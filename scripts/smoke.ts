// Live check against Nebius Token Factory: lists models, asks the router a question, and runs the
// coding agent on a scratch folder. Usage: NEBIUS_API_KEY=... npm run smoke
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.ts';
import { NebiusClient } from '../src/nebius.ts';
import { Brain } from '../src/brain.ts';
import { defaultModelConfig, nebiusRoster, pickRouterModel, reconcileRoster } from '../src/models.ts';
import { runAgent } from '../src/agent/loop.ts';

process.on('uncaughtException', error => { console.error(`\n✗ ${error.message}`); process.exit(1); });

const config = loadConfig();
const client = new NebiusClient({ baseUrl: config.nebius.baseUrl, apiKey: config.nebius.apiKey });

console.log(`1. Listing models at ${config.nebius.baseUrl}`);
const served = await client.listModels();
console.log(`   ${served.length} models served: ${served.join(', ')}`);
const roster = reconcileRoster(defaultModelConfig('nebius'), served);
for (const model of roster.models) console.log(`   ${model.enabled ? '✓' : '✗'} ${model.id}`);
const routerModel = pickRouterModel(config.nebius.routerModel, served, nebiusRoster);

console.log(`\n2. Router (${routerModel}) chooses a model for a small task`);
const brain = new Brain(client, () => routerModel);
const decision = await brain.decideModel('Rename the variable x to count in utils.py', 'nebius', roster);
console.log(`   → ${decision.model} (${decision.source}): ${decision.reason}${decision.fallbackReason ? ` [${decision.fallbackReason}]` : ''}`);

const agentModel = config.nebius.defaultAgentModel || roster.defaultModel || decision.model || roster.models.find(m => m.enabled)!.id;
const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'shed-smoke-'));
console.log(`\n3. Agent (${agentModel}) writes and runs a script in ${cwd}`);
const result = await runAgent({
  client, model: agentModel, cwd, history: [], signal: AbortSignal.timeout(300_000),
  prompt: 'Create fizzbuzz.py that prints FizzBuzz for 1..15, run it with python3, and tell me the last line it printed.',
  approve: async request => { console.log(`   (auto-approved) ${request.summary}`); return true; },
  onEvent: event => { if (event.type === 'tool') console.log(`   ${event.isError ? '✗' : '•'} ${event.summary}`); },
});
console.log(`\n   Final answer after ${result.steps} steps, ${result.usage.total_tokens} tokens:\n   ${result.finalText.replace(/\n/g, '\n   ')}`);
console.log(fs.existsSync(path.join(cwd, 'fizzbuzz.py')) ? '\n✓ Smoke test passed: fizzbuzz.py was created.' : '\n✗ The agent did not create fizzbuzz.py.');
process.exit(fs.existsSync(path.join(cwd, 'fizzbuzz.py')) ? 0 : 1);
