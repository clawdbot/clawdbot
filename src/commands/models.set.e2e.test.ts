// Models set e2e tests cover persisted model selection updates through command handlers.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { registerModelsCli } from "../cli/models-cli.js";
import { stampConfigWriteMetadata } from "../config/io.meta.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { defaultRuntime } from "../runtime.js";
import { runRegisteredCli } from "../test-utils/command-runner.js";

const mocks = vi.hoisted(() => ({
  currentConfig: {} as Record<string, unknown>,
  writtenConfig: undefined as Record<string, unknown> | undefined,
}));

vi.mock("../config/config.js", async () => {
  const actual = await vi.importActual<typeof import("../config/config.js")>("../config/config.js");
  return {
    ...actual,
    readConfigFileSnapshot: async () => ({
      valid: true,
      hash: "config-hash",
      sourceConfig: structuredClone(mocks.currentConfig),
      runtimeConfig: structuredClone(mocks.currentConfig),
      config: structuredClone(mocks.currentConfig),
    }),
    replaceConfigFile: async ({ nextConfig }: { nextConfig: Record<string, unknown> }) => {
      mocks.writtenConfig = nextConfig;
    },
  };
});

import { modelsSetImageCommand } from "./models/set-image.js";
import { modelsSetCommand } from "./models/set.js";

function mockConfigSnapshot(config: Record<string, unknown> = {}) {
  mocks.currentConfig = config;
  mocks.writtenConfig = undefined;
}

function makeRuntime() {
  return { log: vi.fn(), error: vi.fn(), exit: vi.fn() };
}

function getWrittenConfig(): OpenClawConfig {
  if (!mocks.writtenConfig) {
    throw new Error("expected config write");
  }
  return mocks.writtenConfig as OpenClawConfig;
}

function expectWrittenPrimaryModel(model: string) {
  const written = getWrittenConfig();
  expect(written.agents).toEqual({
    defaults: {
      model: { primary: model },
      models: { [model]: {} },
    },
  });
}

const fallbackGroups = [
  { name: "fallbacks", key: "model", label: "Fallbacks", singular: "Fallback" },
  {
    name: "image-fallbacks",
    key: "imageModel",
    label: "Image fallbacks",
    singular: "Image fallback",
  },
] as const;

async function runFallbackCommand(name: string, ...args: string[]) {
  await runRegisteredCli({ register: registerModelsCli, argv: ["models", name, ...args] });
}

describe("models set + fallbacks", () => {
  beforeEach(() => {
    mocks.currentConfig = {};
    mocks.writtenConfig = undefined;
    vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
  });

  afterEach(() => vi.restoreAllMocks());

  it("normalizes z.ai provider in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("z.ai/glm-4.7", runtime);

    expectWrittenPrimaryModel("zai/glm-4.7");
  });

  it("does not warn for a cataloged model under a known provider", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("openai/gpt-5.6-sol", runtime);

    expectWrittenPrimaryModel("openai/gpt-5.6-sol");
    expect(runtime.error).not.toHaveBeenCalled();
  });

  it.each([
    ["text", modelsSetCommand],
    ["image", modelsSetImageCommand],
  ])("rejects an unknown %s model provider without writing config", async (_kind, command) => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await expect(command("no-such-provider/no-such-model", runtime)).rejects.toThrow(
      'Unknown model provider "no-such-provider"',
    );

    expect(mocks.writtenConfig).toBeUndefined();
  });

  it.each([
    ["text", modelsSetCommand],
    ["image", modelsSetImageCommand],
  ])("warns but saves an unknown %s model for a known provider", async (_kind, command) => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await command("openai/not-in-the-local-catalog", runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining(
        'Model "openai/not-in-the-local-catalog" is not in the local model catalog',
      ),
    );
    expect(getWrittenConfig().agents?.defaults?.models).toHaveProperty(
      "openai/not-in-the-local-catalog",
    );
  });

  it("recognizes a provider declared by a disabled installed plugin", async () => {
    mockConfigSnapshot({ plugins: { entries: { ollama: { enabled: false } } } });
    const runtime = makeRuntime();

    await modelsSetCommand("ollama/site-local-model", runtime);

    expect(runtime.error).toHaveBeenCalledWith(
      expect.stringContaining('Model "ollama/site-local-model" is not in the local model catalog'),
    );
    expect(getWrittenConfig().agents?.defaults?.models).toHaveProperty("ollama/site-local-model");
  });

  it("does not make an unlisted model override invalid on a fresh config", async () => {
    mockConfigSnapshot({});

    await modelsSetCommand("clawrouter/google/gemini-3.5-flash", makeRuntime());

    const written = getWrittenConfig();
    const persisted = stampConfigWriteMetadata(
      written,
      "2026-07-18T00:00:00.000Z",
      "test",
      mocks.currentConfig,
    );
    const policy = createModelVisibilityPolicy({
      cfg: persisted,
      catalog: [],
      defaultProvider: "clawrouter",
      defaultModel: "google/gemini-3.5-flash",
    });
    expect(written.agents?.defaults?.modelPolicy).toBeUndefined();
    expect(persisted.meta?.migrations?.modelPolicyAllowlist).toBe(true);
    expect(policy.allows({ provider: "openai", model: "gpt-5.6-sol" })).toBe(true);
  });

  it.each(fallbackGroups)(
    "normalizes z-ai provider in models $name add",
    async ({ name, key, label }) => {
      mockConfigSnapshot({ agents: { defaults: { [key]: { fallbacks: [] } } } });

      await runFallbackCommand(name, "add", "z-ai/glm-4.7");

      const written = getWrittenConfig();
      expect(written.agents).toEqual({
        defaults: {
          [key]: { fallbacks: ["zai/glm-4.7"] },
          models: { "zai/glm-4.7": {} },
        },
      });
      expect(defaultRuntime.log).toHaveBeenLastCalledWith(`${label}: zai/glm-4.7`);
    },
  );

  it.each(fallbackGroups)(
    "preserves string primary when adding models $name",
    async ({ name, key }) => {
      mockConfigSnapshot({ agents: { defaults: { [key]: "openai/gpt-4.1-mini" } } });

      await runFallbackCommand(name, "add", "anthropic/claude-opus-4-6");

      const written = getWrittenConfig();
      expect(written.agents).toEqual({
        defaults: {
          [key]: {
            primary: "openai/gpt-4.1-mini",
            fallbacks: ["anthropic/claude-opus-4-6"],
          },
          models: { "anthropic/claude-opus-4-6": {} },
        },
      });
    },
  );

  it.each(fallbackGroups)(
    "does not duplicate a provider alias in models $name add",
    async ({ name, key }) => {
      mockConfigSnapshot({
        agents: { defaults: { [key]: { fallbacks: ["moonshotai/kimi-k3"] } } },
      });

      await runFallbackCommand(name, "add", "moonshot/kimi-k3");

      expect(getWrittenConfig().agents?.defaults?.[key]).toEqual({
        fallbacks: ["moonshotai/kimi-k3"],
      });
    },
  );

  it.each(fallbackGroups)("removes a provider alias from models $name", async ({ name, key }) => {
    mockConfigSnapshot({
      agents: { defaults: { [key]: { fallbacks: ["moonshotai/kimi-k3"] } } },
    });

    await runFallbackCommand(name, "remove", "moonshot-ai/kimi-k3");

    expect(getWrittenConfig().agents?.defaults?.[key]).toEqual({ fallbacks: [] });
  });

  it.each(fallbackGroups)(
    "removes aliases and clears only models $name",
    async ({ name, key, label, singular }) => {
      const siblingKey = key === "model" ? "imageModel" : "model";
      const primary = "openai/gpt-5.6-luna";
      const sibling = { primary, fallbacks: [primary] };
      mockConfigSnapshot({
        agents: {
          defaults: {
            [key]: { primary, fallbacks: ["backup", primary] },
            [siblingKey]: sibling,
            models: { "zai/glm-4.7": { alias: "backup" } },
          },
        },
      });

      await runFallbackCommand(name, "remove", "z-ai/glm-4.7");

      expect(getWrittenConfig().agents?.defaults?.[key]).toEqual({ primary, fallbacks: [primary] });
      expect(getWrittenConfig().agents?.defaults?.[siblingKey]).toEqual(sibling);
      expect(defaultRuntime.log).toHaveBeenLastCalledWith(`${label}: ${primary}`);
      mocks.currentConfig = getWrittenConfig();

      await runFallbackCommand(name, "clear");

      expect(getWrittenConfig().agents?.defaults?.[key]).toEqual({ primary, fallbacks: [] });
      expect(getWrittenConfig().agents?.defaults?.[siblingKey]).toEqual(sibling);
      expect(defaultRuntime.log).toHaveBeenLastCalledWith(`${singular} list cleared.`);

      mockConfigSnapshot(getWrittenConfig());
      const error = vi.spyOn(defaultRuntime, "error").mockImplementation(() => {});
      const exit = vi.spyOn(defaultRuntime, "exit").mockImplementation(() => {
        throw new Error("CLI exit");
      });
      await expect(runFallbackCommand(name, "remove", "backup")).rejects.toThrow("CLI exit");
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining(`${singular} not found: zai/glm-4.7.`),
      );
      expect(error).toHaveBeenCalledWith(expect.stringContaining(`models ${name} list`));
      expect(exit).toHaveBeenCalledWith(1);
      expect(mocks.writtenConfig).toBeUndefined();
    },
  );

  it("normalizes provider casing in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("Z.AI/glm-4.7", runtime);

    expectWrittenPrimaryModel("zai/glm-4.7");
  });

  it("keeps canonical OpenRouter native ids in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("openrouter/hunter-alpha", runtime);

    expectWrittenPrimaryModel("openrouter/hunter-alpha");
  });

  it("normalizes retired Google Gemini preview ids in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("google/gemini-3-pro-preview", runtime);

    expectWrittenPrimaryModel("google/gemini-3.1-pro-preview");
  });

  it("migrates legacy duplicated OpenRouter keys on write", async () => {
    mockConfigSnapshot({
      agents: {
        defaults: {
          models: {
            "openrouter/openrouter/hunter-alpha": {
              params: { thinking: "high" },
            },
          },
        },
      },
    });
    const runtime = makeRuntime();

    await modelsSetCommand("openrouter/hunter-alpha", runtime);

    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { primary: "openrouter/hunter-alpha" },
        models: {
          "openrouter/hunter-alpha": {
            params: { thinking: "high" },
          },
        },
      },
    });
  });

  it("rewrites string defaults.model to object form when setting primary", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: "openai/gpt-4.1-mini" } } });
    const runtime = makeRuntime();

    await modelsSetCommand("anthropic/claude-opus-4-6", runtime);

    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
      },
    });
  });
});
