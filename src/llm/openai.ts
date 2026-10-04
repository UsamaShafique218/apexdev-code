import { CompletionRequest, CompletionResult, LLMError, LLMProvider, ToolCall } from './types';

export interface OpenAIConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
  maxTokens?: number;
  temperature?: number | null;
}

interface StreamDelta {
  content?: string | null;
  tool_calls?: Array<{
    index?: number;
    id?: string;
    function?: { name?: string; arguments?: string };
    extra_content?: unknown;
  }>;
}

interface PartialCall {
  id: string;
  name: string;
  arguments: string;
  extra_content?: unknown;
}

/**
 * Client for any API that implements OpenAI's `/chat/completions` with
 * streaming and tool calling (OpenAI, OpenRouter, Groq, DeepSeek, LM Studio, Ollama…).
 */
export class OpenAICompatibleProvider implements LLMProvider {
  constructor(private readonly config: OpenAIConfig) {}

  async complete(request: CompletionRequest): Promise<CompletionResult> {
    const url = this.config.baseUrl.replace(/\/+$/, '') + '/chat/completions';
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages,
      stream: true,
    };
    if (request.tools.length) {
      body.tools = request.tools;
      body.tool_choice = 'auto';
    }
    if (this.config.maxTokens) body.max_tokens = this.config.maxTokens;
    if (typeof this.config.temperature === 'number') body.temperature = this.config.temperature;

    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.config.apiKey) headers.Authorization = `Bearer ${this.config.apiKey}`;

    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: request.signal,
      });
    } catch (err) {
      if (request.signal?.aborted) throw err;
      throw new LLMError(`Could not reach ${url}: ${errorText(err)}`, undefined, true);
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      const retryable = response.status === 429 || response.status >= 500;
      throw new LLMError(
        `${response.status} ${response.statusText}: ${extractApiError(text) || 'request failed'}`,
        response.status,
        retryable,
        retryable ? retryAfter(response.headers.get('retry-after'), text) : undefined,
      );
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      // Some gateways ignore `stream: true` and answer with a single JSON body.
      return parseFullResponse(await response.json(), request.onText);
    }
    return this.readStream(response, request);
  }

  private async readStream(response: Response, request: CompletionRequest): Promise<CompletionResult> {
    if (!response.body) throw new LLMError('Empty response body from the API');

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const calls: PartialCall[] = [];
    let content = '';
    let finishReason: string | null = null;
    let buffer = '';
    let done = false;

    const handleData = (data: string) => {
      if (data === '[DONE]') {
        done = true;
        return;
      }
      let json: any;
      try {
        json = JSON.parse(data);
      } catch {
        return; // keep-alive or malformed fragment
      }
      if (json.error) throw new LLMError(extractApiError(JSON.stringify(json)) || 'Stream error');

      const choice = json.choices?.[0];
      if (!choice) return;
      const delta: StreamDelta = choice.delta ?? choice.message ?? {};
      if (delta.content) {
        content += delta.content;
        request.onText?.(delta.content);
      }
      for (const part of delta.tool_calls ?? []) {
        let slot: (typeof calls)[number] | undefined;
        if (typeof part.index === 'number') {
          slot = calls[part.index] ??= { id: '', name: '', arguments: '' };
          // Some gateways (e.g. Gemini) send several complete calls that all claim index 0.
          if (part.id && slot.id && part.id !== slot.id) calls.push((slot = { id: '', name: '', arguments: '' }));
        } else if (part.id) {
          slot = calls.find((c) => c.id === part.id);
          if (!slot) calls.push((slot = { id: '', name: '', arguments: '' }));
        } else {
          slot = calls[calls.length - 1];
        }
        if (!slot) continue;
        if (part.id) slot.id = part.id;
        if (part.function?.name) slot.name += part.function.name;
        if (part.function?.arguments) slot.arguments += part.function.arguments;
        if (part.extra_content) slot.extra_content = part.extra_content;
      }
      if (choice.finish_reason) finishReason = choice.finish_reason;
    };

    while (!done) {
      const { value, done: streamDone } = await reader.read();
      if (streamDone) break;
      buffer += decoder.decode(value, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line.startsWith('data:')) handleData(line.slice(5).trim());
        if (done) break;
      }
    }
    const rest = buffer.trim();
    if (!done && rest.startsWith('data:')) handleData(rest.slice(5).trim());
    reader.cancel().catch(() => undefined);

    return {
      content,
      toolCalls: calls.filter(Boolean).filter((c) => c.name).map(toToolCall),
      finishReason,
    };
  }
}

function parseFullResponse(json: any, onText?: (delta: string) => void): CompletionResult {
  const message = json?.choices?.[0]?.message ?? {};
  const content: string = message.content ?? '';
  if (content) onText?.(content);
  const toolCalls: ToolCall[] = (message.tool_calls ?? []).map((c: any) =>
    toToolCall({
      id: c.id ?? '',
      name: c.function?.name ?? '',
      arguments: c.function?.arguments ?? '',
      extra_content: c.extra_content,
    }),
  );
  return { content, toolCalls, finishReason: json?.choices?.[0]?.finish_reason ?? null };
}

function toToolCall(c: PartialCall): ToolCall {
  const call: ToolCall = {
    id: c.id || `call_${Math.random().toString(36).slice(2, 12)}`,
    type: 'function',
    function: { name: c.name, arguments: c.arguments || '{}' },
  };
  // Gemini rejects the next request unless each call's thought_signature comes back with it.
  if (c.extra_content) call.extra_content = c.extra_content;
  return call;
}

function extractApiError(text: string): string {
  try {
    const json = JSON.parse(text);
    const error = Array.isArray(json) ? json[0]?.error : json.error;
    if (typeof error === 'string') return error;
    if (error?.message) return error.message;
    if (json.message) return json.message;
  } catch {
    // not JSON
  }
  return text.slice(0, 500);
}

/**
 * Wait time from a Retry-After header, Gemini's `retryDelay: "37s"`, or "try again in 7.5s" /
 * "Please retry in 16h9m58.2s" in the error text.
 */
export function retryAfter(header: string | null, body: string): number | undefined {
  const seconds =
    Number(header) ||
    Number(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(body)?.[1]) ||
    duration(/(?:try again|retry) in ((?:\d+(?:\.\d+)?[hms])+)/i.exec(body)?.[1]);
  return seconds > 0 ? Math.ceil(seconds * 1000) : undefined;
}

/** "1h2m3.5s" → 3723.5 */
function duration(text: string | undefined): number {
  let seconds = 0;
  for (const [, n, unit] of (text ?? '').matchAll(/(\d+(?:\.\d+)?)([hms])/g)) {
    seconds += Number(n) * (unit === 'h' ? 3600 : unit === 'm' ? 60 : 1);
  }
  return seconds;
}

function errorText(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as Error & { cause?: unknown }).cause;
    return cause instanceof Error ? `${err.message} (${cause.message})` : err.message;
  }
  return String(err);
}
