// Upgrade Survivor Probe Gateway tests cover upgrade survivor probe gateway script behavior.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";

const probePath = path.resolve("scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs");
const dockerSurvivorPath = path.resolve("scripts/e2e/upgrade-survivor-docker.sh");
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

function runProbe(
  args: string[],
  timeout = 5_000,
  env: NodeJS.ProcessEnv = {},
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [probePath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createBoundedChildOutput();
    const stderr = createBoundedChildOutput();
    let timedOut = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeout);
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ error, signal: null, status: null, stderr: stderr.text(), stdout: stdout.text() });
    });
    child.on("exit", (status, signal) => {
      clearTimeout(timer);
      resolve({
        error: timedOut ? new Error(`probe timed out after ${timeout}ms`) : undefined,
        signal,
        status,
        stderr: stderr.text(),
        stdout: stdout.text(),
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
  it("does not hard-code degraded ready allowlists into Docker survivor probes", () => {
    const script = fs.readFileSync(dockerSurvivorPath, "utf8");

    expect(script).not.toContain("--allow-failing discord,telegram,whatsapp,feishu,matrix");
  });

  it("rejects loose numeric probe limits instead of parsing prefixes", async () => {
    const out = path.join(makeTempDir(), "invalid.json");
    const timeoutResult = await runProbe([
      "--base-url",
      "http://127.0.0.1:9",
      "--path",
      "/readyz",
      "--expect",
      "ready",
      "--out",
      out,
      "--timeout-ms",
      "1e3",
    ]);

    expect(timeoutResult.status).not.toBe(0);
    expect(timeoutResult.stderr).toContain("invalid --timeout-ms: 1e3");

    const bodyLimitResult = await runProbe(
      ["--base-url", "http://127.0.0.1:9", "--path", "/readyz", "--expect", "ready", "--out", out],
      5_000,
      {
        OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES: "64bytes",
      },
    );

    expect(bodyLimitResult.status).not.toBe(0);
    expect(bodyLimitResult.stderr).toContain(
      "invalid OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES: 64bytes",
    );
  });

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

  it("rejects degraded ready responses by default even when failing components are allowlisted", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: false, failing: ["telegram"] }));
    });
    const baseUrl = await listen(server);
    const out = path.join(makeTempDir(), "ready-degraded.json");
    try {
      const result = await runProbe([
        "--base-url",
        baseUrl,
        "--path",
        "/readyz",
        "--expect",
        "ready",
        "--allow-failing",
        "telegram",
        "--out",
        out,
        "--timeout-ms",
        "300",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("probe failed with HTTP 503");
      expect(fs.existsSync(out)).toBe(false);
    } finally {
      server.close();
    }
  });

  it("allows degraded ready responses only when degraded readiness is explicit", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(503, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: false, failing: ["telegram"] }));
    });
    const baseUrl = await listen(server);
    const out = path.join(makeTempDir(), "ready-degraded.json");
    try {
      const result = await runProbe([
        "--base-url",
        baseUrl,
        "--path",
        "/readyz",
        "--expect",
        "ready",
        "--allow-failing",
        "telegram",
        "--allow-degraded-ready",
        "--out",
        out,
        "--timeout-ms",
        "300",
      ]);

      expect(result.status).toBe(0);
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({
        body: { failing: ["telegram"], ready: false },
        path: "/readyz",
        status: 503,
      });
    } finally {
      server.close();
    }
  });

  it("does not let degraded ready mode convert generic server errors into success", async () => {
    const server = createHttpServer((_request, response) => {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ ready: true }));
    });
    const baseUrl = await listen(server);
    const out = path.join(makeTempDir(), "ready-server-error.json");
    try {
      const result = await runProbe([
        "--base-url",
        baseUrl,
        "--path",
        "/readyz",
        "--expect",
        "ready",
        "--allow-failing",
        "telegram",
        "--allow-degraded-ready",
        "--out",
        out,
        "--timeout-ms",
        "300",
      ]);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("probe failed with HTTP 500");
      expect(fs.existsSync(out)).toBe(false);
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
