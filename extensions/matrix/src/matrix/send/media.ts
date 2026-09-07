// Matrix plugin module implements media behavior.
import { parseBuffer, type IFileInfo } from "music-metadata";
import type { MediaKind } from "openclaw/plugin-sdk/media-runtime";
import { getMatrixRuntime } from "../../runtime.js";
import type {
  DimensionalFileInfo,
  EncryptedFile,
  FileWithThumbnailInfo,
  MatrixClient,
  TimedFileInfo,
  VideoFileInfo,
} from "../sdk.js";
import type {
  MatrixMediaContent,
  MatrixMediaInfo,
  MatrixMediaMsgType,
  MatrixRelation,
} from "./types.js";

function buildMatrixMediaInfo(params: {
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
  if (Object.keys(base).length === 0) {
    return undefined;
  }
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
  return base;
}

const THUMBNAIL_MAX_SIDE = 800;
const THUMBNAIL_QUALITY = 80;
const AIFC_IMA4_BYTES_PER_CHANNEL_PACKET = 34;
const AIFC_IMA4_FRAMES_PER_PACKET = 64;

function resolveAifcIma4DurationSeconds(buffer: Buffer, sampleRate?: number): number | undefined {
  if (
    !sampleRate ||
    !Number.isFinite(sampleRate) ||
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "FORM" ||
    buffer.toString("ascii", 8, 12) !== "AIFC"
  ) {
    return undefined;
  }

  let channels: number | undefined;
  let declaredFrameCount: number | undefined;
  let soundDataBytes: number | undefined;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const chunkType = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32BE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkSize > buffer.length - chunkStart) {
      return undefined;
    }
    if (chunkType === "COMM") {
      if (chunkSize < 22 || buffer.toString("ascii", chunkStart + 18, chunkStart + 22) !== "ima4") {
        return undefined;
      }
      channels = buffer.readUInt16BE(chunkStart);
      declaredFrameCount = buffer.readUInt32BE(chunkStart + 2);
    } else if (chunkType === "SSND") {
      if (chunkSize < 8) {
        return undefined;
      }
      const soundDataOffset = buffer.readUInt32BE(chunkStart);
      if (soundDataOffset > chunkSize - 8) {
        return undefined;
      }
      soundDataBytes = chunkSize - 8 - soundDataOffset;
    }
    offset = chunkStart + chunkSize + (chunkSize & 1);
  }

  if (!channels || !declaredFrameCount || !soundDataBytes) {
    return undefined;
  }
  const packetSize = channels * AIFC_IMA4_BYTES_PER_CHANNEL_PACKET;
  if (soundDataBytes % packetSize !== 0) {
    return undefined;
  }
  const packetCount = soundDataBytes / packetSize;
  if (packetCount !== declaredFrameCount) {
    return undefined;
  }
  // Apple AIFC stores IMA4 packet count in COMM; each packet decodes to 64
  // sample frames. Other encoders can store decoded frames, so verify SSND first.
  return (packetCount * AIFC_IMA4_FRAMES_PER_PACKET) / sampleRate;
}

export async function prepareImageInfo(params: {
  buffer: Buffer;
  client: MatrixClient;
  roomId: string;
}): Promise<DimensionalFileInfo | undefined> {
  const meta = await getMatrixRuntime()
    .media.getImageMetadata(params.buffer)
    .catch(() => null);
  if (!meta) {
    return undefined;
  }
  const imageInfo: DimensionalFileInfo = { w: meta.width, h: meta.height };
  const maxDim = Math.max(meta.width, meta.height);
  if (maxDim > THUMBNAIL_MAX_SIDE) {
    try {
      const thumbBuffer = await getMatrixRuntime().media.resizeToJpeg({
        buffer: params.buffer,
        maxSide: THUMBNAIL_MAX_SIDE,
        quality: THUMBNAIL_QUALITY,
        withoutEnlargement: true,
      });
      const thumbMeta = await getMatrixRuntime()
        .media.getImageMetadata(thumbBuffer)
        .catch(() => null);
      const result = await uploadMediaWithEncryption(params.client, params.roomId, thumbBuffer, {
        contentType: "image/jpeg",
        filename: "thumbnail.jpg",
      });
      if (result.file) {
        imageInfo.thumbnail_file = result.file;
      } else {
        imageInfo.thumbnail_url = result.url;
      }
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
  kind: Exclude<MediaKind, "sticker">;
}): Promise<number | undefined> {
  if (params.kind !== "audio" && params.kind !== "video") {
    return undefined;
  }
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
    const durationSeconds =
      resolveAifcIma4DurationSeconds(params.buffer, metadata.format.sampleRate) ??
      metadata.format.duration;
    if (typeof durationSeconds === "number" && Number.isFinite(durationSeconds)) {
      return Math.max(0, Math.round(durationSeconds * 1000));
    }
  } catch {
    // Duration is optional; ignore parse failures.
  }
  return undefined;
}

export async function uploadMediaWithEncryption(
  client: MatrixClient,
  roomId: string,
  buffer: Buffer,
  params: {
    contentType?: string;
    filename?: string;
  },
): Promise<{ url: string; file?: EncryptedFile }> {
  // Downloads and thumbnail generation can yield while encryption changes;
  // resolve room policy at the upload boundary instead of reusing stale facts.
  if ((await client.prepareRoomForMessageSend(roomId)) === "m.room.encrypted") {
    if (!client.crypto) {
      throw new Error("Encrypted Matrix room: enable encryption before uploading media");
    }
    const encrypted = await client.crypto.encryptMedia(buffer);
    // Upload URLs and headers are visible; keep real media metadata inside
    // the encrypted room event instead of exposing it with the ciphertext.
    const mxc = await client.uploadContent(encrypted.buffer, "application/octet-stream");
    const file: EncryptedFile = { url: mxc, ...encrypted.file };
    return {
      url: mxc,
      file,
    };
  }

  const mxc = await client.uploadContent(buffer, params.contentType, params.filename);
  return { url: mxc };
}
