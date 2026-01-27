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

  it("uses the first github-copilot profile when env tokens are missing", async () => {
    await withTempHome(async (home) => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      const previousGh = process.env.GH_TOKEN;
      const previousGithub = process.env.GITHUB_TOKEN;
      delete process.env.COPILOT_GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;

      try {
        vi.resetModules();

        const agentDir = path.join(home, "agent-profiles");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "auth-profiles.json"),
          JSON.stringify(
            {
              version: 1,
              profiles: {
                "github-copilot:alpha": {
                  type: "token",
                  provider: "github-copilot",
                  token: "alpha-token",
                },
                "github-copilot:beta": {
                  type: "token",
                  provider: "github-copilot",
                  token: "beta-token",
                },
              },
            },
            null,
            2,
          ),
        );

        const resolveCopilotApiToken = vi.fn().mockResolvedValue({
          token: "copilot",
          expiresAt: Date.now() + 60 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        });

        vi.doMock("../providers/github-copilot-token.js", () => ({
          DEFAULT_COPILOT_API_BASE_URL: "https://api.individual.githubcopilot.com",
          resolveCopilotApiToken,
        }));

        const { ensureMoltbotModelsJson } = await import("./models-config.js");

        await ensureMoltbotModelsJson({ models: { providers: {} } }, agentDir);

        expect(resolveCopilotApiToken).toHaveBeenCalledWith(
          expect.objectContaining({ githubToken: "alpha-token" }),
        );
      } finally {
        if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
        else process.env.COPILOT_GITHUB_TOKEN = previous;
        if (previousGh === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = previousGh;
        if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = previousGithub;
      }
    });
  });
  it("does not override explicit github-copilot provider config", async () => {
    await withTempHome(async () => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      process.env.COPILOT_GITHUB_TOKEN = "gh-token";

      try {
        vi.resetModules();

        vi.doMock("../providers/github-copilot-token.js", () => ({
          DEFAULT_COPILOT_API_BASE_URL: "https://api.individual.githubcopilot.com",
          resolveCopilotApiToken: vi.fn().mockResolvedValue({
            token: "copilot",
            expiresAt: Date.now() + 60 * 60 * 1000,
            source: "mock",
            baseUrl: "https://api.copilot.example",
          }),
        }));

        const { ensureMoltbotModelsJson } = await import("./models-config.js");
        const { resolveMoltbotAgentDir } = await import("./agent-paths.js");

        await ensureMoltbotModelsJson({
          models: {
            providers: {
              "github-copilot": {
                baseUrl: "https://copilot.local",
                api: "openai-responses",
                models: [],
              },
            },
          },
        });

        const agentDir = resolveMoltbotAgentDir();
        const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe("https://copilot.local");
      } finally {
        process.env.COPILOT_GITHUB_TOKEN = previous;
      }
    });
  });
});
