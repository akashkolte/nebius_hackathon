import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Config } from './config.ts';
import { NebiusClient, stripThinking } from './nebius.ts';
import { HealthMonitor } from './health.ts';
import { Store, type Task } from './store.ts';
import { Auth, isLocalRequest } from './auth.ts';
import { TaskManager, uncommittedChanges } from './tasks.ts';
import { harnesses, harnessLabels, isHarness, validateModelConfig } from './models.ts';
import { publicSession } from './sessions.ts';
import type { Plan } from './tasks.ts';

const SECURITY_HEADERS = {
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.webmanifest': 'application/manifest+json', '.json': 'application/json' };

type HttpError = Error & { status?: number };

export const taskSummary = (t: Task) => ({ id: t.id, title: t.title, status: t.status, harness: t.harness, sessionId: t.sessionId, cwd: t.cwd, model: t.model, routeSource: t.routeSource, modelSource: t.modelSource, approval: t.approval, handoffFrom: t.handoffFrom, createdAt: t.createdAt, updatedAt: t.updatedAt, error: t.error.slice(0, 300), lastEvent: t.events.at(-1)?.text.slice(0, 200) || '' });

function planSummary(plan: Plan) {
  return {
    harness: plan.route.session?.harness || plan.route.harness,
    sessionId: plan.route.session?.id || null,
    sessionTitle: plan.route.session?.title || '',
    handoff: Boolean(plan.route.handoff),
    reason: plan.route.reason,
    source: plan.route.source,
    fallbackReason: plan.route.fallbackReason || '',
    cwd: plan.cwd,
    model: plan.model.model,
    modelReason: plan.model.reason,
    modelSource: plan.model.source,
  };
}

export function createApp(config: Config, options: { fetchImpl?: typeof fetch; initialPassword?: string } = {}) {
  const store = new Store(config.dataDir);
  const client = new NebiusClient({ baseUrl: config.nebius.baseUrl, apiKey: config.nebius.apiKey, fetchImpl: options.fetchImpl });
  const health = new HealthMonitor(client, { probeClis: config.cliHarnesses });
  const manager = new TaskManager({ config, store, client, health });
  const auth = new Auth(store, options.initialPassword ?? process.env.DISPATCH_PASSWORD ?? '');
  const eventClients = new Set<http.ServerResponse>();

  const broadcast = (event: string, data: unknown) => {
    const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const res of eventClients) res.write(payload);
  };
  manager.on('task', (task: Task) => broadcast('task', taskSummary(task)));
  manager.on('sessions', () => broadcast('sessions', {}));
  const keepAlive = setInterval(() => { for (const res of eventClients) res.write(': ping\n\n'); }, 25000);
  keepAlive.unref();

  const send = (res: http.ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}) => {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(JSON.stringify(value));
  };

  async function body(req: http.IncomingMessage): Promise<any> {
    if (!String(req.headers['content-type'] || '').includes('application/json')) throw Object.assign(new Error('Send JSON.'), { status: 415 });
    let size = 0;
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1024 * 1024) throw Object.assign(new Error('Request is too large.'), { status: 413 });
      chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw Object.assign(new Error('Invalid JSON.'), { status: 400 }); }
  }

  // Cross-site form posts must not drive the agents; browsers always send Origin on such requests.
  function sameOrigin(req: http.IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    try { return new URL(origin).host === (req.headers['x-forwarded-host'] || req.headers.host); } catch { return false; }
  }

  function serveStatic(res: http.ServerResponse, pathname: string) {
    const name = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(config.publicDir, name);
    if (!file.startsWith(config.publicDir + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache', ...SECURITY_HEADERS });
    fs.createReadStream(file).pipe(res);
  }

  async function handle(req: http.IncomingMessage, res: http.ServerResponse) {
    const url = new URL(req.url || '/', 'http://localhost');
    const { pathname } = url;
    const method = req.method || 'GET';
    if (!pathname.startsWith('/api/')) return serveStatic(res, pathname);
    if (method !== 'GET' && !sameOrigin(req)) return send(res, 403, { error: 'Cross-origin request refused.' });

    if (pathname === '/api/auth/status' && method === 'GET') return send(res, 200, { configured: auth.configured, canSetup: !auth.configured && isLocalRequest(req), signedIn: Boolean(auth.device(req)) });
    if (pathname === '/api/password/setup' && method === 'POST') { const { cookie } = auth.setup(req, (await body(req)).password); return send(res, 200, { ok: true }, { 'set-cookie': cookie }); }
    if (pathname === '/api/auth' && method === 'POST') { const { cookie } = auth.login(req, (await body(req)).password); return send(res, 200, { ok: true }, { 'set-cookie': cookie }); }
    if (pathname === '/api/logout' && method === 'POST') return send(res, 200, { ok: true }, { 'set-cookie': auth.logout(req) });
    if (!auth.device(req)) return send(res, 401, { error: 'Sign in first.' });

    if (pathname === '/api/me' && method === 'GET') {
      return send(res, 200, { hostname: os.hostname(), routerModel: manager.routerModel(), nebiusBaseUrl: config.nebius.baseUrl, workspaceRoot: config.workspaceRoot, harnesses: health.snapshot, labels: harnessLabels, projects: manager.projects(), demo: { enabled: config.demo.enabled, maxTasksPerHour: config.demo.maxTasksPerHour } });
    }
    if (pathname === '/api/harness-health' && method === 'GET') return send(res, 200, { harnesses: await health.refresh(url.searchParams.get('force') === '1') });
    if (pathname === '/api/projects' && method === 'GET') return send(res, 200, { projects: manager.projects() });
    if (pathname === '/api/sessions' && method === 'GET') return send(res, 200, { sessions: manager.sessions().slice(0, 300).map(publicSession) });

    const sessionMatch = pathname.match(/^\/api\/sessions\/([^/]+)(\/changes)?$/);
    if (sessionMatch && method === 'GET') {
      const session = manager.findSession(decodeURIComponent(sessionMatch[1]));
      if (!session) return send(res, 404, { error: 'Session not found.' });
      if (sessionMatch[2]) return send(res, 200, { changes: uncommittedChanges(session.cwd) });
      const tasks = store.tasks.filter(t => t.sessionId === session.id).slice(0, 20).map(taskSummary);
      return send(res, 200, { session: publicSession(session), messages: manager.messages(session), tasks });
    }

    if (pathname === '/api/route' && method === 'POST') return send(res, 200, { route: planSummary(await manager.plan(await body(req), true)) });
    if (pathname === '/api/tasks' && method === 'GET') return send(res, 200, { tasks: store.tasks.slice(0, 60).map(taskSummary) });
    if (pathname === '/api/tasks' && method === 'POST') return send(res, 200, { task: await manager.start(await body(req)) });
    const taskMatch = pathname.match(/^\/api\/tasks\/([0-9a-f-]{36})(?:\/(cancel|approve))?$/);
    if (taskMatch) {
      const task = store.tasks.find(t => t.id === taskMatch[1]);
      if (!task) return send(res, 404, { error: 'Task not found.' });
      if (!taskMatch[2] && method === 'GET') return send(res, 200, { task });
      if (taskMatch[2] === 'cancel' && method === 'POST') { manager.cancel(task.id); return send(res, 200, { ok: true }); }
      if (taskMatch[2] === 'approve' && method === 'POST') { manager.respond(task.id, (await body(req)).allow === true); return send(res, 200, { ok: true }); }
    }

    if (pathname === '/api/models' && method === 'GET') {
      return send(res, 200, { configs: Object.fromEntries(harnesses.map(h => [h, manager.modelConfig(h)])), routerModel: manager.routerModel(), served: health.nebiusModels });
    }
    if (pathname === '/api/models' && method === 'POST') {
      const input = await body(req);
      const harness: unknown = input.harness;
      if (!isHarness(harness)) return send(res, 400, { error: 'Unknown harness.' });
      (store.settings.modelRouting ||= {})[harness] = validateModelConfig(input);
      store.saveSettings();
      return send(res, 200, { config: manager.modelConfig(harness) });
    }
    if (pathname === '/api/router-model' && method === 'POST') {
      const model = String((await body(req)).model || '').trim();
      if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(model)) return send(res, 400, { error: 'Invalid model ID.' });
      store.settings.routerModel = model || undefined;
      store.saveSettings();
      return send(res, 200, { routerModel: manager.routerModel() });
    }
    if (pathname === '/api/nebius/test' && method === 'POST') {
      const started = Date.now();
      const model = manager.routerModel();
      const result = await client.chat({ model, maxTokens: 20, temperature: 0, messages: [{ role: 'user', content: 'Reply with the single word: ready' }] });
      health.refresh(true).catch(() => {});
      return send(res, 200, { ok: true, model: result.model, reply: stripThinking(result.message.content).slice(0, 80), latencyMs: Date.now() - started });
    }

    if (pathname === '/api/events' && method === 'GET') {
      // Tunnels and reverse proxies may buffer or compress a stream; these headers and the padding ask them not to.
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', 'x-accel-buffering': 'no', connection: 'keep-alive', ...SECURITY_HEADERS });
      res.flushHeaders();
      res.write(`retry: 3000\n: ${' '.repeat(2048)}\n\n`);
      eventClients.add(res);
      req.on('close', () => eventClients.delete(res));
      return;
    }
    return send(res, 404, { error: 'Not found.' });
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((error: HttpError) => {
      const status = error.status || 500;
      if (status >= 500) console.error(error);
      if (!res.headersSent) send(res, status, { error: error.message || 'Something went wrong.' });
      else res.end();
    });
  });
  server.on('close', () => { clearInterval(keepAlive); store.flush(); for (const res of eventClients) res.end(); });
  return { server, store, manager, health, auth };
}
