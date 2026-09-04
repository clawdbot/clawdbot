import { createHash } from "node:crypto";
import type { FileHandle } from "node:fs/promises";
import type { IncomingMessage } from "node:http";
import type { NodeWorkspaceTransferInvalidReason } from "../../worker/node-workspace-transfer-protocol.js";
import { MAX_WORKSPACE_MANIFEST_BYTES } from "./workspace-inventory-limits.js";
import {
  MAX_RECONCILIATION_TOTAL_BYTES,
  MAX_RECONCILIATION_ENTRIES,
  type WorkerWorkspaceManifestEntry,
} from "./workspace-manifest.js";

export const MAX_UPLOAD_BYTES =
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

export class NodeWorkspaceTransferInvalidError extends Error {
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

export class RequestByteReader {
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

export async function streamUploadFile(params: {
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
