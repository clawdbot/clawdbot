import { stripSystemPromptCacheBoundary } from "@openclaw/ai/internal/shared";
import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { toErrorObject } from "../../infra/errors.js";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import { BLOCKED_TOOL_CALL_ABORT_FLOOR_MS } from "../../logging/diagnostic-run-activity.js";
import type {
  CliBackendExecute,
  CliBackendToolPermissionRequest,
  CliBackendToolPermissionResult,
  CliBackendUserInputRequest,
  CliBackendUserInputResult,
} from "../../plugins/cli-backend.types.js";
import type { RunExit, TerminationReason } from "../../process/supervisor/types.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import type { CliTerminalInterruption } from "../cli-output-contracts.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import { isSignalTimeoutReason, type FailoverError } from "../failover-error.js";
import { runStructuredInput } from "../harness/structured-input-execution.js";
import { compileStructuredInputQuestions } from "../harness/structured-input.js";
import { callGatewayTool } from "../tools/gateway.js";
import {
  closeCliLiveSession,
  createCliLiveSessionCapability,
  getCliLiveSessionApprovalGrants,
} from "./cli-live-session-registry.js";
import {
  requestCliNativeToolApproval,
  resolveCliNativeToolApprovalPlan,
} from "./cli-native-tool-approval.js";
import { createCliAbortError } from "./execute-node-claude.js";
import { resolveCliNoOutputTimeoutDecision } from "./no-output-timeout-policy.js";
import type { PreparedCliRunContext } from "./types.js";

const PLUGIN_ITERATOR_CLOSE_TIMEOUT_MS = 5_000;

function denyTool(message: string): CliBackendToolPermissionResult {
  return { behavior: "deny", message };
}

function createPluginToolPermissionHandler(params: {
  context: PreparedCliRunContext;
  abortSignal: AbortSignal;
  onPendingApproval: (delta: 1 | -1) => void;
}): (request: CliBackendToolPermissionRequest) => Promise<CliBackendToolPermissionResult> {
  const run = params.context.params;
  const permission = resolveExecDefaults({
    cfg: run.config,
    sessionEntry: run.sessionEntry,
    execOverrides: run.execOverrides,
    agentId: run.agentId,
    sessionKey: run.runtimePolicySessionKey ?? run.sessionKey,
  });
  const grants = new Set<string>();

  return async (request) => {
    const signal = request.abortSignal
      ? AbortSignal.any([params.abortSignal, request.abortSignal])
      : params.abortSignal;
    const assertActive = resolveAdmittedRunActiveAssertion(run.admittedRunContext, signal);
    if (!assertActive) {
      return denyTool("OpenClaw denied native tool use: the admitted run is no longer active.");
    }
    try {
      assertActive();
    } catch {
      return denyTool("OpenClaw denied native tool use: the admitted run is no longer active.");
    }

    const toolName = request.toolName.trim();
    if (!toolName) {
      return denyTool("OpenClaw denied an unnamed native tool.");
    }
    if (run.cliToolAvailability && !run.cliToolAvailability.native.includes(toolName)) {
      return denyTool(`OpenClaw denied native tool ${toolName}: it is unavailable to this run.`);
    }

    const plan = resolveCliNativeToolApprovalPlan(permission);
    if (plan === "deny") {
      return denyTool(
        `OpenClaw exec policy denied native tool use (security=${permission.security}, ask=${permission.ask}).`,
      );
    }
    const currentGrants = getCliLiveSessionApprovalGrants(params.context) ?? grants;
    if (plan === "allow" || (permission.ask !== "always" && currentGrants.has(toolName))) {
      assertActive();
      return { behavior: "allow", updatedInput: request.toolInput };
    }

    params.onPendingApproval(1);
    let outcome: Awaited<ReturnType<typeof requestCliNativeToolApproval>>;
    try {
      outcome = await requestCliNativeToolApproval({
        toolName,
        toolInput: request.toolInput,
        pluginId: params.context.backendResolved.id,
        sessionKey: run.sessionKey,
        agentId: run.agentId,
        toolCallId: request.toolCallId,
        cwd: params.context.cwd ?? params.context.workspaceDir,
        abortSignal: signal,
        ask: permission.ask,
      });
    } finally {
      params.onPendingApproval(-1);
    }
    // Approval itself may outlive, replace, or close the exact admitted turn.
    // The host rechecks authority immediately before returning any capability.
    try {
      assertActive();
    } catch {
      return denyTool("OpenClaw denied native tool use: the admitted run closed during approval.");
    }
    if (outcome.kind !== "allow") {
      return denyTool(
        outcome.message ??
          (outcome.reason === "user"
            ? `OpenClaw user denied native tool use (${toolName}).`
            : `OpenClaw approval was not granted for native tool use (${toolName}).`),
      );
    }
    if (outcome.grantAlways) {
      currentGrants.add(toolName);
    }
    return { behavior: "allow", updatedInput: request.toolInput };
  };
}

function cancelUserInput(message: string): CliBackendUserInputResult {
  return { status: "cancelled", message };
}

function createPluginUserInputHandler(params: {
  context: PreparedCliRunContext;
  abortSignal: AbortSignal;
  onPendingInput: (delta: 1 | -1) => void;
}): (request: CliBackendUserInputRequest) => Promise<CliBackendUserInputResult> {
  const run = params.context.params;
  return async (request) => {
    const signal = request.abortSignal
      ? AbortSignal.any([params.abortSignal, request.abortSignal])
      : params.abortSignal;
    const assertActive = resolveAdmittedRunActiveAssertion(run.admittedRunContext, signal);
    if (!assertActive) {
      return cancelUserInput(
        "OpenClaw cancelled operator input: the admitted run is no longer active.",
      );
    }
    try {
      assertActive();
    } catch {
      return cancelUserInput(
        "OpenClaw cancelled operator input: the admitted run is no longer active.",
      );
    }

    const toolName = request.toolName.trim();
    if (
      !toolName ||
      (run.cliToolAvailability && !run.cliToolAvailability.native.includes(toolName))
    ) {
      return cancelUserInput(
        toolName
          ? `OpenClaw cancelled operator input from ${toolName}: it is unavailable to this run.`
          : "OpenClaw cancelled an unnamed operator input request.",
      );
    }
    if (request.questions.length === 0 || request.questions.length > 12) {
      return cancelUserInput("OpenClaw cancelled an invalid operator input request.");
    }

    params.onPendingInput(1);
    try {
      const result = await runStructuredInput({
        input: compileStructuredInputQuestions({
          questions: request.questions.map((question) => ({
            ...question,
            isSecret: false,
          })),
          intro: request.intro?.trim() || "Agent needs input:",
        }),
        sessionKey: run.sessionKey ?? run.sessionId,
        agentId: run.agentId,
        runId: run.runId,
        timeoutMs: run.timeoutMs,
        gatewayCall: callGatewayTool,
        delivery: {
          onBlockReply: run.onBlockReply,
          onPartialReply: run.onPartialReply,
        },
        signal,
        isActive: () => {
          try {
            assertActive();
            return true;
          } catch {
            return false;
          }
        },
        questionId: request.toolCallId ? (batch) => `${request.toolCallId}:${batch}` : undefined,
      });
      try {
        assertActive();
      } catch {
        return cancelUserInput(
          "OpenClaw cancelled operator input: the admitted run closed before the answer was committed.",
        );
      }
      return result.status === "answered"
        ? { status: "answered", answers: result.answers }
        : cancelUserInput(
            result.message ??
              "OpenClaw cancelled operator input; continue with your best judgment.",
          );
    } catch {
      return cancelUserInput(
        "OpenClaw could not collect operator input; continue with your best judgment.",
      );
    } finally {
      params.onPendingInput(-1);
    }
  };
}

function waitForIteratorValue<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) {
    return Promise.reject(toErrorObject(signal.reason, "CLI plugin execution was aborted."));
  }
  return new Promise((resolve, reject) => {
    const rejectAborted = () =>
      reject(toErrorObject(signal.reason, "CLI plugin execution was aborted."));
    signal.addEventListener("abort", rejectAborted, { once: true });
    void iterator.next().then(
      (value) => {
        signal.removeEventListener("abort", rejectAborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", rejectAborted);
        reject(toErrorObject(error, "CLI plugin execution stream failed."));
      },
    );
  });
}

async function closePluginIterator(
  iterator: AsyncIterator<Record<string, unknown>> | undefined,
): Promise<void> {
  if (!iterator?.return) {
    return;
  }
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      iterator.return(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error("CLI plugin runtime did not close after its run ended.")),
          PLUGIN_ITERATOR_CLOSE_TIMEOUT_MS,
        );
        timeout.unref();
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

/** Runs a prepared plugin transport while keeping cancellation and approvals host-owned. */
export async function executePluginOwnedProcess(params: {
  context: PreparedCliRunContext;
  execute: CliBackendExecute;
  executionCommand: string;
  executionArgs: readonly string[];
  env: Record<string, string>;
  prompt: string;
  useResume: boolean;
  forceNewSession?: boolean;
  sessionId?: string;
  noOutputTimeoutMs: number;
  consumeStdout: (chunk: string) => void;
  activeToolCount?: () => number;
  onNoOutputTimeout?: (error: FailoverError) => void;
  onInterrupted?: (reason: CliTerminalInterruption["reason"]) => boolean;
  liveSession?: {
    captureKey?: string;
    beginCapture: (captureKey: string | undefined) => void;
    requiredGeneration?: string;
  };
}): Promise<RunExit> {
  const run = params.context.params;
  const cwd = params.context.cwd ?? params.context.workspaceDir;
  const command = resolveExecutablePath(params.executionCommand, { cwd, env: params.env });
  if (!command) {
    throw new Error(`CLI backend executable could not be resolved: ${params.executionCommand}`);
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const signal = run.abortSignal
    ? AbortSignal.any([controller.signal, run.abortSignal])
    : controller.signal;
  const termination: { reason: TerminationReason } = { reason: "exit" };
  const outstanding = {
    approvals: 0,
    background: 0,
    lastOutputAt: startedAt,
    observed: false,
    replayUnsafe: false,
  };
  let noOutputTimer: ReturnType<typeof setTimeout> | undefined;
  const overallTimeoutMs = clampPositiveTimerTimeoutMs(run.timeoutMs);
  const noOutputTimeoutMs = clampPositiveTimerTimeoutMs(params.noOutputTimeoutMs);
  const overallTimer =
    overallTimeoutMs === undefined
      ? undefined
      : setTimeout(() => {
          termination.reason = "overall-timeout";
          controller.abort(new Error("CLI plugin runtime exceeded its execution timeout."));
        }, overallTimeoutMs);
  const resetNoOutputTimer = (delayMs = noOutputTimeoutMs) => {
    clearTimeout(noOutputTimer);
    if (delayMs === undefined || noOutputTimeoutMs === undefined) {
      return;
    }
    noOutputTimer = setTimeout(() => {
      const quietDurationMs = Date.now() - outstanding.lastOutputAt;
      const decision = resolveCliNoOutputTimeoutDecision({
        context: {
          provider: run.provider,
          model: params.context.modelId,
          sessionId: run.sessionId,
          lane: run.lane,
        },
        timeoutMs: noOutputTimeoutMs,
        quietDurationMs,
        cliTimeout: {
          mode: "no-output",
          timeoutSeconds: Math.round(quietDurationMs / 1000),
          observedActivity: outstanding.observed,
          activeToolCount: Math.max(params.activeToolCount?.() ?? 0, outstanding.approvals),
          backgroundTaskCount: outstanding.background,
        },
        hasOutputText: false,
        useResume: params.useResume,
        hasReplayUnsafeActivity: outstanding.replayUnsafe,
        allowResumeControlOnlyRetry: true,
        outstandingWorkGraceMs: BLOCKED_TOOL_CALL_ABORT_FLOOR_MS,
      });
      if (decision.deferMs !== undefined) {
        resetNoOutputTimer(decision.deferMs);
        return;
      }
      termination.reason = "no-output-timeout";
      params.onNoOutputTimeout?.(decision.error);
      controller.abort(decision.error);
    }, delayMs);
  };

  const replyBackendHandle = run.replyOperation
    ? {
        kind: "cli" as const,
        runId: run.runId,
        toolAuthorityFingerprint: run.toolAuthorityFingerprint,
        cancel: () => {
          termination.reason = "manual-cancel";
          controller.abort(createCliAbortError());
        },
      }
    : undefined;
  if (replyBackendHandle) {
    run.replyOperation?.attachBackend(replyBackendHandle);
  }

  let iterator: AsyncIterator<Record<string, unknown>> | undefined;
  let terminalResultSeen = false;
  let terminalErrorSeen = false;
  try {
    resetNoOutputTimer();
    if (
      params.liveSession &&
      (params.forceNewSession ||
        (Boolean(params.context.preparedBackend.backend.resumeArgs?.length) && !params.useResume))
    ) {
      if (params.liveSession.requiredGeneration) {
        throw new Error("The required CLI live session cannot be replaced by a fresh process.");
      }
      await closeCliLiveSession(params.context, "restart");
      const assertActive = resolveAdmittedRunActiveAssertion(run.admittedRunContext, signal);
      if (!assertActive) {
        throw new Error("CLI live session turn closed while restarting its process.");
      }
      assertActive();
    }
    const execution = params.execute({
      command,
      args: params.executionArgs,
      cwd,
      env: params.env,
      prompt: params.prompt,
      modelId: params.context.normalizedModel,
      systemPrompt: stripSystemPromptCacheBoundary(params.context.systemPrompt).trim(),
      ...(params.sessionId ? { sessionId: params.sessionId } : {}),
      useResume: params.useResume,
      abortSignal: signal,
      timeoutMs: run.timeoutMs,
      ...(run.executionMode ? { executionMode: run.executionMode } : {}),
      ...(run.cliToolAvailability ? { toolAvailability: run.cliToolAvailability } : {}),
      ...(params.liveSession
        ? {
            liveSession: createCliLiveSessionCapability({
              context: params.context,
              argv: [command, ...params.executionArgs],
              env: params.env,
              captureKey: params.liveSession.captureKey,
              beginCapture: params.liveSession.beginCapture,
              abortSignal: signal,
              requiredGeneration: params.liveSession.requiredGeneration,
              claimResources: params.context.preparedBackend.claimLiveSessionResources,
            }),
          }
        : {}),
      requestToolPermission: createPluginToolPermissionHandler({
        context: params.context,
        abortSignal: signal,
        onPendingApproval: (delta) => {
          outstanding.approvals = Math.max(0, outstanding.approvals + delta);
        },
      }),
      requestUserInput: createPluginUserInputHandler({
        context: params.context,
        abortSignal: signal,
        onPendingInput: (delta) => {
          outstanding.approvals = Math.max(0, outstanding.approvals + delta);
        },
      }),
    });
    iterator = execution[Symbol.asyncIterator]();

    for (;;) {
      const next = await waitForIteratorValue(iterator, signal);
      if (next.done) {
        break;
      }
      if (!isRecord(next.value)) {
        throw new Error("CLI plugin runtime emitted an invalid structured stream event.");
      }
      if (next.value.type === "result") {
        terminalResultSeen = true;
        terminalErrorSeen ||=
          next.value.is_error === true ||
          (typeof next.value.subtype === "string" && next.value.subtype.startsWith("error_"));
      }
      if (
        next.value.type === "system" &&
        next.value.subtype === "background_tasks_changed" &&
        Array.isArray(next.value.tasks)
      ) {
        outstanding.background = next.value.tasks.filter(isRecord).length;
      }
      params.consumeStdout(`${JSON.stringify(next.value)}\n`);
      outstanding.observed = true;
      if (
        !(next.value.type === "system" && next.value.subtype === "init") &&
        next.value.type !== "command_lifecycle"
      ) {
        outstanding.replayUnsafe = true;
      }
      outstanding.lastOutputAt = Date.now();
      resetNoOutputTimer();
    }

    if (!terminalResultSeen) {
      throw new Error("CLI plugin runtime completed without a terminal result.");
    }
  } catch (error) {
    if (run.abortSignal?.aborted || termination.reason === "manual-cancel") {
      const reason = isSignalTimeoutReason(run.abortSignal?.reason) ? "timeout" : "aborted";
      if (!params.onInterrupted?.(reason)) {
        throw createCliAbortError();
      }
      termination.reason = "manual-cancel";
    }
    // SDKs can throw after emitting an authoritative failed terminal record.
    // Preserve that record so the existing parser owns auth/rate-limit failover.
    if (termination.reason === "exit" && !terminalErrorSeen) {
      throw error;
    }
  } finally {
    clearTimeout(overallTimer);
    clearTimeout(noOutputTimer);
    // Permission callbacks can be retained by the plugin or its subprocess.
    // Closing the turn fences those capabilities before any outer cleanup runs.
    if (!controller.signal.aborted) {
      controller.abort(new Error("CLI plugin runtime turn is no longer active."));
    }
    if (replyBackendHandle) {
      run.replyOperation?.detachBackend(replyBackendHandle);
    }
    await closePluginIterator(iterator);
  }

  return {
    reason: termination.reason,
    exitCode: termination.reason === "exit" ? 0 : null,
    exitSignal: null,
    durationMs: Date.now() - startedAt,
    stdout: "",
    stderr: "",
    timedOut:
      termination.reason === "overall-timeout" || termination.reason === "no-output-timeout",
    noOutputTimedOut: termination.reason === "no-output-timeout",
  };
}
