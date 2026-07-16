// Slack plugin module implements message handler behavior.
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import {
  asDateTimestampMs,
  resolveExpiresAtMsFromDurationMs,
} from "openclaw/plugin-sdk/number-runtime";
import type { ResolvedSlackAccount } from "../accounts.js";
import type { SlackSendIdentity } from "../send.js";
import type { SlackMessageEvent } from "../types.js";
import { stripSlackMentionsForCommandDetection } from "./commands.js";
import type { SlackMonitorContext } from "./context.js";
import type { SlackEventScope } from "./event-scope.js";
import {
  hasSlackInboundMessageDelivery,
  recordSlackInboundMessageDeliveries,
} from "./inbound-delivery-state.js";
import {
  buildSlackDebounceKey,
  buildTopLevelSlackConversationKey,
} from "./message-handler/debounce-key.js";
import type { PreparedSlackMessage } from "./message-handler/types.js";
import { createSlackThreadTsResolver } from "./thread-resolution.js";

const loadSlackMessagePipeline = createLazyRuntimeModule(
  () => import("./message-handler/pipeline.runtime.js"),
);

export type SlackMessageHandler = (
  message: SlackMessageEvent,
  opts: {
    source: "message" | "app_mention";
    wasMentioned?: boolean;
    relayIdentity?: SlackSendIdentity;
    /** Non-serializable listener scope for a validated enterprise event. */
    eventScope?: SlackEventScope;
    /** Wait until any inbound debounce flush and dispatch has completed. */
    awaitDispatch?: boolean;
  },
) => Promise<void>;

type SlackDispatchCompletion = {
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
};

type IngressSlackMessageOptions = Parameters<SlackMessageHandler>[1] & {
  retryAttempt?: number;
};

type QueuedSlackMessageOptions = IngressSlackMessageOptions & {
  dispatchCompletion?: Omit<SlackDispatchCompletion, "promise">;
};

function createSlackDispatchCompletion(): SlackDispatchCompletion {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

const APP_MENTION_RETRY_TTL_MS = 60_000;
const RETRYABLE_FLUSH_MAX_ATTEMPTS = 3;
const RETRYABLE_FLUSH_RETRY_DELAY_MS = 1_000;
const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;

function isRetryableSlackInboundError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause, current.error]).some(
    (candidate) => REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(formatErrorMessage(candidate)),
  );
}

function shouldDebounceSlackMessage(message: SlackMessageEvent, cfg: SlackMonitorContext["cfg"]) {
  const text = message.text ?? "";
  const textForCommandDetection = stripSlackMentionsForCommandDetection(text);
  return shouldDebounceTextInbound({
    text: textForCommandDetection,
    cfg,
    hasMedia: Boolean(message.files && message.files.length > 0),
  });
}

function buildSeenMessageKey(
  channelId: string | undefined,
  ts: string | undefined,
  teamId?: string,
): string | null {
  if (!channelId || !ts) {
    return null;
  }
  return `${teamId ? `${teamId}:` : ""}${channelId}:${ts}`;
}

export function createSlackMessageHandler(params: {
  ctx: SlackMonitorContext;
  account: ResolvedSlackAccount;
  /** Called on each inbound event to update liveness tracking. */
  trackEvent?: () => void;
  /** Called after access/routing preparation accepts a human message. */
  onPrepared?: (prepared: PreparedSlackMessage) => void;
}): SlackMessageHandler {
  const { ctx, account, trackEvent, onPrepared } = params;
  const { debounceMs, debouncer } = createChannelInboundDebouncer<{
    message: SlackMessageEvent;
    opts: QueuedSlackMessageOptions;
  }>({
    cfg: ctx.cfg,
    channel: "slack",
    buildKey: (entry) =>
      buildSlackDebounceKey(entry.message, ctx.accountId, entry.opts.eventScope?.teamId),
    shouldDebounce: (entry) =>
      !entry.opts.eventScope && shouldDebounceSlackMessage(entry.message, ctx.cfg),
    onFlush: async (entries) => {
      const retryEntries = (sourceError: unknown): boolean => {
        if (
          !isRetryableSlackInboundError(sourceError) ||
          entries.some((entry) => entry.opts.eventScope)
        ) {
          return false;
        }
        const nextEntries = entries
          .map((entry) => {
            // Relay delivery owns retry until its dispatch completion is acknowledged.
            // Scheduling here as well can race the router redelivery and duplicate a reply.
            if (entry.opts.dispatchCompletion) {
              return null;
            }
            const retryAttempt = entry.opts.retryAttempt ?? 0;
            if (retryAttempt >= RETRYABLE_FLUSH_MAX_ATTEMPTS) {
              return null;
            }
            const { dispatchCompletion: _dispatchCompletion, ...retryOpts } = entry.opts;
            return {
              ...entry,
              opts: {
                ...retryOpts,
                retryAttempt: retryAttempt + 1,
              },
            };
          })
          .filter((entry) => entry !== null);
        if (nextEntries.length === 0) {
          return false;
        }
        const retryTimer = setTimeout(() => {
          for (const entry of nextEntries) {
            // Re-enter ingress so a relay replay or another successful attempt wins
            // through the normal delivery and seen-message gates before dispatch.
            void enqueueSlackMessage(entry.message, entry.opts).catch((err: unknown) => {
              ctx.runtime.error?.(`slack inbound retry enqueue failed: ${formatErrorMessage(err)}`);
            });
          }
        }, RETRYABLE_FLUSH_RETRY_DELAY_MS);
        retryTimer.unref?.();
        return true;
      };
      const completions = entries
        .map((entry) => entry.opts.dispatchCompletion)
        .filter((completion) => completion !== undefined);
      try {
        await (async () => {
          const last = entries.at(-1);
          if (!last) {
            return;
          }
          const teamId = last.opts.eventScope?.teamId;
          const flushedKey = buildSlackDebounceKey(last.message, ctx.accountId, teamId);
          const topLevelConversationKey = buildTopLevelSlackConversationKey(
            last.message,
            ctx.accountId,
            teamId,
          );
          if (flushedKey && topLevelConversationKey) {
            const pendingKeys = pendingTopLevelDebounceKeys.get(topLevelConversationKey);
            if (pendingKeys) {
              pendingKeys.delete(flushedKey);
              if (pendingKeys.size === 0) {
                pendingTopLevelDebounceKeys.delete(topLevelConversationKey);
              }
            }
          }
          const combinedText =
            entries.length === 1
              ? (last.message.text ?? "")
              : entries
                  .map((entry) => entry.message.text ?? "")
                  .filter(Boolean)
                  .join("\n");
          const combinedMentioned = entries.some((entry) => Boolean(entry.opts.wasMentioned));
          const syntheticMessage: SlackMessageEvent = {
            ...last.message,
            text: combinedText,
          };
          const seenMessageKey = buildSeenMessageKey(
            last.message.channel,
            last.message.ts,
            last.opts.eventScope?.teamId,
          );
          try {
            const { prepareSlackMessage, dispatchPreparedSlackMessage } =
              await loadSlackMessagePipeline();
            const {
              dispatchCompletion: _completion,
              awaitDispatch: _awaitDispatch,
              ...lastOpts
            } = last.opts;
            const appMentionRetryKey =
              seenMessageKey && lastOpts.source === "app_mention" && !ctx.botUserId
                ? seenMessageKey
                : undefined;
            if (appMentionRetryKey) {
              // Keep a concurrent message copy from recording this timestamp while the trusted
              // app_mention prepares and removes any already-recorded copy from its routed history.
              appMentionPreparingKeys.add(appMentionRetryKey);
            }
            const prepared = await (async () => {
              try {
                const result = await prepareSlackMessage({
                  ctx,
                  account,
                  message: syntheticMessage,
                  opts: {
                    ...lastOpts,
                    wasMentioned: combinedMentioned || last.opts.wasMentioned,
                    ...(seenMessageKey && lastOpts.source === "message"
                      ? {
                          shouldRecordDroppedHistory: () =>
                            !appMentionPreparingKeys.has(seenMessageKey) &&
                            !appMentionDispatchedKeys.has(seenMessageKey),
                        }
                      : {}),
                  },
                });
                if (result && seenMessageKey) {
                  pruneAppMentionRetryKeys(Date.now());
                  if (last.opts.source === "app_mention") {
                    // If app_mention wins the race and dispatches first, drop the later message.
                    rememberExpiringAppMentionKey(appMentionDispatchedKeys, seenMessageKey);
                  } else if (
                    last.opts.source === "message" &&
                    appMentionDispatchedKeys.has(seenMessageKey)
                  ) {
                    appMentionDispatchedKeys.delete(seenMessageKey);
                    appMentionRetryKeys.delete(seenMessageKey);
                    return null;
                  }
                  appMentionRetryKeys.delete(seenMessageKey);
                }
                return result;
              } finally {
                if (appMentionRetryKey) {
                  appMentionPreparingKeys.delete(appMentionRetryKey);
                }
              }
            })();
            if (!prepared) {
              return;
            }
            onPrepared?.(prepared);
            if (entries.length > 1) {
              const ids = entries.map((entry) => entry.message.ts).filter(Boolean) as string[];
              if (ids.length > 0) {
                prepared.ctxPayload.MessageSids = ids;
                prepared.ctxPayload.MessageSidFirst = ids[0];
                prepared.ctxPayload.MessageSidLast = ids[ids.length - 1];
              }
            }
            try {
              await dispatchPreparedSlackMessage(prepared);
              await recordSlackInboundMessageDeliveries({
                accountId: ctx.accountId,
                ...(last.opts.eventScope ? { teamId: last.opts.eventScope.teamId } : {}),
                messages: entries.map((entry) => entry.message),
              });
            } catch (error) {
              if (!isRetryableSlackInboundError(error)) {
                await recordSlackInboundMessageDeliveries({
                  accountId: ctx.accountId,
                  ...(last.opts.eventScope ? { teamId: last.opts.eventScope.teamId } : {}),
                  messages: entries.map((entry) => entry.message),
                });
              }
              throw error;
            }
          } catch (error) {
            if (isRetryableSlackInboundError(error)) {
              // Every buffered event passed the seen gate before this combined dispatch.
              // Release all of them so the retry can rebuild the same batch.
              for (const entry of entries) {
                const entrySeenKey = buildSeenMessageKey(
                  entry.message.channel,
                  entry.message.ts,
                  entry.opts.eventScope?.teamId,
                );
                if (entrySeenKey) {
                  appMentionDispatchedKeys.delete(entrySeenKey);
                }
                ctx.releaseSeenMessage(
                  entry.message.channel,
                  entry.message.ts,
                  entry.opts.eventScope,
                );
              }
            }
            throw error;
          }
        })();
        for (const completion of completions) {
          completion.resolve();
        }
      } catch (error) {
        retryEntries(error);
        for (const completion of completions) {
          completion.reject(error);
        }
        throw error;
      }
    },
    onError: (err) => {
      ctx.runtime.error?.(`slack inbound debounce flush failed: ${formatErrorMessage(err)}`);
    },
  });
  const threadTsResolver = createSlackThreadTsResolver({ client: ctx.app.client });
  const pendingTopLevelDebounceKeys = new Map<string, Set<string>>();
  const appMentionRetryKeys = new Map<string, number>();
  const appMentionPreparingKeys = new Set<string>();
  const appMentionDispatchedKeys = new Map<string, number>();

  const pruneAppMentionRetryKeys = (rawNow: number): boolean => {
    const now = asDateTimestampMs(rawNow);
    if (now === undefined) {
      appMentionRetryKeys.clear();
      appMentionDispatchedKeys.clear();
      return false;
    }
    for (const [key, expiresAt] of appMentionRetryKeys) {
      if (asDateTimestampMs(expiresAt) === undefined || expiresAt <= now) {
        appMentionRetryKeys.delete(key);
      }
    }
    for (const [key, expiresAt] of appMentionDispatchedKeys) {
      if (asDateTimestampMs(expiresAt) === undefined || expiresAt <= now) {
        appMentionDispatchedKeys.delete(key);
      }
    }
    return true;
  };

  const rememberExpiringAppMentionKey = (map: Map<string, number>, key: string): void => {
    const now = Date.now();
    if (!pruneAppMentionRetryKeys(now)) {
      return;
    }
    const expiresAt = resolveExpiresAtMsFromDurationMs(APP_MENTION_RETRY_TTL_MS, { nowMs: now });
    if (expiresAt !== undefined) {
      map.set(key, expiresAt);
    }
  };

  const rememberAppMentionRetryKey = (key: string) => {
    rememberExpiringAppMentionKey(appMentionRetryKeys, key);
  };

  const consumeAppMentionRetryKey = (key: string) => {
    const now = Date.now();
    if (!pruneAppMentionRetryKeys(now)) {
      return false;
    }
    if (!appMentionRetryKeys.has(key)) {
      return false;
    }
    appMentionRetryKeys.delete(key);
    return true;
  };

  async function enqueueSlackMessage(
    message: SlackMessageEvent,
    opts: IngressSlackMessageOptions,
  ): Promise<SlackDispatchCompletion | undefined> {
    if (opts.source === "message" && message.type !== "message") {
      return undefined;
    }
    if (
      opts.source === "message" &&
      message.subtype &&
      message.subtype !== "file_share" &&
      message.subtype !== "bot_message" &&
      message.subtype !== "thread_broadcast"
    ) {
      return undefined;
    }
    // Record Slack's explicit type before delivery-state or thread-resolution awaits.
    // Relay and native events can overlap; a following typeless bot event must see it.
    ctx.rememberSlackChannelType(message.channel, message.channel_type, opts.eventScope);
    const seenMessageKey = buildSeenMessageKey(
      message.channel,
      message.ts,
      opts.eventScope?.teamId,
    );
    if (
      seenMessageKey &&
      (await hasSlackInboundMessageDelivery({
        accountId: ctx.accountId,
        channelId: message.channel,
        ts: message.ts,
        ...(opts.eventScope ? { teamId: opts.eventScope.teamId } : {}),
      }))
    ) {
      return undefined;
    }
    const wasSeen = seenMessageKey
      ? ctx.markMessageSeen(message.channel, message.ts, opts.eventScope)
      : false;
    if (seenMessageKey && opts.source === "message" && !wasSeen) {
      // Prime exactly one fallback app_mention allowance immediately so a near-simultaneous
      // app_mention is not dropped while message handling is still in-flight.
      rememberAppMentionRetryKey(seenMessageKey);
    }
    if (seenMessageKey && wasSeen) {
      // Allow exactly one app_mention retry if the same ts was previously dropped
      // from the message stream before it reached dispatch.
      if (opts.source !== "app_mention" || !consumeAppMentionRetryKey(seenMessageKey)) {
        return undefined;
      }
    }
    trackEvent?.();
    const resolvedMessage = await (
      opts.eventScope
        ? createSlackThreadTsResolver({ client: opts.eventScope.client })
        : threadTsResolver
    ).resolve({ message, source: opts.source });
    const teamId = opts.eventScope?.teamId;
    const debounceKey = buildSlackDebounceKey(resolvedMessage, ctx.accountId, teamId);
    const conversationKey = buildTopLevelSlackConversationKey(
      resolvedMessage,
      ctx.accountId,
      teamId,
    );
    const canDebounce =
      !opts.eventScope && debounceMs > 0 && shouldDebounceSlackMessage(resolvedMessage, ctx.cfg);
    if (!canDebounce && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey);
      if (pendingKeys && pendingKeys.size > 0) {
        const keysToFlush = Array.from(pendingKeys);
        for (const pendingKey of keysToFlush) {
          await debouncer.flushKey(pendingKey);
        }
      }
    }
    if (canDebounce && debounceKey && conversationKey) {
      const pendingKeys = pendingTopLevelDebounceKeys.get(conversationKey) ?? new Set<string>();
      pendingKeys.add(debounceKey);
      pendingTopLevelDebounceKeys.set(conversationKey, pendingKeys);
    }
    const dispatchCompletion = opts.awaitDispatch ? createSlackDispatchCompletion() : undefined;
    await debouncer.enqueue({
      message: resolvedMessage,
      opts: {
        ...opts,
        ...(dispatchCompletion
          ? {
              dispatchCompletion: {
                resolve: dispatchCompletion.resolve,
                reject: dispatchCompletion.reject,
              },
            }
          : {}),
      },
    });
    return dispatchCompletion;
  }

  return async (message, opts) => {
    const dispatchCompletion = await enqueueSlackMessage(message, opts);
    await dispatchCompletion?.promise;
  };
}
