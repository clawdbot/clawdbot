import type {
  DimensionalFileInfo,
  EncryptedFile,
  FileWithThumbnailInfo,
  MatrixClient,
  TimedFileInfo,
  VideoFileInfo,
} from "@vector-im/matrix-bot-sdk";
import { parseBuffer, type IFileInfo } from "music-metadata";

import { getMatrixRuntime } from "../../runtime.js";
import {
  type MatrixMediaContent,
  type MatrixMediaInfo,
  type MatrixMediaMsgType,
  type MatrixRelation,
  type MediaKind,
} from "./types.js";
import { applyMatrixFormatting } from "./formatting.js";

const getCore = () => getMatrixRuntime();

export function buildMatrixMediaInfo(params: {
  size: number;
  mimetype?: string;
  durationMs?: number;
  imageInfo?: DimensionalFileInfo;
}): MatrixMediaInfo | undefined {
  const base: FileWithThumbnailInfo = {};
  if (Number.isFinite(params.size)) {
    base.size = params.size;
  }
  if (params.mimetype) {
    base.mimetype = params.mimetype;
  }
  if (params.imageInfo) {
    const dimensional: DimensionalFileInfo = {
      ...base,
      ...params.imageInfo,
    };
    if (typeof params.durationMs === "number") {
      const videoInfo: VideoFileInfo = {
        ...dimensional,
        duration: params.durationMs,
      };
      return videoInfo;
    }
    return dimensional;
  }
  if (typeof params.durationMs === "number") {
    const timedInfo: TimedFileInfo = {
      ...base,
      duration: params.durationMs,
    };
    return timedInfo;
  }
  if (Object.keys(base).length === 0) return undefined;
  return base;
}

export function buildMediaContent(params: {
  msgtype: MatrixMediaMsgType;
  body: string;
  url?: string;
  filename?: string;
  mimetype?: string;
  size: number;
  relation?: MatrixRelation;
  isVoice?: boolean;
  durationMs?: number;
  imageInfo?: DimensionalFileInfo;
  file?: EncryptedFile;
}): MatrixMediaContent {
  const info = buildMatrixMediaInfo({
    size: params.size,
    mimetype: params.mimetype,
    durationMs: params.durationMs,
    imageInfo: params.imageInfo,
  });
  const base: MatrixMediaContent = {
    msgtype: params.msgtype,
    body: params.body,
    filename: params.filename,
    info: info ?? undefined,
  };
  // Encrypted media should only include the "file" payload, not top-level "url".
  if (!params.file && params.url) {
    base.url = params.url;
  }
  // For encrypted files, add the file object
  if (params.file) {
    base.file = params.file;
  }
  if (params.isVoice) {
    base["org.matrix.msc3245.voice"] = {};
    if (typeof params.durationMs === "number") {
      base["org.matrix.msc1767.audio"] = {
        duration: params.durationMs,
      };
    }
  }
  if (params.relation) {
    base["m.relates_to"] = params.relation;
  }
  applyMatrixFormatting(base, params.body);
  return base;
}

const THUMBNAIL_MAX_SIDE = 800;
const THUMBNAIL_QUALITY = 80;

export async function prepareImageInfo(params: {
  buffer: Buffer;
  client: MatrixClient;
}): Promise<DimensionalFileInfo | undefined> {
  const meta = await getCore().media.getImageMetadata(params.buffer).catch(() => null);
  if (!meta) return undefined;
  const imageInfo: DimensionalFileInfo = { w: meta.width, h: meta.height };
  const maxDim = Math.max(meta.width, meta.height);
  if (maxDim > THUMBNAIL_MAX_SIDE) {
    try {
      const thumbBuffer = await getCore().media.resizeToJpeg({
        buffer: params.buffer,
        maxSide: THUMBNAIL_MAX_SIDE,
        quality: THUMBNAIL_QUALITY,
        withoutEnlargement: true,
      });
      const thumbMeta = await getCore().media.getImageMetadata(thumbBuffer).catch(() => null);
      const thumbUri = await params.client.uploadContent(
        thumbBuffer,
        "image/jpeg",
        "thumbnail.jpg",
      );
      imageInfo.thumbnail_url = thumbUri;
      if (thumbMeta) {
        imageInfo.thumbnail_info = {
          w: thumbMeta.width,
          h: thumbMeta.height,
          mimetype: "image/jpeg",
          size: thumbBuffer.byteLength,
        };
      }
    } catch {
      // Thumbnail generation failed, continue without it
    }
  }
  return imageInfo;
}

export async function resolveMediaDurationMs(params: {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
  kind: MediaKind;
}): Promise<number | undefined> {
  if (params.kind !== "audio" && params.kind !== "video") return undefined;
  try {
    const fileInfo: IFileInfo | string | undefined =
      params.contentType || params.fileName
        ? {
            mimeType: params.contentType,
            size: params.buffer.byteLength,
            path: params.fileName,
          }
        : undefined;
    const metadata = await parseBuffer(params.buffer, fileInfo, {
      duration: true,
      skipCovers: true,
    });
    const durationSeconds = metadata.format.duration;
    if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
      return Math.max(0, Math.round(durationSeconds * 1000));
    }
  } catch {
    // Duration is optional; ignore parse failures.
  }
  return undefined;
}

async function uploadFile(
  client: MatrixClient,
  file: Buffer,
  params: {
    contentType?: string;
    filename?: string;
  },
): Promise<string> {
  return await client.uploadContent(file, params.contentType, params.filename);
}

/**
 * Upload media with optional encryption for E2EE rooms.
 */
export async function uploadMediaMaybeEncrypted(
  client: MatrixClient,
  roomId: string,
  buffer: Buffer,
  params: {
    contentType?: string;
    filename?: string;
  },
): Promise<{ url: string; file?: EncryptedFile }> {
  // Check if room is encrypted and crypto is available
  const isEncrypted = client.crypto && await client.crypto.isRoomEncrypted(roomId);

  if (isEncrypted && client.crypto) {
    // Encrypt the media before uploading
    const encrypted = await client.crypto.encryptMedia(buffer);
    const mxc = await client.uploadContent(encrypted.buffer, params.contentType, params.filename);
    const file: EncryptedFile = { url: mxc, ...encrypted.file };
    return {
      url: mxc,
      file,
    };
  }

  // Upload unencrypted
  const mxc = await uploadFile(client, buffer, params);
  return { url: mxc };
}
