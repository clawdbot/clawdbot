// Plugin-managed reserved spawn adapter. Service-specific lease state stays in plugins.
import { createHash } from "node:crypto";
import { resolveAgentConfig } from "../agents/agent-scope.js";
import { parseExecApprovalFollowupApprovalId } from "../agents/bash-tools.exec-approval-followup-state.js";
import {
  getLatestSubagentRunByChildSessionKey,
  hasSubagentRunIdentity,
} from "../agents/subagent-registry.js";
import type { ProvisionalSessionCleanupIdentity } from "../agents/subagent-spawn-cleanup-types.js";
import {
  cleanupProvisionalSession,
  resolveProvisionalSessionCleanupProof,
} from "../agents/subagent-spawn-cleanup.js";
import type { SpawnSubagentResult } from "../agents/subagent-spawn-contract.js";
import { resolveSubagentTargetPolicy } from "../agents/subagent-target-policy.js";
import { normalizeSubagentTaskName } from "../agents/subagent-task-name.js";
import { getAgentRunContext } from "../infra/agent-events.js";
import { isFastTestRuntimeEnv } from "../infra/env.js";
import {
  getPluginRuntimeGatewayRequestScope,
  type ReservedSubagentRequesterOwnershipEvidence,
} from "../plugins/runtime/gateway-request-scope.js";
import { createRuntimeAgent } from "../plugins/runtime/runtime-agent.js";
import type { PluginRuntime } from "../plugins/runtime/types.js";
import { isValidAgentId, parseAgentSessionKey } from "../routing/session-key.js";
import { normalizeSessionKeyPreservingOpaquePeerIds } from "../sessions/session-key-utils.js";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";
import { reserveReservedSubagentDedupeEntry } from "./server-methods/agent-dedupe.js";
import type { GatewayRequestContext } from "./server-methods/types.js";
import { getFallbackGatewayContext } from "./server-plugin-fallback-context.js";
import { loadSessionEntryReadOnly } from "./session-utils-store.js";

type ReservedSubagentIdentityClaims = {
  runIds: Set<string>;
  childSessionKeys: Set<string>;
};

type ReservedSubagentCleanupHolder = {
  attempts: number;
  timer?: ReturnType<typeof setTimeout>;
  release: () => void;
};

export const RESERVED_SUBAGENT_TASK_MAX_BYTES = 4 * 1024;
export const RESERVED_SUBAGENT_IDENTITY_MAX_BYTES = 1024;
export const RESERVED_SUBAGENT_LABEL_MAX_BYTES = 1024;

const RESERVED_SUBAGENT_IDENTITY_CLAIMS_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntime.reservedSubagentIdentityClaims",
);
const RESERVED_SUBAGENT_CLEANUP_HOLDERS_KEY: unique symbol = Symbol.for(
  "openclaw.pluginRuntime.reservedSubagentCleanupHolders",
);

function reservedSubagentCleanupHolderKey(params: {
  runId: string;
  childSessionKey: string;
}): string {
  return JSON.stringify([params.runId, params.childSessionKey]);
}

function retainReservedSubagentCleanupHolder(params: {
  runId: string;
  childSessionKey: string;
  sessionIdentity?: ProvisionalSessionCleanupIdentity;
  releaseGatewayDedupeReservation: () => void;
  releaseIdentityClaim: () => void;
}): void {
  const holders = resolveGlobalSingleton<Map<string, ReservedSubagentCleanupHolder>>(
    RESERVED_SUBAGENT_CLEANUP_HOLDERS_KEY,
    () => new Map(),
  );
  const key = reservedSubagentCleanupHolderKey(params);
  if (holders.has(key)) {
    return;
  }
  let released = false;
  const maxAttempts = isFastTestRuntimeEnv() ? 3 : 30;
  const retryDelayMs = isFastTestRuntimeEnv() ? 1 : 1_000;
  const holder: ReservedSubagentCleanupHolder = {
    attempts: 0,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      if (holder.timer) {
        clearTimeout(holder.timer);
      }
      holders.delete(key);
      params.releaseGatewayDedupeReservation();
      params.releaseIdentityClaim();
    },
  };
  const retryDeletion = async () => {
    if (released) {
      return;
    }
    holder.attempts += 1;
    const deleted = await cleanupProvisionalSession(params.childSessionKey, {
      emitLifecycleHooks: false,
      deleteTranscript: true,
      ...(params.sessionIdentity ? { expectedIdentity: params.sessionIdentity } : {}),
    });
    if (deleted) {
      holder.release();
      return;
    }
    try {
      const current = loadSessionEntryReadOnly(params.childSessionKey, { clone: false }).entry;
      const proof = resolveProvisionalSessionCleanupProof(current, params.sessionIdentity);
      if (proof === "missing" || proof === "replacement") {
        holder.release();
        return;
      }
    } catch {
      // Fail closed: unresolved inspection cannot release reserved identities.
    }
    if (holder.attempts >= maxAttempts) {
      if (
        hasDurableReservedCleanupOwner({
          runId: params.runId,
          childSessionKey: params.childSessionKey,
        })
      ) {
        holder.release();
        return;
      }
      holder.timer = undefined;
      return;
    }
    holder.timer = setTimeout(() => {
      void retryDeletion();
    }, retryDelayMs);
    holder.timer.unref?.();
  };
  holders.set(key, holder);
  holder.timer = setTimeout(() => {
    void retryDeletion();
  }, retryDelayMs);
  holder.timer.unref?.();
}

function hasIndeterminateReservedCleanup(result: SpawnSubagentResult): boolean {
  return result.reservedCleanup?.sessionDeletion === "indeterminate";
}

function hasDurableReservedCleanupOwner(params: {
  runId: string;
  childSessionKey: string;
}): boolean {
  const latest = getLatestSubagentRunByChildSessionKey(params.childSessionKey);
  return (
    latest?.runId === params.runId &&
    latest.childSessionKey === params.childSessionKey &&
    (Boolean(latest.spawnFailureCleanup) ||
      typeof latest.cleanupCompletedAt === "number" ||
      typeof latest.execution?.endedAt === "number")
  );
}

function assertReservedSubagentTextWithinLimit(
  fieldName: "childSessionKey" | "label" | "requesterSessionKey" | "runId" | "task",
  value: string,
  maxBytes: number,
): void {
  const bytes = Buffer.byteLength(value, "utf8");
  if (bytes > maxBytes) {
    throw new Error(`spawnReserved ${fieldName} exceeds the ${maxBytes} byte limit.`);
  }
}

function assertReservedSubagentTaskWithinLimit(task: string): void {
  assertReservedSubagentTextWithinLimit("task", task, RESERVED_SUBAGENT_TASK_MAX_BYTES);
}

function assertReservedSubagentLabelWithinLimit(label: string | undefined): void {
  if (label === undefined) {
    return;
  }
  assertReservedSubagentTextWithinLimit("label", label, RESERVED_SUBAGENT_LABEL_MAX_BYTES);
}

function assertReservedSubagentIdentitiesWithinLimit(params: {
  requesterSessionKey: string;
  childSessionKey: string;
  runId: string;
}): void {
  assertReservedSubagentTextWithinLimit(
    "requesterSessionKey",
    params.requesterSessionKey,
    RESERVED_SUBAGENT_IDENTITY_MAX_BYTES,
  );
  assertReservedSubagentTextWithinLimit(
    "childSessionKey",
    params.childSessionKey,
    RESERVED_SUBAGENT_IDENTITY_MAX_BYTES,
  );
  assertReservedSubagentTextWithinLimit(
    "runId",
    params.runId,
    RESERVED_SUBAGENT_IDENTITY_MAX_BYTES,
  );
}

function assertReservedSubagentOptions(params: {
  cleanup?: unknown;
  context?: unknown;
  lightContext?: unknown;
}): void {
  if (params.cleanup !== undefined && params.cleanup !== "delete" && params.cleanup !== "keep") {
    throw new Error('spawnReserved cleanup must be "delete" or "keep".');
  }
  if (params.context !== undefined && params.context !== "isolated" && params.context !== "fork") {
    throw new Error('spawnReserved context must be "isolated" or "fork".');
  }
  if (params.lightContext !== undefined && typeof params.lightContext !== "boolean") {
    throw new Error("spawnReserved lightContext must be a boolean.");
  }
}

function normalizeReservedSubagentTaskName(value: unknown): string | undefined {
  const result = normalizeSubagentTaskName(value);
  if (result.error) {
    throw new Error(`spawnReserved ${result.error}`);
  }
  return result.taskName;
}

function throwIfReservedSpawnAborted(signal: AbortSignal): void {
  if (!signal.aborted) {
    return;
  }
  const reason = (signal as { reason?: unknown }).reason;
  throw reason instanceof Error ? reason : new Error("spawnReserved interrupted.");
}

function buildReservedSubagentClaimToken(params: {
  pluginId: string;
  requesterSessionKey: string;
  requesterSessionId?: string;
  targetAgentId: string;
  childSessionKey: string;
  runId: string;
  task: string;
  taskName?: string;
  label?: string;
  cleanup?: "delete" | "keep";
  context?: string;
  lightContext?: boolean;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: 1,
        pluginId: params.pluginId,
        requesterSessionKey: params.requesterSessionKey,
        requesterSessionId: params.requesterSessionId ?? null,
        targetAgentId: params.targetAgentId,
        childSessionKey: params.childSessionKey,
        runId: params.runId,
        task: params.task,
        taskName: params.taskName ?? null,
        label: params.label ?? null,
        cleanup: params.cleanup ?? null,
        context: params.context ?? null,
        lightContext: params.lightContext ?? null,
      }),
    )
    .digest("hex");
}

function claimReservedSubagentIdentities(params: {
  pluginId: string;
  requesterSessionKey: string;
  requesterSessionId?: string;
  targetAgentId: string;
  childSessionKey: string;
  runId: string;
  task: string;
  taskName?: string;
  label?: string;
  cleanup?: "delete" | "keep";
  context?: string;
  lightContext?: boolean;
}): {
  claimToken: string;
  release: () => void;
} {
  const claims = resolveGlobalSingleton<ReservedSubagentIdentityClaims>(
    RESERVED_SUBAGENT_IDENTITY_CLAIMS_KEY,
    () => ({
      runIds: new Set(),
      childSessionKeys: new Set(),
    }),
  );
  if (claims.runIds.has(params.runId)) {
    throw new Error("reserved subagent runId is already claimed.");
  }
  if (claims.childSessionKeys.has(params.childSessionKey)) {
    throw new Error("reserved subagent childSessionKey is already claimed.");
  }
  claims.runIds.add(params.runId);
  claims.childSessionKeys.add(params.childSessionKey);
  const claimToken = buildReservedSubagentClaimToken(params);
  let released = false;
  return {
    claimToken,
    release: () => {
      if (released) {
        return;
      }
      released = true;
      claims.runIds.delete(params.runId);
      claims.childSessionKeys.delete(params.childSessionKey);
    },
  };
}

function assertReservedSubagentIdentitiesAvailable(params: {
  runId: string;
  childSessionKey: string;
}): void {
  if (getAgentRunContext(params.runId)) {
    throw new Error("reserved subagent runId is already active.");
  }
  if (hasSubagentRunIdentity(params.runId)) {
    throw new Error("reserved subagent runId already exists.");
  }
  if (getLatestSubagentRunByChildSessionKey(params.childSessionKey)) {
    throw new Error("reserved subagent childSessionKey already exists.");
  }
}

function assertReservedSubagentRequesterOwned(params: {
  pluginId: string;
  requesterSessionKey: string;
  targetAgentId: string;
  requesterOwnership?: ReservedSubagentRequesterOwnershipEvidence;
}): {
  requesterAgentId: string;
  requesterSessionId?: string;
  requesterStorePath: string;
} {
  const parsedRequester = parseAgentSessionKey(params.requesterSessionKey);
  if (!parsedRequester) {
    throw new Error("spawnReserved requesterSessionKey must be a canonical agent session key.");
  }
  const loaded = loadSessionEntryReadOnly(params.requesterSessionKey, {
    agentId: parsedRequester.agentId,
  });
  const entry = loaded.entry;
  if (!entry) {
    throw new Error(`spawnReserved missing requester session "${params.requesterSessionKey}".`);
  }
  const requesterOwnership = params.requesterOwnership;
  if (requesterOwnership) {
    if (
      requesterOwnership.ownerPluginId !== params.pluginId ||
      requesterOwnership.sessionKey !== params.requesterSessionKey
    ) {
      throw new Error(
        `Plugin "${params.pluginId}" cannot spawn a reserved child from unvalidated requester session "${params.requesterSessionKey}".`,
      );
    }
    const currentOwnerPluginId = requesterOwnership.resolveCurrentOwnerPluginId({
      entry,
      sessionKey: params.requesterSessionKey,
    });
    if (currentOwnerPluginId !== params.pluginId) {
      throw new Error(
        `Requester session "${params.requesterSessionKey}" is owned by plugin "${
          currentOwnerPluginId ?? "<none>"
        }", not "${params.pluginId}".`,
      );
    }
    const identityChanged =
      (requesterOwnership.sessionId !== undefined &&
        entry.sessionId !== requesterOwnership.sessionId) ||
      (requesterOwnership.lifecycleRevision !== undefined &&
        entry.lifecycleRevision !== requesterOwnership.lifecycleRevision) ||
      (requesterOwnership.createdAt !== undefined &&
        entry.createdAt !== requesterOwnership.createdAt);
    if (identityChanged) {
      throw new Error(
        `Requester session "${params.requesterSessionKey}" changed while starting reserved subagent work. Retry.`,
      );
    }
  } else if (entry.pluginOwnerId !== params.pluginId) {
    throw new Error(
      `Requester session "${params.requesterSessionKey}" is owned by plugin "${
        entry.pluginOwnerId ?? "<none>"
      }", not "${params.pluginId}".`,
    );
  }
  const requesterSubagentConfig = resolveAgentConfig(
    loaded.cfg,
    parsedRequester.agentId,
  )?.subagents;
  const configuredAllowAgents =
    requesterSubagentConfig?.allowAgents ?? loaded.cfg.agents?.defaults?.subagents?.allowAgents;
  const configuredAgentIds = Object.keys(loaded.cfg.agents?.entries ?? {});
  const targetPolicy = resolveSubagentTargetPolicy({
    requesterAgentId: parsedRequester.agentId,
    targetAgentId: params.targetAgentId,
    requestedAgentId: params.targetAgentId,
    allowAgents: configuredAllowAgents,
    configuredAgentIds,
  });
  if (!targetPolicy.ok) {
    throw new Error(targetPolicy.error);
  }
  return {
    requesterAgentId: parsedRequester.agentId,
    ...(entry.sessionId ? { requesterSessionId: entry.sessionId } : {}),
    requesterStorePath: loaded.storePath,
  };
}

export const spawnReservedSubagent: PluginRuntime["subagent"]["spawnReserved"] = async (params) => {
  const scope = getPluginRuntimeGatewayRequestScope();
  const pluginId =
    typeof scope?.pluginId === "string" && scope.pluginId.trim()
      ? scope.pluginId.trim()
      : undefined;
  if (!pluginId) {
    throw new Error("spawnReserved requires an active plugin runtime scope.");
  }
  assertReservedSubagentOptions(params);
  const requesterSessionKey = params.requesterSessionKey.trim();
  const targetAgentId = params.targetAgentId.trim();
  const childSessionKey = params.childSessionKey.trim();
  const runId = params.runId.trim();
  const task = params.task.trim();
  assertReservedSubagentIdentitiesWithinLimit({
    requesterSessionKey: params.requesterSessionKey,
    childSessionKey: params.childSessionKey,
    runId: params.runId,
  });
  if (
    requesterSessionKey !== params.requesterSessionKey ||
    normalizeSessionKeyPreservingOpaquePeerIds(requesterSessionKey) !== requesterSessionKey ||
    !parseAgentSessionKey(requesterSessionKey)
  ) {
    throw new Error("spawnReserved requesterSessionKey must be a canonical agent session key.");
  }
  if (targetAgentId !== params.targetAgentId || !isValidAgentId(targetAgentId)) {
    throw new Error("spawnReserved targetAgentId is invalid.");
  }
  if (
    !childSessionKey ||
    childSessionKey !== params.childSessionKey ||
    normalizeSessionKeyPreservingOpaquePeerIds(childSessionKey) !== childSessionKey ||
    !runId ||
    runId !== params.runId
  ) {
    throw new Error("spawnReserved childSessionKey and runId must be non-empty canonical values.");
  }
  if (parseExecApprovalFollowupApprovalId(runId)) {
    throw new Error("spawnReserved runId uses a backend-reserved namespace.");
  }
  if (runId.startsWith("chat:") || runId.startsWith("agent:")) {
    throw new Error("spawnReserved runId uses a backend-reserved namespace.");
  }
  const taskName = normalizeReservedSubagentTaskName(params.taskName);
  assertReservedSubagentTaskWithinLimit(params.task);
  assertReservedSubagentLabelWithinLimit(params.label);
  if (!task) {
    throw new Error("spawnReserved task must be non-empty.");
  }
  const gatewayContext = scope?.context ?? getFallbackGatewayContext();
  if (!gatewayContext) {
    throw new Error("spawnReserved requires a live Gateway context.");
  }
  const requesterAdmission = assertReservedSubagentRequesterOwned({
    pluginId,
    requesterSessionKey,
    targetAgentId,
    requesterOwnership: scope?.reservedSubagentRequesterOwnership,
  });
  return await createRuntimeAgent().session.runWithWorkAdmission(
    {
      storePath: requesterAdmission.requesterStorePath,
      sessionKey: requesterSessionKey,
    },
    async (signal) => {
      throwIfReservedSpawnAborted(signal);
      const admittedRequester = assertReservedSubagentRequesterOwned({
        pluginId,
        requesterSessionKey,
        targetAgentId,
        requesterOwnership: scope?.reservedSubagentRequesterOwnership,
      });
      return await spawnReservedSubagentWithRequesterAdmission({
        params,
        pluginId,
        requesterSessionKey,
        targetAgentId,
        childSessionKey,
        runId,
        task,
        taskName,
        gatewayContext,
        requesterSessionId: admittedRequester.requesterSessionId,
        signal,
      });
    },
  );
};

async function spawnReservedSubagentWithRequesterAdmission(params: {
  params: Parameters<PluginRuntime["subagent"]["spawnReserved"]>[0];
  pluginId: string;
  requesterSessionKey: string;
  targetAgentId: string;
  childSessionKey: string;
  runId: string;
  task: string;
  taskName?: string;
  gatewayContext: GatewayRequestContext;
  requesterSessionId?: string;
  signal: AbortSignal;
}): ReturnType<PluginRuntime["subagent"]["spawnReserved"]> {
  const reservationParams = params.params;
  const identityClaim = claimReservedSubagentIdentities({
    pluginId: params.pluginId,
    requesterSessionKey: params.requesterSessionKey,
    requesterSessionId: params.requesterSessionId,
    targetAgentId: params.targetAgentId,
    runId: params.runId,
    childSessionKey: params.childSessionKey,
    task: params.task,
    ...(params.taskName !== undefined ? { taskName: params.taskName } : {}),
    ...(reservationParams.label !== undefined ? { label: reservationParams.label } : {}),
    ...(reservationParams.cleanup !== undefined ? { cleanup: reservationParams.cleanup } : {}),
    ...(reservationParams.context !== undefined ? { context: reservationParams.context } : {}),
    ...(reservationParams.lightContext !== undefined
      ? { lightContext: reservationParams.lightContext }
      : {}),
  });
  let releaseGatewayDedupeReservation = () => {};
  let releaseClaimsOnReturn = true;
  try {
    assertReservedSubagentIdentitiesAvailable({
      runId: params.runId,
      childSessionKey: params.childSessionKey,
    });
    releaseGatewayDedupeReservation = reserveReservedSubagentDedupeEntry({
      dedupe: params.gatewayContext.dedupe,
      runId: params.runId,
      sessionKey: params.childSessionKey,
      pluginRuntimeOwnerId: params.pluginId,
      claimToken: identityClaim.claimToken,
    });
    throwIfReservedSpawnAborted(params.signal);
    const { spawnSubagentDirect } = await import("../agents/subagent-spawn.js");
    throwIfReservedSpawnAborted(params.signal);
    const result = await spawnSubagentDirect(
      {
        task: params.task,
        agentId: params.targetAgentId,
        ...(params.taskName !== undefined ? { taskName: params.taskName } : {}),
        ...(reservationParams.label !== undefined ? { label: reservationParams.label } : {}),
        mode: "run",
        ...(reservationParams.cleanup !== undefined ? { cleanup: reservationParams.cleanup } : {}),
        ...(reservationParams.context !== undefined ? { context: reservationParams.context } : {}),
        ...(reservationParams.lightContext !== undefined
          ? { lightContext: reservationParams.lightContext }
          : {}),
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: params.requesterSessionKey,
        authorizedTargetAgentId: params.targetAgentId,
        preallocatedChildSessionKey: params.childSessionKey,
        preallocatedRunId: params.runId,
        pluginOwnerId: params.pluginId,
        requesterSessionId: params.requesterSessionId,
        reservedSubagentClaimToken: identityClaim.claimToken,
        signal: params.signal,
      },
    );
    if (result.status !== "accepted") {
      if (hasIndeterminateReservedCleanup(result)) {
        retainReservedSubagentCleanupHolder({
          runId: params.runId,
          childSessionKey: params.childSessionKey,
          ...(result.reservedCleanup?.sessionIdentity
            ? { sessionIdentity: result.reservedCleanup.sessionIdentity }
            : {}),
          releaseGatewayDedupeReservation,
          releaseIdentityClaim: identityClaim.release,
        });
        releaseClaimsOnReturn = false;
      }
      throw new Error(result.error?.trim() || `reserved subagent spawn ${result.status}`);
    }
    if (result.childSessionKey !== params.childSessionKey || result.runId !== params.runId) {
      throw new Error("reserved subagent spawn returned different child or run identities.");
    }
    return {
      childSessionKey: result.childSessionKey,
      runId: result.runId,
      mode: "run",
    };
  } finally {
    if (releaseClaimsOnReturn) {
      releaseGatewayDedupeReservation();
      identityClaim.release();
    }
  }
}
