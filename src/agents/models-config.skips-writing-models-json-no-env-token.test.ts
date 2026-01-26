import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { ClawdbotConfig } from "../config/config.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "clawdbot-models-" });
}

const MODELS_CONFIG: ClawdbotConfig = {
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

  it("skips writing models.json when no env token or profile exists", async () => {
    await withTempHome(async (home) => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      const previousGh = process.env.GH_TOKEN;
      const previousGithub = process.env.GITHUB_TOKEN;
      const previousKimiCode = process.env.KIMICODE_API_KEY;
      const previousMinimax = process.env.MINIMAX_API_KEY;
      const previousMoonshot = process.env.MOONSHOT_API_KEY;
      const previousSynthetic = process.env.SYNTHETIC_API_KEY;
      const previousVenice = process.env.VENICE_API_KEY;
      delete process.env.COPILOT_GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.KIMICODE_API_KEY;
      delete process.env.MINIMAX_API_KEY;
      delete process.env.MOONSHOT_API_KEY;
      delete process.env.SYNTHETIC_API_KEY;
      delete process.env.VENICE_API_KEY;

      try {
        vi.resetModules();
        const { ensureClawdbotModelsJson } = await import("./models-config.js");

        const agentDir = path.join(home, "agent-empty");
        const result = await ensureClawdbotModelsJson(
          {
            models: { providers: {} },
          },
          agentDir,
        );

        await expect(fs.stat(path.join(agentDir, "models.json"))).rejects.toThrow();
        expect(result.wrote).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
        else process.env.COPILOT_GITHUB_TOKEN = previous;
        if (previousGh === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = previousGh;
        if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = previousGithub;
        if (previousKimiCode === undefined) delete process.env.KIMICODE_API_KEY;
        else process.env.KIMICODE_API_KEY = previousKimiCode;
        if (previousMinimax === undefined) delete process.env.MINIMAX_API_KEY;
        else process.env.MINIMAX_API_KEY = previousMinimax;
        if (previousMoonshot === undefined) delete process.env.MOONSHOT_API_KEY;
        else process.env.MOONSHOT_API_KEY = previousMoonshot;
        if (previousSynthetic === undefined) delete process.env.SYNTHETIC_API_KEY;
        else process.env.SYNTHETIC_API_KEY = previousSynthetic;
        if (previousVenice === undefined) delete process.env.VENICE_API_KEY;
        else process.env.VENICE_API_KEY = previousVenice;
      }
    });
  });
  it("writes models.json for configured providers", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureClawdbotModelsJson } = await import("./models-config.js");
      const { resolveClawdbotAgentDir } = await import("./agent-paths.js");

      await ensureClawdbotModelsJson(MODELS_CONFIG);

      const modelPath = path.join(resolveClawdbotAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { baseUrl?: string }>;
      };

      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe("http://localhost:4000/v1");
    });
  });
  it("adds minimax provider when MINIMAX_API_KEY is set", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const prevKey = process.env.MINIMAX_API_KEY;
      process.env.MINIMAX_API_KEY = "sk-minimax-test";
      try {
        const { ensureClawdbotModelsJson } = await import("./models-config.js");
        const { resolveClawdbotAgentDir } = await import("./agent-paths.js");

        await ensureClawdbotModelsJson({});

        const modelPath = path.join(resolveClawdbotAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<
            string,
            {
              baseUrl?: string;
              apiKey?: string;
              models?: Array<{ id: string }>;
            }
          >;
        };
        expect(parsed.providers.minimax?.baseUrl).toBe("https://api.minimax.io/anthropic");
        expect(parsed.providers.minimax?.apiKey).toBe("MINIMAX_API_KEY");
        const ids = parsed.providers.minimax?.models?.map((model) => model.id);
        expect(ids).toContain("MiniMax-M2.1");
        expect(ids).toContain("MiniMax-VL-01");
      } finally {
        if (prevKey === undefined) delete process.env.MINIMAX_API_KEY;
        else process.env.MINIMAX_API_KEY = prevKey;
      }
    });
  });
  it("adds synthetic provider when SYNTHETIC_API_KEY is set", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const prevKey = process.env.SYNTHETIC_API_KEY;
      process.env.SYNTHETIC_API_KEY = "sk-synthetic-test";
      try {
        const { ensureClawdbotModelsJson } = await import("./models-config.js");
        const { resolveClawdbotAgentDir } = await import("./agent-paths.js");

        await ensureClawdbotModelsJson({});

        const modelPath = path.join(resolveClawdbotAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<
            string,
            {
              baseUrl?: string;
              apiKey?: string;
              models?: Array<{ id: string }>;
            }
          >;
        };
        expect(parsed.providers.synthetic?.baseUrl).toBe("https://api.synthetic.new/anthropic");
        expect(parsed.providers.synthetic?.apiKey).toBe("SYNTHETIC_API_KEY");
        const ids = parsed.providers.synthetic?.models?.map((model) => model.id);
        expect(ids).toContain("hf:MiniMaxAI/MiniMax-M2.1");
      } finally {
        if (prevKey === undefined) delete process.env.SYNTHETIC_API_KEY;
        else process.env.SYNTHETIC_API_KEY = prevKey;
      }
    });
  });
});
