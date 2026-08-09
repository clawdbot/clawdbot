// Shared session-handler target resolution and mutation guards.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionOperationEvent,
  type SessionPlacement,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { listConfiguredSessionStoreAgentIds, type SessionEntry } from "../../config/sessions.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { normalizeAgentId, parseAgentSessionKey } from "../../routing/session-key.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  resolvePluginSessionOwnershipError,
  type PluginSessionOwnershipAction,
} from "../session-plugin-ownership.js";
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "../session-store-key.js";
import type {
  GatewaySessionStoreTarget,
  GatewaySessionStoreTargetWithStore,
} from "../session-utils-contracts.js";
import type {
  GatewaySessionStoreCache,
  GatewaySessionStoreDiscoveryCache,
} from "../session-utils-store-lookup.js";
import {
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";
import {
  isWorkerPlacementSessionRuntimeSupported,
  resolveWorkerPlacementSessionRuntime,
} from "../worker-environments/placement-session-runtime.js";
import type { WorkerSessionPlacementRetirement } from "../worker-environments/placement-store.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export const sessionLog = createSubsystemLogger("gateway/sessions");

export class SessionWorkerPlacementMutationError extends Error {
  constructor(
    readonly placementState: SessionPlacement["state"],
    action: "delete" | "fork" | "reset" | "restore" | "rewind" | "switch",
    key: string,
  ) {
    super(`Session ${key} cannot ${action} while cloud worker placement is ${placementState}.`);
  }
}

type SessionWorkerPlacementMutationGuard = {
  error?: SessionWorkerPlacementMutationError;
  retirement?: WorkerSessionPlacementRetirement;
};

export function resolveSessionWorkerPlacementMutationGuard(params: {
  action: "delete" | "fork" | "reset" | "restore" | "rewind" | "switch";
  context: GatewayRequestContext;
  key: string;
  sessionId: string | undefined;
}): SessionWorkerPlacementMutationGuard {
  if (!params.sessionId) {
    return {};
  }
  const placement = params.context.workerSessionPlacementService
    ?.getMany([params.sessionId])
    .get(params.sessionId);
  const environment = placement?.environmentId
    ? params.context.workerEnvironmentService?.get(placement.environmentId)
    : undefined;
  // finishProvenDestroy clears leaseId only after provider teardown succeeds. Failed environments
  // that retain a lease stay fenced because their teardown is pending or indeterminate.
  const failedPlacementCanDelete =
    params.action === "delete" &&
    placement?.state === "failed" &&
    (placement.environmentId === null ||
      environment?.state === "destroyed" ||
      (environment?.state === "failed" && environment.leaseId === null));
  const placementCanMutate =
    !placement ||
    placement.state === "local" ||
    (params.action === "delete" && placement.state === "reclaimed") ||
    failedPlacementCanDelete;
  if (!placementCanMutate) {
    return {
      error: new SessionWorkerPlacementMutationError(placement.state, params.action, params.key),
    };
  }
  if (
    params.action === "delete" &&
    placement &&
    (placement.state === "local" || placement.state === "reclaimed" || placement.state === "failed")
  ) {
    return {
      retirement: {
        sessionId: placement.sessionId,
        expectedState: placement.state,
        expectedGeneration: placement.generation,
      },
    };
  }
  return {};
}

export function resolveSessionWorkerPlacementMutationError(
  params: Parameters<typeof resolveSessionWorkerPlacementMutationGuard>[0],
): SessionWorkerPlacementMutationError | undefined {
  return resolveSessionWorkerPlacementMutationGuard(params).error;
}

export function respondSessionWorkerPlacementMutationError(
  error: SessionWorkerPlacementMutationError,
  respond: RespondFn,
): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, error.message));
}

export function resolveSessionWorkerPlacementPatchError(params: {
  agentId: string;
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  entry: SessionEntry | undefined;
  key: string;
  patch: SessionsPatchParams;
  sessionKey: string;
  validateModelRuntime: boolean;
}): string | undefined {
  const placement = params.entry?.sessionId
    ? params.context.workerSessionPlacementService
        ?.getMany([params.entry.sessionId])
        .get(params.entry.sessionId)
    : undefined;
  if (!placement || placement.state === "local") {
    return undefined;
  }
  if (params.patch.archived !== undefined) {
    return `Session ${params.key} cannot change archive state while cloud worker placement is ${placement.state}.`;
  }
  if (!params.validateModelRuntime || params.patch.model === undefined || !params.entry) {
    return undefined;
  }
  const runtime = resolveWorkerPlacementSessionRuntime({
    cfg: params.cfg,
    entry: params.entry,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  if (isWorkerPlacementSessionRuntimeSupported(runtime)) {
    return undefined;
  }
  return `Session ${params.key} cannot select the ${runtime} runtime while cloud worker placement is ${placement.state}.`;
}

export function filterSessionStoreToConfiguredAgents(
  cfg: OpenClawConfig,
  store: Record<string, SessionEntry>,
): Record<string, SessionEntry> {
  const configuredAgentIds = new Set(listConfiguredSessionStoreAgentIds(cfg));
  const isConfiguredSessionKey = (key: string | undefined) => {
    const normalizedKey = normalizeOptionalString(key);
    if (!normalizedKey) {
      return false;
    }
    const canonicalKey = resolveSessionStoreKey({ cfg, sessionKey: normalizedKey });
    const agentId = resolveSessionStoreAgentId(cfg, canonicalKey);
    return configuredAgentIds.has(normalizeAgentId(agentId));
  };
  return Object.fromEntries(
    Object.entries(store).filter(([key, entry]) => {
      if (key === "global" || key === "unknown") {
        return true;
      }
      if (isConfiguredSessionKey(key)) {
        return true;
      }
      // Keep spawned child sessions visible when their parent belongs to a configured agent.
      return (
        isConfiguredSessionKey(entry?.spawnedBy) || isConfiguredSessionKey(entry?.parentSessionKey)
      );
    }),
  );
}

export const loadSessionsRuntimeModule = createLazyRuntimeModule(
  () => import("./sessions.runtime.js"),
);

export function requireSessionKey(key: unknown, respond: RespondFn): string | null {
  const raw =
    typeof key === "string"
      ? key
      : typeof key === "number"
        ? String(key)
        : typeof key === "bigint"
          ? String(key)
          : "";
  const normalized = normalizeOptionalString(raw) ?? "";
  if (!normalized) {
    respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, "key required"));
    return null;
  }
  return normalized;
}

export function rejectPluginRuntimeSessionOwnershipMismatch(params: {
  action: PluginSessionOwnershipAction;
  client: GatewayClient | null;
  key: string;
  entry: SessionEntry | undefined;
  respond: RespondFn;
}): boolean {
  const error = resolvePluginSessionOwnershipError({
    action: params.action,
    entry: params.entry,
    key: params.key,
    pluginOwnerId: params.client?.internal?.pluginRuntimeOwnerId,
  });
  if (!error) {
    return false;
  }
  params.respond(false, undefined, error);
  return true;
}

type GatewaySessionTargetOptions = {
  agentId?: string;
  exactRead?: boolean;
  storeCache?: GatewaySessionStoreCache;
  targetDiscoveryCache?: GatewaySessionStoreDiscoveryCache;
};

type HydratedGatewaySessionTargetOptions = GatewaySessionTargetOptions &
  (
    | { exactRead: true }
    | { storeCache: GatewaySessionStoreCache }
    | { targetDiscoveryCache: GatewaySessionStoreDiscoveryCache }
  );

export function resolveGatewaySessionTargetFromKey(
  key: string,
  cfg: OpenClawConfig,
  opts: HydratedGatewaySessionTargetOptions,
): { cfg: OpenClawConfig; target: GatewaySessionStoreTargetWithStore; storePath: string };
export function resolveGatewaySessionTargetFromKey(
  key: string,
  cfg: OpenClawConfig,
  opts?: GatewaySessionTargetOptions,
): { cfg: OpenClawConfig; target: GatewaySessionStoreTarget; storePath: string };
export function resolveGatewaySessionTargetFromKey(
  key: string,
  cfg: OpenClawConfig,
  opts?: GatewaySessionTargetOptions,
) {
  const targetOptions = {
    cfg,
    key,
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
  };
  const needsStore =
    opts?.exactRead === true ||
    opts?.storeCache !== undefined ||
    opts?.targetDiscoveryCache !== undefined;
  const target = needsStore
    ? resolveGatewaySessionStoreTargetWithStore({
        ...targetOptions,
        ...(opts?.exactRead === true ? { exactRead: true } : {}),
        ...(opts?.storeCache !== undefined ? { storeCache: opts.storeCache } : {}),
        ...(opts?.targetDiscoveryCache !== undefined
          ? { targetDiscoveryCache: opts.targetDiscoveryCache }
          : {}),
      })
    : resolveGatewaySessionStoreTarget(targetOptions);
  return { cfg, target, storePath: target.storePath };
}

export function loadAccessorSessionEntryForGatewayTarget(params: {
  key: string;
  cfg: OpenClawConfig;
  agentId?: string;
}) {
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg: params.cfg,
    key: params.key,
    clone: false,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  let best:
    | {
        entry: SessionEntry;
        sessionStoreKey: string;
      }
    | undefined;
  for (const sessionStoreKey of target.storeKeys) {
    const entry = target.store[sessionStoreKey];
    if (entry) {
      if (!best || (entry.updatedAt ?? 0) > (best.entry.updatedAt ?? 0)) {
        best = { entry, sessionStoreKey };
      }
    }
  }
  if (best) {
    return {
      target,
      storePath: target.storePath,
      entry: best.entry,
      canonicalKey: target.canonicalKey,
      sessionStoreKey: best.sessionStoreKey,
    };
  }
  return {
    target,
    storePath: target.storePath,
    entry: undefined,
    canonicalKey: target.canonicalKey,
    sessionStoreKey: target.canonicalKey,
  };
}

export function loadSessionEntriesForTarget(params: {
  key: string;
  cfg: OpenClawConfig;
  agentId?: string;
}) {
  const target = resolveGatewaySessionStoreTargetWithStore({
    cfg: params.cfg,
    key: params.key,
    clone: false,
    ...(params.agentId ? { agentId: params.agentId } : {}),
  });
  const store = target.store;
  const entry = resolveCanonicalSessionEntryFromStoreKeys(store, target.storeKeys);
  return { target, storePath: target.storePath, store, entry };
}

export function emitSessionOperation(
  context: Pick<GatewayRequestContext, "broadcastToConnIds" | "getSessionEventSubscriberConnIds">,
  payload: Omit<SessionOperationEvent, "ts">,
) {
  const connIds = context.getSessionEventSubscriberConnIds();
  if (connIds.size === 0) {
    return;
  }
  context.broadcastToConnIds(
    "session.operation",
    {
      ...payload,
      ts: Date.now(),
    } satisfies SessionOperationEvent,
    connIds,
    { dropIfSlow: true },
  );
}

export function isWorkerDispatchInputError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return false;
  }
  const code = error.code;
  return code === "invalid_profile" || code === "profile_not_found" || code === "invalid_state";
}

export function isAgentMainSessionKey(cfg: OpenClawConfig, sessionKey: string): boolean {
  const parsed = parseAgentSessionKey(sessionKey);
  if (!parsed) {
    return false;
  }
  return sessionKey === resolveAgentMainSessionKey({ cfg, agentId: parsed.agentId });
}
