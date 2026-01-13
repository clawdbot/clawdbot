import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { OAuthCredentials } from "@mariozechner/pi-ai";
import { afterEach, describe, expect, it } from "vitest";

import {
  applyAuthProfileConfig,
  applyMinimaxApiConfig,
  applyMinimaxApiProviderConfig,
  applySyntheticConfig,
  applySyntheticProviderConfig,
  applyOpencodeZenConfig,
  applyOpencodeZenProviderConfig,
  applyOpenrouterConfig,
  applyOpenrouterProviderConfig,
  OPENROUTER_DEFAULT_MODEL_REF,
  SYNTHETIC_DEFAULT_MODEL_ID,
  SYNTHETIC_DEFAULT_MODEL_REF,
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

  it("merges existing minimax provider models", () => {
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
    expect(cfg.models?.providers?.minimax?.apiKey).toBe("old-key");
    expect(cfg.models?.providers?.minimax?.models.map((m) => m.id)).toEqual([
      "old-model",
      "MiniMax-M2.1",
    ]);
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

describe("applySyntheticConfig", () => {
  it("adds synthetic provider with correct settings", () => {
    const cfg = applySyntheticConfig({});
    expect(cfg.models?.providers?.synthetic).toMatchObject({
      baseUrl: "https://api.synthetic.new/anthropic",
      api: "anthropic-messages",
    });
  });

  it("sets correct primary model", () => {
    const cfg = applySyntheticConfig({});
    expect(cfg.agents?.defaults?.model?.primary).toBe(
      SYNTHETIC_DEFAULT_MODEL_REF,
    );
  });

  it("merges existing synthetic provider models", () => {
    const cfg = applySyntheticProviderConfig({
      models: {
        providers: {
          synthetic: {
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
    expect(cfg.models?.providers?.synthetic?.baseUrl).toBe(
      "https://api.synthetic.new/anthropic",
    );
    expect(cfg.models?.providers?.synthetic?.api).toBe("anthropic-messages");
    expect(cfg.models?.providers?.synthetic?.apiKey).toBe("old-key");
    const ids = cfg.models?.providers?.synthetic?.models.map((m) => m.id);
    expect(ids).toContain("old-model");
    expect(ids).toContain(SYNTHETIC_DEFAULT_MODEL_ID);
  });
});

describe("applyOpencodeZenProviderConfig", () => {
  it("adds allowlist entry for the default model", () => {
    const cfg = applyOpencodeZenProviderConfig({});
    const models = cfg.agents?.defaults?.models ?? {};
    expect(Object.keys(models)).toContain("opencode/claude-opus-4-5");
  });

  it("preserves existing alias for the default model", () => {
    const cfg = applyOpencodeZenProviderConfig({
      agents: {
        defaults: {
          models: {
            "opencode/claude-opus-4-5": { alias: "My Opus" },
          },
        },
      },
    });
    expect(
      cfg.agents?.defaults?.models?.["opencode/claude-opus-4-5"]?.alias,
    ).toBe("My Opus");
  });
});

describe("applyOpencodeZenConfig", () => {
  it("sets correct primary model", () => {
    const cfg = applyOpencodeZenConfig({});
    expect(cfg.agents?.defaults?.model?.primary).toBe(
      "opencode/claude-opus-4-5",
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

describe("applyOpenrouterProviderConfig", () => {
  it("adds allowlist entry for the default model", () => {
    const cfg = applyOpenrouterProviderConfig({});
    const models = cfg.agents?.defaults?.models ?? {};
    expect(Object.keys(models)).toContain(OPENROUTER_DEFAULT_MODEL_REF);
  });

  it("preserves existing alias for the default model", () => {
    const cfg = applyOpenrouterProviderConfig({
      agents: {
        defaults: {
          models: {
            [OPENROUTER_DEFAULT_MODEL_REF]: { alias: "Router" },
          },
        },
      },
    });
    expect(
      cfg.agents?.defaults?.models?.[OPENROUTER_DEFAULT_MODEL_REF]?.alias,
    ).toBe("Router");
  });
});

describe("applyOpenrouterConfig", () => {
  it("sets correct primary model", () => {
    const cfg = applyOpenrouterConfig({});
    expect(cfg.agents?.defaults?.model?.primary).toBe(
      OPENROUTER_DEFAULT_MODEL_REF,
    );
  });

  it("preserves existing model fallbacks", () => {
    const cfg = applyOpenrouterConfig({
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
