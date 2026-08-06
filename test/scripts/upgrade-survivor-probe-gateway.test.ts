// Upgrade Survivor Probe Gateway tests cover upgrade survivor probe gateway script behavior.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Server, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";

const probePath = path.resolve("scripts/e2e/lib/upgrade-survivor/probe-gateway.mjs");
const dockerSurvivorPath = path.resolve("scripts/e2e/upgrade-survivor-docker.sh");
const tempDirs: string[] = [];
const LOAD_SENSITIVE_PROCESS_TIMEOUT_MS = process.env.CI ? 30_000 : 15_000;

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-upgrade-probe-"));
  tempDirs.push(dir);
  return dir;
}

function writeProbeImport(source: string): string[] {
  const fixturePath = path.join(makeTempDir(), "probe-import.mjs");
  fs.writeFileSync(fixturePath, source);
  return ["--import", pathToFileURL(fixturePath).href];
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
  timeout = LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
  env: NodeJS.ProcessEnv = {},
  nodeArgs: string[] = [],
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [...nodeArgs, probePath, ...args], {
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

  it("keeps failed probe retries inside the total timeout", async () => {
    const baseUrl = "http://probe.test";
    const out = path.join(makeTempDir(), "ready-timeout.json");
    const nodeArgs = writeProbeImport(
      [
        "const realSetTimeout = globalThis.setTimeout;",
        "let now = 0;",
        "Date.now = () => now;",
        'globalThis.fetch = async () => new Response(JSON.stringify({ ready: false, failing: ["gateway"] }), { status: 503, headers: { "content-type": "application/json" } });',
        "globalThis.setTimeout = (callback, delay = 0, ...args) => {",
        "  if (delay === 50) {",
        "    now += delay;",
        "    return realSetTimeout(callback, 0, ...args);",
        "  }",
        "  return realSetTimeout(callback, delay, ...args);",
        "};",
      ].join("\n"),
    );
    // Virtualize fetch and only the retry sleep; CPU scheduling cannot consume the test budget.
    const result = await runProbe(
      [
        "--base-url",
        baseUrl,
        "--path",
        "/readyz",
        "--expect",
        "ready",
        "--out",
        out,
        "--timeout-ms",
        "50",
        "--attempt-timeout-ms",
        "25",
      ],
      LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
      {},
      nodeArgs,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("probe did not satisfy ready within 50ms");
    expect(fs.existsSync(out)).toBe(false);
  });

  it("allows degraded ready responses only when degraded readiness is explicit", async () => {
    const baseUrl = "http://probe.test";
    const out = path.join(makeTempDir(), "ready-degraded.json");
    const nodeArgs = writeProbeImport(
      'globalThis.fetch = async () => new Response(JSON.stringify({ ready: false, failing: ["telegram"] }), { status: 503, headers: { "content-type": "application/json" } });',
    );
    const result = await runProbe(
      [
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
      ],
      LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
      {},
      nodeArgs,
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(fs.readFileSync(out, "utf8"))).toMatchObject({
      body: { failing: ["telegram"], ready: false },
      path: "/readyz",
      status: 503,
    });
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

  it("rejects declared oversized probe bodies before waiting on the stream", async () => {
    const baseUrl = "http://probe.test";
    const out = path.join(makeTempDir(), "oversized.json");
    const nodeArgs = writeProbeImport(
      'globalThis.fetch = async () => new Response(new ReadableStream({ start() {} }), { status: 200, headers: { "content-length": "65", "content-type": "application/json" } });',
    );
    const result = await runProbe(
      [
        "--base-url",
        baseUrl,
        "--path",
        "/healthz",
        "--expect",
        "live",
        "--out",
        out,
        "--timeout-ms",
        "200",
        "--attempt-timeout-ms",
        "100",
      ],
      LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
      { OPENCLAW_UPGRADE_SURVIVOR_PROBE_MAX_BODY_BYTES: "64" },
      nodeArgs,
    );

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(`${baseUrl}/healthz probe body exceeded 64 bytes`);
    expect(fs.existsSync(out)).toBe(false);
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

  it("keeps the attempt timeout active while reading probe bodies", async () => {
    const sockets = new Set<Socket>();
    const server = createHttpServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"ok":');
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
    });
    const baseUrl = await listen(server);
    const out = path.join(makeTempDir(), "body-stall.json");
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
      expect(result.stderr).toContain("probe attempt timed out after 100ms");
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
    const baseUrl = "http://probe.test";
    const out = path.join(makeTempDir(), "oversized.json");
    const nodeArgs = writeProbeImport(
      'globalThis.fetch = async () => new Response("x".repeat(256), { status: 200, headers: { "content-type": "application/json" } });',
    );
    const result = await runProbe(
      [
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
      ],
      LOAD_SENSITIVE_PROCESS_TIMEOUT_MS,
      {},
      nodeArgs,
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("probe body exceeded 64 bytes");
    expect(fs.existsSync(out)).toBe(false);
  });
});
