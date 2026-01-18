import { type AddressInfo, createServer } from "node:net";
import { isMainThread, threadId } from "node:worker_threads";

async function isPortFree(port: number): Promise<boolean> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) return false;
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function getOsFreePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to acquire free port"));
        return;
      }
      const port = (addr as AddressInfo).port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

let nextTestPortOffset = 0;

/**
 * Allocate a deterministic per-worker port block.
 *
 * Motivation: many tests spin up gateway + related services that use derived ports
 * (e.g. +1/+2/+3/+4). If each test just grabs an OS free port, parallel test runs
 * can collide on derived ports and get flaky EADDRINUSE.
 */
export async function getDeterministicFreePortBlock(params?: {
  offsets?: number[];
}): Promise<number> {
  const offsets = params?.offsets ?? [0, 1, 2, 3, 4];
  const maxOffset = Math.max(...offsets);

  const workerIdRaw = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "";
  const workerId = Number.parseInt(workerIdRaw, 10);
  const shard = Number.isFinite(workerId)
    ? Math.max(0, workerId)
    : isMainThread
      ? Math.abs(process.pid)
      : Math.abs(threadId);

  const rangeSize = 1000;
  const shardCount = 30;
  const base = 30_000 + (Math.abs(shard) % shardCount) * rangeSize; // <= 59_999
  const usable = rangeSize - maxOffset;

  // Allocate in blocks to avoid derived-port overlaps (e.g. port+3).
  const blockSize = Math.max(maxOffset + 1, 8);

  for (let attempt = 0; attempt < usable; attempt += 1) {
    const start = base + ((nextTestPortOffset + attempt) % usable);
    // eslint-disable-next-line no-await-in-loop
    const ok = (await Promise.all(offsets.map((offset) => isPortFree(start + offset)))).every(
      Boolean,
    );
    if (!ok) continue;
    nextTestPortOffset = (nextTestPortOffset + attempt + blockSize) % usable;
    return start;
  }

  // Fallback: let the OS pick a port block (best effort).
  for (let attempt = 0; attempt < 25; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop
    const port = await getOsFreePort();
    // eslint-disable-next-line no-await-in-loop
    const ok = (await Promise.all(offsets.map((offset) => isPortFree(port + offset)))).every(
      Boolean,
    );
    if (ok) return port;
  }

  throw new Error("failed to acquire a free port block");
}
