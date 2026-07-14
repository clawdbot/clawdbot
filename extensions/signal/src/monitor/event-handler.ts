// Signal plugin module implements event handler behavior.
import { setTimeout as sleep } from "node:timers/promises";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createStatusReactionController,
  DEFAULT_EMOJIS,
  DEFAULT_TIMING,
  logAckFailure,
  logTypingFailure,
  resolveAckReaction,
  shouldAckReaction,
  type StatusReactionController,
  type StatusReactionEmojis,
} from "openclaw/plugin-sdk/channel-feedback";
import {
  buildMentionRegexes,
  buildChannelInboundEventContext,
  createChannelInboundDebouncer,
  formatInboundMediaUnavailableText,
  formatInboundEnvelope,
  formatInboundFromLabel,
  logInboundDrop,
  matchesMentionPatterns,
  resolveInboundMentionDecision,
  resolveEnvelopeFormatOptions,
  hasVisibleInboundReplyDispatch,
  runChannelInboundEvent,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelMessageReplyPipeline } from "openclaw/plugin-sdk/channel-outbound";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import { hasControlCommand } from "openclaw/plugin-sdk/command-auth-native";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { collectErrorGraphCandidates, formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  createInternalHookEvent,
  fireAndForgetHook,
  toInternalMessageReceivedContext,
  triggerInternalHook,
} from "openclaw/plugin-sdk/hook-runtime";
import { kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { createChannelHistoryWindow } from "openclaw/plugin-sdk/reply-history";
import { resolveBatchedReplyThreadingPolicy } from "openclaw/plugin-sdk/reply-reference";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { createReplyDispatcherWithTyping } from "openclaw/plugin-sdk/reply-runtime";
import { settleReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { resolveAgentRoute, resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import {
  danger,
  logVerbose,
  shouldLogVerbose,
  sleep as delay,
} from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { enqueueSystemEvent } from "openclaw/plugin-sdk/system-event-runtime";
import { normalizeE164, truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveSignalReplyToMode } from "../accounts.js";
import {
  maybeResolveSignalApprovalReaction,
  resolveSignalApprovalConversationKey,
} from "../approval-reactions.js";
import {
  formatSignalPairingIdLine,
  formatSignalSenderDisplay,
  formatSignalSenderId,
  normalizeSignalAllowRecipient,
  resolveSignalPeerId,
  resolveSignalRecipient,
  resolveSignalSender,
  type SignalSender,
} from "../identity.js";
import { normalizeSignalMessagingTarget } from "../normalize.js";
import { resolveSignalReactionLevel } from "../reaction-level.js";
import { registerSignalReplyContext } from "../reply-authors.js";
import {
  removeReactionSignal,
  sendReactionSignal,
  type SignalReactionOpts,
} from "../send-reactions.js";
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";
import type {
  SignalEnvelope,
  SignalEventHandlerDeps,
  SignalReactionMessage,
  SignalReceivePayload,
} from "./event-handler.types.js";
import { resolveSignalQuoteContext } from "./inbound-context.js";
import { renderSignalMentions, resolveSignalMentionFacts } from "./mentions.js";

const REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE = /reply session initialization conflicted for \S+/u;
const RETRYABLE_FLUSH_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;
function isSignalReplySessionInitConflictError(error: unknown): boolean {
  return collectErrorGraphCandidates(error, (current) => [current.cause, current.error]).some(
    (candidate) => REPLY_SESSION_INIT_CONFLICT_MESSAGE_RE.test(formatErrorMessage(candidate)),
  );
}

function formatAttachmentKindCount(kind: string, count: number): string {
  if (kind === "attachment") {
    return `${count} file${count > 1 ? "s" : ""}`;
  }
  return `${count} ${kind}${count > 1 ? "s" : ""}`;
}
function formatAttachmentSummaryPlaceholder(contentTypes: Array<string | undefined>): string {
  const kindCounts = new Map<string, number>();
  for (const contentType of contentTypes) {
    const kind = kindFromMime(contentType) ?? "attachment";
    kindCounts.set(kind, (kindCounts.get(kind) ?? 0) + 1);
  }
  const parts = [...kindCounts.entries()].map(([kind, count]) =>
    formatAttachmentKindCount(kind, count),
  );
  return `[${parts.join(" + ")} attached]`;
}

function resolveSignalInboundRoute(params: {
  cfg: SignalEventHandlerDeps["cfg"];
  accountId: SignalEventHandlerDeps["accountId"];
  isGroup: boolean;
  groupId?: string;
  senderPeerId: string;
}) {
  return resolveAgentRoute({
    cfg: params.cfg,
    channel: "signal",
    accountId: params.accountId,
    peer: {
      kind: params.isGroup ? "group" : "direct",
      id: params.isGroup ? (params.groupId ?? "unknown") : params.senderPeerId,
    },
  });
}

function resolveSignalStatusReactionTimestamp(params: {
  timestamp?: number;
  messageId?: string;
}): number | null {
  if (typeof params.timestamp === "number") {
    return Number.isFinite(params.timestamp) && params.timestamp > 0 ? params.timestamp : null;
  }
  const parsed = Number(params.messageId);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

type SignalStatusDispatchResult = Awaited<ReturnType<typeof dispatchInboundMessage>>;

function hasSignalStatusReplyDeliveryFailure(result: SignalStatusDispatchResult): boolean {
  const failedCounts = result.failedCounts;
  return (
    (failedCounts?.tool ?? 0) > 0 ||
    (failedCounts?.block ?? 0) > 0 ||
    (failedCounts?.final ?? 0) > 0
  );
}

function resolveSignalStatusReactionEmojis(
  emojis: StatusReactionEmojis | undefined,
): StatusReactionEmojis | undefined {
  if (emojis?.stallHard !== undefined) {
    return emojis;
  }
  return {
    ...emojis,
    // Signal exposes one reaction slot on the source message. A warning emoji
    // reads as terminal failure even when the turn is merely long-running.
    stallHard: DEFAULT_EMOJIS.stallSoft,
  };
}

async function finalizeSignalStatusReaction(params: {
  controller: StatusReactionController;
  outcome: "done" | "error";
  hasFinalResponse: boolean;
  removeAckAfterReply: boolean;
  timing: typeof DEFAULT_TIMING;
}): Promise<void> {
  if (params.outcome === "done") {
    await params.controller.setDone();
    if (params.removeAckAfterReply) {
      await delay(params.timing.doneHoldMs);
      await params.controller.clear();
    } else {
      await params.controller.restoreInitial();
    }
    return;
  }

  await params.controller.setError();
  if (params.hasFinalResponse) {
    if (params.removeAckAfterReply) {
      await delay(params.timing.errorHoldMs);
      await params.controller.clear();
    } else {
      await params.controller.restoreInitial();
    }
    return;
  }
  if (params.removeAckAfterReply) {
    await delay(params.timing.errorHoldMs);
  }
  await params.controller.restoreInitial();
}

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  type SignalInboundEntry = {
    senderName: string;
    senderDisplay: string;
    senderRecipient: string;
    senderPeerId: string;
    groupId?: string;
    groupName?: string;
    isGroup: boolean;
    bodyText: string;
    nativeReplyBody?: string;
    commandBody: string;
    timestamp?: number;
    messageId?: string;
    replyToId?: string;
    isBatched?: boolean;
    mediaPath?: string;
    mediaType?: string;
    mediaPaths?: string[];
    mediaTypes?: string[];
    commandAuthorized: boolean;
    canDetectMention?: boolean;
    requireMention?: boolean;
    wasMentioned?: boolean;
    replyToBody?: string;
    replyToSender?: string;
    replyToIsQuote?: boolean;
  };
  const activeEnqueueEntries = new WeakSet<SignalInboundEntry>();

  async function handleSignalInboundMessage(entry: SignalInboundEntry) {
    const fromLabel = formatInboundFromLabel({
      isGroup: entry.isGroup,
      groupLabel: entry.groupName ?? undefined,
      groupId: entry.groupId ?? "unknown",
      groupFallback: "Group",
      directLabel: entry.senderName,
      directId: entry.senderDisplay,
    });
    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup: entry.isGroup,
      groupId: entry.groupId,
      senderPeerId: entry.senderPeerId,
    });
    const storePath = resolveStorePath(deps.cfg.session?.store, {
      agentId: route.agentId,
    });
    const envelopeOptions = resolveEnvelopeFormatOptions(deps.cfg);
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: route.sessionKey,
    });
    const body = formatInboundEnvelope({
      channel: "Signal",
      from: fromLabel,
      timestamp: entry.timestamp ?? undefined,
      body: entry.bodyText,
      chatType: entry.isGroup ? "group" : "direct",
      sender: { name: entry.senderName, id: entry.senderDisplay },
      previousTimestamp,
      envelope: envelopeOptions,
    });
    let combinedBody = body;
    const historyKey = entry.isGroup ? (entry.groupId ?? "unknown") : undefined;
    if (entry.isGroup && historyKey) {
      const channelHistory = createChannelHistoryWindow({ historyMap: deps.groupHistories });
      combinedBody = channelHistory.buildPendingContext({
        historyKey,
        limit: deps.historyLimit,
        currentMessage: combinedBody,
        formatEntry: (historyEntry) =>
          formatInboundEnvelope({
            channel: "Signal",
            from: fromLabel,
            timestamp: historyEntry.timestamp,
            body: `${historyEntry.body}${
              historyEntry.messageId ? ` [id:${historyEntry.messageId}]` : ""
            }`,
            chatType: "group",
            senderLabel: historyEntry.sender,
            envelope: envelopeOptions,
          }),
      });
    }
    const signalToRaw = entry.isGroup
      ? `group:${entry.groupId}`
      : `signal:${entry.senderRecipient}`;
    const signalTo = normalizeSignalMessagingTarget(signalToRaw) ?? signalToRaw;
    const inboundHistory =
      entry.isGroup && historyKey && deps.historyLimit > 0
        ? createChannelHistoryWindow({ historyMap: deps.groupHistories }).buildInboundHistory({
            historyKey,
            limit: deps.historyLimit,
          })
        : undefined;
    const replyToMode = resolveSignalReplyToMode({
      cfg: deps.cfg,
      accountId: deps.accountId,
      chatType: entry.isGroup ? "group" : "direct",
    });
    const replyThreading = resolveBatchedReplyThreadingPolicy(
      replyToMode,
      entry.isBatched === true,
    );
    const media =
      entry.mediaPaths && entry.mediaPaths.length > 0
        ? entry.mediaPaths.map((path, index) => ({
            path,
            url: path,
            contentType: entry.mediaTypes?.[index],
          }))
        : entry.mediaPath
          ? [{ path: entry.mediaPath, url: entry.mediaPath, contentType: entry.mediaType }]
          : undefined;
    const ctxPayload = buildChannelInboundEventContext({
      channel: "signal",
      supplemental: {
        quote: entry.replyToBody
          ? {
              body: entry.replyToBody,
              sender: entry.replyToSender,
              isQuote: entry.replyToIsQuote,
            }
          : undefined,
      },
      messageId: entry.messageId,
      timestamp: entry.timestamp ?? undefined,
      from: entry.isGroup
        ? `group:${entry.groupId ?? "unknown"}`
        : `signal:${entry.senderRecipient}`,
      sender: {
        id: entry.senderDisplay,
        name: entry.senderName,
      },
      conversation: {
        kind: entry.isGroup ? "group" : "direct",
        id: entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderRecipient,
        label: fromLabel,
      },
      route: {
        agentId: route.agentId,
        accountId: route.accountId,
        routeSessionKey: route.sessionKey,
      },
      reply: {
        to: signalTo,
        replyToId: entry.replyToId ?? entry.messageId,
      },
      message: {
        body: combinedBody,
        bodyForAgent: entry.bodyText,
        inboundHistory,
        rawBody: entry.commandBody,
        commandBody: entry.commandBody,
      },
      access: {
        ...(entry.isGroup
          ? {
              mentions: {
                canDetectMention: true,
                wasMentioned: entry.wasMentioned === true,
              },
            }
          : {}),
        commands: {
          authorized: entry.commandAuthorized,
        },
      },
      media,
      extra: {
        GroupSubject: entry.isGroup ? (entry.groupName ?? undefined) : undefined,
        ReplyThreading: replyThreading,
      },
    });

    if (shouldLogVerbose()) {
      const preview = truncateUtf16Safe(body, 200).replace(/\\n/g, "\\\\n");
      logVerbose(`signal inbound: from=${ctxPayload.From} len=${body.length} preview="${preview}"`);
    }

    const statusReactionTimestamp = resolveSignalStatusReactionTimestamp(entry);
    const statusReactionsConfig = deps.cfg.messages?.statusReactions;
    const signalReactionLevel = resolveSignalReactionLevel({
      cfg: deps.cfg,
      accountId: route.accountId,
    });
    const ackReaction = resolveAckReaction(deps.cfg, route.agentId, {
      channel: "signal",
      accountId: route.accountId,
    });
    const shouldSendStatusReaction = Boolean(
      ackReaction &&
      shouldAckReaction({
        scope: deps.cfg.messages?.ackReactionScope,
        isDirect: !entry.isGroup,
        isGroup: entry.isGroup,
        isMentionableGroup: entry.isGroup,
        requireMention: entry.requireMention === true,
        canDetectMention: entry.canDetectMention === true,
        effectiveWasMentioned: entry.wasMentioned === true,
      }),
    );
    const statusReactionTarget = `${entry.groupId ?? entry.senderRecipient}/${
      statusReactionTimestamp ?? "unknown"
    }`;
    const signalReactionOpts: SignalReactionOpts = {
      cfg: deps.cfg,
      ...(deps.baseUrl ? { baseUrl: deps.baseUrl } : {}),
      ...(deps.account ? { account: deps.account } : {}),
      ...(deps.accountId ? { accountId: deps.accountId } : {}),
      ...(entry.isGroup && entry.groupId
        ? {
            groupId: entry.groupId,
            targetAuthor: entry.senderRecipient,
          }
        : {}),
    };
    const statusReactionRecipient = entry.isGroup ? "" : entry.senderRecipient;
    let currentStatusReactionEmoji = ackReaction;
    const statusReactionController =
      statusReactionsConfig?.enabled === true &&
      signalReactionLevel.level !== "off" &&
      shouldSendStatusReaction &&
      statusReactionTimestamp
        ? createStatusReactionController({
            enabled: true,
            adapter: {
              setReaction: async (emoji) => {
                await sendReactionSignal(
                  statusReactionRecipient,
                  statusReactionTimestamp,
                  emoji,
                  signalReactionOpts,
                );
                currentStatusReactionEmoji = emoji;
              },
              clearReaction: async () => {
                if (!currentStatusReactionEmoji) {
                  return;
                }
                await removeReactionSignal(
                  statusReactionRecipient,
                  statusReactionTimestamp,
                  currentStatusReactionEmoji,
                  signalReactionOpts,
                );
                currentStatusReactionEmoji = "";
              },
            },
            initialEmoji: ackReaction,
            emojis: resolveSignalStatusReactionEmojis(statusReactionsConfig.emojis),
            timing: statusReactionsConfig.timing,
            onError: (err) => {
              logAckFailure({
                log: logVerbose,
                channel: "signal",
                target: statusReactionTarget,
                error: err,
              });
            },
          })
        : null;
    const statusReactionTiming = {
      ...DEFAULT_TIMING,
      ...statusReactionsConfig?.timing,
    };
    if (statusReactionController) {
      void statusReactionController.setQueued();
    }

    const { onModelSelected, typingCallbacks, ...replyPipeline } =
      createChannelMessageReplyPipeline({
        cfg: deps.cfg,
        agentId: route.agentId,
        channel: "signal",
        accountId: route.accountId,
        typing: {
          start: async () => {
            if (!ctxPayload.To) {
              return;
            }
            await sendTypingSignal(ctxPayload.To, {
              cfg: deps.cfg,
              baseUrl: deps.baseUrl,
              account: deps.account,
              accountId: deps.accountId,
            });
          },
          onStartError: (err) => {
            logTypingFailure({
              log: logVerbose,
              channel: "signal",
              target: ctxPayload.To ?? undefined,
              error: err,
            });
          },
        },
      });

    const nativeReplyContext = {
      replyToId: ctxPayload.ReplyToId,
      author: entry.senderRecipient,
      body: entry.nativeReplyBody ?? entry.bodyText,
      allowImplicitCurrentMessage:
        replyToMode !== "off" && replyThreading?.implicitCurrentMessage !== "deny",
      state: { hasReplied: false },
    };
    const { dispatcher, replyOptions, markDispatchIdle } = createReplyDispatcherWithTyping({
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(deps.cfg, route.agentId),
      typingCallbacks,
      deliver: async (payload, _info) => {
        await deps.deliverReplies({
          cfg: deps.cfg,
          replies: [payload],
          target: ctxPayload.To,
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountUuid: deps.accountUuid,
          accountId: deps.accountId,
          runtime: deps.runtime,
          maxBytes: deps.mediaMaxBytes,
          textLimit: deps.textLimit,
          replyContext: nativeReplyContext,
          chatType: entry.isGroup ? "group" : "direct",
        });
      },
      onError: (err, info) => {
        deps.runtime.error?.(danger(`signal ${info.kind} reply failed: ${String(err)}`));
      },
    });
    const inboundLastRouteSessionKey = resolveInboundLastRouteSessionKey({
      route,
      sessionKey: route.sessionKey,
    });

    await runChannelInboundEvent({
      channel: "signal",
      accountId: route.accountId,
      raw: entry,
      adapter: {
        ingest: () => ({
          id: entry.messageId ?? `${entry.timestamp ?? Date.now()}`,
          timestamp: entry.timestamp,
          rawText: entry.commandBody,
          raw: entry,
        }),
        resolveTurn: () => ({
          channel: "signal",
          accountId: route.accountId,
          routeSessionKey: route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession,
          record: {
            updateLastRoute: !entry.isGroup
              ? {
                  sessionKey: inboundLastRouteSessionKey,
                  channel: "signal",
                  to: entry.senderRecipient,
                  accountId: route.accountId,
                  mainDmOwnerPin: (() => {
                    if (inboundLastRouteSessionKey !== route.mainSessionKey) {
                      return undefined;
                    }
                    const pinnedOwner = resolvePinnedMainDmOwnerFromAllowlist({
                      dmScope: deps.cfg.session?.dmScope,
                      allowFrom: deps.allowFrom,
                      normalizeEntry: normalizeSignalAllowRecipient,
                    });
                    if (!pinnedOwner) {
                      return undefined;
                    }
                    return {
                      ownerRecipient: pinnedOwner,
                      senderRecipient: entry.senderRecipient,
                      onSkip: ({ ownerRecipient, senderRecipient }) => {
                        logVerbose(
                          `signal: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                        );
                      },
                    };
                  })(),
                }
              : undefined,
            onRecordError: (err) => {
              logVerbose(`signal: failed updating session meta: ${String(err)}`);
            },
          },
          history: {
            isGroup: entry.isGroup,
            historyKey,
            historyMap: deps.groupHistories,
            limit: deps.historyLimit,
          },
          onPreDispatchFailure: () =>
            settleReplyDispatcher({
              dispatcher,
              onSettled: () => markDispatchIdle(),
            }),
          runDispatch: async () => {
            try {
              if (statusReactionController) {
                void statusReactionController.setThinking();
              }
              return await dispatchInboundMessage({
                ctx: ctxPayload,
                cfg: deps.cfg,
                dispatcher,
                replyOptions: {
                  ...replyOptions,
                  disableBlockStreaming:
                    typeof deps.blockStreaming === "boolean" ? !deps.blockStreaming : undefined,
                  ...(statusReactionController
                    ? {
                        allowProgressCallbacksWhenSourceDeliverySuppressed: true,
                        allowToolLifecycleWhenProgressHidden: true,
                        onToolStart: async (payload: { name?: string }) => {
                          const toolName = payload.name?.trim();
                          if (toolName) {
                            await statusReactionController.setTool(toolName);
                          }
                        },
                        onCompactionStart: async () => {
                          await statusReactionController.setCompacting();
                        },
                        onCompactionEnd: async () => {
                          statusReactionController.cancelPending();
                          await statusReactionController.setThinking();
                        },
                      }
                    : {}),
                  onModelSelected,
                },
              });
            } finally {
              markDispatchIdle();
            }
          },
        }),
        onFinalize: (result) => {
          if (!statusReactionController) {
            return;
          }
          const hasFinalResponse =
            result.dispatched && hasVisibleInboundReplyDispatch(result.dispatchResult);
          const hasDeliveryFailure =
            result.dispatched && hasSignalStatusReplyDeliveryFailure(result.dispatchResult);
          void finalizeSignalStatusReaction({
            controller: statusReactionController,
            outcome: hasFinalResponse && !hasDeliveryFailure ? "done" : "error",
            hasFinalResponse,
            removeAckAfterReply: deps.cfg.messages?.removeAckAfterReply ?? false,
            timing: statusReactionTiming,
          }).catch((err: unknown) => {
            logVerbose(`signal: status reaction finalize failed: ${String(err)}`);
          });
        },
      },
    });
  }

  async function flushSignalInboundEntries(entries: SignalInboundEntry[]): Promise<void> {
    const last = entries.at(-1);
    if (!last) {
      return;
    }
    if (entries.length === 1) {
      await handleSignalInboundMessage(last);
      return;
    }
    const combinedText = entries
      .map((entry) => entry.bodyText)
      .filter(Boolean)
      .join("\\n");
    const combinedCommandBody = entries
      .map((entry) => entry.commandBody)
      .filter(Boolean)
      .join("\\n");
    if (!combinedText.trim()) {
      return;
    }
    await handleSignalInboundMessage({
      ...last,
      bodyText: combinedText,
      commandBody: combinedCommandBody,
      isBatched: true,
      nativeReplyBody: last.nativeReplyBody ?? last.bodyText,
      mediaPath: undefined,
      mediaType: undefined,
      mediaPaths: undefined,
      mediaTypes: undefined,
    });
  }

  async function retrySignalInboundFlush(
    entries: SignalInboundEntry[],
    initialError: unknown,
  ): Promise<void> {
    let lastError = initialError;
    for (const [attemptIndex, delayMs] of RETRYABLE_FLUSH_RETRY_DELAYS_MS.entries()) {
      const attempt = attemptIndex + 1;
      logVerbose(
        `signal: reply session init conflict, retrying ${entries.length} inbound message(s) in ${delayMs}ms (attempt ${attempt}/${RETRYABLE_FLUSH_RETRY_DELAYS_MS.length})`,
      );
      try {
        await sleep(delayMs, undefined, { ref: false, signal: deps.abortSignal });
      } catch (err) {
        if (deps.abortSignal?.aborted) {
          return;
        }
        throw err;
      }
      if (deps.abortSignal?.aborted) {
        return;
      }
      try {
        await flushSignalInboundEntries(entries);
        return;
      } catch (err) {
        if (deps.abortSignal?.aborted) {
          return;
        }
        lastError = err;
        if (!isSignalReplySessionInitConflictError(err)) {
          throw err;
        }
      }
    }
    throw lastError;
  }

  const { debouncer } = createChannelInboundDebouncer<SignalInboundEntry>({
    cfg: deps.cfg,
    channel: "signal",
    buildKey: (entry) => {
      const conversationId = entry.isGroup ? (entry.groupId ?? "unknown") : entry.senderPeerId;
      if (!conversationId || !entry.senderPeerId) {
        return null;
      }
      return `signal:${deps.accountId}:${conversationId}:${entry.senderPeerId}`;
    },
    shouldDebounce: (entry) => {
      return shouldDebounceTextInbound({
        text: entry.commandBody,
        cfg: deps.cfg,
        hasMedia: Boolean(entry.mediaPath || entry.mediaType || entry.mediaPaths?.length),
      });
    },
    onFlush: async (entries) => {
      // enqueue() awaits inline and overflow flushes, but not timer-backed work.
      // Drain tracked inline work on shutdown; stop delayed work with no owner.
      const hasActiveEnqueue = entries.some((entry) => activeEnqueueEntries.has(entry));
      if (!hasActiveEnqueue && deps.abortSignal?.aborted) {
        return;
      }
      try {
        await flushSignalInboundEntries(entries);
      } catch (err) {
        if (!isSignalReplySessionInitConflictError(err)) {
          throw err;
        }
        if (deps.abortSignal?.aborted) {
          return;
        }
        // Keep the current keyed debounce task reserved through backoff so a
        // newer same-conversation flush cannot overtake this failed batch.
        const retryTask = retrySignalInboundFlush(entries, err);
        deps.runTrackedTask?.(() => retryTask.catch(() => undefined));
        await retryTask;
      }
    },
    onError: (err) => {
      deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
    },
  });

  async function handleReactionOnlyInbound(params: {
    envelope: SignalEnvelope;
    sender: SignalSender;
    senderDisplay: string;
    reaction: SignalReactionMessage;
    hasBodyContent: boolean;
    accessDecision: { decision: "allow" | "block" | "pairing"; reasonCode: string };
  }): Promise<boolean> {
    if (params.hasBodyContent) {
      return false;
    }
    if (params.reaction.isRemove) {
      return true; // Ignore reaction removals
    }
    const emojiLabel = normalizeOptionalString(params.reaction.emoji) ?? "emoji";
    const senderName = params.envelope.sourceName ?? params.senderDisplay;
    logVerbose(`signal reaction: ${emojiLabel} from ${senderName}`);
    const groupId = params.reaction.groupInfo?.groupId ?? undefined;
    const groupName = params.reaction.groupInfo?.groupName ?? undefined;
    const isGroup = Boolean(groupId);
    const messageId = params.reaction.targetSentTimestamp
      ? String(params.reaction.targetSentTimestamp)
      : "unknown";
    const conversationKey = resolveSignalApprovalConversationKey(
      groupId ? `group:${groupId}` : `signal:${resolveSignalRecipient(params.sender)}`,
    );
    if (
      conversationKey &&
      (await maybeResolveSignalApprovalReaction({
        cfg: deps.cfg,
        accountId: deps.accountId,
        conversationKey,
        messageId,
        reactionKey: emojiLabel,
        actorId: formatSignalSenderId(params.sender),
        targetAuthor: params.reaction.targetAuthor,
        targetAuthorUuid: params.reaction.targetAuthorUuid,
        logVerboseMessage: logVerbose,
      }))
    ) {
      return true;
    }
    if (params.accessDecision.decision !== "allow") {
      logVerbose(
        `Blocked signal reaction sender ${params.senderDisplay} (${params.accessDecision.reasonCode})`,
      );
      return true;
    }
    const targets = deps.resolveSignalReactionTargets(params.reaction);
    const shouldNotify = deps.shouldEmitSignalReactionNotification({
      mode: deps.reactionMode,
      account: deps.account,
      targets,
      sender: params.sender,
      allowlist: deps.reactionAllowlist,
    });
    if (!shouldNotify) {
      return true;
    }

    const senderPeerId = resolveSignalPeerId(params.sender);
    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup,
      groupId,
      senderPeerId,
    });
    const groupLabel = isGroup ? `${groupName ?? "Signal Group"} id:${groupId}` : undefined;
    const text = deps.buildSignalReactionSystemEventText({
      emojiLabel,
      actorLabel: senderName,
      messageId,
      targetLabel: targets[0]?.display,
      groupLabel,
    });
    const senderId = formatSignalSenderId(params.sender);
    const contextKey = [
      "signal",
      "reaction",
      "added",
      messageId,
      senderId,
      emojiLabel,
      groupId ?? "",
    ]
      .filter(Boolean)
      .join(":");
    enqueueSystemEvent(text, {
      sessionKey: route.sessionKey,
      contextKey,
    });
    return true;
  }

  return async (event: { event?: string; data?: string }) => {
    if (event.event !== "receive" || !event.data) {
      return;
    }

    let payload: SignalReceivePayload | null;
    try {
      payload = JSON.parse(event.data) as SignalReceivePayload;
    } catch (err) {
      deps.runtime.error?.(`failed to parse event: ${String(err)}`);
      return;
    }
    if (payload?.exception?.message) {
      deps.runtime.error?.(`receive exception: ${payload.exception.message}`);
    }
    const envelope = payload?.envelope;
    if (!envelope) {
      return;
    }

    // Check for syncMessage (e.g., sentTranscript from other devices)
    // We need to check if it's from our own account to prevent self-reply loops
    const sender = resolveSignalSender(envelope);
    if (!sender) {
      return;
    }

    // Check if the message is from our own account to prevent loop/self-reply
    // This handles both phone number and UUID based identification
    const normalizedAccount = deps.account ? normalizeE164(deps.account) : undefined;
    const isOwnMessage =
      (sender.kind === "phone" && normalizedAccount != null && sender.e164 === normalizedAccount) ||
      (sender.kind === "uuid" && deps.accountUuid != null && sender.raw === deps.accountUuid);
    if (isOwnMessage) {
      return;
    }

    // Filter all sync messages (sentTranscript, readReceipts, etc.).
    // signal-cli may set syncMessage to null instead of omitting it, so
    // check property existence rather than truthiness to avoid replaying
    // the bot's own sent messages on daemon restart.
    if ("syncMessage" in envelope) {
      return;
    }

    const dataMessage = envelope.dataMessage ?? envelope.editMessage?.dataMessage;
    const reaction = deps.isSignalReactionMessage(envelope.reactionMessage)
      ? envelope.reactionMessage
      : deps.isSignalReactionMessage(dataMessage?.reaction)
        ? dataMessage?.reaction
        : null;

    // Replace ￼ (object replacement character) with @uuid or @phone from mentions
    // Signal encodes mentions as the object replacement character; hydrate them from metadata first.
    const rawMessage = dataMessage?.message ?? "";
    const normalizedMessage = renderSignalMentions(rawMessage, dataMessage?.mentions);
    const messageText = normalizedMessage.trim();
    const groupId = dataMessage?.groupInfo?.groupId ?? reaction?.groupInfo?.groupId ?? undefined;
    const isGroup = Boolean(groupId);
    const hasControlCommandInMessage = hasControlCommand(messageText, deps.cfg);

    const senderDisplay = formatSignalSenderDisplay(sender);
    const { senderAccess, commandAccess } = await resolveSignalAccessState({
      accountId: deps.accountId,
      dmPolicy: deps.dmPolicy,
      groupPolicy: deps.groupPolicy,
      allowFrom: deps.allowFrom,
      groupAllowFrom: deps.groupAllowFrom,
      sender,
      groupId,
      isGroup,
      cfg: deps.cfg,
      hasControlCommand: hasControlCommandInMessage,
    });
    const quoteText = normalizeOptionalString(dataMessage?.quote?.text) ?? "";
    const { contextVisibilityMode, quoteSenderAllowed, visibleQuoteText, visibleQuoteSender } =
      resolveSignalQuoteContext({
        cfg: deps.cfg,
        accountId: deps.accountId,
        isGroup,
        dataMessage,
        effectiveGroupAllow: senderAccess.effectiveGroupAllowFrom,
      });
    if (quoteText && !visibleQuoteText && isGroup) {
      logVerbose(
        `signal: drop quote context (mode=${contextVisibilityMode}, sender_allowed=${quoteSenderAllowed ? "yes" : "no"})`,
      );
    }
    const hasBodyContent =
      Boolean(messageText || visibleQuoteText) ||
      Boolean(!reaction && dataMessage?.attachments?.length);

    if (
      reaction &&
      (await handleReactionOnlyInbound({
        envelope,
        sender,
        senderDisplay,
        reaction,
        hasBodyContent,
        accessDecision: senderAccess,
      }))
    ) {
      return;
    }
    if (!dataMessage) {
      return;
    }

    const senderRecipient = resolveSignalRecipient(sender);
    const senderPeerId = resolveSignalPeerId(sender);
    const senderAllowId = formatSignalSenderId(sender);
    if (!senderRecipient) {
      return;
    }
    const senderIdLine = formatSignalPairingIdLine(sender);
    const groupName = dataMessage.groupInfo?.groupName ?? undefined;

    if (!isGroup) {
      const allowedDirectMessage = await handleSignalDirectMessageAccess({
        dmPolicy: deps.dmPolicy,
        dmAccessDecision: senderAccess.decision,
        senderId: senderAllowId,
        senderIdLine,
        senderDisplay,
        senderName: envelope.sourceName ?? undefined,
        accountId: deps.accountId,
        sendPairingReply: async (text) => {
          await sendMessageSignal(`signal:${senderRecipient}`, text, {
            cfg: deps.cfg,
            baseUrl: deps.baseUrl,
            account: deps.account,
            maxBytes: deps.mediaMaxBytes,
            accountId: deps.accountId,
          });
        },
        log: logVerbose,
      });
      if (!allowedDirectMessage) {
        return;
      }
    }
    if (isGroup) {
      if (senderAccess.decision !== "allow") {
        if (senderAccess.reasonCode === "group_policy_disabled") {
          logVerbose("Blocked signal group message (groupPolicy: disabled)");
        } else if (senderAccess.reasonCode === "group_policy_empty_allowlist") {
          logVerbose("Blocked signal group message (groupPolicy: allowlist, no groupAllowFrom)");
        } else {
          logVerbose(`Blocked signal group sender ${senderDisplay} (not in groupAllowFrom)`);
        }
        return;
      }
    }

    const commandAuthorized = commandAccess.authorized;
    if (isGroup && commandAccess.shouldBlockControlCommand) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "control command (unauthorized)",
        target: senderDisplay,
      });
      return;
    }

    const route = resolveSignalInboundRoute({
      cfg: deps.cfg,
      accountId: deps.accountId,
      isGroup,
      groupId,
      senderPeerId,
    });
    const inboundTimestamp =
      typeof envelope.timestamp === "number"
        ? envelope.timestamp
        : typeof dataMessage.timestamp === "number"
          ? dataMessage.timestamp
          : undefined;
    const nativeReplyTargetTimestamp =
      typeof envelope.editMessage?.targetSentTimestamp === "number"
        ? envelope.editMessage.targetSentTimestamp
        : inboundTimestamp;
    const messageId = typeof inboundTimestamp === "number" ? String(inboundTimestamp) : undefined;
    const replyToId =
      typeof nativeReplyTargetTimestamp === "number"
        ? String(nativeReplyTargetTimestamp)
        : undefined;
    const signalToRaw = isGroup ? `group:${groupId}` : `signal:${senderRecipient}`;
    const signalTo = normalizeSignalMessagingTarget(signalToRaw) ?? signalToRaw;
    const mentionRegexes = buildMentionRegexes(deps.cfg, route.agentId);
    const textWasMentioned = isGroup && matchesMentionPatterns(messageText, mentionRegexes);
    const nativeMentionFacts = resolveSignalMentionFacts(deps, rawMessage, dataMessage?.mentions);
    const wasMentioned = isGroup && (textWasMentioned || nativeMentionFacts.mentionsBot);
    const requireMention =
      isGroup &&
      resolveChannelGroupRequireMention({
        cfg: deps.cfg,
        channel: "signal",
        groupId,
        accountId: deps.accountId,
        configuredGroupDefaultsToNoMention: true,
      });
    const canDetectMention = mentionRegexes.length > 0 || nativeMentionFacts.canDetectBotMention;
    const mentionDecision = resolveInboundMentionDecision({
      facts: {
        canDetectMention,
        wasMentioned,
        hasAnyMention: nativeMentionFacts.hasAnyMention,
        implicitMentionKinds: [],
      },
      policy: {
        isGroup,
        requireMention,
        allowTextCommands: true,
        hasControlCommand: hasControlCommandInMessage,
        commandAuthorized,
      },
    });
    const effectiveWasMentioned = mentionDecision.effectiveWasMentioned;
    if (isGroup && requireMention && canDetectMention && mentionDecision.shouldSkip) {
      logInboundDrop({
        log: logVerbose,
        channel: "signal",
        reason: "no mention",
        target: senderDisplay,
      });
      const pendingPlaceholder = (() => {
        if (!dataMessage.attachments?.length) {
          return "";
        }
        // When we're skipping a message we intentionally avoid downloading attachments.
        // Still record a useful placeholder for pending-history context.
        if (deps.ignoreAttachments) {
          return "<media:attachment>";
        }
        const attachmentTypes = (dataMessage.attachments ?? []).map((attachment) =>
          typeof attachment?.contentType === "string" ? attachment.contentType : undefined,
        );
        if (attachmentTypes.length > 1) {
          return formatAttachmentSummaryPlaceholder(attachmentTypes);
        }
        const firstContentType = dataMessage.attachments?.[0]?.contentType;
        const pendingKind = kindFromMime(firstContentType ?? undefined);
        return pendingKind ? `<media:${pendingKind}>` : "<media:attachment>";
      })();
      const pendingBodyText = messageText || pendingPlaceholder || visibleQuoteText;
      const historyKey = groupId ?? "unknown";
      createChannelHistoryWindow({ historyMap: deps.groupHistories }).record({
        historyKey,
        limit: deps.historyLimit,
        entry: {
          sender: envelope.sourceName ?? senderDisplay,
          body: pendingBodyText,
          timestamp: envelope.timestamp ?? undefined,
          messageId:
            typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined,
        },
      });
      await registerSignalReplyContext({
        accountId: deps.accountId,
        to: signalTo,
        replyToId,
        author: senderRecipient,
        body: pendingBodyText,
        sourceTimestamp: inboundTimestamp,
      });
      const signalGroupPolicy = resolveChannelGroupPolicy({
        cfg: deps.cfg,
        channel: "signal",
        groupId,
        accountId: deps.accountId,
      });
      if (
        (signalGroupPolicy.groupConfig?.ingest ?? signalGroupPolicy.defaultConfig?.ingest) === true
      ) {
        const canonicalGroupTarget =
          normalizeSignalMessagingTarget(`group:${groupId}`) ?? `group:${groupId}`;
        fireAndForgetHook(
          triggerInternalHook(
            createInternalHookEvent(
              "message",
              "received",
              route.sessionKey,
              toInternalMessageReceivedContext({
                from: `group:${groupId}`,
                to: canonicalGroupTarget,
                content: pendingBodyText,
                timestamp: envelope.timestamp ?? undefined,
                channelId: "signal",
                accountId: deps.accountId,
                conversationId: canonicalGroupTarget,
                messageId:
                  typeof envelope.timestamp === "number" ? String(envelope.timestamp) : undefined,
                senderId: senderDisplay,
                senderName: envelope.sourceName ?? undefined,
                provider: "signal",
                surface: "signal",
                originatingChannel: "signal",
                originatingTo: canonicalGroupTarget,
                isGroup: true,
                groupId: canonicalGroupTarget,
              }),
            ),
          ),
          "signal: mention-skip message hook failed",
        );
      }
      return;
    }

    let mediaPath: string | undefined;
    let mediaType: string | undefined;
    const mediaPaths: string[] = [];
    const mediaTypes: string[] = [];
    let placeholder = "";
    const attachments = dataMessage.attachments ?? [];
    let unavailableAttachmentCount = deps.ignoreAttachments ? attachments.length : 0;
    if (!deps.ignoreAttachments) {
      for (const attachment of attachments) {
        if (!attachment?.id) {
          unavailableAttachmentCount += 1;
          continue;
        }
        try {
          const fetched = await deps.fetchAttachment({
            baseUrl: deps.baseUrl,
            account: deps.account,
            attachment,
            sender: senderRecipient,
            groupId,
            maxBytes: deps.mediaMaxBytes,
          });
          if (fetched) {
            mediaPaths.push(fetched.path);
            mediaTypes.push(
              fetched.contentType ?? attachment.contentType ?? "application/octet-stream",
            );
            if (!mediaPath) {
              mediaPath = fetched.path;
              mediaType = fetched.contentType ?? attachment.contentType ?? undefined;
            }
          } else {
            unavailableAttachmentCount += 1;
          }
        } catch (err) {
          unavailableAttachmentCount += 1;
          deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
        }
      }
    }

    if (mediaPaths.length > 1) {
      placeholder = formatAttachmentSummaryPlaceholder(mediaTypes);
    } else {
      const kind = kindFromMime(mediaType ?? undefined);
      if (kind) {
        placeholder = `<media:${kind}>`;
      } else if (mediaPaths.length > 0) {
        placeholder = "<media:attachment>";
      }
    }

    let bodyText = messageText || placeholder || visibleQuoteText || "";
    if (unavailableAttachmentCount > 0) {
      const attachmentLabel = unavailableAttachmentCount === 1 ? "attachment" : "attachments";
      bodyText = formatInboundMediaUnavailableText({
        body: bodyText,
        notice: `[signal ${unavailableAttachmentCount > 1 ? `${unavailableAttachmentCount} ` : ""}${attachmentLabel} unavailable]`,
      });
    }
    if (!bodyText) {
      return;
    }

    if (deps.sendReadReceipts && !deps.readReceiptsViaDaemon && !isGroup && inboundTimestamp) {
      try {
        await sendReadReceiptSignal(`signal:${senderRecipient}`, inboundTimestamp, {
          cfg: deps.cfg,
          baseUrl: deps.baseUrl,
          account: deps.account,
          accountId: deps.accountId,
        });
      } catch (err) {
        logVerbose(`signal read receipt failed for ${senderDisplay}: ${String(err)}`);
      }
    } else if (
      deps.sendReadReceipts &&
      !deps.readReceiptsViaDaemon &&
      !isGroup &&
      !inboundTimestamp
    ) {
      logVerbose(`signal read receipt skipped (missing timestamp) for ${senderDisplay}`);
    }

    const senderName = envelope.sourceName ?? senderDisplay;
    await registerSignalReplyContext({
      accountId: deps.accountId,
      to: signalTo,
      replyToId,
      author: senderRecipient,
      body: bodyText,
      sourceTimestamp: inboundTimestamp,
    });
    const entry: SignalInboundEntry = {
      senderName,
      senderDisplay,
      senderRecipient,
      senderPeerId,
      groupId,
      groupName,
      isGroup,
      bodyText,
      commandBody: messageText,
      timestamp: inboundTimestamp,
      messageId,
      replyToId,
      mediaPath,
      mediaType,
      mediaPaths: mediaPaths.length > 0 ? mediaPaths : undefined,
      mediaTypes: mediaTypes.length > 0 ? mediaTypes : undefined,
      commandAuthorized,
      canDetectMention,
      requireMention,
      wasMentioned: effectiveWasMentioned,
      replyToBody: visibleQuoteText || undefined,
      replyToSender: visibleQuoteSender,
      replyToIsQuote: visibleQuoteText ? true : undefined,
    };
    activeEnqueueEntries.add(entry);
    try {
      await debouncer.enqueue(entry);
    } finally {
      activeEnqueueEntries.delete(entry);
    }
  };
}
