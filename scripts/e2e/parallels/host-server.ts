// Host Server script supports OpenClaw repository automation.
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Readable } from "node:stream";
import { sleep as delay } from "../../lib/sleep.mjs";
import { die, run, say, sh, warn } from "./host-command.ts";
import type { HostServer, NpmRegistryPackage, NpmRegistryServer } from "./types.ts";

const HOST_SERVER_STDERR_LIMIT_BYTES = 64 * 1024;
const HOST_SERVER_STDERR_DRAIN_MS = 5_000;
type HostServerChild = ChildProcess & { stderr: Readable };

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

function allocateHostPort(): number {
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

async function isHostPortFree(port: number): Promise<boolean> {
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

export async function startNpmRegistryServer(input: {
  hostIp: string;
  packages: NpmRegistryPackage[];
}): Promise<NpmRegistryServer> {
  if (input.packages.length === 0) {
    die("npm registry server requires at least one package");
  }
  const port = allocateHostPort();
  const portFile = path.join(tmpdir(), `openclaw-npm-registry-${randomUUID()}.port`);
  const packageArgs = input.packages.flatMap((pkg) => [pkg.name, pkg.version, pkg.tarballPath]);
  const child = spawn(
    process.execPath,
    ["scripts/e2e/lib/plugins/npm-registry-server.mjs", portFile, ...packageArgs],
    {
      env: {
        ...process.env,
        OPENCLAW_NPM_REGISTRY_BIND_HOST: "0.0.0.0",
        OPENCLAW_NPM_REGISTRY_PORT: String(port),
        OPENCLAW_NPM_REGISTRY_UPSTREAM: "https://registry.npmjs.org",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  await waitForHostServer(child, port);
  const url = `http://${input.hostIp}:${port}`;
  say(`Serve prepared npm package set on ${url}`);
  return {
    url,
    stop: async () => {
      try {
        await stopHostServerChild(child);
      } finally {
        await rm(portFile, { force: true });
      }
    },
  };
}

async function stopHostServerChild(
  child: HostServerChild,
  terminateTimeoutMs = 2_000,
  killTimeoutMs = 1_500,
): Promise<boolean> {
  if (hasHostServerChildExited(child)) {
    return true;
  }
  child.kill("SIGTERM");
  if (await waitForChildExit(child, terminateTimeoutMs)) {
    return true;
  }
  child.kill("SIGKILL");
  return await waitForChildExit(child, killTimeoutMs);
}

async function waitForChildExit(child: HostServerChild, timeoutMs: number): Promise<boolean> {
  if (hasHostServerChildExited(child)) {
    return true;
  }
  return await new Promise<boolean>((resolve) => {
    let settled = false;
    const onExit = () => settle(true);
    const timeout = setTimeout(() => settle(hasHostServerChildExited(child)), timeoutMs);
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

function hasHostServerChildExited(child: HostServerChild): boolean {
  return child.exitCode != null || child.signalCode != null;
}

async function waitForHostServer(child: HostServerChild, port: number): Promise<void> {
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
    if (hasHostServerChildExited(child)) {
      if (!childClosed) {
        await Promise.race([childClose, delay(HOST_SERVER_STDERR_DRAIN_MS)]);
      }
      die(`host artifact server exited early: ${stderr.trim() || formatHostServerExit(child)}`);
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

function formatHostServerExit(child: HostServerChild): string {
  return child.signalCode ? `signal ${child.signalCode}` : `exit ${child.exitCode ?? "unknown"}`;
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

export const testing = {
  appendBoundedOutput,
  stopHostServerChild,
};
