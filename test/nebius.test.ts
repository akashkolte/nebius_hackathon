import test from 'node:test';
import assert from 'node:assert/strict';
import { NebiusClient, parseJsonObject, stripThinking, textToolCalls } from '../src/nebius.ts';
import { startMockNebius } from './mock-nebius.ts';

test('parseJsonObject finds the first JSON object in prose and code fences', () => {
  assert.deepEqual(parseJsonObject('Sure! ```json\n{"choice": "new_nebius", "confidence": 0.9}\n```'), { choice: 'new_nebius', confidence: 0.9 });
  assert.deepEqual(parseJsonObject('<think>{"choice":"wrong"}</think>{"choice":"right","note":"a } in a string"}'), { choice: 'right', note: 'a } in a string' });
  assert.equal(parseJsonObject('no json here'), null);
  assert.equal(parseJsonObject('{broken'), null);
});

test('textToolCalls reads tool calls that a model wrote as text', () => {
  const { calls, rest } = textToolCalls('Let me look.\n<tool_call>{"name": "list_files", "arguments": {"path": "."}}</tool_call>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, 'list_files');
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { path: '.' });
  assert.equal(rest, 'Let me look.');
});

test('stripThinking removes reasoning blocks', () => {
  assert.equal(stripThinking('<think>hmm</think>\nDone.'), 'Done.');
});

test('the client sends the key, lists models and returns tool calls', async () => {
  const mock = await startMockNebius({ models: ['b/model', 'a/model'], agent: () => ({ content: null, tool_calls: [{ name: 'read_file', arguments: { path: 'x' } }] }) });
  try {
    const client = new NebiusClient({ baseUrl: mock.url, apiKey: 'test-key', retries: 0 });
    assert.deepEqual(await client.listModels(), ['a/model', 'b/model']);
    const result = await client.chat({ model: 'a/model', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.message.tool_calls?.[0].function.name, 'read_file');
    assert.equal(result.usage.total_tokens, 120);
  } finally { await mock.close(); }
});

test('the client retries rate limits and reports API errors clearly', async () => {
  const mock = await startMockNebius({ agent: (_, i) => i === 0 ? { status: 429, body: { detail: 'slow down' } } : { content: 'fine' } });
  try {
    const client = new NebiusClient({ baseUrl: mock.url, apiKey: 'test-key', retries: 2 });
    const result = await client.chat({ model: 'm', messages: [{ role: 'user', content: 'hi' }] });
    assert.equal(result.message.content, 'fine');
    const wrongKey = new NebiusClient({ baseUrl: mock.url, apiKey: 'nope', retries: 0 });
    await assert.rejects(wrongKey.listModels(), /Nebius returned 401: Invalid API key/);
    await assert.rejects(new NebiusClient({ baseUrl: mock.url, apiKey: '' }).listModels(), /No Nebius API key/);
  } finally { await mock.close(); }
});
