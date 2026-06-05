// Host Server script supports OpenClaw repository automation.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import { die, run, say, sh, warn } from "./host-command.ts";
import type { HostServer } from "./types.ts";

const HOST_SERVER_STDERR_LIMIT_BYTES = 64 * 1024;
const HOST_SERVER_STDERR_DRAIN_MS = 5_000;

export function resolveHostIp(explicit = ""): string {
  if (explicit) {
    return explicit;
  }
  const output = sh("ifconfig | awk '/inet 10\\.211\\./ { print $2; exit }'", {
    quiet: true,
  }).stdout.trim();
  if (!output) {
    die("failed to detect Parallels host IP; pass --host-ip");
  }
  return output;
}

export function allocateHostPort(): number {
  return Number(
    run(
      "python3",
      [
        "-c",
        "import socket; s=socket.socket(); s.bind(('0.0.0.0', 0)); print(s.getsockname()[1]); s.close()",
      ],
      { quiet: true },
    ).stdout.trim(),
  );
}

export async function isHostPortFree(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => resolve(false));
    server.listen(port, "0.0.0.0", () => {
      server.close(() => resolve(true));
    });
  });
}

export async function resolveHostPort(
  port: number,
  explicit: boolean,
  defaultPort: number,
): Promise<number> {
  if (await isHostPortFree(port)) {
    return port;
  }
  if (explicit) {
    die(`host port ${port} already in use`);
  }
  const allocated = allocateHostPort();
  warn(`host port ${defaultPort} busy; using ${allocated}`);
  return allocated;
}

export async function startHostServer(input: {
  dir: string;
  hostIp: string;
  port: number;
  artifactPath: string;
  label: string;
}): Promise<HostServer> {
  const actualPort = input.port || allocateHostPort();
  const child = spawn(
    "python3",
    ["-m", "http.server", String(actualPort), "--bind", "0.0.0.0", "--directory", input.dir],
    {
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForHostServer(child, actualPort);
  say(`Serve ${input.label} on ${input.hostIp}:${actualPort}`);
  return {
    hostIp: input.hostIp,
    port: actualPort,
    stop: async () => {
      await stopHostServerChild(child);
    },
    urlFor: (filePath) =>
      `http://${input.hostIp}:${actualPort}/${encodeURIComponent(path.basename(filePath))}`,
  };
}

async function stopHostServerChild(
  child: ChildProcessWithoutNullStreams,
  terminateTimeoutMs = 2_000,
  killTimeoutMs = 1_500,
): Promise<boolean> {
  if (child.exitCode != null) {
    return true;
  }
  child.kill("SIGTERM");
  if (await waitForChildExit(child, terminateTimeoutMs)) {
    return true;
  }
  child.kill("SIGKILL");
  return await waitForChildExit(child, killTimeoutMs);
}

async function waitForChildExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
): Promise<boolean> {
  if (child.exitCode != null) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const onExit = () => settle(true);
    const timeout = setTimeout(() => settle(child.exitCode != null), timeoutMs);
    timeout.unref();
    function settle(exited: boolean): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      child.off("exit", onExit);
      resolve(exited);
    }
    child.once("exit", onExit);
  });
}

async function waitForHostServer(
  child: ChildProcessWithoutNullStreams,
  port: number,
): Promise<void> {
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = appendBoundedOutput(stderr, chunk, HOST_SERVER_STDERR_LIMIT_BYTES);
  });
  let childClosed = false;
  const childClose = new Promise<void>((resolve) => {
    child.once("close", () => {
      childClosed = true;
      resolve();
    });
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode != null) {
      if (!childClosed) {
        await Promise.race([childClose, delay(HOST_SERVER_STDERR_DRAIN_MS)]);
      }
      die(`host artifact server exited early: ${stderr.trim() || `exit ${child.exitCode}`}`);
    }
    if (await canConnect(port)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  child.kill("SIGTERM");
  die(`host artifact server did not start on port ${port}: ${stderr.trim()}`);
}

function appendBoundedOutput(previous: string, chunk: Buffer, limitBytes: number): string {
  const combined = Buffer.concat([Buffer.from(previous, "utf8"), chunk]);
  if (combined.byteLength <= limitBytes) {
    return combined.toString("utf8");
  }
  return combined.subarray(combined.byteLength - limitBytes).toString("utf8");
}

async function canConnect(port: number): Promise<boolean> {
  return await new Promise((resolve) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => {
      socket.destroy();
      resolve(true);
    });
    socket.once("error", () => resolve(false));
    socket.setTimeout(250, () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export const testing = {
  appendBoundedOutput,
  stopHostServerChild,
};
