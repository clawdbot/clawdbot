import crypto from "node:crypto";
import { shouldLogVerbose } from "../../globals.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../../infra/event-session-routing.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import type { RunExit } from "../../process/supervisor/types.js";
import type { CliOutput, CliTerminalInterruption } from "../cli-output-contracts.js";
import { createCliJsonlStreamingParser } from "../cli-output-stream.js";
import { parseCliOutput } from "../cli-output.js";
import type { FailoverError } from "../failover-error.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import type { CliExecuteDeps } from "./execute-deps.js";
import type { CliEventHandlers } from "./execute-events.js";
import { createCliAbortError, executeNodeClaudeRun } from "./execute-node-claude.js";
import { appendCliOutputTail } from "./execute-output-buffer.js";
import { executePluginOwnedProcess } from "./execute-plugin.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import {
  createCliExitFailoverError,
  createCliFailoverError,
  resolveCliResumeAtError,
} from "./exit-error.js";
import { buildCliSupervisorScopeKey } from "./helpers.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./log.js";
import type { createClaudeCliModelCallDiagnostics } from "./model-call-diagnostics.js";
import {
  createCliTimeoutError,
  resolveCliNoOutputTimeoutDecision,
} from "./no-output-timeout-policy.js";
import { createCliOutputFailoverError } from "./output-error.js";
import type { NodeClaudePlacement, PreparedCliRunContext } from "./types.js";

const CLI_RUNNER_OUTPUT_PARSE_BYTES = 1024 * 1024;

function appendCliOutputParseBuffer(buffer: Buffer, chunk: string) {
  if (!chunk) {
    return { buffer, exceeded: false };
  }
  const chunkBuffer = Buffer.from(chunk);
  if (buffer.byteLength + chunkBuffer.byteLength <= CLI_RUNNER_OUTPUT_PARSE_BYTES) {
    return {
      buffer: Buffer.concat([buffer, chunkBuffer], buffer.byteLength + chunkBuffer.byteLength),
      exceeded: false,
    };
  }
  const remainingBytes = CLI_RUNNER_OUTPUT_PARSE_BYTES - buffer.byteLength;
  return {
    buffer:
      remainingBytes <= 0
        ? buffer
        : Buffer.concat(
            [buffer, chunkBuffer.subarray(0, remainingBytes)],
            CLI_RUNNER_OUTPUT_PARSE_BYTES,
          ),
    exceeded: true,
  };
}

type ExecuteCliProcessOptions = {
  onPhase?: (phase: "send" | "resolve" | "cleanup") => void;
};

export async function executeCliProcess(params: {
  context: PreparedCliRunContext;
  assertCurrent: () => void;
  backend: CliBackendConfig;
  deps: CliExecuteDeps;
  events: CliEventHandlers;
  toolTracking: CliToolTracking;
  diagnostics: ReturnType<typeof createClaudeCliModelCallDiagnostics>;
  nodePlacement: NodeClaudePlacement | null;
  nodeSystemPrompt?: string;
  nodeEnv?: Record<string, string>;
  nodeClearEnv?: string[];
  useManagedClaudeLiveSession: boolean;
  initialGatewayCaptureKey?: string;
  useResume: boolean;
  cliSessionIdToUse?: string;
  resolvedSessionId?: string;
  executionCommand: string;
  executionArgv0?: string;
  executionLeadingArgv: readonly string[];
  executionArgs: string[];
  env: Record<string, string>;
  prompt: string;
  promptContext?: PreparedCliRunContext["promptContext"];
  argsPrompt?: string;
  stdin?: string;
  noOutputTimeoutMs: number;
  outputMode: CliBackendConfig["output"];
  logOutputText: boolean;
  cliTurnStartedAt: number;
  observeForkSuccessor: (sessionId: string) => void;
  options?: ExecuteCliProcessOptions;
}): Promise<CliOutput> {
  const context = params.context;
  const runParams = context.params;
  const failoverContext = {
    provider: runParams.provider,
    model: context.modelId,
    sessionId: runParams.sessionId,
    lane: runParams.lane,
  };
  const outputErrorContext = { ...failoverContext, runId: runParams.runId };
  // buildCliArgs emits this option only for an actual checkpointed resume.
  const resumeAtArg =
    params.useResume && runParams.cliSessionResumeAt ? params.backend.resumeAtArg : undefined;
  const hasJsonlOutput = params.outputMode === "jsonl";

  const streamingParser = hasJsonlOutput
    ? createCliJsonlStreamingParser({
        backend: params.backend,
        providerId: context.backendResolved.id,
        parseJsonlEvent: context.backendResolved.parseJsonlEvent,
        parseJsonlLifecycleEvent: context.backendResolved.parseJsonlLifecycleEvent,
        onAssistantDelta: params.events.emitCliAssistantDelta,
        onThinkingDelta: params.events.emitCliThinkingDelta,
        onThinkingProgress: params.events.emitCliThinkingProgress,
        onCompaction: params.events.emitCliCompaction,
        onToolUseStart: params.events.emitParsedToolUseStart,
        onToolResult: params.events.emitParsedToolResult,
        onDisplayToolUseStart: params.events.emitCliDisplayToolUseStart,
        onDisplayToolResult: params.events.emitCliDisplayToolResult,
        onCommentaryText:
          params.events.emitLiveEvents && runParams.emitCommentaryText
            ? params.events.emitCliCommentaryText
            : undefined,
        onSessionId: params.observeForkSuccessor,
        onAssistantMessage: params.diagnostics?.observeAssistantMessage,
        onUsage: params.diagnostics?.observeUsage,
      })
    : null;
  let stdoutTail = "";
  let stdoutParseBuffer: Buffer = Buffer.alloc(0);
  let stdoutBytes = 0;
  const stdoutHash = crypto.createHash("sha256");
  let stdoutParseExceeded = false;
  let stderrTail = "";
  let stderrParseBuffer: Buffer = Buffer.alloc(0);
  let stderrBytes = 0;
  const stderrHash = crypto.createHash("sha256");
  let stderrParseExceeded = false;
  const consumeStdout = (chunk: string) => {
    const chunkBytes = Buffer.byteLength(chunk);
    params.diagnostics?.observeCliOutput(chunk, "stdout", chunkBytes);
    stdoutBytes += chunkBytes;
    stdoutHash.update(chunk);
    stdoutTail = appendCliOutputTail(stdoutTail, chunk);
    if (!stdoutParseExceeded) {
      const next = appendCliOutputParseBuffer(stdoutParseBuffer, chunk);
      stdoutParseBuffer = next.buffer;
      stdoutParseExceeded = next.exceeded;
    }
    streamingParser?.push(chunk);
  };
  const consumeStderr = (chunk: string) => {
    params.diagnostics?.observeCliOutput(chunk, "stderr");
    stderrBytes += Buffer.byteLength(chunk);
    stderrHash.update(chunk);
    stderrTail = appendCliOutputTail(stderrTail, chunk);
    if (!stderrParseExceeded) {
      const next = appendCliOutputParseBuffer(stderrParseBuffer, chunk);
      stderrParseBuffer = next.buffer;
      stderrParseExceeded = next.exceeded;
    }
  };

  runParams.onExecutionPhase?.({
    phase: "process_spawned",
    provider: runParams.provider,
    model: context.modelId,
    backend: context.backendResolved.id,
  });
  let managedRunPid: number | undefined;
  let nodeRunAbortSignal: AbortSignal | undefined;
  let nodeRunTruncated = false;
  const pluginTimeout: { error?: FailoverError } = {};
  let terminalInterruption: CliTerminalInterruption | undefined;
  let result: RunExit;
  runParams.assertCurrent?.();
  params.diagnostics?.observeRequestPayload(params.stdin ?? params.argsPrompt ?? "");
  params.assertCurrent();
  if (params.nodePlacement) {
    const nodeRun = await executeNodeClaudeRun({
      context,
      nodePlacement: params.nodePlacement,
      executionArgs: params.executionArgs,
      stdinPayload: params.stdin ?? "",
      ...(params.nodeSystemPrompt !== undefined
        ? { nodeSystemPrompt: params.nodeSystemPrompt }
        : {}),
      ...(params.nodeEnv ? { nodeEnv: params.nodeEnv } : {}),
      ...(params.nodeClearEnv ? { nodeClearEnv: params.nodeClearEnv } : {}),
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      consumeStdout,
      consumeStderr,
      deps: params.deps,
    });
    result = nodeRun.result;
    nodeRunAbortSignal = nodeRun.nodeRunAbortSignal;
    nodeRunTruncated = nodeRun.nodeRunTruncated;
  } else if (context.executionTarget.kind === "plugin") {
    result = await executePluginOwnedProcess({
      context,
      execute: context.executionTarget.execute,
      executionCommand: params.executionCommand,
      executionArgs: params.executionArgs,
      env: params.env,
      prompt: params.prompt,
      ...(params.promptContext ? { promptContext: params.promptContext } : {}),
      useResume: params.useResume,
      forceNewSession:
        params.cliSessionIdToUse === undefined && context.openClawHistoryPrompt !== undefined,
      sessionId: params.resolvedSessionId,
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      consumeStdout,
      activeToolCount: params.events.activeParsedToolCount,
      onNoOutputTimeout: (error) => {
        pluginTimeout.error = error;
      },
      onInterrupted: (reason) => {
        streamingParser?.finish();
        const partialOutput = streamingParser?.getOutput();
        if (
          !partialOutput?.text.trim() ||
          partialOutput.errorText ||
          partialOutput.terminalFailure
        ) {
          return false;
        }
        terminalInterruption = { reason };
        return true;
      },
      ...(params.useManagedClaudeLiveSession
        ? {
            liveSession: {
              captureKey: params.initialGatewayCaptureKey,
              beginCapture: params.toolTracking.beginGatewayCapture,
              requiredGeneration: params.cliSessionIdToUse
                ? context.requiredClaudeLiveSessionGeneration
                : undefined,
            },
          }
        : {}),
    }).catch((error: unknown) => {
      runParams.assertCurrent?.();
      if (runParams.abortSignal?.aborted || params.events.hasObservedCliActivity()) {
        throw error;
      }
      throw resolveCliResumeAtError(error, resumeAtArg, failoverContext) ?? error;
    });
  } else {
    const supervisor = params.deps.getProcessSupervisor();
    const scopeKey = buildCliSupervisorScopeKey({
      backend: params.backend,
      backendId: context.backendResolved.id,
      cliSessionId: params.useResume ? params.resolvedSessionId : undefined,
    });
    if (runParams.abortSignal?.aborted) {
      throw createCliAbortError();
    }
    // Startup can wait behind another scoped run. Reserve cancellation under
    // the caller's run id before awaiting the child or replacement fence.
    const abortManagedRun = () => supervisor.cancel(runParams.runId, "manual-cancel");
    runParams.abortSignal?.addEventListener("abort", abortManagedRun, { once: true });
    try {
      const managedRun = await supervisor.spawn({
        assertCurrent: params.assertCurrent,
        runId: runParams.runId,
        sessionId: runParams.sessionId,
        backendId: context.backendResolved.id,
        scopeKey,
        replaceExistingScope: Boolean(params.useResume && scopeKey),
        mode: "child",
        argv: [params.executionCommand, ...params.executionLeadingArgv, ...params.executionArgs],
        argv0: params.executionArgv0,
        timeoutMs: runParams.timeoutMs,
        noOutputTimeoutMs: params.noOutputTimeoutMs,
        cwd: context.cwd ?? context.workspaceDir,
        env: params.env,
        input: params.stdin ?? "",
        secretInput: context.preparedBackend.secretInput,
        captureOutput: false,
        onStdout: consumeStdout,
        onStderr: consumeStderr,
      });
      managedRunPid = managedRun.pid;
      const replyBackendHandle = runParams.replyOperation
        ? {
            kind: "cli" as const,
            runId: runParams.runId,
            toolAuthorityFingerprint: runParams.toolAuthorityFingerprint,
            cancel: () => managedRun.cancel("manual-cancel"),
          }
        : undefined;
      if (replyBackendHandle) {
        runParams.replyOperation?.attachBackend(replyBackendHandle);
      }
      try {
        result = await managedRun.wait();
      } finally {
        if (replyBackendHandle) {
          runParams.replyOperation?.detachBackend(replyBackendHandle);
        }
      }
    } finally {
      runParams.abortSignal?.removeEventListener("abort", abortManagedRun);
    }
  }
  if (
    (runParams.abortSignal?.aborted || nodeRunAbortSignal?.aborted) &&
    result.reason === "manual-cancel" &&
    !terminalInterruption
  ) {
    throw createCliAbortError();
  }
  params.options?.onPhase?.("resolve");
  streamingParser?.finish();
  const streamingParserErrorText =
    params.outputMode === "jsonl" ? (streamingParser?.getErrorText() ?? null) : null;
  if (streamingParserErrorText) {
    throw createCliFailoverError(streamingParserErrorText, "format", failoverContext);
  }
  // The node re-injects the terminal result after truncation. If even that is
  // missing, the turn outcome is unknowable and cannot pass as a clean exit.
  if (
    nodeRunTruncated &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !streamingParser?.hasTerminalResult()
  ) {
    throw createCliFailoverError(
      "paired node truncated the Claude CLI stream before the terminal result; refusing to accept partial output.",
      "format",
      failoverContext,
    );
  }

  let stdout: string | undefined;
  const readStdout = () => (stdout ??= stdoutParseBuffer.toString("utf8").trim());
  const stdoutDiagnostic = stdoutTail.trim();
  const stderrDiagnostic = stderrTail.trim();
  const processDiagnostics = {
    backendId: context.backendResolved.id,
    processReason: result.reason,
    exitCode: result.exitCode,
    exitSignal: result.exitSignal,
    durationMs: result.durationMs,
    stdoutBytes,
    stdoutHash: stdoutHash.digest("hex").slice(0, 12),
    stderrBytes,
    stderrHash: stderrHash.digest("hex").slice(0, 12),
    useResume: params.useResume,
  };
  if (params.logOutputText) {
    if (stdoutDiagnostic) {
      cliBackendLog.info(`cli stdout:\n${stdoutDiagnostic}`);
    }
    if (stderrDiagnostic) {
      cliBackendLog.info(`cli stderr:\n${stderrDiagnostic}`);
    }
  }
  if (shouldLogVerbose()) {
    if (stdoutDiagnostic) {
      cliBackendLog.debug(`cli stdout:\n${stdoutDiagnostic}`);
    }
    if (stderrDiagnostic) {
      cliBackendLog.debug(`cli stderr:\n${stderrDiagnostic}`);
    }
  }

  const streamedJsonlOutput =
    params.outputMode === "jsonl" ? (streamingParser?.getOutput() ?? null) : null;
  const parsedStructuredOutput =
    streamedJsonlOutput ??
    (params.outputMode === "json" && !stdoutParseExceeded
      ? parseCliOutput({
          raw: readStdout(),
          backend: params.backend,
          providerId: context.backendResolved.id,
          outputMode: params.outputMode,
          fallbackSessionId: params.resolvedSessionId,
        })
      : null);
  // A completed terminal record is authoritative even if the CLI hangs
  // afterward. Reclassifying it as a timeout could replay completed tools.
  if (parsedStructuredOutput?.terminalFailure) {
    const terminalError = createCliOutputFailoverError({
      output: parsedStructuredOutput,
      ...outputErrorContext,
    });
    if (terminalError) {
      throw terminalError;
    }
  }

  if (!terminalInterruption && (result.exitCode !== 0 || result.reason !== "exit")) {
    params.options?.onPhase?.("send");
    if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
      const timeoutSeconds = Math.round(params.noOutputTimeoutMs / 1000);
      cliBackendLog.warn(
        `cli watchdog timeout: provider=${runParams.provider} model=${context.modelId} session=${params.resolvedSessionId ?? runParams.sessionId} noOutputTimeoutMs=${params.noOutputTimeoutMs} pid=${managedRunPid ?? "node"}`,
      );
      const observedActivity = params.events.hasObservedCliActivity();
      const timeoutDecision = pluginTimeout.error
        ? { error: pluginTimeout.error }
        : resolveCliNoOutputTimeoutDecision({
            context: failoverContext,
            timeoutMs: params.noOutputTimeoutMs,
            quietDurationMs: params.noOutputTimeoutMs,
            cliTimeout: {
              mode: "no-output",
              timeoutSeconds,
              observedActivity,
              activeToolCount: params.events.activeParsedToolCount(),
              backgroundTaskCount: 0,
            },
            hasOutputText: Boolean(stdoutDiagnostic || stderrDiagnostic),
            useResume: params.useResume,
            hasReplayUnsafeActivity: observedActivity,
          });
      const retryable = timeoutDecision.error.code === "cli_no_output_timeout";
      const deferNotice =
        retryable &&
        Boolean(params.cliSessionIdToUse) &&
        Boolean(params.resolvedSessionId) &&
        Boolean(context.openClawHistoryPrompt) &&
        Boolean(runParams.sessionKey) &&
        runParams.timeoutMs - (Date.now() - context.started) > 0;
      if (runParams.sessionKey && params.events.emitLiveEvents && !deferNotice) {
        const stallNotice = [
          `CLI agent (${runParams.provider}) produced no output for ${timeoutSeconds}s and was terminated.`,
          "It may have been waiting for interactive input or an approval prompt.",
          "Check CLI permission settings and OpenClaw approval prompts.",
        ].join(" ");
        const routing = resolveEventSessionRoutingPolicy({
          cfg: runParams.config,
          sessionKey: runParams.sessionKey,
          channel: runParams.messageProvider,
          accountId: runParams.agentAccountId,
        });
        params.deps.enqueueSystemEvent(stallNotice, {
          sessionKey: resolveEventSessionKeyForPolicy(runParams.sessionKey, routing),
        });
        params.deps.requestHeartbeat(
          scopedHeartbeatWakeOptionsForPolicy(
            runParams.sessionKey,
            { source: "cli-watchdog", intent: "event", reason: "cli:watchdog:stall" },
            routing,
          ),
        );
      }
      throw timeoutDecision.error;
    }
    if (result.reason === "overall-timeout") {
      const timeoutSeconds = Math.round(runParams.timeoutMs / 1000);
      throw createCliTimeoutError(
        failoverContext,
        {
          mode: "overall",
          timeoutSeconds,
          observedActivity: params.events.hasObservedCliActivity(),
          activeToolCount: params.events.activeParsedToolCount(),
          backgroundTaskCount: 0,
        },
        "cli_overall_timeout",
      );
    }
    const retryEmptyFailure = result.reason === "exit" && !params.events.hasObservedCliActivity();
    const stderr = stderrParseBuffer.toString("utf8").trim();
    throw createCliExitFailoverError({
      context: failoverContext,
      candidates: [stderr, readStdout(), stderrDiagnostic, stdoutDiagnostic],
      fallbackMessage: "CLI failed.",
      retryEmptyFailure,
      resumeAtArg: retryEmptyFailure ? resumeAtArg : undefined,
    });
  }

  if (stdoutParseExceeded && !streamedJsonlOutput) {
    throw createCliFailoverError(
      `CLI stdout exceeded ${CLI_RUNNER_OUTPUT_PARSE_BYTES} bytes; refusing to parse truncated output.`,
      "format",
      failoverContext,
    );
  }
  if (runParams.controlOperation === "compact") {
    const manualCompaction = context.backendResolved.manualCompaction;
    if (!manualCompaction) {
      throw new Error(
        `CLI backend ${context.backendResolved.id} does not support manual compaction`,
      );
    }
    const validation = manualCompaction.validateOutput(readStdout());
    if (!validation.ok) {
      throw createCliFailoverError(validation.reason, "unknown", failoverContext);
    }
    return {
      text: "",
      rawText: "",
      diagnostics: { process: processDiagnostics },
      finalPromptText: params.prompt,
    };
  }
  const parsed =
    parsedStructuredOutput ??
    parseCliOutput({
      raw: readStdout(),
      backend: params.backend,
      providerId: context.backendResolved.id,
      outputMode: params.outputMode,
      fallbackSessionId: params.resolvedSessionId,
    });
  const parsedError = createCliOutputFailoverError({
    output: parsed,
    ...outputErrorContext,
  });
  if (parsedError) {
    throw parsedError;
  }
  const rawText = parsed.text;
  cliBackendLog.info(
    `cli turn: provider=${runParams.provider} model=${context.modelId} durationMs=${Date.now() - params.cliTurnStartedAt} ${formatCliBackendOutputDigest(rawText)}`,
  );
  return {
    ...parsed,
    ...(terminalInterruption ? { terminalInterruption } : {}),
    diagnostics: { ...parsed.diagnostics, process: processDiagnostics },
    rawText,
    finalPromptText: params.prompt,
    text: applyPluginTextReplacements(rawText, context.backendResolved.textTransforms?.output),
  };
}
