// Ollama tests cover ollama plugin behavior.
import { spawnSync } from "node:child_process";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { isLocalOllamaBaseUrl } from "./src/discovery-shared.js";
import { createOllamaEmbeddingProvider } from "./src/embedding-provider.js";
import { createOllamaStreamFn } from "./src/stream.runtime.js";
import { createOllamaWebSearchProvider } from "./src/web-search-provider.js";

const LIVE = process.env.OPENCLAW_LIVE_TEST === "1" && process.env.OPENCLAW_LIVE_OLLAMA === "1";
const OLLAMA_BASE_URL =
  process.env.OPENCLAW_LIVE_OLLAMA_BASE_URL?.trim() || "http://127.0.0.1:11434";
const EXPECTED_OLLAMA_VERSION = process.env.OPENCLAW_LIVE_OLLAMA_VERSION?.trim();
const CHAT_MODEL = process.env.OPENCLAW_LIVE_OLLAMA_MODEL?.trim() || "llama3.2:latest";
const EMBEDDING_MODEL =
  process.env.OPENCLAW_LIVE_OLLAMA_EMBED_MODEL?.trim() || "embeddinggemma:latest";
const PROVIDER_ID = process.env.OPENCLAW_LIVE_OLLAMA_PROVIDER_ID?.trim() || "ollama-live-custom";
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

async function fetchOllamaApi(
  pathname: string,
  init?: RequestInit,
): Promise<Record<string, unknown>> {
  const apiKey = requireOllamaRuntimeApiKey();
  const headers = new Headers(init?.headers);
  if (apiKey) {
    headers.set("Authorization", `Bearer ${apiKey}`);
  }
  const response = await fetch(new URL(pathname, OLLAMA_BASE_URL), {
    ...init,
    headers,
  });
  const body = await response.text();
  if (!response.ok) {
    throw new Error(`Ollama ${pathname} returned HTTP ${response.status}: ${body}`);
  }
  return JSON.parse(body) as Record<string, unknown>;
}

function ollamaModelNameMatches(candidate: unknown, expected: string): boolean {
  if (typeof candidate !== "string") {
    return false;
  }
  const normalize = (value: string) =>
    value
      .trim()
      .toLowerCase()
      .replace(/:latest$/u, "");
  return normalize(candidate) === normalize(expected);
}

async function collectStreamEvents<T>(stream: AsyncIterable<T>): Promise<T[]> {
  const events: T[] = [];
  for await (const event of stream) {
    events.push(event);
  }
  return events;
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
  it.skipIf(isOllamaCloudBaseUrl(OLLAMA_BASE_URL))(
    "records the exact local daemon and model identity",
    async () => {
      const [versionPayload, tagsPayload, showPayload] = await Promise.all([
        fetchOllamaApi("/api/version"),
        fetchOllamaApi("/api/tags"),
        fetchOllamaApi("/api/show", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: CHAT_MODEL }),
        }),
      ]);
      const version = versionPayload.version;
      expect(typeof version).toBe("string");
      if (EXPECTED_OLLAMA_VERSION) {
        expect(version).toBe(EXPECTED_OLLAMA_VERSION);
      }
      const models = Array.isArray(tagsPayload.models) ? tagsPayload.models : [];
      const selected = models.find((entry) => {
        if (!entry || typeof entry !== "object") {
          return false;
        }
        const model = entry as Record<string, unknown>;
        return (
          ollamaModelNameMatches(model.name, CHAT_MODEL) ||
          ollamaModelNameMatches(model.model, CHAT_MODEL)
        );
      }) as Record<string, unknown> | undefined;
      expect(selected).toBeDefined();
      expect(typeof selected?.digest).toBe("string");
      const capabilities = Array.isArray(showPayload.capabilities)
        ? showPayload.capabilities.filter((value): value is string => typeof value === "string")
        : [];
      console.info(
        `[ollama:live] qualification ${JSON.stringify({
          version,
          platform: process.platform,
          arch: process.arch,
          osRelease: os.release(),
          model: selected?.name ?? selected?.model ?? CHAT_MODEL,
          digest: selected?.digest,
          capabilities,
        })}`,
      );
    },
    15_000,
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

      expect(result.exitCode, result.stderr || result.stdout).toBe(0);
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

    const runNativeChat = () =>
      streamFn(
        {
          id: `${PROVIDER_ID}/${CHAT_MODEL}`,
          api: "ollama",
          provider: PROVIDER_ID,
          input: ["text"],
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
                  required: ["city"],
                },
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

    const events = await collectStreamEvents(await Promise.resolve(runNativeChat()));
    const warmEvents = await collectStreamEvents(await Promise.resolve(runNativeChat()));
    const error = events.find((event) => (event as { type?: string }).type === "error");
    const warmError = warmEvents.find((event) => (event as { type?: string }).type === "error");
    const warmDone = warmEvents.find((event) => event.type === "done");

    expect(error).toBeUndefined();
    expect(warmError).toBeUndefined();
    expect(events.map((event) => (event as { type?: string }).type)).toContain("done");
    expect(warmDone?.type).toBe("done");
    if (warmDone?.type !== "done") {
      throw new Error("missing warm Ollama terminal message");
    }
    const usage = warmDone.message.usage;
    expect(usage.totalTokens).toBe(usage.input + usage.cacheRead + usage.cacheWrite + usage.output);
    console.info(
      `[ollama:live] usage ${JSON.stringify({
        input: usage.input,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        output: usage.output,
        totalTokens: usage.totalTokens,
        cacheTelemetry: usage.cacheTelemetry,
      })}`,
    );
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
