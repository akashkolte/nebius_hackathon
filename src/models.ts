export const harnesses = ['nebius', 'claude', 'codex', 'gemini', 'opencode'] as const;
export type Harness = typeof harnesses[number];
export const isHarness = (value: unknown): value is Harness => harnesses.includes(value as Harness);

export type ModelEntry = { id: string; label: string; description: string; enabled: boolean };
export type ModelConfig = { models: ModelEntry[]; defaultModel: string };

export const harnessLabels: Record<Harness, string> = {
  nebius: 'Nebius agent',
  claude: 'Claude Code',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

export const harnessDescriptions: Record<Harness, string> = {
  nebius: 'Built-in Nebius coding agent: reads, edits and runs code in the project with open models on Nebius Token Factory.',
  claude: 'Claude Code CLI: coding, analysis, and longer codebase tasks.',
  codex: 'Codex CLI: coding, terminal workflows, and repository work.',
  gemini: 'Gemini CLI: coding, research, and multimodal workflows.',
  opencode: 'OpenCode CLI: coding agent with configurable providers and models.',
};

// Default roster for the built-in agent. Model IDs on Token Factory change over time, so the server
// checks them against GET /v1/models at startup (see reconcileRoster) and the roster is editable in Settings.
export const nebiusRoster: ModelEntry[] = [
  { id: 'moonshotai/Kimi-K2.7-Code', label: 'Kimi K2.7 Code', description: 'Coding-tuned: multi-file features, refactors and hard debugging.', enabled: true },
  { id: 'nvidia/nemotron-3-super-120b-a12b', label: 'NVIDIA Nemotron 3 Super', description: 'Long, multi-step agentic work with many tool calls; everyday coding tasks.', enabled: true },
  { id: 'Qwen/Qwen3-235B-A22B-Instruct-2507', label: 'Qwen3 235B', description: 'Balanced general model: explanations, moderate changes, reliable tool use.', enabled: true },
  { id: 'Qwen/Qwen3-30B-A3B-Instruct-2507', label: 'Qwen3 30B (fast)', description: 'Fast: small edits, questions about code, short scripts.', enabled: true },
];

// The router answers one short JSON question per request, so a fast instruct model is preferred.
// Non-reasoning instruct models answer JSON directly instead of spending tokens thinking first.
export const routerPreference = [
  'Qwen/Qwen3-30B-A3B-Instruct-2507',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  'nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B',
  'meta-llama/Llama-3.3-70B-Instruct',
];

const curated: Record<Harness, ModelEntry[]> = {
  nebius: nebiusRoster,
  claude: [
    { id: 'opus', label: 'Opus', description: 'Deep reasoning and complex implementation.', enabled: true },
    { id: 'sonnet', label: 'Sonnet', description: 'Balanced coding and everyday tasks.', enabled: true },
    { id: 'haiku', label: 'Haiku', description: 'Fast, simple tasks and lightweight edits.', enabled: true },
  ],
  codex: [],
  gemini: [
    { id: 'pro', label: 'Pro', description: 'Complex reasoning and larger tasks.', enabled: true },
    { id: 'flash', label: 'Flash', description: 'Fast, balanced work.', enabled: true },
  ],
  opencode: [],
};

export function defaultModelConfig(harness: Harness): ModelConfig {
  return { models: curated[harness].map(model => ({ ...model })), defaultModel: '' };
}

export function modelConfig(harness: Harness, overrides: Partial<Record<Harness, ModelConfig>> = {}): ModelConfig {
  const saved = overrides[harness];
  return saved ? { models: saved.models.map(model => ({ ...model })), defaultModel: saved.defaultModel || '' } : defaultModelConfig(harness);
}

const CODING_HINT = /coder|kimi|nemotron|deepseek|qwen3|llama-3\.3|gpt-oss|glm|devstral/i;

// Keeps roster entries Nebius actually serves. If none survive, offers up to four served models that look
// like coding or instruct models, so a stale default never leaves the agent without a model.
export function reconcileRoster(config: ModelConfig, available: string[]): ModelConfig {
  if (!available.length) return config;
  const served = new Set(available);
  const models = config.models.map(model => served.has(model.id) ? model : { ...model, enabled: false, description: `${model.description.replace(/ \(not served by Nebius right now\)$/, '')} (not served by Nebius right now)` });
  if (!models.some(model => model.enabled)) {
    for (const id of available.filter(id => CODING_HINT.test(id) && !/embed|vision|guard|reward/i.test(id)).slice(0, 4)) {
      if (!models.some(model => model.id === id)) models.push({ id, label: id.split('/').pop() || id, description: 'Served by Nebius Token Factory.', enabled: true });
    }
  }
  const defaultModel = models.some(model => model.id === config.defaultModel && model.enabled) ? config.defaultModel : '';
  return { models, defaultModel };
}

export function pickRouterModel(configured: string, available: string[], roster: ModelEntry[]): string {
  if (configured) return configured;
  if (!available.length) return routerPreference[0];
  const served = new Set(available);
  return routerPreference.find(id => served.has(id)) || roster.find(m => m.enabled && served.has(m.id))?.id || available.find(id => CODING_HINT.test(id)) || available[0];
}

export function validateModelConfig(input: { models?: unknown; defaultModel?: unknown }): ModelConfig {
  if (!Array.isArray(input.models) || input.models.length > 16) throw new Error('Use at most 16 models per harness.');
  const seen = new Set<string>();
  const models = input.models.map((model: any) => {
    if (!model || typeof model.id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(model.id)) throw new Error('Model IDs must be 1–120 letters, numbers, dots, slashes, colons, dashes, or underscores.');
    if (seen.has(model.id)) throw new Error('Model IDs must be unique within a harness.');
    seen.add(model.id);
    const label = String(model.label || model.id).trim();
    const description = String(model.description || '').trim();
    if (label.length > 100 || description.length > 300) throw new Error('Model label or description is too long.');
    return { id: model.id, label, description, enabled: model.enabled !== false };
  });
  const defaultModel = String(input.defaultModel || '');
  if (defaultModel && !models.some(model => model.id === defaultModel && model.enabled)) throw new Error('Default model must be an enabled model.');
  return { models, defaultModel };
}
