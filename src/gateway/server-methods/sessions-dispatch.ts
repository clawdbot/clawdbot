// Cloud-worker dispatch for managed-worktree sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsDispatchParams,
  validateSessionsReclaimParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-create-service.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { projectWorkerSessionPlacement } from "../worker-environments/placement-projector.js";
import {
  isWorkerPlacementSessionRuntimeSupported,
  resolveWorkerPlacementSessionRuntime,
} from "../worker-environments/placement-session-runtime.js";
import {
  isWorkerDispatchInputError,
  loadAccessorSessionEntryForGatewayTarget,
  requireSessionKey,
} from "./sessions-shared.js";
import type { GatewayRequestContext, GatewayRequestHandlers, RespondFn } from "./types.js";
import { assertValidParams } from "./validation.js";

function respondInvalidWorkerSession(respond: RespondFn, message: string): void {
  respond(false, undefined, errorShape(ErrorCodes.INVALID_REQUEST, message));
}

function resolveWorkerSessionTarget(params: {
  key: string;
  agentId?: string;
  profileId?: string;
  context: GatewayRequestContext;
  respond: RespondFn;
}) {
  const cfg = params.context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, params.key, params.agentId);
  if (!requestedAgent.ok) {
    params.respond(false, undefined, requestedAgent.error);
    return undefined;
  }
  if (
    params.profileId !== undefined &&
    !Object.hasOwn(cfg.cloudWorkers?.profiles ?? {}, params.profileId)
  ) {
    respondInvalidWorkerSession(
      params.respond,
      `cloud worker profile is not configured: ${params.profileId}`,
    );
    return undefined;
  }
  const target = loadAccessorSessionEntryForGatewayTarget({
    key: params.key,
    cfg,
    agentId: requestedAgent.agentId,
  });
  const entry = target.entry;
  const sessionId = normalizeOptionalString(entry?.sessionId);
  if (!entry || !sessionId) {
    respondInvalidWorkerSession(params.respond, `session not found: ${params.key}`);
    return undefined;
  }
  return { cfg, target, entry, sessionId };
}

function hasManagedSessionWorktree(params: {
  entry: NonNullable<ReturnType<typeof loadAccessorSessionEntryForGatewayTarget>["entry"]>;
  sessionKey: string;
  method: "sessions.dispatch" | "sessions.reclaim";
  respond: RespondFn;
}): boolean {
  const worktree = managedWorktrees.findLiveByOwner("session", params.sessionKey);
  if (
    params.entry.worktree?.id &&
    worktree &&
    worktree.id === params.entry.worktree.id &&
    worktree.ownerId === params.sessionKey
  ) {
    return true;
  }
  const article = params.method === "sessions.dispatch" ? "a" : "the";
  respondInvalidWorkerSession(
    params.respond,
    `${params.method} requires ${article} session-owned managed worktree`,
  );
  return false;
}

function respondWorkerPlacement(params: {
  respond: RespondFn;
  key: string;
  sessionId: string;
  placement: Parameters<typeof projectWorkerSessionPlacement>[0];
}): void {
  params.respond(
    true,
    {
      ok: true,
      key: params.key,
      sessionId: params.sessionId,
      placement: projectWorkerSessionPlacement(params.placement),
    },
    undefined,
  );
}

function respondWorkerDispatchError(error: unknown, respond: RespondFn): void {
  if (error instanceof SessionMutationAuthorizationChangedError) {
    throw error;
  }
  respond(
    false,
    undefined,
    errorShape(
      isWorkerDispatchInputError(error) ? ErrorCodes.INVALID_REQUEST : ErrorCodes.UNAVAILABLE,
      formatErrorMessage(error),
    ),
  );
}

export const sessionDispatchHandlers: GatewayRequestHandlers = {
  "sessions.dispatch": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsDispatchParams, "sessions.dispatch", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const dispatchService = context.workerPlacementDispatchService;
    const placementReader = context.workerSessionPlacementService;
    if (!dispatchService || !placementReader) {
      respondInvalidWorkerSession(respond, "cloud worker dispatch is not configured");
      return;
    }
    const resolved = resolveWorkerSessionTarget({
      key,
      agentId: params.agentId,
      profileId: params.profileId,
      context,
      respond,
    });
    if (!resolved) {
      return;
    }
    const { cfg, target, entry, sessionId } = resolved;
    if (entry.archivedAt !== undefined) {
      respondInvalidWorkerSession(respond, "cannot dispatch an archived session");
      return;
    }
    const sessionRuntime = resolveWorkerPlacementSessionRuntime({
      cfg,
      entry,
      agentId: target.target.agentId,
      sessionKey: target.canonicalKey,
    });
    if (!isWorkerPlacementSessionRuntimeSupported(sessionRuntime)) {
      respondInvalidWorkerSession(
        respond,
        `cloud worker dispatch requires the OpenClaw runtime, not ${sessionRuntime}`,
      );
      return;
    }
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    if (
      existingPlacement &&
      existingPlacement.state !== "local" &&
      existingPlacement.state !== "reclaimed"
    ) {
      respondInvalidWorkerSession(
        respond,
        `session cannot dispatch from placement ${existingPlacement.state}`,
      );
      return;
    }
    if (
      !hasManagedSessionWorktree({
        entry,
        sessionKey: target.canonicalKey,
        method: "sessions.dispatch",
        respond,
      })
    ) {
      return;
    }
    try {
      // Dispatch is session-id addressed after this point; reject a replacement before handing
      // the captured instance to the asynchronous worker service.
      sessionMutationAuthorization?.assertCurrent();
      const placement = await dispatchService.dispatch({
        sessionId,
        sessionKey: target.canonicalKey,
        agentId: target.target.agentId,
        profileId: params.profileId,
      });
      respondWorkerPlacement({ respond, key: target.canonicalKey, sessionId, placement });
    } catch (error) {
      respondWorkerDispatchError(error, respond);
    }
  },
  "sessions.reclaim": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsReclaimParams, "sessions.reclaim", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const placementService = context.workerPlacementDispatchService;
    const placementReader = context.workerSessionPlacementService;
    if (!placementService?.reclaim || !placementReader) {
      respondInvalidWorkerSession(respond, "cloud worker stop is not configured");
      return;
    }
    const resolved = resolveWorkerSessionTarget({
      key,
      agentId: params.agentId,
      context,
      respond,
    });
    if (!resolved) {
      return;
    }
    const { target, entry, sessionId } = resolved;
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    if (existingPlacement?.state === "reclaimed") {
      respondWorkerPlacement({
        respond,
        key: target.canonicalKey,
        sessionId,
        placement: existingPlacement,
      });
      return;
    }
    if (existingPlacement?.state !== "active") {
      respondInvalidWorkerSession(
        respond,
        `session cannot stop cloud worker from placement ${existingPlacement?.state ?? "local"}`,
      );
      return;
    }
    if (
      !hasManagedSessionWorktree({
        entry,
        sessionKey: target.canonicalKey,
        method: "sessions.reclaim",
        respond,
      })
    ) {
      return;
    }
    try {
      sessionMutationAuthorization?.assertCurrent();
      const placement = await placementService.reclaim({
        sessionId,
        sessionKey: target.canonicalKey,
        agentId: target.target.agentId,
      });
      respondWorkerPlacement({ respond, key: target.canonicalKey, sessionId, placement });
    } catch (error) {
      respondWorkerDispatchError(error, respond);
    }
  },
};
