import path from "node:path";
import { getActiveDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { prepareSystemRunMutableFileApproval } from "../../infra/system-run-approval-binding.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { getActiveSecretsRuntimeConfigSnapshot } from "../../secrets/runtime-state.js";
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
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
import { prepareGitHubToolEnvironment } from "../github-tool-identity.js";
import {
  attachInternalToolExecutionPreparer,
  getInternalToolExecutionPreparer,
} from "../runtime/internal-hooks.js";
import { resolveToolLoopDetectionConfig } from "../tool-loop-detection-config.js";
import type { AnyAgentTool } from "../tools/common.js";
import {
  createAdmittedGatewayToolCallerIdentity,
  withGatewayToolApprovalOwner,
  withGatewayToolCallerIdentity,
  wrapToolWithGatewayCallerIdentity,
} from "../tools/gateway-caller-context.js";
import { callGatewayTool } from "../tools/gateway.js";
import type { AgentHarnessHostCapabilities } from "./host-capability-types.js";

type AgentHarnessHostAttempt = Partial<EmbeddedRunAttemptParams> &
  Pick<EmbeddedRunAttemptParams, "admittedRunContext" | "runId">;

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

function gateBoundTool(tool: AnyAgentTool, assertActive: () => void): AnyAgentTool {
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
            assertActive();
            const result = await execute(...args);
            assertActive();
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
        return prepared;
      }
      return {
        ...prepared,
        execute: async (onImplementationStart) => {
          assertActive();
          const result = await prepared.execute(onImplementationStart);
          assertActive();
          return result;
        },
      };
    });
  }
  return gated;
}

function createBoundCallerIdentity(params: AgentHarnessHostAttempt) {
  return createAdmittedGatewayToolCallerIdentity({
    admittedRunContext: params.admittedRunContext,
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
}): { capabilities: AgentHarnessHostCapabilities; close: () => void } {
  const attempt = params.attempt;
  const operationalRunInstance = attempt.admittedRunContext.operationalRunInstance;
  const delegatedAuthority = getAdmittedRunDelegatedAuthority(attempt.admittedRunContext);
  if (!delegatedAuthority) {
    throw new Error("agent harness host capability requires active admitted run authority");
  }
  let active = true;
  // Lexical closure must also fence work already past its entry guard. The
  // result guards below cover exact authority loss that does not use close().
  const capabilityAbortController = new AbortController();
  const assertActive = () => {
    if (
      !active ||
      attempt.admittedRunContext.operationalRunInstance !== operationalRunInstance ||
      getAdmittedRunDelegatedAuthority(attempt.admittedRunContext) !== delegatedAuthority
    ) {
      throw new Error("agent harness host capability is no longer active");
    }
  };
  const callerIdentity = createBoundCallerIdentity(attempt);
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
  const withCaller = async <T>(run: () => Promise<T>): Promise<T> =>
    await withGatewayToolCallerIdentity(callerIdentity, run);
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
    await withCaller(async () => await runBeforeToolCallWithAssertion(assertActive, request));
  retainedBeforeToolCallRunners.set(runBeforeToolCall, () => {
    const recovery = retainAdmittedRunBeforeToolCallRecovery(attempt.admittedRunContext);
    if (!recovery) {
      return undefined;
    }
    const assertRecoveryActive = () => {
      if (
        attempt.abortSignal?.aborted ||
        attempt.admittedRunContext.operationalRunInstance !== operationalRunInstance
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

  const capabilities: AgentHarnessHostCapabilities = Object.freeze({
    kind: "agent-harness-host-capability" as const,
    version: 1 as const,
    assertActive,
    preparedEnvironment: () => {
      assertActive();
      return Object.freeze({
        credentialScrubEnv: Object.freeze({ ...preparedRunEnvironment.credentialScrubEnv }),
        localIdentityEnv: Object.freeze({ ...preparedRunEnvironment.localIdentityEnv }),
        managedLocalIdentity: preparedRunEnvironment.managedLocalIdentity,
      });
    },
    bindToolSurface: (tools, options) => {
      assertActive();
      const boundAbortSignal = attempt.abortSignal
        ? AbortSignal.any([attempt.abortSignal, capabilityAbortController.signal])
        : capabilityAbortController.signal;
      const bindingCwd =
        options?.cwd !== undefined
          ? normalizeNativeOperationCwd(options.cwd, hookContext.cwd)
          : undefined;
      // Native harnesses may execute a bound surface from a narrower cwd than
      // the agent workspace. Hooks must authorize the same absolute path.
      const bindingHookContext = bindingCwd
        ? Object.freeze({ ...hookContext, cwd: bindingCwd })
        : hookContext;
      return (
        tools
          .map((tool) => bindAgentToolSourceExecutionGuard(tool, assertActive))
          .map((tool) => rewrapToolWithBeforeToolCallHook(tool, bindingHookContext))
          .map((tool) =>
            callerIdentity ? wrapToolWithGatewayCallerIdentity(tool, callerIdentity) : tool,
          )
          // Rewrapping intentionally restores the original source tool. Restore
          // the run abort race around the rebound surface for plugin harnesses.
          .map((tool) => wrapToolWithAbortSignal(tool, boundAbortSignal))
          .map((tool) => gateBoundTool(tool, assertActive))
      );
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
                { expectFinal: false, requireAgentRuntimeIdentity: true },
              ),
          ),
      );
      // Gateway approval calls may outlive their owning attempt. A late
      // request result must not escape after exact authority has closed.
      assertActive();
      return result;
    },
    waitForApproval: async (request) => {
      assertActive();
      const result = await withCaller(
        async () =>
          await callGatewayTool<{ id?: string; decision?: string | null }>(
            "plugin.approval.waitDecision",
            { timeoutMs: request.transportTimeoutMs ?? request.timeoutMs },
            { id: request.approvalId },
            { signal: request.signal },
          ),
      );
      // An allowed decision is useful only while this exact admitted owner is
      // still live; fail closed if closure raced the awaited Gateway result.
      assertActive();
      return result?.id === request.approvalId
        ? (result.decision as "allow-once" | "allow-always" | "deny" | null | undefined)
        : undefined;
    },
  });
  return {
    capabilities,
    close: () => {
      if (!active) {
        return;
      }
      active = false;
      capabilityAbortController.abort();
    },
  };
}
