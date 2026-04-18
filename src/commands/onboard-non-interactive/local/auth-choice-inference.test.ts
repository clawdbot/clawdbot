import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OnboardOptions } from "../../onboard-types.js";
import { inferAuthChoiceFromFlags } from "./auth-choice-inference.js";

const resolveManifestProviderOnboardAuthFlags = vi.hoisted(() =>
  vi.fn<
    () => ReadonlyArray<{
      optionKey: string;
      authChoice: string;
      cliFlag: string;
    }>
  >(() => []),
);

vi.mock("../../../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderOnboardAuthFlags,
}));

describe("inferAuthChoiceFromFlags", () => {
  beforeEach(() => {
    resolveManifestProviderOnboardAuthFlags.mockReset();
    resolveManifestProviderOnboardAuthFlags.mockReturnValue([]);
  });

  it("infers plugin-owned auth choices from manifest option keys", () => {
    resolveManifestProviderOnboardAuthFlags.mockReturnValue([
      {
        optionKey: "pluginOwnedApiKey",
        authChoice: "plugin-api-key",
        cliFlag: "--plugin-api-key",
      },
    ]);

    const opts: OnboardOptions = {
      pluginOwnedApiKey: "sk-plugin-test",
    };

    expect(inferAuthChoiceFromFlags(opts)).toEqual({
      choice: "plugin-api-key",
      matches: [
        {
          optionKey: "pluginOwnedApiKey",
          authChoice: "plugin-api-key",
          label: "--plugin-api-key",
        },
      ],
    });
  });

  it("infers the built-in custom provider from custom flags", () => {
    const opts: OnboardOptions = {
      customBaseUrl: "https://models.custom.local/v1",
      customModelId: "local-large",
      customApiKey: "custom-test-key", // pragma: allowlist secret
    };

    expect(inferAuthChoiceFromFlags(opts)).toEqual({
      choice: "custom-api-key",
      matches: [
        {
          optionKey: "customBaseUrl",
          authChoice: "custom-api-key",
          label: "--custom-base-url/--custom-model-id/--custom-api-key",
        },
      ],
    });
  });
});
