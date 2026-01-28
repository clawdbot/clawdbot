import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withTempHome as withTempHomeBase } from "../../test/helpers/temp-home.js";
import type { MoltbotConfig } from "../config/config.js";

async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  return withTempHomeBase(fn, { prefix: "moltbot-models-" });
}

const _MODELS_CONFIG: MoltbotConfig = {
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

  it("normalizes gemini 3 ids to preview for google providers", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureMoltbotModelsJson } = await import("./models-config.js");
      const { resolveMoltbotAgentDir } = await import("./agent-paths.js");

      const cfg: MoltbotConfig = {
        models: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              apiKey: "GEMINI_KEY",
              api: "google-generative-ai",
              models: [
                {
                  id: "gemini-3-pro",
                  name: "Gemini 3 Pro",
                  api: "google-generative-ai",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1048576,
                  maxTokens: 65536,
                },
                {
                  id: "gemini-3-flash",
                  name: "Gemini 3 Flash",
                  api: "google-generative-ai",
                  reasoning: false,
                  input: ["text", "image"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 1048576,
                  maxTokens: 65536,
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
        providers: Record<string, { models: Array<{ id: string }> }>;
      };
      const ids = parsed.providers.google?.models?.map((model) => model.id);
      expect(ids).toEqual(["gemini-3-pro-preview", "gemini-3-flash-preview"]);
    });
  });
});
