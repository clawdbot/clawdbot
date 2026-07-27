// OpenWebUI probe tests cover QA Lab OpenAI-compatible API evidence.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import path from "node:path";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it } from "vitest";
import { createBoundedChildOutput } from "../../../helpers/bounded-child-output.js";

const probePath = path.resolve("scripts/e2e/openwebui-probe.mjs");

interface ProbeResult {
  error?: Error;
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
      resolve({ error, status: null, stderr: stderr.text(), stdout: stdout.text() });
    });
    child.on("exit", (status) => {
      clearTimeout(timer);
      resolve({
        error: timedOut ? new Error(`probe timed out after ${timeout}ms`) : undefined,
        status,
        stderr: stderr.text(),
        stdout: stdout.text(),
      });
    });
  });
}

async function readRequestBody(request: IncomingMessage): Promise<string> {
  let body = "";
  request.setEncoding("utf8");
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
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

  it("rejects loose response body cap env values instead of parsing prefixes", async () => {
    const result = await runProbe("http://127.0.0.1:9", {
      OPENWEBUI_RESPONSE_BODY_MAX_BYTES: "1mb",
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "OPENWEBUI_RESPONSE_BODY_MAX_BYTES must be a positive integer; got: 1mb",
    );
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

  it("passes Open WebUI request timeouts into bounded body reads", () => {
    const script = readFileSync(probePath, "utf8");

    expect(script).toContain("run(controller.signal, timeoutPromise)");
    expect(script).toMatch(
      /readBoundedResponseTextWithLimit\(\s*response,\s*label,\s*responseBodyMaxBytes,\s*timeoutPromise,/u,
    );
    expect(script.match(/async \(signal, timeoutPromise\)/gu)).toHaveLength(3);
  });

  it("bounds sign-in error response bodies", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(500, { "content-type": "text/plain" });
        response.end("x".repeat(64));
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl, {
        OPENWEBUI_RESPONSE_BODY_MAX_BYTES: "16",
      });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("Open WebUI signin response body exceeded 16 bytes");
      expect(result.stderr).not.toContain("x".repeat(64));
    } finally {
      server.close();
    }
  });

  it("redacts admin credentials from sign-in error bodies", async () => {
    const adminEmail = "openwebui-e2e" + "@example.com";
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "invalid credentials",
            email: adminEmail,
            password: 'pa"ss',
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl, { OPENWEBUI_ADMIN_PASSWORD: 'pa"ss' });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("signin failed: HTTP 401");
      expect(result.stderr).toContain("<redacted>");
      expect(result.stderr).not.toContain(adminEmail);
      expect(result.stderr).not.toContain('pa"ss');
      expect(result.stderr).not.toContain('pa\\"ss');
    } finally {
      server.close();
    }
  });

  it("bounds model-list error response bodies", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "openwebui-session=chat=secret=cookie; Path=/",
        });
        response.end(JSON.stringify({ token: "chat-secret-token" }));
        return;
      }
      if (request.url === "/api/models") {
        response.writeHead(502, { "content-type": "text/plain" });
        response.end("y".repeat(96));
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl, {
        OPENWEBUI_RESPONSE_BODY_MAX_BYTES: "32",
      });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Open WebUI models attempt 1 response body exceeded 32 bytes",
      );
      expect(result.stderr).not.toContain("y".repeat(96));
    } finally {
      server.close();
    }
  });

  it("redacts auth material from model-list error bodies", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "openwebui-session=model=secret=cookie; Path=/",
        });
        response.end(JSON.stringify({ token: "model-secret-token" }));
        return;
      }
      if (request.url === "/api/models") {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: "upstream rejected Authorization Bearer model-secret-token",
            cookieValue: "model=secret=cookie",
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl);

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("HTTP 502");
      expect(result.stderr).toContain("<redacted>");
      expect(result.stderr).not.toContain("model-secret-token");
      expect(result.stderr).not.toContain("model=secret=cookie");
    } finally {
      server.close();
    }
  });

  it("does not sleep after the final model-list attempt", async () => {
    const server = createServer((request, response) => {
      if (request.url === "/api/v1/auths/signin") {
        response.writeHead(200, {
          "content-type": "application/json",
          "set-cookie": "openwebui-session=chat=secret=cookie; Path=/",
        });
        response.end(JSON.stringify({ token: "chat-secret-token" }));
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
        setTimeout(() => {
          response.writeHead(200, {
            "content-type": "application/json",
            "set-cookie": "openwebui-session=test; Path=/",
          });
          response.end(JSON.stringify({ token: "test-token" }));
        }, 25);
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
      const result = await runProbe(baseUrl, {
        OPENWEBUI_CONTROL_TIMEOUT_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
        OPENWEBUI_FETCH_TIMEOUT_MS: String(MAX_TIMER_TIMEOUT_MS + 1),
      });

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

  it("runs chat mode through Open WebUI chat completions and validates the nonce", async () => {
    const chatRequests: unknown[] = [];
    const server = createServer(async (request, response) => {
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
        response.end(JSON.stringify({ data: [{ id: "openclaw/default" }] }));
        return;
      }
      if (request.url === "/api/chat/completions") {
        expect(request.headers.authorization).toBe("Bearer test-token");
        expect(request.headers.cookie).toContain("openwebui-session=test");
        chatRequests.push(JSON.parse(await readRequestBody(request)));
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            choices: [{ message: { content: "OpenClaw replied with nonce-123" } }],
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl, { OPENWEBUI_SMOKE_MODE: "chat" });

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        model: "openclaw/default",
        ok: true,
        reply: "OpenClaw replied with nonce-123",
      });
      expect(chatRequests).toEqual([
        {
          messages: [{ content: "reply with nonce-123", role: "user" }],
          model: "openclaw/default",
        },
      ]);
    } finally {
      server.close();
    }
  });

  it("fails chat mode when the Open WebUI reply omits the expected nonce", async () => {
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
        response.end(JSON.stringify({ data: [{ id: "openclaw/default" }] }));
        return;
      }
      if (request.url === "/api/chat/completions") {
        const authorization = request.headers.authorization ?? "";
        const cookie = request.headers.cookie ?? "";
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            message: {
              content: `missing the marker with ${authorization} and ${cookie}`,
            },
          }),
        );
        return;
      }
      response.writeHead(404).end();
    });
    const baseUrl = await listen(server);
    try {
      const result = await runProbe(baseUrl, { OPENWEBUI_SMOKE_MODE: "chat" });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("chat reply missing nonce");
      expect(result.stderr).toContain("<redacted>");
      expect(result.stderr).not.toContain("chat-secret-token");
      expect(result.stderr).not.toContain("chat=secret=cookie");
      expect(result.stderr).not.toContain("openwebui-session=chat");
    } finally {
      server.close();
    }
  });
});
