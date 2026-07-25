// Gateway Bench Probes script supports OpenClaw repository automation.
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { createServer } from "node:net";
import { expectDefined } from "../../packages/normalization-core/src/expect.js";

export async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate port")));
        return;
      }
      const { port } = address;
      server.close(() => resolve(port));
    });
  });
}

export async function requestProbeStatus(
  port: number,
  pathname: string,
): Promise<{ errorKind: string | null; status: number | null }> {
  try {
    const status = await requestStatus(port, pathname);
    return {
      errorKind: status === 200 ? null : `http-${status}`,
      status,
    };
  } catch (error) {
    return {
      errorKind: classifyProbeErrorKind(error),
      status: null,
    };
  }
}

function classifyProbeErrorKind(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.trim()) {
      return code.trim().toLowerCase();
    }
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.toLowerCase().includes("probe timeout")) {
      return "timeout";
    }
    const name = (error as { name?: unknown }).name;
    if (typeof name === "string" && name.trim()) {
      return name.trim().toLowerCase();
    }
  }
  return "error";
}

export function readProcessRssMb(pid: number | undefined): number | null {
  if (!pid || process.platform === "win32") {
    return null;
  }
  const result = spawnSync("ps", ["-o", "rss=", "-p", String(pid)], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }
  const rssKb = parseProcessRssKb(result.stdout);
  return rssKb === null ? null : rssKb / 1024;
}

export function parseProcessRssKb(raw: string): number | null {
  const value = raw.trim();
  if (!/^[1-9][0-9]*$/u.test(value)) {
    return null;
  }
  const rssKb = Number(value);
  return Number.isSafeInteger(rssKb) ? rssKb : null;
}

export function readProcessTreeCpuMs(rootPid: number | undefined): number | null {
  if (!rootPid || process.platform === "win32") {
    return null;
  }
  const result = spawnSync("ps", ["-eo", "pid=,ppid=,time="], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) {
    return null;
  }

  const childrenByParent = new Map<number, number[]>();
  const cpuByPid = new Map<number, number>();
  for (const line of result.stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)$/u);
    if (!match) {
      continue;
    }
    const pid = Number(expectDefined(match[1], "process id from ps output"));
    const ppid = Number(expectDefined(match[2], "parent process id from ps output"));
    const cpuMs = parsePsCpuTimeMs(expectDefined(match[3], "CPU time from ps output"));
    if (!Number.isInteger(pid) || !Number.isInteger(ppid) || cpuMs === null) {
      continue;
    }
    cpuByPid.set(pid, cpuMs);
    const children = childrenByParent.get(ppid) ?? [];
    children.push(pid);
    childrenByParent.set(ppid, children);
  }
  if (!cpuByPid.has(rootPid)) {
    return null;
  }

  let totalCpuMs = 0;
  const seen = new Set<number>();
  const stack = [rootPid];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (!pid || seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    totalCpuMs += cpuByPid.get(pid) ?? 0;
    for (const childPid of childrenByParent.get(pid) ?? []) {
      stack.push(childPid);
    }
  }
  return totalCpuMs;
}

function requestStatus(port: number, pathname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request(
      { host: "127.0.0.1", method: "GET", path: pathname, port, timeout: 100 },
      (res) => {
        res.resume();
        res.on("end", () => resolve(res.statusCode ?? 0));
      },
    );
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error("probe timeout"));
    });
    req.end();
  });
}

function parsePsCpuTimeMs(raw: string): number | null {
  const parts = raw.trim().split(":").map(Number);
  if (parts.some((part) => !Number.isFinite(part) || part < 0)) {
    return null;
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts;
    return Math.round(
      (expectDefined(minutes, "process CPU minutes") * 60 +
        expectDefined(seconds, "process CPU seconds")) *
        1000,
    );
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts;
    return Math.round(
      (expectDefined(hours, "process CPU hours") * 60 * 60 +
        expectDefined(minutes, "process CPU minutes") * 60 +
        expectDefined(seconds, "process CPU seconds")) *
        1000,
    );
  }
  return null;
}
