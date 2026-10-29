// A stand-in for Nebius Token Factory's OpenAI-compatible API, scripted per test.
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export type MockRequest = { model: string; messages: any[]; tools?: any[] };
export type MockReply = { content?: string | null; tool_calls?: { name: string; arguments: Record<string, unknown> }[] } | { status: number; body: unknown };
export type Handler = (request: MockRequest, index: number) => MockReply;

export const isRouterCall = (request: MockRequest) => /routing brain/.test(request.messages[0]?.content || '');

export async function startMockNebius(options: { models?: string[]; router?: Handler; agent?: Handler }) {
  const requests: MockRequest[] = [];
  let agentCalls = 0;
  let routerCalls = 0;
  const server = http.createServer(async (req, res) => {
    const json = (status: number, value: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== 'Bearer test-key') return json(401, { detail: 'Invalid API key' });
    if (req.url === '/v1/models') return json(200, { object: 'list', data: (options.models || []).map(id => ({ id, object: 'model' })) });
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') return json(404, { detail: 'not found' });
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const request = JSON.parse(Buffer.concat(chunks).toString()) as MockRequest;
    requests.push(request);
    const router = isRouterCall(request);
    const handler = router ? options.router : options.agent;
    const reply: MockReply = handler ? handler(request, router ? routerCalls++ : agentCalls++) : { content: 'ok' };
    if ('status' in reply) return json(reply.status, reply.body);
    json(200, {
      id: 'chatcmpl-test', object: 'chat.completion', model: request.model,
      choices: [{ index: 0, finish_reason: reply.tool_calls ? 'tool_calls' : 'stop', message: {
        role: 'assistant', content: reply.content ?? null,
        ...(reply.tool_calls ? { tool_calls: reply.tool_calls.map((c, i) => ({ id: `call_${requests.length}_${i}`, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) } : {}),
      } }],
      usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}/v1`, requests, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
