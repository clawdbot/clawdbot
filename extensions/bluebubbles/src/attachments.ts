import crypto from "node:crypto";
import type { ClawdbotConfig } from "clawdbot/plugin-sdk";
import { resolveBlueBubblesAccount } from "./accounts.js";
import { resolveChatGuidForTarget } from "./send.js";
import { parseBlueBubblesTarget, normalizeBlueBubblesHandle } from "./targets.js";
import {
  blueBubblesFetchWithTimeout,
  buildBlueBubblesApiUrl,
  type BlueBubblesAttachment,
  type BlueBubblesSendTarget,
} from "./types.js";

export type BlueBubblesAttachmentOpts = {
  serverUrl?: string;
  password?: string;
  accountId?: string;
  timeoutMs?: number;
  cfg?: ClawdbotConfig;
};

const DEFAULT_ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

function resolveAccount(params: BlueBubblesAttachmentOpts) {
  const account = resolveBlueBubblesAccount({
    cfg: params.cfg ?? {},
    accountId: params.accountId,
  });
  const baseUrl = params.serverUrl?.trim() || account.config.serverUrl?.trim();
  const password = params.password?.trim() || account.config.password?.trim();
  if (!baseUrl) throw new Error("BlueBubbles serverUrl is required");
  if (!password) throw new Error("BlueBubbles password is required");
  return { baseUrl, password };
}

export async function downloadBlueBubblesAttachment(
  attachment: BlueBubblesAttachment,
  opts: BlueBubblesAttachmentOpts & { maxBytes?: number } = {},
): Promise<{ buffer: Uint8Array; contentType?: string }> {
  const guid = attachment.guid?.trim();
  if (!guid) throw new Error("BlueBubbles attachment guid is required");
  const { baseUrl, password } = resolveAccount(opts);
  const url = buildBlueBubblesApiUrl({
    baseUrl,
    path: `/api/v1/attachment/${encodeURIComponent(guid)}/download`,
    password,
  });
  const res = await blueBubblesFetchWithTimeout(url, { method: "GET" }, opts.timeoutMs);
  if (!res.ok) {
    const errorText = await res.text().catch(() => "");
    throw new Error(
      `BlueBubbles attachment download failed (${res.status}): ${errorText || "unknown"}`,
    );
  }
  const contentType = res.headers.get("content-type") ?? undefined;
  const buf = new Uint8Array(await res.arrayBuffer());
  const maxBytes = typeof opts.maxBytes === "number" ? opts.maxBytes : DEFAULT_ATTACHMENT_MAX_BYTES;
  if (buf.byteLength > maxBytes) {
    throw new Error(`BlueBubbles attachment too large (${buf.byteLength} bytes)`);
  }
  return { buffer: buf, contentType: contentType ?? attachment.mimeType ?? undefined };
}

export type SendBlueBubblesAttachmentResult = {
  messageId: string;
};

function resolveSendTarget(raw: string): BlueBubblesSendTarget {
  const parsed = parseBlueBubblesTarget(raw);
  if (parsed.kind === "handle") {
    return {
      kind: "handle",
      address: normalizeBlueBubblesHandle(parsed.to),
      service: parsed.service,
    };
  }
  if (parsed.kind === "chat_id") {
    return { kind: "chat_id", chatId: parsed.chatId };
  }
  if (parsed.kind === "chat_guid") {
    return { kind: "chat_guid", chatGuid: parsed.chatGuid };
  }
  return { kind: "chat_identifier", chatIdentifier: parsed.chatIdentifier };
}

function extractMessageId(payload: unknown): string {
  if (!payload || typeof payload !== "object") return "unknown";
  const record = payload as Record<string, unknown>;
  const data = record.data && typeof record.data === "object" ? (record.data as Record<string, unknown>) : null;
  const candidates = [
    record.messageId,
    record.guid,
    record.id,
    data?.messageId,
    data?.guid,
    data?.id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
    if (typeof candidate === "number" && Number.isFinite(candidate)) return String(candidate);
  }
  return "unknown";
}

/**
 * Send an attachment via BlueBubbles API.
 * Supports sending media files (images, videos, audio, documents) to a chat.
 */
export async function sendBlueBubblesAttachment(params: {
  to: string;
  buffer: Uint8Array;
  filename: string;
  contentType?: string;
  caption?: string;
  replyToMessageGuid?: string;
  replyToPartIndex?: number;
  opts?: BlueBubblesAttachmentOpts;
}): Promise<SendBlueBubblesAttachmentResult> {
  const { to, buffer, filename, contentType, caption, replyToMessageGuid, replyToPartIndex, opts = {} } =
    params;
  const { baseUrl, password } = resolveAccount(opts);

  const target = resolveSendTarget(to);
  const chatGuid = await resolveChatGuidForTarget({
    baseUrl,
    password,
    timeoutMs: opts.timeoutMs,
    target,
  });
  if (!chatGuid) {
    throw new Error(
      "BlueBubbles attachment send failed: chatGuid not found for target. Use a chat_guid target or ensure the chat exists.",
    );
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
      encoder.encode(
        `Content-Disposition: form-data; name="${name}"; filename="${fileName}"\r\n`,
      ),
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
  addField("method", "private-api");

  const trimmedReplyTo = replyToMessageGuid?.trim();
  if (trimmedReplyTo) {
    addField("selectedMessageGuid", trimmedReplyTo);
    addField(
      "partIndex",
      typeof replyToPartIndex === "number" ? String(replyToPartIndex) : "0",
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

  // Combine all parts into a single buffer
  const totalLength = parts.reduce((acc, part) => acc + part.length, 0);
  const body = new Uint8Array(totalLength);
  let offset = 0;
  for (const part of parts) {
    body.set(part, offset);
    offset += part.length;
  }

  const res = await blueBubblesFetchWithTimeout(
    url,
    {
      method: "POST",
      headers: {
        "Content-Type": `multipart/form-data; boundary=${boundary}`,
      },
      body,
    },
    opts.timeoutMs ?? 60_000, // longer timeout for file uploads
  );

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`BlueBubbles attachment send failed (${res.status}): ${errorText || "unknown"}`);
  }

  const responseBody = await res.text();
  if (!responseBody) return { messageId: "ok" };
  try {
    const parsed = JSON.parse(responseBody) as unknown;
    return { messageId: extractMessageId(parsed) };
  } catch {
    return { messageId: "ok" };
  }
}
