import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { ClientRequest, IncomingMessage } from "node:http";
import path from "node:path";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import type { CloudflareAccessCredentials } from "../../packages/gateway-client/src/cloudflare-access.js";
import { boundedWorkerError } from "../gateway/worker-environments/worker-error.js";
import {
  replaceWorkerWorkspaceHashMemoEntries,
  withWorkerWorkspaceHashMemo,
  type WorkspaceHashMemo,
} from "../gateway/worker-environments/workspace-hash-memo.js";
import {
  MAX_WORKSPACE_MANIFEST_BYTES,
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
} from "../gateway/worker-environments/workspace-inventory-limits.js";
import { parseWorkerWorkspaceManifest } from "../gateway/worker-environments/workspace-manifest.js";
import { absoluteEntryMatches } from "../gateway/worker-environments/workspace-reconcile-fs.js";
import { workerWorkspaceTransferPaths } from "../gateway/worker-environments/workspace-result-staging.js";
import { REMOTE_WORKSPACE_MANIFEST_JS } from "../gateway/worker-environments/workspace-sync-scripts.js";
import { root as fsRoot, FsSafeError } from "../infra/fs-safe.js";
import { isPathInside } from "../infra/path-guards.js";
import { tempWorkspace } from "../infra/private-temp-workspace.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  ensureStagedInputDirectory,
  isStagedInputPath,
  stagedInputDirectoriesFromEntries,
} from "../media/staged-inputs.js";
import {
  isNodeWorkspaceTransferInvalidReason,
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
import { createNodeWorkerUploadSnapshot } from "./node-worker-upload-snapshot.js";
import { captureManifest, runWorkspaceCommand } from "./node-worker-workspace-commands.js";
import { initializeNodeWorkerGitWorkspace } from "./node-worker-workspace-git.js";
import { copyNodeWorkerProjectSeedObjects } from "./node-worker-workspace-seeds.js";

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
  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    payload = undefined;
  }
  if (
    response.statusCode === 413 &&
    isRecord(payload) &&
    payload.error === "workspace_transfer_limit"
  ) {
    throw new NodeWorkerWorkspaceTransferError(
      "workspace-transfer-limit: gateway rejected workspace transfer caps",
    );
  }
  if (
    response.statusCode === 400 &&
    isRecord(payload) &&
    payload.error === "workspace_transfer_invalid" &&
    isNodeWorkspaceTransferInvalidReason(payload.reason)
  ) {
    throw new NodeWorkerWorkspaceTransferError(
      `workspace-transfer-invalid: gateway rejected workspace transfer payload (${payload.reason})`,
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
  seedsRoot?: string;
  gatewayNamespace?: string;
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
  let baseSource: "prepared-project-seed" | "gateway-pack" | undefined;
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
  if (params.transfer.seedKey && (!manifest.baseCommit || params.transfer.attachments)) {
    throw new Error("Prepared project seeds require a Git workspace transfer");
  }
  const stagedInputs = stagedInputDirectoriesFromEntries(manifest.entries);
  if (
    params.transfer.attachments &&
    (manifest.baseCommit !== null ||
      manifest.entries.some(
        (entry) => entry.type !== "file" || !isStagedInputPath(entry.path, stagedInputs),
      ))
  ) {
    throw new Error("Invalid worker attachment manifest");
  }
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
      try {
        let seeded = false;
        if (params.transfer.seedKey) {
          baseSource = "prepared-project-seed";
          if (!params.seedsRoot || !params.gatewayNamespace) {
            throw new Error("Prepared project seed has no machine cache owner");
          }
          seeded = await copyNodeWorkerProjectSeedObjects({
            seedsRoot: params.seedsRoot,
            gatewayNamespace: params.gatewayNamespace,
            seedKey: params.transfer.seedKey,
            workspaceDir: staging,
            signal: params.signal,
          });
        }
        let packPath: string | undefined;
        if (!seeded) {
          baseSource = "gateway-pack";
          packPath = path.join(staging, ".openclaw-base.pack");
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
        }
        await initializeNodeWorkerGitWorkspace({
          workspaceDir: staging,
          manifestHome: params.manifestHome,
          packPath,
          baseCommit: manifest.baseCommit,
          entries: manifest.entries,
          signal: params.signal,
        });
      } catch (error) {
        params.signal?.throwIfAborted();
        if (baseSource === "prepared-project-seed") {
          throw new NodeWorkerWorkspaceTransferError(
            `workspace-transfer-failed: prepared project seed is invalid: ${boundedWorkerError(error)}`,
            { cause: error },
          );
        }
        throw error;
      }
    }
    const blobApplyStartedAt = performance.now();
    const stagingHashMemo: WorkspaceHashMemo = new Map();
    for (const directory of manifest.directories ?? []) {
      await fsp.mkdir(workspacePath(staging, directory), {
        recursive: true,
        mode: 0o700,
      });
    }
    await withWorkerWorkspaceHashMemo(stagingHashMemo, async () => {
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
    });
    const blobApplyMs = performance.now() - blobApplyStartedAt;
    // Reuse only hashes validated on this staging filesystem. Capture still checks
    // the complete tree and current handle identities before the atomic replacement.
    const observed = await captureManifest({
      workspaceDir: staging,
      manifestHome: params.manifestHome,
      baseCommit: manifest.baseCommit,
      referenceManifestRef: params.transfer.manifestRef,
      hashMemo: stagingHashMemo,
      signal: params.signal,
    });
    if (observed !== params.transfer.manifestRef) {
      throw new Error(
        `workspace transfer materialized a different manifest (${observed}/${params.transfer.manifestRef})`,
      );
    }
    if (params.transfer.attachments) {
      params.signal?.throwIfAborted();
      const root = await fsRoot(params.workspaceDir);
      for (const directory of stagedInputs) {
        params.signal?.throwIfAborted();
        await ensureStagedInputDirectory(params.workspaceDir, directory, params.signal);
      }
      for (const entry of manifest.entries) {
        params.signal?.throwIfAborted();
        const data = await fsp.readFile(workspacePath(staging, entry.path));
        params.signal?.throwIfAborted();
        try {
          // Adopt guarded exclusive-create with identity-bound rollback when fs-safe supports it.
          // Until then an entered create may retain this private copy after cancellation;
          // never unlink by path or overwrite an earlier turn's edits.
          await root.create(entry.path, data, { mode: 0o600 });
        } catch (error) {
          params.signal?.throwIfAborted();
          if (!(error instanceof FsSafeError) || error.code !== "already-exists") {
            throw error;
          }
          await root.open(entry.path).then((opened) => opened.handle.close());
        }
        params.signal?.throwIfAborted();
      }
    } else {
      await replaceWorkspace(params.workspaceDir, staging);
    }
    if (params.hashMemo) {
      replaceWorkerWorkspaceHashMemoEntries(params.hashMemo, [...stagingHashMemo]);
    }
    transferLog.debug("node worker workspace transfer completed", {
      environmentId: params.environmentId,
      direction: "download",
      outcome: "succeeded",
      durationMs: performance.now() - startedAt,
      ...(baseSource === undefined ? {} : { baseSource }),
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
  const manifestBytes = Buffer.from(currentRaw);
  const baseBytes = Buffer.from(baseRaw);
  const snapshot = await createNodeWorkerUploadSnapshot({
    workspaceDir: params.workspaceDir,
    sources: current.entries.flatMap((entry) =>
      entry.type === "file" && changed.has(entry.path)
        ? [
            {
              path: workspacePath(params.workspaceDir, entry.path),
              size: entry.size,
              sha256: entry.sha256,
            },
          ]
        : [],
    ),
    signal: params.signal,
  });
  try {
    const contentLength =
      8 +
      baseBytes.byteLength +
      manifestBytes.byteLength +
      snapshot.files.reduce((total, file) => total + 8 + file.size, 0);
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
        for (const file of snapshot.files) {
          const size = Buffer.allocUnsafe(8);
          size.writeBigUInt64BE(BigInt(file.size));
          await writeChunk(request, size);
          await snapshot.stream(file, async (chunk) => await writeChunk(request, chunk));
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
  } finally {
    await snapshot.cleanup();
  }
}

export async function runNodeWorkerWorkspaceTransfer(params: {
  seedsRoot?: string;
  gatewayNamespace?: string;
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
