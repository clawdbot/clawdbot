/**
 * Implements filesystem JSON-RPC handlers for the Codex sandbox exec-server
 * with OpenClaw sandbox policy checks before every bridge operation.
 */
import { posix as pathPosix } from "node:path";
import type { SandboxFsStat } from "openclaw/plugin-sdk/sandbox";
import type { JsonObject, JsonValue } from "../protocol.js";
import {
  assertFsSandboxAccess,
  assertNoReadOnlyDescendant,
  assertResolvedFsSandboxAccess,
  joinSandboxChildPath,
  normalizeSandboxAbsolutePath,
  pathContains,
  resolveFsSandboxPolicy,
} from "./fs-policy.js";
import {
  JSON_RPC_NOT_FOUND,
  JsonRpcProtocolError,
  requireBase64String,
  requireNumber,
  requireObject,
  requireString,
} from "./json-rpc.js";
import { resolveExecServerPath } from "./path-uri.js";
import type { DirectoryEntry, OpenClawExecServer, ResolvedFsSandboxPolicy } from "./types.js";

const CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES = 512 * 1024 * 1024;
const CODEX_SANDBOX_EXEC_SERVER_MAX_OPEN_FILE_READS = 128;
const CODEX_SANDBOX_EXEC_SERVER_MAX_BUFFERED_FILE_READ_BYTES = 64 * 1024 * 1024;
const CODEX_SANDBOX_EXEC_SERVER_MAX_READ_BLOCK_BYTES = 1024 * 1024;
const CODEX_SANDBOX_EXEC_SERVER_MAX_FILE_READ_HANDLE_ID_BYTES = 32;

type CodexSandboxFileReadHandle = {
  abortController: AbortController;
  closeRequested: boolean;
  reservedBytes: number;
  data?: Buffer;
};

/** Sandboxed file contents and pending reservations owned by one connection. */
export type CodexSandboxFileReadHandles = Map<string, CodexSandboxFileReadHandle> & {
  closed?: boolean;
};

/** Opens a policy-checked sandbox file under a bounded, connection-owned handle. */
export async function openFile(
  execServer: OpenClawExecServer,
  handles: CodexSandboxFileReadHandles,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "fs/open params");
  const handleId = requireFileReadHandleId(record.handleId);
  if (handles.closed) {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, `unknown file read handle \`${handleId}\``);
  }
  if (handles.has(handleId)) {
    throw new JsonRpcProtocolError(-32600, `file read handle \`${handleId}\` already exists`);
  }
  if (handles.size >= CODEX_SANDBOX_EXEC_SERVER_MAX_OPEN_FILE_READS) {
    throw new JsonRpcProtocolError(
      -32600,
      `at most ${CODEX_SANDBOX_EXEC_SERVER_MAX_OPEN_FILE_READS} file reads may be open per connection`,
    );
  }

  const filePath = resolveExecServerPath(requireString(record.path, "path"), "read path");
  assertFsSandboxAccess(execServer, record, [{ path: filePath, access: "read" }]);
  const fsBridge = execServer.fsBridge;
  // Claim the handle before even stat so slow or cancelled stats cannot bypass
  // the connection's handle cap or lose their cancellation and ownership.
  const handle: CodexSandboxFileReadHandle = {
    abortController: new AbortController(),
    closeRequested: false,
    reservedBytes: 0,
  };
  handles.set(handleId, handle);
  try {
    const stat = await fsBridge.stat({ filePath, signal: handle.abortController.signal });
    if (handles.get(handleId) !== handle || handle.closeRequested || handles.closed) {
      throw new JsonRpcProtocolError(
        JSON_RPC_NOT_FOUND,
        `unknown file read handle \`${handleId}\``,
      );
    }
    if (!stat) {
      throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
    }
    if (stat.type !== "file") {
      throw new JsonRpcProtocolError(-32600, "file read handle requires a regular file");
    }
    if (!Number.isSafeInteger(stat.size) || stat.size < 0) {
      throw new JsonRpcProtocolError(-32600, "file size must be a non-negative safe integer");
    }
    if (
      stat.size >
      CODEX_SANDBOX_EXEC_SERVER_MAX_BUFFERED_FILE_READ_BYTES - bufferedFileReadBytes(handles)
    ) {
      throw new JsonRpcProtocolError(
        -32600,
        "sandbox file read exceeds the per-connection buffered file limit",
      );
    }
    // Charge actual bytes before awaiting the bounded read; concurrent stats
    // cannot overbook memory, even when a backend ignores cancellation.
    handle.reservedBytes = stat.size;
    const data = await fsBridge.readFile({
      filePath,
      maxBytes: handle.reservedBytes,
      signal: handle.abortController.signal,
    });
    if (handles.get(handleId) !== handle || handle.closeRequested || handles.closed) {
      throw new JsonRpcProtocolError(
        JSON_RPC_NOT_FOUND,
        `unknown file read handle \`${handleId}\``,
      );
    }
    if (data.byteLength > handle.reservedBytes) {
      throw new JsonRpcProtocolError(
        -32600,
        "sandbox file read exceeds the per-connection buffered file limit",
      );
    }
    handle.reservedBytes = data.byteLength;
    handle.data = data;
    return { handleId };
  } catch (error) {
    if (handles.get(handleId) === handle) {
      handles.delete(handleId);
    }
    throw error;
  }
}

/** Reads a bounded base64 block from a handle belonging to this connection. */
export function readFileBlock(
  handles: CodexSandboxFileReadHandles,
  params: JsonValue | undefined,
): JsonObject {
  const record = requireObject(params, "fs/readBlock params");
  const handleId = requireFileReadHandleId(record.handleId);
  const handle = handles.get(handleId);
  if (!handle?.data) {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, `unknown file read handle \`${handleId}\``);
  }
  const offset = requireNumber(record.offset, "offset");
  const length = requireNumber(record.len, "len");
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new JsonRpcProtocolError(-32600, "file read offset must be a non-negative safe integer");
  }
  if (
    !Number.isSafeInteger(length) ||
    length < 1 ||
    length > CODEX_SANDBOX_EXEC_SERVER_MAX_READ_BLOCK_BYTES
  ) {
    throw new JsonRpcProtocolError(
      -32600,
      `file read block length must be between 1 and ${CODEX_SANDBOX_EXEC_SERVER_MAX_READ_BLOCK_BYTES}`,
    );
  }
  const chunk = handle.data.subarray(offset, Math.min(offset + length, handle.data.byteLength));
  // The complete buffered file makes exactly filled final blocks terminal without another RPC.
  return {
    chunk: chunk.toString("base64"),
    eof: offset + chunk.byteLength >= handle.data.byteLength,
  };
}

/** Closes one connection-owned file handle; repeated closes are harmless. */
export function closeFile(
  handles: CodexSandboxFileReadHandles,
  params: JsonValue | undefined,
): JsonObject {
  const record = requireObject(params, "fs/close params");
  closeFileReadHandle(handles, requireFileReadHandleId(record.handleId));
  return {};
}

/** Cancels a disconnected socket without releasing unsettled read reservations. */
export function closeAllFileReads(handles: CodexSandboxFileReadHandles): void {
  handles.closed = true;
  for (const handleId of handles.keys()) {
    closeFileReadHandle(handles, handleId);
  }
}

function closeFileReadHandle(handles: CodexSandboxFileReadHandles, handleId: string): void {
  const handle = handles.get(handleId);
  if (!handle) {
    return;
  }
  handle.closeRequested = true;
  if (handle.data !== undefined) {
    handles.delete(handleId);
    return;
  }
  // A backend may not honor abort; retain its reservation until readFile settles.
  handle.abortController.abort();
}

function bufferedFileReadBytes(handles: CodexSandboxFileReadHandles): number {
  let total = 0;
  for (const handle of handles.values()) {
    total += handle.reservedBytes;
  }
  return total;
}

function requireFileReadHandleId(value: unknown): string {
  const handleId = requireString(value, "handleId");
  if (
    Buffer.byteLength(handleId, "utf8") > CODEX_SANDBOX_EXEC_SERVER_MAX_FILE_READ_HANDLE_ID_BYTES
  ) {
    throw new JsonRpcProtocolError(
      -32600,
      `file read handle ID must not exceed ${CODEX_SANDBOX_EXEC_SERVER_MAX_FILE_READ_HANDLE_ID_BYTES} bytes`,
    );
  }
  return handleId;
}

/** Reads a sandbox file as base64 after read-policy and size checks. */
export async function readFile(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "fs/readFile params");
  const filePath = resolveExecServerPath(requireString(record.path, "path"), "read path");
  assertFsSandboxAccess(execServer, record, [{ path: filePath, access: "read" }]);
  const fsBridge = execServer.fsBridge;
  const stat = await fsBridge.stat({ filePath });
  if (!stat) {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
  }
  assertSandboxFileReadWithinLimit(stat);
  const data = await fsBridge.readFile({
    filePath,
    maxBytes: CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES,
  });
  return { dataBase64: data.toString("base64") };
}

/** Writes base64 data to an existing sandbox directory after write-policy checks. */
export async function writeFile(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<void> {
  const record = requireObject(params, "fs/writeFile params");
  const filePath = resolveExecServerPath(requireString(record.path, "path"), "write path");
  assertFsSandboxAccess(execServer, record, [{ path: filePath, access: "write" }]);
  const fsBridge = execServer.fsBridge;
  const parent = await fsBridge.stat({ filePath: pathPosix.dirname(filePath) });
  if (parent?.type !== "directory") {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "parent directory not found");
  }
  await fsBridge.writeFile({
    filePath,
    data: Buffer.from(requireBase64String(record.dataBase64, "dataBase64"), "base64"),
    mkdir: false,
  });
}

/** Creates a sandbox directory, respecting recursive and parent-directory semantics. */
export async function createDirectory(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<void> {
  const record = requireObject(params, "fs/createDirectory params");
  const filePath = resolveExecServerPath(
    requireString(record.path, "path"),
    "create-directory path",
  );
  assertFsSandboxAccess(execServer, record, [{ path: filePath, access: "write" }]);
  const fsBridge = execServer.fsBridge;
  if (record.recursive === false) {
    const parentPath = pathPosix.dirname(filePath);
    const parent = await fsBridge.stat({ filePath: parentPath });
    if (parent?.type !== "directory") {
      throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "parent directory not found");
    }
  }
  await fsBridge.mkdirp({
    filePath,
  });
}

/** Returns normalized metadata for a sandbox path. */
export async function getMetadata(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "fs/getMetadata params");
  const filePath = resolveExecServerPath(requireString(record.path, "path"), "metadata path");
  assertFsSandboxAccess(execServer, record, [{ path: filePath, access: "read" }]);
  const stat = await execServer.fsBridge.stat({
    filePath,
  });
  if (!stat) {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
  }
  return metadataResponse(stat);
}

/** Lists sandbox directory entries visible under the resolved filesystem policy. */
export async function readDirectory(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "fs/readDirectory params");
  const filePath = resolveExecServerPath(requireString(record.path, "path"), "read-directory path");
  const fsSandboxPolicy = resolveFsSandboxPolicy(execServer, record);
  return {
    entries: await listDirectoryEntries(execServer, filePath, fsSandboxPolicy),
  };
}

async function listDirectoryEntries(
  execServer: OpenClawExecServer,
  filePath: string,
  fsSandboxPolicy: ResolvedFsSandboxPolicy | undefined,
): Promise<DirectoryEntry[]> {
  assertResolvedFsSandboxAccess(fsSandboxPolicy, [{ path: filePath, access: "read" }]);
  const resolved = execServer.fsBridge.resolvePath({
    filePath,
  });
  if (!resolved) {
    throw new Error(`Cannot resolve sandbox path: ${filePath}`);
  }
  const result = await execServer.backend.runShellCommand({
    script:
      'find "$1" -mindepth 1 -maxdepth 1 -exec sh -c \'for path do name=${path##*/}; if [ -L "$path" ]; then kind=o; elif [ -d "$path" ]; then kind=d; elif [ -f "$path" ]; then kind=f; else kind=o; fi; printf "%s\\t%s\\n" "$kind" "$name"; done\' sh {} +',
    args: [resolved.containerPath],
    allowFailure: true,
  });
  if (result.code !== 0) {
    const stderr = result.stderr.toString("utf8").trim();
    throw new Error(stderr || `sandbox directory listing failed with code ${result.code}`);
  }
  const lines = result.stdout.toString("utf8").split("\n").filter(Boolean);
  return lines.map((line) => {
    const [kind = "o", fileName = ""] = line.split("\t");
    return {
      fileName,
      isDirectory: kind === "d",
      isFile: kind === "f",
    };
  });
}

/** Removes a sandbox path after rejecting writes outside policy or under read-only descendants. */
export async function removePath(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<void> {
  const record = requireObject(params, "fs/remove params");
  const filePath = resolveExecServerPath(requireString(record.path, "path"), "remove path");
  const fsSandboxPolicy = resolveFsSandboxPolicy(execServer, record);
  assertResolvedFsSandboxAccess(fsSandboxPolicy, [{ path: filePath, access: "write" }]);
  if (record.recursive !== false) {
    assertNoReadOnlyDescendant(fsSandboxPolicy, filePath, "remove");
  }
  await execServer.fsBridge.remove({
    filePath,
    recursive: record.recursive !== false,
    force: record.force !== false,
  });
}

/** Copies sandbox files or recursive directories while enforcing source and destination policy. */
export async function copyPath(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<void> {
  const record = requireObject(params, "fs/copy params");
  const sourcePath = resolveExecServerPath(
    requireString(record.sourcePath ?? record.source, "sourcePath"),
    "copy source path",
  );
  const destinationPath = resolveExecServerPath(
    requireString(record.destinationPath ?? record.destination, "destinationPath"),
    "copy destination path",
  );
  const fsSandboxPolicy = resolveFsSandboxPolicy(execServer, record);
  assertResolvedFsSandboxAccess(fsSandboxPolicy, [
    { path: sourcePath, access: "read" },
    { path: destinationPath, access: "write" },
  ]);
  await copySandboxPath(execServer, {
    sourcePath,
    destinationPath,
    recursive: record.recursive === true,
    fsSandboxPolicy,
  });
}

async function copySandboxPath(
  execServer: OpenClawExecServer,
  params: {
    sourcePath: string;
    destinationPath: string;
    recursive: boolean;
    fsSandboxPolicy: ResolvedFsSandboxPolicy | undefined;
  },
): Promise<void> {
  const fsBridge = execServer.fsBridge;
  assertResolvedFsSandboxAccess(params.fsSandboxPolicy, [
    { path: params.sourcePath, access: "read" },
    { path: params.destinationPath, access: "write" },
  ]);
  const sourceStat = await fsBridge.stat({ filePath: params.sourcePath });
  if (!sourceStat) {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
  }
  if (sourceStat?.type === "directory") {
    if (!params.recursive) {
      throw new Error(`Cannot copy directory without recursive=true: ${params.sourcePath}`);
    }
    if (
      pathContains(
        normalizeSandboxAbsolutePath(params.sourcePath, "copy source path"),
        normalizeSandboxAbsolutePath(params.destinationPath, "copy destination path"),
      )
    ) {
      throw new Error("Cannot recursively copy a directory into itself.");
    }
    await fsBridge.mkdirp({ filePath: params.destinationPath });
    for (const entry of await listDirectoryEntries(
      execServer,
      params.sourcePath,
      params.fsSandboxPolicy,
    )) {
      if (!entry.isDirectory && !entry.isFile) {
        throw new Error(`Cannot copy unsupported filesystem entry: ${entry.fileName}`);
      }
      await copySandboxPath(execServer, {
        sourcePath: joinSandboxChildPath(params.sourcePath, entry.fileName),
        destinationPath: joinSandboxChildPath(params.destinationPath, entry.fileName),
        recursive: true,
        fsSandboxPolicy: params.fsSandboxPolicy,
      });
    }
    return;
  }

  if (sourceStat.type === "file" && fsBridge.copyFile) {
    await fsBridge.copyFile({
      sourcePath: params.sourcePath,
      destinationPath: params.destinationPath,
      mkdir: true,
    });
    return;
  }

  // Shipped third-party bridges may not expose streaming copy yet. Keep their
  // buffered fallback bounded while built-in bridges use the path-native copy above.
  assertSandboxFileReadWithinLimit(sourceStat);
  const data = await fsBridge.readFile({
    filePath: params.sourcePath,
    maxBytes: CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES,
  });
  await fsBridge.writeFile({
    filePath: params.destinationPath,
    data,
    mkdir: true,
  });
}

function assertSandboxFileReadWithinLimit(stat: SandboxFsStat): void {
  if (stat.type === "file" && stat.size > CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES) {
    throw new Error(
      `file is too large to read through Codex sandbox exec-server: ${stat.size} bytes`,
    );
  }
}

function metadataResponse(stat: SandboxFsStat | null): JsonObject {
  return {
    isDirectory: stat?.type === "directory",
    isFile: stat?.type === "file",
    isSymlink: false,
    size: stat?.size ?? 0,
    createdAtMs: 0,
    modifiedAtMs: stat?.mtimeMs ?? 0,
  };
}
