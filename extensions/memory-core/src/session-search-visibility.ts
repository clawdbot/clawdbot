import type { OpenClawConfig } from "openclaw/plugin-sdk/memory-core-host-runtime-core";
import type { MemorySearchResult } from "openclaw/plugin-sdk/memory-core-host-runtime-files";
import { resolveSessionAgentId } from "openclaw/plugin-sdk/memory-host-core";
import {
  extractTranscriptIdentityFromSessionsMemoryHit,
  loadCombinedSessionStoreForGateway,
  resolveTranscriptStemToSessionKeys,
} from "openclaw/plugin-sdk/session-transcript-hit";
import {
  createAgentToAgentPolicy,
  createSessionVisibilityGuard,
  resolveEffectiveSessionToolsVisibility,
} from "openclaw/plugin-sdk/session-visibility";

function normalizeAgentIdForCompare(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase() || undefined;
}

function isGlobalSessionKeyForSharedScope(cfg: OpenClawConfig, key: string): boolean {
  return cfg.session?.scope === "global" && key.trim().toLowerCase() === "global";
}

function filterSessionKeysByScopedAgent(params: {
  cfg: OpenClawConfig;
  keys: string[];
  scopedAgentId: string | undefined;
}): string[] {
  const scopedAgentId = normalizeAgentIdForCompare(params.scopedAgentId);
  if (!scopedAgentId) {
    return params.keys;
  }
  return params.keys.filter((key) => {
    if (isGlobalSessionKeyForSharedScope(params.cfg, key)) {
      return true;
    }
    const ownerAgentId = resolveSessionAgentId({
      sessionKey: key,
      config: params.cfg,
    });
    return normalizeAgentIdForCompare(ownerAgentId) === scopedAgentId;
  });
}

export async function filterMemorySearchHitsBySessionVisibility(params: {
  cfg: OpenClawConfig;
  agentId?: string;
  requesterSessionKey: string | undefined;
  sandboxed: boolean;
  hits: MemorySearchResult[];
}): Promise<MemorySearchResult[]> {
  const visibility = resolveEffectiveSessionToolsVisibility({
    cfg: params.cfg,
    sandboxed: params.sandboxed,
  });
  const a2aPolicy = createAgentToAgentPolicy(params.cfg);
  const requesterAgentId = params.requesterSessionKey
    ? resolveSessionAgentId({
        sessionKey: params.requesterSessionKey,
        config: params.cfg,
      })
    : undefined;
  const scopedAgentId = params.agentId?.trim() || requesterAgentId;
  const guard = params.requesterSessionKey
    ? await createSessionVisibilityGuard({
        action: "history",
        requesterSessionKey: params.requesterSessionKey,
        visibility,
        a2aPolicy,
      })
    : null;

  const { store: combinedSessionStore } = loadCombinedSessionStoreForGateway(
    params.cfg,
    scopedAgentId ? { agentId: scopedAgentId } : {},
  );

  const next: MemorySearchResult[] = [];
  for (const hit of params.hits) {
    if (hit.source !== "sessions") {
      next.push(hit);
      continue;
    }
    if (!params.requesterSessionKey || !guard) {
      continue;
    }
    const identity = extractTranscriptIdentityFromSessionsMemoryHit(hit.path);
    if (!identity) {
      continue;
    }
    const normalizedScopedAgentId = normalizeAgentIdForCompare(scopedAgentId);
    const normalizedOwnerAgentId = normalizeAgentIdForCompare(identity.ownerAgentId);
    if (
      normalizedScopedAgentId &&
      normalizedOwnerAgentId &&
      normalizedOwnerAgentId !== normalizedScopedAgentId
    ) {
      continue;
    }
    const archivedOwnerMatchesScope = Boolean(
      identity.archived &&
      identity.ownerAgentId &&
      (!scopedAgentId ||
        normalizeAgentIdForCompare(identity.ownerAgentId) ===
          normalizeAgentIdForCompare(scopedAgentId)),
    );
    const archivedOwnerAgentId = archivedOwnerMatchesScope ? identity.ownerAgentId : undefined;
    const keys = filterSessionKeysByScopedAgent({
      cfg: params.cfg,
      scopedAgentId,
      keys: resolveTranscriptStemToSessionKeys({
        store: combinedSessionStore,
        stem: identity.stem,
        ...(archivedOwnerAgentId ? { archivedOwnerAgentId } : {}),
      }),
    });
    if (keys.length === 0) {
      continue;
    }
    const allowed = keys.some((key) => guard.check(key).allowed);
    if (!allowed) {
      continue;
    }
    next.push(hit);
  }
  return next;
}
