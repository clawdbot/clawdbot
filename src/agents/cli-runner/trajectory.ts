/** Owns one durable trajectory across CLI recovery and final settlement. */
import { isAbortError } from "../../infra/abort-signal.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { buildTrajectoryRunMetadata } from "../../trajectory/metadata.js";
import { createTrajectoryRuntimeRecorder } from "../../trajectory/runtime.js";
import type { CliOutput } from "../cli-output-contracts.js";
import type { EmbeddedAgentRunResult } from "../embedded-agent-runner.js";
import { isFailoverError, isSignalTimeoutReason } from "../failover-error.js";
import { runAgentCleanupStep } from "../run-cleanup-timeout.js";
import { settlePreparedCliRun } from "./cli-run-settlement.js";
import { cliBackendLog } from "./log.js";
import type { ClaudeCliRunDiagnosticLifecycle } from "./run-diagnostics.js";
import type { PreparedCliRunContext } from "./types.js";

export type CliTrajectoryRecorder = ReturnType<typeof createTrajectoryRuntimeRecorder>;

export function recordCliTrajectoryEvent(
  recorder: CliTrajectoryRecorder,
  type: string,
  data?: Record<string, unknown>,
): void {
  try {
    recorder?.recordEvent(type, data);
  } catch (error) {
    cliBackendLog.warn(
      `cli trajectory event failed: type=${type} error=${formatErrorMessage(error)}`,
    );
  }
}

export function recordCliModelCompleted(recorder: CliTrajectoryRecorder, output: CliOutput): void {
  recordCliTrajectoryEvent(recorder, "model.completed", {
    assistantTexts: output.text ? [output.text] : [],
    usage: output.usage,
    finalPromptText: output.finalPromptText,
    stopReason: output.terminalInterruption?.reason ?? (output.yielded ? "end_turn" : "completed"),
  });
}

function prepareCliTrajectory(context: PreparedCliRunContext): CliTrajectoryRecorder {
  // Preparation removes borrowed durable identity from caller-owned helper sessions.
  const { params } = context;
  const recorder =
    params.isolatedCompletion || params.controlOperation || params.sessionManager
      ? null
      : createTrajectoryRuntimeRecorder({
          cfg: params.config,
          runId: params.runId,
          sessionId: params.sessionId,
          sessionKey: params.sessionKey,
          sessionFile: params.sessionFile,
          sessionTarget: params.sessionTarget,
          provider: params.provider,
          modelId: context.modelId,
          workspaceDir: context.workspaceDir,
        });
  if (!recorder) {
    return null;
  }
  recordCliTrajectoryEvent(recorder, "session.started", {
    trigger: params.trigger,
    sessionFile: params.sessionFile,
    workspaceDir: context.workspaceDir,
    agentId: params.agentId,
    messageProvider: params.messageProvider,
    messageChannel: params.messageChannel,
  });
  recordCliTrajectoryEvent(
    recorder,
    "trace.metadata",
    buildTrajectoryRunMetadata({
      config: params.config,
      workspaceDir: context.workspaceDir,
      sessionFile: params.sessionFile,
      sessionKey: params.sessionKey,
      agentId: params.agentId,
      trigger: params.trigger,
      messageProvider: params.messageProvider,
      messageChannel: params.messageChannel,
      provider: params.provider,
      modelId: context.modelId,
      timeoutMs: params.timeoutMs,
      thinkLevel: params.thinkLevel,
      skillsSnapshot: params.skillsSnapshot,
      systemPromptReport: context.systemPromptReport,
    }),
  );
  return recorder;
}

async function withCliRunTrajectory(
  context: PreparedCliRunContext,
  run: (recorder: CliTrajectoryRecorder) => Promise<EmbeddedAgentRunResult>,
): Promise<EmbeddedAgentRunResult> {
  const { params } = context;
  let recorder: CliTrajectoryRecorder = null;
  try {
    recorder = prepareCliTrajectory(context);
  } catch (error) {
    // Observability setup must not prevent the prepared backend from reaching cleanup.
    cliBackendLog.warn(`cli trajectory setup failed: ${formatErrorMessage(error)}`);
  }
  if (!recorder) {
    return await run(null);
  }
  let result: EmbeddedAgentRunResult | undefined;
  let failed = false;
  let runError: unknown;
  try {
    result = await run(recorder);
    return result;
  } catch (error) {
    failed = true;
    runError = error;
    throw error;
  } finally {
    const stopReason = result?.meta.completion?.stopReason ?? result?.meta.stopReason;
    const timedOut =
      stopReason === "timeout" ||
      (isFailoverError(runError) && runError.reason === "timeout") ||
      (failed &&
        params.abortSignal?.aborted === true &&
        isSignalTimeoutReason(params.abortSignal.reason));
    const aborted = result?.meta.aborted === true || isAbortError(runError);
    const terminalAttempt = result?.meta.executionTrace?.attempts?.at(-1);
    const status =
      timedOut || aborted
        ? "interrupted"
        : failed || result?.meta.error || terminalAttempt?.result === "error"
          ? "error"
          : "success";
    recordCliTrajectoryEvent(recorder, "session.ended", {
      status,
      aborted,
      timedOut,
      stopReason,
      promptError: failed ? formatErrorMessage(runError) : undefined,
      terminalError:
        result?.meta.error?.message ?? (status === "error" ? terminalAttempt?.reason : undefined),
    });
    await runAgentCleanupStep({
      runId: params.runId,
      sessionId: params.sessionId,
      step: "openclaw-trajectory-flush",
      log: cliBackendLog,
      getTimeoutDetails: () => recorder.describeFlushState(),
      cleanup: () => recorder.flush(),
    });
  }
}

export async function settlePreparedCliRunWithTrajectory(
  context: PreparedCliRunContext,
  diagnosticLifecycle?: ClaudeCliRunDiagnosticLifecycle,
): Promise<EmbeddedAgentRunResult> {
  const { runPreparedCliAgent } = await import("../cli-runner.js");
  return await withCliRunTrajectory(context, (trajectoryRecorder) =>
    settlePreparedCliRun({
      context,
      diagnosticLifecycle,
      run: async () => await runPreparedCliAgent(context, diagnosticLifecycle, trajectoryRecorder),
    }),
  );
}
