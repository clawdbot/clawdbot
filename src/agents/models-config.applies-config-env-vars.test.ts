// Verifies models.json planning applies config env vars and discovery scope.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { createConfigRuntimeEnv } from "../config/env-vars.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { saveAuthProfileStore } from "./auth-profiles/store.js";
import { unsetEnv, withTempEnv } from "./models-config.e2e-harness.js";
import {
  planOpenClawModelsJsonWithDeps,
  resolveProvidersForModelsJsonWithDeps,
} from "./models-config.plan.js";
import type { ProviderConfig } from "./models-config.providers.secrets.js";
import { encodePluginModelCatalogRelativePath } from "./plugin-model-catalog.js";

const TEST_ENV_VAR = "OPENCLAW_MODELS_CONFIG_TEST_ENV";

function createImplicitOpenRouterProvider(): ProviderConfig {
  return {
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    apiKey: "OPENROUTER_API_KEY",
    models: [
      {
        id: "openrouter/auto",
        name: "OpenRouter Auto",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
      },
    ],
  };
}

function createImplicitOpenAiProvider(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  // Minimal implicit OpenAI provider used to verify write planning without live
  // discovery or real credentials.
  return {
    baseUrl: "https://api.openai.com/v1",
    api: "openai-responses",
    models: [
      {
        id: "gpt-5.5",
        name: "GPT-5.5",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 400000,
        maxTokens: 128000,
      },
    ],
    ...overrides,
  };
}

function createImplicitGoogleVertexProvider(): ProviderConfig {
  return {
    baseUrl: "https://{location}-aiplatform.googleapis.com",
    api: "google-vertex",
    models: [
      {
        id: "gemini-2.5-pro",
        name: "Gemini 2.5 Pro",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      },
    ],
  };
}

async function resolveProvidersForConfigEnvTest(params: {
  cfg: OpenClawConfig;
  onResolveImplicitProviders: (env: NodeJS.ProcessEnv) => void;
}) {
  // Config env vars are materialized into the discovery env before implicit
  // provider resolution.
  const env = createConfigRuntimeEnv(params.cfg);
  return await resolveProvidersForModelsJsonWithDeps(
    {
      cfg: params.cfg,
      agentDir: "/tmp/openclaw-models-config-env-vars-test",
      env,
    },
    {
      resolveImplicitProviders: async ({ env: discoveryEnv }) => {
        params.onResolveImplicitProviders(discoveryEnv);
        return {
          openrouter: createImplicitOpenRouterProvider(),
        };
      },
    },
  );
}

function createConfigEnvVarsConfig(): OpenClawConfig {
  return {
    models: { providers: {} },
    env: {
      vars: {
        OPENROUTER_API_KEY: "from-config", // pragma: allowlist secret
        [TEST_ENV_VAR]: "from-config",
      },
    },
  };
}

async function resolveProvidersAndCaptureDiscoveryEnv(cfg: OpenClawConfig) {
  let discoveryEnv: NodeJS.ProcessEnv | undefined;
  const providers = await resolveProvidersForConfigEnvTest({
    cfg,
    onResolveImplicitProviders: (env) => {
      discoveryEnv = env;
    },
  });
  return { discoveryEnv, providers };
}

let unauthenticatedProviderWritePlan: Awaited<ReturnType<typeof planOpenClawModelsJsonWithDeps>>;
let unauthenticatedProviderParsed: { providers?: Record<string, unknown> };

beforeAll(async () => {
  // Reused no-auth write plan proves generated providers stay serializable
  // even when discovery returns auth-only provider shells.
  unauthenticatedProviderWritePlan = await planOpenClawModelsJsonWithDeps(
    {
      cfg: { models: { providers: {} } },
      agentDir: "/tmp/openclaw-models-config-env-vars-test",
      env: {},
      existingRaw: "",
      existingParsed: null,
    },
    {
      resolveImplicitProviders: async () => ({
        openai: createImplicitOpenAiProvider(),
        "auth-only": createImplicitOpenAiProvider({
          baseUrl: "https://auth.example/v1",
          api: "openai-responses",
          models: [],
        }),
      }),
    },
  );
  if (unauthenticatedProviderWritePlan.action !== "write") {
    throw new Error("Expected models.json write plan");
  }
  unauthenticatedProviderParsed = JSON.parse(unauthenticatedProviderWritePlan.contents) as {
    providers?: Record<string, unknown>;
  };
});

describe("models-config", () => {
  it("threads plugin metadata snapshots into implicit provider discovery", async () => {
    const pluginMetadataSnapshot = {
      index: { plugins: [{ pluginId: "zai", enabled: true }] },
      normalizePluginId: (pluginId: string) => pluginId,
      manifestRegistry: { plugins: [], diagnostics: [] },
      owners: { providers: new Map() },
    } as unknown as Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    let observedSnapshot:
      | Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">
      | undefined;

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        pluginMetadataSnapshot,
      },
      {
        resolveImplicitProviders: async ({ pluginMetadataSnapshot: receivedSnapshot }) => {
          observedSnapshot = receivedSnapshot;
          return {};
        },
      },
    );

    expect(observedSnapshot).toBe(pluginMetadataSnapshot);
  });

  it("threads workspace scope into implicit provider discovery", async () => {
    let observedWorkspaceDir: string | undefined;

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        workspaceDir: "/tmp/openclaw-workspace",
      },
      {
        resolveImplicitProviders: async ({ workspaceDir }) => {
          observedWorkspaceDir = workspaceDir;
          return {};
        },
      },
    );

    expect(observedWorkspaceDir).toBe("/tmp/openclaw-workspace");
  });

  it("threads startup provider discovery scope into implicit provider discovery", async () => {
    let observedProviderIds: readonly string[] | undefined;
    let observedEntriesOnly: boolean | undefined;
    let observedTimeoutMs: number | undefined;

    await resolveProvidersForModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        providerDiscoveryProviderIds: ["openai"],
        providerDiscoveryEntriesOnly: true,
        providerDiscoveryTimeoutMs: 5000,
      },
      {
        resolveImplicitProviders: async ({
          providerDiscoveryProviderIds,
          providerDiscoveryEntriesOnly,
          providerDiscoveryTimeoutMs,
        }) => {
          observedProviderIds = providerDiscoveryProviderIds;
          observedEntriesOnly = providerDiscoveryEntriesOnly;
          observedTimeoutMs = providerDiscoveryTimeoutMs;
          return {};
        },
      },
    );

    expect(observedProviderIds).toEqual(["openai"]);
    expect(observedEntriesOnly).toBe(true);
    expect(observedTimeoutMs).toBe(5000);
  });

  it("threads plugin metadata snapshots through models.json planning", async () => {
    const pluginMetadataSnapshot = {
      index: { plugins: [{ pluginId: "zai", enabled: true }] },
      normalizePluginId: (pluginId: string) => pluginId,
      manifestRegistry: { plugins: [], diagnostics: [] },
      owners: { providers: new Map() },
    } as unknown as Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    let observedSnapshot:
      | Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">
      | undefined;

    await planOpenClawModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        existingRaw: "",
        existingParsed: null,
        pluginMetadataSnapshot,
      },
      {
        resolveImplicitProviders: async ({ pluginMetadataSnapshot: receivedSnapshot }) => {
          observedSnapshot = receivedSnapshot;
          return {};
        },
      },
    );

    expect(observedSnapshot).toBe(pluginMetadataSnapshot);
  });

  it("does not write unauthenticated model providers that would invalidate models.json", async () => {
    expect(unauthenticatedProviderWritePlan.action).toBe("write");
    expect(unauthenticatedProviderParsed.providers?.openai).toBeUndefined();
    expect(unauthenticatedProviderParsed.providers?.["auth-only"]).toBeDefined();
  });

  it("treats empty replace-mode provider sets as authoritative", async () => {
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: { models: { mode: "replace", providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        existingRaw: `${JSON.stringify({ providers: { stale: {} } }, null, 2)}\n`,
        existingParsed: { providers: { stale: {} } },
      },
      {
        resolveImplicitProviders: async () => ({}),
      },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error("Expected models.json write plan");
    }
    expect(JSON.parse(plan.contents)).toEqual({ providers: {} });
    expect(plan.pluginCatalogWrites).toEqual({});
  });

  it("moves plugin-owned provider catalogs into plugin-scoped files", async () => {
    const pluginMetadataSnapshot = {
      index: { plugins: [{ pluginId: "zai", enabled: true }] },
      normalizePluginId: (pluginId: string) => pluginId,
      manifestRegistry: { plugins: [], diagnostics: [] },
      owners: {
        providers: new Map([["zai", ["zai"]]]),
        modelCatalogProviders: new Map([["zai", ["zai"]]]),
        setupProviders: new Map(),
      },
    } as unknown as Pick<PluginMetadataSnapshot, "index" | "manifestRegistry" | "owners">;
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: { ZAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
        existingRaw: "",
        existingParsed: null,
        pluginMetadataSnapshot,
      },
      {
        resolveImplicitProviders: async () => ({
          zai: createImplicitOpenAiProvider({
            baseUrl: "https://api.z.ai/api/paas/v4",
            apiKey: "ZAI_API_KEY",
          }),
          custom: createImplicitOpenAiProvider({
            baseUrl: "https://custom.example/v1",
            apiKey: "CUSTOM_API_KEY",
          }),
        }),
      },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error("Expected models.json write plan");
    }
    const root = JSON.parse(plan.contents) as {
      providers?: Record<string, unknown>;
    };
    expect(Object.keys(root.providers ?? {})).toEqual(["custom"]);
    expect(root).not.toHaveProperty("pluginCatalogs");
    const zaiCatalogPath = encodePluginModelCatalogRelativePath("zai");
    const zaiCatalog = JSON.parse(plan.pluginCatalogWrites?.[zaiCatalogPath] ?? "{}") as {
      providers?: Record<string, unknown>;
    };
    expect(Object.keys(zaiCatalog.providers ?? {})).toEqual(["zai"]);
  });

  it("falls back to canonical env markers when provider runtime has no api-key policy", async () => {
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: { models: { providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: { OPENAI_API_KEY: "sk-test" } as NodeJS.ProcessEnv,
        existingRaw: "",
        existingParsed: null,
      },
      {
        resolveImplicitProviders: async () => ({
          openai: createImplicitOpenAiProvider(),
        }),
      },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error("Expected models.json write plan");
    }
    const parsed = JSON.parse(plan.contents) as {
      providers?: Record<string, { apiKey?: string }>;
    };
    expect(parsed.providers?.openai?.apiKey).toBe("OPENAI_API_KEY");
  });

  it("normalizes retired Gemini ids preserved from existing models.json rows", async () => {
    const plan = await planOpenClawModelsJsonWithDeps(
      {
        cfg: { models: { mode: "merge", providers: {} } },
        agentDir: "/tmp/openclaw-models-config-env-vars-test",
        env: {},
        existingRaw: "",
        existingParsed: {
          providers: {
            google: {
              baseUrl: "https://generativelanguage.googleapis.com/v1beta",
              api: "google-generative-ai",
              apiKey: "GOOGLE_API_KEY", // pragma: allowlist secret
              models: [
                {
                  id: "gemini-3-pro-preview",
                  name: "Gemini 3 Pro",
                  input: ["text"],
                },
              ],
            },
          },
        },
      },
      {
        resolveImplicitProviders: async () => ({
          openai: {
            baseUrl: "https://api.openai.com/v1",
            api: "openai-responses",
            apiKey: "OPENAI_API_KEY", // pragma: allowlist secret
            models: [
              {
                id: "gpt-5.5",
                name: "GPT-5.5",
                input: ["text"],
                reasoning: true,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: 400000,
                maxTokens: 128000,
              },
            ],
          },
        }),
      },
    );

    expect(plan.action).toBe("write");
    if (plan.action !== "write") {
      throw new Error("Expected models.json write plan");
    }
    const parsed = JSON.parse(plan.contents) as {
      providers?: Record<string, { models?: Array<{ id?: string }> }>;
    };
    expect(parsed.providers?.google?.models?.map((model) => model.id)).toEqual([
      "gemini-3.1-pro-preview",
    ]);
  });

  it("keeps google-vertex static catalog rows when an auth profile supplies the API key", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-models-"));
    try {
      saveAuthProfileStore(
        {
          version: 1,
          profiles: {
            "google-vertex:default": {
              type: "api_key",
              provider: "google-vertex",
              keyRef: { source: "env", provider: "default", id: "GOOGLE_CLOUD_API_KEY" },
            },
          },
        },
        agentDir,
        { filterExternalAuthProfiles: false, syncExternalCli: false },
      );

      const plan = await planOpenClawModelsJsonWithDeps(
        {
          cfg: {
            agents: {
              defaults: {
                models: {
                  "google-vertex/gemini-2.5-pro": {},
                },
                model: { primary: "google-vertex/gemini-2.5-pro" },
              },
            },
            models: { providers: {} },
          },
          agentDir,
          env: {},
          existingRaw: "",
          existingParsed: null,
        },
        {
          resolveImplicitProviders: async () => ({
            "google-vertex": createImplicitGoogleVertexProvider(),
          }),
        },
      );

      expect(plan.action).toBe("write");
      if (plan.action !== "write") {
        throw new Error("Expected models.json write plan");
      }
      const parsed = JSON.parse(plan.contents) as {
        providers?: Record<
          string,
          { apiKey?: string; api?: string; models?: Array<{ id?: string }> }
        >;
      };
      expect(parsed.providers?.["google-vertex"]?.api).toBe("google-vertex");
      expect(parsed.providers?.["google-vertex"]?.apiKey).toBe("GOOGLE_CLOUD_API_KEY");
      expect(parsed.providers?.["google-vertex"]?.models?.map((model) => model.id)).toEqual([
        "gemini-2.5-pro",
      ]);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("keeps google-vertex static catalog rows when ADC auth evidence supplies the marker", async () => {
    const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-google-vertex-adc-models-"));
    const credentialsPath = path.join(agentDir, "application_default_credentials.json");
    await fs.writeFile(credentialsPath, JSON.stringify({ type: "authorized_user" }), "utf8");
    try {
      const plan = await planOpenClawModelsJsonWithDeps(
        {
          cfg: {
            agents: {
              defaults: {
                models: {
                  "google-vertex/gemini-2.5-pro": {},
                },
                model: { primary: "google-vertex/gemini-2.5-pro" },
              },
            },
            models: { providers: {} },
          },
          agentDir,
          env: {
            GOOGLE_APPLICATION_CREDENTIALS: credentialsPath,
            GOOGLE_CLOUD_PROJECT: "vertex-project",
            GOOGLE_CLOUD_LOCATION: "global",
          } as NodeJS.ProcessEnv,
          existingRaw: "",
          existingParsed: null,
        },
        {
          resolveImplicitProviders: async () => ({
            "google-vertex": createImplicitGoogleVertexProvider(),
          }),
        },
      );

      expect(plan.action).toBe("write");
      if (plan.action !== "write") {
        throw new Error("Expected models.json write plan");
      }
      const parsed = JSON.parse(plan.contents) as {
        providers?: Record<
          string,
          { apiKey?: string; api?: string; models?: Array<{ id?: string }> }
        >;
      };
      expect(parsed.providers?.["google-vertex"]?.api).toBe("google-vertex");
      expect(parsed.providers?.["google-vertex"]?.apiKey).toBe("gcp-vertex-credentials");
      expect(parsed.providers?.["google-vertex"]?.models?.map((model) => model.id)).toEqual([
        "gemini-2.5-pro",
      ]);
    } finally {
      await fs.rm(agentDir, { recursive: true, force: true });
    }
  });

  it("uses config env.vars entries for implicit provider discovery without mutating process.env", async () => {
    await withTempEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR], async () => {
      unsetEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR]);
      const { discoveryEnv, providers } = await resolveProvidersAndCaptureDiscoveryEnv(
        createConfigEnvVarsConfig(),
      );

      expect(process.env.OPENROUTER_API_KEY).toBeUndefined();
      expect(process.env[TEST_ENV_VAR]).toBeUndefined();
      expect(discoveryEnv?.OPENROUTER_API_KEY).toBe("from-config");
      expect(discoveryEnv?.[TEST_ENV_VAR]).toBe("from-config");
      expect(providers.openrouter?.apiKey).toBe("OPENROUTER_API_KEY");
    });
  });

  it("does not overwrite already-set host env vars while ensuring models.json", async () => {
    await withTempEnv(["OPENROUTER_API_KEY", TEST_ENV_VAR], async () => {
      process.env.OPENROUTER_API_KEY = "from-host"; // pragma: allowlist secret
      process.env[TEST_ENV_VAR] = "from-host";
      const { discoveryEnv, providers } = await resolveProvidersAndCaptureDiscoveryEnv(
        createConfigEnvVarsConfig(),
      );

      expect(discoveryEnv?.OPENROUTER_API_KEY).toBe("from-host");
      expect(discoveryEnv?.[TEST_ENV_VAR]).toBe("from-host");
      expect(providers.openrouter?.apiKey).toBe("OPENROUTER_API_KEY");
      expect(process.env.OPENROUTER_API_KEY).toBe("from-host");
      expect(process.env[TEST_ENV_VAR]).toBe("from-host");
    });
  });
});
