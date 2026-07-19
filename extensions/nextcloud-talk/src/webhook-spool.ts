// Nextcloud Talk plugin module owns durable webhook admission and replay draining.
import {
  bindIngressLifecycleToReplyOptions,
  createChannelIngressDrain,
  DEFAULT_INGRESS_ADOPTION_STALL_MS,
  DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
  DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
  type ChannelIngressDrain,
  type ChannelIngressQueue,
} from "openclaw/plugin-sdk/channel-outbound";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { resolvePersistentDedupePluginStateNamespace } from "openclaw/plugin-sdk/persistent-dedupe";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { z } from "zod";
import {
  NEXTCLOUD_TALK_REPLAY_DEDUPE_MAX_ENTRIES,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
  NEXTCLOUD_TALK_REPLAY_DEDUPE_TTL_MS,
} from "./replay-migration-contract.js";
import { getNextcloudTalkRuntime } from "./runtime.js";
import type { NextcloudTalkInboundMessage, NextcloudTalkWebhookPayload } from "./types.js";
import {
  inspectNextcloudTalkWebhookEnvelope,
  migrateNextcloudTalkLegacyReplayState,
  NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION,
  NextcloudTalkWebhookPayloadError,
  parseRawObject,
  requiredString,
  type NextcloudTalkIngressPayload,
  type NextcloudTalkLegacyReplayEntry,
  type NextcloudTalkLegacyReplayStore,
} from "./webhook-spool-state.js";

const NEXTCLOUD_TALK_INGRESS_POLL_INTERVAL_MS = 500;
const NEXTCLOUD_TALK_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const NEXTCLOUD_TALK_INGRESS_COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const NEXTCLOUD_TALK_INGRESS_COMPLETED_MAX_ENTRIES = 10_000;
const NEXTCLOUD_TALK_INGRESS_FAILED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const NEXTCLOUD_TALK_INGRESS_FAILED_MAX_ENTRIES = 10_000;

const NextcloudTalkWebhookPayloadSchema: z.ZodType<NextcloudTalkWebhookPayload> = z.object({
  type: z.enum(["Create", "Update", "Delete"]),
  actor: z.object({
    type: z.literal("Person"),
    id: z.string().min(1),
    name: z.string(),
  }),
  object: z.object({
    type: z.literal("Note"),
    id: z.string().min(1),
    name: z.string(),
    content: z.string(),
    mediaType: z.string(),
  }),
  target: z.object({
    type: z.literal("Collection"),
    id: z.string().min(1),
    name: z.string(),
  }),
});

export type NextcloudTalkIngressLifecycle = Parameters<
  typeof bindIngressLifecycleToReplyOptions
>[0];

type NextcloudTalkIngressMonitor = {
  receive: (rawEvent: string) => Promise<"accepted" | "ignored">;
  ready: () => Promise<void>;
  stop: () => Promise<void>;
  waitForIdle: () => Promise<void>;
};

function parseClaimedMessage(
  payload: NextcloudTalkIngressPayload,
  claimedId: string,
  claimedLaneKey: string | undefined,
) {
  if (payload.version !== NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION) {
    throw new NextcloudTalkWebhookPayloadError(
      `Nextcloud Talk ingress row ${claimedId} has an unsupported version.`,
    );
  }
  const result = NextcloudTalkWebhookPayloadSchema.safeParse(parseRawObject(payload.rawEvent));
  if (!result.success || result.data.type !== "Create" || result.data.object.id !== claimedId) {
    throw new NextcloudTalkWebhookPayloadError(
      `Nextcloud Talk ingress row ${claimedId} has invalid message identity.`,
    );
  }
  const webhook = result.data;
  const roomId = requiredString(webhook.target.id, "target.id");
  if (claimedLaneKey !== `room:${roomId}`) {
    throw new NextcloudTalkWebhookPayloadError(
      `Nextcloud Talk ingress row ${claimedId} changed room identity.`,
    );
  }
  const message: NextcloudTalkInboundMessage = {
    messageId: webhook.object.id,
    roomToken: roomId,
    roomName: webhook.target.name,
    senderId: webhook.actor.id,
    senderName: webhook.actor.name,
    text: webhook.object.content || webhook.object.name,
    mediaType: webhook.object.mediaType || "text/plain",
    timestamp: payload.receivedAt,
    // Activity Streams does not distinguish Talk room kinds. Runtime lookup refines this.
    isGroupChat: true,
  };
  return message;
}

function resolveNonRetryableFailure(error: unknown) {
  if (error instanceof NextcloudTalkWebhookPayloadError) {
    return { reason: "invalid-event", message: error.message };
  }
  const message = formatErrorMessage(error);
  if (
    message.includes("Nextcloud Talk: bot send was rejected") ||
    message.includes("Nextcloud Talk: forbidden")
  ) {
    return { reason: "nextcloud-talk-auth", message };
  }
  return null;
}

export function createNextcloudTalkWebhookSpool(options: {
  accountId: string;
  queue?: ChannelIngressQueue<NextcloudTalkIngressPayload>;
  deliver: (
    message: NextcloudTalkInboundMessage,
    lifecycle: NextcloudTalkIngressLifecycle,
  ) => Promise<void>;
  runtime: Pick<RuntimeEnv, "error" | "log">;
  pollIntervalMs?: number;
  adoptionStallTimeoutMs?: number;
  abortSignal?: AbortSignal;
  legacyReplayStore?: NextcloudTalkLegacyReplayStore | null;
}): NextcloudTalkIngressMonitor {
  let queue = options.queue;
  let drain!: ChannelIngressDrain;
  let drainInitialized = false;
  let running = true;
  let requested = false;
  let pumping: Promise<void> | undefined;
  let lastPrunedAt = 0;
  const activeDeliveries = new Set<Promise<void>>();

  const getQueue = (): ChannelIngressQueue<NextcloudTalkIngressPayload> => {
    queue ??= getNextcloudTalkRuntime().state.openChannelIngressQueue<NextcloudTalkIngressPayload>({
      accountId: options.accountId,
    });
    return queue;
  };

  const legacyReplayStore =
    options.legacyReplayStore === null
      ? null
      : (options.legacyReplayStore ??
        getNextcloudTalkRuntime().state.openKeyedStore<NextcloudTalkLegacyReplayEntry>({
          namespace: resolvePersistentDedupePluginStateNamespace({
            namespace: options.accountId,
            namespacePrefix: NEXTCLOUD_TALK_REPLAY_DEDUPE_NAMESPACE_PREFIX,
          }),
          maxEntries: NEXTCLOUD_TALK_REPLAY_DEDUPE_MAX_ENTRIES,
          defaultTtlMs: NEXTCLOUD_TALK_REPLAY_DEDUPE_TTL_MS,
        }));
  const legacyMigration = legacyReplayStore
    ? migrateNextcloudTalkLegacyReplayState({ queue: getQueue(), store: legacyReplayStore })
    : Promise.resolve();

  const getDrain = (): ChannelIngressDrain => {
    if (!drainInitialized) {
      drain = createChannelIngressDrain<NextcloudTalkIngressPayload>({
        queue: getQueue(),
        adoptionStallTimeoutMs: options.adoptionStallTimeoutMs ?? DEFAULT_INGRESS_ADOPTION_STALL_MS,
        retryPolicy: {
          maxAttempts: DEFAULT_INGRESS_RETRY_MAX_ATTEMPTS,
          deadLetterMinAgeMs: DEFAULT_INGRESS_RETRY_DEAD_LETTER_MIN_AGE_MS,
        },
        resolveNonRetryableFailure,
        ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
        onLog: (message) => options.runtime.log?.(`nextcloud-talk ${message}`),
        dispatchClaimedEvent: async (record, lifecycle) => {
          if (lifecycle.abortSignal.aborted) {
            return {
              kind: "failed-retryable",
              error: new Error("Nextcloud Talk ingress stopped"),
            };
          }
          const message = parseClaimedMessage(record.payload, record.id, record.laneKey);
          let handedOff = false;
          let deferredHandoff = false;
          const delivery = options.deliver(message, {
            ...lifecycle,
            onAdopted: async () => {
              handedOff = true;
              await lifecycle.onAdopted();
            },
            onDeferred: () => {
              handedOff = true;
              deferredHandoff = true;
              lifecycle.onDeferred();
            },
            onAdoptionFinalizing: () => {
              handedOff = true;
              deferredHandoff = true;
              lifecycle.onAdoptionFinalizing();
            },
            onAbandoned: async () => {
              handedOff = true;
              await lifecycle.onAbandoned();
            },
          });
          activeDeliveries.add(delivery);
          try {
            await delivery;
            // Policy gates and empty messages are terminal, successful no-dispatch turns.
            if (!handedOff) {
              await lifecycle.onAdopted();
            }
          } finally {
            activeDeliveries.delete(delivery);
          }
          return deferredHandoff ? { kind: "deferred" } : undefined;
        },
      });
      drainInitialized = true;
    }
    return drain;
  };

  const pruneIfDue = async (): Promise<void> => {
    const now = Date.now();
    if (now - lastPrunedAt < NEXTCLOUD_TALK_INGRESS_PRUNE_INTERVAL_MS) {
      return;
    }
    await getQueue().prune({
      completedTtlMs: NEXTCLOUD_TALK_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: NEXTCLOUD_TALK_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: NEXTCLOUD_TALK_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: NEXTCLOUD_TALK_INGRESS_FAILED_MAX_ENTRIES,
      now,
    });
    lastPrunedAt = now;
  };

  const runPump = async (): Promise<void> => {
    try {
      await legacyMigration;
      for (;;) {
        requested = false;
        await pruneIfDue();
        if (!running) {
          break;
        }
        const activeDrain = getDrain();
        const { started } = await activeDrain.drainOnce();
        await activeDrain.waitForIdle();
        if (!running || (!requested && started === 0)) {
          break;
        }
      }
    } catch (error) {
      options.runtime.error?.(`nextcloud-talk ingress drain failed: ${formatErrorMessage(error)}`);
    } finally {
      pumping = undefined;
      if (running && requested) {
        requestDrain();
      }
    }
  };

  const requestDrain = (): void => {
    requested = true;
    if (!running || pumping) {
      return;
    }
    pumping = runPump();
  };

  const timer = setInterval(
    requestDrain,
    options.pollIntervalMs ?? NEXTCLOUD_TALK_INGRESS_POLL_INTERVAL_MS,
  );
  timer.unref?.();
  requestDrain();

  // Webhook handlers can overlap. Preserve room arrival order across append backoff.
  let admissionTail: Promise<void> = Promise.resolve();

  const admitOnce = async (rawEvent: string): Promise<"accepted" | "ignored"> => {
    await legacyMigration;
    const facts = inspectNextcloudTalkWebhookEnvelope(rawEvent);
    if (!facts) {
      return "ignored";
    }
    const receivedAt = Date.now();
    let lastError: unknown;
    for (const delayMs of [0, 100, 300]) {
      if (delayMs > 0) {
        await new Promise((resolve) => {
          setTimeout(resolve, delayMs);
        });
      }
      try {
        await getQueue().enqueue(
          facts.eventId,
          {
            version: NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION,
            receivedAt,
            rawEvent,
          },
          { receivedAt, laneKey: facts.laneKey },
        );
        requestDrain();
        return "accepted";
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  };

  return {
    ready: async () => {
      await legacyMigration;
    },
    receive: (rawEvent) => {
      const admission = admissionTail.then(() => admitOnce(rawEvent));
      admissionTail = admission.then(
        () => undefined,
        () => undefined,
      );
      return admission;
    },
    stop: async () => {
      running = false;
      clearInterval(timer);
      await admissionTail;
      await legacyMigration.catch(() => undefined);
      if (drainInitialized) {
        drain.dispose();
      }
      await pumping;
      if (drainInitialized) {
        drain.dispose();
      }
      await Promise.allSettled(activeDeliveries);
      if (drainInitialized) {
        await drain.waitForIdle();
      }
    },
    waitForIdle: async () => {
      for (;;) {
        const activePump = pumping;
        if (!activePump) {
          break;
        }
        await activePump;
      }
      if (drainInitialized) {
        await drain.waitForIdle();
      }
    },
  };
}
