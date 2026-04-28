import { spawnSync } from "node:child_process";
import * as fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
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
const RUN_WEB_SEARCH = process.env.OPENCLAW_LIVE_OLLAMA_WEB_SEARCH !== "0";

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
                apiKey: "ollama-local",
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
  const outputRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "openclaw-ollama-cli-output-"));
  const stdoutPath = path.join(outputRoot, "stdout.txt");
  const stderrPath = path.join(outputRoot, "stderr.txt");
  const stdoutFd = fsSync.openSync(stdoutPath, "w");
  const stderrFd = fsSync.openSync(stderrPath, "w");
  let stdoutClosed = false;
  let stderrClosed = false;
  try {
    const result = spawnSync(process.execPath, ["openclaw.mjs", ...args], {
      cwd: process.cwd(),
      env,
      timeout: 90_000,
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
    OLLAMA_API_KEY: "ollama-local",
  };
}

describe.skipIf(!LIVE)("ollama live", () => {
  it("runs infer model run through the local CLI path without PI model discovery", async () => {
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
      expect(payload).toMatchObject({
        ok: true,
        transport: "local",
        provider: "ollama",
        model: CHAT_MODEL,
      });
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
      } as never,
    );

    const events = await collectStreamEvents(await Promise.resolve(stream));
    const error = events.find((event) => (event as { type?: string }).type === "error");

    expect(error).toBeUndefined();
    expect(events.some((event) => (event as { type?: string }).type === "done")).toBe(true);
    expect(payload?.model).toBe(CHAT_MODEL);
    expect(payload?.options?.num_ctx).toBe(4096);
    expect(payload?.options?.top_p).toBe(0.9);
    expect(payload?.think).toBe(false);
    expect(payload?.keep_alive).toBe("5m");
    const properties = payload?.tools?.[0]?.function?.parameters?.properties;
    expect(properties?.city?.type).toBe("string");
    expect(properties?.units?.type).toBe("string");
    expect(properties?.options?.type).toBe("object");
  }, 60_000);

  it("embeds a batch through the current Ollama endpoint for custom providers", async () => {
    const { client } = await createOllamaEmbeddingProvider({
      config: {
        models: {
          providers: {
            [PROVIDER_ID]: {
              api: "ollama",
              baseUrl: OLLAMA_BASE_URL,
              apiKey: "ollama-local",
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
    expect(Math.hypot(...embeddings[0])).toBeGreaterThan(0.99);
    expect(Math.hypot(...embeddings[0])).toBeLessThan(1.01);
  }, 45_000);

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
                apiKey: "ollama-local",
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
