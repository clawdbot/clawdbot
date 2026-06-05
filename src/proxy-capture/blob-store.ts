// Proxy capture blob store persists captured request and response bodies by hash.
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { gzipSync, gunzipSync } from "node:zlib";
import type { CaptureBlobRecord } from "./types.js";

// Capture blobs store request/response bodies by content hash, gzip-compressed
// on disk, so repeated payloads can share one file across events.
function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

export function writeCaptureBlob(params: {
  blobDir: string;
  data: Buffer;
  contentType?: string;
}): CaptureBlobRecord {
  ensureDir(params.blobDir);
  const sha256 = createHash("sha256").update(params.data).digest("hex");
  const blobId = sha256.slice(0, 24);
  const outputPath = path.join(params.blobDir, `${blobId}.bin.gz`);
  if (!fs.existsSync(outputPath)) {
    fs.writeFileSync(outputPath, gzipSync(params.data));
  }
  return {
    blobId,
    path: outputPath,
    encoding: "gzip",
    sizeBytes: params.data.byteLength,
    sha256,
    ...(params.contentType ? { contentType: params.contentType } : {}),
  };
}

// Debug CLI reads blobs as UTF-8 previews. Binary payloads still remain
// available via the compressed file path recorded in the blob metadata.
export function readCaptureBlobText(blobPath: string): string {
  return gunzipSync(fs.readFileSync(blobPath)).toString("utf8");
}
