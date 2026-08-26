import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

/** Resolves the durable requester owner for legacy rows that predate requesterAgentId. */
export function resolveSubagentRequesterAgentId(
  cfg: OpenClawConfig,
  entry: { requesterSessionKey: string; requesterAgentId?: string },
): string | undefined {
  if (entry.requesterAgentId) {
    return entry.requesterAgentId;
  }
  const parsedAgentId = parseAgentSessionKey(entry.requesterSessionKey)?.agentId;
  if (parsedAgentId) {
    return parsedAgentId;
  }
  const persisted = resolvePersistedSessionStoreOwnerForKey(cfg, entry.requesterSessionKey);
  return persisted.kind === "configured"
    ? persisted.agentId
    : persisted.kind === "none"
      ? tryResolveLegacyCompatibilityAgentId(cfg)
      : undefined;
}

/** Materializes the compatibility owner once so every registry selector sees the same tuple. */
export function backfillSubagentRequesterAgentIds(
  cfg: OpenClawConfig,
  entries: Iterable<{ requesterSessionKey: string; requesterAgentId?: string }>,
): number {
  let changed = 0;
  for (const entry of entries) {
    if (entry.requesterAgentId) {
      continue;
    }
    const requesterAgentId = resolveSubagentRequesterAgentId(cfg, entry);
    if (!requesterAgentId) {
      continue;
    }
    entry.requesterAgentId = requesterAgentId;
    changed += 1;
  }
  return changed;
}
