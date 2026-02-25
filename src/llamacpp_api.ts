import { ToolDefinition } from './tools';

export interface ToolCall {
	id: string;
	name: string;
	arguments: string;  // JSON string
}

interface ToolCallRef {
	id: string;
	type: 'function';
	function: { name: string; arguments: string };
}

export type ApiMessage =
	| { role: 'system' | 'user'; content: string }
	| { role: 'assistant'; content: string | null; tool_calls?: ToolCallRef[] }
	| { role: 'tool'; tool_call_id: string; content: string };

export type CompleteOutcome =
	| { kind: 'done' }
	| { kind: 'tool_calls'; calls: ToolCall[] };

export class LLamaCPPApi {
	private baseUrl: string = '';
	private modelName: string = '';
	private displayModelName: string = '';
	private connected: boolean = false;
	private nCtx: number = 0;
	private lastTotalTokens: number = 0;
	private allowSelfSigned: boolean = false;

	is_connected(): boolean {
		return this.connected;
	}

	get_display_model_name(): string {
		return this.displayModelName;
	}

	get_n_ctx(): number {
		return this.nCtx;
	}

	get_last_total_tokens(): number {
		return this.lastTotalTokens;
	}

	reset_token_count(): void {
		this.lastTotalTokens = 0;
	}

	add_estimated_tokens(chars: number): void {
		this.lastTotalTokens += Math.ceil(chars / 4);
	}

	set_allow_self_signed(value: boolean): void {
		this.allowSelfSigned = value;
		if (value) {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		} else {
			delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		}
	}

	disconnect(): void {
		this.baseUrl = '';
		this.modelName = '';
		this.displayModelName = '';
		this.connected = false;
		this.nCtx = 0;
		this.lastTotalTokens = 0;
	}

	async infill(
		completionUrl: string,
		prefix: string,
		suffix: string,
		signal?: AbortSignal
	): Promise<string> {
		const base = completionUrl.replace(/\/+$/, '');
		const response = await fetch(`${base}/infill`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				input_prefix: prefix,
				input_suffix: suffix,
				n_predict: 32,
				stream: false,
				cache_prompt: true,
			}),
			signal,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const json = await response.json() as { content: string };
		return json.content;
	}

	async complete(
		messages: ApiMessage[],
		tools: ToolDefinition[],
		onChunk: (text: string) => void,
		signal?: AbortSignal
	): Promise<CompleteOutcome> {
		if (!this.connected) {
			throw new Error('Not connected');
		}

		const body: Record<string, unknown> = {
			messages,
			stream: true,
			stream_options: { include_usage: true },
		};
		if (tools.length > 0) {
			body.tools = tools;
		}

		const response = await fetch(`${this.baseUrl}/v1/chat/completions`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		if (!response.body) {
			throw new Error('No response body');
		}

		const reader = response.body.getReader();
		const decoder = new TextDecoder();
		let buffer = '';

		type StreamChunk = {
			choices: {
				delta: {
					content?: string;
					tool_calls?: {
						index: number;
						id?: string;
						function?: { name?: string; arguments?: string };
					}[];
				};
				finish_reason: string | null;
			}[];
			usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
		};

		const pendingCalls = new Map<number, { id: string; name: string; arguments: string }>();
		let pendingOutcome: CompleteOutcome | null = null;

		while (true) {
			const { done, value } = await reader.read();
			if (done) { break; }

			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split('\n');
			buffer = lines.pop() ?? '';

			for (const line of lines) {
				if (!line.startsWith('data: ')) { continue; }
				const payload = line.slice(6);
				if (payload === '[DONE]') {
					return pendingOutcome ?? { kind: 'done' };
				}

				const chunk = JSON.parse(payload) as StreamChunk;
				if (chunk.usage) {
					this.lastTotalTokens = chunk.usage.total_tokens;
				}
				const choice = chunk.choices[0];
				if (!choice) { continue; }

				const content = choice.delta.content;
				if (content) {
					this.add_estimated_tokens(content.length);
					onChunk(content);
				}

				for (const tc of choice.delta.tool_calls ?? []) {
					if (!pendingCalls.has(tc.index)) {
						pendingCalls.set(tc.index, { id: '', name: '', arguments: '' });
					}
					const pending = pendingCalls.get(tc.index)!;
					if (tc.id) { pending.id = tc.id; }
					if (tc.function?.name) { pending.name += tc.function.name; }
					if (tc.function?.arguments) { pending.arguments += tc.function.arguments; }
				}

				if (choice.finish_reason === 'stop') {
					pendingOutcome = { kind: 'done' };
				} else if (choice.finish_reason === 'tool_calls') {
					const calls = [...pendingCalls.entries()]
						.sort(([a], [b]) => a - b)
						.map(([, tc]) => tc);
					pendingOutcome = { kind: 'tool_calls', calls };
				}
			}
		}

		return pendingOutcome ?? { kind: 'done' };
	}

	async connect(url: string): Promise<void> {
		if (this.connected || url.length === 0) {
			return;
		}

		this.baseUrl = url.replace(/\/+$/, '');
		this.connected = false;
		this.modelName = '';

		const response = await fetch(`${this.baseUrl}/v1/models`);
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}

		const json = (await response.json()) as { data?: { id: string }[] };
		const firstModel = json.data?.[0];
		if (!firstModel) {
			throw new Error('No models returned');
		}

		this.modelName = firstModel.id;

		let gguf_index = this.modelName.indexOf("-00001-of-");
		if (gguf_index === -1) {
			gguf_index = this.modelName.indexOf(".gguf");
		}

		this.displayModelName = gguf_index === -1 ? this.modelName : this.modelName.substring(0, gguf_index);

		const propsResponse = await fetch(`${this.baseUrl}/props`);
		if (propsResponse.ok) {
			const props = await propsResponse.json() as { default_generation_settings?: { n_ctx?: number } };
			this.nCtx = props.default_generation_settings?.n_ctx ?? 0;
		}

		this.connected = true;
	}
}
