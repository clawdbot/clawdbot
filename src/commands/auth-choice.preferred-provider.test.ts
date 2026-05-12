import { beforeEach, describe, expect, it, vi } from "vitest";
import type { resolvePluginProviders as resolvePluginProvidersFn } from "../plugins/providers.runtime.js";

type ResolvePluginProvidersOptions = Parameters<typeof resolvePluginProvidersFn>[0];

const resolveManifestProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestDeprecatedProviderAuthChoice = vi.hoisted(() => vi.fn());
const resolveManifestProviderAuthChoices = vi.hoisted(() => vi.fn(() => []));
const resolveProviderPluginChoice = vi.hoisted(() => vi.fn());
const resolvePluginProviders = vi.hoisted(() => vi.fn(() => []));

vi.mock("../plugins/provider-auth-choices.js", () => ({
  resolveManifestProviderAuthChoice,
  resolveManifestDeprecatedProviderAuthChoice,
  resolveManifestProviderAuthChoices,
}));

vi.mock("../plugins/provider-wizard.js", () => ({
  resolveProviderPluginChoice,
}));

vi.mock("../plugins/providers.runtime.js", () => ({
  resolvePluginProviders,
}));

import { resolvePreferredProviderForAuthChoice } from "./auth-choice.preferred-provider.js";

describe("resolvePreferredProviderForAuthChoice", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveManifestProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue(undefined);
    resolveManifestProviderAuthChoices.mockReturnValue([]);
    resolvePluginProviders.mockReturnValue([]);
    resolveProviderPluginChoice.mockReturnValue(null);
  });

  it("prefers manifest metadata when available", async () => {
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "openai",
      providerId: "openai",
      methodId: "api-key",
      choiceId: "openai-api-key",
      choiceLabel: "OpenAI API key",
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "openai-api-key" })).resolves.toBe(
      "openai",
    );
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });

  it("normalizes legacy auth choices before plugin lookup", async () => {
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      choiceId: "anthropic-cli",
      choiceLabel: "Anthropic Claude CLI",
    });
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "anthropic",
      providerId: "anthropic",
      methodId: "cli",
      choiceId: "anthropic-cli",
      choiceLabel: "Anthropic Claude CLI",
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "claude-cli" })).resolves.toBe(
      "anthropic",
    );
    expect(resolveProviderPluginChoice).not.toHaveBeenCalled();
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });

  it("passes explicit env through legacy auth normalization", async () => {
    const env = { OPENCLAW_AUTH_CHOICE_TEST: "1" } as NodeJS.ProcessEnv;
    resolveManifestDeprecatedProviderAuthChoice.mockReturnValue({
      choiceId: "anthropic-cli",
      choiceLabel: "Anthropic Claude CLI",
    });
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "anthropic",
      providerId: "anthropic",
      methodId: "cli",
      choiceId: "anthropic-cli",
      choiceLabel: "Anthropic Claude CLI",
    });

    await expect(
      resolvePreferredProviderForAuthChoice({ choice: "claude-cli", env }),
    ).resolves.toBe("anthropic");
    expect(resolveManifestDeprecatedProviderAuthChoice).toHaveBeenCalledWith("claude-cli", { env });
  });

  it("uses manifest metadata for plugin-owned choices", async () => {
    resolveManifestProviderAuthChoice.mockReturnValue({
      pluginId: "chutes",
      providerId: "chutes",
      methodId: "oauth",
      choiceId: "chutes",
      choiceLabel: "Chutes OAuth",
    });

    await expect(resolvePreferredProviderForAuthChoice({ choice: "chutes" })).resolves.toBe(
      "chutes",
    );
    expect(resolvePluginProviders).not.toHaveBeenCalled();
  });

  it("passes untrusted-workspace filtering through setup-provider fallback lookup", async () => {
    resolvePluginProviders.mockReturnValue([
      {
        id: "demo-provider",
        label: "Demo Provider",
        auth: [{ id: "api-key", label: "API key", kind: "api_key" }],
      },
    ] as never);
    resolveProviderPluginChoice.mockReturnValue({
      provider: { id: "demo-provider" },
      method: { id: "api-key" },
    });

    await expect(
      resolvePreferredProviderForAuthChoice({
        choice: "demo-provider",
        includeUntrustedWorkspacePlugins: false,
      }),
    ).resolves.toBe("demo-provider");
    expect(resolvePluginProviders).toHaveBeenCalledOnce();
    const [pluginProviderOptions] = resolvePluginProviders.mock.calls.at(0) as unknown as [
      ResolvePluginProvidersOptions,
    ];
    expect(pluginProviderOptions?.mode).toBe("setup");
    expect(pluginProviderOptions?.includeUntrustedWorkspacePlugins).toBe(false);
  });
});
