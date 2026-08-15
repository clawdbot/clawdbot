import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http, { type ClientRequest, type IncomingMessage } from "node:http";
import https from "node:https";
import path from "node:path";
import type { TLSSocket } from "node:tls";
import {
  MAX_WORKSPACE_MANIFEST_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "../gateway/worker-environments/workspace-inventory-limits.js";
import { parseWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { workerWorkspaceTransferPaths } from "../gateway/worker-environments/workspace-result-staging.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "../gateway/worker-environments/workspace-sync-scripts.js";
import { isPathInside } from "../infra/path-guards.js";
import { tempWorkspace } from "../infra/private-temp-workspace.js";
import { normalizeFingerprint } from "../infra/tls/fingerprint.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import {
  nodeWorkspaceTransferBlobPath,
  NodeWorkerWorkspaceTransferError,
  nodeWorkspaceTransferManifestPath,
  nodeWorkspaceTransferPackPath,
  nodeWorkspaceTransferReconcilePath,
  type NodeWorkerWorkspaceTransferInput,
} from "../worker/node-workspace-transfer-protocol.js";

const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const TRANSFER_RESULT_MAX_BYTES = 64 * 1024;
const validatedTlsSocketPins = new WeakMap<TLSSocket, string>();
const transferLog = createSubsystemLogger("node-host/worker-workspace");

function tlsPinMismatch(): NodeWorkerWorkspaceTransferError {
  return new NodeWorkerWorkspaceTransferError(
    "workspace-transfer-failed: gateway TLS fingerprint mismatch",
  );
}

function transferUrl(gatewayUrl: string, routePath: string): URL {
  const gateway = new URL(gatewayUrl);
  if (gateway.protocol !== "ws:" && gateway.protocol !== "wss:") {
    throw new Error("workspace transfer gateway must use WebSocket transport");
  }
  const url = new URL(gateway.toString());
  url.protocol = gateway.protocol === "wss:" ? "https:" : "http:";
  const basePath = gateway.pathname.replace(/\/$/u, "");
  url.pathname = `${basePath}${routePath}`;
  url.search = "";
  url.hash = "";
  if (url.host !== gateway.host) {
    throw new Error("workspace transfer endpoint must stay on the connected gateway host");
  }
  return url;
}

function waitForTlsPin(request: ClientRequest, expectedRaw?: string): Promise<void> {
  if (!expectedRaw?.trim()) {
    return Promise.resolve();
  }
  const expected = normalizeFingerprint(expectedRaw);
  if (!expected) {
    return Promise.reject(
      new NodeWorkerWorkspaceTransferError(
        "workspace-transfer-failed: gateway TLS fingerprint is invalid",
      ),
    );
  }
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    let tlsSocket: TLSSocket | undefined;
    let fail: (error: Error) => void = () => {};
    let verify: () => void = () => {};
    let bindSocket: (socket: import("node:net").Socket) => void = () => {};
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      request.off("error", fail);
      request.off("socket", bindSocket);
      tlsSocket?.off("secureConnect", verify);
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    };
    fail = (error: Error) => finish(error);
    request.once("error", fail);
    bindSocket = (socket) => {
      tlsSocket = socket as TLSSocket;
      const validated = validatedTlsSocketPins.get(tlsSocket);
      if (validated) {
        finish(validated === expected ? undefined : tlsPinMismatch());
        return;
      }
      verify = () => {
        const actual = normalizeFingerprint(tlsSocket!.getPeerCertificate().fingerprint256 ?? "");
        if (!actual || expected !== actual) {
          finish(tlsPinMismatch());
          return;
        }
        validatedTlsSocketPins.set(tlsSocket!, actual);
        finish();
      };
      // A pooled socket was verified when its secureConnect event completed.
      const peerFingerprint = tlsSocket.getPeerCertificate().fingerprint256;
      if (request.reusedSocket || peerFingerprint) {
        verify();
      } else {
        tlsSocket.once("secureConnect", verify);
      }
    };
    request.once("socket", bindSocket);
  });
}

async function openRequest(params: {
  gatewayUrl: string;
  tlsFingerprint?: string;
  routePath: string;
  method: "GET" | "POST";
  token: string;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  writeBody?: (request: ClientRequest) => Promise<void>;
}): Promise<IncomingMessage> {
  const url = transferUrl(params.gatewayUrl, params.routePath);
  const transport = url.protocol === "https:" ? https : http;
  // Keep the proxy-aware global transport, but require replacement sockets to expose a certificate.
  const request = transport.request(url, {
    method: params.method,
    headers: { authorization: `Bearer ${params.token}`, ...params.headers },
    signal: params.signal,
    ...(url.protocol === "https:" && params.tlsFingerprint
      ? { rejectUnauthorized: false, session: Buffer.alloc(0) }
      : {}),
  });
  const response = once(request, "response").then(([message]) => message as IncomingMessage);
  const send = async () => {
    if (url.protocol === "https:") {
      await waitForTlsPin(request, params.tlsFingerprint);
    }
    await params.writeBody?.(request);
    request.end();
  };
  void send().catch((error: unknown) =>
    request.destroy(error instanceof Error ? error : new Error(String(error))),
  );
  return await response;
}

async function readResponseBody(response: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const value of response) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    total += chunk.byteLength;
    if (total > maxBytes) {
      response.destroy(new Error("workspace transfer response exceeded its byte limit"));
      throw new Error("workspace transfer response exceeded its byte limit");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function requireOk(response: IncomingMessage): Promise<void> {
  if (response.statusCode === 200) {
    return;
  }
  const body = (await readResponseBody(response, TRANSFER_RESULT_MAX_BYTES)).toString("utf8");
  if (response.statusCode === 413 && body.includes("workspace_transfer_limit")) {
    throw new NodeWorkerWorkspaceTransferError(
      "workspace-transfer-limit: gateway rejected workspace transfer caps",
    );
  }
  throw new NodeWorkerWorkspaceTransferError(
    `workspace-transfer-failed: gateway returned ${response.statusCode ?? 0}`,
  );
}

async function downloadBuffer(params: Parameters<typeof openRequest>[0], maxBytes: number) {
  const response = await openRequest(params);
  await requireOk(response);
  return await readResponseBody(response, maxBytes);
}

async function downloadFile(params: {
  request: Parameters<typeof openRequest>[0];
  destination: string;
  expectedBytes?: number;
  expectedSha256?: string;
}): Promise<void> {
  const response = await openRequest(params.request);
  await requireOk(response);
  const output = fs.createWriteStream(params.destination, { flags: "wx", mode: 0o600 });
  const hash = createHash("sha256");
  let bytes = 0;
  try {
    for await (const value of response) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      bytes += chunk.byteLength;
      if (
        bytes > (params.expectedBytes ?? MAX_WORKSPACE_INVENTORY_TOTAL_BYTES) ||
        bytes > MAX_WORKSPACE_INVENTORY_TOTAL_BYTES
      ) {
        throw new Error("workspace transfer download exceeded its byte limit");
      }
      hash.update(chunk);
      if (!output.write(chunk)) {
        await once(output, "drain");
      }
    }
    const finished = once(output, "finish");
    output.end();
    await finished;
  } catch (error) {
    output.destroy();
    await fsp.rm(params.destination, { force: true });
    throw error;
  }
  if (
    (params.expectedBytes !== undefined && bytes !== params.expectedBytes) ||
    (params.expectedSha256 !== undefined && hash.digest("hex") !== params.expectedSha256)
  ) {
    await fsp.rm(params.destination, { force: true });
    throw new Error("workspace transfer blob failed integrity validation");
  }
}

function workspacePath(root: string, relative: string): string {
  const candidate = path.join(root, ...relative.split("/"));
  if (candidate !== root && !isPathInside(root, candidate)) {
    throw new Error("workspace transfer manifest escaped its workspace");
  }
  return candidate;
}

function workspaceCommandEnv(homeDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: homeDir,
    ...(process.platform === "win32" ? { USERPROFILE: homeDir } : {}),
    GCM_INTERACTIVE: "Never",
    GIT_ASKPASS: "",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    SSH_ASKPASS: "",
  };
}

async function runWorkspaceCommand(params: {
  workspaceDir: string;
  homeDir: string;
  argv: string[];
  input?: string | Uint8Array;
  signal?: AbortSignal;
  maxOutputBytes?: number;
}): Promise<string> {
  const maxOutputBytes = params.maxOutputBytes ?? 128 * 1024;
  const result = await runCommandWithTimeout(params.argv, {
    cwd: params.workspaceDir,
    baseEnv: workspaceCommandEnv(params.homeDir),
    ...(params.input === undefined ? {} : { input: params.input }),
    timeoutMs: TRANSFER_TIMEOUT_MS,
    signal: params.signal,
    maxOutputBytes,
    maxCombinedOutputBytes: maxOutputBytes + 128 * 1024,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(`workspace transfer apply failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout;
}

async function captureManifest(params: {
  workspaceDir: string;
  manifestHome: string;
  baseCommit: string | null;
  signal?: AbortSignal;
}): Promise<string> {
  return (
    await runWorkspaceCommand({
      workspaceDir: params.workspaceDir,
      homeDir: params.manifestHome,
      argv: [
        "node",
        "-e",
        REMOTE_WORKSPACE_MANIFEST_JS,
        params.workspaceDir,
        params.baseCommit ?? "",
        ...(params.baseCommit ? ["eligible"] : []),
      ],
      signal: params.signal,
    })
  ).trim();
}

async function initializeGitWorkspace(params: {
  workspaceDir: string;
  manifestHome: string;
  packPath: string;
  baseCommit: string;
  signal?: AbortSignal;
}): Promise<void> {
  const objectFormat = params.baseCommit.length === 40 ? "sha1" : "sha256";
  if (params.baseCommit.length !== 40 && params.baseCommit.length !== 64) {
    throw new Error("workspace transfer Git base object id is invalid");
  }
  const git = async (args: string[], options: { input?: string; maxOutputBytes?: number } = {}) =>
    await runWorkspaceCommand({
      workspaceDir: params.workspaceDir,
      homeDir: params.manifestHome,
      argv: ["git", "-C", params.workspaceDir, ...args],
      ...(options.input === undefined ? {} : { input: options.input }),
      signal: params.signal,
      ...(options.maxOutputBytes === undefined ? {} : { maxOutputBytes: options.maxOutputBytes }),
    });
  await git(["init", "--quiet", `--object-format=${objectFormat}`, "."]);
  const pack = await fsp.open(params.packPath, "r");
  try {
    await runExec("git", ["-C", params.workspaceDir, "index-pack", "--stdin"], {
      cwd: params.workspaceDir,
      baseEnv: workspaceCommandEnv(params.manifestHome),
      stdinFileDescriptor: pack.fd,
      signal: params.signal,
      timeoutMs: TRANSFER_TIMEOUT_MS,
      maxBuffer: 256 * 1024,
      logOutput: false,
    });
  } finally {
    await pack.close();
  }
  await fsp.writeFile(path.join(params.workspaceDir, ".git", "shallow"), `${params.baseCommit}\n`);
  const actual = (await git(["rev-parse", "--verify", `${params.baseCommit}^{commit}`])).trim();
  if (actual !== params.baseCommit) {
    throw new Error("workspace transfer Git base does not match the synced pack");
  }
  await git(["update-ref", "refs/heads/openclaw-worker", params.baseCommit]);
  await git(["symbolic-ref", "HEAD", "refs/heads/openclaw-worker"]);
  await git(["read-tree", params.baseCommit]);
  const index = await git(["ls-files", "--stage", "-z"], {
    maxOutputBytes: MAX_WORKSPACE_MANIFEST_BYTES,
  });
  const gitlinks = index
    .split("\0")
    .filter(Boolean)
    .flatMap((record) => {
      const separator = record.indexOf("\t");
      return separator >= 0 && record.startsWith("160000 ") ? [record.slice(separator + 1)] : [];
    });
  if (gitlinks.length > 0) {
    await git(["update-index", "--skip-worktree", "-z", "--stdin"], {
      input: `${gitlinks.join("\0")}\0`,
    });
  }
  await fsp.rm(params.packPath, { force: true });
}

const workspaceTransferQueues = new Map<string, Promise<void>>();

export async function serializeNodeWorkerWorkspace<T>(
  workspaceDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const key = path.resolve(workspaceDir);
  const previous = workspaceTransferQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => current);
  workspaceTransferQueues.set(key, queued);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (workspaceTransferQueues.get(key) === queued) {
      workspaceTransferQueues.delete(key);
    }
  }
}

async function removeTransferArtifact(target: string): Promise<void> {
  await fsp.rm(target, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 0,
    retryDelay: 100,
  });
}

async function recoverWorkspaceReplacement(workspaceDir: string): Promise<void> {
  const parent = path.dirname(workspaceDir);
  const workspaceName = path.basename(workspaceDir);
  await fsp.mkdir(parent, { recursive: true, mode: 0o700 });
  const entries = await fsp.readdir(parent, { withFileTypes: true });
  const stagingPrefix = `.${workspaceName}.workspace-transfer-`;
  const staging = entries.filter((entry) => entry.name.startsWith(stagingPrefix));
  const backups = entries.filter((entry) => entry.name.startsWith(`${workspaceName}.previous-`));
  for (const entry of staging) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      await removeTransferArtifact(path.join(parent, entry.name));
    }
  }
  const workspaceExists = await fsp
    .lstat(workspaceDir)
    .then((stats) => {
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error("workspace transfer target is not an owned directory");
      }
      return true;
    })
    .catch((error: unknown) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw error;
    });
  const validBackups: string[] = [];
  for (const entry of backups) {
    if (entry.isDirectory() && !entry.isSymbolicLink()) {
      validBackups.push(path.join(parent, entry.name));
    }
  }
  if (!workspaceExists) {
    if (validBackups.length > 1) {
      throw new Error("workspace transfer recovery found multiple prior workspaces");
    }
    if (validBackups.length === 1) {
      await fsp.rename(validBackups[0]!, workspaceDir);
    }
    return;
  }
  await Promise.all(
    validBackups.map((backup) => removeTransferArtifact(backup).catch(() => undefined)),
  );
}

async function replaceWorkspace(workspaceDir: string, staging: string): Promise<void> {
  const backup = `${workspaceDir}.previous-${process.pid}-${randomUUID()}`;
  let movedOld = false;
  try {
    await fsp.rename(workspaceDir, backup);
    movedOld = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  try {
    await fsp.rename(staging, workspaceDir);
  } catch (error) {
    if (movedOld) {
      try {
        await fsp.rename(backup, workspaceDir);
      } catch (rollbackError) {
        const recoveryError = new Error(`workspace transfer rollback failed; recover ${backup}`, {
          cause: error,
        });
        Object.defineProperty(recoveryError, "rollbackError", { value: rollbackError });
        throw recoveryError;
      }
    }
    throw error;
  }
  if (movedOld) {
    // The second rename is the commit point. Cleanup failure is recovered on the next transfer.
    await removeTransferArtifact(backup).catch(() => undefined);
  }
}

async function downloadWorkspace(params: {
  gatewayUrl: string;
  tlsFingerprint?: string;
  environmentId: string;
  workspaceDir: string;
  manifestHome: string;
  transfer: Extract<NodeWorkerWorkspaceTransferInput, { direction: "download" }>;
  signal?: AbortSignal;
}): Promise<string> {
  const startedAt = performance.now();
  let packDownloadMs: number | undefined;
  const raw = await downloadBuffer(
    {
      gatewayUrl: params.gatewayUrl,
      tlsFingerprint: params.tlsFingerprint,
      routePath: nodeWorkspaceTransferManifestPath(
        params.environmentId,
        params.transfer.manifestRef,
      ),
      method: "GET",
      token: params.transfer.token,
      signal: params.signal,
    },
    MAX_WORKSPACE_MANIFEST_BYTES,
  );
  const manifest = parseWorkerWorkspaceManifest(raw.toString("utf8"), params.transfer.manifestRef);
  const parent = path.dirname(params.workspaceDir);
  const workspaceName = path.basename(params.workspaceDir);
  const stagingWorkspace = await tempWorkspace({
    rootDir: parent,
    prefix: `.${workspaceName}.workspace-transfer-`,
  });
  const staging = stagingWorkspace.dir;
  try {
    if (manifest.baseCommit) {
      const packPath = path.join(staging, ".openclaw-base.pack");
      const packStartedAt = performance.now();
      await downloadFile({
        request: {
          gatewayUrl: params.gatewayUrl,
          tlsFingerprint: params.tlsFingerprint,
          routePath: nodeWorkspaceTransferPackPath(
            params.environmentId,
            params.transfer.manifestRef,
          ),
          method: "GET",
          token: params.transfer.token,
          signal: params.signal,
        },
        destination: packPath,
      });
      packDownloadMs = performance.now() - packStartedAt;
      await initializeGitWorkspace({
        workspaceDir: staging,
        manifestHome: params.manifestHome,
        packPath,
        baseCommit: manifest.baseCommit,
        signal: params.signal,
      });
    }
    const blobApplyStartedAt = performance.now();
    for (const directory of manifest.directories ?? []) {
      await fsp.mkdir(workspacePath(staging, directory), { recursive: true, mode: 0o700 });
    }
    for (const entry of manifest.entries) {
      const destination = workspacePath(staging, entry.path);
      await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
      await fsp.rm(destination, { recursive: true, force: true });
      if (entry.type === "symlink") {
        await fsp.symlink(entry.target, destination);
        continue;
      }
      await downloadFile({
        request: {
          gatewayUrl: params.gatewayUrl,
          tlsFingerprint: params.tlsFingerprint,
          routePath: nodeWorkspaceTransferBlobPath(params.environmentId, entry.sha256),
          method: "GET",
          token: params.transfer.token,
          signal: params.signal,
        },
        destination,
        expectedBytes: entry.size,
        expectedSha256: entry.sha256,
      });
      await fsp.chmod(destination, entry.mode);
    }
    const blobApplyMs = performance.now() - blobApplyStartedAt;
    const observed = await captureManifest({
      workspaceDir: staging,
      manifestHome: params.manifestHome,
      baseCommit: manifest.baseCommit,
      signal: params.signal,
    });
    if (observed !== params.transfer.manifestRef) {
      throw new Error(
        `workspace transfer materialized a different manifest (${observed}/${params.transfer.manifestRef})`,
      );
    }
    await replaceWorkspace(params.workspaceDir, staging);
    transferLog.debug("node worker workspace transfer completed", {
      environmentId: params.environmentId,
      direction: "download",
      outcome: "succeeded",
      durationMs: performance.now() - startedAt,
      ...(packDownloadMs === undefined ? {} : { packDownloadMs }),
      blobApplyMs,
    });
    return observed;
  } finally {
    await stagingWorkspace.cleanup();
  }
}

async function writeChunk(request: ClientRequest, chunk: Buffer): Promise<void> {
  if (request.write(chunk)) {
    return;
  }
  await once(request, "drain");
}

async function uploadFile(request: ClientRequest, filePath: string): Promise<void> {
  for await (const value of fs.createReadStream(filePath)) {
    await writeChunk(request, Buffer.isBuffer(value) ? value : Buffer.from(value));
  }
}

async function uploadWorkspace(params: {
  gatewayUrl: string;
  tlsFingerprint?: string;
  environmentId: string;
  workspaceDir: string;
  manifestHome: string;
  transfer: Extract<NodeWorkerWorkspaceTransferInput, { direction: "upload" }>;
  signal?: AbortSignal;
}): Promise<string> {
  const baseRaw = await fsp.readFile(
    path.join(
      params.manifestHome,
      ".openclaw-worker",
      "manifests",
      `${params.transfer.baseManifestRef.slice("sha256:".length)}.json`,
    ),
    "utf8",
  );
  const base = parseWorkerWorkspaceManifest(baseRaw, params.transfer.baseManifestRef);
  const currentRef = await captureManifest({
    workspaceDir: params.workspaceDir,
    manifestHome: params.manifestHome,
    baseCommit: base.baseCommit,
    signal: params.signal,
  });
  const currentRaw = await fsp.readFile(
    path.join(
      params.manifestHome,
      ".openclaw-worker",
      "manifests",
      `${currentRef.slice("sha256:".length)}.json`,
    ),
    "utf8",
  );
  const current = parseWorkerWorkspaceManifest(currentRaw, currentRef);
  const changed = new Set(workerWorkspaceTransferPaths(current, base));
  const files = current.entries.filter(
    (entry): entry is Extract<(typeof current.entries)[number], { type: "file" }> =>
      entry.type === "file" && changed.has(entry.path),
  );
  const manifestBytes = Buffer.from(currentRaw);
  const baseBytes = Buffer.from(baseRaw);
  const contentLength =
    8 +
    baseBytes.byteLength +
    manifestBytes.byteLength +
    files.reduce((total, entry) => total + 8 + entry.size, 0);
  const response = await openRequest({
    gatewayUrl: params.gatewayUrl,
    tlsFingerprint: params.tlsFingerprint,
    routePath: nodeWorkspaceTransferReconcilePath(
      params.environmentId,
      params.transfer.baseManifestRef,
    ),
    method: "POST",
    token: params.transfer.token,
    headers: {
      "content-type": "application/vnd.openclaw.worker-workspace-reconcile-v1",
      "content-length": String(contentLength),
    },
    signal: params.signal,
    writeBody: async (request) => {
      for (const value of [baseBytes, manifestBytes]) {
        const header = Buffer.allocUnsafe(4);
        header.writeUInt32BE(value.byteLength);
        await writeChunk(request, header);
        await writeChunk(request, value);
      }
      for (const entry of files) {
        const size = Buffer.allocUnsafe(8);
        size.writeBigUInt64BE(BigInt(entry.size));
        await writeChunk(request, size);
        await uploadFile(request, workspacePath(params.workspaceDir, entry.path));
      }
    },
  });
  await requireOk(response);
  const payload = JSON.parse(
    (await readResponseBody(response, TRANSFER_RESULT_MAX_BYTES)).toString("utf8"),
  ) as { manifestRef?: unknown };
  if (payload.manifestRef !== currentRef) {
    throw new Error("workspace transfer upload acknowledgement is invalid");
  }
  return currentRef;
}

export async function runNodeWorkerWorkspaceTransfer(params: {
  gatewayUrl: string;
  gatewayTlsFingerprint?: string;
  environmentId: string;
  workspaceDir: string;
  manifestHome: string;
  transfer: NodeWorkerWorkspaceTransferInput;
  signal?: AbortSignal;
}): Promise<string> {
  try {
    await recoverWorkspaceReplacement(params.workspaceDir);
    return params.transfer.direction === "download"
      ? await downloadWorkspace({
          ...params,
          tlsFingerprint: params.gatewayTlsFingerprint,
          transfer: params.transfer,
        })
      : await uploadWorkspace({
          ...params,
          tlsFingerprint: params.gatewayTlsFingerprint,
          transfer: params.transfer,
        });
  } catch (error) {
    if (error instanceof NodeWorkerWorkspaceTransferError) {
      throw error;
    }
    throw new NodeWorkerWorkspaceTransferError(
      "workspace-transfer-failed: transfer did not complete",
      { cause: error },
    );
  }
}
