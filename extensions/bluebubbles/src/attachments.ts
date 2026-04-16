import crypto from "node:crypto";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { isBlockedHostnameOrIp } from "openclaw/plugin-sdk/ssrf-runtime";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/text-runtime";
import { resolveBlueBubblesServerAccount } from "./account-resolve.js";
import { extractAttachments } from "./monitor-normalize.js";
import { assertMultipartActionOk, postMultipartFormData } from "./multipart.js";
import {
  fetchBlueBubblesServerInfo,
  getCachedBlueBubblesPrivateApiStatus,
  isBlueBubblesPrivateApiStatusEnabled,
} from "./probe.js";
import { resolveRequestUrl } from "./request-url.js";
import type { OpenClawConfig } from "./runtime-api.js";
import { getBlueBubblesRuntime, warnBlueBubbles } from "./runtime.js";
import { extractBlueBubblesMessageId, resolveBlueBubblesSendTarget } from "./send-helpers.js";
import { createChatForHandle, resolveChatGuidForTarget } from "./send.js";
import {
  blueBubblesFetchWithTimeout,
  buildBlueBubblesApiUrl,
  type BlueBubblesAttachment,
  type SsrFPolicy,
} from "./types.js";

function blueBubblesPolicy(allowPrivateNetwork: boolean | undefined): SsrFPolicy | undefined {
  // Pass `undefined` (not `{}`) for the non-private case so the non-SSRF fallback path
  // is used. An empty `{}` policy routes through the SSRF guard, which blocks the
  // localhost BB deployments that are the most common self-hosted setup. The opt-in
  // private-network branch keeps the explicit policy. (#64105, #67510)
  return allowPrivateNetwork ? { allowPrivateNetwork: true } : undefined;
}

export type BlueBubblesAttachmentOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: OpenClawConfig;
};

const DEFAULT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;
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

function resolveAccount(params: BlueBubblesAttachmentOpts) {
  return resolveBlueBubblesServerAccount(params);
}

function safeExtractHostname(url: string): string | undefined {
  try {
    const hostname = new URL(url).hostname.trim();
    return hostname || undefined;
  } catch {
    return undefined;
  }
}

type MediaFetchErrorCode = "max_bytes" | "http_error" | "fetch_failed";

function readMediaFetchErrorCode(error: unknown): MediaFetchErrorCode | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }
  const code = (error as { code?: unknown }).code;
  return code === "max_bytes" || code === "http_error" || code === "fetch_failed"
    ? code
    : undefined;
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
  const url = buildBlueBubblesApiUrl({
    baseUrl: opts.baseUrl,
    path: `/api/v1/message/${encodeURIComponent(messageGuid)}`,
    password: opts.password,
  });
  // Pass undefined (not {}) when private network is not opted-in so the
  // non-SSRF fallback path is used — an empty {} triggers the SSRF-guarded
  // path which blocks localhost BB servers by default. (#64105)
  const policy: SsrFPolicy | undefined = opts.allowPrivateNetwork
    ? { allowPrivateNetwork: true }
    : undefined;
  const response = await blueBubblesFetchWithTimeout(
    url,
    { method: "GET" },
    opts.timeoutMs,
    policy,
  );
  if (!response.ok) {
    return [];
  }
  const json = (await response.json()) as Record<string, unknown>;
  const data = json.data as Record<string, unknown> | undefined;
  if (!data) {
    return [];
  }
  return extractAttachments(data);
}

export async function downloadBlueBubblesAttachment(
  attachment: BlueBubblesAttachment,
  opts: BlueBubblesAttachmentOpts & { maxBytes?: number } = {},
): Promise<{ buffer: Uint8Array; contentType?: string }> {
  const guid = attachment.guid?.trim();
  if (!guid) {
    throw new Error("BlueBubbles attachment guid is required");
  }
  const { baseUrl, password, allowPrivateNetwork, allowPrivateNetworkConfig } =
    resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/attachment/${encodeURIComponent(guid)}/download`,
    password,
  });
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : DEFAULT_ATTACHMENT_MAX_BYTES;
  const trustedHostname = safeExtractHostname(baseUrl);
  const trustedHostnameIsPrivate = trustedHostname ? isBlockedHostnameOrIp(trustedHostname) : false;
  try {
    const fetched = await getBlueBubblesRuntime().channel.media.fetchRemoteMedia({
      url,
      filePathHint: attachment.transferName ?? attachment.guid ?? "attachment",
      maxBytes,
      ssrfPolicy: allowPrivateNetwork
        ? { allowPrivateNetwork: true }
        : trustedHostname && (allowPrivateNetworkConfig !== false || !trustedHostnameIsPrivate)
          ? { allowedHostnames: [trustedHostname] }
          : undefined,
      fetchImpl: async (input, init) =>
        await blueBubblesFetchWithTimeout(
          resolveRequestUrl(input),
          { ...init, method: init?.method ?? "GET" },
          opts.timeoutMs,
        ),
    });
    return {
      buffer: new Uint8Array(fetched.buffer),
      contentType: fetched.contentType ?? attachment.mimeType ?? undefined,
    };
  } catch (error) {
    if (readMediaFetchErrorCode(error) === "max_bytes") {
      throw new Error(`BlueBubbles attachment too large (limit ${maxBytes} bytes)`, {
        cause: error,
      });
    }
    const text = formatErrorMessage(error);
    throw new Error(`BlueBubbles attachment download failed: ${text}`, { cause: error });
  }
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
  const { baseUrl, password, accountId, allowPrivateNetwork } = resolveAccount(opts);
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

  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: "/api/v1/message/attachment",
    password,
  });

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

  const res = await postMultipartFormData({
    url,
    boundary,
    parts,
    timeoutMs: opts.timeoutMs ?? 60_000, // longer timeout for file uploads
    ssrfPolicy: blueBubblesPolicy(allowPrivateNetwork),
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
