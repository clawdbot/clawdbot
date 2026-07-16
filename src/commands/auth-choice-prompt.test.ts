// Grouped auth-choice prompt tests cover configured-provider setup affordances.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import type { WizardPrompter, WizardSelectParams } from "../wizard/prompts.js";
import type { AuthChoiceGroup } from "./auth-choice-options.static.js";
import { KEEP_CURRENT_AUTH_CHOICE, promptAuthChoiceGrouped } from "./auth-choice-prompt.js";

const buildAuthChoiceGroups = vi.hoisted(() => vi.fn());
const compareAuthChoiceGroups = vi.hoisted(() =>
  vi.fn((a: AuthChoiceGroup, b: AuthChoiceGroup) => a.label.localeCompare(b.label)),
);
const isFeaturedAuthChoiceGroup = vi.hoisted(() =>
  vi.fn((group: AuthChoiceGroup) =>
    ["openai", "anthropic", "xai", "google", "openrouter"].includes(group.value),
  ),
);

vi.mock("./auth-choice-options.js", () => ({
  buildAuthChoiceGroups,
  compareAuthChoiceGroups,
  isFeaturedAuthChoiceGroup,
}));

const EMPTY_STORE: AuthProfileStore = { version: 1, profiles: {} };

function createPromptHarness(
  onSelect: (params: WizardSelectParams<unknown>) => Promise<unknown>,
): WizardPrompter {
  return {
    intro: vi.fn(async () => {}),
    outro: vi.fn(async () => {}),
    note: vi.fn(async () => {}),
    select: vi.fn(onSelect) as WizardPrompter["select"],
    multiselect: vi.fn(async () => []),
    text: vi.fn(async () => ""),
    confirm: vi.fn(async () => true),
    progress: vi.fn(() => ({
      update: vi.fn(),
      stop: vi.fn(),
    })),
  };
}

function openAIGroup(options?: Partial<AuthChoiceGroup>): AuthChoiceGroup {
  return {
    value: "openai",
    label: "OpenAI",
    providerIds: ["openai"],
    options: [
      {
        value: "openai",
        label: "ChatGPT Login",
        onboardingFeatured: true,
      },
      {
        value: "openai-api-key",
        label: "OpenAI API Key",
      },
    ],
    ...options,
  };
}

function authChoiceGroup(
  value: string,
  label: string,
  methods: Array<readonly [value: string, label: string]>,
  featured = false,
): AuthChoiceGroup {
  return {
    value,
    label,
    options: methods.map(([methodValue, methodLabel], index) => ({
      value: methodValue,
      label: methodLabel,
      ...(featured && index === 0 ? { onboardingFeatured: true } : {}),
    })),
  };
}

describe("promptAuthChoiceGrouped", () => {
  beforeEach(() => {
    buildAuthChoiceGroups.mockReset();
    compareAuthChoiceGroups
      .mockReset()
      .mockImplementation((a: AuthChoiceGroup, b: AuthChoiceGroup) =>
        a.label.localeCompare(b.label),
      );
  });

  it("marks the configured provider and offers keep current config first", async () => {
    buildAuthChoiceGroups.mockReturnValue({
      groups: [
        openAIGroup(),
        {
          value: "anthropic",
          label: "Anthropic",
          providerIds: ["anthropic"],
          options: [
            {
              value: "apiKey",
              label: "Anthropic API Key",
              onboardingFeatured: true,
            },
          ],
        },
      ],
      skipOption: { value: "skip", label: "Skip for now" },
    });
    let providerOptions: Array<{ value: unknown; label: string; hint?: string }> = [];
    let methodOptions: Array<{ value: unknown; label: string; hint?: string }> = [];
    const prompter = createPromptHarness(async (params) => {
      if (params.message === "Model/auth provider") {
        providerOptions = params.options;
        return "openai";
      }
      if (params.message === "OpenAI auth method") {
        methodOptions = params.options;
        return KEEP_CURRENT_AUTH_CHOICE;
      }
      throw new Error(`unexpected prompt ${params.message}`);
    });

    const result = await promptAuthChoiceGrouped({
      prompter,
      store: EMPTY_STORE,
      includeSkip: true,
      allowKeepCurrentProvider: true,
      config: {
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.5",
            },
          },
        },
      },
    });

    expect(result).toBe(KEEP_CURRENT_AUTH_CHOICE);
    expect(providerOptions).toContainEqual({
      value: "openai",
      label: "OpenAI (currently configured)",
      hint: undefined,
    });
    expect(methodOptions[0]).toEqual({
      value: KEEP_CURRENT_AUTH_CHOICE,
      label: "Keep current config",
      hint: "Keep openai/gpt-5.5",
    });
    expect(methodOptions.map((option) => option.value)).toEqual([
      KEEP_CURRENT_AUTH_CHOICE,
      "openai",
      "openai-api-key",
      "__back",
    ]);
  });

  it("does not show keep current config for a different provider", async () => {
    buildAuthChoiceGroups.mockReturnValue({
      groups: [openAIGroup()],
      skipOption: { value: "skip", label: "Skip for now" },
    });
    let providerOptions: Array<{ value: unknown; label: string; hint?: string }> = [];
    let methodOptions: Array<{ value: unknown; label: string; hint?: string }> = [];
    const prompter = createPromptHarness(async (params) => {
      if (params.message === "Model/auth provider") {
        providerOptions = params.options;
        return "openai";
      }
      if (params.message === "OpenAI auth method") {
        methodOptions = params.options;
        return "openai-api-key";
      }
      throw new Error(`unexpected prompt ${params.message}`);
    });

    const result = await promptAuthChoiceGrouped({
      prompter,
      store: EMPTY_STORE,
      includeSkip: true,
      allowKeepCurrentProvider: true,
      config: {
        agents: {
          defaults: {
            model: {
              primary: "anthropic/claude-sonnet-4.6",
            },
          },
        },
      },
    });

    expect(result).toBe("openai-api-key");
    expect(providerOptions).toContainEqual({
      value: "openai",
      label: "OpenAI",
      hint: undefined,
    });
    expect(methodOptions.map((option) => option.value)).toEqual([
      "openai",
      "openai-api-key",
      "__back",
    ]);
  });

  it("filters guided choices while keeping featured providers and grouped methods", async () => {
    const featuredOrder = new Map([
      ["openai", 0],
      ["openrouter", 1],
      ["xai", 2],
      ["google", 3],
      ["anthropic", 4],
    ]);
    compareAuthChoiceGroups.mockImplementation((a, b) => {
      const priorityA = featuredOrder.get(a.value) ?? Number.POSITIVE_INFINITY;
      const priorityB = featuredOrder.get(b.value) ?? Number.POSITIVE_INFINITY;
      return priorityA - priorityB || a.label.localeCompare(b.label);
    });
    buildAuthChoiceGroups.mockReturnValue({
      groups: [
        authChoiceGroup("minimax", "MiniMax", [
          ["minimax-global-oauth", "MiniMax OAuth (Global)"],
          ["minimax-global-api", "MiniMax API key (Global)"],
          ["minimax-cn-oauth", "MiniMax OAuth (CN)"],
          ["minimax-cn-api", "MiniMax API key (CN)"],
          ["minimax-legacy", "Legacy MiniMax login"],
        ]),
        authChoiceGroup("opencode", "OpenCode", [
          ["opencode-zen", "OpenCode Zen catalog"],
          ["opencode-go", "OpenCode Go catalog"],
        ]),
        authChoiceGroup("meta", "Meta", [["meta-api-key", "Meta API key"]], true),
        authChoiceGroup("xiaomi", "Xiaomi", [
          ["xiaomi-api-key", "Xiaomi API key"],
          ["xiaomi-token-plan-cn", "Xiaomi Token Plan (CN)"],
        ]),
        openAIGroup(),
        authChoiceGroup(
          "openrouter",
          "OpenRouter",
          [["openrouter-oauth", "OpenRouter OAuth"]],
          true,
        ),
        authChoiceGroup("google", "Google", [["google-gemini-cli", "Gemini CLI OAuth"]], true),
        authChoiceGroup("xai", "xAI (Grok)", [["xai-oauth", "xAI OAuth"]], true),
        authChoiceGroup("anthropic", "Anthropic", [["apiKey", "Anthropic API key"]], true),
      ],
      skipOption: { value: "skip", label: "Skip for now" },
    });
    let providerOptions: Array<{ value: unknown; label: string }> = [];
    let moreProviderOptions: Array<{ value: unknown; label: string }> = [];
    let minimaxOptions: Array<{ value: unknown; label: string }> = [];
    const prompter = createPromptHarness(async (params) => {
      if (params.message === "Model/auth provider" && !providerOptions.length) {
        providerOptions = params.options;
        return "__more";
      }
      if (params.message === "Model/auth provider") {
        moreProviderOptions = params.options;
        return "minimax";
      }
      if (params.message === "MiniMax auth method") {
        minimaxOptions = params.options;
        return "minimax-cn-api";
      }
      throw new Error(`unexpected prompt ${params.message}`);
    });

    const result = await promptAuthChoiceGrouped({
      prompter,
      store: EMPTY_STORE,
      includeSkip: true,
      allowedChoices: new Set([
        "openai",
        "openai-api-key",
        "apiKey",
        "xai-oauth",
        "google-gemini-cli",
        "openrouter-oauth",
        "minimax-global-oauth",
        "minimax-global-api",
        "minimax-cn-oauth",
        "minimax-cn-api",
        "opencode-zen",
        "opencode-go",
        "xiaomi-api-key",
        "xiaomi-token-plan-cn",
        "meta-api-key",
      ]),
    });

    expect(providerOptions.map((option) => option.value)).toEqual([
      "openai",
      "openrouter",
      "xai",
      "google",
      "anthropic",
      "__more",
      "skip",
    ]);
    expect(moreProviderOptions.map((option) => option.value)).toEqual([
      "meta",
      "minimax",
      "opencode",
      "xiaomi",
      "__back",
    ]);
    expect(minimaxOptions.map((option) => option.value)).toEqual([
      "minimax-global-oauth",
      "minimax-global-api",
      "minimax-cn-oauth",
      "minimax-cn-api",
      "__back",
    ]);
    expect(result).toBe("minimax-cn-api");
  });
});
