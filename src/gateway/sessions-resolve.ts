import { expectDefined } from "@openclaw/normalization-core";
// Gateway sessions.resolve implementation helper.
// Resolves key/sessionId/label/shortId selectors into one canonical session key.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsResolveCandidate,
  type SessionsResolveParams,
} from "../../packages/gateway-protocol/src/index.js";
import {
  controlUiSessionSlug,
  SESSION_UUID_SUFFIX_RE,
  SHORT_SESSION_ID_RE,
} from "../../packages/session-url-contract/src/index.js";
import { listAgentIds } from "../agents/agent-scope.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import { hasOperatorBoundary } from "./operator-role-policy.js";
import type { GatewayClient } from "./server-methods/types.js";
import { resolveRequestedSessionAgentId } from "./session-request-agent.js";
import { prepareSessionSharing } from "./session-sharing.js";
import { resolveSessionStoreKey } from "./session-store-key.js";
import type { SessionListRowContext } from "./session-utils-contracts.js";
import { resolveGatewaySessionDisplayName } from "./session-utils-display.js";
import { buildSessionListRowMetadataContext } from "./session-utils-projection.js";
import {
  filterAndSortSessionEntries,
  loadCombinedSessionStoreForGatewayCore,
  resolveDeletedAgentIdFromSessionKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";

export type SessionsResolveResult =
  | ({ ok: true } & SessionsResolveCandidate)
  | { ok: true; missing: true }
  | { ok: true; ambiguous: true; candidates: SessionsResolveCandidate[] }
  | { ok: false; error: ErrorShape };

function resolveSessionVisibilityFilterOptions(p: SessionsResolveParams) {
  return {
    includeGlobal: p.includeGlobal === true,
    includeUnknown: p.includeUnknown === true,
    spawnedBy: p.spawnedBy,
    agentId: p.agentId,
  };
}

function noSessionFoundResult(params: { p: SessionsResolveParams; message: string }) {
  if (params.p.allowMissing) {
    return { ok: true, missing: true } as const;
  }
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, params.message),
  } as const;
}

/** Rejects sessions whose owning agent no longer exists in config (#65524). */
function validateSessionAgentExists(
  cfg: OpenClawConfig,
  key: string,
  entry?: SessionEntry | null,
  options?: { acpMetadataSessionKey?: string | null },
): SessionsResolveResult | null {
  const deletedAgentId = resolveDeletedAgentIdFromSessionKey(cfg, key, entry, options);
  if (deletedAgentId === null) {
    return null;
  }
  return {
    ok: false,
    error: errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Agent "${deletedAgentId}" no longer exists in configuration`,
    ),
  };
}

function isResolvedSessionKeyVisible(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
  store: Record<string, SessionEntry>;
  key: string;
}) {
  if (typeof params.p.spawnedBy !== "string" || params.p.spawnedBy.trim().length === 0) {
    return true;
  }
  return filterAndSortSessionEntries({
    cfg: params.cfg,
    store: params.store,
    now: Date.now(),
    opts: resolveSessionVisibilityFilterOptions(params.p),
  }).some(([key]) => key === params.key);
}

function findVisibleSessionIdMatches(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  p: SessionsResolveParams;
  sessionId: string;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
}): Array<[string, SessionEntry]> {
  return filterAndSortSessionEntries({
    cfg: params.cfg,
    store: params.store,
    now: Date.now(),
    opts: resolveSessionVisibilityFilterOptions(params.p),
  }).filter(
    ([key, entry]) =>
      (params.entryFilter?.(key, entry) ?? true) &&
      (entry?.sessionId === params.sessionId || key === params.sessionId),
  );
}

function normalizeShortSessionId(shortId: string): string | null {
  return SHORT_SESSION_ID_RE.test(shortId) ? shortId.toLowerCase() : null;
}

function sessionResolveCandidate(
  key: string,
  entry: SessionEntry,
  agentId: string,
): SessionsResolveCandidate {
  const displayName = resolveGatewaySessionDisplayName(key, entry);
  return {
    key,
    agentId: normalizeAgentId(agentId),
    ...(displayName ? { displayName } : {}),
    ...(entry.boardFace ? { boardFace: entry.boardFace } : {}),
  };
}

function findVisibleShortIdMatches(params: {
  cfg: OpenClawConfig;
  store: Record<string, SessionEntry>;
  p: SessionsResolveParams;
  shortId: string;
  entryFilter?: (key: string, entry: SessionEntry) => boolean;
}): SessionsResolveCandidate[] {
  const now = Date.now();
  const entries = filterAndSortSessionEntries({
    cfg: params.cfg,
    store: params.store,
    now,
    opts: { ...resolveSessionVisibilityFilterOptions(params.p), archived: "all" },
  });
  return entries.flatMap(([key, entry]) => {
    if (params.entryFilter && !params.entryFilter(key, entry)) {
      return [];
    }
    const parsed = parseAgentSessionKey(key);
    const uuid = parsed?.rest.match(SESSION_UUID_SUFFIX_RE)?.[1];
    if (!parsed || !uuid?.toLowerCase().replaceAll("-", "").startsWith(params.shortId)) {
      return [];
    }
    if (resolveDeletedAgentIdFromSessionKey(params.cfg, key, entry) !== null) {
      return [];
    }
    return [sessionResolveCandidate(key, entry, parsed.agentId)];
  });
}

export async function resolveSessionKeyFromResolveParams(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  p: SessionsResolveParams;
}): Promise<SessionsResolveResult> {
  const { cfg, client, p } = params;
  const { entryFilter } = prepareSessionSharing({ client, cfg });

  const key = normalizeOptionalString(p.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeOptionalString(p.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasLabel = (normalizeOptionalString(p.label) ?? "").length > 0;
  const rawShortId = normalizeOptionalString(p.shortId) ?? "";
  const hasShortId = rawShortId.length > 0;
  const hasReference = p.reference !== undefined;
  const hasSlugHint = p.slugHint !== undefined;
  if (hasSlugHint && !hasShortId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "slugHint requires shortId"),
    };
  }
  const selectionCount = [hasKey, hasSessionId, hasLabel, hasShortId, hasReference].filter(
    Boolean,
  ).length;
  if (selectionCount > 1) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Provide either key, sessionId, label, shortId, or reference (not multiple)",
      ),
    };
  }
  if (selectionCount === 0) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Either key, sessionId, label, shortId, or reference is required",
      ),
    };
  }

  if (p.reference) {
    const referenceKey = normalizeSessionKeyPreservingOpaquePeerIds(p.reference.key);
    const parsed = parseAgentSessionKey(referenceKey);
    const sameAgent = !p.agentId || !parsed || parsed.agentId === normalizeAgentId(p.agentId);
    const exactKey = sameAgent
      ? resolveSessionStoreKey({ cfg, sessionKey: referenceKey, storeAgentId: p.agentId })
      : referenceKey;
    const { store, targetsBySessionKey } = loadCombinedSessionStoreForGatewayCore(cfg, {
      agentId: p.agentId,
      configuredAgentsOnly: true,
      projection: "list",
    });
    // URL references are discovery, including exact keys. Keep hidden rows out
    // before choosing a winner; the separate key selector retains its read contract.
    const entries = filterAndSortSessionEntries({
      cfg,
      store,
      entryFilter,
      now: Date.now(),
      opts: { ...resolveSessionVisibilityFilterOptions(p), archived: "all" },
    }).filter(
      ([candidateKey, entry]) =>
        resolveDeletedAgentIdFromSessionKey(cfg, candidateKey, entry) === null,
    );
    const candidate = ([candidateKey, entry]: [string, SessionEntry]) =>
      sessionResolveCandidate(
        candidateKey,
        entry,
        expectDefined(targetsBySessionKey.get(candidateKey), "reference session agent").agentId,
      );
    const exact = entries.find(
      ([candidateKey]) => normalizeSessionKeyPreservingOpaquePeerIds(candidateKey) === exactKey,
    );
    if (exact) {
      return { ok: true, ...candidate(exact) };
    }
    const slug = normalizeOptionalString(p.reference.slug);
    const matches = slug
      ? entries
          .filter(
            ([candidateKey, entry]) =>
              SESSION_UUID_SUFFIX_RE.test(parseAgentSessionKey(candidateKey)?.rest ?? "") &&
              controlUiSessionSlug(resolveGatewaySessionDisplayName(candidateKey, entry)) === slug,
          )
          .slice(0, 10)
          .map(candidate)
      : [];
    if (matches.length > 1) {
      return { ok: true, ambiguous: true, candidates: matches };
    }
    const selected = matches[0];
    return selected
      ? { ok: true, ...selected }
      : noSessionFoundResult({ p, message: `No session found: ${p.reference.key}` });
  }

  if (hasKey) {
    // Exact-key lookup follows the proof-of-knowledge read semantics of get/describe/history;
    // only discovery selectors use list visibility. Incognito keys are gated pre-dispatch.
    const requestedAgent = resolveRequestedSessionAgentId(cfg, key, p.agentId);
    if (!requestedAgent.ok) {
      return requestedAgent;
    }
    const target = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key,
      clone: false,
      projection: "list",
      ...(requestedAgent.agentId ? { agentId: requestedAgent.agentId } : {}),
    });
    const store = target.store;
    const entry = store[target.canonicalKey];
    if (entry) {
      if (
        (hasOperatorBoundary(client, cfg) && entryFilter?.(target.canonicalKey, entry) === false) ||
        !isResolvedSessionKeyVisible({
          cfg,
          p,
          store,
          key: target.canonicalKey,
        })
      ) {
        return noSessionFoundResult({ p, message: `No session found: ${key}` });
      }
      const agentCheck = validateSessionAgentExists(cfg, target.canonicalKey, entry, {
        acpMetadataSessionKey: target.canonicalKey,
      });
      if (agentCheck) {
        return agentCheck;
      }
      return { ok: true, key: target.canonicalKey, agentId: requestedAgent.agentId };
    }
    return noSessionFoundResult({ p, message: `No session found: ${key}` });
  }

  if (hasSessionId) {
    if (!p.agentId) {
      const ownerTaggedMatches = new Map<
        string,
        { agentId: string; entry: SessionEntry; key: string }
      >();
      for (const agentId of listAgentIds(cfg)) {
        const loaded = loadCombinedSessionStoreForGatewayCore(cfg, {
          agentId,
          projection: "list",
        });
        const agentMatches = findVisibleSessionIdMatches({
          cfg,
          store: loaded.store,
          p: { ...p, agentId },
          sessionId,
          entryFilter,
        });
        const agentSelection = resolveSessionIdMatchSelection(agentMatches, sessionId);
        if (agentSelection.kind === "ambiguous") {
          return {
            ok: false,
            error: errorShape(
              ErrorCodes.INVALID_REQUEST,
              `Multiple sessions found for sessionId: ${sessionId} (${agentSelection.sessionKeys.join(", ")})`,
            ),
          };
        }
        if (agentSelection.kind === "selected") {
          const entry = agentMatches.find(
            ([matchKey]) => matchKey === agentSelection.sessionKey,
          )?.[1];
          const owner = resolveRequestedSessionAgentId(cfg, agentSelection.sessionKey, agentId);
          if (entry && owner.ok) {
            ownerTaggedMatches.set(`${owner.agentId}\0${agentSelection.sessionKey}`, {
              agentId: owner.agentId,
              entry,
              key: agentSelection.sessionKey,
            });
          }
        }
      }
      if (ownerTaggedMatches.size > 1) {
        return {
          ok: false,
          error: errorShape(
            ErrorCodes.INVALID_REQUEST,
            `Multiple sessions found for sessionId: ${sessionId} (${[...ownerTaggedMatches.values()]
              .map((match) => `${match.agentId}:${match.key}`)
              .join(", ")})`,
          ),
        };
      }
      const ownerTaggedMatch = ownerTaggedMatches.values().next().value;
      if (ownerTaggedMatch) {
        const agentCheck = validateSessionAgentExists(
          cfg,
          ownerTaggedMatch.key,
          ownerTaggedMatch.entry,
        );
        return (
          agentCheck ?? {
            ok: true,
            key: ownerTaggedMatch.key,
            agentId: ownerTaggedMatch.agentId,
          }
        );
      }
    }
    const { store } = loadCombinedSessionStoreForGatewayCore(cfg, {
      agentId: p.agentId,
      projection: "list",
    });
    const matches = findVisibleSessionIdMatches({ cfg, store, p, sessionId, entryFilter });
    const selection = resolveSessionIdMatchSelection(matches, sessionId);
    if (selection.kind === "none") {
      return noSessionFoundResult({ p, message: `No session found: ${sessionId}` });
    }
    if (selection.kind === "ambiguous") {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found for sessionId: ${sessionId} (${selection.sessionKeys.join(", ")})`,
        ),
      };
    }
    const selectedEntry = matches.find(([matchKey]) => matchKey === selection.sessionKey)?.[1];
    let selectedAgentId = parseAgentSessionKey(selection.sessionKey)?.agentId ?? p.agentId;
    if (!selectedAgentId) {
      const resolvedOwner = resolveRequestedSessionAgentId(cfg, selection.sessionKey);
      if (!resolvedOwner.ok) {
        return resolvedOwner;
      }
      selectedAgentId = resolvedOwner.agentId;
    }
    const agentCheckSessionId = validateSessionAgentExists(
      cfg,
      selection.sessionKey,
      selectedEntry,
    );
    if (agentCheckSessionId) {
      return agentCheckSessionId;
    }
    return { ok: true, key: selection.sessionKey, agentId: selectedAgentId };
  }

  if (hasShortId) {
    const shortId = normalizeShortSessionId(rawShortId);
    if (!shortId) {
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          "shortId must be 8-32 hexadecimal characters",
        ),
      };
    }
    const { store } = loadCombinedSessionStoreForGatewayCore(cfg, {
      agentId: p.agentId,
      projection: "list",
    });
    const matches = findVisibleShortIdMatches({
      cfg,
      store,
      p,
      shortId,
      entryFilter,
    });
    const slugHint = normalizeOptionalString(p.slugHint);
    const slugMatches = slugHint
      ? matches.filter((candidate) => controlUiSessionSlug(candidate.displayName) === slugHint)
      : [];
    // A stale display-name hint may narrow a tie, but it must never invalidate the id.
    const narrowed = slugMatches.length > 0 ? slugMatches : matches;
    if (narrowed.length === 0) {
      return noSessionFoundResult({ p, message: `No session found: ${shortId}` });
    }
    if (narrowed.length > 1) {
      // Bound the ambiguity payload; callers treat a full ten rows as possibly truncated.
      return { ok: true, ambiguous: true, candidates: narrowed.slice(0, 10) };
    }
    const selected = expectDefined(narrowed[0], "short session match at 0");
    return { ok: true, ...selected };
  }

  const parsedLabel = parseSessionLabel(p.label);
  if (!parsedLabel.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error),
    };
  }

  const { store, targetsBySessionKey } = loadCombinedSessionStoreForGatewayCore(cfg, {
    agentId: p.agentId,
    projection: "list",
  });
  const now = Date.now();
  // Keep list-discovery snapshot semantics without hydrating display rows.
  let rowContext: SessionListRowContext | undefined;
  const matches = filterAndSortSessionEntries({
    cfg,
    ...(entryFilter ? { entryFilter } : {}),
    store,
    now,
    getRowContext: () => (rowContext ??= buildSessionListRowMetadataContext({ now })),
    opts: {
      ...resolveSessionVisibilityFilterOptions(p),
      label: parsedLabel.label,
      limit: 2,
    },
  });
  if (matches.length === 0) {
    return noSessionFoundResult({
      p,
      message: `No session found with label: ${parsedLabel.label}`,
    });
  }
  if (matches.length > 1) {
    const keys = matches.map(([matchKey]) => matchKey).join(", ");
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Multiple sessions found with label: ${parsedLabel.label} (${keys})`,
      ),
    };
  }

  const [labelKey, labelEntry] = expectDefined(matches[0], "label session match at 0");
  const agentCheckLabel = validateSessionAgentExists(cfg, labelKey, labelEntry);
  if (agentCheckLabel) {
    return agentCheckLabel;
  }
  return {
    ok: true,
    key: labelKey,
    agentId: expectDefined(targetsBySessionKey.get(labelKey), "label session agent").agentId,
  };
}
