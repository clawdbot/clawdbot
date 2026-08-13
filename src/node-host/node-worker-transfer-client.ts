import { createHash } from "node:crypto";
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
import {
  REMOTE_GIT_WORKSPACE_SETUP_SCRIPT,
  REMOTE_WORKSPACE_MANIFEST_JS,
} from "../gateway/worker-environments/workspace-sync-scripts.js";
import { isPathInside } from "../infra/path-guards.js";
import { normalizeFingerprint } from "../infra/tls/fingerprint.js";
import { runCommandWithTimeout } from "../process/exec.js";
import {
  nodeWorkspaceTransferBlobPath,
  nodeWorkspaceTransferManifestPath,
  nodeWorkspaceTransferPackPath,
  nodeWorkspaceTransferReconcilePath,
  type NodeWorkerWorkspaceTransferInput,
} from "../worker/node-workspace-transfer-protocol.js";

const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const TRANSFER_RESULT_MAX_BYTES = 64 * 1024;

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

function endAfterTlsPin(request: ClientRequest, expectedRaw?: string): void {
  if (!expectedRaw?.trim()) {
    request.end();
    return;
  }
  request.once("socket", (socket) => {
    const tlsSocket = socket as TLSSocket;
    tlsSocket.once("secureConnect", () => {
      const expected = normalizeFingerprint(expectedRaw);
      const actual = normalizeFingerprint(tlsSocket.getPeerCertificate().fingerprint256 ?? "");
      if (!expected || !actual || expected !== actual) {
        request.destroy(new Error("gateway TLS fingerprint mismatch"));
        return;
      }
      request.end();
    });
  });
}

function openRequest(params: {
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
  return new Promise<IncomingMessage>((resolve, reject) => {
    const transport = url.protocol === "https:" ? https : http;
    const request = transport.request(url, {
      method: params.method,
      headers: { authorization: `Bearer ${params.token}`, ...params.headers },
      signal: params.signal,
      ...(url.protocol === "https:" && params.tlsFingerprint ? { rejectUnauthorized: false } : {}),
    });
    request.once("response", resolve);
    request.once("error", reject);
    if (params.writeBody) {
      const write = async () => {
        if (url.protocol === "https:" && params.tlsFingerprint?.trim()) {
          const expectedFingerprint = params.tlsFingerprint;
          await new Promise<void>((ready, failed) => {
            request.once("socket", (socket) => {
              const tlsSocket = socket as TLSSocket;
              tlsSocket.once("secureConnect", () => {
                const expected = normalizeFingerprint(expectedFingerprint);
                const actual = normalizeFingerprint(
                  tlsSocket.getPeerCertificate().fingerprint256 ?? "",
                );
                if (!expected || !actual || expected !== actual) {
                  failed(new Error("gateway TLS fingerprint mismatch"));
                } else {
                  ready();
                }
              });
            });
          });
        }
        await params.writeBody!(request);
        request.end();
      };
      void write().catch((error: unknown) =>
        request.destroy(error instanceof Error ? error : new Error(String(error))),
      );
    } else {
      endAfterTlsPin(request, params.tlsFingerprint);
    }
  });
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
    throw new Error("workspace-transfer-limit: gateway rejected workspace transfer caps");
  }
  throw new Error(`workspace-transfer-failed: gateway returned ${response.statusCode ?? 0}`);
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
        await new Promise<void>((resolve, reject) => {
          output.once("drain", resolve);
          output.once("error", reject);
        });
      }
    }
    await new Promise<void>((resolve, reject) => {
      output.once("error", reject);
      output.end(resolve);
    });
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

async function runWorkspaceScript(params: {
  workspaceDir: string;
  homeDir: string;
  argv: string[];
  input: string;
  signal?: AbortSignal;
}): Promise<string> {
  const result = await runCommandWithTimeout(params.argv, {
    cwd: params.workspaceDir,
    baseEnv: { ...process.env, HOME: params.homeDir, GIT_TERMINAL_PROMPT: "0" },
    input: params.input,
    timeoutMs: TRANSFER_TIMEOUT_MS,
    signal: params.signal,
    maxOutputBytes: 128 * 1024,
    maxCombinedOutputBytes: 256 * 1024,
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error(`workspace transfer apply failed: ${(result.stderr || result.stdout).trim()}`);
  }
  return result.stdout.trim();
}

async function captureManifest(params: {
  workspaceDir: string;
  manifestHome: string;
  baseCommit: string | null;
  signal?: AbortSignal;
}): Promise<string> {
  return await runWorkspaceScript({
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
    input: "",
    signal: params.signal,
  });
}

async function replaceWorkspaceAtomically(workspaceDir: string, staging: string): Promise<void> {
  const backup = `${workspaceDir}.previous-${process.pid}-${Date.now()}`;
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
      await fsp.rename(backup, workspaceDir).catch(() => undefined);
    }
    throw error;
  }
  if (movedOld) {
    await fsp.rm(backup, { recursive: true, force: true });
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
  const staging = await fsp.mkdtemp(path.join(parent, ".workspace-transfer-"));
  try {
    if (manifest.baseCommit) {
      const packPath = path.join(staging, ".openclaw-base.pack");
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
      await runWorkspaceScript({
        workspaceDir: staging,
        homeDir: params.manifestHome,
        argv: ["sh", "-s", "--", staging, packPath, manifest.baseCommit, "", ""],
        input: REMOTE_GIT_WORKSPACE_SETUP_SCRIPT,
        signal: params.signal,
      });
    }
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
    await replaceWorkspaceAtomically(params.workspaceDir, staging);
    return observed;
  } catch (error) {
    await fsp.rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function writeChunk(request: ClientRequest, chunk: Buffer): Promise<void> {
  if (request.write(chunk)) {
    return;
  }
  await new Promise<void>((resolve, reject) => {
    request.once("drain", resolve);
    request.once("error", reject);
  });
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
    if (error instanceof Error && error.message.startsWith("workspace-transfer-")) {
      throw error;
    }
    throw new Error("workspace-transfer-failed: transfer did not complete", { cause: error });
  }
}
