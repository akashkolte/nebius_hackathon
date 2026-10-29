// End to end: the real server, router and agent loop, against a mock Nebius API.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.ts';
import { createApp } from '../src/server.ts';
import { startMockNebius, type Handler, type MockRequest } from './mock-nebius.ts';

const tmp = (name: string) => fs.mkdtempSync(path.join(os.tmpdir(), `shed-${name}-`));
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a task goes from the phone through the Nebius router to the Nebius agent and back', async t => {
  const home = tmp('home');
  const desktopProject = tmp('desktop-project');
  // A Claude Code conversation saved on this machine, to check discovery and handoff.
  fs.mkdirSync(path.join(home, '.claude', 'projects', 'p'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'p', 'abc.jsonl'), [
    { type: 'user', sessionId: 'abc', cwd: desktopProject, timestamp: new Date().toISOString(), message: { role: 'user', content: 'Refactor the billing module into services' } },
    { type: 'assistant', sessionId: 'abc', timestamp: new Date().toISOString(), message: { role: 'assistant', model: 'claude-sonnet-4', content: [{ type: 'text', text: 'Split billing into three services.' }] } },
  ].map(row => JSON.stringify(row)).join('\n') + '\n');

  let agent: Handler = () => ({ content: 'ok' });
  // Each scenario numbers its own agent calls from 0.
  const scenario = (handler: Handler): Handler => { let calls = 0; return request => handler(request, calls++); };
  const mock = await startMockNebius({
    models: ['Qwen/Qwen3-Coder-480B-A35B-Instruct', 'meta-llama/Llama-3.3-70B-Instruct'],
    router: request => /best model/.test(request.messages[1].content)
      ? { content: '{"choice":"model_0","confidence":0.8,"reason":"Coding task"}' }
      : /hello\.txt/.test(request.messages[1].content) && /session_0/.test(request.messages[1].content)
      ? { content: '{"choice":"session_0","confidence":0.85,"reason":"Same hello.txt project"}' }
      : { content: '{"choice":"new_nebius","confidence":0.9,"reason":"Fresh project"}' },
    agent: (request, index) => agent(request, index),
  });
  const config = loadConfig({ SHED_HOME_DIR: home, SHED_DATA_DIR: tmp('data'), SHED_WORKSPACES: tmp('workspaces'), NEBIUS_BASE_URL: mock.url, NEBIUS_API_KEY: 'test-key', SHED_CLI: '0' });
  const { server, manager } = createApp(config, { initialPassword: '' });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await mock.close(); });

  let cookie = '';
  const call = async (pathname: string, body?: unknown, headers: Record<string, string> = {}) => {
    const response = await fetch(base + pathname, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, data: await response.json() as any, setCookie: response.headers.get('set-cookie') || '' };
  };
  const waitFor = async (taskId: string, statuses: string[]) => {
    for (let i = 0; i < 200; i++) {
      const { data } = await call(`/api/tasks/${taskId}`);
      if (statuses.includes(data.task.status)) return data.task;
      await sleep(25);
    }
    throw new Error(`task never reached ${statuses}`);
  };

  // Sign-in: the first password can only be set from this machine.
  assert.equal((await call('/api/sessions')).status, 401);
  assert.equal((await call('/api/password/setup', { password: 'correct horse' }, { 'x-forwarded-for': '203.0.113.9' })).status, 403);
  const setup = await call('/api/password/setup', { password: 'correct horse' });
  assert.equal(setup.status, 200);
  cookie = setup.setCookie.split(';')[0];
  assert.equal((await call('/api/password/setup', { password: 'another one' })).status, 409);
  const wrong = await fetch(`${base}/api/auth`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'nope nope' }) });
  assert.equal(wrong.status, 401);
  assert.equal((await call('/api/tasks', { prompt: 'x' }, { origin: 'https://evil.example' })).status, 403);

  // Health reaches Nebius and lists the served models.
  const health = await call('/api/harness-health?force=1');
  assert.equal(health.data.harnesses.nebius.state, 'ready');
  assert.equal((await call('/api/me')).data.routerModel, 'meta-llama/Llama-3.3-70B-Instruct');

  // 1. A new task: the router picks a new Nebius session; the agent writes a file, asks to run a command, finishes.
  agent = scenario((request, index) => [
    { content: 'I will create the file.', tool_calls: [{ name: 'write_file', arguments: { path: 'hello.txt', content: 'Hello from Nebius\n' } }] },
    { tool_calls: [{ name: 'run_command', arguments: { command: 'cat hello.txt' } }] },
    { content: 'Created **hello.txt** and checked it with `cat`.' },
  ][index] || { content: 'done' });
  const started = await call('/api/tasks', { prompt: 'Create hello.txt that greets the hackathon judges', harness: 'auto' });
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const task = started.data.task;
  assert.equal(task.harness, 'nebius');
  // A new session on the only ready harness is the only option, so no routing call is needed.
  assert.equal(task.routeSource, 'local');
  assert.equal(task.modelSource, 'nebius');
  assert.equal(task.model, 'Qwen/Qwen3-Coder-480B-A35B-Instruct');
  assert.match(task.cwd, /hello-txt-greets-hackathon$/);

  const waiting = await waitFor(task.id, ['waiting']);
  assert.equal(waiting.approval.detail, 'cat hello.txt');
  assert.equal((await call(`/api/tasks/${task.id}/approve`, { allow: true })).status, 200);
  const done = await waitFor(task.id, ['completed', 'failed']);
  assert.equal(done.status, 'completed', done.error);
  assert.equal(fs.readFileSync(path.join(task.cwd, 'hello.txt'), 'utf8'), 'Hello from Nebius\n');
  assert.match(done.output, /Created \*\*hello\.txt\*\*/);
  assert.equal(done.usage.total_tokens, 360);
  assert.ok(done.events.some((e: { text: string }) => e.text === 'Approved: Run: cat hello.txt'));
  const commandResult = mock.requests.filter(r => !/routing brain/.test(r.messages[0].content)).at(-1)!.messages.at(-1);
  assert.equal(commandResult.role, 'tool');
  assert.match(commandResult.content, /Hello from Nebius[\s\S]*exit code 0/);

  // 2. Sessions list both the Nebius session and the desktop Claude Code session.
  const sessions = (await call('/api/sessions')).data.sessions;
  const nebiusSession = sessions.find((s: { id: string }) => s.id === task.sessionId);
  assert.equal(nebiusSession.harness, 'nebius');
  assert.ok(sessions.some((s: { id: string; title: string }) => s.id === 'claude:abc' && s.title === 'Refactor the billing module into services'));
  const detail = (await call(`/api/sessions/${encodeURIComponent(task.sessionId)}`)).data;
  assert.deepEqual(detail.messages.map((m: { role: string }) => m.role), ['user', 'tool', 'tool', 'assistant']);

  // 3. A follow-up continues the same session with the full conversation as context.
  let followupRequest: MockRequest | null = null;
  agent = request => { followupRequest = request; return { content: 'Added a second line.' }; };
  const followup = (await call('/api/tasks', { prompt: 'Add a second line', sessionId: task.sessionId })).data.task;
  assert.equal(followup.sessionId, task.sessionId);
  assert.equal(followup.routeSource, 'selected');
  await waitFor(followup.id, ['completed']);
  const roles = followupRequest!.messages.map((m: { role: string }) => m.role);
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'assistant', 'user']);

  // 3b. A new message from the composer that belongs to that session is routed there by Nebius.
  agent = () => ({ content: 'Updated the greeting.' });
  const routed = (await call('/api/tasks', { prompt: 'Make hello.txt greet NVIDIA too', harness: 'auto' })).data.task;
  assert.equal(routed.routeSource, 'nebius');
  assert.equal(routed.sessionId, task.sessionId);
  assert.equal(routed.routeReason, 'Same hello.txt project');
  await waitFor(routed.id, ['completed']);

  // 4. Declining a command is reported back to the model.
  let declinedResult = '';
  agent = scenario((request, index) => {
    if (index === 0) return { tool_calls: [{ name: 'run_command', arguments: { command: 'rm -rf /tmp/whatever' } }] };
    declinedResult = request.messages.at(-1).content;
    return { content: 'Skipped the command as asked.' };
  });
  const risky = (await call('/api/tasks', { prompt: 'Clean up temp files', sessionId: task.sessionId })).data.task;
  await waitFor(risky.id, ['waiting']);
  await call(`/api/tasks/${risky.id}/approve`, { allow: false });
  assert.equal((await waitFor(risky.id, ['completed'])).output, 'Skipped the command as asked.');
  assert.match(declinedResult, /declined/);

  // 5. Stop cancels a long-running command.
  agent = () => ({ tool_calls: [{ name: 'run_command', arguments: { command: 'sleep 30' } }] });
  const slow = (await call('/api/tasks', { prompt: 'Run the slow job', sessionId: task.sessionId, skipPermissions: true })).data.task;
  await sleep(150);
  const busy = await call('/api/tasks', { prompt: 'Another thing at the same time', sessionId: task.sessionId });
  assert.equal(busy.status, 409);
  assert.equal((await call(`/api/tasks/${slow.id}/cancel`, {})).status, 200);
  assert.equal((await waitFor(slow.id, ['cancelled'])).status, 'cancelled');

  // 6. Handoff: a desktop Claude Code session continues on the Nebius agent with its transcript.
  let handoffPrompt = '';
  agent = request => { handoffPrompt = request.messages.at(-1).content; return { content: 'Picked up the billing refactor.' }; };
  const handoff = (await call('/api/tasks', { prompt: 'Finish the refactor', sessionId: 'claude:abc', followup: 'nebius' })).data.task;
  assert.equal(handoff.harness, 'nebius');
  assert.equal(handoff.handoffFrom, 'claude:abc');
  assert.equal(handoff.cwd, desktopProject);
  await waitFor(handoff.id, ['completed']);
  assert.match(handoffPrompt, /continuing work that began in a Claude Code session using claude-sonnet-4/);
  assert.match(handoffPrompt, /\[user\] Refactor the billing module into services/);
  assert.match(handoffPrompt, /New request:\nFinish the refactor/);

  // 7. Following up on the desktop session itself needs its CLI, which is off here.
  const blocked = await call('/api/tasks', { prompt: 'More billing work', sessionId: 'claude:abc' });
  assert.equal(blocked.status, 400);
  assert.match(blocked.data.error, /stays on claude/);
  assert.equal(manager.running.size, 0);
});

test('when Nebius is unreachable, routing falls back locally and the task fails with a clear reason', async t => {
  const config = loadConfig({ SHED_HOME_DIR: tmp('home'), SHED_DATA_DIR: tmp('data'), SHED_WORKSPACES: tmp('workspaces'), NEBIUS_BASE_URL: 'http://127.0.0.1:9/v1', NEBIUS_API_KEY: 'k', SHED_CLI: '0' });
  const { server, manager, health } = createApp(config, { initialPassword: '' });
  manager.client.retries = 0;
  t.after(() => new Promise(resolve => server.close(resolve)));
  const snapshot = await health.refresh(true);
  assert.equal(snapshot.nebius.state, 'offline');
  assert.match(snapshot.nebius.detail, /Could not reach Nebius/);
  await assert.rejects(manager.plan({ prompt: 'write a fizzbuzz script', harness: 'nebius' }), /Could not reach Nebius/);
  const task = await manager.start({ prompt: 'write a fizzbuzz script', harness: 'auto' });
  assert.equal(task.routeSource, 'local');
  // With Nebius offline no harness is ready, but the built-in agent is still the fallback route.
  assert.equal(task.harness, 'nebius');
  for (let i = 0; i < 100 && task.status === 'running'; i++) await sleep(20);
  assert.equal(task.status, 'failed');
  assert.match(task.error, /Could not reach Nebius/);
});
