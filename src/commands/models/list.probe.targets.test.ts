// Model probe target tests cover selecting provider/model targets for probing.
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.js";
import type { OpenClawConfig } from "../../config/config.js";
import { withEnvAsync } from "../../test-utils/env.js";

let mockStore: AuthProfileStore;
let mockAgentStore: AuthProfileStore | undefined;
let mockAllowedProfiles: string[];
const loadModelCatalogMock = vi.fn<() => Promise<ModelCatalogEntry[]>>(async () => []);

const resolveAuthProfileOrderMock = vi.fn(() => mockAllowedProfiles);
const resolveAuthProfileEligibilityMock = vi.fn<
  () => { eligible: boolean; reasonCode: "invalid_expires" | "ok" }
>(() => ({
  eligible: false,
  reasonCode: "invalid_expires",
}));
const resolveSecretRefStringMock = vi.fn(async () => "resolved-secret");

vi.mock("../../agents/prepared-model-catalog.js", () => ({
  loadPreparedModelCatalog: loadModelCatalogMock,
}));
vi.mock("../../agents/model-auth.js", () => ({
  hasUsableCustomProviderApiKey: (cfg: OpenClawConfig, provider: string) => {
    const raw = cfg.models?.providers?.[provider]?.apiKey;
    return typeof raw === "string" && raw.trim().length > 0 && raw !== "ollama-local";
  },
  resolveEnvApiKey: (
    provider: string,
    _env?: NodeJS.ProcessEnv,
    options?: { workspaceDir?: string },
  ) => {
    if (provider === "workspace-cloud") {
      return options?.workspaceDir === "/tmp/workspace"
        ? {
            source: "workspace cloud credentials",
            apiKey: "workspace-cloud-local-credentials",
          }
        : null;
    }
    const keys =
      provider === "anthropic"
        ? ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"]
        : provider === "zai"
          ? ["ZAI_API_KEY", "Z_AI_API_KEY"]
          : [];
    const source = keys.find((key) => process.env[key]?.trim());
    return source
      ? {
          source: `env: ${source}`,
          ...Object.fromEntries([["apiKey", process.env[source]]]),
        }
      : null;
  },
  resolveProviderEntryApiKeyProfileReference: (params: {
    cfg: OpenClawConfig;
    provider: string;
    store: AuthProfileStore;
  }) => {
    const raw = params.cfg.models?.providers?.[params.provider]?.apiKey;
    if (typeof raw !== "string") {
      return { kind: "none" };
    }
    if (raw === "ANTHROPIC_API_KEY" || raw === "ollama-local") {
      return { kind: "marker" };
    }
    const profile = params.store.profiles[raw];
    return profile
      ? { kind: "profile", profileId: raw, profile, mode: profile.type }
      : { kind: "literal", apiKey: raw, source: "models.json" };
  },
  resolveProviderEntryApiKeyBinding: async () => ({ kind: "profile-unresolved" }),
  resolveUsableCustomProviderApiKey: (params: {
    cfg: OpenClawConfig;
    provider: string;
    env?: NodeJS.ProcessEnv;
  }) => {
    const raw = params.cfg.models?.providers?.[params.provider]?.apiKey;
    if (raw === "ollama-local") {
      return { apiKey: raw, source: "models.json (local marker)" };
    }
    if (raw !== "ANTHROPIC_API_KEY") {
      return null;
    }
    const value = params.env?.ANTHROPIC_API_KEY;
    return value
      ? { ...Object.fromEntries([["apiKey", value]]), source: "env: ANTHROPIC_API_KEY" }
      : null;
  },
}));
vi.mock("../../agents/provider-auth-aliases.js", () => ({
  resolveProviderIdForAuth: (provider: string) =>
    provider === "byteplus-plan" ? "byteplus" : provider,
}));
vi.mock("../../agents/model-selection.js", () => {
  const normalizeProviderId = (value: string) =>
    value.trim().toLowerCase() === "z.ai" || value.trim().toLowerCase() === "z-ai"
      ? "zai"
      : value.trim().toLowerCase();
  return {
    normalizeProviderId,
    findNormalizedProviderValue: (record: Record<string, unknown> | undefined, provider: string) =>
      Object.entries(record ?? {}).find(([key]) => normalizeProviderId(key) === provider)?.[1],
    parseModelRef: (raw: string, defaultProvider: string) => {
      const [provider, ...modelParts] = raw.includes("/") ? raw.split("/") : [defaultProvider, raw];
      const model = modelParts.join("/");
      return provider && model ? { provider: normalizeProviderId(provider), model } : null;
    },
  };
});
vi.mock("../../secrets/resolve.js", () => ({
  resolveSecretRefString: resolveSecretRefStringMock,
}));
vi.mock("../status-all/format.js", () => ({
  redactSecrets: (value: string) => value,
}));
vi.mock("./shared.js", () => ({
  DEFAULT_PROVIDER: "openai",
  formatMs: (ms: number) => `${ms}ms`,
}));

vi.mock("../../agents/auth-profiles.js", () => ({
  externalCliDiscoveryScoped: (params: Record<string, unknown> = {}) => ({
    mode: "scoped",
    ...params,
  }),
  ensureAuthProfileStore: (agentDir?: string) =>
    agentDir === "/tmp/coder-agent" && mockAgentStore ? mockAgentStore : mockStore,
  listProfilesForProvider: (store: AuthProfileStore, provider: string) =>
    Object.entries(store.profiles)
      .filter(
        ([, profile]) =>
          typeof profile.provider === "string" && profile.provider.toLowerCase() === provider,
      )
      .map(([profileId]) => profileId),
  resolveAuthProfileDisplayLabel: ({ profileId }: { profileId: string }) => profileId,
  resolveAuthProfileOrder: resolveAuthProfileOrderMock,
  resolveAuthProfileEligibility: resolveAuthProfileEligibilityMock,
}));

const { buildProbeTargets } = await import("./list.probe.js");

async function buildAnthropicProbePlan(order: string[]) {
  return buildProbeTargets({
    cfg: {
      auth: {
        order: {
          anthropic: order,
        },
      },
    } as OpenClawConfig,
    providers: ["anthropic"],
    modelCandidates: ["anthropic/claude-sonnet-4-6"],
    options: {
      timeoutMs: 5_000,
      concurrency: 1,
      maxTokens: 16,
    },
  });
}

function withClearedAnthropicEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withEnvAsync({ ANTHROPIC_API_KEY: undefined, ANTHROPIC_OAUTH_TOKEN: undefined }, fn);
}

function withClearedZaiEnv<T>(fn: () => Promise<T>): Promise<T> {
  return withEnvAsync({ ZAI_API_KEY: undefined, Z_AI_API_KEY: undefined }, fn);
}

async function buildAnthropicPlanFromModelsJsonApiKey(apiKey: string) {
  return await buildProbeTargets({
    cfg: {
      models: {
        providers: {
          anthropic: {
            baseUrl: "https://api.anthropic.com/v1",
            api: "anthropic-messages",
            apiKey,
            models: [],
          },
        },
      },
    } as OpenClawConfig,
    providers: ["anthropic"],
    modelCandidates: ["anthropic/claude-sonnet-4-6"],
    options: {
      timeoutMs: 5_000,
      concurrency: 1,
      maxTokens: 16,
    },
  });
}

function expectLegacyMissingCredentialsError(
  result: { reasonCode?: string; error?: string } | undefined,
  reasonCode: string,
) {
  expect(result?.reasonCode).toBe(reasonCode);
  expect(result?.error?.split("\n")[0]).toBe("Auth profile credentials are missing or expired.");
  expect(result?.error).toContain(`[${reasonCode}]`);
}

describe("buildProbeTargets reason codes", () => {
  beforeEach(() => {
    mockStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "ANTHROPIC_TOKEN" },
          expires: 0,
        },
      },
      order: {
        anthropic: ["anthropic:default"],
      },
    };
    mockAgentStore = undefined;
    mockAllowedProfiles = [];
    loadModelCatalogMock.mockReset();
    loadModelCatalogMock.mockResolvedValue([]);
    resolveAuthProfileOrderMock.mockClear();
    resolveAuthProfileEligibilityMock.mockClear();
    resolveSecretRefStringMock.mockReset();
    resolveSecretRefStringMock.mockResolvedValue("resolved-secret");
    resolveAuthProfileEligibilityMock.mockReturnValue({
      eligible: false,
      reasonCode: "invalid_expires",
    });
  });

  it("reports invalid_expires with a legacy-compatible first error line", async () => {
    const plan = await buildAnthropicProbePlan(["anthropic:default"]);

    expect(plan.targets).toStrictEqual([]);
    expect(plan.results).toStrictEqual([
      {
        error:
          "Auth profile credentials are missing or expired.\n↳ Auth reason [invalid_expires]: token expires must be a positive Unix ms timestamp.",
        label: "anthropic:default",
        mode: "token",
        model: "anthropic/claude-sonnet-4-6",
        profileId: "anthropic:default",
        provider: "anthropic",
        reasonCode: "invalid_expires",
        source: "profile",
        status: "unknown",
      },
    ]);
  });

  it("reports excluded_by_auth_order when profile id is not present in explicit order", async () => {
    mockStore.order = {
      anthropic: ["anthropic:work"],
    };
    const plan = await buildAnthropicProbePlan(["anthropic:work"]);

    expect(plan.targets).toStrictEqual([]);
    expect(plan.results).toStrictEqual([
      {
        error: "Excluded by auth.order for this provider.",
        label: "anthropic:default",
        mode: "token",
        model: "anthropic/claude-sonnet-4-6",
        profileId: "anthropic:default",
        provider: "anthropic",
        reasonCode: "excluded_by_auth_order",
        source: "profile",
        status: "unknown",
      },
    ]);
  });

  it("reports unresolved_ref when a ref-only profile cannot resolve its SecretRef", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "token",
          provider: "anthropic",
          tokenRef: { source: "env", provider: "default", id: "MISSING_ANTHROPIC_TOKEN" },
        },
      },
      order: {
        anthropic: ["anthropic:default"],
      },
    };
    mockAllowedProfiles = ["anthropic:default"];
    resolveSecretRefStringMock.mockRejectedValueOnce(new Error("missing secret"));

    const plan = await buildAnthropicProbePlan(["anthropic:default"]);

    expect(plan.targets).toHaveLength(0);
    expect(plan.results).toHaveLength(1);
    expectLegacyMissingCredentialsError(plan.results[0], "unresolved_ref");
    expect(plan.results[0]?.error).toContain("env:default:MISSING_ANTHROPIC_TOKEN");
  });

  it("skips marker-only models.json credentials when building probe targets", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    await withClearedAnthropicEnv(async () => {
      const plan = await buildAnthropicPlanFromModelsJsonApiKey("ollama-local");
      expect(plan.targets).toStrictEqual([]);
      expect(plan.results).toStrictEqual([]);
    });
  });

  it("does not treat arbitrary all-caps models.json apiKey values as markers", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    await withClearedAnthropicEnv(async () => {
      const plan = await buildAnthropicPlanFromModelsJsonApiKey("ALLCAPS_SAMPLE");
      expect(plan.results).toStrictEqual([]);
      expect(plan.targets).toStrictEqual([
        {
          label: "models.json",
          mode: "api_key",
          model: { provider: "anthropic", model: "claude-sonnet-4-6" },
          provider: "anthropic",
          source: "models.json",
        },
      ]);
    });
  });

  it("adds a forced config-key target alongside stored profiles when requested", async () => {
    mockAllowedProfiles = ["anthropic:default"];
    const plan = await buildProbeTargets({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com/v1",
              api: "anthropic-messages",
              apiKey: "test",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      providers: ["anthropic"],
      modelCandidates: ["anthropic/claude-sonnet-4-6"],
      options: {
        includeDirectKeys: true,
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.results).toEqual([
      expect.objectContaining({
        profileId: "anthropic:default",
        reasonCode: "invalid_expires",
        source: "profile",
      }),
    ]);
    expect(plan.targets).toEqual([
      expect.objectContaining({
        label: "config",
        source: "models.json",
        boundValue: "test",
      }),
    ]);
  });

  it("emits a no_model result for a resolved config credential with no probe model", async () => {
    mockStore = { version: 1, profiles: {}, order: {} };
    const plan = await buildProbeTargets({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com/v1",
              api: "anthropic-messages",
              apiKey: "test",
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      providers: ["anthropic"],
      modelCandidates: [],
      options: {
        includeDirectKeys: true,
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.targets).toEqual([]);
    expect(plan.results).toContainEqual(
      expect.objectContaining({
        label: "config",
        source: "models.json",
        status: "no_model",
        reasonCode: "no_model",
      }),
    );
  });

  it("resolves configured SecretRefs before binding a direct probe", async () => {
    mockStore = { version: 1, profiles: {}, order: {} };
    const plan = await buildProbeTargets({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com/v1",
              api: "anthropic-messages",
              apiKey: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      providers: ["anthropic"],
      modelCandidates: ["anthropic/claude-sonnet-4-6"],
      options: {
        includeDirectKeys: true,
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.targets).toContainEqual(
      expect.objectContaining({
        boundValue: "resolved-secret",
        label: "config",
        source: "models.json",
      }),
    );
  });

  it("deduplicates matching config and environment credentials", async () => {
    mockStore = { version: 1, profiles: {}, order: {} };
    resolveSecretRefStringMock.mockResolvedValueOnce("same-value");
    const plan = await withEnvAsync(
      Object.fromEntries([["ANTHROPIC_API_KEY", "same-value"]]),
      async () =>
        await buildProbeTargets({
          cfg: {
            models: {
              providers: {
                anthropic: {
                  baseUrl: "https://api.anthropic.com/v1",
                  api: "anthropic-messages",
                  apiKey: { source: "env", provider: "default", id: "ANTHROPIC_API_KEY" },
                  models: [],
                },
              },
            },
          } as OpenClawConfig,
          providers: ["anthropic"],
          modelCandidates: ["anthropic/claude-sonnet-4-6"],
          options: {
            includeDirectKeys: true,
            timeoutMs: 5_000,
            concurrency: 1,
            maxTokens: 16,
          },
        }),
    );

    expect(plan.targets).toEqual([
      expect.objectContaining({
        label: "config",
        source: "models.json",
        boundValue: "same-value",
      }),
    ]);
  });

  it("deduplicates persisted env-marker credentials", async () => {
    mockStore = { version: 1, profiles: {}, order: {} };
    const value = ["marker", "test"].join("-");
    const plan = await withEnvAsync(
      Object.fromEntries([["ANTHROPIC_API_KEY", value]]),
      async () =>
        await buildProbeTargets({
          cfg: {
            models: {
              providers: {
                anthropic: {
                  baseUrl: "https://api.anthropic.com/v1",
                  api: "anthropic-messages",
                  ...Object.fromEntries([["apiKey", "ANTHROPIC_API_KEY"]]),
                  models: [],
                },
              },
            },
          } as OpenClawConfig,
          providers: ["anthropic"],
          modelCandidates: ["anthropic/claude-sonnet-4-6"],
          options: {
            includeDirectKeys: true,
            timeoutMs: 5_000,
            concurrency: 1,
            maxTokens: 16,
          },
        }),
    );

    expect(plan.targets).toEqual([
      expect.objectContaining({
        boundValue: value,
        label: "config",
        source: "models.json",
        useRuntimeAuth: true,
      }),
    ]);
  });

  it("adds environment credentials alongside stored profiles", async () => {
    await withEnvAsync(
      Object.fromEntries([["ANTHROPIC_API_KEY", ["env", "test"].join("-")]]),
      async () => {
        mockAllowedProfiles = ["anthropic:default"];
        const plan = await buildProbeTargets({
          cfg: {} as OpenClawConfig,
          providers: ["anthropic"],
          modelCandidates: ["anthropic/claude-sonnet-4-6"],
          options: {
            includeDirectKeys: true,
            timeoutMs: 5_000,
            concurrency: 1,
            maxTokens: 16,
          },
        });

        expect(plan.targets).toContainEqual(
          expect.objectContaining({
            boundValue: ["env", "test"].join("-"),
            label: "env: ANTHROPIC_API_KEY",
            source: "env",
          }),
        );
      },
    );
  });

  it("does not turn a provider-entry profile reference into a direct key target", async () => {
    const ref = "anthropic:saved";
    mockStore = {
      version: 1,
      profiles: {
        [ref]: {
          type: "api_key",
          provider: "anthropic",
          key: "placeholder",
        },
      },
      order: {},
    };
    mockAllowedProfiles = [ref];
    resolveAuthProfileEligibilityMock.mockReturnValue({ eligible: true, reasonCode: "ok" });

    const plan = await buildProbeTargets({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com/v1",
              api: "anthropic-messages",
              ...Object.fromEntries([["apiKey", ref]]),
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      providers: ["anthropic"],
      modelCandidates: ["anthropic/claude-sonnet-4-6"],
      options: {
        includeDirectKeys: true,
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.results).toStrictEqual([]);
    expect(plan.targets).toStrictEqual([
      {
        provider: "anthropic",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        profileId: ref,
        label: ref,
        source: "profile",
        mode: "api_key",
      },
    ]);
  });

  it("probes a config-bound profile even when auth.order excludes it", async () => {
    const ref = "anthropic:saved";
    mockStore = {
      version: 1,
      profiles: {
        [ref]: { type: "api_key", provider: "anthropic", key: "placeholder" },
        "anthropic:other": { type: "api_key", provider: "anthropic", key: "placeholder" },
      },
      // Explicit order excludes the config-referenced profile; runtime still
      // binds it from the provider apiKey, so the probe must not report it
      // excluded_by_auth_order.
      order: { anthropic: ["anthropic:other"] },
    };
    mockAllowedProfiles = ["anthropic:other"];
    resolveAuthProfileEligibilityMock.mockReturnValue({ eligible: true, reasonCode: "ok" });

    const plan = await buildProbeTargets({
      cfg: {
        models: {
          providers: {
            anthropic: {
              baseUrl: "https://api.anthropic.com/v1",
              api: "anthropic-messages",
              ...Object.fromEntries([["apiKey", ref]]),
              models: [],
            },
          },
        },
      } as OpenClawConfig,
      providers: ["anthropic"],
      modelCandidates: ["anthropic/claude-sonnet-4-6"],
      options: {
        includeDirectKeys: true,
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.results).not.toContainEqual(
      expect.objectContaining({ profileId: ref, reasonCode: "excluded_by_auth_order" }),
    );
    expect(plan.targets).toContainEqual(
      expect.objectContaining({ profileId: ref, source: "profile" }),
    );
  });

  it("probes an environment credential with the configured token auth mode", async () => {
    await withEnvAsync(
      Object.fromEntries([["ZAI_API_KEY", ["env", "zai"].join("-")]]),
      async () => {
        mockStore = { version: 1, profiles: {}, order: {} };
        mockAllowedProfiles = [];
        const plan = await buildProbeTargets({
          cfg: {
            models: {
              providers: {
                zai: {
                  baseUrl: "https://api.z.ai/v1",
                  api: "openai-responses",
                  auth: "token",
                  models: [],
                },
              },
            },
          } as OpenClawConfig,
          providers: ["zai"],
          modelCandidates: ["zai/glm-4.7"],
          options: {
            includeDirectKeys: true,
            timeoutMs: 5_000,
            concurrency: 1,
            maxTokens: 16,
          },
        });

        expect(plan.targets).toContainEqual(
          expect.objectContaining({ source: "env", label: "env: ZAI_API_KEY", mode: "token" }),
        );
      },
    );
  });

  it("keeps alias model selection while resolving profiles from the auth provider", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "byteplus:plan": {
          type: "api_key",
          provider: "byteplus",
          key: "byteplus-plan-key",
        },
      },
      order: { byteplus: ["byteplus:plan"] },
    };
    mockAllowedProfiles = ["byteplus:plan"];
    resolveAuthProfileEligibilityMock.mockReturnValue({ eligible: true, reasonCode: "ok" });
    loadModelCatalogMock.mockResolvedValueOnce([
      { provider: "byteplus", id: "seed-2-0-mini", name: "BytePlus Standard" },
      { provider: "byteplus-plan", id: "ark-code-latest", name: "BytePlus Plan" },
    ]);

    const plan = await buildProbeTargets({
      cfg: {
        models: {
          providers: {
            "byteplus-plan": {
              baseUrl: "https://ark.ap-southeast.bytepluses.com/api/coding/v3",
              api: "openai-completions",
              models: [],
            },
          },
        },
        auth: { order: { byteplus: ["byteplus:plan"] } },
      } as OpenClawConfig,
      providers: ["byteplus-plan"],
      modelCandidates: [],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.results).toStrictEqual([]);
    expect(plan.targets).toStrictEqual([
      {
        label: "byteplus:plan",
        mode: "api_key",
        model: { provider: "byteplus-plan", model: "ark-code-latest" },
        profileId: "byteplus:plan",
        provider: "byteplus-plan",
        source: "profile",
      },
    ]);
  });

  it("keeps profiles stored under the requested provider alias", async () => {
    mockStore = {
      version: 1,
      profiles: {
        "byteplus-plan:saved": {
          type: "api_key",
          provider: "byteplus-plan",
          key: "byteplus-plan-key",
        },
      },
      order: { "byteplus-plan": ["byteplus-plan:saved"] },
    };
    mockAllowedProfiles = ["byteplus-plan:saved"];
    resolveAuthProfileEligibilityMock.mockReturnValue({ eligible: true, reasonCode: "ok" });

    const plan = await buildProbeTargets({
      cfg: {} as OpenClawConfig,
      providers: ["byteplus-plan"],
      modelCandidates: ["byteplus-plan/ark-code-latest"],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(plan.results).toStrictEqual([]);
    expect(plan.targets).toContainEqual(
      expect.objectContaining({
        provider: "byteplus-plan",
        profileId: "byteplus-plan:saved",
        source: "profile",
      }),
    );
  });

  it("matches canonical providers against alias-valued catalog probe models", async () => {
    await withClearedZaiEnv(async () => {
      mockStore = {
        version: 1,
        profiles: {},
        order: {},
      };
      loadModelCatalogMock.mockResolvedValueOnce([
        { provider: "z.ai", id: "glm-4.7", name: "GLM-4.7" },
      ]);

      const plan = await buildProbeTargets({
        cfg: {
          models: {
            providers: {
              zai: {
                baseUrl: "https://api.z.ai/v1",
                api: "openai-responses",
                apiKey: "sk-zai-test", // pragma: allowlist secret
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        providers: ["zai"],
        modelCandidates: [],
        options: {
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      });

      expect(plan.results).toStrictEqual([]);
      expect(plan.targets).toStrictEqual([
        {
          label: "models.json",
          mode: "api_key",
          model: { provider: "zai", model: "glm-4.7" },
          provider: "zai",
          source: "models.json",
        },
      ]);
    });
  });

  it("prefers live Anthropic Haiku 4.5 catalog entries over stale Claude 3 probes", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    loadModelCatalogMock.mockResolvedValueOnce([
      { provider: "anthropic", id: "claude-3-haiku-20240307", name: "Claude Haiku 3" },
      {
        provider: "anthropic",
        id: "claude-haiku-4-5-20251001",
        name: "Claude Haiku 4.5",
      },
      { provider: "anthropic", id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
    ]);

    const plan = await withClearedAnthropicEnv(async () =>
      buildProbeTargets({
        cfg: {
          models: {
            providers: {
              anthropic: {
                baseUrl: "https://api.anthropic.com/v1",
                api: "anthropic-messages",
                apiKey: "sk-ant-test",
                models: [],
              },
            },
          },
        } as OpenClawConfig,
        providers: ["anthropic"],
        modelCandidates: [],
        options: {
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    );

    expect(plan.results).toStrictEqual([]);
    expect(plan.targets).toStrictEqual([
      {
        label: "models.json",
        mode: "api_key",
        model: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
        provider: "anthropic",
        source: "models.json",
      },
    ]);
  });

  it("uses workspace-scoped auth evidence when building env probe targets", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    loadModelCatalogMock.mockResolvedValue([
      { provider: "workspace-cloud", id: "workspace-model", name: "Workspace Model" },
    ]);

    const withoutWorkspace = await buildProbeTargets({
      cfg: {} as OpenClawConfig,
      providers: ["workspace-cloud"],
      modelCandidates: [],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });
    const withWorkspace = await buildProbeTargets({
      cfg: {} as OpenClawConfig,
      workspaceDir: "/tmp/workspace",
      providers: ["workspace-cloud"],
      modelCandidates: [],
      options: {
        timeoutMs: 5_000,
        concurrency: 1,
        maxTokens: 16,
      },
    });

    expect(withoutWorkspace.targets).toStrictEqual([]);
    expect(withWorkspace.targets).toStrictEqual([
      {
        label: "env",
        mode: "api_key",
        model: { provider: "workspace-cloud", model: "workspace-model" },
        provider: "workspace-cloud",
        source: "env",
      },
    ]);
  });

  it("uses the requested agent auth store when building profile probe targets", async () => {
    mockStore = {
      version: 1,
      profiles: {},
      order: {},
    };
    mockAgentStore = {
      version: 1,
      profiles: {
        "anthropic:coder": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant-coder-profile",
        },
      },
      order: {},
    };

    const { defaultPlan, agentPlan } = await withClearedAnthropicEnv(async () => ({
      defaultPlan: await buildProbeTargets({
        cfg: {} as OpenClawConfig,
        providers: ["anthropic"],
        modelCandidates: ["anthropic/claude-sonnet-4-6"],
        options: {
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
      agentPlan: await buildProbeTargets({
        cfg: {} as OpenClawConfig,
        agentDir: "/tmp/coder-agent",
        providers: ["anthropic"],
        modelCandidates: ["anthropic/claude-sonnet-4-6"],
        options: {
          timeoutMs: 5_000,
          concurrency: 1,
          maxTokens: 16,
        },
      }),
    }));

    expect(defaultPlan.targets).toStrictEqual([]);
    expect(agentPlan.results).toStrictEqual([]);
    expect(agentPlan.targets).toStrictEqual([
      {
        label: "anthropic:coder",
        mode: "api_key",
        model: { provider: "anthropic", model: "claude-sonnet-4-6" },
        profileId: "anthropic:coder",
        provider: "anthropic",
        source: "profile",
      },
    ]);
  });
});
