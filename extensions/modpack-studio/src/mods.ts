import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Instance, LoaderKind } from './instance';
import { downloadFile, ensureDir, fetchJson, formatBytes, hashFile, pathExists, readJson, writeJson } from './util';

export interface ModDependency {
	modId: string;
	mandatory: boolean;
	versionRange?: string;
	side?: string;
}

export interface ModInfo {
	file: string;
	fileName: string;
	enabled: boolean;
	size: number;
	name: string;
	version?: string;
	modId?: string;
	description?: string;
	authors?: string[];
	loader?: LoaderKind | 'unknown';
	minecraftVersion?: string;
	dependencies: ModDependency[];
	projectId?: string;
	versionId?: string;
}

export interface InstalledModRecord {
	projectId: string;
	versionId: string;
	name: string;
	versionNumber: string;
	url: string;
	fileSize?: number;
	sha1?: string;
	sha512?: string;
	installedAt: string;
	source: 'modrinth' | 'local';
}

export type InstalledMods = Record<string, InstalledModRecord>;

export interface ModIssue {
	severity: 'error' | 'warning' | 'info';
	message: string;
	mod?: string;
}

export type ModProjectType = 'mod' | 'resourcepack' | 'shader' | 'datapack' | 'modpack';

export interface ModrinthSearchHit {
	project_id: string;
	slug: string;
	title: string;
	description: string;
	categories: string[];
	downloads: number;
	author: string;
	icon_url?: string;
	latest_version?: string;
	versions: string[];
}

export interface ModrinthVersion {
	id: string;
	project_id: string;
	name: string;
	version_number: string;
	version_type: 'release' | 'beta' | 'alpha';
	game_versions: string[];
	loaders: string[];
	date_published: string;
	files: Array<{
		hashes: { sha1?: string; sha512?: string };
		url: string;
		filename: string;
		primary: boolean;
		size: number;
	}>;
	dependencies: Array<{
		version_id?: string;
		project_id?: string;
		dependency_type: 'required' | 'optional' | 'incompatible' | 'embedded';
	}>;
}

const MODRINTH = 'https://api.modrinth.com/v2';

/**
 * Modrinth occasionally stalls on IPv6 routes. Surface a readable error instead
 * of the raw undici abort so users know they can retry or configure a proxy.
 */
async function modrinthFetch<T>(url: string): Promise<T> {
	try {
		return await fetchJson<T>(url, {}, 30_000);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (error instanceof Error && error.name === 'AbortError' || /fetch failed|connect timeout|timed out|aborted/i.test(message)) {
			throw new Error('连接 Modrinth 超时。请检查网络或代理设置后重试。');
		}
		throw error;
	}
}
const jarCache = new Map<string, { stamp: string; info: ModInfo }>();

export async function loadInstalledMods(instance: Instance): Promise<InstalledMods> {
	return readJson<InstalledMods>(instance.installedModsPath, {});
}

export async function saveInstalledMods(instance: Instance, mods: InstalledMods): Promise<void> {
	await writeJson(instance.installedModsPath, mods);
}

function firstMatch(text: string, regex: RegExp): string | undefined {
	return regex.exec(text)?.[1];
}

function parseFabricLike(json: any): Partial<ModInfo> & { dependencies: ModDependency[] } {
	const dependencies: ModDependency[] = [];
	for (const [modId, range] of Object.entries(json.depends ?? {})) {
		dependencies.push({ modId, mandatory: true, versionRange: Array.isArray(range) ? range.join(' || ') : String(range) });
	}
	for (const [modId, range] of Object.entries(json.recommends ?? {})) {
		dependencies.push({ modId, mandatory: false, versionRange: String(range) });
	}
	const authors = Array.isArray(json.authors)
		? json.authors.map((author: any) => typeof author === 'string' ? author : author?.name).filter(Boolean)
		: undefined;
	return {
		name: json.name ?? json.id,
		version: typeof json.version === 'string' ? json.version : undefined,
		modId: json.id,
		description: json.description,
		authors,
		loader: 'fabric',
		dependencies
	};
}

function parseToml(text: string): Partial<ModInfo> & { dependencies: ModDependency[] } {
	const modBlock = text.split(/\[\[mods\]\]/i)[1] ?? text;
	const modId = firstMatch(modBlock, /^\s*modId\s*=\s*"([^"]+)"/m);
	const displayName = firstMatch(modBlock, /^\s*displayName\s*=\s*"([^"]*)"/m);
	const version = firstMatch(modBlock, /^\s*version\s*=\s*"([^"]*)"/m);
	const description = firstMatch(modBlock, /^\s*description\s*=\s*"([^"]*)"/m);
	const authors = firstMatch(modBlock, /^\s*authors\s*=\s*"([^"]*)"/m)?.split(',').map(author => author.trim());
	const loader: LoaderKind = /neoforge/i.test(text) ? 'neoforge' : 'forge';
	const dependencies: ModDependency[] = [];
	for (const block of text.split(/\[\[dependencies\.[^\]]+\]\]/i).slice(1)) {
		const dependencyId = firstMatch(block, /^\s*modId\s*=\s*"([^"]+)"/m);
		if (!dependencyId) {
			continue;
		}
		dependencies.push({
			modId: dependencyId,
			mandatory: !/^\s*mandatory\s*=\s*false/m.test(block),
			versionRange: firstMatch(block, /^\s*versionRange\s*=\s*"([^"]*)"/m),
			side: firstMatch(block, /^\s*side\s*=\s*"([^"]*)"/m)
		});
	}
	return { modId, name: displayName ?? modId, version, description, authors, loader, dependencies };
}

export function parseModJar(file: string): ModInfo {
	const stat = fs.statSync(file);
	const stamp = `${stat.size}:${stat.mtimeMs}`;
	const cached = jarCache.get(file);
	if (cached?.stamp === stamp) {
		return cached.info;
	}
	const enabled = file.toLowerCase().endsWith('.jar');
	const info: ModInfo = {
		file,
		fileName: path.basename(file),
		enabled,
		size: stat.size,
		name: path.basename(file, enabled ? '.jar' : '.jar.disabled'),
		dependencies: []
	};
	try {
		const zip = new AdmZip(file);
		const read = (entry: string): string | undefined => {
			const item = zip.getEntry(entry);
			return item ? item.getData().toString('utf8') : undefined;
		};

		const fabric = read('fabric.mod.json');
		const quilt = read('quilt.mod.json');
		const modsToml = read('META-INF/neoforge.mods.toml') ?? read('META-INF/mods.toml');
		const mcmod = read('mcmod.info');

		if (fabric) {
			Object.assign(info, parseFabricLike(JSON.parse(fabric)));
		} else if (quilt) {
			const parsed = JSON.parse(quilt);
			const quiltLoader = parsed.quilt_loader ?? {};
			Object.assign(info, {
				name: quiltLoader.metadata?.name ?? quiltLoader.id,
				version: quiltLoader.version,
				modId: quiltLoader.id,
				description: quiltLoader.metadata?.description,
				loader: 'quilt',
				dependencies: Object.entries(quiltLoader.depends ?? {}).map(([modId, range]) => ({
					modId,
					mandatory: true,
					versionRange: String(range)
				}))
			});
		} else if (modsToml) {
			Object.assign(info, parseToml(modsToml));
		} else if (mcmod) {
			const parsed = JSON.parse(mcmod);
			const entry = Array.isArray(parsed) ? parsed[0] : parsed?.modList?.[0];
			if (entry) {
				Object.assign(info, {
					name: entry.name ?? entry.modid,
					version: entry.version,
					modId: entry.modid,
					description: entry.description,
					authors: entry.authorList,
					loader: 'forge'
				});
			}
		} else {
			const manifest = read('META-INF/MANIFEST.MF');
			if (manifest) {
				info.name = firstMatch(manifest, /^Implementation-Title:\s*(.+)$/m)?.trim() ?? info.name;
				info.version = firstMatch(manifest, /^Implementation-Version:\s*(.+)$/m)?.trim();
			}
			info.loader = 'unknown';
		}
	} catch {
		info.loader = 'unknown';
		info.description = '无法读取模组元数据（文件可能损坏）';
	}
	jarCache.set(file, { stamp, info });
	return info;
}

export async function scanMods(instance: Instance): Promise<ModInfo[]> {
	await ensureDir(instance.modsDir);
	const records = await loadInstalledMods(instance);
	let entries: fs.Dirent[];
	try {
		entries = await fs.promises.readdir(instance.modsDir, { withFileTypes: true });
	} catch {
		return [];
	}
	const mods: ModInfo[] = [];
	for (const entry of entries) {
		if (!entry.isFile()) {
			continue;
		}
		const lower = entry.name.toLowerCase();
		if (!lower.endsWith('.jar') && !lower.endsWith('.jar.disabled')) {
			continue;
		}
		const info = parseModJar(path.join(instance.modsDir, entry.name));
		const record = records[info.fileName.replace(/\.disabled$/i, '')] ?? records[info.fileName];
		if (record) {
			info.projectId = record.projectId;
			info.versionId = record.versionId;
			info.name = info.name || record.name;
			info.version = info.version ?? record.versionNumber;
		}
		mods.push(info);
	}
	mods.sort((a, b) => Number(b.enabled) - Number(a.enabled) || a.name.localeCompare(b.name, 'zh-CN'));
	return mods;
}

export async function toggleMod(mod: ModInfo): Promise<void> {
	if (mod.enabled) {
		const target = `${mod.file}.disabled`;
		await fs.promises.rename(mod.file, target);
		jarCache.delete(mod.file);
	} else {
		const target = mod.file.replace(/\.disabled$/i, '');
		if (await pathExists(target)) {
			throw new Error(`已存在同名模组文件：${path.basename(target)}`);
		}
		await fs.promises.rename(mod.file, target);
		jarCache.delete(mod.file);
	}
}

export async function removeMod(instance: Instance, mod: ModInfo): Promise<void> {
	await fs.promises.rm(mod.file, { force: true });
	jarCache.delete(mod.file);
	const records = await loadInstalledMods(instance);
	const base = mod.fileName.replace(/\.disabled$/i, '');
	delete records[base];
	await saveInstalledMods(instance, records);
}

export async function addLocalMods(instance: Instance, files: string[]): Promise<number> {
	await ensureDir(instance.modsDir);
	const records = await loadInstalledMods(instance);
	let added = 0;
	for (const source of files) {
		if (!source.toLowerCase().endsWith('.jar')) {
			continue;
		}
		let fileName = path.basename(source);
		let target = path.join(instance.modsDir, fileName);
		let index = 2;
		while (await pathExists(target)) {
			fileName = `${path.basename(source, '.jar')}-${index++}.jar`;
			target = path.join(instance.modsDir, fileName);
		}
		await fs.promises.copyFile(source, target);
		const info = parseModJar(target);
		records[fileName] = {
			projectId: '',
			versionId: '',
			name: info.name,
			versionNumber: info.version ?? '',
			url: '',
			fileSize: info.size,
			installedAt: new Date().toISOString(),
			source: 'local'
		};
		added++;
	}
	await saveInstalledMods(instance, records);
	return added;
}

export function analyzeMods(instance: Instance, mods: ModInfo[]): ModIssue[] {
	const issues: ModIssue[] = [];
	const enabled = mods.filter(mod => mod.enabled);
	const byId = new Map<string, ModInfo[]>();
	for (const mod of enabled) {
		if (mod.modId) {
			const list = byId.get(mod.modId) ?? [];
			list.push(mod);
			byId.set(mod.modId, list);
		}
	}
	for (const [modId, list] of byId) {
		if (list.length > 1) {
			issues.push({
				severity: 'error',
				message: `重复安装：${list.map(mod => mod.fileName).join('、')}（modId: ${modId}），请只保留一个版本`,
				mod: modId
			});
		}
	}
	const compatibleLoader: Record<string, LoaderKind[]> = {
		fabric: ['fabric'],
		forge: ['forge'],
		neoforge: ['neoforge', 'forge'],
		quilt: ['quilt', 'fabric']
	};
	const expected = compatibleLoader[instance.config.loader] ?? [];
	for (const mod of enabled) {
		if (mod.loader && mod.loader !== 'unknown' && expected.length > 0 && !expected.includes(mod.loader)) {
			issues.push({
				severity: 'warning',
				message: `加载器不匹配：${mod.fileName} 是 ${mod.loader} 模组，当前整合包是 ${instance.config.loader}`,
				mod: mod.fileName
			});
		}
	}
	const internalDependencies = new Set(['minecraft', 'fabricloader', 'fabric-api', 'forge', 'neoforge', 'java', 'quilt_loader', 'quilted_fabric_api']);
	for (const mod of enabled) {
		for (const dependency of mod.dependencies) {
			if (!dependency.mandatory || internalDependencies.has(dependency.modId.toLowerCase())) {
				continue;
			}
			if (!byId.has(dependency.modId)) {
				issues.push({
					severity: 'error',
					message: `缺少前置：${mod.name} 需要 ${dependency.modId}${dependency.versionRange ? ` (${dependency.versionRange})` : ''}`,
					mod: mod.fileName
				});
			}
		}
	}
	return issues;
}

export async function searchModrinth(
	query: string,
	instance: Instance,
	offset = 0,
	limit = 20,
	projectType: ModProjectType = 'mod'
): Promise<{ hits: ModrinthSearchHit[]; total: number }> {
	const facets: string[][] = [['project_type:' + projectType]];
	if (instance.config.minecraftVersion) {
		facets.push([`versions:${instance.config.minecraftVersion}`]);
	}
	if (projectType === 'mod') {
		const loader = instance.config.loader;
		if (loader === 'fabric' || loader === 'forge' || loader === 'neoforge' || loader === 'quilt') {
			facets.push([`categories:${loader}`]);
		}
	}
	const url = new URL(`${MODRINTH}/search`);
	url.searchParams.set('query', query);
	url.searchParams.set('limit', String(limit));
	url.searchParams.set('offset', String(offset));
	url.searchParams.set('facets', JSON.stringify(facets));
	url.searchParams.set('index', 'relevance');
	const response = await modrinthFetch<{ hits: ModrinthSearchHit[]; total_hits: number }>(url.toString());
	return { hits: response.hits, total: response.total_hits };
}

export async function getProjectVersions(projectId: string, instance: Instance): Promise<ModrinthVersion[]> {
	const url = new URL(`${MODRINTH}/project/${encodeURIComponent(projectId)}/version`);
	url.searchParams.set('game_versions', JSON.stringify([instance.config.minecraftVersion]));
	const loader = instance.config.loader;
	if (loader === 'fabric' || loader === 'forge' || loader === 'neoforge' || loader === 'quilt') {
		url.searchParams.set('loaders', JSON.stringify([loader]));
	}
	return modrinthFetch<ModrinthVersion[]>(url.toString());
}

export async function getVersion(versionId: string): Promise<ModrinthVersion> {
	return modrinthFetch<ModrinthVersion>(`${MODRINTH}/version/${encodeURIComponent(versionId)}`);
}

function pickVersion(versions: ModrinthVersion[]): ModrinthVersion | undefined {
	const order = { release: 0, beta: 1, alpha: 2 } as const;
	return versions
		.slice()
		.sort((a, b) => order[a.version_type] - order[b.version_type] || b.date_published.localeCompare(a.date_published))[0];
}

export interface InstallModResult {
	installed: Array<{ name: string; version: string; fileName: string; dependency: boolean }>;
	warnings: string[];
	versions: ModrinthVersion[];
}

/**
 * Installs a Modrinth project and its required dependencies.
 * For `resourcepack` / `shader` / `datapack` project types the zip file
 * is written to the appropriate sub-folder of the instance game directory
 * instead of `mods/`.
 */
export async function installModrinthProject(
	instance: Instance,
	projectId: string,
	versionId: string | undefined,
	onProgress: (message: string, percentage?: number) => void,
	abortSignal?: AbortSignal,
	projectType: ModProjectType = 'mod'
): Promise<InstallModResult> {
	if (projectType !== 'mod') {
		return installSingleNonMod(instance, projectId, versionId, onProgress, abortSignal, projectType);
	}

	await ensureDir(instance.modsDir);
	const records = await loadInstalledMods(instance);
	const result: InstallModResult = { installed: [], warnings: [], versions: [] };
	const visited = new Set<string>();
	const incompatible = new Set<string>();
	let totalFiles = 0;
	let doneFiles = 0;
	let totalDownloadBytes = 0;
	let doneBytes = 0;

	const isAborted = (): boolean => abortSignal?.aborted === true;
	const checkAbort = (): void => {
		if (isAborted()) {
			throw abortSignal?.reason ?? new Error('安装已取消');
		}
	};

	const reportProgress = (message: string, percent?: number): void => {
		onProgress(message, percent);
	};

	/** Compute overall percentage from files + bytes so the UI shows a stable 0–100 bar. */
	const overallPercent = (): number | undefined => {
		if (totalFiles === 0) {
			return undefined;
		}
		const fileFraction = doneFiles / totalFiles;
		const byteFraction = totalDownloadBytes > 0 ? doneBytes / totalDownloadBytes : 0;
		return Math.round((fileFraction * 0.5 + byteFraction * 0.5) * 100);
	};

	/**
	 * Pre-scan all reachable dependencies to get an accurate file count
	 * before starting downloads.  Mirrors PCL's ModDependencyResolver BFS.
	 */
	const preScan = async (id: string, fixedVersionId: string | undefined, depth: number): Promise<ModrinthVersion | undefined> => {
		if (visited.has(id) || depth > 8) {
			return undefined;
		}
		visited.add(id);
		const version = fixedVersionId
			? await getVersion(fixedVersionId)
			: pickVersion(await getProjectVersions(id, instance));
		if (!version) {
			return undefined;
		}
		const file = version.files.find(candidate => candidate.primary) ?? version.files[0];
		if (file) {
			totalFiles++;
			totalDownloadBytes += file.size;
		}
		// Collect incompatible project IDs.
		for (const dep of version.dependencies) {
			if (dep.dependency_type === 'incompatible' && dep.project_id) {
				incompatible.add(dep.project_id);
			}
		}
		// Recurse into required dependencies.
		for (const dep of version.dependencies) {
			if (dep.dependency_type !== 'required' || !dep.project_id || dep.project_id in visited) {
				continue;
			}
			await preScan(dep.project_id, dep.version_id, depth + 1);
		}
		return version;
	};

	await preScan(projectId, versionId, 0);
	visited.clear();

	const installRecursive = async (
		id: string,
		fixedVersionId: string | undefined,
		depth: number
	): Promise<void> => {
		checkAbort();
		if (visited.has(id) || depth > 8) {
			return;
		}
		visited.add(id);
		const version = fixedVersionId
			? await getVersion(fixedVersionId)
			: pickVersion(await getProjectVersions(id, instance));
		if (!version) {
			result.warnings.push(`没有找到与 Minecraft ${instance.config.minecraftVersion} / ${instance.config.loader} 兼容的版本`);
			return;
		}
		const file = version.files.find(candidate => candidate.primary) ?? version.files[0];
		if (!file) {
			result.warnings.push(`${version.name} 没有可下载的文件`);
			return;
		}

		const target = path.join(instance.modsDir, file.filename);
		await fs.promises.rm(`${target}.disabled`, { force: true });

		reportProgress(
			`正在下载 ${version.name} (${formatBytes(doneBytes)}/${formatBytes(totalDownloadBytes)})…`,
			overallPercent()
		);

		const downloadStartBytes = doneBytes;
		await downloadFile(file.url, target, {}, 2, abortSignal);
		doneBytes += file.size;

		if (file.hashes.sha512) {
			const actual = await hashFile(target, 'sha512');
			if (actual.toLowerCase() !== file.hashes.sha512.toLowerCase()) {
				await fs.promises.rm(target, { force: true });
				throw new Error(`${file.filename} 校验失败，已删除损坏文件`);
			}
		}

		records[file.filename] = {
			projectId: id,
			versionId: version.id,
			name: version.name,
			versionNumber: version.version_number,
			url: file.url,
			fileSize: file.size,
			sha1: file.hashes.sha1,
			sha512: file.hashes.sha512,
			installedAt: new Date().toISOString(),
			source: 'modrinth'
		};
		doneFiles++;
		result.installed.push({
			name: version.name,
			version: version.version_number,
			fileName: file.filename,
			dependency: depth > 0
		});
		result.versions.push(version);
		reportProgress(`已下载 ${version.name}`, overallPercent());

		for (const dep of version.dependencies) {
			checkAbort();
			if (dep.dependency_type === 'incompatible' && dep.project_id) {
				const installedIncompatible = Object.values(records).find(
					record => record.projectId === dep.project_id
				);
				if (installedIncompatible) {
					result.warnings.push(
						`${version.name} 与已安装的 "${installedIncompatible.name}" 不兼容，请手动移除其中一个`
					);
				} else {
					result.warnings.push(`${version.name} 声明了与 "${dep.project_id}" 的不兼容依赖`);
				}
				continue;
			}
			if (dep.dependency_type !== 'required' || !dep.project_id) {
				if (dep.dependency_type === 'optional') {
					result.warnings.push(`${version.name} 有一个可选前置，可在 Modrinth 页面按需安装`);
				}
				continue;
			}
			await installRecursive(dep.project_id, dep.version_id, depth + 1);
		}
	};

	await installRecursive(projectId, versionId, 0);
	await saveInstalledMods(instance, records);
	return result;
}

/**
 * Installs a single non-mod project type (resourcepack / shader / datapack)
 * into the correct sub-folder of the instance.
 */
async function installSingleNonMod(
	instance: Instance,
	projectId: string,
	versionId: string | undefined,
	onProgress: (message: string, percentage?: number) => void,
	abortSignal?: AbortSignal,
	projectType: ModProjectType
): Promise<InstallModResult> {
	const version = versionId
		? await getVersion(versionId)
		: pickVersion(await getProjectVersions(projectId, instance));
	const result: InstallModResult = { installed: [], warnings: [], versions: [] };
	if (!version) {
		result.warnings.push(`没有找到与 Minecraft ${instance.config.minecraftVersion} 兼容的版本`);
		return result;
	}
	const file = version.files.find(candidate => candidate.primary) ?? version.files[0];
	if (!file) {
		result.warnings.push(`${version.name} 没有可下载的文件`);
		return result;
	}

	const folderMap: Partial<Record<ModProjectType, string>> = {
		resourcepack: 'resourcepacks',
		shader: 'shaderpacks',
		datapack: 'datapacks'
	};
	const subFolder = folderMap[projectType] ?? 'mods';
	const targetDir = path.join(instance.gameDir, subFolder);
	await ensureDir(targetDir);
	const target = path.join(targetDir, file.filename);

	onProgress(`正在下载 ${version.name}…`, 0);
	await downloadFile(file.url, target, {}, 2, abortSignal);
	if (file.hashes.sha512) {
		const actual = await hashFile(target, 'sha512');
		if (actual.toLowerCase() !== file.hashes.sha512.toLowerCase()) {
			await fs.promises.rm(target, { force: true });
			throw new Error(`${file.filename} 校验失败，已删除损坏文件`);
		}
	}
	result.installed.push({
		name: version.name,
		version: version.version_number,
		fileName: file.filename,
		dependency: false
	});
	result.versions.push(version);
	onProgress(`已安装 ${version.name}`, 100);
	return result;
}

export async function findInstalledProject(instance: Instance, projectId: string): Promise<ModInfo | undefined> {
	const records = await loadInstalledMods(instance);
	const record = Object.values(records).find(candidate => candidate.projectId === projectId);
	if (!record) {
		return undefined;
	}
	return (await scanMods(instance)).find(mod => mod.fileName.replace(/\.disabled$/i, '') === Object.keys(records).find(key => records[key] === record));
}

export function describeMod(mod: ModInfo): string {
	const pieces = [mod.version ? `v${mod.version}` : undefined, mod.enabled ? undefined : '已禁用', formatBytes(mod.size)];
	return pieces.filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------------------
// CurseForge
// ---------------------------------------------------------------------------

const CURSEFORGE = 'https://api.curseforge.com';

export interface CurseForgeSearchHit {
	id: number;
	name: string;
	summary: string;
	authorName: string;
	downloadCount: number;
	iconUrl?: string;
	categories: number[];
	game: string;
	latestFilesId?: number;
}

export interface CurseForgeVersion {
	id: number;
	modId: number;
	displayName: string;
	fileName: string;
	fileUrl: string;
	fileDate: string;
	version: string;
	type: string;
	hash: { algo: string; value: string };
	gameVersions: string[];
}

function cfHeaders(apiKey?: string): Record<string, string> {
	const headers: Record<string, string> = { 'Accept': 'application/json', 'User-Agent': 'ModpackStudio/0.1.0' };
	if (apiKey) {
		headers['x-api-key'] = apiKey;
	}
	return headers;
}

/**
 * Searches CurseForge for mods, resource packs, or shaders.
 * Category IDs (Minecraft Java): mods=4, resourcepacks=7, shaders=18, datapacks=9.
 */
export async function searchCurseForge(
	query: string,
	instance: Instance,
	offset = 0,
	limit = 20,
	category: 'mod' | 'resourcepack' | 'shader' | 'datapack' = 'mod',
	apiKey?: string
): Promise<{ hits: CurseForgeSearchHit[]; total: number }> {
	const categoryId: Record<typeof category, number> = { mod: 4, resourcepack: 7, shader: 18, datapack: 9 };
	const cfGameId = 438; // Minecraft Java Edition
	const url = new URL(`${CURSEFORGE}/v1/search/mods`);
	url.searchParams.set('game', String(cfGameId));
	url.searchParams.set('categories', String(categoryId[category]));
	if (query.trim()) {
		url.searchParams.set('searchFilter', query.trim());
	}
	url.searchParams.set('pageSize', String(limit));
	url.searchParams.set('startIndex', String(offset));

	const response = await fetchJson<{ data: Array<{
		modId: number;
		name: string;
		summary: string;
		downloadCount: number;
		created: string;
		iconUrl?: string;
		authorName: string;
		categories: number[];
		game: string;
		latestFilesId?: number;
	}>}(url.toString(), cfHeaders(apiKey), 30_000);

	const hits: CurseForgeSearchHit[] = response.data.map(item => ({
		id: item.modId,
		name: item.name,
		summary: item.summary,
		authorName: item.authorName,
		downloadCount: item.downloadCount,
		iconUrl: item.iconUrl,
		categories: item.categories ?? [],
		game: item.game,
		latestFilesId: item.latestFilesId
	}));
	return { hits, total: response.data.length };
}

/**
 * Returns the latest compatible CurseForge file for a given mod.
 */
export async function getCurseForgeVersions(
	modId: number,
	instance: Instance,
	apiKey?: string,
	abortSignal?: AbortSignal
): Promise<CurseForgeVersion[]> {
	const cfGameId = 438;
	const cfMcVersion = encodeURIComponent(instance.config.minecraftVersion);
	const url = `${CURSEFORGE}/v1/mods/${modId}/files?gameId=${cfGameId}&gamePopFilter=${cfMcVersion}&pageSize=50`;
	const response = await fetchJson<{ data: Array<{
		id: number;
		modId: number;
		displayName: string;
		fileName: string;
		fileUrl: string;
		fileDate: string;
		version: string;
		type: string;
		hash: { algo: string; value: string };
		gameVersions: string[];
	}>}(url, cfHeaders(apiKey), 30_000);
	return response.data;
}

/**
 * Installs a specific CurseForge mod version into the mods folder.
 */
export async function installCurseForgeFile(
	instance: Instance,
	modId: number,
	fileId: number,
	onProgress: (message: string, percentage?: number) => void,
	abortSignal?: AbortSignal,
	apiKey?: string
): Promise<InstallModResult> {
	const versions = await getCurseForgeVersions(modId, instance, apiKey, abortSignal);
	const file = versions.find(v => v.id === fileId);
	if (!file) {
		throw new Error(`找不到 CurseForge 文件 ${fileId}`);
	}

	await ensureDir(instance.modsDir);
	const target = path.join(instance.modsDir, file.fileName);
	await fs.promises.rm(`${target}.disabled`, { force: true });

	onProgress(`正在下载 ${file.displayName}…`, 0);
	await downloadFile(file.fileUrl, target, cfHeaders(apiKey), 2, abortSignal);

	// CurseForge uses MD5 hashes.
	if (file.hash.algo.toUpperCase() === 'MD5' && file.hash.value) {
		const actual = await hashFile(target, 'md5');
		if (actual.toLowerCase() !== file.hash.value.toLowerCase()) {
			await fs.promises.rm(target, { force: true });
			throw new Error(`${file.fileName} 校验失败，已删除损坏文件`);
		}
	}

	const records = await loadInstalledMods(instance);
	records[file.fileName] = {
		projectId: String(modId),
		versionId: String(file.id),
		name: file.displayName,
		versionNumber: file.version,
		url: file.fileUrl,
		fileSize: undefined,
		sha1: undefined,
		sha512: undefined,
		installedAt: new Date().toISOString(),
		source: 'modrinth' // reuse the record shape; source is informational only
	};
	await saveInstalledMods(instance, records);

	onProgress(`已安装 ${file.displayName}`, 100);
	return {
		installed: [{ name: file.displayName, version: file.version, fileName: file.fileName, dependency: false }],
		warnings: [],
		versions: []
	};
}
