import { spawn } from "node:child_process";
import { createServer, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import path from "node:path";
import { describe, expect, it } from "vitest";

const probePath = path.resolve("scripts/e2e/openwebui-probe.mjs");

interface ProbeResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

async function listen(server: HttpServer | TcpServer): Promise<string> {
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

function runProbe(baseUrl: string, env: Record<string, string> = {}, timeout = 3_000) {
  return new Promise<ProbeResult>((resolve) => {
    const child = spawn(process.execPath, [probePath], {
      env: {
        ...process.env,
        OPENWEBUI_ADMIN_EMAIL: "openwebui-e2e@example.com",
        OPENWEBUI_ADMIN_PASSWORD: "test-password",
        OPENWEBUI_BASE_URL: baseUrl,
        OPENWEBUI_CONTROL_TIMEOUT_MS: "250",
        OPENWEBUI_EXPECTED_NONCE: "nonce-123",
        OPENWEBUI_MODEL_ATTEMPTS: "1",
        OPENWEBUI_MODEL_RETRY_MS: "0",
        OPENWEBUI_PROMPT: "reply with nonce-123",
        OPENWEBUI_SMOKE_MODE: "models",
        ...env,
      },
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

describe("scripts/e2e/openwebui-probe.mjs", () => {
  it("rejects loose numeric timeout env values instead of parsing prefixes", async () => {
    const result = await runProbe("http://127.0.0.1:9", {
      OPENWEBUI_CONTROL_TIMEOUT_MS: "25ms",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENWEBUI_CONTROL_TIMEOUT_MS must be a positive integer; got: 25ms",
    );
  });

  it("rejects zero where positive retry counts are required", async () => {
    const result = await runProbe("http://127.0.0.1:9", {
      OPENWEBUI_MODEL_ATTEMPTS: "0",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("OPENWEBUI_MODEL_ATTEMPTS must be a positive integer; got: 0");
  });

  it("uses a short control-plane timeout for stalled sign-in requests", async () => {
    const sockets = new Set<Socket>();
    const server = createTcpServer((socket) => {
      sockets.add(socket);
      socket.on("close", () => sockets.delete(socket));
      socket.on("data", () => {});
    });
    const baseUrl = await listen(server);
    const startedAt = Date.now();
    try {
      const result = await runProbe(
        baseUrl,
        {
          OPENWEBUI_CONTROL_TIMEOUT_MS: "25",
          OPENWEBUI_FETCH_TIMEOUT_MS: "5000",
        },
        2_000,
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Open WebUI signin timed out after 25ms");
      expect(elapsedMs).toBeLessThan(1500);
    } finally {
      for (const socket of sockets) {
        socket.destroy();
      }
      server.close();
    }
  });

  it("keeps the control-plane timeout active while reading sign-in bodies", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(200, { "content-type": "application/json" });
        response.flushHeaders();
        response.write("{");
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(
        baseUrl,
        {
          OPENWEBUI_CONTROL_TIMEOUT_MS: "25",
          OPENWEBUI_FETCH_TIMEOUT_MS: "5000",
        },
        2_000,
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Open WebUI signin timed out after 25ms");
    } finally {
      server.close();
    }
  });

  it("does not sleep after the final model-list attempt", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "openwebui-session=test; Path=/",
        });
        response.end(JSON.stringify({ token: "test-token" }));
        return;
      }
      if (request.url === "/api/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "other-model" }] }));
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(
        baseUrl,
        {
          OPENWEBUI_MODEL_ATTEMPTS: "1",
          OPENWEBUI_MODEL_RETRY_MS: "1500",
        },
        1_000,
      );

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("openclaw model missing from Open WebUI model list");
    } finally {
      server.close();
    }
  });

  it("passes in models mode when Open WebUI exposes the OpenClaw model", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "openwebui-session=test; Path=/",
        });
        response.end(JSON.stringify({ token: "test-token" }));
        return;
      }
      if (request.url === "/api/models") {
        expect(request.headers.authorization).toBe("Bearer test-token");
        expect(request.headers.cookie).toContain("openwebui-session=test");
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "openclaw/default" }] }));
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        mode: "models",
        model: "openclaw/default",
        ok: true,
      });
    } finally {
      server.close();
    }
  });
});
