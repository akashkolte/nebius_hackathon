// Tools the built-in Nebius agent can call. File tools are confined to the session's project
// folder (symlinks included). Shell commands need the user's OK unless permissions are skipped.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { ToolSpec } from '../nebius.ts';

export type ApprovalRequest = { tool: string; summary: string; detail: string };
export type ToolContext = { cwd: string; signal: AbortSignal; approve: (request: ApprovalRequest) => Promise<boolean> };
export type ToolResult = { output: string; summary: string; isError?: boolean };

const SKIP_DIRS = new Set(['.git', 'node_modules', '.venv', 'venv', '__pycache__', 'dist', 'build', '.next', '.cache', 'target', '.dispatch-data']);
const MAX_OUTPUT = 20_000;

const fn = (name: string, description: string, properties: Record<string, unknown>, required: string[] = []): ToolSpec =>
  ({ type: 'function', function: { name, description, parameters: { type: 'object', properties, required } } });

export const toolSpecs: ToolSpec[] = [
  fn('list_files', 'List files and folders in the project. Folders end with "/". Skips .git, node_modules and build output.', {
    path: { type: 'string', description: 'Folder relative to the project root. Default ".".' },
    depth: { type: 'integer', description: 'How many levels deep to list, 1-4. Default 2.' },
  }),
  fn('read_file', 'Read a text file with line numbers.', {
    path: { type: 'string', description: 'File path relative to the project root.' },
    start_line: { type: 'integer', description: 'First line to read (1-based). Optional.' },
    end_line: { type: 'integer', description: 'Last line to read. Optional.' },
  }, ['path']),
  fn('write_file', 'Create or overwrite a file with the given content. Creates parent folders.', {
    path: { type: 'string', description: 'File path relative to the project root.' },
    content: { type: 'string', description: 'The complete new file content.' },
  }, ['path', 'content']),
  fn('edit_file', 'Replace an exact snippet in a file. old_string must appear exactly once unless replace_all is true. Include enough surrounding lines to make it unique.', {
    path: { type: 'string', description: 'File path relative to the project root.' },
    old_string: { type: 'string', description: 'Exact text to replace, including whitespace.' },
    new_string: { type: 'string', description: 'Replacement text.' },
    replace_all: { type: 'boolean', description: 'Replace every occurrence. Default false.' },
  }, ['path', 'old_string', 'new_string']),
  fn('search', 'Search file contents with a regular expression (case-insensitive). Returns matching lines as path:line: text.', {
    pattern: { type: 'string', description: 'JavaScript regular expression.' },
    path: { type: 'string', description: 'Folder or file to search, relative to the project root. Default ".".' },
  }, ['pattern']),
  fn('run_command', 'Run a shell command (bash) in the project folder, e.g. tests, builds, git, package installs. Returns exit code and output.', {
    command: { type: 'string', description: 'The command line to run.' },
    timeout_seconds: { type: 'integer', description: 'Time limit, 1-600. Default 120.' },
  }, ['command']),
];

export function resolveInside(cwd: string, target: unknown): string {
  if (typeof target !== 'string' && target !== undefined) throw new Error('path must be a string');
  const root = fs.realpathSync(cwd);
  const full = path.resolve(root, String(target || '.'));
  const inside = (p: string) => { const rel = path.relative(root, p); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };
  if (!inside(full)) throw new Error(`${target} is outside the project folder`);
  // Resolve the deepest existing ancestor so a symlink cannot lead outside the project.
  let existing = full;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  if (!inside(fs.realpathSync(existing))) throw new Error(`${target} leads outside the project folder`);
  return full;
}

const rel = (cwd: string, file: string) => path.relative(fs.realpathSync(cwd), file) || '.';

function clip(text: string, limit = MAX_OUTPUT): string {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n… [${text.length - limit} characters omitted] …\n${text.slice(-half)}`;
}

function listFiles(cwd: string, args: any): ToolResult {
  const start = resolveInside(cwd, args.path);
  const depth = Math.min(4, Math.max(1, Number(args.depth) || 2));
  const lines: string[] = [];
  const visit = (dir: string, level: number) => {
    if (lines.length >= 400) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (error) { lines.push(`(cannot read ${rel(cwd, dir)}: ${(error as Error).message})`); return; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (lines.length >= 400) { lines.push('… more entries omitted'); return; }
      const full = path.join(dir, entry.name);
      const indent = '  '.repeat(level);
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        if (!SKIP_DIRS.has(entry.name) && level + 1 < depth) visit(full, level + 1);
      } else lines.push(`${indent}${entry.name}`);
    }
  };
  if (!fs.existsSync(start)) throw new Error(`${args.path || '.'} does not exist`);
  visit(start, 0);
  return { output: lines.join('\n') || '(empty folder)', summary: `Listed ${rel(cwd, start)}` };
}

function readFile(cwd: string, args: any): ToolResult {
  const file = resolveInside(cwd, args.path);
  const stat = fs.statSync(file);
  if (stat.isDirectory()) throw new Error(`${args.path} is a folder; use list_files`);
  if (stat.size > 4 * 1024 * 1024) throw new Error(`${args.path} is larger than 4 MB`);
  const text = fs.readFileSync(file, 'utf8');
  if (text.includes('\u0000')) throw new Error(`${args.path} looks like a binary file`);
  const all = text.split('\n');
  const from = Math.max(1, Number(args.start_line) || 1);
  const to = Math.min(all.length, Number(args.end_line) || from + 799);
  const body = all.slice(from - 1, to).map((line, i) => `${String(from + i).padStart(5)}  ${line}`).join('\n');
  const more = to < all.length ? `\n… ${all.length - to} more lines (use start_line=${to + 1})` : '';
  return { output: clip(body + more, 60_000), summary: `Read ${rel(cwd, file)}` };
}

function writeFile(cwd: string, args: any): ToolResult {
  if (typeof args.content !== 'string') throw new Error('content must be a string');
  const file = resolveInside(cwd, args.path);
  const existed = fs.existsSync(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, args.content);
  return { output: `${existed ? 'Updated' : 'Created'} ${rel(cwd, file)} (${args.content.split('\n').length} lines)`, summary: `${existed ? 'Wrote' : 'Created'} ${rel(cwd, file)}` };
}

function editFile(cwd: string, args: any): ToolResult {
  if (typeof args.old_string !== 'string' || typeof args.new_string !== 'string') throw new Error('old_string and new_string must be strings');
  if (!args.old_string) throw new Error('old_string must not be empty; use write_file to create files');
  const file = resolveInside(cwd, args.path);
  const text = fs.readFileSync(file, 'utf8');
  const count = text.split(args.old_string).length - 1;
  if (count === 0) throw new Error('old_string was not found; read the file again and copy the text exactly');
  if (count > 1 && !args.replace_all) throw new Error(`old_string appears ${count} times; add surrounding lines to make it unique or set replace_all`);
  const next = args.replace_all ? text.split(args.old_string).join(args.new_string) : text.replace(args.old_string, () => args.new_string);
  fs.writeFileSync(file, next);
  return { output: `Edited ${rel(cwd, file)} (${args.replace_all ? count : 1} replacement${count > 1 && args.replace_all ? 's' : ''})`, summary: `Edited ${rel(cwd, file)}` };
}

function search(cwd: string, args: any): ToolResult {
  let regex: RegExp;
  try { regex = new RegExp(String(args.pattern), 'i'); } catch (error) { throw new Error(`invalid pattern: ${(error as Error).message}`); }
  const start = resolveInside(cwd, args.path);
  const hits: string[] = [];
  const visit = (target: string) => {
    if (hits.length >= 200) return;
    let stat: fs.Stats;
    try { stat = fs.statSync(target); } catch { return; }
    if (stat.isDirectory()) {
      if (SKIP_DIRS.has(path.basename(target)) && target !== start) return;
      for (const name of fs.readdirSync(target).sort()) visit(path.join(target, name));
      return;
    }
    if (stat.size > 1024 * 1024) return;
    const text = fs.readFileSync(target, 'utf8');
    if (text.includes('\u0000')) return;
    text.split('\n').forEach((line, i) => { if (hits.length < 200 && regex.test(line)) hits.push(`${rel(cwd, target)}:${i + 1}: ${line.slice(0, 300)}`); });
  };
  visit(start);
  return { output: hits.join('\n') || 'No matches.', summary: `Searched for /${args.pattern}/ (${hits.length}${hits.length >= 200 ? '+' : ''} matches)` };
}

async function runCommand(ctx: ToolContext, args: any): Promise<ToolResult> {
  const command = String(args.command || '').trim();
  if (!command) throw new Error('command must not be empty');
  const timeout = Math.min(600, Math.max(1, Number(args.timeout_seconds) || 120)) * 1000;
  const allowed = await ctx.approve({ tool: 'run_command', summary: `Run: ${command.slice(0, 160)}`, detail: command });
  if (!allowed) return { output: 'The user declined to run this command. Choose another approach or ask the user in your final message.', summary: `Declined: ${command.slice(0, 120)}`, isError: true };
  return new Promise(resolve => {
    // Its own process group, so a timeout or cancel also stops anything the command started.
    const child = spawn('bash', ['-lc', command], { cwd: ctx.cwd, detached: true, env: { ...process.env, CI: '1', NO_COLOR: '1', PAGER: 'cat', GIT_PAGER: 'cat' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    let reason = '';
    const append = (chunk: Buffer) => { output = (output + chunk.toString()).slice(-200_000); };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    const stop = (why: string) => { reason = why; try { process.kill(-child.pid!, 'SIGKILL'); } catch {} };
    const timer = setTimeout(() => stop(`timed out after ${timeout / 1000}s`), timeout);
    const onAbort = () => stop('cancelled');
    ctx.signal.addEventListener('abort', onAbort, { once: true });
    const finish = (code: number | null, error?: Error) => {
      clearTimeout(timer);
      ctx.signal.removeEventListener('abort', onAbort);
      const status = error ? `failed to start: ${error.message}` : reason || `exit code ${code}`;
      resolve({ output: `$ ${command}\n${clip(output.trimEnd()) || '(no output)'}\n[${status}]`, summary: `Ran: ${command.slice(0, 120)} (${status})`, isError: Boolean(error || reason || code !== 0) });
    };
    child.on('error', error => finish(null, error));
    child.on('close', code => finish(code));
  });
}

export async function runTool(name: string, rawArgs: string, ctx: ToolContext): Promise<ToolResult> {
  let args: any;
  try { args = rawArgs ? JSON.parse(rawArgs) : {}; } catch { return { output: `Error: the arguments for ${name} were not valid JSON.`, summary: `${name}: invalid arguments`, isError: true }; }
  if (!args || typeof args !== 'object') args = {};
  try {
    switch (name) {
      case 'list_files': return listFiles(ctx.cwd, args);
      case 'read_file': return readFile(ctx.cwd, args);
      case 'write_file': return writeFile(ctx.cwd, args);
      case 'edit_file': return editFile(ctx.cwd, args);
      case 'search': return search(ctx.cwd, args);
      case 'run_command': return await runCommand(ctx, args);
      default: return { output: `Error: unknown tool ${name}. Available: ${toolSpecs.map(t => t.function.name).join(', ')}`, summary: `Unknown tool ${name}`, isError: true };
    }
  } catch (error) {
    return { output: `Error: ${(error as Error).message}`, summary: `${name} failed: ${(error as Error).message}`.slice(0, 200), isError: true };
  }
}
