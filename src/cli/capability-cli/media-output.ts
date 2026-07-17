import fs from "node:fs/promises";
import path from "node:path";
import { detectMime, extensionForMime, normalizeMimeType } from "@openclaw/media-core/mime";
import pMap from "p-map";
import { saveMediaBuffer } from "../../media/store.js";

export async function writeOutputAsset(params: {
  buffer: Buffer;
  mimeType?: string;
  originalFilename?: string;
  outputPath?: string;
  outputIndex: number;
  outputCount: number;
  subdir: string;
}) {
  if (!params.outputPath) {
    const saved = await saveMediaBuffer(
      params.buffer,
      params.mimeType,
      params.subdir,
      Number.MAX_SAFE_INTEGER,
      params.originalFilename,
    );
    return { path: saved.path, mimeType: saved.contentType, size: saved.size };
  }

  const resolvedOutput = path.resolve(params.outputPath);
  const parsed = path.parse(resolvedOutput);
  const detectedMime =
    (await detectMime({
      buffer: params.buffer,
      headerMime: params.mimeType,
    })) ?? params.mimeType;
  const requestedMime = normalizeMimeType(await detectMime({ filePath: resolvedOutput }));
  const detectedNormalized = normalizeMimeType(detectedMime);
  const canonicalDetectedExt = extensionForMime(detectedNormalized);
  const fallbackExt = parsed.ext || path.extname(params.originalFilename ?? "") || "";
  const ext =
    parsed.ext && requestedMime === detectedNormalized
      ? parsed.ext
      : (canonicalDetectedExt ?? fallbackExt);
  const filePath =
    params.outputCount <= 1
      ? path.join(parsed.dir, `${parsed.name}${ext}`)
      : path.join(parsed.dir, `${parsed.name}-${String(params.outputIndex + 1)}${ext}`);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, params.buffer);
  return {
    path: filePath,
    mimeType: detectedNormalized ?? params.mimeType,
    size: params.buffer.byteLength,
  };
}

export async function readInputFiles(
  files: string[],
): Promise<Array<{ path: string; buffer: Buffer }>> {
  return await pMap(
    files,
    async (filePath) => ({
      path: path.resolve(filePath),
      buffer: await fs.readFile(path.resolve(filePath)),
    }),
    { concurrency: 20 },
  );
}
