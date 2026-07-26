import crypto from "node:crypto";
import { shouldLogVerbose } from "../../globals.js";
import {
  resolveEventSessionKeyForPolicy,
  resolveEventSessionRoutingPolicy,
  scopedHeartbeatWakeOptionsForPolicy,
} from "../../infra/event-session-routing.js";
import type { CliBackendConfig } from "../../plugins/cli-backend.types.js";
import type { RunExit } from "../../process/supervisor/types.js";
import {
  createCliJsonlStreamingParser,
  extractCliErrorMessage,
  parseCliOutput,
  type CliOutput,
} from "../cli-output.js";
import { classifyFailoverReason } from "../embedded-agent-helpers.js";
import { FailoverError, resolveFailoverStatus } from "../failover-error.js";
import { applyPluginTextReplacements } from "../plugin-text-transforms.js";
import { runClaudeLiveSessionTurn } from "./claude-live-session.js";
import type { CliExecuteDeps } from "./execute-deps.js";
import type { CliEventHandlers } from "./execute-events.js";
import {
  createCliAbortError,
  executeNodeClaudeRun,
  type resolveNodeClaudePlacement,
} from "./execute-node-claude.js";
import { appendCliOutputTail } from "./execute-output-buffer.js";
import type { CliToolTracking } from "./execute-tool-tracking.js";
import { buildCliSupervisorScopeKey } from "./helpers.js";
import { cliBackendLog, formatCliBackendOutputDigest } from "./log.js";
import type { createClaudeCliModelCallDiagnostics } from "./model-call-diagnostics.js";
import { createCliOutputFailoverError } from "./output-error.js";
import type { PreparedCliRunContext } from "./types.js";

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
  backend: CliBackendConfig;
  deps: CliExecuteDeps;
  events: CliEventHandlers;
  toolTracking: CliToolTracking;
  diagnostics: ReturnType<typeof createClaudeCliModelCallDiagnostics>;
  nodePlacement: ReturnType<typeof resolveNodeClaudePlacement>;
  nodeSystemPrompt?: string;
  nodeEnv?: Record<string, string>;
  nodeClearEnv?: string[];
  useManagedClaudeLiveSession: boolean;
  useResume: boolean;
  cliSessionIdToUse?: string;
  resolvedSessionId?: string;
  executionCommand: string;
  executionLeadingArgv: readonly string[];
  executionArgs: string[];
  env: Record<string, string>;
  prompt: string;
  argsPrompt?: string;
  stdin?: string;
  noOutputTimeoutMs: number;
  outputMode: CliBackendConfig["output"];
  logOutputText: boolean;
  cliTurnStartedAt: number;
  fallbackCleanup?: () => Promise<void>;
  claimFallbackCleanup: () => void;
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
  const hasJsonlOutput = params.outputMode === "jsonl";
  if (params.useManagedClaudeLiveSession) {
    if (!hasJsonlOutput) {
      throw new Error("Claude live session requires JSONL streaming parser");
    }
    runParams.onExecutionPhase?.({
      phase: "process_spawned",
      provider: runParams.provider,
      model: context.modelId,
      backend: context.backendResolved.id,
    });
    params.claimFallbackCleanup();
    const liveResult = await runClaudeLiveSessionTurn({
      context,
      args: params.executionArgs,
      executableCommand: params.executionCommand,
      executableLeadingArgv: params.executionLeadingArgv,
      env: params.env,
      prompt: params.prompt,
      useResume: params.useResume,
      forceNewSession:
        params.cliSessionIdToUse === undefined && context.openClawHistoryPrompt !== undefined,
      requiredSessionGeneration: params.cliSessionIdToUse
        ? context.requiredClaudeLiveSessionGeneration
        : undefined,
      noOutputTimeoutMs: params.noOutputTimeoutMs,
      getProcessSupervisor: params.deps.getProcessSupervisor,
      onAssistantDelta: params.events.emitCliAssistantDelta,
      onThinkingDelta: params.events.emitCliThinkingDelta,
      onThinkingProgress: params.events.emitCliThinkingProgress,
      onToolUseStart: params.events.emitCliToolUseStart,
      onToolResult: params.events.emitCliToolResult,
      resolveToolResultTerminalOutcome: (event) => {
        const outcome = params.toolTracking.resolveCliLoopbackTerminalOutcome(event.toolCallId);
        return outcome?.outcome === "completed" ? undefined : outcome;
      },
      onCommentaryText:
        params.events.emitLiveEvents && runParams.emitCommentaryText
          ? params.events.emitCliCommentaryText
          : undefined,
      onMcpCaptureReady: params.toolTracking.beginGatewayCapture,
      cleanup: async () => {
        await params.fallbackCleanup?.();
      },
      onSessionId: params.observeForkSuccessor,
      onAssistantMessage: params.diagnostics?.observeAssistantMessage,
      onUsage: params.diagnostics?.observeUsage,
      onCliOutput: params.diagnostics?.observeCliOutput,
      onRequestPayload: params.diagnostics?.observeRequestPayload,
      onPhase: params.options?.onPhase,
    });
    params.options?.onPhase?.("resolve");
    const rawText = liveResult.output.text;
    return {
      ...liveResult.output,
      rawText,
      finalPromptText: params.prompt,
      text: applyPluginTextReplacements(rawText, context.backendResolved.textTransforms?.output),
    };
  }

  const streamingParser = hasJsonlOutput
    ? createCliJsonlStreamingParser({
        backend: params.backend,
        providerId: context.backendResolved.id,
        onAssistantDelta: params.events.emitCliAssistantDelta,
        onThinkingDelta: params.events.emitCliThinkingDelta,
        onThinkingProgress: params.events.emitCliThinkingProgress,
        onPlanUpdate: params.events.emitCliPlanUpdate,
        onToolUseStart: params.events.emitParsedToolUseStart,
        onToolResult: params.events.emitParsedToolResult,
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
  let result: RunExit;
  params.diagnostics?.observeRequestPayload(params.stdin ?? params.argsPrompt ?? "");
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
  } else {
    const supervisor = params.deps.getProcessSupervisor();
    const scopeKey = buildCliSupervisorScopeKey({
      backend: params.backend,
      backendId: context.backendResolved.id,
      cliSessionId: params.useResume ? params.resolvedSessionId : undefined,
    });
    const managedRun = await supervisor.spawn({
      sessionId: runParams.sessionId,
      backendId: context.backendResolved.id,
      scopeKey,
      replaceExistingScope: Boolean(params.useResume && scopeKey),
      mode: "child",
      argv: [params.executionCommand, ...params.executionLeadingArgv, ...params.executionArgs],
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
    let replyBackendCompleted = false;
    const replyBackendHandle = runParams.replyOperation
      ? {
          kind: "cli" as const,
          cancel: () => managedRun.cancel("manual-cancel"),
          isStreaming: () => !replyBackendCompleted,
        }
      : undefined;
    if (replyBackendHandle) {
      runParams.replyOperation?.attachBackend(replyBackendHandle);
    }
    const abortManagedRun = () => managedRun.cancel("manual-cancel");
    runParams.abortSignal?.addEventListener("abort", abortManagedRun, { once: true });
    if (runParams.abortSignal?.aborted) {
      abortManagedRun();
    }
    try {
      result = await managedRun.wait();
    } finally {
      replyBackendCompleted = true;
      if (replyBackendHandle) {
        runParams.replyOperation?.detachBackend(replyBackendHandle);
      }
      runParams.abortSignal?.removeEventListener("abort", abortManagedRun);
    }
  }
  if (
    (runParams.abortSignal?.aborted || nodeRunAbortSignal?.aborted) &&
    result.reason === "manual-cancel"
  ) {
    throw createCliAbortError();
  }
  params.options?.onPhase?.("resolve");
  streamingParser?.finish();
  const streamingParserErrorText =
    params.outputMode === "jsonl" ? (streamingParser?.getErrorText() ?? null) : null;
  if (streamingParserErrorText) {
    throw new FailoverError(streamingParserErrorText, {
      reason: "format",
      ...failoverContext,
      status: resolveFailoverStatus("format"),
    });
  }
  // The node re-injects the terminal result after truncation. If even that is
  // missing, the turn outcome is unknowable and cannot pass as a clean exit.
  if (
    nodeRunTruncated &&
    result.exitCode === 0 &&
    !result.timedOut &&
    !streamingParser?.getOutput()
  ) {
    throw new FailoverError(
      "paired node truncated the Claude CLI stream before the terminal result; refusing to accept partial output.",
      {
        reason: "format",
        ...failoverContext,
        status: resolveFailoverStatus("format"),
      },
    );
  }

  const stdout = stdoutParseBuffer.toString("utf8").trim();
  const stdoutDiagnostic = stdoutTail.trim();
  const stderr = stderrParseBuffer.toString("utf8").trim();
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
          raw: stdout,
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

  if (result.exitCode !== 0 || result.reason !== "exit") {
    params.options?.onPhase?.("send");
    if (result.reason === "no-output-timeout" || result.noOutputTimedOut) {
      const timeoutSeconds = Math.round(params.noOutputTimeoutMs / 1000);
      cliBackendLog.warn(
        `cli watchdog timeout: provider=${runParams.provider} model=${context.modelId} session=${params.resolvedSessionId ?? runParams.sessionId} noOutputTimeoutMs=${params.noOutputTimeoutMs} pid=${managedRunPid ?? "node"}`,
      );
      const retryable =
        !params.events.hasObservedCliActivity() && !stdoutDiagnostic && !stderrDiagnostic;
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
          ...(params.nodePlacement
            ? ["Check the node's Claude permission settings for pending prompts."]
            : ["For Claude Code, prefer --permission-mode bypassPermissions --print."]),
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
      throw new FailoverError(`CLI produced no output for ${timeoutSeconds}s and was terminated.`, {
        reason: "timeout",
        ...failoverContext,
        status: resolveFailoverStatus("timeout"),
        code: retryable ? "cli_no_output_timeout" : undefined,
        cliTimeout: {
          mode: "no-output",
          timeoutSeconds,
          observedActivity: params.events.hasObservedCliActivity(),
          activeToolCount: params.events.activeParsedToolCount(),
          backgroundTaskCount: 0,
        },
      });
    }
    if (result.reason === "overall-timeout") {
      const timeoutSeconds = Math.round(runParams.timeoutMs / 1000);
      throw new FailoverError(`CLI exceeded timeout (${timeoutSeconds}s) and was terminated.`, {
        reason: "timeout",
        ...failoverContext,
        status: resolveFailoverStatus("timeout"),
        code: "cli_overall_timeout",
        cliTimeout: {
          mode: "overall",
          timeoutSeconds,
          observedActivity: params.events.hasObservedCliActivity(),
          activeToolCount: params.events.activeParsedToolCount(),
          backgroundTaskCount: 0,
        },
      });
    }
    const errorCandidates = [stderr, stdout, stderrDiagnostic, stdoutDiagnostic].filter(Boolean);
    const structuredError =
      errorCandidates.map((candidate) => extractCliErrorMessage(candidate)).find(Boolean) ?? null;
    let classifiedErrorText = structuredError;
    let reason = structuredError
      ? classifyFailoverReason(structuredError, { provider: runParams.provider })
      : null;
    if (!reason) {
      for (const candidate of errorCandidates) {
        reason = classifyFailoverReason(candidate, { provider: runParams.provider });
        if (reason) {
          classifiedErrorText = candidate;
          break;
        }
      }
    }
    const errorText = structuredError || classifiedErrorText || errorCandidates[0] || "CLI failed.";
    reason ??= "unknown";
    const retryCode =
      reason === "context_overflow"
        ? "cli_context_overflow"
        : reason === "unknown" &&
            result.reason === "exit" &&
            errorCandidates.length === 0 &&
            !params.events.hasObservedCliActivity()
          ? "cli_unknown_empty_failure"
          : undefined;
    throw new FailoverError(errorText, {
      reason,
      ...failoverContext,
      status: resolveFailoverStatus(reason),
      code: retryCode,
    });
  }

  if (stdoutParseExceeded && !streamedJsonlOutput) {
    throw new FailoverError(
      `CLI stdout exceeded ${CLI_RUNNER_OUTPUT_PARSE_BYTES} bytes; refusing to parse truncated output.`,
      {
        reason: "format",
        ...failoverContext,
        status: resolveFailoverStatus("format"),
      },
    );
  }
  const parsed =
    parsedStructuredOutput ??
    parseCliOutput({
      raw: stdout,
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
    diagnostics: { ...parsed.diagnostics, process: processDiagnostics },
    rawText,
    finalPromptText: params.prompt,
    text: applyPluginTextReplacements(rawText, context.backendResolved.textTransforms?.output),
  };
}
