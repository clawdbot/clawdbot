import { describe, expect, it, vi } from "vitest";
import {
  planOpenClawModelsJson,
  planOpenClawModelsJsonWithDeps,
  type ResolveImplicitProvidersForModelsJson,
} from "./models-config.plan.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
import { createProviderAuthResolver } from "./models-config.providers.secrets.js";

vi.mock("./model-auth-env.js", () => ({
  resolveEnvApiKey: () => null,
}));

vi.mock("./provider-auth-aliases.js", () => ({
  resolveProviderAuthAliasMap: () => ({}),
  resolveProviderIdForAuth: (provider: string) => provider.trim().toLowerCase(),
}));

vi.mock("./model-auth-env-vars.js", () => ({
  PROVIDER_ENV_API_KEY_CANDIDATES: {},
  listKnownProviderEnvApiKeyNames: () => [],
  resolveProviderEnvApiKeyCandidates: () => ({}),
  resolveProviderEnvAuthEvidence: () => ({}),
}));

vi.mock("../plugins/provider-runtime.js", () => ({
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

vi.mock("./models-config.providers.js", () => ({
  applyNativeStreamingUsageCompat: (providers: unknown) => providers,
  enforceSourceManagedProviderSecrets: ({ providers }: { providers: unknown }) => providers,
  normalizeProviderCatalogModelsForConfig: (providers: unknown) => providers,
  normalizeProviders: ({ providers }: { providers: unknown }) => providers,
  resolveImplicitProviders: async ({
    explicitProviders,
  }: {
    explicitProviders?: Record<string, unknown>;
  }) => explicitProviders ?? {},
}));

describe("models-config", () => {
  it("uses the first github-copilot profile when env tokens are missing", () => {
    const auth = createProviderAuthResolver({} as NodeJS.ProcessEnv, {
      version: 1,
      profiles: {
        "github-copilot:alpha": {
          type: "token",
          provider: "github-copilot",
          token: "alpha-token",
        },
        "github-copilot:beta": {
          type: "token",
          provider: "github-copilot",
          token: "beta-token",
        },
      },
    });

    expect(auth("github-copilot")).toEqual({
      apiKey: "alpha-token",
      discoveryApiKey: "alpha-token",
      mode: "token",
      source: "profile",
      profileId: "github-copilot:alpha",
    });
  });

  it("does not override explicit github-copilot provider config", async () => {
    const plan = await planOpenClawModelsJson({
      cfg: {
        models: {
          providers: {
            "github-copilot": {
              baseUrl: "https://copilot.local",
              api: "openai-responses",
              models: [],
            },
          },
        },
      },
      agentDir: "/tmp/openclaw-agent",
      env: {} as NodeJS.ProcessEnv,
      existingRaw: "",
      existingParsed: null,
    });

    expect(plan.action).toBe("write");
    expect(
      plan.action === "write"
        ? (
            JSON.parse(plan.contents) as {
              providers?: Record<string, { baseUrl?: string }>;
            }
          ).providers?.["github-copilot"]?.baseUrl
        : undefined,
    ).toBe("https://copilot.local");
  });

  it("passes explicit provider config to implicit discovery so plugins can skip duplicates", async () => {
    const resolveImplicitProviders = vi.fn<ResolveImplicitProvidersForModelsJson>(
      async ({ explicitProviders }) => {
        expect(explicitProviders.vllm?.baseUrl).toBe("http://127.0.0.1:8000/v1");
        return {};
      },
    );

    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: {
          models: {
            providers: {
              vllm: {
                baseUrl: "http://127.0.0.1:8000/v1",
                api: "openai-completions",
                models: [],
              },
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        env: { VLLM_API_KEY: "test-vllm-key" } as NodeJS.ProcessEnv,
        existingRaw: "",
        existingParsed: null,
      },
      { resolveImplicitProviders },
    );

    expect(resolveImplicitProviders).toHaveBeenCalledOnce();
    expect(plan).toEqual({
      action: "write",
      contents: `${JSON.stringify(
        {
          providers: {
            vllm: {
              baseUrl: "http://127.0.0.1:8000/v1",
              api: "openai-completions",
              models: [],
            },
          },
        },
        null,
        2,
      )}\n`,
    });
  });

  it("keeps a non-empty existing models.json baseUrl when merge mode regenerates the provider", async () => {
    const kilocodeProvider = {
      baseUrl: "https://api.kilo.ai/api/gateway/v1",
      api: "openai-completions" as const,
      models: [],
    };
    const existingContents = `${JSON.stringify(
      {
        providers: {
          kilocode: {
            baseUrl: "https://api.kilo.ai/api/gateway",
            api: "openai-completions",
            models: [],
          },
        },
      },
      null,
      2,
    )}\n`;

    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: {
          models: {
            providers: {
              kilocode: kilocodeProvider,
            },
          },
        },
        sourceConfigForSecrets: {
          models: {
            providers: {
              kilocode: kilocodeProvider,
            },
          },
        },
        agentDir: "/tmp/openclaw-agent",
        env: {} as NodeJS.ProcessEnv,
        existingRaw: existingContents,
        existingParsed: JSON.parse(existingContents),
      },
      {
        resolveImplicitProviders: async () => ({}),
      },
    );

    expect(plan).toEqual({ action: "noop" });
  });

  it("uses tokenRef env var when github-copilot profile omits plaintext token", () => {
    const auth = createProviderAuthResolver(
      {
        COPILOT_REF_TOKEN: "token-from-ref-env",
      } as NodeJS.ProcessEnv,
      {
        version: 1,
        profiles: {
          "github-copilot:default": {
            type: "token",
            provider: "github-copilot",
            tokenRef: { source: "env", provider: "default", id: "COPILOT_REF_TOKEN" },
          },
        },
      },
    );

    expect(auth("github-copilot")).toEqual({
      apiKey: "COPILOT_REF_TOKEN",
      discoveryApiKey: "token-from-ref-env",
      mode: "token",
      source: "profile",
      profileId: "github-copilot:default",
    });
  });

  it("writes an implicit github-copilot provider discovered from a token exchange", async () => {
    const plan = await planCopilotWithImplicitProvider({
      provider: { baseUrl: "https://api.copilot.example", models: [] },
    });

    expect(expectCopilotProviderFromPlan(plan)).toEqual({
      baseUrl: "https://api.copilot.example",
      models: [],
    });
  });

  it("writes default github-copilot baseUrl when the token exchange fails", async () => {
    const plan = await planCopilotWithImplicitProvider({
      provider: { baseUrl: "https://api.individual.githubcopilot.com", models: [] },
    });

    expect(expectCopilotProviderFromPlan(plan)).toEqual({
      baseUrl: "https://api.individual.githubcopilot.com",
      models: [],
    });
  });
});

function createCopilotImplicitResolver(
  provider: ProviderConfig,
): ResolveImplicitProvidersForModelsJson {
  return async () => ({ "github-copilot": provider });
}

async function planCopilotWithImplicitProvider(params: { provider: ProviderConfig }) {
  return await planOpenClawModelsJsonWithDeps(
    {
      cfg: { models: { providers: {} } },
      agentDir: "/tmp/openclaw-agent",
      env: {} as NodeJS.ProcessEnv,
      existingRaw: "",
      existingParsed: null,
    },
    {
      resolveImplicitProviders: createCopilotImplicitResolver(params.provider),
    },
  );
}

function expectCopilotProviderFromPlan(
  plan: Awaited<ReturnType<typeof planCopilotWithImplicitProvider>>,
) {
  expect(plan.action).toBe("write");
  const parsed =
    plan.action === "write"
      ? (JSON.parse(plan.contents) as { providers?: Record<string, unknown> })
      : {};
  const provider = parsed.providers?.["github-copilot"];
  if (provider === null || typeof provider !== "object") {
    throw new Error("Expected GitHub Copilot provider config");
  }
  return provider;
}
