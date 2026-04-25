import path from "node:path";
import { parseUsageCountedSessionIdFromFileName } from "../config/sessions/artifacts.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";

/**
 * Derive transcript stem `S` from a memory search hit path for `source === "sessions"`.
 * Builtin index uses `sessions/<basename>.jsonl`; QMD exports use `<stem>.md`.
 */
export function extractTranscriptStemFromSessionsMemoryHit(hitPath: string): string | null {
  const normalized = hitPath.replace(/\\/g, "/");
  const trimmed = normalized.startsWith("sessions/")
    ? normalized.slice("sessions/".length)
    : normalized;
  const base = path.basename(trimmed);
  if (base.endsWith(".jsonl")) {
    const stem = base.slice(0, -".jsonl".length);
    return stem || null;
  }
  if (base.endsWith(".md")) {
    const stem = base.slice(0, -".md".length);
    return stem || null;
  }
  return null;
}

/**
 * Map transcript stem to canonical session store keys (all agents in the combined store).
 * Session tools visibility and agent-to-agent policy are enforced by the caller (e.g.
 * `createSessionVisibilityGuard`), including cross-agent cases.
 */
export function resolveTranscriptStemToSessionKeys(params: {
  store: Record<string, SessionEntry>;
  stem: string;
}): string[] {
  const { store } = params;
  const matches: string[] = [];
  const stemAsFile = params.stem.endsWith(".jsonl") ? params.stem : `${params.stem}.jsonl`;
  const parsedStemId = parseUsageCountedSessionIdFromFileName(stemAsFile);

  for (const [sessionKey, entry] of Object.entries(store)) {
    const sessionFile = normalizeOptionalString(entry.sessionFile);
    if (sessionFile) {
      const base = path.basename(sessionFile);
      const fileStem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
      if (fileStem === params.stem) {
        matches.push(sessionKey);
        continue;
      }
    }
    if (entry.sessionId === params.stem || (parsedStemId && entry.sessionId === parsedStemId)) {
      matches.push(sessionKey);
    }
  }
  return [...new Set(matches)];
}
