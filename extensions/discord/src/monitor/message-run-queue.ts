import { createChannelRunQueue } from "openclaw/plugin-sdk/channel-lifecycle";
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
  __testing?: DiscordMessageRunQueueTestingHooks;
};

type DiscordMessageRunQueue = {
  enqueue: (job: DiscordInboundJob) => void;
  deactivate: () => void;
};

export type DiscordMessageRunQueueTestingHooks = {
  processDiscordMessage?: ProcessDiscordMessage;
};

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

export function createDiscordMessageRunQueue(
  params: DiscordMessageRunQueueParams,
): DiscordMessageRunQueue {
  const replayGuard = params.replayGuard ?? createDiscordInboundReplayGuard();
  const runQueue = createChannelRunQueue({
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    onError: (error) => {
      params.runtime.error?.(danger(`discord message run failed: ${String(error)}`));
    },
  });

  return {
    enqueue(job) {
      runQueue.enqueue(job.queueKey, async ({ lifecycleSignal }) => {
        await processDiscordQueuedMessage({
          job,
          lifecycleSignal,
          replayGuard,
          testing: params.__testing,
        });
      });
    },
    deactivate: runQueue.deactivate,
  };
}
