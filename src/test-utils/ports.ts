// Allocates available local ports for tests that start servers.
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { platform } from "node:os";
import { isMainThread, threadId } from "node:worker_threads";
import { resolveGlobalSingleton } from "../shared/global-singleton.js";

type PortProbe = { free: boolean; error?: NodeJS.ErrnoException };
type PortRange = { start: number; end: number };
type PortPool = { ranges: PortRange[]; excludesEphemeral: boolean };

// Nonprivileged ports blocked by Fetch; Gateway callers use HTTP and WebSockets.
// https://fetch.spec.whatwg.org/#port-blocking
const httpBlockedPorts = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

const hostPortPool = resolveGlobalSingleton<{ value?: PortPool }>(
  Symbol.for("openclaw.testPortPool"),
  () => ({}),
);

function getPortPool(): PortPool {
  if (hostPortPool.value) {
    return hostPortPool.value;
  }
  if (platform() !== "linux") {
    return (hostPortPool.value = {
      ranges: [{ start: 30_000, end: 64_999 }],
      excludesEphemeral: false,
    });
  }
  let raw: string;
  try {
    raw = readFileSync("/proc/sys/net/ipv4/ip_local_port_range", "utf8");
  } catch (cause) {
    throw new Error("failed to read Linux ephemeral TCP port range", { cause });
  }
  const match = /^\s*(\d+)\s+(\d+)\s*$/u.exec(raw);
  const low = Number(match?.[1]);
  const high = Number(match?.[2]);
  if (!match || low < 1 || high > 65535 || low > high) {
    throw new Error("invalid Linux ephemeral TCP port range");
  }
  // A probe is not a lease: startup's outbound sockets can claim its port and
  // leave TIME_WAIT behind before the listener binds. Keep test listeners out
  // of the kernel's client-port pool, including derived ports and fallback.
  return (hostPortPool.value = {
    ranges: [
      { start: 1024, end: low - 1 },
      { start: Math.max(1024, high + 1), end: 65535 },
    ].filter((range) => range.start <= range.end),
    excludesEphemeral: true,
  });
}

async function probePort(port: number): Promise<PortProbe> {
  if (!Number.isFinite(port) || port <= 0 || port > 65535) {
    return { free: false };
  }
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", (error: NodeJS.ErrnoException) => resolve({ free: false, error }));
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve({ free: true }));
    });
  });
}

export async function isPortFree(port: number): Promise<boolean> {
  return (await probePort(port)).free;
}

async function isPortBlockFree(start: number, offsets: number[]): Promise<boolean> {
  if (offsets.some((offset) => httpBlockedPorts.has(start + offset))) {
    return false;
  }
  const probes = await Promise.all(offsets.map((offset) => probePort(start + offset)));
  for (const probe of probes) {
    if (probe.error?.code === "EPERM" || probe.error?.code === "EACCES") {
      throw probe.error;
    }
  }
  return probes.every((probe) => probe.free);
}

export async function getFreePort(host = "127.0.0.1"): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, host, () => {
      const addr = server.address();
      if (!addr || typeof addr === "string") {
        server.close();
        reject(new Error("failed to acquire free port"));
        return;
      }
      const port = addr.port;
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
  return allocateDeterministicPortBlock(params?.offsets ?? [0, 1, 2, 3, 4], false);
}

async function allocateDeterministicPortBlock(
  offsets: number[],
  allowPermissionFallback: boolean,
): Promise<number> {
  if (
    offsets.length === 0 ||
    offsets.some((offset) => !Number.isInteger(offset) || offset < 0 || offset > 65535 - 1024)
  ) {
    throw new Error(
      "test port offsets must be nonnegative integers within nonprivileged TCP bounds",
    );
  }
  const maxOffset = Math.max(...offsets);

  const workerIdRaw = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? "";
  const workerId = Number.parseInt(workerIdRaw, 10);
  const processShard = Math.abs(process.pid);
  const shard = Number.isFinite(workerId)
    ? Math.max(0, workerId) + processShard
    : isMainThread
      ? processShard
      : processShard + Math.abs(threadId);

  const pool = getPortPool();
  const canUseBlock = async (start: number): Promise<boolean> => {
    try {
      return await isPortBlockFree(start, offsets);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException | undefined)?.code;
      if (
        allowPermissionFallback &&
        pool.excludesEphemeral &&
        (code === "EPERM" || code === "EACCES")
      ) {
        // Socket-denied callers still need the same safe pool and HTTP checks.
        // Retain this candidate without attempting another denied probe.
        return true;
      }
      throw err;
    }
  };
  const rangeSize = Math.max(1000, maxOffset + 1);
  const shards = pool.ranges.flatMap((range) => {
    const ranges: PortRange[] = [];
    for (let start = range.start; start <= range.end; start += rangeSize) {
      const end = Math.min(start + rangeSize - 1, range.end);
      if (end - start >= maxOffset) {
        ranges.push({ start, end });
      }
    }
    return ranges;
  });
  const shardIndex = Math.abs(shard) % shards.length;
  const primary = shards[shardIndex];
  if (!primary) {
    throw new Error("no nonprivileged test port block fits outside the ephemeral TCP range");
  }
  const usable = primary.end - primary.start + 1 - maxOffset;

  // Allocate in blocks to avoid derived-port overlaps (e.g. port+3).
  const blockSize = Math.max(maxOffset + 1, 8);

  // Scan in block-size steps. Tests consume neighboring derived ports (+1/+2/...),
  // so probing every single offset is wasted work and slows large suites.
  for (let attempt = 0; attempt < usable; attempt += blockSize) {
    const start = primary.start + ((nextTestPortOffset + attempt) % usable);
    const ok = await canUseBlock(start);
    if (!ok) {
      continue;
    }
    nextTestPortOffset = (nextTestPortOffset + attempt + blockSize) % usable;
    return start;
  }

  // Try other safe worker shards on Linux. Asking its kernel for port zero
  // would put the fallback straight back into the excluded ephemeral range.
  for (let attempt = 0; attempt < 25; attempt += 1) {
    const alternative = shards[(shardIndex + attempt + 1) % shards.length];
    if (!alternative) {
      break;
    }
    const available = alternative.end - alternative.start + 1 - maxOffset;
    const port = pool.excludesEphemeral
      ? alternative.start + ((nextTestPortOffset + attempt * blockSize) % available)
      : await getFreePort();
    const ok = await canUseBlock(port);
    if (ok) {
      return port;
    }
  }

  throw new Error("failed to acquire a free port block");
}

export async function getFreePortBlockWithPermissionFallback(params: {
  offsets: number[];
  fallbackBase: number;
}): Promise<number> {
  try {
    return await allocateDeterministicPortBlock(params.offsets, true);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM" || code === "EACCES") {
      return params.fallbackBase + (process.pid % 10_000);
    }
    throw err;
  }
}
