// Cloud-worker dispatch for managed-worktree sessions.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import {
  ErrorCodes,
  errorShape,
  validateSessionsDispatchParams,
  validateSessionsMoveParams,
  validateSessionsReclaimParams,
} from "../../../packages/gateway-protocol/src/index.js";
import { managedWorktrees } from "../../agents/worktrees/service.js";
import type { ManagedWorktreeRecord } from "../../agents/worktrees/types.js";
import { normalizeCloudRepo } from "../../config/cloud-worker-project-profiles.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import { resolveRequestedSessionAgentId as resolveRequestedGlobalAgentId } from "../session-request-agent.js";
import { SessionMutationAuthorizationChangedError } from "../session-sharing.js";
import { resolveWorkerPlacementDestination } from "../worker-environments/placement-destination.js";
import { projectWorkerSessionPlacement } from "../worker-environments/placement-projector.js";
import type { WorkerSessionPlacementRecord } from "../worker-environments/placement-record.js";
import {
  resolveWorkerPlacementExecutionMode,
  resolveWorkerPlacementSessionRuntime,
} from "../worker-environments/placement-session-runtime.js";
import { isFailedWorkerPlacementEnvironmentGone } from "../worker-environments/session-placement-lifecycle.js";
import { emitSessionsChanged } from "./session-change-event.js";
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

const PROJECT_ORIGIN_TIMEOUT_MS = 4_000;

class CloudWorkerProjectProfileError extends Error {
  readonly code = "invalid_profile";
}

function resolveWorkerSessionTarget(params: {
  key: string;
  agentId?: string;
  profileId?: string;
  deviceId?: string;
  machineClass?: string;
  context: GatewayRequestContext;
  respond: RespondFn;
}) {
  const cfg = params.context.getRuntimeConfig();
  const requestedAgent = resolveRequestedGlobalAgentId(cfg, params.key, params.agentId);
  if (!requestedAgent.ok) {
    params.respond(false, undefined, requestedAgent.error);
    return undefined;
  }
  const destination = resolveWorkerPlacementDestination({
    cfg,
    profileId: params.profileId,
    deviceId: params.deviceId,
    machineClass: params.machineClass,
  });
  if (!destination.ok) {
    respondInvalidWorkerSession(params.respond, destination.error);
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
  return { cfg, target, entry, sessionId, dispatchTarget: destination.value };
}

function resolveManagedSessionWorktree(params: {
  entry: NonNullable<ReturnType<typeof loadAccessorSessionEntryForGatewayTarget>["entry"]>;
  sessionKey: string;
  method: "sessions.dispatch" | "sessions.move" | "sessions.reclaim";
  respond: RespondFn;
}): ManagedWorktreeRecord | undefined {
  const worktree = managedWorktrees.findLiveByOwner("session", params.sessionKey);
  if (
    params.entry.worktree?.id &&
    worktree &&
    worktree.id === params.entry.worktree.id &&
    worktree.ownerId === params.sessionKey
  ) {
    return worktree;
  }
  const article = params.method === "sessions.dispatch" ? "a" : "the";
  respondInvalidWorkerSession(
    params.respond,
    `${params.method} requires ${article} session-owned managed worktree`,
  );
  return undefined;
}

async function resolveProjectProfileDestination(params: {
  cfg: ReturnType<GatewayRequestContext["getRuntimeConfig"]>;
  worktree: ManagedWorktreeRecord;
}) {
  let originUrl: string;
  try {
    const result = await runCommandWithTimeout(
      ["git", "-C", params.worktree.path, "config", "--get", "remote.origin.url"],
      { timeoutMs: PROJECT_ORIGIN_TIMEOUT_MS },
    );
    if (result.code !== 0) {
      return undefined;
    }
    originUrl = result.stdout.trim();
  } catch {
    return undefined;
  }
  const projectKey = normalizeCloudRepo(originUrl);
  if (!projectKey) {
    return undefined;
  }
  const profileId = params.cfg.cloudWorkers?.projectProfiles?.[projectKey];
  if (!profileId) {
    return undefined;
  }
  if (!Object.hasOwn(params.cfg.cloudWorkers?.profiles ?? {}, profileId)) {
    throw new CloudWorkerProjectProfileError(
      `cloudWorkers.projectProfiles mapping ${projectKey} references unconfigured profile ${profileId}`,
    );
  }
  return { profileId };
}

function validateDispatchExecutionMode(params: {
  context: GatewayRequestContext;
  executionMode: "worker-turn" | "remote-exec";
  sessionRuntime: string;
  target: { profileId: string; deviceId?: string };
  respond: RespondFn;
}): boolean {
  if (
    params.executionMode !== "remote-exec" ||
    (params.target.deviceId === undefined &&
      params.context.workerEnvironmentService?.supportsExecutionMode?.(
        params.target.profileId,
        params.executionMode,
      ) === true)
  ) {
    return true;
  }
  respondInvalidWorkerSession(
    params.respond,
    params.target.deviceId !== undefined
      ? `runtime ${params.sessionRuntime} cannot dispatch to a paired device; select an agent/model route with agentRuntime.id "openclaw" (the embedded runtime), or choose an SSH-backed cloud worker provider`
      : `runtime ${params.sessionRuntime} requires an SSH-backed cloud worker provider; choose a provider that supports remote-exec, or select an agent/model route with agentRuntime.id "openclaw"`,
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

function respondWorkerMove(params: {
  respond: RespondFn;
  key: string;
  sessionId: string;
  placement: Extract<WorkerSessionPlacementRecord, { state: "local" | "active" }>;
}): void {
  params.respond(
    true,
    {
      ok: true,
      key: params.key,
      sessionId: params.sessionId,
      placement: {
        state: params.placement.state,
        generation: params.placement.generation,
      },
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
      deviceId: params.deviceId,
      machineClass: params.machineClass,
      context,
      respond,
    });
    if (!resolved) {
      return;
    }
    const { cfg, target, entry, sessionId } = resolved;
    let { dispatchTarget } = resolved;
    const canUseProjectProfile = params.profileId === undefined && params.deviceId === undefined;
    if (!dispatchTarget && !canUseProjectProfile) {
      respondInvalidWorkerSession(respond, "worker dispatch target is missing");
      return;
    }
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
    const executionMode = resolveWorkerPlacementExecutionMode(sessionRuntime);
    if (!executionMode) {
      respondInvalidWorkerSession(
        respond,
        `runtime ${sessionRuntime} lacks cloud placement support`,
      );
      return;
    }
    if (
      dispatchTarget &&
      !validateDispatchExecutionMode({
        context,
        executionMode,
        sessionRuntime,
        target: dispatchTarget,
        respond,
      })
    ) {
      return;
    }
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    if (
      existingPlacement?.state === "failed" &&
      !isFailedWorkerPlacementEnvironmentGone({
        environmentService: context.workerEnvironmentService,
        placement: existingPlacement,
      })
    ) {
      respondInvalidWorkerSession(
        respond,
        "cloud worker environment must be stopped before redispatch; use Stop cloud worker",
      );
      return;
    }
    if (
      existingPlacement &&
      (existingPlacement.state === "active" ||
        existingPlacement.state === "draining" ||
        existingPlacement.state === "reconciling")
    ) {
      respondInvalidWorkerSession(
        respond,
        `session cannot dispatch from placement ${existingPlacement.state}`,
      );
      return;
    }
    const worktree = resolveManagedSessionWorktree({
      entry,
      sessionKey: target.canonicalKey,
      method: "sessions.dispatch",
      respond,
    });
    if (!worktree) {
      return;
    }
    if (!dispatchTarget && canUseProjectProfile) {
      try {
        dispatchTarget = await resolveProjectProfileDestination({ cfg, worktree });
      } catch (error) {
        respondWorkerDispatchError(error, respond);
        return;
      }
    }
    if (!dispatchTarget) {
      respondInvalidWorkerSession(respond, "worker dispatch target is missing");
      return;
    }
    if (
      canUseProjectProfile &&
      !validateDispatchExecutionMode({
        context,
        executionMode,
        sessionRuntime,
        target: dispatchTarget,
        respond,
      })
    ) {
      return;
    }
    try {
      const placement = await dispatchService.dispatch(
        {
          sessionId,
          sessionKey: target.canonicalKey,
          agentId: target.target.agentId,
          executionMode,
          ...dispatchTarget,
        },
        () =>
          emitSessionsChanged(context, {
            reason: "dispatch",
            sessionKey: target.canonicalKey,
          }),
        sessionMutationAuthorization?.assertCurrent,
      );
      respondWorkerPlacement({ respond, key: target.canonicalKey, sessionId, placement });
    } catch (error) {
      respondWorkerDispatchError(error, respond);
    }
  },
  "sessions.move": async ({ params, respond, context, sessionMutationAuthorization }) => {
    if (!assertValidParams(params, validateSessionsMoveParams, "sessions.move", respond)) {
      return;
    }
    const key = requireSessionKey(params.key, respond);
    if (!key) {
      return;
    }
    const placementService = context.workerPlacementDispatchService;
    const placementReader = context.workerSessionPlacementService;
    if (!placementService?.move || !placementReader) {
      respondInvalidWorkerSession(respond, "session placement move is not configured");
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
    if (entry.archivedAt !== undefined) {
      respondInvalidWorkerSession(respond, "cannot move an archived session");
      return;
    }
    const existingPlacement = placementReader.getMany([sessionId]).get(sessionId);
    if (existingPlacement?.state !== "active" && existingPlacement?.state !== "draining") {
      respondInvalidWorkerSession(
        respond,
        `session cannot move from placement ${existingPlacement?.state ?? "local"}`,
      );
      return;
    }
    if (
      !resolveManagedSessionWorktree({
        entry,
        sessionKey: target.canonicalKey,
        method: "sessions.move",
        respond,
      })
    ) {
      return;
    }
    try {
      const placement = await placementService.move(
        {
          sessionId,
          sessionKey: target.canonicalKey,
          agentId: target.target.agentId,
          source: params.expected,
          target: params.target,
          ...("abandonSource" in params ? { abandonSource: true } : {}),
        },
        () =>
          emitSessionsChanged(context, {
            reason: "move",
            sessionKey: target.canonicalKey,
          }),
        sessionMutationAuthorization?.assertCurrent,
      );
      respondWorkerMove({
        respond,
        key: target.canonicalKey,
        sessionId,
        placement,
      });
    } catch (error) {
      if (error instanceof SessionMutationAuthorizationChangedError) {
        throw error;
      }
      emitSessionsChanged(context, { reason: "move", sessionKey: target.canonicalKey });
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
    if (
      existingPlacement?.state !== "failed" &&
      !resolveManagedSessionWorktree({
        entry,
        sessionKey: target.canonicalKey,
        method: "sessions.reclaim",
        respond,
      })
    ) {
      return;
    }
    try {
      const placement = await placementService.reclaim(
        {
          sessionId,
          sessionKey: target.canonicalKey,
          agentId: target.target.agentId,
        },
        sessionMutationAuthorization?.assertCurrent,
      );
      respondWorkerPlacement({ respond, key: target.canonicalKey, sessionId, placement });
    } catch (error) {
      respondWorkerDispatchError(error, respond);
    }
  },
};
