import path from "node:path";
import { getActiveDiagnosticTraceContext } from "../../infra/diagnostic-trace-context.js";
import { buildAgentHookContextChannelFields } from "../../plugins/hook-agent-context.js";
import { copyAgentToolMetadata } from "../agent-tool-metadata.js";
import {
  rewrapToolWithBeforeToolCallHook,
  runBeforeToolCallHook,
} from "../agent-tools.before-tool-call.js";
import type { EmbeddedRunAttemptParams } from "../embedded-agent-runner/run/types.js";
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
  if (!tool.execute) {
    return tool;
  }
  const execute = tool.execute;
  const gated: AnyAgentTool = {
    ...tool,
    execute: async (...args) => {
      assertActive();
      return await execute(...args);
    },
  };
  return copyAgentToolMetadata(tool, gated);
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
  let active = true;
  const assertActive = () => {
    if (!active || attempt.admittedRunContext.operationalRunInstance !== operationalRunInstance) {
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

  const capabilities: AgentHarnessHostCapabilities = Object.freeze({
    kind: "agent-harness-host-capability" as const,
    version: 1 as const,
    bindToolSurface: (tools) => {
      assertActive();
      return tools
        .map((tool) => rewrapToolWithBeforeToolCallHook(tool, hookContext))
        .map((tool) =>
          callerIdentity ? wrapToolWithGatewayCallerIdentity(tool, callerIdentity) : tool,
        )
        .map((tool) => gateBoundTool(tool, assertActive));
    },
    runBeforeToolCall: async ({ nativeOperation, ...request }) => {
      assertActive();
      const actionCwd =
        nativeOperation?.cwd !== undefined
          ? normalizeNativeOperationCwd(nativeOperation.cwd, hookContext.cwd)
          : undefined;
      // Native action location can vary within one attempt. Only cwd is derived;
      // all authority and identity fields remain fixed to the admitted host snapshot.
      const actionHookContext = actionCwd
        ? Object.freeze({ ...hookContext, cwd: actionCwd })
        : hookContext;
      return await withCaller(
        async () =>
          await runBeforeToolCallHook({
            ...request,
            approvalMode: "request",
            ctx: actionHookContext,
          }),
      );
    },
    requestApproval: async (request) => {
      assertActive();
      return await withCaller(
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
      return result?.id === request.approvalId
        ? (result.decision as "allow-once" | "allow-always" | "deny" | null | undefined)
        : undefined;
    },
  });
  return {
    capabilities,
    close: () => {
      active = false;
    },
  };
}
