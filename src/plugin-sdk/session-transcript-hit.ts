import path from "node:path";
import { parseUsageCountedSessionIdFromFileName } from "../config/sessions/artifacts.js";
import type { SessionEntry } from "../config/sessions/types.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";

export { loadCombinedSessionStoreForGateway } from "../config/sessions/combined-store-gateway.js";

export type SessionTranscriptHitIdentity = {
  stem: string;
  ownerAgentId?: string;
  archived: boolean;
};

function parseSessionsPath(hitPath: string): { base: string; ownerAgentId?: string } {
  const normalized = hitPath.replace(/\\/g, "/");
  const fromSessionsRoot = normalized.startsWith("sessions/")
    ? normalized.slice("sessions/".length)
    : normalized;
  const parts = fromSessionsRoot.split("/").filter(Boolean);
  const base = path.posix.basename(fromSessionsRoot);
  const ownerAgentId =
    normalized.startsWith("sessions/") && parts.length === 2
      ? normalizeAgentId(parts[0])
      : undefined;
  return { base, ownerAgentId };
}

/**
 * Derive transcript stem `S` from a memory search hit path for `source === "sessions"`.
 * Builtin index uses `sessions/<basename>.jsonl`; QMD exports use `<stem>.md`.
 * Archived transcripts (`.jsonl.reset.<iso>` / `.jsonl.deleted.<iso>`) resolve
 * to the same stem as the live `.jsonl` they were rotated from.
 */
export function extractTranscriptStemFromSessionsMemoryHit(hitPath: string): string | null {
  return extractTranscriptIdentityFromSessionsMemoryHit(hitPath)?.stem ?? null;
}

export function extractTranscriptIdentityFromSessionsMemoryHit(
  hitPath: string,
): SessionTranscriptHitIdentity | null {
  const { base, ownerAgentId } = parseSessionsPath(hitPath);
  const archivedStem = parseUsageCountedSessionIdFromFileName(base);
  if (archivedStem && base !== `${archivedStem}.jsonl`) {
    return { stem: archivedStem, ownerAgentId, archived: true };
  }
  if (base.endsWith(".jsonl")) {
    const stem = base.slice(0, -".jsonl".length);
    return stem ? { stem, ownerAgentId, archived: false } : null;
  }
  if (base.endsWith(".md")) {
    const stem = base.slice(0, -".md".length);
    return stem ? { stem, archived: false } : null;
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
  archivedOwnerAgentId?: string;
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
  const deduped = [...new Set(matches)];
  if (deduped.length > 0) {
    return deduped;
  }
  const archivedOwnerAgentId = normalizeOptionalString(params.archivedOwnerAgentId);
  return archivedOwnerAgentId
    ? [`agent:${normalizeAgentId(archivedOwnerAgentId)}:${params.stem}`]
    : [];
}
