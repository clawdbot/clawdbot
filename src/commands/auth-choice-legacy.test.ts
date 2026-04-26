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

describe("auth choice legacy aliases", () => {
  it("maps claude-cli to the new anthropic cli choice", () => {
    expect(normalizeLegacyOnboardAuthChoice("claude-cli")).toBe("anthropic-cli");
    expect(resolveDeprecatedAuthChoiceReplacement("claude-cli")).toEqual({
      normalized: "anthropic-cli",
      message: 'Auth choice "claude-cli" is deprecated; using Anthropic Claude CLI setup instead.',
    });
    expect(formatDeprecatedNonInteractiveAuthChoiceError("claude-cli")).toBe(
      'Auth choice "claude-cli" is deprecated.\nUse "--auth-choice anthropic-cli".',
    );
  });

  it("sources deprecated cli aliases from plugin manifests", () => {
    expect(resolveLegacyAuthChoiceAliasesForCli()).toEqual(["claude-cli", "codex-cli"]);
  });
});
