import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import {
  type HeartbeatTerminalToolFailure,
  resolveHeartbeatReplyPayload,
  resolveHeartbeatTerminalToolFailure,
} from "../auto-reply/heartbeat-reply-payload.js";
import {
  resolveHeartbeatScratchProposalFromReplyResult,
  resolveHeartbeatToolResponseFromReplyResult,
} from "../auto-reply/heartbeat-tool-response.js";
import { resolveReplyOperationAgentTurn } from "../auto-reply/reply/reply-operation-agent-turn-state.js";
import {
  REPLY_OPERATION_RUN_STATE,
  type ReplyOperationRunState,
} from "../auto-reply/reply/reply-operation-run-state.js";
import { writeCronJobScratch } from "../cron/scratch-store.js";
import { resolveCronJobsStorePathFromConfig } from "../cron/store.js";
import { createLazyRuntimeModule } from "../shared/lazy-runtime.js";
import { formatErrorMessage } from "./errors.js";
import { heartbeatLog, resolveHeartbeatTimeoutOverrideSeconds } from "./heartbeat-runner-config.js";
import type {
  HeartbeatRunOptions,
  PreparedHeartbeatRun,
  ReadyHeartbeatWake,
} from "./heartbeat-runner-execution.js";
import {
  createHeartbeatSetupAbortController,
  resolveHeartbeatSetupTimeoutMs,
  type HeartbeatSetupAbortController,
} from "./heartbeat-runner-setup-watchdog.js";
import { getHeartbeatWakeAbortSignal } from "./heartbeat-wake.js";

const log = heartbeatLog;

type StageResult<T, K extends string> = Extract<Awaited<T>, { kind: K }>;

const loadHeartbeatRunnerRuntime = createLazyRuntimeModule(
  () => import("./heartbeat-runner.runtime.js"),
);

export async function invokeHeartbeatAgentRun(
  opts: HeartbeatRunOptions,
  wake: ReadyHeartbeatWake,
  prepared: PreparedHeartbeatRun,
  setupWatchdog?: HeartbeatSetupAbortController,
) {
  const { cfg, agentId, heartbeat, startedAt, preflight } = wake;
  const { delivery, hasExecCompletion, hasCronEvents, prompt } = prepared;
  const { replyPrefix, runSessionKey, sender, suppressOriginatingContext } = prepared;
  const { usesHeartbeatResponseTool } = prepared;
  const replyOperationRunState: ReplyOperationRunState = {};
  const heartbeatModelOverride = normalizeOptionalString(heartbeat?.model);
  const getReplyFromConfig =
    opts.deps?.getReplyFromConfig ?? (await loadHeartbeatRunnerRuntime()).getReplyFromConfig;
  const heartbeatTimeoutSeconds = resolveHeartbeatTimeoutOverrideSeconds(cfg, heartbeat);
  const setupTimeoutMs = resolveHeartbeatSetupTimeoutMs(
    heartbeatTimeoutSeconds,
    opts.setupTimeoutMs,
  );
  const resolvedSetupWatchdog =
    setupWatchdog ??
    createHeartbeatSetupAbortController({
      timeoutMs: setupTimeoutMs,
      heartbeatWakeAbortSignal: getHeartbeatWakeAbortSignal(),
      onTimeout: () =>
        new Error(
          `heartbeat setup timeout: no model selected within ${Math.floor(setupTimeoutMs / 1000)}s`,
        ),
    });
  const onModelSelected = replyPrefix.onModelSelected;
  const replyOpts = {
    isHeartbeat: true,
    [REPLY_OPERATION_RUN_STATE]: replyOperationRunState,
    ...(heartbeatModelOverride ? { heartbeatModelOverride } : {}),
    suppressToolErrorWarnings: false,
    ...(usesHeartbeatResponseTool ? { enableHeartbeatTool: true, forceHeartbeatTool: true } : {}),
    ...(usesHeartbeatResponseTool ? { sourceReplyDeliveryMode: "message_tool_only" as const } : {}),
    abortSignal: resolvedSetupWatchdog.signal,
    // Heartbeat timeout is a per-run override so user turns keep the global default.
    timeoutOverrideSeconds: heartbeatTimeoutSeconds,
    bootstrapContextMode: heartbeat?.lightContext === true ? ("lightweight" as const) : undefined,
    onModelSelected: onModelSelected
      ? (ctx: Parameters<typeof onModelSelected>[0]) => {
          resolvedSetupWatchdog.disarm();
          onModelSelected(ctx);
        }
      : undefined,
  };
  const replyResult = await (async () => {
    try {
      return await getReplyFromConfig(
        {
          Body: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),
          From: sender,
          To: sender,
          OriginatingChannel:
            !suppressOriginatingContext && delivery.channel !== "none"
              ? delivery.channel
              : undefined,
          OriginatingTo: !suppressOriginatingContext ? delivery.to : undefined,
          AccountId: delivery.accountId,
          MessageThreadId: delivery.threadId,
          InternalTurnSource: hasExecCompletion ? "exec" : hasCronEvents ? "cron" : "heartbeat",
          SessionKey: runSessionKey,
          AgentId: agentId,
        },
        replyOpts,
        cfg,
      );
    } finally {
      resolvedSetupWatchdog.disarm();
    }
  })();
  const agentTurnStatus = resolveReplyOperationAgentTurn(replyOperationRunState);
  if (agentTurnStatus === "superseded" || agentTurnStatus === "cancelled") {
    return { kind: agentTurnStatus === "superseded" ? "preempted" : "cancelled" } as const;
  }
  const heartbeatToolResponse = resolveHeartbeatToolResponseFromReplyResult(replyResult);
  const heartbeatScratchProposal = resolveHeartbeatScratchProposalFromReplyResult(replyResult);
  const heartbeatTerminalToolFailure: HeartbeatTerminalToolFailure | undefined =
    resolveHeartbeatTerminalToolFailure(replyResult);
  const replyPayload = resolveHeartbeatReplyPayload(replyResult);
  const agentRunFailed = agentTurnStatus === "failed";
  if (
    heartbeatScratchProposal !== undefined &&
    heartbeatToolResponse &&
    !heartbeatTerminalToolFailure
  ) {
    if (!preflight.scratchJobId) {
      log.warn("heartbeat: scratch update ignored because no monitor job exists");
    } else {
      try {
        const scratchWrite = writeCronJobScratch({
          storePath: resolveCronJobsStorePathFromConfig(cfg),
          jobId: preflight.scratchJobId,
          content: heartbeatScratchProposal,
          expectedRevision: preflight.scratchRevision ?? 0,
        });
        if (!scratchWrite.ok) {
          log.warn("heartbeat: scratch update lost a concurrent revision race");
        }
      } catch (error) {
        log.warn(`heartbeat: scratch update failed: ${formatErrorMessage(error)}`);
      }
    }
  }
  if (
    !heartbeatToolResponse &&
    (!replyPayload || !hasOutboundReplyContent(replyPayload)) &&
    replyOperationRunState.admission?.status === "skipped" &&
    replyOperationRunState.admission.reason === "active-run"
  ) {
    return { kind: "busy" } as const;
  }
  return {
    kind: "completed",
    heartbeatToolResponse,
    heartbeatTerminalToolFailure,
    agentRunFailed,
    replyPayload,
  } as const;
}

export type CompletedHeartbeatAgentRun = StageResult<
  ReturnType<typeof invokeHeartbeatAgentRun>,
  "completed"
>;
