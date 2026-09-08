import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import type { SubagentLifecycleHookRunner } from "../../../plugins/hooks.js";
import { isValidAgentId, normalizeAgentId } from "../../../routing/session-key.js";
import { listAgentIds } from "../../agent-scope-config.js";
import { resolveSessionAgentId } from "../../agent-scope.js";
import { reserveChildAdmissionSlot } from "../../child-admission.js";
import { resolveSpawnAdmission, resolveSpawnMode } from "../../spawn-plan.js";
import { listSwarmRunsForGroup } from "../registry/subagent-registry.js";
import { resolveSwarmConfig } from "../swarm/swarm-config.js";
import { validateStructuredOutputSchema } from "../swarm/swarm-output-schema.js";
import { reserveSwarmRun } from "../swarm/swarm-scheduler.js";
import { resolveSubagentContextMode } from "./subagent-spawn-context.js";
import type {
  SpawnSubagentContext,
  SpawnSubagentParams,
  SpawnSubagentResult,
} from "./subagent-spawn-contract.js";
import { getSubagentSpawnDeps } from "./subagent-spawn-deps.js";
import { resolveSubagentSpawnOwnership } from "./subagent-spawn-ownership.js";
import { resolveConfiguredSubagentRunTimeoutSeconds } from "./subagent-spawn-plan.js";
import { loadSubagentConfig } from "./subagent-spawn-session-patch.js";
import { resolveInternalSessionKey, resolveMainSessionAlias } from "./subagent-spawn.runtime.js";
import { normalizeSubagentTaskName } from "./subagent-task-name.js";

type ResolvedSubagentSpawnRequest = {
  request: {
    taskName?: string;
    spawnMode: ReturnType<typeof resolveSpawnMode>;
    cleanup: "delete" | "keep";
    expectsCompletionMessage: boolean;
  };
  runtime: {
    hookRunner: SubagentLifecycleHookRunner | null;
    cfg: OpenClawConfig;
    runTimeoutSeconds: number;
    contextMode: ReturnType<typeof resolveSubagentContextMode>;
    requesterInternalKey: string;
    ownership: ReturnType<typeof resolveSubagentSpawnOwnership>;
    requesterAgentId: string;
    targetAgentId: string;
  };
  swarm: {
    config: ReturnType<typeof resolveSwarmConfig>;
    groupId?: string;
    schedulerGroupKey?: string;
    launchReplayKey?: string;
    soleImplicitMember: boolean;
    reservationPending: boolean;
  };
  admission: {
    resolve: (pendingChildren?: number) => ReturnType<typeof resolveSpawnAdmission>;
    initial: ReturnType<typeof resolveSpawnAdmission> & { ok: true };
    reservation?: { release: () => void };
    childDepth: number;
    maxSpawnDepth: number;
  };
  childIdem: string;
};

type ResolveSubagentSpawnRequestResult =
  | { ok: false; result: SpawnSubagentResult }
  | { ok: true; resolved: ResolvedSubagentSpawnRequest };

function rejectSubagentSpawnRequest(
  status: "error" | "forbidden",
  error: string,
): ResolveSubagentSpawnRequestResult {
  return { ok: false, result: { status, error } };
}

export function resolveSubagentSpawnRequest(
  params: SpawnSubagentParams,
  ctx: SpawnSubagentContext,
): ResolveSubagentSpawnRequestResult {
  const requestedAgentId = params.agentId?.trim();
  const taskNameResult = normalizeSubagentTaskName(params.taskName);
  if (taskNameResult.error) {
    return rejectSubagentSpawnRequest("error", taskNameResult.error);
  }
  const taskName = taskNameResult.taskName;

  // Reject malformed agentId before normalizeAgentId can mangle it.
  // Without this gate, error-message strings like "Agent not found: xyz" pass
  // through normalizeAgentId and become "agent-not-found--xyz", which later
  // creates ghost workspace directories and triggers cascading cron loops (#31311).
  if (requestedAgentId && !isValidAgentId(requestedAgentId)) {
    return rejectSubagentSpawnRequest(
      "error",
      `Invalid agentId "${requestedAgentId}". Agent IDs must match [a-z0-9][a-z0-9_-]{0,63}.`,
    );
  }
  const requestThreadBinding = params.thread === true;
  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (params.collect && (requestThreadBinding || spawnMode === "session")) {
    return rejectSubagentSpawnRequest(
      "error",
      "sessions_spawn collect=true requires mode=run and thread=false.",
    );
  }
  if (spawnMode === "session" && !requestThreadBinding) {
    return rejectSubagentSpawnRequest(
      "error",
      'sessions_spawn(mode="session") requires thread=true so the subagent can stay bound to a channel thread. ' +
        'Retry with { mode: "session", thread: true } on a channel that supports threads, or use mode="run" for one-shot work.',
    );
  }
  const cleanup =
    spawnMode === "session"
      ? "keep"
      : params.cleanup === "keep" || params.cleanup === "delete"
        ? params.cleanup
        : "keep";
  const expectsCompletionMessage = params.collect
    ? false
    : params.expectsCompletionMessage !== false;
  const hookRunner = getSubagentSpawnDeps().getGlobalHookRunner();
  const cfg = loadSubagentConfig();

  // When agent omits runTimeoutSeconds, use the config default.
  // Falls back to 0 (no timeout) if config key is also unset,
  // preserving current behavior for existing deployments.
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  const contextMode = resolveSubagentContextMode({
    requestedContext: params.context,
    threadRequested: requestThreadBinding,
    cfg,
    requester: {
      channel: ctx.agentChannel,
      accountId: ctx.agentAccountId,
    },
  });
  const { mainKey, alias } = resolveMainSessionAlias(cfg);
  const requesterSessionKey = ctx.agentSessionKey;
  const requesterInternalKey = requesterSessionKey
    ? resolveInternalSessionKey({
        key: requesterSessionKey,
        alias,
        mainKey,
      })
    : alias;
  const ownership = resolveSubagentSpawnOwnership({
    cfg,
    agentSessionKey: ctx.agentSessionKey,
    completionOwnerKey: ctx.completionOwnerKey,
  });

  const requesterAgentId = resolveSessionAgentId({
    config: cfg,
    sessionKey: requesterInternalKey,
    agentId: ctx.requesterAgentIdOverride,
  });
  const swarmConfig = resolveSwarmConfig(cfg, requesterAgentId);
  const hasSwarmParams =
    params.collect !== undefined ||
    params.outputSchema !== undefined ||
    params.fastMode !== undefined ||
    params.groupId !== undefined;
  if (hasSwarmParams && !swarmConfig.enabled) {
    return rejectSubagentSpawnRequest(
      "forbidden",
      "sessions_spawn swarm parameters require tools.swarm.enabled=true.",
    );
  }
  if (params.outputSchema && !params.collect) {
    return rejectSubagentSpawnRequest(
      "error",
      "sessions_spawn outputSchema requires collect=true.",
    );
  }
  if (params.groupId !== undefined && !params.collect) {
    return rejectSubagentSpawnRequest("error", "sessions_spawn groupId requires collect=true.");
  }
  if (params.outputSchema) {
    const schemaError = validateStructuredOutputSchema(params.outputSchema);
    if (schemaError) {
      return rejectSubagentSpawnRequest("error", schemaError);
    }
  }

  const usingDefaultAgentId =
    params.collect === true && !requestedAgentId && Boolean(swarmConfig.defaultAgentId);
  const effectiveRequestedAgentId = usingDefaultAgentId
    ? swarmConfig.defaultAgentId
    : requestedAgentId;
  if (usingDefaultAgentId) {
    if (!isValidAgentId(effectiveRequestedAgentId)) {
      return rejectSubagentSpawnRequest(
        "error",
        `tools.swarm.defaultAgentId contains invalid agentId "${effectiveRequestedAgentId}".`,
      );
    }
  }
  const targetAgentId = effectiveRequestedAgentId
    ? normalizeAgentId(effectiveRequestedAgentId)
    : requesterAgentId;
  const configuredAgentIds = listAgentIds(cfg);
  const explicitSwarmGroupId = normalizeOptionalString(params.groupId);
  const requesterRunId = normalizeOptionalString(ctx.requesterRunId);
  const swarmGroupId = params.collect
    ? (explicitSwarmGroupId ??
      (requesterRunId ? `swarm:${requesterInternalKey}:${requesterRunId}` : undefined))
    : undefined;
  const swarmSchedulerGroupKey = swarmGroupId
    ? JSON.stringify([requesterAgentId, requesterInternalKey, swarmGroupId])
    : undefined;
  const resolveAdmission = (pendingChildren = 0) => {
    const collectorRuns = params.collect
      ? swarmGroupId
        ? listSwarmRunsForGroup(swarmGroupId, requesterInternalKey, requesterAgentId)
        : []
      : undefined;
    return resolveSpawnAdmission({
      cfg,
      collector: collectorRuns
        ? {
            liveChildren: collectorRuns.filter((entry) => !entry.collectorCompletion).length,
            totalChildren: collectorRuns.length,
            maxChildrenPerGroup: swarmConfig.maxChildrenPerGroup,
            maxTotalPerGroup: swarmConfig.maxTotalPerGroup,
          }
        : undefined,
      requesterSessionKey: requesterInternalKey,
      requesterAgentId,
      targetAgentId,
      requestedAgentId: effectiveRequestedAgentId,
      configuredAgentIds,
      additionalActiveChildren: pendingChildren,
    });
  };
  const admissionReservation = params.collect
    ? undefined
    : reserveChildAdmissionSlot({
        controllerSessionKey: ownership.controllerSessionKey,
        resolveAdmission,
      });
  const admission = admissionReservation ?? resolveAdmission();
  if (admissionReservation?.ok) {
    ctx.onSpawnEffectsStart?.();
  }
  if (!admission.ok) {
    return rejectSubagentSpawnRequest(
      "forbidden",
      usingDefaultAgentId && !admission.governingCap?.startsWith("tools.swarm.")
        ? `tools.swarm.defaultAgentId is unavailable: ${admission.error}`
        : admission.error,
    );
  }
  if (params.collect && !swarmGroupId) {
    return rejectSubagentSpawnRequest(
      "error",
      "sessions_spawn collect=true requires a requesting run id when groupId is omitted.",
    );
  }
  const childDepth = admission.childSessionPatch?.spawnDepth ?? 1;
  const maxSpawnDepth = admission.maxSpawnDepth ?? childDepth;
  const swarmLaunchReplayKey = normalizeOptionalString(params.swarmLaunchReplayKey);
  // Registry and Gateway identities are global, while host replay keys are requester-scoped.
  const childIdem = swarmLaunchReplayKey
    ? `swarm_${crypto
        .createHash("sha256")
        .update(JSON.stringify([requesterInternalKey, swarmLaunchReplayKey]))
        .digest("hex")
        .slice(0, 32)}`
    : crypto.randomUUID();
  let reservationPending = false;
  let soleImplicitMember = false;
  if (params.collect && swarmGroupId && swarmSchedulerGroupKey) {
    const groupRuns = listSwarmRunsForGroup(swarmGroupId, requesterInternalKey, requesterAgentId);
    soleImplicitMember = !explicitSwarmGroupId && !swarmLaunchReplayKey && groupRuns.length === 0;
    // Swarm reservation can reconcile existing lane state even when it rejects a duplicate.
    ctx.onSpawnEffectsStart?.();
    if (
      !reserveSwarmRun({
        groupId: swarmSchedulerGroupKey,
        runId: childIdem,
        maxConcurrent: swarmConfig.maxConcurrent,
        activeRunIds: groupRuns
          .filter(
            (entry) =>
              entry.execution.status === "running" || entry.execution.status === "interrupted",
          )
          .map((entry) => entry.schedulerSlotId ?? entry.runId),
      })
    ) {
      return rejectSubagentSpawnRequest(
        "error",
        "sessions_spawn could not reserve swarm FIFO order.",
      );
    }
    reservationPending = true;
  }
  return {
    ok: true,
    resolved: {
      request: {
        taskName,
        spawnMode,
        cleanup,
        expectsCompletionMessage,
      },
      runtime: {
        hookRunner,
        cfg,
        runTimeoutSeconds,
        contextMode,
        requesterInternalKey,
        ownership,
        requesterAgentId,
        targetAgentId,
      },
      swarm: {
        config: swarmConfig,
        groupId: swarmGroupId,
        schedulerGroupKey: swarmSchedulerGroupKey,
        launchReplayKey: swarmLaunchReplayKey,
        soleImplicitMember,
        reservationPending,
      },
      admission: {
        resolve: resolveAdmission,
        initial: admission,
        reservation: admissionReservation?.ok ? admissionReservation : undefined,
        childDepth,
        maxSpawnDepth,
      },
      childIdem,
    },
  };
}
