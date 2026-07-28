import { expectDefined } from "@openclaw/normalization-core";
// Gateway sessions.resolve implementation helper.
// Resolves key/sessionId/label selectors into one canonical session key.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsResolveParams,
} from "../../packages/gateway-protocol/src/index.js";
import { canonicalizeSessionEntryAliases, type SessionEntry } from "../config/sessions.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveSessionIdMatchSelection } from "../sessions/session-id-resolution.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import {
  filterAndSortSessionEntries,
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  resolveDeletedAgentIdFromSessionKey,
  resolveGatewaySessionStoreTargetWithStore,
} from "./session-utils.js";

export type SessionsResolveResult =
  | { ok: true; key: string }
  | { ok: true; missing: true }
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
}): Array<[string, SessionEntry]> {
  const now = Date.now();
  const entries = filterAndSortSessionEntries({
    cfg: params.cfg,
    store: params.store,
    now,
    opts: resolveSessionVisibilityFilterOptions(params.p),
  });
  return entries.filter(
    ([key, entry]) => entry?.sessionId === params.sessionId || key === params.sessionId,
  );
}

export async function resolveSessionKeyFromResolveParams(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
}): Promise<SessionsResolveResult> {
  const { cfg, p } = params;

  const key = normalizeOptionalString(p.key) ?? "";
  const hasKey = key.length > 0;
  const sessionId = normalizeOptionalString(p.sessionId) ?? "";
  const hasSessionId = sessionId.length > 0;
  const hasLabel = (normalizeOptionalString(p.label) ?? "").length > 0;
  const selectionCount = [hasKey, hasSessionId, hasLabel].filter(Boolean).length;
  if (selectionCount > 1) {
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        "Provide either key, sessionId, or label (not multiple)",
      ),
    };
  }
  if (selectionCount === 0) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, "Either key, sessionId, or label is required"),
    };
  }

  if (hasKey) {
    // Key lookups may hit legacy store aliases. Migrate/prune before returning
    // the canonical key so later calls operate on one store identity.
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
    const legacyKey = target.storeKeys.find((candidate) => store[candidate]);
    if (!legacyKey) {
      return noSessionFoundResult({ p, message: `No session found: ${key}` });
    }
    await canonicalizeSessionEntryAliases({
      storePath: target.storePath,
      target: {
        canonicalKey: target.canonicalKey,
        storeKeys: target.storeKeys,
      },
    });
    const refreshedTarget = resolveGatewaySessionStoreTargetWithStore({
      cfg,
      key: target.canonicalKey,
      clone: false,
    });
    if (
      !isResolvedSessionKeyVisible({
        cfg,
        p,
        store: refreshedTarget.store,
        key: refreshedTarget.canonicalKey,
      })
    ) {
      return noSessionFoundResult({ p, message: `No session found: ${key}` });
    }
    const agentCheckLegacy = validateSessionAgentExists(
      cfg,
      refreshedTarget.canonicalKey,
      refreshedTarget.store[refreshedTarget.canonicalKey],
      { acpMetadataSessionKey: refreshedTarget.canonicalKey },
    );
    if (agentCheckLegacy) {
      return agentCheckLegacy;
    }
    return { ok: true, key: refreshedTarget.canonicalKey };
  }

  if (hasSessionId) {
    // sessionId can collide across stores; delegate selection so exact key
    // matches and ambiguity rules stay shared with other session-id callers.
    const { store } = loadCombinedSessionStoreForGateway(cfg, { agentId: p.agentId });
    const matches = findVisibleSessionIdMatches({ cfg, store, p, sessionId });
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
    storePath,
    store,
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
    const keys = list.sessions.map((s) => s.key).join(", ");
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
    key: expectDefined(list.sessions[0], "sessions entry at 0").key,
  };
}
