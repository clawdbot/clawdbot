/** Store binding for ACP session metadata: resolves which session-store row owns a key. */
import { AgentSelectionRequiredError, listAgentIds } from "../../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { canonicalizeMainSessionAlias } from "../../config/sessions/main-session.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import { loadSessionEntryReadOnly } from "../../config/sessions/session-accessor.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import { normalizeStoreSessionKey } from "../../config/sessions/store-entry.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";

/** Join the logical ACP key to its canonical SQLite entry without renaming ACP metadata. */
export function resolveStoreEntryForSessionKey(params: {
  agentId?: string;
  storePath: string;
  sessionKey: string;
  clone?: boolean;
}): { storeSessionKey: string; entry?: SessionEntry } {
  const storeSessionKey = normalizeStoreSessionKey(params.sessionKey);
  if (!storeSessionKey) {
    return { storeSessionKey };
  }
  return {
    storeSessionKey,
    entry: loadSessionEntryReadOnly({ ...params, sessionKey: storeSessionKey }),
  };
}

/** Resolves the session store path that owns an ACP session key. */
export function resolveSessionStorePathForAcp(params: {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): { cfg: OpenClawConfig; agentId: string; storePath: string; storeSessionKey: string } {
  const cfg = params.cfg ?? getRuntimeConfig();
  const parsed = parseAgentSessionKey(params.sessionKey);
  const requestedAgentId = params.agentId?.trim() ? normalizeAgentId(params.agentId) : undefined;
  const parsedAgentId = parsed?.agentId ? normalizeAgentId(parsed.agentId) : undefined;
  if (requestedAgentId && parsedAgentId && requestedAgentId !== parsedAgentId) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `ACP session key "${params.sessionKey}"`,
      hint: `Agent "${requestedAgentId}" does not own agent-scoped session key "${params.sessionKey}".`,
    });
  }
  const persistedStoreOwner = resolvePersistedSessionStoreOwnerForKey(cfg, params.sessionKey);
  const agentId = requestedAgentId ?? parsedAgentId;
  if (
    requestedAgentId &&
    persistedStoreOwner.kind === "configured" &&
    requestedAgentId !== persistedStoreOwner.agentId
  ) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `ACP session key "${params.sessionKey}"`,
      hint: `The shared fixed-store row belongs to agent "${persistedStoreOwner.agentId}", not agent "${requestedAgentId}".`,
    });
  }
  if (persistedStoreOwner.kind === "retired") {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `ACP session key "${params.sessionKey}"`,
      hint: `The shared fixed-store row belongs to retired agent "${persistedStoreOwner.agentId}".`,
    });
  }
  const resolvedAgentId =
    agentId ??
    (persistedStoreOwner.kind === "configured" ? persistedStoreOwner.agentId : undefined) ??
    tryResolveLegacyCompatibilityAgentId(cfg);
  if (!resolvedAgentId) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `ACP session key "${params.sessionKey}"`,
      hint: "Pass an explicit agent owner for this ACP session.",
    });
  }
  const storeSessionKey = canonicalizeMainSessionAlias({
    cfg,
    sessionKey: params.sessionKey,
    agentId: resolvedAgentId,
  });
  const canonicalOwner = resolvePersistedSessionStoreOwnerForKey(cfg, storeSessionKey);
  if (
    canonicalOwner.kind === "retired" ||
    (canonicalOwner.kind === "configured" && canonicalOwner.agentId !== resolvedAgentId)
  ) {
    throw new AgentSelectionRequiredError(listAgentIds(cfg), {
      surface: `ACP session key "${storeSessionKey}"`,
      hint: "The canonical fixed-store session has a different or retired owner. Select its recorded owner.",
    });
  }
  return {
    cfg,
    storeSessionKey,
    agentId: resolvedAgentId,
    storePath: resolveSessionStorePathCore(cfg.session?.store, {
      agentId: resolvedAgentId,
      env: params.env,
    }),
  };
}

/** Reads the canonical session binding while retaining ACP's logical key. */
export function readSessionEntryFromStore(params: {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  clone?: boolean;
}): {
  cfg: OpenClawConfig;
  agentId?: string;
  storePath?: string;
  storeSessionKey: string;
  entry?: SessionEntry;
  storeReadFailed?: boolean;
} {
  const {
    cfg,
    agentId,
    storePath,
    storeSessionKey: canonicalKey,
  } = resolveSessionStorePathForAcp({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    cfg: params.cfg,
    env: params.env,
  });
  try {
    const { storeSessionKey, entry } = resolveStoreEntryForSessionKey({
      ...(agentId ? { agentId } : {}),
      storePath,
      sessionKey: canonicalKey,
      ...(params.clone === false ? { clone: false } : {}),
    });
    return { cfg, agentId, storePath, storeSessionKey, entry };
  } catch {
    return {
      cfg,
      agentId,
      storePath,
      storeSessionKey: canonicalKey,
      storeReadFailed: true,
    };
  }
}
