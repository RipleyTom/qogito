import * as vscode from 'vscode';
import { LLamaCPPApi } from './llamacpp_api';

const PREFIX_MAX_CHARS = 4000;
const SUFFIX_MAX_CHARS = 1000;

export function registerCompletionTool(context: vscode.ExtensionContext, api: LLamaCPPApi): void {
	context.subscriptions.push(
		vscode.commands.registerCommand('qogito.triggerCompletion', () => {
			vscode.commands.executeCommand('editor.action.inlineSuggest.trigger');
		})
	);

	context.subscriptions.push(
		vscode.languages.registerInlineCompletionItemProvider(
			{ pattern: '**' },
			{
				async provideInlineCompletionItems(
					document: vscode.TextDocument,
					position: vscode.Position,
					triggerContext: vscode.InlineCompletionContext,
					token: vscode.CancellationToken
				): Promise<vscode.InlineCompletionItem[]> {
					const completionUrl = context.globalState.get<string>('qogito.completionUrl', '');
					if (!completionUrl) {
						return [];
					}

					// For automatic triggers, only fire when there is meaningful context
					// on the current line to avoid spamming the model on empty lines.
					if (triggerContext.triggerKind === vscode.InlineCompletionTriggerKind.Automatic) {
						const linePrefix = document.lineAt(position).text.slice(0, position.character);
						if (linePrefix.trim().length < 3) {
							return [];
						}
					}

					const docText = document.getText();
					const offset = document.offsetAt(position);
					const prefix = docText.slice(Math.max(0, offset - PREFIX_MAX_CHARS), offset);
					const suffix = docText.slice(offset, Math.min(docText.length, offset + SUFFIX_MAX_CHARS));

					const abort = new AbortController();
					token.onCancellationRequested(() => abort.abort());

					try {
						const completion = await api.infill(completionUrl, prefix, suffix, abort.signal);
						if (!completion) {
							return [];
						}
						return [new vscode.InlineCompletionItem(
							completion,
							new vscode.Range(position, position)
						)];
					} catch {
						return [];
					}
				},
			}
		)
	);
}
