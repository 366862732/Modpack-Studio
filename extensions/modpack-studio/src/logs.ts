import type { ChildProcess } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { Instance } from './instance';
import { launchClient, ensureServerJar, resolveJava } from './minecraft';
import { ensureDir } from './util';

export type IssueSeverity = 'error' | 'warning' | 'info';

export interface LogIssue {
	id: string;
	severity: IssueSeverity;
	message: string;
	hint?: string;
	file?: string;
	line?: number;
}

interface Pattern {
	regex: RegExp;
	severity: IssueSeverity;
	message: (match: RegExpExecArray) => string;
	hint?: string;
}

const PATTERNS: Pattern[] = [
	{
		regex: /java\.lang\.OutOfMemoryError|OutOfMemoryError|Could not reserve enough space/i,
		severity: 'error',
		message: () => '内存不足，游戏无法继续加载',
		hint: '在“运行”视图中提高分配内存（建议 4096–8192 MB），并关闭占用内存的其他程序。'
	},
	{
		regex: /UnsupportedClassVersionError|class file version (\d+)|Unsupported Java/i,
		severity: 'error',
		message: () => 'Java 版本与游戏或模组不匹配',
		hint: '安装对应版本的 Java（1.17+ 通常用 Java 17/21），然后在“运行 → 选择 Java”中指定。'
	},
	{
		regex: /Missing or unsupported mandatory dependencies|requires .* which is missing|缺少.*前置/i,
		severity: 'error',
		message: match => `缺少前置模组：${match[0].slice(0, 180)}`,
		hint: '在“模组”视图点击搜索，安装日志中提到的缺失前置。'
	},
	{
		regex: /NoSuchMethodError|NoClassDefFoundError|IncompatibleClassChangeError|AbstractMethodError/,
		severity: 'error',
		message: match => `模组版本冲突：找不到类或方法 ${match[0].slice(0, 160)}`,
		hint: '通常由两个模组依赖不同版本的前置导致。检查最近更新的模组，或安装日志中缺失的版本。'
	},
	{
		regex: /Mixin apply failed|MixinTransformerError|Mixin.*(?:failed|error)/i,
		severity: 'error',
		message: () => 'Mixin 注入失败，模组与当前版本不兼容',
		hint: '确认模组支持当前的 Minecraft、加载器和 Java 版本；尝试更新或移除最近添加的模组。'
	},
	{
		regex: /Duplicate mods|Duplicate mod|duplicate recipe|Tried to register .* twice|already registered/i,
		severity: 'error',
		message: () => '检测到重复模组或重复注册',
		hint: '在模组列表中删除重复的 jar（同名模组只保留一个版本）。'
	},
	{
		regex: /Failed to download|Unable to download|DownloadException|UnknownHostException|ConnectException|SSLHandshakeException/i,
		severity: 'warning',
		message: () => '网络请求失败，可能有资源未下载完成',
		hint: '检查网络或代理设置，然后再次启动；必要时重新安装游戏文件。'
	},
	{
		regex: /AccessDeniedException|FileNotFoundException|The process cannot access the file|另一个程序正在使用此文件/i,
		severity: 'warning',
		message: () => '文件被占用或没有访问权限',
		hint: '关闭占用该文件的程序（常见于同时打开了另一个启动器），或把整合包移到非系统目录。'
	},
	{
		regex: /Invalid mod file|ZipException|invalid LOC header|Error reading .*\.jar|zip END header not found/i,
		severity: 'error',
		message: match => `模组文件损坏：${match[0].slice(0, 160)}`,
		hint: '删除对应的 jar，重新从 Modrinth 下载。'
	},
	{
		regex: /The game crashed whilst|Description:\s*(.+)/i,
		severity: 'error',
		message: match => `游戏崩溃：${(match[1] ?? '请查看崩溃报告').slice(0, 160)}`,
		hint: '打开 crash-reports 目录中的最新报告，或查看诊断视图中的堆栈信息。'
	},
	{
		regex: /Mod .* is not compatible with|requires (?:Minecraft|Forge|Fabric|NeoForge) .*(?:version|but)/i,
		severity: 'error',
		message: match => `模组版本不兼容：${match[0].slice(0, 180)}`,
		hint: '安装与当前 Minecraft/加载器版本匹配的模组版本。'
	},
	{
		regex: /Could not find or load main class|ClassNotFoundException: net\.minecraft|Failed to load mods|LoadingFailedException/i,
		severity: 'error',
		message: () => '启动配置损坏或模组加载失败',
		hint: '先运行“安装或修复游戏文件”；如果仍然失败，检查日志中的第一个 Caused by。'
	}
];

export class LogService implements vscode.Disposable {
	readonly output = vscode.window.createOutputChannel('Minecraft 运行日志');
	private readonly diagnostics = vscode.languages.createDiagnosticCollection('minecraft');
	private readonly issuesChanged = new vscode.EventEmitter<LogIssue[]>();
	private readonly runningChanged = new vscode.EventEmitter<void>();
	private readonly issueList: LogIssue[] = [];
	private readonly issueKeys = new Set<string>();
	private child: ChildProcess | undefined;
	private currentKind: 'client' | 'server' | undefined;
	private currentInstance: Instance | undefined;
	private logUri: vscode.Uri | undefined;
	private logStream: fs.WriteStream | undefined;
	private readonly disposables: vscode.Disposable[] = [];

	readonly onDidChangeIssues = this.issuesChanged.event;
	readonly onDidChangeRunning = this.runningChanged.event;

	get issues(): readonly LogIssue[] {
		return this.issueList;
	}

	get running(): boolean {
		return !!this.child;
	}

	get runningKind(): 'client' | 'server' | undefined {
		return this.currentKind;
	}

	get runningInstance(): Instance | undefined {
		return this.currentInstance;
	}

	async startClient(instance: Instance): Promise<void> {
		if (this.child) {
			throw new Error('已经有游戏或服务端在运行');
		}
		this.output.show(true);
		this.output.appendLine(`[Modpack Studio] 正在准备启动 ${instance.name}…`);
		const result = await launchClient(instance);
		this.attach(result.process, 'client', instance);
		this.output.appendLine(`[Modpack Studio] 使用 Java: ${result.java.path} (${result.java.version})`);
	}

	async startServer(instance: Instance): Promise<void> {
		if (this.child) {
			throw new Error('已经有游戏或服务端在运行');
		}
		await ensureEula(instance);
		const jar = await ensureServerJar(instance);
		const java = await resolveJava(instance);
		const memory = instance.config.memoryMb ?? vscode.workspace.getConfiguration('modpack').get<number>('memoryMb', 4096);
		const args = [`-Xms${Math.min(1024, memory)}M`, `-Xmx${memory}M`, '-jar', path.basename(jar), 'nogui'];
		const { spawn } = await import('node:child_process');
		const child = spawn(java.path, args, {
			cwd: instance.gameDir,
			windowsHide: true,
			stdio: ['pipe', 'pipe', 'pipe']
		});
		this.output.show(true);
		this.output.appendLine(`[Modpack Studio] 启动服务端：${path.basename(jar)}`);
		this.attach(child, 'server', instance);
	}

	private attach(child: ChildProcess, kind: 'client' | 'server', instance: Instance): void {
		this.child = child;
		this.currentKind = kind;
		this.currentInstance = instance;
		this.runningChanged.fire();
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const logFile = path.join(instance.metaDir, 'logs', `${kind}-${stamp}.log`);
		void ensureDir(path.dirname(logFile)).then(() => {
			this.logStream = fs.createWriteStream(logFile, { flags: 'a' });
		});
		this.logUri = vscode.Uri.file(logFile);
		this.clearIssues(false);

		let buffer = '';
		const onData = (chunk: Buffer | string) => {
			const text = chunk.toString();
			this.output.append(text);
			this.logStream?.write(text);
			buffer += text;
			const lines = buffer.split(/\r?\n/);
			buffer = lines.pop() ?? '';
			for (const line of lines) {
				this.analyzeLine(line);
			}
			if (kind === 'server' && /Done \([\d.]+s\)! For help, type "help"/.test(text)) {
				this.output.appendLine('[Modpack Studio] 服务端已就绪，可以在“运行”视图发送命令。');
			}
		};
		child.stdout?.on('data', onData);
		child.stderr?.on('data', onData);
		child.on('exit', (code, signal) => {
			if (buffer) {
				this.analyzeLine(buffer);
				buffer = '';
			}
			this.output.appendLine(`[Modpack Studio] ${kind === 'server' ? '服务端' : '游戏'}已退出（代码 ${code ?? signal ?? '未知'}）。`);
			this.logStream?.end();
			this.logStream = undefined;
			this.child = undefined;
			this.currentKind = undefined;
			this.runningChanged.fire();
			if (code !== 0) {
				void this.diagnoseCrash(instance);
			}
		});
	}

	private analyzeLine(line: string, lineNumber?: number): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		for (const pattern of PATTERNS) {
			const match = pattern.regex.exec(trimmed);
			if (!match) {
				continue;
			}
			const message = pattern.message(match);
			const key = `${pattern.severity}:${message}`;
			if (this.issueKeys.has(key)) {
				continue;
			}
			this.issueKeys.add(key);
			const issue: LogIssue = {
				id: `${Date.now()}-${this.issueList.length}`,
				severity: pattern.severity,
				message,
				hint: pattern.hint,
				file: this.logUri?.fsPath,
				line: lineNumber
			};
			this.issueList.push(issue);
			if (this.issueList.length > 200) {
				this.issueList.shift();
			}
			if (this.logUri) {
				const diagnostic = new vscode.Diagnostic(
					new vscode.Range((lineNumber ?? 1) - 1, 0, (lineNumber ?? 1) - 1, Math.max(1, trimmed.length)),
					`${message}${pattern.hint ? `\n${pattern.hint}` : ''}`,
					pattern.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning
				);
				diagnostic.source = 'Minecraft';
				const existing = [...(this.diagnostics.get(this.logUri) ?? [])];
				this.diagnostics.set(this.logUri, [...existing, diagnostic]);
			}
			this.issuesChanged.fire([...this.issueList]);
			break;
		}
	}

	async diagnose(instance: Instance): Promise<LogIssue[]> {
		this.clearIssues(false);
		const candidates = [
			path.join(instance.logsDir, 'latest.log'),
			...await listFiles(instance.metaDir ? path.join(instance.metaDir, 'logs') : instance.logsDir, '.log')
		];
		const seen = new Set<string>();
		for (const candidate of candidates) {
			if (!candidate || seen.has(candidate)) {
				continue;
			}
			seen.add(candidate);
			if (!await exists(candidate)) {
				continue;
			}
			this.logUri = vscode.Uri.file(candidate);
			this.issueKeys.clear();
			let content: string;
			try {
				content = await fs.promises.readFile(candidate, 'utf8');
			} catch {
				continue;
			}
			const lines = content.split(/\r?\n/).slice(-8000);
			for (let index = 0; index < lines.length; index++) {
				this.analyzeLine(lines[index], index + 1);
			}
		}
		await this.diagnoseCrash(instance, false);
		if (this.issueList.length === 0) {
			void vscode.window.showInformationMessage('日志中没有发现常见错误。');
		}
		return [...this.issueList];
	}

	private async diagnoseCrash(instance: Instance, notify = true): Promise<void> {
		const crash = await newestFile(instance.crashReportsDir, /^crash-.*\.txt$/i);
		if (crash) {
			try {
				const text = await fs.promises.readFile(crash, 'utf8');
				const description = /Description:\s*(.+)/.exec(text)?.[1] ?? '未知原因';
				const stack = /-- Head --\s*([\s\S]{0,1500})/.exec(text)?.[1]?.trim();
				const issue: LogIssue = {
					id: `crash-${Date.now()}`,
					severity: 'error',
					message: `崩溃报告：${description.slice(0, 180)}`,
					hint: stack ? stack.split(/\r?\n/).slice(0, 6).join('\n') : '打开崩溃报告查看完整堆栈。',
					file: crash,
					line: 1
				};
				if (!this.issueKeys.has(issue.message)) {
					this.issueKeys.add(issue.message);
					this.issueList.push(issue);
					this.issuesChanged.fire([...this.issueList]);
				}
			} catch {
				// ignore broken crash report
			}
		}
		const hsErr = await newestFile(instance.gameDir, /^hs_err_pid\d+\.log$/i);
		if (hsErr) {
			this.issueList.push({
				id: `jvm-${Date.now()}`,
				severity: 'error',
				message: 'JVM 崩溃，通常是内存不足或 Java 版本问题',
				hint: '查看 hs_err 日志，降低内存或更换 Java 版本。',
				file: hsErr,
				line: 1
			});
			this.issuesChanged.fire([...this.issueList]);
		}
		if (notify && this.issueList.length > 0) {
			const action = await vscode.window.showErrorMessage('游戏异常退出，已生成诊断结果。', '查看诊断', '打开日志');
			if (action === '查看诊断') {
				await vscode.commands.executeCommand('modpack.issues.focus');
			} else if (action === '打开日志') {
				await vscode.commands.executeCommand('modpack.openLogs');
			}
		}
	}

	clearIssues(notify = true): void {
		this.issueList.length = 0;
		this.issueKeys.clear();
		this.diagnostics.clear();
		this.issuesChanged.fire([]);
		if (notify) {
			this.output.appendLine('[Modpack Studio] 已清空诊断结果。');
		}
	}

	sendServerCommand(command: string): void {
		if (!this.child || this.currentKind !== 'server') {
			throw new Error('服务端没有运行');
		}
		this.child.stdin?.write(`${command}\n`);
		this.output.appendLine(`> ${command}`);
	}

	async stop(): Promise<void> {
		if (!this.child) {
			return;
		}
		if (this.currentKind === 'server') {
			this.child.stdin?.write('stop\n');
			await new Promise<void>(resolve => {
				const timer = setTimeout(() => {
					this.child?.kill();
					resolve();
				}, 10_000);
				this.child?.once('exit', () => {
					clearTimeout(timer);
					resolve();
				});
			});
		} else {
			this.child.kill();
		}
	}

	dispose(): void {
		this.child?.kill();
		this.logStream?.end();
		this.diagnostics.dispose();
		this.issuesChanged.dispose();
		this.runningChanged.dispose();
		this.output.dispose();
		for (const disposable of this.disposables) {
			disposable.dispose();
		}
	}
}

async function ensureEula(instance: Instance): Promise<void> {
	const eulaPath = path.join(instance.gameDir, 'eula.txt');
	let accepted = false;
	try {
		accepted = /eula\s*=\s*true/i.test(await fs.promises.readFile(eulaPath, 'utf8'));
	} catch {
		accepted = false;
	}
	if (accepted) {
		return;
	}
	const choice = await vscode.window.showWarningMessage(
		'启动 Minecraft 服务端需要同意 Mojang 最终用户许可协议（EULA）。是否同意并继续？',
		{ modal: true },
		'同意并启动',
		'查看 EULA'
	);
	if (choice === '查看 EULA') {
		await vscode.env.openExternal(vscode.Uri.parse('https://aka.ms/MinecraftEULA'));
		throw new Error('尚未同意 EULA');
	}
	if (choice !== '同意并启动') {
		throw new Error('已取消启动服务端');
	}
	await fs.promises.writeFile(eulaPath, '# 由 Modpack Studio 写入\neula=true\n', 'utf8');
}

async function exists(file: string): Promise<boolean> {
	try {
		await fs.promises.access(file);
		return true;
	} catch {
		return false;
	}
}

async function listFiles(directory: string, extension: string): Promise<string[]> {
	try {
		const entries = await fs.promises.readdir(directory, { withFileTypes: true });
		return entries
			.filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(extension))
			.map(entry => path.join(directory, entry.name));
	} catch {
		return [];
	}
}

async function newestFile(directory: string, pattern: RegExp): Promise<string | undefined> {
	try {
		const entries = await fs.promises.readdir(directory, { withFileTypes: true });
		const files = entries
			.filter(entry => entry.isFile() && pattern.test(entry.name))
			.map(entry => path.join(directory, entry.name));
		if (!files.length) {
			return undefined;
		}
		const stats = await Promise.all(files.map(async file => ({ file, time: (await fs.promises.stat(file)).mtimeMs })));
		stats.sort((a, b) => b.time - a.time);
		return stats[0]?.file;
	} catch {
		return undefined;
	}
}
