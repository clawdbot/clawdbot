import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { TsdownPlugin } from "tsdown";
import { isRecord } from "../../packages/normalization-core/src/record-coerce.ts";

export const GATEWAY_RUN_CHUNK_METADATA_VERSION = 1;
export const GATEWAY_RUN_CHUNK_METADATA_PATH = "cli/gateway-run-chunk.json";

function hashChunk(contents: string | Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

export function createGatewayRunChunkMetadataPlugin(rootDir = process.cwd()) {
  const ownerModule = path
    .resolve(rootDir, "src/cli/gateway-cli/run-command.ts")
    .replaceAll("\\", "/");
  return {
    name: "openclaw:gateway-run-chunk-metadata",
    generateBundle: {
      order: "post",
      handler(_options, bundle) {
        // Module ownership survives chunk naming and minification; source-text markers do not.
        const chunks = Object.values(bundle).flatMap((chunk) =>
          chunk.type === "chunk" &&
          chunk.moduleIds.some((id) => id.replaceAll("\\", "/") === ownerModule)
            ? [{ fileName: chunk.fileName, sha256: hashChunk(chunk.code) }]
            : [],
        );
        // Subset builds need not include the CLI. The complete build guard requires this file.
        if (chunks.length > 0) {
          this.emitFile({
            type: "asset",
            fileName: GATEWAY_RUN_CHUNK_METADATA_PATH,
            source: `${JSON.stringify({ version: GATEWAY_RUN_CHUNK_METADATA_VERSION, chunks })}\n`,
          });
        }
      },
    },
  } satisfies TsdownPlugin;
}

export function readGatewayRunChunks(distDir: string, fsImpl: typeof fs = fs) {
  const canonicalDistDir = fsImpl.realpathSync(distDir);
  const metadataPath = path.join(distDir, GATEWAY_RUN_CHUNK_METADATA_PATH);
  const metadataStat = fsImpl.lstatSync(metadataPath);
  if (!metadataStat.isFile() || metadataStat.isSymbolicLink()) {
    throw new Error("gateway run chunk metadata must be a regular file");
  }
  const metadata: unknown = JSON.parse(fsImpl.readFileSync(metadataPath, "utf8"));
  if (
    !isRecord(metadata) ||
    metadata.version !== GATEWAY_RUN_CHUNK_METADATA_VERSION ||
    !Array.isArray(metadata.chunks) ||
    metadata.chunks.length === 0
  ) {
    throw new Error("invalid gateway run chunk metadata");
  }
  return metadata.chunks.map((chunk: unknown) => {
    if (
      !isRecord(chunk) ||
      typeof chunk.fileName !== "string" ||
      typeof chunk.sha256 !== "string"
    ) {
      throw new Error("invalid gateway run chunk metadata entry");
    }
    const filePath = path.resolve(distDir, chunk.fileName);
    const relative = path.relative(distDir, filePath);
    if (!relative || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("gateway run chunk must belong to the build output directory");
    }
    const stat = fsImpl.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error("gateway run chunk must be a regular file");
    }
    if (fsImpl.realpathSync(filePath) !== path.resolve(canonicalDistDir, relative)) {
      throw new Error("gateway run chunk must not traverse a symbolic link");
    }
    const bytes = fsImpl.readFileSync(filePath);
    if (hashChunk(bytes) !== chunk.sha256) {
      throw new Error("gateway run chunk does not match its build metadata");
    }
    return { filePath, source: bytes.toString("utf8") };
  });
}
