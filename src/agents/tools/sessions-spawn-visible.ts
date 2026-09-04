import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { Type } from "typebox";
import { readMissingScopeErrorDetails } from "../../../packages/gateway-protocol/src/gateway-error-details.js";
import {
  DEFAULT_SUBAGENT_MAX_CHILDREN_PER_AGENT,
  DEFAULT_SUBAGENT_MAX_SPAWN_DEPTH,
} from "../../config/agent-limits.js";
import { getRuntimeConfig } from "../../config/config.js";
import { resolveControlUiSessionUrl } from "../../config/control-ui-link-base.js";
import { resolveSessionStorePathCore } from "../../config/sessions/paths.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { ADMIN_SCOPE } from "../../gateway/method-scopes.js";
import { resolveWorkspacePathContainment } from "../../gateway/server-methods/workspace-path-containment.js";
import { isPathInside } from "../../infra/path-guards.js";
import { isValidAgentId, normalizeAgentId } from "../../routing/session-key.js";
import { recordSessionParticipantBestEffort } from "../../sessions/session-participant-recording.js";
import { resolveUserPath } from "../../utils.js";
import { normalizeDeliveryContext } from "../../utils/delivery-context.shared.js";
import { listAgentIds, resolveAgentConfig, resolveSessionAgentId } from "../agent-scope.js";
import { reserveChildAdmissionSlot } from "../child-admission.js";
import { resolveAgentIdentity } from "../identity.js";
import { resolveSubagentSpawnModelSelection } from "../model-selection.js";
import { resolveSandboxRuntimeStatus } from "../sandbox/runtime-status.js";
import { resolveSpawnedWorkspaceInheritance, type SpawnedToolContext } from "../spawned-context.js";
import {
  countActiveRunsForSession,
  registerSubagentRun,
} from "../subagents/registry/subagent-registry.js";
import { deleteSubagentSessionForCleanup } from "../subagents/registry/subagent-session-cleanup.js";
import { getSubagentDepthFromSessionStore } from "../subagents/spawn/subagent-depth.js";
import { resolveSubagentSpawnOwnership } from "../subagents/spawn/subagent-spawn-ownership.js";
import { resolveConfiguredSubagentRunTimeoutSeconds } from "../subagents/spawn/subagent-spawn-plan.js";
import { resolveSubagentTargetPolicy } from "../subagents/spawn/subagent-target-policy.js";
import { normalizeToolModelOverride, readToolStringParam, ToolInputError } from "./common.js";
import {
  callInProcessGatewayTool,
  callInProcessGatewayToolWithCreation,
  type InProcessGatewayCaller,
} from "./in-process-gateway.js";

export const VISIBLE_SESSIONS_SPAWN_SCHEMA = {
  visible: Type.Optional(
    Type.Boolean({
      description:
        "Durable visible session: coding/multi-step/keepable results; works without UI; subagent only. Default run mode and empty attachment fields are accepted; no thread/thinking/lightContext or attachment staging.",
    }),
  ),
  group: Type.Optional(
    Type.String({
      description:
        "Custom sidebar group for a visible session; a new name creates the group. Omit or pass an empty string to leave it ungrouped.",
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

type VisibleSessionsSpawnOptions = VisibleSessionsSpawnDeps &
  SpawnedToolContext & {
    agentSessionKey?: string;
    requesterTurnRunId?: string;
    completionOwnerKey?: string;
    agentChannel?: string;
    agentAccountId?: string;
    agentTo?: string;
    agentThreadId?: string | number;
    currentMessagingTarget?: string;
    currentChannelId?: string;
    currentThreadTs?: string;
    sandboxed?: boolean;
    config?: OpenClawConfig;
    requesterAgentIdOverride?: string;
  };

function summarizeSessionsSpawnError(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "error";
}

export async function maybeSpawnVisibleSession(params: {
  raw: Record<string, unknown>;
  task: string;
  taskName?: string;
  label: string;
  runtime: "subagent" | "acp";
  requestedAgentId?: string;
  runTimeoutSeconds?: number;
  sandbox: "inherit" | "require";
  expectsCompletionMessage: boolean;
  options?: VisibleSessionsSpawnOptions;
}): Promise<Record<string, unknown> | undefined> {
  const promptedAt = Date.now();
  const worktree = params.raw.worktree === true;
  const worktreeName = readToolStringParam(params.raw, "worktreeName");
  const worktreeBaseRef = readToolStringParam(params.raw, "worktreeBaseRef");
  const group = readToolStringParam(params.raw, "group");
  if (params.raw.visible !== true) {
    const visibleOnlyParams = [
      ["group", group],
      ["worktree", worktree],
      ["worktreeName", worktreeName],
      ["worktreeBaseRef", worktreeBaseRef],
    ] as const;
    const providedVisibleOnlyParams = visibleOnlyParams
      .filter(([, value]) => value !== undefined && value !== false)
      .map(([name]) => name);
    if (providedVisibleOnlyParams.length > 0) {
      throw new ToolInputError(
        `Parameters require visible=true: ${providedVisibleOnlyParams.join(", ")}. ` +
          'Omit these options for hidden subagent or ACP runs. For a visible session, use visible=true with runtime="subagent"; omit mode, thread, thinking, lightContext, attachments, attachAs, swarm options, and ACP-only streamTo/resumeSessionId. Worktree names/base refs also require worktree=true.',
      );
    }
    return undefined;
  }
  const modelOverride = normalizeToolModelOverride(readToolStringParam(params.raw, "model"));
  const requestedCwd = readToolStringParam(params.raw, "cwd");
  const spawnedCwd = requestedCwd ? resolveUserPath(requestedCwd) : undefined;
  // A visible session starts one run; empty attachment fields request no staging.
  const requestedMode = params.raw.mode === "run" ? undefined : params.raw.mode;
  const unsupported = [
    [
      "runtime",
      params.runtime === "subagent" ? undefined : params.runtime,
      'supports runtime="subagent" only',
    ],
    [
      "thinking",
      readToolStringParam(params.raw, "thinking"),
      "thinking overrides are not wired to the sessions.create path",
    ],
    [
      "thread",
      params.raw.thread === true ? true : undefined,
      "visible sessions route to the dashboard, not a channel thread",
    ],
    ["mode", requestedMode, "visible sessions are persistent dashboard sessions"],
    [
      "lightContext",
      params.raw.lightContext === true ? true : undefined,
      "bootstrap staging is not wired to the sessions.create path",
    ],
    [
      "attachments",
      Array.isArray(params.raw.attachments) && params.raw.attachments.length > 0
        ? params.raw.attachments
        : undefined,
      "attachment staging is not wired to the sessions.create path",
    ],
    [
      "attachAs",
      isRecord(params.raw.attachAs)
        ? readToolStringParam(params.raw.attachAs, "mountPath")
        : params.raw.attachAs,
      "attachment staging is not wired to the sessions.create path",
    ],
  ] as const;
  const unsupportedEntries = unsupported.filter(([, value]) => value !== undefined);
  if (unsupportedEntries.length > 0) {
    throw new ToolInputError(
      `Parameters unavailable with visible=true: ${unsupportedEntries
        .map(([name, , reason]) => `${name}: ${reason}`)
        .join("; ")}`,
    );
  }

  const cfg = params.options?.config ?? getRuntimeConfig();
  const ownership = resolveSubagentSpawnOwnership({
    cfg,
    agentSessionKey: params.options?.agentSessionKey,
    completionOwnerKey: params.options?.completionOwnerKey,
  });
  const requesterKey = ownership.controllerSessionKey;
  const callerDepth = getSubagentDepthFromSessionStore(requesterKey, {
    cfg,
    agentId: params.options?.requesterAgentIdOverride,
  });
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
      error: `Invalid agentId "${params.requestedAgentId}". Agent IDs must match [a-z0-9][a-z0-9_-]{0,63}.`,
    };
  }
  const requesterAgentId = resolveSessionAgentId({
    config: cfg,
    sessionKey: requesterKey,
    agentId: params.options?.requesterAgentIdOverride,
  });
  const requireAgentId =
    resolveAgentConfig(cfg, requesterAgentId)?.subagents?.requireAgentId ??
    cfg.agents?.defaults?.subagents?.requireAgentId ??
    false;
  if (requireAgentId && !params.requestedAgentId) {
    return { status: "forbidden", error: "sessions_spawn requires agentId; use an allowed agent." };
  }
  const targetAgentId = params.requestedAgentId
    ? normalizeAgentId(params.requestedAgentId)
    : requesterAgentId;
  if (params.raw.context === "fork" && targetAgentId !== requesterAgentId) {
    return {
      status: "error",
      error:
        'context="fork" currently requires the same target agent as the requester; use context="isolated" for cross-agent spawns.',
    };
  }
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
  const resolvedModel =
    modelOverride ?? resolveSubagentSpawnModelSelection({ cfg, agentId: targetAgentId });
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg,
    sessionKey: requesterKey,
    agentId: requesterAgentId,
  });
  // Gateway creation inherits the exact parent's requirement before admitting a child run.
  const childRuntimeSandboxed =
    requesterRuntime.sandboxRequired ||
    resolveSandboxRuntimeStatus({
      cfg,
      sessionKey: `agent:${targetAgentId}:dashboard:pending`,
    }).sandboxed;
  const requesterSandboxed = params.options?.sandboxed === true || requesterRuntime.sandboxed;
  if (!childRuntimeSandboxed && (requesterSandboxed || params.sandbox === "require")) {
    return {
      status: "forbidden",
      error: requesterSandboxed
        ? "Sandboxed sessions cannot spawn unsandboxed sessions."
        : 'sessions_spawn sandbox="require" needs sandboxed target.',
    };
  }
  const spawnedWorkspaceDir = resolveSpawnedWorkspaceInheritance({
    config: cfg,
    targetAgentId,
  });
  const spawnedWorkspaceCwd = spawnedWorkspaceDir
    ? resolveUserPath(spawnedWorkspaceDir)
    : undefined;
  // Sandbox mounts only the target workspace; cwd must stay within that boundary.
  if (
    childRuntimeSandboxed &&
    spawnedCwd &&
    (!spawnedWorkspaceCwd || !isPathInside(spawnedWorkspaceCwd, spawnedCwd))
  ) {
    return {
      status: "forbidden",
      error:
        "cwd override is not supported outside the target agent workspace for sandboxed visible session runs",
    };
  }

  const reservation = reserveChildAdmissionSlot({
    controllerSessionKey: requesterKey,
    resolveAdmission: (pendingChildren) => {
      const activeChildren =
        (params.options?.countActiveRuns ?? countActiveRunsForSession)(requesterKey, {
          collect: false,
        }) + pendingChildren;
      return activeChildren >= maxChildren
        ? { ok: false as const, activeChildren }
        : { ok: true as const };
    },
  });
  if (!reservation.ok) {
    return {
      status: "forbidden",
      error: `sessions_spawn has reached max active children for this session (${reservation.activeChildren}/${maxChildren})`,
    };
  }
  try {
    const gatewayCall = params.options?.callGateway ?? callInProcessGatewayTool;
    const createGatewayCall: InProcessGatewayCaller =
      params.options?.callGateway ??
      ((method, requestParams) =>
        callInProcessGatewayToolWithCreation(method, requestParams, {
          via: "spawn",
          actor: { type: "agent", id: requesterAgentId },
          requesterSessionKey: requesterKey,
          completionOwnerSessionKey: ownership.completionRequesterSessionKey,
          inheritedToolPolicy: {
            version: 1,
            allow: [...(params.options?.inheritedToolAllowlist ?? [])],
            deny: [...(params.options?.inheritedToolDenylist ?? [])],
          },
        }));
    let response: {
      key?: string;
      sessionId?: string;
      entry?: { lifecycleRevision?: string };
      runStarted?: boolean;
      runId?: string;
      runError?: unknown;
    };
    try {
      response = await createGatewayCall("sessions.create", {
        agentId: targetAgentId,
        ...(params.label ? { label: params.label } : {}),
        // sessions.create persists the group under the legacy wire field `category`.
        ...(group ? { category: group } : {}),
        model: resolvedModel,
        task: params.task,
        parentSessionKey: requesterKey,
        // Declared spawn lineage: without it the child persists as a depth-0 root
        // and could spawn past maxSpawnDepth.
        spawnDepth: callerDepth + 1,
        ...(params.options?.sessionPermissionPolicy
          ? { permissionMode: params.options.sessionPermissionPolicy.mode }
          : {}),
        ...(params.raw.context === "fork" ? { fork: true } : {}),
        ...(spawnedCwd ? { cwd: spawnedCwd } : {}),
        ...(worktree ? { worktree: true } : {}),
        ...(worktreeName ? { worktreeName } : {}),
        ...(worktreeBaseRef ? { worktreeBaseRef } : {}),
      });
    } catch (error) {
      const missingScope = readMissingScopeErrorDetails(
        error && typeof error === "object" && "details" in error ? error.details : undefined,
      );
      if (
        spawnedCwd &&
        missingScope?.missingScope === ADMIN_SCOPE &&
        missingScope.requiredScopes.includes(ADMIN_SCOPE) &&
        !(await resolveWorkspacePathContainment(spawnedCwd, cfg))
      ) {
        return {
          status: "forbidden",
          error: `Visible session cwd "${spawnedCwd}" is outside configured agent workspaces and requires operator.admin. Omit cwd to use the target agent workspace, or ask the operator to start the session from a registered project. Do not substitute the synchronous \`openclaw agent\` CLI for a persistent visible session.`,
        };
      }
      throw error;
    }
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
    const cleanupCreatedSession = async () => {
      // Deletion drains active work only after checking the creation receipt.
      // Never recapture identity from a key that a reset or replacement may own.
      const outcome = await deleteSubagentSessionForCleanup({
        callGateway: ({ method, params: cleanupParams }) => gatewayCall(method, cleanupParams),
        childSessionKey,
        expectedSessionId: response.sessionId,
        expectedLifecycleRevision: response.entry?.lifecycleRevision,
        emitLifecycleHooks: false,
      });
      return outcome === "deleted"
        ? "Session removed."
        : outcome === "changed"
          ? "Session changed; newer session kept."
          : "Session cleanup unconfirmed. Inspect the child session before retrying.";
    };
    if (response.runStarted !== true || !runId) {
      return {
        status: "error",
        error: `${runError}. ${await cleanupCreatedSession()}`,
        childSessionKey,
      };
    }
    try {
      (params.options?.registerRun ?? registerSubagentRun)({
        runId,
        requesterTurnRunId: params.options?.requesterTurnRunId,
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
        requesterAgentId,
        cleanup: "keep",
        label: params.label || undefined,
        runTimeoutSeconds,
        expectsCompletionMessage: params.expectsCompletionMessage,
        spawnMode: "run",
      });
    } catch (error) {
      return {
        status: "error",
        error: `Visible run registration failed: ${summarizeSessionsSpawnError(error)}. ${await cleanupCreatedSession()}`,
        childSessionKey,
        runId,
      };
    }
    recordSessionParticipantBestEffort({
      promptedAt,
      identity: { type: "agent", id: requesterAgentId },
      agentId: targetAgentId,
      sessionKey: childSessionKey,
      storePath: resolveSessionStorePathCore(cfg.session?.store, { agentId: targetAgentId }),
    });
    const ownerLabel = normalizeOptionalString(resolveAgentIdentity(cfg, requesterAgentId)?.name);
    const sessionUrl = resolveControlUiSessionUrl(cfg, {
      sessionKey: childSessionKey,
      fallbackAgentId: targetAgentId,
    });
    return {
      status: "accepted",
      childSessionKey,
      runId,
      mode: "run",
      cleanup: "keep",
      ...(sessionUrl ? { sessionUrl } : {}),
      owner: {
        type: "agent",
        id: requesterAgentId,
        ...(ownerLabel ? { label: ownerLabel } : {}),
      },
    };
  } finally {
    reservation.release();
  }
}
