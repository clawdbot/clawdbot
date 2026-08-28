import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import path from "node:path";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import type { WorkspaceHashMemo } from "../gateway/worker-environments/workspace-hash-memo.js";
import {
  MAX_WORKSPACE_MANIFEST_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "../gateway/worker-environments/workspace-inventory-limits.js";
import {
  parseWorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "../gateway/worker-environments/workspace-manifest.js";
import { absoluteEntryMatches } from "../gateway/worker-environments/workspace-reconcile-fs.js";
import { workerWorkspaceTransferPaths } from "../gateway/worker-environments/workspace-result-staging.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "../gateway/worker-environments/workspace-sync-scripts.js";
import { isPathInside } from "../infra/path-guards.js";
import { tempWorkspace } from "../infra/private-temp-workspace.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { runExec } from "../process/exec.js";
import {
  nodeWorkspaceTransferBlobPath,
  NodeWorkerWorkspaceTransferError,
  nodeWorkspaceTransferManifestPath,
  nodeWorkspaceTransferPackPath,
  nodeWorkspaceTransferReconcilePath,
  type NodeWorkerWorkspaceTransferInput,
} from "../worker/node-workspace-transfer-protocol.js";
import {
  NodeWorkerTransferHttpError,
  openNodeWorkerTransferHttpRequest,
  type NodeWorkerTransferHttpRequest,
} from "./node-worker-transfer-http.js";
import {
  captureManifest,
  runWorkspaceCommand,
  TRANSFER_TIMEOUT_MS,
  workspaceCommandEnv,
} from "./node-worker-workspace-commands.js";

const TRANSFER_RESULT_MAX_BYTES = 64 * 1024;
const transferLog = createSubsystemLogger("node-host/worker-workspace");

export type NodeWorkerTransferGateway = {
  url: string;
  tlsFingerprint?: string;
  cloudflareAccess?: CloudflareAccessCredentials;
};

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

async function downloadBuffer(params: NodeWorkerTransferHttpRequest, maxBytes: number) {
  const response = await openNodeWorkerTransferHttpRequest(params);
  await requireOk(response);
  return await readResponseBody(response, maxBytes);
}

async function downloadFile(params: {
  request: NodeWorkerTransferHttpRequest;
  destination: string;
  expectedBytes?: number;
  expectedSha256?: string;
}): Promise<void> {
  const response = await openNodeWorkerTransferHttpRequest(params.request);
  await requireOk(response);
  const output = fs.createWriteStream(params.destination, {
    flags: "wx",
    mode: 0o600,
  });
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

async function initializeGitWorkspace(params: {
  workspaceDir: string;
  manifestHome: string;
  packPath: string;
  baseCommit: string;
  entries: WorkerWorkspaceManifestEntry[];
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
  const gitlinks: string[] = [];
  const basePaths = new Set<string>();
  for (const record of index.split("\0").filter(Boolean)) {
    const separator = record.indexOf("\t");
    if (separator < 0) {
      continue;
    }
    const indexedPath = record.slice(separator + 1);
    if (record.startsWith("160000 ")) {
      gitlinks.push(indexedPath);
    } else {
      basePaths.add(indexedPath);
    }
  }
  if (gitlinks.length > 0) {
    await git(["update-index", "--skip-worktree", "-z", "--stdin"], {
      input: `${gitlinks.join("\0")}\0`,
    });
  }
  const checkoutPaths = params.entries
    .map((entry) => entry.path)
    .filter((entryPath) => basePaths.has(entryPath));
  if (checkoutPaths.length > 0) {
    await git(["checkout-index", "-z", "--stdin"], {
      input: `${checkoutPaths.join("\0")}\0`,
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
        Object.defineProperty(recoveryError, "rollbackError", {
          value: rollbackError,
        });
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
  cloudflareAccess?: CloudflareAccessCredentials;
  environmentId: string;
  workspaceDir: string;
  manifestHome: string;
  transfer: Extract<NodeWorkerWorkspaceTransferInput, { direction: "download" }>;
  hashMemo?: WorkspaceHashMemo;
  signal?: AbortSignal;
}): Promise<string> {
  const startedAt = performance.now();
  let packDownloadMs: number | undefined;
  const raw = await downloadBuffer(
    {
      gatewayUrl: params.gatewayUrl,
      tlsFingerprint: params.tlsFingerprint,
      cloudflareAccess: params.cloudflareAccess,
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
  const stagingWorkspace = await tempWorkspace({
    rootDir: path.dirname(params.workspaceDir),
    prefix: `.${path.basename(params.workspaceDir)}.workspace-transfer-`,
  });
  const staging = stagingWorkspace.dir;
  try {
    if (process.platform === "win32") {
      const published = await runWorkspaceCommand({
        workspaceDir: staging,
        homeDir: params.manifestHome,
        argv: [
          "node",
          "-e",
          REMOTE_WORKSPACE_MANIFEST_JS,
          staging,
          manifest.baseCommit ?? "",
          "publish",
          params.transfer.manifestRef.slice("sha256:".length),
        ],
        input: raw,
        signal: params.signal,
      });
      if (published.trim() !== params.transfer.manifestRef) {
        throw new Error("workspace transfer manifest publication acknowledgement is invalid");
      }
    }
    if (manifest.baseCommit) {
      const packPath = path.join(staging, ".openclaw-base.pack");
      const packStartedAt = performance.now();
      await downloadFile({
        request: {
          gatewayUrl: params.gatewayUrl,
          tlsFingerprint: params.tlsFingerprint,
          cloudflareAccess: params.cloudflareAccess,
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
        entries: manifest.entries,
        signal: params.signal,
      });
    }
    const blobApplyStartedAt = performance.now();
    for (const directory of manifest.directories ?? []) {
      await fsp.mkdir(workspacePath(staging, directory), {
        recursive: true,
        mode: 0o700,
      });
    }
    for (const entry of manifest.entries) {
      const destination = workspacePath(staging, entry.path);
      const materializedEntry =
        process.platform === "win32" && entry.type === "file" && entry.mode === 0o755
          ? { ...entry, mode: 0o644 }
          : entry;
      if (manifest.baseCommit && (await absoluteEntryMatches(destination, materializedEntry))) {
        continue;
      }
      await fsp.mkdir(path.dirname(destination), {
        recursive: true,
        mode: 0o700,
      });
      await fsp.rm(destination, { recursive: true, force: true });
      if (entry.type === "symlink") {
        await fsp.symlink(entry.target, destination);
        continue;
      }
      await downloadFile({
        request: {
          gatewayUrl: params.gatewayUrl,
          tlsFingerprint: params.tlsFingerprint,
          cloudflareAccess: params.cloudflareAccess,
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
    // Staging identities are fresh, so this capture re-hashes; its memo output
    // survives the rename into workspaceDir and seeds the next upload capture.
    const observed = await captureManifest({
      workspaceDir: staging,
      manifestHome: params.manifestHome,
      baseCommit: manifest.baseCommit,
      referenceManifestRef: params.transfer.manifestRef,
      ...(params.hashMemo === undefined ? {} : { hashMemo: params.hashMemo }),
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
  cloudflareAccess?: CloudflareAccessCredentials;
  environmentId: string;
  workspaceDir: string;
  manifestHome: string;
  transfer: Extract<NodeWorkerWorkspaceTransferInput, { direction: "upload" }>;
  hashMemo?: WorkspaceHashMemo;
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
    referenceManifestRef: params.transfer.baseManifestRef,
    ...(params.hashMemo === undefined ? {} : { hashMemo: params.hashMemo }),
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
  const response = await openNodeWorkerTransferHttpRequest({
    gatewayUrl: params.gatewayUrl,
    tlsFingerprint: params.tlsFingerprint,
    cloudflareAccess: params.cloudflareAccess,
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
  gatewayCloudflareAccess?: CloudflareAccessCredentials;
  environmentId: string;
  workspaceDir: string;
  manifestHome: string;
  transfer: NodeWorkerWorkspaceTransferInput;
  hashMemo?: WorkspaceHashMemo;
  signal?: AbortSignal;
}): Promise<string> {
  try {
    await recoverWorkspaceReplacement(params.workspaceDir);
    return params.transfer.direction === "download"
      ? await downloadWorkspace({
          ...params,
          tlsFingerprint: params.gatewayTlsFingerprint,
          cloudflareAccess: params.gatewayCloudflareAccess,
          transfer: params.transfer,
        })
      : await uploadWorkspace({
          ...params,
          tlsFingerprint: params.gatewayTlsFingerprint,
          cloudflareAccess: params.gatewayCloudflareAccess,
          transfer: params.transfer,
        });
  } catch (error) {
    if (error instanceof NodeWorkerWorkspaceTransferError) {
      throw error;
    }
    if (error instanceof NodeWorkerTransferHttpError) {
      if (error.reason === "cloudflare-access-requires-tls") {
        throw new NodeWorkerWorkspaceTransferError(
          "workspace-transfer-failed: Cloudflare Access credentials require HTTPS",
          { cause: error },
        );
      }
      if (error.reason === "tls-fingerprint-mismatch") {
        throw new NodeWorkerWorkspaceTransferError(
          "workspace-transfer-failed: gateway TLS fingerprint mismatch",
          { cause: error },
        );
      }
      if (error.reason === "invalid-tls-fingerprint") {
        throw new NodeWorkerWorkspaceTransferError(
          "workspace-transfer-failed: gateway TLS fingerprint is invalid",
          { cause: error },
        );
      }
    }
    throw new NodeWorkerWorkspaceTransferError(
      "workspace-transfer-failed: transfer did not complete",
      { cause: error },
    );
  }
}
