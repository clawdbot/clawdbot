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

describe("models config", () => {
  it("auto-injects github-copilot provider when token is present", async () => {
    await withTempHome(async (home) => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      process.env.COPILOT_GITHUB_TOKEN = "gh-token";

      try {
        vi.resetModules();

        vi.doMock("../providers/github-copilot-token.js", () => ({
          DEFAULT_COPILOT_API_BASE_URL:
            "https://api.individual.githubcopilot.com",
          resolveCopilotApiToken: vi.fn().mockResolvedValue({
            token: "copilot",
            expiresAt: Date.now() + 60 * 60 * 1000,
            source: "mock",
            baseUrl: "https://api.copilot.example",
          }),
        }));

        const { ensureClawdbotModelsJson } = await import("./models-config.js");

        const agentDir = path.join(home, "agent-default-base-url");
        await ensureClawdbotModelsJson({ models: { providers: {} } }, agentDir);

        const raw = await fs.readFile(
          path.join(agentDir, "models.json"),
          "utf8",
        );
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string; models?: unknown[] }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe(
          "https://api.copilot.example",
        );
        expect(parsed.providers["github-copilot"]?.models?.length ?? 0).toBe(0);
      } finally {
        process.env.COPILOT_GITHUB_TOKEN = previous;
      }
    });
  });

  it("prefers COPILOT_GITHUB_TOKEN over GH_TOKEN and GITHUB_TOKEN", async () => {
    await withTempHome(async () => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      const previousGh = process.env.GH_TOKEN;
      const previousGithub = process.env.GITHUB_TOKEN;
      process.env.COPILOT_GITHUB_TOKEN = "copilot-token";
      process.env.GH_TOKEN = "gh-token";
      process.env.GITHUB_TOKEN = "github-token";

      try {
        vi.resetModules();

        const resolveCopilotApiToken = vi.fn().mockResolvedValue({
          token: "copilot",
          expiresAt: Date.now() + 60 * 60 * 1000,
          source: "mock",
          baseUrl: "https://api.copilot.example",
        });

        vi.doMock("../providers/github-copilot-token.js", () => ({
          DEFAULT_COPILOT_API_BASE_URL:
            "https://api.individual.githubcopilot.com",
          resolveCopilotApiToken,
        }));

        const { ensureClawdbotModelsJson } = await import("./models-config.js");

        await ensureClawdbotModelsJson({ models: { providers: {} } });

        expect(resolveCopilotApiToken).toHaveBeenCalledWith(
          expect.objectContaining({ githubToken: "copilot-token" }),
        );
      } finally {
        process.env.COPILOT_GITHUB_TOKEN = previous;
        process.env.GH_TOKEN = previousGh;
        process.env.GITHUB_TOKEN = previousGithub;
      }
    });
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
          DEFAULT_COPILOT_API_BASE_URL:
            "https://api.individual.githubcopilot.com",
          resolveCopilotApiToken,
        }));

        const { ensureClawdbotModelsJson } = await import("./models-config.js");

        await ensureClawdbotModelsJson({ models: { providers: {} } }, agentDir);

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
          DEFAULT_COPILOT_API_BASE_URL:
            "https://api.individual.githubcopilot.com",
          resolveCopilotApiToken: vi.fn().mockResolvedValue({
            token: "copilot",
            expiresAt: Date.now() + 60 * 60 * 1000,
            source: "mock",
            baseUrl: "https://api.copilot.example",
          }),
        }));

        const { ensureClawdbotModelsJson } = await import("./models-config.js");
        const { resolveClawdbotAgentDir } = await import("./agent-paths.js");

        await ensureClawdbotModelsJson({
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

        const agentDir = resolveClawdbotAgentDir();
        const raw = await fs.readFile(
          path.join(agentDir, "models.json"),
          "utf8",
        );
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe(
          "https://copilot.local",
        );
      } finally {
        process.env.COPILOT_GITHUB_TOKEN = previous;
      }
    });
  });

  it("falls back to default baseUrl when token exchange fails", async () => {
    await withTempHome(async () => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      process.env.COPILOT_GITHUB_TOKEN = "gh-token";

      try {
        vi.resetModules();

        vi.doMock("../providers/github-copilot-token.js", () => ({
          DEFAULT_COPILOT_API_BASE_URL: "https://api.default.test",
          resolveCopilotApiToken: vi.fn().mockRejectedValue(new Error("boom")),
        }));

        const { ensureClawdbotModelsJson } = await import("./models-config.js");
        const { resolveClawdbotAgentDir } = await import("./agent-paths.js");

        await ensureClawdbotModelsJson({ models: { providers: {} } });

        const agentDir = resolveClawdbotAgentDir();
        const raw = await fs.readFile(
          path.join(agentDir, "models.json"),
          "utf8",
        );
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe(
          "https://api.default.test",
        );
      } finally {
        process.env.COPILOT_GITHUB_TOKEN = previous;
      }
    });
  });

  it("uses agentDir override auth profiles for copilot injection", async () => {
    await withTempHome(async (home) => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      const previousGh = process.env.GH_TOKEN;
      const previousGithub = process.env.GITHUB_TOKEN;
      delete process.env.COPILOT_GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;

      try {
        vi.resetModules();

        const agentDir = path.join(home, "agent-override");
        await fs.mkdir(agentDir, { recursive: true });
        await fs.writeFile(
          path.join(agentDir, "auth-profiles.json"),
          JSON.stringify(
            {
              version: 1,
              profiles: {
                "github-copilot:github": {
                  type: "token",
                  provider: "github-copilot",
                  token: "gh-profile-token",
                },
              },
            },
            null,
            2,
          ),
        );

        vi.doMock("../providers/github-copilot-token.js", () => ({
          DEFAULT_COPILOT_API_BASE_URL:
            "https://api.individual.githubcopilot.com",
          resolveCopilotApiToken: vi.fn().mockResolvedValue({
            token: "copilot",
            expiresAt: Date.now() + 60 * 60 * 1000,
            source: "mock",
            baseUrl: "https://api.copilot.example",
          }),
        }));

        const { ensureClawdbotModelsJson } = await import("./models-config.js");

        await ensureClawdbotModelsJson({ models: { providers: {} } }, agentDir);

        const raw = await fs.readFile(
          path.join(agentDir, "models.json"),
          "utf8",
        );
        const parsed = JSON.parse(raw) as {
          providers: Record<string, { baseUrl?: string }>;
        };

        expect(parsed.providers["github-copilot"]?.baseUrl).toBe(
          "https://api.copilot.example",
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

  it("skips writing models.json when no env token or profile exists", async () => {
    await withTempHome(async (home) => {
      const previous = process.env.COPILOT_GITHUB_TOKEN;
      const previousGh = process.env.GH_TOKEN;
      const previousGithub = process.env.GITHUB_TOKEN;
      const previousMinimax = process.env.MINIMAX_API_KEY;
      const previousMoonshot = process.env.MOONSHOT_API_KEY;
      const previousSynthetic = process.env.SYNTHETIC_API_KEY;
      delete process.env.COPILOT_GITHUB_TOKEN;
      delete process.env.GH_TOKEN;
      delete process.env.GITHUB_TOKEN;
      delete process.env.MINIMAX_API_KEY;
      delete process.env.MOONSHOT_API_KEY;
      delete process.env.SYNTHETIC_API_KEY;

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

        await expect(
          fs.stat(path.join(agentDir, "models.json")),
        ).rejects.toThrow();
        expect(result.wrote).toBe(false);
      } finally {
        if (previous === undefined) delete process.env.COPILOT_GITHUB_TOKEN;
        else process.env.COPILOT_GITHUB_TOKEN = previous;
        if (previousGh === undefined) delete process.env.GH_TOKEN;
        else process.env.GH_TOKEN = previousGh;
        if (previousGithub === undefined) delete process.env.GITHUB_TOKEN;
        else process.env.GITHUB_TOKEN = previousGithub;
        if (previousMinimax === undefined) delete process.env.MINIMAX_API_KEY;
        else process.env.MINIMAX_API_KEY = previousMinimax;
        if (previousMoonshot === undefined) delete process.env.MOONSHOT_API_KEY;
        else process.env.MOONSHOT_API_KEY = previousMoonshot;
        if (previousSynthetic === undefined)
          delete process.env.SYNTHETIC_API_KEY;
        else process.env.SYNTHETIC_API_KEY = previousSynthetic;
      }
    });
  });
  let previousHome: string | undefined;

  beforeEach(() => {
    previousHome = process.env.HOME;
  });

  afterEach(() => {
    process.env.HOME = previousHome;
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

      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe(
        "http://localhost:4000/v1",
      );
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
        expect(parsed.providers.minimax?.baseUrl).toBe(
          "https://api.minimax.io/anthropic",
        );
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
        expect(parsed.providers.synthetic?.baseUrl).toBe(
          "https://api.synthetic.new/anthropic",
        );
        expect(parsed.providers.synthetic?.apiKey).toBe("SYNTHETIC_API_KEY");
        const ids = parsed.providers.synthetic?.models?.map((model) => model.id);
        expect(ids).toContain("hf:MiniMaxAI/MiniMax-M2.1");
      } finally {
        if (prevKey === undefined) delete process.env.SYNTHETIC_API_KEY;
        else process.env.SYNTHETIC_API_KEY = prevKey;
      }
    });
  });

  it("fills missing provider.apiKey from env var name when models exist", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const prevKey = process.env.MINIMAX_API_KEY;
      process.env.MINIMAX_API_KEY = "sk-minimax-test";
      try {
        const { ensureClawdbotModelsJson } = await import("./models-config.js");
        const { resolveClawdbotAgentDir } = await import("./agent-paths.js");

        const cfg: ClawdbotConfig = {
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

        await ensureClawdbotModelsJson(cfg);

        const modelPath = path.join(resolveClawdbotAgentDir(), "models.json");
        const raw = await fs.readFile(modelPath, "utf8");
        const parsed = JSON.parse(raw) as {
          providers: Record<
            string,
            { apiKey?: string; models?: Array<{ id: string }> }
          >;
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
      const { ensureClawdbotModelsJson } = await import("./models-config.js");
      const { resolveClawdbotAgentDir } = await import("./agent-paths.js");

      const agentDir = resolveClawdbotAgentDir();
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

      await ensureClawdbotModelsJson(MODELS_CONFIG);

      const raw = await fs.readFile(path.join(agentDir, "models.json"), "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { baseUrl?: string }>;
      };

      expect(parsed.providers.existing?.baseUrl).toBe(
        "http://localhost:1234/v1",
      );
      expect(parsed.providers["custom-proxy"]?.baseUrl).toBe(
        "http://localhost:4000/v1",
      );
    });
  });

  it("normalizes gemini 3 ids to preview for google providers", async () => {
    await withTempHome(async () => {
      vi.resetModules();
      const { ensureClawdbotModelsJson } = await import("./models-config.js");
      const { resolveClawdbotAgentDir } = await import("./agent-paths.js");

      const cfg: ClawdbotConfig = {
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

      await ensureClawdbotModelsJson(cfg);

      const modelPath = path.join(resolveClawdbotAgentDir(), "models.json");
      const raw = await fs.readFile(modelPath, "utf8");
      const parsed = JSON.parse(raw) as {
        providers: Record<string, { models: Array<{ id: string }> }>;
      };
      const ids = parsed.providers.google?.models?.map((model) => model.id);
      expect(ids).toEqual(["gemini-3-pro-preview", "gemini-3-flash-preview"]);
    });
  });
});
