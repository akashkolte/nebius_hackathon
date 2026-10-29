// Discovers conversations that desktop coding CLIs saved on this machine, so they can be
// listed, read and continued from the browser. Adapted from server/sessions.js in Shed (MIT).
import fs from 'node:fs';
import path from 'node:path';
import type { Harness } from './models.ts';

export type Session = {
  id: string;
  nativeId: string;
  harness: Harness;
  title: string;
  lastPrompt: string;
  cwd: string;
  currentModel: string;
  updatedAt: string;
  file: string | null;
  source: 'desktop' | 'dispatch';
  liveState: 'working' | 'waiting' | 'history';
};
export type DisplayMessage = { role: 'user' | 'assistant' | 'tool'; text: string; at?: string };

function walk(dir: string, accept: (file: string) => boolean, maxDepth = 5, depth = 0, out: string[] = []): string[] {
  if (depth > maxDepth) return out;
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, accept, maxDepth, depth + 1, out);
    else if (entry.isFile() && accept(full)) out.push(full);
  }
  return out;
}

function sliceFile(file: string, bytes: number, fromEnd = false): string {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = fromEnd ? Math.max(0, size - bytes) : 0;
    const buffer = Buffer.alloc(Math.min(bytes, size));
    fs.readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.toString('utf8');
    if (fromEnd && start > 0) text = text.slice(text.indexOf('\n') + 1);
    if (!fromEnd && size > bytes) text = text.slice(0, text.lastIndexOf('\n'));
    return text;
  } finally { fs.closeSync(fd); }
}

function jsonLines(text: string): any[] {
  return text.split('\n').flatMap(line => {
    if (!line.trim()) return [];
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

// Keeps line breaks so Markdown survives; drops harness-injected blocks a person never wrote.
export function displayText(text: unknown, limit = 12000): string {
  return String(text || '')
    .replace(/<(environment_context|system-reminder|oai-mem-citation)>[\s\S]*?<\/\1>/g, '')
    .replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim().slice(0, limit);
}

export function clean(text: unknown, limit = 220): string {
  return String(text || '').replace(/<environment_context>[\s\S]*?<\/environment_context>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  // Claude records tool output as user-role tool_result blocks; that is not something the user typed.
  return content.filter(c => c?.type !== 'tool_result').map(c => typeof c === 'string' ? c : c?.text || c?.content || '')
    .filter(x => typeof x === 'string' && x).join('\n\n');
}

function isUsefulPrompt(text: string): boolean {
  if (/^\s*<(command-name|command-message|local-command-stdout|local-command-caveat|system-reminder)>/i.test(String(text || ''))) return false;
  const value = clean(text, 1000);
  return value.length > 8 && !/^(# AGENTS\.md instructions|<environment_context>|<permissions instructions>|You are Codex,)/i.test(value);
}

function lastModel(text: string): string {
  return [...text.matchAll(/"model"\s*:\s*"([^"<]{1,100})"/g)].map(match => match[1]).at(-1) || '';
}

function codexRecord(file: string): Session | null {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, 256 * 1024));
  const meta = lines.find(x => x.type === 'session_meta')?.payload || {};
  const userText = (rows: any[]) => rows.filter(x => x.type === 'response_item' && x.payload?.type === 'message' && x.payload.role === 'user')
    .map(x => contentText(x.payload.content)).filter(isUsefulPrompt);
  const prompts = userText(lines);
  const tail = sliceFile(file, 128 * 1024, true);
  const id = path.basename(file).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/)?.[1] || meta.id || meta.session_id;
  if (!id) return null;
  return { id: `codex:${id}`, nativeId: id, harness: 'codex', title: clean(prompts[0]) || 'Untitled Codex session', lastPrompt: clean(userText(jsonLines(tail)).at(-1), 260), cwd: meta.cwd || '', currentModel: lastModel(tail), updatedAt: stat.mtime.toISOString(), file, source: 'desktop', liveState: 'history' };
}

function claudeRecord(file: string): Session | null {
  const stat = fs.statSync(file);
  const lines = jsonLines(sliceFile(file, 256 * 1024));
  const first = lines.find(x => x.type === 'user' && !x.isSidechain && isUsefulPrompt(contentText(x.message?.content)));
  const tail = sliceFile(file, 128 * 1024, true);
  const recent = jsonLines(tail).filter(x => x.type === 'user' && !x.isSidechain).map(x => contentText(x.message?.content)).filter(isUsefulPrompt);
  const id = first?.sessionId || path.basename(file, '.jsonl');
  return { id: `claude:${id}`, nativeId: id, harness: 'claude', title: clean(contentText(first?.message?.content)) || 'Untitled Claude session', lastPrompt: clean(recent.at(-1), 260), cwd: first?.cwd || '', currentModel: lastModel(tail), updatedAt: stat.mtime.toISOString(), file, source: 'desktop', liveState: 'history' };
}

function geminiRecord(file: string): Session | null {
  const stat = fs.statSync(file);
  if (stat.size > 8 * 1024 * 1024) return null;
  const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  const messages: any[] = Array.isArray(data.messages) ? data.messages : [];
  const users = messages.filter(x => x.type === 'user' || x.role === 'user');
  const text = (x: any) => x?.content || x?.text || x?.message;
  const id = data.sessionId || path.basename(file, '.json');
  return { id: `gemini:${id}`, nativeId: id, harness: 'gemini', title: clean(text(users[0])) || 'Untitled Gemini session', lastPrompt: clean(text(users.at(-1)), 260), cwd: data.cwd || '', currentModel: [...messages].reverse().find(x => typeof x.model === 'string')?.model || '', updatedAt: data.lastUpdated || stat.mtime.toISOString(), file, source: 'desktop', liveState: 'history' };
}

// Parsing reads up to 384 KB per transcript and there can be hundreds; reuse results until a file changes.
const parsed = new Map<string, { key: string; item: Session | null }>();
function parseCached(file: string, parse: (file: string) => Session | null): Session | null {
  const stat = fs.statSync(file);
  const key = `${stat.mtimeMs}:${stat.size}`;
  const hit = parsed.get(file);
  if (hit && hit.key === key) return hit.item;
  const item = parse(file);
  parsed.set(file, { key, item });
  return item;
}

export function discoverDesktopSessions(homeDir: string): Session[] {
  const inputs: [string, (file: string) => Session | null][] = [
    ...walk(path.join(homeDir, '.codex', 'sessions'), f => f.endsWith('.jsonl'), 5).map(file => [file, codexRecord] as [string, typeof codexRecord]),
    ...walk(path.join(homeDir, '.claude', 'projects'), f => f.endsWith('.jsonl') && !f.includes('/subagents/'), 3).map(file => [file, claudeRecord] as [string, typeof claudeRecord]),
    ...walk(path.join(homeDir, '.gemini', 'tmp'), f => f.endsWith('.json') && f.includes('/chats/'), 4).map(file => [file, geminiRecord] as [string, typeof geminiRecord]),
  ];
  const sessions: Session[] = [];
  for (const [file, parse] of inputs) {
    try { const item = parseCached(file, parse); if (item) sessions.push(item); } catch { /* Ignore files still being written. */ }
  }
  return sessions.filter(session => !(session.title.startsWith('Untitled ') && !session.cwd));
}

export function desktopMessages(session: Session): DisplayMessage[] {
  const file = session.file;
  if (!file || !fs.existsSync(file)) return [];
  if (session.harness === 'gemini') {
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    return (data.messages || []).map((x: any) => ({ role: x.type === 'user' || x.role === 'user' ? 'user' : 'assistant', text: displayText(x.content || x.text || x.message), at: x.timestamp || x.time }))
      .filter((x: DisplayMessage) => x.text).slice(-60);
  }
  const messages: DisplayMessage[] = [];
  for (const row of jsonLines(sliceFile(file, 2 * 1024 * 1024, true))) {
    if (session.harness === 'codex' && row.type === 'response_item' && row.payload?.type === 'message' && ['user', 'assistant'].includes(row.payload.role)) {
      const text = displayText(contentText(row.payload.content));
      if (text && !(row.payload.role === 'user' && !isUsefulPrompt(text))) messages.push({ role: row.payload.role, text, at: row.timestamp });
    }
    if (session.harness === 'claude' && ['user', 'assistant'].includes(row.type) && !row.isSidechain) {
      const raw = contentText(row.message?.content), text = displayText(raw);
      if (text && !(row.type === 'user' && !isUsefulPrompt(raw))) messages.push({ role: row.type, text, at: row.timestamp });
    }
  }
  return messages.slice(-60);
}

export function publicSession(session: Session) {
  const { file, nativeId, ...safe } = session;
  return safe;
}
