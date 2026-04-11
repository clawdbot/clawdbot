import type { OpenClawConfig } from "../config/config.js";
import { loadSessionStore, updateSessionStore } from "../config/sessions.js";
import { parseSessionLabel } from "../sessions/session-label.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import {
  ErrorCodes,
  type ErrorShape,
  errorShape,
  type SessionsResolveParams,
} from "./protocol/index.js";
import {
  listSessionsFromStore,
  loadCombinedSessionStoreForGateway,
  migrateAndPruneGatewaySessionStoreKey,
  resolveGatewaySessionStoreTarget,
} from "./session-utils.js";

export type SessionsResolveResult = { ok: true; key: string } | { ok: false; error: ErrorShape };

function resolveSessionVisibilityFilterOptions(p: SessionsResolveParams) {
  return {
    includeGlobal: p.includeGlobal === true,
    includeUnknown: p.includeUnknown === true,
    spawnedBy: p.spawnedBy,
    agentId: p.agentId,
  };
}

function noSessionFoundResult(key: string): SessionsResolveResult {
  return {
    ok: false,
    error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${key}`),
  };
}

function isResolvedSessionKeyVisible(params: {
  cfg: OpenClawConfig;
  p: SessionsResolveParams;
  storePath: string;
  store: ReturnType<typeof loadSessionStore>;
  key: string;
}) {
  if (typeof params.p.spawnedBy !== "string" || params.p.spawnedBy.trim().length === 0) {
    return true;
  }
  return listSessionsFromStore({
    cfg: params.cfg,
    storePath: params.storePath,
    store: params.store,
    opts: resolveSessionVisibilityFilterOptions(params.p),
  }).sessions.some((session) => session.key === params.key);
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
    const target = resolveGatewaySessionStoreTarget({ cfg, key });
    const store = loadSessionStore(target.storePath);
    if (store[target.canonicalKey]) {
      if (
        !isResolvedSessionKeyVisible({
          cfg,
          p,
          storePath: target.storePath,
          store,
          key: target.canonicalKey,
        })
      ) {
        return noSessionFoundResult(key);
      }
      return { ok: true, key: target.canonicalKey };
    }
    const legacyKey = target.storeKeys.find((candidate) => store[candidate]);
    if (!legacyKey) {
      return noSessionFoundResult(key);
    }
    await updateSessionStore(target.storePath, (s) => {
      const { primaryKey } = migrateAndPruneGatewaySessionStoreKey({ cfg, key, store: s });
      if (!s[primaryKey] && s[legacyKey]) {
        s[primaryKey] = s[legacyKey];
      }
    });
    if (
      !isResolvedSessionKeyVisible({
        cfg,
        p,
        storePath: target.storePath,
        store: loadSessionStore(target.storePath),
        key: target.canonicalKey,
      })
    ) {
      return noSessionFoundResult(key);
    }
    return { ok: true, key: target.canonicalKey };
  }

  if (hasSessionId) {
    const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
    const list = listSessionsFromStore({
      cfg,
      storePath,
      store,
      opts: {
        includeGlobal: p.includeGlobal === true,
        includeUnknown: p.includeUnknown === true,
        spawnedBy: p.spawnedBy,
        agentId: p.agentId,
      },
    });
    const matches = list.sessions.filter(
      (session) => session.sessionId === sessionId || session.key === sessionId,
    );
    if (matches.length === 0) {
      return {
        ok: false,
        error: errorShape(ErrorCodes.INVALID_REQUEST, `No session found: ${sessionId}`),
      };
    }
    if (matches.length > 1) {
      const keys = matches.map((session) => session.key).join(", ");
      return {
        ok: false,
        error: errorShape(
          ErrorCodes.INVALID_REQUEST,
          `Multiple sessions found for sessionId: ${sessionId} (${keys})`,
        ),
      };
    }
    return { ok: true, key: matches[0].key };
  }

  const parsedLabel = parseSessionLabel(p.label);
  if (!parsedLabel.ok) {
    return {
      ok: false,
      error: errorShape(ErrorCodes.INVALID_REQUEST, parsedLabel.error),
    };
  }

  const { storePath, store } = loadCombinedSessionStoreForGateway(cfg);
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
    return {
      ok: false,
      error: errorShape(
        ErrorCodes.INVALID_REQUEST,
        `No session found with label: ${parsedLabel.label}`,
      ),
    };
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

  return { ok: true, key: list.sessions[0].key };
}
