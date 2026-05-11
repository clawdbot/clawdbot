import { messagingApi } from "@line/bot-sdk";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { logVerbose } from "openclaw/plugin-sdk/runtime-env";
import { lowercasePreservingWhitespace } from "openclaw/plugin-sdk/string-coerce-runtime";

interface DownloadResult {
  path: string;
  contentType?: string;
  size: number;
}

const AUDIO_BRANDS = new Set(["m4a ", "m4b ", "m4p ", "m4r ", "f4a ", "f4b "]);

export async function downloadLineMedia(
  messageId: string,
  channelAccessToken: string,
  maxBytes = 10 * 1024 * 1024,
): Promise<DownloadResult> {
  const client = new messagingApi.MessagingApiBlobClient({
    channelAccessToken,
  });

  const response = await client.getMessageContent(messageId);
  const chunks: Buffer[] = [];
  let totalSize = 0;

  for await (const chunk of response as AsyncIterable<Buffer>) {
    totalSize += chunk.length;
    if (totalSize > maxBytes) {
      throw new Error(`Media exceeds ${Math.round(maxBytes / (1024 * 1024))}MB limit`);
    }
    chunks.push(chunk);
  }

  const buffer = Buffer.concat(chunks);
  const contentType = detectContentType(buffer);
  const saved = await saveMediaBuffer(buffer, contentType, "inbound", maxBytes);
  logVerbose(`line: persisted media ${messageId} to ${saved.path} (${buffer.length} bytes)`);

  return {
    path: saved.path,
    contentType: saved.contentType,
    size: buffer.length,
  };
}

function detectContentType(buffer: Buffer): string {
  const hasFtypBox =
    buffer.length >= 12 &&
    buffer[4] === 0x66 &&
    buffer[5] === 0x74 &&
    buffer[6] === 0x79 &&
    buffer[7] === 0x70;

  if (buffer.length >= 2) {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) {
      return "image/jpeg";
    }
    if (buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
      return "image/png";
    }
    if (buffer[0] === 0x47 && buffer[1] === 0x49 && buffer[2] === 0x46) {
      return "image/gif";
    }
    if (
      buffer[0] === 0x52 &&
      buffer[1] === 0x49 &&
      buffer[2] === 0x46 &&
      buffer[3] === 0x46 &&
      buffer[8] === 0x57 &&
      buffer[9] === 0x45 &&
      buffer[10] === 0x42 &&
      buffer[11] === 0x50
    ) {
      return "image/webp";
    }
    if (hasFtypBox) {
      const majorBrand = lowercasePreservingWhitespace(buffer.toString("ascii", 8, 12));
      if (AUDIO_BRANDS.has(majorBrand)) {
        return "audio/mp4";
      }
      return "video/mp4";
    }
  }

  return "application/octet-stream";
}
