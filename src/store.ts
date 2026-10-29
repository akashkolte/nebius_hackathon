// JSON-file persistence for settings, tasks and the built-in agent's sessions.
// Writes go to a temp file first and are renamed, so a crash never leaves half a file.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ChatMessage } from './nebius.ts';
import type { Harness, ModelConfig } from './models.ts';
import type { DisplayMessage } from './sessions.ts';

export type Device = { id: string; keyHash: string; name: string; createdAt: string; lastSeenAt: string };
export type Settings = {
  passwordHash?: string;
  devices?: Device[];
  modelRouting?: Partial<Record<Harness, ModelConfig>>;
  routerModel?: string;
};
export type TaskStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled';
export type TaskEvent = { at: string; kind: 'step' | 'assistant' | 'tool' | 'tool-error' | 'approval' | 'info'; text: string };
export type Task = {
  id: string;
  prompt: string;
  title: string;
  status: TaskStatus;
  harness: Harness;
  sessionId: string | null;
  handoffFrom: string | null;
  cwd: string;
  model: string | null;
  modelReason: string;
  modelSource: string;
  modelFallbackReason: string;
  routeReason: string;
  routeSource: string;
  routeFallbackReason: string;
  skipPermissions: boolean;
  output: string;
  error: string;
  events: TaskEvent[];
  approval: { summary: string; detail: string; requestedAt: string } | null;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  createdAt: string;
  updatedAt: string;
};
export type AgentSession = {
  id: string;
  title: string;
  cwd: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  lastPrompt: string;
  messages: ChatMessage[];
  transcript: DisplayMessage[];
};

function readJson<T>(file: string, fallback: T): T {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) as T; } catch { return fallback; }
}

function writeJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(value, null, 1), { mode: 0o600 });
  fs.renameSync(temp, file);
}

export class Store {
  dir: string;
  settings: Settings;
  tasks: Task[];
  sessions: Map<string, AgentSession>;
  saveTimer: NodeJS.Timeout | null = null;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(path.join(dir, 'agent-sessions'), { recursive: true, mode: 0o700 });
    this.settings = readJson<Settings>(path.join(dir, 'settings.json'), {});
    this.tasks = readJson<Task[]>(path.join(dir, 'tasks.json'), []);
    // A task that was running when the server stopped cannot be resumed; mark it so the UI is honest.
    for (const task of this.tasks) {
      if (task.status === 'running' || task.status === 'waiting') Object.assign(task, { status: 'failed', approval: null, error: `${task.error}\nDispatch restarted while this task was running.`.trim() });
    }
    this.sessions = new Map();
    for (const name of fs.readdirSync(path.join(dir, 'agent-sessions'))) {
      if (!name.endsWith('.json')) continue;
      const session = readJson<AgentSession | null>(path.join(dir, 'agent-sessions', name), null);
      if (session?.id) this.sessions.set(session.id, session);
    }
  }

  saveSettings() { writeJson(path.join(this.dir, 'settings.json'), this.settings); }

  // Running tasks update many times a second; coalesce those writes.
  saveTasks(immediate = false) {
    const write = () => { this.saveTimer = null; writeJson(path.join(this.dir, 'tasks.json'), this.tasks.slice(0, 300)); };
    if (immediate) { if (this.saveTimer) clearTimeout(this.saveTimer); write(); return; }
    if (!this.saveTimer) this.saveTimer = setTimeout(write, 250);
  }

  saveSession(session: AgentSession) {
    this.sessions.set(session.id, session);
    writeJson(path.join(this.dir, 'agent-sessions', `${session.id}.json`), session);
  }

  flush() { if (this.saveTimer) this.saveTasks(true); }
}
