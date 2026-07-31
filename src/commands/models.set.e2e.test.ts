// Models set e2e tests cover persisted model selection updates through command handlers.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createModelVisibilityPolicy } from "../agents/model-visibility-policy.js";
import { stampConfigWriteMetadata } from "../config/io.meta.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

const mocks = vi.hoisted(() => ({
  currentConfig: {} as Record<string, unknown>,
  writtenConfig: undefined as Record<string, unknown> | undefined,
}));

vi.mock("./models/shared.js", async () => {
  const actual = await vi.importActual<typeof import("./models/shared.js")>("./models/shared.js");
  return {
    ...actual,
    updateConfig: async (
      mutator: (
        cfg: Record<string, unknown>,
        context: {
          runtimeConfig: Record<string, unknown>;
        },
      ) => Record<string, unknown>,
    ) => {
      const sourceConfig = structuredClone(mocks.currentConfig);
      const runtimeConfig = structuredClone(mocks.currentConfig);
      const next = mutator(sourceConfig, { runtimeConfig });
      mocks.writtenConfig = next;
      return next;
    },
  };
});

import { modelsFallbacksAddCommand } from "./models/fallbacks.js";
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

describe("models set + fallbacks", () => {
  beforeEach(() => {
    mocks.currentConfig = {};
    mocks.writtenConfig = undefined;
  });

  it("normalizes z.ai provider in models set", async () => {
    mockConfigSnapshot({});
    const runtime = makeRuntime();

    await modelsSetCommand("z.ai/glm-4.7", runtime);

    expectWrittenPrimaryModel("zai/glm-4.7");
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

  it("normalizes z-ai provider in models fallbacks add", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: { fallbacks: [] } } } });
    const runtime = makeRuntime();

    await modelsFallbacksAddCommand("z-ai/glm-4.7", {}, runtime);

    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { fallbacks: ["zai/glm-4.7"] },
        models: { "zai/glm-4.7": {} },
      },
    });
  });

  it("writes to the agent entry when --agent names an agent with its own fallbacks", async () => {
    mockConfigSnapshot({
      agents: {
        defaults: { model: { fallbacks: ["zai/glm-4.7"] } },
        list: [{ id: "riley", model: { primary: "anthropic/claude-opus-4-6", fallbacks: [] } }],
      },
    });
    const runtime = makeRuntime();

    await modelsFallbacksAddCommand("openai/gpt-5.2", { agent: "riley" }, runtime);

    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { fallbacks: ["zai/glm-4.7"] },
        models: { "openai/gpt-5.2": {} },
      },
      list: [
        {
          id: "riley",
          model: { primary: "anthropic/claude-opus-4-6", fallbacks: ["openai/gpt-5.2"] },
        },
      ],
    });
  });

  it("materializes an agent override when --agent names an inheriting agent", async () => {
    mockConfigSnapshot({
      agents: {
        defaults: {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["zai/glm-4.7"],
          },
        },
        list: [{ id: "riley" }],
      },
    });
    const runtime = makeRuntime();

    await modelsFallbacksAddCommand("openai/gpt-5.2", { agent: "riley" }, runtime);

    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: {
          primary: "anthropic/claude-opus-4-6",
          fallbacks: ["zai/glm-4.7"],
        },
        models: { "openai/gpt-5.2": {} },
      },
      list: [
        {
          id: "riley",
          model: { fallbacks: ["zai/glm-4.7", "openai/gpt-5.2"] },
        },
      ],
    });
  });

  it("rejects an unknown --agent id without writing config", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: { fallbacks: [] } } } });
    const runtime = makeRuntime();

    await expect(
      modelsFallbacksAddCommand("openai/gpt-5.2", { agent: "bogus" }, runtime),
    ).rejects.toThrow(/Unknown agent id "bogus"/);
    expect(mocks.writtenConfig).toBeUndefined();
  });

  it("preserves primary when adding fallbacks to string defaults.model", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: "openai/gpt-4.1-mini" } } });
    const runtime = makeRuntime();

    await modelsFallbacksAddCommand("anthropic/claude-opus-4-6", {}, runtime);

    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: {
          primary: "openai/gpt-4.1-mini",
          fallbacks: ["anthropic/claude-opus-4-6"],
        },
        models: { "anthropic/claude-opus-4-6": {} },
      },
    });
  });

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
