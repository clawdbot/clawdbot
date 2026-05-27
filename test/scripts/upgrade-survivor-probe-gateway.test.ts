import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const probePath = path.resolve("scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs");
const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-probe-"));
  tempDirs.push(dir);
  return dir;
}

interface ProbeResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

function runProbe(args: string[], timeout = 5_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probePath, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error, signal: null, status: null, stderr, stdout });
    });
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({
        error: timedOut ? new Error(`probe timed out after ${timeout}ms`) : undefined,
        signal,
        status,
        stderr,
        stdout,
      });
    });
  });
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose a TCP port");
  }
  return `http://127.0.0.1:${address.port}`;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs", () => {
  it("writes a result when the ready probe matches", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: true }));
    });
    const baseUrl = await listen(server);
    const out = path.join(makeTempDir(), "ready.json");
    try {
      const result = await runProbe([
        "--base-url",
        baseUrl,
        "--path",
        "/readyz",
        "--expect",
        "ready",
        "--out",
        out,
        "--timeout-ms",
        "1000",
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({
        body: { ready: true },
        path: "/readyz",
        status: 200,
        url: `${baseUrl}/readyz`,
      });
    } finally {
      server.close();
    }
  });

  it("bounds probes when a server accepts the connection but never responds", async () => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => {});
    });
    const baseUrl = await listen(server);
    const out = path.join(makeTempDir(), "stall.json");
    const startedAt = Date.now();
    try {
      const result = await runProbe([
        "--base-url",
        baseUrl,
        "--path",
        "/healthz",
        "--expect",
        "live",
        "--out",
        out,
        "--timeout-ms",
        "300",
        "--attempt-timeout-ms",
        "100",
      ]);
      const elapsedMs = Date.now() - startedAt;

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("probe did not satisfy live within 300ms");
      expect(elapsedMs).toBeLessThan(2_500);
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    }
  });

  it("caps response bodies before parsing probe JSON", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(256));
    });
    const baseUrl = await listen(server);
    const out = path.join(makeTempDir(), "oversized.json");
    try {
      const result = await runProbe([
        "--base-url",
        baseUrl,
        "--path",
        "/readyz",
        "--expect",
        "ready",
        "--out",
        out,
        "--timeout-ms",
        "300",
        "--max-body-bytes",
        "64",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("probe body exceeded 64 bytes");
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      server.close();
    }
  });
});
