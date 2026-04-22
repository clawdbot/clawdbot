import fs from "node:fs/promises";
import { resolveHumanDelayConfig } from "openclaw/plugin-sdk/agent-runtime";
import {
  createChannelInboundDebouncer,
  shouldDebounceTextInbound,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelPairingChallengeIssuer } from "openclaw/plugin-sdk/channel-pairing";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { loadConfig } from "openclaw/plugin-sdk/config-runtime";
import {
  resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
  warnMissingProviderGroupPolicyFallbackOnce,
} from "openclaw/plugin-sdk/config-runtime";
import { readSessionUpdatedAt, resolveStorePath } from "openclaw/plugin-sdk/config-runtime";
import {
  readChannelAllowFromStore,
  upsertChannelPairingRequest,
} from "openclaw/plugin-sdk/conversation-runtime";
import { recordInboundSession } from "openclaw/plugin-sdk/conversation-runtime";
import { normalizeScpRemoteHost } from "openclaw/plugin-sdk/host-runtime";
import { waitForTransportReady } from "openclaw/plugin-sdk/infra-runtime";
import { isInboundPathAllowed, kindFromMime } from "openclaw/plugin-sdk/media-runtime";
import {
  clearHistoryEntriesIfEnabled,
  DEFAULT_GROUP_HISTORY_LIMIT,
  type HistoryEntry,
} from "openclaw/plugin-sdk/reply-history";
import { resolveTextChunkLimit } from "openclaw/plugin-sdk/reply-runtime";
import { dispatchInboundMessage } from "openclaw/plugin-sdk/reply-runtime";
import { createReplyDispatcher } from "openclaw/plugin-sdk/reply-runtime";
import { danger, logVerbose, shouldLogVerbose, warn } from "openclaw/plugin-sdk/runtime-env";
import { resolvePinnedMainDmOwnerFromAllowlist } from "openclaw/plugin-sdk/security-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-runtime";
import { resolveIMessageAccount } from "../accounts.js";
import { createIMessageRpcClient, type IMessageRpcClient } from "../client.js";
import { DEFAULT_IMESSAGE_PROBE_TIMEOUT_MS } from "../constants.js";
import {
  resolveIMessageAttachmentRoots,
  resolveIMessageRemoteAttachmentRoots,
} from "../media-contract.js";
import { probeIMessage } from "../probe.js";
import { sendMessageIMessage } from "../send.js";
import { normalizeIMessageHandle } from "../targets.js";
import { attachIMessageMonitorAbortHandler } from "./abort-handler.js";
import { deliverReplies } from "./deliver.js";
import { createSentMessageCache } from "./echo-cache.js";
import {
  buildIMessageInboundContext,
  resolveIMessageInboundDecision,
} from "./inbound-processing.js";
import { createLoopRateLimiter } from "./loop-rate-limiter.js";
import { parseIMessageNotification } from "./parse-notification.js";
import { normalizeAllowList, resolveRuntime } from "./runtime.js";
import { createSelfChatCache } from "./self-chat-cache.js";
import type { IMessagePayload, MonitorIMessageOpts } from "./types.js";
import { sanitizeIMessageWatchErrorPayload } from "./watch-error-log.js";

const WATCH_SUBSCRIBE_MAX_ATTEMPTS = 3;
const WATCH_SUBSCRIBE_RETRY_DELAY_MS = 1_000;

/**
 * Try to detect remote host from an SSH wrapper script like:
 *   exec ssh -T openclaw@192.168.64.3 /opt/homebrew/bin/imsg "$@"
 *   exec ssh -T mac-mini imsg "$@"
 * Returns the user@host or host portion if found, undefined otherwise.
 */
async function detectRemoteHostFromCliPath(cliPath: string): Promise<string | undefined> {
  try {
    // Expand ~ to home directory
    const expanded = cliPath.startsWith("~")
      ? cliPath.replace(/^~/, process.env.HOME ?? "")
      : cliPath;
    const content = await fs.readFile(expanded, "utf8");

    // Match user@host pattern first (e.g., openclaw@192.168.64.3)
    const userHostMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z0-9._-]+@[a-zA-Z0-9._-]+)/);
    if (userHostMatch) {
      return userHostMatch[1];
    }

    // Fallback: match host-only before imsg command (e.g., ssh -T mac-mini imsg)
    const hostOnlyMatch = content.match(/\bssh\b[^\n]*?\s+([a-zA-Z][a-zA-Z0-9._-]*)\s+\S*\bimsg\b/);
    return hostOnlyMatch?.[1];
  } catch {
    return undefined;
  }
}

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
  const cfg = opts.config ?? loadConfig();
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

  const { debouncer: inboundDebouncer } = createChannelInboundDebouncer<{
    message: IMessagePayload;
  }>({
    cfg,
    channel: "imessage",
    buildKey: (entry) => {
      const sender = entry.message.sender?.trim();
      if (!sender) {
        return null;
      }
      const conversationId =
        entry.message.chat_id != null
          ? `chat:${entry.message.chat_id}`
          : (entry.message.chat_guid ?? entry.message.chat_identifier ?? "unknown");
      return `imessage:${accountInfo.accountId}:${conversationId}:${sender}`;
    },
    shouldDebounce: (entry) => {
      return shouldDebounceTextInbound({
        text: entry.message.text,
        cfg,
        hasMedia: Boolean(entry.message.attachments && entry.message.attachments.length > 0),
      });
    },
    onFlush: async (entries) => {
      const last = entries.at(-1);
      if (!last) {
        return;
      }
      if (entries.length === 1) {
        await handleMessageNow(last.message);
        return;
      }
      const combinedText = entries
        .map((entry) => entry.message.text ?? "")
        .filter(Boolean)
        .join("\n");
      const syntheticMessage: IMessagePayload = {
        ...last.message,
        text: combinedText,
        attachments: null,
      };
      await handleMessageNow(syntheticMessage);
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
    const decision = resolveIMessageInboundDecision({
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
          logVerbose(`imessage pairing reply failed for ${decision.senderId}: ${String(err)}`);
        },
      });
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
    await recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? decision.route.sessionKey,
      ctx: ctxPayload,
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
    });

    if (shouldLogVerbose()) {
      const preview = truncateUtf16Safe(ctxPayload.Body ?? "", 200).replace(/\n/g, "\\n");
      logVerbose(
        `imessage inbound: chatId=${chatId ?? "unknown"} from=${ctxPayload.From} len=${
          (ctxPayload.Body ?? "").length
        } preview="${preview}"`,
      );
    }

    const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
      cfg,
      agentId: decision.route.agentId,
      channel: "imessage",
      accountId: decision.route.accountId,
    });

    const dispatcher = createReplyDispatcher({
      ...replyPipeline,
      humanDelay: resolveHumanDelayConfig(cfg, decision.route.agentId),
      deliver: async (payload) => {
        const target = ctxPayload.To;
        if (!target) {
          runtime.error?.(danger("imessage: missing delivery target"));
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

    const { queuedFinal } = await dispatchInboundMessage({
      ctx: ctxPayload,
      cfg,
      dispatcher,
      replyOptions: {
        disableBlockStreaming:
          typeof accountInfo.config.blockStreaming === "boolean"
            ? !accountInfo.config.blockStreaming
            : undefined,
        onModelSelected,
      },
    });

    if (!queuedFinal) {
      if (decision.isGroup && decision.historyKey) {
        clearHistoryEntriesIfEnabled({
          historyMap: groupHistories,
          historyKey: decision.historyKey,
          limit: historyLimit,
        });
      }
      return;
    }
    if (decision.isGroup && decision.historyKey) {
      clearHistoryEntriesIfEnabled({
        historyMap: groupHistories,
        historyKey: decision.historyKey,
        limit: historyLimit,
      });
    }
  }

  const handleMessage = async (raw: unknown) => {
    const message = parseIMessageNotification(raw);
    if (!message) {
      logVerbose("imessage: dropping malformed RPC message payload");
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

export const __testing = {
  resolveIMessageRuntimeGroupPolicy: resolveOpenProviderRuntimeGroupPolicy,
  resolveDefaultGroupPolicy,
};

export const resolveIMessageRuntimeGroupPolicy = resolveOpenProviderRuntimeGroupPolicy;
