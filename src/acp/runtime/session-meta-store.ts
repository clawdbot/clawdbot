/** Store binding for ACP session metadata: resolves which session-store row owns a key. */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { AgentSelectionRequiredError, listAgentIds } from "../../agents/agent-scope-config.js";
import { getRuntimeConfig } from "../../config/config.js";
import { tryResolveLegacyCompatibilityAgentId } from "../../config/legacy.default-agent-owner.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import {
  listSessionEntryKeysReadOnly,
  loadExactSessionEntryReadOnly,
} from "../../config/sessions/session-accessor.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../../config/sessions/session-store-owner.js";
import type { SessionEntry } from "../../config/sessions/types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";

/**
 * Resolve one session's store key and entry with targeted single-row probes.
 * Gateway sessions.list calls this per row; listing the whole store here made
 * that path O(rows²) in JSON parsing (12.7s of a 78.5s production profile).
 * The full scan survives only as the fallback for legacy case-variant keys
 * that neither the exact nor the lowercased probe can hit.
 */
export function resolveStoreEntryForSessionKey(params: {
  agentId?: string;
  storePath: string;
  sessionKey: string;
  clone?: boolean;
}): { storeSessionKey: string; entry?: SessionEntry } {
  const scope = {
    ...(params.agentId ? { agentId: params.agentId } : {}),
    storePath: params.storePath,
    ...(params.clone === false ? { clone: false } : {}),
  };
  const normalized = params.sessionKey.trim();
  if (!normalized) {
    return { storeSessionKey: "" };
  }
  const exact = loadExactSessionEntryReadOnly({ ...scope, sessionKey: normalized });
  if (exact) {
    return { storeSessionKey: normalized, entry: exact.entry };
  }
  const lower = normalizeLowercaseStringOrEmpty(normalized);
  if (lower !== normalized) {
    const lowered = loadExactSessionEntryReadOnly({ ...scope, sessionKey: lower });
    if (lowered) {
      return { storeSessionKey: lower, entry: lowered.entry };
    }
  }
  // Both direct probes missed, so only a legacy case-variant key can match.
  // Scan persisted keys without parsing any entry_json, then probe the winner.
  const variant = listSessionEntryKeysReadOnly(scope).find(
    (candidate) => normalizeLowercaseStringOrEmpty(candidate) === lower,
  );
  if (variant === undefined) {
    return { storeSessionKey: lower };
  }
  return {
    storeSessionKey: variant,
    entry: loadExactSessionEntryReadOnly({ ...scope, sessionKey: variant })?.entry,
  };
}

/** Resolves the session store path that owns an ACP session key. */
export function resolveSessionStorePathForAcp(params: {
  sessionKey: string;
  agentId?: string;
  cfg?: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
}): { cfg: OpenClawConfig; agentId?: string; storePath?: string } {
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
  return {
    cfg,
    agentId: resolvedAgentId,
    storePath: resolveSessionStorePathCore(cfg.session?.store, {
      agentId: resolvedAgentId,
      env: params.env,
    }),
  };
}

/** Reads one session's store binding, falling back to a lowercased key on store errors. */
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
  const { cfg, agentId, storePath } = resolveSessionStorePathForAcp({
    sessionKey: params.sessionKey,
    agentId: params.agentId,
    cfg: params.cfg,
    env: params.env,
  });
  if (!storePath) {
    return {
      cfg,
      agentId,
      storeSessionKey: normalizeLowercaseStringOrEmpty(params.sessionKey),
    };
  }
  try {
    const { storeSessionKey, entry } = resolveStoreEntryForSessionKey({
      ...(agentId ? { agentId } : {}),
      storePath,
      sessionKey: params.sessionKey,
      ...(params.clone === false ? { clone: false } : {}),
    });
    return { cfg, agentId, storePath, storeSessionKey, entry };
  } catch {
    return {
      cfg,
      agentId,
      storePath,
      storeSessionKey: normalizeLowercaseStringOrEmpty(params.sessionKey),
      storeReadFailed: true,
    };
  }
}
