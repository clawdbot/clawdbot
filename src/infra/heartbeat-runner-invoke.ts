// Final stage of the heartbeat runner pipeline: turn a prepared wake into an
// actual agent run. Split out of `heartbeat-runner-execution.ts`, which owns
// the wake-resolution and preparation stages, so each stage file stays within
// the repo's max-lines budget.
import { normalizeOptionalString } from "@openclaw/normalization-core/string-coerce";
import { hasOutboundReplyContent } from "openclaw/plugin-sdk/reply-payload";
import { appendCronStyleCurrentTimeLine } from "../agents/current-time.js";
import {
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
  StageResult,
} from "./heartbeat-runner-execution.js";
import { getHeartbeatWakeAbortSignal } from "./heartbeat-wake.js";

const log = heartbeatLog;

const loadHeartbeatRunnerRuntime = createLazyRuntimeModule(
  () => import("./heartbeat-runner.runtime.js"),
);

export async function invokeHeartbeatAgentRun(
  opts: HeartbeatRunOptions,
  wake: ReadyHeartbeatWake,
  prepared: PreparedHeartbeatRun,
) {
  const { cfg, agentId, heartbeat, startedAt, preflight } = wake;
  const { delivery, hasExecCompletion, hasCronEvents, prompt } = prepared;
  const { replyPrefix, runSessionKey, sender, suppressOriginatingContext } = prepared;
  const { usesHeartbeatResponseTool } = prepared;
  const replyOperationRunState: ReplyOperationRunState = {};
  const heartbeatModelOverride = normalizeOptionalString(heartbeat?.model);
  const getReplyFromConfig =
    opts.deps?.getReplyFromConfig ?? (await loadHeartbeatRunnerRuntime()).getReplyFromConfig;
  const heartbeatWakeAbortSignal = getHeartbeatWakeAbortSignal();
  const replyOpts = {
    isHeartbeat: true,
    [REPLY_OPERATION_RUN_STATE]: replyOperationRunState,
    ...(heartbeatModelOverride ? { heartbeatModelOverride } : {}),
    suppressToolErrorWarnings: false,
    ...(usesHeartbeatResponseTool ? { enableHeartbeatTool: true, forceHeartbeatTool: true } : {}),
    ...(usesHeartbeatResponseTool ? { sourceReplyDeliveryMode: "message_tool_only" as const } : {}),
    ...(heartbeatWakeAbortSignal ? { abortSignal: heartbeatWakeAbortSignal } : {}),
    // Heartbeat timeout is a per-run override so user turns keep the global default.
    timeoutOverrideSeconds: resolveHeartbeatTimeoutOverrideSeconds(cfg, heartbeat),
    bootstrapContextMode: heartbeat?.lightContext === true ? ("lightweight" as const) : undefined,
    onModelSelected: replyPrefix.onModelSelected,
  };
  const replyResult = await getReplyFromConfig(
    {
      Body: appendCronStyleCurrentTimeLine(prompt, cfg, startedAt),
      From: sender,
      To: sender,
      OriginatingChannel:
        !suppressOriginatingContext && delivery.channel !== "none" ? delivery.channel : undefined,
      OriginatingTo: !suppressOriginatingContext ? delivery.to : undefined,
      AccountId: delivery.accountId,
      MessageThreadId: delivery.threadId,
      Provider: hasExecCompletion ? "exec-event" : hasCronEvents ? "cron-event" : "heartbeat",
      SessionKey: runSessionKey,
      AgentId: agentId,
    },
    replyOpts,
    cfg,
  );
  const agentTurnStatus = resolveReplyOperationAgentTurn(replyOperationRunState);
  if (agentTurnStatus === "superseded" || agentTurnStatus === "cancelled") {
    return { kind: agentTurnStatus === "superseded" ? "preempted" : "cancelled" } as const;
  }
  const heartbeatToolResponse = resolveHeartbeatToolResponseFromReplyResult(replyResult);
  const heartbeatScratchProposal = resolveHeartbeatScratchProposalFromReplyResult(replyResult);
  const heartbeatTerminalToolFailure = resolveHeartbeatTerminalToolFailure(replyResult);
  const agentRunFailed = agentTurnStatus === "failed";
  const selectedReplyPayload = resolveHeartbeatReplyPayload(replyResult);
  const replyPayload = selectedReplyPayload;
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
