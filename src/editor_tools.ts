import * as vscode from 'vscode';
import { LLamaCPPApi } from './llamacpp_api';

export function registerEditorTools(context: vscode.ExtensionContext, api: LLamaCPPApi): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('qogito.transformSelection', async () => {
			const editor = vscode.window.activeTextEditor;
			if (!editor) { return; }

			const selection = editor.selection;
			if (selection.isEmpty) {
				vscode.window.showWarningMessage('Qogito: no text selected.');
				return;
			}

			if (!api.is_connected()) {
				vscode.window.showErrorMessage('Qogito: not connected to any model.');
				return;
			}

			const instruction = await vscode.window.showInputBox({
				prompt: 'Transform selection: what should be done?',
				placeHolder: 'e.g. add JSDoc comments, convert to TypeScript, fix spelling...',
			});
			if (!instruction) { return; }

			const selectedText = editor.document.getText(selection);

			await vscode.window.withProgress(
				{ location: vscode.ProgressLocation.Notification, title: 'Qogito: transforming...', cancellable: false },
				async () => {
					let result = '';
					try {
						await api.complete(
							[
								{
									role: 'system',
									content: 'You are a code editor assistant. Transform the provided text according to the instruction. Respond with ONLY the transformed text — no explanations, no markdown code fences, no commentary.',
								},
								{
									role: 'user',
									content: `Text:\n${selectedText}\n\nInstruction: ${instruction}`,
								},
							],
							[],
							(chunk) => { result += chunk; }
						);

						await editor.edit(editBuilder => {
							editBuilder.replace(selection, result);
						});
					} catch (e) {
						const msg = e instanceof Error ? e.message : String(e);
						vscode.window.showErrorMessage(`Qogito transform failed: ${msg}`);
					}
				}
			);
		})
	);
}
