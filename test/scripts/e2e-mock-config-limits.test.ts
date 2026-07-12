// E2E Mock Config Limits tests cover e2e mock config limits script behavior.
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { getFreePort } from "../../src/test-utils/ports.js";

const mockOpenAiPath = "scripts/e2e/mock-openai-server.mjs";
const webSearchMockPath = "scripts/e2e/lib/openai-web-search-minimal/mock-server.mjs";
const browserCdpFixturePath = "scripts/e2e/lib/browser-cdp-snapshot/fixture-server.mjs";
const configReloadAssertPath = "scripts/e2e/lib/config-reload/assert-log.mjs";
const clickClackFixturePath = "scripts/e2e/lib/release-user-journey/clickclack-fixture.mjs";
const scrubbedEnvKeys = [
  "CLICKCLACK_FIXTURE_PORT",
  "CLICKCLACK_FIXTURE_REQUEST_MAX_BYTES",
  "FIXTURE_PORT",
  "MOCK_PORT",
  "MOCK_REQUEST_LOG",
  "MOCK_TLS_CERT",
  "MOCK_TLS_KEY",
  "OPENCLAW_CONFIG_RELOAD_LOG_MAX_READ_BYTES",
  "OPENCLAW_CONFIG_RELOAD_LOG_PATH",
  "OPENCLAW_CONFIG_RELOAD_LOG_TIMEOUT_MS",
  "OPENCLAW_MOCK_OPENAI_PORT",
  "RAW_SCHEMA_ERROR",
  "SUCCESS_MARKER",
];

function cleanEnv(env: Record<string, string>) {
  const childEnv = { ...process.env };
  for (const key of scrubbedEnvKeys) {
    delete childEnv[key];
  }
  return { ...childEnv, ...env };
}

function runScript(scriptPath: string, env: Record<string, string>) {
  return spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    env: cleanEnv(env),
    killSignal: "SIGKILL",
    timeout: 3_000,
  });
}

async function waitForListening(child: ChildProcess, port: number, output: () => string) {
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      reject(new Error(`mock server did not listen on ${port}: ${output()}`));
    }, 3_000);
    const finish = (error?: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (error) {
        reject(error);
        return;
      }
      resolve();
    };
    if (output().includes(`mock-openai listening on ${port}`)) {
      finish();
      return;
    }
    child.stdout?.on("data", () => {
      if (output().includes(`mock-openai listening on ${port}`)) {
        finish();
      }
    });
    child.once("exit", (code, signal) => {
      finish(new Error(`mock server exited before listening: code=${code} signal=${signal}`));
    });
  });
}

async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exited = once(child, "exit").then(() => undefined);
  child.kill("SIGTERM");
  await Promise.race([
    exited,
    delay(1_000).then(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
      }
    }),
  ]);
  if (child.exitCode === null && child.signalCode === null) {
    await exited;
  }
}

async function withMockServer(
  scriptPath: string,
  env: Record<string, string>,
  run: (
    baseUrl: string,
    output: {
      stderr: () => string;
      stdout: () => string;
    },
  ) => Promise<void>,
) {
  const port = await getFreePort();
  let stderr = "";
  let stdout = "";
  const child = spawn(process.execPath, [scriptPath], {
    env: cleanEnv({ ...env, MOCK_PORT: String(port) }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk: string) => {
    stderr += chunk;
  });
  try {
    await waitForListening(child, port, () => `${stdout}\n${stderr}`);
    await run(`http://127.0.0.1:${port}`, {
      stderr: () => stderr,
      stdout: () => stdout,
    });
  } finally {
    await stopServer(child);
  }
}

describe("e2e mock and config helper numeric limits", () => {
  it("rejects loose mock OpenAI port env values", () => {
    const mockPort = runScript(mockOpenAiPath, { MOCK_PORT: "44080tcp" });
    expect(mockPort.status).not.toBe(0);
    expect(mockPort.stderr).toContain("invalid MOCK_PORT: 44080tcp");

    const fallbackPort = runScript(mockOpenAiPath, {
      OPENCLAW_MOCK_OPENAI_PORT: "44080http",
    });
    expect(fallbackPort.status).not.toBe(0);
    expect(fallbackPort.stderr).toContain("invalid OPENCLAW_MOCK_OPENAI_PORT: 44080http");
  });

  it("rejects out-of-range mock OpenAI port env values", () => {
    const mockPort = runScript(mockOpenAiPath, { MOCK_PORT: "65536" });
    expect(mockPort.status).not.toBe(0);
    expect(mockPort.stderr).toContain("invalid MOCK_PORT: 65536");

    const fallbackPort = runScript(mockOpenAiPath, {
      OPENCLAW_MOCK_OPENAI_PORT: "65536",
    });
    expect(fallbackPort.status).not.toBe(0);
    expect(fallbackPort.stderr).toContain("invalid OPENCLAW_MOCK_OPENAI_PORT: 65536");
  });

  it("rejects loose OpenAI web-search mock port env values", () => {
    const result = runScript(webSearchMockPath, { MOCK_PORT: "80http" });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid MOCK_PORT: 80http");
  });

  it("rejects out-of-range fixture listener ports", () => {
    const webSearch = runScript(webSearchMockPath, { MOCK_PORT: "65536" });
    expect(webSearch.status).not.toBe(0);
    expect(webSearch.stderr).toContain("invalid MOCK_PORT: 65536");

    const browserFixture = runScript(browserCdpFixturePath, { FIXTURE_PORT: "65536" });
    expect(browserFixture.status).not.toBe(0);
    expect(browserFixture.stderr).toContain("invalid FIXTURE_PORT: 65536");

    const clickClack = runScript(clickClackFixturePath, {
      CLICKCLACK_FIXTURE_PORT: "65536",
    });
    expect(clickClack.status).not.toBe(0);
    expect(clickClack.stderr).toContain("invalid CLICKCLACK_FIXTURE_PORT: 65536");
  });

  it("rejects loose config-reload log timeout env values", () => {
    const result = runScript(configReloadAssertPath, {
      OPENCLAW_CONFIG_RELOAD_LOG_TIMEOUT_MS: "30000ms",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OPENCLAW_CONFIG_RELOAD_LOG_TIMEOUT_MS: 30000ms");
  });

  it("rejects loose config-reload log read caps", () => {
    const result = runScript(configReloadAssertPath, {
      OPENCLAW_CONFIG_RELOAD_LOG_MAX_READ_BYTES: "256kb",
    });

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("invalid OPENCLAW_CONFIG_RELOAD_LOG_MAX_READ_BYTES: 256kb");
  });

  it("returns a clear error when mock OpenAI cannot append request logs", async () => {
    const requestLogDirectory = await mkdtemp(join(tmpdir(), "openclaw-mock-request-log-"));
    try {
      await withMockServer(
        mockOpenAiPath,
        { MOCK_REQUEST_LOG: requestLogDirectory },
        async (baseUrl, output) => {
          const response = await fetch(`${baseUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ input: "OPENCLAW_E2E_OK" }),
          });
          const body = await response.json();

          expect(response.status).toBe(500);
          expect(body.error.message).toContain("mock OpenAI request log write failed");
          await expect
            .poll(() => output.stderr(), { timeout: 1_000 })
            .toContain("mock-openai request log write failed");
        },
      );
    } finally {
      await rm(requestLogDirectory, { force: true, recursive: true });
    }
  });

  it("returns a clear error when web-search mock cannot append request logs", async () => {
    const requestLogDirectory = await mkdtemp(join(tmpdir(), "openclaw-web-search-log-"));
    try {
      await withMockServer(
        webSearchMockPath,
        {
          MOCK_REQUEST_LOG: requestLogDirectory,
          RAW_SCHEMA_ERROR: "400 schema rejected",
          SUCCESS_MARKER: "OPENCLAW_SCHEMA_E2E_OK",
        },
        async (baseUrl, output) => {
          const response = await fetch(`${baseUrl}/v1/responses`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              input: "OPENCLAW_SCHEMA_E2E_OK",
              reasoning: { effort: "low" },
              tools: [{ type: "web_search" }],
            }),
          });
          const body = await response.json();

          expect(response.status).toBe(500);
          expect(body.error.message).toContain("mock OpenAI request log write failed");
          await expect
            .poll(() => output.stderr(), { timeout: 1_000 })
            .toContain("mock-openai-web-search request log write failed");
        },
      );
    } finally {
      await rm(requestLogDirectory, { force: true, recursive: true });
    }
  });
});
