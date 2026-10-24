import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { DatabaseService } from './db';
import { Instance, InstanceStore, LOADER_LABELS, LoaderKind } from './instance';
import { LogIssue, LogService } from './logs';
import {
	JavaInstall,
	JavaNotFoundError,
	discoverJava,
	getLoaderVersions,
	getManifest,
	getRequiredJava,
	installGame,
	isGameInstalled,
	readJavaVersion,
	resolveJava
} from './minecraft';
import {
	ModInfo,
	addLocalMods,
	analyzeMods,
	installModrinthProject,
	removeMod,
	scanMods,
	searchModrinth,
	toggleMod
} from './mods';
import { PACK_FORMAT_LABELS, PackFormat, exportPack, importPack } from './pack';
import {
	AssetNode,
	AssetProvider,
	IssuesProvider,
	InstancesProvider,
	ModsProvider,
	RunProvider
} from './views';
import { ensureDir, formatBytes } from './util';

interface InstancePickItem extends vscode.QuickPickItem {
	instance: Instance;
}

interface JavaPickItem extends vscode.QuickPickItem {
	java?: JavaInstall;
	action?: 'auto' | 'browse' | 'rescan';
}

interface ModSearchItem extends vscode.QuickPickItem {
	projectId: string;
}

/**
 * Wires the extension services into VS Code: views, commands, status bar and
 * file watchers. All long running work is kept off the activation path.
 */
class ModpackStudio implements vscode.Disposable {
	private readonly store: InstanceStore;
	private readonly db: DatabaseService;
	private readonly logs: LogService;
	private readonly instancesProvider: InstancesProvider;
	private readonly modsProvider: ModsProvider;
	private readonly runProvider: RunProvider;
	private readonly issuesProvider: IssuesProvider;
	private readonly assetProvider: AssetProvider;
	private readonly statusBar: vscode.StatusBarItem;
	private readonly disposables: vscode.Disposable[] = [];
	private modsView: vscode.TreeView<ModInfo> | undefined;
	private active: Instance | undefined;
	private mods: ModInfo[] = [];
	private modIssues: LogIssue[] = [];
	private databaseWarningShown = false;

	constructor(private readonly context: vscode.ExtensionContext) {
		this.store = new InstanceStore(context);
		this.db = new DatabaseService(context);
		this.logs = new LogService();
		this.instancesProvider = new InstancesProvider(this.store);
		this.modsProvider = new ModsProvider();
		this.runProvider = new RunProvider(this.store, this.logs, this.db);
		this.issuesProvider = new IssuesProvider(this.logs, () => this.modIssues);
		this.assetProvider = new AssetProvider();
		this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
	}

	async start(): Promise<void> {
		this.registerViews();
		this.registerCommands();
		this.registerWatchers();
		this.registerEvents();
		this.statusBar.command = 'workbench.view.extension.modpack';
		this.statusBar.name = 'Modpack Studio';
		this.statusBar.show();
		await this.setRunningContext();
		await this.refreshActive(true);
		void this.initializeDatabase();
		setTimeout(() => void this.showWelcomeOnce(), 1200);
	}

	private async openWalkthrough(): Promise<void> {
		await vscode.commands.executeCommand(
			'workbench.action.openWalkthrough',
			'modpack-studio.modpack-studio#modpack-studio.gettingStarted',
			false
		);
	}

	private async showWelcomeOnce(): Promise<void> {
		if (this.context.globalState.get<boolean>('modpack.welcomeShown')) {
			return;
		}
		await this.context.globalState.update('modpack.welcomeShown', true);
		try {
			await vscode.commands.executeCommand('workbench.view.extension.modpack');
			await this.openWalkthrough();
		} catch (error) {
			console.warn('[modpack-studio] 无法打开快速开始', error);
		}
	}

	private registerViews(): void {
		this.disposables.push(
			vscode.window.registerTreeDataProvider('modpack.instances', this.instancesProvider),
			vscode.window.registerTreeDataProvider('modpack.run', this.runProvider),
			vscode.window.registerTreeDataProvider('modpack.issues', this.issuesProvider),
			vscode.window.registerTreeDataProvider('modpack.assets', this.assetProvider)
		);
		this.modsView = vscode.window.createTreeView('modpack.mods', {
			treeDataProvider: this.modsProvider,
			showCollapseAll: false
		});
		this.disposables.push(this.modsView);
		this.modsView.onDidChangeCheckboxState(event => {
			void this.handleCheckboxChange(event);
		}, undefined, this.disposables);
	}

	private registerCommands(): void {
		const register = (command: string, handler: (...args: any[]) => any): void => {
			this.disposables.push(vscode.commands.registerCommand(command, handler));
		};
		register('modpack.createInstance', () => this.createInstance());
		register('modpack.wizardRpc', async (wizardId: string, message: unknown) => {
			await this.handleWizardRpc(wizardId, message);
		});
		register('modpack.importInstance', () => this.importInstance());
		register('modpack.openInstance', (candidate?: Instance) => this.openInstance(candidate));
		register('modpack.deleteInstance', (candidate?: Instance) => this.deleteInstance(candidate));
		register('modpack.showInstanceFolder', (candidate?: Instance) => this.showInstanceFolder(candidate));
		register('modpack.openInstanceSettings', (candidate?: Instance) => this.openInstanceSettings(candidate));
		register('modpack.refresh', () => this.refreshActive(true));
		register('modpack.launchClient', (candidate?: Instance) => this.launchClient(candidate));
		register('modpack.launchServer', (candidate?: Instance) => this.launchServer(candidate));
		register('modpack.stopGame', () => this.stopGame());
		register('modpack.installGame', (candidate?: Instance) => this.installGameFiles(candidate));
		register('modpack.searchMods', () => this.searchMods());
		register('modpack.addModFile', () => this.addModFile());
		register('modpack.toggleMod', (candidate?: ModInfo) => this.toggleModCommand(candidate));
		register('modpack.removeMod', (candidate?: ModInfo) => this.removeModCommand(candidate));
		register('modpack.openModFolder', (candidate?: ModInfo) => this.openModFolder(candidate));
		register('modpack.exportPack', (candidate?: Instance) => this.exportPack(candidate));
		register('modpack.openLogs', () => this.openLogs());
		register('modpack.showOutput', () => this.logs.output.show(true));
		register('modpack.diagnoseLogs', () => this.diagnoseLogs());
		register('modpack.clearIssues', () => this.clearIssues());
		register('modpack.revealIssue', (issue?: LogIssue) => this.revealIssue(issue));
		register('modpack.setJava', (candidate?: Instance) => this.setJava(candidate));
		register('modpack.setMemory', (candidate?: Instance) => this.setMemory(candidate));
		register('modpack.serverCommand', () => this.serverCommand());
		register('modpack.configureDatabase', () => this.configureDatabase());
		register('modpack.testDatabase', () => this.testDatabase());
		register('modpack.databaseStats', () => this.databaseStats());
		register('modpack.openWalkthrough', () => this.openWalkthrough());
		register('modpack.searchAssets', () => this.searchAssets());
		register('modpack.openAssetFolder', (node?: AssetNode) => this.openAssetFolder(node));
		register('modpack.removeAsset', (node?: AssetNode) => this.removeAssetCommand(node));
	}

	private registerWatchers(): void {
		const root = vscode.Uri.file(this.store.instancesRoot);
		const instanceWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '*/*.json'));
		const modWatcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '*/mods/*.jar*'));
		const onChange = (): void => {
			this.instancesProvider.refresh();
			void this.refreshActive(false);
		};
		this.disposables.push(
			instanceWatcher,
			modWatcher,
			instanceWatcher.onDidChange(onChange),
			instanceWatcher.onDidCreate(onChange),
			instanceWatcher.onDidDelete(onChange),
			modWatcher.onDidChange(onChange),
			modWatcher.onDidCreate(onChange),
			modWatcher.onDidDelete(onChange)
		);
		this.disposables.push(vscode.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('modpack.home') || event.affectsConfiguration('modpack.javaPath')) {
				this.store.invalidate();
				void this.refreshActive(true);
			}
		}));
	}

	private registerEvents(): void {
		this.disposables.push(this.logs.onDidChangeRunning(() => {
			void this.setRunningContext();
			this.runProvider.refresh();
			this.updateStatus();
		}));
		this.disposables.push(this.logs.onDidChangeIssues(() => this.issuesProvider.refresh()));
		this.disposables.push(this.db.onDidChange(() => {
			this.runProvider.refresh();
			this.updateStatus();
			if (this.db.available) {
				void this.syncInstalled();
			} else if (this.db.failed && !this.databaseWarningShown) {
				this.databaseWarningShown = true;
				void vscode.window.showWarningMessage(
					`模组资料库未连接：${this.db.statusText}`,
					'配置数据库',
					'忽略'
				).then(choice => {
					if (choice === '配置数据库') {
						void vscode.commands.executeCommand('modpack.configureDatabase');
					}
				});
			}
		}));
	}

	private async initializeDatabase(): Promise<void> {
		await this.db.initialize();
		this.runProvider.refresh();
		this.updateStatus();
	}

	private async setRunningContext(): Promise<void> {
		await vscode.commands.executeCommand('setContext', 'modpack.gameRunning', this.logs.running);
		await vscode.commands.executeCommand('setContext', 'modpack.serverRunning', this.logs.running && this.logs.runningKind === 'server');
	}

	private async refreshActive(invalidate: boolean): Promise<void> {
		if (invalidate) {
			this.store.invalidate();
			this.instancesProvider.refresh();
		}
		try {
			this.active = await this.store.active();
		} catch {
			this.active = undefined;
		}
		this.assetProvider.setInstance(this.active);
		await this.refreshMods();
		this.runProvider.refresh();
		this.updateStatus();
	}

	private async refreshMods(): Promise<void> {
		const instance = this.active;
		if (!instance) {
			this.mods = [];
			this.modIssues = [];
			this.modsProvider.refresh([], undefined);
			this.issuesProvider.refresh();
			this.updateStatus();
			return;
		}
		try {
			this.mods = await scanMods(instance);
		} catch (error) {
			console.warn('[modpack-studio] 无法读取模组列表', error);
			this.mods = [];
		}
		this.modsProvider.refresh(this.mods, instance);
		this.modIssues = analyzeMods(instance, this.mods).map((issue, index) => ({
			id: `mod-${index}-${issue.mod ?? 'pack'}`,
			severity: issue.severity,
			message: issue.message,
			hint: issue.severity === 'error' ? '修复后会自动重新检查。' : undefined
		}));
		this.issuesProvider.refresh();
		this.updateStatus();
		void this.syncInstalled();
	}

	private async syncInstalled(): Promise<void> {
		const instance = this.active;
		if (!instance || !this.db.available || this.mods.length === 0) {
			return;
		}
		await Promise.all(this.mods.map(mod => this.db.recordInstalled(instance.config.id, {
			fileName: mod.fileName.replace(/\.disabled$/i, ''),
			projectId: mod.projectId,
			versionId: mod.versionId,
			name: mod.name,
			versionNumber: mod.version,
			enabled: mod.enabled,
			source: mod.projectId ? 'modrinth' : 'local'
		})));
	}

	private updateStatus(): void {
		const running = this.logs.running
			? this.logs.runningKind === 'server' ? '服务端运行中' : '游戏运行中'
			: '未运行';
		if (!this.active) {
			this.statusBar.text = '$(rocket) 整合包工作室';
			this.statusBar.tooltip = `还没有选择整合包\n${this.db.statusText}`;
			return;
		}
		const size = this.mods.reduce((total, mod) => total + mod.size, 0);
		this.statusBar.text = `$(rocket) ${this.active.name}`;
		this.statusBar.tooltip = [
			this.active.name,
			this.active.description,
			`模组：${this.mods.length} 个（${formatBytes(size)}）`,
			`运行：${running}`,
			`数据库：${this.db.statusText}`
		].join('\n');
	}

	private async setActive(instance: Instance): Promise<void> {
		this.active = instance;
		await this.store.setActive(instance);
		await this.refreshMods();
		this.runProvider.refresh();
		this.updateStatus();
	}

	private async resolveInstance(candidate?: unknown): Promise<Instance | undefined> {
		if (candidate instanceof Instance) {
			return candidate;
		}
		return this.requireActive();
	}

	private async requireActive(): Promise<Instance | undefined> {
		if (this.active) {
			return this.active;
		}
		this.active = await this.store.active();
		if (this.active) {
			await this.refreshMods();
			return this.active;
		}
		const instance = await this.store.pick();
		if (instance) {
			await this.setActive(instance);
			return instance;
		}
		return undefined;
	}

	private async chooseExistingInstance(): Promise<Instance | undefined> {
		const instances = await this.store.list();
		if (instances.length === 0) {
			void vscode.window.showInformationMessage('还没有整合包，请先新建或导入一个。', '新建整合包', '导入整合包')
				.then(async choice => {
					if (choice === '新建整合包') {
						await vscode.commands.executeCommand('modpack.createInstance');
					} else if (choice === '导入整合包') {
						await vscode.commands.executeCommand('modpack.importInstance');
					}
				});
			return undefined;
		}
		if (instances.length === 1) {
			return instances[0];
		}
		const picked = await vscode.window.showQuickPick<InstancePickItem>(
			instances.map(instance => ({
				label: instance.name,
				description: instance.description,
				instance
			})),
			{ title: '选择整合包', placeHolder: '选择要操作的整合包' }
		);
		return picked?.instance;
	}

	//#region 实例

	private async createInstance(): Promise<void> {
		// 拉取 Mojang 全量版本列表
		let allVersions: { id: string; type: string }[] = [];
		try {
			const manifest = await getManifest();
			allVersions = manifest.versions.map(v => ({ id: v.id, type: v.type }));
		} catch (error) {
			console.warn('[modpack-studio] 无法加载 Mojang 版本清单，向导将使用内置常用版本', error);
		}

		// 常用做包版本（即使清单拉取失败也始终可用）
		const POPULAR_VERSIONS = [
			{ id: '1.7.10', label: '经典老服' },
			{ id: '1.12.2', label: '经典模组' },
			{ id: '1.20.1', label: '主流整合' },
			{ id: '1.21.1', label: '新版整合' }
		];
		// 全量列表为空时，退化为只用常用版本
		const effectiveVersions = allVersions.length ? allVersions : POPULAR_VERSIONS.map(v => ({ id: v.id, type: 'release' }));

		const LOADER_ICONS: Record<LoaderKind, string> = {
			vanilla: '⬜', fabric: '🧵', forge: '🔥', neoforge: '🦊', quilt: '🧵'
		};
		const LOADER_NAMES: Record<LoaderKind, string> = { ...LOADER_LABELS };
		const LOADER_DESCRIPTORS: Record<LoaderKind, string> = {
			vanilla: '不安装加载器', fabric: '轻量、稳定', forge: '传统大型模组', neoforge: '新一代 Forge', quilt: '轻量替代'
		};

		// 调用主代码的 workbench 命令打开浮动向导窗口
		const wizardData = {
			allVersions: effectiveVersions,
			popularVersions: POPULAR_VERSIONS,
			loaderIcons: LOADER_ICONS,
			loaderNames: LOADER_NAMES,
			loaderDescriptors: LOADER_DESCRIPTORS
		};

		let wizardId: string | undefined;
		try {
			const result = await vscode.commands.executeCommand<{ wizardId?: string }>('modpack.openWizard', wizardData);
			wizardId = result?.wizardId;
		} catch (error) {
			// 主代码命令未注册或打开失败，回退到 WebviewPanel 方案
			console.warn('[modpack-studio] modpack.openWizard 命令不可用，回退到 Webview', error);
			await this.openWizardAsWebview(wizardData);
			return;
		}
		if (!wizardId) {
			await this.openWizardAsWebview(wizardData);
			return;
		}

		// 浮动向导窗口内嵌的 webview 元素通过 service 转发 `modpack.wizardRpc` 命令到扩展宿主，
		// 扩展端再经 `modpack.pushWizardMessage` 命令把消息推回 webview。
		// 该 RPC 命令由本扩展注册（见 registerCommands），由 workbench 侧 executeCommand 路由到此。
		// 把 wizardId 记下，避免重复 registerCommand；消息处理统一在 handleWizardRpc。
	}

	/**
	 * 由 service 端转发 webview 消息的 `modpack.wizardRpc` 命令回调。
	 * `wizardId` 标识是哪个浮动向导窗口发出的；`message` 即 webview 的 postMessage 载荷。
	 */
	private async handleWizardRpc(wizardId: string, message: unknown): Promise<void> {
		const msg = message as {
			type?: string;
			action?: string;
			loader?: LoaderKind;
			mcVersion?: string;
			name?: string;
			mode?: 'single' | 'multi';
			minecraftVersion?: string;
			multiVersions?: string[];
			loaderVersion?: string;
			memoryMb?: number;
			jvmArgs?: string[];
			launchArgs?: string[];
		};
		if (msg?.type !== 'modpack-wizard') {
			return;
		}

		const push = (payload: Record<string, unknown>): void => {
			void vscode.commands.executeCommand('modpack.pushWizardMessage', wizardId, payload);
		};

		// 关闭请求：由 service 端 onUnload 关闭浮动窗口，这里无需处理
		if (msg.action === 'modpack-wizard-close' || msg.type === 'modpack-wizard-close') {
			return;
		}

		// 加载器版本列表
		if (msg.action === 'loadVersions') {
			let versions: Awaited<ReturnType<typeof getLoaderVersions>> = [];
			try {
				versions = await getLoaderVersions(msg.loader as LoaderKind, msg.mcVersion as string);
			} catch {
				console.warn('[modpack-studio] 读取加载器版本失败', msg.loader);
			}
			push({
				type: 'modpack-wizard',
				action: 'loaderVersions',
				versions: versions.map(v => ({ version: v.version, stable: v.stable }))
			});
			return;
		}

		// 创建整合包
		if (msg.action !== 'create') {
			return;
		}

		const name = (msg.name as string)?.trim();
		if (!name) {
			push({ type: 'modpack-wizard', action: 'error', message: '整合包名称不能为空' });
			return;
		}

		const mcVersion = msg.minecraftVersion as string;
		const loader = msg.loader as LoaderKind;
		const loaderVersion = msg.loaderVersion as string | undefined;
		const memoryMb = msg.memoryMb as number | undefined;
		const jvmArgs = (msg.jvmArgs as string[]) || [];
		const launchArgs = (msg.launchArgs as string[]) || [];
		const multiVersions = (msg.multiVersions as string[]) || [];

		try {
			const instance = await this.store.create({
				name,
				minecraftVersion: mcVersion,
				loader,
				loaderVersion,
				description: loaderVersion
					? `${LOADER_LABELS[loader]} ${loaderVersion}`
					: LOADER_LABELS[loader]
			});

			// 写入 jvmArgs / memoryMb / launchArgs
			if (jvmArgs.length) {
				instance.config.jvmArgs = jvmArgs;
			}
			if (memoryMb) {
				instance.config.memoryMb = memoryMb;
			}
			if (launchArgs.length) {
				instance.config.launchArgs = launchArgs;
			}
			if (multiVersions.length) {
				// 多版本记录到 description 中
				instance.config.description = `${LOADER_LABELS[loader]}${loaderVersion ? ' ' + loaderVersion : ''} · 多版本: ${multiVersions.join(', ')}`;
			}
			await instance.save();

			this.instancesProvider.refresh();
			await this.setActive(instance);

			// 安装游戏文件，进度同步到浮动窗口
			await installGame(instance, (message, percent) => {
				push({
					type: 'modpack-wizard',
					action: 'progress',
					message,
					percent: percent ?? undefined
				});
			});

			this.instancesProvider.refresh();
			this.runProvider.refresh();
			push({
				type: 'modpack-wizard',
				action: 'done',
				message: `"${name}" 创建完成，游戏文件已就绪。`
			});
		} catch (error) {
			push({
				type: 'modpack-wizard',
				action: 'error',
				message: safeError(error)
			});
		}
	}

	/**
	 * 回退方案：主代码的浮动向导命令不可用时（例如运行在未修改的 VS Code 上），
	 * 使用 WebviewPanel 渲染同样的向导。
	 */
	private async openWizardAsWebview(wizardData: {
		allVersions: { id: string; type: string }[];
		popularVersions: { id: string; label: string }[];
		loaderIcons: Record<string, string>;
		loaderNames: Record<string, string>;
		loaderDescriptors: Record<string, string>;
	}): Promise<void> {
		const wizardPath = path.join(this.context.extensionPath, 'wizard.html');
		let html: string;
		try {
			html = await fs.promises.readFile(wizardPath, 'utf-8');
		} catch {
			void vscode.window.showErrorMessage('无法加载新建整合包向导，请重启扩展。');
			return;
		}

		const injected = html
			.replace('__ALL_VERSIONS__', JSON.stringify(wizardData.allVersions))
			.replace('__POPULAR_VERSIONS__', JSON.stringify(wizardData.popularVersions))
			.replace('__LOADER_ICONS__', JSON.stringify(wizardData.loaderIcons))
			.replace('__LOADER_NAMES__', JSON.stringify(wizardData.loaderNames))
			.replace('__LOADER_DESCRIPTORS__', JSON.stringify(wizardData.loaderDescriptors));

		const panel = vscode.window.createWebviewPanel('modpackWizard', '新建整合包', vscode.ViewColumn.One, {
			enableScripts: true,
			retainContextWhenHidden: true
		});
		panel.webview.html = injected;

		panel.webview.onDidReceiveMessage(async msg => {
			if (msg?.type !== 'wizard') {
				return;
			}
			// 加载器版本列表
			if (msg.action === 'loadVersions') {
				let versions: Awaited<ReturnType<typeof getLoaderVersions>> = [];
				try {
					versions = await getLoaderVersions(msg.loader as LoaderKind, msg.mcVersion as string);
				} catch {
					console.warn('[modpack-studio] 读取加载器版本失败', msg.loader);
				}
				void panel.webview.postMessage({
					type: 'wizard',
					action: 'loaderVersions',
					versions: versions.map(v => ({ version: v.version, stable: v.stable }))
				});
				return;
			}
			// 关闭窗口
			if (msg.action === 'close') {
				panel.dispose();
				return;
			}
			// 创建整合包
			if (msg.action !== 'create') {
				return;
			}
			const name = (msg.name as string)?.trim();
			if (!name) {
				void panel.webview.postMessage({ type: 'wizard', action: 'error', message: '整合包名称不能为空' });
				return;
			}
			const mcVersion = msg.minecraftVersion as string;
			const loader = msg.loader as LoaderKind;
			const loaderVersion = msg.loaderVersion as string | undefined;
			const memoryMb = msg.memoryMb as number | undefined;
			const jvmArgs = (msg.jvmArgs as string[]) || [];
			const launchArgs = (msg.launchArgs as string[]) || [];
			const multiVersions = (msg.multiVersions as string[]) || [];

			try {
				const instance = await this.store.create({
					name,
					minecraftVersion: mcVersion,
					loader,
					loaderVersion,
					description: loaderVersion
						? `${LOADER_LABELS[loader]} ${loaderVersion}`
						: LOADER_LABELS[loader]
				});
				if (jvmArgs.length) {
					instance.config.jvmArgs = jvmArgs;
				}
				if (memoryMb) {
					instance.config.memoryMb = memoryMb;
				}
				if (launchArgs.length) {
					instance.config.launchArgs = launchArgs;
				}
				if (multiVersions.length) {
					instance.config.description = `${LOADER_LABELS[loader]}${loaderVersion ? ' ' + loaderVersion : ''} · 多版本: ${multiVersions.join(', ')}`;
				}
				await instance.save();
				this.instancesProvider.refresh();
				await this.setActive(instance);
				await installGame(instance, (message, percent) => {
					void panel.webview.postMessage({
						type: 'wizard',
						action: 'progress',
						message,
						percent: percent ?? undefined
					});
				});
				this.instancesProvider.refresh();
				this.runProvider.refresh();
				void panel.webview.postMessage({
					type: 'wizard',
					action: 'done',
					message: `"${name}" 创建完成，游戏文件已就绪。`
				});
			} catch (error) {
				void panel.webview.postMessage({
					type: 'wizard',
					action: 'error',
					message: safeError(error)
				});
			}
		});
	}

	private async importInstance(): Promise<void> {
		const selection = await vscode.window.showOpenDialog({
			title: '选择整合包文件或目录',
			canSelectFiles: true,
			canSelectFolders: true,
			canSelectMany: false,
			openLabel: '导入',
			filters: {
				'整合包': ['mrpack', 'zip'],
				'所有文件': ['*']
			}
		});
		if (!selection?.length) {
			return;
		}
		try {
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '正在导入整合包…' },
				progress => importPack(selection[0].fsPath, this.store, message => progress.report({ message }))
			);
			this.instancesProvider.refresh();
			await this.setActive(result.instance);
			if (result.warnings.length) {
				void vscode.window.showWarningMessage(
					`导入完成，但有 ${result.warnings.length} 条提示：${result.warnings[0]}`,
					'查看详情'
				).then(async choice => {
					if (choice === '查看详情') {
						await vscode.window.showQuickPick(result.warnings, { title: '导入提示' });
					}
				});
			} else {
				void vscode.window.showInformationMessage(`已导入“${result.instance.name}”。`);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`导入失败：${safeError(error)}`);
		}
	}

	private async openInstance(candidate?: Instance): Promise<void> {
		const instance = await this.resolveInstance(candidate);
		if (!instance) {
			return;
		}
		await this.setActive(instance);
		await vscode.commands.executeCommand('modpack.mods.focus');
	}

	private async deleteInstance(candidate?: Instance): Promise<void> {
		const instance = candidate instanceof Instance ? candidate : await this.chooseExistingInstance();
		if (!instance) {
			return;
		}
		const confirmation = await vscode.window.showWarningMessage(
			`确定删除整合包“${instance.name}”吗？\n\n目录 ${instance.dir} 及其中所有模组和存档都会被删除。`,
			{ modal: true },
			'删除'
		);
		if (confirmation !== '删除') {
			return;
		}
		try {
			await this.store.remove(instance);
			if (this.active?.dir === instance.dir) {
				this.active = undefined;
			}
			this.instancesProvider.refresh();
			await this.refreshActive(true);
			void vscode.window.showInformationMessage(`已删除“${instance.name}”。`);
		} catch (error) {
			void vscode.window.showErrorMessage(`删除失败：${safeError(error)}`);
		}
	}

	private async showInstanceFolder(candidate?: Instance): Promise<void> {
		const instance = await this.resolveInstance(candidate);
		if (instance) {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(instance.dir));
		}
	}

	private async openInstanceSettings(candidate?: Instance): Promise<void> {
		const instance = await this.resolveInstance(candidate);
		if (!instance) {
			return;
		}
		await vscode.window.showTextDocument(vscode.Uri.file(instance.instanceJsonPath), { preview: false });
	}

	//#endregion

	//#region 启动与服务端

	private async launchClient(candidate?: Instance): Promise<void> {
		const instance = await this.resolveInstance(candidate);
		if (!instance) {
			return;
		}
		try {
			if (!await isGameInstalled(instance)) {
				const choice = await vscode.window.showInformationMessage(
					'游戏文件尚未安装，需要先下载 Minecraft 和加载器文件。',
					'安装并启动',
					'取消'
				);
				if (choice !== '安装并启动') {
					return;
				}
				if (!await this.installGameFiles(instance, false)) {
					return;
				}
			}
			await this.withJavaSelection(instance, () => this.logs.startClient(instance));
			this.runProvider.refresh();
			this.updateStatus();
		} catch (error) {
			void vscode.window.showErrorMessage(`启动失败：${safeError(error)}`, '打开日志').then(choice => {
				if (choice === '打开日志') {
					this.logs.output.show(true);
				}
			});
		}
	}

	private async launchServer(candidate?: Instance): Promise<void> {
		const instance = await this.resolveInstance(candidate);
		if (!instance) {
			return;
		}
		if (this.logs.running) {
			void vscode.window.showWarningMessage('已经有游戏或服务端在运行。');
			return;
		}
		try {
			await this.withJavaSelection(instance, () => this.logs.startServer(instance));
			this.runProvider.refresh();
			this.updateStatus();
		} catch (error) {
			void vscode.window.showErrorMessage(`启动服务端失败：${safeError(error)}`);
		}
	}

	private async stopGame(): Promise<void> {
		try {
			await this.logs.stop();
		} catch (error) {
			void vscode.window.showErrorMessage(`停止失败：${safeError(error)}`);
		}
	}

	private async installGameFiles(candidate?: Instance, notify = true): Promise<boolean> {
		const instance = await this.resolveInstance(candidate);
		if (!instance) {
			return false;
		}
		try {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `安装 ${instance.name} 的游戏文件`, cancellable: false },
				progress => installGame(instance, message => progress.report({ message }))
			);
			this.instancesProvider.refresh();
			this.runProvider.refresh();
			if (notify) {
				void vscode.window.showInformationMessage(`“${instance.name}”的游戏文件已就绪。`);
			}
			return true;
		} catch (error) {
			void vscode.window.showErrorMessage(`安装失败：${safeError(error)}`);
			return false;
		}
	}

	private async serverCommand(): Promise<void> {
		if (!this.logs.running || this.logs.runningKind !== 'server') {
			void vscode.window.showWarningMessage('服务端没有运行。');
			return;
		}
		const command = await vscode.window.showInputBox({
			title: '向服务端发送命令',
			prompt: '例如：op Steve、weather clear、list',
			ignoreFocusOut: true
		});
		if (!command) {
			return;
		}
		try {
			this.logs.sendServerCommand(command);
		} catch (error) {
			void vscode.window.showErrorMessage(safeError(error));
		}
	}

	//#endregion

	//#region 模组

	private async handleCheckboxChange(event: vscode.TreeCheckboxChangeEvent<ModInfo>): Promise<void> {
		for (const [mod, state] of event.items) {
			const enabled = state === vscode.TreeItemCheckboxState.Checked;
			if (mod.enabled === enabled) {
				continue;
			}
			try {
				await this.applyModEnabled(mod, enabled);
			} catch (error) {
				void vscode.window.showErrorMessage(`无法切换模组状态：${safeError(error)}`);
				await this.refreshMods();
			}
		}
	}

	private async applyModEnabled(mod: ModInfo, enabled: boolean): Promise<void> {
		const instance = this.active;
		if (!instance) {
			return;
		}
		const fileName = mod.fileName.replace(/\.disabled$/i, '');
		if (mod.enabled !== enabled) {
			await toggleMod(mod);
		}
		await this.db.setEnabled(instance.config.id, fileName, enabled);
		await this.refreshMods();
	}

	private async toggleModCommand(candidate?: ModInfo): Promise<void> {
		const instance = await this.requireActive();
		if (!instance) {
			return;
		}
		const mod = candidate ?? await this.pickMod();
		if (!mod) {
			return;
		}
		try {
			await this.applyModEnabled(mod, !mod.enabled);
		} catch (error) {
			void vscode.window.showErrorMessage(`无法切换模组状态：${safeError(error)}`);
		}
	}

	private async removeModCommand(candidate?: ModInfo): Promise<void> {
		const instance = await this.requireActive();
		if (!instance) {
			return;
		}
		const mod = candidate ?? await this.pickMod();
		if (!mod) {
			return;
		}
		const confirmation = await vscode.window.showWarningMessage(`确定删除模组 ${mod.name} 吗？`, { modal: true }, '删除');
		if (confirmation !== '删除') {
			return;
		}
		try {
			await removeMod(instance, mod);
			await this.db.removeInstalled(instance.config.id, mod.fileName.replace(/\.disabled$/i, ''));
			await this.refreshMods();
		} catch (error) {
			void vscode.window.showErrorMessage(`删除失败：${safeError(error)}`);
		}
	}

	private async pickMod(): Promise<ModInfo | undefined> {
		if (this.mods.length === 0) {
			void vscode.window.showInformationMessage('当前整合包还没有模组。');
			return undefined;
		}
		const picked = await vscode.window.showQuickPick(
			this.mods.map(mod => ({
				label: mod.name,
				description: `${mod.enabled ? '已启用' : '已禁用'}${mod.version ? ` · v${mod.version}` : ''}`,
				detail: mod.fileName,
				mod
			})),
			{ title: '选择模组', matchOnDescription: true, matchOnDetail: true }
		);
		return picked?.mod;
	}

	private async addModFile(): Promise<void> {
		const instance = await this.requireActive();
		if (!instance) {
			return;
		}
		const selection = await vscode.window.showOpenDialog({
			title: '选择模组 jar 文件',
			canSelectFiles: true,
			canSelectMany: true,
			openLabel: '添加',
			filters: { 'Minecraft 模组': ['jar'] }
		});
		if (!selection?.length) {
			return;
		}
		try {
			const count = await addLocalMods(instance, selection.map(uri => uri.fsPath));
			await this.refreshMods();
			void vscode.window.showInformationMessage(`已添加 ${count} 个模组。`);
		} catch (error) {
			void vscode.window.showErrorMessage(`添加失败：${safeError(error)}`);
		}
	}

	private async openModFolder(candidate?: ModInfo): Promise<void> {
		const instance = await this.requireActive();
		if (!instance) {
			return;
		}
		if (candidate?.file) {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(candidate.file));
		} else {
			await vscode.env.openExternal(vscode.Uri.file(instance.modsDir));
		}
	}

	private async searchMods(): Promise<void> {
		const instance = await this.requireActive();
		if (!instance) {
			return;
		}
		const quickPick = vscode.window.createQuickPick<ModSearchItem>();
		quickPick.title = `为 ${instance.name} 搜索 Modrinth 模组`;
		quickPick.placeholder = '输入关键词搜索（留空显示热门模组）';
		quickPick.matchOnDescription = true;
		quickPick.matchOnDetail = true;
		quickPick.busy = true;
		let debounce: NodeJS.Timeout | undefined;
		let sequence = 0;

		const search = async (query: string): Promise<void> => {
			const current = ++sequence;
			quickPick.busy = true;
			try {
				const { hits, total } = await searchModrinth(query, instance, 0, 40);
				if (current !== sequence) {
					return;
				}
				quickPick.items = hits.map(hit => ({
					label: hit.title,
					description: `${hit.downloads.toLocaleString('zh-CN')} 次下载`,
					detail: hit.description,
					iconPath: hit.icon_url ? vscode.Uri.parse(hit.icon_url) : new vscode.ThemeIcon('package'),
					projectId: hit.project_id
				}));
				quickPick.title = `Modrinth：${total.toLocaleString('zh-CN')} 个兼容 ${instance.config.minecraftVersion} / ${instance.description} 的模组`;
				void this.db.recordSearch(hits);
			} catch (error) {
				if (current === sequence) {
					quickPick.items = [{
						label: '$(error) 搜索失败',
						description: safeError(error),
						projectId: ''
					}];
				}
			} finally {
				if (current === sequence) {
					quickPick.busy = false;
				}
			}
		};

		quickPick.onDidChangeValue(value => {
			if (debounce) {
				clearTimeout(debounce);
			}
			debounce = setTimeout(() => void search(value), 350);
		});
		quickPick.onDidAccept(() => {
			const selected = quickPick.selectedItems[0];
			if (!selected?.projectId) {
				return;
			}
			quickPick.hide();
			void this.installMod(instance, selected.projectId, selected.label);
		});
		quickPick.onDidHide(() => {
			if (debounce) {
				clearTimeout(debounce);
			}
			quickPick.dispose();
		});
		quickPick.show();
		await search('');
	}

	private async installMod(instance: Instance, projectId: string, title: string): Promise<void> {
		const abortController = new AbortController();
		try {
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `安装 ${title}`, cancellable: true },
				(progress, token) => {
					token.onDidCancel(() => abortController.abort());
					return installModrinthProject(
						instance,
						projectId,
						undefined,
						(message, percent) => progress.report({ message, ...(percent !== undefined ? { percent } : {}) }),
						abortController.signal
					);
				}
			);
			await this.refreshMods();
			for (const version of result.versions) {
				await this.db.recordVersion(version);
			}
			if (result.warnings.length) {
				void vscode.window.showWarningMessage(result.warnings[0], '查看详情').then(async choice => {
					if (choice === '查看详情') {
						await vscode.window.showQuickPick(result.warnings, { title: '安装提示' });
					}
				});
			} else {
				void vscode.window.showInformationMessage(`已安装 ${result.installed.length} 个模组。`);
			}
		} catch (error) {
			if (abortController.signal.aborted) {
				void vscode.window.showInformationMessage(`已取消安装 ${title}。`);
			} else {
				void vscode.window.showErrorMessage(`安装失败：${safeError(error)}`);
			}
		}
	}

	//#endregion

	//#region 资源包 / 光影 / 数据包

	private async searchAssets(): Promise<void> {
		const instance = await this.requireActive();
		if (!instance) {
			return;
		}
		const kindPick = await vscode.window.showQuickPick(
			[
				{ label: '$(color-palette) 资源包', description: 'Modrinth resourcepack', value: 'resourcepack' },
				{ label: '$(sparkle) 光影', description: 'Modrinth shader', value: 'shader' },
				{ label: '$(database) 数据包', description: 'Modrinth datapack', value: 'datapack' }
			] as const,
			{ title: '搜索并安装资产', placeHolder: '选择要搜索的资产类型' }
		);
		if (!kindPick) {
			return;
		}
		const kind = kindPick.value as 'resourcepack' | 'shader' | 'datapack';
		const label = { resourcepack: '资源包', shader: '光影', datapack: '数据包' }[kind];

		const quickPick = vscode.window.createQuickPick<{ projectId: string; title: string; downloadCount: number; detail: string }>();
		quickPick.title = `为 ${instance.name} 搜索 Modrinth ${label}`;
		quickPick.placeholder = '输入关键词搜索（留空显示热门）';
		quickPick.matchOnDescription = true;
		quickPick.matchOnDetail = true;
		quickPick.busy = true;
		let debounce: NodeJS.Timeout | undefined;
		let sequence = 0;
		const apiKey = vscode.workspace.getConfiguration('modpack').get<string>('curseforgeApiKey');

		const search = async (query: string): Promise<void> => {
			const current = ++sequence;
			quickPick.busy = true;
			try {
				const { hits } = await searchModrinth(query, instance, 0, 40, kind);
				if (current !== sequence) {
					return;
				}
				quickPick.items = hits.map(hit => ({
					label: hit.title,
					description: `${hit.downloads.toLocaleString('zh-CN')} 次下载`,
					detail: hit.description,
					projectId: hit.project_id,
					title: hit.title,
					downloadCount: hit.downloads
				}));
			} catch (error) {
				if (current === sequence) {
					quickPick.items = [{
						label: '$(error) 搜索失败',
						description: safeError(error),
						detail: '',
						projectId: '',
						title: '',
						downloadCount: 0
					}];
				}
			} finally {
				if (current === sequence) {
					quickPick.busy = false;
				}
			}
		};

		quickPick.onDidChangeValue(value => {
			if (debounce) {
				clearTimeout(debounce);
			}
			debounce = setTimeout(() => void search(value), 350);
		});
		quickPick.onDidAccept(() => {
			const selected = quickPick.selectedItems[0];
			if (!selected?.projectId) {
				return;
			}
			quickPick.hide();
			void this.installAsset(instance, selected.projectId, selected.title, kind);
		});
		quickPick.onDidHide(() => {
			if (debounce) {
				clearTimeout(debounce);
			}
			quickPick.dispose();
		});
		quickPick.show();
		await search('');
	}

	private async installAsset(
		instance: Instance,
		projectId: string,
		title: string,
		kind: 'resourcepack' | 'shader' | 'datapack'
	): Promise<void> {
		const abortController = new AbortController();
		const kindLabel = { resourcepack: '资源包', shader: '光影', datapack: '数据包' }[kind];
		try {
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: `安装 ${kindLabel}：${title}`, cancellable: true },
				(progress, token) => {
					token.onDidCancel(() => abortController.abort());
					return installModrinthProject(
						instance,
						projectId,
						undefined,
						(message, percent) => progress.report({ message, ...(percent !== undefined ? { percent } : {}) }),
						abortController.signal,
						kind
					);
				}
			);
			this.assetProvider.refresh();
			if (result.warnings.length) {
				void vscode.window.showWarningMessage(result.warnings[0]);
			} else {
				void vscode.window.showInformationMessage(`已安装 ${kindLabel} "${title}"。`);
			}
		} catch (error) {
			if (abortController.signal.aborted) {
				void vscode.window.showInformationMessage(`已取消安装 ${kindLabel} "${title}"。`);
			} else {
				void vscode.window.showErrorMessage(`安装失败：${safeError(error)}`);
			}
		}
	}

	private async openAssetFolder(node?: AssetNode): Promise<void> {
		if (node) {
			await vscode.commands.executeCommand('revealFileInOS', vscode.Uri.file(node.file));
		}
	}

	private async removeAssetCommand(node?: AssetNode): Promise<void> {
		if (!node) {
			return;
		}
		const confirmation = await vscode.window.showWarningMessage(
			`确定删除 ${node.name} 吗？`,
			{ modal: true },
			'删除'
		);
		if (confirmation !== '删除') {
			return;
		}
		try {
			await fs.promises.rm(node.file, { force: true });
			this.assetProvider.refresh();
			void vscode.window.showInformationMessage(`已删除 ${node.name}。`);
		} catch (error) {
			void vscode.window.showErrorMessage(`删除失败：${safeError(error)}`);
		}
	}

	//#endregion

	//#region 导出与日志

	private async exportPack(candidate?: Instance): Promise<void> {
		const instance = await this.resolveInstance(candidate);
		if (!instance) {
			return;
		}
		const formatPick = await vscode.window.showQuickPick(
			(Object.keys(PACK_FORMAT_LABELS) as PackFormat[]).map(format => ({
				label: PACK_FORMAT_LABELS[format],
				format
			})),
			{ title: '导出整合包', placeHolder: '选择导出格式' }
		);
		if (!formatPick) {
			return;
		}
		const extension = formatPick.format === 'mrpack' ? 'mrpack' : 'zip';
		const defaultUri = vscode.Uri.file(path.join(
			this.store.home,
			'exports',
			`${instance.config.id}-${new Date().toISOString().slice(0, 10)}.${extension}`
		));
		await ensureDir(path.dirname(defaultUri.fsPath));
		const target = await vscode.window.showSaveDialog({
			title: '导出整合包',
			defaultUri,
			saveLabel: '导出',
			filters: {
				[formatPick.label]: [extension]
			}
		});
		if (!target) {
			return;
		}
		try {
			const result = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '正在打包整合包…' },
				progress => exportPack(instance, formatPick.format, target.fsPath, message => progress.report({ message }))
			);
			await this.db.recordExport(instance.config.id, formatPick.format, target.fsPath, result.mods);
			if (result.skipped.length) {
				void vscode.window.showWarningMessage(
					`已导出 ${result.mods} 个模组，${result.skipped.length} 个本地模组放进了覆盖目录。`,
					'打开文件夹'
				).then(choice => {
					if (choice === '打开文件夹') {
						void vscode.commands.executeCommand('revealFileInOS', target);
					}
				});
			} else {
				void vscode.window.showInformationMessage(`已导出 ${result.mods} 个模组。`, '打开文件夹').then(choice => {
					if (choice === '打开文件夹') {
						void vscode.commands.executeCommand('revealFileInOS', target);
					}
				});
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`导出失败：${safeError(error)}`);
		}
	}

	private async openLogs(): Promise<void> {
		const instance = await this.requireActive();
		if (!instance) {
			return;
		}
		const files = await newestLogs(instance);
		if (files.length === 0) {
			this.logs.output.show(true);
			void vscode.window.showInformationMessage('还没有日志，先启动一次游戏或服务端。');
			return;
		}
		await vscode.window.showTextDocument(vscode.Uri.file(files[0]), { preview: false });
	}

	private async diagnoseLogs(): Promise<void> {
		const instance = await this.requireActive();
		if (!instance) {
			return;
		}
		try {
			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '正在分析日志…' },
				() => this.logs.diagnose(instance)
			);
			this.issuesProvider.refresh();
			await vscode.commands.executeCommand('modpack.issues.focus');
		} catch (error) {
			void vscode.window.showErrorMessage(`诊断失败：${safeError(error)}`);
		}
	}

	private clearIssues(): void {
		this.logs.clearIssues();
		this.modIssues = [];
		this.issuesProvider.refresh();
	}

	private async revealIssue(issue?: LogIssue): Promise<void> {
		if (!issue?.file) {
			return;
		}
		const document = await vscode.workspace.openTextDocument(vscode.Uri.file(issue.file));
		const line = Math.max(0, (issue.line ?? 1) - 1);
		await vscode.window.showTextDocument(document, {
			preview: false,
			selection: new vscode.Range(line, 0, line, 0)
		});
	}

	//#endregion

	//#region 运行设置

	private async setJava(candidate?: Instance): Promise<void> {
		const instance = await this.resolveInstance(candidate);
		if (!instance) {
			return;
		}
		try {
			await this.pickJava(instance);
			this.runProvider.refresh();
			this.updateStatus();
		} catch (error) {
			void vscode.window.showErrorMessage(`保存 Java 设置失败：${safeError(error)}`);
		}
	}

	/**
	 * Lists every detected Java installation and lets the user choose one.
	 * Nothing is downloaded automatically; a missing runtime is resolved by
	 * picking an installed JDK or browsing to java.exe.
	 */
	private async pickJava(instance: Instance, reason?: string): Promise<JavaInstall | undefined> {
		const required = await getRequiredJava(instance).catch(() => undefined);
		for (;;) {
			let javas: JavaInstall[] = [];
			try {
				javas = await vscode.window.withProgress(
					{ location: vscode.ProgressLocation.Notification, title: '正在查找已安装的 Java…' },
					() => discoverJava(true)
				);
			} catch (error) {
				console.warn('[modpack-studio] 查找 Java 失败', error);
			}
			const current = instance.config.javaPath ?? vscode.workspace.getConfiguration('modpack').get<string>('javaPath');
			const items: JavaPickItem[] = javas.map(java => {
				const recommended = required !== undefined && java.major === required;
				const flags = [
					recommended ? '推荐' : required !== undefined ? `游戏需要 Java ${required}` : '',
					java.source,
					current && path.resolve(current).toLowerCase() === path.resolve(java.path).toLowerCase() ? '当前使用' : ''
				].filter(Boolean);
				return {
					label: `$(file-binary) Java ${java.major ?? '?'} · ${java.version}`,
					description: flags.join(' · '),
					detail: java.path,
					java
				};
			});
			if (javas.length === 0) {
				items.push({
					label: '$(info) 没有检测到 Java',
					description: '请先安装 Java，或使用“浏览 java.exe”手动选择',
					alwaysShow: true
				});
			}
			items.push(
				{ label: '$(folder-opened) 浏览 java.exe…', description: '手动选择 Java 可执行文件', action: 'browse', alwaysShow: true },
				{ label: '$(refresh) 重新扫描已安装的 Java', description: '查找新安装的 Java', action: 'rescan', alwaysShow: true },
				{ label: '$(sync) 自动匹配', description: '清除手动选择，按游戏要求自动匹配', action: 'auto', alwaysShow: true }
			);
			const picked = await vscode.window.showQuickPick(items, {
				title: reason ? `选择 Java（${reason}）` : '选择 Java',
				placeHolder: required ? `游戏需要 Java ${required}，请选择要使用的 Java` : '请选择用于启动游戏的 Java',
				matchOnDetail: true,
				ignoreFocusOut: true
			});
			if (!picked) {
				return undefined;
			}
			if (picked.action === 'rescan') {
				continue;
			}
			if (picked.action === 'auto') {
				instance.config.javaPath = undefined;
				await instance.save();
				try {
					const java = await resolveJava(instance);
					void vscode.window.showInformationMessage(`已启用自动匹配：Java ${java.major ?? '?'}（${java.path}）`);
					return java;
				} catch (error) {
					if (!(error instanceof JavaNotFoundError)) {
						throw error;
					}
					void vscode.window.showWarningMessage(error.message);
					continue;
				}
			}
			if (picked.java) {
				instance.config.javaPath = picked.java.path;
				await instance.save();
				return picked.java;
			}
			const browsed = await this.browseJava(instance);
			if (browsed) {
				return browsed;
			}
		}
	}

	private async browseJava(instance: Instance): Promise<JavaInstall | undefined> {
		const configured = instance.config.javaPath ?? vscode.workspace.getConfiguration('modpack').get<string>('javaPath');
		const selection = await vscode.window.showOpenDialog({
			title: '选择 java.exe',
			openLabel: '使用此 Java',
			canSelectFiles: true,
			canSelectFolders: false,
			canSelectMany: false,
			defaultUri: configured ? vscode.Uri.file(path.dirname(configured)) : undefined,
			filters: process.platform === 'win32' ? { 'Java 可执行文件': ['exe'] } : undefined
		});
		if (!selection?.length) {
			return undefined;
		}
		const javaPath = selection[0].fsPath;
		const info = await vscode.window.withProgress(
			{ location: vscode.ProgressLocation.Notification, title: '正在检查 Java…' },
			() => readJavaVersion(javaPath)
		);
		if (!info) {
			void vscode.window.showErrorMessage(`无法运行所选文件，请选择有效的 java.exe：${javaPath}`);
			return undefined;
		}
		instance.config.javaPath = javaPath;
		await instance.save();
		void vscode.window.showInformationMessage(`已选择 Java ${info.major ?? '?'}（${info.version}）`);
		return { path: javaPath, source: '手动选择', ...info };
	}

	/** Runs a launch action and offers the Java picker when no runtime matches. */
	private async withJavaSelection(instance: Instance, action: () => Promise<void>): Promise<void> {
		try {
			await action();
		} catch (error) {
			if (!(error instanceof JavaNotFoundError)) {
				throw error;
			}
			const java = await this.pickJava(instance, error.required ? `需要 Java ${error.required}` : '未找到 Java');
			if (!java) {
				return;
			}
			this.runProvider.refresh();
			this.updateStatus();
			await action();
		}
	}

	private async setMemory(candidate?: Instance): Promise<void> {
		const instance = await this.resolveInstance(candidate);
		if (!instance) {
			return;
		}
		const current = instance.config.memoryMb ?? vscode.workspace.getConfiguration('modpack').get<number>('memoryMb', 4096);
		const value = await vscode.window.showInputBox({
			title: '分配内存',
			prompt: '输入最大内存（MB），建议 4096–8192',
			value: String(current),
			ignoreFocusOut: true,
			validateInput: text => {
				const number = Number(text);
				return Number.isInteger(number) && number >= 1024 && number <= 32768
					? undefined
					: '请输入 1024 到 32768 之间的整数';
			}
		});
		if (!value) {
			return;
		}
		instance.config.memoryMb = Number(value);
		try {
			await instance.save();
			this.runProvider.refresh();
			this.updateStatus();
		} catch (error) {
			void vscode.window.showErrorMessage(`保存内存设置失败：${safeError(error)}`);
		}
	}

	//#endregion

	//#region 数据库

	private async configureDatabase(): Promise<void> {
		const config = vscode.workspace.getConfiguration('modpack');
		const mode = await vscode.window.showQuickPick(
			[
				{ label: '$(server) 本机 PostgreSQL', description: '127.0.0.1:5432，自动创建数据库', value: 'local' },
				{ label: '$(globe) 远程 PostgreSQL', description: '手动填写主机、端口和账号', value: 'remote' },
				{ label: '$(circle-slash) 关闭模组资料库', description: '只使用本地 JSON 数据', value: 'off' }
			],
			{ title: '模组资料库', placeHolder: '选择 PostgreSQL 连接方式' }
		);
		if (!mode) {
			return;
		}
		this.databaseWarningShown = false;
		if (mode.value === 'off') {
			await config.update('postgres.enabled', false, vscode.ConfigurationTarget.Global);
			await this.db.initialize();
			this.runProvider.refresh();
			this.updateStatus();
			void vscode.window.showInformationMessage('已关闭模组资料库，IDE 将只使用本地数据。');
			return;
		}

		await config.update('postgres.enabled', true, vscode.ConfigurationTarget.Global);
		if (mode.value === 'local') {
			await config.update('postgres.host', '127.0.0.1', vscode.ConfigurationTarget.Global);
			await config.update('postgres.port', 5432, vscode.ConfigurationTarget.Global);
			await config.update('postgres.user', 'postgres', vscode.ConfigurationTarget.Global);
			await config.update('postgres.database', 'modpack_studio', vscode.ConfigurationTarget.Global);
		} else {
			const host = await vscode.window.showInputBox({
				title: 'PostgreSQL 主机',
				value: config.get<string>('postgres.host', '127.0.0.1'),
				ignoreFocusOut: true,
				validateInput: value => value.trim() ? undefined : '主机不能为空'
			});
			if (host === undefined) {
				return;
			}
			await config.update('postgres.host', host.trim(), vscode.ConfigurationTarget.Global);

			const port = await vscode.window.showInputBox({
				title: 'PostgreSQL 端口',
				value: String(config.get<number>('postgres.port', 5432)),
				ignoreFocusOut: true,
				validateInput: value => {
					const number = Number(value);
					return Number.isInteger(number) && number > 0 && number < 65536 ? undefined : '端口无效';
				}
			});
			if (port === undefined) {
				return;
			}
			await config.update('postgres.port', Number(port), vscode.ConfigurationTarget.Global);

			const user = await vscode.window.showInputBox({
				title: 'PostgreSQL 用户',
				value: config.get<string>('postgres.user', 'postgres'),
				ignoreFocusOut: true,
				validateInput: value => value.trim() ? undefined : '用户不能为空'
			});
			if (user === undefined) {
				return;
			}
			await config.update('postgres.user', user.trim(), vscode.ConfigurationTarget.Global);

			const database = await vscode.window.showInputBox({
				title: '数据库名',
				value: config.get<string>('postgres.database', 'modpack_studio'),
				ignoreFocusOut: true,
				validateInput: value => /^[A-Za-z0-9_]+$/.test(value.trim()) ? undefined : '只能包含字母、数字和下划线'
			});
			if (database === undefined) {
				return;
			}
			await config.update('postgres.database', database.trim(), vscode.ConfigurationTarget.Global);
		}

		const existing = await this.context.secrets.get('modpack.postgres.password');
		const password = await vscode.window.showInputBox({
			title: 'PostgreSQL 密码',
			prompt: `用户 ${config.get<string>('postgres.user', 'postgres')} 的密码。留空则继续使用已保存的密码。`,
			password: true,
			ignoreFocusOut: true
		});
		if (password === undefined) {
			return;
		}
		if (password) {
			await this.context.secrets.store('modpack.postgres.password', password);
		} else if (!existing && !config.get<string>('postgres.password', '') && !process.env.PGPASSWORD) {
			void vscode.window.showWarningMessage('没有提供密码，连接可能失败。可以再次运行“配置模组资料库”。');
		}

		try {
			const version = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '正在测试 PostgreSQL 连接…' },
				() => this.db.testExternal()
			);
			await this.db.initialize();
			this.runProvider.refresh();
			this.updateStatus();
			if (this.db.available) {
				this.databaseWarningShown = false;
				void vscode.window.showInformationMessage(`模组资料库已连接：${version.split(' on ')[0]}`);
			} else {
				void vscode.window.showErrorMessage(`连接成功，但初始化数据库失败：${this.db.statusText}`);
			}
		} catch (error) {
			void vscode.window.showErrorMessage(`PostgreSQL 连接失败：${safeError(error)}`, '重新配置').then(choice => {
				if (choice === '重新配置') {
					void this.configureDatabase();
				}
			});
		}
	}

	private async testDatabase(): Promise<void> {
		if (!vscode.workspace.getConfiguration('modpack').get<boolean>('postgres.enabled', true)) {
			const choice = await vscode.window.showWarningMessage('模组资料库已关闭。', '配置数据库');
			if (choice === '配置数据库') {
				await this.configureDatabase();
			}
			return;
		}
		try {
			const version = await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: '正在测试 PostgreSQL 连接…' },
				() => this.db.testExternal()
			);
			void vscode.window.showInformationMessage(`连接成功：${version.split(' on ')[0]}`);
		} catch (error) {
			void vscode.window.showErrorMessage(`连接失败：${safeError(error)}`, '配置数据库').then(choice => {
				if (choice === '配置数据库') {
					void this.configureDatabase();
				}
			});
		}
	}

	private async databaseStats(): Promise<void> {
		const stats = await this.db.getStats();
		if (!stats) {
			void vscode.window.showWarningMessage(`模组资料库不可用：${this.db.statusText}`, '配置数据库').then(choice => {
				if (choice === '配置数据库') {
					void this.configureDatabase();
				}
			});
			return;
		}
		void vscode.window.showInformationMessage(
			`模组 ${stats.mods} 个 · 版本 ${stats.versions} 个 · 安装记录 ${stats.installed} 条 · 导出 ${stats.exports} 次`
		);
	}

	//#endregion

	dispose(): void {
		for (const disposable of this.disposables.splice(0)) {
			disposable.dispose();
		}
		this.statusBar.dispose();
		this.logs.dispose();
		this.db.dispose();
	}
}

async function newestLogs(instance: Instance): Promise<string[]> {
	const directories = [instance.logsDir, path.join(instance.metaDir, 'logs')];
	const files: Array<{ file: string; time: number }> = [];
	for (const directory of directories) {
		let entries: fs.Dirent[];
		try {
			entries = await fs.promises.readdir(directory, { withFileTypes: true });
		} catch {
			continue;
		}
		for (const entry of entries) {
			if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.log')) {
				continue;
			}
			const file = path.join(directory, entry.name);
			try {
				const stat = await fs.promises.stat(file);
				files.push({ file, time: stat.mtimeMs });
			} catch {
				// Ignore a log that disappeared while scanning.
			}
		}
	}
	files.sort((a, b) => b.time - a.time);
	return files.map(entry => entry.file);
}

function safeError(error: unknown): string {
	if (error instanceof Error) {
		return error.message.split(/\r?\n/)[0].slice(0, 300);
	}
	return String(error).slice(0, 300);
}

let studio: ModpackStudio | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
	studio = new ModpackStudio(context);
	context.subscriptions.push(studio);
	await studio.start();
}

export function deactivate(): void {
	// Disposal happens through context.subscriptions.
	studio = undefined;
}
