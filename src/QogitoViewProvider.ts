import * as vscode from 'vscode';
import { LLamaCPPApi, ApiMessage } from './llamacpp_api';
import { ACTIVE_MODE_TOOLS, PASSIVE_MODE_TOOLS, executeTool } from './tools';

const DEFAULT_SYSTEM_PROMPT =
`You are Qogito, an agentic coding assistant embedded in VS Code. You help with understanding and editing code in the current workspace.

Always call tool_list as your very first action before doing anything else. Check the returned list carefully to confirm you have the tools needed to fulfill the request. If your request requires file editing and no file editing tools(write_file, str_replace) are available, state clearly that you cannot proceed rather than attempting a workaround. If the tools needed are not available you can stop processing the request after stating why.`;

export class QogitoViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = 'qogito.view';

	private view?: vscode.WebviewView;
	private showSettings = false;
	readonly api = new LLamaCPPApi();
	private mode: 'passive' | 'active' = 'passive';
	private chatLog: { role: string; content: string }[] = [];
	private apiMessages: ApiMessage[] = [];
	private isGenerating = false;
	private abortController: AbortController | null = null;

	constructor(private readonly context: vscode.ExtensionContext) {}

	resolveWebviewView(webviewView: vscode.WebviewView): void {
		this.view = webviewView;

		webviewView.webview.options = {
			enableScripts: true,
		};

		webviewView.webview.onDidReceiveMessage(async (message) => {
			if (message.command === 'save') {
				const prevAgenticUrl = this.context.globalState.get<string>('qogito.agenticUrl', '');
				await this.context.globalState.update('qogito.agenticUrl', message.agenticUrl);
				await this.context.globalState.update('qogito.completionUrl', message.completionUrl);
				await this.context.globalState.update('qogito.allowRunCommand', message.allowRunCommand);
				await this.context.globalState.update('qogito.allowSelfSigned', message.allowSelfSigned);
				await this.context.globalState.update('qogito.systemPrompt', message.systemPrompt);
				this.api.set_allow_self_signed(message.allowSelfSigned);
				if (message.agenticUrl !== prevAgenticUrl) {
					this.api.disconnect();
					this.clearLog();
					if (message.agenticUrl) {
						await this.tryConnect();
					} else {
						this.render();
					}
				} else {
					vscode.window.showInformationMessage('Settings saved.');
				}
			} else if (message.command === 'retry') {
				await this.tryConnect();
			} else if (message.command === 'setMode') {
				this.mode = message.mode;
				this.render();
			} else if (message.command === 'clearContext') {
				this.clearLog();
			} else if (message.command === 'sendMessage') {
				if (!this.isGenerating) {
					this.handleUserMessage(message.text);
				}
			} else if (message.command === 'stopGeneration') {
				this.abortController?.abort();
			}
		});

		this.render();
	}

	toggleSettings(): void {
		this.showSettings = !this.showSettings;
		this.render();
	}

	async tryConnect(): Promise<void> {
		const url = this.context.globalState.get<string>('qogito.agenticUrl', '');
		if (!url) {
			vscode.window.showWarningMessage('No Agentic URL configured.');
			return;
		}
		this.api.set_allow_self_signed(this.context.globalState.get<boolean>('qogito.allowSelfSigned', false));
		try {
			await this.api.connect(url);
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			vscode.window.showErrorMessage(`Connection failed: ${msg}`);
		}
		this.render();
	}

	addMessage(role: string, content: string): void {
		this.chatLog.push({ role, content });
		this.render();
	}

	updateLastMessage(content: string): void {
		if (this.chatLog.length > 0) {
			this.chatLog[this.chatLog.length - 1].content = content;
			this.render();
		}
	}

	clearLog(): void {
		this.chatLog = [];
		this.apiMessages = [];
		this.api.reset_token_count();
		this.render();
	}

	private getSystemMessage(): ApiMessage {
		const prompt = this.context.globalState.get<string>('qogito.systemPrompt', DEFAULT_SYSTEM_PROMPT);
		return { role: 'system', content: prompt };
	}

	private async handleUserMessage(text: string): Promise<void> {
		if (this.apiMessages.length === 0 || this.apiMessages[0].role !== 'system') {
			this.apiMessages.unshift(this.getSystemMessage());
		} else {
			this.apiMessages[0] = this.getSystemMessage();
		}
		this.chatLog.push({ role: 'user', content: text });
		this.apiMessages.push({ role: 'user', content: text });
		this.isGenerating = true;
		this.render();

		const allowRunCommand = this.context.globalState.get<boolean>('qogito.allowRunCommand', true);
		const activeTools = allowRunCommand
			? ACTIVE_MODE_TOOLS
			: ACTIVE_MODE_TOOLS.filter(t => t.function.name !== 'run_command');
		const tools = this.mode === 'active' ? activeTools : PASSIVE_MODE_TOOLS;
		const allowedTools = new Set(tools.map(t => t.function.name));
		const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
		this.abortController = new AbortController();
		const { signal } = this.abortController;

		try {
			while (true) {
				// Compact before calling complete() if context is already near full
				const nCtxMid = this.api.get_n_ctx();
				if (!signal.aborted && nCtxMid > 0 && this.api.get_last_total_tokens() >= nCtxMid * 0.95) {
					await this.compactContext(signal);
					break;
				}

				this.chatLog.push({ role: 'assistant', content: '' });
				this.render();

				let accumulated = '';
				const outcome = await this.api.complete(
					this.apiMessages,
					tools,
					(chunk) => {
						accumulated += chunk;
						this.chatLog[this.chatLog.length - 1].content = accumulated;
						this.view?.webview.postMessage({ command: 'appendChunk', text: chunk });
					},
					signal
				);

				if (outcome.kind === 'done') {
					this.apiMessages.push({ role: 'assistant', content: accumulated });
					break;
				}

				// outcome.kind === 'tool_calls'
				if (!accumulated) {
					this.chatLog.pop();  // drop the empty assistant entry
				}

				this.apiMessages.push({
					role: 'assistant',
					content: accumulated || null,
					tool_calls: outcome.calls.map(c => ({
						id: c.id,
						type: 'function' as const,
						function: { name: c.name, arguments: c.arguments },
					})),
				});

				for (const call of outcome.calls) {
					this.chatLog.push({ role: 'tool_call', content: `${call.name}(${call.arguments})` });
					this.render();

					let result: string;
					try {
						if (!allowedTools.has(call.name)) {
							throw new Error(`Tool "${call.name}" is not permitted in ${this.mode} mode`);
						}
						if (call.name === 'tool_list') {
							result = tools.map(t => t.function.name).join('\n');
						} else if (!workspaceRoot) {
							throw new Error('No workspace folder open');
						} else {
							const args = JSON.parse(call.arguments) as Record<string, string>;
							if (call.name === 'run_command') {
								const choice = await vscode.window.showWarningMessage(
									`Allow command to run?\n\n$ ${args.command}`,
									{ modal: true },
									'Run'
								);
								result = choice === 'Run'
									? await executeTool(call.name, args, workspaceRoot)
									: 'Command denied by user.';
							} else {
								result = await executeTool(call.name, args, workspaceRoot);
							}
						}
					} catch (e) {
						result = `Error: ${e instanceof Error ? e.message : String(e)}`;
					}

					this.chatLog.push({ role: 'tool', content: result });
					this.render();

					this.apiMessages.push({ role: 'tool', tool_call_id: call.id, content: result });
				}
			}

			// Auto-compact when context reaches 95%
			const nCtx = this.api.get_n_ctx();
			if (!signal.aborted && nCtx > 0 && this.api.get_last_total_tokens() >= nCtx * 0.95) {
				await this.compactContext(signal);
			}
		} catch (e: unknown) {
			if (!(e instanceof Error && e.name === 'AbortError')) {
				const msg = e instanceof Error ? e.message : String(e);
				this.chatLog[this.chatLog.length - 1].content = `[Error: ${msg}]`;
			}
		} finally {
			this.abortController = null;
			this.isGenerating = false;
			this.render();
		}
	}

	private async compactContext(signal: AbortSignal): Promise<void> {
		const compactMessages: ApiMessage[] = [
			...this.apiMessages,
			{
				role: 'user',
				content: 'The conversation context is almost full. Please write a complete, dense summary of everything discussed — goals, decisions, code written, files changed, and any other context needed to continue seamlessly. Be comprehensive.',
			},
		];

		this.chatLog.push({ role: 'compaction', content: '' });
		this.render();

		let summary = '';
		try {
			await this.api.complete(
				compactMessages,
				[],
				(chunk) => {
					summary += chunk;
					this.chatLog[this.chatLog.length - 1].content = summary;
					this.view?.webview.postMessage({ command: 'appendChunk', text: chunk });
				},
				signal
			);
		} catch {
			this.chatLog[this.chatLog.length - 1].content = '[Compaction failed]';
			this.render();
			return;
		}

		if (!summary) { return; }

		this.chatLog = [{ role: 'compaction', content: summary }];
		this.apiMessages = [{ role: 'system', content: 'Summary of the conversation so far:\n\n' + summary }];
		this.api.reset_token_count();
		this.render();
	}

	private render(): void {
		if (!this.view) {
			return;
		}
		this.view.webview.html = this.showSettings
			? this.getSettingsHtml()
			: this.getDefaultHtml();
	}

	private getDefaultHtml(): string {
		const status = this.api.is_connected()
			? `Connected to ${this.api.get_display_model_name()}`
			: 'Disconnected';

		const roleClassMap: Record<string, string> = {
			user: 'role-user',
			assistant: 'role-assistant',
			tool_call: 'role-tool-call',
			tool: 'role-tool',
			compaction: 'role-compaction',
		};
		const roleLabelMap: Record<string, string> = {
			user: 'user',
			assistant: 'qogito',
			tool_call: 'tool call',
			tool: 'tool result',
			compaction: 'context summary',
		};

		const chatEntries = this.chatLog.map(entry => {
			const escaped = entry.content
				.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
			const roleClass = roleClassMap[entry.role] ?? 'role-assistant';
			const label = roleLabelMap[entry.role] ?? entry.role;
			if (entry.role === 'tool') {
				return `<div class="chat-entry ${roleClass}"><details><summary><strong>${label}</strong></summary><span class="entry-content">${escaped}</span></details></div>`;
			}
			if (entry.role === 'compaction') {
				return `<div class="chat-entry ${roleClass}"><details open><summary><strong>${label}</strong></summary><span class="entry-content">${escaped}</span></details></div>`;
			}
			return `<div class="chat-entry ${roleClass}"><strong>${label}:</strong> <span class="entry-content">${escaped}</span></div>`;
		}).join('\n');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		html, body { height: 100%; margin: 0; padding: 0; }
		body {
			font-family: var(--vscode-font-family);
			color: var(--vscode-foreground);
			display: flex;
			flex-direction: column;
			height: 100%;
			overflow: hidden;
		}
		#status-bar {
			padding: 6px 10px;
			font-size: 12px;
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
		}
		#retry { cursor: pointer; margin-left: 6px; font-size: 14px; }
		#retry:hover { color: var(--vscode-textLink-foreground); }
		#mode-toggle {
			display: flex;
			padding: 6px 10px;
			gap: 4px;
			flex-shrink: 0;
			border-bottom: 1px solid var(--vscode-panel-border);
		}
		#mode-toggle button {
			flex: 1;
			padding: 4px 8px;
			cursor: pointer;
			border: 1px solid var(--vscode-button-border, transparent);
			background: transparent;
			color: var(--vscode-foreground);
			font-size: 12px;
		}
		#mode-toggle button.selected {
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
		}
		#mode-toggle button:hover:not(.selected) {
			background: var(--vscode-button-secondaryHoverBackground);
		}
		#clear-bar {
			padding: 4px 10px 6px;
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
		}
		#btn-clear {
			width: 100%;
			padding: 3px 8px;
			cursor: pointer;
			background: transparent;
			border: 1px solid var(--vscode-panel-border);
			border-radius: 2px;
			color: var(--vscode-descriptionForeground);
			font-size: 11px;
		}
		#btn-clear:hover {
			background: var(--vscode-button-secondaryHoverBackground);
			color: var(--vscode-foreground);
		}
		#token-bar {
			padding: 3px 10px 5px;
			font-size: 11px;
			color: var(--vscode-descriptionForeground);
			border-bottom: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
		}
		#chat-log {
			flex: 1;
			overflow-y: auto;
			padding: 8px 10px;
		}
		.chat-entry {
			margin-bottom: 8px;
			font-size: 13px;
			line-height: 1.4;
			white-space: pre-wrap;
			word-wrap: break-word;
		}
		.role-user strong { color: var(--vscode-textLink-foreground); }
		.role-assistant strong { color: var(--vscode-charts-green); }
		.role-tool-call strong { color: var(--vscode-charts-yellow); }
		.role-tool strong { color: var(--vscode-charts-orange); }
		.role-tool details summary { cursor: pointer; list-style: none; }
		.role-tool details summary::before { content: '▶ '; font-size: 10px; }
		.role-tool details[open] summary::before { content: '▼ '; font-size: 10px; }
		.role-tool details .entry-content { display: block; margin-top: 4px; white-space: pre-wrap; word-wrap: break-word; }
		.role-compaction strong { color: var(--vscode-charts-purple); }
		.role-compaction details summary { cursor: pointer; list-style: none; }
		.role-compaction details summary::before { content: '▶ '; font-size: 10px; }
		.role-compaction details[open] summary::before { content: '▼ '; font-size: 10px; }
		.role-compaction details .entry-content { display: block; margin-top: 4px; white-space: pre-wrap; word-wrap: break-word; }
		#input-area {
			display: flex;
			gap: 4px;
			padding: 6px 10px;
			border-top: 1px solid var(--vscode-panel-border);
			flex-shrink: 0;
		}
		#input-area textarea {
			flex: 1;
			resize: none;
			padding: 4px 6px;
			font-family: var(--vscode-font-family);
			font-size: 13px;
			background: var(--vscode-input-background);
			color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border);
		}
		#input-area button {
			padding: 4px 12px;
			cursor: pointer;
			background: var(--vscode-button-background);
			color: var(--vscode-button-foreground);
			border: none;
			align-self: flex-end;
		}
		#input-area button:hover {
			background: var(--vscode-button-hoverBackground);
		}
	</style>
</head>
<body>
	<div id="status-bar">
		Status: ${status}${this.api.is_connected() ? '' : ` <span id="retry" title="Retry connection">&#x21bb;</span>`}
	</div>
	<div id="mode-toggle">
		<button id="btn-passive" class="${this.mode === 'passive' ? 'selected' : ''}">Passive</button>
		<button id="btn-active" class="${this.mode === 'active' ? 'selected' : ''}">Active</button>
	</div>
	<div id="token-bar">
		${this.api.get_last_total_tokens().toLocaleString()} / ${this.api.get_n_ctx().toLocaleString()} tokens
	</div>
	<div id="clear-bar">
		<button id="btn-clear">Clear context</button>
	</div>
	<div id="chat-log">${chatEntries}</div>
	<div id="input-area">
		<textarea id="prompt" rows="2" placeholder="Type a message..."${this.isGenerating ? ' disabled' : ''}></textarea>
		<button id="action-btn">${this.isGenerating ? 'Stop' : 'Send'}</button>
	</div>
	<script>
		const vscode = acquireVsCodeApi();

		${this.api.is_connected() ? '' : `document.getElementById('retry').addEventListener('click', () => {
			vscode.postMessage({ command: 'retry' });
		});`}

		document.getElementById('btn-passive').addEventListener('click', () => {
			vscode.postMessage({ command: 'setMode', mode: 'passive' });
		});
		document.getElementById('btn-active').addEventListener('click', () => {
			vscode.postMessage({ command: 'setMode', mode: 'active' });
		});
		document.getElementById('btn-clear').addEventListener('click', () => {
			vscode.postMessage({ command: 'clearContext' });
		});

		function sendMessage() {
			const textarea = document.getElementById('prompt');
			const text = textarea.value.trim();
			if (!text) return;
			vscode.postMessage({ command: 'sendMessage', text });
			textarea.value = '';
		}

		document.getElementById('action-btn').addEventListener('click', () => {
			${this.isGenerating
				? `vscode.postMessage({ command: 'stopGeneration' });`
				: `sendMessage();`}
		});
		document.getElementById('prompt').addEventListener('keydown', (e) => {
			if (e.key === 'Enter' && !e.shiftKey) {
				e.preventDefault();
				sendMessage();
			}
		});

		const chatLog = document.getElementById('chat-log');
		chatLog.scrollTop = chatLog.scrollHeight;

		window.addEventListener('message', (event) => {
			const msg = event.data;
			if (msg.command === 'appendChunk') {
				const entries = chatLog.querySelectorAll('.entry-content');
				const last = entries[entries.length - 1];
				if (last) {
					last.textContent += msg.text;
					chatLog.scrollTop = chatLog.scrollHeight;
				}
			}
		});
	</script>
</body>
</html>`;
	}

	private getSettingsHtml(): string {
		const agenticUrl = this.context.globalState.get<string>('qogito.agenticUrl', '');
		const completionUrl = this.context.globalState.get<string>('qogito.completionUrl', '');
		const allowRunCommand = this.context.globalState.get<boolean>('qogito.allowRunCommand', true);
		const allowSelfSigned = this.context.globalState.get<boolean>('qogito.allowSelfSigned', false);
		const systemPrompt = this.context.globalState.get<string>('qogito.systemPrompt', DEFAULT_SYSTEM_PROMPT);
		const escapedPrompt = systemPrompt.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

		return `<!DOCTYPE html>
<html lang="en">
<head>
	<meta charset="UTF-8">
	<meta name="viewport" content="width=device-width, initial-scale=1.0">
	<style>
		body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); padding: 10px; }
		label { display: block; margin-top: 8px; font-size: 12px; }
		input[type="url"] { width: 100%; box-sizing: border-box; padding: 4px; margin-top: 2px;
			background: var(--vscode-input-background); color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border); }
		.checkbox-row { display: flex; align-items: center; gap: 6px; margin-top: 12px; }
		.checkbox-row label { margin-top: 0; }
		button { margin-top: 12px; padding: 4px 12px; cursor: pointer;
			background: var(--vscode-button-background); color: var(--vscode-button-foreground);
			border: none; }
		button:hover { background: var(--vscode-button-hoverBackground); }
		details { margin-top: 16px; }
		details summary { cursor: pointer; font-size: 12px; color: var(--vscode-descriptionForeground); user-select: none; }
		details summary:hover { color: var(--vscode-foreground); }
		.prompt-header { display: flex; align-items: center; justify-content: space-between; margin-top: 10px; }
		.prompt-header label { margin-top: 0; }
		.btn-secondary { margin-top: 0; padding: 2px 8px; font-size: 11px;
			background: transparent; color: var(--vscode-descriptionForeground);
			border: 1px solid var(--vscode-panel-border); }
		.btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); color: var(--vscode-foreground); }
		textarea { width: 100%; box-sizing: border-box; padding: 4px; margin-top: 4px;
			font-family: var(--vscode-editor-font-family, monospace); font-size: 11px;
			background: var(--vscode-input-background); color: var(--vscode-input-foreground);
			border: 1px solid var(--vscode-input-border); resize: vertical; }
	</style>
</head>
<body>
	<h3>Settings</h3>
	<label for="agenticUrl">Agentic URL</label>
	<input id="agenticUrl" type="url" value="${agenticUrl}" />
	<label for="completionUrl">Completion URL</label>
	<input id="completionUrl" type="url" value="${completionUrl}" />
	<div class="checkbox-row">
		<input type="checkbox" id="allowRunCommand" ${allowRunCommand ? 'checked' : ''} />
		<label for="allowRunCommand">Allow run_command in Active mode</label>
	</div>
	<div class="checkbox-row">
		<input type="checkbox" id="allowSelfSigned" ${allowSelfSigned ? 'checked' : ''} />
		<label for="allowSelfSigned">Allow self-signed certificates</label>
	</div>
	<details>
		<summary>Advanced</summary>
		<div class="prompt-header">
			<label for="systemPrompt">System prompt</label>
			<button class="btn-secondary" id="resetPrompt" type="button">Reset to default</button>
		</div>
		<textarea id="systemPrompt" rows="14">${escapedPrompt}</textarea>
	</details>
	<button id="save">Save</button>
	<script>
		const vscode = acquireVsCodeApi();
		const DEFAULT_SYSTEM_PROMPT = ${JSON.stringify(DEFAULT_SYSTEM_PROMPT)};
		document.getElementById('resetPrompt').addEventListener('click', () => {
			document.getElementById('systemPrompt').value = DEFAULT_SYSTEM_PROMPT;
		});
		document.getElementById('save').addEventListener('click', () => {
			vscode.postMessage({
				command: 'save',
				agenticUrl: document.getElementById('agenticUrl').value,
				completionUrl: document.getElementById('completionUrl').value,
				allowRunCommand: document.getElementById('allowRunCommand').checked,
				allowSelfSigned: document.getElementById('allowSelfSigned').checked,
				systemPrompt: document.getElementById('systemPrompt').value
			});
		});
	</script>
</body>
</html>`;
	}
}
