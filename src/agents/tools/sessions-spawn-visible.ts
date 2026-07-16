import { Type } from "typebox";
import {
  DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
} from "../../config/agent-limits.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { callGateway } from "../../gateway/call.js";
import {
  isValidAgentId,
  normalizeAgentId,
  parseAgentSessionKey,
} from "../../routing/session-key.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import type { GatewayMessageChannel } from "../../utils/message-channel.js";
import { listAgentIds, resolveAgentConfig } from "../agent-scope.js";
import { resolveSubagentSpawnModelSelection } from "../model-selection.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { getSubagentDepthFromSessionStore } from "../subagent-depth.js";
import { countActiveRunsForSession, registerSubagentRun } from "../subagent-registry.js";
import { resolveSubagentSpawnOwnership } from "../subagent-spawn-ownership.js";
import { resolveConfiguredSubagentRunTimeoutSeconds } from "../subagent-spawn-plan.js";
import { resolveSubagentTargetPolicy } from "../subagent-target-policy.js";
import { normalizeToolModelOverride, readStringParam, ToolInputError } from "./common.js";
import { callInProcessGatewayTool, type InProcessGatewayCaller } from "./in-process-gateway.js";
import { reserveVisibleChildSlot } from "./sessions-spawn-visible-admission.js";

export const VISIBLE_SESSIONS_SPAWN_SCHEMA = {
  visible: Type.Optional(
    Type.Boolean({
      description: "visible: user sees session in UI. Use when user asked or talks via web/app.",
    }),
  ),
  worktree: Type.Optional(Type.Boolean({ description: "Visible session worktree" })),
  worktreeName: Type.Optional(Type.String({ description: "Worktree name" })),
  worktreeBaseRef: Type.Optional(Type.String({ description: "Worktree base ref" })),
};

export type VisibleSessionsSpawnDeps = {
  callGateway?: InProcessGatewayCaller;
  registerRun?: typeof registerSubagentRun;
  countActiveRuns?: typeof countActiveRunsForSession;
};

type VisibleSessionsSpawnOptions = VisibleSessionsSpawnDeps & {
  agentSessionKey?: string;
  completionOwnerKey?: string;
  agentChannel?: GatewayMessageChannel;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentThreadTs?: string;
  sandboxed?: boolean;
  config?: OpenClawConfig;
  requesterAgentIdOverride?: string;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
};

export function summarizeSessionsSpawnError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "error";
}

export function resolveTrackedSpawnMode(params: {
  requestedMode?: "run" | "session";
  threadRequested: boolean;
}): "run" | "session" {
  return params.requestedMode ?? (params.threadRequested ? "session" : "run");
}

export async function cleanupUntrackedAcpSession(sessionKey: string): Promise<void> {
  const key = sessionKey.trim();
  if (!key) {
    return;
  }
  try {
    await callGateway({
      method: "sessions.delete",
      params: { key, deleteTranscript: true, emitLifecycleHooks: false },
      timeoutMs: 10_000,
    });
  } catch {
    // Best-effort cleanup only.
  }
}

async function deleteVisibleSession(
  gatewayCall: InProcessGatewayCaller,
  childSessionKey: string,
): Promise<void> {
  try {
    await gatewayCall("sessions.delete", {
      key: childSessionKey,
      deleteTranscript: true,
      emitLifecycleHooks: false,
    });
  } catch {
    // Best-effort rollback only.
  }
}

export async function maybeSpawnVisibleSession(params: {
  raw: Record<string, unknown>;
  task: string;
  taskName?: string;
  label: string;
  runtime: "subagent" | "acp";
  requestedAgentId?: string;
  sandbox: "inherit" | "require";
  options?: VisibleSessionsSpawnOptions;
}): Promise<Record<string, unknown> | undefined> {
  const worktree = params.raw.worktree === true;
  const worktreeName = readStringParam(params.raw, "worktreeName");
  const worktreeBaseRef = readStringParam(params.raw, "worktreeBaseRef");
  if (params.raw.visible !== true) {
    if (worktree || worktreeName || worktreeBaseRef) {
      throw new ToolInputError("worktree options require visible=true");
    }
    return undefined;
  }
  if (params.runtime !== "subagent") {
    throw new ToolInputError('visible=true supports runtime="subagent" only');
  }
  const unsupported = [
    ["model", normalizeToolModelOverride(readStringParam(params.raw, "model"))],
    ["thinking", readStringParam(params.raw, "thinking")],
    ["cwd", readStringParam(params.raw, "cwd")],
    ["thread", params.raw.thread === true ? true : undefined],
    ["mode", params.raw.mode],
    ["context", params.raw.context],
    ["lightContext", params.raw.lightContext === true ? true : undefined],
    ["attachments", Array.isArray(params.raw.attachments) ? params.raw.attachments : undefined],
    ["attachAs", params.raw.attachAs],
  ] as const;
  const unsupportedEntry = unsupported.find(([, value]) => value !== undefined);
  if (unsupportedEntry) {
    throw new ToolInputError(`${unsupportedEntry[0]} unavailable with visible=true`);
  }

  const cfg = params.options?.config ?? getRuntimeConfig();
  if (
    (params.options?.inheritedToolAllowlist?.length ?? 0) > 0 ||
    (params.options?.inheritedToolDenylist?.length ?? 0) > 0
  ) {
    return {
      status: "forbidden",
      error: "Visible sessions unavailable with inherited tool restrictions.",
    };
  }
  const ownership = resolveSubagentSpawnOwnership({
    cfg,
    agentSessionKey: params.options?.agentSessionKey,
    completionOwnerKey: params.options?.completionOwnerKey,
  });
  const requesterKey = ownership.controllerSessionKey;
  const callerDepth = getSubagentDepthFromSessionStore(requesterKey, { cfg });
  const maxDepth =
    cfg.agents?.defaults?.subagents?.maxSpawnDepth ?? DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH;
  if (callerDepth >= maxDepth) {
    return {
      status: "forbidden",
      error: `sessions_spawn is not allowed at this depth (current depth: ${callerDepth}, max: ${maxDepth})`,
    };
  }
  const maxChildren =
    cfg.agents?.defaults?.subagents?.maxChildrenPerAgent ?? DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT;
  if (params.requestedAgentId && !isValidAgentId(params.requestedAgentId)) {
    return {
      status: "error",
      error: `Invalid agentId "${params.requestedAgentId}". Use agents_list.`,
    };
  }
  const requesterAgentId = normalizeAgentId(
    params.options?.requesterAgentIdOverride ?? parseAgentSessionKey(requesterKey)?.agentId,
  );
  const requireAgentId =
    resolveAgentConfig(cfg, requesterAgentId)?.subagents?.requireAgentId ??
    cfg.agents?.defaults?.subagents?.requireAgentId ??
    false;
  if (requireAgentId && !params.requestedAgentId) {
    return { status: "forbidden", error: "sessions_spawn requires agentId. Use agents_list." };
  }
  const targetAgentId = params.requestedAgentId
    ? normalizeAgentId(params.requestedAgentId)
    : requesterAgentId;
  const targetPolicy = resolveSubagentTargetPolicy({
    requesterAgentId,
    targetAgentId,
    requestedAgentId: params.requestedAgentId,
    allowAgents:
      resolveAgentConfig(cfg, requesterAgentId)?.subagents?.allowAgents ??
      cfg.agents?.defaults?.subagents?.allowAgents,
    configuredAgentIds: listAgentIds(cfg),
  });
  if (!targetPolicy.ok) {
    return { status: "forbidden", error: targetPolicy.error };
  }
  const resolvedModel = resolveSubagentSpawnModelSelection({
    cfg,
    agentId: targetAgentId,
  });
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({ cfg });
  const requesterRuntime = resolveSandboxRuntimeStatus({ cfg, sessionKey: requesterKey });
  const childRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: `agent:${targetAgentId}:dashboard:pending`,
  });
  const requesterSandboxed = params.options?.sandboxed === true || requesterRuntime.sandboxed;
  if (!childRuntime.sandboxed && (requesterSandboxed || params.sandbox === "require")) {
    return {
      status: "forbidden",
      error: requesterSandboxed
        ? "Sandboxed sessions cannot spawn unsandboxed sessions."
        : 'sessions_spawn sandbox="require" needs sandboxed target.',
    };
  }

  const reservation = reserveVisibleChildSlot({
    controllerSessionKey: requesterKey,
    maxChildren,
    countActiveRuns: params.options?.countActiveRuns ?? countActiveRunsForSession,
  });
  if (!reservation.ok) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children for this session (${reservation.activeChildren}/${maxChildren})`,
    };
  }
  try {
    const gatewayCall = params.options?.callGateway ?? callInProcessGatewayTool;
    const response = await gatewayCall<{
      key?: string;
      runStarted?: boolean;
      runId?: string;
      runError?: unknown;
    }>("sessions.create", {
      agentId: targetAgentId,
      ...(params.label ? { label: params.label } : {}),
      model: resolvedModel,
      task: params.task,
      parentSessionKey: requesterKey,
      ...(worktree ? { worktree: true } : {}),
      ...(worktreeName ? { worktreeName } : {}),
      ...(worktreeBaseRef ? { worktreeBaseRef } : {}),
    });
    const childSessionKey = response.key?.trim();
    const runId = response.runId?.trim();
    const runError = response.runError
      ? summarizeSessionsSpawnError(response.runError)
      : "Visible session run failed";
    if (!childSessionKey) {
      return {
        status: "error",
        error: runError,
      };
    }
    if (response.runStarted !== true) {
      await deleteVisibleSession(gatewayCall, childSessionKey);
      return { status: "error", error: runError, childSessionKey };
    }
    if (!runId) {
      // A started run with no run id is untrackable: it cannot be registered,
      // announced, or cancelled, so never leave it as a visible orphan. Abort
      // by key to stop whatever is running, then delete the session.
      try {
        await gatewayCall("sessions.abort", { key: childSessionKey, agentId: targetAgentId });
      } catch {
        // Best-effort stop before cleanup.
      }
      await deleteVisibleSession(gatewayCall, childSessionKey);
      return { status: "error", error: runError };
    }
    try {
      (params.options?.registerRun ?? registerSubagentRun)({
        runId,
        childSessionKey,
        controllerSessionKey: ownership.controllerSessionKey,
        requesterSessionKey: ownership.completionRequesterSessionKey,
        requesterOrigin: normalizeDeliveryContext({
          channel: params.options?.agentChannel,
          accountId: params.options?.agentAccountId,
          to:
            params.options?.currentMessagingTarget ??
            params.options?.currentChannelId ??
            params.options?.agentTo,
          threadId: params.options?.currentThreadTs ?? params.options?.agentThreadId,
        }),
        requesterDisplayKey: ownership.completionRequesterDisplayKey,
        task: params.task,
        taskName: params.taskName,
        agentId: targetAgentId,
        requesterAgentId: params.options?.requesterAgentIdOverride,
        cleanup: "keep",
        label: params.label || undefined,
        runTimeoutSeconds,
        expectsCompletionMessage: params.raw.expectsCompletionMessage !== false,
        spawnMode: "run",
      });
    } catch (error) {
      let abortResponse: { abortedRunId?: string | null };
      try {
        abortResponse = await gatewayCall<{ abortedRunId?: string | null }>("sessions.abort", {
          key: childSessionKey,
          runId,
          agentId: targetAgentId,
        });
      } catch (abortError) {
        return {
          status: "error",
          error: `Visible run registration failed: ${summarizeSessionsSpawnError(error)}. Run abort failed: ${summarizeSessionsSpawnError(abortError)}. Session kept.`,
          childSessionKey,
          runId,
        };
      }
      if (abortResponse.abortedRunId !== runId) {
        return {
          status: "error",
          error: `Visible run registration failed: ${summarizeSessionsSpawnError(error)}. Run abort unconfirmed. Session kept.`,
          childSessionKey,
          runId,
        };
      }
      await deleteVisibleSession(gatewayCall, childSessionKey);
      return {
        status: "error",
        error: `Visible run registration failed: ${summarizeSessionsSpawnError(error)}. Run aborted; cleanup attempted.`,
        childSessionKey,
        runId,
      };
    }
    return {
      status: "accepted",
      childSessionKey,
      runId,
      mode: "run",
      cleanup: "keep",
    };
  } finally {
    reservation.release();
  }
}
