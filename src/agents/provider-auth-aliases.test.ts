import { describe, expect, it, vi } from "vitest";

const loadPluginManifestRegistry = vi.hoisted(() => vi.fn());

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
}));

import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

describe("provider auth aliases", () => {
  it("treats deprecated auth choice ids as provider auth aliases", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          providerAuthChoices: [
            {
              provider: "openai-codex",
              method: "oauth",
              choiceId: "openai-codex",
              deprecatedChoiceIds: ["codex-cli", "openai-codex-import"],
            },
          ],
        },
      ],
      diagnostics: [],
    });

    expect(resolveProviderIdForAuth("codex-cli")).toBe("openai-codex");
    expect(resolveProviderIdForAuth("openai-codex-import")).toBe("openai-codex");
    expect(resolveProviderIdForAuth("openai-codex")).toBe("openai-codex");
  });
});
