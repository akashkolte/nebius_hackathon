// The router agent: a Nebius model decides which session or harness a request belongs to and
// which model should run it. Every decision falls back to
// deterministic local matching when Nebius is unreachable, unsure, or answers with an invalid option.
import { parseJsonObject, type NebiusClient } from './nebius.ts';
import { chooseRoute, rankSessions } from './router.ts';
import { harnessDescriptions, type Harness, type ModelConfig } from './models.ts';
import type { Session } from './sessions.ts';

export type ChatClient = Pick<NebiusClient, 'chat'>;
export type RouteSource = 'selected' | 'local' | 'nebius';
export type RouteDecision = {
  session: Session | null;
  harness: Harness;
  reason: string;
  source: RouteSource;
  score?: number;
  fallbackReason?: string;
  handoff?: boolean;
  handoffFrom?: string;
};
export type ModelDecision = { model: string | null; source: string; reason: string; score?: number; fallbackReason?: string };

const MIN_CONFIDENCE = 0.4;

export class Brain {
  client: ChatClient;
  routerModel: () => string;

  constructor(client: ChatClient, routerModel: () => string) {
    this.client = client;
    this.routerModel = routerModel;
  }

  async choose(question: string, options: Record<string, string>, context: Record<string, unknown>): Promise<{ choice: string; confidence: number; reason: string }> {
    const result = await this.client.chat({
      model: this.routerModel(),
      temperature: 0,
      maxTokens: 300,
      messages: [
        { role: 'system', content: 'You are the routing brain of Dispatch, a task plane for coding agents. You pick exactly one option for each request. Reply with only a JSON object: {"choice": "<one option key>", "confidence": <number from 0 to 1>, "reason": "<at most 15 words>"}.' },
        { role: 'user', content: `${question}\n\nContext:\n${JSON.stringify(context, null, 1)}\n\nOptions:\n${Object.entries(options).map(([key, text]) => `- ${key}: ${text}`).join('\n')}` },
      ],
    });
    const answer = parseJsonObject(result.message.content || '');
    const choice = typeof answer?.choice === 'string' ? answer.choice.trim() : '';
    if (!Object.hasOwn(options, choice)) throw new Error('the router answered with an option that was not offered');
    const confidence = Number(answer?.confidence);
    return { choice, confidence: Number.isFinite(confidence) ? Math.min(1, Math.max(0, confidence)) : 0.5, reason: String(answer?.reason || '').slice(0, 160) };
  }

  async decideRoute(prompt: string, sessions: Session[], harness: Harness | 'auto', sessionId: string | null, options: { preview?: boolean; availableHarnesses: Harness[] }): Promise<RouteDecision> {
    const fallbackHarness = harness !== 'auto' ? harness : options.availableHarnesses[0] || 'nebius';
    const local = chooseRoute(prompt, sessions, harness, sessionId, fallbackHarness);
    const localDecision: RouteDecision = { session: local.session, harness: local.session?.harness || local.harness || fallbackHarness, reason: local.reason, source: sessionId ? 'selected' : 'local' };
    if (sessionId || options.preview) return localDecision;

    const candidates = rankSessions(prompt, sessions, harness).slice(0, 6);
    const newHarnesses = harness === 'auto' ? options.availableHarnesses : [harness];
    const criteria: Record<string, string> = Object.fromEntries(newHarnesses.map(name => [`new_${name}`, `Start a new ${name} session. ${harnessDescriptions[name]} Choose this when no existing conversation is a close fit.`]));
    candidates.forEach(({ session }, index) => {
      criteria[`session_${index}`] = `Continue the ${session.harness} conversation about "${session.title.slice(0, 140)}" in project ${session.cwd || 'unknown'}. Recent request: ${session.lastPrompt?.slice(0, 150) || 'none'}. Use only when the new request clearly belongs in this conversation.`;
    });
    if (Object.keys(criteria).length < 2) return localDecision;

    try {
      const { choice, confidence, reason } = await this.choose(
        'Choose the best existing session for this request, or start a new session in the best suited available harness. Prefer a new session if the connection to existing sessions is weak or unclear.',
        criteria,
        { request: prompt.slice(0, 6000), allowedHarness: harness, availableHarnesses: newHarnesses },
      );
      if (confidence < MIN_CONFIDENCE) return { ...localDecision, fallbackReason: 'The Nebius router was unsure; local matching was used' };
      if (choice.startsWith('new_')) {
        const chosen = choice.slice(4) as Harness;
        return { session: null, harness: chosen, reason: reason || `Nebius chose a new ${chosen} session for this task`, source: 'nebius', score: confidence };
      }
      const selected = candidates[Number(choice.split('_')[1])].session;
      return { session: selected, harness: selected.harness, reason: reason || `Nebius matched this task to the ${selected.harness} conversation`, source: 'nebius', score: confidence };
    } catch (error) {
      return { ...localDecision, fallbackReason: `Nebius router unavailable: ${(error as Error).message}` };
    }
  }

  async decideModel(prompt: string, harness: Harness, config: ModelConfig, options: { override?: string; session?: Session | null; preview?: boolean } = {}): Promise<ModelDecision> {
    const enabled = config.models.filter(model => model.enabled);
    const defaultModel = config.defaultModel && enabled.some(model => model.id === config.defaultModel) ? config.defaultModel : '';
    const current = options.session?.harness === harness ? sessionModel(options.session.currentModel, enabled) : null;
    const fallback: ModelDecision = current ? { model: current.id, source: 'session', reason: `Keeping the session's current model, ${current.label}` }
      : defaultModel ? { model: defaultModel, source: 'default', reason: 'Using the configured default model' }
      : harness === 'nebius' && enabled[0] ? { model: enabled[0].id, source: 'default', reason: `Using ${enabled[0].label}, the first enabled Nebius model` }
      : { model: null, source: 'harness-default', reason: 'Using the harness default model' };
    if (options.override) {
      const selected = enabled.find(model => model.id === options.override);
      if (!selected) throw new Error('The selected model is not enabled for this harness.');
      return { model: selected.id, source: 'selected', reason: 'Using the model you selected' };
    }
    if (enabled.length === 0) return fallback;
    if (enabled.length === 1) return { model: enabled[0].id, source: 'single-option', reason: 'Only one model is enabled for this harness' };
    if (options.preview) return fallback;
    const criteria = Object.fromEntries(enabled.map((model, index) => [`model_${index}`, `${model.label} (${model.id}): ${model.description || 'No description supplied.'}${model === current ? ' The conversation already uses this model; prefer it unless the request clearly needs a different one.' : ''}`]));
    try {
      const { choice, confidence, reason } = await this.choose(
        'Choose the best model for this coding task. Weigh difficulty against speed: use the strongest model only for hard, multi-file or ambiguous work, and a fast model for small edits and questions.',
        criteria,
        { request: prompt.slice(0, 6000), harness, currentModel: current?.id || '', sessionTopic: options.session?.title || '' },
      );
      if (confidence < MIN_CONFIDENCE) return { ...fallback, fallbackReason: 'The Nebius router was unsure about the model' };
      const selected = enabled[Number(choice.split('_')[1])];
      if (selected === current) return { model: selected.id, source: 'nebius', reason: reason || `Nebius kept the session on ${selected.label}`, score: confidence };
      return { model: selected.id, source: 'nebius', reason: reason || `Nebius chose ${selected.label} for this task`, score: confidence };
    } catch (error) {
      return { ...fallback, fallbackReason: `Nebius model choice unavailable: ${(error as Error).message}` };
    }
  }
}

// Existing sessions keep their harness and context. Only an explicit handoff starts a different harness.
export function decideFollowup(session: Session, options: { mode?: string; availableHarnesses: Harness[]; currentReady: boolean; currentDetail?: string }): RouteDecision {
  const mode = options.mode || 'auto';
  if (!['auto', 'stay', session.harness].includes(mode)) {
    if (!options.availableHarnesses.includes(mode as Harness)) throw new Error(`${mode} is not ready.`);
    return { session: null, harness: mode as Harness, handoff: true, handoffFrom: session.id, reason: `Handing this session off to ${mode} as you selected`, source: 'selected' };
  }
  if (!options.currentReady) throw new Error(`${options.currentDetail || `${session.harness} is not ready.`} This session stays on ${session.harness}; restore it or explicitly choose a handoff.`);
  return { session, harness: session.harness, reason: `Continuing in the same ${session.harness} session`, source: 'selected' };
}

export function sessionModel<T extends { id: string }>(id: string, models: T[]): T | null {
  if (!id) return null;
  const value = id.toLowerCase();
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Aliases like "opus" match full IDs like "claude-opus-4"; the longest alias wins.
  return [...models].sort((a, b) => b.id.length - a.id.length)
    .find(model => new RegExp(`(^|[^a-z0-9])${escape(model.id.toLowerCase())}($|[^a-z0-9])`).test(value)) || null;
}
