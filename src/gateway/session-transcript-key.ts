import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/config.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { resolvePreferredSessionKeyForSessionIdMatches } from "../sessions/session-id-resolution.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  loadCombinedSessionStoreForGateway,
  resolveGatewaySessionStoreTarget,
  resolveSessionTranscriptCandidates,
} from "./session-utils.js";

const TRANSCRIPT_SESSION_KEY_CACHE = new Map<string, string>();
const TRANSCRIPT_SESSION_KEY_CACHE_MAX = 256;

function resolveTranscriptPathForComparison(value: string | undefined): string | undefined {
  const trimmed = normalizeOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  const resolved = path.resolve(trimmed);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

function sessionKeyMatchesTranscriptPath(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  key: string;
  targetPath: string;
}): boolean {
  const entry = params.store[params.key];
  if (!entry?.sessionId) {
    return false;
  }
  const target = resolveGatewaySessionStoreTarget({
    cfg: params.cfg,
    key: params.key,
    scanLegacyKeys: false,
    store: params.store,
  });
  const sessionAgentId = normalizeAgentId(target.agentId);
  return resolveSessionTranscriptCandidates(
    entry.sessionId,
    target.storePath,
    entry.sessionFile,
    sessionAgentId,
  ).some((candidate) => resolveTranscriptPathForComparison(candidate) === params.targetPath);
}

export function clearSessionTranscriptKeyCacheForTests(): void {
  TRANSCRIPT_SESSION_KEY_CACHE.clear();
}

export function resolveSessionKeyForTranscriptFile(sessionFile: string): string | undefined {
  const targetPath = resolveTranscriptPathForComparison(sessionFile);
  if (!targetPath) {
    return undefined;
  }
  const cfg = loadConfig();
  const { store } = loadCombinedSessionStoreForGateway(cfg);

  const cachedKey = TRANSCRIPT_SESSION_KEY_CACHE.get(targetPath);
  if (
    cachedKey &&
    sessionKeyMatchesTranscriptPath({
      cfg,
      store,
      key: cachedKey,
      targetPath,
    })
  ) {
    return cachedKey;
  }

  const matchingEntries: Array<[string, SessionEntry]> = [];
  for (const [key, entry] of Object.entries(store)) {
    if (!entry?.sessionId || key === cachedKey) {
      continue;
    }
    if (
      sessionKeyMatchesTranscriptPath({
        cfg,
        store,
        key,
        targetPath,
      })
    ) {
      matchingEntries.push([key, entry]);
    }
  }

  if (matchingEntries.length > 0) {
    const matchesBySessionId = new Map<string, Array<[string, SessionEntry]>>();
    for (const entry of matchingEntries) {
      const sessionId = entry[1].sessionId;
      if (!sessionId) {
        continue;
      }
      const group = matchesBySessionId.get(sessionId);
      if (group) {
        group.push(entry);
      } else {
        matchesBySessionId.set(sessionId, [entry]);
      }
    }

    const resolvedMatches = Array.from(matchesBySessionId.entries())
      .map(([sessionId, matches]) => {
        const resolvedKey =
          resolvePreferredSessionKeyForSessionIdMatches(matches, sessionId) ?? matches[0]?.[0];
        const resolvedEntry = resolvedKey
          ? matches.find(([key]) => key === resolvedKey)?.[1]
          : undefined;
        return resolvedKey && resolvedEntry
          ? {
              key: resolvedKey,
              updatedAt: resolvedEntry.updatedAt ?? 0,
            }
          : undefined;
      })
      .filter((match): match is { key: string; updatedAt: number } => match !== undefined);

    const sortedResolvedMatches = [...resolvedMatches].toSorted(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const [freshestMatch, secondFreshestMatch] = sortedResolvedMatches;
    const resolvedKey =
      resolvedMatches.length === 1
        ? freshestMatch?.key
        : (freshestMatch?.updatedAt ?? 0) > (secondFreshestMatch?.updatedAt ?? 0)
          ? freshestMatch?.key
          : undefined;
    if (resolvedKey) {
      // Evict oldest-inserted entry when cache exceeds size cap (FIFO bound).
      if (
        !TRANSCRIPT_SESSION_KEY_CACHE.has(targetPath) &&
        TRANSCRIPT_SESSION_KEY_CACHE.size >= TRANSCRIPT_SESSION_KEY_CACHE_MAX
      ) {
        const oldest = TRANSCRIPT_SESSION_KEY_CACHE.keys().next().value;
        if (oldest !== undefined) {
          TRANSCRIPT_SESSION_KEY_CACHE.delete(oldest);
        }
      }
      TRANSCRIPT_SESSION_KEY_CACHE.set(targetPath, resolvedKey);
      return resolvedKey;
    }
  }

  TRANSCRIPT_SESSION_KEY_CACHE.delete(targetPath);
  return undefined;
}
