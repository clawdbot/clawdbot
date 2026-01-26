import { messagingApi } from "@line/bot-sdk";
import { loadConfig } from "../config/config.js";
import { logVerbose } from "../globals.js";
import { recordChannelActivity } from "../infra/channel-activity.js";
import { resolveLineAccount } from "./accounts.js";
import type { LineSendResult } from "./types.js";

// Use the messaging API types directly
type Message = messagingApi.Message;
type TextMessage = messagingApi.TextMessage;
type ImageMessage = messagingApi.ImageMessage;
type LocationMessage = messagingApi.LocationMessage;
type FlexMessage = messagingApi.FlexMessage;
type FlexContainer = messagingApi.FlexContainer;
type TemplateMessage = messagingApi.TemplateMessage;
type QuickReply = messagingApi.QuickReply;
type QuickReplyItem = messagingApi.QuickReplyItem;

// Cache for user profiles
const userProfileCache = new Map<
  string,
  { displayName: string; pictureUrl?: string; fetchedAt: number }
>();
const PROFILE_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

interface LineSendOpts {
  channelAccessToken?: string;
  accountId?: string;
  verbose?: boolean;
  mediaUrl?: string;
  replyToken?: string;
}

function resolveToken(
  explicit: string | undefined,
  params: { accountId: string; channelAccessToken: string },
): string {
  if (explicit?.trim()) return explicit.trim();
  if (!params.channelAccessToken) {
    throw new Error(
      `LINE channel access token missing for account "${params.accountId}" (set channels.line.channelAccessToken or LINE_CHANNEL_ACCESS_TOKEN).`,
    );
  }
  return params.channelAccessToken.trim();
}

function normalizeTarget(to: string): string {
  const trimmed = to.trim();
  if (!trimmed) throw new Error("Recipient is required for LINE sends");

  // Strip internal prefixes
  let normalized = trimmed
    .replace(/^line:group:/i, "")
    .replace(/^line:room:/i, "")
    .replace(/^line:user:/i, "")
    .replace(/^line:/i, "");

  if (!normalized) throw new Error("Recipient is required for LINE sends");

  return normalized;
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

export function createLocationMessage(location: {
  title: string;
  address: string;
  latitude: number;
  longitude: number;
}): LocationMessage {
  return {
    type: "location",
    title: location.title.slice(0, 100), // LINE limit
    address: location.address.slice(0, 100), // LINE limit
    latitude: location.latitude,
    longitude: location.longitude,
  };
}

function logLineHttpError(err: unknown, context: string): void {
  if (!err || typeof err !== "object") return;
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

export async function sendMessageLine(
  to: string,
  text: string,
  opts: LineSendOpts = {},
): Promise<LineSendResult> {
  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);
  const chatId = normalizeTarget(to);

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  const messages: Message[] = [];

  // Add media if provided
  if (opts.mediaUrl?.trim()) {
    messages.push(createImageMessage(opts.mediaUrl.trim()));
  }

  // Add text message
  if (text?.trim()) {
    messages.push(createTextMessage(text.trim()));
  }

  if (messages.length === 0) {
    throw new Error("Message must be non-empty for LINE sends");
  }

  // Use reply if we have a reply token, otherwise push
  if (opts.replyToken) {
    await client.replyMessage({
      replyToken: opts.replyToken,
      messages,
    });

    recordChannelActivity({
      channel: "line",
      accountId: account.accountId,
      direction: "outbound",
    });

    if (opts.verbose) {
      logVerbose(`line: replied to ${chatId}`);
    }

    return {
      messageId: "reply",
      chatId,
    };
  }

  // Push message (for proactive messaging)
  await client.pushMessage({
    to: chatId,
    messages,
  });

  recordChannelActivity({
    channel: "line",
    accountId: account.accountId,
    direction: "outbound",
  });

  if (opts.verbose) {
    logVerbose(`line: pushed message to ${chatId}`);
  }

  return {
    messageId: "push",
    chatId,
  };
}

export async function pushMessageLine(
  to: string,
  text: string,
  opts: LineSendOpts = {},
): Promise<LineSendResult> {
  // Force push (no reply token)
  return sendMessageLine(to, text, { ...opts, replyToken: undefined });
}

export async function replyMessageLine(
  replyToken: string,
  messages: Message[],
  opts: { channelAccessToken?: string; accountId?: string; verbose?: boolean } = {},
): Promise<void> {
  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  await client.replyMessage({
    replyToken,
    messages,
  });

  recordChannelActivity({
    channel: "line",
    accountId: account.accountId,
    direction: "outbound",
  });

  if (opts.verbose) {
    logVerbose(`line: replied with ${messages.length} messages`);
  }
}

export async function pushMessagesLine(
  to: string,
  messages: Message[],
  opts: { channelAccessToken?: string; accountId?: string; verbose?: boolean } = {},
): Promise<LineSendResult> {
  if (messages.length === 0) {
    throw new Error("Message must be non-empty for LINE sends");
  }

  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);
  const chatId = normalizeTarget(to);

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  await client
    .pushMessage({
      to: chatId,
      messages,
    })
    .catch((err) => {
      logLineHttpError(err, "push message");
      throw err;
    });

  recordChannelActivity({
    channel: "line",
    accountId: account.accountId,
    direction: "outbound",
  });

  if (opts.verbose) {
    logVerbose(`line: pushed ${messages.length} messages to ${chatId}`);
  }

  return {
    messageId: "push",
    chatId,
  };
}

export function createFlexMessage(
  altText: string,
  contents: messagingApi.FlexContainer,
): messagingApi.FlexMessage {
  return {
    type: "flex",
    altText,
    contents,
  };
}

/**
 * Push an image message to a user/group
 */
export async function pushImageMessage(
  to: string,
  originalContentUrl: string,
  previewImageUrl?: string,
  opts: { channelAccessToken?: string; accountId?: string; verbose?: boolean } = {},
): Promise<LineSendResult> {
  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);
  const chatId = normalizeTarget(to);

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  const imageMessage = createImageMessage(originalContentUrl, previewImageUrl);

  await client.pushMessage({
    to: chatId,
    messages: [imageMessage],
  });

  recordChannelActivity({
    channel: "line",
    accountId: account.accountId,
    direction: "outbound",
  });

  if (opts.verbose) {
    logVerbose(`line: pushed image to ${chatId}`);
  }

  return {
    messageId: "push",
    chatId,
  };
}

/**
 * Push a location message to a user/group
 */
export async function pushLocationMessage(
  to: string,
  location: {
    title: string;
    address: string;
    latitude: number;
    longitude: number;
  },
  opts: { channelAccessToken?: string; accountId?: string; verbose?: boolean } = {},
): Promise<LineSendResult> {
  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);
  const chatId = normalizeTarget(to);

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  const locationMessage = createLocationMessage(location);

  await client.pushMessage({
    to: chatId,
    messages: [locationMessage],
  });

  recordChannelActivity({
    channel: "line",
    accountId: account.accountId,
    direction: "outbound",
  });

  if (opts.verbose) {
    logVerbose(`line: pushed location to ${chatId}`);
  }

  return {
    messageId: "push",
    chatId,
  };
}

/**
 * Push a Flex Message to a user/group
 */
export async function pushFlexMessage(
  to: string,
  altText: string,
  contents: FlexContainer,
  opts: { channelAccessToken?: string; accountId?: string; verbose?: boolean } = {},
): Promise<LineSendResult> {
  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);
  const chatId = normalizeTarget(to);

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  const flexMessage: FlexMessage = {
    type: "flex",
    altText: altText.slice(0, 400), // LINE limit
    contents,
  };

  await client
    .pushMessage({
      to: chatId,
      messages: [flexMessage],
    })
    .catch((err) => {
      logLineHttpError(err, "push flex message");
      throw err;
    });

  recordChannelActivity({
    channel: "line",
    accountId: account.accountId,
    direction: "outbound",
  });

  if (opts.verbose) {
    logVerbose(`line: pushed flex message to ${chatId}`);
  }

  return {
    messageId: "push",
    chatId,
  };
}

/**
 * Push a Template Message to a user/group
 */
export async function pushTemplateMessage(
  to: string,
  template: TemplateMessage,
  opts: { channelAccessToken?: string; accountId?: string; verbose?: boolean } = {},
): Promise<LineSendResult> {
  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);
  const chatId = normalizeTarget(to);

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  await client.pushMessage({
    to: chatId,
    messages: [template],
  });

  recordChannelActivity({
    channel: "line",
    accountId: account.accountId,
    direction: "outbound",
  });

  if (opts.verbose) {
    logVerbose(`line: pushed template message to ${chatId}`);
  }

  return {
    messageId: "push",
    chatId,
  };
}

/**
 * Push a text message with quick reply buttons
 */
export async function pushTextMessageWithQuickReplies(
  to: string,
  text: string,
  quickReplyLabels: string[],
  opts: { channelAccessToken?: string; accountId?: string; verbose?: boolean } = {},
): Promise<LineSendResult> {
  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);
  const chatId = normalizeTarget(to);

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  const message = createTextMessageWithQuickReplies(text, quickReplyLabels);

  await client.pushMessage({
    to: chatId,
    messages: [message],
  });

  recordChannelActivity({
    channel: "line",
    accountId: account.accountId,
    direction: "outbound",
  });

  if (opts.verbose) {
    logVerbose(`line: pushed message with quick replies to ${chatId}`);
  }

  return {
    messageId: "push",
    chatId,
  };
}

/**
 * Create quick reply buttons to attach to a message
 */
export function createQuickReplyItems(labels: string[]): QuickReply {
  const items: QuickReplyItem[] = labels.slice(0, 13).map((label) => ({
    type: "action",
    action: {
      type: "message",
      label: label.slice(0, 20), // LINE limit: 20 chars
      text: label,
    },
  }));
  return { items };
}

/**
 * Create a text message with quick reply buttons
 */
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

/**
 * Show loading animation to user (lasts up to 20 seconds or until next message)
 */
export async function showLoadingAnimation(
  chatId: string,
  opts: { channelAccessToken?: string; accountId?: string; loadingSeconds?: number } = {},
): Promise<void> {
  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  try {
    await client.showLoadingAnimation({
      chatId: normalizeTarget(chatId),
      loadingSeconds: opts.loadingSeconds ?? 20,
    });
    logVerbose(`line: showing loading animation to ${chatId}`);
  } catch (err) {
    // Loading animation may fail for groups or unsupported clients - ignore
    logVerbose(`line: loading animation failed (non-fatal): ${String(err)}`);
  }
}

/**
 * Fetch user profile (display name, picture URL)
 */
export async function getUserProfile(
  userId: string,
  opts: { channelAccessToken?: string; accountId?: string; useCache?: boolean } = {},
): Promise<{ displayName: string; pictureUrl?: string } | null> {
  const useCache = opts.useCache ?? true;

  // Check cache first
  if (useCache) {
    const cached = userProfileCache.get(userId);
    if (cached && Date.now() - cached.fetchedAt < PROFILE_CACHE_TTL_MS) {
      return { displayName: cached.displayName, pictureUrl: cached.pictureUrl };
    }
  }

  const cfg = loadConfig();
  const account = resolveLineAccount({
    cfg,
    accountId: opts.accountId,
  });
  const token = resolveToken(opts.channelAccessToken, account);

  const client = new messagingApi.MessagingApiClient({
    channelAccessToken: token,
  });

  try {
    const profile = await client.getProfile(userId);
    const result = {
      displayName: profile.displayName,
      pictureUrl: profile.pictureUrl,
    };

    // Cache the result
    userProfileCache.set(userId, {
      ...result,
      fetchedAt: Date.now(),
    });

    return result;
  } catch (err) {
    logVerbose(`line: failed to fetch profile for ${userId}: ${String(err)}`);
    return null;
  }
}

/**
 * Get user's display name (with fallback to userId)
 */
export async function getUserDisplayName(
  userId: string,
  opts: { channelAccessToken?: string; accountId?: string } = {},
): Promise<string> {
  const profile = await getUserProfile(userId, opts);
  return profile?.displayName ?? userId;
}
