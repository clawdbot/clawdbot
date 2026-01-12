import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import { applyAuthChoice } from "./auth-choice.js";

const noopAsync = async () => {};
const noop = () => {};

describe("applyAuthChoice", () => {
  const previousStateDir = process.env.CLAWDBOT_STATE_DIR;
  const previousAgentDir = process.env.CLAWDBOT_AGENT_DIR;
  const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
  const previousOpenrouterKey = process.env.OPENROUTER_API_KEY;
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
    if (previousOpenrouterKey === undefined) {
      delete process.env.OPENROUTER_API_KEY;
    } else {
      process.env.OPENROUTER_API_KEY = previousOpenrouterKey;
    }
  });

  it("prompts and writes MiniMax API key when selecting minimax-api", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-auth-"));
    process.env.CLAWDBOT_STATE_DIR = tempStateDir;
    process.env.CLAWDBOT_AGENT_DIR = path.join(tempStateDir, "agent");
    process.env.PI_CODING_AGENT_DIR = process.env.CLAWDBOT_AGENT_DIR;

    const text = vi
      .fn()
      .mockResolvedValue('export MINIMAX_API_KEY="sk-minimax-test"');
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter: WizardPrompter = {
      intro: vi.fn(noopAsync),
      outro: vi.fn(noopAsync),
      note: vi.fn(noopAsync),
      select,
      multiselect,
      text,
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: noop, stop: noop })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const result = await applyAuthChoice({
      authChoice: "minimax-api",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter MiniMax API key" }),
    );
    expect(result.config.models?.providers?.minimax).toMatchObject({
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
    });
    expect(result.config.agents?.defaults?.model).toMatchObject({
      primary: "minimax/MiniMax-M2.1",
    });
    expect(result.config.auth?.profiles?.["minimax:default"]).toMatchObject({
      provider: "minimax",
      mode: "api_key",
    });

    const authProfilePath = path.join(
      tempStateDir,
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    const raw = await fs.readFile(authProfilePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { key?: string }>;
    };
    expect(parsed.profiles?.["minimax:default"]?.key).toBe("sk-minimax-test");
  });

  it("configures MiniMax M2.1 via the Anthropic-compatible endpoint", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-auth-"));
    process.env.CLAWDBOT_STATE_DIR = tempStateDir;
    process.env.CLAWDBOT_AGENT_DIR = path.join(tempStateDir, "agent");
    process.env.PI_CODING_AGENT_DIR = process.env.CLAWDBOT_AGENT_DIR;

    const text = vi.fn().mockResolvedValue("sk-minimax-test");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter: WizardPrompter = {
      intro: vi.fn(noopAsync),
      outro: vi.fn(noopAsync),
      note: vi.fn(noopAsync),
      select,
      multiselect,
      text,
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: noop, stop: noop })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const result = await applyAuthChoice({
      authChoice: "minimax-api",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter MiniMax API key" }),
    );
    expect(result.config.models?.providers?.minimax).toMatchObject({
      baseUrl: "https://api.minimax.io/anthropic",
      api: "anthropic-messages",
    });
    expect(result.config.agents?.defaults?.model).toMatchObject({
      primary: "minimax/MiniMax-M2.1",
    });

    const authProfilePath = path.join(
      tempStateDir,
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    const raw = await fs.readFile(authProfilePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { key?: string }>;
    };
    expect(parsed.profiles?.["minimax:default"]?.key).toBe("sk-minimax-test");
  });
  it("does not override the default model when selecting opencode-zen without setDefaultModel", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-auth-"));
    process.env.CLAWDBOT_STATE_DIR = tempStateDir;
    process.env.CLAWDBOT_AGENT_DIR = path.join(tempStateDir, "agent");
    process.env.PI_CODING_AGENT_DIR = process.env.CLAWDBOT_AGENT_DIR;

    const text = vi.fn().mockResolvedValue("sk-opencode-zen-test");
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const prompter: WizardPrompter = {
      intro: vi.fn(noopAsync),
      outro: vi.fn(noopAsync),
      note: vi.fn(noopAsync),
      select,
      multiselect,
      text,
      confirm: vi.fn(async () => false),
      progress: vi.fn(() => ({ update: noop, stop: noop })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const result = await applyAuthChoice({
      authChoice: "opencode-zen",
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-opus-4-5" },
          },
        },
      },
      prompter,
      runtime,
      setDefaultModel: false,
    });

    expect(text).toHaveBeenCalledWith(
      expect.objectContaining({ message: "Enter OpenCode Zen API key" }),
    );
    expect(result.config.agents?.defaults?.model?.primary).toBe(
      "anthropic/claude-opus-4-5",
    );
    expect(result.config.models?.providers?.["opencode-zen"]).toBeUndefined();
    expect(result.agentModelOverride).toBe("opencode/claude-opus-4-5");
  });

  it("uses existing OPENROUTER_API_KEY when selecting openrouter-api-key", async () => {
    tempStateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clawdbot-auth-"));
    process.env.CLAWDBOT_STATE_DIR = tempStateDir;
    process.env.CLAWDBOT_AGENT_DIR = path.join(tempStateDir, "agent");
    process.env.PI_CODING_AGENT_DIR = process.env.CLAWDBOT_AGENT_DIR;
    process.env.OPENROUTER_API_KEY = "sk-openrouter-test";

    const text = vi.fn();
    const select: WizardPrompter["select"] = vi.fn(
      async (params) => params.options[0]?.value as never,
    );
    const multiselect: WizardPrompter["multiselect"] = vi.fn(async () => []);
    const confirm = vi.fn(async () => true);
    const prompter: WizardPrompter = {
      intro: vi.fn(noopAsync),
      outro: vi.fn(noopAsync),
      note: vi.fn(noopAsync),
      select,
      multiselect,
      text,
      confirm,
      progress: vi.fn(() => ({ update: noop, stop: noop })),
    };
    const runtime: RuntimeEnv = {
      log: vi.fn(),
      error: vi.fn(),
      exit: vi.fn((code: number) => {
        throw new Error(`exit:${code}`);
      }),
    };

    const result = await applyAuthChoice({
      authChoice: "openrouter-api-key",
      config: {},
      prompter,
      runtime,
      setDefaultModel: true,
    });

    expect(confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("OPENROUTER_API_KEY"),
      }),
    );
    expect(text).not.toHaveBeenCalled();
    expect(result.config.auth?.profiles?.["openrouter:default"]).toMatchObject({
      provider: "openrouter",
      mode: "api_key",
    });
    expect(result.config.agents?.defaults?.model?.primary).toBe(
      "openrouter/auto",
    );

    const authProfilePath = path.join(
      tempStateDir,
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    const raw = await fs.readFile(authProfilePath, "utf8");
    const parsed = JSON.parse(raw) as {
      profiles?: Record<string, { key?: string }>;
    };
    expect(parsed.profiles?.["openrouter:default"]?.key).toBe(
      "sk-openrouter-test",
    );

    delete process.env.OPENROUTER_API_KEY;
  });
});
