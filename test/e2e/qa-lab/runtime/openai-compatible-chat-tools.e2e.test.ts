// OpenAI-compatible chat tools tests cover QA Lab HTTP tool-call evidence.
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createBoundedChildOutput } from "../../../helpers/bounded-child-output.js";
import { cleanupTempDirs, makeTempDir } from "../../../helpers/temp-dir.js";

const clientPath = path.resolve("scripts/e2e/lib/openai-chat-tools/client.mjs");
const dockerRunnerPath = path.resolve("scripts/e2e/openai-chat-tools-docker.sh");
const writeConfigPath = path.resolve("scripts/e2e/lib/openai-chat-tools/write-config.mjs");

interface ClientResult {
  error?: Error;
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
  port: number | string,
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
        error: timedOut ? new Error(`client timed out after ${timeout}ms`) : undefined,
        status,
        stderr: stderr.text(),
        stdout: stdout.text(),
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
      OPENCLAW_OPENAI_CHAT_TOOLS_MODEL: "openai/gpt-5.6-luna",
      OPENCLAW_STATE_DIR: path.join(root, "state"),
      OPENCLAW_TEST_WORKSPACE_DIR: path.join(root, "workspace"),
      PORT: "18789",
      ...env,
    },
  });
}

function runDockerRunnerAuthPreflight(root: string, env: Record<string, string> = {}) {
  return spawnSync("bash", [dockerRunnerPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: root,
      OPENAI_API_KEY: "",
      OPENAI_BASE_URL: "",
      OPENCLAW_OPENAI_CHAT_TOOLS_PROFILE_FILE: path.join(root, "missing.profile"),
      ...env,
    },
  });
}

function toolCallResponse(messageOverrides: Record<string, unknown> = {}) {
  return {
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          ...messageOverrides,
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
  let bodyReadTimeoutProbe: {
    elapsedMs: number;
    responseClosed: boolean;
    result: ClientResult;
  };

  beforeAll(async () => {
    let responseClosed = false;
    const server = createServer((_request, response) => {
      response.on("close", () => {
        responseClosed = true;
      });
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"choices":');
    });
    const port = await listen(server);
    const startedAt = Date.now();
    try {
      bodyReadTimeoutProbe = {
        result: await runClient(port, {}, 4_000),
        elapsedMs: Date.now() - startedAt,
        responseClosed,
      };
    } finally {
      server.close();
    }
  });

  it("keeps full profile exports out of the Docker build phase", () => {
    const runner = readFileSync(dockerRunnerPath, "utf8");
    const preflightSourceIndex = runner.indexOf('source "$profile_file"');
    const buildIndex = runner.indexOf("docker_e2e_build_or_reuse");
    const fullProfileSourceIndex = runner.indexOf('source "$PROFILE_FILE"', buildIndex);

    expect(preflightSourceIndex).toBeGreaterThanOrEqual(0);
    expect(buildIndex).toBeGreaterThan(preflightSourceIndex);
    expect(fullProfileSourceIndex).toBeGreaterThan(buildIndex);
  });

  it("fails auth preflight before Docker build work starts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-openai-chat-tools-"));
    try {
      const result = runDockerRunnerAuthPreflight(root);
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("OPENAI_API_KEY was not available");
      expect(output).not.toContain("Building Docker image:");
      expect(output).not.toContain("Reusing Docker image:");
      expect(output).not.toContain("Running OpenAI Chat Completions tools Docker E2E");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("treats placeholder profile auth as missing before Docker build work starts", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-openai-chat-tools-"));
    try {
      const profile = path.join(root, "profile");
      writeFileSync(profile, "OPENAI_API_KEY=undefined\n");
      const result = runDockerRunnerAuthPreflight(root, {
        OPENCLAW_OPENAI_CHAT_TOOLS_PROFILE_FILE: profile,
      });
      const output = `${result.stdout}\n${result.stderr}`;

      expect(result.status).toBe(1);
      expect(output).toContain("OPENAI_API_KEY was not available");
      expect(output).not.toContain("Building Docker image:");
      expect(output).not.toContain("Reusing Docker image:");
      expect(output).not.toContain("Running OpenAI Chat Completions tools Docker E2E");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["timeout", "OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS", "1e3"],
    ["body limit", "OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES", "64bytes"],
  ])(
    "rejects invalid Docker runner %s before auth or Docker build work starts",
    (_label, envName, value) => {
      const tempDirs: string[] = [];
      const root = makeTempDir(tempDirs, "openclaw-openai-chat-tools-");
      try {
        const result = runDockerRunnerAuthPreflight(root, { [envName]: value });
        const output = `${result.stdout}\n${result.stderr}`;

        expect(result.status).toBe(2);
        expect(output).toContain(`invalid ${envName}: ${value}`);
        expect(output).not.toContain("OPENAI_API_KEY was not available");
        expect(output).not.toContain("Building Docker image:");
        expect(output).not.toContain("Reusing Docker image:");
        expect(output).not.toContain("Running OpenAI Chat Completions tools Docker E2E");
      } finally {
        cleanupTempDirs(tempDirs);
      }
    },
  );

  it("passes normalized timeout and body limits into the Docker runner", () => {
    const runner = readFileSync(dockerRunnerPath, "utf8");

    expect(runner).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS 180",
    );
    expect(runner).toContain(
      "docker_e2e_read_positive_int_env OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES 1048576",
    );
    expect(runner).toContain('-e "OPENCLAW_OPENAI_CHAT_TOOLS_TIMEOUT_SECONDS=$TIMEOUT_SECONDS"');
    expect(runner).toContain('-e "OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES=$MAX_BODY_BYTES"');
  });

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

  it("rejects out-of-range client gateway ports", async () => {
    const result = await runClient("65536");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid PORT: 65536");
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

  it("rejects out-of-range write-config gateway ports", () => {
    const root = mkdtempSync(path.join(tmpdir(), "openclaw-openai-chat-tools-"));
    try {
      const result = runWriteConfig(root, { PORT: "65536" });

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("invalid PORT: 65536");
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

  it("rejects chat completions responses that include content beside the tool call", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(toolCallResponse({ content: "I will call the tool now." })));
    });
    const port = await listen(server);
    try {
      const result = await runClient(port);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("expected tool call only response");
    } finally {
      server.close();
    }
  });

  it("keeps the request timeout active while reading the response body", async () => {
    expect(bodyReadTimeoutProbe.result.error).toBeUndefined();
    expect(bodyReadTimeoutProbe.result.status).not.toBe(0);
    expect(bodyReadTimeoutProbe.result.stderr).toMatch(/timed out|aborted|AbortError/iu);
    expect(bodyReadTimeoutProbe.elapsedMs).toBeLessThan(3_500);
    expect(bodyReadTimeoutProbe.responseClosed).toBe(true);
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

  it("rejects declared oversized chat completion bodies before waiting on the stream", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-length": "65",
        "content-type": "application/json",
      });
      response.flushHeaders();
    });
    const port = await listen(server);
    try {
      const startedAt = Date.now();
      const result = await runClient(port, { OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES: "64" });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("chat completions response body exceeded 64 bytes");
      expect(Date.now() - startedAt).toBeLessThan(3_500);
    } finally {
      server.close();
    }
  });

  it("rejects unsafe declared chat completion body lengths before waiting on the stream", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "content-length": "9007199254740993",
        "content-type": "application/json",
      });
      response.flushHeaders();
    });
    const port = await listen(server);
    try {
      const startedAt = Date.now();
      const result = await runClient(port, { OPENCLAW_OPENAI_CHAT_TOOLS_MAX_BODY_BYTES: "64" });

      expect(result.error).toBeUndefined();
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("chat completions response body exceeded 64 bytes");
      expect(result.stderr).not.toContain("timed out");
      expect(Date.now() - startedAt).toBeLessThan(3_500);
    } finally {
      server.close();
    }
  });
});
