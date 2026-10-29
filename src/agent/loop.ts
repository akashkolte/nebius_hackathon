// The built-in coding agent: a tool-calling loop on a Nebius model. Each step the model either
// calls tools (results are fed back) or answers in plain text, which ends the turn.
import os from 'node:os';
import { stripThinking, type ChatMessage, type Usage } from '../nebius.ts';
import type { ChatClient } from '../brain.ts';
import { runTool, toolSpecs, type ApprovalRequest } from './tools.ts';

export type AgentEvent =
  | { type: 'step'; step: number; model: string }
  | { type: 'assistant'; text: string }
  | { type: 'tool'; tool: string; summary: string; isError: boolean };

export type AgentRun = {
  client: ChatClient;
  model: string;
  cwd: string;
  history: ChatMessage[];
  prompt: string;
  signal: AbortSignal;
  approve: (request: ApprovalRequest) => Promise<boolean>;
  onEvent: (event: AgentEvent) => void;
  maxSteps?: number;
};
export type AgentResult = { messages: ChatMessage[]; finalText: string; usage: Required<Usage>; steps: number };

export function systemPrompt(cwd: string): string {
  return [
    'You are the Nebius coding agent inside Dispatch, a task plane that lets people direct coding agents from their phone.',
    `You work in the project folder ${cwd} on ${os.type()} (${os.arch()}). All file paths are relative to that folder.`,
    'Work like a careful senior engineer:',
    '1. Explore first: list files, read the relevant code and search before changing anything.',
    '2. Make focused, minimal changes that match the existing style. Prefer edit_file for small changes and write_file for new files.',
    '3. Verify: run the project\'s tests, linters or the program itself with run_command when that is possible.',
    '4. Never invent results. If a command fails or was declined, say so.',
    'When you are done, reply without calling tools. That final message is read on a phone: in a few short lines say what you changed (file names), how you verified it, and anything the user must do next.',
  ].join('\n');
}

// Old tool output dominates context size; keep the latest results whole and shorten earlier ones.
export function compactHistory(messages: ChatMessage[], keepRecent = 8, limit = 1500): ChatMessage[] {
  const toolIndexes = messages.flatMap((m, i) => m.role === 'tool' ? [i] : []);
  const older = new Set(toolIndexes.slice(0, Math.max(0, toolIndexes.length - keepRecent)));
  return messages.map((message, i) => older.has(i) && message.role === 'tool' && message.content.length > limit
    ? { ...message, content: `${message.content.slice(0, limit)}\n… [older output shortened]` } : message);
}

export async function runAgent(run: AgentRun): Promise<AgentResult> {
  const maxSteps = run.maxSteps ?? 40;
  const messages: ChatMessage[] = run.history.length ? [...run.history] : [{ role: 'system', content: systemPrompt(run.cwd) }];
  messages.push({ role: 'user', content: run.prompt });
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  const count = (u: Usage) => { usage.prompt_tokens += u.prompt_tokens || 0; usage.completion_tokens += u.completion_tokens || 0; usage.total_tokens += u.total_tokens || 0; };

  for (let step = 1; step <= maxSteps; step++) {
    run.signal.throwIfAborted();
    run.onEvent({ type: 'step', step, model: run.model });
    const result = await run.client.chat({ model: run.model, messages: compactHistory(messages), tools: toolSpecs, signal: run.signal, maxTokens: 8192 });
    count(result.usage);
    messages.push(result.message);
    const text = stripThinking(result.message.content);
    const calls = result.message.tool_calls || [];
    if (!calls.length) {
      if (text) run.onEvent({ type: 'assistant', text });
      return { messages, finalText: text || '(The agent finished without a message.)', usage, steps: step };
    }
    if (text) run.onEvent({ type: 'assistant', text });
    for (const call of calls) {
      run.signal.throwIfAborted();
      const outcome = await runTool(call.function.name, call.function.arguments, { cwd: run.cwd, signal: run.signal, approve: run.approve });
      run.onEvent({ type: 'tool', tool: call.function.name, summary: outcome.summary, isError: Boolean(outcome.isError) });
      messages.push({ role: 'tool', tool_call_id: call.id, content: outcome.output });
    }
  }

  // Out of steps: ask for a summary without tools so the user still learns where things stand.
  messages.push({ role: 'user', content: 'You have reached the step limit. Stop working and summarize what you did, what is left, and how to continue.' });
  const summary = await run.client.chat({ model: run.model, messages: compactHistory(messages), signal: run.signal, maxTokens: 2048 });
  count(summary.usage);
  messages.push(summary.message);
  const finalText = stripThinking(summary.message.content) || 'Reached the step limit.';
  run.onEvent({ type: 'assistant', text: finalText });
  return { messages, finalText, usage, steps: maxSteps };
}
