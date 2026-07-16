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
  requireObject,
  requireString,
} from "./json-rpc.js";
import { resolveExecServerPath } from "./path-uri.js";
import { requireBackend, requireFsBridge } from "./runtime.js";
import type { DirectoryEntry, OpenClawExecServer, ResolvedFsSandboxPolicy } from "./types.js";

const CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES = 512 * 1024 * 1024;

/** Reads a sandbox file as base64 after read-policy and size checks. */
export async function readFile(
  execServer: OpenClawExecServer,
  params: JsonValue | undefined,
): Promise<JsonObject> {
  const record = requireObject(params, "fs/readFile params");
  const filePath = resolveExecServerPath(requireString(record.path, "path"), "read path");
  assertFsSandboxAccess(execServer, record, [{ path: filePath, access: "read" }]);
  const fsBridge = requireFsBridge(execServer);
  const stat = await fsBridge.stat({ filePath });
  if (!stat) {
    throw new JsonRpcProtocolError(JSON_RPC_NOT_FOUND, "file not found");
  }
  if (stat.type === "file" && stat.size > CODEX_SANDBOX_EXEC_SERVER_MAX_READ_FILE_BYTES) {
    throw new Error(
      `file is too large to read through Codex sandbox exec-server: ${stat.size} bytes`,
    );
  }
  const data = await fsBridge.readFile({
    filePath,
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
  const fsBridge = requireFsBridge(execServer);
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
  const fsBridge = requireFsBridge(execServer);
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
  const fsBridge = requireFsBridge(execServer);
  const stat = await fsBridge.stat({
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
  const fsBridge = requireFsBridge(execServer);
  const backend = requireBackend(execServer);
  const resolved = fsBridge.resolvePath({
    filePath,
  });
  if (!resolved) {
    throw new Error(`Cannot resolve sandbox path: ${filePath}`);
  }
  const result = await backend.runShellCommand({
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
  const fsBridge = requireFsBridge(execServer);
  await fsBridge.remove({
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
  const fsBridge = execServer.sandbox.fsBridge;
  if (!fsBridge) {
    throw new Error("Sandbox filesystem bridge is unavailable.");
  }
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

  const data = await fsBridge.readFile({ filePath: params.sourcePath });
  await fsBridge.writeFile({
    filePath: params.destinationPath,
    data,
    mkdir: true,
  });
}

function metadataResponse(stat: SandboxFsStat | null): JsonObject {
  return {
    isDirectory: stat?.type === "directory",
    isFile: stat?.type === "file",
    isSymlink: false,
    createdAtMs: 0,
    modifiedAtMs: stat?.mtimeMs ?? 0,
  };
}
