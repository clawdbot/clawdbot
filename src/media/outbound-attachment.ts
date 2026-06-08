// Outbound attachment helpers prepare media attachments for channel delivery.
import { buildOutboundMediaLoadOptions, type OutboundMediaAccess } from "./load-options.js";
import { saveMediaBuffer } from "./store.js";
import { loadWebMedia } from "./web-media.js";

/** Loads a remote/local media URL and stages it into the outbound media store. */
export async function resolveOutboundAttachmentFromUrl(
  mediaUrl: string,
  maxBytes: number,
  options?: {
    mediaAccess?: OutboundMediaAccess;
    localRoots?: readonly string[];
    readFile?: (filePath: string) => Promise<Buffer>;
  },
): Promise<{ path: string; contentType?: string }> {
  const media = await loadWebMedia(
    mediaUrl,
    buildOutboundMediaLoadOptions({
      maxBytes,
      mediaAccess: options?.mediaAccess,
      mediaLocalRoots: options?.localRoots,
      mediaReadFile: options?.readFile,
    }),
  );
  // Preserve source file names so outbound attachments keep useful names after UUID staging.
  const saved = await saveMediaBuffer(
    media.buffer,
    media.contentType ?? undefined,
    "outbound",
    maxBytes,
    media.fileName,
  );
  return { path: saved.path, contentType: saved.contentType };
}

/** Stages an in-memory attachment buffer into the outbound media store. */
export async function resolveOutboundAttachmentFromBuffer(
  buffer: Buffer,
  maxBytes: number,
  options?: {
    contentType?: string;
    filename?: string;
  },
): Promise<{ path: string; contentType?: string }> {
  const saved = await saveMediaBuffer(
    buffer,
    options?.contentType,
    "outbound",
    maxBytes,
    options?.filename,
  );
  return { path: saved.path, contentType: saved.contentType };
}
