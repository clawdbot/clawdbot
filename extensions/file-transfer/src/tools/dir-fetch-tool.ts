import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import {
  callGatewayTool,
  listNodes,
  resolveNodeIdFromList,
  type AnyAgentTool,
  type NodeListNode,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import { Type } from "typebox";
import { appendFileTransferAudit } from "../shared/audit.js";
import { throwFromNodePayload } from "../shared/errors.js";
import { IMAGE_MIME_INLINE_SET, mimeFromExtension } from "../shared/mime.js";
import {
  humanSize,
  readBoolean,
  readClampedInt,
  readGatewayCallOptions,
  readTrimmedString,
} from "../shared/params.js";

const DIR_FETCH_DEFAULT_MAX_BYTES = 8 * 1024 * 1024;
const DIR_FETCH_HARD_MAX_BYTES = 16 * 1024 * 1024;
const FILE_TRANSFER_SUBDIR = "file-transfer";

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

// Hard caps on uncompressed extraction. Defends against decompression-bomb
// archives that compress to <16MB but expand to gigabytes. Both caps are
// enforced during the post-extract walk: total bytes summed across entries
// and per-file size to bound any single fs.stat / hash operation.
const DIR_FETCH_MAX_UNCOMPRESSED_BYTES = 64 * 1024 * 1024;
const DIR_FETCH_MAX_SINGLE_FILE_BYTES = 16 * 1024 * 1024;

const DirFetchToolSchema = Type.Object({
  node: Type.String({
    description: "Node id, name, or IP. Resolves the same way as the nodes tool.",
  }),
  path: Type.String({
    description: "Absolute path to the directory on the node to fetch. Canonicalized server-side.",
  }),
  maxBytes: Type.Optional(
    Type.Number({
      description:
        "Max gzipped tarball bytes to fetch. Default 8 MB, hard ceiling 16 MB (single round-trip).",
    }),
  ),
  includeDotfiles: Type.Optional(
    Type.Boolean({
      description: "Reserved for v2; currently always includes dotfiles (v1 quirk in BSD tar).",
    }),
  ),
  gatewayUrl: Type.Optional(Type.String()),
  gatewayToken: Type.Optional(Type.String()),
  timeoutMs: Type.Optional(Type.Number()),
});

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
  return new Promise((resolve) => {
    const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
    const child = spawn(tarBin, ["-tzf", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const watchdog = setTimeout(() => {
      aborted = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve({ ok: false, reason: "tar -tzf timed out" });
    }, 30_000);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
      if (stdout.length > 32 * 1024 * 1024) {
        aborted = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
        clearTimeout(watchdog);
        resolve({ ok: false, reason: "tar -tzf output too large" });
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (aborted) {
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, reason: `tar -tzf exited ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      // tar -tf emits one path per line with literal newlines as record
      // separators. Filenames containing newlines are exotic enough that
      // refusing them is safer than trying to parse around them.
      const paths = stdout.split("\n").filter((l) => l.length > 0);
      resolve({ ok: true, paths });
    });
    child.on("error", (e) => {
      clearTimeout(watchdog);
      if (!aborted) {
        resolve({ ok: false, reason: `tar -tzf error: ${String(e)}` });
      }
    });
    child.stdin.end(tarBuffer);
  });
}

async function listTarTypeChars(
  tarBuffer: Buffer,
): Promise<{ ok: true; typeChars: string[] } | { ok: false; reason: string }> {
  return new Promise((resolve) => {
    const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
    const child = spawn(tarBin, ["-tzvf", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let aborted = false;
    const watchdog = setTimeout(() => {
      aborted = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      resolve({ ok: false, reason: "tar -tzvf timed out" });
    }, 30_000);
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString();
      if (stdout.length > 32 * 1024 * 1024) {
        aborted = true;
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
        clearTimeout(watchdog);
        resolve({ ok: false, reason: "tar -tzvf output too large" });
      }
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (aborted) {
        return;
      }
      if (code !== 0) {
        resolve({ ok: false, reason: `tar -tzvf exited ${code}: ${stderr.slice(0, 200)}` });
        return;
      }
      // Take only the first character of each line — the entry type.
      // We don't touch the rest of the line (path/size/etc) so filenames
      // with whitespace can't shift our parser.
      const typeChars = stdout
        .split("\n")
        .filter((l) => l.length > 0)
        .map((l) => l.charAt(0));
      resolve({ ok: true, typeChars });
    });
    child.on("error", (e) => {
      clearTimeout(watchdog);
      if (!aborted) {
        resolve({ ok: false, reason: `tar -tzvf error: ${String(e)}` });
      }
    });
    child.stdin.end(tarBuffer);
  });
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

  for (let i = 0; i < paths.length; i++) {
    const entryPath = paths[i];
    const t = typeChars[i];
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
  return new Promise((resolve) => {
    const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
    const child = spawn(tarBin, ["-xOzf", "-"], { stdio: ["pipe", "pipe", "pipe"] });
    let totalBytes = 0;
    let stderr = "";
    let settled = false;
    let watchdog: ReturnType<typeof setTimeout>;
    const finish = (result: { ok: true } | { ok: false; reason: string }): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(watchdog);
      resolve(result);
    };
    watchdog = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
      finish({ ok: false, reason: "tar uncompressed budget validation timed out" });
    }, TAR_UNPACK_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > maxBytes) {
        try {
          child.kill("SIGKILL");
        } catch {
          /* gone */
        }
        finish({
          ok: false,
          reason: `archive expands past uncompressed budget ${maxBytes} bytes`,
        });
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
      if (stderr.length > 4096) {
        stderr = stderr.slice(-4096);
      }
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        finish({
          ok: false,
          reason: `tar uncompressed budget validation exited ${code}: ${stderr.slice(0, 200)}`,
        });
        return;
      }
      finish({ ok: true });
    });
    child.on("error", (error) => {
      finish({
        ok: false,
        reason: `tar uncompressed budget validation error: ${String(error)}`,
      });
    });
    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (settled && error.code === "EPIPE") {
        return;
      }
      finish({
        ok: false,
        reason: `tar uncompressed budget validation input error: ${String(error)}`,
      });
    });
    child.stdin.end(tarBuffer);
  });
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
  return new Promise((resolve, reject) => {
    const tarBin = process.platform !== "win32" ? "/usr/bin/tar" : "tar";
    const child = spawn(
      tarBin,
      ["-xzf", "-", "-C", destDir, "--no-same-owner", "--no-same-permissions"],
      {
        stdio: ["pipe", "ignore", "pipe"],
      },
    );
    let stderrOut = "";
    const watchdog = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
      reject(new Error(`tar unpack timed out after ${TAR_UNPACK_TIMEOUT_MS}ms`));
    }, TAR_UNPACK_TIMEOUT_MS);
    child.stderr.on("data", (chunk: Buffer) => {
      stderrOut += chunk.toString();
    });
    child.on("close", (code) => {
      clearTimeout(watchdog);
      if (code !== 0) {
        reject(new Error(`tar unpack exited ${code}: ${stderrOut.slice(0, 300)}`));
        return;
      }
      resolve();
    });
    child.on("error", (e) => {
      clearTimeout(watchdog);
      reject(e);
    });
    child.stdin.end(tarBuffer);
  });
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
    label: "Directory Fetch",
    name: "dir_fetch",
    description:
      "Retrieve a directory tree from a paired node as a gzipped tarball, unpack it on the gateway, and return a manifest of saved paths. Use to pull source trees, asset folders, or log directories in a single round-trip. The unpacked files live on the GATEWAY (not your local machine); pass localPath into other tools or use file_fetch on individual entries to ship them elsewhere. Rejects trees larger than 16 MB compressed. Requires operator opt-in: gateway.nodes.allowCommands must include 'dir.fetch' AND plugins.entries.file-transfer.config.nodes.<node>.allowReadPaths must match the directory path.",
    parameters: DirFetchToolSchema,
    execute: async (_toolCallId, args) => {
      const params = args as Record<string, unknown>;
      const node = readTrimmedString(params, "node");
      const dirPath = readTrimmedString(params, "path");
      if (!node) {
        throw new Error("node required");
      }
      if (!dirPath) {
        throw new Error("path required");
      }

      const maxBytes = readClampedInt({
        input: params,
        key: "maxBytes",
        defaultValue: DIR_FETCH_DEFAULT_MAX_BYTES,
        hardMin: 1,
        hardMax: DIR_FETCH_HARD_MAX_BYTES,
      });
      const includeDotfiles = readBoolean(params, "includeDotfiles", false);

      const gatewayOpts = readGatewayCallOptions(params);
      const nodes: NodeListNode[] = await listNodes(gatewayOpts);
      const nodeId = resolveNodeIdFromList(nodes, node, false);
      const nodeMeta = nodes.find((n) => n.nodeId === nodeId);
      const nodeDisplayName = nodeMeta?.displayName ?? node;
      const startedAt = Date.now();

      const raw = await callGatewayTool<{ payload: unknown }>("node.invoke", gatewayOpts, {
        nodeId,
        command: "dir.fetch",
        params: {
          path: dirPath,
          maxBytes,
          includeDotfiles,
        },
        idempotencyKey: crypto.randomUUID(),
      });

      const payload =
        raw?.payload && typeof raw.payload === "object" && !Array.isArray(raw.payload)
          ? (raw.payload as Record<string, unknown>)
          : null;
      if (!payload) {
        await appendFileTransferAudit({
          op: "dir.fetch",
          nodeId,
          nodeDisplayName,
          requestedPath: dirPath,
          decision: "error",
          errorMessage: "invalid payload",
          durationMs: Date.now() - startedAt,
        });
        throw new Error("invalid dir.fetch payload");
      }
      if (payload.ok === false) {
        await appendFileTransferAudit({
          op: "dir.fetch",
          nodeId,
          nodeDisplayName,
          requestedPath: dirPath,
          canonicalPath:
            typeof payload.canonicalPath === "string" ? payload.canonicalPath : undefined,
          decision: "error",
          errorCode: typeof payload.code === "string" ? payload.code : undefined,
          errorMessage: typeof payload.message === "string" ? payload.message : undefined,
          durationMs: Date.now() - startedAt,
        });
        throwFromNodePayload("dir.fetch", payload);
      }

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
        let size = 0;
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
