// API-provider auth-choice tests cover built-in provider config, API keys, and provider plugin setup.
import { afterEach, describe, expect, it, vi } from "vitest";
import * as providerAuthChoices from "../plugins/provider-auth-choices.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { normalizeApiKeyTokenProviderAuthChoice } from "./auth-choice.apply.api-providers.js";
import { prepareAuthChoice } from "./auth-choice.apply.js";

const resolvePluginProviders = vi.hoisted(() =>
  vi.fn<typeof import("../plugins/provider-auth-choice.runtime.js").resolvePluginProviders>(),
);
const resolvePluginSetupProvider = vi.hoisted(() => vi.fn(() => undefined));
const prepareAuthChoiceLoadedPluginProvider = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/provider-auth-choice.js").prepareAuthChoiceLoadedPluginProvider
  >(),
);
const resolveDeprecatedProviderInstallCatalogEntry = vi.hoisted(() =>
  vi.fn<
    typeof import("../plugins/provider-install-catalog.js").resolveDeprecatedProviderInstallCatalogEntry
  >(),
);

vi.mock("../plugins/provider-auth-choice.runtime.js", () => ({
  resolvePluginProviders,
  resolvePluginSetupProvider,
}));
vi.mock("../plugins/provider-auth-choice.js", () => ({
  prepareAuthChoiceLoadedPluginProvider,
}));
vi.mock("../plugins/provider-install-catalog.js", () => ({
  resolveDeprecatedProviderInstallCatalogEntry,
}));

function createProvider(params: {
  id: string;
  aliases?: string[];
  auth: Array<{
    id: string;
    kind: ProviderPlugin["auth"][number]["kind"];
    choiceId?: string;
  }>;
}): ProviderPlugin {
  return {
    id: params.id,
    label: params.id,
    ...(params.aliases ? { aliases: params.aliases } : {}),
    auth: params.auth.map((method) => ({
      id: method.id,
      label: method.id,
      kind: method.kind,
      ...(method.choiceId ? { wizard: { choiceId: method.choiceId } } : {}),
      run: vi.fn(async () => ({ profiles: [] })),
    })),
  };
}

describe("normalizeApiKeyTokenProviderAuthChoice", () => {
  afterEach(() => {
    resolvePluginProviders.mockReset();
    prepareAuthChoiceLoadedPluginProvider.mockReset();
    resolveDeprecatedProviderInstallCatalogEntry.mockReset();
    vi.restoreAllMocks();
  });

  it("maps token provider auth through plugin token methods", () => {
    resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "anthropic",
        auth: [{ id: "setup-token", kind: "token", choiceId: "setup-token" }],
      }),
    ]);

    expect(
      normalizeApiKeyTokenProviderAuthChoice({
        authChoice: "token",
        tokenProvider: " anthropic ",
      }),
    ).toBe("setup-token");
  });

  it("maps apiKey provider auth through plugin api key methods and aliases", () => {
    resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "google",
        aliases: ["gemini"],
        auth: [{ id: "api-key", kind: "api_key", choiceId: "gemini-api-key" }],
      }),
    ]);

    expect(
      normalizeApiKeyTokenProviderAuthChoice({
        authChoice: "apiKey",
        tokenProvider: " GeMiNi ",
      }),
    ).toBe("gemini-api-key");
  });

  it("leaves the auth choice unchanged when no matching provider method exists", () => {
    resolvePluginProviders.mockReturnValue([
      createProvider({
        id: "openai",
        auth: [{ id: "api-key", kind: "api_key", choiceId: "openai-api-key" }],
      }),
    ]);

    expect(
      normalizeApiKeyTokenProviderAuthChoice({
        authChoice: "token",
        tokenProvider: "openai",
      }),
    ).toBe("token");
  });

  it.each([
    { authChoice: "apiKey", kind: "api_key" },
    { authChoice: "token", kind: "token" },
    { authChoice: "setup-token", kind: "token" },
  ] as const)(
    "resolves workspace-only $authChoice providers through interactive setup",
    async (choice) => {
      const workspaceDir = "/tmp/selected-agent-workspace";
      const provider = createProvider({
        id: "workspace-provider",
        auth: [{ id: "workspace-auth", kind: choice.kind, choiceId: "workspace-provider-auth" }],
      });
      resolvePluginProviders.mockImplementation((params) =>
        params?.workspaceDir === workspaceDir ? [provider] : [],
      );
      prepareAuthChoiceLoadedPluginProvider.mockImplementation(async (params) =>
        params.authChoice === "workspace-provider-auth"
          ? {
              config: params.config,
              authProfiles: [
                {
                  profileId: "workspace-provider:default",
                  credential: {
                    type: "api_key",
                    provider: "workspace-provider",
                    key: "fixture-workspace-key",
                  },
                },
              ],
              persistAuthProfiles: async () => {},
            }
          : null,
      );

      const prepared = await prepareAuthChoice({
        authChoice: choice.authChoice,
        config: {},
        workspaceDir,
        prompter: {} as never,
        runtime: {} as never,
        setDefaultModel: false,
        opts: { tokenProvider: provider.id },
      });

      expect(prepared.authProfiles).toEqual([
        {
          profileId: "workspace-provider:default",
          credential: {
            type: "api_key",
            provider: "workspace-provider",
            key: "fixture-workspace-key",
          },
        },
      ]);
    },
  );

  it.each(["manifest", "install catalog"] as const)(
    "resolves workspace-only deprecated auth choices from the %s",
    async (source) => {
      const workspaceDir = "/tmp/selected-agent-workspace";
      vi.spyOn(
        providerAuthChoices,
        "resolveManifestDeprecatedProviderAuthChoice",
      ).mockImplementation((_choice, params) =>
        source === "manifest" && params?.workspaceDir === workspaceDir
          ? ({ choiceId: "workspace-modern-auth" } as never)
          : undefined,
      );
      resolveDeprecatedProviderInstallCatalogEntry.mockImplementation((_choice, params) =>
        source === "install catalog" &&
        params?.workspaceDir === workspaceDir &&
        params.includeUntrustedWorkspacePlugins === false
          ? ({ choiceId: "workspace-modern-auth" } as never)
          : undefined,
      );

      await expect(
        prepareAuthChoice({
          authChoice: "workspace-legacy-auth",
          config: {},
          workspaceDir,
          prompter: {} as never,
          runtime: {} as never,
          setDefaultModel: false,
        }),
      ).rejects.toThrow('Use "workspace-modern-auth" instead');
    },
  );
});
