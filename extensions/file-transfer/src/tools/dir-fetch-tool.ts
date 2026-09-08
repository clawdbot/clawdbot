// File Transfer plugin module implements dir fetch tool behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  ARCHIVE_LIMIT_ERROR_CODE,
  ArchiveLimitError,
  extractArchive,
} from "openclaw/plugin-sdk/archive";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { wrapExternalContent } from "openclaw/plugin-sdk/security-runtime";
import { appendFileTransferAudit } from "../shared/audit.js";
import { DIR_FETCH_ARCHIVE_POLICY } from "../shared/dir-fetch-archive.js";
import {
  DIR_FETCH_DEFAULT_MAX_BYTES,
  DIR_FETCH_HARD_MAX_BYTES,
} from "../shared/dir-fetch-limits.js";
import { IMAGE_MIME_INLINE_SET, mimeFromExtension } from "../shared/mime.js";
import { readClampedInt } from "../shared/params.js";
import { DIR_FETCH_TOOL_DESCRIPTOR, FILE_TRANSFER_SUBDIR } from "./descriptors.js";
import { invokeNodeToolPayload, readRequiredNodePath } from "./node-tool-invoke.js";

// Cap how many local file paths we surface in details.media.mediaUrls.
// Larger trees still land on disk but we don't spam the channel adapter
// with hundreds of attachments.
const MEDIA_URL_CAP = 25;
const DIRECTORY_TEXT_MAX_BYTES = 8192;

// Hard timeout for gateway-side archive extraction.
const TAR_UNPACK_TIMEOUT_MS = 60_000;

function classifyArchiveFailure(error: unknown): {
  auditCode: "TREE_TOO_LARGE" | "UNSAFE_ARCHIVE";
  publicCode: "UNCOMPRESSED_TOO_LARGE" | "UNSAFE_ARCHIVE";
  reason: string;
} {
  const reason = error instanceof Error ? error.message : String(error);
  if (
    error instanceof ArchiveLimitError &&
    error.code !== ARCHIVE_LIMIT_ERROR_CODE.ENTRY_COUNT_EXCEEDS_LIMIT
  ) {
    return { auditCode: "TREE_TOO_LARGE", publicCode: "UNCOMPRESSED_TOO_LARGE", reason };
  }
  return { auditCode: "UNSAFE_ARCHIVE", publicCode: "UNSAFE_ARCHIVE", reason };
}

async function computeFileSha256(filePath: string): Promise<string> {
  // Stream the hash so we never pull a whole large file into memory.
  // file_fetch caps single files at 16MB, but unpacked dir_fetch entries
  // share the 64MB uncompressed budget — better to stream regardless.
  const hash = crypto.createHash("sha256");
  const handle = await fs.open(filePath, "r");
  try {
    const chunkSize = 64 * 1024;
    const buf = Buffer.allocUnsafe(chunkSize);
    while (true) {
      const { bytesRead } = await handle.read(buf, 0, chunkSize, null);
      if (bytesRead === 0) {
        break;
      }
      hash.update(buf.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

type UnpackedFileEntry = {
  relPath: string;
  size: number;
  mimeType: string;
  sha256: string;
  localPath: string;
};

function savedDirectoryText(rootDir: string, files: UnpackedFileEntry[]): string {
  const visible: Array<{ relPath: string; size: number }> = [];
  const render = () => {
    const manifest = JSON.stringify({
      rootDir,
      fileCount: files.length,
      displayedCount: visible.length,
      files: visible,
    });
    const omitted = files.length - visible.length;
    // A stable footer lets each additional complete record consume more bytes,
    // including the last one; omission guidance must not crowd out a full manifest.
    const note = `${omitted} saved files omitted from this text (byte limit or reserved path markers). All remain under rootDir; inspect them with available local file or directory capabilities.`;
    const wrapped = wrapExternalContent(`Fetched ${files.length} files.\n${manifest}\n${note}`, {
      source: "unknown",
    });
    // Keep complete, exact local paths: the security wrapper can rewrite reserved
    // markers, and its warning and escaping must fit inside the same byte budget.
    return wrapped.includes(manifest) &&
      Buffer.byteLength(wrapped, "utf8") <= DIRECTORY_TEXT_MAX_BYTES
      ? wrapped
      : undefined;
  };
  let text = render();
  // Sort only the text projection; manifest and attachment order are unchanged.
  for (const { relPath, size } of files.toSorted((a, b) =>
    a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0,
  )) {
    visible.push({ relPath, size });
    const candidate = render();
    if (!candidate) {
      break;
    }
    text = candidate;
  }
  return (
    text ??
    wrapExternalContent(
      `Fetched ${files.length} files. Saved paths omitted: rootDir cannot be represented safely within the 8192-byte text limit. No usable local path is shown.`,
      { source: "unknown" },
    )
  );
}

/**
 * Walk a directory recursively, collecting file entries (skips directories).
 * Skips symlinks — we don't want to follow links the archive might have
 * carried in. Files only.
 */
async function walkDir(
  dir: string,
  rootDir: string,
): Promise<{ relPath: string; absPath: string }[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results: { relPath: string; absPath: string }[] = [];
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = await walkDir(absPath, rootDir);
      results.push(...nested);
    } else if (entry.isFile()) {
      const relPath = path.relative(rootDir, absPath);
      results.push({ relPath, absPath });
    }
    // Symlinks are intentionally ignored: don't follow them out of destDir.
  }
  return results;
}

export function createDirFetchTool(): AnyAgentTool {
  return {
    ...DIR_FETCH_TOOL_DESCRIPTOR,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const { node, requestedPath: dirPath } = readRequiredNodePath(params);

      const maxBytes = readClampedInt({
        input: params,
        key: "maxBytes",
        defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
        hardMin: 1,
        hardMax: DIR_FETCH_HARD_MAX_BYTES,
      });

      const { nodeId, nodeDisplayName, payload, startedAt } = await invokeNodeToolPayload({
        node,
        params,
        command: "dir.fetch",
        commandParams: {
          path: dirPath,
          maxBytes,
        },
        requestedPath: dirPath,
      });

      const canonicalPath = typeof payload.path === "string" ? payload.path : "";
      const tarBase64 = typeof payload.tarBase64 === "string" ? payload.tarBase64 : "";
      const tarBytes = typeof payload.tarBytes === "number" ? payload.tarBytes : -1;
      const sha256 = typeof payload.sha256 === "string" ? payload.sha256 : "";

      if (!canonicalPath || !tarBase64 || tarBytes < 0 || !sha256) {
        throw new Error("invalid dir.fetch payload (missing fields)");
      }

      const tarBuffer = Buffer.from(tarBase64, "base64");
      if (tarBuffer.byteLength !== tarBytes) {
        throw new Error(
          `dir.fetch size mismatch: payload says ${tarBytes} bytes, decoded ${tarBuffer.byteLength}`,
        );
      }
      const localSha256 = crypto.createHash("sha256").update(tarBuffer).digest("hex");
      if (localSha256 !== sha256) {
        throw new Error("dir.fetch sha256 mismatch (integrity failure)");
      }

      // Keep the tarball and extracted paths under the same managed tool namespace.
      const savedTar = await saveMediaBuffer(
        tarBuffer,
        "application/gzip",
        FILE_TRANSFER_SUBDIR,
        DIR_FETCH_HARD_MAX_BYTES,
      );

      const tarDir = path.dirname(savedTar.path);
      const tarBaseName = path.basename(savedTar.path, path.extname(savedTar.path));
      const unpackId = `dir-fetch-${tarBaseName}`;
      const rootDir = path.join(tarDir, unpackId);
      await fs.mkdir(rootDir, { recursive: true, mode: 0o700 });
      try {
        await extractArchive({
          archivePath: savedTar.path,
          destDir: rootDir,
          kind: "tar",
          tarGzip: true,
          timeoutMs: TAR_UNPACK_TIMEOUT_MS,
          entryModes: "clamp",
          ...DIR_FETCH_ARCHIVE_POLICY,
        });
      } catch (error) {
        await Promise.all([
          fs.rm(rootDir, { recursive: true, force: true }).catch(() => undefined),
          fs.rm(savedTar.path, { force: true }).catch(() => undefined),
        ]);
        const failure = classifyArchiveFailure(error);
        await appendFileTransferAudit({
          op: "dir.fetch",
          nodeId,
          nodeDisplayName,
          requestedPath: dirPath,
          canonicalPath,
          decision: "error",
          errorCode: failure.auditCode,
          errorMessage: failure.reason,
          sizeBytes: tarBytes,
          sha256,
          durationMs: Date.now() - startedAt,
        });
        throw new Error(`dir.fetch ${failure.publicCode}: ${failure.reason}`, { cause: error });
      }

      const walked = await walkDir(rootDir, rootDir);
      const files: UnpackedFileEntry[] = [];
      for (const { relPath, absPath } of walked) {
        let size;
        try {
          const st = await fs.stat(absPath);
          size = st.size;
        } catch {
          continue;
        }
        const mimeType = mimeFromExtension(relPath);
        const fileSha256 = await computeFileSha256(absPath);
        files.push({ relPath, size, mimeType, sha256: fileSha256, localPath: absPath });
      }
      const fileCount = files.length;

      const imageFiles = files.filter((f) => IMAGE_MIME_INLINE_SET.has(f.mimeType));
      const nonImageFiles = files.filter((f) => !IMAGE_MIME_INLINE_SET.has(f.mimeType));
      const allOrdered = [...imageFiles, ...nonImageFiles];
      const mediaUrls = allOrdered.slice(0, MEDIA_URL_CAP).map((f) => f.localPath);

      await appendFileTransferAudit({
        op: "dir.fetch",
        nodeId,
        nodeDisplayName,
        requestedPath: dirPath,
        canonicalPath,
        decision: "allowed",
        sizeBytes: tarBytes,
        sha256,
        durationMs: Date.now() - startedAt,
      });

      return {
        content: [{ type: "text" as const, text: savedDirectoryText(rootDir, files) }],
        details: {
          path: canonicalPath,
          rootDir,
          fileCount,
          tarBytes,
          sha256,
          files,
          media: {
            mediaUrls,
          },
        },
      };
    },
  };
}
