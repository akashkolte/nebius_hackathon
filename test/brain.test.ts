import test from 'node:test';
import assert from 'node:assert/strict';
import { Brain, decideFollowup, sessionModel, type ChatClient } from '../src/brain.ts';
import { defaultModelConfig, pickRouterModel, reconcileRoster, validateModelConfig, nebiusRoster } from '../src/models.ts';
import { rankSessions } from '../src/router.ts';
import type { Session } from '../src/sessions.ts';

const session = (over: Partial<Session>): Session => ({ id: 'claude:1', nativeId: '1', harness: 'claude', title: 'Fix the checkout payment flow', lastPrompt: 'stripe webhook fails', cwd: '/work/shop', currentModel: '', updatedAt: new Date().toISOString(), file: null, source: 'desktop', liveState: 'history', ...over });

function fakeClient(answers: string[]): ChatClient & { seen: any[] } {
  const seen: any[] = [];
  return {
    seen,
    async chat(request) {
      seen.push(request);
      const content = answers.shift() ?? '{}';
      if (content === 'THROW') throw new Error('network down');
      return { message: { role: 'assistant', content }, usage: {}, model: request.model, finishReason: 'stop' };
    },
  };
}

test('local ranking prefers sessions whose topic matches the request', () => {
  const sessions = [session({ id: 'a', title: 'Write docs for the CLI' }), session({ id: 'b' })];
  assert.equal(rankSessions('the checkout payment flow double charges', sessions)[0].session.id, 'b');
});

test('the Nebius router can continue an existing session', async () => {
  const client = fakeClient(['{"choice":"session_0","confidence":0.9,"reason":"Same checkout bug"}']);
  const brain = new Brain(client, () => 'router/model');
  const route = await brain.decideRoute('checkout payment still broken', [session({})], 'auto', null, { availableHarnesses: ['nebius', 'claude'] });
  assert.equal(route.source, 'nebius');
  assert.equal(route.session?.id, 'claude:1');
  assert.equal(route.reason, 'Same checkout bug');
  assert.equal(client.seen[0].model, 'router/model');
  assert.match(client.seen[0].messages[1].content, /new_nebius/);
});

test('the Nebius router can start a new session in a chosen harness', async () => {
  const brain = new Brain(fakeClient(['{"choice":"new_nebius","confidence":0.8}']), () => 'm');
  const route = await brain.decideRoute('build a todo api', [session({})], 'auto', null, { availableHarnesses: ['nebius', 'claude'] });
  assert.deepEqual([route.session, route.harness, route.source], [null, 'nebius', 'nebius']);
});

test('routing falls back to local matching when Nebius fails, is unsure, or invents an option', async () => {
  const sessions = [session({})];
  const options = { availableHarnesses: ['nebius' as const, 'claude' as const] };
  for (const answer of ['THROW', '{"choice":"session_0","confidence":0.1}', '{"choice":"rm -rf"}']) {
    const route = await new Brain(fakeClient([answer]), () => 'm').decideRoute('build a todo api', sessions, 'auto', null, options);
    assert.equal(route.source, 'local');
    assert.equal(route.harness, 'nebius');
    assert.ok(route.fallbackReason);
  }
});

test('previews never call Nebius', async () => {
  const client = fakeClient([]);
  await new Brain(client, () => 'm').decideRoute('anything at all here', [session({})], 'auto', null, { preview: true, availableHarnesses: ['nebius'] });
  assert.equal(client.seen.length, 0);
});

test('the router chooses a model from the enabled roster', async () => {
  const brain = new Brain(fakeClient(['{"choice":"model_3","confidence":0.7,"reason":"Small edit"}']), () => 'm');
  const decision = await brain.decideModel('rename a variable', 'nebius', defaultModelConfig('nebius'));
  assert.equal(decision.model, nebiusRoster[3].id);
  assert.equal(decision.source, 'nebius');
  const override = await brain.decideModel('x', 'nebius', defaultModelConfig('nebius'), { override: nebiusRoster[0].id });
  assert.equal(override.source, 'selected');
  await assert.rejects(brain.decideModel('x', 'nebius', defaultModelConfig('nebius'), { override: 'not/enabled' }), /not enabled/);
});

test('a failed model choice keeps the session model', async () => {
  const brain = new Brain(fakeClient(['THROW']), () => 'm');
  const current = session({ harness: 'nebius', currentModel: nebiusRoster[1].id });
  const decision = await brain.decideModel('more work', 'nebius', defaultModelConfig('nebius'), { session: current });
  assert.equal(decision.model, nebiusRoster[1].id);
  assert.equal(decision.source, 'session');
});

test('follow-ups stay in their harness unless a handoff is chosen', () => {
  const origin = session({});
  assert.equal(decideFollowup(origin, { availableHarnesses: ['nebius', 'claude'], currentReady: true }).session, origin);
  const handoff = decideFollowup(origin, { mode: 'nebius', availableHarnesses: ['nebius', 'claude'], currentReady: false });
  assert.deepEqual([handoff.handoff, handoff.harness, handoff.handoffFrom], [true, 'nebius', 'claude:1']);
  assert.throws(() => decideFollowup(origin, { availableHarnesses: ['nebius'], currentReady: false, currentDetail: 'Sign in' }), /Sign in/);
  assert.throws(() => decideFollowup(origin, { mode: 'codex', availableHarnesses: ['nebius'], currentReady: true }), /not ready/);
});

test('sessionModel matches aliases inside full model IDs', () => {
  assert.equal(sessionModel('claude-opus-4-1', [{ id: 'opus' }, { id: 'sonnet' }])?.id, 'opus');
  assert.equal(sessionModel('', [{ id: 'opus' }]), null);
});

test('the roster is reconciled with the models Nebius serves', () => {
  const config = defaultModelConfig('nebius');
  assert.deepEqual(reconcileRoster(config, []), config);
  const partial = reconcileRoster(config, [nebiusRoster[0].id]);
  assert.deepEqual(partial.models.map(m => m.enabled), nebiusRoster.map((_, i) => i === 0));
  const none = reconcileRoster(config, ['vendor/Some-Coder-7B', 'vendor/embedding-large']);
  assert.ok(none.models.some(m => m.id === 'vendor/Some-Coder-7B' && m.enabled));
  assert.ok(!none.models.some(m => m.id === 'vendor/embedding-large'));
});

test('router model selection honours config, then preference, then what is served', () => {
  assert.equal(pickRouterModel('my/router', ['x'], nebiusRoster), 'my/router');
  assert.equal(pickRouterModel('', ['nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B', 'zzz'], nebiusRoster), 'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B');
  assert.equal(pickRouterModel('', ['zzz', 'nvidia/nemotron-3-super-120b-a12b'], nebiusRoster), 'nvidia/nemotron-3-super-120b-a12b');
  assert.equal(pickRouterModel('', ['Qwen/Qwen3-235B-A22B-Instruct-2507', 'Qwen/Qwen3-30B-A3B-Instruct-2507'], nebiusRoster), 'Qwen/Qwen3-30B-A3B-Instruct-2507');
  assert.equal(pickRouterModel('', ['only/model'], nebiusRoster), 'only/model');
});

test('model settings are validated', () => {
  assert.deepEqual(validateModelConfig({ models: [{ id: 'a/b', label: 'AB' }], defaultModel: 'a/b' }), { models: [{ id: 'a/b', label: 'AB', description: '', enabled: true }], defaultModel: 'a/b' });
  assert.throws(() => validateModelConfig({ models: [{ id: 'bad id' }] }), /Model IDs/);
  assert.throws(() => validateModelConfig({ models: [{ id: 'a' }, { id: 'a' }] }), /unique/);
  assert.throws(() => validateModelConfig({ models: [{ id: 'a', enabled: false }], defaultModel: 'a' }), /enabled model/);
});

test('NVIDIA Nemotron 3 Ultra is the default agent model and the fallback when routing fails', async () => {
  const config = defaultModelConfig('nebius');
  assert.equal(config.defaultModel, 'nvidia/Nemotron-3-Ultra-550b-a55b');
  const decision = await new Brain(fakeClient(['THROW']), () => 'm').decideModel('build a feature', 'nebius', config);
  assert.deepEqual([decision.model, decision.source], ['nvidia/Nemotron-3-Ultra-550b-a55b', 'default']);
  assert.equal(reconcileRoster(config, ['Qwen/Qwen3-30B-A3B-Instruct-2507']).defaultModel, '');
});
