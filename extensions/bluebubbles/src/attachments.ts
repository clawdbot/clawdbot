import crypto from "node:crypto";
import path from "node:path";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import {
  createBlueBubblesClient,
  createBlueBubblesClientFromParts,
  type BlueBubblesClient,
} from "./client.js";
import { assertMultipartActionOk } from "./multipart.js";
import {
  fetchBlueBubblesServerInfo,
  getCachedBlueBubblesPrivateApiStatus,
  isBlueBubblesPrivateApiStatusEnabled,
} from "./probe.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { warnBlueBubbles } from "./runtime.js";
import { extractBlueBubblesMessageId, resolveBlueBubblesSendTarget } from "./send-helpers.js";
import { createChatForHandle, resolveChatGuidForTarget } from "./send.js";
import { type BlueBubblesAttachment } from "./types.js";

export type BlueBubblesAttachmentOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
};

const AUDIO_MIME_MP3 = new Set(["audio/mpeg", "audio/mp3"]);
const AUDIO_MIME_CAF = new Set(["audio/x-caf", "audio/caf"]);

function sanitizeFilename(input: string | undefined, fallback: string): string {
  const trimmed = input?.trim() ?? "";
  const base = trimmed ? path.basename(trimmed) : "";
  const name = base || fallback;
  // Strip characters that could enable multipart header injection (CWE-93)
  return name.replace(/[\r\n"\\]/g, "_");
}

function ensureExtension(filename: string, extension: string, fallbackBase: string): string {
  const currentExt = path.extname(filename);
  if (normalizeLowercaseStringOrEmpty(currentExt) === extension) {
    return filename;
  }
  const base = currentExt ? filename.slice(0, -currentExt.length) : filename;
  return `${base || fallbackBase}${extension}`;
}

function resolveVoiceInfo(filename: string, contentType?: string) {
  const normalizedType = normalizeOptionalLowercaseString(contentType);
  const extension = normalizeLowercaseStringOrEmpty(path.extname(filename));
  const isMp3 =
    extension === ".mp3" || (normalizedType ? AUDIO_MIME_MP3.has(normalizedType) : false);
  const isCaf =
    extension === ".caf" || (normalizedType ? AUDIO_MIME_CAF.has(normalizedType) : false);
  const isAudio = isMp3 || isCaf || Boolean(normalizedType?.startsWith("audio/"));
  return { isAudio, isMp3, isCaf };
}

function clientFromOpts(params: BlueBubblesAttachmentOpts): BlueBubblesClient {
  return createBlueBubblesClient(params);
}

function resolveAccount(params: BlueBubblesAttachmentOpts) {
  return resolveBlueBubblesServerAccount(params);
}

/**
 * Fetch attachment metadata for a message from the BlueBubbles API.
 *
 * BlueBubbles sometimes fires the `new-message` webhook before attachment
 * indexing is complete, so `attachments` arrives as `[]`. This function
 * GETs the message by GUID and returns whatever attachments the server
 * has indexed by now. (#65430, #67437)
 */
export async function fetchBlueBubblesMessageAttachments(
  messageGuid: string,
  opts: {
    baseUrl: string;
    password: string;
    timeoutMs?: number;
    allowPrivateNetwork?: boolean;
  },
): Promise<BlueBubblesAttachment[]> {
  const client = createBlueBubblesClientFromParts({
    baseUrl: opts.baseUrl,
    password: opts.password,
    allowPrivateNetwork: opts.allowPrivateNetwork === true,
    timeoutMs: opts.timeoutMs,
  });
  return await client.getMessageAttachments({ messageGuid, timeoutMs: opts.timeoutMs });
}

export async function downloadBlueBubblesAttachment(
  attachment: BlueBubblesAttachment,
  opts: BlueBubblesAttachmentOpts & { maxBytes?: number } = {},
): Promise<{ buffer: Uint8Array; contentType?: string }> {
  const client = clientFromOpts(opts);
  // client.downloadAttachment threads this.ssrfPolicy to BOTH fetchRemoteMedia
  // and the fetchImpl callback — closing the gap in #34749 where the legacy
  // helper silently omitted the policy on the callback path.
  return await client.downloadAttachment({
    attachment,
    maxBytes: opts.maxBytes,
    timeoutMs: opts.timeoutMs,
  });
}

export type SendBlueBubblesAttachmentResult = {
  messageId: string;
};

/**
 * Send an attachment via BlueBubbles API.
 * Supports sending media files (images, videos, audio, documents) to a chat.
 * When asVoice is true, expects MP3/CAF audio and marks it as an iMessage voice memo.
 */
export async function sendBlueBubblesAttachment(params: {
  to: string;
  buffer: Uint8Array;
  filename: string;
  contentType?: string;
  caption?: string;
  replyToMessageGuid?: string;
  replyToPartIndex?: number;
  asVoice?: boolean;
  opts?: BlueBubblesAttachmentOpts;
}): Promise<SendBlueBubblesAttachmentResult> {
  const { to, caption, replyToMessageGuid, replyToPartIndex, asVoice, opts = {} } = params;
  let { buffer, filename, contentType } = params;
  const wantsVoice = asVoice === true;
  const fallbackName = wantsVoice ? "Audio Message" : "attachment";
  filename = sanitizeFilename(filename, fallbackName);
  contentType = normalizeOptionalString(contentType);
  // Resolve account tuple for helpers that still need baseUrl/password
  // (createChatForHandle, resolveChatGuidForTarget, fetchBlueBubblesServerInfo).
  // These migrate to the client in subsequent passes. For this callsite, the
  // client owns the actual attachment POST; the resolved tuple stays alongside
  // so chat-guid resolution and Private API probe continue to work.
  const { baseUrl, password, accountId, allowPrivateNetwork } = resolveAccount(opts);
  const client = createBlueBubblesClient(opts);
  let privateApiStatus = getCachedBlueBubblesPrivateApiStatus(accountId);

  // Lazy refresh: when the cache has expired and Private API features are needed,
  // fetch server info before making the decision. This prevents silent degradation
  // of reply threading after the 10-minute cache TTL expires. (#43764)
  const wantsReplyThread = Boolean(replyToMessageGuid?.trim());
  if (privateApiStatus === null && wantsReplyThread) {
    try {
      await fetchBlueBubblesServerInfo({
        baseUrl,
        password,
        accountId,
        timeoutMs: opts.timeoutMs ?? 5000,
        allowPrivateNetwork,
      });
      privateApiStatus = getCachedBlueBubblesPrivateApiStatus(accountId);
    } catch {
      // Refresh failed — proceed with null status (existing graceful degradation)
    }
  }

  const privateApiEnabled = isBlueBubblesPrivateApiStatusEnabled(privateApiStatus);

  // Validate voice memo format when requested (BlueBubbles converts MP3 -> CAF when isAudioMessage).
  const isAudioMessage = wantsVoice;
  if (isAudioMessage) {
    const voiceInfo = resolveVoiceInfo(filename, contentType);
    if (!voiceInfo.isAudio) {
      throw new Error("BlueBubbles voice messages require audio media (mp3 or caf).");
    }
    if (voiceInfo.isMp3) {
      filename = ensureExtension(filename, ".mp3", fallbackName);
      contentType = contentType ?? "audio/mpeg";
    } else if (voiceInfo.isCaf) {
      filename = ensureExtension(filename, ".caf", fallbackName);
      contentType = contentType ?? "audio/x-caf";
    } else {
      throw new Error(
        "BlueBubbles voice messages require mp3 or caf audio (convert before sending).",
      );
    }
  }

  const target = resolveBlueBubblesSendTarget(to);
  let chatGuid = await resolveChatGuidForTarget({
    baseUrl,
    password,
    timeoutMs: opts.timeoutMs,
    target,
    allowPrivateNetwork,
  });
  if (!chatGuid) {
    // For handle targets (phone numbers/emails), auto-create a new DM chat
    if (target.kind === "handle") {
      const created = await createChatForHandle({
        baseUrl,
        password,
        address: target.address,
        timeoutMs: opts.timeoutMs,
        allowPrivateNetwork,
      });
      chatGuid = created.chatGuid;
      // If we still don't have a chatGuid, try resolving again (chat was created server-side)
      if (!chatGuid) {
        chatGuid = await resolveChatGuidForTarget({
          baseUrl,
          password,
          timeoutMs: opts.timeoutMs,
          target,
          allowPrivateNetwork,
        });
      }
    }
    if (!chatGuid) {
      throw new Error(
        "BlueBubbles attachment send failed: chatGuid not found for target. Use a chat_guid target or ensure the chat exists.",
      );
    }
  }

  // Build FormData with the attachment
  const boundary = `----BlueBubblesFormBoundary${crypto.randomUUID().replace(/-/g, "")}`;
  const parts: Uint8Array[] = [];
  const encoder = new TextEncoder();

  // Helper to add a form field
  const addField = (name: string, value: string) => {
    parts.push(encoder.encode(`--${boundary}\r\n`));
    parts.push(encoder.encode(`Content-Disposition: form-data; name="${name}"\r\n\r\n`));
    parts.push(encoder.encode(`${value}\r\n`));
  };

  // Helper to add a file field
  const addFile = (name: string, fileBuffer: Uint8Array, fileName: string, mimeType?: string) => {
    parts.push(encoder.encode(`--${boundary}\r\n`));
    parts.push(
      encoder.encode(`Content-Disposition: form-data; name="${name}"; filename="${fileName}"\r\n`),
    );
    parts.push(encoder.encode(`Content-Type: ${mimeType ?? "application/octet-stream"}\r\n\r\n`));
    parts.push(fileBuffer);
    parts.push(encoder.encode("\r\n"));
  };

  // Add required fields
  addFile("attachment", buffer, filename, contentType);
  addField("chatGuid", chatGuid);
  addField("name", filename);
  addField("tempGuid", `temp-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`);
  if (privateApiEnabled) {
    addField("method", "private-api");
  }

  // Add isAudioMessage flag for voice memos
  if (isAudioMessage) {
    addField("isAudioMessage", "true");
  }

  const trimmedReplyTo = replyToMessageGuid?.trim();
  if (trimmedReplyTo && privateApiEnabled) {
    addField("selectedMessageGuid", trimmedReplyTo);
    addField("partIndex", typeof replyToPartIndex === "number" ? String(replyToPartIndex) : "0");
  } else if (trimmedReplyTo && privateApiStatus === null) {
    warnBlueBubbles(
      "Private API status unknown; sending attachment without reply threading metadata. Run a status probe to restore private-api reply features.",
    );
  }

  // Add optional caption
  if (caption) {
    addField("message", caption);
    addField("text", caption);
    addField("caption", caption);
  }

  // Close the multipart body
  parts.push(encoder.encode(`--${boundary}--\r\n`));

  const res = await client.requestMultipart({
    path: "/api/v1/message/attachment",
    boundary,
    parts,
    timeoutMs: opts.timeoutMs ?? 60_000, // longer timeout for file uploads
  });

  await assertMultipartActionOk(res, "attachment send");

  const responseBody = await res.text();
  if (!responseBody) {
    return { messageId: "ok" };
  }
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    return { messageId: extractBlueBubblesMessageId(parsed) };
  } catch {
    return { messageId: "ok" };
  }
}
