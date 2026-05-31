import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-outbound";
import type { ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import {
  commitDiscordInboundReplay,
  createDiscordInboundReplayGuard,
  DiscordRetryableInboundError,
  releaseDiscordInboundReplay,
} from "./inbound-dedupe.js";
import { materializeDiscordInboundJob, type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";
import { mergeAbortSignals } from "./timeouts.js";

type ProcessDiscordMessage = typeof import("./message-handler.process.js").processDiscordMessage;

type DiscordMessageRunQueueParams = {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  replayGuard?: ClaimableDedupe;
  testing?: DiscordMessageRunQueueTestingHooks;
};

type DiscordMessageRunQueue = {
  enqueue: (job: DiscordInboundJob) => void;
  deactivate: () => void;
};

export type DiscordMessageRunQueueTestingHooks = {
  processDiscordMessage?: ProcessDiscordMessage;
};

type SkippedQueuedMessageCleanup = () => void;

let messageProcessRuntimePromise:
  | Promise<typeof import("./message-handler.process.js")>
  | undefined;

async function loadMessageProcessRuntime() {
  messageProcessRuntimePromise ??= import("./message-handler.process.js");
  return await messageProcessRuntimePromise;
}

async function processDiscordQueuedMessage(params: {
  job: DiscordInboundJob;
  lifecycleSignal?: AbortSignal;
  replayGuard: ClaimableDedupe;
  testing?: DiscordMessageRunQueueTestingHooks;
}) {
  const processDiscordMessageImpl =
    params.testing?.processDiscordMessage ??
    (await loadMessageProcessRuntime()).processDiscordMessage;
  const abortSignal = mergeAbortSignals([params.job.runtime.abortSignal, params.lifecycleSignal]);
  try {
    await processDiscordMessageImpl(materializeDiscordInboundJob(params.job, abortSignal));
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

function cleanupSkippedDiscordQueuedMessage(params: {
  job: DiscordInboundJob;
  replayGuard: ClaimableDedupe;
}) {
  try {
    // Skipped jobs never reach processDiscordMessage's finally block.
    // Clean carried typing here before reopening the replay key for retry.
    params.job.runtime.replyTypingFeedback?.onCleanup?.();
  } finally {
    releaseDiscordInboundReplay({
      replayKeys: params.job.replayKeys,
      error: new DiscordRetryableInboundError("discord queued run skipped before processing"),
      replayGuard: params.replayGuard,
    });
  }
}

export function createDiscordMessageRunQueue(
  params: DiscordMessageRunQueueParams,
): DiscordMessageRunQueue {
  const replayGuard = params.replayGuard ?? createDiscordInboundReplayGuard();
  const skippedCleanup = new Set<SkippedQueuedMessageCleanup>();
  const runQueue = createChannelRunQueue({
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    onError: (error) => {
      params.runtime.error(danger(`discord message run failed: ${String(error)}`));
    },
  });
  let lifecycleActive = !params.abortSignal?.aborted;

  const cleanupSkippedQueuedMessages = () => {
    // These callbacks represent jobs accepted into the queue but not started.
    // Running jobs remove their callback before processDiscordMessage owns cleanup.
    if (!lifecycleActive && skippedCleanup.size === 0) {
      return;
    }
    lifecycleActive = false;
    const cleanups = [...skippedCleanup];
    skippedCleanup.clear();
    for (const cleanup of cleanups) {
      cleanup();
    }
  };

  if (params.abortSignal?.aborted) {
    cleanupSkippedQueuedMessages();
  } else {
    params.abortSignal?.addEventListener("abort", cleanupSkippedQueuedMessages, { once: true });
  }

  return {
    enqueue(job) {
      const cleanupSkipped = () => {
        cleanupSkippedDiscordQueuedMessage({ job, replayGuard });
      };
      if (!lifecycleActive) {
        cleanupSkipped();
        return;
      }
      skippedCleanup.add(cleanupSkipped);
      runQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {
        // Once the task starts, normal process/commit handling owns cleanup.
        // Leaving it in skippedCleanup would double-release replay/typing state.
        skippedCleanup.delete(cleanupSkipped);
        await processDiscordQueuedMessage({
          job,
          lifecycleSignal,
          replayGuard,
          testing: params.testing,
        });
      });
    },
    deactivate() {
      runQueue.deactivate();
      cleanupSkippedQueuedMessages();
    },
  };
}
