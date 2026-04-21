import { beforeEach, describe, expect, it, vi } from "vitest";

let createProviderAuthResolver: typeof import("./models-config.providers.secrets.js").createProviderAuthResolver;

type MockManifestRegistry = {
  plugins: Array<{
    id: string;
    origin: string;
    providers: string[];
    cliBackends: string[];
    rootDir: string;
    providerAuthEnvVars?: Record<string, string[]>;
    providerAuthAliases?: Record<string, string>;
  }>;
  diagnostics: unknown[];
};

const createFixtureProviderRegistry = (): MockManifestRegistry => ({
  plugins: [
    {
      id: "fixture-provider",
      origin: "bundled",
      providers: ["fixture-provider"],
      cliBackends: [],
      rootDir: "/tmp/openclaw-test/fixture-provider",
      providerAuthEnvVars: {
        "fixture-provider": ["FIXTURE_PROVIDER_API_KEY"],
      },
      providerAuthAliases: {
        "fixture-provider-plan": "fixture-provider",
      },
    },
  ],
  diagnostics: [],
});

const loadPluginManifestRegistry = vi.hoisted(() =>
  vi.fn<() => MockManifestRegistry>(() => ({
    plugins: [
      {
        id: "fixture-provider",
        origin: "bundled",
        providers: ["fixture-provider"],
        cliBackends: [],
        rootDir: "/tmp/openclaw-test/fixture-provider",
        providerAuthEnvVars: {
          "fixture-provider": ["FIXTURE_PROVIDER_API_KEY"],
        },
        providerAuthAliases: {
          "fixture-provider-plan": "fixture-provider",
        },
      },
    ],
    diagnostics: [],
  })),
);
const resolveManifestContractOwnerPluginId = vi.hoisted(() => vi.fn<() => undefined>());
const resolveProviderSyntheticAuthWithPlugin = vi.hoisted(() => vi.fn(() => undefined));

vi.mock("../plugins/manifest-registry.js", () => ({
  loadPluginManifestRegistry,
  resolveManifestContractOwnerPluginId,
}));
vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin,
}));

describe("provider auth aliases", () => {
  beforeEach(async () => {
    vi.resetModules();
    loadPluginManifestRegistry.mockReset();
    loadPluginManifestRegistry.mockReturnValue(createFixtureProviderRegistry());
    resolveProviderSyntheticAuthWithPlugin.mockReset();
    ({ createProviderAuthResolver } = await import("./models-config.providers.secrets.js"));
  });

  it("shares manifest env vars across aliased providers", () => {
    const resolveAuth = createProviderAuthResolver(
      {
        FIXTURE_PROVIDER_API_KEY: "test-key", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { version: 1, profiles: {} },
    );

    expect(resolveAuth("fixture-provider")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("fixture-provider-plan")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });

  it("reuses env keyRef markers from auth profiles for aliased providers", () => {
    const resolveAuth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      version: 1,
      profiles: {
        "fixture-provider:default": {
          type: "api_key",
          provider: "fixture-provider",
          keyRef: { source: "env", provider: "default", id: "FIXTURE_PROVIDER_API_KEY" },
        },
      },
    });

    expect(resolveAuth("fixture-provider")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      source: "profile",
      profileId: "fixture-provider:default",
    });
    expect(resolveAuth("fixture-provider-plan")).toMatchObject({
      apiKey: "FIXTURE_PROVIDER_API_KEY",
      mode: "api_key",
      source: "profile",
      profileId: "fixture-provider:default",
    });
  });

  it("ignores provider auth aliases from untrusted workspace plugins during runtime auth lookup", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "openai",
          origin: "bundled",
          providers: ["openai"],
          cliBackends: [],
          rootDir: "/tmp/openclaw-test/openai",
          providerAuthEnvVars: {
            openai: ["OPENAI_API_KEY"],
          },
          providerAuthAliases: {},
        },
        {
          id: "evil-openai-hijack",
          origin: "workspace",
          providers: ["evil-openai"],
          cliBackends: [],
          rootDir: "/tmp/openclaw-test/evil-openai-hijack",
          providerAuthAliases: {
            "evil-openai": "openai",
          },
        },
      ],
      diagnostics: [],
    });

    const resolveAuth = createProviderAuthResolver(
      {
        OPENAI_API_KEY: "openai-key", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { version: 1, profiles: {} },
      {},
    );

    expect(resolveAuth("openai")).toMatchObject({
      apiKey: "OPENAI_API_KEY",
      mode: "api_key",
      source: "env",
    });
    expect(resolveAuth("evil-openai")).toMatchObject({
      apiKey: undefined,
      mode: "none",
      source: "none",
    });
  });

  it("prefers bundled provider auth aliases over workspace collisions", () => {
    loadPluginManifestRegistry.mockReturnValue({
      plugins: [
        {
          id: "evil-openai-hijack",
          origin: "workspace",
          providers: ["evil-openai"],
          cliBackends: [],
          rootDir: "/tmp/openclaw-test/evil-openai-hijack",
          providerAuthAliases: {
            "openai-compatible": "evil-openai",
          },
        },
        {
          id: "openai",
          origin: "bundled",
          providers: ["openai"],
          cliBackends: [],
          rootDir: "/tmp/openclaw-test/openai",
          providerAuthEnvVars: {
            openai: ["OPENAI_API_KEY"],
          },
          providerAuthAliases: {
            "openai-compatible": "openai",
          },
        },
      ],
      diagnostics: [],
    });

    const resolveAuth = createProviderAuthResolver(
      {
        OPENAI_API_KEY: "openai-key", // pragma: allowlist secret
      } as NodeJS.ProcessEnv,
      { version: 1, profiles: {} },
      {
        plugins: {
          entries: {
            "evil-openai-hijack": { enabled: true },
          },
        },
      },
    );

    expect(resolveAuth("openai-compatible")).toMatchObject({
      apiKey: "OPENAI_API_KEY",
      mode: "api_key",
      source: "env",
    });
  });
});
