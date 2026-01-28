import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { MoltbotConfig } from "../config/config.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "moltbot-models-" });
}

const MODELS_CONFIG: MoltbotConfig = {
  models: {
    providers: {
      "custom-proxy": {
        baseUrl: "http://localhost:4000/v1",
        apiKey: "TEST_KEY",
        api: "openai-completions",
        models: [
          {
            id: "llama-3.1-8b",
            name: "Llama 3.1 8B (Proxy)",
            api: "openai-completions",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 128000,
            maxTokens: 32000,
          },
        ],
      },
    },
  },
};

describe("models-config", () => {
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
  });

  it("fills missing provider.apiKey from env var name when models exist", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const prevKey = process.env.MINIMAX_API_KEY;
      process.env.MINIMAX_API_KEY = "sk-minimax-test";
      try {
        const { ensureMoltbotModelsJson } = await import("./models-config.js");
        const { resolveMoltbotAgentDir } = await import("./agent-paths.js");

        const cfg: MoltbotConfig = {
          models: {
            providers: {
              minimax: {
                baseUrl: "https://api.minimax.io/anthropic",
                api: "anthropic-messages",
                models: [
                  {
                    id: "MiniMax-M2.1",
                    name: "MiniMax M2.1",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 200000,
                    maxTokens: 8192,
                  },
                ],
              },
            },
          },
        };

        await ensureMoltbotModelsJson(cfg);

        const modelPath = path.join(resolveMoltbotAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { apiKey?: string; models?: Array<{ id: string }> }>;
        };
        expect(parsed.providers.minimax?.apiKey).toBe("MINIMAX_API_KEY");
        const ids = parsed.providers.minimax?.models?.map((model) => model.id);
        expect(ids).toContain("MiniMax-VL-01");
      } finally {
        if (prevKey === undefined) delete process.env.MINIMAX_API_KEY;
        else process.env.MINIMAX_API_KEY = prevKey;
      }
    });
  });
  it("merges providers by default", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureMoltbotModelsJson } = await import("./models-config.js");
      const { resolveMoltbotAgentDir } = await import("./agent-paths.js");

      const agentDir = resolveMoltbotAgentDir();
      await fs.mkdir(agentDir, { recursive: true });
      await fs.writeFile(
        path.join(agentDir, "models.json"),
        JSON.stringify(
          {
            providers: {
              existing: {
                baseUrl: "http://localhost:1234/v1",
                apiKey: "EXISTING_KEY",
                api: "openai-completions",
                models: [
                  {
                    id: "existing-model",
                    name: "Existing",
                    api: "openai-completions",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 2048,
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      await ensureMoltbotModelsJson(MODELS_CONFIG);

      const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { baseUrl?: string }>;
      };

      expect(parsed.providers.existing?.baseUrl).toBe("http://localhost:1234/v1");
      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
    });
  });
});
