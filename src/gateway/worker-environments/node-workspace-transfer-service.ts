import { createHash } from "node:crypto";
import fsp from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import { resolveStateDir } from "../../config/paths.js";
import { isPathInside } from "../../infra/fs-safe.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import type { NodeWorkspaceTransferHttpRoute } from "./node-workspace-transfer-http-contract.js";
import {
  prepareNodeWorkspaceTransferSnapshot,
  type NodeWorkspaceTransferSnapshot,
} from "./node-workspace-transfer-snapshot.js";
import { mintNodeWorkspaceTransferToken } from "./node-workspace-transfer-token.js";
import {
  MAX_UPLOAD_BYTES,
  NodeWorkspaceTransferLimitError,
  RequestByteReader,
  streamUploadFile,
} from "./node-workspace-upload-reader.js";
import { readWorkspaceFileSnapshotWithLimit } from "./workspace-actual-manifest.js";
import { prepareWorkerWorkspaceGitPack } from "./workspace-git-base.js";
import {
  MAX_WORKSPACE_INVENTORY_TOTAL_BYTES,
  MAX_WORKSPACE_MANIFEST_BYTES,
} from "./workspace-inventory-limits.js";
import {
  parseWorkerWorkspaceManifest,
  serializeWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
} from "./workspace-manifest.js";
import {
  assertWorkspaceMatchesManifest,
  readActualWorkspaceManifest,
} from "./workspace-reconcile.js";
import { workerWorkspaceTransferPaths } from "./workspace-result-staging.js";

export { isNodeWorkspaceTransferLimitError } from "./node-workspace-upload-reader.js";

const TRANSFER_TIMEOUT_MS = 10 * 60_000;
const MANIFEST_REF_PATTERN = /^sha256:[a-f0-9]{64}$/u;

type TransferCredential = {
  ownerEpoch: number;
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
  manifestRef: string;
  expiresAtMs: number;
  isAuthorized?: () => boolean;
  signal?: AbortSignal;
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
  currentManifestRef: string;
  snapshots: Map<string, NodeWorkspaceTransferSnapshot>;
  baseCommit: string | null;
  pack?: Promise<string>;
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

function contextOwnerValid(context: TransferContext, owner: TransferOwner | undefined): boolean {
  const environment = owner?.environment;
  const credential = owner?.credential;
  // Deleting the credential fences teardown before its asynchronous tunnel stop.
  // Its RPC admission expiry does not end the node workspace; each transfer has its own TTL.
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
    credential.sessionId === context.sessionId,
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
    return contextOwnerValid(context, owner) ? owner : undefined;
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
    // Cancellation fences requests before pack processes release their scratch files.
    await context.pack?.catch(() => undefined);
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
    manifestRef: string,
    isAuthorized?: () => boolean,
    signal?: AbortSignal,
  ): string => {
    signal?.throwIfAborted();
    if (!isCurrentContext(context) || isAuthorized?.() === false) {
      throw new Error("Node workspace transfer owner is no longer current");
    }
    const token = mintNodeWorkspaceTransferToken();
    context.downloads.set(token, {
      direction: "download",
      token,
      environmentId: context.environmentId,
      ownerEpoch: context.ownerEpoch,
      sessionId: context.sessionId,
      generation: context.generation,
      manifestRef,
      expiresAtMs: now() + TRANSFER_TIMEOUT_MS,
      ...(isAuthorized ? { isAuthorized } : {}),
      ...(signal ? { signal } : {}),
    });
    return token;
  };

  const pruneSnapshots = (context: TransferContext): void => {
    const retained = new Set([
      context.currentManifestRef,
      ...[...context.downloads.values()].map((download) => download.manifestRef),
    ]);
    for (const manifestRef of context.snapshots.keys()) {
      if (!retained.has(manifestRef)) {
        context.snapshots.delete(manifestRef);
      }
    }
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
      ? context.downloads.get(capability.token) === capability &&
          !capability.signal?.aborted &&
          capability.isAuthorized?.() !== false
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
      return route.manifestRef === capability.manifestRef;
    }
    if (route.kind !== "blob") {
      return false;
    }
    return Boolean(
      context.snapshots
        .get(capability.manifestRef)
        ?.manifest.entries.some((entry) => entry.type === "file" && entry.sha256 === route.sha256),
    );
  };

  return {
    initialize: ensureTemporaryRoot,

    async prepareAttachments(params: {
      environmentId: string;
      localPath: string;
      isAuthorized: () => boolean;
      signal: AbortSignal;
    }) {
      params.signal.throwIfAborted();
      const context = contexts.get(params.environmentId);
      if (!context || !isCurrentContext(context) || !params.isAuthorized()) {
        throw new Error("Worker attachment transfer authority closed");
      }
      const root = await fsp.realpath(params.localPath);
      params.signal.throwIfAborted();
      const actual = await readActualWorkspaceManifest({ root, baseCommit: null });
      params.signal.throwIfAborted();
      if (!isCurrentContext(context) || !params.isAuthorized()) {
        throw new Error("Worker attachment transfer authority closed");
      }
      // Attachment snapshots are claim-scoped and must not advance the workspace base.
      const snapshot = {
        ...actual,
        root,
        rawManifest: serializeWorkerWorkspaceManifest(actual.manifest),
      };
      context.snapshots.set(snapshot.manifestRef, snapshot);
      return {
        snapshot,
        token: mintDownload(context, snapshot.manifestRef, params.isAuthorized, params.signal),
      };
    },

    async prepareSync(params: {
      environmentId: string;
      ownerEpoch: number;
      sessionId: string;
      generation: number;
      localPath: string;
      isAuthorized: () => boolean;
      signal?: AbortSignal;
    }) {
      return await contextOperations.enqueue(params.environmentId, async () => {
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
          currentManifestRef: "",
          snapshots: new Map(),
          baseCommit: null,
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
        try {
          const snapshot = await prepareNodeWorkspaceTransferSnapshot({
            localPath: context.localPath,
            temporaryRoot: context.temporaryRoot,
            signal: AbortSignal.any([
              context.abortController.signal,
              AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
            ]),
          });
          context.snapshots.set(snapshot.manifestRef, snapshot);
          context.baseCommit = snapshot.manifest.baseCommit;
          context.currentManifestRef = snapshot.manifestRef;
          contexts.set(context.environmentId, context);
          return { snapshot, token: mintDownload(context, snapshot.manifestRef) };
        } catch (error) {
          await closeContext(context);
          throw error;
        }
      });
    },

    prepareUpload(environmentId: string, baseManifestRef: string): string {
      const context = contexts.get(environmentId);
      if (!context || !MANIFEST_REF_PATTERN.test(baseManifestRef) || !isCurrentContext(context)) {
        throw new Error("Node workspace transfer context is unavailable");
      }
      if (context.upload) {
        throw new Error("Node workspace transfer upload is already active");
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
        expiresAtMs: now() + TRANSFER_TIMEOUT_MS,
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

    getSnapshot(
      environmentId: string,
      manifestRef: string,
    ): NodeWorkspaceTransferSnapshot | undefined {
      return contexts.get(environmentId)?.snapshots.get(manifestRef);
    },

    publishSnapshot(environmentId: string, snapshot: NodeWorkspaceTransferSnapshot): string {
      const context = contexts.get(environmentId);
      if (!context || !isCurrentContext(context)) {
        throw new Error("Node workspace transfer context is unavailable");
      }
      context.snapshots.set(snapshot.manifestRef, snapshot);
      context.currentManifestRef = snapshot.manifestRef;
      pruneSnapshots(context);
      return mintDownload(context, snapshot.manifestRef);
    },

    revoke(environmentId: string, token: string): void {
      const context = contexts.get(environmentId);
      context?.downloads.delete(token);
      if (context) {
        pruneSnapshots(context);
      }
      if (context?.upload?.token === token && context.upload.state === "ready") {
        context.upload = undefined;
      }
    },

    authorize(params: {
      route: NodeWorkspaceTransferHttpRoute;
      token: string;
    }): TransferAuthorization | undefined {
      const context = contexts.get(params.route.environmentId);
      if (!context) {
        return undefined;
      }
      const download = context.downloads.get(params.token);
      if (download) {
        const authorization = { context, capability: download, route: params.route };
        if (
          !authorizationCurrent(authorization) ||
          !routeMatchesDownload(context, download, params.route)
        ) {
          return undefined;
        }
        return authorization;
      }
      const upload = context.upload;
      if (
        !upload ||
        !isCurrentContext(context) ||
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
      const signal = authorization.context.abortController.signal;
      const capability = authorization.capability;
      return capability.direction === "download" && capability.signal
        ? AbortSignal.any([signal, capability.signal])
        : signal;
    },

    snapshot(authorization: TransferAuthorization): NodeWorkspaceTransferSnapshot | undefined {
      if (
        authorization.capability.direction !== "download" ||
        (authorization.route.kind !== "manifest" && authorization.route.kind !== "pack") ||
        !authorizationCurrent(authorization)
      ) {
        return undefined;
      }
      return authorization.context.snapshots.get(authorization.capability.manifestRef);
    },

    async pack(authorization: TransferAuthorization): Promise<string | undefined> {
      if (authorization.route.kind !== "pack" || !authorizationCurrent(authorization)) {
        return undefined;
      }
      const { context, route } = authorization;
      const snapshot = context.snapshots.get(route.manifestRef);
      const { baseCommit } = context;
      if (!baseCommit || snapshot?.manifest.baseCommit !== baseCommit) {
        return undefined;
      }
      if (!context.pack) {
        // Origin/seed sync needs only the manifest. Materialize its immutable Git base
        // on first download; accepted manifests share this context-owned operation.
        context.pack = prepareWorkerWorkspaceGitPack({
          root: context.localPath,
          baseCommit,
          temporaryRoot: context.temporaryRoot,
          signal: AbortSignal.any([
            context.abortController.signal,
            AbortSignal.timeout(TRANSFER_TIMEOUT_MS),
          ]),
        }).catch((error: unknown) => {
          context.pack = undefined;
          throw error;
        });
      }
      const packPath = await context.pack;
      return authorizationCurrent(authorization) ? packPath : undefined;
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
      const snapshot = authorization.context.snapshots.get(authorization.capability.manifestRef);
      const sha256 = authorization.route.sha256;
      const entry = snapshot?.manifest.entries.find(
        (candidate) => candidate.type === "file" && candidate.sha256 === sha256,
      );
      return snapshot && entry?.type === "file"
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
