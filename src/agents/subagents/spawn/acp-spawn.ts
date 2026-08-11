/** Implements ACP subagent/session spawning, binding, limits, and parent-stream setup. */
import crypto from "node:crypto";
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import type { AcpTurnAttachment } from "../../../acp/control-plane/manager.types.js";
import type { AcpSpawnRuntimeCloseHandle } from "../../../acp/control-plane/spawn.js";
import { cleanupFailedAcpSpawn } from "../../../acp/control-plane/spawn.js";
import { isAcpEnabledByPolicy, resolveAcpAgentPolicyError } from "../../../acp/policy.js";
import { getRuntimeConfig } from "../../../config/config.js";
import { resolveStorePath } from "../../../config/sessions/paths.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntry,
} from "../../../config/sessions/session-accessor.js";
import { buildSessionCreationStamp } from "../../../config/sessions/session-entry-provenance.js";
import type { SessionEntry } from "../../../config/sessions/types.js";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { formatErrorMessage } from "../../../infra/errors.js";
import { resolveEventSessionRoutingPolicy } from "../../../infra/event-session-routing.js";
import {
  getSessionBindingService,
  isSessionBindingError,
  type SessionBindingRecord,
} from "../../../infra/outbound/session-binding-service.js";
import { getGlobalHookRunner } from "../../../plugins/hook-runner-global.js";
import {
  normalizeAgentId,
  normalizeOptionalAgentId,
  parseAgentSessionKey,
  resolveAgentIdFromSessionKey,
} from "../../../routing/session-key.js";
import {
  recordSessionCreated,
  recordSubagentSpawned,
} from "../../../sessions/session-state-events.js";
import { deliveryContextFromSession } from "../../../utils/delivery-context.shared.js";
import { resolveDefaultAgentId } from "../../agent-scope.js";
import { reserveChildAdmissionSlot } from "../../child-admission.js";
import {
  findAcpUnsupportedInheritedToolAllow,
  findAcpUnsupportedInheritedToolDeny,
  formatAcpInheritedToolAllowError,
  formatAcpInheritedToolDenyError,
  inheritedToolAllowPatch,
  inheritedToolDenyPatch,
} from "../../inherited-tool-deny.js";
import { AGENT_LANE_SUBAGENT } from "../../lanes.js";
import { resolveSandboxRuntimeStatus } from "../../sandbox/runtime-status.js";
import {
  runSpawnPipeline,
  type SpawnBackendAdapter,
  summarizeSpawnError,
} from "../../spawn-pipeline.js";
import {
  mintSpawnSessionKey,
  prepareSpawnThreadBinding,
  resolveSpawnAdmission,
  resolveSpawnMode,
  resolveSpawnSandboxError,
  type PreparedSpawnThreadBinding,
} from "../../spawn-plan.js";
import { resolveSpawnedWorkspaceInheritance } from "../../spawned-context.js";
import { countUntrackedActiveAcpRunsForOwner } from "./acp-spawn-admission.js";
import {
  resolveAcpSpawnBootstrapDeliveryPlan,
  toGatewayImageAttachments,
  type AcpSpawnBootstrapDeliveryPlan,
} from "./acp-spawn-bootstrap-delivery.js";
import {
  type AcpSpawnParentRelayHandle,
  startAcpSpawnParentStreamRelay,
} from "./acp-spawn-parent-stream.js";
import {
  resolveAcpSpawnRequesterState,
  resolveAcpSpawnStreamPlan,
  resolveRequesterInternalSessionKey,
  validateAcpResumeSessionOwnership,
} from "./acp-spawn-requester.js";
import {
  bindPreparedAcpThread,
  initializeAcpSpawnRuntime,
  resolveAcpSessionMode,
  resolveAcpSpawnRuntimeOptions,
  resolveRuntimeCwdForAcpSpawn,
  type AcpSpawnInitializedRuntime,
} from "./acp-spawn-runtime.js";
import {
  resolveConfiguredAcpSubagentTargetIds,
  resolveTargetAcpAgentId,
} from "./acp-spawn-target.js";
import {
  isSubagentEnvelopeSession,
  resolveSubagentCapabilityStore,
} from "./subagent-capabilities.js";
import { callSubagentGateway, readGatewayRunId } from "./subagent-spawn-gateway.js";
import { resolveSubagentSpawnOwnership } from "./subagent-spawn-ownership.js";
import { resolveConfiguredSubagentRunTimeoutSeconds } from "./subagent-spawn-plan.js";

export const ACP_SPAWN_MODES = ["run", "session"] as const;
type SpawnAcpMode = (typeof ACP_SPAWN_MODES)[number];
const ACP_SPAWN_SANDBOX_MODES = ["inherit", "require"] as const;
export type SpawnAcpSandboxMode = (typeof ACP_SPAWN_SANDBOX_MODES)[number];
export const ACP_SPAWN_STREAM_TARGETS = ["parent"] as const;
type SpawnAcpStreamTarget = (typeof ACP_SPAWN_STREAM_TARGETS)[number];

type SpawnAcpParams = {
  task: string;
  taskName?: string;
  label?: string;
  agentId?: string;
  resumeSessionId?: string;
  model?: string;
  thinking?: string;
  runTimeoutSeconds?: number;
  cwd?: string;
  mode?: SpawnAcpMode;
  thread?: boolean;
  sandbox?: SpawnAcpSandboxMode;
  cleanup?: "delete" | "keep";
  expectsCompletionMessage?: boolean;
  streamTo?: SpawnAcpStreamTarget;
  attachments?: AcpTurnAttachment[];
};

export type SpawnAcpContext = {
  agentSessionKey?: string;
  requesterTurnRunId?: string;
  completionOwnerKey?: string;
  requesterAgentIdOverride?: string;
  agentChannel?: string;
  agentAccountId?: string;
  agentTo?: string;
  agentThreadId?: string | number;
  currentMessagingTarget?: string;
  currentChannelId?: string;
  currentMessageId?: string | number;
  /** Group chat ID for channels that distinguish group vs. topic (e.g. Telegram). */
  agentGroupId?: string;
  /** Group space label (guild/team id) from the originating channel context. */
  agentGroupSpace?: string | null;
  /** Trusted provider role ids for the requester in this group turn. */
  agentMemberRoleIds?: string[];
  sandboxed?: boolean;
  inheritedToolAllowlist?: string[];
  inheritedToolDenylist?: string[];
};

const ACP_SPAWN_ERROR_CODES = [
  "acp_disabled",
  "requester_session_required",
  "runtime_policy",
  "resume_forbidden",
  "subagent_policy",
  "thread_required",
  "target_agent_required",
  "runtime_agent_mismatch",
  "agent_forbidden",
  "cwd_resolution_failed",
  "thread_binding_invalid",
  "spawn_failed",
  "dispatch_failed",
] as const;
type SpawnAcpErrorCode = (typeof ACP_SPAWN_ERROR_CODES)[number];

type SpawnAcpResultFields = {
  childSessionKey?: string;
  runId?: string;
  mode?: SpawnAcpMode;
  runTimeoutSeconds?: number;
  inlineDelivery?: boolean;
  note?: string;
};

type SpawnAcpAcceptedResult = SpawnAcpResultFields & {
  status: "accepted";
  childSessionKey: string;
  runId: string;
  mode: SpawnAcpMode;
};

type SpawnAcpFailedResult = SpawnAcpResultFields & {
  status: "forbidden" | "error";
  error: string;
  errorCode: SpawnAcpErrorCode;
};

export type SpawnAcpResult = SpawnAcpAcceptedResult | SpawnAcpFailedResult;

export function isSpawnAcpAcceptedResult(result: SpawnAcpResult): result is SpawnAcpAcceptedResult {
  return result.status === "accepted";
}

const ACP_SPAWN_ACCEPTED_NOTE =
  "initial ACP task queued in isolated session; follow-ups continue in the bound thread.";
const ACP_SPAWN_SESSION_ACCEPTED_NOTE =
  "thread-bound ACP session stays active after this task; continue in-thread for follow-ups.";

export function resolveAcpSpawnRuntimePolicyError(params: {
  cfg: OpenClawConfig;
  requesterSessionKey?: string;
  requesterSandboxed?: boolean;
  sandbox?: SpawnAcpSandboxMode;
}): string | undefined {
  const sandboxMode = params.sandbox === "require" ? "require" : "inherit";
  const requesterRuntime = resolveSandboxRuntimeStatus({
    cfg: params.cfg,
    sessionKey: params.requesterSessionKey,
  });
  const requesterSandboxed = params.requesterSandboxed === true || requesterRuntime.sandboxed;
  return resolveSpawnSandboxError({
    backend: "acp",
    requesterSandboxed,
    sandbox: sandboxMode,
  });
}

function createAcpSpawnFailure(params: {
  status: "forbidden" | "error";
  errorCode: SpawnAcpErrorCode;
  error: string;
  childSessionKey?: string;
  runId?: string;
}): SpawnAcpFailedResult {
  return {
    status: params.status,
    errorCode: params.errorCode,
    error: params.error,
    ...(params.childSessionKey ? { childSessionKey: params.childSessionKey } : {}),
    ...(params.runId ? { runId: params.runId } : {}),
  };
}

export { resolveRuntimeCwdForAcpSpawn } from "./acp-spawn-runtime.js";

export async function spawnAcpDirect(
  params: SpawnAcpParams,
  ctx: SpawnAcpContext,
): Promise<SpawnAcpResult> {
  const cfg = getRuntimeConfig();
  const runTimeoutSeconds = resolveConfiguredSubagentRunTimeoutSeconds({
    cfg,
    runTimeoutSeconds: params.runTimeoutSeconds,
  });
  const requesterInternalKey = resolveRequesterInternalSessionKey({
    cfg,
    requesterSessionKey: ctx.agentSessionKey,
  });
  const requesterAgentId = normalizeAgentId(
    ctx.requesterAgentIdOverride ?? parseAgentSessionKey(requesterInternalKey)?.agentId,
  );
  if (!isAcpEnabledByPolicy(cfg)) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "acp_disabled",
      error: "ACP is disabled by policy (`acp.enabled=false`).",
    });
  }
  const streamToParentRequested = params.streamTo === "parent";
  const parentSessionKey = normalizeOptionalString(ctx.agentSessionKey);
  if (streamToParentRequested && !parentSessionKey) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "requester_session_required",
      error: 'sessions_spawn streamTo="parent" requires an active requester session context.',
    });
  }

  const requestThreadBinding = params.thread === true;
  const runtimePolicyError = resolveAcpSpawnRuntimePolicyError({
    cfg,
    requesterSessionKey: ctx.agentSessionKey,
    requesterSandboxed: ctx.sandboxed,
    sandbox: params.sandbox,
  });
  if (runtimePolicyError) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "runtime_policy",
      error: runtimePolicyError,
    });
  }
  const acpUnsupportedInheritedTool = findAcpUnsupportedInheritedToolDeny(
    ctx.inheritedToolDenylist,
  );
  if (acpUnsupportedInheritedTool) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "runtime_policy",
      error: formatAcpInheritedToolDenyError(acpUnsupportedInheritedTool),
    });
  }
  const acpUnsupportedInheritedAllow = findAcpUnsupportedInheritedToolAllow(
    ctx.inheritedToolAllowlist,
  );
  if (acpUnsupportedInheritedAllow) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "runtime_policy",
      error: formatAcpInheritedToolAllowError(acpUnsupportedInheritedAllow),
    });
  }

  const spawnMode = resolveSpawnMode({
    requestedMode: params.mode,
    threadRequested: requestThreadBinding,
  });
  if (spawnMode === "session" && !requestThreadBinding) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "thread_required",
      error:
        'sessions_spawn(runtime="acp", mode="session") requires thread=true so the ACP session can stay bound to a channel thread. ' +
        'Retry with { mode: "session", thread: true } on a channel that exposes threads (e.g. Discord, Slack, Telegram topics), or use mode="run" for one-shot work.',
    });
  }

  const targetAgentResult = resolveTargetAcpAgentId({
    requestedAgentId: params.agentId,
    cfg,
  });
  if (!targetAgentResult.ok) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode:
        params.agentId && normalizeOptionalAgentId(params.agentId)
          ? "runtime_agent_mismatch"
          : "target_agent_required",
      error: targetAgentResult.error,
    });
  }
  const targetAgentId = targetAgentResult.agentId;
  const agentPolicyError = resolveAcpAgentPolicyError(cfg, targetAgentId);
  if (agentPolicyError) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "agent_forbidden",
      error: agentPolicyError.message,
    });
  }
  const subagentStore = resolveSubagentCapabilityStore(parentSessionKey, {
    cfg,
  });
  const requesterState = resolveAcpSpawnRequesterState({
    cfg,
    parentSessionKey,
    requesterAgentId,
    targetAgentId,
    ctx,
    subagentStore,
  });
  const hasSubagentEnvelope = isSubagentEnvelopeSession(requesterInternalKey, {
    cfg,
    store: subagentStore,
  });
  const resolveAdmission = (pendingChildren = 0, pendingChildSessionKeys?: ReadonlySet<string>) =>
    resolveSpawnAdmission({
      cfg,
      enabled: hasSubagentEnvelope,
      requesterSessionKey: requesterInternalKey,
      requesterAgentId,
      targetAgentId,
      requestedAgentId: params.agentId,
      configuredAgentIds: resolveConfiguredAcpSubagentTargetIds(cfg),
      additionalActiveChildren: hasSubagentEnvelope
        ? countUntrackedActiveAcpRunsForOwner(requesterInternalKey, pendingChildSessionKeys) +
          pendingChildren
        : 0,
    });
  const rejectSubagentPolicy = (error: string) =>
    createAcpSpawnFailure({ status: "forbidden", errorCode: "subagent_policy", error });
  const admission = resolveAdmission();
  if (!admission.ok) {
    return rejectSubagentPolicy(admission.error);
  }
  const resumeAuthorization = validateAcpResumeSessionOwnership({
    cfg,
    targetAgentId,
    requesterSessionKey: requesterInternalKey,
    resumeSessionId: params.resumeSessionId,
  });
  if (!resumeAuthorization.ok) {
    return createAcpSpawnFailure({
      status: "forbidden",
      errorCode: "resume_forbidden",
      error: resumeAuthorization.error,
    });
  }
  const runtimeOptionsResult = resolveAcpSpawnRuntimeOptions({
    cfg,
    targetAgentId,
    configAgentId: targetAgentResult.configAgentId,
    model: params.model,
    thinking: params.thinking,
    runTimeoutSeconds,
  });
  if (!runtimeOptionsResult.ok) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "spawn_failed",
      error: runtimeOptionsResult.error,
    });
  }
  const { effectiveStreamToParent } = resolveAcpSpawnStreamPlan({
    spawnMode,
    requestThreadBinding,
    streamToParentRequested,
    requester: requesterState,
  });

  const sessionKey = mintSpawnSessionKey({ targetAgentId, backend: "acp" });
  const runtimeMode = resolveAcpSessionMode(spawnMode);
  const resolvedCwd = resolveSpawnedWorkspaceInheritance({
    config: cfg,
    targetAgentId,
    requesterSessionKey: ctx.agentSessionKey,
    explicitWorkspaceDir: params.cwd,
  });
  let runtimeCwd: string | undefined;
  try {
    runtimeCwd = await resolveRuntimeCwdForAcpSpawn({
      resolvedCwd,
      explicitCwd: params.cwd,
    });
  } catch (error) {
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "cwd_resolution_failed",
      error: formatErrorMessage(error),
    });
  }

  let preparedBinding: PreparedSpawnThreadBinding | null = null;
  if (requestThreadBinding) {
    const prepared = prepareSpawnThreadBinding({
      cfg,
      kind: "acp",
      mode: spawnMode,
      bindingService: getSessionBindingService(),
      channel: requesterState.origin?.channel,
      accountId: requesterState.origin?.accountId,
      to: requesterState.origin?.to,
      threadId: requesterState.origin?.threadId,
      groupId: ctx.agentGroupId,
    });
    if (!prepared.ok) {
      return createAcpSpawnFailure({
        status: "error",
        errorCode: "thread_binding_invalid",
        error: prepared.error,
      });
    }
    preparedBinding = prepared.binding;
  }

  let sessionCreated = false;
  let childCreationEntry: SessionEntry | undefined;
  let initializedRuntime: AcpSpawnRuntimeCloseHandle | undefined;
  const childIdem = crypto.randomUUID();
  const parentAgentId = parentSessionKey
    ? resolveAgentIdFromSessionKey(parentSessionKey, resolveDefaultAgentId(cfg))
    : undefined;
  // Resolve parent session delivery context so system events route to the
  // correct thread/topic instead of falling back to the main DM.
  const parentDeliveryCtx =
    effectiveStreamToParent && parentSessionKey
      ? deliveryContextFromSession(
          loadSessionEntryReadOnly({
            sessionKey: parentSessionKey,
            ...(parentAgentId ? { agentId: parentAgentId } : {}),
            clone: false,
          }),
        )
      : undefined;

  const parentRelayStateEnv = { ...process.env };
  const parentEventRouting = parentSessionKey
    ? resolveEventSessionRoutingPolicy({ cfg, sessionKey: parentSessionKey })
    : undefined;
  const gatewayAttachments = toGatewayImageAttachments(params.attachments);
  const ownership = resolveSubagentSpawnOwnership({
    cfg,
    agentSessionKey: ctx.agentSessionKey,
    completionOwnerKey: ctx.completionOwnerKey,
  });
  const requesterOrigin = requesterState.origin;
  const progressOrigin = {
    channel: requesterOrigin?.channel,
    accountId: requesterOrigin?.accountId,
    to: ctx.currentMessagingTarget ?? ctx.currentChannelId ?? requesterOrigin?.to,
    threadId: requesterOrigin?.threadId,
    channelId: ctx.currentChannelId,
    messageId: ctx.currentMessageId,
  };
  type AcpBackendState = {
    initializedSession: AcpSpawnInitializedRuntime;
    binding: SessionBindingRecord | null;
    deliveryPlan?: AcpSpawnBootstrapDeliveryPlan;
    parentRelay?: AcpSpawnParentRelayHandle;
  };
  const adapter: SpawnBackendAdapter<AcpBackendState> = {
    async initialize() {
      const creationStamp = buildSessionCreationStamp({
        via: "spawn",
        actor: { type: "agent", id: requesterInternalKey },
      });
      const storePath = resolveStorePath(cfg.session?.store, { agentId: targetAgentId });
      const childSessionPatch = admission.childSessionPatch
        ? {
            spawnDepth: admission.childSessionPatch.spawnDepth,
            ...(admission.childSessionPatch.subagentRole
              ? { subagentRole: admission.childSessionPatch.subagentRole }
              : {}),
            subagentControlScope: admission.childSessionPatch.subagentControlScope,
          }
        : {};
      childCreationEntry =
        (await upsertSessionEntry(
          { storePath, sessionKey },
          {
            ...creationStamp,
            spawnedBy: requesterInternalKey,
            completionOwnerSessionKey: ownership.completionRequesterSessionKey,
            // Navigation parent is stamped at creation so the durable tree edge
            // does not depend on the control-lineage field.
            parentSessionKey: requesterInternalKey,
            ...childSessionPatch,
            inheritedToolPolicyVersion: 1,
            ...inheritedToolAllowPatch(ctx.inheritedToolAllowlist),
            ...inheritedToolDenyPatch(ctx.inheritedToolDenylist),
            ...(params.label ? { label: params.label } : {}),
          },
        )) ?? undefined;
      sessionCreated = true;
      const initializedSession = await initializeAcpSpawnRuntime({
        cfg,
        sessionKey,
        targetAgentId,
        runtimeMode,
        resumeSessionId: params.resumeSessionId,
        runtimeOptions: runtimeOptionsResult.runtimeOptions,
        modelExplicit: runtimeOptionsResult.modelExplicit,
        cwd: runtimeCwd,
      });
      initializedRuntime = initializedSession.runtimeCloseHandle;
      const binding = preparedBinding
        ? (
            await bindPreparedAcpThread({
              cfg,
              sessionKey,
              targetAgentId,
              label: params.label,
              preparedBinding,
              initializedRuntime: initializedSession,
            })
          ).binding
        : null;
      return { initializedSession, binding };
    },
    async dispatchTurn(state) {
      state.deliveryPlan = resolveAcpSpawnBootstrapDeliveryPlan({
        cfg,
        spawnMode,
        requestThreadBinding,
        effectiveStreamToParent,
        requester: requesterState,
        binding: state.binding,
      });
      // ACP bypasses the native adapter, so seed the same child lineage before dispatch.
      if (childCreationEntry) {
        recordSessionCreated({
          sessionKey,
          agentId: targetAgentId,
          entry: childCreationEntry,
        });
      }
      recordSubagentSpawned({
        childSessionKey: sessionKey,
        childRunId: childIdem,
        requesterSessionKey: requesterInternalKey,
        agentId: targetAgentId,
      });
      if (effectiveStreamToParent && parentSessionKey) {
        state.parentRelay = startAcpSpawnParentStreamRelay({
          runId: childIdem,
          parentSessionKey,
          childSessionKey: sessionKey,
          childSessionId: state.initializedSession.sessionId,
          agentId: targetAgentId,
          env: parentRelayStateEnv,
          mainKey: cfg.session?.mainKey,
          sessionScope: cfg.session?.scope,
          eventRouting: parentEventRouting,
          deliveryContext: parentDeliveryCtx,
          emitStartNotice: false,
          cfg,
        });
      }
      const response = await callSubagentGateway({
        method: "agent",
        params: {
          message: params.task,
          sessionKey,
          channel: state.deliveryPlan.channel,
          to: state.deliveryPlan.to,
          accountId: state.deliveryPlan.accountId,
          threadId: state.deliveryPlan.threadId,
          idempotencyKey: childIdem,
          deliver: state.deliveryPlan.useInlineDelivery,
          lane: AGENT_LANE_SUBAGENT,
          acpTurnSource: "manual_spawn",
          timeout: runTimeoutSeconds,
          label: params.label || undefined,
          ...(gatewayAttachments ? { attachments: gatewayAttachments } : {}),
        },
        timeoutMs: 10_000,
      });
      const runId = readGatewayRunId(response) ?? childIdem;
      if (state.parentRelay && runId !== childIdem && parentSessionKey) {
        state.parentRelay.dispose();
        state.parentRelay = startAcpSpawnParentStreamRelay({
          runId,
          parentSessionKey,
          childSessionKey: sessionKey,
          childSessionId: state.initializedSession.sessionId,
          agentId: targetAgentId,
          env: parentRelayStateEnv,
          mainKey: cfg.session?.mainKey,
          sessionScope: cfg.session?.scope,
          eventRouting: parentEventRouting,
          deliveryContext: parentDeliveryCtx,
          emitStartNotice: false,
          cfg,
        });
      }
      state.parentRelay?.notifyStarted();
      return { runId };
    },
    async cleanupOnFailure({ state }) {
      state?.parentRelay?.dispose();
      await cleanupFailedAcpSpawn({
        cfg,
        sessionKey,
        shouldDeleteSession: sessionCreated,
        deleteTranscript: true,
        runtimeCloseHandle: initializedRuntime,
      });
    },
  };
  const { controllerSessionKey } = ownership;
  const admissionReservation = hasSubagentEnvelope
    ? reserveChildAdmissionSlot({
        controllerSessionKey,
        childSessionKey: sessionKey,
        resolveAdmission,
      })
    : undefined;
  if (admissionReservation && !admissionReservation.ok) {
    return rejectSubagentPolicy(admissionReservation.error);
  }
  const pipelineResult = await runSpawnPipeline({
    adapter,
    admissionReservation,
    hookRunner: getGlobalHookRunner(),
    progressOrigin,
    progressSessionKey: ownership.completionRequesterSessionKey,
    buildRegistration: (state, runId) => {
      const inlineDelivery = state.deliveryPlan?.useInlineDelivery === true;
      return {
        runId,
        requesterTurnRunId: ctx.requesterTurnRunId,
        childSessionKey: sessionKey,
        controllerSessionKey,
        requesterSessionKey: ownership.completionRequesterSessionKey,
        requesterOrigin,
        progressOrigin,
        requesterDisplayKey: ownership.completionRequesterDisplayKey,
        task: params.task,
        taskName: params.taskName,
        agentId: targetAgentId,
        requesterAgentId,
        cleanup: spawnMode === "session" ? "keep" : params.cleanup === "delete" ? "delete" : "keep",
        label: params.label,
        runTimeoutSeconds,
        expectsCompletionMessage: inlineDelivery
          ? false
          : params.expectsCompletionMessage !== false,
        spawnMode,
      };
    },
  });
  if (!pipelineResult.ok) {
    if (pipelineResult.phase === "initialize") {
      return createAcpSpawnFailure({
        status: "error",
        errorCode: isSessionBindingError(pipelineResult.error)
          ? "thread_binding_invalid"
          : "spawn_failed",
        error: isSessionBindingError(pipelineResult.error)
          ? pipelineResult.error.message
          : summarizeSpawnError(pipelineResult.error),
      });
    }
    if (pipelineResult.phase === "dispatch") {
      return createAcpSpawnFailure({
        status: "error",
        errorCode: "dispatch_failed",
        error: summarizeSpawnError(pipelineResult.error),
        childSessionKey: sessionKey,
      });
    }
    return createAcpSpawnFailure({
      status: "error",
      errorCode: "spawn_failed",
      error: `Failed to register ACP run: ${summarizeSpawnError(pipelineResult.error)}. Cleanup was attempted, but the already-started ACP run may still finish in the background.`,
      childSessionKey: sessionKey,
      runId: pipelineResult.runId,
    });
  }
  const childRunId = pipelineResult.runId;
  const deliveryPlan = pipelineResult.state.deliveryPlan;

  return {
    status: "accepted",
    childSessionKey: sessionKey,
    runId: childRunId,
    mode: spawnMode,
    runTimeoutSeconds,
    ...(deliveryPlan?.useInlineDelivery ? { inlineDelivery: true } : {}),
    note: spawnMode === "session" ? ACP_SPAWN_SESSION_ACCEPTED_NOTE : ACP_SPAWN_ACCEPTED_NOTE,
  };
}
