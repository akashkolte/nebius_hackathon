// Deterministic, offline routing: ranks existing sessions by word overlap and recency.
// Used for previews and whenever the Nebius router is unavailable or unsure.
import type { Session } from './sessions.ts';
import type { Harness } from './models.ts';

const stop = new Set('a an the and or to for of in on at with from it this that i you we my our your please can could would should task project code app make build add fix update work session into through use using'.split(' '));

export function tokens(value: unknown): string[] {
  return [...new Set(String(value || '').toLowerCase().match(/[a-z0-9]{3,}/g)?.filter(x => !stop.has(x)) || [])];
}

export type Ranked = { session: Session; score: number; reason: string };

export function rankSessions(prompt: string, sessions: Session[], harness: Harness | 'auto' = 'auto', now = Date.now()): Ranked[] {
  const words = tokens(prompt);
  return sessions.filter(s => harness === 'auto' || s.harness === harness).map(session => {
    const titleWords = new Set(tokens(session.title));
    const recentWords = new Set(tokens(session.lastPrompt));
    const pathWords = new Set(tokens(session.cwd.replaceAll('/', ' ')));
    const titleHits = words.filter(w => titleWords.has(w));
    const recentHits = words.filter(w => recentWords.has(w));
    const pathHits = words.filter(w => pathWords.has(w));
    const ageDays = Math.max(0, (now - Date.parse(session.updatedAt)) / 86400000);
    const score = titleHits.length * 4 + recentHits.length * 2 + pathHits.length * 3 + Math.max(0, 2 - Math.log2(ageDays + 1));
    const reason = titleHits.length ? `Matches ${titleHits.slice(0, 3).join(', ')} in the session topic`
      : recentHits.length ? `Matches ${recentHits.slice(0, 3).join(', ')} in the recent conversation`
      : pathHits.length ? `Matches ${pathHits.slice(0, 3).join(', ')} in the project` : 'Recent session';
    return { session, score, reason };
  }).sort((a, b) => b.score - a.score);
}

export type LocalRoute = { session: Session | null; harness?: Harness; reason: string };

export function chooseRoute(prompt: string, sessions: Session[], harness: Harness | 'auto', sessionId: string | null, fallbackHarness: Harness): LocalRoute {
  if (sessionId) {
    const session = sessions.find(s => s.id === sessionId);
    if (!session) throw new Error('That session is no longer available.');
    return { session, reason: 'Sent to the session you selected' };
  }
  const ranked = rankSessions(prompt, sessions, harness);
  if (ranked[0]?.score >= 6) return { session: ranked[0].session, reason: ranked[0].reason };
  return { session: null, harness: harness === 'auto' ? fallbackHarness : harness, reason: 'Starting a fresh session because no existing topic matched closely' };
}
