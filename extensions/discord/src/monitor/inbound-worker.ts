import { createRunStateMachine } from "openclaw/plugin-sdk/channel-lifecycle";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import type { ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { danger, formatDurationSeconds } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
  DiscordRetryableInboundError,
  releaseDiscordInboundReplay,
} from "./inbound-dedupe.js";
import { materializeDiscordInboundJob, type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { resolveDiscordReplyDeliveryPlan } from "./threading.js";
import { normalizeDiscordInboundWorkerTimeoutMs, runDiscordTaskWithTimeout } from "./timeouts.js";

type ProcessDiscordMessage = typeof import("./message-handler.process.js").processDiscordMessage;
type DeliverDiscordReply = typeof import("./reply-delivery.js").deliverDiscordReply;

type DiscordInboundWorkerParams = {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  runTimeoutMs?: number;
  replayGuard?: ClaimableDedupe;
  __testing?: DiscordInboundWorkerTestingHooks;
};

export type DiscordInboundWorker = {
  enqueue: (job: DiscordInboundJob) => void;
  deactivate: () => void;
};

export type DiscordInboundWorkerTestingHooks = {
  processDiscordMessage?: ProcessDiscordMessage;
  deliverDiscordReply?: DeliverDiscordReply;
};

let messageProcessRuntimePromise:
  | Promise<typeof import("./message-handler.process.js")>
  | undefined;
let replyDeliveryRuntimePromise: Promise<typeof import("./reply-delivery.js")> | undefined;

async function loadMessageProcessRuntime() {
  messageProcessRuntimePromise ??= import("./message-handler.process.js");
  return await messageProcessRuntimePromise;
}

async function loadReplyDeliveryRuntime() {
  replyDeliveryRuntimePromise ??= import("./reply-delivery.js");
  return await replyDeliveryRuntimePromise;
}

function formatDiscordRunContextSuffix(job: DiscordInboundJob): string {
  const channelId = job.payload.messageChannelId?.trim();
  const messageId = job.payload.data?.message?.id?.trim();
  const details = [
    channelId ? `channelId=${channelId}` : null,
    messageId ? `messageId=${messageId}` : null,
  ].filter((entry): entry is string => Boolean(entry));
  if (details.length === 0) {
    return "";
  }
  return ` (${details.join(", ")})`;
}

async function processDiscordInboundJob(params: {
  job: DiscordInboundJob;
  runtime: RuntimeEnv;
  lifecycleSignal?: AbortSignal;
  runTimeoutMs?: number;
  replayGuard: ClaimableDedupe;
  testing?: DiscordInboundWorkerTestingHooks;
}) {
  const timeoutMs = normalizeDiscordInboundWorkerTimeoutMs(params.runTimeoutMs);
  const contextSuffix = formatDiscordRunContextSuffix(params.job);
  let finalReplyStarted = false;
  let createdThreadId: string | undefined;
  let sessionKey: string | undefined;
  const processDiscordMessageImpl =
    params.testing?.processDiscordMessage ??
    (await loadMessageProcessRuntime()).processDiscordMessage;
  try {
    await runDiscordTaskWithTimeout({
      run: async (abortSignal) => {
        await processDiscordMessageImpl(materializeDiscordInboundJob(params.job, abortSignal), {
          onFinalReplyStart: () => {
            finalReplyStarted = true;
          },
          onFinalReplyDelivered: () => {
            finalReplyStarted = true;
          },
          onReplyPlanResolved: (resolved) => {
            createdThreadId = normalizeOptionalString(resolved.createdThreadId);
            sessionKey = normalizeOptionalString(resolved.sessionKey);
          },
        });
      },
      timeoutMs,
      abortSignals: [params.job.runtime.abortSignal, params.lifecycleSignal],
      onTimeout: async (resolvedTimeoutMs) => {
        params.runtime.error?.(
          danger(
            `discord inbound worker timed out after ${formatDurationSeconds(resolvedTimeoutMs, {
              decimals: 1,
              unit: "seconds",
            })}${contextSuffix}`,
          ),
        );
        if (finalReplyStarted) {
          return;
        }
        await sendDiscordInboundWorkerTimeoutReply({
          job: params.job,
          runtime: params.runtime,
          contextSuffix,
          createdThreadId,
          sessionKey,
          deliverDiscordReplyImpl: params.testing?.deliverDiscordReply,
        });
      },
      onErrorAfterTimeout: (error) => {
        params.runtime.error?.(
          danger(`discord inbound worker failed after timeout: ${String(error)}${contextSuffix}`),
        );
      },
    });
    await commitDiscordInboundReplay({
      replayKeys: params.job.replayKeys,
      replayGuard: params.replayGuard,
    });
  } catch (error) {
    if (error instanceof DiscordRetryableInboundError) {
      releaseDiscordInboundReplay({
        replayKeys: params.job.replayKeys,
        error,
        replayGuard: params.replayGuard,
      });
    } else {
      await commitDiscordInboundReplay({
        replayKeys: params.job.replayKeys,
        replayGuard: params.replayGuard,
      });
    }
    throw error;
  }
}

async function sendDiscordInboundWorkerTimeoutReply(params: {
  job: DiscordInboundJob;
  runtime: RuntimeEnv;
  contextSuffix: string;
  createdThreadId?: string;
  sessionKey?: string;
  deliverDiscordReplyImpl?: DeliverDiscordReply;
}) {
  const messageChannelId = params.job.payload.messageChannelId?.trim();
  const messageId = params.job.payload.message?.id?.trim();
  const token = params.job.payload.token?.trim();
  if (!messageChannelId || !messageId || !token) {
    params.runtime.error?.(
      danger(
        `discord inbound worker timeout reply skipped: missing reply target${params.contextSuffix}`,
      ),
    );
    return;
  }

  const deliveryPlan = resolveDiscordReplyDeliveryPlan({
    replyTarget: `channel:${params.job.payload.threadChannel?.id ?? messageChannelId}`,
    replyToMode: params.job.payload.replyToMode,
    messageId,
    threadChannel: params.job.payload.threadChannel,
    createdThreadId: params.createdThreadId,
  });

  try {
    const deliverDiscordReplyImpl =
      params.deliverDiscordReplyImpl ?? (await loadReplyDeliveryRuntime()).deliverDiscordReply;
    await deliverDiscordReplyImpl({
      cfg: params.job.payload.cfg,
      replies: [{ text: "Discord inbound worker timed out.", isError: true }],
      target: deliveryPlan.deliverTarget,
      token,
      accountId: params.job.payload.accountId,
      runtime: params.runtime,
      textLimit: params.job.payload.textLimit,
      maxLinesPerMessage: params.job.payload.discordConfig?.maxLinesPerMessage,
      replyToId: deliveryPlan.replyReference.use(),
      replyToMode: params.job.payload.replyToMode,
      sessionKey:
        params.sessionKey ??
        params.job.payload.route.sessionKey ??
        params.job.payload.baseSessionKey,
      threadBindings: params.job.runtime.threadBindings,
    });
  } catch (error) {
    params.runtime.error?.(
      danger(
        `discord inbound worker timeout reply failed: ${String(error)}${params.contextSuffix}`,
      ),
    );
  }
}

export function createDiscordInboundWorker(
  params: DiscordInboundWorkerParams,
): DiscordInboundWorker {
  const runQueue = new KeyedAsyncQueue();
  const runState = createRunStateMachine({
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
  });
  const replayGuard = params.replayGuard ?? createDiscordInboundReplayGuard();

  return {
    enqueue(job) {
      void runQueue
        .enqueue(job.queueKey, async () => {
          if (!runState.isActive()) {
            return;
          }
          runState.onRunStart();
          try {
            if (!runState.isActive()) {
              return;
            }
            await processDiscordInboundJob({
              job,
              runtime: params.runtime,
              lifecycleSignal: params.abortSignal,
              runTimeoutMs: params.runTimeoutMs,
              replayGuard,
              testing: params.__testing,
            });
          } finally {
            runState.onRunEnd();
          }
        })
        .catch((error) => {
          params.runtime.error?.(danger(`discord inbound worker failed: ${String(error)}`));
        });
    },
    deactivate: runState.deactivate,
  };
}
