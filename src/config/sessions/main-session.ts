import { resolveDefaultAgentId } from "../../agents/agent-scope-config.js";
// Main-session keys normalize configured agents and legacy aliases into store keys.
import {
  normalizeAgentId,
  normalizeMainKey,
  resolveAgentIdFromSessionKey,
} from "../../routing/session-key.js";
import type { OpenClawConfig } from "../types.openclaw.js";
import type { SessionScope } from "./types.js";

const LEGACY_HARDCODED_AGENT_ID = "main";

export const SESSION_ROUTING_CHANGED_ERROR_REASON = "session-routing-changed";

/** Builds the canonical main session key for an agent. */
function buildMainSessionKey(agentId: string, mainKey?: string): string {
  return `agent:${normalizeAgentId(agentId)}:${normalizeMainKey(mainKey)}`;
}

/** Resolves the configured main session key, honoring global session scope. */
export function resolveMainSessionKey(cfg: OpenClawConfig): string {
  if (cfg?.session?.scope === "global") {
    return "global";
  }
  return buildMainSessionKey(resolveDefaultAgentId(cfg), cfg.session?.mainKey);
}

/** Stable fingerprint for the config values that canonicalize chat session keys. */
export function resolveSessionRoutingContract(cfg: OpenClawConfig): string {
  const defaultAgentId = resolveDefaultAgentId(cfg);
  const scope = cfg?.session?.scope ?? "per-sender";
  return [scope, normalizeMainKey(cfg?.session?.mainKey), normalizeAgentId(defaultAgentId)].join(
    "|",
  );
}

export { resolveAgentIdFromSessionKey };

/** Resolves the main session key for one explicit agent. */
export function resolveAgentMainSessionKey(params: {
  cfg?: { session?: { mainKey?: string } };
  agentId: string;
}): string {
  return buildMainSessionKey(params.agentId, params.cfg?.session?.mainKey);
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
  const agentMainSessionKey = buildMainSessionKey(agentId, mainKey);
  const agentMainAliasKey = buildMainSessionKey(agentId, "main");

  // Shipped writers hardcoded agent:main:* even for non-main defaults. Keep this
  // remap until doctor is guaranteed to migrate session keys on every upgrade.
  const legacyMainKey = buildMainSessionKey(LEGACY_HARDCODED_AGENT_ID, mainKey);
  const legacyMainAliasKey = buildMainSessionKey(LEGACY_HARDCODED_AGENT_ID, "main");
  const roster = (
    params.cfg as
      | ({ agents?: { list?: Array<{ id: string; default?: boolean }> } } & typeof params.cfg)
      | undefined
  )?.agents?.list;
  const hasConfiguredMain = roster?.some(
    (entry) => normalizeAgentId(entry.id) === LEGACY_HARDCODED_AGENT_ID,
  );
  const configuredDefault = roster?.find((entry) => entry.default === true);
  const allowLegacyMainAlias =
    agentId !== LEGACY_HARDCODED_AGENT_ID &&
    !hasConfiguredMain &&
    normalizeAgentId(configuredDefault?.id ?? "") === agentId;

  const isMainAlias =
    raw === "main" ||
    raw === mainKey ||
    raw === agentMainSessionKey ||
    raw === agentMainAliasKey ||
    (allowLegacyMainAlias && (raw === legacyMainKey || raw === legacyMainAliasKey));

  if (params.cfg?.session?.scope === "global" && isMainAlias) {
    return "global";
  }
  if (isMainAlias) {
    return agentMainSessionKey;
  }
  return raw;
}
