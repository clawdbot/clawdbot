import { randomUUID } from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { buildSessionCreationStamp } from "../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../config/sessions/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { runExclusiveSessionLifecycleMutation } from "../sessions/session-lifecycle-admission.js";
import { resolveIncognitoOpenClawAgentSqlitePath } from "../state/openclaw-agent-db.js";
import {
  inheritedToolAllowPatch,
  inheritedToolDenyPatch,
  normalizeInheritedToolAllowlist,
  normalizeInheritedToolDenylist,
} from "./inherited-tool-deny.js";
import type { ProvisionalSessionCleanupIdentity } from "./subagent-spawn-cleanup-types.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { splitModelRef } from "./subagent-spawn-plan.js";
import {
  loadSessionEntry,
  patchSessionEntry,
  resolveGatewaySessionStoreTarget,
  upsertSessionEntry,
} from "./subagent-spawn.runtime.js";

const RESERVED_DIRECT_SPAWN_IN_FLIGHT_KEY: unique symbol = Symbol.for(
  "openclaw.subagentSpawn.reservedDirectInFlight",
);

type ReservedSubagentReplayMarker = {
  runId: string;
  requesterSessionId: string;
  requesterLifecycleRevisionPresent: boolean;
  requesterLifecycleRevision: string | null;
  claimToken: string;
};

function isReservedSubagentReplayMarker(value: unknown): value is ReservedSubagentReplayMarker {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof (value as Partial<ReservedSubagentReplayMarker>).runId === "string" &&
    typeof (value as Partial<ReservedSubagentReplayMarker>).requesterSessionId === "string" &&
    typeof (value as Partial<ReservedSubagentReplayMarker>).requesterLifecycleRevisionPresent ===
      "boolean" &&
    ((value as Partial<ReservedSubagentReplayMarker>).requesterLifecycleRevision === null ||
      typeof (value as Partial<ReservedSubagentReplayMarker>).requesterLifecycleRevision ===
        "string") &&
    typeof (value as Partial<ReservedSubagentReplayMarker>).claimToken === "string"
  );
}

function reservedDirectSpawnInFlightKey(params: {
  preallocatedRunId: string;
  preallocatedChildSessionKey: string;
}): string {
  return JSON.stringify([params.preallocatedRunId, params.preallocatedChildSessionKey]);
}

export function claimReservedDirectSpawnInFlight(params: {
  preallocatedRunId?: string;
  preallocatedChildSessionKey?: string;
}): (() => void) | undefined {
  if (!params.preallocatedRunId || !params.preallocatedChildSessionKey) {
    return undefined;
  }
  const globalRecord = globalThis as Record<PropertyKey, unknown>;
  const claims = (globalRecord[RESERVED_DIRECT_SPAWN_IN_FLIGHT_KEY] ??=
    new Set<string>()) as Set<string>;
  const key = reservedDirectSpawnInFlightKey({
    preallocatedRunId: params.preallocatedRunId,
    preallocatedChildSessionKey: params.preallocatedChildSessionKey,
  });
  if (claims.has(key)) {
    throw new Error("reserved childSessionKey already exists");
  }
  claims.add(key);
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    claims.delete(key);
  };
}

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
  if (typeof patch.pluginOwnerId === "string" && patch.pluginOwnerId.trim()) {
    entry.pluginOwnerId = patch.pluginOwnerId.trim();
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
  const reservedSubagentRunId = normalizeOptionalString(patch.reservedSubagentRunId);
  const reservedSubagentRequesterSessionId = normalizeOptionalString(
    patch.reservedSubagentRequesterSessionId,
  );
  const reservedSubagentRequesterLifecycleRevisionPresent =
    patch.reservedSubagentRequesterLifecycleRevisionPresent;
  const reservedSubagentRequesterLifecycleRevision = normalizeOptionalString(
    patch.reservedSubagentRequesterLifecycleRevision,
  );
  const reservedSubagentClaimToken = normalizeOptionalString(patch.reservedSubagentClaimToken);
  const pluginOwnerId = normalizeOptionalString(patch.pluginOwnerId);
  if (
    (reservedSubagentRunId ||
      reservedSubagentRequesterSessionId ||
      typeof reservedSubagentRequesterLifecycleRevisionPresent === "boolean" ||
      reservedSubagentRequesterLifecycleRevision ||
      reservedSubagentClaimToken) &&
    pluginOwnerId
  ) {
    entry.pluginExtensions = {
      ...entry.pluginExtensions,
      [pluginOwnerId]: {
        ...entry.pluginExtensions?.[pluginOwnerId],
        openclawReservedSubagent: {
          ...(reservedSubagentRunId ? { runId: reservedSubagentRunId } : {}),
          ...(reservedSubagentRequesterSessionId
            ? { requesterSessionId: reservedSubagentRequesterSessionId }
            : {}),
          ...(typeof reservedSubagentRequesterLifecycleRevisionPresent === "boolean"
            ? {
                requesterLifecycleRevisionPresent:
                  reservedSubagentRequesterLifecycleRevisionPresent,
                requesterLifecycleRevision: reservedSubagentRequesterLifecycleRevisionPresent
                  ? (reservedSubagentRequesterLifecycleRevision ?? null)
                  : null,
              }
            : {}),
          ...(reservedSubagentClaimToken ? { claimToken: reservedSubagentClaimToken } : {}),
        },
      },
    };
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

function isConfigOwnedModelOverride(entry: SessionEntry): boolean {
  return entry.modelOverrideSource === undefined || entry.modelOverrideSource === "auto";
}

function refreshConfigOwnedModelReplayFields(
  existing: SessionEntry,
  modelPatch: Partial<SessionEntry>,
): SessionEntry {
  if (
    modelPatch.modelOverrideSource !== "auto" ||
    !isConfigOwnedModelOverride(existing) ||
    !modelPatch.model
  ) {
    return existing;
  }
  const next: SessionEntry = {
    ...existing,
    model: modelPatch.model,
    modelOverride: modelPatch.modelOverride,
    modelOverrideSource: "auto",
    modelOverrideRouteResolution: modelPatch.modelOverrideRouteResolution,
  };
  delete next.modelProvider;
  delete next.providerOverride;
  if (modelPatch.modelProvider) {
    next.modelProvider = modelPatch.modelProvider;
  }
  if (modelPatch.providerOverride) {
    next.providerOverride = modelPatch.providerOverride;
  }
  delete next.modelOverrideFallbackOriginProvider;
  delete next.modelOverrideFallbackOriginModel;
  if (modelPatch.modelOverrideFallbackOriginProvider) {
    next.modelOverrideFallbackOriginProvider = modelPatch.modelOverrideFallbackOriginProvider;
  }
  if (modelPatch.modelOverrideFallbackOriginModel) {
    next.modelOverrideFallbackOriginModel = modelPatch.modelOverrideFallbackOriginModel;
  }
  return next;
}

function provisionalSessionIdentityMatches(
  entry: SessionEntry,
  identity?: ProvisionalSessionCleanupIdentity,
): boolean {
  return (
    (identity?.expectedSessionId === undefined || entry.sessionId === identity.expectedSessionId) &&
    (identity?.expectedLifecycleRevision === undefined ||
      entry.lifecycleRevision === identity.expectedLifecycleRevision) &&
    (identity?.expectedSessionUpdatedAt === undefined ||
      entry.updatedAt === identity.expectedSessionUpdatedAt)
  );
}

export function loadSubagentConfig() {
  return getSubagentSpawnDeps().getRuntimeConfig();
}

export async function createInitialSubagentSession(params: {
  cfg: OpenClawConfig;
  targetAgentId: string;
  childSessionKey: string;
  requireFreshIdentity?: boolean;
  incognito: boolean;
  requesterInternalKey: string;
  completionOwnerSessionKey: string;
  pluginOwnerId?: string;
  spawnedWorkspaceDir?: string;
  spawnedCwd?: string;
  admissionPatch?: Record<string, unknown>;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
  modelPatch: Record<string, unknown>;
  reservedSubagentRunId?: string;
  reservedSubagentRequesterSessionId?: string;
  reservedSubagentRequesterLifecycleRevisionPresent?: boolean;
  reservedSubagentRequesterLifecycleRevision?: string;
  reservedSubagentClaimToken?: string;
  swarmGroupId?: string;
  collect: boolean;
  outputSchema?: Record<string, unknown>;
}): Promise<{ status: "ok"; entry?: SessionEntry } | { status: "error"; error: string }> {
  const initialChildSessionPatch: Record<string, unknown> = {
    spawnedBy: params.requesterInternalKey,
    completionOwnerSessionKey: params.completionOwnerSessionKey,
    ...(params.pluginOwnerId ? { pluginOwnerId: params.pluginOwnerId } : {}),
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
    ...(params.reservedSubagentRunId
      ? { reservedSubagentRunId: params.reservedSubagentRunId }
      : {}),
    ...(params.reservedSubagentRequesterSessionId
      ? { reservedSubagentRequesterSessionId: params.reservedSubagentRequesterSessionId }
      : {}),
    ...(params.reservedSubagentRequesterLifecycleRevisionPresent !== undefined
      ? {
          reservedSubagentRequesterLifecycleRevisionPresent:
            params.reservedSubagentRequesterLifecycleRevisionPresent,
        }
      : {}),
    ...(params.reservedSubagentRequesterLifecycleRevision !== undefined
      ? {
          reservedSubagentRequesterLifecycleRevision:
            params.reservedSubagentRequesterLifecycleRevision,
        }
      : {}),
    ...(params.reservedSubagentClaimToken
      ? { reservedSubagentClaimToken: params.reservedSubagentClaimToken }
      : {}),
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
    const patch = {
      ...buildDirectChildSessionPatch(initialChildSessionPatch),
      ...childSessionIdentity,
      ...buildSessionCreationStamp({
        via: "spawn",
        actor: { type: "agent", id: params.requesterInternalKey },
      }),
    };
    const modelPatch = buildDirectChildSessionPatch(params.modelPatch);
    const createEntry = async () =>
      await upsertSessionEntry(
        {
          storePath: target.storePath,
          sessionKey: target.canonicalKey,
        },
        patch,
      );
    const entry = params.requireFreshIdentity
      ? await runExclusiveSessionLifecycleMutation({
          scope: target.storePath,
          identities: new Set([target.canonicalKey, ...target.storeKeys]),
          run: async () => {
            const existing = loadSessionEntry({
              agentId: target.agentId,
              storePath: target.storePath,
              sessionKey: target.canonicalKey,
            });
            if (existing) {
              const reserved = params.pluginOwnerId
                ? existing.pluginExtensions?.[params.pluginOwnerId]?.openclawReservedSubagent
                : undefined;
              const requesterLifecycleRevisionPresent =
                params.reservedSubagentRequesterLifecycleRevisionPresent;
              const requesterLifecycleRevision = requesterLifecycleRevisionPresent
                ? (params.reservedSubagentRequesterLifecycleRevision ?? null)
                : null;
              const exactReplay =
                params.reservedSubagentRunId &&
                params.reservedSubagentRequesterSessionId &&
                requesterLifecycleRevisionPresent !== undefined &&
                params.reservedSubagentClaimToken &&
                isReservedSubagentReplayMarker(reserved) &&
                reserved?.runId === params.reservedSubagentRunId &&
                reserved?.requesterSessionId === params.reservedSubagentRequesterSessionId &&
                reserved?.requesterLifecycleRevisionPresent === requesterLifecycleRevisionPresent &&
                reserved?.requesterLifecycleRevision === requesterLifecycleRevision &&
                reserved?.claimToken === params.reservedSubagentClaimToken &&
                existing.pluginOwnerId === params.pluginOwnerId &&
                existing.spawnedBy === params.requesterInternalKey &&
                existing.parentSessionKey === params.requesterInternalKey;
              if (exactReplay) {
                const refreshed = refreshConfigOwnedModelReplayFields(existing, modelPatch);
                return refreshed === existing
                  ? existing
                  : await upsertSessionEntry(
                      {
                        storePath: target.storePath,
                        sessionKey: target.canonicalKey,
                      },
                      refreshed,
                    );
              }
              throw new Error("reserved childSessionKey already exists");
            }
            return await createEntry();
          },
        })
      : await createEntry();
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
  expectedIdentity?: ProvisionalSessionCleanupIdentity;
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
    const patched = await patchSessionEntry(
      {
        storePath: target.storePath,
        sessionKey: target.canonicalKey,
      },
      (entry) => {
        if (!provisionalSessionIdentityMatches(entry, params.expectedIdentity)) {
          throw new Error("child session identity changed before runtime model patch");
        }
        return {
          ...entry,
          model,
          ...(provider ? { modelProvider: provider } : {}),
        };
      },
      {
        requireWriteSuccess: true,
        replaceEntry: true,
      },
    );
    if (!patched) {
      return "child session identity changed before runtime model patch";
    }
    return undefined;
  } catch (err) {
    return err instanceof Error ? err.message : typeof err === "string" ? err : "error";
  }
}
