import { fanInChannelIngressLifecycles } from "openclaw/plugin-sdk/channel-ingress-runtime";
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

type QueuedDiscordInboundJob = {
  job: DiscordInboundJob;
  cleanupSkipped: SkippedQueuedMessageCleanup;
  settlePending: () => void;
};

type DiscordQueueLane = {
  jobs: QueuedDiscordInboundJob[];
  scheduled: boolean;
};

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function combineAbortSignals(
  signals: readonly (AbortSignal | undefined)[],
): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) {
    return undefined;
  }
  return present.length === 1 ? present[0] : AbortSignal.any(present);
}

function cloneDiscordMessageWithContent<T extends object>(message: T, content: string): T {
  return Object.create(Object.getPrototypeOf(message), {
    ...Object.getOwnPropertyDescriptors(message),
    content: { value: content, enumerable: true, configurable: true },
  }) as T;
}

function getDiscordMessageId(job: DiscordInboundJob): string | undefined {
  return nonEmptyString((job.payload.message as { id?: unknown }).id);
}

function getDiscordReplyIdentity(job: DiscordInboundJob): string {
  const message = job.payload.message as unknown as Record<string, unknown>;
  const referenceRaw = message.message_reference ?? message.referenced_message;
  const reference =
    referenceRaw && typeof referenceRaw === "object"
      ? (referenceRaw as Record<string, unknown>)
      : undefined;
  return JSON.stringify({
    messageId: nonEmptyString(reference?.message_id ?? reference?.id),
    channelId: nonEmptyString(reference?.channel_id),
    guildId: nonEmptyString(reference?.guild_id),
  });
}

function getDiscordQueuedBatchCompatibilityKey(job: DiscordInboundJob): string {
  return JSON.stringify({
    accountId: job.payload.accountId,
    authorId: nonEmptyString(job.payload.author?.id),
    baseSessionKey: job.payload.baseSessionKey,
    boundSessionKey: job.payload.boundSessionKey,
    channelId: job.payload.messageChannelId,
    commandAuthorized: job.payload.commandAuthorized,
    effectiveWasMentioned: job.payload.effectiveWasMentioned,
    inboundEventKind: job.payload.inboundEventKind,
    isDirectMessage: job.payload.isDirectMessage,
    isGroupDm: job.payload.isGroupDm,
    reply: getDiscordReplyIdentity(job),
    replyToMode: job.payload.replyToMode,
    route: {
      accountId: job.payload.route.accountId,
      agentId: job.payload.route.agentId,
      channel: job.payload.route.channel,
      dmScope: job.payload.route.dmScope,
      sessionKey: job.payload.route.sessionKey,
    },
    senderId: nonEmptyString(job.payload.sender?.id),
    threadChannelId: job.payload.threadChannel?.id,
    threadParentId: job.payload.threadParentId,
  });
}

function splitDiscordQueuedBatchByCompatibility(
  entries: readonly QueuedDiscordInboundJob[],
): QueuedDiscordInboundJob[][] {
  const groups: QueuedDiscordInboundJob[][] = [];
  let currentKey: string | undefined;
  for (const entry of entries) {
    const key = getDiscordQueuedBatchCompatibilityKey(entry.job);
    if (key !== currentKey) {
      groups.push([]);
      currentKey = key;
    }
    groups.at(-1)!.push(entry);
  }
  return groups;
}

function formatDiscordQueuedBatchText(jobs: readonly DiscordInboundJob[]): string {
  const parts = jobs.map((job, index) => {
    const messageId = getDiscordMessageId(job) ?? "unknown";
    const text = (job.payload.preflightAudioTranscript ?? job.payload.messageText).trim();
    const body =
      text ||
      (job.payload.preparedMedia.length > 0
        ? `[media-only Discord message with ${job.payload.preparedMedia.length} attachment(s)]`
        : "[empty Discord message]");
    return `Message ${index + 1}/${jobs.length} [id:${messageId}]\n${body}`;
  });
  return [
    "[Queued Discord messages received while a previous turn was active. Treat this as one current request batch in chronological order.]",
    ...parts,
  ].join("\n\n");
}

function mergeDiscordQueuedJobs(jobs: readonly DiscordInboundJob[]): DiscordInboundJob {
  if (jobs.length === 0) {
    throw new Error("discord queued batch cannot be empty");
  }
  if (jobs.length === 1) {
    return jobs[0]!;
  }
  const first = jobs[0]!;
  const last = jobs.at(-1)!;
  const combinedText = formatDiscordQueuedBatchText(jobs);
  const combinedMessage = cloneDiscordMessageWithContent(last.payload.message, combinedText);
  const ids = jobs
    .map((job) => getDiscordMessageId(job))
    .filter((id): id is string => id !== undefined);
  const ingress = fanInChannelIngressLifecycles(
    jobs.map((job) => job.runtime.turnAdoptionLifecycle),
  );
  const mergedPayload = {
    ...last.payload,
    message: combinedMessage,
    data: {
      ...last.payload.data,
      message: combinedMessage,
    },
    baseText: combinedText,
    messageText: combinedText,
    preflightAudioTranscript: undefined,
    preparedMedia: jobs.flatMap((job) => job.payload.preparedMedia),
  };
  if (ids.length > 0) {
    mergedPayload.batchMessageIds = ids;
    mergedPayload.batchMessageIdFirst = ids[0];
    mergedPayload.batchMessageIdLast = ids[ids.length - 1];
  }

  return {
    queueKey: first.queueKey,
    payload: mergedPayload,
    runtime: {
      ...last.runtime,
      abortSignal: combineAbortSignals(jobs.map((job) => job.runtime.abortSignal)),
      turnAdoptionLifecycle: ingress.lifecycle,
    },
    ingressSettlement: ingress,
  };
}

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
  const lanes = new Map<string, DiscordQueueLane>();
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

  const scheduleLane = (queueKey: string, lane: DiscordQueueLane) => {
    if (lane.scheduled) {
      return;
    }
    lane.scheduled = true;
    runQueue.enqueue(queueKey, async ({ lifecycleSignal }) => {
      try {
        for (;;) {
          if (!lifecycleActive) {
            break;
          }
          const batchEntries = lane.jobs.splice(0);
          if (batchEntries.length === 0) {
            break;
          }
          let firstError: unknown;
          for (const batch of splitDiscordQueuedBatchByCompatibility(batchEntries)) {
            for (const entry of batch) {
              skippedCleanup.delete(entry.cleanupSkipped);
            }
            try {
              await processDiscordQueuedMessage({
                job: mergeDiscordQueuedJobs(batch.map((entry) => entry.job)),
                lifecycleSignal,
                testing: params.testing,
              });
            } catch (error) {
              firstError ??= error;
            } finally {
              for (const entry of batch) {
                entry.settlePending();
              }
            }
          }
          if (firstError) {
            throw firstError;
          }
        }
      } finally {
        lane.scheduled = false;
        if (lane.jobs.length > 0 && lifecycleActive) {
          scheduleLane(queueKey, lane);
        } else if (lane.jobs.length === 0) {
          lanes.delete(queueKey);
        }
      }
    });
  };

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
        } catch (error) {
          // Durable release is best-effort during shutdown. One failed claim
          // must not strand the remaining accepted jobs or their pending tasks.
          try {
            params.runtime.error(danger(`discord queued message cleanup failed: ${String(error)}`));
          } catch {
            // Error reporting must not interrupt the remaining cleanup owners.
          }
        } finally {
          settlePending();
        }
      };
      if (!lifecycleActive) {
        void cleanupSkipped();
        return;
      }
      skippedCleanup.add(cleanupSkipped);
      const lane = lanes.get(job.queueKey) ?? { jobs: [], scheduled: false };
      lanes.set(job.queueKey, lane);
      lane.jobs.push({
        job,
        cleanupSkipped,
        settlePending,
      });
      scheduleLane(job.queueKey, lane);
    },
    async deactivate() {
      runQueue.deactivate();
      await cleanupSkippedQueuedMessages();
      await Promise.allSettled(pendingTasks);
    },
  };
}
