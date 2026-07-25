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
  toInboundMediaFacts,
  toHistoryMediaEntries,
  type ChannelInboundMediaInput,
  type ChannelInboundTurnPlan,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  bindIngressLifecycleToReplyOptions,
  createChannelMessageReplyPipeline,
} from "openclaw/plugin-sdk/channel-outbound";
import {
  resolveChannelGroupPolicy,
  resolveChannelGroupRequireMention,
} from "openclaw/plugin-sdk/channel-policy";
import { isControlCommandMessage } from "openclaw/plugin-sdk/command-detection";
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
import { resolveAgentRoute, resolveInboundLastRouteSessionKey } from "openclaw/plugin-sdk/routing";
import { danger, logVerbose, shouldLogVerbose } from "openclaw/plugin-sdk/runtime-env";
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
import { formatSignalMediaText } from "../media-text.js";
import { normalizeSignalMessagingTarget } from "../normalize.js";
import { maybeResolveSignalQuestionReaction } from "../question-reactions.js";
import { resolveSignalReactionLevel } from "../reaction-level.js";
import { registerSignalReplyContext } from "../reply-authors.js";
import { sendReactionSignal, type SignalReactionOpts } from "../send-reactions.js";
import { sendMessageSignal, sendReadReceiptSignal, sendTypingSignal } from "../send.js";
import type { SignalIngressLifecycle } from "../signal-ingress.js";
import { handleSignalDirectMessageAccess, resolveSignalAccessState } from "./access-policy.js";
import {
  createSignalPendingInboundRegistry,
  resolveSignalControlLaneKey,
  resolveSignalInboundDebounceKey,
  type SignalInboundEntry,
} from "./event-handler.control-lane.js";
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

type SignalStatusDispatchResult = {
  failedCounts?: Partial<Record<"tool" | "block" | "final", number>>;
};

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
}): Promise<void> {
  if (params.outcome === "done") {
    await params.controller.setDone();
  } else {
    await params.controller.setError();
  }
  await params.controller.restoreInitial();
}

export function createSignalEventHandler(deps: SignalEventHandlerDeps) {
  const statusReactionTiming = deps.statusReactionTiming ?? DEFAULT_TIMING;
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
            body: `${[historyEntry.body, formatSignalMediaText(historyEntry.media ?? [])]
              .filter(Boolean)
              .join("\n")}${historyEntry.messageId ? ` [id:${historyEntry.messageId}]` : ""}`,
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
    const media = toInboundMediaFacts(entry.media);
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
        dmScope: route.dmScope,
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
      sessionTranscript: { historyLimit: entry.isGroup ? deps.historyLimit : 0 },
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
              },
            },
            initialEmoji: ackReaction,
            emojis: resolveSignalStatusReactionEmojis(undefined),
            timing: statusReactionTiming,
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
    const dispatcherOptions: NonNullable<ChannelInboundTurnPlan["dispatcherOptions"]> = {
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(deps.cfg, route.agentId),
      typingCallbacks,
    };
    const delivery: ChannelInboundTurnPlan["delivery"] = {
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
    };
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
          cfg: deps.cfg,
          channel: "signal",
          accountId: route.accountId,
          route: { agentId: route.agentId, sessionKey: route.sessionKey },
          ctxPayload,
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
          afterRecord: () => {
            if (statusReactionController) {
              void statusReactionController.setThinking();
            }
          },
          dispatcherOptions,
          delivery,
          // Signal retries the whole debounced flush below so the keyed lane and durable claims
          // remain owned during backoff; a nested dispatch retry breaks shutdown cancellation.
          sessionInitRetry: { delaysMs: [] },
          replyOptions: {
            ...(entry.turnAdoptionLifecycle
              ? bindIngressLifecycleToReplyOptions(entry.turnAdoptionLifecycle)
              : {}),
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
          }).catch((err: unknown) => {
            logVerbose(`signal: status reaction finalize failed: ${String(err)}`);
          });
        },
      },
    });
  }

  // Fan one settlement out to every constituent claim of a (possibly merged)
  // flush, and track whether the reply lane took ownership. A merged turn owns
  // ALL constituent queue claims: adoption must complete each of them or the
  // unmerged events would stall and redeliver duplicates.
  function buildFlushIngressLifecycle(entries: SignalInboundEntry[]): {
    lifecycle: SignalIngressLifecycle | undefined;
    settle: () => Promise<void>;
  } {
    const lifecycles = entries
      .map((entry) => entry.turnAdoptionLifecycle)
      .filter((lifecycle) => lifecycle !== undefined);
    const [firstLifecycle] = lifecycles;
    if (!firstLifecycle) {
      return { lifecycle: undefined, settle: async () => {} };
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
          await Promise.all(
            lifecycles.map((lifecycle) => Promise.resolve(lifecycle.onAbandoned())),
          );
        },
      },
      // Terminal no-dispatch (gated, whitespace-only, deliberate skip) must
      // still tombstone the claims — mirrors the drain's skipped→completed
      // mapping; leaving them deferred would watchdog-dead-letter live turns.
      settle: async () => {
        if (!handedOff) {
          await adoptAll();
        }
      },
    };
  }

  async function flushSignalInboundEntries(entries: SignalInboundEntry[]): Promise<void> {
    const last = entries.at(-1);
    if (!last) {
      return;
    }
    const { lifecycle, settle } = buildFlushIngressLifecycle(entries);
    if (entries.length === 1) {
      await handleSignalInboundMessage(
        lifecycle ? { ...last, turnAdoptionLifecycle: lifecycle } : last,
      );
      await settle();
      return;
    }
    const combinedText = entries
      .map((entry) => entry.bodyText)
      .filter(Boolean)
      .join("\n");
    const combinedCommandBody = entries
      .map((entry) => entry.commandBody)
      .filter(Boolean)
      .join("\n");
    if (!combinedText.trim()) {
      await settle();
      return;
    }
    await handleSignalInboundMessage({
      ...last,
      bodyText: combinedText,
      commandBody: combinedCommandBody,
      ...(lifecycle ? { turnAdoptionLifecycle: lifecycle } : {}),
      isBatched: true,
      nativeReplyBody: last.nativeReplyBody ?? last.bodyText,
      media: entries.flatMap((entry) => entry.media ?? []),
    });
    await settle();
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

  const flushDebouncedSignalInboundEntries = async (entries: SignalInboundEntry[]) => {
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
      const retryTask = retrySignalInboundFlush(entries, err).catch(
        async (terminalError: unknown) => {
          // Exhausted retries: release the drain claims so queue retry policy
          // owns redelivery instead of the stall watchdog dead-lettering them.
          await Promise.all(
            entries.map((entry) => Promise.resolve(entry.turnAdoptionLifecycle?.onAbandoned())),
          );
          throw terminalError;
        },
      );
      deps.runTrackedTask?.(() => retryTask.catch(() => undefined));
      await retryTask;
    }
  };
  const reportSignalInboundFlushError = (err: unknown) => {
    deps.runtime.error?.(`signal debounce flush failed: ${String(err)}`);
  };
  const pendingInboundRegistry = createSignalPendingInboundRegistry(deps.accountId);
  const flushNormalSignalInboundEntries = pendingInboundRegistry.completeAfter(
    flushDebouncedSignalInboundEntries,
  );

  const { debouncer } = createChannelInboundDebouncer<SignalInboundEntry>({
    cfg: deps.cfg,
    channel: "signal",
    buildKey: (entry) => resolveSignalInboundDebounceKey(deps.accountId, entry),
    shouldDebounce: (entry) =>
      shouldDebounceTextInbound({
        text: entry.commandBody,
        cfg: deps.cfg,
        hasMedia: entry.media?.some((media) => Boolean(media.path || media.url)) === true,
      }),
    onFlush: flushNormalSignalInboundEntries,
    onError: reportSignalInboundFlushError,
    onCancel: pendingInboundRegistry.complete,
  });
  const { debouncer: controlDebouncer } = createChannelInboundDebouncer<SignalInboundEntry>({
    cfg: deps.cfg,
    channel: "signal",
    // Controls bypass normal batching but retain FIFO ordering with each other.
    serializeImmediate: true,
    buildKey: (entry) => resolveSignalControlLaneKey(deps.accountId, entry),
    shouldDebounce: () => false,
    onFlush: flushDebouncedSignalInboundEntries,
    onError: reportSignalInboundFlushError,
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
    if (
      conversationKey &&
      (await maybeResolveSignalQuestionReaction({
        cfg: deps.cfg,
        accountId: deps.accountId,
        conversationKey,
        messageId,
        reactionKey: emojiLabel,
        isRemove: Boolean(params.reaction.isRemove),
        actorId: formatSignalSenderId(params.sender),
        targetAuthor: params.reaction.targetAuthor,
        targetAuthorUuid: params.reaction.targetAuthorUuid,
        logDebug: logVerbose,
      }))
    ) {
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

  return async (
    event: { event?: string; data?: string },
    turnAdoptionLifecycle?: SignalIngressLifecycle,
  ): Promise<{ kind: "deferred" } | { kind: "failed-retryable"; error: unknown } | void> => {
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
    const hasControlCommandInMessage = isControlCommandMessage(messageText, deps.cfg);

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
      const pendingMedia: ChannelInboundMediaInput[] = (dataMessage.attachments ?? []).map(
        (attachment) => {
          const contentType = attachment?.contentType ?? undefined;
          return { contentType, kind: kindFromMime(contentType) ?? "unknown" };
        },
      );
      // Skipped messages intentionally avoid downloads; facts stay type-only.
      const pendingMediaText = formatSignalMediaText(pendingMedia);
      const pendingBodyText = messageText || pendingMediaText || visibleQuoteText;
      const historyKey = groupId ?? "unknown";
      createChannelHistoryWindow({ historyMap: deps.groupHistories }).record({
        historyKey,
        limit: deps.historyLimit,
        entry: {
          sender: envelope.sourceName ?? senderDisplay,
          body: messageText || visibleQuoteText,
          media: toHistoryMediaEntries(pendingMedia),
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
        body: messageText || visibleQuoteText,
        media: pendingMedia,
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

    const attachments = dataMessage.attachments ?? [];
    const mediaFacts: ChannelInboundMediaInput[] = attachments.map((attachment) => {
      const contentType = attachment?.contentType ?? undefined;
      return { contentType, kind: kindFromMime(contentType) ?? "unknown" };
    });
    let unavailableAttachmentCount = deps.ignoreAttachments ? attachments.length : 0;
    if (!deps.ignoreAttachments) {
      for (const [index, attachment] of attachments.entries()) {
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
            const contentType =
              fetched.contentType ?? attachment.contentType ?? "application/octet-stream";
            mediaFacts[index] = {
              path: fetched.path,
              url: fetched.path,
              contentType,
              kind: kindFromMime(contentType) ?? "unknown",
            };
          } else {
            unavailableAttachmentCount += 1;
          }
        } catch (err) {
          unavailableAttachmentCount += 1;
          deps.runtime.error?.(danger(`attachment fetch failed: ${String(err)}`));
        }
      }
    }

    let bodyText = messageText;
    if (unavailableAttachmentCount > 0) {
      const attachmentLabel = unavailableAttachmentCount === 1 ? "attachment" : "attachments";
      bodyText = formatInboundMediaUnavailableText({
        body: bodyText,
        notice: `[signal ${unavailableAttachmentCount > 1 ? `${unavailableAttachmentCount} ` : ""}${attachmentLabel} unavailable]`,
      });
    }
    if (!bodyText && mediaFacts.length === 0 && !visibleQuoteText) {
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
      body: messageText,
      media: mediaFacts,
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
      nativeReplyBody: [messageText, formatSignalMediaText(mediaFacts)].filter(Boolean).join("\n"),
      commandBody: messageText,
      timestamp: inboundTimestamp,
      messageId,
      replyToId,
      media: mediaFacts,
      commandAuthorized,
      canDetectMention,
      requireMention,
      wasMentioned: effectiveWasMentioned,
      replyToBody: visibleQuoteText || undefined,
      replyToSender: visibleQuoteSender,
      replyToIsQuote: visibleQuoteText ? true : undefined,
      turnAdoptionLifecycle,
    };
    pendingInboundRegistry.cancelPendingOnAbort(entry, debouncer.cancelKey);
    // Normal and stateful turns stay on the existing ingress path so core session admission owns
    // queueing and lifecycle mutations; only the narrow safe set uses channel-level serialization.
    const inboundLane = resolveSignalControlLaneKey(deps.accountId, entry)
      ? controlDebouncer
      : debouncer;
    if (inboundLane === debouncer) {
      pendingInboundRegistry.track(entry);
    }
    activeEnqueueEntries.add(entry);
    try {
      await inboundLane.enqueue(entry);
    } finally {
      activeEnqueueEntries.delete(entry);
    }
    if (turnAdoptionLifecycle) {
      // Debounce merging stays on under the drain: the claim defers (held,
      // watchdog armed) and completes when the merged turn adopts. Returning
      // completed here would tombstone before the buffered flush dispatches,
      // losing the message if the gateway dies inside the debounce window.
      return { kind: "deferred" };
    }
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
