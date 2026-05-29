import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const clientPath = path.resolve("scripts/e2e/lib/openai-chat-tools/client.mjs");
const writeConfigPath = path.resolve("scripts/e2e/lib/openai-chat-tools/write-config.mjs");

interface ClientResult {
  error?: Error;
  signal: NodeJS.Signals | null;
  status: number | null;
  stderr: string;
  stdout: string;
}

async function listen(server: Server): Promise<number> {
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
  return address.port;
}

function runClient(
  port: number,
  env: Record<string, string> = {},
  timeout = 5_000,
): Promise<ClientResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [clientPath], {
      env: {
        ...process.env,
        MODEL_REF: "openai/gpt-5.4-mini",
        OPENCLAW_GATEWAY_TOKEN: "test-token",
        OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS: "1",
        PORT: String(port),
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
        error: timedOut ? new Error(`client timed out after ${timeout}ms`) : undefined,
        signal,
        status,
        stderr,
        stdout,
      });
    });
  });
}

function runWriteConfig(root: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [writeConfigPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
      OPENCLAW_GATEWAY_TOKEN: "test-token",
      OPENCLAW_OPENAI_CHAT_TOOLS_MODEL: "openai/gpt-5.5",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_TEST_WORKSPACE_DIR: path.join(root, "workspace"),
      PORT: "18789",
      ...env,
    },
  });
}

function toolCallResponse() {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          tool_calls: [
            {
              type: "function",
              function: {
                name: "get_weather",
                arguments: JSON.stringify({ city: "Paris, France" }),
              },
            },
          ],
        },
      },
    ],
  };
}

describe("scripts/e2e/lib/openai-chat-tools/client.mjs", () => {
  it("rejects loose timeout env values instead of parsing numeric prefixes", async () => {
    const result = await runClient(1, {
      OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS: "1e3",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS: 1e3");
  });

  it("rejects loose body limit env values instead of parsing numeric prefixes", async () => {
    const result = await runClient(1, {
      OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES: "64bytes",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES: 64bytes");
  });

  it("rejects loose write-config timeout env values", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-openai-chat-tools-"));
    try {
      const result = runWriteConfig(root, {
        OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS: "1e3",
      });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("invalid OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS: 1e3");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("writes strict positive timeout and port values into generated config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-openai-chat-tools-"));
    try {
      const result = runWriteConfig(root, {
        OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS: "240",
        PORT: "19001",
      });

      expect(result.status).toBe(0);
      const config = JSON.parse(readFileSync(path.join(root, "openclaw.json"), "utf8"));
      expect(config.gateway.port).toBe(19001);
      expect(config.models.providers.openai.timeoutSeconds).toBe(240);
      expect(config.agents.defaults.timeoutSeconds).toBe(240);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("accepts a matching chat completions tool call response", async () => {
    const server = createServer((request, response) => {
      expect(request.method).toBe("POST");
      expect(request.url).toBe("/v1/chat/completions");
      expect(request.headers.authorization).toBe("Bearer test-token");
      expect(request.headers["x-openclaw-model"]).toBe("openai/gpt-5.4-mini");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(toolCallResponse()));
    });
    const port = await listen(server);
    try {
      const result = await runClient(port);

      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        args: { city: "Paris, France" },
        finishReason: "tool_calls",
        ok: true,
        toolName: "get_weather",
      });
    } finally {
      server.close();
    }
  });

  it("keeps the request timeout active while reading the response body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"choices":');
    });
    const port = await listen(server);
    const startedAt = Date.now();
    try {
      const result = await runClient(port, {}, 4_000);
      const elapsedMs = Date.now() - startedAt;

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toMatch(/aborted|AbortError/iu);
      expect(elapsedMs).toBeLessThan(3_500);
    } finally {
      server.close();
    }
  });

  it("caps chat completion response bodies before JSON parsing", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end("x".repeat(256));
    });
    const port = await listen(server);
    try {
      const result = await runClient(port, { OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES: "64" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("chat completions response body exceeded 64 bytes");
    } finally {
      server.close();
    }
  });
});
