import { ChatMessage, ContentPart, LLMError, LLMProvider, ToolCall } from '../llm/types';
import { toToolSchemas } from '../tools';
import { Tool, ToolContext, ToolError, ToolImage, ToolKind, truncateMiddle } from '../tools/types';
import { PermissionDecision, PermissionPolicy, PermissionRequest } from './permissions';

export interface ToolStartEvent {
  id: string;
  name: string;
  label: string;
  kind: ToolKind;
  summary: string;
  input: unknown;
}

export interface ToolEndEvent {
  id: string;
  output: string;
  isError: boolean;
  denied?: boolean;
  images?: ToolImage[];
}

export interface AgentEvents {
  /** A new model response is starting (once per loop iteration). */
  onTurnStart?(): void;
  onText(delta: string): void;
  onToolStart(event: ToolStartEvent): void;
  onToolProgress?(id: string, message: string): void;
  onToolEnd(event: ToolEndEvent): void;
  onRetry?(attempt: number, delayMs: number, error: Error): void;
}

export interface AgentOptions {
  provider: () => LLMProvider;
  /** Read on every run so settings that enable or disable tool groups apply to the next message. */
  tools: () => Tool[];
  systemPrompt: () => string | Promise<string>;
  toolContext: () => Omit<ToolContext, 'signal' | 'readFiles' | 'progress'>;
  permissions: PermissionPolicy;
  requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>;
  maxIterations: () => number;
  contextCharBudget: () => number;
  /** Whether screenshots returned by tools are sent to the model as images. */
  vision?: () => boolean;
}

export type RunOutcome = 'completed' | 'cancelled' | 'max_iterations';

interface ToolOutcome {
  text: string;
  images: ToolImage[];
}

const MAX_RETRIES = 3;
const MAX_RETRY_DELAY_MS = 60_000;
/** Screenshots are expensive context; only the most recent ones stay in the conversation. */
const MAX_IMAGES_IN_HISTORY = 3;
const IMAGE_CHAR_COST = 1500;

/** The model ↔ tool loop for one chat. Keeps the conversation history between runs. */
export class Agent {
  private history: ChatMessage[] = [];
  private readFiles = new Set<string>();

  constructor(private readonly options: AgentOptions) {}

  get messages(): readonly ChatMessage[] {
    return this.history;
  }

  reset(): void {
    this.history = [];
    this.readFiles = new Set();
    this.options.permissions.reset();
  }

  /** Continues a saved chat. Files must be read again before they can be edited. */
  load(history: ChatMessage[]): void {
    this.reset();
    this.history = history.slice();
  }

  /** `images` are data URLs the user attached (pasted screenshots, mockups…). */
  async run(userText: string, events: AgentEvents, signal: AbortSignal, images: string[] = []): Promise<RunOutcome> {
    this.history.push({ role: 'user', content: userText });
    // A separate message, like tool screenshots, so the text message still starts the exchange for compaction.
    if (images.length) {
      this.history.push({
        role: 'user',
        content: [
          { type: 'text', text: `[${images.length} image(s) attached by the user]` },
          ...images.map((url): ContentPart => ({ type: 'image_url', image_url: { url } })),
        ],
      });
    }
    const tools = this.options.tools();
    const toolsByName = new Map(tools.map((t) => [t.name, t]));
    const schemas = toToolSchemas(tools);
    const maxIterations = this.options.maxIterations();

    for (let iteration = 0; iteration < maxIterations; iteration++) {
      if (signal.aborted) return 'cancelled';
      pruneImages(this.history, MAX_IMAGES_IN_HISTORY);
      compactHistory(this.history, this.options.contextCharBudget());

      const system: ChatMessage = { role: 'system', content: await this.options.systemPrompt() };
      events.onTurnStart?.();
      let streamed = '';
      let result;
      try {
        result = await this.completeWithRetry([system, ...this.history], schemas, signal, events, (delta) => {
          streamed += delta;
          events.onText(delta);
        });
      } catch (err) {
        if (signal.aborted) {
          if (streamed) this.history.push({ role: 'assistant', content: `${streamed}\n\n[interrupted by the user]` });
          return 'cancelled';
        }
        throw err;
      }

      const toolCalls = result.toolCalls;
      if (!toolCalls.length) {
        if (result.content) this.history.push({ role: 'assistant', content: result.content });
        return 'completed';
      }
      this.history.push({ role: 'assistant', content: result.content || null, tool_calls: toolCalls });

      // Every tool call needs a matching tool message, even after a cancel, or the next request is rejected.
      const outcomes = await this.runToolCalls(toolCalls, toolsByName, events, signal);
      const images: Array<{ call: ToolCall; image: ToolImage }> = [];
      toolCalls.forEach((call, i) => {
        this.history.push({ role: 'tool', tool_call_id: call.id, content: outcomes[i].text });
        for (const image of outcomes[i].images) images.push({ call, image });
      });

      // Tool messages can only carry text, so screenshots follow as a user message.
      if (images.length && (this.options.vision?.() ?? true)) {
        const parts: ContentPart[] = [{ type: 'text', text: `[Screenshots returned by ${[...new Set(images.map((i) => i.call.function.name))].join(', ')}]` }];
        for (const { image } of images) {
          parts.push({ type: 'image_url', image_url: { url: `data:${image.mime};base64,${image.data}` } });
        }
        this.history.push({ role: 'user', content: parts });
      }
    }
    return 'max_iterations';
  }

  /** Runs tool calls in order; consecutive read-only calls run concurrently. */
  private async runToolCalls(
    calls: ToolCall[],
    toolsByName: Map<string, Tool>,
    events: AgentEvents,
    signal: AbortSignal,
  ): Promise<ToolOutcome[]> {
    const outcomes: ToolOutcome[] = [];
    let i = 0;
    while (i < calls.length) {
      if (signal.aborted) {
        outcomes.push({ text: 'Cancelled by the user before this tool ran.', images: [] });
        i++;
        continue;
      }
      let end = i + 1;
      if (toolsByName.get(calls[i].function.name)?.kind === 'read') {
        while (end < calls.length && toolsByName.get(calls[end].function.name)?.kind === 'read') end++;
      }
      const group = calls.slice(i, end);
      outcomes.push(...(await Promise.all(group.map((call) => this.runTool(call, toolsByName, events, signal)))));
      i = end;
    }
    return outcomes;
  }

  private async completeWithRetry(
    messages: ChatMessage[],
    tools: ReturnType<typeof toToolSchemas>,
    signal: AbortSignal,
    events: AgentEvents,
    onText: (delta: string) => void,
  ) {
    for (let attempt = 0; ; attempt++) {
      let streamedAny = false;
      try {
        return await this.options.provider().complete({
          messages,
          tools,
          signal,
          onText: (delta) => {
            streamedAny = true;
            onText(delta);
          },
        });
      } catch (err) {
        const retryable = err instanceof LLMError && err.retryable && !streamedAny && !signal.aborted;
        if (!retryable || attempt >= MAX_RETRIES) throw err;
        // Free tiers say how long to wait; honour that instead of retrying too early. A wait of
        // minutes or hours means a used-up quota, which retrying in-run cannot fix.
        const asked = (err as LLMError).retryAfterMs ?? 0;
        if (asked > MAX_RETRY_DELAY_MS) throw err;
        const delayMs = Math.max(1000 * 2 ** attempt, asked);
        events.onRetry?.(attempt + 1, delayMs, err as Error);
        await sleep(delayMs, signal);
      }
    }
  }

  private async runTool(
    call: ToolCall,
    toolsByName: Map<string, Tool>,
    events: AgentEvents,
    signal: AbortSignal,
  ): Promise<ToolOutcome> {
    const tool = toolsByName.get(call.function.name);
    let input: any = {};
    let parseError: string | undefined;
    try {
      input = call.function.arguments.trim() ? JSON.parse(call.function.arguments) : {};
    } catch (err) {
      parseError = `Invalid JSON in tool arguments: ${(err as Error).message}`;
    }

    let summary = '';
    try {
      summary = tool && !parseError ? tool.summarize(input) : '';
    } catch {
      // summaries are cosmetic
    }
    events.onToolStart({
      id: call.id,
      name: call.function.name,
      label: tool?.label ?? call.function.name,
      kind: tool?.kind ?? 'read',
      summary,
      input: parseError ? call.function.arguments : input,
    });

    const finish = (output: string, isError: boolean, denied = false, images: ToolImage[] = []): ToolOutcome => {
      const text = truncateMiddle(output);
      events.onToolEnd({ id: call.id, output: text, isError, denied, images: images.length ? images : undefined });
      return { text, images };
    };

    if (!tool) {
      const names = [...toolsByName.keys()].join(', ');
      return finish(`Error: unknown tool "${call.function.name}". Available tools: ${names}.`, true);
    }
    if (parseError) return finish(`Error: ${parseError}`, true);

    const { needsApproval, dangerous } = this.options.permissions.check(tool, input);
    if (needsApproval) {
      const request: PermissionRequest = { tool, input, summary, dangerous };
      const decision = await this.options.requestPermission(request);
      this.options.permissions.remember(request, decision);
      if (decision === 'deny') {
        return finish(
          'The user denied this action. Do not retry it. Choose a different approach or ask the user how to proceed.',
          true,
          true,
        );
      }
    }

    try {
      const result = await tool.execute(input, {
        ...this.options.toolContext(),
        signal,
        readFiles: this.readFiles,
        progress: (message) => events.onToolProgress?.(call.id, message),
      });
      if (typeof result === 'string') return finish(result, false);
      return finish(result.text, false, false, result.images ?? []);
    } catch (err) {
      const message = err instanceof ToolError ? err.message : `${(err as Error)?.message ?? String(err)}`;
      return finish(`Error: ${message}`, true);
    }
  }
}

function contentSize(content: ChatMessage['content']): number {
  if (content == null) return 0;
  if (typeof content === 'string') return content.length;
  return content.reduce((n, part) => n + (part.type === 'text' ? part.text.length : IMAGE_CHAR_COST), 0);
}

function messageSize(m: ChatMessage): number {
  const toolCalls = m.role === 'assistant' && m.tool_calls ? JSON.stringify(m.tool_calls).length : 0;
  return contentSize(m.content) + toolCalls;
}

/** Replaces all but the newest `keep` images with a short placeholder. */
export function pruneImages(history: ChatMessage[], keep: number): void {
  let seen = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const m = history[i];
    if (m.role !== 'user' || typeof m.content === 'string') continue;
    m.content = m.content.map((part) => {
      if (part.type !== 'image_url') return part;
      seen++;
      return seen > keep ? { type: 'text', text: '[older screenshot removed to save context]' } : part;
    });
  }
}

/**
 * Keeps the conversation under a character budget: first trims old tool output,
 * then drops the oldest complete exchanges (never splitting a tool call from its result).
 */
export function compactHistory(history: ChatMessage[], budget: number): void {
  let total = history.reduce((n, m) => n + messageSize(m), 0);
  if (total <= budget) return;

  const keepRecent = 6;
  for (let i = 0; i < history.length - keepRecent && total > budget; i++) {
    const m = history[i];
    if (m.role === 'tool' && m.content.length > 400) {
      const trimmed = `${m.content.slice(0, 200)}\n[older tool output trimmed to save context]`;
      total -= m.content.length - trimmed.length;
      m.content = trimmed;
    }
  }

  // Only a plain-text user message starts an exchange; image messages belong to the tool calls before them.
  while (total > budget) {
    const nextUser = history.findIndex((m, i) => i > 0 && m.role === 'user' && typeof m.content === 'string');
    if (nextUser <= 0) break;
    for (const removed of history.splice(0, nextUser)) total -= messageSize(removed);
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('Cancelled'));
      },
      { once: true },
    );
  });
}
