// Discord plugin module dispatches inbound messages into the processing queue.
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import { danger } from "openclaw/plugin-sdk/runtime-env";
import { resolveOpenProviderRuntimeGroupPolicy } from "openclaw/plugin-sdk/runtime-group-policy";
import type { Client } from "../internal/discord.js";
import { buildDiscordInboundJob } from "./inbound-job.js";
import type {
  createDiscordIngressMonitor,
  DiscordIngressDispatchResult,
  DiscordIngressLifecycle,
} from "./ingress.js";
import type { DiscordMessageEvent } from "./listeners.js";
import { applyImplicitReplyBatchGate } from "./message-handler.batch-gate.js";
import type { DiscordMessagePreflightParams } from "./message-handler.preflight.types.js";
import {
  createDiscordMessageRunQueue,
  type DiscordMessageRunQueueTestingHooks,
} from "./message-run-queue.js";
import {
  hasDiscordMessageStickers,
  resolveDiscordMessageChannelId,
  resolveDiscordMessageText,
} from "./message-utils.js";
import type { DiscordMonitorStatusSink } from "./status.js";

type PreflightDiscordMessage =
  typeof import("./message-handler.preflight.js").preflightDiscordMessage;

type DiscordMessageHandlerParams = Omit<
  DiscordMessagePreflightParams,
  "ackReactionScope" | "groupPolicy" | "data" | "client"
> & {
  setStatus?: DiscordMonitorStatusSink;
  abortSignal?: AbortSignal;
  testing?: DiscordMessageHandlerTestingHooks;
};

type DiscordMessageHandlerTestingHooks = DiscordMessageRunQueueTestingHooks & {
  preflightDiscordMessage?: PreflightDiscordMessage;
  createIngressMonitor?: typeof createDiscordIngressMonitor;
};

const loadMessagePreflightRuntime = createLazyRuntimeModule(
  () => import("./message-handler.preflight.js"),
);

type DiscordMessageDispatcher = (
  data: DiscordMessageEvent,
  client: Client,
  options?: { abortSignal?: AbortSignal; turnAdoptionLifecycle?: DiscordIngressLifecycle },
) => Promise<DiscordIngressDispatchResult | void>;

type DiscordMessageDispatcherWithLifecycle = DiscordMessageDispatcher & {
  deactivate: () => Promise<void>;
};

type DiscordFlushIngressSettlement = {
  lifecycle: DiscordIngressLifecycle | undefined;
  settle: () => Promise<void>;
  abandon: (error?: unknown) => Promise<void>;
};

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function buildFlushIngressLifecycle(
  entries: Array<{ turnAdoptionLifecycle?: DiscordIngressLifecycle }>,
): DiscordFlushIngressSettlement {
  const lifecycles = entries
    .map((entry) => entry.turnAdoptionLifecycle)
    .filter((lifecycle) => lifecycle !== undefined);
  const [firstLifecycle] = lifecycles;
  if (!firstLifecycle) {
    return {
      lifecycle: undefined,
      settle: async () => {},
      abandon: async () => {},
    };
  }
  let handedOff = false;
  const adoptAll = async () => {
    for (const lifecycle of lifecycles) {
      await lifecycle.onAdopted();
    }
  };
  return {
    lifecycle: {
      abortSignal:
        lifecycles.length === 1
          ? firstLifecycle.abortSignal
          : AbortSignal.any(lifecycles.map((lifecycle) => lifecycle.abortSignal)),
      onAdopted: async () => {
        handedOff = true;
        await adoptAll();
      },
      onDeferred: () => {
        handedOff = true;
        for (const lifecycle of lifecycles) {
          lifecycle.onDeferred();
        }
      },
      onAdoptionFinalizing: () => {
        for (const lifecycle of lifecycles) {
          lifecycle.onAdoptionFinalizing();
        }
      },
      onAbandoned: async () => {
        handedOff = true;
        for (const lifecycle of lifecycles) {
          await lifecycle.onAbandoned();
        }
      },
    },
    // A gate or deliberate no-dispatch still consumes every merged queue row.
    settle: async () => {
      if (!handedOff) {
        await adoptAll();
      }
    },
    abandon: async () => {
      if (handedOff) {
        return;
      }
      handedOff = true;
      for (const lifecycle of lifecycles) {
        await lifecycle.onAbandoned();
      }
    },
  };
}

export function createDiscordMessageDispatcher(
  params: DiscordMessageHandlerParams,
): DiscordMessageDispatcherWithLifecycle {
  const { groupPolicy } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: params.cfg.channels?.discord !== undefined,
    groupPolicy: params.discordConfig?.groupPolicy,
    defaultGroupPolicy: params.cfg.channels?.defaults?.groupPolicy,
  });
  const ackReactionScope =
    params.discordConfig?.ackReactionScope ??
    params.cfg.messages?.ackReactionScope ??
    "group-mentions";
  const preflightDiscordMessageImpl = params.testing?.preflightDiscordMessage;
  const messageRunQueue = createDiscordMessageRunQueue({
    runtime: params.runtime,
    setStatus: params.setStatus,
    abortSignal: params.abortSignal,
    testing: params.testing,
  });
  const dispatcherShutdown = new AbortController();

  type DiscordDebounceEntry = {
    data: DiscordMessageEvent;
    client: Client;
    abortSignal?: AbortSignal;
    turnAdoptionLifecycle?: DiscordIngressLifecycle;
    debounceKey?: string;
  };
  const pendingDebounceEntries = new Set<DiscordDebounceEntry>();
  const pendingCancellationSettlements = new Set<Promise<void>>();
  const activeDebounceFlushes = new Set<Promise<void>>();
  const resolveDebounceKey = (entry: DiscordDebounceEntry) => {
    const message = entry.data.message;
    const authorId = entry.data.author?.id;
    if (!message || !authorId) {
      return null;
    }
    const channelId = resolveDiscordMessageChannelId({
      message,
      eventChannelId: entry.data.channel_id,
    });
    return channelId ? `discord:${params.accountId}:${channelId}:${authorId}` : null;
  };
  const { debouncer } = createChannelInboundDebouncer<DiscordDebounceEntry>({
    cfg: params.cfg,
    channel: "discord",
    buildKey: resolveDebounceKey,
    shouldDebounce: (entry) => {
      const message = entry.data.message;
      if (!message) {
        return false;
      }
      const baseText = resolveDiscordMessageText(message, { includeForwarded: false });
      return shouldDebounceTextInbound({
        text: baseText,
        cfg: params.cfg,
        hasMedia:
          (message.attachments && message.attachments.length > 0) ||
          hasDiscordMessageStickers(message),
      });
    },
    onFlush: async (entries) => {
      let resolveTrackedFlush!: () => void;
      const trackedFlush = new Promise<void>((resolve) => {
        resolveTrackedFlush = resolve;
      });
      activeDebounceFlushes.add(trackedFlush);
      try {
        for (const entry of entries) {
          pendingDebounceEntries.delete(entry);
        }
        const last = entries.at(-1);
        if (!last) {
          return;
        }
        const ingress = buildFlushIngressLifecycle(entries);
        const abortSignal = last.abortSignal;
        if (abortSignal?.aborted) {
          await ingress.abandon(abortSignal.reason);
          return;
        }
        try {
          if (entries.length === 1) {
            const preflight =
              preflightDiscordMessageImpl ??
              (await loadMessagePreflightRuntime()).preflightDiscordMessage;
            const ctx = await preflight({
              ...params,
              ackReactionScope,
              groupPolicy,
              abortSignal,
              data: last.data,
              client: last.client,
              turnAdoptionLifecycle: ingress.lifecycle,
            });
            if (abortSignal?.aborted) {
              await ingress.abandon(abortSignal.reason);
              return;
            }
            if (!ctx) {
              await ingress.settle();
              return;
            }
            applyImplicitReplyBatchGate(ctx, params.replyToMode, false);
            messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { ingressSettlement: ingress }));
            return;
          }
          const combinedBaseText = entries
            .map((entry) =>
              resolveDiscordMessageText(entry.data.message, { includeForwarded: false }),
            )
            .filter(Boolean)
            .join("\n");
          const syntheticMessage = Object.create(Object.getPrototypeOf(last.data.message), {
            ...Object.getOwnPropertyDescriptors(last.data.message),
            content: { value: combinedBaseText, enumerable: true, configurable: true },
            attachments: { value: [], enumerable: true, configurable: true },
            message_snapshots: {
              value: (last.data.message as { message_snapshots?: unknown }).message_snapshots,
              enumerable: true,
              configurable: true,
            },
            messageSnapshots: {
              value: (last.data.message as { messageSnapshots?: unknown }).messageSnapshots,
              enumerable: true,
              configurable: true,
            },
            rawData: {
              value: { ...(last.data.message as { rawData?: Record<string, unknown> }).rawData },
              enumerable: true,
              configurable: true,
            },
          }) as DiscordMessageEvent["message"];
          const syntheticData: DiscordMessageEvent = {
            ...last.data,
            message: syntheticMessage,
          };
          const preflight =
            preflightDiscordMessageImpl ??
            (await loadMessagePreflightRuntime()).preflightDiscordMessage;
          const ctx = await preflight({
            ...params,
            ackReactionScope,
            groupPolicy,
            abortSignal,
            data: syntheticData,
            client: last.client,
            turnAdoptionLifecycle: ingress.lifecycle,
          });
          if (abortSignal?.aborted) {
            await ingress.abandon(abortSignal.reason);
            return;
          }
          if (!ctx) {
            await ingress.settle();
            return;
          }
          applyImplicitReplyBatchGate(ctx, params.replyToMode, true);
          const ids = entries.map((entry) => entry.data.message?.id).filter(isNonEmptyString);
          if (ids.length > 0) {
            const ctxBatch = ctx as typeof ctx & {
              MessageSids?: string[];
              MessageSidFirst?: string;
              MessageSidLast?: string;
            };
            ctxBatch.MessageSids = ids;
            ctxBatch.MessageSidFirst = ids[0];
            ctxBatch.MessageSidLast = ids[ids.length - 1];
          }
          messageRunQueue.enqueue(buildDiscordInboundJob(ctx, { ingressSettlement: ingress }));
        } catch (error) {
          await ingress.abandon(error);
          throw error;
        }
      } finally {
        activeDebounceFlushes.delete(trackedFlush);
        resolveTrackedFlush();
      }
    },
    onError: (err) => {
      params.runtime.error(danger(`discord debounce flush failed: ${String(err)}`));
    },
    onCancel: (entries) => {
      for (const entry of entries) {
        pendingDebounceEntries.delete(entry);
        const settlement = Promise.resolve(entry.turnAdoptionLifecycle?.onAbandoned())
          .catch((error: unknown) => {
            params.runtime.error(
              danger(`discord ingress cancellation settlement failed: ${String(error)}`),
            );
          })
          .finally(() => {
            pendingCancellationSettlements.delete(settlement);
          });
        pendingCancellationSettlements.add(settlement);
      }
    },
  });

  const dispatchMessage = async (
    data: DiscordMessageEvent,
    client: Client,
    options?: { abortSignal?: AbortSignal; turnAdoptionLifecycle?: DiscordIngressLifecycle },
  ): Promise<DiscordIngressDispatchResult> => {
    try {
      if (dispatcherShutdown.signal.aborted || options?.abortSignal?.aborted) {
        // Shutdown/abort before dispatch must NOT complete: completing
        // tombstones a message that never ran, and a restarted drain would
        // skip it forever. Retryable releases the claim for replay.
        const reason = dispatcherShutdown.signal.aborted
          ? (dispatcherShutdown.signal.reason ?? new Error("discord dispatcher shut down"))
          : (options?.abortSignal?.reason ?? new Error("discord dispatch aborted"));
        return { kind: "failed-retryable", error: reason };
      }
      // Filter bot-own messages before they enter the debounce queue.
      // The same check exists in preflightDiscordMessage(), but by that point
      // the message has already consumed debounce capacity and blocked
      // legitimate user messages. On active servers this causes cumulative
      // slowdown (see #15874).
      const msgAuthorId = data.message?.author?.id ?? data.author?.id;
      if (params.botUserId && msgAuthorId === params.botUserId) {
        return { kind: "completed" };
      }
      const abortSignal = options?.abortSignal
        ? AbortSignal.any([options.abortSignal, dispatcherShutdown.signal])
        : dispatcherShutdown.signal;
      const entry: DiscordDebounceEntry = {
        data,
        client,
        abortSignal,
        turnAdoptionLifecycle: options?.turnAdoptionLifecycle,
      };
      const debounceKey = resolveDebounceKey(entry);
      if (debounceKey) {
        entry.debounceKey = debounceKey;
        pendingDebounceEntries.add(entry);
      }
      await debouncer.enqueue(entry);
      if (options?.turnAdoptionLifecycle) {
        return { kind: "deferred" };
      }
      return { kind: "completed" };
    } catch (err) {
      params.runtime.error(danger(`handler failed: ${String(err)}`));
      if (options?.turnAdoptionLifecycle) {
        throw err;
      }
      return { kind: "completed" };
    }
  };

  const handler: DiscordMessageDispatcherWithLifecycle = (data, client, options) => {
    const result = dispatchMessage(data, client, options);
    return options?.turnAdoptionLifecycle ? result : result.then(() => undefined);
  };

  handler.deactivate = async () => {
    dispatcherShutdown.abort(new Error("discord-message-handler-deactivated"));
    const pendingKeys = new Set(
      [...pendingDebounceEntries]
        .map((entry) => entry.debounceKey)
        .filter((key) => key !== undefined),
    );
    for (const key of pendingKeys) {
      debouncer.cancelKey(key);
    }
    pendingDebounceEntries.clear();
    await Promise.allSettled(pendingCancellationSettlements);
    await Promise.allSettled(activeDebounceFlushes);
    await messageRunQueue.deactivate();
  };

  return handler;
}
