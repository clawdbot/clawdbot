import { normalizeAgentId } from "@openclaw/normalization-core/agent-id";
import { tryResolveLegacyCompatibilityAgentId } from "../config/legacy.default-agent-owner.js";
import { resolvePersistedSessionStoreOwnerForKey } from "../config/sessions/session-store-owner.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { parseAgentSessionKey } from "../routing/session-key.js";

/** Resolve the durable owner for a requester key before opening its session store. */
export function resolveSubagentRequesterAgentIdForSession(
  cfg: OpenClawConfig,
  requesterSessionKey: string,
  explicitAgentId?: string,
): string | undefined {
  const requestedAgentId = explicitAgentId?.trim() ? normalizeAgentId(explicitAgentId) : undefined;
  const parsedAgentId = parseAgentSessionKey(requesterSessionKey)?.agentId;
  if (requestedAgentId && parsedAgentId && requestedAgentId !== parsedAgentId) {
    return undefined;
  }
  const persisted = resolvePersistedSessionStoreOwnerForKey(cfg, requesterSessionKey);
  if (persisted.kind === "retired") {
    return undefined;
  }
  if (
    requestedAgentId &&
    persisted.kind === "configured" &&
    requestedAgentId !== persisted.agentId
  ) {
    return undefined;
  }
  return (
    requestedAgentId ??
    parsedAgentId ??
    (persisted.kind === "configured" ? persisted.agentId : undefined) ??
    tryResolveLegacyCompatibilityAgentId(cfg)
  );
}

/** Resolves the durable requester owner for legacy rows that predate requesterAgentId. */
export function resolveSubagentRequesterAgentId(
  cfg: OpenClawConfig,
  entry: { requesterSessionKey: string; requesterAgentId?: string },
): string | undefined {
  if (entry.requesterAgentId) {
    return entry.requesterAgentId;
  }
  return resolveSubagentRequesterAgentIdForSession(cfg, entry.requesterSessionKey);
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
