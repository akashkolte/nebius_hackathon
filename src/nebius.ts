// Minimal client for Nebius Token Factory, which serves an OpenAI-compatible API.
// Plain fetch keeps the project dependency-free and easy to point at a mock in tests.

export type ToolCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
export type ChatMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: ToolCall[] }
  | { role: 'tool'; content: string; tool_call_id: string };
export type ToolSpec = { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } };
export type Usage = { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
export type ChatRequest = {
  model: string;
  messages: ChatMessage[];
  tools?: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
};
export type ChatResult = { message: Extract<ChatMessage, { role: 'assistant' }>; usage: Usage; model: string; finishReason: string };

export class NebiusError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.status = status;
  }
}

const RETRYABLE = new Set([408, 409, 429, 500, 502, 503, 504]);
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

export class NebiusClient {
  baseUrl: string;
  apiKey: string;
  fetchImpl: typeof fetch;
  timeoutMs: number;
  retries: number;

  constructor(options: { baseUrl: string; apiKey: string; fetchImpl?: typeof fetch; timeoutMs?: number; retries?: number }) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl || fetch;
    this.timeoutMs = options.timeoutMs ?? 180_000;
    this.retries = options.retries ?? 3;
  }

  get configured() { return Boolean(this.apiKey); }

  async request(pathname: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<any> {
    if (!this.apiKey) throw new NebiusError('No Nebius API key. Set NEBIUS_API_KEY or NEBIUS_TEMP_API_KEY.');
    for (let attempt = 0; ; attempt++) {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}${pathname}`, {
          method: init.method || 'GET',
          headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal,
        });
      } catch (error) {
        if (init.signal?.aborted) throw error;
        if (attempt < this.retries) { await sleep(1000 * 2 ** attempt, init.signal); continue; }
        const cause = (error as Error & { cause?: Error }).cause?.message;
        throw new NebiusError(`Could not reach Nebius at ${this.baseUrl}: ${cause || (error as Error).message}`);
      }
      if (response.ok) return response.json();
      const text = (await response.text().catch(() => '')).slice(0, 600);
      if (RETRYABLE.has(response.status) && attempt < this.retries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? Math.min(retryAfter, 30) * 1000 : 1000 * 2 ** attempt, init.signal);
        continue;
      }
      let detail = text;
      try { const parsed = JSON.parse(text); detail = parsed.error?.message || parsed.detail || parsed.message || text; } catch {}
      throw new NebiusError(`Nebius returned ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`, response.status);
    }
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const data = await this.request('/models', { signal });
    return (Array.isArray(data?.data) ? data.data : []).map((m: { id?: string }) => m.id).filter((id: unknown): id is string => typeof id === 'string').sort();
  }

  async chat(request: ChatRequest): Promise<ChatResult> {
    const data = await this.request('/chat/completions', {
      method: 'POST',
      signal: request.signal,
      body: {
        model: request.model,
        messages: request.messages,
        ...(request.tools?.length ? { tools: request.tools, tool_choice: 'auto' } : {}),
        temperature: request.temperature ?? 0.2,
        max_tokens: request.maxTokens ?? 4096,
      },
    });
    const choice = data?.choices?.[0];
    if (!choice?.message) throw new NebiusError('Nebius returned no message.');
    const raw = choice.message;
    let content: string | null = typeof raw.content === 'string' ? raw.content : null;
    let toolCalls: ToolCall[] = Array.isArray(raw.tool_calls) ? raw.tool_calls.filter((c: ToolCall) => c?.function?.name).map((c: ToolCall, i: number) => ({
      id: c.id || `call_${Date.now()}_${i}`,
      type: 'function' as const,
      function: { name: c.function.name, arguments: typeof c.function.arguments === 'string' ? c.function.arguments : JSON.stringify(c.function.arguments || {}) },
    })) : [];
    // Some open models write tool calls as text instead of using the tool_calls field.
    if (!toolCalls.length && content) {
      const parsed = textToolCalls(content);
      if (parsed.calls.length) { toolCalls = parsed.calls; content = parsed.rest || null; }
    }
    return {
      message: { role: 'assistant', content, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) },
      usage: data.usage || {},
      model: data.model || request.model,
      finishReason: choice.finish_reason || '',
    };
  }
}

export function textToolCalls(content: string): { calls: ToolCall[]; rest: string } {
  const calls: ToolCall[] = [];
  const rest = content.replace(/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g, (_, body: string) => {
    const parsed = parseJsonObject(body);
    if (parsed && typeof parsed.name === 'string') {
      calls.push({ id: `call_text_${calls.length}`, type: 'function', function: { name: parsed.name, arguments: JSON.stringify(parsed.arguments ?? parsed.parameters ?? {}) } });
      return '';
    }
    return _;
  }).trim();
  return { calls, rest };
}

// Models often wrap JSON in prose or code fences; take the first balanced object.
export function parseJsonObject(text: string): Record<string, any> | null {
  const source = String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '');
  for (let start = source.indexOf('{'); start !== -1; start = source.indexOf('{', start + 1)) {
    let depth = 0, inString = false, escaped = false;
    for (let i = start; i < source.length; i++) {
      const ch = source[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') inString = true;
      else if (ch === '{') depth++;
      else if (ch === '}' && --depth === 0) {
        try {
          const value = JSON.parse(source.slice(start, i + 1));
          if (value && typeof value === 'object' && !Array.isArray(value)) return value;
        } catch {}
        break;
      }
    }
  }
  return null;
}

export function stripThinking(text: string | null | undefined): string {
  return String(text || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}
