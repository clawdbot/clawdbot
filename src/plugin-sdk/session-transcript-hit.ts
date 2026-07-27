// Session transcript hit helpers describe and load matched transcript snippets for plugins.
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { normalizeOptionalString } from "../../packages/normalization-core/src/string-coerce.js";
import { uniqueStrings } from "../../packages/normalization-core/src/string-normalization.js";
import { parseUsageCountedSessionIdFromFileName } from "../config/sessions/artifacts.js";
import { loadCombinedSessionStoreForGateway as loadGatewaySessionStore } from "../config/sessions/combined-store-gateway.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isIncognitoSessionKey, normalizeAgentId } from "../routing/session-key.js";
export {
  formatSessionTranscriptMemoryHitKey,
  parseSessionTranscriptMemoryHitKey,
  resolveSessionTranscriptMemoryHitKeyToSessionKeys,
} from "./session-transcript-memory-hit.js";
export type {
  ResolveSessionTranscriptMemoryHitKeyParams,
  SessionTranscriptIdentity,
  SessionTranscriptMemoryHitIdentity,
  SessionTranscriptMemoryHitKey,
  SessionTranscriptMemoryHitKeyParams,
  SessionTranscriptReadParams,
} from "./session-transcript-memory-hit.js";

/** Loads the cross-session plugin view without process-only incognito rows. */
export function loadCombinedSessionStoreForGateway(
  cfg: OpenClawConfig,
  opts: { agentId?: string; configuredAgentsOnly?: boolean } = {},
) {
  const result = loadGatewaySessionStore(cfg, { ...opts, includeIncognito: false });
  return {
    storePath: result.storePath,
    // Plugin search hits can be re-persisted into durable transcripts, so the
    // SDK cross-session view must never expose incognito content.
    store: Object.fromEntries(
      Object.entries(result.store).filter(([sessionKey]) => !isIncognitoSessionKey(sessionKey)),
    ),
  };
}

const QMD_ARCHIVE_STEM_RE = /^(.+)-jsonl-(reset|deleted)-(.+)$/;
const QMD_ARCHIVE_TIMESTAMP_RE =
  /^(\d{4}-\d{2}-\d{2})[tT](\d{2}-\d{2}-\d{2})(?:(?:\.|-)(\d{3}))?[zZ]$/;

function restoreQmdNormalizedArchiveTimestamp(timestamp: string): string | null {
  const match = QMD_ARCHIVE_TIMESTAMP_RE.exec(timestamp);
  if (!match) {
    return null;
  }
  const [, date, time, milliseconds] = match;
  return `${date}T${time}${milliseconds ? `.${milliseconds}` : ""}Z`;
}

function restoreQmdNormalizedArchiveName(mdStem: string): string | null {
  const match = QMD_ARCHIVE_STEM_RE.exec(mdStem);
  if (!match) {
    return null;
  }
  const [, sessionId, reason, timestamp] = match;
  const restoredTimestamp = restoreQmdNormalizedArchiveTimestamp(
    expectDefined(timestamp, "session transcript hit timestamp"),
  );
  return restoredTimestamp ? `${sessionId}.jsonl.${reason}.${restoredTimestamp}` : null;
}

function normalizeQmdSessionStem(stem: string): string {
  return stem
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Canonical session identity parsed from a transcript search-hit path. */
export type SessionTranscriptHitIdentity = {
  stem: string;
  liveStem?: string;
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

/** Parse live/archive ownership metadata from a sessions-memory hit path. */
export function extractTranscriptIdentityFromSessionsMemoryHit(
  hitPath: string,
): SessionTranscriptHitIdentity | null {
  const isQmdPath = hitPath.replace(/\\/g, "/").startsWith("qmd/");
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
    const mdStem = base.slice(0, -".md".length);
    if (!mdStem) {
      return null;
    }
    if (isQmdPath) {
      const exportedArchiveStem = parseUsageCountedSessionIdFromFileName(mdStem);
      if (exportedArchiveStem && mdStem !== `${exportedArchiveStem}.jsonl`) {
        return { stem: exportedArchiveStem, liveStem: mdStem, ownerAgentId, archived: true };
      }
      const restoredArchiveName = restoreQmdNormalizedArchiveName(mdStem);
      if (restoredArchiveName) {
        const archivedStemLocal = parseUsageCountedSessionIdFromFileName(restoredArchiveName);
        if (archivedStemLocal && restoredArchiveName !== `${archivedStemLocal}.jsonl`) {
          return { stem: archivedStemLocal, liveStem: mdStem, ownerAgentId, archived: true };
        }
      }
    }
    return { stem: mdStem, ownerAgentId, archived: false };
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
  allowQmdSlugFallback?: boolean;
}): string[] {
  const { store } = params;
  const matches: string[] = [];
  const stemAsFile = params.stem.endsWith(".jsonl") ? params.stem : `${params.stem}.jsonl`;
  const parsedStemId = parseUsageCountedSessionIdFromFileName(stemAsFile);

  for (const [sessionKey, entry] of Object.entries(store)) {
    if (isIncognitoSessionKey(sessionKey)) {
      continue;
    }
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
  const deduped = uniqueStrings(matches);
  if (deduped.length > 0) {
    return deduped;
  }
  const normalizedStem = normalizeQmdSessionStem(params.stem);
  if (params.allowQmdSlugFallback === true && normalizedStem) {
    for (const [sessionKey, entry] of Object.entries(store)) {
      if (isIncognitoSessionKey(sessionKey)) {
        continue;
      }
      const sessionFile = normalizeOptionalString(entry.sessionFile);
      if (sessionFile) {
        const base = path.basename(sessionFile);
        const fileStem = base.endsWith(".jsonl") ? base.slice(0, -".jsonl".length) : base;
        if (normalizeQmdSessionStem(fileStem) === normalizedStem) {
          matches.push(sessionKey);
          continue;
        }
      }
      const entrySessionId = normalizeOptionalString(entry.sessionId);
      if (entrySessionId && normalizeQmdSessionStem(entrySessionId) === normalizedStem) {
        matches.push(sessionKey);
      }
    }
  }
  const normalizedDeduped = uniqueStrings(matches);
  if (normalizedDeduped.length > 0) {
    return normalizedDeduped.length === 1 ? normalizedDeduped : [];
  }
  const archivedOwnerAgentId = normalizeOptionalString(params.archivedOwnerAgentId);
  if (!archivedOwnerAgentId) {
    return [];
  }
  const fallbackKey = `agent:${normalizeAgentId(archivedOwnerAgentId)}:${params.stem}`;
  return isIncognitoSessionKey(fallbackKey) ? [] : [fallbackKey];
}
