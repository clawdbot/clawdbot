import {
  listAgentIds,
  resolveAmbientOwnerAgentId,
  tryResolveAmbientOwnerAgentId,
} from "../../agents/agent-scope-config.js";
// Main-session keys normalize configured agents and legacy aliases into store keys.
import {
  buildAgentMainSessionKey,
  normalizeAgentId,
  normalizeMainKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import { resolveCanonicalMainSessionKey } from "./main-session-key.js";
import { resolvePersistedSessionStoreOwnerForKey } from "./session-store-owner.js";
import type { SessionScope } from "./types.js";

const FALLBACK_DEFAULT_AGENT_ID = "main";
export const SESSION_ROUTING_CHANGED_ERROR_REASON = "session-routing-changed";

/** Resolves the configured main session key, honoring global session scope. */
export function resolveMainSessionKey(cfg: OpenClawConfig): string {
  return resolveCanonicalMainSessionKey({
    agentId: resolveAmbientOwnerAgentId(cfg, undefined, {
      surface: "main-session routing",
      hint: "Pass an explicit agent/session key instead of the unscoped main alias.",
    }),
    mainKey: cfg.session?.mainKey,
    sessionScope: cfg.session?.scope,
  });
}

/** Resolves the owner and canonical session target for ambient system work. */
export function resolveSystemMainSessionTarget(cfg: OpenClawConfig): {
  agentId: string;
  sessionKey: string;
} {
  const agentId = resolveAmbientOwnerAgentId(cfg);
  return {
    agentId,
    sessionKey: resolveCanonicalMainSessionKey({
      agentId,
      mainKey: cfg.session?.mainKey,
      sessionScope: cfg.session?.scope,
    }),
  };
}

/** Resolves the main session owned by configured ambient system work. */
export function resolveSystemMainSessionKey(cfg: OpenClawConfig): string {
  return resolveSystemMainSessionTarget(cfg).sessionKey;
}

/** Stable fingerprint for the config values that canonicalize chat session keys. */
export function resolveSessionRoutingContract(cfg: OpenClawConfig): string {
  const scope = cfg?.session?.scope ?? "per-sender";
  // Global keys carry no agent namespace, so their durable fixed-store owner is
  // part of the routing contract; otherwise stale clients can target a changed row.
  const persistedOwner =
    scope === "global"
      ? resolvePersistedSessionStoreOwnerForKey(cfg, "global")
      : ({ kind: "none" } as const);
  const routingOwner =
    persistedOwner.kind === "configured"
      ? persistedOwner.agentId
      : persistedOwner.kind === "retired"
        ? `retired:${persistedOwner.agentId}`
        : (tryResolveAmbientOwnerAgentId(cfg) ??
          (cfg.agents?.ownership === "explicit" ? "unowned" : (listAgentIds(cfg)[0] ?? "main")));
  return [scope, normalizeMainKey(cfg?.session?.mainKey), routingOwner].join("|");
}

export { resolveAgentIdFromSessionKey };

/** Resolves the main session key for one explicit agent. */
export function resolveAgentMainSessionKey(params: {
  cfg?: { session?: { mainKey?: string } };
  agentId: string;
}): string {
  return buildAgentMainSessionKey({
    agentId: params.agentId,
    mainKey: params.cfg?.session?.mainKey,
  });
}

/** Resolves an explicit agent id to its canonical main session key. */
export function resolveExplicitAgentSessionKey(params: {
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
  agentId?: string | null;
}): string | undefined {
  const agentId = params.agentId?.trim();
  if (!agentId) {
    return undefined;
  }
  return resolveAgentMainSessionKey({ cfg: params.cfg, agentId });
}

/** Canonicalizes main-session aliases to the current scoped session key. */
export function canonicalizeMainSessionAlias(params: {
  cfg?: { session?: { scope?: SessionScope; mainKey?: string } };
  agentId: string;
  sessionKey: string;
}): string {
  const raw = params.sessionKey.trim();
  if (!raw) {
    return raw;
  }

  const agentId = normalizeAgentId(params.agentId);
  const mainKey = normalizeMainKey(params.cfg?.session?.mainKey);
  const agentMainSessionKey = buildAgentMainSessionKey({ agentId, mainKey });
  const agentMainAliasKey = buildAgentMainSessionKey({ agentId, mainKey: "main" });

  // Also recognize legacy keys built with the hardcoded DEFAULT_AGENT_ID ("main")
  // when the configured agent differs. resolveSessionKey() historically used
  // DEFAULT_AGENT_ID="main" for all write paths, producing "agent:main:<mainKey>"
  // even when the configured agent is e.g. "ops". See #29683.
  const legacyMainKey = buildAgentMainSessionKey({ agentId: FALLBACK_DEFAULT_AGENT_ID, mainKey });
  const legacyMainAliasKey = buildAgentMainSessionKey({
    agentId: FALLBACK_DEFAULT_AGENT_ID,
    mainKey: "main",
  });

  const isMainAlias =
    raw === "main" ||
    raw === mainKey ||
    raw === agentMainSessionKey ||
    raw === agentMainAliasKey ||
    raw === legacyMainKey ||
    raw === legacyMainAliasKey;

  if (params.cfg?.session?.scope === "global" && isMainAlias) {
    return "global";
  }
  if (isMainAlias) {
    return agentMainSessionKey;
  }
  return raw;
}
