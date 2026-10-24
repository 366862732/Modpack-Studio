import AdmZip from 'adm-zip';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Instance, InstanceStore, LoaderKind } from './instance';
import { loadInstalledMods, scanMods } from './mods';
import { downloadFile, ensureDir, hashFile, pathExists, readJson } from './util';

export type PackFormat = 'mrpack' | 'curseforge' | 'zip';

export const PACK_FORMAT_LABELS: Record<PackFormat, string> = {
	mrpack: 'Modrinth 整合包 (.mrpack)',
	curseforge: 'CurseForge 整合包 (.zip)',
	zip: '通用整合包 (.zip)'
};

const RUNTIME_DIRS = new Set(['versions', 'libraries', 'assets', 'logs', 'crash-reports', 'saves', 'runtime', '.modpack-studio', 'server.jar', 'fabric-server-launch.jar']);
const OVERRIDE_ROOTS = ['config', 'defaultconfigs', 'kubejs', 'scripts', 'resourcepacks', 'shaderpacks', 'options.txt', 'servers.dat', 'icon.png'];

interface MrpackIndex {
	formatVersion: number;
	game: 'minecraft';
	versionId: string;
	name: string;
	summary?: string;
	files: Array<{
		path: string;
		hashes: { sha1?: string; sha512?: string };
		env?: { client?: string; server?: string };
		downloads: string[];
		fileSize?: number;
	}>;
	dependencies: Record<string, string>;
}

interface CurseManifest {
	minecraft: {
		version: string;
		modLoaders?: Array<{ id: string; primary: boolean }>;
	};
	manifestType: string;
	manifestVersion: number;
	name: string;
	version: string;
	author?: string;
	files: Array<{ projectID: number; fileID: number; required?: boolean }>;
	overrides?: string;
}

export interface ExportResult {
	file: string;
	format: PackFormat;
	mods: number;
	skipped: string[];
}

export interface ImportResult {
	instance: Instance;
	format: PackFormat | 'prism' | 'folder';
	warnings: string[];
}

export async function exportPack(instance: Instance, format: PackFormat, target: string, onProgress: (message: string) => void): Promise<ExportResult> {
	const mods = (await scanMods(instance)).filter(mod => mod.enabled);
	const records = await loadInstalledMods(instance);
	const zip = new AdmZip();
	const skipped: string[] = [];
	let countedMods = 0;

	if (format === 'mrpack') {
		const index: MrpackIndex = {
			formatVersion: 1,
			game: 'minecraft',
			versionId: '1.0.0',
			name: instance.name,
			summary: instance.config.description ?? `${instance.description} 整合包`,
			files: [],
			dependencies: { minecraft: instance.config.minecraftVersion }
		};
		if (instance.config.loader === 'fabric' && instance.config.loaderVersion) {
			index.dependencies['fabric-loader'] = instance.config.loaderVersion;
		} else if (instance.config.loader === 'forge' && instance.config.loaderVersion) {
			index.dependencies.forge = instance.config.loaderVersion;
		} else if (instance.config.loader === 'neoforge' && instance.config.loaderVersion) {
			index.dependencies.neoforge = instance.config.loaderVersion;
		} else if (instance.config.loader === 'quilt' && instance.config.loaderVersion) {
			index.dependencies['quilt-loader'] = instance.config.loaderVersion;
		}
		const overrides = new Set<string>();
		for (const mod of mods) {
			const record = records[mod.fileName.replace(/\.disabled$/i, '')];
			if (record?.source === 'modrinth' && record.url && (record.sha1 || record.sha512) && !mod.fileName.endsWith('.disabled')) {
				onProgress(`写入索引：${mod.fileName}`);
				index.files.push({
					path: `mods/${mod.fileName}`,
					hashes: { sha1: record.sha1, sha512: record.sha512 },
					env: { client: 'required', server: 'required' },
					downloads: [record.url],
					fileSize: record.fileSize
				});
				countedMods++;
			} else {
				skipped.push(mod.fileName);
				overrides.add(mod.file);
			}
		}
		zip.addFile('modrinth.index.json', Buffer.from(JSON.stringify(index, undefined, 2), 'utf8'));
		await addOverrides(zip, instance, 'overrides', overrides);
	} else if (format === 'curseforge') {
		const manifest: CurseManifest = {
			minecraft: {
				version: instance.config.minecraftVersion,
				modLoaders: instance.config.loaderVersion
					? [{
						id: instance.config.loader === 'neoforge'
							? `neoforge-${instance.config.loaderVersion}`
							: `${instance.config.loader}-${instance.config.loaderVersion}`,
						primary: true
					}]
					: []
			},
			manifestType: 'minecraftModpack',
			manifestVersion: 1,
			name: instance.name,
			version: '1.0.0',
			author: 'Modpack Studio',
			files: [],
			overrides: 'overrides'
		};
		zip.addFile('manifest.json', Buffer.from(JSON.stringify(manifest, undefined, 2), 'utf8'));
		const modList = mods.map(mod => `<li><a href="https://modrinth.com/mod/${mod.projectId ?? ''}">${escapeHtml(mod.name)} (${escapeHtml(mod.version ?? '')})</a></li>`).join('\n');
		zip.addFile('modlist.html', Buffer.from(`<ul>\n${modList}\n</ul>`, 'utf8'));
		for (const mod of mods) {
			if (mod.fileName.endsWith('.disabled')) {
				continue;
			}
			zip.addLocalFile(mod.file, 'overrides/mods', mod.fileName);
			countedMods++;
		}
		await addOverrides(zip, instance, 'overrides', new Set());
	} else {
		for (const mod of mods) {
			if (mod.fileName.endsWith('.disabled')) {
				continue;
			}
			zip.addLocalFile(mod.file, 'mods', mod.fileName);
			countedMods++;
		}
		await addOverrides(zip, instance, '', new Set());
		zip.addFile('整合包说明.txt', Buffer.from([
			`${instance.name}`,
			`Minecraft ${instance.config.minecraftVersion} / ${instance.description}`,
			'',
			`Java：请使用 ${instance.config.loader === 'forge' || instance.config.loader === 'neoforge' ? 'Java 17 或 21' : 'Java 21'}。`,
			'将本压缩包解压到 .minecraft 目录即可使用。'
		].join('\r\n'), 'utf8'));
	}

	await ensureDir(path.dirname(target));
	zip.writeZip(target);
	return { file: target, format, mods: countedMods, skipped };
}

async function addOverrides(zip: AdmZip, instance: Instance, prefix: string, extraMods: Set<string>): Promise<void> {
	for (const root of OVERRIDE_ROOTS) {
		const source = path.join(instance.gameDir, root);
		if (!await pathExists(source)) {
			continue;
		}
		const stat = await fs.promises.stat(source);
		if (stat.isFile()) {
			zip.addLocalFile(source, prefix);
		} else {
			await addDirectory(zip, source, prefix ? `${prefix}/${root}` : root, extraMods);
		}
	}
	for (const modFile of extraMods) {
		const stat = await fs.promises.stat(modFile).catch(() => undefined);
		if (stat?.isFile()) {
			zip.addLocalFile(modFile, prefix ? `${prefix}/mods` : 'mods');
		}
	}
}

async function addDirectory(zip: AdmZip, source: string, zipPath: string, extraMods: Set<string>): Promise<void> {
	const entries = await fs.promises.readdir(source, { withFileTypes: true });
	for (const entry of entries) {
		if (RUNTIME_DIRS.has(entry.name)) {
			continue;
		}
		const full = path.join(source, entry.name);
		if (extraMods.has(full)) {
			continue;
		}
		if (entry.isDirectory()) {
			await addDirectory(zip, full, `${zipPath}/${entry.name}`, extraMods);
		} else if (entry.isFile()) {
			zip.addLocalFile(full, zipPath);
		}
	}
}

export async function importPack(source: string, store: InstanceStore, onProgress: (message: string) => void): Promise<ImportResult> {
	const stat = await fs.promises.stat(source);
	if (stat.isDirectory()) {
		return importFolder(source, store, onProgress);
	}
	const zip = new AdmZip(source);
	const entries = zip.getEntries().map(entry => entry.entryName.replace(/\\/g, '/'));
	if (entries.includes('modrinth.index.json')) {
		return importMrpack(zip, store, onProgress);
	}
	if (entries.includes('manifest.json')) {
		return importCurseForge(zip, store, onProgress);
	}
	if (entries.some(entry => entry.endsWith('mmc-pack.json'))) {
		const prefix = entries.find(entry => entry.endsWith('mmc-pack.json'))!.replace(/mmc-pack\.json$/, '');
		return importPrismZip(zip, store, onProgress, prefix);
	}
	throw new Error('无法识别整合包格式。支持 Modrinth .mrpack、CurseForge 整合包、Prism/MultiMC 实例和普通整合包目录。');
}

async function importMrpack(zip: AdmZip, store: InstanceStore, onProgress: (message: string) => void): Promise<ImportResult> {
	const index = JSON.parse(zip.readAsText('modrinth.index.json')) as MrpackIndex;
	const { loader, loaderVersion } = dependenciesToLoader(index.dependencies);
	onProgress(`创建整合包“${index.name}”…`);
	const instance = await store.create({
		name: index.name || path.basename(index.versionId ?? '整合包'),
		minecraftVersion: index.dependencies.minecraft,
		loader,
		loaderVersion,
		description: index.summary
	});
	await extractOverrides(zip, instance, 'overrides');
	const warnings: string[] = [];
	const files = index.files.filter(file => file.env?.client !== 'unsupported');
	let installed = 0;
	for (const file of files) {
		const relative = sanitizeRelative(file.path);
		if (!relative) {
			warnings.push(`跳过非法路径：${file.path}`);
			continue;
		}
		const target = path.join(instance.gameDir, relative);
		const url = file.downloads[0];
		if (!url) {
			warnings.push(`缺少下载地址：${file.path}`);
			continue;
		}
		onProgress(`下载 ${relative}（${installed + 1}/${files.length}）…`);
		try {
			await downloadFile(url, target);
			if (file.hashes.sha512) {
				const actual = await hashFile(target, 'sha512');
				if (actual.toLowerCase() !== file.hashes.sha512.toLowerCase()) {
					await fs.promises.rm(target, { force: true });
					warnings.push(`校验失败：${file.path}`);
					continue;
				}
			}
			installed++;
		} catch (error) {
			warnings.push(`${relative} 下载失败：${error instanceof Error ? error.message : error}`);
		}
	}
	if (files.length > 0 && installed === 0) {
		warnings.push('所有文件都未能下载，请检查网络或稍后重试。');
	}
	return { instance, format: 'mrpack', warnings };
}

async function importCurseForge(zip: AdmZip, store: InstanceStore, onProgress: (message: string) => void): Promise<ImportResult> {
	const manifest = JSON.parse(zip.readAsText('manifest.json')) as CurseManifest;
	const loaderEntry = manifest.minecraft.modLoaders?.find(loader => loader.primary) ?? manifest.minecraft.modLoaders?.[0];
	const { loader, loaderVersion } = curseLoader(loaderEntry?.id);
	onProgress(`创建整合包“${manifest.name}”…`);
	const instance = await store.create({
		name: manifest.name,
		minecraftVersion: manifest.minecraft.version,
		loader,
		loaderVersion
	});
	await extractOverrides(zip, instance, manifest.overrides || 'overrides');
	const warnings: string[] = [];
	const apiKey = vscode.workspace.getConfiguration('modpack').get<string>('curseforgeApiKey', '').trim();
	if (!apiKey) {
		if (manifest.files.length > 0) {
			warnings.push(`CurseForge 需要 API Key 才能自动下载 ${manifest.files.length} 个模组。请在设置中填写 modpack.curseforgeApiKey，或手动下载后放入 mods 目录。`);
		}
	} else {
		for (let index = 0; index < manifest.files.length; index++) {
			const file = manifest.files[index];
			onProgress(`下载 CurseForge 文件 ${index + 1}/${manifest.files.length}…`);
			try {
				const response = await fetch(`https://api.curseforge.com/v1/mods/${file.projectID}/files/${file.fileID}`, {
					headers: { 'x-api-key': apiKey, 'Accept': 'application/json', 'User-Agent': 'ModpackStudio/0.1.0' }
				});
				if (!response.ok) {
					throw new Error(`HTTP ${response.status}`);
				}
				const payload = await response.json() as { data?: { downloadUrl?: string | null; fileName?: string } };
				const data = payload.data;
				if (!data?.downloadUrl || !data.fileName) {
					throw new Error('CurseForge 未提供下载地址');
				}
				await downloadFile(data.downloadUrl, path.join(instance.modsDir, data.fileName));
			} catch (error) {
				warnings.push(`项目 ${file.projectID} / 文件 ${file.fileID} 下载失败：${error instanceof Error ? error.message : error}`);
			}
		}
	}
	return { instance, format: 'curseforge', warnings };
}

async function importPrismZip(zip: AdmZip, store: InstanceStore, onProgress: (message: string) => void, prefix: string): Promise<ImportResult> {
	const packText = zip.readAsText(`${prefix}mmc-pack.json`);
	const components = (JSON.parse(packText).components ?? []) as Array<{ uid: string; version: string }>;
	const minecraft = components.find(component => component.uid === 'net.minecraft')?.version;
	if (!minecraft) {
		throw new Error('Prism 实例缺少 Minecraft 版本信息');
	}
	const loader = detectPrismLoader(components);
	onProgress('创建整合包…');
	const instance = await store.create({
		name: path.basename(prefix) || '导入的整合包',
		minecraftVersion: minecraft,
		loader: loader.loader,
		loaderVersion: loader.version
	});
	const minecraftPrefix = `${prefix}.minecraft/`;
	for (const entry of zip.getEntries()) {
		if (!entry.entryName.startsWith(minecraftPrefix) || entry.isDirectory) {
			continue;
		}
		const relative = entry.entryName.slice(minecraftPrefix.length);
		if (relative.startsWith('versions/') || relative.startsWith('libraries/') || relative.startsWith('assets/') || relative.startsWith('logs/')) {
			continue;
		}
		await writeEntry(entry, instance.gameDir, relative);
	}
	return { instance, format: 'prism', warnings: [] };
}

function detectPrismLoader(components: Array<{ uid: string; version: string }>): { loader: LoaderKind; version?: string } {
	const fabric = components.find(component => component.uid === 'net.fabricmc.fabric-loader');
	if (fabric) {
		return { loader: 'fabric', version: fabric.version };
	}
	const quilt = components.find(component => component.uid === 'org.quiltmc.quilt-loader');
	if (quilt) {
		return { loader: 'quilt', version: quilt.version };
	}
	const neo = components.find(component => component.uid === 'net.neoforged');
	if (neo) {
		return { loader: 'neoforge', version: neo.version };
	}
	const forge = components.find(component => component.uid === 'net.minecraftforge');
	if (forge) {
		return { loader: 'forge', version: forge.version };
	}
	return { loader: 'vanilla' };
}

async function importFolder(folder: string, store: InstanceStore, onProgress: (message: string) => void): Promise<ImportResult> {
	const prismConfig = path.join(folder, 'mmc-pack.json');
	if (await pathExists(prismConfig)) {
		const components = (await readJson<{ components?: Array<{ uid: string; version: string }> }>(prismConfig)).components ?? [];
		const minecraft = components.find(component => component.uid === 'net.minecraft')?.version;
		if (!minecraft) {
			throw new Error('Prism 实例缺少 Minecraft 版本信息');
		}
		const loader = detectPrismLoader(components);
		onProgress(`创建整合包“${path.basename(folder)}”…`);
		const instance = await store.create({
			name: path.basename(folder),
			minecraftVersion: minecraft,
			loader: loader.loader,
			loaderVersion: loader.version
		});
		const gameDir = path.join(folder, '.minecraft');
		await copyIfExists(gameDir, instance.gameDir, ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'kubejs', 'scripts', 'options.txt']);
		return { instance, format: 'prism', warnings: [] };
	}

	onProgress('正在识别整合包目录…');
	const gameDir = await pathExists(path.join(folder, 'minecraft')) ? path.join(folder, 'minecraft') : folder;
	const guessedVersion = await guessMinecraftVersion(gameDir);
	const instance = await store.create({
		name: path.basename(folder) || '导入的整合包',
		minecraftVersion: guessedVersion ?? '1.20.1',
		loader: 'vanilla'
	});
	await copyIfExists(gameDir, instance.gameDir, ['mods', 'config', 'defaultconfigs', 'resourcepacks', 'shaderpacks', 'kubejs', 'scripts', 'options.txt']);
	const warnings = guessedVersion
		? ['未能从目录中识别加载器，已按原版导入。请根据实际使用的 Forge/Fabric 版本在实例设置中调整。']
		: ['未能识别 Minecraft 版本，已默认使用 1.20.1。请在实例设置中修改。'];
	return { instance, format: 'folder', warnings };
}

async function guessMinecraftVersion(gameDir: string): Promise<string | undefined> {
	try {
		const versions = await fs.promises.readdir(path.join(gameDir, 'versions'), { withFileTypes: true });
		const names = versions.filter(entry => entry.isDirectory()).map(entry => entry.name);
		const mc = names.find(name => /^1\.\d+(\.\d+)?$/.test(name));
		return mc;
	} catch {
		return undefined;
	}
}

async function copyIfExists(sourceDir: string, targetDir: string, names: string[]): Promise<void> {
	for (const name of names) {
		const source = path.join(sourceDir, name);
		if (!await pathExists(source)) {
			continue;
		}
		const target = path.join(targetDir, name);
		await ensureDir(path.dirname(target));
		await fs.promises.cp(source, target, { recursive: true, force: true });
	}
}

function dependenciesToLoader(dependencies: Record<string, string>): { loader: LoaderKind; loaderVersion?: string } {
	if (dependencies['fabric-loader']) {
		return { loader: 'fabric', loaderVersion: dependencies['fabric-loader'] };
	}
	if (dependencies.neoforge) {
		return { loader: 'neoforge', loaderVersion: dependencies.neoforge };
	}
	if (dependencies.forge) {
		return { loader: 'forge', loaderVersion: dependencies.forge };
	}
	if (dependencies['quilt-loader']) {
		return { loader: 'quilt', loaderVersion: dependencies['quilt-loader'] };
	}
	return { loader: 'vanilla' };
}

function curseLoader(id: string | undefined): { loader: LoaderKind; loaderVersion?: string } {
	if (!id) {
		return { loader: 'vanilla' };
	}
	if (id.startsWith('forge-')) {
		return { loader: 'forge', loaderVersion: id.slice('forge-'.length) };
	}
	if (id.startsWith('neoforge-')) {
		return { loader: 'neoforge', loaderVersion: id.slice('neoforge-'.length) };
	}
	if (id.startsWith('fabric-')) {
		return { loader: 'fabric', loaderVersion: id.slice('fabric-'.length) };
	}
	if (id.startsWith('quilt-')) {
		return { loader: 'quilt', loaderVersion: id.slice('quilt-'.length) };
	}
	return { loader: 'vanilla' };
}

async function extractOverrides(zip: AdmZip, instance: Instance, prefix: string): Promise<void> {
	const normalized = prefix.replace(/\\/g, '/').replace(/\/$/, '');
	for (const entry of zip.getEntries()) {
		if (entry.isDirectory || !entry.entryName.replace(/\\/g, '/').startsWith(`${normalized}/`)) {
			continue;
		}
		const relative = entry.entryName.replace(/\\/g, '/').slice(normalized.length + 1);
		if (relative.startsWith('mods/') || relative === 'mods') {
			// Overrides mods are real jars and belong next to downloaded mods.
		}
		await writeEntry(entry, instance.gameDir, relative);
	}
}

async function writeEntry(entry: AdmZip.IZipEntry, root: string, relative: string): Promise<void> {
	const safe = sanitizeRelative(relative);
	if (!safe) {
		return;
	}
	const target = path.join(root, safe);
	await ensureDir(path.dirname(target));
	await fs.promises.writeFile(target, entry.getData());
}

function sanitizeRelative(relative: string): string | undefined {
	const normalized = relative.replace(/\\/g, '/').replace(/^\/+/, '');
	if (!normalized || normalized.split('/').includes('..')) {
		return undefined;
	}
	return normalized;
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]!));
}
