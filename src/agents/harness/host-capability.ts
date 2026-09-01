import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { emitAgentRunOutputTokens } from "../../infra/agent-events.js";
import { getActiveDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import {
  getInstallationTarget,
  installationTargetEnv,
  withInstallationTarget,
} from "../../infra/installation-target-context.js";
import { prepareSystemRunMutableFileApproval } from "../../infra/system-run-approval-binding.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import {
  getPluginRuntimeGatewayRequestScope,
  withPluginRuntimeGatewayRequestScope,
} from "../../plugins/runtime/gateway-request-scope.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
import { bindUserTurnTranscriptAnnotation } from "../../sessions/user-turn-transcript-annotation.js";
import {
  getAdmittedRunDelegatedAuthority,
  retainAdmittedRunBeforeToolCallRecovery,
} from "../admitted-run-context.js";
import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import { bindAgentToolSourceExecutionGuard } from "../agent-tool-source-execution-guard.js";
import { wrapToolWithAbortSignal } from "../agent-tools.abort.js";
import {
  rewrapToolWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import { createOpenClawCodingTools } from "../agent-tools.js";
import { log } from "../embedded-agent-runner/logger.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { runBestEffortCallback } from "../embedded-agent-subscribe.callback.js";
import { createCronScheduledToolProjection } from "../exec-tool-target-pinning.js";
import { prepareGitHubToolEnvironment } from "../github-tool-identity.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import { registerTrustedToolNoStartError } from "../tool-result-error.js";
import type { AnyAgentTool } from "../tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  getGatewayToolCallerIdentity,
  withGatewayToolApprovalOwner,
  withGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  getCoreTtsToolResultMediaUrls,
  transferCoreTtsToolResultProvenance,
} from "../tools/tts-tool-result-provenance.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";
import {
  registerAgentHarnessScheduledToolProjectionCapability,
  registerAgentHarnessTtsProvenanceTransferCapability,
} from "./host-private-capabilities.js";
import { createSessionNodeInvocation } from "./node-execution-authority.js";

type AgentHarnessHostAttempt = Partial<EmbeddedRunAttemptParams> &
  Pick<EmbeddedRunAttemptParams, "admittedRunContext" | "runId">;
type AgentHarnessHostApprovalResult = NonNullable<
  Awaited<ReturnType<AgentHarnessHostCapabilities["waitForApproval"]>>
>;

const MAX_NATIVE_OPERATION_CWD_BYTES = 4096;

type RetainedBeforeToolCallRunner = Readonly<{
  assertActive: () => void;
  release: () => void;
  runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"];
}>;

const retainedBeforeToolCallRunners = new WeakMap<
  AgentHarnessHostCapabilities["runBeforeToolCall"],
  () => RetainedBeforeToolCallRunner | undefined
>();

/** Internal core-only lease for an already-created host policy callback. */
export function retainBeforeToolCallForNativeHookRelay(
  runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"],
): RetainedBeforeToolCallRunner | undefined {
  return retainedBeforeToolCallRunners.get(runBeforeToolCall)?.();
}

function normalizeNativeOperationCwd(value: unknown, attemptCwd: string | undefined): string {
  if (typeof value !== "string") {
    throw new Error("native operation cwd must be a string");
  }
  const normalized = value.trim();
  if (!normalized) {
    throw new Error("native operation cwd must not be empty");
  }
  if (Buffer.byteLength(normalized, "utf8") > MAX_NATIVE_OPERATION_CWD_BYTES) {
    throw new Error(`native operation cwd must not exceed ${MAX_NATIVE_OPERATION_CWD_BYTES} bytes`);
  }
  for (let index = 0; index < normalized.length; index += 1) {
    const code = normalized.charCodeAt(index);
    if (code < 32 || code === 127) {
      throw new Error("native operation cwd must not contain control characters");
    }
  }
  return path.resolve(attemptCwd ?? process.cwd(), normalized);
}

function freezeSnapshot<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value as object)) {
    return value;
  }
  seen.add(value as object);
  for (const nested of Object.values(value as Record<string, unknown>)) {
    freezeSnapshot(nested, seen);
  }
  return Object.freeze(value);
}

function cloneSnapshot<T>(value: T): T {
  return freezeSnapshot(structuredClone(value));
}

function gateBoundTool(
  tool: AnyAgentTool,
  assertActive: () => void,
  observeResult: (result: unknown) => void,
): AnyAgentTool {
  const execute = tool.execute;
  const sourcePreparer = getInternalToolExecutionPreparer(tool);
  if (!execute && !sourcePreparer) {
    return tool;
  }
  const gated: AnyAgentTool = {
    ...tool,
    ...(execute
      ? {
          execute: async (...args: Parameters<NonNullable<AnyAgentTool["execute"]>>) => {
            try {
              assertActive();
            } catch (error) {
              // This gate precedes dispatch; a revoked owner must not look like
              // a tool that started and failed in downstream terminal evidence.
              throw registerTrustedToolNoStartError(error);
            }
            const result = await execute(...args);
            assertActive();
            observeResult(result);
            return result;
          },
        }
      : {}),
  };
  copyAgentToolMetadata(tool, gated);
  if (sourcePreparer) {
    attachInternalToolExecutionPreparer(gated, async (preparationParams) => {
      assertActive();
      const prepared = await sourcePreparer(preparationParams);
      try {
        assertActive();
      } catch (error) {
        prepared.dispose();
        throw error;
      }
      if (prepared.kind === "immediate") {
        if (prepared.outcome.kind === "result") {
          observeResult(prepared.outcome.result);
        }
        return prepared;
      }
      return {
        ...prepared,
        execute: async (onImplementationStart) => {
          assertActive();
          const result = await prepared.execute(onImplementationStart);
          assertActive();
          observeResult(result);
          return result;
        },
      };
    });
  }
  return gated;
}

function createBoundCallerIdentity(
  params: AgentHarnessHostAttempt,
  receiptAuthority: () => void,
  signal: AbortSignal,
) {
  return createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: params.admittedRunContext,
    receiptAuthority,
    approvalSignals: [signal, ...(params.abortSignal ? [params.abortSignal] : [])],
    agentId: params.agentId,
    sessionKey: params.sessionKey,
    turnSourceChannel: params.messageChannel ?? params.messageProvider,
    turnSourceTo: params.currentMessagingTarget ?? params.currentChannelId,
    turnSourceAccountId: params.agentAccountId,
    turnSourceThreadId: params.currentThreadTs,
  });
}

/** Creates a closure-bound capability before plugin invocation. */
export function createAgentHarnessHostCapabilities(params: {
  attempt: AgentHarnessHostAttempt;
  pluginId: string;
  requiredNodeCommands?: readonly string[];
}): {
  capabilities: AgentHarnessHostCapabilities;
  close: () => void;
  runWithScope: <T>(run: () => Promise<T>) => Promise<T>;
} {
  const attempt = params.attempt;
  const installationTarget = getInstallationTarget();
  const localProcessEnv = installationTargetEnv(installationTarget);
  const { sessionKey, onAgentEvent } = attempt;
  // Capture the selected harness declaration before plugin code can mutate it.
  // Full must not cover other commands merely because the same plugin owns them.
  const requiredNodeCommands = new Set(params.requiredNodeCommands);
  const operationalRunInstance = attempt.admittedRunContext.operationalRunInstance;
  const delegatedAuthority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
  if (!delegatedAuthority) {
    throw new Error("agent harness host capability requires active admitted run authority");
  }
  const { lifecycleGeneration } = delegatedAuthority;
  const { runId } = delegatedAuthority.operationalRunInstance;
  const coreTtsToolResults = new WeakSet<object>();
  let active = true;
  // Lexical closure must also fence work already past its entry guard. The
  // result guards below cover exact authority loss that does not use close().
  const capabilityAbortController = new AbortController();
  const inheritedCaller = getGatewayToolCallerIdentity();
  const sourceCaller =
    inheritedCaller?.operationalRunInstance === operationalRunInstance
      ? inheritedCaller
      : undefined;
  const callerIdentity = createBoundCallerIdentity(
    attempt,
    assertActive,
    capabilityAbortController.signal,
  );
  function assertActive() {
    if (
      !active ||
      attempt.admittedRunContext.operationalRunInstance !== operationalRunInstance ||
      getAdmittedRunDelegatedAuthority(attempt.admittedRunContext) !== delegatedAuthority ||
      (callerIdentity?.gatewayContextResolver !== undefined &&
        callerIdentity.gatewayContextResolver() === undefined)
    ) {
      throw new Error("agent harness host capability is no longer active");
    }
    // The captured worker/source claim owns every host capability use, including
    // native configuration writes that do not pass through prompt annotation.
    if (
      (sourceCaller &&
        (sourceCaller.agentId !== attempt.agentId ||
          sourceCaller.sessionKey !== attempt.sessionKey)) ||
      (sourceCaller?.workerTurnClaim &&
        (sourceCaller.workerTurnClaim.sessionId !== attempt.sessionId ||
          sourceCaller.workerTurnClaim.runId !== attempt.runId)) ||
      (sourceCaller?.workerTurnClaim && !sourceCaller.receiptAuthority) ||
      sourceCaller?.receiptAuthority?.() === false
    ) {
      throw new Error("agent harness host capability lost its source execution claim");
    }
  }
  const observeCoreTtsToolResult = (result: unknown) => {
    if (typeof result === "object" && result !== null && getCoreTtsToolResultMediaUrls(result)) {
      coreTtsToolResults.add(result);
    }
  };
  const requester = {
    ...((attempt.messageChannel ?? attempt.messageProvider)
      ? { channel: attempt.messageChannel ?? attempt.messageProvider ?? undefined }
      : {}),
    ...(attempt.agentAccountId ? { accountId: attempt.agentAccountId } : {}),
    ...(attempt.senderId ? { senderId: attempt.senderId } : {}),
    ...(attempt.senderIsOwner !== undefined ? { senderIsOwner: attempt.senderIsOwner } : {}),
    ...(attempt.memberRoleIds?.length
      ? { roleIds: Object.freeze([...attempt.memberRoleIds]) }
      : {}),
  };
  const config = attempt.config ? cloneSnapshot(attempt.config) : undefined;
  const recorder = attempt.userTurnTranscriptRecorder;
  const sessionTarget = attempt.sessionTarget ? cloneSnapshot(attempt.sessionTarget) : undefined;
  const annotateCurrentUserTurn =
    attempt.userTurnTranscriptRecorder &&
    attempt.sessionTarget &&
    attempt.agentId &&
    attempt.sessionId &&
    attempt.sessionKey &&
    attempt.sessionTarget.storePath &&
    !attempt.suppressNextUserMessagePersistence &&
    attempt.trigger !== "memory"
      ? bindUserTurnTranscriptAnnotation({
          recorder: attempt.userTurnTranscriptRecorder,
          target: {
            ...attempt.sessionTarget,
            agentId: attempt.agentId,
            sessionId: attempt.sessionId,
            sessionKey: attempt.sessionKey,
            storePath: attempt.sessionTarget.storePath,
          },
          runId: attempt.runId,
          config,
          abortSignal: attempt.abortSignal
            ? AbortSignal.any([attempt.abortSignal, capabilityAbortController.signal])
            : capabilityAbortController.signal,
          assertCurrent: () => {
            assertActive();
            if (
              attempt.userTurnTranscriptRecorder !== recorder ||
              !isDeepStrictEqual(attempt.sessionTarget, sessionTarget) ||
              (sessionTarget?.agentId !== undefined && sessionTarget.agentId !== attempt.agentId) ||
              (sessionTarget?.sessionId !== undefined &&
                sessionTarget.sessionId !== attempt.sessionId) ||
              (sessionTarget?.sessionKey !== undefined &&
                sessionTarget.sessionKey !== attempt.sessionKey)
            ) {
              throw new Error("native prompt annotation lost its source execution claim");
            }
          },
        })
      : undefined;
  const skillsSnapshot = attempt.skillsSnapshot ? cloneSnapshot(attempt.skillsSnapshot) : undefined;
  const preparedRunEnvironment = prepareGitHubToolEnvironment({
    config: config ?? {},
    sourceConfig: getActiveSecretsRuntimeConfigSnapshot()?.sourceConfig,
    agentId: attempt.agentId ?? "main",
  });
  const skillUsagePaths = attempt.sandbox?.skillUsagePaths
    ? cloneSnapshot(attempt.sandbox.skillUsagePaths)
    : undefined;
  const hookContext = Object.freeze({
    ...(attempt.agentId ? { agentId: attempt.agentId } : {}),
    ...(config ? { config } : {}),
    ...(attempt.cwd ? { cwd: attempt.cwd } : {}),
    ...(attempt.workspaceDir ? { workspaceDir: attempt.workspaceDir } : {}),
    ...(attempt.sessionKey ? { sessionKey: attempt.sessionKey } : {}),
    ...(attempt.sessionId ? { sessionId: attempt.sessionId } : {}),
    runId: attempt.runId,
    ...buildAgentHookContextChannelFields(attempt),
    ...(Object.keys(requester).length > 0 ? { requester: Object.freeze(requester) } : {}),
    ...(getActiveDiagnosticTraceContext() ? { trace: getActiveDiagnosticTraceContext() } : {}),
    ...(skillsSnapshot ? { skillsSnapshot } : {}),
    ...(skillUsagePaths ? { skillUsagePaths } : {}),
    ...(attempt.onToolOutcome ? { onToolOutcome: attempt.onToolOutcome } : {}),
    ...(attempt.allocateToolOutcomeOrdinal
      ? { allocateToolOutcomeOrdinal: attempt.allocateToolOutcomeOrdinal }
      : {}),
    ...(attempt.sandbox?.enabled &&
    attempt.sandbox.workspaceAccess === "rw" &&
    attempt.sandbox.fsBridge
      ? {
          sandbox: Object.freeze({
            root: attempt.sandbox.workspaceDir,
            bridge: attempt.sandbox.fsBridge,
          }),
        }
      : {}),
    loopDetection: cloneSnapshot(
      resolveToolLoopDetectionConfig({
        cfg: config,
        agentId: attempt.agentId,
      }),
    ),
    trigger: attempt.trigger,
    approvalReviewerDeviceId: attempt.approvalReviewerDeviceId,
    turnSourceChannel: attempt.messageChannel ?? attempt.messageProvider,
    turnSourceTo: attempt.currentMessagingTarget ?? attempt.currentChannelId,
    turnSourceAccountId: attempt.agentAccountId,
    turnSourceThreadId: attempt.currentThreadTs,
  });
  const withCaller = async <T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> =>
    await withGatewayToolCallerIdentity(
      callerIdentity && signal
        ? {
            ...callerIdentity,
            approvalSignals: [...(callerIdentity.approvalSignals ?? []), signal],
          }
        : callerIdentity,
      run,
    );
  const runBeforeToolCallWithAssertion = async (
    assertCurrent: () => void,
    {
      nativeOperation,
      approvalMode,
      ...request
    }: Parameters<AgentHarnessHostCapabilities["runBeforeToolCall"]>[0],
  ) => {
    assertCurrent();
    const hostApprovalMode = approvalMode === "defer" ? "defer" : "request";
    const actionCwd =
      nativeOperation?.cwd !== undefined
        ? normalizeNativeOperationCwd(nativeOperation.cwd, hookContext.cwd)
        : undefined;
    const actionHookContext = actionCwd
      ? Object.freeze({ ...hookContext, cwd: actionCwd })
      : hookContext;
    const result = await runBeforeToolCallHook({
      ...request,
      approvalMode: hostApprovalMode,
      ctx: actionHookContext,
    });
    assertCurrent();
    return result;
  };
  const runBeforeToolCall: AgentHarnessHostCapabilities["runBeforeToolCall"] = async (request) =>
    await withCaller(
      async () => await runBeforeToolCallWithAssertion(assertActive, request),
      request.signal,
    );
  retainedBeforeToolCallRunners.set(runBeforeToolCall, () => {
    const recovery = retainAdmittedRunBeforeToolCallRecovery(attempt.admittedRunContext);
    if (!recovery) {
      return undefined;
    }
    const assertRecoveryActive = () => {
      if (
        attempt.abortSignal?.aborted ||
        attempt.admittedRunContext.operationalRunInstance !== operationalRunInstance ||
        (callerIdentity?.gatewayContextResolver !== undefined &&
          callerIdentity.gatewayContextResolver() === undefined)
      ) {
        throw new Error("agent harness retained host policy is no longer active");
      }
      recovery.assertActive();
    };
    return Object.freeze({
      assertActive: assertRecoveryActive,
      release: recovery.release,
      runBeforeToolCall: async (request) =>
        await runBeforeToolCallWithAssertion(assertRecoveryActive, request),
    });
  });

  const trajectoryRecorder = attempt.trajectoryRecorder;
  const scheduledToolSources = new WeakMap<
    AnyAgentTool,
    Readonly<{ targetTool: "exec" | "process"; execute: AnyAgentTool["execute"] }>
  >();
  const bindTools = (
    tools: AnyAgentTool[],
    options: Readonly<{ cwd?: string }> | undefined,
    observeResult: (result: unknown) => void,
  ) => {
    assertActive();
    const boundAbortSignal = attempt.abortSignal
      ? AbortSignal.any([attempt.abortSignal, capabilityAbortController.signal])
      : capabilityAbortController.signal;
    const bindingCwd =
      options?.cwd !== undefined
        ? normalizeNativeOperationCwd(options.cwd, hookContext.cwd)
        : undefined;
    const bindingHookContext = bindingCwd
      ? Object.freeze({ ...hookContext, cwd: bindingCwd })
      : hookContext;
    return tools
      .map((tool) => bindAgentToolSourceExecutionGuard(tool, assertActive))
      .map((tool) => rewrapToolWithBeforeToolCallHook(tool, bindingHookContext))
      .map((tool) =>
        callerIdentity ? wrapToolWithGatewayCallerIdentity(tool, callerIdentity) : tool,
      )
      .map((tool) => wrapToolWithAbortSignal(tool, boundAbortSignal))
      .map((tool) => gateBoundTool(tool, assertActive, observeResult));
  };
  const bindToolSurface: AgentHarnessHostCapabilities["bindToolSurface"] = (tools, options) =>
    bindTools(tools, options, () => {});
  const capabilities: AgentHarnessHostCapabilities = Object.freeze({
    kind: "agent-harness-host-capability" as const,
    version: 1 as const,
    assertActive,
    reportOutputTokens: (outputTokens) => {
      assertActive();
      const data = emitAgentRunOutputTokens({
        runId,
        lifecycleGeneration,
        sessionKey,
        outputTokens,
      });
      if (data && onAgentEvent) {
        runBestEffortCallback({
          label: "usage agent event",
          log,
          callback: () => onAgentEvent({ stream: "usage", data }),
        });
      }
    },
    ...(annotateCurrentUserTurn ? { annotateCurrentUserTurn } : {}),
    ...(trajectoryRecorder
      ? {
          trajectory: Object.freeze({
            recordEvent: (type: string, data?: Record<string, unknown>) => {
              assertActive();
              trajectoryRecorder.recordEvent(type, data);
            },
            flush: async () => {
              assertActive();
              await trajectoryRecorder.flush();
              assertActive();
            },
          }),
        }
      : {}),
    preparedEnvironment: () => {
      assertActive();
      return Object.freeze({
        credentialScrubEnv: Object.freeze({ ...preparedRunEnvironment.credentialScrubEnv }),
        localIdentityEnv: Object.freeze({ ...preparedRunEnvironment.localIdentityEnv }),
        managedLocalIdentity: preparedRunEnvironment.managedLocalIdentity,
        ...(localProcessEnv ? { localProcessEnv } : {}),
      });
    },
    bindToolSurface,
    createToolSurface: (options, bindingOptions) => {
      assertActive();
      // Only host-created core tools can seed TTS provenance. Plugin-bound tools
      // must not replay a retained core result into this attempt's authority set.
      const tools = bindTools(
        withInstallationTarget(installationTarget, () =>
          createOpenClawCodingTools({ ...options, operationalRunInstance }),
        ),
        bindingOptions,
        observeCoreTtsToolResult,
      );
      for (const tool of tools) {
        if (tool.name === "exec" || tool.name === "process") {
          scheduledToolSources.set(
            tool,
            Object.freeze({ targetTool: tool.name, execute: tool.execute }),
          );
        }
      }
      return tools;
    },
    prepareMutableFileApproval: async (request) => {
      assertActive();
      const prepared = await prepareSystemRunMutableFileApproval(request);
      assertActive();
      if (!prepared.ok) {
        return prepared;
      }
      return Object.freeze({
        ok: true,
        requiresOneShot: prepared.requiresOneShot,
        revalidate: async () => {
          assertActive();
          const current = await prepared.revalidate();
          assertActive();
          return current;
        },
      });
    },
    runBeforeToolCall,
    requestApproval: async (request) => {
      assertActive();
      request.signal?.throwIfAborted();
      const result = await withCaller(
        async () =>
          await withGatewayToolApprovalOwner(
            params.pluginId,
            async () =>
              await callGatewayTool(
                "plugin.approval.request",
                { timeoutMs: request.transportTimeoutMs ?? request.timeoutMs },
                {
                  title: request.title,
                  description: request.description,
                  severity: request.severity,
                  toolName: request.toolName,
                  toolCallId: request.toolCallId,
                  timeoutMs: request.timeoutMs,
                  twoPhase: true,
                  ...(request.allowedDecisions
                    ? { allowedDecisions: request.allowedDecisions }
                    : {}),
                },
                { expectFinal: false, requireAgentRuntimeIdentity: true, signal: request.signal },
              ),
          ),
        request.signal,
      );
      // Gateway approval calls may outlive their owning attempt. A late
      // request result must not escape after exact authority has closed.
      assertActive();
      request.signal?.throwIfAborted();
      return result;
    },
    waitForApproval: async (request) => {
      assertActive();
      const result = await withCaller(
        async () =>
          await callGatewayTool<{ id?: string } & Partial<AgentHarnessHostApprovalResult>>(
            "plugin.approval.waitDecision",
            { timeoutMs: request.transportTimeoutMs ?? request.timeoutMs },
            { id: request.approvalId },
            { signal: request.signal },
          ),
        request.signal,
      );
      // An allowed decision is useful only while this exact admitted owner is
      // still live; fail closed if closure raced the awaited Gateway result.
      assertActive();
      if (result?.id !== request.approvalId) {
        return undefined;
      }
      return {
        decision: result.decision,
        terminalReason: result.terminalReason,
      };
    },
  });
  registerAgentHarnessScheduledToolProjectionCapability({
    hostCapabilities: capabilities,
    ownerPluginId: params.pluginId,
    create: (sourceTool, projection) => {
      assertActive();
      const source = scheduledToolSources.get(sourceTool);
      if (
        !source ||
        sourceTool.name !== source.targetTool ||
        sourceTool.execute !== source.execute
      ) {
        throw new Error("scheduled tool projection source was not created by this host capability");
      }
      return createCronScheduledToolProjection(
        sourceTool,
        assertActive,
        source.targetTool,
        projection,
      );
    },
  });
  registerAgentHarnessTtsProvenanceTransferCapability({
    hostCapabilities: capabilities,
    ownerPluginId: params.pluginId,
    transfer: (toolResult, attemptResult, eligibleMediaUrls) => {
      assertActive();
      if (
        typeof toolResult !== "object" ||
        toolResult === null ||
        !coreTtsToolResults.has(toolResult)
      ) {
        return attemptResult;
      }
      return transferCoreTtsToolResultProvenance(
        toolResult,
        attemptResult,
        eligibleMediaUrls,
        operationalRunInstance,
      );
    },
  });
  return {
    capabilities,
    runWithScope: (run) =>
      withPluginRuntimeGatewayRequestScope(
        {
          isWebchatConnect: () => false,
          ...getPluginRuntimeGatewayRequestScope(),
          invokeWithSessionNodeAuthority: createSessionNodeInvocation(
            attempt,
            params.pluginId,
            requiredNodeCommands,
            assertActive,
            attempt.abortSignal
              ? AbortSignal.any([attempt.abortSignal, capabilityAbortController.signal])
              : capabilityAbortController.signal,
          ),
        },
        run,
      ),
    close: () => {
      if (!active) {
        return;
      }
      active = false;
      capabilityAbortController.abort();
    },
  };
}
