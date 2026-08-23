import { clampPositiveTimerTimeoutMs } from "@openclaw/normalization-core/number-coercion";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { resolveExecutablePath } from "../../infra/executable-path.js";
import type {
  CliBackendExecute,
  CliBackendToolPermissionRequest,
  CliBackendToolPermissionResult,
} from "../../plugins/cli-backend.types.js";
import type { RunExit, TerminationReason } from "../../process/supervisor/types.js";
import { resolveAdmittedRunActiveAssertion } from "../admitted-run-context.js";
import { resolveExecDefaults } from "../exec-defaults.js";
import {
  requestClaudeNativeToolApproval,
  resolveClaudeNativeToolApprovalPlan,
} from "./claude-live-tool-approval.js";
import { createCliAbortError } from "./execute-node-claude.js";
import { buildCliBackendToolAvailability } from "./tool-policy.js";
import type { PreparedCliRunContext } from "./types.js";

const PLUGIN_ITERATOR_CLOSE_TIMEOUT_MS = 5_000;

function denyTool(message: string): CliBackendToolPermissionResult {
  return { behavior: "deny", message };
}

function createPluginToolPermissionHandler(params: {
  context: PreparedCliRunContext;
  abortSignal: AbortSignal;
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

    const plan = resolveClaudeNativeToolApprovalPlan(permission);
    if (plan === "deny") {
      return denyTool(
        `OpenClaw exec policy denied native tool use (security=${permission.security}, ask=${permission.ask}).`,
      );
    }
    if (plan === "allow" || (permission.ask !== "always" && grants.has(toolName))) {
      assertActive();
      return { behavior: "allow", updatedInput: request.toolInput };
    }

    const outcome = await requestClaudeNativeToolApproval({
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
      grants.add(toolName);
    }
    return { behavior: "allow", updatedInput: request.toolInput };
  };
}

function waitForIteratorValue<T>(
  iterator: AsyncIterator<T>,
  signal: AbortSignal,
): Promise<IteratorResult<T>> {
  if (signal.aborted) {
    return Promise.reject(signal.reason);
  }
  return new Promise((resolve, reject) => {
    const rejectAborted = () => reject(signal.reason);
    signal.addEventListener("abort", rejectAborted, { once: true });
    void iterator.next().then(
      (value) => {
        signal.removeEventListener("abort", rejectAborted);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", rejectAborted);
        reject(error);
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
  sessionId?: string;
  noOutputTimeoutMs: number;
  consumeStdout: (chunk: string) => void;
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
  const resetNoOutputTimer = () => {
    clearTimeout(noOutputTimer);
    if (noOutputTimeoutMs === undefined) {
      return;
    }
    noOutputTimer = setTimeout(() => {
      termination.reason = "no-output-timeout";
      controller.abort(new Error("CLI plugin runtime produced no output before its watchdog."));
    }, noOutputTimeoutMs);
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
    iterator = params
      .execute({
        command,
        args: params.executionArgs,
        cwd,
        env: params.env,
        prompt: params.prompt,
        modelId: params.context.normalizedModel,
        systemPrompt: params.context.systemPrompt.trim(),
        ...(params.sessionId ? { sessionId: params.sessionId } : {}),
        useResume: params.useResume,
        abortSignal: signal,
        timeoutMs: run.timeoutMs,
        ...(run.executionMode ? { executionMode: run.executionMode } : {}),
        ...(run.cliToolAvailability
          ? { toolAvailability: buildCliBackendToolAvailability(run.cliToolAvailability) }
          : {}),
        requestToolPermission: createPluginToolPermissionHandler({
          context: params.context,
          abortSignal: signal,
        }),
      })
      [Symbol.asyncIterator]();

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
      params.consumeStdout(`${JSON.stringify(next.value)}\n`);
      resetNoOutputTimer();
    }

    if (!terminalResultSeen) {
      throw new Error("CLI plugin runtime completed without a terminal result.");
    }
  } catch (error) {
    if (run.abortSignal?.aborted || termination.reason === "manual-cancel") {
      throw createCliAbortError();
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
