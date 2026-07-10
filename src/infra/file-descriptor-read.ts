// Bounded reads for file descriptors already pinned by a boundary open.
import fs from "node:fs";

const READ_CHUNK_BYTES = 64 * 1024;

function createScratchBuffer(maxBytes: number): Buffer {
  return Buffer.allocUnsafe(Math.min(READ_CHUNK_BYTES, Math.max(1, maxBytes + 1)));
}

function appendChunk(params: {
  chunks: Buffer[];
  scratch: Buffer;
  bytesRead: number;
  total: number;
  maxBytes: number;
}): number {
  const total = params.total + params.bytesRead;
  if (total > params.maxBytes) {
    throw new RangeError(`File exceeds ${params.maxBytes} bytes`);
  }
  params.chunks.push(Buffer.from(params.scratch.subarray(0, params.bytesRead)));
  return total;
}

/** Read at most maxBytes from the descriptor without an unbounded allocation. */
export function readFileDescriptorBoundedSync(fd: number, maxBytes: number): Buffer {
  const chunks: Buffer[] = [];
  const scratch = createScratchBuffer(maxBytes);
  let total = 0;
  while (true) {
    const bytesRead = fs.readSync(fd, scratch, 0, scratch.length, null);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total = appendChunk({ chunks, scratch, bytesRead, total, maxBytes });
  }
}

function readChunk(fd: number, scratch: Buffer): Promise<number> {
  return new Promise((resolve, reject) => {
    fs.read(fd, scratch, 0, scratch.length, null, (error, bytesRead) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(bytesRead);
    });
  });
}

/** Async variant for request paths; caller retains descriptor ownership. */
export async function readFileDescriptorBounded(fd: number, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const scratch = createScratchBuffer(maxBytes);
  let total = 0;
  while (true) {
    const bytesRead = await readChunk(fd, scratch);
    if (bytesRead === 0) {
      return Buffer.concat(chunks, total);
    }
    total = appendChunk({ chunks, scratch, bytesRead, total, maxBytes });
  }
}
