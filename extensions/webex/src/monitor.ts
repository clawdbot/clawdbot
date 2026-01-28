/**
 * Webex webhook monitor
 *
 * Handles incoming webhook requests from Webex and processes messages.
 * Key points:
 * - Webex webhooks only send message ID, we must fetch full message via API
 * - Signature verification uses HMAC-SHA1 via X-Spark-Signature header
 * - Bot mentions are tracked via mentionedPeople array
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { downloadWebexFile, getWebexMessage, sendWebexMessage } from "./api.js";
import { verifyWebexWebhookSignature } from "./auth.js";
import { getWebexRuntime } from "./runtime.js";
import { normalizeAllowFromEntry } from "./targets.js";
import type { MoltbotConfig } from "clawdbot/plugin-sdk";
import type { ResolvedWebexAccount, WebexMessage, WebexWebhookEvent } from "./types.js";

/** Registry of webhook targets */
type WebhookTarget = {
  path: string;
  accountId: string;
  account: ResolvedWebexAccount;
  config: MoltbotConfig;
  abortSignal?: AbortSignal;
  statusSink?: (patch: Record<string, unknown>) => void;
};

const webhookTargets = new Map<string, WebhookTarget[]>();

/**
 * Normalize webhook path for comparison
 */
function normalizeWebhookPath(path: string): string {
  let normalized = path.trim().toLowerCase();
  if (!normalized.startsWith("/")) {
    normalized = "/" + normalized;
  }
  // Remove trailing slash
  if (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Register a webhook target for an account
 */
export function registerWebexWebhookTarget(target: WebhookTarget): () => void {
  const key = normalizeWebhookPath(target.path);
  const existing = webhookTargets.get(key) ?? [];
  webhookTargets.set(key, [...existing, { ...target, path: key }]);

  return () => {
    const current = webhookTargets.get(key);
    if (current) {
      const filtered = current.filter(
        (t) => t.accountId !== target.accountId || t.path !== key,
      );
      if (filtered.length === 0) {
        webhookTargets.delete(key);
      } else {
        webhookTargets.set(key, filtered);
      }
    }
  };
}

/**
 * Read request body as string
 */
async function readBody(req: IncomingMessage, maxBytes = 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });

    req.on("end", () => {
      resolve(Buffer.concat(chunks).toString("utf8"));
    });

    req.on("error", reject);
  });
}

/**
 * Handle an incoming Webex webhook request
 *
 * @returns true if the request was handled, false if it should be passed to other handlers
 */
export async function handleWebexWebhookRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<boolean> {
  // Only handle POST requests
  if (req.method !== "POST") {
    return false;
  }

  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = normalizeWebhookPath(url.pathname);

  // Check if we have any targets for this path
  const targets = webhookTargets.get(path);
  if (!targets || targets.length === 0) {
    return false;
  }

  // Read and parse body
  let rawBody: string;
  let event: WebexWebhookEvent;

  try {
    rawBody = await readBody(req);
    event = JSON.parse(rawBody) as WebexWebhookEvent;
  } catch (err) {
    res.statusCode = 400;
    res.end("Invalid request body");
    return true;
  }

  // Get signature header
  const signature = req.headers["x-spark-signature"] as string | undefined;

  // Find matching target by verifying signature
  let matchedTarget: WebhookTarget | undefined;

  for (const target of targets) {
    const secret = target.account.config.webhookSecret;
    if (!secret) {
      // No secret configured, accept without verification (not recommended)
      matchedTarget = target;
      break;
    }

    if (verifyWebexWebhookSignature(rawBody, signature, secret)) {
      matchedTarget = target;
      break;
    }
  }

  if (!matchedTarget) {
    // Signature verification failed
    res.statusCode = 401;
    res.end("Unauthorized");
    return true;
  }

  // Respond immediately (Webex expects fast response)
  res.statusCode = 200;
  res.end();

  // Process event asynchronously
  void processWebexEvent(event, matchedTarget).catch((err) => {
    console.error("[webex] Error processing event", err);
  });

  return true;
}

/**
 * Process a Webex webhook event
 */
async function processWebexEvent(event: WebexWebhookEvent, target: WebhookTarget): Promise<void> {
  const runtime = getWebexRuntime();
  const { account, config, statusSink } = target;
  const core = runtime;

  // Only handle message creation events
  if (event.resource !== "messages" || event.event !== "created") {
    return;
  }

  // Update status
  statusSink?.({ lastInboundAt: Date.now() });

  // Fetch full message (webhook only contains ID)
  let message: WebexMessage;
  try {
    message = await getWebexMessage(account, event.data.id);
  } catch (err) {
    console.error("[webex] Failed to fetch message", event.data.id, err);
    return;
  }

  // Skip bot's own messages
  const botId = account.botId;
  if (botId && message.personId === botId) {
    return;
  }

  // Determine if this is a DM or group room
  const isGroup = message.roomType === "group";
  const roomId = message.roomId;

  // Check if bot was mentioned
  const wasMentioned = botId ? message.mentionedPeople?.includes(botId) ?? false : false;

  // Get sender info
  const senderId = message.personId;
  const senderEmail = message.personEmail;

  // Resolve routing
  const route = await resolveWebexRoute({
    account,
    config,
    isGroup,
    roomId,
    senderId,
    senderEmail,
    wasMentioned,
    core,
  });

  if (!route.allowed) {
    // Message blocked by policy - debug only
    return;
  }

  // Process media if present
  let mediaPath: string | undefined;
  let mediaType: string | undefined;

  if (message.files && message.files.length > 0) {
    try {
      const mediaMaxMb = 50; // 50MB limit
      const file = await downloadWebexFile(account, message.files[0], mediaMaxMb * 1024 * 1024);
      // Save to temp storage
      const tempPath = await core.storage.writeTempFile(file.buffer, {
        extension: getExtensionFromContentType(file.contentType),
        prefix: "webex-",
      });
      mediaPath = tempPath;
      mediaType = file.contentType;
    } catch (err) {
      console.warn("[webex] Failed to download media", err);
    }
  }

  // Build message body
  const rawBody = message.text ?? "";
  let body = rawBody;

  // Format envelope
  const senderName = senderEmail ?? formatSenderId(senderId);
  const envelope = core.channel.reply.formatAgentEnvelope({
    senderName,
    timestamp: message.created,
  });

  if (envelope) {
    body = envelope + body;
  }

  // Build context payload
  const ctxPayload = core.channel.reply.finalizeInboundContext({
    Body: body,
    RawBody: rawBody,
    CommandBody: rawBody,
    From: `webex:${senderId}`,
    To: `webex:${roomId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: isGroup ? "channel" : "direct",
    ConversationLabel: senderName,
    SenderName: senderName,
    SenderId: senderId,
    SenderUsername: senderEmail,
    WasMentioned: isGroup ? wasMentioned : undefined,
    MessageSid: message.id,
    MessageSidFull: message.id,
    ReplyToId: message.parentId,
    ReplyToIdFull: message.parentId,
    MediaPath: mediaPath,
    MediaUrl: mediaPath,
    MediaType: mediaType,
    GroupSpace: isGroup ? roomId : undefined,
    GroupSystemPrompt: route.groupSystemPrompt,
    OriginatingChannel: "webex",
    OriginatingTo: `webex:${roomId}`,
  });

  // Dispatch to message pipeline
  console.log("[webex] calling dispatchReplyWithBufferedBlockDispatcher");
  const dispatchResult = await core.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg: config,
    dispatcherOptions: {
      deliver: async (payload) => {
        await deliverWebexReply({
          payload,
          account,
          roomId,
          runtime: core,
          config,
          statusSink,
          parentId: message.parentId,
        });
      },
      onError: (err, info) => {
        console.error(`[webex] ${info.kind} reply failed:`, err);
      },
    },
  });
  console.log("[webex] dispatchReplyWithBufferedBlockDispatcher result:", dispatchResult);
}

/**
 * Route resolution result
 */
type WebexRouteResult = {
  allowed: boolean;
  reason?: string;
  sessionKey: string;
  accountId: string;
  groupSystemPrompt?: string;
};

/**
 * Resolve routing and policy for a message
 */
async function resolveWebexRoute(params: {
  account: ResolvedWebexAccount;
  config: MoltbotConfig;
  isGroup: boolean;
  roomId: string;
  senderId: string;
  senderEmail?: string;
  wasMentioned: boolean;
  core: ReturnType<typeof getWebexRuntime>;
}): Promise<WebexRouteResult> {
  const { account, config, isGroup, roomId, senderId, senderEmail, wasMentioned, core } = params;
  const accountId = account.accountId;

  if (isGroup) {
    // Group message routing
    const groupPolicy = account.config.groupPolicy ?? "allowlist";

    if (groupPolicy === "disabled") {
      return { allowed: false, reason: "groupPolicy=disabled", sessionKey: "", accountId };
    }

    const roomConfig = account.config.rooms?.[roomId];

    if (groupPolicy === "allowlist") {
      if (!roomConfig?.allow) {
        return { allowed: false, reason: "room not in allowlist", sessionKey: "", accountId };
      }
    }

    // Check mention requirement
    const requireMention = roomConfig?.requireMention ?? true;
    if (requireMention && !wasMentioned) {
      return { allowed: false, reason: "mention required but not mentioned", sessionKey: "", accountId };
    }

    // Check user allowlist for room
    if (roomConfig?.users && roomConfig.users.length > 0) {
      const normalizedSender = normalizeAllowFromEntry(senderId);
      const normalizedEmail = senderEmail ? normalizeAllowFromEntry(senderEmail) : undefined;
      const allowed = roomConfig.users.some((u) => {
        const normalized = normalizeAllowFromEntry(u);
        return normalized === normalizedSender || (normalizedEmail && normalized === normalizedEmail);
      });
      if (!allowed) {
        return { allowed: false, reason: "user not in room allowlist", sessionKey: "", accountId };
      }
    }

    const sessionKey = `webex:${accountId}:room:${roomId}`;
    return {
      allowed: true,
      sessionKey,
      accountId,
      groupSystemPrompt: roomConfig?.systemPrompt,
    };
  } else {
    // DM routing
    const dmPolicy = account.config.dm?.policy ?? "pairing";

    if (dmPolicy === "disabled") {
      return { allowed: false, reason: "dm.policy=disabled", sessionKey: "", accountId };
    }

    const allowFrom = account.config.dm?.allowFrom ?? [];
    const normalizedSender = normalizeAllowFromEntry(senderId);
    const normalizedEmail = senderEmail ? normalizeAllowFromEntry(senderEmail) : undefined;

    const isInAllowlist = allowFrom.some((entry) => {
      const normalized = normalizeAllowFromEntry(entry);
      return normalized === normalizedSender || (normalizedEmail && normalized === normalizedEmail);
    });

    if (dmPolicy === "allowlist" && !isInAllowlist) {
      return { allowed: false, reason: "sender not in dm.allowFrom", sessionKey: "", accountId };
    }

    if (dmPolicy === "pairing" && !isInAllowlist) {
      // Check pairing status
      const pairingKey = senderEmail ?? senderId;
      const isPaired = await core.pairing.isPaired("webex", pairingKey);
      if (!isPaired) {
        // Send pairing request
        await core.pairing.requestPairing("webex", pairingKey, {
          displayName: senderEmail ?? formatSenderId(senderId),
        });
        return { allowed: false, reason: "pairing required", sessionKey: "", accountId };
      }
    }

    const sessionKey = `webex:${accountId}:dm:${senderId}`;
    return {
      allowed: true,
      sessionKey,
      accountId,
    };
  }
}

/**
 * Deliver a reply to Webex
 */
async function deliverWebexReply(params: {
  payload: { text?: string; mediaUrls?: string[]; mediaUrl?: string };
  account: ResolvedWebexAccount;
  roomId: string;
  runtime: ReturnType<typeof getWebexRuntime>;
  config: MoltbotConfig;
  statusSink?: (patch: Record<string, unknown>) => void;
  parentId?: string;
}): Promise<void> {
  const { payload, account, roomId, runtime, statusSink, parentId } = params;

  console.log("[webex] deliverWebexReply called", {
    roomId,
    hasText: !!payload.text,
    textLength: payload.text?.length,
    mediaUrls: payload.mediaUrls?.length ?? 0,
  });

  // Send text message
  if (payload.text) {
    console.log("[webex] sending text message to room", roomId);
    try {
      const result = await sendWebexMessage(account, {
        roomId,
        markdown: payload.text,
        parentId,
      });
      console.log("[webex] message sent successfully", { messageId: result.id });
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      console.error("[webex] failed to send message", err);
      throw err;
    }
  }

  // Send media
  const mediaUrls = payload.mediaUrls ?? (payload.mediaUrl ? [payload.mediaUrl] : []);
  for (const mediaUrl of mediaUrls) {
    try {
      // Webex supports sending files via URL
      await sendWebexMessage(account, {
        roomId,
        files: [mediaUrl],
        parentId,
      });
      statusSink?.({ lastOutboundAt: Date.now() });
    } catch (err) {
      console.warn("[webex] Failed to send media", mediaUrl, err);
    }
  }
}

/**
 * Start the Webex webhook monitor for an account
 */
export async function startWebexMonitor(params: {
  account: ResolvedWebexAccount;
  config: MoltbotConfig;
  runtime: ReturnType<typeof getWebexRuntime>;
  abortSignal?: AbortSignal;
  webhookPath?: string;
  webhookUrl?: string;
  statusSink?: (patch: Record<string, unknown>) => void;
}): Promise<() => void> {
  const { account, config, runtime, abortSignal, statusSink } = params;
  const webhookPath = params.webhookPath ?? account.config.webhookPath ?? "/webex";

  console.info(`[webex][${account.accountId}] Registering webhook handler at ${webhookPath}`);

  const unregister = registerWebexWebhookTarget({
    path: webhookPath,
    accountId: account.accountId,
    account,
    config,
    abortSignal,
    statusSink,
  });

  return unregister;
}

/**
 * Get file extension from content type
 */
function getExtensionFromContentType(contentType?: string): string {
  if (!contentType) return "bin";
  const map: Record<string, string> = {
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/quicktime": "mov",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "application/pdf": "pdf",
    "text/plain": "txt",
  };
  return map[contentType.split(";")[0]] ?? "bin";
}

/**
 * Format sender ID for display
 */
function formatSenderId(senderId: string): string {
  // Truncate long IDs
  if (senderId.length > 20) {
    return `${senderId.slice(0, 8)}...${senderId.slice(-4)}`;
  }
  return senderId;
}
