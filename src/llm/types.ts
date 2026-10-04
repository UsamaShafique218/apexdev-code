export interface ToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
  /** Provider-specific data that must be sent back unchanged (e.g. Gemini's thought_signature). */
  extra_content?: unknown;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'auto' | 'low' | 'high' } };

export type ChatMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | ContentPart[] }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface ToolSchema {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface CompletionRequest {
  messages: ChatMessage[];
  tools: ToolSchema[];
  signal?: AbortSignal;
  /** Called for every streamed chunk of assistant text. */
  onText?: (delta: string) => void;
}

export interface CompletionResult {
  content: string;
  toolCalls: ToolCall[];
  finishReason: string | null;
}

export interface LLMProvider {
  complete(request: CompletionRequest): Promise<CompletionResult>;
}

export class LLMError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    /** True for rate limits, 5xx and network failures — worth retrying. */
    readonly retryable = false,
    /** How long the server asked us to wait before retrying (rate limits), if it said. */
    readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'LLMError';
  }
}
