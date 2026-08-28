import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createTestPluginApi } from "../plugin-sdk/plugin-test-api.js";
import { clearLiveCatalogCacheForTests } from "../plugin-sdk/provider-catalog-shared.js";
import { createPluginMetadataSnapshotFixture } from "../plugins/plugin-metadata.test-support.js";
import type { OpenClawPluginDefinition, ProviderPlugin } from "../plugins/types.js";
import { resolveRelativeBundledPluginPublicModuleId } from "../test-utils/bundled-plugin-public-surface.js";
import { withEnvAsync } from "../test-utils/env.js";
import { withFetchPreconnect } from "../test-utils/fetch-mock.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot,
} from "./auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { planOpenClawModelsJson } from "./models-config.plan.js";
import { encodePluginModelCatalogRelativePath } from "./plugin-model-catalog.js";

const discovery = vi.hoisted(() => ({ providers: new Array<ProviderPlugin>() }));
vi.mock("../plugins/provider-discovery.runtime.js", () => ({
  resolvePluginDiscoveryProvidersRuntime: () => discovery.providers,
}));

describe("registered Ollama catalog SecretRef ownership", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);
  beforeAll(async () => {
    const { default: plugin } = (await import(
      resolveRelativeBundledPluginPublicModuleId({
        fromModuleUrl: import.meta.url,
        pluginId: "ollama",
        artifactBasename: "index.js",
      })
    )) as { default: OpenClawPluginDefinition };
    expectDefined(
      plugin.register,
      "Ollama public register",
    )(
      createTestPluginApi({
        id: "ollama",
        registrationMode: "discovery",
        registerProvider: (provider) => {
          if (provider.id === "ollama") {
            discovery.providers.push(provider);
          }
        },
      }),
    );
    expect(discovery.providers).toHaveLength(1);
  });
  afterEach(() => {
    clearLiveCatalogCacheForTests();
    vi.unstubAllGlobals();
  });

  it.each(
    ["profile", "config"].flatMap((owner) =>
      [
        "https://ollama-profile.example/v1",
        "http://127.0.0.1:11434",
        ...(owner === "config" ? ["http://127.0.0.1:11435"] : []),
      ].flatMap((baseUrl) =>
        [true, false].map((explicitModels) => ({ owner, baseUrl, explicitModels })),
      ),
    ),
  )(
    "keeps $owner refs out of writable plans at $baseUrl (explicit=$explicitModels)",
    async ({ owner, baseUrl, explicitModels }) => {
      const stateDir = tempDirs.make("ollama-catalog-ref-");
      await withEnvAsync({ OPENCLAW_STATE_DIR: stateDir, OLLAMA_API_KEY: undefined }, async () => {
        const agentDir = path.join(stateDir, "agent");
        const ref = { source: "store", provider: "default", id: "OLLAMA_DISCOVERY_KEY" } as const;
        const profile = {
          type: "api_key",
          provider: "ollama",
          keyRef: ref,
        } as const;
        const authStore: AuthProfileStore = {
          version: 1,
          profiles: owner === "profile" ? { "ollama:fixture": profile } : {},
        };
        const runtimeKey = "resolved-ollama-profile-fixture";
        if (owner === "profile") {
          setRuntimeAuthProfileStoreSnapshot(
            {
              version: 1,
              profiles: { "ollama:fixture": { ...profile, key: runtimeKey } },
            },
            agentDir,
          );
        }
        const model = {
          id: "fixture-model",
          name: "Fixture model",
          reasoning: false,
          input: ["text"] as ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 8192,
          maxTokens: 2048,
        };
        const provider = { baseUrl, models: explicitModels ? [model] : [] };
        const cfg: OpenClawConfig = {
          models: {
            providers: {
              ollama: { ...provider, ...(owner === "config" ? { apiKey: ref } : {}) },
            },
          },
        };
        const discoveryAuthConfig: OpenClawConfig =
          owner === "config"
            ? { models: { providers: { ollama: { ...provider, apiKey: runtimeKey } } } }
            : cfg;
        const authorization: Array<string | null> = [];
        const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          authorization.push(new Headers(init?.headers).get("authorization"));
          const url = input instanceof Request ? input.url : input.toString();
          return Response.json(
            url.endsWith("/api/tags")
              ? { models: [{ name: model.id }] }
              : {
                  capabilities: ["completion", "tools"],
                  model_info: { "fixture.context_length": 8192 },
                },
          );
        });
        vi.stubGlobal("fetch", withFetchPreconnect(fetchMock));
        try {
          const plan = await planOpenClawModelsJson({
            context: {
              cfg,
              discoveryAuthConfig,
              sourceConfigForSecrets: cfg,
              agentDir,
              env: {},
              envFingerprint: {},
              pluginMetadataSnapshot: createPluginMetadataSnapshotFixture({
                plugins: [{ id: "ollama", providers: discovery.providers.map(({ id }) => id) }],
              }),
            },
            authStore,
            existingRaw: "",
            existingParsed: null,
          });
          const contents = expectDefined(
            plan.pluginCatalogWrites?.[encodePluginModelCatalogRelativePath("ollama")],
            "Ollama writable plugin catalog",
          );
          expect(contents).not.toContain(runtimeKey);
          expect(JSON.stringify(plan)).not.toContain(runtimeKey);
          const catalog = JSON.parse(contents) as {
            providers: { ollama: { api: string; apiKey: string; models: Array<{ id: string }> } };
          };
          expect(catalog.providers.ollama.models.map(({ id }) => id)).toEqual([model.id]);
          expect(catalog.providers.ollama.api).toBe("ollama");
          // Explicit local catalogs intentionally select synthetic auth before profiles.
          expect(catalog.providers.ollama.apiKey).toBe(
            owner === "profile" && explicitModels && baseUrl.startsWith("http://127.0.0.1")
              ? "ollama-local"
              : NON_ENV_SECRETREF_MARKER,
          );
          expect(authorization).toEqual(
            explicitModels ? [] : [`Bearer ${runtimeKey}`, `Bearer ${runtimeKey}`],
          );
        } finally {
          // Close snapshot readers before the tracker removes their temporary owner.
          clearRuntimeAuthProfileStoreSnapshots();
        }
      });
    },
  );
});
