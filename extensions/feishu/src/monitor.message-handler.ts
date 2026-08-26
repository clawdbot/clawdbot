// Feishu plugin module implements monitor.message handler behavior.
import { isRecord, readStringValue as readString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { ClawdbotConfig, HistoryEntry, PluginRuntime, RuntimeEnv } from "../runtime-api.js";
import { claimUnprocessedFeishuMessage, type FeishuMessageProcessingClaim } from "./dedup.js";
import { resolveFeishuMessageDedupeKey } from "./dedupe-key.js";
import type { FeishuMessageEvent } from "./event-types.js";
import {
  buildFeishuFlushIngressLifecycle,
  FeishuIngressPermanentError,
  type FeishuIngressLifecycle,
} from "./feishu-ingress.js";
import { isMentionForwardRequest } from "./mention.js";
import { createSequentialQueue } from "./sequential-queue.js";
import {
  isFeishuSourceMessageRecalled,
  retainFeishuSourceMessageIngress,
} from "./source-message-recall.js";
import type { FeishuChatType } from "./types.js";

type FeishuMessageReceiveHandlerContext = {
  cfg: ClawdbotConfig;
  channelRuntime: PluginRuntime["channel"];
  accountId: string;
  runtime?: RuntimeEnv;
  chatHistories: Map<string, HistoryEntry[]>;
  fireAndForget?: boolean;
  handleMessage: (params: {
    cfg: ClawdbotConfig;
    event: FeishuMessageEvent;
    botOpenId?: string;
    botName?: string;
    runtime?: RuntimeEnv;
    channelRuntime?: PluginRuntime["channel"];
    chatHistories?: Map<string, HistoryEntry[]>;
    accountId?: string;
    processingClaim?: FeishuMessageProcessingClaim;
    messageDedupeKey?: string;
    sourceMessageIds?: readonly string[];
    turnAdoptionLifecycle?: FeishuIngressLifecycle;
  }) => Promise<void>;
  resolveDebounceText: (params: {
    event: FeishuMessageEvent;
    botOpenId?: string;
    botName?: string;
  }) => string;
  hasProcessedMessage: (
    messageId: string | undefined | null,
    namespace: string,
    log?: (...args: unknown[]) => void,
  ) => Promise<boolean>;
  getBotOpenId?: (accountId: string) => string | undefined;
  getBotName?: (accountId: string) => string | undefined;
  resolveSequentialKey?: (params: {
    accountId: string;
    event: FeishuMessageEvent;
    botOpenId?: string;
    botName?: string;
  }) => string;
  /**
   * Optional status sink. When provided, the handler will publish `lastEventAt`
   * on every inbound message for message recency. Transport liveness is
   * published by the transport layer.
   */
  statusSink?: import("./monitor.js").FeishuStatusSink;
  resolveIngressLifecycle?: (data: unknown) => FeishuIngressLifecycle | undefined;
};

function normalizeFeishuChatType(value: unknown): FeishuChatType | undefined {
  return value === "group" || value === "topic_group" || value === "private" || value === "p2p"
    ? value
    : undefined;
}

function parseFeishuMessageEventPayload(value: unknown): FeishuMessageEvent | null {
  if (!isRecord(value)) {
    return null;
  }
  const sender = value.sender;
  const message = value.message;
  if (!isRecord(sender) || !isRecord(message)) {
    return null;
  }
  const senderId = sender.sender_id;
  if (!isRecord(senderId)) {
    return null;
  }
  const messageId = readString(message.message_id);
  const chatId = readString(message.chat_id);
  const chatType = normalizeFeishuChatType(message.chat_type);
  const messageType = readString(message.message_type);
  // Feishu can deliver a legitimately empty message body; keep absent or
  // non-string bodies malformed instead of inventing fallback content.
  if (!messageId || !chatId || !chatType || !messageType || typeof message.content !== "string") {
    return null;
  }
  return value as FeishuMessageEvent;
}

function mergeFeishuDebounceMentions(
  entries: FeishuMessageEvent[],
): FeishuMessageEvent["message"]["mentions"] | undefined {
  const merged = new Map<string, NonNullable<FeishuMessageEvent["message"]["mentions"]>[number]>();
  for (const entry of entries) {
    for (const mention of entry.message.mentions ?? []) {
      const stableId =
        mention.id.open_id?.trim() || mention.id.user_id?.trim() || mention.id.union_id?.trim();
      const mentionName = mention.name?.trim();
      const mentionKey = mention.key?.trim();
      const fallback =
        mentionName && mentionKey ? `${mentionName}|${mentionKey}` : mentionName || mentionKey;
      const key = stableId || fallback;
      if (!key || merged.has(key)) {
        continue;
      }
      merged.set(key, mention);
    }
  }
  return merged.size > 0 ? Array.from(merged.values()) : undefined;
}

type FeishuMessageDebounceEntry = {
  event: FeishuMessageEvent;
  processingClaim?: FeishuMessageProcessingClaim;
  turnAdoptionLifecycle?: FeishuIngressLifecycle;
  sourceMessageRetention?: { dispose: () => void };
  abandoned?: boolean;
};

function dedupeFeishuDebounceEntriesByDedupeKey(
  entries: FeishuMessageDebounceEntry[],
): FeishuMessageDebounceEntry[] {
  const seen = new Set<string>();
  const deduped: FeishuMessageDebounceEntry[] = [];
  for (const entry of entries) {
    const dedupeKey = resolveFeishuMessageDedupeKey(entry.event);
    if (!dedupeKey) {
      deduped.push(entry);
      continue;
    }
    if (seen.has(dedupeKey)) {
      continue;
    }
    seen.add(dedupeKey);
    deduped.push(entry);
  }
  return deduped;
}

function resolveFeishuDebounceMentions(params: {
  entries: FeishuMessageEvent[];
  botOpenId?: string;
}): FeishuMessageEvent["message"]["mentions"] | undefined {
  const { entries, botOpenId } = params;
  if (entries.length === 0) {
    return undefined;
  }
  for (const entry of entries.toReversed()) {
    if (isMentionForwardRequest(entry, botOpenId)) {
      return mergeFeishuDebounceMentions([entry]);
    }
  }
  const merged = mergeFeishuDebounceMentions(entries);
  if (!merged) {
    return undefined;
  }
  const normalizedBotOpenId = botOpenId?.trim();
  if (!normalizedBotOpenId) {
    return undefined;
  }
  const botMentions = merged.filter(
    (mention) => mention.id.open_id?.trim() === normalizedBotOpenId,
  );
  return botMentions.length > 0 ? botMentions : undefined;
}

export function createFeishuMessageReceiveHandler({
  cfg,
  channelRuntime,
  accountId,
  runtime,
  chatHistories,
  fireAndForget,
  handleMessage,
  resolveDebounceText: resolveText,
  hasProcessedMessage,
  getBotOpenId = () => undefined,
  getBotName = () => undefined,
  resolveSequentialKey = ({ accountId: accountIdLocal, event }) =>
    `feishu:${accountIdLocal}:${event.message.chat_id?.trim() || "unknown"}`,
  statusSink,
  resolveIngressLifecycle,
}: FeishuMessageReceiveHandlerContext): (
  data: unknown,
) => Promise<{ kind: "deferred" } | { kind: "failed-retryable"; error: unknown } | void> {
  const inboundDebounceMs = channelRuntime.debounce.resolveInboundDebounceMs({
    cfg,
    channel: "feishu",
  });
  const log = runtime?.log ?? console.log;
  const error = runtime?.error ?? console.error;
  const enqueue = createSequentialQueue({
    onTaskTimeout: (key, timeoutMs) => {
      log(
        `feishu[${accountId}]: per-chat task exceeded ${timeoutMs}ms cap (key=${key}); evicting from queue so later same-key messages can proceed (#70133)`,
      );
    },
  });

  const dispatchFeishuMessage = async (
    event: FeishuMessageEvent,
    messageDedupeKey?: string,
    processingClaim?: FeishuMessageProcessingClaim,
    turnAdoptionLifecycle?: FeishuIngressLifecycle,
    sourceMessageIds: readonly string[] = [event.message.message_id],
    onTaskSettled?: () => void,
  ) => {
    let taskSettled = false;
    const settleTask = () => {
      if (taskSettled) {
        return;
      }
      taskSettled = true;
      onTaskSettled?.();
    };
    try {
      const sequentialKey = resolveSequentialKey({
        accountId,
        event,
        botOpenId: getBotOpenId(accountId),
        botName: getBotName(accountId),
      });
      const task = async () => {
        try {
          const recalledMessageId = sourceMessageIds.find((messageId) =>
            isFeishuSourceMessageRecalled({ channelRuntime, accountId, messageId }),
          );
          if (recalledMessageId) {
            log(`feishu[${accountId}]: skipping recalled message ${recalledMessageId}`);
            // The outer debounce flush settles durable claims. Keeping settlement
            // there avoids adopting and committing a recalled queued turn.
            if (!turnAdoptionLifecycle) {
              processingClaim?.release({ error: new Error("feishu-source-message-recalled") });
            }
            return;
          }
          if (turnAdoptionLifecycle?.abortSignal.aborted) {
            await turnAdoptionLifecycle.onAbandoned();
            return;
          }
          await handleMessage({
            cfg,
            event,
            botOpenId: getBotOpenId(accountId),
            botName: getBotName(accountId),
            runtime,
            channelRuntime,
            chatHistories,
            accountId,
            processingClaim,
            messageDedupeKey,
            sourceMessageIds,
            turnAdoptionLifecycle,
          });
        } finally {
          // Queue timeouts unblock later turns while this task keeps running.
          // Retain recall state until the actual task, not the queue gate, ends.
          settleTask();
        }
      };
      await enqueue(sequentialKey, task);
    } catch (err) {
      settleTask();
      throw err;
    }
  };

  const resolveSenderDebounceId = (event: FeishuMessageEvent): string | undefined => {
    const senderId =
      event.sender.sender_id.open_id?.trim() || event.sender.sender_id.user_id?.trim();
    return senderId || undefined;
  };

  const resolveDebounceText = (event: FeishuMessageEvent): string => {
    return resolveText({
      event,
      botOpenId: getBotOpenId(accountId),
      botName: getBotName(accountId),
    }).trim();
  };

  const recordSuppressedMessageIds = async (
    entries: FeishuMessageDebounceEntry[],
    dispatchDedupeKey?: string,
  ) => {
    const keepDedupeKey = dispatchDedupeKey?.trim();
    const suppressedIds = new Set(
      entries
        .map((entry) => ({
          id: resolveFeishuMessageDedupeKey(entry.event),
          claim: entry.processingClaim,
        }))
        .filter(({ id }) => Boolean(id) && (!keepDedupeKey || id !== keepDedupeKey)),
    );
    for (const suppressed of suppressedIds) {
      try {
        await suppressed.claim?.commit();
      } catch (err) {
        error(
          `feishu[${accountId}]: failed to record merged dedupe id ${suppressed.id}: ${String(err)}`,
        );
      }
    }
  };

  const partitionRecalledDebounceEntries = (entries: FeishuMessageDebounceEntry[]) => {
    const activeEntries: FeishuMessageDebounceEntry[] = [];
    const recalledEntries: FeishuMessageDebounceEntry[] = [];
    for (const entry of entries) {
      if (
        !isFeishuSourceMessageRecalled({
          channelRuntime,
          accountId,
          messageId: entry.event.message.message_id,
        })
      ) {
        activeEntries.push(entry);
        continue;
      }
      recalledEntries.push(entry);
    }
    return {
      activeEntries,
      settleRecalledEntries: async () => {
        for (const entry of recalledEntries) {
          log(
            `feishu[${accountId}]: dropping recalled debounced message ${entry.event.message.message_id}`,
          );
          // Keep transport adoption and logical replay-guard release symmetric
          // with the later sequential-queue recall check above.
          if (!entry.turnAdoptionLifecycle) {
            entry.processingClaim?.release({ error: new Error("feishu-source-message-recalled") });
            continue;
          }
          const { settle } = buildFeishuFlushIngressLifecycle([
            {
              lifecycle: entry.turnAdoptionLifecycle,
              replayClaim: entry.processingClaim,
            },
          ]);
          await settle();
        }
      },
    };
  };

  const inboundDebouncer =
    channelRuntime.debounce.createInboundDebouncer<FeishuMessageDebounceEntry>({
      debounceMs: inboundDebounceMs,
      buildKey: ({ event }) => {
        const chatId = event.message.chat_id?.trim();
        const senderId = resolveSenderDebounceId(event);
        if (!chatId || !senderId) {
          return null;
        }
        const rootId = event.message.root_id?.trim();
        const threadKey = rootId ? `thread:${rootId}` : "chat";
        return `feishu:${accountId}:${chatId}:${threadKey}:${senderId}`;
      },
      shouldDebounce: ({ event }) => {
        if (event.message.message_type !== "text") {
          return false;
        }
        const text = resolveDebounceText(event);
        return Boolean(text) && !channelRuntime.commands.isControlCommandMessage(text, cfg);
      },
      // The shared debouncer routes buffered, immediate, and capacity-fallback
      // entries through onFlush, so this callback owns every retention lease.
      onFlush: (entries, createFlush) => {
        const { activeEntries, settleRecalledEntries } = partitionRecalledDebounceEntries(
          entries.filter((entry) => !entry.abandoned),
        );
        const last = activeEntries.at(-1);
        const { lifecycle, settle } = buildFeishuFlushIngressLifecycle(
          activeEntries.map((entry) => ({
            lifecycle: entry.turnAdoptionLifecycle,
            replayClaim: entry.processingClaim,
          })),
          {
            onReplayCommitError: (err) =>
              error(`feishu[${accountId}]: failed to commit logical replay guard: ${String(err)}`),
          },
        );
        return createFlush({
          lifecycle,
          dispatch: async (admissionLifecycle) => {
            const handedOffRetentions = new Set<FeishuMessageDebounceEntry>();
            const handOffRetentions = (taskEntries: readonly FeishuMessageDebounceEntry[]) => {
              for (const entry of taskEntries) {
                handedOffRetentions.add(entry);
              }
              return () => {
                for (const entry of taskEntries) {
                  entry.sourceMessageRetention?.dispose();
                }
              };
            };
            try {
              await settleRecalledEntries();
              if (!last) {
                return;
              }
              if (admissionLifecycle.abortSignal.aborted) {
                await admissionLifecycle.onAbandoned();
                return;
              }
              if (activeEntries.length === 1) {
                await dispatchFeishuMessage(
                  last.event,
                  resolveFeishuMessageDedupeKey(last.event),
                  last.processingClaim,
                  admissionLifecycle,
                  [last.event.message.message_id],
                  handOffRetentions([last]),
                );
                await settle();
                return;
              }
              const dedupedEntries = dedupeFeishuDebounceEntriesByDedupeKey(activeEntries);
              const freshEntries: FeishuMessageDebounceEntry[] = [];
              for (const entry of dedupedEntries) {
                if (
                  !(await hasProcessedMessage(
                    resolveFeishuMessageDedupeKey(entry.event),
                    accountId,
                    log,
                  ))
                ) {
                  freshEntries.push(entry);
                }
              }
              const dispatchEntry = freshEntries.at(-1);
              if (!dispatchEntry) {
                await settle();
                return;
              }
              const dispatchDedupeKey = resolveFeishuMessageDedupeKey(dispatchEntry.event);
              if (!lifecycle) {
                await recordSuppressedMessageIds(dedupedEntries, dispatchDedupeKey);
              }
              const combinedText = freshEntries
                .map((entry) => resolveDebounceText(entry.event))
                .filter(Boolean)
                .join("\n");
              const mergedMentions = resolveFeishuDebounceMentions({
                entries: freshEntries.map((entry) => entry.event),
                botOpenId: getBotOpenId(accountId),
              });
              await dispatchFeishuMessage(
                {
                  ...dispatchEntry.event,
                  message: {
                    ...dispatchEntry.event.message,
                    ...(combinedText.trim()
                      ? {
                          message_type: "text",
                          content: JSON.stringify({ text: combinedText }),
                        }
                      : {}),
                    mentions: mergedMentions ?? dispatchEntry.event.message.mentions,
                  },
                },
                dispatchDedupeKey,
                dispatchEntry.processingClaim,
                admissionLifecycle,
                freshEntries.map((entry) => entry.event.message.message_id),
                handOffRetentions(freshEntries),
              );
              await settle();
            } catch (err) {
              await admissionLifecycle.onAbandoned();
              throw err;
            } finally {
              for (const entry of entries) {
                if (!handedOffRetentions.has(entry)) {
                  entry.sourceMessageRetention?.dispose();
                }
              }
            }
          },
        });
      },
      onError: (err, entries) => {
        for (const entry of entries) {
          entry.sourceMessageRetention?.dispose();
          entry.processingClaim?.release({ error: err });
          try {
            void Promise.resolve(entry.turnAdoptionLifecycle?.onAbandoned()).catch(
              (abandonError: unknown) => {
                error(
                  `feishu[${accountId}]: failed to abandon durable ingress after debounce error: ${String(abandonError)}`,
                );
              },
            );
          } catch (abandonError) {
            error(
              `feishu[${accountId}]: failed to abandon durable ingress after debounce error: ${String(abandonError)}`,
            );
          }
        }
        error(`feishu[${accountId}]: inbound debounce flush failed: ${String(err)}`);
      },
    });

  return async (data) => {
    const turnAdoptionLifecycle = resolveIngressLifecycle?.(data);
    const completeSuppressedIngress = async () => {
      if (!turnAdoptionLifecycle) {
        return;
      }
      turnAdoptionLifecycle.onAdoptionFinalizing();
      await turnAdoptionLifecycle.onAdopted();
    };
    // Publish message recency before dedupe/debounce; transport liveness is
    // owned by the WebSocket/Webhook lifecycle monitors.
    const inboundAt = Date.now();
    statusSink?.({
      lastEventAt: inboundAt,
    });

    const event = parseFeishuMessageEventPayload(data);
    if (!event) {
      if (turnAdoptionLifecycle) {
        throw new FeishuIngressPermanentError(
          "invalid-event",
          "Feishu durable message event payload is malformed.",
        );
      }
      error(`feishu[${accountId}]: ignoring malformed message event payload`);
      return undefined;
    }
    const messageId = event.message?.message_id?.trim();
    const botOpenId = getBotOpenId(accountId)?.trim();
    const senderOpenId = event.sender.sender_id.open_id?.trim();
    if (botOpenId && senderOpenId === botOpenId) {
      // Feishu bot receive events identify their sender by open_id. Drop this
      // account's bot before it can consume a claim or debounce slot.
      log(`feishu[${accountId}]: dropping self-authored message ${messageId ?? "unknown"}`);
      await completeSuppressedIngress();
      return undefined;
    }
    if (isFeishuSourceMessageRecalled({ channelRuntime, accountId, messageId })) {
      log(`feishu[${accountId}]: dropping recalled message ${messageId ?? "unknown"}`);
      await completeSuppressedIngress();
      return undefined;
    }
    const sourceMessageRetention = retainFeishuSourceMessageIngress({
      channelRuntime,
      accountId,
      messageId,
    });
    const messageDedupeKey = resolveFeishuMessageDedupeKey(event);
    let claim: Awaited<ReturnType<typeof claimUnprocessedFeishuMessage>>;
    try {
      claim = await claimUnprocessedFeishuMessage({
        messageId: messageDedupeKey,
        namespace: accountId,
        log,
      });
    } catch (err) {
      sourceMessageRetention?.dispose();
      throw err;
    }
    if (claim.kind === "duplicate" || claim.kind === "inflight") {
      sourceMessageRetention?.dispose();
      log(`feishu[${accountId}]: dropping ${claim.kind} event for message ${messageId}`);
      await completeSuppressedIngress();
      return undefined;
    }
    const debounceEntry: FeishuMessageDebounceEntry = {
      event,
      ...(claim.kind === "claimed" ? { processingClaim: claim.handle } : {}),
      ...(turnAdoptionLifecycle ? { turnAdoptionLifecycle } : {}),
      ...(sourceMessageRetention ? { sourceMessageRetention } : {}),
    };
    if (claim.kind === "claimed" && turnAdoptionLifecycle) {
      // The durable drain can abandon before the debounce timer flushes. Tie
      // the logical claim and queued entry to that earlier lifecycle.
      turnAdoptionLifecycle.registerAbandonHandler?.(() => {
        debounceEntry.abandoned = true;
        sourceMessageRetention?.dispose();
        claim.handle.release({ error: new Error("feishu-ingress-abandoned-before-flush") });
      });
    }
    const processMessage = async () => {
      await inboundDebouncer.enqueue(debounceEntry);
    };
    if (turnAdoptionLifecycle) {
      try {
        await processMessage();
        return { kind: "deferred" };
      } catch (err) {
        sourceMessageRetention?.dispose();
        if (claim.kind === "claimed") {
          claim.handle.release({ error: err });
        }
        return { kind: "failed-retryable", error: err };
      }
    }
    if (fireAndForget) {
      void processMessage().catch((err: unknown) => {
        sourceMessageRetention?.dispose();
        if (claim.kind === "claimed") {
          claim.handle.release({ error: err });
        }
        error(`feishu[${accountId}]: error handling message: ${String(err)}`);
      });
      return undefined;
    }
    try {
      await processMessage();
    } catch (err) {
      sourceMessageRetention?.dispose();
      if (claim.kind === "claimed") {
        claim.handle.release({ error: err });
      }
      error(`feishu[${accountId}]: error handling message: ${String(err)}`);
    }
    return undefined;
  };
}
