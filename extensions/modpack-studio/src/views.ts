import * as vscode from 'vscode';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseService } from './db';
import { Instance, InstanceStore } from './instance';
import { LogIssue, LogService } from './logs';
import { ModInfo, describeMod } from './mods';
import { formatBytes } from './util';

export class InstancesProvider implements vscode.TreeDataProvider<Instance> {
	private readonly changed = new vscode.EventEmitter<Instance | undefined>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(private readonly store: InstanceStore) { }

	refresh(): void {
		this.store.invalidate();
		this.changed.fire(undefined);
	}

	async getChildren(): Promise<Instance[]> {
		return this.store.list();
	}

	getTreeItem(instance: Instance): vscode.TreeItem {
		const item = new vscode.TreeItem(instance.name, vscode.TreeItemCollapsibleState.None);
		const active = this.store.getActiveId() === instance.config.id;
		item.description = `${instance.description}${active ? '  ·  当前' : ''}`;
		item.contextValue = 'instance';
		item.iconPath = new vscode.ThemeIcon(active ? 'package' : 'archive');
		item.tooltip = new vscode.MarkdownString([
			`**${instance.name}**`,
			'',
			`- Minecraft：\`${instance.config.minecraftVersion}\``,
			`- 加载器：\`${instance.description}\``,
			`- 目录：\`${instance.dir}\``,
			instance.config.lastPlayed ? `- 上次启动：${new Date(instance.config.lastPlayed).toLocaleString('zh-CN')}` : undefined
		].filter(Boolean).join('\n'));
		item.command = {
			command: 'modpack.openInstance',
			title: '打开整合包',
			arguments: [instance]
		};
		return item;
	}
}

export class ModsProvider implements vscode.TreeDataProvider<ModInfo> {
	private readonly changed = new vscode.EventEmitter<ModInfo | undefined>();
	private mods: ModInfo[] = [];
	private instance: Instance | undefined;

	readonly onDidChangeTreeData = this.changed.event;

	constructor() { }

	get activeMods(): readonly ModInfo[] {
		return this.mods;
	}

	get activeInstance(): Instance | undefined {
		return this.instance;
	}

	refresh(mods: ModInfo[], instance: Instance | undefined): void {
		this.mods = mods;
		this.instance = instance;
		this.changed.fire(undefined);
	}

	getChildren(): ModInfo[] {
		return this.mods;
	}

	getTreeItem(mod: ModInfo): vscode.TreeItem {
		const item = new vscode.TreeItem(mod.name, vscode.TreeItemCollapsibleState.None);
		item.id = mod.file;
		item.description = describeMod(mod);
		item.contextValue = 'mod';
		item.iconPath = new vscode.ThemeIcon(mod.enabled ? 'package' : 'circle-slash');
		item.checkboxState = {
			state: mod.enabled ? vscode.TreeItemCheckboxState.Checked : vscode.TreeItemCheckboxState.Unchecked,
			tooltip: mod.enabled ? '已启用，取消勾选可禁用' : '已禁用，勾选可启用'
		};
		const tooltip = new vscode.MarkdownString([
			`**${mod.name}** ${mod.version ? `\`${mod.version}\`` : ''}`,
			mod.description ? `\n${mod.description}` : '',
			'',
			`- 文件：\`${mod.fileName}\``,
			`- 加载器：\`${mod.loader ?? '未知'}\``,
			mod.modId ? `- Mod ID：\`${mod.modId}\`` : '',
			mod.authors?.length ? `- 作者：${mod.authors.join('、')}` : '',
			mod.projectId ? `- Modrinth：\`${mod.projectId}\`` : '',
			mod.dependencies.length ? `\n**依赖：** ${mod.dependencies.map(dependency => dependency.modId).join('、')}` : ''
		].filter(Boolean).join('\n'));
		item.tooltip = tooltip;
		return item;
	}
}

export interface RunNode {
	kind: 'status' | 'instance' | 'java' | 'memory' | 'database' | 'action';
	label: string;
	description?: string;
	tooltip?: string;
	icon?: string;
	command?: vscode.Command;
	contextValue?: string;
}

export class RunProvider implements vscode.TreeDataProvider<RunNode> {
	private readonly changed = new vscode.EventEmitter<RunNode | undefined>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(
		private readonly store: InstanceStore,
		private readonly logs: LogService,
		private readonly db: DatabaseService
	) { }

	refresh(): void {
		this.changed.fire(undefined);
	}

	async getChildren(): Promise<RunNode[]> {
		const instance = await this.store.active();
		if (!instance) {
			return [];
		}
		const java = instance.config.javaPath || '自动检测';
		const memory = instance.config.memoryMb ?? vscode.workspace.getConfiguration('modpack').get<number>('memoryMb', 4096);
		const running = this.logs.running;
		const runningLabel = running
			? `运行中（${this.logs.runningKind === 'server' ? '服务端' : '客户端'}）`
			: '未运行';
		const nodes: RunNode[] = [
			{
				kind: 'status',
				label: '运行状态',
				description: runningLabel,
				icon: running ? 'debug-start' : 'circle-outline',
				contextValue: 'run'
			},
			{
				kind: 'instance',
				label: instance.name,
				description: `${instance.config.minecraftVersion} · ${instance.description}`,
				icon: 'package',
				tooltip: instance.dir
			},
			{
				kind: 'java',
				label: 'Java',
				description: java,
				icon: 'java',
				command: { command: 'modpack.setJava', title: '选择 Java' }
			},
			{
				kind: 'memory',
				label: '分配内存',
				description: `${memory} MB`,
				icon: 'dashboard',
				command: { command: 'modpack.setMemory', title: '设置内存' }
			},
			{
				kind: 'database',
				label: '模组资料库',
				description: this.db.statusText,
				icon: this.db.available ? 'database' : 'database',
				command: { command: 'modpack.configureDatabase', title: '配置数据库' }
			},
			{
				kind: 'action',
				label: running ? '停止运行' : '启动游戏',
				description: running ? undefined : '客户端',
				icon: running ? 'debug-stop' : 'play',
				command: { command: running ? 'modpack.stopGame' : 'modpack.launchClient', title: '启动' }
			},
			{
				kind: 'action',
				label: '启动服务端',
				description: '控制台调试',
				icon: 'server-process',
				command: { command: 'modpack.launchServer', title: '启动服务端' }
			},
			{
				kind: 'action',
				label: '安装 / 修复游戏文件',
				icon: 'cloud-download',
				command: { command: 'modpack.installGame', title: '安装游戏' }
			},
			{
				kind: 'action',
				label: '导出整合包',
				icon: 'archive',
				command: { command: 'modpack.exportPack', title: '导出' }
			},
			{
				kind: 'action',
				label: '打开日志',
				icon: 'output',
				command: { command: 'modpack.openLogs', title: '打开日志' }
			}
		];
		if (running && this.logs.runningKind === 'server') {
			nodes.push({
				kind: 'action',
				label: '向服务端发送命令',
				icon: 'terminal',
				command: { command: 'modpack.serverCommand', title: '发送命令' }
			});
		}
		return nodes;
	}

	getTreeItem(node: RunNode): vscode.TreeItem {
		const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
		item.description = node.description;
		item.tooltip = node.tooltip;
		item.iconPath = node.icon ? new vscode.ThemeIcon(node.icon) : undefined;
		item.contextValue = node.contextValue ?? 'run';
		item.command = node.command;
		return item;
	}
}

export class IssuesProvider implements vscode.TreeDataProvider<LogIssue> {
	private readonly changed = new vscode.EventEmitter<LogIssue | undefined>();
	readonly onDidChangeTreeData = this.changed.event;

	constructor(
		private readonly logs: LogService,
		private readonly modIssues: () => LogIssue[] = () => []
	) { }

	refresh(): void {
		this.changed.fire(undefined);
	}

	getChildren(): LogIssue[] {
		return [...this.logs.issues, ...this.modIssues()];
	}

	getTreeItem(issue: LogIssue): vscode.TreeItem {
		const item = new vscode.TreeItem(issue.message, vscode.TreeItemCollapsibleState.None);
		item.description = issue.hint?.split('\n')[0];
		item.tooltip = new vscode.MarkdownString([`**${issue.message}**`, '', issue.hint ?? '', issue.file ? `\n文件：\`${issue.file}\`` : ''].join('\n'));
		item.iconPath = new vscode.ThemeIcon(issue.severity === 'error' ? 'error' : issue.severity === 'warning' ? 'warning' : 'info');
		item.contextValue = 'issue';
		item.command = issue.file
			? { command: 'modpack.revealIssue', title: '打开日志', arguments: [issue] }
			: undefined;
		return item;
	}
}

// ---------------------------------------------------------------------------
// 资源包 / 光影 / 数据包
// ---------------------------------------------------------------------------

export interface AssetNode {
	kind: 'resourcepack' | 'shader' | 'datapack';
	name: string;
	file: string;
	size: number;
	enabled: boolean;
}

export class AssetProvider implements vscode.TreeDataProvider<AssetNode> {
	private readonly changed = new vscode.EventEmitter<AssetNode | undefined>();
	private instance: Instance | undefined;

	readonly onDidChangeTreeData = this.changed.event;

	constructor() { }

	setInstance(instance: Instance | undefined): void {
		this.instance = instance;
		this.refresh();
	}

	refresh(): void {
		this.changed.fire(undefined);
	}

	async getChildren(): Promise<AssetNode[]> {
		const instance = this.instance;
		if (!instance) {
			return [];
		}
		const nodes: AssetNode[] = [];
		const scan = async (dir: string, kind: AssetNode['kind'], exts: string[]): Promise<void> => {
			let entries: fs.Dirent[];
			try {
				entries = await fs.promises.readdir(dir, { withFileTypes: true });
			} catch {
				return;
			}
			for (const entry of entries) {
				if (!entry.isFile()) {
					continue;
				}
				const lower = entry.name.toLowerCase();
				if (!exts.some(ext => lower.endsWith(ext))) {
					continue;
				}
				const file = path.join(dir, entry.name);
				let size = 0;
				try {
					size = (await fs.promises.stat(file)).size;
				} catch { /* 文件在扫描时消失 */ }
				nodes.push({
					kind,
					name: entry.name.replace(/\.zip|\.jar|\.mcaddon|\.disabled$/i, ''),
					file,
					size,
					enabled: !lower.endsWith('.disabled')
				});
			}
		};
		await scan(path.join(instance.gameDir, 'resourcepacks'), 'resourcepack', ['.zip', '.jar']);
		await scan(path.join(instance.gameDir, 'shaderpacks'), 'shader', ['.zip', '.jar']);
		await scan(path.join(instance.gameDir, 'datapacks'), 'datapack', ['.zip', '.mcaddon', '.zip.disabled']);
		nodes.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name, 'zh-CN'));
		return nodes;
	}

	getTreeItem(node: AssetNode): vscode.TreeItem {
		const kindLabels: Record<AssetNode['kind'], string> = { resourcepack: '资源包', shader: '光影', datapack: '数据包' };
		const kindIcons: Record<AssetNode['kind'], string> = { resourcepack: 'color-palette', shader: 'sparkle', datapack: 'database' };
		const item = new vscode.TreeItem(node.name, vscode.TreeItemCollapsibleState.None);
		item.description = `${kindLabels[node.kind]} · ${formatBytes(node.size)}${node.enabled ? '' : ' · 已禁用'}`;
		item.contextValue = `asset-${node.kind}`;
		item.iconPath = new vscode.ThemeIcon(node.enabled ? kindIcons[node.kind] : 'circle-slash');
		item.tooltip = new vscode.MarkdownString([
			`**${node.name}**`,
			'',
			`- 类型：${kindLabels[node.kind]}`,
			`- 大小：${formatBytes(node.size)}`,
			`- 状态：${node.enabled ? '已启用' : '已禁用'}`,
			`- 文件：\`${node.file}\``
		].join('\n'));
		item.command = {
			command: 'modpack.openAssetFolder',
			title: '打开文件夹',
			arguments: [node]
		};
		return item;
	}
}
