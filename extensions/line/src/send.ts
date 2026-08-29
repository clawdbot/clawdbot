// Line plugin module implements send behavior.
import { randomUUID } from "node:crypto";
import { HTTPFetchError, messagingApi } from "@line/bot-sdk";
import lineBotSdkPackage from "@line/bot-sdk/package.json" with { type: "json" };
import { recordChannelActivity } from "openclaw/plugin-sdk/channel-activity-runtime";
import { createChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import { pruneMapToMaxSize } from "openclaw/plugin-sdk/collection-runtime";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import {
  readProviderJsonResponse,
  readResponseTextLimited,
} from "openclaw/plugin-sdk/provider-http";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { fetchWithRuntimeDispatcherOrMockedGlobal } from "openclaw/plugin-sdk/runtime-fetch";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { resolveLineAccount } from "./accounts.js";
import { messageAction, normalizeLineMessageActions } from "./actions.js";
import { resolveLineChannelAccessToken } from "./channel-access-token.js";
import { validateLineMediaUrl } from "./outbound-media.js";
import { recordLineSentMessages } from "./outbound-message-log.js";
import { createLineSendReceipt } from "./send-receipt.js";
import { runLinePushWithRetries } from "./send-retry.js";
import type { LineChannelData, LineOutboundMediaKind, LineSendResult } from "./types.js";

type Message = messagingApi.Message;
type TextMessage = messagingApi.TextMessage;
type ImageMessage = messagingApi.ImageMessage;
type VideoMessage = messagingApi.VideoMessage & { trackingId?: string };
type AudioMessage = messagingApi.AudioMessage;
type LocationMessage = messagingApi.LocationMessage;
type FlexContainer = messagingApi.FlexContainer;
type TemplateMessage = messagingApi.TemplateMessage;
type QuickReply = messagingApi.QuickReply;
type QuickReplyItem = messagingApi.QuickReplyItem;
type LineLocation = NonNullable<LineChannelData["location"]>;

type LineUserProfile = { displayName: string; pictureUrl?: string };
type LineIdentityCache<T> = {
  values: Map<string, { value: T; fetchedAt: number }>;
  pending: Map<string, Promise<T>>;
};

const profileCache: LineIdentityCache<LineUserProfile | null> = {
  values: new Map(),
  pending: new Map(),
};
const groupNameCache: LineIdentityCache<string | undefined> = {
  values: new Map(),
  pending: new Map(),
};
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000;
const PROFILE_CACHE_MAX_ENTRIES = 1000;
const LINE_FLEX_ALT_TEXT_LIMIT = 1500;
const LINE_LOCATION_LABEL_LIMIT = 100;
// This cap bounds receipts and diagnostics: overflow after acceptance becomes no-retry partial
// delivery, while rejected responses keep their status with prefix-only diagnostics.
const LINE_PROVIDER_RESPONSE_MAX_BYTES = 16 * 1024;

// Refresh insertion order so overflow evicts expired entries first, then the oldest live fetch.
function rememberLineIdentity<T>(cache: LineIdentityCache<T>, key: string, value: T): void {
  const entry = { value, fetchedAt: Date.now() };
  cache.values.delete(key);
  cache.values.set(key, entry);
  if (cache.values.size <= PROFILE_CACHE_MAX_ENTRIES) {
    return;
  }
  for (const [cachedKey, cached] of cache.values) {
    if (entry.fetchedAt - cached.fetchedAt >= PROFILE_CACHE_TTL_MS) {
      cache.values.delete(cachedKey);
    }
  }
  pruneMapToMaxSize(cache.values, PROFILE_CACHE_MAX_ENTRIES);
}

async function loadLineIdentity<T>(
  cache: LineIdentityCache<T>,
  key: string,
  load: () => Promise<T>,
): Promise<T> {
  const cached = cache.values.get(key);
  if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS) {
    return cached.value;
  }
  const pending = cache.pending.get(key);
  if (pending) {
    return await pending;
  }
  const lookup = load().then((value) => {
    rememberLineIdentity(cache, key, value);
    return value;
  });
  cache.pending.set(key, lookup);
  pruneMapToMaxSize(cache.pending, PROFILE_CACHE_MAX_ENTRIES);
  try {
    return await lookup;
  } finally {
    if (cache.pending.get(key) === lookup) {
      cache.pending.delete(key);
    }
  }
}

interface LineSendOpts {
  cfg: OpenClawConfig;
  channelAccessToken?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  mediaKind?: LineOutboundMediaKind;
  previewImageUrl?: string;
  durationMs?: number;
  trackingId?: string;
  replyToken?: string;
}

type LineClientOpts = Pick<LineSendOpts, "cfg" | "channelAccessToken" | "accountId">;
type LinePushOpts = Pick<LineSendOpts, "cfg" | "channelAccessToken" | "accountId" | "verbose">;

interface LinePushBehavior {
  errorContext?: string;
  verboseMessage?: (chatId: string, messageCount: number) => string;
}

function resolveLineProviderMessageIds(
  response: messagingApi.PushMessageResponse | messagingApi.ReplyMessageResponse,
  operation: "push" | "reply",
): { messageId: string; messageIds: string[] } {
  const sentMessages = Array.isArray(response?.sentMessages) ? response.sentMessages : [];
  const messageIds = sentMessages.flatMap((entry) => {
    const id = entry && typeof entry === "object" ? entry.id : undefined;
    const messageId = typeof id === "string" ? id.trim() : "";
    return messageId ? [messageId] : [];
  });
  const messageId = messageIds[0];
  if (!messageId || messageIds.length !== sentMessages.length) {
    // A successful LINE response means delivery was accepted even when its receipt is malformed.
    throw createChannelPartialDeliveryError(
      new Error(`LINE ${operation} response did not include a sent message id`),
      { messageIds, visibleReplySent: true },
    );
  }
  return { messageId, messageIds };
}

function normalizeTarget(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) {
    throw new Error("Recipient is required for LINE sends");
  }

  const normalized = trimmed
    .replace(/^line:group:/i, "")
    .replace(/^line:room:/i, "")
    .replace(/^line:user:/i, "")
    .replace(/^line:/i, "");

  if (!normalized) {
    throw new Error("Recipient is required for LINE sends");
  }

  // Real LINE chat ids are a capital C/U/R followed by 32 lowercase hex chars
  // (33 chars total) and are case-sensitive — push returns HTTP 400 otherwise.
  // Reject values that match the LINE id shape but lost their leading capital
  // so the failure is surfaced as a permanent error (recovery moves the entry
  // to failed/ immediately instead of silently retrying 5 times). Short test
  // fixtures (e.g. "U123") are left alone. openclaw/openclaw#81628
  if (normalized.length >= 33 && !/^[CUR]/.test(normalized)) {
    throw new Error(
      `Recipient is not a valid LINE id (case-sensitive; expected leading capital C/U/R): ${truncateUtf16Safe(normalized, 4)}…`,
    );
  }

  return normalized;
}

function isLineUserChatId(chatId: string): boolean {
  return /^U/i.test(chatId);
}

function resolveLineMessagingAccount(opts: LineClientOpts): {
  account: ReturnType<typeof resolveLineAccount>;
  token: string;
} {
  const cfg = requireRuntimeConfig(opts.cfg, "LINE send");
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveLineChannelAccessToken(opts.channelAccessToken, account);
  return { account, token };
}

function createLineMessagingClient(opts: LineClientOpts): {
  account: ReturnType<typeof resolveLineAccount>;
  client: messagingApi.MessagingApiClient;
} {
  const { account, token } = resolveLineMessagingAccount(opts);
  return {
    account,
    client: new messagingApi.MessagingApiClient({ channelAccessToken: token }),
  };
}

function createLinePushContext(
  to: string,
  opts: LineClientOpts,
): {
  account: ReturnType<typeof resolveLineAccount>;
  token: string;
  chatId: string;
} {
  const { account, token } = resolveLineMessagingAccount(opts);
  const chatId = normalizeTarget(to);
  return { account, token, chatId };
}

async function sendLineProviderMessages(
  operation: "push" | "reply",
  token: string,
  request: messagingApi.PushMessageRequest | messagingApi.ReplyMessageRequest,
  retryKey?: string,
): Promise<messagingApi.PushMessageResponse | messagingApi.ReplyMessageResponse> {
  const response = await fetchWithRuntimeDispatcherOrMockedGlobal(
    `https://api.line.me/v2/bot/message/${operation}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": `@line/bot-sdk/${lineBotSdkPackage.version}`,
        ...(retryKey ? { "X-Line-Retry-Key": retryKey } : {}),
      },
      body: JSON.stringify(request),
    },
  );

  // LINE answers a retried key with 409 and the accepted request's sent messages
  // instead of delivering the batch a second time, so that conflict is the
  // earlier attempt's success rather than a failure of this one.
  const acceptedRetryConflict = retryKey !== undefined && response.status === 409;

  if (!response.ok && !acceptedRetryConflict) {
    const body = await readResponseTextLimited(response, LINE_PROVIDER_RESPONSE_MAX_BYTES).catch(
      () => "",
    );
    throw new HTTPFetchError(`${response.status} - ${response.statusText}`, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
      body,
    });
  }

  try {
    return await readProviderJsonResponse<
      messagingApi.PushMessageResponse | messagingApi.ReplyMessageResponse
    >(response, `LINE ${operation} response`, {
      maxBytes: LINE_PROVIDER_RESPONSE_MAX_BYTES,
    });
  } catch (error) {
    // LINE accepted this exact request before its receipt became unreadable; retrying duplicates it.
    throw createChannelPartialDeliveryError(error, { messageIds: [], visibleReplySent: true });
  }
}

function createTextMessage(text: string): TextMessage {
  return { type: "text", text };
}

export function createImageMessage(
  originalContentUrl: string,
  previewImageUrl?: string,
): ImageMessage {
  return {
    type: "image",
    originalContentUrl,
    previewImageUrl: previewImageUrl ?? originalContentUrl,
  };
}

export function createVideoMessage(
  originalContentUrl: string,
  previewImageUrl: string,
  trackingId?: string,
): VideoMessage {
  return {
    type: "video",
    originalContentUrl,
    previewImageUrl,
    ...(trackingId ? { trackingId } : {}),
  };
}

export function createAudioMessage(originalContentUrl: string, durationMs: number): AudioMessage {
  return {
    type: "audio",
    originalContentUrl,
    duration: durationMs,
  };
}

function isValidLineLocation(location: LineLocation): boolean {
  // LINE rejects either blank required field atomically, so every delivery path
  // must use this gate before adding a location to a provider request.
  return location.title.trim().length > 0 && location.address.trim().length > 0;
}

// A pin LINE will not render still carries the values the sender wrote, and the
// coordinates are always present, so the location degrades to the text it was
// made of instead of vanishing from the reply.
function locationTextFallback(location: LineLocation): TextMessage {
  // The pin caps each label, and so must the fallback: an unbounded label would
  // breach LINE's text limit and lose the location the same silent way.
  const authored = [location.title, location.address]
    .map((label) => truncateUtf16Safe(label.trim(), LINE_LOCATION_LABEL_LIMIT))
    .filter(Boolean);
  return {
    type: "text",
    text: [...authored, `${location.latitude}, ${location.longitude}`].join("\n"),
  };
}

export function createLocationMessage(location: LineLocation): LocationMessage | TextMessage {
  if (!isValidLineLocation(location)) {
    return locationTextFallback(location);
  }
  return {
    type: "location",
    title: truncateUtf16Safe(location.title, LINE_LOCATION_LABEL_LIMIT),
    address: truncateUtf16Safe(location.address, LINE_LOCATION_LABEL_LIMIT),
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

function logLineHttpError(err: unknown, context: string): void {
  if (!err || typeof err !== "object") {
    return;
  }
  const { status, statusText, body } = err as {
    status?: number;
    statusText?: string;
    body?: string;
  };
  if (typeof body === "string") {
    const summary = status ? `${status} ${statusText ?? ""}`.trim() : "unknown status";
    logVerbose(`line: ${context} failed (${summary}): ${body}`);
  }
}

function recordLineOutboundActivity(
  accountId: string,
  delivery: { messageIds: string[]; receipt?: LineSendResult["receipt"] },
): void {
  // Every LINE send funnels through here, so this is where the ids a later quote
  // can point at become known.
  recordLineSentMessages(accountId, delivery.messageIds);
  try {
    recordChannelActivity({
      channel: "line",
      accountId,
      direction: "outbound",
    });
  } catch (error) {
    // Provider delivery is already final; retain its identity if local bookkeeping fails.
    throw createChannelPartialDeliveryError(error, {
      messageIds: delivery.messageIds,
      ...(delivery.receipt ? { receipt: delivery.receipt } : {}),
      visibleReplySent: true,
    });
  }
}

function resolveLineReceiptKind(messages: readonly Message[]) {
  const types = new Set(messages.map((message) => message.type));
  if (types.has("audio")) {
    return "voice";
  }
  if (types.has("image") || types.has("video")) {
    return "media";
  }
  if (types.has("flex") || types.has("template") || types.has("location")) {
    return "card";
  }
  if (types.has("text")) {
    return "text";
  }
  return "unknown";
}

async function pushLineMessages(
  to: string,
  messages: Message[],
  opts: LinePushOpts,
  behavior: LinePushBehavior = {},
): Promise<LineSendResult> {
  if (messages.length === 0) {
    throw new Error("Message must be non-empty for LINE sends");
  }

  const { account, token, chatId } = createLinePushContext(to, opts);
  const normalizedMessages = messages.map(normalizeLineMessageActions);
  // One retry key per logical push: every attempt reuses it so LINE deduplicates
  // an attempt that was accepted before its outcome reached us.
  const retryKey = randomUUID();

  const response = await runLinePushWithRetries(async () => {
    try {
      return await sendLineProviderMessages(
        "push",
        token,
        { to: chatId, messages: normalizedMessages },
        retryKey,
      );
    } catch (err) {
      if (behavior.errorContext) {
        logLineHttpError(err, behavior.errorContext);
      }
      throw err;
    }
  }, "line:push");
  const { messageId, messageIds } = resolveLineProviderMessageIds(response, "push");
  const result: LineSendResult = {
    messageId,
    chatId,
    receipt: createLineSendReceipt({
      messageId,
      messageIds,
      chatId,
      kind: resolveLineReceiptKind(messages),
      messageCount: messages.length,
    }),
  };

  recordLineOutboundActivity(account.accountId, { messageIds, receipt: result.receipt });

  if (opts.verbose) {
    const logMessage =
      behavior.verboseMessage?.(chatId, messages.length) ??
      `line: pushed ${messages.length} messages to ${chatId}`;
    logVerbose(logMessage);
  }

  return result;
}

async function replyLineMessages(
  replyToken: string,
  messages: Message[],
  opts: LinePushOpts,
): Promise<{ messageId: string; messageIds: string[]; accountId: string }> {
  const { account, token } = resolveLineMessagingAccount(opts);
  const normalizedMessages = messages.map(normalizeLineMessageActions);

  const response = await sendLineProviderMessages("reply", token, {
    replyToken,
    messages: normalizedMessages,
  });
  const result = resolveLineProviderMessageIds(response, "reply");
  return { ...result, accountId: account.accountId };
}

export async function sendMessageLine(
  to: string,
  text: string,
  opts: LineSendOpts,
): Promise<LineSendResult> {
  const chatId = normalizeTarget(to);
  const messages: Message[] = [];

  const mediaUrl = opts.mediaUrl?.trim();
  if (mediaUrl) {
    await validateLineMediaUrl(mediaUrl);
    switch (opts.mediaKind) {
      case "video": {
        const previewImageUrl = opts.previewImageUrl?.trim();
        if (!previewImageUrl) {
          throw new Error("LINE video messages require previewImageUrl to reference an image URL");
        }
        await validateLineMediaUrl(previewImageUrl);
        const trackingId = isLineUserChatId(chatId) ? opts.trackingId : undefined;
        messages.push(createVideoMessage(mediaUrl, previewImageUrl, trackingId));
        break;
      }
      case "audio":
        messages.push(createAudioMessage(mediaUrl, opts.durationMs ?? 60000));
        break;
      default:
        // Backward compatibility: keep image as default when media kind is unspecified.
        {
          const previewImageUrl = opts.previewImageUrl?.trim() || mediaUrl;
          await validateLineMediaUrl(previewImageUrl);
          messages.push(createImageMessage(mediaUrl, previewImageUrl));
        }
        break;
    }
  }

  if (text?.trim()) {
    messages.push(createTextMessage(text.trim()));
  }

  if (messages.length === 0) {
    throw new Error("Message must be non-empty for LINE sends");
  }

  if (opts.replyToken) {
    const { messageId, messageIds, accountId } = await replyLineMessages(
      opts.replyToken,
      messages,
      opts,
    );
    const result: LineSendResult = {
      messageId,
      chatId,
      receipt: createLineSendReceipt({
        messageId,
        messageIds,
        chatId,
        kind: resolveLineReceiptKind(messages),
        messageCount: messages.length,
      }),
    };
    recordLineOutboundActivity(accountId, { messageIds, receipt: result.receipt });
    if (opts.verbose) {
      logVerbose(`line: replied to ${chatId}`);
    }
    return result;
  }

  return pushLineMessages(chatId, messages, opts, {
    verboseMessage: (resolvedChatId) => `line: pushed message to ${resolvedChatId}`,
  });
}

export async function pushMessageLine(
  to: string,
  text: string,
  opts: LineSendOpts,
): Promise<LineSendResult> {
  return sendMessageLine(to, text, { ...opts, replyToken: undefined });
}

export async function replyMessageLine(
  replyToken: string,
  messages: Message[],
  opts: LinePushOpts,
): Promise<void> {
  const { messageIds, accountId } = await replyLineMessages(replyToken, messages, opts);
  recordLineOutboundActivity(accountId, { messageIds });
  if (opts.verbose) {
    logVerbose(`line: replied with ${messages.length} messages`);
  }
}

export async function pushMessagesLine(
  to: string,
  messages: Message[],
  opts: LinePushOpts,
): Promise<LineSendResult> {
  return pushLineMessages(to, messages, opts, {
    errorContext: "push message",
  });
}

export function createFlexMessage(
  altText: string,
  contents: messagingApi.FlexContainer,
): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText: truncateUtf16Safe(altText, LINE_FLEX_ALT_TEXT_LIMIT),
    contents,
  };
}

export async function pushImageMessage(
  to: string,
  originalContentUrl: string,
  previewImageUrl: string | undefined,
  opts: LinePushOpts,
): Promise<LineSendResult> {
  await validateLineMediaUrl(originalContentUrl);
  if (previewImageUrl) {
    await validateLineMediaUrl(previewImageUrl);
  }
  return pushLineMessages(to, [createImageMessage(originalContentUrl, previewImageUrl)], opts, {
    verboseMessage: (chatId) => `line: pushed image to ${chatId}`,
  });
}

export async function pushLocationMessage(
  to: string,
  location: LineLocation,
  opts: LinePushOpts,
): Promise<LineSendResult> {
  return pushLineMessages(to, [createLocationMessage(location)], opts, {
    verboseMessage: (chatId) => `line: pushed location to ${chatId}`,
  });
}

export async function pushFlexMessage(
  to: string,
  altText: string,
  contents: FlexContainer,
  opts: LinePushOpts,
): Promise<LineSendResult> {
  return pushLineMessages(to, [createFlexMessage(altText, contents)], opts, {
    errorContext: "push flex message",
    verboseMessage: (chatId) => `line: pushed flex message to ${chatId}`,
  });
}

export async function pushTemplateMessage(
  to: string,
  template: TemplateMessage,
  opts: LinePushOpts,
): Promise<LineSendResult> {
  return pushLineMessages(to, [template], opts, {
    verboseMessage: (chatId) => `line: pushed template message to ${chatId}`,
  });
}

export async function pushTextMessageWithQuickReplies(
  to: string,
  text: string,
  quickReplyLabels: string[],
  opts: LinePushOpts,
): Promise<LineSendResult> {
  const message = createTextMessageWithQuickReplies(text, quickReplyLabels);

  return pushLineMessages(to, [message], opts, {
    verboseMessage: (chatId) => `line: pushed message with quick replies to ${chatId}`,
  });
}

export function createQuickReplyItems(labels: string[]): QuickReply {
  const items: QuickReplyItem[] = labels.slice(0, 13).map((label) => ({
    type: "action",
    action: messageAction(label, label),
  }));
  return { items };
}

export function createTextMessageWithQuickReplies(
  text: string,
  quickReplyLabels: string[],
): TextMessage & { quickReply: QuickReply } {
  return {
    type: "text",
    text,
    quickReply: createQuickReplyItems(quickReplyLabels),
  };
}

export async function showLoadingAnimation(
  chatId: string,
  opts: LineClientOpts & { loadingSeconds?: number },
): Promise<void> {
  const { client } = createLineMessagingClient(opts);

  try {
    await client.showLoadingAnimation({
      chatId: normalizeTarget(chatId),
      loadingSeconds: opts.loadingSeconds ?? 20,
    });
    logVerbose(`line: showing loading animation to ${chatId}`);
  } catch (err) {
    logVerbose(`line: loading animation failed (non-fatal): ${String(err)}`);
  }
}

export type LineConversationScope = { groupId?: string; roomId?: string };

function lineProfileCacheKey(
  accountId: string,
  userId: string,
  scope: LineConversationScope,
): string {
  const conversation = scope.groupId
    ? ["group", scope.groupId]
    : scope.roomId
      ? ["room", scope.roomId]
      : ["direct"];
  return JSON.stringify([accountId, "profile", ...conversation, userId]);
}

// A group or room member who has not added the bot as a friend is invisible to
// the plain profile endpoint, so the sender's conversation decides which one can
// answer. Reading the wrong one returns 404 for exactly the people whose names
// matter most in a group.
function fetchLineMemberProfile(
  client: messagingApi.MessagingApiClient,
  userId: string,
  scope: LineConversationScope,
): Promise<{ displayName: string; pictureUrl?: string }> {
  if (scope.groupId) {
    return client.getGroupMemberProfile(scope.groupId, userId);
  }
  if (scope.roomId) {
    return client.getRoomMemberProfile(scope.roomId, userId);
  }
  return client.getProfile(userId);
}

export async function getUserProfile(
  userId: string,
  opts: LineClientOpts & { useCache?: boolean } & LineConversationScope,
): Promise<LineUserProfile | null> {
  const useCache = opts.useCache ?? true;
  try {
    // Client construction resolves the canonical account for the cache key and
    // can throw; an unresolvable name must never cost the inbound turn.
    const { account, token } = resolveLineMessagingAccount(opts);
    const cacheKey = lineProfileCacheKey(account.accountId, userId, opts);
    const load = async () => {
      try {
        const client = new messagingApi.MessagingApiClient({ channelAccessToken: token });
        const profile = await fetchLineMemberProfile(client, userId, opts);
        return { displayName: profile.displayName, pictureUrl: profile.pictureUrl };
      } catch (err) {
        logVerbose(`line: failed to fetch profile for ${userId}: ${String(err)}`);
        return null;
      }
    };
    if (!useCache) {
      const profile = await load();
      rememberLineIdentity(profileCache, cacheKey, profile);
      return profile;
    }
    return await loadLineIdentity(profileCache, cacheKey, load);
  } catch (err) {
    logVerbose(`line: failed to fetch profile for ${userId}: ${String(err)}`);
    return null;
  }
}

export async function getUserDisplayName(
  userId: string,
  opts: LineClientOpts & LineConversationScope,
): Promise<string> {
  const profile = await getUserProfile(userId, opts);
  return profile?.displayName ?? userId;
}

// LINE never puts the group name in a webhook, and multi-person rooms have no
// name endpoint at all, so only groups can be named and only by asking.
export async function getLineGroupName(
  groupId: string,
  opts: LineClientOpts,
): Promise<string | undefined> {
  try {
    const { account, token } = resolveLineMessagingAccount(opts);
    const cacheKey = JSON.stringify([account.accountId, "group", groupId]);
    return await loadLineIdentity(groupNameCache, cacheKey, async () => {
      try {
        const client = new messagingApi.MessagingApiClient({ channelAccessToken: token });
        const summary = await client.getGroupSummary(groupId);
        return summary.groupName.trim() || undefined;
      } catch (err) {
        logVerbose(`line: failed to fetch group summary for ${groupId}: ${String(err)}`);
        return undefined;
      }
    });
  } catch (err) {
    logVerbose(`line: failed to fetch group summary for ${groupId}: ${String(err)}`);
    return undefined;
  }
}
