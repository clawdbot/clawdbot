// Shared media runner test utilities create temporary audio/video fixtures and
// attachment caches with host tool discovery disabled.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withEnvAsync } from "../test-utils/env.js";
import { MIN_AUDIO_FILE_BYTES } from "./defaults.constants.js";
import { createMediaAttachmentCache, normalizeMediaAttachments } from "./runner.attachments.js";

// Temp-file fixtures for media runner tests; keep cache roots scoped to generated files.
type MediaFixtureParams = {
  ctx: { media: Array<{ path: string; contentType: string }> };
  mediaPath: string;
  media: ReturnType<typeof normalizeMediaAttachments>;
  cache: ReturnType<typeof createMediaAttachmentCache>;
};

/** Creates a temporary media file, cache, and normalized context for a test callback. */
export async function withMediaFixture(
  params: {
    filePrefix: string;
    extension: string;
    mediaType: string;
    fileContents: Buffer;
  },
  run: (params: MediaFixtureParams) => Promise<void>,
) {
  const tmpPath = path.join(
    os.tmpdir(),
    `${params.filePrefix}-${Date.now().toString()}.${params.extension}`,
  );
  await fs.writeFile(tmpPath, params.fileContents);
  const ctx = { media: [{ path: tmpPath, contentType: params.mediaType }] };
  const media = normalizeMediaAttachments(ctx);
  const cache = createMediaAttachmentCache(media, {
    localPathRoots: [path.dirname(tmpPath)],
    includeDefaultLocalPathRoots: false,
  });

  try {
    // Avoid accidentally finding host audio/video tools during unit tests.
    await withEnvAsync({ PATH: "" }, async () => {
      await run({ ctx, mediaPath: tmpPath, media, cache });
    });
  } finally {
    await cache.cleanup();
    await fs.unlink(tmpPath).catch(() => {});
  }
}

/** Creates a safe WAV fixture above the minimum audio-byte threshold. */
export async function withAudioFixture(
  filePrefix: string,
  run: (params: MediaFixtureParams) => Promise<void>,
) {
  await withMediaFixture(
    {
      filePrefix,
      extension: "wav",
      mediaType: "audio/wav",
      fileContents: createSafeAudioFixtureBuffer(2048, 0x52),
    },
    run,
  );
}

/** Allocates a deterministic audio buffer large enough to skip tiny-file guards. */
export function createSafeAudioFixtureBuffer(size?: number, fill = 0xab): Buffer {
  const minSafeSize = MIN_AUDIO_FILE_BYTES + 1;
  const finalSize = Math.max(size ?? minSafeSize, minSafeSize);
  return Buffer.alloc(finalSize, fill);
}

/** Creates a small MP4-labeled fixture for video runner tests. */
export async function withVideoFixture(
  filePrefix: string,
  run: (params: MediaFixtureParams) => Promise<void>,
) {
  await withMediaFixture(
    {
      filePrefix,
      extension: "mp4",
      mediaType: "video/mp4",
      fileContents: Buffer.from("video"),
    },
    run,
  );
}
