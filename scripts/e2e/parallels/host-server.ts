import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import path from "node:path";
import { die, run, say, sh, warn } from "./host-command.ts";
import type { HostServer } from "./types.ts";

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
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000).unref();
      });
    },
    urlFor: (filePath) =>
      `http://${input.hostIp}:${actualPort}/${encodeURIComponent(path.basename(filePath))}`,
  };
}

async function waitForHostServer(
  child: ChildProcessWithoutNullStreams,
  port: number,
): Promise<void> {
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const startedAt = Date.now();
  while (Date.now() - startedAt < 10_000) {
    if (child.exitCode != null) {
      die(`host artifact server exited early: ${stderr.trim() || `exit ${child.exitCode}`}`);
    }
    if (await canConnect(port)) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill("SIGTERM");
  die(`host artifact server did not start on port ${port}: ${stderr.trim()}`);
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
