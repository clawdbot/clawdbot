// Discord plugin module implements message run queue behavior.
import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-outbound";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
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
  deactivate: () => Promise<void>;
};

export type DiscordMessageRunQueueTestingHooks = {
  processDiscordMessage?: ProcessDiscordMessage;
};

type SkippedQueuedMessageCleanup = () => Promise<void>;

const loadMessageProcessRuntime = createLazyRuntimeModule(
  () => import("./message-handler.process.js"),
);

async function processDiscordQueuedMessage(params: {
  job: DiscordInboundJob;
  lifecycleSignal?: AbortSignal;
  testing?: DiscordMessageRunQueueTestingHooks;
}) {
  const abortSignal =
    params.job.runtime.abortSignal && params.lifecycleSignal
      ? AbortSignal.any([params.job.runtime.abortSignal, params.lifecycleSignal])
      : (params.job.runtime.abortSignal ?? params.lifecycleSignal);
  try {
    const processDiscordMessageImpl =
      params.testing?.processDiscordMessage ??
      (await loadMessageProcessRuntime()).processDiscordMessage;
    await processDiscordMessageImpl(materializeDiscordInboundJob(params.job, abortSignal));
    if (abortSignal?.aborted) {
      await params.job.ingressSettlement?.abandon(abortSignal.reason);
    } else {
      await params.job.ingressSettlement?.settle();
    }
  } catch (error) {
    await params.job.ingressSettlement?.abandon(error);
    throw error;
  }
}

async function cleanupSkippedDiscordQueuedMessage(params: { job: DiscordInboundJob }) {
  // A skipped job never reached reply-lane adoption; reopen its durable claim.
  await params.job.ingressSettlement?.abandon(
    new Error("discord queued run skipped before processing"),
  );
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
  const pendingTasks = new Set<Promise<void>>();
  const onAbort = () => void cleanupSkippedQueuedMessages();

  async function cleanupSkippedQueuedMessages() {
    params.abortSignal?.removeEventListener("abort", onAbort);
    // These callbacks represent jobs accepted into the queue but not started.
    // Running jobs remove their callback before processDiscordMessage owns cleanup.
    if (!lifecycleActive && skippedCleanup.size === 0) {
      return;
    }
    lifecycleActive = false;
    const cleanups = [...skippedCleanup];
    skippedCleanup.clear();
    for (const cleanup of cleanups) {
      await cleanup();
    }
  }

  if (params.abortSignal?.aborted) {
    void cleanupSkippedQueuedMessages();
  } else {
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  }

  return {
    enqueue(job) {
      let resolvePending!: () => void;
      const pending = new Promise<void>((resolve) => {
        resolvePending = resolve;
      });
      pendingTasks.add(pending);
      const settlePending = () => {
        pendingTasks.delete(pending);
        resolvePending();
      };
      const cleanupSkipped = async () => {
        try {
          await cleanupSkippedDiscordQueuedMessage({ job });
        } finally {
          settlePending();
        }
      };
      if (!lifecycleActive) {
        void cleanupSkipped();
        return;
      }
      skippedCleanup.add(cleanupSkipped);
      runQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {
        // Once the task starts, normal process/commit handling owns cleanup.
        // Leaving it in skippedCleanup would double-release replay state.
        skippedCleanup.delete(cleanupSkipped);
        try {
          await processDiscordQueuedMessage({
            job,
            lifecycleSignal,
            testing: params.testing,
          });
        } finally {
          settlePending();
        }
      });
    },
    async deactivate() {
      runQueue.deactivate();
      await cleanupSkippedQueuedMessages();
      await Promise.allSettled(pendingTasks);
    },
  };
}
