import path from "node:path";
import { isPathStrictlyInside, root } from "openclaw/plugin-sdk/file-access-runtime";
import { getMediaDir } from "openclaw/plugin-sdk/media-runtime";
import { saveMediaBuffer } from "openclaw/plugin-sdk/media-store";
import type { CodexCommandExecParams, CodexCommandExecResponse } from "./command-exec-protocol.js";
import {
  isCodexPassThroughMediaSource,
  mapCodexAppServerLocalWorkspacePath,
  mapCodexAppServerRemoteWorkspacePath,
} from "./remote-workspace-path.js";

const REMOTE_WORKSPACE_MEDIA_TIMEOUT_MS = 60_000;
const REMOTE_WORKSPACE_MEDIA_MAX_BYTES = 64 * 1024 * 1024;
const REMOTE_WORKSPACE_MEDIA_MAX_ATTACHMENTS = 16;
const CODEX_REMOTE_MEDIA_CHUNK_BYTES = 512 * 1024;
// codex_utils_pty's native 1 MiB default is also the only output cap supported
// by restricted Windows app-server commands.
const CODEX_REMOTE_COMMAND_DEFAULT_OUTPUT_BYTES = 1024 * 1024;

// Execute a fixed argv program, never a shell or model-provided script. Resolve
// Linux paths through the opened descriptor so a swapped parent cannot escape
// the workspace; every chunk binds to the same capped filesystem identity.
const CODEX_BOUNDED_REMOTE_FILE_READER = [
  "try{",
  'const fs=require("node:fs");',
  'const path=require("node:path");',
  "const file=process.argv[1];",
  "const max=Number(process.argv[2]);",
  "const offset=Number(process.argv[3]);",
  "const chunk=Number(process.argv[4]);",
  "const workspace=process.argv[5];",
  'if(!Number.isSafeInteger(max)||max<0)throw Error("invalid media byte limit");',
  'if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(chunk)||chunk<=0)throw Error("invalid media chunk");',
  'if(fs.lstatSync(file).isSymbolicLink())throw Error("symbolic links are not allowed");',
  "const noFollow=fs.constants.O_NOFOLLOW??0;",
  "const fd=fs.openSync(file,fs.constants.O_RDONLY|noFollow);",
  "try{",
  "const before=fs.fstatSync(fd);",
  'if(!before.isFile())throw Error("not a regular file");',
  "if(workspace){",
  'const descriptor=process.platform==="linux"?fs.realpathSync(`/proc/self/fd/${fd}`):fs.realpathSync(file);',
  "const relative=path.relative(fs.realpathSync(workspace),descriptor);",
  'if(!relative||relative===".."||relative.startsWith(`..${path.sep}`)||path.isAbsolute(relative))throw Error("file escapes remote workspace");',
  "const verified=fs.statSync(descriptor);",
  'if(verified.dev!==before.dev||verified.ino!==before.ino)throw Error("file changed while being opened");',
  "}",
  "if(before.size>max)throw Error(`file exceeds limit of ${max} bytes`);",
  'if(offset>before.size)throw Error("file changed while being read");',
  "const expected=Math.min(chunk,before.size-offset);",
  "const buffer=Buffer.allocUnsafe(expected);",
  "let total=0;",
  "while(total<buffer.length){",
  "const count=fs.readSync(fd,buffer,total,buffer.length-total,offset+total);",
  "if(count===0)break;total+=count;",
  "}",
  'if(total!==expected)throw Error("file changed while being read");',
  "const after=fs.fstatSync(fd);",
  'const revision=stat=>[stat.dev,stat.ino,stat.size,stat.mtimeMs,stat.ctimeMs].join(":");',
  'if(!after.isFile()||revision(after)!==revision(before))throw Error("file changed while being read");',
  'process.stdout.write(JSON.stringify({dataBase64:buffer.toString("base64"),size:before.size,revision:revision(before)}));',
  "}finally{fs.closeSync(fd)}",
  "}catch(error){process.stderr.write(error instanceof Error?error.message:String(error));process.exitCode=1}",
].join("");

const MESSAGE_MEDIA_KEYS = [
  "media",
  "mediaUrl",
  "media_url",
  "path",
  "filePath",
  "fileUrl",
  "imageUrl",
  "image_url",
] as const;
const MESSAGE_MEDIA_ARRAY_KEYS = ["mediaUrls", "media_urls", "imageUrls", "image_urls"] as const;
const ATTACHMENT_MEDIA_KEYS = ["media", "mediaUrl", "path", "filePath", "fileUrl", "url"] as const;

type CodexRemoteWorkspaceFileResponse = {
  dataBase64: string;
};

export type CodexRemoteWorkspaceFileReader = (params: {
  path: string;
  maxBytes: number;
  workspaceRoot?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}) => Promise<CodexRemoteWorkspaceFileResponse>;

type CodexBoundedRemoteCommandClient = {
  request: (
    method: "command/exec",
    params: CodexCommandExecParams,
    options: { signal?: AbortSignal; timeoutMs?: number },
  ) => Promise<CodexCommandExecResponse>;
};

/** Reads actual remote bytes with a cap enforced by Codex before transport. */
export async function readBoundedCodexRemoteWorkspaceFile(params: {
  client: CodexBoundedRemoteCommandClient;
  path: string;
  maxBytes: number;
  workspaceRoot?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<CodexRemoteWorkspaceFileResponse> {
  if (!Number.isSafeInteger(params.maxBytes) || params.maxBytes < 0) {
    throw new Error("Codex remote workspace upload requires a valid media byte limit.");
  }
  params.signal?.throwIfAborted();
  const chunks: Buffer[] = [];
  let offset = 0;
  let expectedSize: number | undefined;
  let expectedRevision: string | undefined;
  const startedAt = Date.now();

  do {
    params.signal?.throwIfAborted();
    const timeoutMs =
      params.timeoutMs === undefined ? undefined : params.timeoutMs - (Date.now() - startedAt);
    if (timeoutMs !== undefined && timeoutMs <= 0) {
      throw new Error("Codex remote workspace file transfer timed out.");
    }
    let response: CodexCommandExecResponse;
    try {
      response = await params.client.request(
        "command/exec",
        {
          command: [
            "node",
            "-e",
            CODEX_BOUNDED_REMOTE_FILE_READER,
            "--",
            params.path,
            String(params.maxBytes),
            String(offset),
            String(CODEX_REMOTE_MEDIA_CHUNK_BYTES),
            ...(params.workspaceRoot ? [params.workspaceRoot] : []),
          ],
          // Prevent inherited Node preload hooks from changing the fixed reader.
          env: { NODE_OPTIONS: null, NODE_PATH: null },
          ...(timeoutMs === undefined ? {} : { timeoutMs }),
        },
        { signal: params.signal, timeoutMs },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        /failed to spawn|executable.*not found|\bENOENT\b/iu.test(error.message)
      ) {
        throw new Error(
          "Codex remote workspace file transfer requires Node.js on the remote app-server host.",
          { cause: error },
        );
      }
      throw error;
    }
    if (!response || response.exitCode !== 0) {
      const detail = typeof response?.stderr === "string" ? response.stderr.trim() : "";
      throw new Error(
        `Codex remote workspace artifact could not be read: ${params.path}${detail ? `: ${detail}` : ""}`,
      );
    }
    if (
      typeof response.stdout !== "string" ||
      response.stdout.length > CODEX_REMOTE_COMMAND_DEFAULT_OUTPUT_BYTES
    ) {
      throw new Error("Codex remote workspace artifact exceeded the native command output cap.");
    }
    let payload: unknown;
    try {
      payload = JSON.parse(response.stdout);
    } catch {
      throw new Error("Codex remote workspace artifact returned invalid chunk data.");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      throw new Error("Codex remote workspace artifact returned invalid chunk data.");
    }
    const chunk = payload as { dataBase64?: unknown; size?: unknown; revision?: unknown };
    if (
      typeof chunk.dataBase64 !== "string" ||
      !Number.isSafeInteger(chunk.size) ||
      (chunk.size as number) < 0 ||
      (chunk.size as number) > params.maxBytes ||
      typeof chunk.revision !== "string" ||
      !chunk.revision
    ) {
      throw new Error("Codex remote workspace artifact returned invalid or oversized chunk data.");
    }
    if (expectedSize === undefined) {
      expectedSize = chunk.size as number;
      expectedRevision = chunk.revision;
    }
    if (chunk.size !== expectedSize || chunk.revision !== expectedRevision) {
      throw new Error("Codex remote workspace artifact changed during chunked transfer.");
    }
    const remainingBytes = expectedSize - offset;
    const expectedChunkBytes = Math.min(CODEX_REMOTE_MEDIA_CHUNK_BYTES, remainingBytes);
    if (chunk.dataBase64.length > Math.ceil(expectedChunkBytes / 3) * 4) {
      throw new Error("Codex remote workspace artifact returned oversized chunk data.");
    }
    const buffer = Buffer.from(chunk.dataBase64, "base64");
    if (
      buffer.byteLength !== expectedChunkBytes ||
      buffer.toString("base64") !== chunk.dataBase64
    ) {
      throw new Error("Codex remote workspace artifact returned invalid chunk data.");
    }
    chunks.push(buffer);
    offset += buffer.byteLength;
  } while (offset < (expectedSize ?? 0));

  return { dataBase64: Buffer.concat(chunks, offset).toString("base64") };
}

/** Stages authoritative bounded remote bytes into immutable Gateway-owned media. */
export async function prepareCodexRemoteWorkspaceMessageMedia(params: {
  args: Record<string, unknown>;
  localWorkspaceRoot?: string;
  remoteWorkspaceRoot?: string;
  readRemoteFile?: CodexRemoteWorkspaceFileReader;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
}): Promise<Record<string, unknown>> {
  const { localWorkspaceRoot, remoteWorkspaceRoot } = params;
  if (!localWorkspaceRoot || !remoteWorkspaceRoot) {
    return params.args;
  }

  const remotePathsByLocalPath = new Map<string, string>();
  const gatewayManagedPaths = new Set<string>();
  const gatewayMediaRoot = getMediaDir();
  let attachmentEntries = 0;
  const mapMediaPath = (value: unknown): unknown => {
    if (typeof value !== "string") {
      return value;
    }
    if (path.isAbsolute(value) && isPathStrictlyInside(gatewayMediaRoot, value)) {
      attachmentEntries += 1;
      gatewayManagedPaths.add(value);
      return value;
    }
    const mapped = mapCodexAppServerLocalWorkspacePath({
      value,
      localWorkspaceRoot,
      remoteWorkspaceRoot,
    });
    if (value.trim() && !isCodexPassThroughMediaSource(value)) {
      attachmentEntries += 1;
      remotePathsByLocalPath.set(
        mapped,
        mapCodexAppServerRemoteWorkspacePath({
          value: mapped,
          localWorkspaceRoot,
          remoteWorkspaceRoot,
        }),
      );
    }
    return mapped;
  };

  let mappedArgs = params.args;
  const setMappedValue = (key: string, value: unknown) => {
    if (value === params.args[key]) {
      return;
    }
    if (mappedArgs === params.args) {
      mappedArgs = { ...params.args };
    }
    mappedArgs[key] = value;
  };

  for (const key of MESSAGE_MEDIA_KEYS) {
    setMappedValue(key, mapMediaPath(params.args[key]));
  }
  for (const key of MESSAGE_MEDIA_ARRAY_KEYS) {
    const value = params.args[key];
    if (Array.isArray(value)) {
      const mapped = value.map(mapMediaPath);
      if (mapped.some((entry, index) => entry !== value[index])) {
        setMappedValue(key, mapped);
      }
    }
  }
  if (Array.isArray(params.args.attachments)) {
    const attachments = params.args.attachments;
    const mapped = attachments.map((attachment) => {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        return attachment;
      }
      const record = attachment as Record<string, unknown>;
      let mappedAttachment = record;
      for (const key of ATTACHMENT_MEDIA_KEYS) {
        const value = mapMediaPath(record[key]);
        if (value !== record[key]) {
          if (mappedAttachment === record) {
            mappedAttachment = { ...record };
          }
          mappedAttachment[key] = value;
        }
      }
      return mappedAttachment;
    });
    if (mapped.some((attachment, index) => attachment !== attachments[index])) {
      setMappedValue("attachments", mapped);
    }
  }

  if (attachmentEntries > REMOTE_WORKSPACE_MEDIA_MAX_ATTACHMENTS) {
    throw new Error(
      `Codex remote workspace upload exceeds the ${REMOTE_WORKSPACE_MEDIA_MAX_ATTACHMENTS}-attachment limit.`,
    );
  }
  for (const managedPath of gatewayManagedPaths) {
    await assertGatewayManagedMediaPath(managedPath, gatewayMediaRoot);
  }
  if (remotePathsByLocalPath.size === 0) {
    return mappedArgs;
  }
  const readRemoteFile = params.readRemoteFile;
  if (!readRemoteFile) {
    throw new Error("Codex remote workspace file transfer requires an active app-server client.");
  }

  const maxBytes = params.maxBytes ?? REMOTE_WORKSPACE_MEDIA_MAX_BYTES;
  const timeoutMs = params.timeoutMs ?? REMOTE_WORKSPACE_MEDIA_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const stagedPaths = new Map<string, string>();
  let totalBytes = 0;
  // Read the authoritative remote descriptor, not an unverified synchronized
  // path. The native command caps allocation and output before bytes travel.
  for (const [localPath, remotePath] of remotePathsByLocalPath) {
    params.signal?.throwIfAborted();
    const remainingBytes = maxBytes - totalBytes;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error("Codex remote workspace attachment batch timed out.");
    }
    const response = await readRemoteFile({
      path: remotePath,
      maxBytes: remainingBytes,
      workspaceRoot: remoteWorkspaceRoot,
      signal: params.signal,
      timeoutMs: remainingMs,
    });
    if (!response || typeof response.dataBase64 !== "string") {
      throw new Error(`Codex remote workspace artifact returned no file data: ${remotePath}`);
    }
    if (response.dataBase64.length > Math.ceil(remainingBytes / 3) * 4) {
      throw new Error(
        `Codex remote workspace artifact exceeds the limit of ${remainingBytes} bytes.`,
      );
    }
    const remoteBuffer = Buffer.from(response.dataBase64, "base64");
    if (
      remoteBuffer.byteLength > remainingBytes ||
      remoteBuffer.toString("base64") !== response.dataBase64
    ) {
      throw new Error(
        `Codex remote workspace artifact returned invalid or oversized file data: ${remotePath}`,
      );
    }
    totalBytes += remoteBuffer.byteLength;
    const saved = await saveMediaBuffer(
      remoteBuffer,
      undefined,
      "outbound",
      maxBytes,
      path.basename(remotePath),
    );
    stagedPaths.set(localPath, saved.path);
  }
  return mapMessageMediaValues(mappedArgs, (value) => stagedPaths.get(value) ?? value);
}

async function assertGatewayManagedMediaPath(value: string, mediaRoot: string): Promise<void> {
  const media = await root(mediaRoot, { symlinks: "reject" });
  const opened = await media.open(path.relative(mediaRoot, value), { symlinks: "reject" });
  try {
    if (!(await opened.handle.stat()).isFile()) {
      throw new Error(`Codex Gateway-managed media is not a regular file: ${value}`);
    }
  } finally {
    await opened[Symbol.asyncDispose]();
  }
}

function mapMessageMediaValues(
  args: Record<string, unknown>,
  mapValue: (value: string) => string,
): Record<string, unknown> {
  const mapped = { ...args };
  for (const key of MESSAGE_MEDIA_KEYS) {
    const value = mapped[key];
    if (typeof value === "string") {
      mapped[key] = mapValue(value);
    }
  }
  for (const key of MESSAGE_MEDIA_ARRAY_KEYS) {
    const value = mapped[key];
    if (Array.isArray(value)) {
      mapped[key] = value.map((entry) => (typeof entry === "string" ? mapValue(entry) : entry));
    }
  }
  if (Array.isArray(mapped.attachments)) {
    mapped.attachments = mapped.attachments.map((attachment) => {
      if (!attachment || typeof attachment !== "object" || Array.isArray(attachment)) {
        return attachment;
      }
      const record = { ...(attachment as Record<string, unknown>) };
      for (const key of ATTACHMENT_MEDIA_KEYS) {
        const value = record[key];
        if (typeof value === "string") {
          record[key] = mapValue(value);
        }
      }
      return record;
    });
  }
  return mapped;
}
