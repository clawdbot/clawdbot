import { describe, expect, it, vi } from "vitest";

const manifestAuthChoices = vi.hoisted(() => [
  {
    pluginId: "anthropic",
    providerId: "anthropic",
    methodId: "cli",
    choiceId: "anthropic-cli",
    choiceLabel: "Anthropic Claude CLI",
    deprecatedChoiceIds: ["claude-cli"],
  },
  {
    pluginId: "openai",
    providerId: "openai-codex",
    methodId: "cli",
    choiceId: "openai-codex-cli",
    choiceLabel: "OpenAI Codex CLI",
    deprecatedChoiceIds: ["codex-cli"],
  },
]);

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices: () => manifestAuthChoices,
  resolveManifestDeprecatedProviderAuthChoice: (choiceId: string) =>
    manifestAuthChoices.find((choice) => choice.deprecatedChoiceIds.includes(choiceId)),
}));

import {
  resolveLegacyAuthChoiceAliasesForCli,
  formatDeprecatedNonInteractiveAuthChoiceError,
  normalizeLegacyOnboardAuthChoice,
  resolveDeprecatedAuthChoiceReplacement,
} from "./auth-choice-legacy.js";

function authChoiceManifestEnv(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    OPENCLAW_DISABLE_PERSISTED_PLUGIN_REGISTRY: "1",
    OPENCLAW_DISABLE_PLUGIN_DISCOVERY_CACHE: "1",
    OPENCLAW_DISABLE_PLUGIN_MANIFEST_CACHE: "1",
    VITEST: "1",
  } as NodeJS.ProcessEnv;
}

describe("auth choice legacy aliases", () => {
  it("maps claude-cli to the new anthropic cli choice", () => {
    const env = authChoiceManifestEnv();
    expect(normalizeLegacyOnboardAuthChoice("claude-cli", { env })).toBe("anthropic-cli");
    expect(resolveDeprecatedAuthChoiceReplacement("claude-cli", { env })).toEqual({
      normalized: "anthropic-cli",
      message: 'Auth choice "claude-cli" is deprecated; using Anthropic Claude CLI setup instead.',
    });
    expect(formatDeprecatedNonInteractiveAuthChoiceError("claude-cli", { env })).toBe(
      'Auth choice "claude-cli" is deprecated.\nUse "--auth-choice anthropic-cli".',
    );
  });

  it("sources deprecated cli aliases from plugin manifests", () => {
    expect(resolveLegacyAuthChoiceAliasesForCli({ env: authChoiceManifestEnv() })).toEqual([
      "claude-cli",
      "codex-cli",
    ]);
  });
});
