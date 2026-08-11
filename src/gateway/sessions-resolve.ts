import { expectDefined } from "@openclaw/normalization-core";
// Gateway sessions.resolve implementation helper.
// Resolves key/sessionId/label/shortId selectors into one canonical session key.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsResolveParams,
} from "../../packages/gateway-protocol/src/index.js";
import {
  controlUiSessionSlug,
  SESSION_UUID_SUFFIX_RE,
  SHORT_SESSION_ID_RE,
} from "../../packages/session-url-contract/src/index.js";
import type { SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import type { GatewayClient } from "./server-methods/types.js";
import { createSessionListEntryFilter } from "./session-sharing.js";
import {
  buildGatewaySessionInfo,
  filterAndSortSessionEntries,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  resolveDeletedAgentIdFromSessionKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";

type SessionsResolveCandidate = { key: string; displayName?: string };

export type SessionsResolveResult =
  | { ok: true; key: string }
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
  const now = Date.now();
  const entries = filterAndSortSessionEntries({
    cfg: params.cfg,
    store: params.store,
    now,
    opts: resolveSessionVisibilityFilterOptions(params.p),
  });
  return entries.filter(
    ([key, entry]) =>
      (params.entryFilter?.(key, entry) ?? true) &&
      (entry?.sessionId === params.sessionId || key === params.sessionId),
  );
}

function normalizeShortSessionId(shortId: string): string | null {
  return SHORT_SESSION_ID_RE.test(shortId) ? shortId.toLowerCase() : null;
}

function findVisibleShortIdMatches(params: {
  cfg: OpenClawConfig;
  storePath: string;
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
    const uuid = parseAgentSessionKey(key)?.rest.match(SESSION_UUID_SUFFIX_RE)?.[1];
    if (!uuid?.toLowerCase().replaceAll("-", "").startsWith(params.shortId)) {
      return [];
    }
    if (resolveDeletedAgentIdFromSessionKey(params.cfg, key, entry) !== null) {
      return [];
    }
    const row = buildGatewaySessionInfo({
      cfg: params.cfg,
      storePath: params.storePath,
      store: params.store,
      key,
      entry,
      now,
    });
    return [{ key, ...(row.displayName ? { displayName: row.displayName } : {}) }];
  });
}

export async function resolveSessionKeyFromResolveParams(params: {
  cfg: OpenClawConfig;
  client: GatewayClient | null;
  p: SessionsResolveParams;
}): Promise<SessionsResolveResult> {
  const { cfg, client, p } = params;
  const entryFilter = createSessionListEntryFilter({ client });

  const key = normalizeOptionalString(p.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeOptionalString(p.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasLabel = (normalizeOptionalString(p.label) ?? "").length > 0;
  const rawShortId = normalizeOptionalString(p.shortId) ?? "";
  const hasShortId = rawShortId.length > 0;
  const hasSlugHint = p.slugHint !== undefined;
  if (hasSlugHint && !hasShortId) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "slugHint requires shortId"),
    };
  }
  const selectionCount = [hasKey, hasSessionId, hasLabel, hasShortId].filter(Boolean).length;
  if (selectionCount > 1) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Provide either key, sessionId, label, or shortId (not multiple)",
      ),
    };
  }
  if (selectionCount === 0) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Either key, sessionId, label, or shortId is required",
      ),
    };
  }

  if (hasKey) {
    // Exact-key lookup follows the proof-of-knowledge read semantics of get/describe/history;
    // only discovery selectors use list visibility. Incognito keys are gated pre-dispatch.
    const target = resolveGatewaySessionStoreTargetWithStore({ cfg, key, clone: false });
    const store = target.store;
    if (store[target.canonicalKey]) {
      if (
        !isResolvedSessionKeyVisible({
          cfg,
          p,
          store,
          key: target.canonicalKey,
        })
      ) {
        return noSessionFoundResult({ p, message: `No session found: ${key}` });
      }
      const agentCheck = validateSessionAgentExists(
        cfg,
        target.canonicalKey,
        store[target.canonicalKey],
        { acpMetadataSessionKey: target.canonicalKey },
      );
      if (agentCheck) {
        return agentCheck;
      }
      return { ok: true, key: target.canonicalKey };
    }
    return noSessionFoundResult({ p, message: `No session found: ${key}` });
  }

  if (hasSessionId) {
    // sessionId can collide across stores; delegate selection so exact key
    // matches and ambiguity rules stay shared with other session-id callers.
    const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
    const matches = findVisibleSessionIdMatches({ cfg, store, p, sessionId, entryFilter });
    const selection = resolveSessionIdMatchSelection(matches, sessionId);
    if (selection.kind === "none") {
      return noSessionFoundResult({ p, message: `No session found: ${sessionId}` });
    }
    if (selection.kind === "ambiguous") {
      const keys = selection.sessionKeys.join(", ");
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found for sessionId: ${sessionId} (${keys})`,
        ),
      };
    }
    const selectedEntry = matches.find(([matchKey]) => matchKey === selection.sessionKey)?.[1];
    const agentCheckSessionId = validateSessionAgentExists(
      cfg,
      selection.sessionKey,
      selectedEntry,
    );
    if (agentCheckSessionId) {
      return agentCheckSessionId;
    }
    return { ok: true, key: selection.sessionKey };
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
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
    const matches = findVisibleShortIdMatches({
      cfg,
      storePath,
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
    return { ok: true, key: selected.key };
  }

  const parsedLabel = parseSessionLabel(p.label);
  if (!parsedLabel.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error),
    };
  }

  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
  const list = listSessionsFromStore({
    cfg,
    ...(entryFilter ? { entryFilter } : {}),
    storePath,
    store,
    lightweightListRows: true,
    opts: {
      includeGlobal: p.includeGlobal === true,
      includeUnknown: p.includeUnknown === true,
      label: parsedLabel.label,
      agentId: p.agentId,
      spawnedBy: p.spawnedBy,
      limit: 2,
    },
  });
  if (list.sessions.length === 0) {
    return noSessionFoundResult({
      p,
      message: `No session found with label: ${parsedLabel.label}`,
    });
  }
  if (list.sessions.length > 1) {
    const keys = list.sessions.map((session) => session.key).join(", ");
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `Multiple sessions found with label: ${parsedLabel.label} (${keys})`,
      ),
    };
  }

  const labelKey = expectDefined(list.sessions[0], "sessions entry at 0").key;
  const agentCheckLabel = validateSessionAgentExists(cfg, labelKey, store[labelKey]);
  if (agentCheckLabel) {
    return agentCheckLabel;
  }
  return {
    ok: true,
    key: labelKey,
  };
}
