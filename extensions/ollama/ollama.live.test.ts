// Ollama tests cover ollama plugin behavior.
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core";
import {
  loadTranscriptEventsSync,
  resolveTranscriptSessionKeyBySessionId,
} from "openclaw/plugin-sdk/session-store-runtime";
import { createOpenClawTestState } from "openclaw/plugin-sdk/test-state";
import { describe, expect, it } from "vitest";
import { isLocalOllamaBaseUrl } from "./src/discovery-shared.js";
import { createOllamaEmbeddingProvider } from "./src/embedding-provider.js";
import { createOllamaStreamFn } from "./src/stream.js";
import { createOllamaWebSearchProvider } from "./src/web-search-provider.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_OLLAMA === "1";
const OLLAMA_BASE_URL =
  process.env.OPENCLAW_LIVE_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
const CHAT_MODEL = process.env.OPENCLAW_LIVE_OLLAMA_MODEL?.trim() || "llama3.2:latest";
const EMBEDDING_MODEL =
  process.env.OPENCLAW_LIVE_OLLAMA_EMBED_MODEL?.trim() || "embeddinggemma:latest";
const PROVIDER_ID = process.env.OPENCLAW_LIVE_OLLAMA_PROVIDER_ID?.trim() || "ollama-live-custom";
const ONBOARDING_REPLY_MARKER = "OPENCLAW_OLLAMA_ONBOARDING_OK";
const RUN_WEB_SEARCH = process.env.OPENCLAW_LIVE_OLLAMA_WEB_SEARCH !== "0";
const RUN_EMBEDDINGS =
  process.env.OPENCLAW_LIVE_OLLAMA_EMBEDDINGS === "1" ||
  (process.env.OPENCLAW_LIVE_OLLAMA_EMBEDDINGS !== "0" && !isOllamaCloudBaseUrl(OLLAMA_BASE_URL));
const OLLAMA_CONFIG_API_KEY = isLocalOllamaBaseUrl(OLLAMA_BASE_URL)
  ? "ollama-local"
  : "OLLAMA_API_KEY";

function isOllamaCloudBaseUrl(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl);
    return parsed.protocol === "https:" && parsed.hostname === "ollama.com";
  } catch {
    return false;
  }
}

function requireOllamaRuntimeApiKey(): string | undefined {
  if (OLLAMA_CONFIG_API_KEY !== "OLLAMA_API_KEY") {
    return undefined;
  }
  const apiKey = process.env.OLLAMA_API_KEY?.trim();
  if (!apiKey) {
    throw new Error(
      "OPENCLAW_LIVE_OLLAMA_BASE_URL points at a remote Ollama host; set OLLAMA_API_KEY.",
    );
  }
  return apiKey;
}

function resolveOllamaDirectApiKey(): string {
  return requireOllamaRuntimeApiKey() ?? "ollama-local";
}

async function collectStreamEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
}

async function reserveIsolatedGatewayPort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to reserve an isolated Gateway port")));
        return;
      }
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve(address.port);
        }
      });
    });
  });
}

async function assertOllamaModelAlreadyInstalled(): Promise<void> {
  const apiBase = OLLAMA_BASE_URL.replace(/\/+$/, "").replace(/\/v1$/i, "");
  const response = await fetch(`${apiBase}/api/tags`, {
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.ok, "The configured live Ollama host must already be running").toBe(true);
  const payload = (await response.json()) as {
    models?: Array<{ name?: string; model?: string }>;
  };
  const installed = payload.models?.some(
    (model) => model.name === CHAT_MODEL || model.model === CHAT_MODEL,
  );
  expect(
    installed,
    `The live Ollama model ${CHAT_MODEL} must already be installed; onboarding must not pull it`,
  ).toBe(true);
}

async function waitForIsolatedGatewayReady(gateway: ChildProcess, port: number): Promise<void> {
  const deadline = Date.now() + 60_000;
  let startupFailed = false;
  gateway.once("error", () => {
    startupFailed = true;
  });

  while (Date.now() < deadline) {
    if (startupFailed || gateway.exitCode !== null || gateway.signalCode !== null) {
      throw new Error("The isolated Ollama onboarding Gateway exited before becoming ready");
    }

    try {
      const response = await fetch(`http://127.0.0.1:${port}/readyz`, {
        signal: AbortSignal.timeout(1_000),
      });
      if (response.ok) {
        const readiness = (await response.json()) as {
          ready?: boolean;
          failing?: unknown[];
        };
        if (readiness.ready === true && (readiness.failing?.length ?? 0) === 0) {
          return;
        }
      }
    } catch {
      // A successful readiness response, not a listening port, owns Gateway startup.
    }

    await delay(250);
  }

  throw new Error("The isolated Ollama onboarding Gateway did not report ready");
}

async function stopIsolatedGateway(gateway: ChildProcess | undefined): Promise<void> {
  if (!gateway || gateway.exitCode !== null || gateway.signalCode !== null) {
    return;
  }

  const exited = once(gateway, "exit").then(() => true);
  gateway.kill("SIGTERM");
  if (!(await Promise.race([exited, delay(5_000, false)]))) {
    gateway.kill("SIGKILL");
    await Promise.race([exited, delay(5_000)]);
  }
}

function hasPersistedTranscriptMessage(
  events: unknown[],
  role: "user" | "assistant",
  expectedText: string,
): boolean {
  return events.some((event) => {
    if (typeof event !== "object" || event === null) {
      return false;
    }
    const record = event as { type?: unknown; message?: unknown };
    if (record.type !== "message" || typeof record.message !== "object" || !record.message) {
      return false;
    }
    const message = record.message as { role?: unknown; content?: unknown };
    if (message.role !== role) {
      return false;
    }
    if (typeof message.content === "string") {
      return message.content.includes(expectedText);
    }
    return (
      Array.isArray(message.content) &&
      message.content.some(
        (part: unknown) =>
          typeof part === "object" &&
          part !== null &&
          typeof (part as { text?: unknown }).text === "string" &&
          (part as { text: string }).text.includes(expectedText),
      )
    );
  });
}

async function withTempOpenClawState<T>(run: (paths: { root: string }) => Promise<T>): Promise<T> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-ollama-cli-live-"));
  try {
    await fs.writeFile(
      path.join(root, "openclaw.json"),
      JSON.stringify(
        {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                baseUrl: OLLAMA_BASE_URL,
                apiKey: OLLAMA_CONFIG_API_KEY,
                models: [],
              },
            },
          },
        },
        null,
        2,
      ),
    );
    return await run({ root });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
}

async function runOpenClawCli(args: string[], env: NodeJS.ProcessEnv) {
  const hasBuiltEntry = ["entry.js", "entry.mjs"].some((entry) =>
    fsSync.existsSync(path.join(process.cwd(), "dist", entry)),
  );
  const sourceRunnerAvailable = !hasBuiltEntry;
  const commandArgs = sourceRunnerAvailable
    ? ["scripts/run-node.mjs", ...args]
    : ["openclaw.mjs", ...args];
  const outputRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-ollama-cli-output-"));
  const stdoutPath = path.join(outputRoot, "stdout.txt");
  const stderrPath = path.join(outputRoot, "stderr.txt");
  const stdoutFd = fsSync.openSync(stdoutPath, "w");
  const stderrFd = fsSync.openSync(stderrPath, "w");
  let stdoutClosed = false;
  let stderrClosed = false;
  try {
    const result = spawnSync(process.execPath, commandArgs, {
      cwd: process.cwd(),
      env,
      timeout: sourceRunnerAvailable ? 180_000 : 90_000,
      stdio: ["ignore", stdoutFd, stderrFd],
    });
    fsSync.closeSync(stdoutFd);
    stdoutClosed = true;
    fsSync.closeSync(stderrFd);
    stderrClosed = true;
    return {
      exitCode: result.status ?? (result.error ? 1 : 0),
      stdout: fsSync.readFileSync(stdoutPath, "utf8"),
      stderr: fsSync.readFileSync(stderrPath, "utf8"),
    };
  } finally {
    if (!stdoutClosed) {
      fsSync.closeSync(stdoutFd);
    }
    if (!stderrClosed) {
      fsSync.closeSync(stderrFd);
    }
    fsSync.rmSync(outputRoot, { recursive: true, force: true });
  }
}

function parseJsonEnvelope(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  const jsonStart = trimmed.lastIndexOf("\n{");
  const rawJson = jsonStart >= 0 ? trimmed.slice(jsonStart + 1) : trimmed;
  return JSON.parse(rawJson) as Record<string, unknown>;
}

function buildCliEnv(root: string): NodeJS.ProcessEnv {
  const apiKey = requireOllamaRuntimeApiKey();
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    USER: process.env.USER,
    TMPDIR: process.env.TMPDIR,
    NODE_PATH: process.env.NODE_PATH,
    NODE_OPTIONS: process.env.NODE_OPTIONS,
    OPENCLAW_LIVE_TEST: "1",
    OPENCLAW_LIVE_OLLAMA: "1",
    OPENCLAW_LIVE_OLLAMA_WEB_SEARCH: "0",
    OPENCLAW_STATE_DIR: path.join(root, "state"),
    OPENCLAW_CONFIG_PATH: path.join(root, "openclaw.json"),
    OPENCLAW_NO_RESPAWN: "1",
    OPENCLAW_TEST_FAST: "1",
    PNPM_CONFIG_VERIFY_DEPS_BEFORE_RUN: "false",
    pnpm_config_verify_deps_before_run: "false",
    OLLAMA_API_KEY: apiKey ?? "ollama-local",
  };
}

describe.skipIf(!LIVE)("ollama live", () => {
  it.skipIf(!isLocalOllamaBaseUrl(OLLAMA_BASE_URL))(
    "onboards an installed local model and persists the actual Gateway agent turn",
    async () => {
      // Check the real catalog first: a live regression must never download a
      // missing model or modify an Ollama server it does not own.
      await assertOllamaModelAlreadyInstalled();
      const state = await createOpenClawTestState({
        label: "ollama-onboarding-live",
        layout: "home",
        scenario: "empty",
        applyEnv: false,
        env: {
          NODE_ENV: undefined,
          VITEST: undefined,
          VITEST_POOL_ID: undefined,
          VITEST_WORKER_ID: undefined,
          OPENCLAW_TEST_FAST: undefined,
          OPENCLAW_TEST_HOME: undefined,
          OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
          OPENCLAW_TEST_TRUST_BUNDLED_PLUGINS_DIR: undefined,
          OPENCLAW_BUNDLED_PLUGINS_DIR: undefined,
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENCLAW_PLUGIN_CATALOG_PATHS: undefined,
          OPENCLAW_PLUGINS_PATHS: undefined,
          OPENCLAW_WORKSPACE_DIR: undefined,
          OPENCLAW_PROFILE: undefined,
          OPENCLAW_GATEWAY_TOKEN: undefined,
          OPENCLAW_GATEWAY_PASSWORD: undefined,
          OPENCLAW_GATEWAY_URL: undefined,
          OPENCLAW_GATEWAY_PORT: undefined,
          OPENCLAW_NO_RESPAWN: "1",
          OLLAMA_API_KEY: "ollama-local",
        },
      });

      let gateway: ChildProcess | undefined;
      try {
        const gatewayPort = await reserveIsolatedGatewayPort();
        await expect(fs.access(state.configPath)).rejects.toThrow();

        const onboard = await runOpenClawCli(
          [
            "onboard",
            "--non-interactive",
            "--accept-risk",
            "--mode",
            "local",
            "--auth-choice",
            "ollama",
            "--custom-base-url",
            OLLAMA_BASE_URL,
            "--custom-model-id",
            CHAT_MODEL,
            // State-dir overrides do not move the default workspace; always
            // keep onboarding and migration checks inside the owned fixture.
            "--workspace",
            state.workspaceDir,
            "--gateway-bind",
            "loopback",
            "--gateway-port",
            String(gatewayPort),
            "--skip-daemon",
            "--skip-ui",
            "--skip-skills",
            "--skip-health",
            "--suppress-gateway-token-output",
            "--json",
          ],
          state.env,
        );
        expect(onboard.exitCode, onboard.stderr).toBe(0);

        const config = JSON.parse(await fs.readFile(state.configPath, "utf8")) as {
          agents?: { defaults?: { model?: { primary?: string }; workspace?: string } };
          gateway?: { mode?: string; auth?: { mode?: string; token?: string } };
          models?: {
            providers?: {
              ollama?: { api?: string; baseUrl?: string; models?: Array<{ id?: string }> };
            };
          };
        };
        expect(config.agents?.defaults?.model?.primary).toBe(`ollama/${CHAT_MODEL}`);
        expect(config.agents?.defaults?.workspace).toBe(state.workspaceDir);
        expect(config.models?.providers?.ollama?.api).toBe("ollama");
        expect(config.models?.providers?.ollama?.baseUrl).toBe(
          OLLAMA_BASE_URL.replace(/\/+$/, "").replace(/\/v1$/i, ""),
        );
        expect(
          config.models?.providers?.ollama?.models?.some((model) => model.id === CHAT_MODEL),
        ).toBe(true);
        expect(config.gateway?.mode).toBe("local");
        expect(config.gateway?.auth?.mode).toBe("token");
        expect((config.gateway?.auth?.token?.length ?? 0) > 0).toBe(true);

        gateway = spawn(
          process.execPath,
          [
            "scripts/run-node.mjs",
            "gateway",
            "run",
            "--bind",
            "loopback",
            "--port",
            String(gatewayPort),
          ],
          { cwd: process.cwd(), env: state.env, stdio: "ignore" },
        );
        await waitForIsolatedGatewayReady(gateway, gatewayPort);

        const health = await runOpenClawCli(["health", "--json"], state.env);
        expect(health.exitCode, health.stderr).toBe(0);

        const sessionId = "ollama-onboarding-live-gateway";
        const prompt = `Return exactly ${ONBOARDING_REPLY_MARKER} and no other text.`;
        const turn = await runOpenClawCli(
          [
            "agent",
            "--agent",
            "main",
            "--session-id",
            sessionId,
            "--message",
            prompt,
            "--thinking",
            "off",
            "--json",
          ],
          state.env,
        );
        expect(turn.exitCode, turn.stderr).toBe(0);
        const result = parseJsonEnvelope(turn.stdout) as {
          payloads?: Array<{ isError?: boolean; text?: string }>;
          result?: { payloads?: Array<{ isError?: boolean; text?: string }> };
        };
        const replies = result.payloads ?? result.result?.payloads ?? [];
        expect(
          replies.some(
            (reply) => reply.isError !== true && reply.text?.includes(ONBOARDING_REPLY_MARKER),
          ),
          turn.stderr,
        ).toBe(true);

        const transcriptScope = { agentId: "main", env: state.env, sessionId };
        const sessionKey = resolveTranscriptSessionKeyBySessionId(transcriptScope);
        expect(typeof sessionKey === "string" && sessionKey.length > 0).toBe(true);
        const events = loadTranscriptEventsSync({
          ...transcriptScope,
          ...(sessionKey ? { sessionKey } : {}),
        });
        expect(hasPersistedTranscriptMessage(events, "user", prompt)).toBe(true);
        expect(hasPersistedTranscriptMessage(events, "assistant", ONBOARDING_REPLY_MARKER)).toBe(
          true,
        );
      } finally {
        await stopIsolatedGateway(gateway);
        await state.cleanup();
      }
    },
    300_000,
  );

  it("runs infer model run through the local CLI path without static model discovery", async () => {
    await withTempOpenClawState(async ({ root }) => {
      const result = await runOpenClawCli(
        [
          "infer",
          "model",
          "run",
          "--local",
          "--model",
          `ollama/${CHAT_MODEL}`,
          "--prompt",
          "Reply with exactly one word: pong",
          "--json",
        ],
        buildCliEnv(root),
      );

      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("[agents/auth-profiles]");
      expect(result.stdout.trim(), result.stderr).not.toHaveLength(0);
      const payload = parseJsonEnvelope(result.stdout) as {
        ok?: boolean;
        transport?: string;
        provider?: string;
        model?: string;
        outputs?: Array<{ text?: string }>;
      };
      expect(payload.ok).toBe(true);
      expect(payload.transport).toBe("local");
      expect(payload.provider).toBe("ollama");
      expect(payload.model).toBe(CHAT_MODEL);
      expect(payload.outputs?.[0]?.text?.trim().length ?? 0).toBeGreaterThan(0);
    });
  }, 120_000);

  it("runs native chat with a custom provider prefix and normalized tool schemas", async () => {
    const streamFn = createOllamaStreamFn(OLLAMA_BASE_URL);
    let payload:
      | {
          model?: string;
          think?: boolean;
          keep_alive?: string;
          options?: { num_ctx?: number; top_p?: number };
          tools?: Array<{
            function?: {
              parameters?: {
                properties?: Record<string, { type?: string }>;
              };
            };
          }>;
        }
      | undefined;

    const stream = streamFn(
      {
        id: `${PROVIDER_ID}/${CHAT_MODEL}`,
        api: "ollama",
        provider: PROVIDER_ID,
        contextWindow: 8192,
        params: { num_ctx: 4096, top_p: 0.9, thinking: false, keep_alive: "5m" },
        requestTimeoutMs: 120_000,
      } as never,
      {
        messages: [{ role: "user", content: "Reply exactly OK." }],
        tools: [
          {
            name: "lookup_weather",
            description: "Lookup weather for a city.",
            parameters: {
              properties: {
                city: { enum: ["London", "Vienna"] },
                units: { enum: ["metric", "imperial"] },
                options: {
                  properties: {
                    includeWind: { type: "boolean" },
                  },
                },
              },
              required: ["city"],
            },
          },
        ],
      } as never,
      {
        maxTokens: 32,
        temperature: 0,
        onPayload: (body: unknown) => {
          payload = body as NonNullable<typeof payload>;
        },
        apiKey: requireOllamaRuntimeApiKey(),
      } as never,
    );

    const events = await collectStreamEvents(await Promise.resolve(stream));
    const error = events.find((event) => (event as { type?: string }).type === "error");

    expect(error).toBeUndefined();
    expect(events.map((event) => (event as { type?: string }).type)).toContain("done");
    expect(payload?.model).toBe(CHAT_MODEL);
    expect(payload?.options?.num_ctx).toBe(4096);
    expect(payload?.options?.top_p).toBe(1);
    expect(payload?.think).toBe(false);
    expect(payload?.keep_alive).toBe("5m");
    const properties = payload?.tools?.[0]?.function?.parameters?.properties;
    expect(properties?.city?.type).toBe("string");
    expect(properties?.units?.type).toBe("string");
    expect(properties?.options?.type).toBe("object");
  }, 60_000);

  it.skipIf(!RUN_EMBEDDINGS)(
    "embeds a batch through the current Ollama endpoint for custom providers",
    async () => {
      const { client } = await createOllamaEmbeddingProvider({
        config: {
          models: {
            providers: {
              [PROVIDER_ID]: {
                api: "ollama",
                baseUrl: OLLAMA_BASE_URL,
                apiKey: resolveOllamaDirectApiKey(),
              },
            },
          },
        },
        provider: PROVIDER_ID,
        model: `${PROVIDER_ID}/${EMBEDDING_MODEL}`,
      } as never);

      const embeddings = await client.embedBatch(["hello", "world"]);

      expect(embeddings).toHaveLength(2);
      expect(embeddings[0]?.length ?? 0).toBeGreaterThan(0);
      expect(embeddings[1]?.length).toBe(embeddings[0]?.length);
      const firstEmbedding = expectDefined(embeddings[0], "first Ollama embedding");
      expect(Math.hypot(...firstEmbedding)).toBeGreaterThan(0.99);
      expect(Math.hypot(...firstEmbedding)).toBeLessThan(1.01);
    },
    45_000,
  );

  it.skipIf(!RUN_WEB_SEARCH)(
    "searches through Ollama web search fallback endpoints",
    async () => {
      const provider = createOllamaWebSearchProvider();
      const tool = provider.createTool({
        config: {
          models: {
            providers: {
              ollama: {
                api: "ollama",
                baseUrl: OLLAMA_BASE_URL,
                apiKey: resolveOllamaDirectApiKey(),
              },
            },
          },
        },
      } as never);
      if (!tool) {
        throw new Error("Ollama web-search provider did not create a tool");
      }

      const result = (await tool.execute({
        query: "OpenClaw documentation",
        count: 1,
      })) as {
        provider?: string;
        results?: Array<{ url?: string }>;
      };

      expect(result.provider).toBe("ollama");
      expect(result.results?.length ?? 0).toBeGreaterThan(0);
      expect(result.results?.[0]?.url).toMatch(/^https?:\/\//);
    },
    45_000,
  );
});
