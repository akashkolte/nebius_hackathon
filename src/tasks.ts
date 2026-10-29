// Task orchestration: route a request (Nebius router agent), pick a model, then run it on the
// built-in Nebius agent or a headless desktop CLI, streaming progress to the browser.
import { EventEmitter } from 'node:events';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Config } from './config.ts';
import type { NebiusClient } from './nebius.ts';
import { Brain, decideFollowup, type ModelDecision, type RouteDecision } from './brain.ts';
import { harnessLabels, isHarness, modelConfig, nebiusRoster, pickRouterModel, reconcileRoster, type Harness, type ModelConfig } from './models.ts';
import { desktopMessages, discoverDesktopSessions, type DisplayMessage, type Session } from './sessions.ts';
import type { HealthMonitor } from './health.ts';
import type { AgentSession, Store, Task, TaskEvent } from './store.ts';
import { runAgent, systemPrompt } from './agent/loop.ts';
import type { ApprovalRequest } from './agent/tools.ts';

export type TaskInput = {
  prompt: string;
  harness?: string;
  model?: string;
  sessionId?: string | null;
  followup?: string;
  cwd?: string;
  newWorkspace?: string;
  newSession?: boolean;
  skipPermissions?: boolean;
};
export type Plan = { route: RouteDecision; model: ModelDecision; cwd: string; agentPrompt: string };

type Running = { abort: AbortController; child?: ChildProcess; resolveApproval?: (allowed: boolean) => void };

const FILLER = new Set('a an the to for my me of and in on with please can you i it this that is are be some our we us hey hi could would should let lets make build create write'.split(' '));
const titleFor = (prompt: string) => prompt.replace(/\s+/g, ' ').trim().slice(0, 90);
const now = () => new Date().toISOString();
const httpError = (message: string, status = 400) => Object.assign(new Error(message), { status });

export class TaskManager extends EventEmitter {
  config: Config;
  store: Store;
  client: NebiusClient;
  health: HealthMonitor;
  brain: Brain;
  running = new Map<string, Running>();
  desktopCache = { at: 0, sessions: [] as Session[] };

  constructor(deps: { config: Config; store: Store; client: NebiusClient; health: HealthMonitor }) {
    super();
    this.config = deps.config;
    this.store = deps.store;
    this.client = deps.client;
    this.health = deps.health;
    this.brain = new Brain(this.client, () => this.routerModel());
    fs.mkdirSync(this.config.workspaceRoot, { recursive: true });
  }

  // ---- Models -------------------------------------------------------------------------------

  modelConfig(harness: Harness): ModelConfig {
    const base = modelConfig(harness, this.store.settings.modelRouting);
    if (harness !== 'nebius') return base;
    const withDefault = this.config.nebius.defaultAgentModel && !base.models.some(m => m.id === this.config.nebius.defaultAgentModel)
      ? { ...base, models: [{ id: this.config.nebius.defaultAgentModel, label: this.config.nebius.defaultAgentModel.split('/').pop()!, description: 'Configured with NEBIUS_AGENT_MODEL.', enabled: true }, ...base.models] }
      : base;
    return reconcileRoster(withDefault, this.health.nebiusModels);
  }

  routerModel(): string {
    return this.store.settings.routerModel || pickRouterModel(this.config.nebius.routerModel, this.health.nebiusModels, nebiusRoster);
  }

  // ---- Sessions -----------------------------------------------------------------------------

  agentSessionRecord(s: AgentSession): Session {
    return { id: `nebius:${s.id}`, nativeId: s.id, harness: 'nebius', title: s.title, lastPrompt: s.lastPrompt, cwd: s.cwd, currentModel: s.model, updatedAt: s.updatedAt, file: null, source: 'dispatch', liveState: 'history' };
  }

  sessions(force = false): Session[] {
    if (force || Date.now() - this.desktopCache.at > 5000) this.desktopCache = { at: Date.now(), sessions: discoverDesktopSessions(this.config.homeDir) };
    const activeBySession = new Map<string, Task>();
    for (const task of this.store.tasks) if (task.sessionId && (task.status === 'running' || task.status === 'waiting') && !activeBySession.has(task.sessionId)) activeBySession.set(task.sessionId, task);
    return [...this.desktopCache.sessions, ...[...this.store.sessions.values()].map(s => this.agentSessionRecord(s))]
      .map(session => {
        const task = activeBySession.get(session.id);
        return task ? { ...session, liveState: task.status === 'waiting' ? 'waiting' as const : 'working' as const } : session;
      })
      .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  }

  findSession(id: string): Session | undefined { return this.sessions().find(s => s.id === id); }

  messages(session: Session): DisplayMessage[] {
    if (session.harness === 'nebius') return (this.store.sessions.get(session.nativeId)?.transcript || []).slice(-120);
    return desktopMessages(session);
  }

  // Folders a request may target: known session projects, workspaces Dispatch created, and DISPATCH_PROJECTS.
  projects(): string[] {
    const fromEnv = String(process.env.DISPATCH_PROJECTS || '').split(':').filter(Boolean).map(p => path.resolve(p));
    let workspaces: string[] = [];
    try { workspaces = fs.readdirSync(this.config.workspaceRoot, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => path.join(this.config.workspaceRoot, e.name)); } catch {}
    const all = [...fromEnv, ...this.sessions().map(s => s.cwd), ...workspaces].filter(p => p && fs.existsSync(p) && fs.statSync(p).isDirectory());
    return [...new Set(all)];
  }

  autoWorkspace(prompt: string, preview: boolean): string {
    const words = prompt.toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/).filter(w => w && !FILLER.has(w));
    const slug = words.slice(0, 4).join('-').replace(/-+/g, '-').slice(0, 40).replace(/^-|-$/g, '') || 'session';
    let name = slug;
    for (let n = 2; fs.existsSync(path.join(this.config.workspaceRoot, name)); n++) name = `${slug}-${n}`;
    const folder = path.join(this.config.workspaceRoot, name);
    if (!preview) fs.mkdirSync(folder, { recursive: true });
    return folder;
  }

  // ---- Planning -----------------------------------------------------------------------------

  async plan(input: TaskInput, preview = false): Promise<Plan> {
    const prompt = String(input.prompt || '').trim();
    if (!prompt) throw httpError('Write a message first.');
    if (prompt.length > 50_000) throw httpError('That message is too long.');
    const health = this.health.checkedAt ? this.health.snapshot : await this.health.refresh();
    this.health.refresh().catch(() => {});
    const ready = this.health.ready();
    const requestedHarness = input.harness && input.harness !== 'auto' ? input.harness : 'auto';
    if (requestedHarness !== 'auto' && !isHarness(requestedHarness)) throw httpError('Unknown harness.');
    const harness = requestedHarness as Harness | 'auto';
    if (harness !== 'auto' && !ready.includes(harness) && health[harness]?.state !== 'unknown') throw httpError(health[harness]?.detail || `${harness} is not ready.`);

    const all = this.sessions();
    let cwd = '';
    if (input.cwd) {
      const requested = path.resolve(input.cwd);
      if (!this.projects().includes(requested)) throw httpError('That project folder is not one Dispatch knows about.');
      cwd = requested;
    }
    if (input.newWorkspace) {
      const name = String(input.newWorkspace).trim();
      if (!/^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,59}$/.test(name) || name === '.' || name === '..') throw httpError('Workspace names must be 1–60 letters, numbers, spaces, dots, dashes, or underscores.');
      cwd = path.join(this.config.workspaceRoot, name);
      if (!preview) fs.mkdirSync(cwd, { recursive: true });
    }

    let route: RouteDecision;
    let agentPrompt = prompt;
    if (input.sessionId) {
      const origin = all.find(s => s.id === input.sessionId);
      if (!origin) throw httpError('That session is no longer available.', 404);
      try {
        route = decideFollowup(origin, {
          mode: input.followup || 'auto',
          availableHarnesses: ready,
          currentReady: ready.includes(origin.harness) || health[origin.harness]?.state === 'unknown',
          currentDetail: health[origin.harness]?.detail,
        });
      } catch (error) { throw httpError((error as Error).message); }
      if (route.handoff) agentPrompt = this.handoffPrompt(origin, prompt);
      cwd = origin.cwd;
    } else {
      const autoHarnesses = ready.length ? ready : ['nebius' as Harness];
      const candidates = input.newSession ? [] : all.filter(s => s.liveState === 'history' && (!cwd || s.cwd === cwd) && (harness === 'auto' ? ready.includes(s.harness) : s.harness === harness));
      route = await this.brain.decideRoute(prompt, candidates, harness, null, { preview, availableHarnesses: autoHarnesses });
      if (route.session) cwd = route.session.cwd;
      else if (!cwd) cwd = this.autoWorkspace(prompt, preview);
    }

    const target = route.session?.harness || route.harness;
    const model = await this.brain.decideModel(prompt, target, this.modelConfig(target), {
      override: input.model || '',
      session: route.session,
      preview,
    });
    return { route, model, cwd, agentPrompt };
  }

  // ---- Running ------------------------------------------------------------------------------

  async start(input: TaskInput): Promise<Task> {
    const plan = await this.plan(input);
    const { route, model, cwd } = plan;
    const harness = route.session?.harness || route.harness;
    if (route.session && route.session.liveState !== 'history') throw httpError('That session is still working. Send the follow-up when it finishes, or stop it first.', 409);
    if (!cwd || !fs.existsSync(cwd)) throw httpError(route.session ? 'This session\'s project folder no longer exists, so it cannot be continued safely.' : 'The project folder does not exist.');
    const task: Task = {
      id: crypto.randomUUID(), prompt: input.prompt.trim(), title: titleFor(input.prompt), status: 'running', harness,
      sessionId: route.session?.id || null, handoffFrom: route.handoffFrom || null, cwd,
      model: model.model, modelReason: model.reason, modelSource: model.source, modelFallbackReason: model.fallbackReason || '',
      routeReason: route.reason, routeSource: route.source, routeFallbackReason: route.fallbackReason || '',
      skipPermissions: Boolean(input.skipPermissions), output: '', error: '', events: [], approval: null, createdAt: now(), updatedAt: now(),
    };
    this.store.tasks.unshift(task);
    this.addEvent(task, 'info', `${route.reason}${route.fallbackReason ? ` (${route.fallbackReason})` : ''}. Model: ${model.model || 'harness default'} — ${model.reason}.`);
    const running: Running = { abort: new AbortController() };
    this.running.set(task.id, running);
    const work = harness === 'nebius' ? this.runNebius(task, plan, running) : this.runCli(task, plan, running);
    work.catch(error => this.finish(task, running.abort.signal.aborted ? 'cancelled' : 'failed', running.abort.signal.aborted ? '' : (error as Error).message));
    return task;
  }

  addEvent(task: Task, kind: TaskEvent['kind'], text: string) {
    task.events.push({ at: now(), kind, text: text.slice(0, 4000) });
    if (task.events.length > 300) task.events.splice(0, task.events.length - 300);
    this.touch(task);
  }

  touch(task: Task) {
    task.updatedAt = now();
    this.store.saveTasks();
    this.emit('task', task);
  }

  finish(task: Task, status: Task['status'], error = '') {
    if (['completed', 'failed', 'cancelled'].includes(task.status)) return;
    Object.assign(task, { status, approval: null, error: [task.error, error].filter(Boolean).join('\n').slice(-12000) });
    this.running.delete(task.id);
    this.touch(task);
    this.store.saveTasks(true);
    this.desktopCache.at = 0;
  }

  approval(task: Task, running: Running, request: ApprovalRequest): Promise<boolean> {
    if (task.skipPermissions) return Promise.resolve(true);
    return new Promise(resolve => {
      const signal = running.abort.signal;
      const done = (allowed: boolean) => {
        signal.removeEventListener('abort', onAbort);
        running.resolveApproval = undefined;
        if (task.status === 'waiting') Object.assign(task, { status: 'running', approval: null });
        this.addEvent(task, 'approval', `${allowed ? 'Approved' : 'Declined'}: ${request.summary}`);
        resolve(allowed);
      };
      const onAbort = () => done(false);
      signal.addEventListener('abort', onAbort, { once: true });
      running.resolveApproval = done;
      Object.assign(task, { status: 'waiting', approval: { summary: request.summary, detail: request.detail.slice(0, 4000), requestedAt: now() } });
      this.touch(task);
    });
  }

  respond(taskId: string, allowed: boolean) {
    const running = this.running.get(taskId);
    if (!running?.resolveApproval) throw httpError('This task is not waiting for approval.', 409);
    running.resolveApproval(allowed);
  }

  cancel(taskId: string) {
    const task = this.store.tasks.find(t => t.id === taskId);
    const running = this.running.get(taskId);
    if (!task || !running) throw httpError('This task is not running.', 409);
    running.abort.abort(new Error('Cancelled'));
    try { if (running.child?.pid) process.kill(-running.child.pid, 'SIGTERM'); } catch {}
    this.finish(task, 'cancelled');
  }

  async runNebius(task: Task, plan: Plan, running: Running) {
    const existing = plan.route.session ? this.store.sessions.get(plan.route.session.nativeId) : undefined;
    const session: AgentSession = existing || { id: crypto.randomUUID(), title: titleFor(task.prompt), cwd: task.cwd, model: '', createdAt: now(), updatedAt: now(), lastPrompt: '', messages: [], transcript: [] };
    const modelId = task.model || this.modelConfig('nebius').models.find(m => m.enabled)?.id;
    if (!modelId) throw new Error('No Nebius model is enabled. Turn one on in Settings → Models.');
    task.model = modelId;
    task.sessionId = `nebius:${session.id}`;
    Object.assign(session, { model: modelId, lastPrompt: task.prompt.slice(0, 260), updatedAt: now() });
    session.transcript.push({ role: 'user', text: task.prompt, at: now() });
    this.store.saveSession(session);
    this.touch(task);

    const history = session.messages;
    try {
      const result = await runAgent({
        client: this.client, model: modelId, cwd: task.cwd, history, prompt: plan.agentPrompt, signal: running.abort.signal,
        approve: request => this.approval(task, running, request),
        onEvent: event => {
          if (event.type === 'step') this.addEvent(task, 'step', `Step ${event.step} · ${event.model.split('/').pop()}`);
          if (event.type === 'tool') {
            this.addEvent(task, event.isError ? 'tool-error' : 'tool', event.summary);
            session.transcript.push({ role: 'tool', text: event.summary, at: now() });
          }
          if (event.type === 'assistant') {
            this.addEvent(task, 'assistant', event.text);
            task.output = event.text.slice(-120000);
          }
        },
      });
      session.messages = result.messages;
      session.transcript.push({ role: 'assistant', text: result.finalText, at: now() });
      task.usage = result.usage;
      task.output = result.finalText;
      this.finish(task, 'completed');
    } catch (error) {
      const cancelled = running.abort.signal.aborted;
      const note = cancelled ? 'The user cancelled this turn.' : `This turn failed: ${(error as Error).message}`;
      // Keep the request in context so a follow-up knows files may have changed.
      session.messages = [...(history.length ? history : [{ role: 'system' as const, content: systemPrompt(task.cwd) }]), { role: 'user', content: plan.agentPrompt }, { role: 'assistant', content: `(${note})` }];
      session.transcript.push({ role: 'assistant', text: `_${note}_`, at: now() });
      this.finish(task, cancelled ? 'cancelled' : 'failed', cancelled ? '' : (error as Error).message);
    } finally {
      session.transcript = session.transcript.slice(-400);
      session.updatedAt = now();
      this.store.saveSession(session);
      this.emit('sessions');
    }
  }

  async runCli(task: Task, plan: Plan, running: Running) {
    const { route } = plan;
    const harness = task.harness;
    const prompt = plan.agentPrompt;
    const resume = route.session?.nativeId;
    const modelArgs = task.model ? ['--model', task.model] : [];
    let args: string[];
    let stdin = '';
    if (harness === 'codex') {
      const skip = task.skipPermissions ? ['--dangerously-bypass-approvals-and-sandbox'] : [];
      args = resume ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...skip, ...modelArgs, resume, '-'] : ['exec', '--json', '--skip-git-repo-check', ...skip, ...modelArgs, '-C', task.cwd, '-'];
      stdin = prompt;
    } else if (harness === 'claude') {
      args = ['-p', prompt, '--output-format', 'stream-json', '--verbose', ...modelArgs, ...(task.skipPermissions ? ['--dangerously-skip-permissions'] : []), ...(resume ? ['--resume', resume] : [])];
    } else if (harness === 'gemini') {
      args = ['-p', prompt, '-o', 'stream-json', ...modelArgs, ...(task.skipPermissions ? ['--yolo'] : []), ...(resume ? ['--resume', resume] : [])];
    } else {
      args = ['run', '--format', 'json', ...modelArgs, ...(resume ? ['--session', resume] : []), prompt];
    }
    if (!task.skipPermissions) this.addEvent(task, 'info', `${harnessLabels[harness]} runs headless here, so it cannot ask before editing or running commands. Tick “Skip permissions” to let it change files.`);
    const child = spawn(harness, args, { cwd: task.cwd, detached: true, env: { ...process.env, NO_COLOR: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
    running.child = child;
    child.stdin.end(stdin);
    let pending = '';
    const accept = (line: string) => {
      let item: any;
      try { item = JSON.parse(line); } catch { if (line.trim()) task.output += `${line}\n`; return; }
      const id = item.type === 'thread.started' ? item.thread_id : item.session_id || item.sessionID;
      if (id && !task.sessionId) task.sessionId = `${harness}:${id}`;
      const message = item.type === 'item.completed' && item.item?.type === 'agent_message' ? item.item.text
        : item.type === 'assistant' ? item.message?.content?.filter?.((p: any) => p.type === 'text').map((p: any) => p.text).join('\n')
        : item.type === 'message' && (item.role === 'assistant' || item.message?.role === 'assistant') ? (item.content || item.message?.content)
        : item.type === 'result' ? (item.result || item.content)
        : item.type === 'text' ? item.part?.text : null;
      if (message) {
        const text = typeof message === 'string' ? message : JSON.stringify(message);
        if (item.type !== 'result' || !task.output.includes(text)) { task.output = `${task.output}${text}\n\n`.slice(-120000); this.addEvent(task, 'assistant', text); }
      }
      if (item.type === 'error') task.error += `${item.message || JSON.stringify(item)}\n`;
    };
    child.stdout.on('data', chunk => {
      pending += chunk.toString();
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      lines.forEach(accept);
      this.touch(task);
    });
    child.stderr.on('data', chunk => { task.error = (task.error + chunk.toString()).slice(-12000); this.touch(task); });
    await new Promise<void>(resolve => {
      child.on('error', error => { this.finish(task, 'failed', error.message); resolve(); });
      child.on('close', code => {
        if (pending.trim()) accept(pending);
        this.finish(task, running.abort.signal.aborted ? 'cancelled' : code === 0 ? 'completed' : 'failed', code === 0 ? '' : `Exited with code ${code}.`);
        resolve();
      });
    });
  }

  // ---- Handoff ------------------------------------------------------------------------------

  handoffPrompt(session: Session, prompt: string): string {
    const lines: string[] = [];
    let budget = 12000;
    for (const message of this.messages(session).filter(m => m.role !== 'tool').slice(-16).reverse()) {
      const text = message.text.slice(0, 2000);
      if (budget - text.length < 0) break;
      budget -= text.length;
      lines.unshift(`[${message.role === 'user' ? 'user' : session.harness}] ${text}`);
    }
    const changes = uncommittedChanges(session.cwd);
    return [
      `You are continuing work that began in a ${harnessLabels[session.harness]} session${session.currentModel ? ` using ${session.currentModel}` : ''} in this project.`,
      `Session topic: ${session.title}`,
      lines.length ? `Recent conversation:\n${lines.join('\n\n')}` : 'The earlier transcript is unavailable.',
      session.file ? `The complete earlier transcript (JSON Lines) is at:\n${session.file}\nRead it if you need details that are not above.` : '',
      changes ? `Uncommitted changes in the project right now:\n${changes}` : '',
      `New request:\n${prompt.trim()}`,
    ].filter(Boolean).join('\n\n');
  }
}

// A short `git status` plus diff summary, so a handoff (and the Changes tab) shows uncommitted work.
export function uncommittedChanges(cwd: string): string {
  if (!cwd || !fs.existsSync(path.join(cwd, '.git'))) return '';
  const git = (args: string[]) => spawnSync('git', args, { cwd, encoding: 'utf8', timeout: 4000, maxBuffer: 1024 * 1024 }).stdout || '';
  const status = git(['status', '--short']).trim();
  if (!status) return '';
  const stat = git(['diff', '--stat', 'HEAD']).trim().split('\n').slice(-25).join('\n');
  return [status.split('\n').slice(0, 40).join('\n'), stat].filter(Boolean).join('\n\n').slice(0, 3000);
}
