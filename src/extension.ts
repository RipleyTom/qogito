import * as vscode from 'vscode';
import { QogitoViewProvider } from './QogitoViewProvider';
import { registerEditorTools } from './editor_tools';
import { registerCompletionTool } from './completion_tool';

export function activate(context: vscode.ExtensionContext) {
	const provider = new QogitoViewProvider(context);

	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(QogitoViewProvider.viewType, provider)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('qogito.openSettings', () => {
			provider.toggleSettings();
		})
	);

	registerEditorTools(context, provider.api);
	registerCompletionTool(context, provider.api);

	if (context.globalState.get<string>('qogito.agenticUrl', '')) {
		provider.tryConnect();
	}
}

export function deactivate() { }
