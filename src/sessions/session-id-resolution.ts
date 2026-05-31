import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";

type SessionIdMatch = [string, SessionEntry];
type NormalizedSessionIdMatch = {
  sessionKey: string;
  entry: SessionEntry;
  normalizedSessionKey: string;
  normalizedRequestKey: string;
  isCanonicalSessionKey: boolean;
  isStructural: boolean;
};

export type SessionIdMatchSelection =
  | { kind: "none" }
  | { kind: "ambiguous"; sessionKeys: string[] }
  | { kind: "selected"; sessionKey: string };

function compareNormalizedUpdatedAtDescending(
  a: NormalizedSessionIdMatch,
  b: NormalizedSessionIdMatch,
): number {
  return (b.entry?.updatedAt ?? 0) - (a.entry?.updatedAt ?? 0);
}

function compareStoreKeys(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function normalizeSessionIdMatches(
  matches: SessionIdMatch[],
  normalizedSessionId: string,
): NormalizedSessionIdMatch[] {
  return matches.map(([sessionKey, entry]) => {
    const normalizedSessionKey = normalizeLowercaseStringOrEmpty(sessionKey);
    const normalizedRequestKey = normalizeLowercaseStringOrEmpty(
      toAgentRequestSessionKey(sessionKey) ?? sessionKey,
    );
    return {
      sessionKey,
      entry,
      normalizedSessionKey,
      normalizedRequestKey,
      isCanonicalSessionKey: sessionKey === normalizedSessionKey,
      isStructural:
        normalizedSessionKey.endsWith(`:${normalizedSessionId}`) ||
        normalizedRequestKey === normalizedSessionId ||
        normalizedRequestKey.endsWith(`:${normalizedSessionId}`),
    };
  });
}

function collapseAliasMatches(matches: NormalizedSessionIdMatch[]): NormalizedSessionIdMatch[] {
  const grouped = new Map<string, NormalizedSessionIdMatch[]>();
  for (const match of matches) {
    const bucket = grouped.get(match.normalizedRequestKey);
    if (bucket) {
      bucket.push(match);
    } else {
      grouped.set(match.normalizedRequestKey, [match]);
    }
  }

  return Array.from(grouped.values(), (group) => {
    if (group.length === 1) {
      return group[0];
    }
    return [...group].toSorted((a, b) => {
      const timeDiff = compareNormalizedUpdatedAtDescending(a, b);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      if (a.isCanonicalSessionKey !== b.isCanonicalSessionKey) {
        return a.isCanonicalSessionKey ? -1 : 1;
      }
      return compareStoreKeys(a.normalizedSessionKey, b.normalizedSessionKey);
    })[0];
  });
}

function selectFreshestUniqueMatch(
  matches: NormalizedSessionIdMatch[],
): NormalizedSessionIdMatch | undefined {
  if (matches.length === 1) {
    return matches[0];
  }
  const sortedMatches = [...matches].toSorted(compareNormalizedUpdatedAtDescending);
  const [freshest, secondFreshest] = sortedMatches;
  if ((freshest?.entry?.updatedAt ?? 0) > (secondFreshest?.entry?.updatedAt ?? 0)) {
    return freshest;
  }
  return undefined;
}

export function resolveSessionIdMatchSelection(
  matches: Array<[string, SessionEntry]>,
  sessionId: string,
): SessionIdMatchSelection {
  if (matches.length === 0) {
    return { kind: "none" };
  }

  const canonicalMatches = collapseAliasMatches(
    normalizeSessionIdMatches(matches, normalizeLowercaseStringOrEmpty(sessionId)),
  );
  if (canonicalMatches.length === 1) {
    return { kind: "selected", sessionKey: canonicalMatches[0].sessionKey };
  }

  const structuralMatches = canonicalMatches.filter((match) => match.isStructural);
  const selectedStructuralMatch = selectFreshestUniqueMatch(structuralMatches);
  if (selectedStructuralMatch) {
    return { kind: "selected", sessionKey: selectedStructuralMatch.sessionKey };
  }
  if (structuralMatches.length > 1) {
    return { kind: "ambiguous", sessionKeys: structuralMatches.map((match) => match.sessionKey) };
  }

  const selectedCanonicalMatch = selectFreshestUniqueMatch(canonicalMatches);
  if (selectedCanonicalMatch) {
    return { kind: "selected", sessionKey: selectedCanonicalMatch.sessionKey };
  }

  return { kind: "ambiguous", sessionKeys: canonicalMatches.map((match) => match.sessionKey) };
}

export function resolvePreferredSessionKeyForSessionIdMatches(
  matches: Array<[string, SessionEntry]>,
  sessionId: string,
): string | undefined {
  const selection = resolveSessionIdMatchSelection(matches, sessionId);
  return selection.kind === "selected" ? selection.sessionKey : undefined;
}
