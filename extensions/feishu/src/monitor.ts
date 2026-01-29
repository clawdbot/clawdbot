import * as Lark from "@larksuiteoapi/node-sdk";

import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import {
  resolveMentionGatingWithBypass,
  type ReplyPayload,
} from "clawdbot/plugin-sdk";

import { getFeishuRuntime } from "./runtime.js";
import type { ResolvedFeishuAccount } from "./accounts.js";
import { sendFeishuMessage } from "./send.js";

export type FeishuRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type FeishuMonitorOptions = {
  account: ResolvedFeishuAccount;
  config: MoltbotConfig;
  runtime: FeishuRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type FeishuSender = {
  sender_type?: string;
  sender_id?: {
    user_id?: string;
    open_id?: string;
    union_id?: string;
  };
};

type FeishuMessage = {
  chat_id?: string;
  chat_type?: string;
  message_id?: string;
  message_type?: string;
  content?: string;
  create_time?: string;
  root_id?: string;
  parent_id?: string;
};

type FeishuMessageEvent = {
  message?: FeishuMessage;
  sender?: FeishuSender;
};

type FeishuCoreRuntime = ReturnType<typeof getFeishuRuntime>;

type FeishuWsClient = Lark.WSClient & {
  stop?: () => void | Promise<void>;
};

function logVerbose(core: FeishuCoreRuntime, runtime: FeishuRuntimeEnv, message: string): void {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[feishu] ${message}`);
  }
}

function requireFeishuCredentials(account: ResolvedFeishuAccount): {
  appId: string;
  appSecret: string;
} {
  const appId = account.appId?.trim();
  const appSecret = account.appSecret?.trim();
  if (!appId || !appSecret) {
    throw new Error(
      `Feishu credentials missing for account "${account.accountId}" (set channels.feishu.appId/appSecret or channels.feishu.accounts.${account.accountId}.appId/appSecret).`,
    );
  }
  return { appId, appSecret };
}

function resolveSenderInfo(
  sender?: FeishuSender,
): { id: string; idType: "open_id" | "user_id" | "union_id" } | null {
  if (!sender) return null;
  const ids = sender.sender_id;
  if (ids?.open_id?.trim()) {
    return { id: ids.open_id.trim(), idType: "open_id" };
  }
  if (ids?.user_id?.trim()) {
    return { id: ids.user_id.trim(), idType: "user_id" };
  }
  if (ids?.union_id?.trim()) {
    return { id: ids.union_id.trim(), idType: "union_id" };
  }
  return null;
}

function parseMessageText(params: {
  content: string;
  runtime: FeishuRuntimeEnv;
  accountId: string;
}): string | null {
  const trimmed = params.content.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (!parsed || typeof parsed !== "object") return null;
    const text = (parsed as { text?: unknown }).text;
    return typeof text === "string" ? text : null;
  } catch (err) {
    params.runtime.error?.(
      `[${params.accountId}] Feishu message content parse failed: ${String(err)}`,
    );
    return null;
  }
}

function resolveMentionState(text: string): { hasAnyMention: boolean; wasMentioned: boolean } {
  const hasAnyMention = /<at\b/i.test(text);
  return { hasAnyMention, wasMentioned: hasAnyMention };
}

function normalizeAllowEntry(raw: string): string {
  return raw
    .trim()
    .replace(/^(feishu|lark|user|open_id|user_id|union_id|email):/i, "")
    .toLowerCase();
}

function isSenderAllowed(senderId: string, allowFrom: string[]): boolean {
  if (allowFrom.length === 0) return false;
  const normalizedSender = normalizeAllowEntry(senderId);
  for (const entry of allowFrom) {
    const normalized = normalizeAllowEntry(entry);
    if (!normalized) continue;
    if (normalized === "*") return true;
    if (normalized === normalizedSender) return true;
  }
  return false;
}

function resolveGroupEntry(account: ResolvedFeishuAccount, chatId: string) {
  const groups = account.config.groups ?? {};
  const entry = groups[chatId];
  const wildcard = groups["*"];
  const allowlistConfigured = Object.keys(groups).length > 0;
  return { entry, wildcard, allowlistConfigured };
}

function resolveGroupPolicy(cfg: MoltbotConfig, account: ResolvedFeishuAccount): "open" | "allowlist" | "disabled" {
  const defaultGroupPolicy = cfg.channels?.defaults?.groupPolicy;
  return account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
}

function resolveChatType(chatType?: string): "direct" | "channel" {
  if (!chatType) return "channel";
  return chatType === "p2p" ? "direct" : "channel";
}

async function stopFeishuWsClient(wsClient: FeishuWsClient, runtime: FeishuRuntimeEnv): Promise<void> {
  const stop = wsClient.stop;
  if (typeof stop !== "function") return;
  try {
    await Promise.resolve(stop.call(wsClient));
  } catch (err) {
    runtime.error?.(`feishu websocket stop failed: ${String(err)}`);
  }
}

async function deliverFeishuReply(params: {
  payload: ReplyPayload;
  account: ResolvedFeishuAccount;
  chatId: string;
  runtime: FeishuRuntimeEnv;
  core: FeishuCoreRuntime;
  config: MoltbotConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { payload, account, chatId, runtime, core, config, statusSink } = params;
  const text = payload.text ?? "";
  if (!text.trim()) return;
  const textLimit = core.channel.text.resolveTextChunkLimit(config, "feishu", account.accountId, {
    fallbackLimit: 4000,
  });
  const chunkMode = core.channel.text.resolveChunkMode(config, "feishu", account.accountId);
  const chunks = core.channel.text.chunkTextWithMode(text, textLimit, chunkMode);
  for (const chunk of chunks) {
    await sendFeishuMessage({ account, to: `chat:${chatId}`, text: chunk });
    statusSink?.({ lastOutboundAt: Date.now() });
  }
  logVerbose(core, runtime, `reply sent to chat=${chatId}`);
}

async function handleFeishuMessage(params: {
  event: FeishuMessageEvent;
  account: ResolvedFeishuAccount;
  config: MoltbotConfig;
  runtime: FeishuRuntimeEnv;
  core: FeishuCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
}): Promise<void> {
  const { event, account, config, runtime, core, statusSink } = params;
  const message = event.message;
  if (!message) return;
  const chatId = message.chat_id?.trim();
  if (!chatId) return;
  const senderInfo = resolveSenderInfo(event.sender);
  if (!senderInfo) return;
  const senderId = senderInfo.id;
  const senderType = event.sender?.sender_type;
  if (senderType && senderType !== "user" && account.config.allowBots !== true) {
    logVerbose(core, runtime, `drop bot message senderType=${senderType}`);
    return;
  }
  const messageType = message.message_type?.trim() || "";
  if (messageType && messageType !== "text") {
    logVerbose(core, runtime, `drop unsupported message type=${messageType}`);
    return;
  }
  if (typeof message.content !== "string") return;
  const rawBody = parseMessageText({
    content: message.content,
    runtime,
    accountId: account.accountId,
  });
  if (rawBody === null) return;
  const chatType = resolveChatType(message.chat_type);
  const isGroup = chatType !== "direct";

  statusSink?.({ lastInboundAt: Date.now() });

  const groupPolicy = resolveGroupPolicy(config, account);
  const groupInfo = resolveGroupEntry(account, chatId);
  const groupEntry = groupInfo.entry;
  if (isGroup) {
    if (groupPolicy === "disabled") return;
    const groupAllowed = Boolean(groupEntry) || Boolean(groupInfo.wildcard);
    if (groupPolicy === "allowlist") {
      if (!groupInfo.allowlistConfigured) {
        logVerbose(core, runtime, `drop group message (allowlist empty, chat=${chatId})`);
        return;
      }
      if (!groupAllowed) {
        logVerbose(core, runtime, `drop group message (not allowlisted, chat=${chatId})`);
        return;
      }
    }
    if (groupEntry?.enabled === false || groupEntry?.allow === false) {
      logVerbose(core, runtime, `drop group message (disabled, chat=${chatId})`);
      return;
    }
    if (groupEntry?.users && groupEntry.users.length > 0) {
      const ok = isSenderAllowed(senderId, groupEntry.users.map((value) => String(value)));
      if (!ok) {
        logVerbose(core, runtime, `drop group message (sender not allowed, ${senderId})`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dm?.policy ?? "pairing";
  const configAllowFrom = (account.config.dm?.allowFrom ?? []).map((value) => String(value));
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom = !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
    ? await core.channel.pairing.readAllowFromStore("feishu").catch((err) => {
        runtime.error?.(`feishu: failed reading allowFrom store: ${String(err)}`);
        return [];
      })
    : [];
  const effectiveAllowFrom = [...configAllowFrom, ...storeAllowFrom];
  const commandAllowFrom = isGroup
    ? (groupEntry?.users ?? []).map((value) => String(value))
    : effectiveAllowFrom;
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, commandAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          {
            configured: commandAllowFrom.length > 0,
            allowed: senderAllowedForCommands,
          },
        ],
      })
    : undefined;

  let effectiveWasMentioned: boolean | undefined;
  if (isGroup) {
    const requireMention = groupEntry?.requireMention ?? account.config.requireMention ?? true;
    const mentionState = resolveMentionState(rawBody);
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "feishu",
    });
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention,
      canDetectMention: true,
      wasMentioned: mentionState.wasMentioned,
      implicitMention: false,
      hasAnyMention: mentionState.hasAnyMention,
      allowTextCommands,
      hasControlCommand: core.channel.text.hasControlCommand(rawBody, config),
      commandAuthorized: commandAuthorized === true,
    });
    effectiveWasMentioned = mentionGate.effectiveWasMentioned;
    if (mentionGate.shouldSkip) {
      logVerbose(core, runtime, `drop group message (mention required, chat=${chatId})`);
      return;
    }
  }

  if (!isGroup) {
    if (dmPolicy === "disabled" || account.config.dm?.enabled === false) {
      logVerbose(core, runtime, `drop DM (dmPolicy=disabled, sender=${senderId})`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "feishu",
            id: senderId,
          });
          if (created) {
            try {
              await sendFeishuMessage({
                account,
                to: `${senderInfo.idType}:${senderId}`,
                text: core.channel.pairing.buildPairingReply({
                  channel: "feishu",
                  idLine: `Your Feishu user id: ${senderId}`,
                  code,
                }),
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              runtime.error?.(`feishu pairing reply failed: ${String(err)}`);
            }
          }
        } else {
          logVerbose(core, runtime, `drop DM (unauthorized, sender=${senderId})`);
        }
        return;
      }
    }
  }

  if (
    isGroup &&
    core.channel.commands.isControlCommandMessage(rawBody, config) &&
    commandAuthorized !== true
  ) {
    logVerbose(core, runtime, `feishu: drop control command from ${senderId}`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "feishu",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: chatId,
    },
  });

  const fromLabel = isGroup ? `chat:${chatId}` : `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const timestampMs = Number(message.create_time);
  const timestamp = Number.isFinite(timestampMs) ? timestampMs : undefined;
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "Feishu",
    from: fromLabel,
    timestamp,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = groupEntry?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `feishu:${senderId}`,
    To: `feishu:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "channel" : "direct",
    ConversationLabel: fromLabel,
    SenderId: senderId,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    CommandAuthorized: commandAuthorized,
    Provider: "feishu",
    Surface: "feishu",
    MessageSid: message.message_id,
    MessageSidFull: message.message_id,
    ReplyToId: message.parent_id ?? message.root_id,
    ReplyToIdFull: message.parent_id ?? message.root_id,
    GroupSpace: isGroup ? chatId : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    OriginatingChannel: "feishu",
    OriginatingTo: `feishu:${chatId}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`feishu: failed updating session meta: ${String(err)}`);
    });

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverFeishuReply({
          payload,
          account,
          chatId,
          runtime,
          core,
          config,
          statusSink,
        });
      },
      onError: (err, info) => {
        runtime.error?.(`[${account.accountId}] Feishu ${info.kind} reply failed: ${String(err)}`);
      },
    },
  });
}

export async function startFeishuMonitor(opts: FeishuMonitorOptions): Promise<() => void> {
  const core = getFeishuRuntime();
  const { appId, appSecret } = requireFeishuCredentials(opts.account);
  const loggerLevel = core.logging.shouldLogVerbose()
    ? Lark.LoggerLevel.debug
    : Lark.LoggerLevel.error;
  const wsClient: FeishuWsClient = new Lark.WSClient({
    appId,
    appSecret,
    loggerLevel,
  });

  const dispatcher = new Lark.EventDispatcher({}).register({
    "im.message.receive_v1": async (data: unknown) => {
      const event = data as FeishuMessageEvent;
      try {
        await handleFeishuMessage({
          event,
          account: opts.account,
          config: opts.config,
          runtime: opts.runtime,
          core,
          statusSink: opts.statusSink,
        });
      } catch (err) {
        opts.runtime.error?.(`feishu inbound handler failed: ${String(err)}`);
      }
    },
  });

  await Promise.resolve(
    wsClient.start({
      eventDispatcher: dispatcher,
    }),
  );

  const abortHandler = () => {
    void stopFeishuWsClient(wsClient, opts.runtime);
  };
  if (opts.abortSignal.aborted) {
    abortHandler();
  } else {
    opts.abortSignal.addEventListener("abort", abortHandler, { once: true });
  }

  logVerbose(core, opts.runtime, `Feishu WS connected for account=${opts.account.accountId}`);

  return () => {
    opts.abortSignal.removeEventListener("abort", abortHandler);
    void stopFeishuWsClient(wsClient, opts.runtime);
    logVerbose(core, opts.runtime, `Feishu WS stopped for account=${opts.account.accountId}`);
  };
}
