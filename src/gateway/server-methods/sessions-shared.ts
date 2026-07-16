// Shared session-handler target resolution and mutation guards.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { GATEWAY_CLIENT_IDS } from "../../../packages/gateway-protocol/src/client-info.js";
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
import { resolveSessionStoreAgentId, resolveSessionStoreKey } from "../session-store-key.js";
import {
  resolveFreshestSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";
import {
  isWorkerPlacementSessionRuntimeSupported,
  resolveWorkerPlacementSessionRuntime,
} from "../worker-environments/placement-session-runtime.js";
import type { GatewayClient, GatewayRequestContext, RespondFn } from "./types.js";

export const sessionLog = createSubsystemLogger("gateway/sessions");

export class SessionWorkerPlacementMutationError extends Error {
  constructor(
    readonly placementState: SessionPlacement["state"],
    action: "delete" | "reset" | "restore",
    key: string,
  ) {
    super(`Session ${key} cannot ${action} while cloud worker placement is ${placementState}.`);
  }
}

export function resolveSessionWorkerPlacementMutationError(params: {
  action: "delete" | "reset" | "restore";
  context: GatewayRequestContext;
  key: string;
  sessionId: string | undefined;
}): SessionWorkerPlacementMutationError | undefined {
  if (!params.sessionId) {
    return undefined;
  }
  const placement = params.context.workerSessionPlacementService
    ?.getMany([params.sessionId])
    .get(params.sessionId);
  // Failed placement normally keeps destructive mutation fenced. Missing worker identity or an
  // authoritative destroyed environment proves cleanup cannot orphan a live worker.
  const failedPlacementCanDelete =
    params.action === "delete" &&
    placement?.state === "failed" &&
    (placement.environmentId === null ||
      params.context.workerEnvironmentService?.get(placement.environmentId)?.state === "destroyed");
  if (
    !placement ||
    placement.state === "local" ||
    (params.action === "delete" && placement.state === "reclaimed") ||
    failedPlacementCanDelete
  ) {
    return undefined;
  }
  return new SessionWorkerPlacementMutationError(placement.state, params.action, params.key);
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

export function rejectPluginRuntimeDeleteMismatch(params: {
  client: GatewayClient | null;
  key: string;
  entry: SessionEntry | undefined;
  respond: RespondFn;
}): boolean {
  const pluginOwnerId = normalizeOptionalString(params.client?.internal?.pluginRuntimeOwnerId);
  if (!pluginOwnerId || !params.entry) {
    return false;
  }
  if (normalizeOptionalString(params.entry.pluginOwnerId) === pluginOwnerId) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `Plugin "${pluginOwnerId}" cannot delete session "${params.key}" because it did not create it.`,
    ),
  );
  return true;
}

export function resolveGatewaySessionTargetFromKey(
  key: string,
  cfg: OpenClawConfig,
  opts?: { agentId?: string },
) {
  const target = resolveGatewaySessionStoreTarget({
    cfg,
    key,
    ...(opts?.agentId ? { agentId: opts.agentId } : {}),
  });
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
  const entry = resolveFreshestSessionEntryFromStoreKeys(store, target.storeKeys);
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

export function rejectWebchatSessionMutation(params: {
  action: "patch" | "delete" | "compact" | "branch" | "restore" | "dispatch" | "reclaim";
  client: GatewayClient | null;
  isWebchatConnect: (params: GatewayClient["connect"] | null | undefined) => boolean;
  respond: RespondFn;
}): boolean {
  if (!params.client?.connect || !params.isWebchatConnect(params.client.connect)) {
    return false;
  }
  if (params.client.connect.client.id === GATEWAY_CLIENT_IDS.CONTROL_UI) {
    return false;
  }
  params.respond(
    false,
    undefined,
    errorShape(
      ErrorCodes.INVALID_REQUEST,
      `webchat clients cannot ${params.action} sessions; use chat.send for session-scoped updates`,
    ),
  );
  return true;
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
