import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { loadGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import { saveAuthProfileStore } from "./auth-profiles/store.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
import {
  createPreparedModelCatalogWorkerInput,
  getPreparedModelFullCatalogAuth,
  runPreparedModelCatalogWorker,
} from "./prepared-model-catalog-worker.js";
import {
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
  setPreparedModelRuntimeAuthLoader,
} from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuild } from "./prepared-model-runtime.build.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.facts.js";
import { AuthStorage } from "./sessions/auth-storage.js";

const PROVIDER_ID = "worker-catalog-fixture";
const SHARED_AUTH_PROVIDER_ID = `${PROVIDER_ID}-shared-auth`;
const PLUGIN_ID = "worker-catalog-fixture";
const PROFILE_ID = `${SHARED_AUTH_PROVIDER_ID}:named`;
const MATERIALIZED_SECRET = "materialized-worker-secret-not-real";
const UNRELATED_SECRET = "unrelated-worker-secret-not-real";
const REF_ONLY_API_PROVIDER_ID = `${PROVIDER_ID}-ref-api`;
const REF_ONLY_API_ENV = "OPENCLAW_WORKER_REF_ONLY_API_KEY";
const REF_ONLY_TOKEN_PROVIDER_ID = `${PROVIDER_ID}-ref-token`;
const REF_ONLY_TOKEN_ENV = "OPENCLAW_WORKER_REF_ONLY_TOKEN";
const DURABLE_AUTH_PROVIDER_ID = `${PROVIDER_ID}-durable-auth`;
const DURABLE_AUTH_KEY = "post-startup-durable-key-not-real";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  });
});

function createJwtWithExp(exp: number): string {
  const payload = Buffer.from(JSON.stringify({ exp })).toString("base64url");
  return `header.${payload}.signature`;
}

function writeFixturePlugin(params: { root: string; spinMs: number }): string {
  const pluginDir = path.join(params.root, "plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, "index.cjs");
  fs.writeFileSync(
    pluginFile,
    `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(PROVIDER_ID)},
      label: "Worker catalog fixture",
      auth: [],
      catalog: {
        run(context) {
          const refOnlyApi = context.resolveProviderApiKey(${JSON.stringify(REF_ONLY_API_PROVIDER_ID)}).apiKey;
          const refOnlyToken = context.resolveProviderApiKey(${JSON.stringify(REF_ONLY_TOKEN_PROVIDER_ID)}).apiKey;
          const durableAuth = context.resolveProviderApiKey(${JSON.stringify(DURABLE_AUTH_PROVIDER_ID)}).apiKey;
          const hasRefOnlyApi = refOnlyApi === ${JSON.stringify(REF_ONLY_API_ENV)} || refOnlyApi === process.env[${JSON.stringify(REF_ONLY_API_ENV)}];
          const hasRefOnlyToken = refOnlyToken === ${JSON.stringify(REF_ONLY_TOKEN_ENV)} || refOnlyToken === process.env[${JSON.stringify(REF_ONLY_TOKEN_ENV)}];
          return { provider: {
            baseUrl: "https://worker-catalog.invalid/v1",
            api: "openai-completions",
            models: [
              { id: "sqlite-model", name: "SQLite model" },
              {
                id: \`ref-proof-api-\${hasRefOnlyApi}-token-\${hasRefOnlyToken}\`,
                name: "Ref-only worker proof",
              },
              ...(durableAuth === ${JSON.stringify(DURABLE_AUTH_KEY)}
                ? [{ id: "post-startup-auth-model", name: "Post-startup auth model" }]
                : []),
            ],
          } };
        },
      },
      augmentModelCatalog(context) {
        const marker = process.env.OPENCLAW_WORKER_CATALOG_MARKER;
        const invocation = fs.existsSync(marker)
          ? fs.readFileSync(marker, "utf8").split("start\\n").length
          : 1;
        fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, "start\\n");
        const until = Date.now() + ${params.spinMs};
        while (Date.now() < until) {}
        const hasSqlite = context.entries.some((entry) =>
          entry.provider === ${JSON.stringify(PROVIDER_ID)} && entry.id === "sqlite-model");
        const hasShared = context.resolveProviderApiKey(${JSON.stringify(SHARED_AUTH_PROVIDER_ID)}).apiKey === ${JSON.stringify(MATERIALIZED_SECRET)};
        const hasUnrelated = context.resolveProviderApiKey("unrelated-provider").apiKey === ${JSON.stringify(UNRELATED_SECRET)};
        fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, "done\\n");
        return [{
          provider: ${JSON.stringify(PROVIDER_ID)},
          id: \`proof-refresh-\${invocation}-sqlite-\${hasSqlite}-shared-\${hasShared}-unrelated-\${hasUnrelated}\`,
          name: "Worker boundary proof",
        }];
      },
    });
  },
};
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      providers: [PROVIDER_ID],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" }, runtimeAugment: true },
    }),
    "utf8",
  );
  return pluginFile;
}

async function createStaticSnapshot(spinMs: number, envOverride: NodeJS.ProcessEnv = {}) {
  const root = tempDirs.make("openclaw-model-catalog-worker-");
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspace");
  const marker = path.join(root, "worker-marker.txt");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const pluginFile = writeFixturePlugin({ root, spinMs });
  const env = {
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_WORKER_CATALOG_MARKER: marker,
    ...envOverride,
    [REF_ONLY_API_ENV]: "ref-only-api-secret-not-real",
    [REF_ONLY_TOKEN_ENV]: "ref-only-token-secret-not-real",
  };
  const config = {
    agents: { defaults: { model: `${PROVIDER_ID}/sqlite-model` } },
    plugins: {
      allow: [PLUGIN_ID],
      load: { paths: [pluginFile] },
      entries: { [PLUGIN_ID]: { enabled: true } },
    },
  } satisfies OpenClawConfig;
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir,
      store: {
        version: 1,
        profiles: {
          [PROFILE_ID]: {
            type: "token",
            provider: SHARED_AUTH_PROVIDER_ID,
            token: MATERIALIZED_SECRET,
            tokenRef: { source: "env", provider: "default", id: "SHARED_SECRET_REF" },
          },
          "unrelated-provider:default": {
            type: "api_key",
            provider: "unrelated-provider",
            key: UNRELATED_SECRET,
            keyRef: { source: "env", provider: "default", id: "UNRELATED_SECRET_REF" },
          },
        },
        order: { [SHARED_AUTH_PROVIDER_ID]: [PROFILE_ID] },
      },
    },
  ]);
  replacePersistedPluginModelCatalogs({
    agentDir,
    pluginCatalogWrites: {
      [encodePluginModelCatalogRelativePath(PLUGIN_ID)]: JSON.stringify({
        generatedBy: PLUGIN_MODEL_CATALOG_GENERATED_BY,
        providers: {
          [PROVIDER_ID]: {
            baseUrl: "https://worker-catalog.invalid/v1",
            api: "openai-completions",
            apiKey: "WORKER_CATALOG_API_KEY",
            models: [{ id: "sqlite-model", name: "SQLite model" }],
          },
        },
      }),
    },
  });
  let current = true;
  const build = await startSerializedSnapshotBuild(
    { agentId: "main", agentDir, inheritedAuthDir: agentDir, workspaceDir, config, env },
    new Map(),
    30_000,
    "static",
    () => current,
  ).pending;
  return {
    agentDir,
    config,
    env,
    marker,
    pluginMetadataSnapshot: build.pluginGeneration.pluginMetadataSnapshot,
    snapshot: build.snapshot,
    supersede: () => (current = false),
    workspaceDir,
  };
}

async function waitForMarker(marker: string): Promise<void> {
  await expect.poll(() => fs.existsSync(marker), { timeout: 30_000 }).toBe(true);
}

describe("prepared model catalog worker boundary", () => {
  it("refreshes durable auth before provider hooks decide catalog membership", async () => {
    const fixture = await createStaticSnapshot(0);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [`${DURABLE_AUTH_PROVIDER_ID}:default`]: {
            type: "api_key",
            provider: DURABLE_AUTH_PROVIDER_ID,
            key: DURABLE_AUTH_KEY,
          },
        },
      },
      fixture.agentDir,
    );

    const catalog = await fixture.snapshot.loadFullModelCatalog?.();
    expect(catalog?.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: PROVIDER_ID,
          id: "post-startup-auth-model",
        }),
      ]),
    );
    expect(getPreparedModelFullCatalogAuth(catalog!)).toMatchObject({
      authStore: {
        profiles: {
          [`${DURABLE_AUTH_PROVIDER_ID}:default`]: expect.objectContaining({
            key: DURABLE_AUTH_KEY,
          }),
        },
      },
    });
  });

  it("refreshes durable auth profiles added, updated, and removed after startup", async () => {
    const fixture = await createStaticSnapshot(0);
    const route = {
      provider: DURABLE_AUTH_PROVIDER_ID,
      id: "durable-model",
      name: "Durable model",
      api: "openai-completions" as const,
      baseUrl: "https://durable-auth.invalid/v1",
    };
    const config = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        list: [
          {
            id: "main",
            default: true,
            agentDir: fixture.agentDir,
            workspace: fixture.workspaceDir,
          },
        ],
      },
    } satisfies OpenClawConfig;
    const owner = Object.freeze({
      ...fixture.snapshot,
      config,
      modelCatalog: { entries: [route], routeVariants: [route] },
    });
    const project = async () => {
      const fullCatalog = await fixture.snapshot.loadFullModelCatalog?.();
      const fullAuth = fullCatalog && getPreparedModelFullCatalogAuth(fullCatalog);
      if (!fullAuth) {
        throw new Error("full catalog omitted prepared auth");
      }
      return await loadGatewayModelCatalogSnapshot({
        getConfig: () => config,
        loadPublishedPreparedModelCatalogOwnerSnapshot: async () => ({
          ...owner,
          authModes: fullAuth.authModes,
          authStore: fullAuth.authStore,
        }),
      });
    };
    const projectModels = async () => {
      const projected = await project();
      const context = {
        getRuntimeConfig: () => config,
        loadGatewayModelCatalogSnapshot: async () => projected,
        readPreparedGatewayModelCatalogSnapshot: async () => projected,
        logGateway: { debug: () => undefined },
      } as unknown as GatewayRequestContext;
      return {
        projected,
        result: await buildModelsListResult({ context, params: { view: "all" } }),
      };
    };
    const writeDurableProfile = (key?: string) =>
      saveAuthProfileStore(
        {
          version: 1,
          profiles: key
            ? {
                [`${DURABLE_AUTH_PROVIDER_ID}:default`]: {
                  type: "api_key",
                  provider: DURABLE_AUTH_PROVIDER_ID,
                  key,
                },
              }
            : {},
        },
        fixture.agentDir,
      );

    writeDurableProfile("first-key-not-real");
    const added = await projectModels();
    expect(added).toMatchObject({
      result: {
        models: [expect.objectContaining({ id: "durable-model", available: true })],
      },
      projected: {
        authStore: {
          profiles: {
            [`${DURABLE_AUTH_PROVIDER_ID}:default`]: expect.objectContaining({
              key: "first-key-not-real",
            }),
          },
        },
      },
    });

    writeDurableProfile("second-key-not-real");
    const updated = await project();
    expect(updated).toMatchObject({
      authStore: {
        profiles: {
          [`${DURABLE_AUTH_PROVIDER_ID}:default`]: expect.objectContaining({
            key: "second-key-not-real",
          }),
        },
      },
    });

    writeDurableProfile();
    const removed = await projectModels();
    expect(removed).toMatchObject({
      result: {
        models: [expect.objectContaining({ id: "durable-model", available: false })],
      },
    });
    expect(removed.projected.authStore).toBeDefined();
    expect(
      removed.projected.authStore?.profiles[`${DURABLE_AUTH_PROVIDER_ID}:default`],
    ).toBeUndefined();
  });

  it("makes a post-startup Codex login available to direct models.list", async () => {
    const codexHome = tempDirs.make("openclaw-models-list-codex-");
    const fixture = await createStaticSnapshot(0, { CODEX_HOME: codexHome });
    const route = {
      provider: "openai",
      id: "gpt-5.4",
      name: "GPT-5.4",
      api: "openai-chatgpt-responses" as const,
      baseUrl: "https://chatgpt.com/backend-api/codex",
    };
    const config = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        list: [
          {
            id: "main",
            default: true,
            agentDir: fixture.agentDir,
            workspace: fixture.workspaceDir,
          },
        ],
      },
    } satisfies OpenClawConfig;
    const owner = Object.freeze({
      ...fixture.snapshot,
      config,
      authStore: getPreparedModelRuntimeAuthStore(fixture.snapshot),
      modelCatalog: { entries: [route], routeVariants: [route] },
    });
    setPreparedModelRuntimeAuthLoader(owner, async (providerIds) => {
      const refreshed = await loadPreparedModelRuntimeAuth(fixture.snapshot, providerIds);
      if (!refreshed) {
        throw new Error("prepared auth refresh was unavailable");
      }
      return refreshed;
    });
    const listModels = async () => {
      const context = {
        getRuntimeConfig: () => config,
        loadGatewayModelCatalogSnapshot: async (
          loadParams: Parameters<typeof loadGatewayModelCatalogSnapshot>[0],
        ) =>
          await loadGatewayModelCatalogSnapshot({
            ...loadParams,
            getConfig: () => config,
            loadPublishedPreparedModelCatalogOwnerSnapshot: async () => owner,
          }),
        readPreparedGatewayModelCatalogSnapshot: async () => undefined,
        logGateway: { debug: () => undefined },
      } as unknown as GatewayRequestContext;
      return await buildModelsListResult({ context, params: { view: "all" } });
    };

    await expect(listModels()).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "gpt-5.4", available: false })],
    });
    fs.writeFileSync(
      path.join(codexHome, "auth.json"),
      JSON.stringify({
        auth_mode: "chatgpt",
        tokens: {
          access_token: createJwtWithExp(Math.floor(Date.now() / 1000) + 3600),
          refresh_token: "post-startup-refresh-not-real",
        },
      }),
      "utf8",
    );

    await expect(listModels()).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "gpt-5.4", available: true })],
    });
    fs.rmSync(path.join(codexHome, "auth.json"));
    await expect(listModels()).resolves.toMatchObject({
      models: [expect.objectContaining({ id: "gpt-5.4", available: false })],
    });
  });

  it("shares in-flight discovery but reruns completed refreshes with prepared auth and SQLite facts", async () => {
    const fixture = await createStaticSnapshot(750);
    let settled = false;
    const first = fixture.snapshot.loadFullModelCatalog?.().finally(() => {
      settled = true;
    });
    const second = fixture.snapshot.loadFullModelCatalog?.();
    await waitForMarker(fixture.marker);

    expect(settled).toBe(false);
    const [catalog, sharedCatalog] = await Promise.all([first, second]);
    expect(sharedCatalog).toBe(catalog);
    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "proof-refresh-1-sqlite-true-shared-true-unrelated-true",
      }),
    );
    await expect(fixture.snapshot.loadFullModelCatalog?.()).resolves.toEqual(
      expect.objectContaining({
        entries: expect.arrayContaining([
          expect.objectContaining({
            provider: PROVIDER_ID,
            id: "proof-refresh-2-sqlite-true-shared-true-unrelated-true",
          }),
        ]),
      }),
    );
    expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\nstart\ndone\n");
  });

  it("terminates discovery when its owning generation is superseded", async () => {
    const fixture = await createStaticSnapshot(10_000);
    const catalog = fixture.snapshot.loadFullModelCatalog?.();
    await waitForMarker(fixture.marker);
    fixture.supersede();

    await expect(catalog).rejects.toThrow("superseded");
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 100);
    });
    expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\n");
  });

  it("preserves ref-only api-key and token profiles through the real worker", async () => {
    const fixture = await createStaticSnapshot(0);
    const authStore = {
      version: 1,
      profiles: {
        [`${REF_ONLY_API_PROVIDER_ID}:default`]: {
          type: "api_key" as const,
          provider: REF_ONLY_API_PROVIDER_ID,
          keyRef: { source: "env" as const, provider: "default", id: REF_ONLY_API_ENV },
        },
        [`${REF_ONLY_TOKEN_PROVIDER_ID}:default`]: {
          type: "token" as const,
          provider: REF_ONLY_TOKEN_PROVIDER_ID,
          tokenRef: { source: "env" as const, provider: "default", id: REF_ONLY_TOKEN_ENV },
        },
      },
    };
    const input = createPreparedModelCatalogWorkerInput({
      agentFacts: {
        input: {
          agentId: "main",
          agentDir: fixture.agentDir,
          workspaceDir: fixture.workspaceDir,
          config: fixture.config,
          env: fixture.env,
        },
        env: fixture.env,
        authStore,
        credentials: {},
        providerIds: [PROVIDER_ID],
        configuredModelRefs: [],
        configuredRuntimeModels: [],
        configuredGeneratedCatalogPluginIds: [],
        templateAuthStorage: AuthStorage.inMemory({}),
      } satisfies PreparedModelRuntimeAgentFacts,
      pluginMetadataSnapshot: fixture.pluginMetadataSnapshot,
    });

    const catalog = await runPreparedModelCatalogWorker({ input, isCurrent: () => true });

    expect(catalog.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "ref-proof-api-true-token-true",
      }),
    );
  });
});
