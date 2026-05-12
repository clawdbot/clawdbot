import fs from "node:fs/promises";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import { logTypingFailure } from "openclaw/plugin-sdk/channel-feedback";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import {
  deliverInboundReplyWithMessageSendContext,
  createChannelMessageReplyPipeline,
} from "openclaw/plugin-sdk/channel-message";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeScpRemoteHost } from "openclaw/plugin-sdk/host-runtime";
import { runInboundReplyTurn } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { isInboundPathAllowed, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { DEFAULT_GROUP_HISTORY_LIMIT, type HistoryEntry } from "openclaw/plugin-sdk/reply-history";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { createReplyDispatcherWithTyping } from "openclaw/plugin-sdk/reply-runtime";
import { settleReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { getRuntimeConfig } from "openclaw/plugin-sdk/runtime-config-snapshot";
import { danger, logVerbose, shouldLogVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import {
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/runtime-group-policy";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/session-store-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/transport-ready-runtime";
import { resolveIMessageAccount } from "../accounts.js";
import { markIMessageChatRead, sendIMessageTyping } from "../chat.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "../client.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "../constants.js";
import {
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} from "../media-contract.js";
import {
  getCachedIMessagePrivateApiStatus,
  imessageRpcSupportsMethod,
  probeIMessage,
} from "../probe.js";
import { sendMessageIMessage } from "../send.js";
import { normalizeIMessageHandle } from "../targets.js";
import { attachIMessageMonitorAbortHandler } from "./abort-handler.js";
import { runIMessageCatchup } from "./catchup-bridge.js";
import { resolveCatchupConfig } from "./catchup.js";
import { combineIMessagePayloads } from "./coalesce.js";
import { createIMessageEchoCachingSend, deliverReplies } from "./deliver.js";
import { createSentMessageCache } from "./echo-cache.js";
import {
  warnGroupAllowlistDropPerChatOnce,
  warnGroupAllowlistMisconfigOnce,
} from "./group-allowlist-warnings.js";
import {
  buildIMessageInboundContext,
  resolveIMessageReactionContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import { createLoopRateLimiter } from "./loop-rate-limiter.js";
import { parseIMessageNotification } from "./parse-notification.js";
import { enqueueIMessageReactionSystemEvent } from "./reaction-system-event.js";
import { normalizeAllowList, resolveRuntime } from "./runtime.js";
import { createSelfChatCache } from "./self-chat-cache.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./types.js";
import { sanitizeIMessageWatchErrorPayload } from "./watch-error-log.js";

const WATCH_SUBSCRIBE_MAX_ATTEMPTS = 3;
const WATCH_SUBSCRIBE_RETRY_DELAY_MS = 1_000;

async function detectRemoteHostFromCliPath(cliPath: string): Promise<string | undefined> {
  try {
    const expanded = cliPath.startsWith("~")
      ? cliPath.replace(/^~/, process.env.HOME ?? "")
      : cliPath;
    const content = await fs.readFile(expanded, "utf8");

    const userHostMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/);
    if (userHostMatch) {
      return userHostMatch[1];
    }

    const hostOnlyMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z][a-zA-Z0-9._-]*)\s+\S*\bimsg\b/);
    return hostOnlyMatch?.[1];
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      logVerbose(
        `imessage: failed to inspect cliPath ${cliPath} for remoteHost detection: ${String(err)}`,
      );
    }
    return undefined;
  }
}

const warnIfImsgUpgradeNeeded = (() => {
  let fired = false;
  return {
    fireOnce: (
      rpcMethods: readonly string[],
      runtime: { log?: (msg: string) => void; error?: (msg: string) => void },
    ) => {
      if (fired) {
        return;
      }
      fired = true;
      const detail =
        rpcMethods.length === 0
          ? "imsg build pre-dates the rpc_methods capability list"
          : `imsg rpc_methods=[${rpcMethods.join(", ")}] does not include typing/read`;
      runtime.log?.(
        warn(
          `imessage: typing indicators / read receipts gated off (${detail}). ` +
            `Upgrade imsg (current bridge needs typing+read in rpc_methods).`,
        ),
      );
    },
  };
})();

function isRetriableWatchSubscribeStartupError(error: unknown): boolean {
  return /imsg rpc timeout \(watch\.subscribe\)|imsg rpc (closed|exited|not running)/i.test(
    String(error),
  );
}

async function waitForWatchSubscribeRetryDelay(params: {
  ms: number;
  abortSignal?: AbortSignal;
}): Promise<void> {
  if (params.ms <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      params.abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    }, params.ms);
    const onAbort = () => {
      clearTimeout(timer);
      params.abortSignal?.removeEventListener("abort", onAbort);
      resolve();
    };
    params.abortSignal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function monitorIMessageProvider(opts: MonitorIMessageOpts = {}): Promise<void> {
  const runtime = resolveRuntime(opts);
  const cfg = opts.config ?? getRuntimeConfig();
  const accountInfo = resolveIMessageAccount({
    cfg,
    accountId: opts.accountId,
  });
  const imessageCfg = accountInfo.config;
  const historyLimit = Math.max(
    0,
    imessageCfg.historyLimit ??
      cfg.messages?.groupChat?.historyLimit ??
      DEFAULT_GROUP_HISTORY_LIMIT,
  );
  const groupHistories = new Map<string, HistoryEntry[]>();
  const sentMessageCache = createSentMessageCache();
  const selfChatCache = createSelfChatCache();
  const loopRateLimiter = createLoopRateLimiter();
  const textLimit = resolveTextChunkLimit(cfg, "imessage", accountInfo.accountId);
  const allowFrom = normalizeAllowList(opts.allowFrom ?? imessageCfg.allowFrom);
  const groupAllowFrom = normalizeAllowList(
    opts.groupAllowFrom ??
      imessageCfg.groupAllowFrom ??
      (imessageCfg.allowFrom && imessageCfg.allowFrom.length > 0 ? imessageCfg.allowFrom : []),
  );
  const defaultGroupPolicy = resolveDefaultGroupPolicy(cfg);
  const { groupPolicy, providerMissingFallbackApplied } = resolveOpenProviderRuntimeGroupPolicy({
    providerConfigPresent: cfg.channels?.imessage !== undefined,
    groupPolicy: imessageCfg.groupPolicy,
    defaultGroupPolicy,
  });
  warnMissingProviderGroupPolicyFallbackOnce({
    providerMissingFallbackApplied,
    providerKey: "imessage",
    accountId: accountInfo.accountId,
    log: (message) => runtime.log?.(warn(message)),
  });
  warnGroupAllowlistMisconfigOnce({
    groupPolicy,
    groups: imessageCfg.groups,
    accountId: accountInfo.accountId,
    log: (message) => runtime.log?.(warn(message)),
  });
  const dmPolicy = imessageCfg.dmPolicy ?? "pairing";
  const includeAttachments = opts.includeAttachments ?? imessageCfg.includeAttachments ?? false;
  const mediaMaxBytes = (opts.mediaMaxMb ?? imessageCfg.mediaMaxMb ?? 16) * 1024 * 1024;
  const cliPath = opts.cliPath ?? imessageCfg.cliPath ?? "imsg";
  const dbPath = opts.dbPath ?? imessageCfg.dbPath;
  const probeTimeoutMs = imessageCfg.probeTimeoutMs ?? DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS;
  const attachmentRoots = resolveIMessageAttachmentRoots({
    cfg,
    accountId: accountInfo.accountId,
  });
  const remoteAttachmentRoots = resolveIMessageRemoteAttachmentRoots({
    cfg,
    accountId: accountInfo.accountId,
  });

  // Resolve remoteHost: explicit config, or auto-detect from SSH wrapper script.
  // Accept only a safe host token to avoid option/argument injection into SCP.
  const configuredRemoteHost = normalizeScpRemoteHost(imessageCfg.remoteHost);
  if (imessageCfg.remoteHost && !configuredRemoteHost) {
    logVerbose("imessage: ignoring unsafe channels.imessage.remoteHost value");
  }

  let remoteHost = configuredRemoteHost;
  if (!remoteHost && cliPath && cliPath !== "imsg") {
    const detected = await detectRemoteHostFromCliPath(cliPath);
    const normalizedDetected = normalizeScpRemoteHost(detected);
    if (detected && !normalizedDetected) {
      logVerbose("imessage: ignoring unsafe auto-detected remoteHost from cliPath");
    }
    remoteHost = normalizedDetected;
    if (remoteHost) {
      logVerbose(`imessage: detected remoteHost=${remoteHost} from cliPath`);
    }
  }

  // When `coalesceSameSenderDms` is enabled and the user has not set an
  // explicit inbound debounce for this channel, widen the window to 2500 ms.
  // Apple's split-send for `<command> <URL>` arrives ~0.8-2.0 s apart on most
  // setups, so the legacy 0 ms default would flush the command alone before
  // the URL row reaches the debouncer.
  const coalesceSameSenderDms = imessageCfg.coalesceSameSenderDms === true;
  const inboundCfg = cfg.messages?.inbound;
  const hasExplicitInboundDebounce =
    typeof inboundCfg?.debounceMs === "number" ||
    typeof inboundCfg?.byChannel?.imessage === "number";
  const debounceMsOverride =
    coalesceSameSenderDms && !hasExplicitInboundDebounce ? 2500 : undefined;

  const { debouncer: inboundDebouncer } = createChannelInboundDebouncer<{
    message: IMessagePayload;
  }>({
    cfg,
    channel: "imessage",
    debounceMsOverride,
    buildKey: (entry) => {
      const msg = entry.message;
      const sender = msg.sender?.trim();
      if (!sender) {
        return null;
      }
      const conversationId =
        msg.chat_id != null
          ? `chat:${msg.chat_id}`
          : (msg.chat_guid ?? msg.chat_identifier ?? "unknown");

      // With coalesceSameSenderDms enabled, DMs key on chat:sender so two
      // distinct user sends — `Dump` followed by a pasted URL that Apple
      // delivers as a separate row — fall into the same bucket and merge
      // into one agent turn. Group chats fall through to the legacy key so
      // shouldDebounce can route them to the instant-dispatch path and
      // preserve multi-user turn structure.
      if (coalesceSameSenderDms && msg.is_group !== true) {
        return `imessage:${accountInfo.accountId}:dm:${conversationId}:${sender}`;
      }

      return `imessage:${accountInfo.accountId}:${conversationId}:${sender}`;
    },
    shouldDebounce: (entry) => {
      const msg = entry.message;
      if (resolveIMessageReactionContext(msg, (msg.text ?? "").trim())) {
        return false;
      }
      // From-me messages are cached, not processed — never debounce.
      if (msg.is_from_me === true) {
        return false;
      }

      // With coalesceSameSenderDms enabled, debounce DM messages aggressively
      // (text, media, control commands) so split-sends — `Dump <URL>`,
      // `Save 📎image caption`, and rapid floods — merge into one agent
      // turn. Group chats keep instant dispatch so the bot stays responsive
      // when multiple people are typing.
      if (coalesceSameSenderDms) {
        return msg.is_group !== true;
      }

      // Legacy gate: text-only, no control commands, no media.
      return shouldDebounceTextInbound({
        text: msg.text,
        cfg,
        hasMedia: Boolean(msg.attachments && msg.attachments.length > 0),
      });
    },
    onFlush: async (entries) => {
      if (entries.length === 0) {
        return;
      }
      if (entries.length === 1) {
        await handleMessageNow(entries[0].message);
        return;
      }

      const combined = combineIMessagePayloads(entries.map((e) => e.message));
      if (shouldLogVerbose()) {
        const text = combined.text ?? "";
        const preview = text.slice(0, 50);
        const ellipsis = text.length > 50 ? "..." : "";
        logVerbose(`[imessage] coalesced ${entries.length} messages: "${preview}${ellipsis}"`);
      }
      await handleMessageNow(combined);
    },
    onError: (err) => {
      runtime.error?.(`imessage debounce flush failed: ${String(err)}`);
    },
  });

  let client: IMessageRpcClient | undefined;
  let detachAbortHandler = () => {};
  const getActiveClient = () => {
    if (!client) {
      throw new Error("imessage monitor client not initialized");
    }
    return client;
  };

  async function handleMessageNow(message: IMessagePayload) {
    const messageText = (message.text ?? "").trim();

    const attachments = includeAttachments ? (message.attachments ?? []) : [];
    const effectiveAttachmentRoots = remoteHost ? remoteAttachmentRoots : attachmentRoots;
    const validAttachments = attachments.filter((entry) => {
      const attachmentPath = entry?.original_path?.trim();
      if (!attachmentPath || entry?.missing) {
        return false;
      }
      if (isInboundPathAllowed({ filePath: attachmentPath, roots: effectiveAttachmentRoots })) {
        return true;
      }
      logVerbose(`imessage: dropping inbound attachment outside allowed roots: ${attachmentPath}`);
      return false;
    });
    const firstAttachment = validAttachments[0];
    const mediaPath = firstAttachment?.original_path ?? undefined;
    const mediaType = firstAttachment?.mime_type ?? undefined;
    // Build arrays for all attachments (for multi-image support)
    const mediaPaths = validAttachments.map((a) => a.original_path).filter(Boolean) as string[];
    const mediaTypes = validAttachments.map((a) => a.mime_type ?? undefined);
    const kind = kindFromMime(mediaType ?? undefined);
    const placeholder = kind
      ? `<media:${kind}>`
      : validAttachments.length
        ? "<media:attachment>"
        : "";
    const bodyText = messageText || placeholder;

    const storeAllowFrom = await readChannelAllowFromStore(
      "imessage",
      process.env,
      accountInfo.accountId,
    ).catch(() => []);
    const decision = await resolveIMessageInboundDecision({
      cfg,
      accountId: accountInfo.accountId,
      message,
      opts,
      messageText,
      bodyText,
      allowFrom,
      groupAllowFrom,
      groupPolicy,
      dmPolicy,
      storeAllowFrom,
      historyLimit,
      groupHistories,
      echoCache: sentMessageCache,
      selfChatCache,
      reactionNotifications: imessageCfg.reactionNotifications,
      logVerbose,
    });

    // Build conversation key for rate limiting (used by both drop and dispatch paths).
    const chatId = message.chat_id ?? undefined;
    const senderForKey = (message.sender ?? "").trim();
    const conversationKey = chatId != null ? `group:${chatId}` : `dm:${senderForKey}`;
    const rateLimitKey = `${accountInfo.accountId}:${conversationKey}`;

    if (decision.kind === "drop") {
      // Record echo/reflection drops so the rate limiter can detect sustained loops.
      // Only loop-related drop reasons feed the counter; policy/mention/empty drops
      // are normal and should not escalate.
      const isLoopDrop =
        decision.reason === "echo" ||
        decision.reason === "self-chat echo" ||
        decision.reason === "reflected assistant content" ||
        decision.reason === "from me";
      if (isLoopDrop) {
        loopRateLimiter.record(rateLimitKey);
      }
      // Surface the silent-allowlist drop once per chat. Without this, operators
      // who set groupPolicy="allowlist" without populating
      // channels.imessage.groups see every group message vanish at default log
      // level. See issue #78749.
      if (decision.reason === "group id not in allowlist") {
        warnGroupAllowlistDropPerChatOnce({
          accountId: accountInfo.accountId,
          chatId: message.chat_id ?? undefined,
          log: (msg) => runtime.log?.(warn(msg)),
        });
      }
      return;
    }

    // After repeated echo/reflection drops for a conversation, suppress all
    // remaining messages as a safety net against amplification that slips
    // through the primary guards.
    if (decision.kind === "dispatch" && loopRateLimiter.isRateLimited(rateLimitKey)) {
      logVerbose(`imessage: rate-limited conversation ${conversationKey} (echo loop detected)`);
      return;
    }

    if (decision.kind === "pairing") {
      const sender = (message.sender ?? "").trim();
      if (!sender) {
        return;
      }
      await createChannelPairingChallengeIssuer({
        channel: "imessage",
        upsertPairingRequest: async ({ id, meta }) =>
          await upsertChannelPairingRequest({
            channel: "imessage",
            id,
            accountId: accountInfo.accountId,
            meta,
          }),
      })({
        senderId: decision.senderId,
        senderIdLine: `Your iMessage sender id: ${decision.senderId}`,
        meta: {
          sender: decision.senderId,
          chatId: chatId ? String(chatId) : undefined,
        },
        onCreated: () => {
          logVerbose(`imessage pairing request sender=${decision.senderId}`);
        },
        sendPairingReply: async (text) => {
          await sendMessageIMessage(sender, text, {
            config: cfg,
            client: getActiveClient(),
            maxBytes: mediaMaxBytes,
            accountId: accountInfo.accountId,
            ...(chatId ? { chatId } : {}),
          });
        },
        onReplyError: (err) => {
          // Pairing relies on the user receiving the challenge — silent
          // failure here is the user's only "pairing seems broken" signal.
          runtime.error?.(`imessage pairing reply failed for ${decision.senderId}: ${String(err)}`);
        },
      });
      return;
    }

    if (decision.kind === "reaction") {
      enqueueIMessageReactionSystemEvent({ decision, runtime, logVerbose });
      return;
    }

    const storePath = resolveStorePath(cfg.session?.store, {
      agentId: decision.route.agentId,
    });
    const previousTimestamp = readSessionUpdatedAt({
      storePath,
      sessionKey: decision.route.sessionKey,
    });
    const { ctxPayload, chatTarget } = buildIMessageInboundContext({
      cfg,
      decision,
      message,
      previousTimestamp,
      remoteHost,
      historyLimit,
      groupHistories,
      media: {
        path: mediaPath,
        type: mediaType,
        paths: mediaPaths,
        types: mediaTypes,
      },
    });

    const updateTarget = chatTarget || decision.sender;
    const pinnedMainDmOwner = resolvePinnedMainDmOwnerFromAllowlist({
      dmScope: cfg.session?.dmScope,
      allowFrom,
      normalizeEntry: normalizeIMessageHandle,
    });
    if (shouldLogVerbose()) {
      const preview = truncateUtf16Safe(ctxPayload.Body ?? "", 200).replace(/\n/g, "\\n");
      logVerbose(
        `imessage inbound: chatId=${chatId ?? "unknown"} from=${ctxPayload.From} len=${
          (ctxPayload.Body ?? "").length
        } preview="${preview}"`,
      );
    }

    const privateApiStatus = getCachedIMessagePrivateApiStatus(cliPath);
    const supportsTyping = imessageRpcSupportsMethod(privateApiStatus, "typing");
    const supportsRead = imessageRpcSupportsMethod(privateApiStatus, "read");
    if (privateApiStatus?.available === true) {
      // Surface a single warning per restart when the bridge is up but we
      // had to gate off typing/read because the imsg build pre-dates the
      // capability list. Otherwise the user sees no typing bubble / no
      // "Read" receipt with no visible reason.
      if (!supportsTyping || !supportsRead) {
        warnIfImsgUpgradeNeeded.fireOnce(privateApiStatus.rpcMethods, runtime);
      }
    }
    const sendReadReceipts = imessageCfg.sendReadReceipts !== false;
    const typingTarget = ctxPayload.To;

    if (supportsRead && sendReadReceipts && typingTarget) {
      try {
        await markIMessageChatRead(typingTarget, {
          cfg,
          accountId: accountInfo.accountId,
          client: getActiveClient(),
        });
      } catch (err) {
        runtime.error?.(`imessage: mark read failed: ${String(err)}`);
      }
    }

    const { onModelSelected, ...replyPipeline } = createChannelMessageReplyPipeline({
      cfg,
      agentId: decision.route.agentId,
      channel: "imessage",
      accountId: decision.route.accountId,
      typing:
        supportsTyping && typingTarget
          ? {
              start: async () => {
                await sendIMessageTyping(typingTarget, true, {
                  cfg,
                  accountId: accountInfo.accountId,
                  client: getActiveClient(),
                });
              },
              stop: async () => {
                await sendIMessageTyping(typingTarget, false, {
                  cfg,
                  accountId: accountInfo.accountId,
                  client: getActiveClient(),
                });
              },
              onStartError: (err) => {
                logTypingFailure({
                  log: (msg) => logVerbose(msg),
                  channel: "imessage",
                  action: "start",
                  target: typingTarget,
                  error: err,
                });
              },
              onStopError: (err) => {
                logTypingFailure({
                  log: (msg) => logVerbose(msg),
                  channel: "imessage",
                  action: "stop",
                  target: typingTarget,
                  error: err,
                });
              },
            }
          : undefined,
    });

    const {
      dispatcher,
      replyOptions: typingReplyOptions,
      markDispatchIdle,
    } = createReplyDispatcherWithTyping({
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(cfg, decision.route.agentId),
      deliver: async (payload, info) => {
        const target = ctxPayload.To;
        if (!target) {
          runtime.error?.(danger("imessage: missing delivery target"));
          return;
        }
        const durable = await deliverInboundReplyWithMessageSendContext({
          cfg,
          channel: "imessage",
          accountId: accountInfo.accountId,
          agentId: decision.route.agentId,
          ctxPayload,
          payload,
          info,
          to: target,
          deps: {
            imessage: createIMessageEchoCachingSend({
              client: getActiveClient(),
              accountId: accountInfo.accountId,
              sentMessageCache,
            }),
          },
        });
        if (durable.status === "failed") {
          throw durable.error;
        }
        if (durable.status === "handled_visible" || durable.status === "handled_no_send") {
          return;
        }
        await deliverReplies({
          cfg,
          replies: [payload],
          target,
          client: getActiveClient(),
          accountId: accountInfo.accountId,
          runtime,
          maxBytes: mediaMaxBytes,
          textLimit,
          sentMessageCache,
        });
      },
      onError: (err, info) => {
        runtime.error?.(danger(`imessage ${info.kind} reply failed: ${String(err)}`));
      },
    });

    await runInboundReplyTurn({
      channel: "imessage",
      accountId: decision.route.accountId,
      raw: decision,
      adapter: {
        ingest: () => ({
          id: ctxPayload.MessageSid ?? `${ctxPayload.From}:${Date.now()}`,
          timestamp: typeof ctxPayload.Timestamp === "number" ? ctxPayload.Timestamp : undefined,
          rawText: ctxPayload.RawBody ?? "",
          textForAgent: ctxPayload.BodyForAgent,
          textForCommands: ctxPayload.CommandBody,
          raw: decision,
        }),
        resolveTurn: () => ({
          channel: "imessage",
          accountId: decision.route.accountId,
          routeSessionKey: decision.route.sessionKey,
          storePath,
          ctxPayload,
          recordInboundSession,
          record: {
            updateLastRoute:
              !decision.isGroup && updateTarget
                ? {
                    sessionKey: decision.route.mainSessionKey,
                    channel: "imessage",
                    to: updateTarget,
                    accountId: decision.route.accountId,
                    mainDmOwnerPin:
                      pinnedMainDmOwner && decision.senderNormalized
                        ? {
                            ownerRecipient: pinnedMainDmOwner,
                            senderRecipient: decision.senderNormalized,
                            onSkip: ({ ownerRecipient, senderRecipient }) => {
                              logVerbose(
                                `imessage: skip main-session last route for ${senderRecipient} (pinned owner ${ownerRecipient})`,
                              );
                            },
                          }
                        : undefined,
                  }
                : undefined,
            onRecordError: (err) => {
              logVerbose(`imessage: failed updating session meta: ${String(err)}`);
            },
          },
          history: {
            isGroup: decision.isGroup,
            historyKey: decision.historyKey,
            historyMap: groupHistories,
            limit: historyLimit,
          },
          onPreDispatchFailure: () =>
            settleReplyDispatcher({
              dispatcher,
              onSettled: () => markDispatchIdle(),
            }),
          runDispatch: async () => {
            try {
              return await dispatchInboundMessage({
                ctx: ctxPayload,
                cfg,
                dispatcher,
                replyOptions: {
                  ...typingReplyOptions,
                  disableBlockStreaming:
                    typeof accountInfo.config.blockStreaming === "boolean"
                      ? !accountInfo.config.blockStreaming
                      : undefined,
                  onModelSelected,
                },
              });
            } finally {
              markDispatchIdle();
            }
          },
        }),
      },
    });
  }

  const handleMessage = async (raw: unknown) => {
    const message = parseIMessageNotification(raw);
    if (!message) {
      // A malformed RPC notification means imsg shipped a payload shape
      // we do not understand — almost always a real bridge bug. Surface
      // the keys so an operator can correlate without leaking content.
      const shape =
        raw && typeof raw === "object" && !Array.isArray(raw)
          ? Object.keys(raw as Record<string, unknown>)
              .toSorted()
              .join(",")
          : typeof raw;
      runtime.error?.(`imessage: dropping malformed RPC message payload (keys=${shape})`);
      return;
    }
    await inboundDebouncer.enqueue({ message });
  };

  await waitForTransportReady({
    label: "imsg rpc",
    timeoutMs: 30_000,
    logAfterMs: 10_000,
    logIntervalMs: 10_000,
    pollIntervalMs: 500,
    abortSignal: opts.abortSignal,
    runtime,
    check: async () => {
      const probe = await probeIMessage(probeTimeoutMs, { cliPath, dbPath, runtime });
      if (probe.ok) {
        return { ok: true };
      }
      if (probe.fatal) {
        throw new Error(probe.error ?? "imsg rpc unavailable");
      }
      return { ok: false, error: probe.error ?? "unreachable" };
    },
  });

  if (opts.abortSignal?.aborted) {
    return;
  }
  const abort = opts.abortSignal;
  const createWatchClient = async () =>
    await createIMessageRpcClient({
      cliPath,
      dbPath,
      runtime,
      onNotification: (msg) => {
        if (msg.method === "message") {
          void handleMessage(msg.params).catch((err) => {
            runtime.error?.(`imessage: handler failed: ${String(err)}`);
          });
        } else if (msg.method === "error") {
          runtime.error?.(
            `imessage: watch error ${JSON.stringify(sanitizeIMessageWatchErrorPayload(msg.params))}`,
          );
        }
      },
    });

  const requireWatchClient = (
    watchClient: IMessageRpcClient | null | undefined,
  ): IMessageRpcClient => {
    if (!watchClient) {
      throw new Error("imessage monitor client not initialized");
    }
    return watchClient;
  };

  for (let attempt = 1; attempt <= WATCH_SUBSCRIBE_MAX_ATTEMPTS; attempt++) {
    if (abort?.aborted) {
      return;
    }
    let attemptClient: IMessageRpcClient | undefined;
    let attemptDetachAbortHandler = () => {};
    let keepAttemptClient = false;
    try {
      attemptClient = requireWatchClient(await createWatchClient());
      let attemptSubscriptionId: number | null = null;
      attemptDetachAbortHandler = attachIMessageMonitorAbortHandler({
        abortSignal: abort,
        client: attemptClient,
        getSubscriptionId: () => attemptSubscriptionId,
      });
      const result = await attemptClient.request<{ subscription?: number }>(
        "watch.subscribe",
        {
          attachments: includeAttachments,
          include_reactions: true,
        },
        { timeoutMs: probeTimeoutMs },
      );
      attemptSubscriptionId = result?.subscription ?? null;
      client = attemptClient;
      detachAbortHandler = attemptDetachAbortHandler;
      keepAttemptClient = true;
      break;
    } catch (err) {
      if (abort?.aborted) {
        return;
      }
      const shouldRetry =
        attempt < WATCH_SUBSCRIBE_MAX_ATTEMPTS && isRetriableWatchSubscribeStartupError(err);
      if (!shouldRetry) {
        runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
        throw err;
      }
      runtime.log?.(
        warn(
          `imessage: watch.subscribe startup failed (attempt ${attempt}/${WATCH_SUBSCRIBE_MAX_ATTEMPTS}): ${String(err)}; retrying`,
        ),
      );
      // Tear down the failed client before waiting so a slow subscribe attempt
      // cannot keep emitting notifications into the next retry window.
      attemptDetachAbortHandler();
      attemptDetachAbortHandler = () => {};
      await attemptClient?.stop();
      attemptClient = undefined;
      await waitForWatchSubscribeRetryDelay({
        ms: WATCH_SUBSCRIBE_RETRY_DELAY_MS,
        abortSignal: abort,
      });
      if (abort?.aborted) {
        return;
      }
    } finally {
      if (!keepAttemptClient) {
        attemptDetachAbortHandler();
        await attemptClient?.stop();
      }
    }
  }

  const activeClient = client;
  if (!activeClient) {
    return;
  }

  // Catchup runs once between watch.subscribe and the live dispatch loop.
  // Anything that arrives during the catchup pass itself flows through
  // `handleMessage` -> `handleMessageNow`; the inbound-dedupe cache absorbs
  // any overlap with replayed rows. Disabled by default — opt-in via
  // `channels.imessage.catchup.enabled`. See issue #78649.
  const catchupCfg = resolveCatchupConfig(imessageCfg.catchup);
  if (catchupCfg.enabled && !abort?.aborted) {
    try {
      await runIMessageCatchup({
        client: activeClient,
        accountId: accountInfo.accountId,
        config: catchupCfg,
        includeAttachments,
        // Catchup bypasses the inbound debouncer so each row is awaited
        // serially and dispatch failure can hold the cursor. Split-sends
        // from before the gateway gap therefore arrive as separate turns
        // rather than coalesced. Live notifications continue to flow through
        // the debouncer.
        dispatchPayload: (message) => handleMessageNow(message),
        runtime,
      });
    } catch (err) {
      // Catchup is opt-in recovery — surface the error but do not block the
      // monitor. The live dispatch loop is already up and running.
      runtime.error?.(`imessage catchup: pass failed: ${String(err)}`);
    }
  }

  try {
    await activeClient.waitForClose();
  } catch (err) {
    if (abort?.aborted) {
      return;
    }
    runtime.error?.(danger(`imessage: monitor failed: ${String(err)}`));
    throw err;
  } finally {
    detachAbortHandler();
    await activeClient.stop();
  }
}
