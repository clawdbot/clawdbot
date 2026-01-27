import { Subscriptions } from "@ringcentral/subscriptions";

import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { resolveMentionGatingWithBypass } from "clawdbot/plugin-sdk";

import type { ResolvedRingCentralAccount } from "./accounts.js";
import { getRingCentralSDK } from "./auth.js";
import {
  sendRingCentralMessage,
  updateRingCentralMessage,
  deleteRingCentralMessage,
  downloadRingCentralAttachment,
  uploadRingCentralAttachment,
  getRingCentralChat,
} from "./api.js";
import { getRingCentralRuntime } from "./runtime.js";
import type {
  RingCentralWebhookEvent,
  RingCentralEventBody,
  RingCentralAttachment,
  RingCentralMention,
} from "./types.js";

export type RingCentralRuntimeEnv = {
  log?: (message: string) => void;
  error?: (message: string) => void;
};

export type RingCentralMonitorOptions = {
  account: ResolvedRingCentralAccount;
  config: ClawdbotConfig;
  runtime: RingCentralRuntimeEnv;
  abortSignal: AbortSignal;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
};

type RingCentralCoreRuntime = ReturnType<typeof getRingCentralRuntime>;

function logVerbose(
  core: RingCentralCoreRuntime,
  runtime: RingCentralRuntimeEnv,
  message: string,
) {
  if (core.logging.shouldLogVerbose()) {
    runtime.log?.(`[ringcentral] ${message}`);
  }
}

function normalizeUserId(raw?: string | null): string {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return "";
  return trimmed.toLowerCase();
}

export function isSenderAllowed(
  senderId: string,
  allowFrom: string[],
): boolean {
  if (allowFrom.includes("*")) return true;
  const normalizedSenderId = normalizeUserId(senderId);
  return allowFrom.some((entry) => {
    const normalized = String(entry).trim().toLowerCase();
    if (!normalized) return false;
    if (normalized === normalizedSenderId) return true;
    if (normalized.replace(/^(ringcentral|rc):/i, "") === normalizedSenderId) return true;
    if (normalized.replace(/^user:/i, "") === normalizedSenderId) return true;
    return false;
  });
}

function resolveGroupConfig(params: {
  groupId: string;
  groupName?: string | null;
  groups?: Record<string, { requireMention?: boolean; allow?: boolean; enabled?: boolean; users?: Array<string | number>; systemPrompt?: string }>;
}) {
  const { groupId, groupName, groups } = params;
  const entries = groups ?? {};
  const keys = Object.keys(entries);
  if (keys.length === 0) {
    return { entry: undefined, allowlistConfigured: false };
  }
  const normalizedName = groupName?.trim().toLowerCase();
  const candidates = [groupId, groupName ?? "", normalizedName ?? ""].filter(Boolean);
  let entry = candidates.map((candidate) => entries[candidate]).find(Boolean);
  if (!entry && normalizedName) {
    entry = entries[normalizedName];
  }
  const fallback = entries["*"];
  return { entry: entry ?? fallback, allowlistConfigured: true, fallback };
}

function extractMentionInfo(mentions: RingCentralMention[], botExtensionId?: string | null) {
  const personMentions = mentions.filter((entry) => entry.type === "Person");
  const hasAnyMention = personMentions.length > 0;
  const wasMentioned = botExtensionId
    ? personMentions.some((entry) => entry.id === botExtensionId)
    : false;
  return { hasAnyMention, wasMentioned };
}

function resolveBotDisplayName(params: {
  accountName?: string;
  agentId: string;
  config: ClawdbotConfig;
}): string {
  const { accountName, agentId, config } = params;
  if (accountName?.trim()) return accountName.trim();
  const agent = config.agents?.list?.find((a) => a.id === agentId);
  if (agent?.name?.trim()) return agent.name.trim();
  return "Clawdbot";
}

async function processWebSocketEvent(params: {
  event: RingCentralWebhookEvent;
  account: ResolvedRingCentralAccount;
  config: ClawdbotConfig;
  runtime: RingCentralRuntimeEnv;
  core: RingCentralCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  ownerId?: string;
}): Promise<void> {
  const { event, account, config, runtime, core, statusSink, ownerId } = params;
  
  const eventBody = event.body;
  if (!eventBody) return;

  const eventType = eventBody.eventType;
  if (eventType !== "PostAdded") return;

  statusSink?.({ lastInboundAt: Date.now() });

  await processMessageWithPipeline({
    eventBody,
    account,
    config,
    runtime,
    core,
    statusSink,
    ownerId,
  });
}

async function processMessageWithPipeline(params: {
  eventBody: RingCentralEventBody;
  account: ResolvedRingCentralAccount;
  config: ClawdbotConfig;
  runtime: RingCentralRuntimeEnv;
  core: RingCentralCoreRuntime;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  ownerId?: string;
}): Promise<void> {
  const { eventBody, account, config, runtime, core, statusSink, ownerId } = params;
  const mediaMaxMb = account.config.mediaMaxMb ?? 20;
  
  const chatId = eventBody.groupId ?? "";
  if (!chatId) return;

  const senderId = eventBody.creatorId ?? "";
  const messageText = (eventBody.text ?? "").trim();
  const attachments = eventBody.attachments ?? [];
  const hasMedia = attachments.length > 0;
  const rawBody = messageText || (hasMedia ? "<media:attachment>" : "");
  if (!rawBody) return;

  // In JWT mode (selfOnly), only accept messages from the JWT user themselves
  // This is because the bot uses the JWT user's identity, so we're essentially
  // having a conversation with ourselves (the AI assistant)
  const selfOnly = account.config.selfOnly !== false; // default true
  if (selfOnly && ownerId) {
    if (senderId !== ownerId) {
      logVerbose(core, runtime, `ignore message from non-owner: ${senderId} (selfOnly mode)`);
      return;
    }
  }

  // Fetch chat info to determine type
  let chatType = "Group";
  let chatName: string | undefined;
  try {
    const chatInfo = await getRingCentralChat({ account, chatId });
    chatType = chatInfo?.type ?? "Group";
    chatName = chatInfo?.name ?? undefined;
  } catch {
    // If we can't fetch chat info, assume it's a group
  }

  const isGroup = chatType !== "Direct" && chatType !== "PersonalChat";

  const defaultGroupPolicy = config.channels?.defaults?.groupPolicy;
  const groupPolicy = account.config.groupPolicy ?? defaultGroupPolicy ?? "allowlist";
  const groupConfigResolved = resolveGroupConfig({
    groupId: chatId,
    groupName: chatName ?? null,
    groups: account.config.groups ?? undefined,
  });
  const groupEntry = groupConfigResolved.entry;
  const groupUsers = groupEntry?.users ?? account.config.groupAllowFrom ?? [];
  let effectiveWasMentioned: boolean | undefined;

  if (isGroup) {
    if (groupPolicy === "disabled") {
      logVerbose(core, runtime, `drop group message (groupPolicy=disabled, chat=${chatId})`);
      return;
    }
    const groupAllowlistConfigured = groupConfigResolved.allowlistConfigured;
    const groupAllowed =
      Boolean(groupEntry) || Boolean((account.config.groups ?? {})["*"]);
    if (groupPolicy === "allowlist") {
      if (!groupAllowlistConfigured) {
        logVerbose(
          core,
          runtime,
          `drop group message (groupPolicy=allowlist, no allowlist, chat=${chatId})`,
        );
        return;
      }
      if (!groupAllowed) {
        logVerbose(core, runtime, `drop group message (not allowlisted, chat=${chatId})`);
        return;
      }
    }
    if (groupEntry?.enabled === false || groupEntry?.allow === false) {
      logVerbose(core, runtime, `drop group message (chat disabled, chat=${chatId})`);
      return;
    }

    if (groupUsers.length > 0) {
      const ok = isSenderAllowed(senderId, groupUsers.map((v) => String(v)));
      if (!ok) {
        logVerbose(core, runtime, `drop group message (sender not allowed, ${senderId})`);
        return;
      }
    }
  }

  const dmPolicy = account.config.dm?.policy ?? account.config.dmPolicy ?? "pairing";
  const configAllowFrom = account.config.dm?.allowFrom ?? account.config.allowFrom ?? [];
  const configAllowFromStr = configAllowFrom.map((v) => String(v));
  const shouldComputeAuth = core.channel.commands.shouldComputeCommandAuthorized(rawBody, config);
  const storeAllowFrom =
    !isGroup && (dmPolicy !== "open" || shouldComputeAuth)
      ? await core.channel.pairing.readAllowFromStore("ringcentral").catch(() => [])
      : [];
  const effectiveAllowFrom = [...configAllowFromStr, ...storeAllowFrom];
  const commandAllowFrom = isGroup ? groupUsers.map((v) => String(v)) : effectiveAllowFrom;
  const useAccessGroups = config.commands?.useAccessGroups !== false;
  const senderAllowedForCommands = isSenderAllowed(senderId, commandAllowFrom);
  const commandAuthorized = shouldComputeAuth
    ? core.channel.commands.resolveCommandAuthorizedFromAuthorizers({
        useAccessGroups,
        authorizers: [
          { configured: commandAllowFrom.length > 0, allowed: senderAllowedForCommands },
        ],
      })
    : undefined;

  if (isGroup) {
    const requireMention = groupEntry?.requireMention ?? account.config.requireMention ?? true;
    const mentions = eventBody.mentions ?? [];
    const mentionInfo = extractMentionInfo(mentions, account.config.botExtensionId);
    const allowTextCommands = core.channel.commands.shouldHandleTextCommands({
      cfg: config,
      surface: "ringcentral",
    });
    const mentionGate = resolveMentionGatingWithBypass({
      isGroup: true,
      requireMention,
      canDetectMention: Boolean(account.config.botExtensionId),
      wasMentioned: mentionInfo.wasMentioned,
      implicitMention: false,
      hasAnyMention: mentionInfo.hasAnyMention,
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
    const dmEnabled = account.config.dm?.enabled !== false;
    if (dmPolicy === "disabled" || !dmEnabled) {
      logVerbose(core, runtime, `Blocked RingCentral DM from ${senderId} (dmPolicy=disabled)`);
      return;
    }

    if (dmPolicy !== "open") {
      const allowed = senderAllowedForCommands;
      if (!allowed) {
        if (dmPolicy === "pairing") {
          const { code, created } = await core.channel.pairing.upsertPairingRequest({
            channel: "ringcentral",
            id: senderId,
            meta: {},
          });
          if (created) {
            logVerbose(core, runtime, `ringcentral pairing request sender=${senderId}`);
            try {
              await sendRingCentralMessage({
                account,
                chatId,
                text: core.channel.pairing.buildPairingReply({
                  channel: "ringcentral",
                  idLine: `Your RingCentral user id: ${senderId}`,
                  code,
                }),
              });
              statusSink?.({ lastOutboundAt: Date.now() });
            } catch (err) {
              logVerbose(core, runtime, `pairing reply failed for ${senderId}: ${String(err)}`);
            }
          }
        } else {
          logVerbose(
            core,
            runtime,
            `Blocked unauthorized RingCentral sender ${senderId} (dmPolicy=${dmPolicy})`,
          );
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
    logVerbose(core, runtime, `ringcentral: drop control command from ${senderId}`);
    return;
  }

  const route = core.channel.routing.resolveAgentRoute({
    cfg: config,
    channel: "ringcentral",
    accountId: account.accountId,
    peer: {
      kind: isGroup ? "group" : "dm",
      id: chatId,
    },
  });

  let mediaPath: string | undefined;
  let mediaType: string | undefined;
  if (attachments.length > 0) {
    const first = attachments[0];
    const attachmentData = await downloadAttachment(first, account, mediaMaxMb, core);
    if (attachmentData) {
      mediaPath = attachmentData.path;
      mediaType = attachmentData.contentType;
    }
  }

  const fromLabel = isGroup
    ? chatName || `chat:${chatId}`
    : `user:${senderId}`;
  const storePath = core.channel.session.resolveStorePath(config.session?.store, {
    agentId: route.agentId,
  });
  const envelopeOptions = core.channel.reply.resolveEnvelopeFormatOptions(config);
  const previousTimestamp = core.channel.session.readSessionUpdatedAt({
    storePath,
    sessionKey: route.sessionKey,
  });
  const body = core.channel.reply.formatAgentEnvelope({
    channel: "RingCentral",
    from: fromLabel,
    timestamp: eventBody.creationTime ? Date.parse(eventBody.creationTime) : undefined,
    previousTimestamp,
    envelope: envelopeOptions,
    body: rawBody,
  });

  const groupSystemPrompt = groupConfigResolved.entry?.systemPrompt?.trim() || undefined;

  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `ringcentral:${senderId}`,
    To: `ringcentral:${chatId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "channel" : "direct",
    ConversationLabel: fromLabel,
    SenderId: senderId,
    WasMentioned: isGroup ? effectiveWasMentioned : undefined,
    CommandAuthorized: commandAuthorized,
    Provider: "ringcentral",
    Surface: "ringcentral",
    MessageSid: eventBody.id,
    MessageSidFull: eventBody.id,
    MediaPath: mediaPath,
    MediaType: mediaType,
    MediaUrl: mediaPath,
    GroupSpace: isGroup ? chatName ?? undefined : undefined,
    GroupSystemPrompt: isGroup ? groupSystemPrompt : undefined,
    OriginatingChannel: "ringcentral",
    OriginatingTo: `ringcentral:${chatId}`,
  });

  void core.channel.session
    .recordSessionMetaFromInbound({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
    })
    .catch((err) => {
      runtime.error?.(`ringcentral: failed updating session meta: ${String(err)}`);
    });

  let typingPostId: string | undefined;

  // Send typing indicator message
  try {
    const botName = resolveBotDisplayName({
      accountName: account.config.name,
      agentId: route.agentId,
      config,
    });
    const result = await sendRingCentralMessage({
      account,
      chatId,
      text: `_${botName} is typing..._`,
    });
    typingPostId = result?.postId;
  } catch (err) {
    runtime.error?.(`Failed sending typing message: ${String(err)}`);
  }

  await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverRingCentralReply({
          payload,
          account,
          chatId,
          runtime,
          core,
          config,
          statusSink,
          typingPostId,
        });
        typingPostId = undefined;
      },
      onError: (err, info) => {
        runtime.error?.(
          `[${account.accountId}] RingCentral ${info.kind} reply failed: ${String(err)}`,
        );
      },
    },
  });
}

async function downloadAttachment(
  attachment: RingCentralAttachment,
  account: ResolvedRingCentralAccount,
  mediaMaxMb: number,
  core: RingCentralCoreRuntime,
): Promise<{ path: string; contentType?: string } | null> {
  const contentUri = attachment.contentUri;
  if (!contentUri) return null;
  const maxBytes = Math.max(1, mediaMaxMb) * 1024 * 1024;
  const downloaded = await downloadRingCentralAttachment({ account, contentUri, maxBytes });
  const saved = await core.channel.media.saveMediaBuffer(
    downloaded.buffer,
    downloaded.contentType ?? attachment.contentType,
    "inbound",
    maxBytes,
    attachment.name,
  );
  return { path: saved.path, contentType: saved.contentType };
}

async function deliverRingCentralReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  account: ResolvedRingCentralAccount;
  chatId: string;
  runtime: RingCentralRuntimeEnv;
  core: RingCentralCoreRuntime;
  config: ClawdbotConfig;
  statusSink?: (patch: { lastInboundAt?: number; lastOutboundAt?: number }) => void;
  typingPostId?: string;
}): Promise<void> {
  const { payload, account, chatId, runtime, core, config, statusSink, typingPostId } = params;
  const mediaList = payload.mediaUrls?.length
    ? payload.mediaUrls
    : payload.mediaUrl
      ? [payload.mediaUrl]
      : [];

  if (mediaList.length > 0) {
    let suppressCaption = false;
    if (typingPostId) {
      try {
        await deleteRingCentralMessage({
          account,
          chatId,
          postId: typingPostId,
        });
      } catch (err) {
        runtime.error?.(`RingCentral typing cleanup failed: ${String(err)}`);
        const fallbackText = payload.text?.trim()
          ? payload.text
          : mediaList.length > 1
            ? "Sent attachments."
            : "Sent attachment.";
        try {
          await updateRingCentralMessage({
            account,
            chatId,
            postId: typingPostId,
            text: fallbackText,
          });
          suppressCaption = Boolean(payload.text?.trim());
        } catch (updateErr) {
          runtime.error?.(`RingCentral typing update failed: ${String(updateErr)}`);
        }
      }
    }
    let first = true;
    for (const mediaUrl of mediaList) {
      const caption = first && !suppressCaption ? payload.text : undefined;
      first = false;
      try {
        const loaded = await core.channel.media.fetchRemoteMedia(mediaUrl, {
          maxBytes: (account.config.mediaMaxMb ?? 20) * 1024 * 1024,
        });
        const upload = await uploadRingCentralAttachment({
          account,
          chatId,
          filename: loaded.filename ?? "attachment",
          buffer: loaded.buffer,
          contentType: loaded.contentType,
        });
        if (!upload.attachmentId) {
          throw new Error("missing attachment id");
        }
        await sendRingCentralMessage({
          account,
          chatId,
          text: caption,
          attachments: [{ id: upload.attachmentId }],
        });
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`RingCentral attachment send failed: ${String(err)}`);
      }
    }
    return;
  }

  if (payload.text) {
    const chunkLimit = account.config.textChunkLimit ?? 4000;
    const chunkMode = core.channel.text.resolveChunkMode(
      config,
      "ringcentral",
      account.accountId,
    );
    const chunks = core.channel.text.chunkMarkdownTextWithMode(
      payload.text,
      chunkLimit,
      chunkMode,
    );
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      try {
        if (i === 0 && typingPostId) {
          await updateRingCentralMessage({
            account,
            chatId,
            postId: typingPostId,
            text: chunk,
          });
        } else {
          await sendRingCentralMessage({
            account,
            chatId,
            text: chunk,
          });
        }
        statusSink?.({ lastOutboundAt: Date.now() });
      } catch (err) {
        runtime.error?.(`RingCentral message send failed: ${String(err)}`);
      }
    }
  }
}

export async function startRingCentralMonitor(
  options: RingCentralMonitorOptions,
): Promise<() => void> {
  const { account, config, runtime, abortSignal, statusSink } = options;
  const core = getRingCentralRuntime();

  runtime.log?.(`[${account.accountId}] Starting RingCentral WebSocket subscription...`);

  // Get SDK instance
  const sdk = await getRingCentralSDK(account);
  
  // Create subscriptions manager
  const subscriptions = new Subscriptions({ sdk });
  const subscription = subscriptions.createSubscription();

  // Track current user ID to filter out self messages
  let ownerId: string | undefined;
  try {
    const platform = sdk.platform();
    const response = await platform.get("/restapi/v1.0/account/~/extension/~");
    const userInfo = await response.json();
    ownerId = userInfo?.id?.toString();
    runtime.log?.(`[${account.accountId}] Authenticated as extension: ${ownerId}`);
  } catch (err) {
    runtime.error?.(`[${account.accountId}] Failed to get current user: ${String(err)}`);
  }

  // Handle notifications
  subscription.on(subscription.events.notification, (event: unknown) => {
    const evt = event as RingCentralWebhookEvent;
    processWebSocketEvent({
      event: evt,
      account,
      config,
      runtime,
      core,
      statusSink,
      ownerId,
    }).catch((err) => {
      runtime.error?.(`[${account.accountId}] WebSocket event processing failed: ${String(err)}`);
    });
  });

  // Handle subscription status changes
  subscription.on(subscription.events.subscribeSuccess, () => {
    runtime.log?.(`[${account.accountId}] WebSocket subscription active`);
  });

  subscription.on(subscription.events.subscribeError, (err: unknown) => {
    runtime.error?.(`[${account.accountId}] WebSocket subscription error: ${String(err)}`);
  });

  subscription.on(subscription.events.renewSuccess, () => {
    logVerbose(core, runtime, "WebSocket subscription renewed");
  });

  subscription.on(subscription.events.renewError, (err: unknown) => {
    runtime.error?.(`[${account.accountId}] WebSocket subscription renew error: ${String(err)}`);
  });

  // Subscribe to Team Messaging events
  // - /restapi/v1.0/glip/posts: New posts in chats
  // - /restapi/v1.0/glip/groups: Chat/group changes
  try {
    await subscription
      .setEventFilters([
        "/restapi/v1.0/glip/posts",
        "/restapi/v1.0/glip/groups",
      ])
      .register();
    
    runtime.log?.(`[${account.accountId}] RingCentral WebSocket subscription established`);
  } catch (err) {
    runtime.error?.(`[${account.accountId}] Failed to create WebSocket subscription: ${String(err)}`);
    throw err;
  }

  // Handle abort signal
  const cleanup = () => {
    runtime.log?.(`[${account.accountId}] Stopping RingCentral WebSocket subscription...`);
    subscription.reset().catch((err) => {
      runtime.error?.(`[${account.accountId}] Failed to reset subscription: ${String(err)}`);
    });
  };

  if (abortSignal.aborted) {
    cleanup();
  } else {
    abortSignal.addEventListener("abort", cleanup, { once: true });
  }

  return cleanup;
}

// Keep the webhook path resolver for status display
export function resolveRingCentralWebhookPath(_params: {
  account: ResolvedRingCentralAccount;
}): string {
  return "(WebSocket)";
}
