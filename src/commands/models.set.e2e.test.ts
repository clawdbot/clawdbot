import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  currentConfig: {} as Record<string, unknown>,
  writtenConfig: undefined as Record<string, unknown> | undefined,
}));

vi.mock("./models/shared.js", async () => {
  const actual = await vi.importActual<typeof import("./models/shared.js")>("./models/shared.js");
  return {
    ...actual,
    updateConfig: async (mutator: (cfg: Record<string, unknown>) => Record<string, unknown>) => {
      const next = mutator(structuredClone(mocks.currentConfig));
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

function getWrittenConfig() {
  return mocks.writtenConfig as Record<string, unknown>;
}

function expectWrittenPrimaryModel(model: string) {
  expect(mocks.writtenConfig).toBeDefined();
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

  it("normalizes z-ai provider in models fallbacks add", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: { fallbacks: [] } } } });
    const runtime = makeRuntime();

    await modelsFallbacksAddCommand("z-ai/glm-4.7", runtime);

    expect(mocks.writtenConfig).toBeDefined();
    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { fallbacks: ["zai/glm-4.7"] },
        models: { "zai/glm-4.7": {} },
      },
    });
  });

  it("preserves primary when adding fallbacks to string defaults.model", async () => {
    mockConfigSnapshot({ agents: { defaults: { model: "openai/gpt-4.1-mini" } } });
    const runtime = makeRuntime();

    await modelsFallbacksAddCommand("anthropic/claude-opus-4-6", runtime);

    expect(mocks.writtenConfig).toBeDefined();
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

    expect(mocks.writtenConfig).toBeDefined();
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

    expect(mocks.writtenConfig).toBeDefined();
    const written = getWrittenConfig();
    expect(written.agents).toEqual({
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        models: { "anthropic/claude-opus-4-6": {} },
      },
    });
  });
});
