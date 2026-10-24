/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { AuxiliaryWindowMode, IAuxiliaryWindowService, type IAuxiliaryWindow } from '../../../services/auxiliaryWindow/browser/auxiliaryWindowService.js';
import { IWebviewService, type IWebviewElement } from '../../webview/browser/webview.js';
import { ICommandService, CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

/**
 * 传递给浮动向导窗口的初始化数据。
 */
export interface IModpackWizardData {
	readonly allVersions: Array<{ id: string; type: string }>;
	readonly popularVersions: Array<{ id: string; label: string }>;
	readonly loaderIcons: Record<string, string>;
	readonly loaderNames: Record<string, string>;
	readonly loaderDescriptors: Record<string, string>;
}

export interface IModpackWizardService {
	readonly _serviceBrand: undefined;

	/**
	 * 打开一个浮动辅助窗口，在其中挂载一个独立上下文的 webview 元素并渲染 Modpack 向导 HTML。
	 *
	 * 浮动窗口与扩展端（Node 宿主）的通信通过 webview 标准消息桥（`acquireVsCodeApi().postMessage`
	 * 与 `webview.onMessage`）完成，service 再经命令桥 `modpack.wizardRpc` 把消息转发给扩展宿主。
	 * 其中 `wizardId` 由本方法在打开窗口时生成并通过命令返回值传回扩展端，用于多窗口之间隔离。
	 */
	openWizard(data: IModpackWizardData): Promise<{ window: IAuxiliaryWindow; wizardId: string }>;

	/**
	 * 由扩展宿主调用：向指定 `wizardId` 的向导 webview 推送一条消息（loaderVersions / progress / done / error）。
	 */
	postWizardMessage(wizardId: string, message: unknown): Promise<void>;
}

export const IModpackWizardService = createDecorator<IModpackWizardService>('modpackWizardService');

export class ModpackWizardService extends Disposable implements IModpackWizardService {
	declare readonly _serviceBrand: undefined;

	private readonly _wizardWebviews = new Map<string, IWebviewElement>();

	constructor(
		@IAuxiliaryWindowService private readonly auxiliaryWindowService: IAuxiliaryWindowService,
		@IWebviewService private readonly webviewService: IWebviewService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super();
	}

	async openWizard(data: IModpackWizardData): Promise<{ window: IAuxiliaryWindow; wizardId: string }> {
		const wizardId = Math.random().toString(36).slice(2, 10);

		const auxWindow = await this.auxiliaryWindowService.open({
			mode: AuxiliaryWindowMode.Normal,
			bounds: { width: 986, height: 638 },
			nativeTitlebar: true,
			disableFullscreen: true,
			alwaysOnTop: false
		});

		const disposables = new DisposableStore();
		disposables.add(auxWindow);

		await auxWindow.whenStylesHaveLoaded;
		auxWindow.window.document.title = '新建整合包';

		// 移除默认的 monaco-workbench 容器，腾出整个浮动窗口给向导 webview
		auxWindow.container.remove();

		const body = auxWindow.window.document.body;
		body.style.margin = '0';
		body.style.overflow = 'hidden';
		body.style.backgroundColor = '#11111b';
		body.style.colorScheme = 'dark';
		body.style.height = '100%';

		// 辅助窗口的 document.createElement 被 auxiliaryWindowService 故意禁用
		// （"Always use the main window so that instanceof HTMLElement continues to work"）。
		// 因此 hostDiv 必须由主窗口 document 创建，再 appendChild 到子窗口 body ——
		// 跨窗口 DOM 附加是合法的（与 auxiliaryWindowService.applyHTML 的 container 创建方式一致）。
		const hostDiv = document.createElement('div');
		hostDiv.style.position = 'fixed';
		hostDiv.style.inset = '0';
		body.appendChild(hostDiv);
		disposables.add({ dispose: () => hostDiv.remove() });

		const webview = disposables.add(
			this.webviewService.createWebviewElement({
				title: '新建整合包',
				origin: undefined,
				options: {
					retainContextWhenHidden: true,
					enableFindWidget: false
				},
				contentOptions: {
					allowScripts: true,
					allowForms: true
				},
				extension: undefined
			})
		);
		this._wizardWebviews.set(wizardId, webview);

		// webview 内部 JS 通过 acquireVsCodeApi().postMessage 发来的消息，
		// service 端在此经命令桥转发给扩展宿主（Node）
		disposables.add(webview.onMessage(message => {
			this.forwardToExtension(wizardId, message);
		}));

		webview.mountTo(hostDiv, auxWindow.window);
		webview.setHtml(renderWizardHtml(data, wizardId));

		// 窗口关闭时清理：移除 webview、释放 DisposableStore。
		// 不在 disposables 里再注册 `disposables.dispose()` 的自引用，避免 LEAKED DISPOSABLE。
		disposables.add(auxWindow.onUnload(() => {
			this._wizardWebviews.delete(wizardId);
			disposables.dispose();
		}));

		return { window: auxWindow, wizardId };
	}

	async postWizardMessage(wizardId: string, message: unknown): Promise<void> {
		const webview = this._wizardWebviews.get(wizardId);
		if (!webview) {
			return;
		}
		// 扩展宿主 -> webview 的消息统一包一层 type，webview 端按 type 分发
		webview.postMessage({ type: 'modpack-wizard', ...asMessage(message) });
	}

	/**
	 * 把 webview -> 扩展宿主的消息经命令 `modpack.wizardRpc` 转发出去。
	 * 该命令由扩展端注册（workbench 侧 executeCommand 会走到扩展宿主），
	 * 完成"主代码 service 中转"的跨宿主通信。
	 */
	private forwardToExtension(wizardId: string, message: unknown): void {
		// 扩展端 `modpack.wizardRpc` 命令签名为 `(wizardId, message)` 两个参数，
		// 经 MainThreadCommands 桥接后 executeCommand('modpack.wizardRpc', wizardId, message) 才能正确传递。
		void this.commandService.executeCommand('modpack.wizardRpc', wizardId, message);
	}
}

/**
 * 注册 workbench 命令：
 * - `modpack.openWizard`：由扩展端 executeCommand 触发，打开浮动向导窗口，返回 `{ wizardId }`。
 * - `modpack.pushWizardMessage`：由扩展端 executeCommand 触发，向指定 `wizardId` 的向导 webview 推送一条消息。
 *
 * 反向（webview -> 扩展宿主）不在此注册命令，而是由 service 端在收到 webview 消息时直接
 * `executeCommand('modpack.wizardRpc', wizardId, message)`，该命令由扩展端注册并经
 * MainThreadCommands 桥接路由到扩展宿主。
 */
class ModpackWizardContribution extends Disposable {
	declare readonly _serviceBrand: undefined;

	static readonly ID = 'modpackWizardContribution';

	constructor(
		@IModpackWizardService private readonly wizardService: IModpackWizardService,
	) {
		super();
		CommandsRegistry.registerCommand('modpack.openWizard', async (accessor: ServicesAccessor, wizardData?: unknown) => {
			const data = wizardData as Partial<IModpackWizardData> | undefined;
			const result = await this.wizardService.openWizard({
				allVersions: data?.allVersions ?? [],
				popularVersions: data?.popularVersions ?? [],
				loaderIcons: data?.loaderIcons ?? {},
				loaderNames: data?.loaderNames ?? {},
				loaderDescriptors: data?.loaderDescriptors ?? {}
			});
			// 把 wizardId 返回给扩展端，扩展端用它构造消息推送目标
			return { wizardId: result.wizardId };
		});

		CommandsRegistry.registerCommand('modpack.pushWizardMessage', async (accessor: ServicesAccessor, wizardId: unknown, message: unknown) => {
			await this.wizardService.postWizardMessage(String(wizardId), message);
		});
	}
}

function asMessage(message: unknown): Record<string, unknown> {
	if (message && typeof message === 'object') {
		return message as Record<string, unknown>;
	}
	return { data: message };
}

registerWorkbenchContribution2(ModpackWizardContribution.ID, ModpackWizardContribution, WorkbenchPhase.AfterRestored);

/**
 * 渲染完整的向导 HTML 字符串（含内联 CSS / JS）。
 */
function renderWizardHtml(data: IModpackWizardData, nonce: string): string {
	const versionsJson = JSON.stringify(data.allVersions).replace(/</g, '\\u003c');
	const popularJson = JSON.stringify(data.popularVersions).replace(/</g, '\\u003c');
	const iconsJson = JSON.stringify(data.loaderIcons).replace(/</g, '\\u003c');
	const namesJson = JSON.stringify(data.loaderNames).replace(/</g, '\\u003c');
	const descsJson = JSON.stringify(data.loaderDescriptors).replace(/</g, '\\u003c');

	return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>新建整合包</title>
<style>
	:root {
		--bg: #11111b; --bg2: #181825; --bg3: #313244;
		--fg: #cdd6f4; --fg2: #a6adc8; --fg3: #6c7086;
		--accent: #89b4fa; --green: #a6e3a1; --red: #f38ba8;
		--border: #45475a;
	}
	* { box-sizing: border-box; margin: 0; padding: 0; }
	body {
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Inter', sans-serif;
		background: var(--bg); color: var(--fg); font-size: 14px;
		width: 100%; height: 100vh; overflow: hidden; display: flex; flex-direction: column;
	}
	.header {
		padding: 20px 28px 0; font-size: 20px; font-weight: 600;
		display: flex; align-items: center; gap: 12px;
	}
	.header .subtitle { font-size: 13px; color: var(--fg3); font-weight: 400; }

	.stepper {
		display: flex; gap: 4px; padding: 16px 28px; border-bottom: 1px solid var(--bg3);
	}
	.step-item {
		flex: 1; display: flex; align-items: center; gap: 8px;
		font-size: 12px; color: var(--fg3); transition: all 0.15s;
		padding: 6px 0;
	}
	.step-item .num {
		width: 22px; height: 22px; border-radius: 50%; border: 2px solid var(--bg3);
		display: flex; align-items: center; justify-content: center; font-weight: 600;
		flex-shrink: 0;
	}
	.step-item.active { color: var(--accent); }
	.step-item.active .num { border-color: var(--accent); color: var(--accent); }
	.step-item.done { color: var(--green); }
	.step-item.done .num { border-color: var(--green); color: var(--green); background: rgba(166,227,161,0.12); }

	.content { flex: 1; overflow-y: auto; padding: 24px 28px; }
	.step-panel { display: none; }
	.step-panel.active { display: block; animation: fadeUp 0.2s ease; }
	@keyframes fadeUp { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }

	.field-label { font-size: 13px; font-weight: 500; color: var(--fg2); margin-bottom: 6px; display: block; }
	.input {
		width: 100%; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
		color: var(--fg); font-size: 13px; padding: 10px 12px; outline: none; font-family: inherit;
	}
	.input:focus { border-color: var(--accent); }

	/* 模式选择 */
	.mode-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-top: 12px; }
	.mode-btn {
		padding: 14px; border-radius: 8px; border: 1px solid var(--border); background: var(--bg2);
		color: var(--fg); cursor: pointer; text-align: center; font-size: 13px; transition: all 0.15s;
	}
	.mode-btn:hover { border-color: var(--accent); }
	.mode-btn.selected { border-color: var(--accent); background: rgba(137,180,250,0.10); color: var(--accent); }

	/* 版本下拉 */
	.section-title {
		font-size: 12px; color: var(--fg3); margin: 16px 0 8px;
		text-transform: uppercase; letter-spacing: 0.5px;
	}
	.version-row { display: flex; gap: 12px; align-items: flex-start; }
	.version-select-wrap { flex: 1; min-width: 220px; }
	.version-select {
		width: 100%; background: var(--bg2); border: 1px solid var(--border); border-radius: 6px;
		color: var(--fg); font-size: 13px; padding: 8px 10px; outline: none; font-family: inherit;
		-webkit-appearance: none; appearance: none;
		background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23a6adc8' d='M6 8L1 3h10z'/%3E%3C/svg%3E");
		background-repeat: no-repeat; background-position: right 10px center; padding-right: 28px;
	}
	.version-select:focus { border-color: var(--accent); }
	.popular-hints { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
	.popular-hints .hint-label { font-size: 11px; color: var(--fg3); margin-right: 2px; }
	.popular-hint {
		padding: 4px 10px; border-radius: 12px; border: 1px solid var(--border);
		background: var(--bg2); color: var(--fg2); font-size: 12px; cursor: pointer;
		transition: all 0.12s; white-space: nowrap;
	}
	.popular-hint:hover { border-color: var(--accent); color: var(--accent); }
	.popular-hint.active { border-color: var(--accent); background: rgba(137,180,250,0.12); color: var(--accent); }

	/* 多版本 chips */
	.multi-versions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 12px; }
	.multi-ver-chip {
		background: var(--bg3); border: 1px solid var(--border); padding: 4px 10px;
		border-radius: 12px; font-size: 12px; display: flex; align-items: center; gap: 4px;
	}
	.multi-ver-chip button { background: none; border: none; color: var(--fg3); cursor: pointer; font-size: 14px; }
	.multi-ver-chip button:hover { color: var(--red); }

	/* 加载器 */
	.loader-grid { display: grid; grid-template-columns: repeat(5, 1fr); gap: 10px; margin-top: 12px; }
	.loader-card {
		display: flex; flex-direction: column; align-items: center; gap: 6px;
		padding: 14px 6px; border-radius: 8px; border: 1px solid var(--border);
		background: var(--bg2); cursor: pointer; transition: all 0.15s; text-align: center;
	}
	.loader-card:hover { border-color: var(--accent); }
	.loader-card.selected { border-color: var(--accent); background: rgba(137,180,250,0.10); }
	.loader-icon { font-size: 28px; }
	.loader-name { font-size: 13px; font-weight: 500; }
	.loader-desc { font-size: 11px; color: var(--fg3); }

	/* 加载器版本列表 */
	.loader-version-section {
		margin-top: 16px; display: none;
	}
	.loader-version-section.visible { display: block; }
	.lv-list {
		max-height: 180px; overflow-y: auto; border: 1px solid var(--border);
		border-radius: 6px; background: var(--bg2);
	}
	.lv-item {
		padding: 8px 12px; font-size: 13px; cursor: pointer;
		border-bottom: 1px solid var(--bg3); transition: background 0.1s;
	}
	.lv-item:last-child { border-bottom: none; }
	.lv-item:hover { background: var(--bg3); }
	.lv-item.selected { background: rgba(137,180,250,0.12); color: var(--accent); }
	.lv-stable { font-size: 11px; color: var(--fg3); }
	.lv-loading { padding: 12px; font-size: 13px; color: var(--fg3); }

	/* 参数输入 */
	.params-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 12px; }

	/* 摘要 */
	.summary-area { margin-top: 12px; }
	.summary-row {
		display: flex; justify-content: space-between; align-items: center;
		padding: 10px 12px; background: var(--bg2); border: 1px solid var(--border);
		border-radius: 6px; margin-bottom: 6px;
	}
	.summary-key { font-size: 13px; color: var(--fg2); }
	.summary-val { font-size: 13px; font-weight: 500; }

	/* 进度条 */
	.progress-section { margin-top: 16px; display: none; }
	.progress-section.visible { display: block; }
	.progress-bar-bg { height: 6px; background: var(--bg3); border-radius: 3px; overflow: hidden; }
	.progress-bar {
		height: 100%; width: 0%; background: var(--accent); border-radius: 3px;
		transition: width 0.25s ease;
	}
	.progress-text { font-size: 12px; color: var(--fg3); margin-top: 6px; display: flex; justify-content: space-between; }

	/* 错误 */
	.error-box {
		margin-top: 12px; padding: 10px 12px; background: rgba(243,139,168,0.10);
		border: 1px solid var(--red); border-radius: 6px; color: var(--red);
		font-size: 13px; white-space: pre-wrap;
	}

	/* 底部按钮 */
	.footer {
		padding: 14px 28px; border-top: 1px solid var(--bg3);
		display: flex; justify-content: space-between; align-items: center;
	}
	.btn {
		padding: 8px 20px; border-radius: 6px; border: 1px solid var(--border);
		background: var(--bg2); color: var(--fg); font-size: 13px; font-weight: 500;
		cursor: pointer; transition: all 0.12s; font-family: inherit;
	}
	.btn:hover { border-color: var(--accent); color: var(--accent); }
	.btn:disabled { opacity: 0.4; cursor: not-allowed; }
	.btn.primary { background: var(--accent); border-color: var(--accent); color: #11111b; }
	.btn.primary:hover { filter: brightness(1.1); }
	.btn.primary:disabled { filter: none; opacity: 0.4; }
</style>
</head>
<body>
	<div class="header">
		新建整合包
		<span class="subtitle">填写 4 步完成创建</span>
	</div>

	<div class="stepper">
		<div class="step-item active" data-step="1"><div class="num">1</div>版本选择</div>
		<div class="step-item" data-step="2"><div class="num">2</div>加载器</div>
		<div class="step-item" data-step="3"><div class="num">3</div>参数配置</div>
		<div class="step-item" data-step="4"><div class="num">4</div>确认创建</div>
	</div>

	<div class="content">
		<!-- 步骤 1 -->
		<div class="step-panel active" id="panel1">
			<label class="field-label">整合包名称</label>
			<input class="input" id="instName" placeholder="我的整合包" value="我的整合包" />

			<label class="field-label">模式</label>
			<div class="mode-row">
				<div class="mode-btn selected" id="modeSingle">单版本</div>
				<div class="mode-btn" id="modeMulti">多版本</div>
			</div>

			<div id="singleModeArea">
				<div class="version-row">
					<div class="version-select-wrap">
						<span class="field-label">Minecraft 版本</span>
						<select class="version-select" id="versionSelect"></select>
					</div>
					<div class="popular-hints" id="popularHints">
						<span class="hint-label">常用：</span>
					</div>
				</div>
			</div>

			<div id="multiModeArea" style="display:none">
				<div class="version-row">
					<div class="version-select-wrap">
						<span class="field-label">选择版本加入</span>
						<select class="version-select" id="multiVersionSelect"></select>
					</div>
					<button class="btn" id="btnAddMultiVer" style="margin-top:20px">+ 添加</button>
				</div>
				<div class="section-title" id="multiChipsTitle" style="display:none">已选版本</div>
				<div class="multi-versions" id="multiChips"></div>
			</div>
		</div>

		<!-- 步骤 2 -->
		<div class="step-panel" id="panel2">
			<label class="field-label">选择加载器</label>
			<div class="loader-grid" id="loaderGrid"></div>
			<div class="loader-version-section" id="loaderVersionSection">
				<span class="field-label" id="loaderVersionTitle">加载器版本</span>
				<div class="lv-list" id="loaderVersionList">
					<div class="lv-loading">请先选择加载器</div>
				</div>
			</div>
		</div>

		<!-- 步骤 3 -->
		<div class="step-panel" id="panel3">
			<div class="params-grid">
				<div>
					<label class="field-label">内存（MB）</label>
					<input class="input" type="number" id="memoryMb" placeholder="2048" value="2048" min="512" step="256" />
				</div>
				<div>
					<label class="field-label">JVM 参数（空格分隔）</label>
					<input class="input" id="jvmArgs" placeholder="-XX:+UseG1GC -XX:MaxGCPauseMillis=50" />
				</div>
				<div>
					<label class="field-label">启动参数</label>
					<input class="input" id="launchArgs" placeholder="（可选）" />
				</div>
			</div>
		</div>

		<!-- 步骤 4 -->
		<div class="step-panel" id="panel4">
			<label class="field-label">确认配置</label>
			<div class="summary-area" id="summaryArea"></div>
			<div class="progress-section" id="progressSection">
				<div class="progress-bar-bg"><div class="progress-bar" id="progressBar"></div></div>
				<div class="progress-text"><span id="progressMsg"></span><span id="progressPct"></span></div>
			</div>
			<div class="error-box" id="errorMsg" style="display:none"></div>
		</div>
	</div>

	<div class="footer">
		<button class="btn" id="btnBack" disabled>← 上一步</button>
		<span style="font-size:12px;color:var(--fg3)" id="stepLabel">步骤 1 / 4</span>
		<button class="btn primary" id="btnNext">下一步 →</button>
	</div>

	<script>
	(function() {
		'use strict';

		// ---- 注入数据 ----
		const ALL_VERSIONS = ${versionsJson};
		const POPULAR_VERSIONS = ${popularJson};
		const LOADER_ICONS = ${iconsJson};
		const LOADER_NAMES = ${namesJson};
		const LOADER_DESCRIPTORS = ${descsJson};

		// 通过 webview 的 acquireVsCodeApi 与扩展端通信（wizardId 由主代码 service 注入，
		// service 把 webview 消息转发给扩展宿主，扩展端再经 modpack.pushWizardMessage 推回）
		const api = (typeof acquireVsCodeApi === 'function') ? acquireVsCodeApi() : null;
		const WIZARD_ID = ${JSON.stringify(nonce)};

		const send = (payload) => {
			if (api) {
				api.postMessage(Object.assign({ type: 'modpack-wizard' }, payload));
			}
		};
		// 关闭请求：经 service 端 onMessage -> forwardToExtension 转到扩展宿主
		const requestClose = () => {
			send({ type: 'modpack-wizard-close' });
		};

		// 扩展端推送回来的消息（loaderVersions / progress / done / error）
		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (!msg || msg.type !== 'modpack-wizard') {
				return;
			}
			handleWizardMessage(msg);
		});
		function handleWizardMessage(msg) {
			if (msg.action === 'loaderVersions') {
				onLoaderVersions(msg.versions || []);
			} else if (msg.action === 'progress') {
				const pct = msg.percent != null ? Math.round(msg.percent * 100) : null;
				document.getElementById('progressBar').style.width = (pct != null ? pct : 0) + '%';
				document.getElementById('progressMsg').textContent = msg.message || '';
				document.getElementById('progressPct').textContent = pct != null ? pct + '%' : '';
			} else if (msg.action === 'done') {
				document.getElementById('progressBar').style.width = '100%';
				document.getElementById('progressMsg').textContent = msg.message || '完成';
				document.getElementById('progressPct').textContent = '100%';
				const btnNext = document.getElementById('btnNext');
				btnNext.textContent = '完成';
				btnNext.disabled = false;
				btnNext.onclick = requestClose;
			} else if (msg.action === 'error') {
				const el = document.getElementById('errorMsg');
				el.textContent = msg.message || '发生未知错误';
				el.style.display = 'block';
				document.getElementById('btnNext').disabled = false;
			}
		}

		let currentStep = 1;
		let mode = 'single';
		let selectedVersion = '';
		let selectedMultiVersions = [];
		let selectedLoader = 'vanilla';
		let selectedLoaderVersion = '';

		// ---- 版本下拉 ----
		function renderVersionSelect(id) {
			const el = document.getElementById(id);
			el.innerHTML = '';
			const ph = document.createElement('option');
			ph.value = ''; ph.textContent = '选择版本…'; ph.disabled = true; ph.selected = true;
			el.appendChild(ph);
			const releases = ALL_VERSIONS.filter(v => v.type === 'release');
			const snapshots = ALL_VERSIONS.filter(v => v.type === 'snapshot');
			const old = ALL_VERSIONS.filter(v => v.type === 'old');
			appendGroup(el, '正式版', releases);
			appendGroup(el, '快照 / 预览', snapshots);
			if (old.length) appendGroup(el, '其他', old);
		}
		function appendGroup(select, title, items) {
			if (!items.length) return;
			const g = document.createElement('optgroup'); g.label = title;
			items.forEach(v => {
				const o = document.createElement('option');
				o.value = v.id; o.textContent = v.id;
				g.appendChild(o);
			});
			select.appendChild(g);
		}
		function renderPopularHints() {
			const area = document.getElementById('popularHints');
			POPULAR_VERSIONS.forEach(v => {
				const chip = document.createElement('span');
				chip.className = 'popular-hint'; chip.textContent = v.id;
				chip.dataset.id = v.id;
				chip.addEventListener('click', () => {
					selectedVersion = v.id;
					document.getElementById('versionSelect').value = v.id;
					syncPopularHints();
				});
				area.appendChild(chip);
			});
		}
		function syncPopularHints() {
			document.querySelectorAll('.popular-hint').forEach(c =>
				c.classList.toggle('active', c.dataset.id === selectedVersion));
		}
		function updateMultiSelectDisabled() {
			document.querySelectorAll('#multiVersionSelect option').forEach(o =>
				o.disabled = selectedMultiVersions.includes(o.value));
			const first = [...document.querySelectorAll('#multiVersionSelect option')].find(o => !o.disabled);
			if (first) document.getElementById('multiVersionSelect').value = first.value;
		}

		function addMultiVer() {
			const val = document.getElementById('multiVersionSelect').value;
			if (!val) return;
			if (!selectedMultiVersions.includes(val)) {
				selectedMultiVersions.push(val);
				renderMultiChips();
			}
		}
		function renderMultiChips() {
			const area = document.getElementById('multiChips');
			const title = document.getElementById('multiChipsTitle');
			title.style.display = selectedMultiVersions.length ? '' : 'none';
			area.innerHTML = '';
			selectedMultiVersions.forEach(v => {
				const chip = document.createElement('div');
				chip.className = 'multi-ver-chip';
				const label = document.createElement('span'); label.textContent = v;
				const btn = document.createElement('button'); btn.textContent = '\\u00d7';
				btn.addEventListener('click', () => {
					selectedMultiVersions = selectedMultiVersions.filter(x => x !== v);
					renderMultiChips();
				});
				chip.appendChild(label); chip.appendChild(btn);
				area.appendChild(chip);
			});
			updateMultiSelectDisabled();
		}

		// ---- 模式切换 ----
		document.getElementById('modeSingle').addEventListener('click', () => setMode('single'));
		document.getElementById('modeMulti').addEventListener('click', () => setMode('multi'));
		function setMode(m) {
			mode = m;
			document.getElementById('modeSingle').classList.toggle('selected', m === 'single');
			document.getElementById('modeMulti').classList.toggle('selected', m === 'multi');
			document.getElementById('singleModeArea').style.display = m === 'single' ? '' : 'none';
			document.getElementById('multiModeArea').style.display = m === 'multi' ? '' : 'none';
		}

		// ---- 版本下拉事件 ----
		document.getElementById('versionSelect').addEventListener('change', e => {
			selectedVersion = e.target.value;
			syncPopularHints();
		});
		document.getElementById('btnAddMultiVer').addEventListener('click', addMultiVer);

		// ---- 加载器 ----
		function renderLoaderGrid() {
			const el = document.getElementById('loaderGrid');
			el.innerHTML = '';
			Object.keys(LOADER_ICONS).forEach(k => {
				const card = document.createElement('div');
				card.className = 'loader-card' + (k === selectedLoader ? ' selected' : '');
				card.id = 'loader-' + k;
				card.innerHTML =
					'<span class="loader-icon">' + LOADER_ICONS[k] + '</span>' +
					'<div class="loader-name">' + (LOADER_NAMES[k] || k) + '</div>' +
					'<div class="loader-desc">' + (LOADER_DESCRIPTORS[k] || '') + '</div>';
				card.addEventListener('click', () => selectLoader(k));
				el.appendChild(card);
			});
		}
		function selectLoader(k) {
			selectedLoader = k;
			selectedLoaderVersion = '';
			document.querySelectorAll('.loader-card').forEach(c => c.classList.remove('selected'));
			const card = document.getElementById('loader-' + k);
			if (card) card.classList.add('selected');

			const section = document.getElementById('loaderVersionSection');
			if (k === 'vanilla') {
				section.classList.remove('visible');
				return;
			}
			section.classList.add('visible');
			document.getElementById('loaderVersionTitle').textContent = (LOADER_NAMES[k] || k) + ' 版本';
			const list = document.getElementById('loaderVersionList');
			list.innerHTML = '<div class="lv-loading">正在加载 ' + (LOADER_NAMES[k] || k) + ' 版本…</div>';

			// 请求扩展端获取加载器版本
			send({ type: 'modpack-wizard', action: 'loadVersions', loader: k, mcVersion: getEffectiveVersion() });
		}
		function getEffectiveVersion() {
			if (mode === 'multi') return selectedMultiVersions[0] || selectedVersion || (POPULAR_VERSIONS[0] && POPULAR_VERSIONS[0].id);
			return selectedVersion || (POPULAR_VERSIONS[0] && POPULAR_VERSIONS[0].id);
		}

		// 来自扩展端的消息统一走 handleWizardMessage（在 window 'message' 监听器中分发）

		function onLoaderVersions(versions) {
			const list = document.getElementById('loaderVersionList');
			list.innerHTML = '';
			if (!versions.length) {
				list.innerHTML = '<div class="lv-loading">未找到版本列表，创建后可手动填入</div>';
				return;
			}
			versions.slice(0, 40).forEach(v => {
				const item = document.createElement('div');
				item.className = 'lv-item';
				item.dataset.ver = v.version;
				item.innerHTML = '<span>' + v.version + '</span>' +
					(v.stable === false ? '<span class="lv-stable">测试版</span>' : '');
				item.addEventListener('click', () => {
					selectedLoaderVersion = v.version;
					list.querySelectorAll('.lv-item').forEach(el => el.classList.remove('selected'));
					item.classList.add('selected');
				});
				list.appendChild(item);
			});
		}

		// ---- 步骤导航 ----
		function goNext() {
			if (currentStep === 1) {
				const name = document.getElementById('instName').value.trim();
				if (!name) { alert('请填写整合包名称'); return; }
				if (mode === 'single' && !selectedVersion) { alert('请选择 Minecraft 版本'); return; }
				if (mode === 'multi' && !selectedMultiVersions.length) { alert('请至少选择一个版本'); return; }
			}
			if (currentStep < 4) {
				currentStep++;
				showStep(currentStep);
			} else {
				doCreate();
			}
		}
		function goBack() {
			if (currentStep > 1) { currentStep--; showStep(currentStep); }
		}
		function showStep(step) {
			document.querySelectorAll('.step-panel').forEach(p => p.classList.remove('active'));
			document.getElementById('panel' + step).classList.add('active');
			document.querySelectorAll('.step-item').forEach(s => {
				const n = parseInt(s.dataset.step);
				s.classList.toggle('active', n === step);
				s.classList.toggle('done', n < step);
			});
			document.getElementById('stepLabel').textContent = '步骤 ' + step + ' / 4';
			document.getElementById('btnBack').disabled = step === 1;
			document.getElementById('btnNext').textContent = step === 4 ? '创建整合包' : '下一步 →';
			if (step === 4) buildSummary();
		}
		function buildSummary() {
			const name = document.getElementById('instName').value.trim();
			const version = mode === 'multi' ? selectedMultiVersions.join(', ') : selectedVersion;
			const loaderLabel = LOADER_NAMES[selectedLoader] || selectedLoader;
			const lv = selectedLoaderVersion ? ' ' + selectedLoaderVersion : '（未指定）';
			const mem = document.getElementById('memoryMb').value || '2048';
			const jvm = document.getElementById('jvmArgs').value.trim();
			const launch = document.getElementById('launchArgs').value.trim();

			const rows = [
				['名称', name],
				['Minecraft 版本', version],
				['模式', mode === 'multi' ? '多版本（' + selectedMultiVersions.length + ' 个）' : '单版本'],
				['加载器', loaderLabel + lv],
				['内存', mem + ' MB']
			];
			if (jvm) rows.push(['JVM 参数', jvm]);
			if (launch) rows.push(['启动参数', launch]);

			const area = document.getElementById('summaryArea');
			area.innerHTML = '';
			rows.forEach(([k, v]) => {
				const row = document.createElement('div');
				row.className = 'summary-row';
				row.innerHTML = '<span class="summary-key">' + k + '</span><span class="summary-val" data-val="' + String(v).replace(/"/g, '&quot;') + '">' + v + '</span>';
				area.appendChild(row);
			});
		}
		function doCreate() {
			const name = document.getElementById('instName').value.trim();
			const mcVersion = mode === 'multi' ? selectedMultiVersions[0] : selectedVersion;
			const jvm = document.getElementById('jvmArgs').value.trim();
			const mem = parseInt(document.getElementById('memoryMb').value || '2048', 10);
			const launch = document.getElementById('launchArgs').value.trim();

			document.getElementById('btnNext').disabled = true;
			document.getElementById('btnBack').disabled = true;
			document.getElementById('progressSection').classList.add('visible');
			document.getElementById('progressBar').style.width = '0%';
			document.getElementById('progressMsg').textContent = '正在创建整合包…';
			document.getElementById('progressPct').textContent = '';
			document.getElementById('errorMsg').style.display = 'none';

			send({
				type: 'modpack-wizard',
				action: 'create',
				name,
				mode,
				minecraftVersion: mcVersion,
				multiVersions: selectedMultiVersions,
				loader: selectedLoader,
				loaderVersion: selectedLoaderVersion || undefined,
				memoryMb: mem,
				jvmArgs: jvm ? jvm.split(/\\s+/).filter(Boolean) : [],
				launchArgs: launch || undefined
			});
		}

		document.getElementById('btnBack').addEventListener('click', goBack);
		document.getElementById('btnNext').addEventListener('click', goNext);

		// 初始化
		renderVersionSelect('versionSelect');
		renderVersionSelect('multiVersionSelect');
		renderPopularHints();
		renderLoaderGrid();
		updateMultiSelectDisabled();
		showStep(1);
	})();
	</script>
</body>
</html>
	`;
}
