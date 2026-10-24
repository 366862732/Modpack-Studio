import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { ensureDir, pathExists, readJson, slugify, writeJson } from './util';

export type LoaderKind = 'vanilla' | 'fabric' | 'forge' | 'neoforge' | 'quilt';

export interface InstanceConfig {
	schemaVersion: 1;
	id: string;
	name: string;
	description?: string;
	minecraftVersion: string;
	loader: LoaderKind;
	loaderVersion?: string;
	/** Installed version folder used by the launcher, e.g. `1.20.1-forge-47.2.0`. */
	versionId?: string;
	javaPath?: string;
	memoryMb?: number;
	jvmArgs?: string[];
	launchArgs?: string[];
	created: string;
	lastPlayed?: string;
	lastServerPort?: number;
}

export const LOADER_LABELS: Record<LoaderKind, string> = {
	vanilla: '原版',
	fabric: 'Fabric',
	forge: 'Forge',
	neoforge: 'NeoForge',
	quilt: 'Quilt'
};

export function describeLoader(config: Pick<InstanceConfig, 'loader' | 'loaderVersion'>): string {
	const label = LOADER_LABELS[config.loader] ?? config.loader;
	return config.loaderVersion ? `${label} ${config.loaderVersion}` : label;
}

export class Instance {
	constructor(readonly dir: string, public config: InstanceConfig) { }

	get name(): string {
		return this.config.name;
	}

	/** The actual `.minecraft` directory (named `minecraft` for readability). */
	get gameDir(): string {
		return path.join(this.dir, 'minecraft');
	}

	get metaDir(): string {
		return path.join(this.dir, '.modpack-studio');
	}

	get modsDir(): string {
		return path.join(this.gameDir, 'mods');
	}

	get configDir(): string {
		return path.join(this.gamesDir, 'config');
	}

	get gamesDir(): string {
		return this.gameDir;
	}

	get logsDir(): string {
		return path.join(this.gameDir, 'logs');
	}

	get crashReportsDir(): string {
		return path.join(this.gameDir, 'crash-reports');
	}

	get versionsDir(): string {
		return path.join(this.gameDir, 'versions');
	}

	get instanceJsonPath(): string {
		return path.join(this.dir, 'instance.json');
	}

	get installedModsPath(): string {
		return path.join(this.metaDir, 'installed-mods.json');
	}

	get description(): string {
		return `${describeLoader(this.config)} · ${this.config.minecraftVersion}`;
	}

	async save(): Promise<void> {
		await writeJson(this.instanceJsonPath, this.config);
	}

	async ensureLayout(): Promise<void> {
		await Promise.all([
			ensureDir(this.modsDir),
			ensureDir(this.configDir),
			ensureDir(path.join(this.gameDir, 'resourcepacks')),
			ensureDir(path.join(this.gameDir, 'shaderpacks')),
			ensureDir(path.join(this.gameDir, 'datapacks')),
			ensureDir(this.logsDir),
			ensureDir(this.metaDir)
		]);
	}
}

export class InstanceStore {
	private cached: Instance[] | undefined;

	constructor(private readonly context: vscode.ExtensionContext) { }

	get home(): string {
		const configured = vscode.workspace.getConfiguration('modpack').get<string>('home', '').trim();
		const base = configured || path.join(process.env.USERPROFILE || process.env.HOME || process.cwd(), 'ModpackStudio');
		return path.resolve(base.replace(/^~(?=$|[\\/])/, process.env.USERPROFILE || process.env.HOME || ''));
	}

	get instancesRoot(): string {
		return path.join(this.home, 'instances');
	}

	invalidate(): void {
		this.cached = undefined;
	}

	async list(): Promise<Instance[]> {
		if (this.cached) {
			return this.cached;
		}
		const result: Instance[] = [];
		await ensureDir(this.instancesRoot);
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(this.instancesRoot, { withFileTypes: true });
		} catch {
			entries = [];
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) {
				continue;
			}
			const instance = await this.load(path.join(this.instancesRoot, entry.name));
			if (instance) {
				result.push(instance);
			}
		}
		result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'));
		this.cached = result;
		return result;
	}

	async load(dir: string): Promise<Instance | undefined> {
		const candidates = [
			path.join(dir, 'instance.json'),
			path.join(dir, '.modpack-studio', 'instance.json')
		];
		for (const candidate of candidates) {
			if (!await pathExists(candidate)) {
				continue;
			}
			try {
				const config = await readJson<InstanceConfig>(candidate);
				if (!config?.minecraftVersion || !config.loader) {
					continue;
				}
				// Instances imported from older layouts may have the game files in `.minecraft`.
				const legacyGame = path.join(dir, '.minecraft');
				if (!await pathExists(path.join(dir, 'minecraft')) && await pathExists(legacyGame)) {
					await fs.promises.rename(legacyGame, path.join(dir, 'minecraft'));
				}
				return new Instance(dir, config);
			} catch {
				// Ignore broken instance metadata, keep the rest of the list usable.
			}
		}
		return undefined;
	}

	async create(options: {
		name: string;
		minecraftVersion: string;
		loader: LoaderKind;
		loaderVersion?: string;
		description?: string;
	}): Promise<Instance> {
		const baseId = slugify(options.name);
		let id = baseId;
		let index = 2;
		while (await pathExists(path.join(this.instancesRoot, id))) {
			id = `${baseId}-${index++}`;
		}
		const dir = path.join(this.instancesRoot, id);
		const config: InstanceConfig = {
			schemaVersion: 1,
			id,
			name: options.name,
			description: options.description,
			minecraftVersion: options.minecraftVersion,
			loader: options.loader,
			loaderVersion: options.loaderVersion,
			created: new Date().toISOString()
		};
		const instance = new Instance(dir, config);
		await instance.ensureLayout();
		await instance.save();
		await this.setActive(instance);
		this.invalidate();
		return instance;
	}

	async remove(instance: Instance): Promise<void> {
		await vscode.workspace.fs.delete(vscode.Uri.file(instance.dir), { recursive: true, useTrash: true });
		if (this.getActiveId() === instance.config.id) {
			await this.context.globalState.update('modpack.activeInstance', undefined);
		}
		this.invalidate();
	}

	getActiveId(): string | undefined {
		return this.context.globalState.get<string>('modpack.activeInstance');
	}

	async setActive(instance: Instance | undefined): Promise<void> {
		await this.context.globalState.update('modpack.activeInstance', instance?.config.id);
	}

	/** Prefer the instance opened as the current workspace, fall back to the last selected one. */
	async active(): Promise<Instance | undefined> {
		for (const folder of vscode.workspace.workspaceFolders ?? []) {
			if (folder.uri.scheme !== 'file') {
				continue;
			}
			const candidate = await this.load(folder.uri.fsPath);
			if (candidate) {
				return candidate;
			}
		}
		const id = this.getActiveId();
		if (!id) {
			return undefined;
		}
		const instances = await this.list();
		return instances.find(instance => instance.config.id === id) ?? instances[0];
	}

	async pick(): Promise<Instance | undefined> {
		const instances = await this.list();
		if (instances.length === 0) {
			const create = await vscode.window.showInformationMessage('还没有整合包，是否现在新建一个？', '新建整合包', '导入整合包');
			if (create === '新建整合包') {
				await vscode.commands.executeCommand('modpack.createInstance');
			} else if (create === '导入整合包') {
				await vscode.commands.executeCommand('modpack.importInstance');
			}
			return undefined;
		}
		const active = await this.active();
		if (instances.length === 1) {
			return instances[0];
		}
		const picked = await vscode.window.showQuickPick(
			instances.map(instance => ({
				label: instance.name,
				description: active?.config.id === instance.config.id ? `${instance.description} · 当前` : instance.description,
				instance
			})),
			{ placeHolder: '选择整合包' }
		);
		return picked?.instance;
	}
}
