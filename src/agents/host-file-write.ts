import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "../infra/errors.js";
import { captureAgentToolSourceExecutionGuard } from "./agent-tool-source-execution-guard.js";
import { expandOsHomePrefix } from "./sessions/tools/path-utils.js";

function resolveHostPath(filePath: string): string {
  return path.resolve(expandOsHomePrefix(filePath));
}

async function writeHostFileRange(
  handle: FileHandle,
  payload: Buffer,
  offset: number,
  length: number,
  position: number,
) {
  let written = 0;
  while (written < length) {
    const { bytesWritten } = await handle.write(
      payload,
      offset + written,
      length - written,
      position + written,
    );
    if (bytesWritten <= 0) {
      throw new Error(`host file write made no progress at byte ${position + written}`);
    }
    written += bytesWritten;
  }
}

async function readHostFilePrefix(handle: FileHandle, length: number) {
  const prefix = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const { bytesRead } = await handle.read(prefix, read, length - read, read);
    if (bytesRead <= 0) {
      throw new Error(`host file read made no progress at byte ${read}`);
    }
    read += bytesRead;
  }
  return prefix;
}

async function overwriteHostFileInPlace(
  handle: FileHandle,
  payload: Buffer,
  currentSize: number,
  assertCurrent: () => void,
) {
  const prefixLength = Math.min(payload.length, currentSize);
  const originalPrefix = await readHostFilePrefix(handle, prefixLength);
  // Prefix preparation may outlive the tool generation. Once mutation starts,
  // preserve the existing whole-write rollback boundary.
  assertCurrent();
  let prefixStarted = false;
  try {
    if (payload.length > currentSize) {
      await writeHostFileRange(
        handle,
        payload,
        currentSize,
        payload.length - currentSize,
        currentSize,
      );
    }
    prefixStarted = true;
    await writeHostFileRange(handle, payload, 0, prefixLength, 0);
    if (payload.length < currentSize) {
      await handle.truncate(payload.length);
    }
  } catch (error) {
    if (prefixStarted) {
      await writeHostFileRange(handle, originalPrefix, 0, prefixLength, 0).catch(() => undefined);
    }
    await handle.truncate(currentSize).catch(() => undefined);
    throw error;
  }
}

async function openHostFileForUpdate(resolved: string) {
  try {
    const existing = await fs.stat(resolved);
    // Rollback requires the original bytes; unreadable files must fail before mutation.
    return existing.isFile() ? await fs.open(resolved, "r+") : undefined;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  }
}

export async function writeHostFile(
  absolutePath: string,
  content: string,
  abortSignal?: AbortSignal,
) {
  const assertCurrent = captureAgentToolSourceExecutionGuard(abortSignal);
  const resolved = resolveHostPath(absolutePath);
  assertCurrent();
  await fs.mkdir(path.dirname(resolved), { recursive: true });
  const handle = await openHostFileForUpdate(resolved);
  if (!handle) {
    assertCurrent();
    await fs.writeFile(resolved, content, "utf-8");
    return;
  }
  try {
    const stat = await handle.stat();
    await overwriteHostFileInPlace(handle, Buffer.from(content, "utf-8"), stat.size, assertCurrent);
  } finally {
    await handle.close().catch(() => undefined);
  }
}
