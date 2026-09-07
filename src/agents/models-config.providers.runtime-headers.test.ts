// Verifies catalog hooks consume runtime headers without persisting plaintext.
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderPlugin } from "../plugins/types.js";

const discovery = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));
vi.mock("../plugins/provider-runtime.js", () => ({
  normalizeProviderConfigWithPlugin: (params: { context?: { providerConfig?: object } }) =>
    params.context?.providerConfig,
  resolveProviderConfigApiKeyWithPlugin: () => undefined,
  resolveProviderSyntheticAuthWithPlugin: () => undefined,
}));

beforeEach(() => {
  discovery.providers = [];
  vi.doUnmock("../plugins/manifest-registry.js");
  vi.doUnmock("../secrets/provider-env-vars.js");
});

describe("models-config catalog runtime headers", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  it("passes resolved catalog headers while persisting their source markers", async () => {
    const { planOpenClawModelsJson } = await import("./models-config.plan.js");
    const sourceConfig = {
      models: {
        providers: {
          "catalog-fixture": {
            baseUrl: "https://catalog.example/v1",
            api: "openai-completions",
            apiKey: { source: "env", provider: "default", id: "CATALOG_AUTH_TOKEN" },
            headers: {
              "X-Catalog-Token": { source: "env", provider: "default", id: "CATALOG_TOP_TOKEN" },
            },
            request: {
              headers: {
                "X-Request-Token": {
                  source: "env",
                  provider: "default",
                  id: "CATALOG_REQUEST_TOKEN",
                },
              },
            },
            models: [],
          },
          "other-fixture": {
            baseUrl: "https://other.example/v1",
            headers: {
              "X-Other-Token": { source: "env", provider: "default", id: "CATALOG_OTHER_TOKEN" },
            },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    const runtimeConfig: OpenClawConfig = {
      models: {
        providers: {
          "catalog-fixture": {
            ...sourceConfig.models.providers["catalog-fixture"],
            apiKey: "activated-auth-material",
            headers: { "X-Catalog-Token": "activated-catalog-material" },
            request: { headers: { "X-Request-Token": "activated-request-material" } },
          },
          "other-fixture": {
            ...sourceConfig.models.providers["other-fixture"],
            headers: { "X-Other-Token": "other-private-material" },
          },
        },
      },
    };
    const before = structuredClone(sourceConfig);
    const observed: unknown[] = [];
    discovery.providers = [
      {
        id: "catalog-fixture",
        pluginId: "catalog-fixture",
        label: "Catalog fixture",
        auth: [],
        catalog: {
          order: "simple",
          run: async (ctx) => {
            const provider = expectDefined(
              ctx.config.models?.providers?.["catalog-fixture"],
              "catalog callback provider",
            );
            observed.push({
              apiKey: provider.apiKey,
              headers: provider.headers,
              request: provider.request,
              otherHeaders: ctx.config.models?.providers?.["other-fixture"]?.headers,
            });
            return { provider: { baseUrl: provider.baseUrl, api: provider.api, models: [] } };
          },
        },
      },
    ];
    const plan = await planOpenClawModelsJson({
      context: {
        cfg: sourceConfig,
        discoveryAuthConfig: runtimeConfig,
        sourceConfigForSecrets: sourceConfig,
        agentDir: tempDirs.make("catalog-runtime-headers-"),
        env: { CATALOG_TOP_TOKEN: "unactivated-env-material" },
        envFingerprint: "catalog-runtime-headers",
        providerDiscoveryProviderIds: ["catalog-fixture"],
      },
      authStore: { version: 1, profiles: {} },
      existingRaw: "",
      existingParsed: null,
    });

    expect(observed).toEqual([
      {
        apiKey: { source: "env", provider: "default", id: "CATALOG_AUTH_TOKEN" },
        headers: { "X-Catalog-Token": "activated-catalog-material" },
        request: { headers: { "X-Request-Token": "activated-request-material" } },
        otherHeaders: {
          "X-Other-Token": { source: "env", provider: "default", id: "CATALOG_OTHER_TOKEN" },
        },
      },
    ]);
    expect(plan.action).toBe("write");
    expect(JSON.stringify(plan)).toContain("CATALOG_TOP_TOKEN");
    expect(JSON.stringify(plan)).toContain("CATALOG_REQUEST_TOKEN");
    expect(JSON.stringify(plan)).not.toContain("activated-catalog-material");
    expect(JSON.stringify(plan)).not.toContain("activated-request-material");
    expect(JSON.stringify(plan)).not.toContain("activated-auth-material");
    expect(JSON.stringify(plan)).not.toContain("other-private-material");
    expect(sourceConfig).toEqual(before);
  });

  it("keeps unresolved catalog headers fail-closed", async () => {
    const { planOpenClawModelsJson } = await import("./models-config.plan.js");
    const { normalizeResolvedSecretInputString } = await import("../config/types.secrets.js");
    const config = {
      models: {
        providers: {
          "catalog-fixture": {
            baseUrl: "https://catalog.example/v1",
            headers: {
              "X-Catalog-Token": { source: "env", provider: "default", id: "CATALOG_TOP_TOKEN" },
            },
            models: [],
          },
        },
      },
    } satisfies OpenClawConfig;
    discovery.providers = [
      {
        id: "catalog-fixture",
        pluginId: "catalog-fixture",
        label: "Catalog fixture",
        auth: [],
        catalog: {
          order: "simple",
          run: async (ctx) => {
            normalizeResolvedSecretInputString({
              value:
                ctx.config.models?.providers?.["catalog-fixture"]?.headers?.["X-Catalog-Token"],
              path: "models.providers.catalog-fixture.headers.X-Catalog-Token",
            });
            throw new Error("Unresolved catalog request was admitted");
          },
        },
      },
    ];

    await expect(
      planOpenClawModelsJson({
        context: {
          cfg: config,
          discoveryAuthConfig: structuredClone(config),
          sourceConfigForSecrets: config,
          agentDir: tempDirs.make("catalog-unresolved-headers-"),
          env: {},
          envFingerprint: "catalog-unresolved-headers",
          providerDiscoveryProviderIds: ["catalog-fixture"],
        },
        authStore: { version: 1, profiles: {} },
        existingRaw: "",
        existingParsed: null,
      }),
    ).rejects.toThrow("unresolved SecretRef");
  });
});
