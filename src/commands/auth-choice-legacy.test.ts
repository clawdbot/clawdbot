// Legacy auth-choice tests cover deprecated choice detection and replacement messages.
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
    providerId: "openai",
    methodId: "oauth",
    choiceId: "openai",
    choiceLabel: "ChatGPT Login",
  },
]);

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoices: () => manifestAuthChoices,
  resolveManifestDeprecatedProviderAuthChoice: (choiceId: string) =>
    manifestAuthChoices.find((choice) => choice.deprecatedChoiceIds?.includes(choiceId) === true),
}));

import { resolveLegacyOnboardAuthChoice } from "./auth-choice-legacy.js";

function authChoiceManifestEnv(): NodeJS.ProcessEnv {
  return {
    OPENCLAW_BUNDLED_PLUGINS_DIR: "extensions",
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
    VITEST: "1",
  } as NodeJS.ProcessEnv;
}

describe("auth choice legacy aliases", () => {
  it("maps claude-cli to the new anthropic cli choice", () => {
    expect(resolveLegacyOnboardAuthChoice("claude-cli", { env: authChoiceManifestEnv() })).toEqual({
      authChoice: "anthropic-cli",
      deprecated: {
        message:
          'Auth choice "claude-cli" is deprecated; using Anthropic Claude CLI setup instead.',
        nonInteractiveError:
          'Auth choice "claude-cli" is deprecated.\nUse "--auth-choice anthropic-cli".',
      },
    });
  });

  it("does not keep retired Codex setup choices alive outside doctor", () => {
    const result = resolveLegacyOnboardAuthChoice("codex-cli", { env: authChoiceManifestEnv() });
    expect(result.authChoice).toBe("codex-cli");
    expect(result.deprecated).toBeUndefined();
  });
});
