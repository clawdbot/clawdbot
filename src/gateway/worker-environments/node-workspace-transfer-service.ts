import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp, { type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { isPathInside } from "../../infra/fs-safe.js";
import { runCommandWithTimeout } from "../../process/exec.js";
import type { NodeWorkspaceTransferHttpCallback } from "./node-workspace-transfer-http.js";
import {
  mintNodeWorkspaceTransferToken,
  type NodeWorkspaceTransferDirection,
  verifyNodeWorkspaceTransferToken,
} from "./node-workspace-transfer-token.js";
import { readWorkspaceFileSnapshotWithLimit } from "./workspace-actual-manifest.js";
import {
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
  MAX_WORKSPACE_MANIFEST_BYTES,
} from "./workspace-inventory-limits.js";
import {
  MAX_RECONCILIATION_ENTRIES,
  MAX_RECONCILIATION_TOTAL_BYTES,
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import {
  assertWorkspaceMatchesManifest,
  readActualWorkspaceManifest,
} from "./workspace-reconcile.js";
import { workerWorkspaceTransferPaths } from "./workspace-result-staging.js";
import {
  createGitTransferList,
  readWorkspaceTransferPaths,
  runLocalCommandToFile,
} from "./workspace-sync-local.js";

const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const MAX_UPLOAD_BYTES =
  MAX_WORKSPACE_MANIFEST_BYTES * 2 +
  MAX_RECONCILIATION_TOTAL_BYTES +
  MAX_RECONCILIATION_ENTRIES * 8 +
  8;

type TransferCredential = {
  credentialHash: string;
  ownerEpoch: number;
  expiresAtMs: number;
  sessionId: string | null;
};

type TransferEnvironment = {
  ownerEpoch: number;
  attachedSessionIds: string[];
  destroyRequestedAtMs: number | null;
  state: string;
};

type NodeWorkspaceTransferSnapshot = {
  manifest: WorkerWorkspaceManifest;
  manifestRef: string;
  rawManifest: string;
  root: string;
  packPath?: string;
};

type NodeWorkspaceTransferUpload = {
  base: WorkerWorkspaceManifest;
  baseManifestRef: string;
  baseRaw: string;
  current: WorkerWorkspaceManifest;
  currentManifestRef: string;
  currentRaw: string;
  stagingRoot: string;
};

type TransferContext = {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
  generation: number;
  localPath: string;
  temporaryRoot: string;
  snapshots: Map<string, NodeWorkspaceTransferSnapshot>;
  uploadBaseManifestRef?: string;
  uploaded?: NodeWorkspaceTransferUpload;
  isAuthorized: () => boolean;
};

class NodeWorkspaceTransferLimitError extends Error {
  readonly code = "workspace-transfer-limit";
}

class RequestByteReader {
  readonly #iterator: AsyncIterator<unknown>;
  #pending: Buffer = Buffer.alloc(0);
  #done = false;
  bytesRead = 0;

  constructor(request: IncomingMessage) {
    this.#iterator = request[Symbol.asyncIterator]();
  }

  async take(maxBytes: number): Promise<Buffer> {
    if (this.#pending.length === 0 && !this.#done) {
      const next = await this.#iterator.next();
      this.#done = Boolean(next.done);
      if (!next.done) {
        this.#pending = Buffer.isBuffer(next.value)
          ? next.value
          : Buffer.from(next.value as Uint8Array);
      }
    }
    if (this.#pending.length === 0) {
      return Buffer.alloc(0);
    }
    const count = Math.min(maxBytes, this.#pending.length);
    const value = this.#pending.subarray(0, count);
    this.#pending = Buffer.from(this.#pending.subarray(count));
    this.bytesRead += value.byteLength;
    if (this.bytesRead > MAX_UPLOAD_BYTES) {
      throw new NodeWorkspaceTransferLimitError("Workspace transfer upload exceeds its byte limit");
    }
    return value;
  }

  async readExactly(bytes: number): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let remaining = bytes;
    while (remaining > 0) {
      const chunk = await this.take(remaining);
      if (chunk.length === 0) {
        throw new Error("Workspace transfer upload ended before its declared payload");
      }
      chunks.push(chunk);
      remaining -= chunk.length;
    }
    return Buffer.concat(chunks, bytes);
  }

  async assertEnd(): Promise<void> {
    if ((await this.take(1)).length !== 0) {
      throw new Error("Workspace transfer upload contains trailing bytes");
    }
  }
}

async function successfulGit(root: string, args: string[]): Promise<string> {
  const result = await runCommandWithTimeout(["git", "-C", root, ...args], {
    timeoutMs: TRANSFER_TIMEOUT_MS,
    maxOutputBytes: 256 * 1024,
    maxCombinedOutputBytes: 512 * 1024,
    baseEnv: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "" },
  });
  if (result.termination !== "exit" || result.code !== 0) {
    throw new Error("Worker workspace Git inspection failed");
  }
  return result.stdout.trim();
}

async function prepareSnapshot(params: {
  localPath: string;
  temporaryRoot: string;
  signal?: AbortSignal;
}): Promise<NodeWorkspaceTransferSnapshot> {
  const root = await fsp.realpath(params.localPath);
  const gitAdmin = await fsp.lstat(path.join(root, ".git")).catch((error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  let baseCommit: string | null = null;
  let includePaths: ReadonlySet<string> | undefined;
  let packPath: string | undefined;
  if (gitAdmin) {
    const gitRoot = await fsp.realpath(await successfulGit(root, ["rev-parse", "--show-toplevel"]));
    if (gitRoot !== root) {
      throw new Error("Worker git workspace sync requires the managed worktree root");
    }
    baseCommit = await successfulGit(root, ["rev-parse", "--verify", "HEAD"]);
    if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u.test(baseCommit)) {
      throw new Error("Worker workspace Git base is not a commit id");
    }
    const transferList = await createGitTransferList({
      gitRoot: root,
      temporaryDirectory: path.join(params.temporaryRoot, "inventory"),
      signal: params.signal ?? AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    const transferable = await readWorkspaceTransferPaths(transferList);
    const manifestPaths = new Set(transferable);
    for (const relative of transferable) {
      const segments = relative.split("/");
      for (let index = 1; index < segments.length; index += 1) {
        manifestPaths.add(segments.slice(0, index).join("/"));
      }
    }
    includePaths = manifestPaths;
    const objectListPath = path.join(params.temporaryRoot, "base-objects");
    packPath = path.join(params.temporaryRoot, "base.pack");
    await runLocalCommandToFile({
      argv: [
        "git",
        "-C",
        root,
        "rev-list",
        "--objects",
        "--no-object-names",
        `${baseCommit}^{tree}`,
      ],
      outputPath: objectListPath,
      signal: params.signal ?? AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
    await fsp.appendFile(objectListPath, `${baseCommit}\n`);
    await runLocalCommandToFile({
      argv: ["git", "-C", root, "pack-objects", "--stdout"],
      inputPath: objectListPath,
      outputPath: packPath,
      signal: params.signal ?? AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
      timeoutMs: TRANSFER_TIMEOUT_MS,
    });
  }
  const actual = await readActualWorkspaceManifest({ root, baseCommit, includePaths });
  return {
    ...actual,
    rawManifest: serializeWorkerWorkspaceManifest(actual.manifest),
    root,
    ...(packPath ? { packPath } : {}),
  };
}

function contextOwnerValid(
  context: TransferContext,
  environment: TransferEnvironment | undefined,
  credential: TransferCredential | undefined,
  nowMs: number,
): boolean {
  return Boolean(
    context.isAuthorized() &&
    environment &&
    credential &&
    environment.state === "attached" &&
    environment.destroyRequestedAtMs === null &&
    environment.ownerEpoch === context.ownerEpoch &&
    environment.attachedSessionIds.length === 1 &&
    environment.attachedSessionIds[0] === context.sessionId &&
    credential.ownerEpoch === context.ownerEpoch &&
    credential.sessionId === context.sessionId &&
    credential.expiresAtMs > nowMs,
  );
}

function entryPath(root: string, relative: string): string {
  const candidate = path.join(root, ...relative.split("/"));
  if (candidate !== root && !isPathInside(root, candidate)) {
    throw new Error("Workspace transfer entry escaped its staging root");
  }
  return candidate;
}

async function streamUploadFile(params: {
  reader: RequestByteReader;
  handle: FileHandle;
  entry: Extract<WorkerWorkspaceManifestEntry, { type: "file" }>;
}): Promise<void> {
  const size = (await params.reader.readExactly(8)).readBigUInt64BE();
  if (size !== BigInt(params.entry.size)) {
    throw new Error("Workspace transfer file size differs from its manifest");
  }
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < params.entry.size) {
    const chunk = await params.reader.take(Math.min(64 * 1024, params.entry.size - offset));
    if (chunk.length === 0) {
      throw new Error("Workspace transfer upload ended mid-file");
    }
    hash.update(chunk);
    await params.handle.write(chunk, 0, chunk.length, offset);
    offset += chunk.length;
  }
  if (hash.digest("hex") !== params.entry.sha256) {
    throw new Error("Workspace transfer file digest differs from its manifest");
  }
}

export function createNodeWorkspaceTransferService(options: {
  getCredential: (environmentId: string) => TransferCredential | undefined;
  getEnvironment: (environmentId: string) => TransferEnvironment | undefined;
  now?: () => number;
}) {
  const contexts = new Map<string, TransferContext>();
  const now = options.now ?? Date.now;

  const closeContext = async (context: TransferContext) => {
    if (contexts.get(context.environmentId) === context) {
      contexts.delete(context.environmentId);
    }
    await fsp.rm(context.temporaryRoot, { recursive: true, force: true });
  };

  const mint = (context: TransferContext, direction: NodeWorkspaceTransferDirection) => {
    const credential = options.getCredential(context.environmentId);
    const environment = options.getEnvironment(context.environmentId);
    const nowMs = now();
    if (!contextOwnerValid(context, environment, credential, nowMs)) {
      throw new Error("Node workspace transfer owner is no longer current");
    }
    return mintNodeWorkspaceTransferToken({
      credentialHash: credential!.credentialHash,
      credentialExpiresAtMs: credential!.expiresAtMs,
      environmentId: context.environmentId,
      ownerEpoch: context.ownerEpoch,
      direction,
      nowMs,
    }).token;
  };

  return {
    async prepareSync(params: {
      environmentId: string;
      ownerEpoch: number;
      sessionId: string;
      generation: number;
      localPath: string;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
    }) {
      const previous = contexts.get(params.environmentId);
      if (previous) {
        await closeContext(previous);
      }
      const temporaryRoot = await fsp.mkdtemp(
        path.join(os.tmpdir(), "openclaw-node-workspace-transfer-"),
      );
      const context: TransferContext = {
        ...params,
        localPath: await fsp.realpath(params.localPath),
        temporaryRoot,
        snapshots: new Map(),
      };
      try {
        const snapshot = await prepareSnapshot({
          localPath: context.localPath,
          temporaryRoot,
          signal: params.signal,
        });
        context.snapshots.set(snapshot.manifestRef, snapshot);
        contexts.set(context.environmentId, context);
        return { snapshot, token: mint(context, "download") };
      } catch (error) {
        await closeContext(context);
        throw error;
      }
    },

    prepareUpload(environmentId: string, baseManifestRef: string): string {
      const context = contexts.get(environmentId);
      if (!context || !/^sha256:[a-f0-9]{64}$/u.test(baseManifestRef)) {
        throw new Error("Node workspace transfer context is unavailable");
      }
      context.uploadBaseManifestRef = baseManifestRef;
      context.uploaded = undefined;
      return mint(context, "upload");
    },

    takeUpload(environmentId: string, baseManifestRef: string): NodeWorkspaceTransferUpload {
      const context = contexts.get(environmentId);
      const uploaded = context?.uploaded;
      if (
        !context ||
        context.uploadBaseManifestRef !== baseManifestRef ||
        !uploaded ||
        !contextOwnerValid(
          context,
          options.getEnvironment(environmentId),
          options.getCredential(environmentId),
          now(),
        )
      ) {
        throw new Error("Node workspace transfer upload did not complete");
      }
      context.uploaded = undefined;
      return uploaded;
    },

    publishSnapshot(environmentId: string, snapshot: NodeWorkspaceTransferSnapshot): string {
      const context = contexts.get(environmentId);
      if (!context) {
        throw new Error("Node workspace transfer context is unavailable");
      }
      context.snapshots.set(snapshot.manifestRef, snapshot);
      return mint(context, "download");
    },

    authorize(params: {
      environmentId: string;
      direction: NodeWorkspaceTransferDirection;
      token: string;
    }): boolean {
      const context = contexts.get(params.environmentId);
      const credential = options.getCredential(params.environmentId);
      const environment = options.getEnvironment(params.environmentId);
      const nowMs = now();
      return Boolean(
        context &&
        contextOwnerValid(context, environment, credential, nowMs) &&
        verifyNodeWorkspaceTransferToken({
          token: params.token,
          credentialHash: credential!.credentialHash,
          credentialExpiresAtMs: credential!.expiresAtMs,
          environmentId: params.environmentId,
          ownerEpoch: context.ownerEpoch,
          direction: params.direction,
          nowMs,
        }),
      );
    },

    snapshot(
      environmentId: string,
      manifestDigest: string,
    ): NodeWorkspaceTransferSnapshot | undefined {
      return contexts.get(environmentId)?.snapshots.get(`sha256:${manifestDigest}`);
    },

    blob(environmentId: string, sha256: string): { path: string; size: number } | undefined {
      const context = contexts.get(environmentId);
      if (!context) {
        return undefined;
      }
      // Accepted snapshots are inserted last and reflect the current gateway tree.
      // Prefer them when a digest also appeared at a base path that was later removed.
      for (const snapshot of [...context.snapshots.values()].toReversed()) {
        const entry = snapshot.manifest.entries.find(
          (candidate) => candidate.type === "file" && candidate.sha256 === sha256,
        );
        if (entry?.type === "file") {
          return { path: entryPath(snapshot.root, entry.path), size: entry.size };
        }
      }
      return undefined;
    },

    async receiveUpload(params: {
      environmentId: string;
      baseManifestDigest: string;
      request: IncomingMessage;
    }): Promise<{ manifestRef: string }> {
      const context = contexts.get(params.environmentId);
      const baseManifestRef = `sha256:${params.baseManifestDigest}`;
      if (!context || context.uploadBaseManifestRef !== baseManifestRef) {
        throw new Error("Workspace transfer upload owner is unavailable");
      }
      const contentLength = Number(params.request.headers["content-length"]);
      if (
        !Number.isSafeInteger(contentLength) ||
        contentLength < 8 ||
        contentLength > MAX_UPLOAD_BYTES
      ) {
        throw new NodeWorkspaceTransferLimitError(
          "Workspace transfer upload exceeds its byte limit",
        );
      }
      const reader = new RequestByteReader(params.request);
      const readManifest = async (expectedRef?: string) => {
        const bytes = (await reader.readExactly(4)).readUInt32BE();
        if (bytes < 2 || bytes > MAX_WORKSPACE_MANIFEST_BYTES) {
          throw new NodeWorkspaceTransferLimitError(
            "Workspace transfer manifest exceeds its byte limit",
          );
        }
        const raw = (await reader.readExactly(bytes)).toString("utf8");
        const ref = expectedRef ?? `sha256:${createHash("sha256").update(raw).digest("hex")}`;
        return { raw, ref, manifest: parseWorkerWorkspaceManifest(raw, ref) };
      };
      const base = await readManifest(baseManifestRef);
      const current = await readManifest();
      const transferPaths = workerWorkspaceTransferPaths(current.manifest, base.manifest);
      const transferPathSet = new Set(transferPaths);
      const stagingRoot = await fsp.mkdtemp(path.join(context.temporaryRoot, "upload-"));
      try {
        const currentByPath = new Map(current.manifest.entries.map((entry) => [entry.path, entry]));
        for (const relative of transferPaths) {
          const entry = currentByPath.get(relative);
          if (!entry) {
            continue;
          }
          const destination = entryPath(stagingRoot, relative);
          await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          if (entry.type === "symlink") {
            await fsp.symlink(entry.target, destination);
          } else {
            const handle = await fsp.open(destination, "wx", entry.mode);
            try {
              await streamUploadFile({ reader, handle, entry });
            } finally {
              await handle.close();
            }
          }
        }
        await reader.assertEnd();
        if (reader.bytesRead !== contentLength) {
          throw new Error("Workspace transfer upload length is inconsistent");
        }
        await assertWorkspaceMatchesManifest({
          root: stagingRoot,
          manifest: current.manifest,
          entries: current.manifest.entries.filter((entry) => transferPathSet.has(entry.path)),
        });
        if (!context.isAuthorized()) {
          throw new Error("Workspace transfer owner changed during upload");
        }
        context.uploaded = {
          base: base.manifest,
          baseManifestRef,
          baseRaw: base.raw,
          current: current.manifest,
          currentManifestRef: current.ref,
          currentRaw: current.raw,
          stagingRoot,
        };
        return { manifestRef: current.ref };
      } catch (error) {
        await fsp.rm(stagingRoot, { recursive: true, force: true });
        throw error;
      }
    },

    async verifyBlob(params: { path: string; size: number; sha256: string }): Promise<boolean> {
      const snapshot = await readWorkspaceFileSnapshotWithLimit(
        params.path,
        Math.min(params.size, MAX_WORKSPACE_INVENTORY_TOTAL_BYTES),
      );
      return (
        snapshot.type === "file" &&
        snapshot.size === params.size &&
        snapshot.sha256 === params.sha256
      );
    },

    async close(environmentId: string): Promise<void> {
      const context = contexts.get(environmentId);
      if (context) {
        await closeContext(context);
      }
    },

    async closeAll(): Promise<void> {
      await Promise.all([...contexts.values()].map(closeContext));
    },
  };
}

export type NodeWorkspaceTransferService = ReturnType<typeof createNodeWorkspaceTransferService>;

export function createNodeWorkspaceTransferHttpCallback(
  service: NodeWorkspaceTransferService,
): NodeWorkspaceTransferHttpCallback {
  return async ({ req, res, route, bearer }) => {
    if (
      !service.authorize({
        environmentId: route.environmentId,
        direction: route.direction,
        token: bearer,
      })
    ) {
      return { kind: "unauthorized" };
    }
    return {
      kind: "authorized",
      handle: async () => {
        if (route.kind === "manifest" || route.kind === "pack") {
          const snapshot = service.snapshot(
            route.environmentId,
            route.manifestRef.slice("sha256:".length),
          );
          if (!snapshot || (route.kind === "pack" && !snapshot.packPath)) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "not_found" }));
            return;
          }
          if (route.kind === "manifest") {
            const body = Buffer.from(snapshot.rawManifest);
            res.writeHead(200, {
              "content-type": "application/json; charset=utf-8",
              "content-length": String(body.byteLength),
            });
            res.end(body);
            return;
          }
          const stats = await fsp.stat(snapshot.packPath!);
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(stats.size),
          });
          await pipeline(fs.createReadStream(snapshot.packPath!), res);
          return;
        }
        if (route.kind === "blob") {
          const blob = service.blob(route.environmentId, route.sha256);
          if (
            !blob ||
            !(await service.verifyBlob({ path: blob.path, size: blob.size, sha256: route.sha256 }))
          ) {
            res.statusCode = 404;
            res.end(JSON.stringify({ error: "not_found" }));
            return;
          }
          res.writeHead(200, {
            "content-type": "application/octet-stream",
            "content-length": String(blob.size),
          });
          await pipeline(fs.createReadStream(blob.path), res);
          return;
        }
        if (route.kind !== "reconcile") {
          throw new Error("Unsupported workspace transfer route");
        }
        try {
          const result = await service.receiveUpload({
            environmentId: route.environmentId,
            baseManifestDigest: route.baseManifestRef.slice("sha256:".length),
            request: req,
          });
          if (
            !service.authorize({
              environmentId: route.environmentId,
              direction: route.direction,
              token: bearer,
            })
          ) {
            throw new Error("Workspace transfer owner changed during upload");
          }
          const body = Buffer.from(JSON.stringify(result));
          res.writeHead(200, {
            "content-type": "application/json; charset=utf-8",
            "content-length": String(body.byteLength),
          });
          res.end(body);
        } catch (error) {
          const limit = error instanceof NodeWorkspaceTransferLimitError;
          const body = Buffer.from(
            JSON.stringify({
              error: limit ? "workspace_transfer_limit" : "workspace_transfer_invalid",
            }),
          );
          res.writeHead(limit ? 413 : 400, {
            "content-type": "application/json; charset=utf-8",
            "content-length": String(body.byteLength),
          });
          res.end(body);
        }
      },
    };
  };
}
