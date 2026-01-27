import { describe, expect, it, vi } from "vitest";

import type { MoltbotConfig } from "../config/config.js";
import { makePrompter } from "./onboarding/__tests__/test-utils.js";
import {
  applyModelAllowlist,
  applyModelFallbacksFromSelection,
  promptDefaultModel,
  promptModelAllowlist,
} from "./model-picker.js";

const loadModelCatalog = vi.hoisted(() => vi.fn());
vi.mock("../agents/model-catalog.js", () => ({
  loadModelCatalog,
}));

const ensureAuthProfileStore = vi.hoisted(() =>
  vi.fn(() => ({
    version: 1,
    profiles: {},
  })),
);
const listProfilesForProvider = vi.hoisted(() => vi.fn(() => []));
vi.mock("../agents/auth-profiles.js", () => ({
  ensureAuthProfileStore,
  listProfilesForProvider,
}));

const resolveEnvApiKey = vi.hoisted(() => vi.fn(() => undefined));
const getCustomProviderApiKey = vi.hoisted(() => vi.fn(() => undefined));
vi.mock("../agents/model-auth.js", () => ({
  resolveEnvApiKey,
  getCustomProviderApiKey,
}));

describe("promptDefaultModel", () => {
  it("filters internal router models from the selection list", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openrouter",
        id: "auto",
        name: "OpenRouter Auto",
      },
      {
        provider: "openrouter",
        id: "meta-llama/llama-3.3-70b:free",
        name: "Llama 3.3 70B",
      },
    ]);

    const select = vi.fn(async (params) => {
      const first = params.options[0];
      return first?.value ?? "";
    });
    const prompter = makePrompter({ select });
    const config = { agents: { defaults: {} } } as MoltbotConfig;

    await promptDefaultModel({
      config,
      prompter,
      allowKeep: false,
      includeManual: false,
      ignoreAllowlist: true,
    });

    const options = select.mock.calls[0]?.[0]?.options ?? [];
    expect(options.some((opt) => opt.value === "openrouter/auto")).toBe(false);
    expect(options.some((opt) => opt.value === "openrouter/meta-llama/llama-3.3-70b:free")).toBe(
      true,
    );
  });
});

describe("promptModelAllowlist", () => {
  it("filters internal router models from the selection list", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "openrouter",
        id: "auto",
        name: "OpenRouter Auto",
      },
      {
        provider: "openrouter",
        id: "meta-llama/llama-3.3-70b:free",
        name: "Llama 3.3 70B",
      },
    ]);

    const multiselect = vi.fn(async (params) =>
      params.options.map((option: { value: string }) => option.value),
    );
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as MoltbotConfig;

    await promptModelAllowlist({ config, prompter });

    const options = multiselect.mock.calls[0]?.[0]?.options ?? [];
    expect(options.some((opt: { value: string }) => opt.value === "openrouter/auto")).toBe(false);
    expect(
      options.some(
        (opt: { value: string }) => opt.value === "openrouter/meta-llama/llama-3.3-70b:free",
      ),
    ).toBe(true);
  });

  it("filters to allowed keys when provided", async () => {
    loadModelCatalog.mockResolvedValue([
      {
        provider: "anthropic",
        id: "claude-opus-4-5",
        name: "Claude Opus 4.5",
      },
      {
        provider: "anthropic",
        id: "claude-sonnet-4-5",
        name: "Claude Sonnet 4.5",
      },
      {
        provider: "openai",
        id: "gpt-5.2",
        name: "GPT-5.2",
      },
    ]);

    const multiselect = vi.fn(async (params) =>
      params.options.map((option: { value: string }) => option.value),
    );
    const prompter = makePrompter({ multiselect });
    const config = { agents: { defaults: {} } } as MoltbotConfig;

    await promptModelAllowlist({
      config,
      prompter,
      allowedKeys: ["anthropic/claude-opus-4-5"],
    });

    const options = multiselect.mock.calls[0]?.[0]?.options ?? [];
    expect(options.map((opt: { value: string }) => opt.value)).toEqual([
      "anthropic/claude-opus-4-5",
    ]);
  });
});

describe("applyModelAllowlist", () => {
  it("preserves existing entries for selected models", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": { alias: "gpt" },
            "anthropic/claude-opus-4-5": { alias: "opus" },
          },
        },
      },
    } as MoltbotConfig;

    const next = applyModelAllowlist(config, ["openai/gpt-5.2"]);
    expect(next.agents?.defaults?.models).toEqual({
      "openai/gpt-5.2": { alias: "gpt" },
    });
  });

  it("clears the allowlist when no models remain", () => {
    const config = {
      agents: {
        defaults: {
          models: {
            "openai/gpt-5.2": { alias: "gpt" },
          },
        },
      },
    } as MoltbotConfig;

    const next = applyModelAllowlist(config, []);
    expect(next.agents?.defaults?.models).toBeUndefined();
  });
});

describe("applyModelFallbacksFromSelection", () => {
  it("sets fallbacks from selection when the primary is included", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5" },
        },
      },
    } as MoltbotConfig;

    const next = applyModelFallbacksFromSelection(config, [
      "anthropic/claude-opus-4-5",
      "anthropic/claude-sonnet-4-5",
    ]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-5",
      fallbacks: ["anthropic/claude-sonnet-4-5"],
    });
  });

  it("keeps existing fallbacks when the primary is not selected", () => {
    const config = {
      agents: {
        defaults: {
          model: { primary: "anthropic/claude-opus-4-5", fallbacks: ["openai/gpt-5.2"] },
        },
      },
    } as MoltbotConfig;

    const next = applyModelFallbacksFromSelection(config, ["openai/gpt-5.2"]);
    expect(next.agents?.defaults?.model).toEqual({
      primary: "anthropic/claude-opus-4-5",
      fallbacks: ["openai/gpt-5.2"],
    });
  });
});
