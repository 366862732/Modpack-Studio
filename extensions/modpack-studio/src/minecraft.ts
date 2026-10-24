import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { promisify } from 'node:util';
import AdmZip from 'adm-zip';
import {
	getFabricLoaderArtifact,
	install,
	installDependencies,
	installFabric,
	installForge
} from '@xmcl/installer';
import { MinecraftFolder, Version, launch } from '@xmcl/core';
import * as vscode from 'vscode';
import { Instance, LoaderKind } from './instance';
import { downloadFile, ensureDir, fetchJson, fetchText, javaExecutableName, offlineUuid, parseJavaMajor, pathExists, readJson, runtimeHome, writeJson } from './util';

const execFileAsync = promisify(execFile);

/**
 * BMCLAPI mirrors the Maven repositories that are frequently unreachable from
 * mainland China (NeoForge, Forge, Fabric and Mojang libraries). It is used as
 * an alternative host; @xmcl/installer falls back to the official URLs when a
 * file is not mirrored.
 */
const MIRROR_MAVEN_HOST = 'https://bmclapi2.bangbang93.com/maven';
const MIRROR_ASSETS_HOST = 'https://bmclapi2.bangbang93.com/assets';
const MIRROR_META_HOST = 'https://bmclapi2.bangbang93.com';
const NEOFORGE_MAVEN = 'https://maven.neoforged.net/releases';
const FORGE_MAVEN = 'https://maven.minecraftforge.net';

function mavenInstallOptions(side: 'client' | 'server', officialHost: string, javaPath?: string) {
	return {
		side,
		java: javaPath,
		mavenHost: [MIRROR_MAVEN_HOST, officialHost]
	};
}

/** Java major version needed to run the Forge/NeoForge installer. */
function requiredJavaMajorForVersion(minecraftVersion: string): number {
	const match = /^1\.(\d+)(?:\.(\d+))?/.exec(minecraftVersion);
	if (!match) {
		return 21;
	}
	const minor = Number.parseInt(match[1], 10);
	const patch = Number.parseInt(match[2] ?? '0', 10);
	if (minor > 20 || (minor === 20 && patch >= 5)) {
		return 21;
	}
	if (minor >= 18) {
		return 17;
	}
	if (minor === 17) {
		return 16;
	}
	return 8;
}

/**
 * Thrown when no Java installation matches the version required by the game.
 * The UI catches this and lets the user pick an installed Java instead of
 * downloading a runtime automatically.
 */
export class JavaNotFoundError extends Error {
	constructor(public readonly required?: number) {
		super(required
			? `没有找到 Java ${required}。请选择一个已安装的 Java，或安装对应版本后重试。`
			: '没有找到 Java。请选择一个已安装的 Java 后重试。');
		this.name = 'JavaNotFoundError';
	}
}

/**
 * Downloads a NeoForge installer and runs its official headless CLI. The jar's
 * Maven URLs are rewritten to the BMCLAPI mirror first because the official
 * NeoForge Maven is unreachable on some networks. When the mirror copy fails,
 * the untouched official installer is tried as a fallback.
 */
async function installNeoForgeWithInstaller(
	project: 'forge' | 'neoforge',
	version: string,
	minecraftVersion: string,
	gameDir: string,
	progress: InstallProgress,
	preferredJava?: string
): Promise<string> {
	const fileName = `${project}-${version}-installer.jar`;
	const installersDir = path.join(gameDir, '.modpack-studio', 'installers');
	await ensureDir(installersDir);
	const javaPath = await resolveInstallerJava(minecraftVersion, preferredJava);
	const sources = [
		{ url: `${MIRROR_MAVEN_HOST}/net/neoforged/${project}/${version}/${fileName}`, mirror: true },
		{ url: `${NEOFORGE_MAVEN}/net/neoforged/${project}/${version}/${fileName}`, mirror: false }
	];
	const failures: string[] = [];
	for (const [index, source] of sources.entries()) {
		const target = path.join(installersDir, `${index === 0 ? 'mirror-' : ''}${fileName}`);
		try {
			progress(index === 0 ? '正在从镜像下载 NeoForge 安装器…' : '正在尝试官方下载源…');
			await downloadFile(source.url, target);
			const versionId = readInstallerVersionId(target)
				?? (project === 'forge' ? `forge-${version}` : `neoforge-${version}`);
			if (source.mirror) {
				patchInstallerMirror(target);
			}
			await runInstaller(javaPath, target, gameDir, progress);
			return versionId;
		} catch (error) {
			failures.push(`${source.url}: ${error instanceof Error ? error.message : String(error)}`);
			await fs.promises.rm(target, { force: true });
		}
	}
	throw new Error(`NeoForge 安装器执行失败：\n${failures.join('\n')}`);
}

/** Rewrites Maven URLs inside the installer so libraries come from the mirror. */
function patchInstallerMirror(file: string): void {
	const zip = new AdmZip(file);
	let replacements = 0;
	for (const name of ['install_profile.json', 'version.json']) {
		const entry = zip.getEntry(name);
		if (!entry) {
			continue;
		}
		const text = zip.readAsText(entry);
		const next = text
			.split('https://maven.neoforged.net/releases').join(MIRROR_MAVEN_HOST)
			.split('http://maven.neoforged.net/releases').join(MIRROR_MAVEN_HOST);
		if (next !== text) {
			zip.updateFile(name, Buffer.from(next, 'utf8'));
			replacements++;
		}
	}
	if (replacements === 0) {
		throw new Error('安装器中没有找到可替换的 NeoForge 下载地址');
	}
	zip.writeZip(file);
}

function readInstallerVersionId(file: string): string | undefined {
	try {
		const zip = new AdmZip(file);
		const entry = zip.getEntry('version.json');
		if (!entry) {
			return undefined;
		}
		const json = JSON.parse(zip.readAsText(entry)) as { id?: unknown };
		return typeof json.id === 'string' ? json.id : undefined;
	} catch {
		return undefined;
	}
}

async function runInstaller(javaPath: string, installerJar: string, gameDir: string, progress: InstallProgress): Promise<void> {
	const launcherProfiles = path.join(gameDir, 'launcher_profiles.json');
	if (!await pathExists(launcherProfiles)) {
		await writeJson(launcherProfiles, { profiles: {}, settings: {}, version: 3 });
	}
	progress('正在运行 NeoForge 安装器（首次可能需要几分钟）…');
	try {
		await execFileAsync(javaPath, ['-jar', installerJar, '--installClient', gameDir], {
			timeout: 20 * 60_000,
			maxBuffer: 32 * 1024 * 1024,
			windowsHide: true
		});
	} catch (error) {
		const output = [
			(error as { stdout?: string }).stdout,
			(error as { stderr?: string }).stderr
		].filter(Boolean).join('\n').trim();
		const tail = output.split(/\r?\n/).slice(-12).join('\n');
		throw new Error(`安装器返回错误${tail ? `：\n${tail}` : ''}`);
	}
}

async function resolveInstallerJava(minecraftVersion: string, preferredPath?: string): Promise<string> {
	const required = requiredJavaMajorForVersion(minecraftVersion);
	if (preferredPath && await readJavaVersion(preferredPath)) {
		return preferredPath;
	}
	const all = await discoverJava();
	const exact = all.find(java => java.major === required);
	if (exact) {
		return exact.path;
	}
	const newer = all
		.filter(java => (java.major ?? 0) >= required)
		.sort((a, b) => (a.major ?? 0) - (b.major ?? 0))[0];
	if (newer) {
		return newer.path;
	}
	throw new JavaNotFoundError(required);
}

export interface MinecraftVersionSummary {
	id: string;
	type: string;
	url: string;
	releaseTime: string;
}

export interface LoaderChoice {
	version: string;
	label: string;
	stable?: boolean;
}

interface VersionManifest {
	latest: { release: string; snapshot: string };
	versions: MinecraftVersionSummary[];
}

interface VersionDetails {
	id: string;
	inheritsFrom?: string;
	javaVersion?: { majorVersion?: number };
	downloads?: {
		client?: { url: string; sha1?: string; size?: number };
		server?: { url: string; sha1?: string; size?: number };
	};
}

export interface JavaInstall {
	path: string;
	version: string;
	major?: number;
	source: string;
}

let manifestCache: { at: number; value: VersionManifest } | undefined;
let javaCache: { at: number; value: JavaInstall[] } | undefined;

export async function getManifest(): Promise<VersionManifest> {
	if (manifestCache && Date.now() - manifestCache.at < 10 * 60_000) {
		return manifestCache.value;
	}
	// BMCLAPI mirrors the Mojang version manifest and is used first because
	// piston-meta.mojang.com is frequently unreachable from mainland China.
	const value = await fetchFirstAvailableJson<VersionManifest>([
		`${MIRROR_META_HOST}/mc/game/version_manifest_v2.json`,
		'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json'
	]);
	manifestCache = { at: Date.now(), value };
	return value;
}

export async function getVersionDetails(version: string): Promise<VersionDetails> {
	const manifest = await getManifest();
	const meta = manifest.versions.find(candidate => candidate.id === version);
	if (!meta) {
		throw new Error(`找不到 Minecraft 版本 ${version}`);
	}
	return fetchJson<VersionDetails>(meta.url);
}

export function parseMavenVersions(xml: string): string[] {
	return [...xml.matchAll(/<version>([^<]+)<\/version>/g)].map(match => match[1]);
}

export async function getLoaderVersions(loader: LoaderKind, minecraftVersion: string): Promise<LoaderChoice[]> {
	try {
		if (loader === 'fabric') {
			const data = await fetchJson<Array<{ loader: { version: string; stable?: boolean } }>>(
				`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(minecraftVersion)}`
			);
			return data.map(entry => ({
				version: entry.loader.version,
				label: entry.loader.stable === false ? `${entry.loader.version}（测试版）` : entry.loader.version,
				stable: entry.loader.stable
			}));
		}
		if (loader === 'forge') {
			const xml = await fetchFirstAvailable([
				`${FORGE_MAVEN}/net/minecraftforge/forge/maven-metadata.xml`,
				`${MIRROR_MAVEN_HOST}/net/minecraftforge/forge/maven-metadata.xml`
			]);
			const prefix = `${minecraftVersion}-`;
			return parseMavenVersions(xml)
				.filter(version => version.startsWith(prefix))
				.map(version => ({ version: version.slice(prefix.length), label: version.slice(prefix.length) }))
				.reverse();
		}
		if (loader === 'neoforge') {
			const legacy = minecraftVersion === '1.20.1';
			const project = legacy ? 'forge' : 'neoforge';
			// The official NeoForge Maven is blocked or DNS-poisoned on some
			// networks, so the mirror is queried first.
			const xml = await fetchFirstAvailable([
				`${MIRROR_MAVEN_HOST}/net/neoforged/${project}/maven-metadata.xml`,
				`${NEOFORGE_MAVEN}/net/neoforged/${project}/maven-metadata.xml`
			]);
			const prefix = legacy ? `${minecraftVersion}-` : `${minecraftVersion.replace(/^1\./, '')}.`;
			return parseMavenVersions(xml)
				.filter(version => version.startsWith(prefix))
				.map(version => legacy ? { version: version.slice(prefix.length), label: version } : { version, label: version })
				.reverse();
		}
	} catch (error) {
		console.warn(`[modpack-studio] 无法获取 ${loader} 版本列表`, error);
	}
	return [];
}

async function fetchFirstAvailable(urls: string[], timeoutMs = 20_000): Promise<string> {
	let lastError: unknown;
	for (const url of urls) {
		try {
			return await fetchText(url, { 'Accept': 'application/xml, text/xml, */*' }, timeoutMs, 1);
		} catch (error) {
			lastError = error;
			console.warn(`[modpack-studio] 请求失败，尝试下一个镜像: ${url}`, error);
		}
	}
	throw lastError ?? new Error('没有可用的下载源');
}

async function fetchFirstAvailableJson<T>(urls: string[], timeoutMs = 20_000): Promise<T> {
	let lastError: unknown;
	for (const url of urls) {
		try {
			return await fetchJson<T>(url, {}, timeoutMs);
		} catch (error) {
			lastError = error;
			console.warn(`[modpack-studio] 请求失败，尝试下一个镜像: ${url}`, error);
		}
	}
	throw lastError ?? new Error('没有可用的下载源');
}

export interface InstallProgress {
	(message: string, percent?: number): void;
}

/**
 * Installs the vanilla game and then the selected loader. Safe to call on an
 * existing instance: all launcher files are validated/repaired by @xmcl.
 */
export async function installGame(instance: Instance, progress: InstallProgress): Promise<void> {
	const folder = MinecraftFolder.from(instance.gameDir);
	const manifest = await getManifest();
	const meta = manifest.versions.find(candidate => candidate.id === instance.config.minecraftVersion);
	if (!meta) {
		throw new Error(`Minecraft ${instance.config.minecraftVersion} 不在官方版本清单中`);
	}

	progress(`正在安装 Minecraft ${instance.config.minecraftVersion} 基础文件…`);
	// Mirror Mojang's version JSON, client jar, assets and libraries through
	// BMCLAPI when possible; @xmcl/installer falls back to the official URL
	// when the mirror copy is missing. The JSON/CLI overrides hard-replace
	// the original URL, so each must be the host-swapped copy.
	const mirrorHostSwap = (url: string) => url.replace(/^https?:\/\/[^/]+/, MIRROR_META_HOST + '/');
	await install(meta, folder, {
		side: 'client',
		mavenHost: [MIRROR_MAVEN_HOST, 'https://libraries.minecraft.net'],
		assetsHost: [MIRROR_ASSETS_HOST, 'https://resources.download.minecraft.net'],
		json: mirrorHostSwap(meta.url),
		client: version => mirrorHostSwap(version.downloads!.client!.url)
	});

	const loaderVersion = instance.config.loaderVersion;
	if (instance.config.loader === 'vanilla') {
		instance.config.versionId = instance.config.minecraftVersion;
	} else if (!loaderVersion) {
		throw new Error('整合包缺少加载器版本，无法安装');
	} else if (instance.config.loader === 'fabric') {
		progress(`正在安装 Fabric Loader ${loaderVersion}…`);
		const artifact = await getFabricLoaderArtifact(instance.config.minecraftVersion, loaderVersion);
		const versionId = await installFabric(artifact, folder, { side: 'client' });
		const resolved = await Version.parse(folder, versionId);
		progress('正在补全 Fabric 依赖库…');
		await installDependencies(resolved, {
			side: 'client',
			mavenHost: [MIRROR_MAVEN_HOST, 'https://libraries.minecraft.net']
		});
		instance.config.versionId = versionId;
	} else if (instance.config.loader === 'forge') {
		progress(`正在安装 Forge ${loaderVersion}（首次可能需要几分钟）…`);
		const javaPath = await resolveInstallerJava(instance.config.minecraftVersion);
		const versionId = await installForge({
			version: loaderVersion,
			mcversion: instance.config.minecraftVersion
		}, folder, mavenInstallOptions('client', FORGE_MAVEN, javaPath));
		instance.config.versionId = versionId;
	} else if (instance.config.loader === 'neoforge') {
		progress(`正在安装 NeoForge ${loaderVersion}（首次可能需要几分钟）…`);
		const project = instance.config.minecraftVersion === '1.20.1' ? 'forge' : 'neoforge';
		// Modern NeoForge Maven artifacts are versioned as 21.1.x without the
		// Minecraft prefix, while the 1.20.1 compatibility artifact keeps it.
		const versionArg = project === 'forge'
			? (loaderVersion.startsWith(instance.config.minecraftVersion) ? loaderVersion : `${instance.config.minecraftVersion}-${loaderVersion}`)
			: loaderVersion;
		instance.config.versionId = await installNeoForgeWithInstaller(
			project,
			versionArg,
			instance.config.minecraftVersion,
			instance.gameDir,
			progress
		);
	} else {
		throw new Error(`暂不支持 ${instance.config.loader}`);
	}

	await instance.ensureLayout();
	await instance.save();
}

export async function isGameInstalled(instance: Instance): Promise<boolean> {
	if (!instance.config.versionId) {
		return false;
	}
	return pathExists(path.join(instance.versionsDir, instance.config.versionId, `${instance.config.versionId}.json`));
}

/** Returns the Java major version requested by the installed version json. */
export async function getRequiredJava(instance: Instance): Promise<number | undefined> {
	let versionId = instance.config.versionId;
	const seen = new Set<string>();
	while (versionId && !seen.has(versionId)) {
		seen.add(versionId);
		try {
			const details = await readJson<VersionDetails>(
				path.join(instance.versionsDir, versionId, `${versionId}.json`)
			);
			if (details.javaVersion?.majorVersion) {
				return details.javaVersion.majorVersion;
			}
			// Forge/NeoForge version json files inherit from the vanilla one,
			// which is where the javaVersion field lives.
			versionId = details.inheritsFrom;
		} catch {
			break;
		}
	}
	return instance.config.minecraftVersion ? requiredJavaMajorForVersion(instance.config.minecraftVersion) : undefined;
}

/** Reads `java -version` output. Also used to validate a manually picked path. */
export async function readJavaVersion(javaPath: string): Promise<{ version: string; major?: number } | undefined> {
	try {
		const { stderr, stdout } = await execFileAsync(javaPath, ['-XshowSettings:properties', '-version'], { timeout: 8000 });
		const output = `${stderr}\n${stdout}`;
		const version = /java\.version\s*=\s*(\S+)/.exec(output)?.[1]
			?? /version "([^"]+)"/.exec(output)?.[1]
			?? '';
		return { version, major: parseJavaMajor(version) };
	} catch {
		return undefined;
	}
}

async function findJavaInDirectory(directory: string, source: string, depth: number): Promise<JavaInstall[]> {
	if (depth < 0) {
		return [];
	}
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(directory, { withFileTypes: true });
	} catch {
		return [];
	}
	const result: JavaInstall[] = [];
	for (const entry of entries) {
		const full = path.join(directory, entry.name);
		if (entry.isFile() && entry.name.toLowerCase() === javaExecutableName().toLowerCase()) {
			const info = await readJavaVersion(full);
			if (info) {
				result.push({ path: full, source, ...info });
			}
		} else if (entry.isDirectory() && depth > 0) {
			result.push(...await findJavaInDirectory(full, source, depth - 1));
		}
	}
	return result;
}

/** Scans PATH, JAVA_HOME, common JDK vendors and the official launcher runtimes. */
export async function discoverJava(force = false): Promise<JavaInstall[]> {
	if (!force && javaCache && Date.now() - javaCache.at < 60_000) {
		return javaCache.value;
	}
	const candidates: Array<{ path: string; source: string; info?: { version: string; major?: number } }> = [];
	const add = (candidate: string | undefined, source: string, info?: { version: string; major?: number }) => {
		if (candidate && candidate.trim()) {
			candidates.push({ path: candidate.trim().replace(/^"|"$/g, ''), source, info });
		}
	};

	add(vscode.workspace.getConfiguration('modpack').get<string>('javaPath'), '设置');
	add(process.env.JAVA_HOME ? path.join(process.env.JAVA_HOME, 'bin', javaExecutableName()) : undefined, 'JAVA_HOME');
	try {
		const command = process.platform === 'win32' ? 'where' : 'which';
		const { stdout } = await execFileAsync(command, ['java'], { timeout: 5000 });
		for (const line of stdout.split(/\r?\n/)) {
			add(line, 'PATH');
		}
	} catch {
		// Java not on PATH.
	}

	const programFiles = [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')].filter(Boolean) as string[];
	const vendors = ['Java', 'Eclipse Adoptium', 'Microsoft', 'Zulu', 'BellSoft', 'Amazon Corretto', 'Semeru', 'Temurin'];
	for (const base of programFiles) {
		for (const vendor of vendors) {
			const root = path.join(base, vendor);
			for (const install of await findJavaInDirectory(root, vendor, 3)) {
				add(install.path, vendor, { version: install.version, major: install.major });
			}
		}
	}
	for (const jdk of await findJavaInDirectory(path.join(os.homedir(), '.jdks'), 'IDE', 3)) {
		add(jdk.path, 'IDE', { version: jdk.version, major: jdk.major });
	}
	const runtimeRoots: Array<[string, string]> = [
		[runtimeHome(), 'Mojang 运行时'],
		[path.join(process.env.APPDATA ?? '', '.minecraft', 'runtime'), 'Minecraft 启动器'],
		[path.join(process.env.LOCALAPPDATA ?? '', 'Packages', 'Microsoft.4297127D64EC6_8wekyb3d8bbwe', 'LocalCache', 'Local', 'runtime'), 'Minecraft 启动器']
	];
	for (const [root, source] of runtimeRoots) {
		for (const runtime of await findJavaInDirectory(root, source, 6)) {
			add(runtime.path, source, { version: runtime.version, major: runtime.major });
		}
	}

	const seen = new Set<string>();
	const result: JavaInstall[] = [];
	for (const candidate of candidates) {
		if (!await pathExists(candidate.path)) {
			continue;
		}
		const key = path.resolve(candidate.path).toLowerCase();
		if (seen.has(key)) {
			continue;
		}
		seen.add(key);
		const info = candidate.info ?? await readJavaVersion(candidate.path);
		if (info) {
			result.push({ path: candidate.path, source: candidate.source, ...info });
		}
	}
	result.sort((a, b) => (b.major ?? 0) - (a.major ?? 0));
	javaCache = { at: Date.now(), value: result };
	return result;
}

export async function resolveJava(instance: Instance): Promise<JavaInstall> {
	const required = await getRequiredJava(instance);
	const configured = instance.config.javaPath || vscode.workspace.getConfiguration('modpack').get<string>('javaPath');
	if (configured) {
		const info = await readJavaVersion(configured);
		if (info) {
			return { path: configured, source: instance.config.javaPath ? '手动选择' : '设置', ...info };
		}
	}
	const all = await discoverJava();
	const exact = required ? all.find(java => java.major === required) : all[0];
	if (exact) {
		return exact;
	}
	throw new JavaNotFoundError(required);
}

export interface LaunchResult {
	process: import('node:child_process').ChildProcess;
	java: JavaInstall;
	versionId: string;
}

export async function launchClient(instance: Instance): Promise<LaunchResult> {
	if (!await isGameInstalled(instance)) {
		await installGame(instance, () => undefined);
	}
	if (!instance.config.versionId) {
		throw new Error('游戏尚未安装完成，请先运行“安装或修复游戏文件”');
	}
	const java = await resolveJava(instance);
	const config = vscode.workspace.getConfiguration('modpack');
	const memory = instance.config.memoryMb ?? config.get<number>('memoryMb', 4096);
	const extraJVMArgs = [
		...(config.get<string[]>('jvmArgs', []) ?? []),
		...(instance.config.jvmArgs ?? [])
	];
	const playerName = config.get<string>('offlinePlayerName', 'Steve').trim() || 'Steve';
	const folder = MinecraftFolder.from(instance.gameDir);
	const version = await Version.parse(folder, instance.config.versionId);

	instance.config.lastPlayed = new Date().toISOString();
	await instance.save();

	const child = await launch({
		gamePath: instance.gameDir,
		resourcePath: instance.gameDir,
		version,
		javaPath: java.path,
		gameProfile: { name: playerName, id: offlineUuid(playerName) },
		accessToken: '0'.repeat(32),
		userType: 'legacy',
		launcherName: 'Modpack Studio',
		launcherBrand: 'Modpack Studio',
		minMemory: Math.min(1024, memory),
		maxMemory: memory,
		extraJVMArgs,
		ignoreInvalidMinecraftCertificates: instance.config.loader === 'forge' || instance.config.loader === 'neoforge',
		ignorePatchDiscrepancies: instance.config.loader === 'forge' || instance.config.loader === 'neoforge'
	});
	return { process: child, java, versionId: instance.config.versionId };
}

export async function ensureServerJar(instance: Instance): Promise<string> {
	await ensureDir(instance.gameDir);
	const target = path.join(instance.gameDir, 'server.jar');
	if (instance.config.loader === 'fabric' && instance.config.loaderVersion) {
		const fabricLauncher = path.join(instance.gameDir, 'fabric-server-launch.jar');
		if (!await pathExists(fabricLauncher)) {
			await downloadFile(
				`https://meta.fabricmc.net/v2/versions/loader/${encodeURIComponent(instance.config.minecraftVersion)}/${encodeURIComponent(instance.config.loaderVersion)}/server/jar`,
				fabricLauncher
			);
		}
		if (!await pathExists(target)) {
			const details = await getVersionDetails(instance.config.minecraftVersion);
			if (!details.downloads?.server?.url) {
				throw new Error(`Minecraft ${instance.config.minecraftVersion} 没有可用的服务端下载`);
			}
			await downloadFile(details.downloads.server.url, target);
		}
		return fabricLauncher;
	}
	if (instance.config.loader !== 'vanilla') {
		throw new Error('当前版本的服务端启动仅支持原版和 Fabric，Forge/NeoForge 服务端请使用实例目录中的安装脚本。');
	}
	if (!await pathExists(target)) {
		const details = await getVersionDetails(instance.config.minecraftVersion);
		if (!details.downloads?.server?.url) {
			throw new Error(`Minecraft ${instance.config.minecraftVersion} 没有可用的服务端下载`);
		}
		await downloadFile(details.downloads.server.url, target);
	}
	return target;
}
