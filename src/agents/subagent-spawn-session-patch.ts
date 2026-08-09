import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import {
  inheritedToolAllowPatch,
  inheritedToolDenyPatch,
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "./inherited-tool-deny.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { splitModelRef } from "./subagent-spawn-plan.js";
import { resolveGatewaySessionStoreTarget, upsertSessionEntry } from "./subagent-spawn.runtime.js";

function buildDirectChildSessionPatch(patch: Record<string, unknown>): Partial<SessionEntry> {
  const entry: Partial<SessionEntry> = {};
  const spawnDepth = patch.spawnDepth;
  if (typeof spawnDepth === "number" && Number.isFinite(spawnDepth) && spawnDepth >= 0) {
    entry.spawnDepth = Math.floor(spawnDepth);
  }
  if (patch.subagentRole === "orchestrator" || patch.subagentRole === "leaf") {
    entry.subagentRole = patch.subagentRole;
  }
  if (patch.subagentControlScope === "children" || patch.subagentControlScope === "none") {
    entry.subagentControlScope = patch.subagentControlScope;
  }
  if (patch.inheritedToolPolicyVersion === 1) {
    entry.inheritedToolPolicyVersion = 1;
  }
  if (patch.incognito === true) {
    entry.incognito = true;
  }
  if (typeof patch.spawnedBy === "string" && patch.spawnedBy.trim()) {
    entry.spawnedBy = patch.spawnedBy.trim();
  }
  if (
    typeof patch.completionOwnerSessionKey === "string" &&
    patch.completionOwnerSessionKey.trim()
  ) {
    entry.completionOwnerSessionKey = patch.completionOwnerSessionKey.trim();
  }
  if (typeof patch.parentSessionKey === "string" && patch.parentSessionKey.trim()) {
    entry.parentSessionKey = patch.parentSessionKey.trim();
  }
  if (typeof patch.spawnedWorkspaceDir === "string" && patch.spawnedWorkspaceDir.trim()) {
    entry.spawnedWorkspaceDir = patch.spawnedWorkspaceDir.trim();
  }
  if (typeof patch.spawnedCwd === "string" && patch.spawnedCwd.trim()) {
    entry.spawnedCwd = patch.spawnedCwd.trim();
  }
  const inheritedToolDeny = normalizeInheritedToolDenylist(patch.inheritedToolDeny);
  if (inheritedToolDeny.length > 0) {
    entry.inheritedToolDeny = inheritedToolDeny;
  }
  const inheritedToolAllow = normalizeInheritedToolAllowlist(patch.inheritedToolAllow);
  if (inheritedToolAllow.length > 0) {
    entry.inheritedToolAllow = inheritedToolAllow;
  }
  if (typeof patch.thinkingLevel === "string" && patch.thinkingLevel.trim()) {
    entry.thinkingLevel = patch.thinkingLevel.trim();
  }
  if (patch.fastMode === true || patch.fastMode === false || patch.fastMode === "auto") {
    entry.fastMode = patch.fastMode;
  }
  if (typeof patch.swarmGroupId === "string" && patch.swarmGroupId.trim()) {
    entry.swarmGroupId = patch.swarmGroupId.trim();
  }
  if (patch.swarmCollector === true) {
    entry.swarmCollector = true;
  }
  if (patch.swarmOutputSchema && typeof patch.swarmOutputSchema === "object") {
    entry.swarmOutputSchema = patch.swarmOutputSchema as Record<string, unknown>;
  }
  if (typeof patch.model === "string" && patch.model.trim()) {
    const { provider, model } = splitModelRef(patch.model.trim());
    if (model) {
      entry.model = model;
      entry.modelOverride = model;
      entry.modelOverrideSource = patch.modelOverrideSource === "auto" ? "auto" : "user";
      entry.modelOverrideRouteResolution = "resolved";
      const fallbackOriginProvider = normalizeOptionalString(
        patch.modelOverrideFallbackOriginProvider,
      );
      const fallbackOriginModel = normalizeOptionalString(patch.modelOverrideFallbackOriginModel);
      if (fallbackOriginProvider && fallbackOriginModel) {
        entry.modelOverrideFallbackOriginProvider = fallbackOriginProvider;
        entry.modelOverrideFallbackOriginModel = fallbackOriginModel;
      }
      if (provider) {
        entry.modelProvider = provider;
        entry.providerOverride = provider;
      }
    }
  }
  return entry;
}

export function loadSubagentConfig() {
  return getSubagentSpawnDeps().getRuntimeConfig();
}

export async function createInitialSubagentSession(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  childSessionKey: string;
  incognito: boolean;
  requesterInternalKey: string;
  completionOwnerSessionKey: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
  admissionPatch?: Record<string, unknown>;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  modelPatch: Record<string, unknown>;
  swarmGroupId?: string;
  collect: boolean;
  outputSchema?: Record<string, unknown>;
}): Promise<{ status: "ok"; entry?: SessionEntry } | { status: "error"; error: string }> {
  const initialChildSessionPatch: Record<string, unknown> = {
    spawnedBy: params.requesterInternalKey,
    completionOwnerSessionKey: params.completionOwnerSessionKey,
    // Navigation and control lineage commit with the creation stamp so a
    // launch failure cannot leave a durable but parentless child row.
    parentSessionKey: params.requesterInternalKey,
    ...(params.spawnedWorkspaceDir ? { spawnedWorkspaceDir: params.spawnedWorkspaceDir } : {}),
    ...(params.spawnedCwd ? { spawnedCwd: params.spawnedCwd } : {}),
    ...params.admissionPatch,
    inheritedToolPolicyVersion: 1,
    ...inheritedToolAllowPatch(params.inheritedToolAllowlist),
    ...inheritedToolDenyPatch(params.inheritedToolDenylist),
    ...params.modelPatch,
    ...(params.swarmGroupId ? { swarmGroupId: params.swarmGroupId } : {}),
    ...(params.collect ? { swarmCollector: true } : {}),
    ...(params.outputSchema ? { swarmOutputSchema: params.outputSchema } : {}),
    ...(params.incognito ? { incognito: true } : {}),
  };
  // Spawn owns a fresh child lifecycle. Cleanup freezes both fields before
  // launch so it cannot delete a reset successor that reuses the session id.
  const childSessionIdentity = {
    sessionId: randomUUID(),
    lifecycleRevision: randomUUID(),
  };
  try {
    const target = params.incognito
      ? {
          agentId: params.targetAgentId,
          canonicalKey: params.childSessionKey,
          storeKeys: [params.childSessionKey],
          storePath: resolveIncognitoOpenClawAgentSqlitePath({ agentId: params.targetAgentId }),
        }
      : resolveGatewaySessionStoreTarget({
          cfg: params.cfg,
          key: params.childSessionKey,
        });
    const entry = await upsertSessionEntry(
      {
        storePath: target.storePath,
        sessionKey: target.canonicalKey,
      },
      {
        ...buildDirectChildSessionPatch(initialChildSessionPatch),
        ...childSessionIdentity,
        ...buildSessionCreationStamp({
          via: "spawn",
          actor: { type: "agent", id: params.requesterInternalKey },
        }),
      },
    );
    return { status: "ok", entry: entry ?? undefined };
  } catch (err) {
    const message = err instanceof Error ? err.message : typeof err === "string" ? err : "error";
    return { status: "error", error: `child session patch failed: ${message}` };
  }
}

export async function persistInitialChildSessionRuntimeModel(params: {
  cfg: OpenClawConfig;
  childSessionKey: string;
  resolvedModel?: string;
}): Promise<string | undefined> {
  const { provider, model } = splitModelRef(params.resolvedModel);
  if (!model) {
    return undefined;
  }
  try {
    const target = resolveGatewaySessionStoreTarget({
      cfg: params.cfg,
      key: params.childSessionKey,
    });
    await upsertSessionEntry(
      {
        storePath: target.storePath,
        sessionKey: target.canonicalKey,
      },
      {
        model,
        ...(provider ? { modelProvider: provider } : {}),
      },
    );
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : typeof err === "string" ? err : "error";
  }
}
