import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import type * as Lark from "@larksuiteoapi/node-sdk";
import { mediaKindFromMime } from "openclaw/plugin-sdk/media-runtime";
import { withTempDownloadPath } from "openclaw/plugin-sdk/temp-path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import type { ClawdbotConfig } from "../runtime-api.js";
import { resolveFeishuRuntimeAccount } from "./accounts.js";
import { createFeishuClient } from "./client.js";
import { normalizeFeishuExternalKey } from "./external-keys.js";
import { getFeishuRuntime } from "./runtime.js";
import { assertFeishuMessageApiSuccess, toFeishuSendResult } from "./send-result.js";
import { resolveFeishuSendTarget } from "./send-target.js";

const FEISHU_MEDIA_HTTP_TIMEOUT_MS = 120_000;

export type DownloadImageResult = {
  buffer: Buffer;
  contentType?: string;
};

export type DownloadMessageResourceResult = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

function createConfiguredFeishuMediaClient(params: { cfg: ClawdbotConfig; accountId?: string }): {
  account: ReturnType<typeof resolveFeishuRuntimeAccount>;
  client: ReturnType<typeof createFeishuClient>;
} {
  const account = resolveFeishuRuntimeAccount({ cfg: params.cfg, accountId: params.accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }

  return {
    account,
    client: createFeishuClient({
      ...account,
      httpTimeoutMs: FEISHU_MEDIA_HTTP_TIMEOUT_MS,
    }),
  };
}

type FeishuUploadResponse =
  | Awaited<ReturnType<Lark.Client["im"]["image"]["create"]>>
  | Awaited<ReturnType<Lark.Client["im"]["file"]["create"]>>;

type FeishuDownloadResponse =
  | Awaited<ReturnType<Lark.Client["im"]["image"]["get"]>>
  | Awaited<ReturnType<Lark.Client["im"]["file"]["get"]>>
  | Awaited<ReturnType<Lark.Client["im"]["messageResource"]["get"]>>;

type FeishuHeaderMap = Record<string, string | string[]>;

function asHeaderMap(value: object | undefined): FeishuHeaderMap | undefined {
  if (!value) {
    return undefined;
  }
  const entries = Object.entries(value);
  if (entries.every(([, entry]) => typeof entry === "string" || Array.isArray(entry))) {
    return Object.fromEntries(entries) as FeishuHeaderMap;
  }
  return undefined;
}

function extractFeishuUploadKey(
  response: FeishuUploadResponse,
  params: {
    key: "image_key" | "file_key";
    errorPrefix: string;
  },
): string {
  if (!response) {
    throw new Error(`${params.errorPrefix}: empty response`);
  }

  const wrappedResponse = response as {
    image_key?: string;
    file_key?: string;
    code?: number;
    msg?: string;
    data?: Partial<Record<"image_key" | "file_key", string>>;
  };
  if (wrappedResponse.code !== undefined && wrappedResponse.code !== 0) {
    throw new Error(
      `${params.errorPrefix}: ${wrappedResponse.msg || `code ${wrappedResponse.code}`}`,
    );
  }

  const key =
    params.key === "image_key"
      ? (wrappedResponse.image_key ?? wrappedResponse.data?.image_key)
      : (wrappedResponse.file_key ?? wrappedResponse.data?.file_key);
  if (!key) {
    throw new Error(`${params.errorPrefix}: no ${params.key} returned`);
  }
  return key;
}

function readHeaderValue(
  headers: Record<string, unknown> | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (normalizeLowercaseStringOrEmpty(key) !== normalizeLowercaseStringOrEmpty(name)) {
      continue;
    }
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
    if (Array.isArray(value)) {
      const first = value.find((entry) => typeof entry === "string" && entry.trim());
      if (typeof first === "string") {
        return first.trim();
      }
    }
  }
  return undefined;
}

function decodeDispositionFileName(value: string): string | undefined {
  const utf8Match = value.match(/filename\*=UTF-8''([^;]+)/i);
  if (utf8Match?.[1]) {
    try {
      return decodeURIComponent(utf8Match[1].trim().replace(/^"(.*)"$/, "$1"));
    } catch {
      return utf8Match[1].trim().replace(/^"(.*)"$/, "$1");
    }
  }

  const plainMatch = value.match(/filename="?([^";]+)"?/i);
  return plainMatch?.[1]?.trim();
}

function extractFeishuDownloadMetadata(response: FeishuDownloadResponse): {
  contentType?: string;
  fileName?: string;
} {
  const responseWithOptionalFields = response as FeishuDownloadResponse & {
    header?: object;
    contentType?: string;
    mime_type?: string;
    data?: {
      contentType?: string;
      mime_type?: string;
      file_name?: string;
      fileName?: string;
    };
    file_name?: string;
    fileName?: string;
  };
  const headers =
    asHeaderMap(responseWithOptionalFields.headers) ??
    asHeaderMap(responseWithOptionalFields.header);

  const contentType =
    readHeaderValue(headers, "content-type") ??
    responseWithOptionalFields.contentType ??
    responseWithOptionalFields.mime_type ??
    responseWithOptionalFields.data?.contentType ??
    responseWithOptionalFields.data?.mime_type;

  const disposition = readHeaderValue(headers, "content-disposition");
  const fileName =
    (disposition ? decodeDispositionFileName(disposition) : undefined) ??
    responseWithOptionalFields.file_name ??
    responseWithOptionalFields.fileName ??
    responseWithOptionalFields.data?.file_name ??
    responseWithOptionalFields.data?.fileName;

  return { contentType, fileName };
}

async function readReadableBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

async function readFeishuResponseBuffer(params: {
  response: FeishuDownloadResponse;
  tmpDirPrefix: string;
  errorPrefix: string;
}): Promise<Buffer> {
  const { response } = params;
  if (Buffer.isBuffer(response)) {
    return response;
  }
  if (response instanceof ArrayBuffer) {
    return Buffer.from(response);
  }
  const responseWithOptionalFields = response as FeishuDownloadResponse & {
    code?: number;
    msg?: string;
    data?: Buffer | ArrayBuffer;
    [Symbol.asyncIterator]?: () => AsyncIterator<Buffer | Uint8Array | string>;
  };
  if (responseWithOptionalFields.code !== undefined && responseWithOptionalFields.code !== 0) {
    throw new Error(
      `${params.errorPrefix}: ${responseWithOptionalFields.msg || `code ${responseWithOptionalFields.code}`}`,
    );
  }

  if (responseWithOptionalFields.data && Buffer.isBuffer(responseWithOptionalFields.data)) {
    return responseWithOptionalFields.data;
  }
  if (responseWithOptionalFields.data instanceof ArrayBuffer) {
    return Buffer.from(responseWithOptionalFields.data);
  }
  if (typeof response.getReadableStream === "function") {
    return readReadableBuffer(response.getReadableStream());
  }
  if (typeof response.writeFile === "function") {
    return await withTempDownloadPath({ prefix: params.tmpDirPrefix }, async (tmpPath) => {
      await response.writeFile(tmpPath);
      return await fs.promises.readFile(tmpPath);
    });
  }
  if (responseWithOptionalFields[Symbol.asyncIterator]) {
    const asyncIterable = responseWithOptionalFields as AsyncIterable<Buffer | Uint8Array | string>;
    const chunks: Buffer[] = [];
    for await (const chunk of asyncIterable) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (response instanceof Readable) {
    return readReadableBuffer(response);
  }

  const keys = Object.keys(response as object);
  throw new Error(`${params.errorPrefix}: unexpected response format. Keys: [${keys.join(", ")}]`);
}

/**
 * Download an image from Feishu using image_key.
 * Used for downloading images sent in messages.
 */
export async function downloadImageFeishu(params: {
  cfg: ClawdbotConfig;
  imageKey: string;
  accountId?: string;
}): Promise<DownloadImageResult> {
  const { cfg, imageKey, accountId } = params;
  const normalizedImageKey = normalizeFeishuExternalKey(imageKey);
  if (!normalizedImageKey) {
    throw new Error("Feishu image download failed: invalid image_key");
  }
  const { client } = createConfiguredFeishuMediaClient({ cfg, accountId });

  const response = await client.im.image.get({
    path: { image_key: normalizedImageKey },
  });

  const buffer = await readFeishuResponseBuffer({
    response,
    tmpDirPrefix: "openclaw-feishu-img-",
    errorPrefix: "Feishu image download failed",
  });
  const meta = extractFeishuDownloadMetadata(response);
  return { buffer, contentType: meta.contentType };
}

/**
 * Download a message resource (file/image/audio/video) from Feishu.
 * Used for downloading files, audio, and video from messages.
 */
export async function downloadMessageResourceFeishu(params: {
  cfg: ClawdbotConfig;
  messageId: string;
  fileKey: string;
  type: "image" | "file";
  accountId?: string;
}): Promise<DownloadMessageResourceResult> {
  const { cfg, messageId, fileKey, type, accountId } = params;
  const normalizedFileKey = normalizeFeishuExternalKey(fileKey);
  if (!normalizedFileKey) {
    throw new Error("Feishu message resource download failed: invalid file_key");
  }
  const { client } = createConfiguredFeishuMediaClient({ cfg, accountId });

  const response = await client.im.messageResource.get({
    path: { message_id: messageId, file_key: normalizedFileKey },
    params: { type },
  });

  const buffer = await readFeishuResponseBuffer({
    response,
    tmpDirPrefix: "openclaw-feishu-resource-",
    errorPrefix: "Feishu message resource download failed",
  });
  return { buffer, ...extractFeishuDownloadMetadata(response) };
}

export type UploadImageResult = {
  imageKey: string;
};

export type UploadFileResult = {
  fileKey: string;
};

export type SendMediaResult = {
  messageId: string;
  chatId: string;
};

/**
 * Upload an image to Feishu and get an image_key for sending.
 * Supports: JPEG, PNG, WEBP, GIF, TIFF, BMP, ICO
 */
export async function uploadImageFeishu(params: {
  cfg: ClawdbotConfig;
  image: Buffer | string; // Buffer or file path
  imageType?: "message" | "avatar";
  accountId?: string;
}): Promise<UploadImageResult> {
  const { cfg, image, imageType = "message", accountId } = params;
  const { client } = createConfiguredFeishuMediaClient({ cfg, accountId });

  // SDK accepts Buffer directly or fs.ReadStream for file paths
  // Using Readable.from(buffer) causes issues with form-data library
  // See: https://github.com/larksuite/node-sdk/issues/121
  const imageData = typeof image === "string" ? fs.createReadStream(image) : image;

  const response = await client.im.image.create({
    data: {
      image_type: imageType,
      image: imageData,
    },
  });

  return {
    imageKey: extractFeishuUploadKey(response, {
      key: "image_key",
      errorPrefix: "Feishu image upload failed",
    }),
  };
}

/**
 * Sanitize a filename for safe use in Feishu multipart/form-data uploads.
 * Strips control characters and multipart-injection vectors (CWE-93) while
 * preserving the original UTF-8 display name (Chinese, emoji, etc.).
 *
 * Previous versions percent-encoded non-ASCII characters, but the Feishu
 * `im.file.create` API uses `file_name` as a literal display name — it does
 * NOT decode percent-encoding — so encoded filenames appeared as garbled text
 * in chat (regression in v2026.3.2).
 */
export function sanitizeFileNameForUpload(fileName: string): string {
  return fileName.replace(/[\p{Cc}"\\]/gu, "_");
}

/**
 * Upload a file to Feishu and get a file_key for sending.
 * Max file size: 30MB
 */
export async function uploadFileFeishu(params: {
  cfg: ClawdbotConfig;
  file: Buffer | string; // Buffer or file path
  fileName: string;
  fileType: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
  duration?: number; // Required for audio/video files, in milliseconds
  accountId?: string;
}): Promise<UploadFileResult> {
  const { cfg, file, fileName, fileType, duration, accountId } = params;
  const { client } = createConfiguredFeishuMediaClient({ cfg, accountId });

  // SDK accepts Buffer directly or fs.ReadStream for file paths
  // Using Readable.from(buffer) causes issues with form-data library
  // See: https://github.com/larksuite/node-sdk/issues/121
  const fileData = typeof file === "string" ? fs.createReadStream(file) : file;

  const safeFileName = sanitizeFileNameForUpload(fileName);

  const response = await client.im.file.create({
    data: {
      file_type: fileType,
      file_name: safeFileName,
      file: fileData,
      ...(duration !== undefined && { duration }),
    },
  });

  return {
    fileKey: extractFeishuUploadKey(response, {
      key: "file_key",
      errorPrefix: "Feishu file upload failed",
    }),
  };
}

/**
 * Send an image message using an image_key
 */
export async function sendImageFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  imageKey: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, imageKey, replyToMessageId, replyInThread, accountId } = params;
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
    cfg,
    to,
    accountId,
  });
  const content = JSON.stringify({ image_key: imageKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: "image",
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    assertFeishuMessageApiSuccess(response, "Feishu image reply failed");
    return toFeishuSendResult(response, receiveId);
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: "image",
    },
  });
  assertFeishuMessageApiSuccess(response, "Feishu image send failed");
  return toFeishuSendResult(response, receiveId);
}

/**
 * Send a file message using a file_key
 */
export async function sendFileFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  fileKey: string;
  /** Use "audio" for audio, "media" for video (mp4), "file" for documents */
  msgType?: "file" | "audio" | "media";
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
}): Promise<SendMediaResult> {
  const { cfg, to, fileKey, replyToMessageId, replyInThread, accountId } = params;
  const msgType = params.msgType ?? "file";
  const { client, receiveId, receiveIdType } = resolveFeishuSendTarget({
    cfg,
    to,
    accountId,
  });
  const content = JSON.stringify({ file_key: fileKey });

  if (replyToMessageId) {
    const response = await client.im.message.reply({
      path: { message_id: replyToMessageId },
      data: {
        content,
        msg_type: msgType,
        ...(replyInThread ? { reply_in_thread: true } : {}),
      },
    });
    assertFeishuMessageApiSuccess(response, "Feishu file reply failed");
    return toFeishuSendResult(response, receiveId);
  }

  const response = await client.im.message.create({
    params: { receive_id_type: receiveIdType },
    data: {
      receive_id: receiveId,
      content,
      msg_type: msgType,
    },
  });
  assertFeishuMessageApiSuccess(response, "Feishu file send failed");
  return toFeishuSendResult(response, receiveId);
}

/**
 * Helper to detect file type from extension
 */
export function detectFileType(
  fileName: string,
): "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream" {
  const ext = normalizeLowercaseStringOrEmpty(path.extname(fileName));
  switch (ext) {
    case ".opus":
    case ".ogg":
      return "opus";
    case ".mp4":
    case ".mov":
    case ".avi":
      return "mp4";
    case ".pdf":
      return "pdf";
    case ".doc":
    case ".docx":
      return "doc";
    case ".xls":
    case ".xlsx":
      return "xls";
    case ".ppt":
    case ".pptx":
      return "ppt";
    default:
      return "stream";
  }
}

function resolveFeishuOutboundMediaKind(params: { fileName: string; contentType?: string }): {
  fileType?: "opus" | "mp4" | "pdf" | "doc" | "xls" | "ppt" | "stream";
  msgType: "image" | "file" | "audio" | "media";
} {
  const { fileName, contentType } = params;
  const ext = normalizeLowercaseStringOrEmpty(path.extname(fileName));
  const mimeKind = mediaKindFromMime(contentType);

  const isImageExt = [".jpg", ".jpeg", ".png", ".gif", ".webp", ".bmp", ".ico", ".tiff"].includes(
    ext,
  );
  if (isImageExt || mimeKind === "image") {
    return { msgType: "image" };
  }

  if (
    ext === ".opus" ||
    ext === ".ogg" ||
    contentType === "audio/ogg" ||
    contentType === "audio/opus"
  ) {
    return { fileType: "opus", msgType: "audio" };
  }

  if (
    [".mp4", ".mov", ".avi"].includes(ext) ||
    contentType === "video/mp4" ||
    contentType === "video/quicktime" ||
    contentType === "video/x-msvideo"
  ) {
    return { fileType: "mp4", msgType: "media" };
  }

  const fileType = detectFileType(fileName);
  return {
    fileType,
    msgType:
      fileType === "stream"
        ? "file"
        : fileType === "opus"
          ? "audio"
          : fileType === "mp4"
            ? "media"
            : "file",
  };
}

/**
 * Upload and send media (image or file) from URL, local path, or buffer.
 * When mediaUrl is a local path, mediaLocalRoots (from core outbound context)
 * must be passed so loadWebMedia allows the path (post CVE-2026-26321).
 */
export async function sendMediaFeishu(params: {
  cfg: ClawdbotConfig;
  to: string;
  mediaUrl?: string;
  mediaBuffer?: Buffer;
  fileName?: string;
  replyToMessageId?: string;
  replyInThread?: boolean;
  accountId?: string;
  /** Allowed roots for local path reads; required for local filePath to work. */
  mediaLocalRoots?: readonly string[];
}): Promise<SendMediaResult> {
  const {
    cfg,
    to,
    mediaUrl,
    mediaBuffer,
    fileName,
    replyToMessageId,
    replyInThread,
    accountId,
    mediaLocalRoots,
  } = params;
  const account = resolveFeishuRuntimeAccount({ cfg, accountId });
  if (!account.configured) {
    throw new Error(`Feishu account "${account.accountId}" not configured`);
  }
  const mediaMaxBytes = (account.config?.mediaMaxMb ?? 30) * 1024 * 1024;

  let buffer: Buffer;
  let name: string;
  let contentType: string | undefined;

  if (mediaBuffer) {
    buffer = mediaBuffer;
    name = fileName ?? "file";
  } else if (mediaUrl) {
    const loaded = await getFeishuRuntime().media.loadWebMedia(mediaUrl, {
      maxBytes: mediaMaxBytes,
      optimizeImages: false,
      localRoots: mediaLocalRoots?.length ? mediaLocalRoots : undefined,
    });
    buffer = loaded.buffer;
    name = fileName ?? loaded.fileName ?? "file";
    contentType = loaded.contentType;
  } else {
    throw new Error("Either mediaUrl or mediaBuffer must be provided");
  }

  const routing = resolveFeishuOutboundMediaKind({ fileName: name, contentType });

  if (routing.msgType === "image") {
    const { imageKey } = await uploadImageFeishu({ cfg, image: buffer, accountId });
    return sendImageFeishu({ cfg, to, imageKey, replyToMessageId, replyInThread, accountId });
  }
  const { fileKey } = await uploadFileFeishu({
    cfg,
    file: buffer,
    fileName: name,
    fileType: routing.fileType ?? "stream",
    accountId,
  });
  return sendFileFeishu({
    cfg,
    to,
    fileKey,
    msgType: routing.msgType,
    replyToMessageId,
    replyInThread,
    accountId,
  });
}
