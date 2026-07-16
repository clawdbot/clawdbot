// Discord plugin module implements message run queue behavior.
import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { DiscordRetryableInboundError } from "./inbound-dedupe.js";
import { materializeDiscordInboundJob, type DiscordInboundJob } from "./inbound-job.js";
import type { RuntimeEnv } from "./message-handler.preflight.types.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type ProcessDiscordMessage = typeof import("./message-handler.process.js").processDiscordMessage;

type DiscordMessageRunQueueParams = {
  runtime: RuntimeEnv;
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
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

const loadMessageProcessRuntime = createLazyRuntimeModule(
  () => import("./message-handler.process.js"),
);

async function processDiscordQueuedMessage(params: {
  job: DiscordInboundJob;
  lifecycleSignal?: AbortSignal;
  testing?: DiscordMessageRunQueueTestingHooks;
}) {
  const processDiscordMessageImpl =
    params.testing?.processDiscordMessage ??
    (await loadMessageProcessRuntime()).processDiscordMessage;
  const abortSignal =
    params.job.runtime.abortSignal && params.lifecycleSignal
      ? AbortSignal.any([params.job.runtime.abortSignal, params.lifecycleSignal])
      : (params.job.runtime.abortSignal ?? params.lifecycleSignal);
  try {
    await processDiscordMessageImpl(materializeDiscordInboundJob(params.job, abortSignal));
    await Promise.all(params.job.replayClaims?.map((claim) => claim.commit()) ?? []);
  } catch (error) {
    if (error instanceof DiscordRetryableInboundError) {
      for (const claim of params.job.replayClaims ?? []) {
        claim.release({ error });
      }
    } else {
      await Promise.all(params.job.replayClaims?.map((claim) => claim.commit()) ?? []);
    }
    throw error;
  }
}

function cleanupSkippedDiscordQueuedMessage(params: { job: DiscordInboundJob }) {
  // Typing feedback is created inside processing after admission, so skipped
  // jobs only carry replay claims that need reopening for a later retry.
  for (const claim of params.job.replayClaims ?? []) {
    claim.release({
      error: new DiscordRetryableInboundError("discord queued run skipped before processing"),
    });
  }
}

export function createDiscordMessageRunQueue(
  params: DiscordMessageRunQueueParams,
): DiscordMessageRunQueue {
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
        cleanupSkippedDiscordQueuedMessage({ job });
      };
      if (!lifecycleActive) {
        cleanupSkipped();
        return;
      }
      skippedCleanup.add(cleanupSkipped);
      runQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {
        // Once the task starts, normal process/commit handling owns cleanup.
        // Leaving it in skippedCleanup would double-release replay state.
        skippedCleanup.delete(cleanupSkipped);
        await processDiscordQueuedMessage({
          job,
          lifecycleSignal,
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
