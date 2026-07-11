// E2E Helper Env Limits tests cover e2e helper env limits script behavior.
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { createBoundedChildOutput } from "../helpers/bounded-child-output.js";

const browserFixturePath = "scripts/e2e/lib/browser-cdp-snapshot/fixture-server.mjs";
const clickclackFixturePath = "scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs";
const httpProbePath = "scripts/e2e/lib/openwebui/http-probe.mjs";

function runScript(scriptPath: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [scriptPath, ...args], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function runScriptAsync(
  scriptPath: string,
  args: string[] = [],
  env: Record<string, string> = {},
  timeout = 3_000,
) {
  return new Promise<{ stderr: string; stdout: string; status: number | null }>((resolve) => {
    const child = spawn(process.execPath, [scriptPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout = createBoundedChildOutput();
    const stderr = createBoundedChildOutput();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr.append(chunk);
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve({ stderr: stderr.text(), stdout: stdout.text(), status });
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

async function allocatePort(): Promise<number> {
  const server = createServer();
  const url = await listen(server);
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  return Number(new URL(url).port);
}

async function waitForOutput(
  matches: (text: string) => boolean,
  getOutput: () => string,
): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 3_000) {
    if (matches(getOutput())) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`timed out waiting for fixture output. Output: ${getOutput()}`);
}

async function stopChild(child: ReturnType<typeof spawn>): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 1_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe("e2e helper numeric env limits", () => {
  it("rejects loose Browser CDP fixture ports", async () => {
    const result = await runScriptAsync(browserFixturePath, [], { FIXTURE_PORT: "18080http" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid FIXTURE_PORT: 18080http");
  });

  it("rejects loose release ClickClack fixture ports", () => {
    const result = runScript(clickclackFixturePath, [], {
      CLICKCLACK_FIXTURE_PORT: "44181tcp",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid CLICKCLACK_FIXTURE_PORT: 44181tcp");
  });

  it("rejects oversized ClickClack fixture request bodies", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-clickclack-fixture-"));
    const port = await allocatePort();
    const child = spawn(process.execPath, [clickclackFixturePath], {
      env: {
        ...process.env,
        CLICKCLACK_FIXTURE_PORT: String(port),
        CLICKCLACK_FIXTURE_REQUEST_MAX_BYTES: "16",
        CLICKCLACK_FIXTURE_STATE: path.join(tempDir, "state.json"),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const output = createBoundedChildOutput();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output.append(chunk);
    });
    child.stderr.on("data", (chunk) => {
      output.append(chunk);
    });
    try {
      await waitForOutput(
        (text) => text.includes(`clickclack fixture listening on ${port}`),
        () => output.text(),
      );

      const response = await fetch(`http://127.0.0.1:${port}/fixture/inbound`, {
        body: JSON.stringify({ body: "x".repeat(64) }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      const body = await response.json();

      expect(response.status).toBe(413);
      expect(body).toEqual({ error: "ClickClack fixture request body exceeded 16 bytes" });
    } finally {
      await stopChild(child);
      fs.rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it("rejects loose Open WebUI HTTP probe timeouts", () => {
    const result = runScript(httpProbePath, ["http://127.0.0.1:9"], {
      OPENCLAW_HTTP_PROBE_TIMEOUT_MS: "8000ms",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OPENCLAW_HTTP_PROBE_TIMEOUT_MS: 8000ms");
  });

  it("rejects loose Open WebUI HTTP probe expected statuses", () => {
    const result = runScript(httpProbePath, ["http://127.0.0.1:9", "2e2"]);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "expected status must be lt500 or a decimal HTTP status. Got: 2e2",
    );
  });

  it("keeps Open WebUI HTTP probe status checks working with strict timeouts", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(204).end();
    });
    const url = await listen(server);
    try {
      const result = await runScriptAsync(httpProbePath, [url, "204"], {
        OPENCLAW_HTTP_PROBE_TIMEOUT_MS: "500",
      });

      expect(result.status).toBe(0);
    } finally {
      server.close();
    }
  });

  it("keeps Open WebUI HTTP probe lt500 status checks working", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(404).end();
    });
    const url = await listen(server);
    try {
      const result = await runScriptAsync(httpProbePath, [url, "lt500"], {
        OPENCLAW_HTTP_PROBE_TIMEOUT_MS: "500",
      });

      expect(result.status).toBe(0);
    } finally {
      server.close();
    }
  });

  it("cancels Open WebUI HTTP probe response bodies", async () => {
    const { probeHttpStatus } = await import("../../scripts/e2e/lib/openwebui/http-probe.mjs");
    let canceled = false;
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      expect(init.headers).toEqual({ authorization: "Bearer token-123" });
      return new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            canceled = true;
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await expect(
      probeHttpStatus({
        bearer: "token-123",
        fetchImpl,
        timeoutMs: 500,
        url: "http://127.0.0.1/probe",
      }),
    ).resolves.toBe(true);
    expect(canceled).toBe(true);
  });

  it("clamps oversized Open WebUI HTTP probe timers before scheduling", async () => {
    const { probeHttpStatus } = await import("../../scripts/e2e/lib/openwebui/http-probe.mjs");
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, 25);
        init.signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
      return new Response(null, { status: 200 });
    }) as typeof fetch;

    await expect(
      probeHttpStatus({
        fetchImpl,
        timeoutMs: MAX_TIMER_TIMEOUT_MS + 1,
        url: "http://127.0.0.1/probe",
      }),
    ).resolves.toBe(true);
  });
});
