import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveInside, runTool, type ToolContext } from '../src/agent/tools.ts';
import { compactHistory } from '../src/agent/loop.ts';

function project(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-tools-'));
  fs.writeFileSync(path.join(dir, 'app.js'), 'const a = 1;\nconst b = 2;\nconst a2 = 1;\n');
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'util.js'), 'export function add(x, y) { return x + y; }\n');
  return dir;
}
const ctx = (cwd: string, allow = true): ToolContext => ({ cwd, signal: new AbortController().signal, approve: async () => allow });

test('paths cannot leave the project folder, including through symlinks', () => {
  const dir = project();
  assert.ok(resolveInside(dir, 'src/util.js').endsWith(path.join('src', 'util.js')));
  assert.throws(() => resolveInside(dir, '../etc/passwd'), /outside the project/);
  assert.throws(() => resolveInside(dir, '/etc/passwd'), /outside the project/);
  fs.symlinkSync(os.tmpdir(), path.join(dir, 'escape'));
  assert.throws(() => resolveInside(dir, 'escape/x.txt'), /leads outside/);
});

test('file tools list, read, write and edit inside the project', async () => {
  const dir = project();
  const listed = await runTool('list_files', '{}', ctx(dir));
  assert.match(listed.output, /app\.js/);
  assert.match(listed.output, /src\/\n {2}util\.js/);
  const read = await runTool('read_file', JSON.stringify({ path: 'app.js', start_line: 2, end_line: 2 }), ctx(dir));
  assert.match(read.output, /2 {2}const b = 2;/);
  await runTool('write_file', JSON.stringify({ path: 'new/dir/file.txt', content: 'hello' }), ctx(dir));
  assert.equal(fs.readFileSync(path.join(dir, 'new/dir/file.txt'), 'utf8'), 'hello');
  const ambiguous = await runTool('edit_file', JSON.stringify({ path: 'app.js', old_string: '= 1;', new_string: '= 10;' }), ctx(dir));
  assert.equal(ambiguous.isError, true);
  assert.match(ambiguous.output, /appears 2 times/);
  const edited = await runTool('edit_file', JSON.stringify({ path: 'app.js', old_string: 'const b = 2;', new_string: 'const b = 3;' }), ctx(dir));
  assert.equal(edited.isError, undefined);
  assert.match(fs.readFileSync(path.join(dir, 'app.js'), 'utf8'), /const b = 3;/);
  const missing = await runTool('edit_file', JSON.stringify({ path: 'app.js', old_string: 'nope', new_string: 'x' }), ctx(dir));
  assert.match(missing.output, /not found/);
});

test('search finds matches and skips node_modules', async () => {
  const dir = project();
  fs.mkdirSync(path.join(dir, 'node_modules'));
  fs.writeFileSync(path.join(dir, 'node_modules', 'dep.js'), 'function add() {}');
  const result = await runTool('search', JSON.stringify({ pattern: 'function add' }), ctx(dir));
  assert.equal(result.output, 'src/util.js:1: export function add(x, y) { return x + y; }');
});

test('run_command asks first, honours a decline, and reports exit codes', async () => {
  const dir = project();
  const declined = await runTool('run_command', JSON.stringify({ command: 'touch should-not-exist' }), ctx(dir, false));
  assert.equal(declined.isError, true);
  assert.equal(fs.existsSync(path.join(dir, 'should-not-exist')), false);
  const ok = await runTool('run_command', JSON.stringify({ command: 'echo hi && pwd' }), ctx(dir));
  assert.match(ok.output, /hi\n.*shed-tools-/);
  assert.match(ok.output, /\[exit code 0\]/);
  const failed = await runTool('run_command', JSON.stringify({ command: 'exit 3' }), ctx(dir));
  assert.equal(failed.isError, true);
  assert.match(failed.output, /exit code 3/);
  const slow = await runTool('run_command', JSON.stringify({ command: 'sleep 5', timeout_seconds: 1 }), ctx(dir));
  assert.match(slow.output, /timed out after 1s/);
});

test('bad tool calls come back as errors the model can read', async () => {
  const dir = project();
  assert.match((await runTool('read_file', '{not json', ctx(dir))).output, /not valid JSON/);
  assert.match((await runTool('delete_everything', '{}', ctx(dir))).output, /unknown tool/);
  assert.match((await runTool('read_file', JSON.stringify({ path: 'missing.txt' }), ctx(dir))).output, /^Error: ENOENT/);
});

test('compactHistory shortens old tool output but keeps recent results whole', () => {
  const long = 'x'.repeat(5000);
  const messages = Array.from({ length: 10 }, (_, i) => ({ role: 'tool' as const, tool_call_id: String(i), content: long }));
  const compacted = compactHistory(messages, 8, 100).map(m => String(m.content));
  assert.ok(compacted[0].length < 200);
  assert.ok(compacted[1].length < 200);
  assert.equal(compacted[2].length, 5000);
});
