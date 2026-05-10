import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../agents/auth-profiles.js";
import type { ProviderAuthChoiceMetadata } from "../plugins/provider-auth-choices.js";
import type { ProviderWizardOption } from "../plugins/provider-wizard.js";
import {
  buildAuthChoiceGroups,
  buildAuthChoiceOptions,
  formatAuthChoiceChoicesForCli,
} from "./auth-choice-options.js";
import { formatStaticAuthChoiceChoicesForCli } from "./auth-choice-options.static.js";

const resolveManifestProviderAuthChoices = vi.hoisted(() =>
  vi.fn<() => ProviderAuthChoiceMetadata[]>(() => []),
);
const resolveProviderWizardOptions = vi.hoisted(() =>
  vi.fn<() => ProviderWizardOption[]>(() => []),
);
const resolveLegacyAuthChoiceAliasesForCli = vi.hoisted(() => vi.fn<() => string[]>(() => []));

vi.mock("./auth-choice-legacy.js", () => ({
  resolveLegacyAuthChoiceAliasesForCli,
}));

function includesOnboardingScope(
  scopes: readonly ("text-inference" | "image-generation")[] | undefined,
  scope: "text-inference" | "image-generation",
): boolean {
  return scopes ? scopes.includes(scope) : scope === "text-inference";
}

vi.mock("../flows/provider-flow.js", () => ({
  resolveProviderSetupFlowContributions: vi.fn(
    (params?: { scope?: "text-inference" | "image-generation" }) => {
      const scope = params?.scope ?? "text-inference";
      return [
        ...resolveManifestProviderAuthChoices()
          .filter((choice) => includesOnboardingScope(choice.onboardingScopes, scope))
          .map((choice) => ({
            option: {
              value: choice.choiceId,
              label: choice.choiceLabel,
              ...(choice.choiceHint ? { hint: choice.choiceHint } : {}),
              ...(choice.groupId && choice.groupLabel
                ? {
                    group: {
                      id: choice.groupId,
                      label: choice.groupLabel,
                      ...(choice.groupHint ? { hint: choice.groupHint } : {}),
                    },
                  }
                : {}),
              ...(choice.assistantPriority !== undefined
                ? { assistantPriority: choice.assistantPriority }
                : {}),
              ...(choice.assistantVisibility
                ? { assistantVisibility: choice.assistantVisibility }
                : {}),
            },
          })),
        ...resolveProviderWizardOptions()
          .filter((option) => includesOnboardingScope(option.onboardingScopes, scope))
          .map((option) => ({
            option: {
              value: option.value,
              label: option.label,
              ...(option.hint ? { hint: option.hint } : {}),
              group: {
                id: option.groupId,
                label: option.groupLabel,
                ...(option.groupHint ? { hint: option.groupHint } : {}),
              },
              ...(option.assistantPriority !== undefined
                ? { assistantPriority: option.assistantPriority }
                : {}),
              ...(option.assistantVisibility
                ? { assistantVisibility: option.assistantVisibility }
                : {}),
            },
          })),
      ];
    },
  ),
}));

const EMPTY_STORE: AuthProfileStore = { version: 1, profiles: {} };

function getOptions(includeSkip = false) {
  return buildAuthChoiceOptions({
    store: EMPTY_STORE,
    includeSkip,
  });
}

function requireChoiceGroup(
  groups: ReturnType<typeof buildAuthChoiceGroups>["groups"],
  value: string,
) {
  const group = groups.find((entry) => entry.value === value);
  if (!group) {
    throw new Error(`expected auth choice group ${value}`);
  }
  return group;
}

describe("buildAuthChoiceOptions", () => {
  beforeEach(() => {
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    resolveProviderWizardOptions.mockReturnValue([]);
    resolveLegacyAuthChoiceAliasesForCli.mockReturnValue([]);
  });

  it("includes core and provider-specific auth choices", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "chutes",
        providerId: "chutes",
        methodId: "oauth",
        choiceId: "chutes",
        choiceLabel: "Chutes (OAuth)",
        groupId: "chutes",
        groupLabel: "Chutes",
      },
      {
        pluginId: "github-copilot",
        providerId: "github-copilot",
        methodId: "device",
        choiceId: "github-copilot",
        choiceLabel: "GitHub Copilot",
        groupId: "copilot",
        groupLabel: "Copilot",
      },
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
      },
      {
        pluginId: "litellm",
        providerId: "litellm",
        methodId: "api-key",
        choiceId: "litellm-api-key",
        choiceLabel: "LiteLLM API key",
        groupId: "litellm",
        groupLabel: "LiteLLM",
      },
      {
        pluginId: "moonshot",
        providerId: "moonshot",
        methodId: "api-key",
        choiceId: "moonshot-api-key",
        choiceLabel: "Kimi API key (.ai)",
        groupId: "moonshot",
        groupLabel: "Moonshot AI (Kimi K2.6)",
      },
      {
        pluginId: "minimax",
        providerId: "minimax",
        methodId: "api-global",
        choiceId: "minimax-global-api",
        choiceLabel: "MiniMax API key (Global)",
        groupId: "minimax",
        groupLabel: "MiniMax",
      },
      {
        pluginId: "zai",
        providerId: "zai",
        methodId: "api-key",
        choiceId: "zai-api-key",
        choiceLabel: "Z.AI API key",
        groupId: "zai",
        groupLabel: "Z.AI",
      },
      {
        pluginId: "xiaomi",
        providerId: "xiaomi",
        methodId: "api-key",
        choiceId: "xiaomi-api-key",
        choiceLabel: "Xiaomi API key",
        groupId: "xiaomi",
        groupLabel: "Xiaomi",
      },
      {
        pluginId: "together",
        providerId: "together",
        methodId: "api-key",
        choiceId: "together-api-key",
        choiceLabel: "Together AI API key",
        groupId: "together",
        groupLabel: "Together AI",
      },
      {
        pluginId: "xai",
        providerId: "xai",
        methodId: "api-key",
        choiceId: "xai-api-key",
        choiceLabel: "xAI API key",
        groupId: "xai",
        groupLabel: "xAI (Grok)",
      },
      {
        pluginId: "mistral",
        providerId: "mistral",
        methodId: "api-key",
        choiceId: "mistral-api-key",
        choiceLabel: "Mistral API key",
        groupId: "mistral",
        groupLabel: "Mistral AI",
      },
      {
        pluginId: "volcengine",
        providerId: "volcengine",
        methodId: "api-key",
        choiceId: "volcengine-api-key",
        choiceLabel: "Volcano Engine API key",
        groupId: "volcengine",
        groupLabel: "Volcano Engine",
      },
      {
        pluginId: "byteplus",
        providerId: "byteplus",
        methodId: "api-key",
        choiceId: "byteplus-api-key",
        choiceLabel: "BytePlus API key",
        groupId: "byteplus",
        groupLabel: "BytePlus",
      },
      {
        pluginId: "opencode-go",
        providerId: "opencode-go",
        methodId: "api-key",
        choiceId: "opencode-go",
        choiceLabel: "OpenCode Go catalog",
        groupId: "opencode",
        groupLabel: "OpenCode",
      },
    ]);
    resolveProviderWizardOptions.mockReturnValue([
      {
        value: "ollama",
        label: "Ollama",
        hint: "Cloud and local open models",
        groupId: "ollama",
        groupLabel: "Ollama",
      },
      {
        value: "vllm",
        label: "vLLM",
        hint: "Local/self-hosted OpenAI-compatible server",
        groupId: "vllm",
        groupLabel: "vLLM",
      },
      {
        value: "sglang",
        label: "SGLang",
        hint: "Fast self-hosted OpenAI-compatible server",
        groupId: "sglang",
        groupLabel: "SGLang",
      },
    ]);
    const options = getOptions();

    const optionValues = options.map((option) => option.value);
    for (const expectedValue of [
      "github-copilot",
      "zai-api-key",
      "xiaomi-api-key",
      "minimax-global-api",
      "moonshot-api-key",
      "together-api-key",
      "chutes",
      "xai-api-key",
      "mistral-api-key",
      "volcengine-api-key",
      "byteplus-api-key",
      "vllm",
      "opencode-go",
      "ollama",
      "sglang",
    ]) {
      expect(optionValues).toContain(expectedValue);
    }
  });

  it("builds cli help choices from the same runtime catalog", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "chutes",
        providerId: "chutes",
        methodId: "oauth",
        choiceId: "chutes",
        choiceLabel: "Chutes (OAuth)",
      },
      {
        pluginId: "litellm",
        providerId: "litellm",
        methodId: "api-key",
        choiceId: "litellm-api-key",
        choiceLabel: "LiteLLM API key",
      },
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
      },
    ]);
    resolveProviderWizardOptions.mockReturnValue([
      {
        value: "ollama",
        label: "Ollama",
        hint: "Cloud and local open models",
        groupId: "ollama",
        groupLabel: "Ollama",
      },
    ]);
    const options = getOptions(true);
    const cliChoices = formatAuthChoiceChoicesForCli({
      includeLegacyAliases: false,
      includeSkip: true,
    }).split("|");

    expect(cliChoices).toContain("openai-api-key");
    expect(cliChoices).toContain("chutes");
    expect(cliChoices).toContain("litellm-api-key");
    expect(cliChoices).toContain("custom-api-key");
    expect(cliChoices).toContain("skip");
    expect(options.map((option) => option.value)).toContain("ollama");
    expect(cliChoices).toContain("ollama");
  });

  it("can include legacy aliases in cli help choices", () => {
    resolveLegacyAuthChoiceAliasesForCli.mockReturnValue(["claude-cli", "codex-cli"]);

    const cliChoices = formatAuthChoiceChoicesForCli({
      includeLegacyAliases: true,
      includeSkip: true,
    }).split("|");

    expect(cliChoices).toContain("claude-cli");
    expect(cliChoices).toContain("codex-cli");
  });

  it("keeps static cli help choices off the plugin-backed catalog", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
      },
    ]);
    resolveProviderWizardOptions.mockReturnValue([
      {
        value: "ollama",
        label: "Ollama",
        hint: "Cloud and local open models",
        groupId: "ollama",
        groupLabel: "Ollama",
      },
    ]);

    const cliChoices = formatStaticAuthChoiceChoicesForCli({
      includeLegacyAliases: false,
      includeSkip: true,
    }).split("|");

    expect(cliChoices).not.toContain("ollama");
    expect(cliChoices).not.toContain("openai-api-key");
    expect(cliChoices).not.toContain("chutes");
    expect(cliChoices).not.toContain("litellm-api-key");
    expect(cliChoices).toContain("custom-api-key");
    expect(cliChoices).toContain("skip");
  });

  it("shows plugin and wizard providers in grouped selection", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "chutes",
        providerId: "chutes",
        methodId: "oauth",
        choiceId: "chutes",
        choiceLabel: "Chutes (OAuth)",
        groupId: "chutes",
        groupLabel: "Chutes",
      },
      {
        pluginId: "litellm",
        providerId: "litellm",
        methodId: "api-key",
        choiceId: "litellm-api-key",
        choiceLabel: "LiteLLM API key",
        groupId: "litellm",
        groupLabel: "LiteLLM",
      },
    ]);
    resolveProviderWizardOptions.mockReturnValue([
      {
        value: "ollama",
        label: "Ollama",
        hint: "Cloud and local open models",
        groupId: "ollama",
        groupLabel: "Ollama",
      },
    ]);
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const chutesGroup = requireChoiceGroup(groups, "chutes");
    const litellmGroup = requireChoiceGroup(groups, "litellm");
    const ollamaGroup = requireChoiceGroup(groups, "ollama");

    expect(chutesGroup.options.map((option) => option.value)).toContain("chutes");
    expect(litellmGroup.options.map((option) => option.value)).toContain("litellm-api-key");
    expect(ollamaGroup.options.map((option) => option.value)).toContain("ollama");
  });

  it("prefers Anthropic Claude CLI over API key in grouped selection", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "anthropic",
        providerId: "anthropic",
        methodId: "api-key",
        choiceId: "apiKey",
        choiceLabel: "Anthropic API key",
        groupId: "anthropic",
        groupLabel: "Anthropic",
      },
      {
        pluginId: "anthropic",
        providerId: "anthropic",
        methodId: "cli",
        choiceId: "anthropic-cli",
        choiceLabel: "Anthropic Claude CLI",
        assistantPriority: -20,
        groupId: "anthropic",
        groupLabel: "Anthropic",
      },
    ]);
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const anthropicGroup = requireChoiceGroup(groups, "anthropic");

    expect(anthropicGroup.options.map((option) => option.value)).toEqual([
      "anthropic-cli",
      "apiKey",
    ]);
  });

  it("orders OpenAI auth methods as api key, browser login, then device pairing", () => {
    resolveProviderWizardOptions.mockReturnValue([
      {
        value: "openai-api-key",
        label: "OpenAI API Key",
        groupId: "openai",
        groupLabel: "OpenAI",
        assistantPriority: -40,
      },
      {
        value: "openai-codex",
        label: "OpenAI Codex Browser Login",
        groupId: "openai",
        groupLabel: "OpenAI",
        assistantPriority: -30,
      },
      {
        value: "openai-codex-device-code",
        label: "OpenAI Codex Device Pairing",
        groupId: "openai",
        groupLabel: "OpenAI",
        assistantPriority: -10,
      },
    ]);

    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const openAIGroup = requireChoiceGroup(groups, "openai");

    expect(openAIGroup.options.map((option) => option.value)).toEqual([
      "openai-api-key",
      "openai-codex",
      "openai-codex-device-code",
    ]);
  });

  it("groups OpenCode Zen and Go under one OpenCode entry", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "opencode",
        providerId: "opencode",
        methodId: "api-key",
        choiceId: "opencode-zen",
        choiceLabel: "OpenCode Zen catalog",
        groupId: "opencode",
        groupLabel: "OpenCode",
      },
      {
        pluginId: "opencode-go",
        providerId: "opencode-go",
        methodId: "api-key",
        choiceId: "opencode-go",
        choiceLabel: "OpenCode Go catalog",
        groupId: "opencode",
        groupLabel: "OpenCode",
      },
    ]);
    const { groups } = buildAuthChoiceGroups({
      store: EMPTY_STORE,
      includeSkip: false,
    });
    const openCodeGroup = requireChoiceGroup(groups, "opencode");

    const openCodeValues = openCodeGroup.options.map((option) => option.value);
    expect(openCodeValues).toContain("opencode-zen");
    expect(openCodeValues).toContain("opencode-go");
  });

  it("hides image-generation-only providers from the interactive auth picker", () => {
    resolveManifestProviderAuthChoices.mockReturnValue([
      {
        pluginId: "fal",
        providerId: "fal",
        methodId: "api-key",
        choiceId: "fal-api-key",
        choiceLabel: "fal API key",
        groupId: "fal",
        groupLabel: "fal",
        onboardingScopes: ["image-generation"],
      },
      {
        pluginId: "openai",
        providerId: "openai",
        methodId: "api-key",
        choiceId: "openai-api-key",
        choiceLabel: "OpenAI API key",
        groupId: "openai",
        groupLabel: "OpenAI",
      },
    ]);
    resolveProviderWizardOptions.mockReturnValue([
      {
        value: "local-image-runtime",
        label: "Local image runtime",
        groupId: "local-image-runtime",
        groupLabel: "Local image runtime",
        onboardingScopes: ["image-generation"],
      },
      {
        value: "ollama",
        label: "Ollama",
        groupId: "ollama",
        groupLabel: "Ollama",
      },
    ]);

    const options = getOptions();
    const optionValues = options.map((option) => option.value);

    expect(optionValues).toContain("openai-api-key");
    expect(optionValues).toContain("ollama");
    expect(optionValues).not.toContain("fal-api-key");
    expect(optionValues).not.toContain("local-image-runtime");
  });
});
