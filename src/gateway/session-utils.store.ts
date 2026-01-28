/**
 * Session store resolution and loading utilities.
 * Handles canonical key resolution, store path mapping, and store merging.
 */

import { resolveDefaultAgentId } from "../agents/agent-scope.js";
import type { MoltbotConfig } from "../config/config.js";
import {
  canonicalizeMainSessionAlias,
  loadSessionStore,
  resolveMainSessionKey,
  resolveStorePath,
  type SessionEntry,
} from "../config/sessions.js";
import {
  normalizeAgentId,
  normalizeMainKey,
  parseAgentSessionKey,
} from "../routing/session-key.js";
import { isStorePathTemplate, listConfiguredAgentIds } from "./session-utils.agents.js";

/**
 * Canonicalize a session key for a specific agent.
 * Adds the agent: prefix if not already present.
 */
export function canonicalizeSessionKeyForAgent(agentId: string, key: string): string {
  if (key === "global" || key === "unknown") return key;
  if (key.startsWith("agent:")) return key;
  return `agent:${normalizeAgentId(agentId)}:${key}`;
}

/**
 * Get the default store agent ID from config.
 */
export function resolveDefaultStoreAgentId(cfg: MoltbotConfig): string {
  return normalizeAgentId(resolveDefaultAgentId(cfg));
}

/**
 * Resolve a session key to its canonical store key form.
 */
export function resolveSessionStoreKey(params: { cfg: MoltbotConfig; sessionKey: string }): string {
  const raw = params.sessionKey.trim();
  if (!raw) return raw;
  if (raw === "global" || raw === "unknown") return raw;

  const parsed = parseAgentSessionKey(raw);
  if (parsed) {
    const agentId = normalizeAgentId(parsed.agentId);
    const canonical = canonicalizeMainSessionAlias({
      cfg: params.cfg,
      agentId,
      sessionKey: raw,
    });
    if (canonical !== raw) return canonical;
    return raw;
  }

  const rawMainKey = normalizeMainKey(params.cfg.session?.mainKey);
  if (raw === "main" || raw === rawMainKey) {
    return resolveMainSessionKey(params.cfg);
  }
  const agentId = resolveDefaultStoreAgentId(params.cfg);
  return canonicalizeSessionKeyForAgent(agentId, raw);
}

/**
 * Resolve the agent ID for a canonical session key.
 */
export function resolveSessionStoreAgentId(cfg: MoltbotConfig, canonicalKey: string): string {
  if (canonicalKey === "global" || canonicalKey === "unknown") {
    return resolveDefaultStoreAgentId(cfg);
  }
  const parsed = parseAgentSessionKey(canonicalKey);
  if (parsed?.agentId) return normalizeAgentId(parsed.agentId);
  return resolveDefaultStoreAgentId(cfg);
}

/**
 * Canonicalize a spawnedBy reference for an agent.
 */
export function canonicalizeSpawnedByForAgent(
  agentId: string,
  spawnedBy?: string,
): string | undefined {
  const raw = spawnedBy?.trim();
  if (!raw) return undefined;
  if (raw === "global" || raw === "unknown") return raw;
  if (raw.startsWith("agent:")) return raw;
  return `agent:${normalizeAgentId(agentId)}:${raw}`;
}

/**
 * Resolve the target store for a gateway session operation.
 */
export function resolveGatewaySessionStoreTarget(params: { cfg: MoltbotConfig; key: string }): {
  agentId: string;
  storePath: string;
  canonicalKey: string;
  storeKeys: string[];
} {
  const key = params.key.trim();
  const canonicalKey = resolveSessionStoreKey({
    cfg: params.cfg,
    sessionKey: key,
  });
  const agentId = resolveSessionStoreAgentId(params.cfg, canonicalKey);
  const storeConfig = params.cfg.session?.store;
  const storePath = resolveStorePath(storeConfig, { agentId });

  if (canonicalKey === "global" || canonicalKey === "unknown") {
    const storeKeys = key && key !== canonicalKey ? [canonicalKey, key] : [key];
    return { agentId, storePath, canonicalKey, storeKeys };
  }

  const storeKeys = new Set<string>();
  storeKeys.add(canonicalKey);
  if (key && key !== canonicalKey) storeKeys.add(key);
  return {
    agentId,
    storePath,
    canonicalKey,
    storeKeys: Array.from(storeKeys),
  };
}

/**
 * Merge a session entry into a combined store, preferring newer data.
 */
export function mergeSessionEntryIntoCombined(params: {
  combined: Record<string, SessionEntry>;
  entry: SessionEntry;
  agentId: string;
  canonicalKey: string;
}): void {
  const { combined, entry, agentId, canonicalKey } = params;
  const existing = combined[canonicalKey];

  if (existing && (existing.updatedAt ?? 0) > (entry.updatedAt ?? 0)) {
    combined[canonicalKey] = {
      ...entry,
      ...existing,
      spawnedBy: canonicalizeSpawnedByForAgent(agentId, existing.spawnedBy ?? entry.spawnedBy),
    };
  } else {
    combined[canonicalKey] = {
      ...existing,
      ...entry,
      spawnedBy: canonicalizeSpawnedByForAgent(agentId, entry.spawnedBy ?? existing?.spawnedBy),
    };
  }
}

/**
 * Load and merge all session stores into a combined view for gateway.
 */
export function loadCombinedSessionStoreForGateway(cfg: MoltbotConfig): {
  storePath: string;
  store: Record<string, SessionEntry>;
} {
  const storeConfig = cfg.session?.store;

  // Single store mode (no template)
  if (storeConfig && !isStorePathTemplate(storeConfig)) {
    const storePath = resolveStorePath(storeConfig);
    const defaultAgentId = normalizeAgentId(resolveDefaultAgentId(cfg));
    const store = loadSessionStore(storePath);
    const combined: Record<string, SessionEntry> = {};
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = canonicalizeSessionKeyForAgent(defaultAgentId, key);
      mergeSessionEntryIntoCombined({
        combined,
        entry,
        agentId: defaultAgentId,
        canonicalKey,
      });
    }
    return { storePath, store: combined };
  }

  // Multi-agent store mode (templated path)
  const agentIds = listConfiguredAgentIds(cfg);
  const combined: Record<string, SessionEntry> = {};
  for (const agentId of agentIds) {
    const storePath = resolveStorePath(storeConfig, { agentId });
    const store = loadSessionStore(storePath);
    for (const [key, entry] of Object.entries(store)) {
      const canonicalKey = canonicalizeSessionKeyForAgent(agentId, key);
      mergeSessionEntryIntoCombined({
        combined,
        entry,
        agentId,
        canonicalKey,
      });
    }
  }

  const storePath =
    typeof storeConfig === "string" && storeConfig.trim() ? storeConfig.trim() : "(multiple)";
  return { storePath, store: combined };
}
