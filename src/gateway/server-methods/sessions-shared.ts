// Shared session-handler target resolution and mutation guards.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  type SessionOperationEvent,
  type SessionsPatchParams,
} from "../../../packages/gateway-protocol/src/index.js";
import type { SessionEntry } from "../../config/sessions.js";
import { resolveAgentMainSessionKey } from "../../config/sessions/main-session.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { parseAgentSessionKey } from "../../routing/session-key.js";
import { createLazyRuntimeModule } from "../../shared/lazy-runtime.js";
import {
  resolveCanonicalSessionEntryFromStoreKeys,
  resolveGatewaySessionStoreTarget,
  resolveGatewaySessionStoreTargetWithStore,
} from "../session-utils.js";
import {
  resolveWorkerPlacementExecutionMode,
  resolveWorkerPlacementSessionRuntime,
} from "../worker-environments/placement-session-runtime.js";
import { resolveWorkerPlacementArchiveRestoreError } from "../worker-environments/session-placement-lifecycle.js";
import type { GatewayRequestContext, RespondFn } from "./types.js";
export {
  resolveSessionWorkerPlacementMutationError,
  SessionWorkerPlacementMutationError,
} from "../worker-environments/session-placement-lifecycle.js";

export const sessionLog = createSubsystemLogger("gateway/sessions");

export function respondSessionWorkerPlacementMutationError(
  error: { message: string },
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
  if (params.patch.archived === false) {
    const restoreError = resolveWorkerPlacementArchiveRestoreError({
      context: params.context,
      key: params.key,
      placement,
    });
    if (restoreError) {
      return restoreError;
    }
  }
  if (
    !params.validateModelRuntime ||
    params.patch.model === undefined ||
    !params.entry?.sessionId
  ) {
    return undefined;
  }
  const runtime = resolveWorkerPlacementSessionRuntime({
    cfg: params.cfg,
    entry: params.entry,
    agentId: params.agentId,
    sessionKey: params.sessionKey,
  });
  const executionMode = resolveWorkerPlacementExecutionMode(runtime);
  if (executionMode === placement.executionMode) {
    return undefined;
  }
  return executionMode
    ? `Session ${params.key} cannot change cloud placement execution mode while placement is ${placement.state}.`
    : `Session ${params.key} cannot select the ${runtime} runtime while cloud worker placement is ${placement.state}.`;
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
