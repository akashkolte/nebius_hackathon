// Harness health: whether each harness can take work right now. Checks never send a model prompt.
import { spawn, spawnSync } from 'node:child_process';
import { NebiusError, type NebiusClient } from './nebius.ts';
import { harnesses, type Harness } from './models.ts';

export type HealthState = 'ready' | 'needs_auth' | 'offline' | 'unknown' | 'checking';
export type HarnessHealth = { installed: boolean; state: HealthState; detail: string; checkedAt: string | null };

function run(command: string, args: string[], timeoutMs = 8000): Promise<{ ok: boolean; output: string }> {
  return new Promise(resolve => {
    let output = '';
    let settled = false;
    const finish = (result: { ok: boolean; output: string }) => { if (!settled) { settled = true; clearTimeout(timer); resolve(result); } };
    const child = spawn(command, args, { env: { ...process.env, NO_COLOR: '1', CI: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish({ ok: false, output: 'The CLI did not respond in time.' }); }, timeoutMs);
    for (const stream of [child.stdout, child.stderr]) stream.on('data', chunk => { output = (output + chunk.toString()).slice(-4000); });
    child.on('error', error => finish({ ok: false, output: error.message }));
    child.on('close', code => finish({ ok: code === 0, output: output.trim() }));
  });
}

const result = (installed: boolean, state: HealthState, detail: string): HarnessHealth => ({ installed, state, detail, checkedAt: new Date().toISOString() });

export function commandExists(name: string): boolean {
  return spawnSync('which', [name], { encoding: 'utf8', timeout: 2000 }).status === 0;
}

async function probeCli(name: Exclude<Harness, 'nebius'>): Promise<HarnessHealth> {
  if (!commandExists(name)) return result(false, 'offline', 'CLI is not installed');
  const version = await run(name, ['--version'], 12000);
  if (!version.ok) return result(true, 'offline', version.output || 'CLI did not respond');
  if (name === 'codex') {
    const auth = await run(name, ['login', 'status']);
    return auth.ok && /logged in/i.test(auth.output) ? result(true, 'ready', 'CLI responds; Codex login is active') : result(true, 'needs_auth', 'Sign in with codex login');
  }
  if (name === 'claude') {
    if (process.env.ANTHROPIC_API_KEY) return result(true, 'ready', 'CLI responds; an Anthropic API key is configured');
    const auth = await run(name, ['auth', 'status']);
    let loggedIn = false;
    try { loggedIn = JSON.parse(auth.output).loggedIn === true; } catch { loggedIn = /logged in/i.test(auth.output) && !/not logged in/i.test(auth.output); }
    return auth.ok && loggedIn ? result(true, 'ready', 'CLI responds; Claude login is active') : result(true, 'needs_auth', 'Sign in to Claude Code on this machine');
  }
  if (name === 'gemini') {
    return process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY ? result(true, 'ready', 'CLI responds; Gemini API key is configured') : result(true, 'unknown', 'CLI responds; sign-in could not be checked');
  }
  return result(true, 'unknown', 'CLI responds; provider login could not be checked');
}

export class HealthMonitor {
  client: NebiusClient;
  snapshot: Record<Harness, HarnessHealth>;
  nebiusModels: string[] = [];
  checkedAt = 0;
  pending: Promise<Record<Harness, HarnessHealth>> | null = null;
  onModels: (models: string[]) => void;

  probeClis: boolean;

  constructor(client: NebiusClient, options: { probeClis?: boolean; onModels?: (models: string[]) => void } = {}) {
    this.client = client;
    this.probeClis = options.probeClis ?? true;
    this.onModels = options.onModels || (() => {});
    this.snapshot = Object.fromEntries(harnesses.map(name => [name, { installed: name === 'nebius', state: 'checking', detail: 'Checking', checkedAt: null }])) as Record<Harness, HarnessHealth>;
  }

  async probeNebius(): Promise<HarnessHealth> {
    if (!this.client.configured) return result(true, 'needs_auth', 'Set NEBIUS_API_KEY (or NEBIUS_TEMP_API_KEY) and restart');
    try {
      const models = await this.client.listModels(AbortSignal.timeout(15000));
      this.nebiusModels = models;
      this.onModels(models);
      return result(true, 'ready', `Connected to Nebius Token Factory; ${models.length} models served`);
    } catch (error) {
      const status = error instanceof NebiusError ? error.status : 0;
      return result(true, status === 401 || status === 403 ? 'needs_auth' : 'offline', (error as Error).message.slice(0, 300));
    }
  }

  async refresh(force = false): Promise<Record<Harness, HarnessHealth>> {
    if (this.pending) return this.pending;
    if (!force && Date.now() - this.checkedAt < 60000) return this.snapshot;
    this.pending = Promise.all(harnesses.map(async name => [name, name === 'nebius' ? await this.probeNebius() : this.probeClis ? await probeCli(name) : result(false, 'offline', 'Desktop CLIs are turned off (SHED_CLI=0)')] as const))
      .then(rows => {
        this.snapshot = Object.fromEntries(rows) as Record<Harness, HarnessHealth>;
        this.checkedAt = Date.now();
        return this.snapshot;
      }).finally(() => { this.pending = null; });
    return this.pending;
  }

  ready(): Harness[] { return harnesses.filter(name => this.snapshot[name]?.state === 'ready'); }
}
