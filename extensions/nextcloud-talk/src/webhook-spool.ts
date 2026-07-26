// Nextcloud Talk plugin module owns durable webhook admission and replay draining.
import {
  createChannelIngressMonitor,
  type ChannelIngressQueue,
  type ChannelIngressMonitorLifecycle,
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

export type NextcloudTalkIngressLifecycle = Omit<ChannelIngressMonitorLifecycle, "admission">;

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

  const monitor = createChannelIngressMonitor<
    string,
    Omit<NextcloudTalkIngressPayload, "version">,
    NextcloudTalkIngressPayload
  >({
    queue: getQueue,
    inspect: (rawEvent) => inspectNextcloudTalkWebhookEnvelope(rawEvent),
    payload: {
      version: NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION,
      serialize: (rawEvent, { receivedAt }) => ({ receivedAt, rawEvent }),
      deserialize: (body) => body.rawEvent,
      encode: ({ body }) => ({ version: NEXTCLOUD_TALK_INGRESS_PAYLOAD_VERSION, ...body }),
      decode: (payload) => ({
        version: payload.version,
        body: { receivedAt: payload.receivedAt, rawEvent: payload.rawEvent },
      }),
      createClaimError: (kind, claim) =>
        new NextcloudTalkWebhookPayloadError(
          kind === "invalid-version"
            ? `Nextcloud Talk ingress row ${claim.id} has an unsupported version.`
            : `Nextcloud Talk ingress row ${claim.id} has invalid message identity.`,
        ),
    },
    deliver: async (_rawEvent, lifecycle, claim) => {
      const message = parseClaimedMessage(claim.payload, claim.id, claim.laneKey);
      // The shared monitor translates these lifecycle callbacks into terminal or deferred
      // drain outcomes, including successful no-dispatch policy gates.
      await options.deliver(message, lifecycle);
    },
    pollIntervalMs: options.pollIntervalMs ?? NEXTCLOUD_TALK_INGRESS_POLL_INTERVAL_MS,
    // Preserve Nextcloud Talk's existing one-drain-at-a-time delivery cycle.
    waitForDeliveryIdleBeforeRepump: true,
    retention: {
      pruneIntervalMs: NEXTCLOUD_TALK_INGRESS_PRUNE_INTERVAL_MS,
      completedTtlMs: NEXTCLOUD_TALK_INGRESS_COMPLETED_TTL_MS,
      completedMaxEntries: NEXTCLOUD_TALK_INGRESS_COMPLETED_MAX_ENTRIES,
      failedTtlMs: NEXTCLOUD_TALK_INGRESS_FAILED_TTL_MS,
      failedMaxEntries: NEXTCLOUD_TALK_INGRESS_FAILED_MAX_ENTRIES,
    },
    drain: {
      resolveNonRetryableFailure,
      ...(options.adoptionStallTimeoutMs === undefined
        ? {}
        : { adoptionStallTimeoutMs: options.adoptionStallTimeoutMs }),
      onLog: (message) => options.runtime.log?.(`nextcloud-talk ${message}`),
    },
    ...(options.abortSignal ? { abortSignal: options.abortSignal } : {}),
    createStoppedError: () => new Error("Nextcloud Talk ingress stopped"),
    onError: (error) =>
      options.runtime.error?.(`nextcloud-talk ingress drain failed: ${formatErrorMessage(error)}`),
  });
  let stopping = false;
  const inFlightReceives = new Set<Promise<"accepted" | "ignored">>();
  const startAfterMigration = legacyMigration.then(() => {
    if (!stopping) {
      monitor.start();
    }
  });

  return {
    ready: async () => await startAfterMigration,
    receive: (rawEvent) => {
      if (stopping) {
        return Promise.reject(new Error("Nextcloud Talk ingress stopped"));
      }
      const receiveTask = (async () => {
        await startAfterMigration;
        const result = await monitor.admit(rawEvent);
        return result.kind === "ignored" ? "ignored" : "accepted";
      })();
      inFlightReceives.add(receiveTask);
      void receiveTask.then(
        () => inFlightReceives.delete(receiveTask),
        () => inFlightReceives.delete(receiveTask),
      );
      return receiveTask;
    },
    stop: async () => {
      stopping = true;
      const pendingReceives = [...inFlightReceives];
      // Quiesce synchronously, but let callbacks accepted before stop finish durable admission.
      const pauseTask = monitor.pause();
      await startAfterMigration.catch(() => undefined);
      await Promise.allSettled(pendingReceives);
      await monitor.stop();
      await pauseTask;
    },
    waitForIdle: async () => {
      await startAfterMigration.catch(() => undefined);
      await monitor.waitForIdle();
    },
  };
}
