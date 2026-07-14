// File Transfer plugin module implements dir fetch tool behavior.
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import type { AnyAgentTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { runCommandWithTimeout } from "openclaw/plugin-sdk/process-runtime";
import { projectBoundedTextTail } from "../shared/append-bounded-text-tail.js";
import { appendFileTransferAudit } from "../shared/audit.js";
import { IMAGE_MIME_INLINE_SET, mimeFromExtension } from "../shared/mime.js";
import { humanSize, readBoolean, readClampedInt } from "../shared/params.js";
import {
  DIR_FETCH_DEFAULT_MAX_BYTES,
  DIR_FETCH_HARD_MAX_BYTES,
  DIR_FETCH_TOOL_DESCRIPTOR,
  FILE_TRANSFER_SUBDIR,
} from "./descriptors.js";
import { invokeNodeToolPayload, readRequiredNodePath } from "./node-tool-invoke.js";

// Cap how many local file paths we surface in details.media.mediaUrls.
// Larger trees still land on disk but we don't spam the channel adapter
// with hundreds of attachments.
const MEDIA_URL_CAP = 25;

// Hard timeout for gateway-side tar processes.
const TAR_UNPACK_TIMEOUT_MS = 60_000;

// Cap on number of entries pre-validated. The compressed tar is already
// capped at DIR_FETCH_HARD_MAX_BYTES upstream, and we walk the unpacked
// tree to compute hashes — TAR_UNPACK_MAX_ENTRIES bounds how much work
// that walk can do.
const TAR_UNPACK_MAX_ENTRIES = 5000;
const TAR_LIST_OUTPUT_MAX_CHARS = 32 * 1024 * 1024;
const TAR_STDERR_TAIL_CHARS = 4096;
const TAR_ERROR_REASON_STDERR_CHARS = 200;
const TAR_UNPACK_ERROR_STDERR_CHARS = 300;

// Hard caps on uncompressed extraction. Defends against decompression-bomb
// archives that compress to <16MB but expand to gigabytes. Both caps are
// enforced during the post-extract walk: total bytes summed across entries
// and per-file size to bound any single fs.stat / hash operation.
const DIR_FETCH_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const DIR_FETCH_MAX_SINGLE_FILE_BYTES = 16 * 1024 * 1024;

async function listTarOutputLines<T>(input: {
  args: string[];
  label: string;
  tarBuffer: Buffer;
  mapLine: (line: string) => T;
  maxValues: number;
}): Promise<{ ok: true; values: T[] } | { ok: false; reason: string }> {
  const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
  const decoder = new StringDecoder("utf8");
  const values: T[] = [];
  let pending = "";
  let outputBytes = 0;
  let outputTooLarge = false;
  let valueLimitReached = false;
  const appendLine = (line: string): boolean => {
    if (!line) {
      return true;
    }
    values.push(input.mapLine(line));
    valueLimitReached = values.length >= input.maxValues;
    return !valueLimitReached;
  };
  let result: Awaited<ReturnType<typeof runCommandWithTimeout>>;
  try {
    result = await runCommandWithTimeout([tarBin, ...input.args], {
      input: input.tarBuffer,
      maxOutputBytes: { stderr: TAR_STDERR_TAIL_CHARS },
      onOutputChunk: (chunk, stream) => {
        if (stream !== "stdout") {
          return true;
        }
        outputBytes += chunk.byteLength;
        if (outputBytes > TAR_LIST_OUTPUT_MAX_CHARS) {
          outputTooLarge = true;
          return false;
        }
        const lines = `${pending}${decoder.write(chunk)}`.split("\n");
        pending = lines.pop() ?? "";
        return lines.every(appendLine);
      },
      outputCapture: { stdout: "discard", stderr: "tail" },
      tolerateOutputError: { stderr: true },
      timeoutMs: 30_000,
    });
  } catch (error) {
    return { ok: false, reason: `${input.label} error: ${formatErrorMessage(error)}` };
  }
  if (result.termination === "timeout") {
    return { ok: false, reason: `${input.label} timed out` };
  }
  if (valueLimitReached) {
    return { ok: true, values };
  }
  if (outputTooLarge) {
    return { ok: false, reason: `${input.label} output too large` };
  }
  if (result.termination !== "exit") {
    return {
      ok: false,
      reason: `${input.label} error: ${result.termination}`,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      reason: `${input.label} exited ${result.code}: ${projectBoundedTextTail(result.stderr, TAR_ERROR_REASON_STDERR_CHARS)}`,
    };
  }
  appendLine(pending + decoder.end());
  return { ok: true, values };
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

/**
 * Run two passes against the buffer to enumerate entries BEFORE we extract:
 *
 *   1. `tar -tf -` produces names ONLY, one per line. This is whitespace-safe
 *      because each line is exactly one path; no parsing of fixed columns.
 *      Used to validate paths (reject absolute, '..' traversal).
 *   2. `tar -tvf -` adds type info via the `ls -l`-style perm prefix.
 *      Used ONLY to detect symlinks / hardlinks / non-regular entries via
 *      the FIRST CHARACTER of each line, never the path column.
 *
 * Size limits are enforced at the *extraction* step instead — the tar
 * unpack process is bounded by the maxBytes we already pass through, and
 * the post-extract walkDir is hard-capped by TAR_UNPACK_MAX_ENTRIES.
 * Trying to parse uncompressed sizes from `tar -tvf` output is fragile
 * (filenames with whitespace shift the columns) and Aisle flagged that
 * shape as a bypass primitive — drop it.
 */
async function listTarPaths(
  tarBuffer: Buffer,
): Promise<{ ok: true; paths: string[] } | { ok: false; reason: string }> {
  const result = await listTarOutputLines({
    args: ["-tzf", "-"],
    label: "tar -tzf",
    tarBuffer,
    mapLine: (line) => line,
    maxValues: TAR_UNPACK_MAX_ENTRIES + 1,
  });
  return result.ok ? { ok: true, paths: result.values } : result;
}

async function listTarTypeChars(
  tarBuffer: Buffer,
): Promise<{ ok: true; typeChars: string[] } | { ok: false; reason: string }> {
  const result = await listTarOutputLines({
    args: ["-tzvf", "-"],
    label: "tar -tzvf",
    tarBuffer,
    mapLine: (line) => line.charAt(0),
    maxValues: TAR_UNPACK_MAX_ENTRIES + 1,
  });
  return result.ok ? { ok: true, typeChars: result.values } : result;
}

async function preValidateTarball(
  tarBuffer: Buffer,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const namesResult = await listTarPaths(tarBuffer);
  if (!namesResult.ok) {
    return namesResult;
  }
  const paths = namesResult.paths;
  if (paths.length > TAR_UNPACK_MAX_ENTRIES) {
    return {
      ok: false,
      reason: `archive contains ${paths.length} entries; limit ${TAR_UNPACK_MAX_ENTRIES}`,
    };
  }

  const typesResult = await listTarTypeChars(tarBuffer);
  if (!typesResult.ok) {
    return typesResult;
  }
  const typeChars = typesResult.typeChars;
  // The two passes should report the same number of entries; if they
  // don't, something exotic is going on (filenames with newlines, etc.)
  // and we refuse defensively.
  if (typeChars.length !== paths.length) {
    return {
      ok: false,
      reason: `tar -tzf and tar -tzvf disagree on entry count (${paths.length} vs ${typeChars.length}); refusing`,
    };
  }

  for (const [index, entryPath] of paths.entries()) {
    const t = typeChars.at(index);
    if (t === undefined) {
      return {
        ok: false,
        reason: `tar -tzf and tar -tzvf disagree on entry count (${paths.length} vs ${typeChars.length}); refusing`,
      };
    }
    if (t === "l" || t === "h") {
      return { ok: false, reason: `archive contains link entry: ${entryPath}` };
    }
    if (t !== "-" && t !== "d") {
      return { ok: false, reason: `archive contains non-regular entry type '${t}': ${entryPath}` };
    }
    if (path.isAbsolute(entryPath)) {
      return { ok: false, reason: `archive contains absolute path: ${entryPath}` };
    }
    const norm = path.posix.normalize(entryPath);
    if (norm === ".." || norm.startsWith("../") || norm.includes("/../")) {
      return { ok: false, reason: `archive contains '..' traversal: ${entryPath}` };
    }
    // Reject backslash-containing names too — refuses Windows-style
    // traversal in archives produced by an attacker on a Windows node.
    if (entryPath.includes("\\")) {
      return { ok: false, reason: `archive contains backslash in path: ${entryPath}` };
    }
  }
  return { ok: true };
}

export async function validateTarUncompressedBudget(
  tarBuffer: Buffer,
  maxBytes = DIR_FETCH_MAX_UNCOMPRESSED_BYTES,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
  let totalBytes = 0;
  let budgetExceeded = false;
  let result: Awaited<ReturnType<typeof runCommandWithTimeout>>;
  try {
    result = await runCommandWithTimeout([tarBin, "-xOzf", "-"], {
      input: tarBuffer,
      maxOutputBytes: { stderr: TAR_STDERR_TAIL_CHARS },
      onOutputChunk: (chunk, stream) => {
        if (stream !== "stdout") {
          return true;
        }
        totalBytes += chunk.byteLength;
        budgetExceeded = totalBytes > maxBytes;
        return !budgetExceeded;
      },
      outputCapture: { stdout: "discard", stderr: "tail" },
      tolerateOutputError: { stderr: true },
      timeoutMs: TAR_UNPACK_TIMEOUT_MS,
    });
  } catch (error) {
    return {
      ok: false,
      reason: `tar uncompressed budget validation error: ${formatErrorMessage(error)}`,
    };
  }
  if (result.termination === "timeout") {
    return { ok: false, reason: "tar uncompressed budget validation timed out" };
  }
  if (budgetExceeded) {
    return { ok: false, reason: `archive expands past uncompressed budget ${maxBytes} bytes` };
  }
  if (result.termination !== "exit") {
    return {
      ok: false,
      reason: `tar uncompressed budget validation error: ${result.termination}`,
    };
  }
  if (result.code !== 0) {
    return {
      ok: false,
      reason: `tar uncompressed budget validation exited ${result.code}: ${projectBoundedTextTail(result.stderr, TAR_ERROR_REASON_STDERR_CHARS)}`,
    };
  }
  return { ok: true };
}

type UnpackedFileEntry = {
  relPath: string;
  size: number;
  mimeType: string;
  sha256: string;
  localPath: string;
};

/**
 * Unpack a gzipped tarball into a target directory via `tar -xzf -`.
 * Caller MUST have run `preValidateTarball` first — this function trusts
 * that the archive contains only regular files / dirs with relative,
 * non-traversing paths. Without that pre-validation, raw `tar -xzf` is
 * unsafe (tarbomb, symlink-then-write tricks, decompression bomb).
 *
 * The `-P` flag is intentionally omitted so absolute paths in the
 * archive are stripped to relative ones (defense-in-depth on top of the
 * pre-validation rejection). A hard wall-clock timeout caps the unpack
 * at TAR_UNPACK_TIMEOUT_MS to avoid hangs.
 *
 * BSD tar (macOS) and GNU tar disagree on flags: `--no-overwrite-dir` is
 * GNU-only and BSD tar rejects it. We use only flags both implementations
 * accept. Defense-in-depth comes from the pre-validation step instead.
 *
 * `--no-same-owner` and `--no-same-permissions` are accepted by both BSD
 * and GNU tar. They prevent the archive from setting file ownership
 * (uid/gid) and dangerous mode bits (setuid/setgid/world-writable) on
 * the gateway filesystem. If the gateway is ever run as root or with
 * elevated privileges, a malicious node could otherwise plant
 * privileged executables here.
 */
async function unpackTar(tarBuffer: Buffer, destDir: string): Promise<void> {
  await fs.mkdir(destDir, { recursive: true, mode: 0o700 });
  const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
  const result = await runCommandWithTimeout(
    [tarBin, "-xzf", "-", "-C", destDir, "--no-same-owner", "--no-same-permissions"],
    {
      input: tarBuffer,
      maxOutputBytes: { stderr: TAR_STDERR_TAIL_CHARS },
      outputCapture: { stdout: "discard", stderr: "tail" },
      tolerateOutputError: { stderr: true },
      timeoutMs: TAR_UNPACK_TIMEOUT_MS,
    },
  );
  if (result.termination === "timeout") {
    throw new Error(`tar unpack timed out after ${TAR_UNPACK_TIMEOUT_MS}ms`);
  }
  if (result.termination !== "exit") {
    throw new Error(`tar unpack failed: ${result.termination}`);
  }
  if (result.code !== 0) {
    throw new Error(
      `tar unpack exited ${result.code}: ${projectBoundedTextTail(result.stderr, TAR_UNPACK_ERROR_STDERR_CHARS)}`,
    );
  }
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
      const includeDotfiles = readBoolean(params, "includeDotfiles", false);

      const { nodeId, nodeDisplayName, payload, startedAt } = await invokeNodeToolPayload({
        node,
        params,
        command: "dir.fetch",
        commandParams: {
          path: dirPath,
          maxBytes,
          includeDotfiles,
        },
        requestedPath: dirPath,
      });

      const canonicalPath = typeof payload.path === "string" ? payload.path : "";
      const tarBase64 = typeof payload.tarBase64 === "string" ? payload.tarBase64 : "";
      const tarBytes = typeof payload.tarBytes === "number" ? payload.tarBytes : -1;
      const sha256 = typeof payload.sha256 === "string" ? payload.sha256 : "";
      const fileCount = typeof payload.fileCount === "number" ? payload.fileCount : 0;

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

      // Pre-validate before extraction. The node is in the trust boundary
      // for v1, but a malicious or compromised node should not be able to
      // pivot into arbitrary file write on the gateway via tar tricks.
      // Rejects: symlinks, hardlinks, absolute paths, ".." traversal,
      // entry counts and uncompressed sizes above the caps.
      const validation = await preValidateTarball(tarBuffer);
      if (!validation.ok) {
        await appendFileTransferAudit({
          op: "dir.fetch",
          nodeId,
          nodeDisplayName,
          requestedPath: dirPath,
          canonicalPath,
          decision: "error",
          errorCode: "UNSAFE_ARCHIVE",
          errorMessage: validation.reason,
          sizeBytes: tarBytes,
          sha256,
          durationMs: Date.now() - startedAt,
        });
        throw new Error(`dir.fetch UNSAFE_ARCHIVE: ${validation.reason}`);
      }

      const budget = await validateTarUncompressedBudget(tarBuffer);
      if (!budget.ok) {
        await appendFileTransferAudit({
          op: "dir.fetch",
          nodeId,
          nodeDisplayName,
          requestedPath: dirPath,
          canonicalPath,
          decision: "error",
          errorCode: "TREE_TOO_LARGE",
          errorMessage: budget.reason,
          sizeBytes: tarBytes,
          sha256,
          durationMs: Date.now() - startedAt,
        });
        throw new Error(`dir.fetch UNCOMPRESSED_TOO_LARGE: ${budget.reason}`);
      }

      // Save tarball under the file-transfer subdir (no 2-min TTL).
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

      await unpackTar(tarBuffer, rootDir);

      const walked = await walkDir(rootDir, rootDir);
      const files: UnpackedFileEntry[] = [];
      // Defense-in-depth budget on the *uncompressed* extraction. Compressed
      // tar is bounded upstream; an attacker can still send a highly
      // compressible bomb (gigabytes of zeros) that fits under that cap.
      // Stop walking + clean up if the unpacked tree busts the budget.
      let totalUncompressed = 0;
      const abortAndCleanup = async (reason: string): Promise<never> => {
        await fs.rm(rootDir, { recursive: true, force: true }).catch(() => {});
        await appendFileTransferAudit({
          op: "dir.fetch",
          nodeId,
          nodeDisplayName,
          requestedPath: dirPath,
          canonicalPath,
          decision: "error",
          errorCode: "TREE_TOO_LARGE",
          errorMessage: reason,
          sizeBytes: tarBytes,
          sha256,
          durationMs: Date.now() - startedAt,
        });
        throw new Error(`dir.fetch UNCOMPRESSED_TOO_LARGE: ${reason}`);
      };
      for (const { relPath, absPath } of walked) {
        let size;
        try {
          const st = await fs.stat(absPath);
          size = st.size;
        } catch {
          continue;
        }
        if (size > DIR_FETCH_MAX_SINGLE_FILE_BYTES) {
          await abortAndCleanup(
            `extracted file ${relPath} is ${size} bytes (limit ${DIR_FETCH_MAX_SINGLE_FILE_BYTES})`,
          );
        }
        totalUncompressed += size;
        if (totalUncompressed > DIR_FETCH_MAX_UNCOMPRESSED_BYTES) {
          await abortAndCleanup(
            `extracted tree exceeds uncompressed budget ${DIR_FETCH_MAX_UNCOMPRESSED_BYTES} bytes (decompression bomb?)`,
          );
        }
        const mimeType = mimeFromExtension(relPath);
        const fileSha256 = await computeFileSha256(absPath);
        files.push({ relPath, size, mimeType, sha256: fileSha256, localPath: absPath });
      }

      const imageFiles = files.filter((f) => IMAGE_MIME_INLINE_SET.has(f.mimeType));
      const nonImageFiles = files.filter((f) => !IMAGE_MIME_INLINE_SET.has(f.mimeType));
      const allOrdered = [...imageFiles, ...nonImageFiles];
      const droppedFromMedia = Math.max(0, allOrdered.length - MEDIA_URL_CAP);
      const mediaUrls = allOrdered.slice(0, MEDIA_URL_CAP).map((f) => f.localPath);

      const shortHash = sha256.slice(0, 12);
      const mediaNote = droppedFromMedia
        ? ` (channel attaches first ${MEDIA_URL_CAP}; ${droppedFromMedia} more in details.files)`
        : "";
      const summaryText = `Fetched ${fileCount} files from ${canonicalPath} (${humanSize(tarBytes)} compressed, sha256:${shortHash}) — saved on the gateway under ${rootDir}/${mediaNote}`;

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
        content: [{ type: "text" as const, text: summaryText }],
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

export const testing = {
  preValidateTarball,
  unpackTar,
  validateTarUncompressedBudget,
};
