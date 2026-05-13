import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { captureEnv } from "../test-utils/env.js";

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: vi.fn(),
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) => provider.trim().toLowerCase(),
}));

type ProviderRuntimeModule = typeof import("../plugins/provider-runtime.js");

let NON_ENV_SECRETREF_MARKER: typeof import("./model-auth-markers.js").NON_ENV_SECRETREF_MARKER;
let MINIMAX_OAUTH_MARKER: typeof import("./model-auth-markers.js").MINIMAX_OAUTH_MARKER;
let CUSTOM_LOCAL_AUTH_MARKER: typeof import("./model-auth-markers.js").CUSTOM_LOCAL_AUTH_MARKER;
let resolveApiKeyFromCredential: typeof import("./models-config.providers.secrets.js").resolveApiKeyFromCredential;
let createProviderApiKeyResolver: typeof import("./models-config.providers.secrets.js").createProviderApiKeyResolver;
let createProviderAuthResolver: typeof import("./models-config.providers.secrets.js").createProviderAuthResolver;
let mockedResolveProviderSyntheticAuthWithPlugin: ReturnType<
  typeof vi.mocked<ProviderRuntimeModule["resolveProviderSyntheticAuthWithPlugin"]>
>;

async function loadProviderAuthModules() {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  const [providerRuntimeModule, markersModule, secretsModule] = await Promise.all([
    import("../plugins/provider-runtime.js"),
    import("./model-auth-markers.js"),
    import("./models-config.providers.secrets.js"),
  ]);
  mockedResolveProviderSyntheticAuthWithPlugin = vi.mocked(
    providerRuntimeModule.resolveProviderSyntheticAuthWithPlugin,
  );
  CUSTOM_LOCAL_AUTH_MARKER = markersModule.CUSTOM_LOCAL_AUTH_MARKER;
  NON_ENV_SECRETREF_MARKER = markersModule.NON_ENV_SECRETREF_MARKER;
  MINIMAX_OAUTH_MARKER = markersModule.MINIMAX_OAUTH_MARKER;
  resolveApiKeyFromCredential = secretsModule.resolveApiKeyFromCredential;
  createProviderApiKeyResolver = secretsModule.createProviderApiKeyResolver;
  createProviderAuthResolver = secretsModule.createProviderAuthResolver;
}

beforeEach(() => {
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
  mockedResolveProviderSyntheticAuthWithPlugin.mockReset().mockReturnValue(undefined);
});

beforeAll(loadProviderAuthModules);

function buildPairedApiKeyProviders(apiKey: string) {
  return {
    provider: { apiKey },
    paired: { apiKey },
  };
}

describe("models-config provider auth provenance", () => {
  it("persists env keyRef and tokenRef auth profiles as env var markers", () => {
    const envSnapshot = captureEnv(["VOLCANO_ENGINE_API_KEY", "TOGETHER_API_KEY"]);
    delete process.env.VOLCANO_ENGINE_API_KEY;
    delete process.env.TOGETHER_API_KEY;
    try {
      const volcengineApiKey = resolveApiKeyFromCredential({
        type: "api_key",
        provider: "volcengine",
        keyRef: { source: "env", provider: "default", id: "VOLCANO_ENGINE_API_KEY" },
      })?.apiKey;
      const togetherApiKey = resolveApiKeyFromCredential({
        type: "token",
        provider: "together",
        tokenRef: { source: "env", provider: "default", id: "TOGETHER_API_KEY" },
      })?.apiKey;
      const volcengineProviders = buildPairedApiKeyProviders(volcengineApiKey ?? "");

      expect(volcengineProviders.provider.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(volcengineProviders.paired.apiKey).toBe("VOLCANO_ENGINE_API_KEY");
      expect(togetherApiKey).toBe("TOGETHER_API_KEY");
    } finally {
      envSnapshot.restore();
    }
  });

  it("uses non-env marker for ref-managed profiles even when runtime plaintext is present", () => {
    const byteplusApiKey = resolveApiKeyFromCredential({
      type: "api_key",
      provider: "byteplus",
      key: "sk-runtime-resolved-byteplus",
      keyRef: { source: "file", provider: "vault", id: "/byteplus/apiKey" },
    })?.apiKey;
    const togetherApiKey = resolveApiKeyFromCredential({
      type: "token",
      provider: "together",
      token: "tok-runtime-resolved-together",
      tokenRef: { source: "exec", provider: "vault", id: "providers/together/token" },
    })?.apiKey;
    const byteplusProviders = buildPairedApiKeyProviders(byteplusApiKey ?? "");

    expect(byteplusProviders.provider.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(byteplusProviders.paired.apiKey).toBe(NON_ENV_SECRETREF_MARKER);
    expect(togetherApiKey).toBe(NON_ENV_SECRETREF_MARKER);
  });

  it("keeps oauth compatibility markers for minimax-portal", () => {
    const providers = {
      "minimax-portal": {
        apiKey: MINIMAX_OAUTH_MARKER,
      },
    };
    expect(providers["minimax-portal"]?.apiKey).toBe(MINIMAX_OAUTH_MARKER);
  });

  it("prefers profile auth over env auth in provider summaries to match runtime resolution", () => {
    const auth = createProviderAuthResolver(
      {
        OPENAI_API_KEY: "env-openai-key",
      } as NodeJS.ProcessEnv,
      {
        version: 1,
        profiles: {
          "openai:default": {
            type: "api_key",
            provider: "openai",
            keyRef: { source: "env", provider: "default", id: "OPENAI_PROFILE_KEY" },
          },
        },
      },
    );

    expect(auth("openai")).toEqual({
      apiKey: "OPENAI_PROFILE_KEY",
      discoveryApiKey: undefined,
      mode: "api_key",
      source: "profile",
      profileId: "openai:default",
    });
  });

  it("resolves plugin-owned synthetic auth through the provider hook", () => {
    mockedResolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: "xai-plugin-key",
      mode: "api-key",
      source: "test plugin",
    });
    const auth = createProviderAuthResolver(
      {} as NodeJS.ProcessEnv,
      {
        version: 1,
        profiles: {},
      },
      {
        plugins: {
          entries: {
            xai: {
              config: {
                webSearch: {
                  apiKey: "xai-plugin-key",
                },
              },
            },
          },
        },
      },
    );

    expect(auth("xai")).toEqual({
      apiKey: NON_ENV_SECRETREF_MARKER,
      discoveryApiKey: "xai-plugin-key",
      mode: "api_key",
      source: "none",
    });
  });

  it("uses literal configured provider api keys for catalog discovery", () => {
    const auth = createProviderApiKeyResolver(
      {} as NodeJS.ProcessEnv,
      {
        version: 1,
        profiles: {},
      },
      {
        models: {
          providers: {
            vllm: {
              baseUrl: "http://127.0.0.1:8000/v1",
              apiKey: "proof-key",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
    );

    expect(auth("vllm")).toEqual({
      apiKey: "proof-key",
      discoveryApiKey: "proof-key",
    });
  });

  it("resolves custom configured env markers for catalog discovery", () => {
    const auth = createProviderApiKeyResolver(
      {
        MY_VLLM_KEY: "resolved-vllm-key",
      } as NodeJS.ProcessEnv,
      {
        version: 1,
        profiles: {},
      },
      {
        models: {
          providers: {
            vllm: {
              baseUrl: "http://127.0.0.1:8000/v1",
              apiKey: "${MY_VLLM_KEY}",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
    );

    expect(auth("vllm")).toEqual({
      apiKey: "MY_VLLM_KEY",
      discoveryApiKey: "resolved-vllm-key",
    });
  });

  it("does not send missing custom env markers as catalog discovery keys", () => {
    const auth = createProviderApiKeyResolver(
      {} as NodeJS.ProcessEnv,
      {
        version: 1,
        profiles: {},
      },
      {
        models: {
          providers: {
            vllm: {
              baseUrl: "http://127.0.0.1:8000/v1",
              apiKey: "MY_VLLM_KEY",
              api: "openai-completions",
              models: [],
            },
          },
        },
      },
    );

    expect(auth("vllm")).toEqual({
      apiKey: undefined,
      discoveryApiKey: undefined,
    });
  });

  it("preserves shared non-secret synthetic auth markers from provider hooks", () => {
    mockedResolveProviderSyntheticAuthWithPlugin.mockReturnValue({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      mode: "api-key",
      source: "test plugin",
    });
    const auth = createProviderAuthResolver(
      {} as NodeJS.ProcessEnv,
      {
        version: 1,
        profiles: {},
      },
      {
        plugins: {
          entries: {
            lmstudio: {
              config: {
                models: [{ id: "qwen/qwen3.5-9b" }],
              },
            },
          },
        },
      },
    );

    expect(auth("lmstudio")).toEqual({
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      discoveryApiKey: undefined,
      mode: "api_key",
      source: "none",
    });
  });
});
