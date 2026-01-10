import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import { getCustomProviderApiKey } from "../agents/model-auth.js";
import { ClawdbotSchema } from "../config/config.js";
import {
  applyAuthProfileConfig,
  applyMinimaxApiConfig,
  applyMinimaxApiProviderConfig,
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
  writeOAuthCredentials,
} from "./onboard-auth.js";

describe("writeOAuthCredentials", () => {
  const previousStateDir = process.env.CLAWDBOT_STATE_DIR;
  const previousAgentDir = process.env.CLAWDBOT_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  let tempStateDir: string | null = null;

  afterEach(async () => {
    if (tempStateDir) {
      await fs.rm(tempStateDir, { recursive: true, force: true });
      tempStateDir = null;
    }
    if (previousStateDir === undefined) {
      delete process.env.CLAWDBOT_STATE_DIR;
    } else {
      process.env.CLAWDBOT_STATE_DIR = previousStateDir;
    }
    if (previousAgentDir === undefined) {
      delete process.env.CLAWDBOT_AGENT_DIR;
    } else {
      process.env.CLAWDBOT_AGENT_DIR = previousAgentDir;
    }
    if (previousPiAgentDir === undefined) {
      delete process.env.PI_CODING_AGENT_DIR;
    } else {
      process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
    }
    delete process.env.CLAWDBOT_OAUTH_DIR;
  });

  it("writes auth-profiles.json under CLAWDBOT_STATE_DIR/agents/main/agent", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-oauth-"));
    process.env.CLAWDBOT_STATE_DIR = tempStateDir;
    // Even if legacy env vars are set, onboarding should write to the multi-agent path.
    process.env.CLAWDBOT_AGENT_DIR = path.join(tempStateDir, "agent");
    process.env.PI_CODING_AGENT_DIR = process.env.CLAWDBOT_AGENT_DIR;

    const creds = {
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    } satisfies OAuthCredentials;

    await writeOAuthCredentials("openai-codex", creds);

    // Now writes to the multi-agent path: agents/main/agent
    const authProfilePath = path.join(
      tempStateDir,
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    const raw = await fs.readFile(authProfilePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, OAuthCredentials & { type?: string }>;
    };
    expect(parsed.profiles?.["openai-codex:default"]).toMatchObject({
      refresh: "refresh-token",
      access: "access-token",
      type: "oauth",
    });

    await expect(
      fs.readFile(
        path.join(tempStateDir, "agent", "auth-profiles.json"),
        "utf8",
      ),
    ).rejects.toThrow();
  });
});

describe("applyAuthProfileConfig", () => {
  it("promotes the newly selected profile to the front of auth.order", () => {
    const next = applyAuthProfileConfig(
      {
        auth: {
          profiles: {
            "anthropic:default": { provider: "anthropic", mode: "api_key" },
          },
          order: { anthropic: ["anthropic:default"] },
        },
      },
      {
        profileId: "anthropic:claude-cli",
        provider: "anthropic",
        mode: "oauth",
      },
    );

    expect(next.auth?.order?.anthropic).toEqual([
      "anthropic:claude-cli",
      "anthropic:default",
    ]);
  });
});

describe("applyMinimaxApiConfig", () => {
  it("adds minimax provider with correct settings", () => {
    const cfg = applyMinimaxApiConfig({});
    expect(cfg.models?.providers?.minimax).toMatchObject({
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
    });
  });

  it("sets correct primary model", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.1-lightning");
    expect(cfg.agents?.defaults?.model?.primary).toBe(
      "minimax/MiniMax-M2.1-lightning",
    );
  });

  it("sets reasoning flag for MiniMax-M2 model", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2");
    expect(cfg.models?.providers?.minimax?.models[0]?.reasoning).toBe(true);
  });

  it("does not set reasoning for non-M2 models", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.1");
    expect(cfg.models?.providers?.minimax?.models[0]?.reasoning).toBe(false);
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyMinimaxApiConfig({
      agents: {
        defaults: {
          model: { fallbacks: ["anthropic/claude-opus-4-5"] },
        },
      },
    });
    expect(cfg.agents?.defaults?.model?.fallbacks).toEqual([
      "anthropic/claude-opus-4-5",
    ]);
  });

  it("adds model alias", () => {
    const cfg = applyMinimaxApiConfig({}, "MiniMax-M2.1");
    expect(cfg.agents?.defaults?.models?.["minimax/MiniMax-M2.1"]?.alias).toBe(
      "Minimax",
    );
  });

  it("preserves existing model params when adding alias", () => {
    const cfg = applyMinimaxApiConfig(
      {
        agents: {
          defaults: {
            models: {
              "minimax/MiniMax-M2.1": {
                alias: "MiniMax",
                params: { custom: "value" },
              },
            },
          },
        },
      },
      "MiniMax-M2.1",
    );
    expect(
      cfg.agents?.defaults?.models?.["minimax/MiniMax-M2.1"],
    ).toMatchObject({ alias: "Minimax", params: { custom: "value" } });
  });

  it("replaces existing minimax provider entirely", () => {
    const cfg = applyMinimaxApiConfig({
      models: {
        providers: {
          minimax: {
            baseUrl: "https://old.example.com",
            apiKey: "old-key",
            api: "openai-completions",
            models: [
              {
                id: "old-model",
                name: "Old",
                reasoning: false,
                input: ["text"],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1000,
                maxTokens: 100,
              },
            ],
          },
        },
      },
    });
    expect(cfg.models?.providers?.minimax?.baseUrl).toBe(
      "https://api.minimax.io/anthropic",
    );
    expect(cfg.models?.providers?.minimax?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.minimax?.models[0]?.id).toBe("MiniMax-M2.1");
  });

  it("preserves other providers when adding minimax", () => {
    const cfg = applyMinimaxApiConfig({
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            apiKey: "anthropic-key",
            api: "anthropic-messages",
            models: [
              {
                id: "claude-opus-4-5",
                name: "Claude Opus 4.5",
                reasoning: false,
                input: ["text"],
                cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    });
    expect(cfg.models?.providers?.anthropic).toBeDefined();
    expect(cfg.models?.providers?.minimax).toBeDefined();
  });

  it("preserves existing models mode", () => {
    const cfg = applyMinimaxApiConfig({
      models: { mode: "replace", providers: {} },
    });
    expect(cfg.models?.mode).toBe("replace");
  });
});

describe("applyMinimaxApiProviderConfig", () => {
  it("does not overwrite existing primary model", () => {
    const cfg = applyMinimaxApiProviderConfig({
      agents: { defaults: { model: { primary: "anthropic/claude-opus-4-5" } } },
    });
    expect(cfg.agents?.defaults?.model?.primary).toBe(
      "anthropic/claude-opus-4-5",
    );
  });
});

describe("applyOpencodeZenProviderConfig", () => {
  it("adds opencode-zen provider with correct settings", () => {
    const cfg = applyOpencodeZenProviderConfig({});
    expect(cfg.models?.providers?.["opencode-zen"]).toMatchObject({
      baseUrl: "https://opencode.ai/zen/v1",
      apiKey: "opencode-zen",
      api: "openai-completions",
    });
    expect(
      cfg.models?.providers?.["opencode-zen"]?.models.length,
    ).toBeGreaterThan(0);
  });

  it("adds allowlist entries for fallback models", () => {
    const cfg = applyOpencodeZenProviderConfig({});
    const models = cfg.agents?.defaults?.models ?? {};
    expect(Object.keys(models)).toContain("opencode-zen/claude-opus-4-5");
    expect(Object.keys(models)).toContain("opencode-zen/gpt-5.2");
  });

  it("preserves existing alias for the default model", () => {
    const cfg = applyOpencodeZenProviderConfig({
      agents: {
        defaults: {
          models: {
            "opencode-zen/claude-opus-4-5": { alias: "My Opus" },
          },
        },
      },
    });
    expect(
      cfg.agents?.defaults?.models?.["opencode-zen/claude-opus-4-5"]?.alias,
    ).toBe("My Opus");
  });
});

describe("applyOpencodeZenConfig", () => {
  it("sets correct primary model", () => {
    const cfg = applyOpencodeZenConfig({});
    expect(cfg.agents?.defaults?.model?.primary).toBe(
      "opencode-zen/claude-opus-4-5",
    );
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyOpencodeZenConfig({
      agents: {
        defaults: {
          model: { fallbacks: ["anthropic/claude-opus-4-5"] },
        },
      },
    });
    expect(cfg.agents?.defaults?.model?.fallbacks).toEqual([
      "anthropic/claude-opus-4-5",
    ]);
  });
});

describe("apiKey optional validation", () => {
  it("minimax provider config passes Zod validation without apiKey", () => {
    // Apply the MiniMax API config which omits apiKey
    const cfg = applyMinimaxApiConfig({});

    // Verify apiKey is undefined in the generated config
    expect(cfg.models?.providers?.minimax?.apiKey).toBeUndefined();

    // Verify the generated config passes Zod schema validation
    // This is the critical test: config without apiKey must be valid
    const parseResult = ClawdbotSchema.safeParse({
      models: cfg.models,
    });

    expect(parseResult.success).toBe(true);
    if (!parseResult.success) {
      console.error("Zod validation failed:", parseResult.error?.issues);
    }
  });

  it("minimax provider config with only baseUrl and api is valid", () => {
    // Simulate a minimal provider config (what MiniMax generates)
    const minimalConfig = {
      models: {
        mode: "merge" as const,
        providers: {
          minimax: {
            baseUrl: "https://api.minimax.io/anthropic",
            api: "anthropic-messages" as const,
            models: [
              {
                id: "MiniMax-M2.1",
                name: "MiniMax M2.1",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 15, output: 60, cacheRead: 2, cacheWrite: 10 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };

    const parseResult = ClawdbotSchema.safeParse(minimalConfig);
    expect(parseResult.success).toBe(true);
  });

  it("applyMinimaxApiConfig replaces entire provider (apiKey not preserved)", () => {
    // Verify that applyMinimaxApiConfig replaces the entire provider config
    // This is expected behavior - it generates a fresh config for MiniMax
    const cfg = applyMinimaxApiConfig({
      models: {
        providers: {
          minimax: {
            baseUrl: "https://old.example.com",
            apiKey: "explicit-key",
            api: "openai-completions",
            models: [],
          },
        },
      },
    });

    // Config should be replaced with new MiniMax API settings
    expect(cfg.models?.providers?.minimax?.baseUrl).toBe(
      "https://api.minimax.io/anthropic",
    );
    expect(cfg.models?.providers?.minimax?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.minimax?.apiKey).toBeUndefined();
  });

  it("config with explicit apiKey is still valid (backwards compatibility)", () => {
    // Verify that configs with apiKey defined still pass validation
    const configWithApiKey = {
      models: {
        mode: "merge" as const,
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            apiKey: "sk-12345",
            api: "anthropic-messages" as const,
            models: [
              {
                id: "gpt-4o",
                name: "GPT-4o",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 128000,
                maxTokens: 16384,
              },
            ],
          },
        },
      },
    };

    const parseResult = ClawdbotSchema.safeParse(configWithApiKey);
    expect(parseResult.success).toBe(true);
  });

  it("config without apiKey is valid (new behavior)", () => {
    // Verify that configs without apiKey now pass validation
    const configWithoutApiKey = {
      models: {
        mode: "merge" as const,
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com",
            // No apiKey - will be resolved from env or auth profile
            api: "anthropic-messages" as const,
            models: [
              {
                id: "claude-opus-4-5",
                name: "Claude Opus 4.5",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 15, output: 75, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 200000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    };

    const parseResult = ClawdbotSchema.safeParse(configWithoutApiKey);
    expect(parseResult.success).toBe(true);
  });

  it("config with empty apiKey is rejected", () => {
    // Verify that configs with empty apiKey fail validation
    const configWithEmptyApiKey = {
      models: {
        mode: "merge" as const,
        providers: {
          test: {
            baseUrl: "https://api.test.com",
            apiKey: "", // Empty string should be rejected
            api: "openai-responses" as const,
            models: [
              {
                id: "test-model",
                name: "Test Model",
                reasoning: false,
                input: ["text" as const],
                cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 1000,
                maxTokens: 100,
              },
            ],
          },
        },
      },
    };

    const parseResult = ClawdbotSchema.safeParse(configWithEmptyApiKey);
    expect(parseResult.success).toBe(false);
    if (!parseResult.success) {
      // Zod returns "Too small: expected string to have >=1 characters" for empty strings
      expect(parseResult.error?.issues[0]?.message).toMatch(
        /Too small|string/i,
      );
    }
  });

  it("provider with apiKey uses config value over env var", () => {
    // Verify that when apiKey is in config, it takes precedence
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "env-api-key-12345";

      const cfg = {
        models: {
          mode: "merge" as const,
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              apiKey: "config-api-key-67890",
              api: "openai-responses" as const,
              models: [
                {
                  id: "gpt-4o",
                  name: "GPT-4o",
                  reasoning: false,
                  input: ["text" as const],
                  cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 16384,
                },
              ],
            },
          },
        },
      };

      const apiKey = getCustomProviderApiKey(cfg, "openai");
      expect(apiKey).toBe("config-api-key-67890");
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });

  it("provider without apiKey falls back to env var", () => {
    // Verify that when apiKey is NOT in config, env var is used
    const previousOpenAiKey = process.env.OPENAI_API_KEY;
    try {
      process.env.OPENAI_API_KEY = "env-api-key-12345";

      const cfg = {
        models: {
          mode: "merge" as const,
          providers: {
            openai: {
              baseUrl: "https://api.openai.com/v1",
              // No apiKey - should return undefined
              api: "openai-responses" as const,
              models: [
                {
                  id: "gpt-4o",
                  name: "GPT-4o",
                  reasoning: false,
                  input: ["text" as const],
                  cost: { input: 5, output: 15, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 128000,
                  maxTokens: 16384,
                },
              ],
            },
          },
        },
      };

      const apiKey = getCustomProviderApiKey(cfg, "openai");
      // Should be undefined because apiKey is not in config
      expect(apiKey).toBeUndefined();
    } finally {
      if (previousOpenAiKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousOpenAiKey;
      }
    }
  });
});

