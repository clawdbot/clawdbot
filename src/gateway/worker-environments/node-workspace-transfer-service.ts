import { createHash } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { isPathInside } from "../../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { NodeWorkspaceTransferHttpRoute } from "./node-workspace-transfer-http-contract.js";
import {
  prepareNodeWorkspaceTransferPack,
  prepareNodeWorkspaceTransferSnapshot,
  type NodeWorkspaceTransferSnapshot,
} from "./node-workspace-transfer-snapshot.js";
import { mintNodeWorkspaceTransferToken } from "./node-workspace-transfer-token.js";
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
import { assertWorkspaceMatchesManifest } from "./workspace-reconcile.js";
import { workerWorkspaceTransferPaths } from "./workspace-result-staging.js";

const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const MAX_UPLOAD_BYTES =
  MAX_WORKSPACE_MANIFEST_BYTES * 2 +
  MAX_RECONCILIATION_TOTAL_BYTES +
  MAX_RECONCILIATION_ENTRIES * 8 +
  8;
const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;

type TransferCredential = {
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

type TransferOwner = {
  credential: TransferCredential | undefined;
  environment: TransferEnvironment;
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

type DownloadCapability = {
  direction: "download";
  token: string;
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
  generation: number;
  snapshot: NodeWorkspaceTransferSnapshot;
  expiresAtMs: number;
};

type UploadOperation = {
  direction: "upload";
  token: string;
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
  generation: number;
  baseManifestRef: string;
  expiresAtMs: number;
  state: "ready" | "receiving" | "completed";
  uploaded?: NodeWorkspaceTransferUpload;
};

type TransferContext = {
  environmentId: string;
  ownerEpoch: number;
  sessionId: string;
  generation: number;
  localPath: string;
  temporaryRoot: string;
  snapshot?: NodeWorkspaceTransferSnapshot;
  downloads: Map<string, DownloadCapability>;
  upload?: UploadOperation;
  abortController: AbortController;
  stopWatchingOwnerSignal?: () => void;
  isAuthorized: () => boolean;
};

type TransferAuthorization = {
  context: TransferContext;
  capability: DownloadCapability | UploadOperation;
  route: NodeWorkspaceTransferHttpRoute;
};

class NodeWorkspaceTransferLimitError extends Error {
  readonly code = "workspace-transfer-limit";
}

export function isNodeWorkspaceTransferLimitError(
  error: unknown,
): error is NodeWorkspaceTransferLimitError {
  return error instanceof NodeWorkspaceTransferLimitError;
}

class RequestByteReader {
  readonly #iterator: AsyncIterator<unknown>;
  readonly #signal: AbortSignal;
  readonly #assertCurrent: () => void;
  #pending: Buffer = Buffer.alloc(0);
  #done = false;
  bytesRead = 0;

  constructor(request: IncomingMessage, signal: AbortSignal, assertCurrent: () => void) {
    this.#iterator = request[Symbol.asyncIterator]();
    this.#signal = signal;
    this.#assertCurrent = assertCurrent;
  }

  async take(maxBytes: number): Promise<Buffer> {
    this.#signal.throwIfAborted();
    if (this.#pending.length === 0 && !this.#done) {
      const next = await this.#iterator.next();
      // Authority cannot change while buffered bytes are consumed in one turn.
      // Revalidate after the iterator yields; callers do the same after their own awaited I/O.
      this.#assertCurrent();
      this.#signal.throwIfAborted();
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

function contextOwnerValid(
  context: TransferContext,
  owner: TransferOwner | undefined,
  nowMs: number,
): boolean {
  const environment = owner?.environment;
  const credential = owner?.credential;
  return Boolean(
    !context.abortController.signal.aborted &&
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

function capabilityMatchesContext(
  capability: DownloadCapability | UploadOperation,
  context: TransferContext,
): boolean {
  return (
    capability.environmentId === context.environmentId &&
    capability.ownerEpoch === context.ownerEpoch &&
    capability.sessionId === context.sessionId &&
    capability.generation === context.generation
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
  assertCurrent: () => void;
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
    let chunkOffset = 0;
    while (chunkOffset < chunk.length) {
      const { bytesWritten } = await params.handle.write(
        chunk,
        chunkOffset,
        chunk.length - chunkOffset,
        offset + chunkOffset,
      );
      // A short write adds another await, so each suffix retry needs its own authority fence.
      params.assertCurrent();
      if (bytesWritten === 0) {
        throw new Error("Workspace transfer upload write made no progress");
      }
      chunkOffset += bytesWritten;
    }
    offset += chunk.length;
  }
  if (hash.digest("hex") !== params.entry.sha256) {
    throw new Error("Workspace transfer file digest differs from its manifest");
  }
}

export function createNodeWorkspaceTransferService(options: {
  getOwner: (environmentId: string) => TransferOwner | undefined;
  now?: () => number;
  temporaryRoot?: string;
}) {
  const contexts = new Map<string, TransferContext>();
  const contextOperations = new KeyedAsyncQueue();
  const now = options.now ?? Date.now;
  const temporaryBaseRoot =
    options.temporaryRoot ?? path.join(resolveStateDir(), "tmp", "node-workspace-transfer");
  let temporaryRootReady: Promise<void> | undefined;

  const ensureTemporaryRoot = () => {
    temporaryRootReady ??= (async () => {
      // The Gateway state lock proves no previous process still owns this private namespace.
      await fsp.rm(temporaryBaseRoot, { recursive: true, force: true });
      await fsp.mkdir(temporaryBaseRoot, { recursive: true, mode: 0o700 });
    })();
    return temporaryRootReady;
  };

  const currentOwner = (context: TransferContext): TransferOwner | undefined => {
    if (contexts.get(context.environmentId) !== context) {
      return undefined;
    }
    const owner = options.getOwner(context.environmentId);
    return contextOwnerValid(context, owner, now()) ? owner : undefined;
  };

  const isCurrentContext = (context: TransferContext): boolean => Boolean(currentOwner(context));

  const closeContext = async (context: TransferContext) => {
    if (!context.abortController.signal.aborted) {
      context.abortController.abort(new Error("Node workspace transfer context closed"));
    }
    context.stopWatchingOwnerSignal?.();
    if (contexts.get(context.environmentId) === context) {
      contexts.delete(context.environmentId);
    }
    await fsp.rm(context.temporaryRoot, { recursive: true, force: true });
  };

  const closeEnvironment = (environmentId: string) =>
    contextOperations.enqueue(environmentId, async () => {
      const context = contexts.get(environmentId);
      if (context) {
        await closeContext(context);
      }
    });

  const mintDownload = (
    context: TransferContext,
    snapshot: NodeWorkspaceTransferSnapshot,
  ): string => {
    const credential = currentOwner(context)?.credential;
    const nowMs = now();
    if (!credential) {
      throw new Error("Node workspace transfer owner is no longer current");
    }
    const expiresAtMs = Math.min(credential.expiresAtMs, nowMs + TRANSFER_TIMEOUT_MS);
    if (expiresAtMs <= nowMs) {
      throw new Error("Worker workspace transfer credential is expired");
    }
    const token = mintNodeWorkspaceTransferToken();
    context.snapshot = snapshot;
    context.downloads.set(token, {
      direction: "download",
      token,
      environmentId: context.environmentId,
      ownerEpoch: context.ownerEpoch,
      sessionId: context.sessionId,
      generation: context.generation,
      snapshot,
      expiresAtMs,
    });
    return token;
  };

  const authorizationCurrent = (authorization: TransferAuthorization): boolean => {
    const { capability, context } = authorization;
    if (
      !isCurrentContext(context) ||
      !capabilityMatchesContext(capability, context) ||
      capability.expiresAtMs <= now()
    ) {
      return false;
    }
    return capability.direction === "download"
      ? context.downloads.get(capability.token) === capability
      : context.upload === capability &&
          (capability.state === "receiving" || capability.state === "completed");
  };

  const assertAuthorizationCurrent = (authorization: TransferAuthorization): void => {
    if (!authorizationCurrent(authorization)) {
      throw new Error("Workspace transfer authority closed");
    }
  };

  const routeMatchesDownload = (
    context: TransferContext,
    capability: DownloadCapability,
    route: NodeWorkspaceTransferHttpRoute,
  ): boolean => {
    if (route.direction !== "download" || route.environmentId !== context.environmentId) {
      return false;
    }
    if (route.kind === "manifest" || route.kind === "pack") {
      return route.manifestRef === capability.snapshot.manifestRef;
    }
    if (route.kind !== "blob") {
      return false;
    }
    return capability.snapshot.manifest.entries.some(
      (entry) => entry.type === "file" && entry.sha256 === route.sha256,
    );
  };

  const withNewContext = async <T>(
    params: {
      environmentId: string;
      ownerEpoch: number;
      sessionId: string;
      generation: number;
      localPath: string;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
    },
    prepare: (context: TransferContext) => Promise<T>,
  ): Promise<T> =>
    await contextOperations.enqueue(params.environmentId, async () => {
      const previous = contexts.get(params.environmentId);
      if (previous) {
        await closeContext(previous);
      }
      await ensureTemporaryRoot();
      const abortController = new AbortController();
      const context: TransferContext = {
        ...params,
        localPath: await fsp.realpath(params.localPath),
        temporaryRoot: await fsp.mkdtemp(path.join(temporaryBaseRoot, "context-")),
        downloads: new Map(),
        abortController,
      };
      if (params.signal) {
        const abortFromOwner = () => abortController.abort(params.signal!.reason);
        params.signal.addEventListener("abort", abortFromOwner, { once: true });
        context.stopWatchingOwnerSignal = () =>
          params.signal?.removeEventListener("abort", abortFromOwner);
        if (params.signal.aborted) {
          abortFromOwner();
        }
      }
      contexts.set(context.environmentId, context);
      try {
        if (!isCurrentContext(context)) {
          throw new Error("Node workspace transfer owner is no longer current");
        }
        const result = await prepare(context);
        if (!isCurrentContext(context)) {
          throw new Error("Node workspace transfer owner is no longer current");
        }
        return result;
      } catch (error) {
        await closeContext(context);
        throw error;
      }
    });

  return {
    initialize: ensureTemporaryRoot,

    async restore(params: Parameters<typeof withNewContext>[0]): Promise<void> {
      await withNewContext(params, async () => {});
    },

    async prepareSync(params: Parameters<typeof withNewContext>[0]) {
      return await withNewContext(params, async (context) => {
        const snapshot = await prepareNodeWorkspaceTransferSnapshot({
          localPath: context.localPath,
          temporaryRoot: context.temporaryRoot,
          signal: AbortSignal.any([
            context.abortController.signal,
            AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
          ]),
        });
        return { snapshot, token: mintDownload(context, snapshot) };
      });
    },

    prepareUpload(environmentId: string, baseManifestRef: string): string {
      const context = contexts.get(environmentId);
      const credential = context ? currentOwner(context)?.credential : undefined;
      const nowMs = now();
      if (!context || !MANIFEST_REF_PATTERN.test(baseManifestRef) || !credential) {
        throw new Error("Node workspace transfer context is unavailable");
      }
      if (context.upload) {
        throw new Error("Node workspace transfer upload is already active");
      }
      const expiresAtMs = Math.min(credential.expiresAtMs, nowMs + TRANSFER_TIMEOUT_MS);
      if (expiresAtMs <= nowMs) {
        throw new Error("Worker workspace transfer credential is expired");
      }
      const token = mintNodeWorkspaceTransferToken();
      context.upload = {
        direction: "upload",
        token,
        environmentId: context.environmentId,
        ownerEpoch: context.ownerEpoch,
        sessionId: context.sessionId,
        generation: context.generation,
        baseManifestRef,
        expiresAtMs,
        state: "ready",
      };
      return token;
    },

    takeUpload(environmentId: string, baseManifestRef: string): NodeWorkspaceTransferUpload {
      const context = contexts.get(environmentId);
      const operation = context?.upload;
      if (
        !context ||
        !operation ||
        operation.state !== "completed" ||
        operation.baseManifestRef !== baseManifestRef ||
        !operation.uploaded ||
        !isCurrentContext(context)
      ) {
        throw new Error("Node workspace transfer upload did not complete");
      }
      context.upload = undefined;
      return operation.uploaded;
    },

    async publishSnapshot(
      environmentId: string,
      snapshot: Pick<NodeWorkspaceTransferSnapshot, "manifest" | "manifestRef">,
    ): Promise<string> {
      const context = contexts.get(environmentId);
      if (!context || !isCurrentContext(context)) {
        throw new Error("Node workspace transfer context is unavailable");
      }
      // Reuse packs by immutable base commit, not mutable worktree manifest. Recovery
      // rebuilds the authenticated base pack even when the Gateway HEAD has advanced.
      const packPath =
        context.snapshot?.manifest.baseCommit === snapshot.manifest.baseCommit
          ? context.snapshot.packPath
          : await prepareNodeWorkspaceTransferPack({
              root: context.localPath,
              baseCommit: snapshot.manifest.baseCommit,
              temporaryRoot: context.temporaryRoot,
              signal: AbortSignal.any([
                context.abortController.signal,
                AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
              ]),
            });
      return mintDownload(context, {
        ...snapshot,
        rawManifest: serializeWorkerWorkspaceManifest(snapshot.manifest),
        root: context.localPath,
        packPath,
      });
    },

    revoke(environmentId: string, token: string): void {
      const context = contexts.get(environmentId);
      context?.downloads.delete(token);
      if (context?.upload?.token === token && context.upload.state === "ready") {
        context.upload = undefined;
      }
    },

    authorize(params: {
      route: NodeWorkspaceTransferHttpRoute;
      token: string;
    }): TransferAuthorization | undefined {
      const context = contexts.get(params.route.environmentId);
      if (!context || !isCurrentContext(context)) {
        return undefined;
      }
      const download = context.downloads.get(params.token);
      if (download) {
        if (
          download.expiresAtMs <= now() ||
          !capabilityMatchesContext(download, context) ||
          !routeMatchesDownload(context, download, params.route)
        ) {
          return undefined;
        }
        return { context, capability: download, route: params.route };
      }
      const upload = context.upload;
      if (
        !upload ||
        upload.token !== params.token ||
        upload.state !== "ready" ||
        upload.expiresAtMs <= now() ||
        !capabilityMatchesContext(upload, context) ||
        params.route.kind !== "reconcile" ||
        params.route.environmentId !== context.environmentId ||
        params.route.baseManifestRef !== upload.baseManifestRef
      ) {
        return undefined;
      }
      // Claim before body streaming. A retry must mint a fresh operation instead of replaying bytes.
      upload.state = "receiving";
      return { context, capability: upload, route: params.route };
    },

    isAuthorizationCurrent: authorizationCurrent,

    authorizationSignal(authorization: TransferAuthorization): AbortSignal {
      return authorization.context.abortController.signal;
    },

    snapshot(authorization: TransferAuthorization): NodeWorkspaceTransferSnapshot | undefined {
      if (
        authorization.capability.direction !== "download" ||
        (authorization.route.kind !== "manifest" && authorization.route.kind !== "pack") ||
        !authorizationCurrent(authorization)
      ) {
        return undefined;
      }
      return authorization.capability.snapshot;
    },

    blob(
      authorization: TransferAuthorization,
    ): { path: string; size: number; sha256: string } | undefined {
      if (
        authorization.capability.direction !== "download" ||
        authorization.route.kind !== "blob" ||
        !authorizationCurrent(authorization)
      ) {
        return undefined;
      }
      const snapshot = authorization.capability.snapshot;
      const sha256 = authorization.route.sha256;
      const entry = snapshot.manifest.entries.find(
        (candidate) => candidate.type === "file" && candidate.sha256 === sha256,
      );
      return entry?.type === "file"
        ? { path: entryPath(snapshot.root, entry.path), size: entry.size, sha256: entry.sha256 }
        : undefined;
    },

    async receiveUpload(params: {
      authorization: TransferAuthorization;
      request: IncomingMessage;
      signal: AbortSignal;
    }): Promise<{ manifestRef: string }> {
      const { authorization } = params;
      const operation = authorization.capability;
      if (
        operation.direction !== "upload" ||
        authorization.route.kind !== "reconcile" ||
        operation.state !== "receiving"
      ) {
        throw new Error("Workspace transfer upload owner is unavailable");
      }
      const assertCurrent = () => {
        params.signal.throwIfAborted();
        assertAuthorizationCurrent(authorization);
      };
      let stagingRoot: string | undefined;
      try {
        assertCurrent();
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
        const reader = new RequestByteReader(params.request, params.signal, assertCurrent);
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
        const base = await readManifest(operation.baseManifestRef);
        assertCurrent();
        const current = await readManifest();
        assertCurrent();
        const transferPaths = workerWorkspaceTransferPaths(current.manifest, base.manifest);
        const transferPathSet = new Set(transferPaths);
        stagingRoot = await fsp.mkdtemp(path.join(authorization.context.temporaryRoot, "upload-"));
        const currentByPath = new Map(current.manifest.entries.map((entry) => [entry.path, entry]));
        for (const relative of transferPaths) {
          const entry = currentByPath.get(relative);
          if (!entry) {
            continue;
          }
          const destination = entryPath(stagingRoot, relative);
          await fsp.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
          assertCurrent();
          if (entry.type === "symlink") {
            await fsp.symlink(entry.target, destination);
            assertCurrent();
          } else {
            const handle = await fsp.open(destination, "wx", entry.mode);
            try {
              await streamUploadFile({ reader, handle, entry, assertCurrent });
            } finally {
              await handle.close();
            }
            assertCurrent();
          }
        }
        await reader.assertEnd();
        assertCurrent();
        if (reader.bytesRead !== contentLength) {
          throw new Error("Workspace transfer upload length is inconsistent");
        }
        await assertWorkspaceMatchesManifest({
          root: stagingRoot,
          manifest: current.manifest,
          entries: current.manifest.entries.filter((entry) => transferPathSet.has(entry.path)),
        });
        assertCurrent();
        operation.uploaded = {
          base: base.manifest,
          baseManifestRef: operation.baseManifestRef,
          baseRaw: base.raw,
          current: current.manifest,
          currentManifestRef: current.ref,
          currentRaw: current.raw,
          stagingRoot,
        };
        operation.state = "completed";
        return { manifestRef: current.ref };
      } catch (error) {
        if (stagingRoot) {
          await fsp.rm(stagingRoot, { recursive: true, force: true });
        }
        if (authorization.context.upload === operation) {
          authorization.context.upload = undefined;
        }
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

    close: closeEnvironment,

    async closeAll(): Promise<void> {
      await temporaryRootReady;
      const closed = await Promise.allSettled([...contexts.keys()].map(closeEnvironment));
      // Shared scratch outlives every transfer context, including failed sibling cleanup.
      closed.push(
        ...(await Promise.allSettled([
          fsp.rm(temporaryBaseRoot, { recursive: true, force: true }),
        ])),
      );
      const failure = closed.find((result) => result.status === "rejected");
      if (failure) {
        throw failure.reason;
      }
    },
  };
}

export type NodeWorkspaceTransferService = ReturnType<typeof createNodeWorkspaceTransferService>;
