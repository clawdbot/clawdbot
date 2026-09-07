import { createHash } from "node:crypto";
import fsp, { type FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import path from "node:path";
import type { NodeWorkspaceTransferInvalidReason } from "../../worker/node-workspace-transfer-protocol.js";
import { nodeWorkspaceTransferEntryPath } from "./node-workspace-transfer-snapshot.js";
import { MAX_WORKSPACE_MANIFEST_BYTES } from "./workspace-inventory-limits.js";
import {
  MAX_RECONCILIATION_TOTAL_BYTES,
  MAX_RECONCILIATION_ENTRIES,
  parseWorkerWorkspaceManifest,
  type WorkerWorkspaceManifest,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";
import { assertWorkspaceMatchesManifest } from "./workspace-reconcile.js";
import { workerWorkspaceTransferPaths } from "./workspace-result-staging.js";

const MAX_UPLOAD_BYTES =
  MAX_WORKSPACE_MANIFEST_BYTES * 2 +
  MAX_RECONCILIATION_TOTAL_BYTES +
  MAX_RECONCILIATION_ENTRIES * 8 +
  8;
export class NodeWorkspaceTransferLimitError extends Error {
  readonly code = "workspace-transfer-limit";
}

export function isNodeWorkspaceTransferLimitError(
  error: unknown,
): error is NodeWorkspaceTransferLimitError {
  return error instanceof NodeWorkspaceTransferLimitError;
}

class NodeWorkspaceTransferInvalidError extends Error {
  readonly code = "workspace-transfer-invalid";

  constructor(
    readonly reason: NodeWorkspaceTransferInvalidReason,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export function nodeWorkspaceTransferInvalidReason(
  error: unknown,
): NodeWorkspaceTransferInvalidReason | undefined {
  return error instanceof NodeWorkspaceTransferInvalidError ? error.reason : undefined;
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
        if (!Buffer.isBuffer(next.value)) {
          throw new NodeWorkspaceTransferInvalidError(
            "payload",
            "Workspace transfer upload must contain binary data",
          );
        }
        this.#pending = next.value;
      }
    }
    if (this.#pending.length === 0) {
      return Buffer.alloc(0);
    }
    const count = Math.min(maxBytes, this.#pending.length);
    const value = this.#pending.subarray(0, count);
    // Coalesced records must not repeatedly copy the unread suffix.
    // Release exhausted chunks rather than retaining their backing storage.
    this.#pending =
      count === this.#pending.length ? Buffer.alloc(0) : this.#pending.subarray(count);
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
        throw new NodeWorkspaceTransferInvalidError(
          "premature_eof",
          "Workspace transfer upload ended before its declared payload",
        );
      }
      chunks.push(chunk);
      remaining -= chunk.length;
    }
    return Buffer.concat(chunks, bytes);
  }

  async assertEnd(): Promise<void> {
    if ((await this.take(1)).length !== 0) {
      throw new NodeWorkspaceTransferInvalidError(
        "trailing_bytes",
        "Workspace transfer upload contains trailing bytes",
      );
    }
  }
}

async function streamUploadFile(params: {
  reader: RequestByteReader;
  handle: FileHandle;
  entry: Extract<WorkerWorkspaceManifestEntry, { type: "file" }>;
  assertCurrent: () => void;
}): Promise<void> {
  const size = (await params.reader.readExactly(8)).readBigUInt64BE();
  if (size !== BigInt(params.entry.size)) {
    throw new NodeWorkspaceTransferInvalidError(
      "file_size",
      "Workspace transfer file size differs from its manifest",
    );
  }
  const hash = createHash("sha256");
  let offset = 0;
  while (offset < params.entry.size) {
    const chunk = await params.reader.take(Math.min(64 * 1024, params.entry.size - offset));
    if (chunk.length === 0) {
      throw new NodeWorkspaceTransferInvalidError(
        "premature_eof",
        "Workspace transfer upload ended mid-file",
      );
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
    throw new NodeWorkspaceTransferInvalidError(
      "file_digest",
      "Workspace transfer file digest differs from its manifest",
    );
  }
}

export type NodeWorkspaceTransferUpload = {
  base: WorkerWorkspaceManifest;
  baseManifestRef: string;
  baseRaw: string;
  current: WorkerWorkspaceManifest;
  currentManifestRef: string;
  currentRaw: string;
  stagingRoot: string;
};

/** Stages one bounded upload before its context owner publishes the authenticated result. */
export async function readNodeWorkspaceUpload(params: {
  request: IncomingMessage;
  baseManifestRef: string;
  temporaryRoot: string;
  signal: AbortSignal;
  assertCurrent: () => void;
  isAuthorized: () => boolean;
}): Promise<NodeWorkspaceTransferUpload> {
  const { assertCurrent } = params;
  let stagingRoot: string | undefined;
  try {
    assertCurrent();
    const contentLength = Number(params.request.headers["content-length"]);
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength < 8 ||
      contentLength > MAX_UPLOAD_BYTES
    ) {
      throw new NodeWorkspaceTransferLimitError("Workspace transfer upload exceeds its byte limit");
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
      try {
        return { raw, ref, manifest: parseWorkerWorkspaceManifest(raw, ref) };
      } catch (error) {
        throw new NodeWorkspaceTransferInvalidError(
          "manifest",
          "Workspace transfer manifest is invalid",
          { cause: error },
        );
      }
    };
    const base = await readManifest(params.baseManifestRef);
    assertCurrent();
    const current = await readManifest();
    assertCurrent();
    let transferPaths: string[];
    try {
      transferPaths = workerWorkspaceTransferPaths(current.manifest, base.manifest);
    } catch (error) {
      throw new NodeWorkspaceTransferInvalidError(
        "manifest",
        "Workspace transfer manifests cannot be reconciled",
        { cause: error },
      );
    }
    const transferPathSet = new Set(transferPaths);
    stagingRoot = await fsp.mkdtemp(path.join(params.temporaryRoot, "upload-"));
    const currentByPath = new Map(current.manifest.entries.map((entry) => [entry.path, entry]));
    for (const relative of transferPaths) {
      const entry = currentByPath.get(relative);
      if (!entry) {
        continue;
      }
      try {
        const destination = nodeWorkspaceTransferEntryPath(stagingRoot, relative);
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
      } catch (error) {
        if (error instanceof NodeWorkspaceTransferInvalidError) {
          throw error;
        }
        if (params.signal.aborted || !params.isAuthorized()) {
          throw error;
        }
        throw new NodeWorkspaceTransferInvalidError(
          "staging",
          "Workspace transfer payload could not be staged",
          { cause: error },
        );
      }
    }
    await reader.assertEnd();
    assertCurrent();
    if (reader.bytesRead !== contentLength) {
      throw new NodeWorkspaceTransferInvalidError(
        "content_length",
        "Workspace transfer upload length is inconsistent",
      );
    }
    try {
      await assertWorkspaceMatchesManifest({
        root: stagingRoot,
        manifest: current.manifest,
        entries: current.manifest.entries.filter((entry) => transferPathSet.has(entry.path)),
      });
    } catch (error) {
      throw new NodeWorkspaceTransferInvalidError(
        "staging",
        "Workspace transfer payload did not match its staged result",
        { cause: error },
      );
    }
    assertCurrent();
    return {
      base: base.manifest,
      baseManifestRef: params.baseManifestRef,
      baseRaw: base.raw,
      current: current.manifest,
      currentManifestRef: current.ref,
      currentRaw: current.raw,
      stagingRoot,
    };
  } catch (error) {
    if (stagingRoot) {
      await fsp.rm(stagingRoot, { recursive: true, force: true });
    }
    throw error;
  }
}
