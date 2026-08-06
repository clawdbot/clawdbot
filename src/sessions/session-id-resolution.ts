import { expectDefined } from "@openclaw/normalization-core";
// Session id resolution helpers resolve user-provided session references.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { SessionEntry } from "../config/sessions.js";
import { toAgentRequestSessionKey } from "../routing/session-key.js";

// Session-id matching resolves fuzzy CLI/user input against store keys while
// avoiding silent picks when multiple plausible sessions tie.
type SessionIdMatch = [string, SessionEntry];
type NormalizedSessionIdMatch = {
  sessionKey: string;
  entry: SessionEntry;
  normalizedSessionKey: string;
  normalizedRequestKey: string;
  isCanonicalSessionKey: boolean;
  isStructural: boolean;
};

type SessionIdMatchSelection =
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
      return expectDefined(group[0], "normalized session id match");
    }
    // Aliases that normalize to the same request key represent one session.
    // Prefer freshest canonical key so ambiguity only reports distinct sessions.
    const sorted = [...group].toSorted((a, b) => {
      const timeDiff = compareNormalizedUpdatedAtDescending(a, b);
      if (timeDiff !== 0) {
        return timeDiff;
      }
      if (a.isCanonicalSessionKey !== b.isCanonicalSessionKey) {
        return a.isCanonicalSessionKey ? -1 : 1;
      }
      return compareStoreKeys(a.normalizedSessionKey, b.normalizedSessionKey);
    });
    return expectDefined(sorted[0], "freshest normalized session id match");
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

// Selection contract: structural suffix/request-key matches beat fuzzy matches;
// tied structural or fuzzy matches stay ambiguous for caller-visible errors.
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
    return {
      kind: "selected",
      sessionKey: expectDefined(canonicalMatches[0], "canonical matches capture group 0")
        .sessionKey,
    };
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
