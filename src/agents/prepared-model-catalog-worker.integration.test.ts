import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
} from "../gateway/server-model-catalog.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { closeOpenClawAgentDatabasesForTest } from "../state/openclaw-agent-db.js";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "./auth-profiles/constants.js";
import { getRuntimeExternalCliProfileIds } from "./auth-profiles/runtime-external-profile-references.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./auth-profiles/runtime-snapshots.js";
import { ensureAuthProfileStore, saveAuthProfileStore } from "./auth-profiles/store.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
import {
  createPreparedModelCatalogWorker,
  createPreparedModelCatalogWorkerInput,
} from "./prepared-model-catalog-worker.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
  setPreparedModelRuntimeAuthLoader,
} from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuild } from "./prepared-model-runtime.build.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import {
  markPluginMetadataSnapshotProvided,
  writeSyntheticAuthDiscoveryFixture,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const PROVIDER_ID = "worker-catalog-fixture";
const HARNESS_ID = "worker-catalog-fixture-harness";
const UNRELATED_SYNTHETIC_AUTH_ID = `${PROVIDER_ID}-unrelated-harness`;
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
const EXTERNAL_AUTH_PROFILE_ID = `${PROVIDER_ID}:external`;
const EXTERNAL_AUTH_PATH_ENV = "OPENCLAW_WORKER_EXTERNAL_AUTH_PATH";
const tempDirs = useAutoCleanupTempDirTracker((cleanup) => {
  afterEach(() => {
    resetPreparedModelRuntimeSnapshotsForTest();
    clearRuntimeAuthProfileStoreSnapshots();
    closeOpenClawAgentDatabasesForTest();
    cleanup();
  });
});

function createJwtWithExp(exp: number, marker?: string): string {
  const payload = Buffer.from(JSON.stringify({ exp, ...(marker ? { marker } : {}) })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

function writeCodexAuth(codexHome: string, marker: string): void {
  const authPath = path.join(codexHome, "auth.json");
  fs.writeFileSync(
    authPath,
    JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: createJwtWithExp(Math.floor(Date.now() / 1000) + 3600, marker),
        refresh_token: `refresh-${marker}-not-real`,
      },
    }),
    "utf8",
  );
  const future = new Date(Date.now() + 2_000);
  fs.utimesSync(authPath, future, future);
}

function writeFixturePlugin(params: {
  root: string;
  spinMs: number;
  pluginVersion?: string;
}): string {
  const pluginDir = path.join(params.root, "plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, "index.cjs");
  writeSyntheticAuthDiscoveryFixture({
    root: params.root,
    pluginDir,
    harnessId: HARNESS_ID,
    unrelatedId: UNRELATED_SYNTHETIC_AUTH_ID,
  });
  fs.writeFileSync(
    pluginFile,
    `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.registerAgentHarness({
      id: ${JSON.stringify(HARNESS_ID)},
      label: "Worker catalog fixture harness",
      supports: () => ({ supported: true }),
      runAttempt: async () => ({ ok: false, error: "unused" }),
      loadModelCatalog: async () => [{
        provider: ${JSON.stringify(PROVIDER_ID)},
        id: "account-scoped-model",
        name: "Account scoped model",
        api: "openai-completions",
        baseUrl: "https://worker-catalog.invalid/v1",
      }],
    });
    api.registerProvider({
      id: ${JSON.stringify(PROVIDER_ID)},
      label: "Worker catalog fixture",
      auth: [],
      resolveExternalAuthProfiles() {
        const credentialPath = process.env[${JSON.stringify(EXTERNAL_AUTH_PATH_ENV)}];
        if (!credentialPath || !fs.existsSync(credentialPath)) {
          return [];
        }
        const credentialMarker = fs.readFileSync(credentialPath, "utf8").trim();
        return [{
          profileId: ${JSON.stringify(EXTERNAL_AUTH_PROFILE_ID)},
          credential: {
            type: "oauth",
            provider: ${JSON.stringify(PROVIDER_ID)},
            access: ${JSON.stringify(params.pluginVersion ?? "v1")} + ":" + credentialMarker,
            refresh: "refresh-" + credentialMarker + "-not-real",
            expires: Date.now() + 60_000,
          },
        }];
      },
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
                id: ${JSON.stringify(`plugin-generation-${params.pluginVersion ?? "v1"}`)},
                name: "Plugin generation proof",
              },
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
      async augmentModelCatalog(context) {
        const marker = process.env.OPENCLAW_WORKER_CATALOG_MARKER;
        const invocation = fs.existsSync(marker)
          ? fs.readFileSync(marker, "utf8").split("start\\n").length
          : 1;
        fs.appendFileSync(process.env.OPENCLAW_WORKER_CATALOG_MARKER, "start\\n");
        const barrier = marker + ".hold";
        if (fs.existsSync(barrier)) {
          await new Promise((resolve) => {
            const watcher = fs.watch(require("node:path").dirname(barrier), () => {
              if (!fs.existsSync(barrier)) { watcher.close(); resolve(); }
            });
            if (!fs.existsSync(barrier)) { watcher.close(); resolve(); }
          });
        }
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
      cliBackends: [HARNESS_ID, UNRELATED_SYNTHETIC_AUTH_ID],
      syntheticAuthRefs: [HARNESS_ID, UNRELATED_SYNTHETIC_AUTH_ID],
      providerCatalogEntry: "./provider-discovery.cjs",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { externalAuthProviders: [PROVIDER_ID] },
      modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" }, runtimeAugment: true },
    }),
    "utf8",
  );
  return pluginFile;
}

function createCatalogFixture(
  spinMs: number,
  envOverride: NodeJS.ProcessEnv = {},
  options?: {
    hydrateExternalCliProviderIds?: readonly string[];
  },
) {
  const root = tempDirs.make("openclaw-model-catalog-worker-");
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspace");
  const marker = path.join(root, "worker-marker.txt");
  const externalAuthPath = path.join(root, "external-auth.txt");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const pluginFile = writeFixturePlugin({ root, spinMs });
  fs.writeFileSync(externalAuthPath, "A", "utf8");
  const env = {
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_WORKER_CATALOG_MARKER: marker,
    [EXTERNAL_AUTH_PATH_ENV]: externalAuthPath,
    ...envOverride,
    [REF_ONLY_API_ENV]: "ref-only-api-secret-not-real",
    [REF_ONLY_TOKEN_ENV]: "ref-only-token-secret-not-real",
  };
  const config = {
    agents: {
      defaults: {
        model: `${PROVIDER_ID}/sqlite-model`,
        models: {
          [`${PROVIDER_ID}/sqlite-model`]: { agentRuntime: { id: HARNESS_ID } },
        },
      },
    },
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
  const hydratedAuthStore = options?.hydrateExternalCliProviderIds
    ? ensureAuthProfileStore(agentDir, {
        allowKeychainPrompt: false,
        config,
        externalCliProviderIds: options.hydrateExternalCliProviderIds,
        readOnly: true,
        syncExternalCli: false,
      })
    : undefined;
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
  return { agentDir, config, env, marker, externalAuthPath, hydratedAuthStore, root, workspaceDir };
}

async function createStaticSnapshot(
  spinMs: number,
  envOverride: NodeJS.ProcessEnv = {},
  options?: {
    hydrateExternalCliProviderIds?: readonly string[];
    metadataWorkspace?: "gateway" | "none" | "activation";
    provideMetadataToWorker?: boolean;
  },
) {
  const fixture = createCatalogFixture(spinMs, envOverride, options);
  const { agentDir, workspaceDir, config, env, root } = fixture;
  let current = true;
  const loadedMetadataSnapshot = options?.metadataWorkspace
    ? loadPluginMetadataSnapshot({
        config:
          options.metadataWorkspace === "activation"
            ? { ...config, plugins: { ...config.plugins, entries: {} } }
            : config,
        env,
        ...(options.metadataWorkspace === "gateway"
          ? { workspaceDir: path.join(root, "gateway-workspace") }
          : {}),
      })
    : undefined;
  const providedMetadataSnapshot =
    options?.provideMetadataToWorker && loadedMetadataSnapshot
      ? markPluginMetadataSnapshotProvided(loadedMetadataSnapshot)
      : loadedMetadataSnapshot;
  const build = await startSerializedSnapshotBuild(
    { agentId: "main", agentDir, inheritedAuthDir: agentDir, workspaceDir, config, env },
    new Map(),
    30_000,
    "static",
    () => current,
    false,
    undefined,
    providedMetadataSnapshot,
  ).pending;
  return {
    ...fixture,
    pluginMetadataSnapshot: build.pluginGeneration.pluginMetadataSnapshot,
    snapshot: build.snapshot,
    supersede: () => (current = false),
  };
}

async function createReadyWorkerFixture(spinMs: number) {
  const fixture = await createStaticSnapshot(spinMs);
  // Ordering tests begin at discovery, not cold worker/module startup. The normal
  // auth request prepares the same worker without running catalog hooks.
  await loadPreparedModelRuntimeAuth(fixture.snapshot, { providerIds: [] });
  expect(fs.existsSync(fixture.marker)).toBe(false);
  return fixture;
}

async function waitForMarker(marker: string): Promise<void> {
  await expect.poll(() => fs.existsSync(marker), { timeout: 30_000 }).toBe(true);
}

describe("prepared model catalog worker boundary", () => {
  it("keeps an unaffected configured worker live across a scoped sibling reload", async () => {
    const fixture = createCatalogFixture(0);
    // Configured publication reads the process environment; keep both the parent and worker
    // inside the same synthetic plugin/state fixture, without a supplied liveness predicate.
    for (const name of [
      "OPENCLAW_DISABLE_BUNDLED_PLUGINS",
      "OPENCLAW_STATE_DIR",
      "OPENCLAW_WORKER_CATALOG_MARKER",
      EXTERNAL_AUTH_PATH_ENV,
      REF_ONLY_API_ENV,
      REF_ONLY_TOKEN_ENV,
    ] as const) {
      vi.stubEnv(name, fixture.env[name]);
    }
    const siblingDir = path.join(fixture.root, "sibling-agent");
    const initialConfig = {
      ...fixture.config,
      agents: {
        ...fixture.config.agents,
        entries: {
          main: { default: true, agentDir: fixture.agentDir, workspace: fixture.workspaceDir },
          sibling: {
            agentDir: siblingDir,
            workspace: fixture.workspaceDir,
            tools: { exec: { security: "full", ask: "off" } },
          },
        },
      },
    } satisfies OpenClawConfig;
    const buildCounts: number[] = [];
    const options = {
      gatewayLifecycle: true,
      catalogMode: "static" as const,
      onBuildStats: (stats: { agentCount: number }) => buildCounts.push(stats.agentCount),
    };
    const mainInput = { agentId: "main", agentDir: fixture.agentDir, config: initialConfig };
    const siblingInput = { agentId: "sibling", agentDir: siblingDir, config: initialConfig };
    await refreshPreparedModelRuntimeSnapshots(initialConfig, options);
    const main = getPreparedModelRuntimeSnapshot(mainInput)!;
    const sibling = getPreparedModelRuntimeSnapshot(siblingInput)!;
    const catalog = await main.loadFullModelCatalog!();
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
    );
    const authScope = { providerIds: [PROVIDER_ID] };
    await expect(loadPreparedModelRuntimeAuth(sibling, authScope)).resolves.toMatchObject({
      authStore: { profiles: { [EXTERNAL_AUTH_PROFILE_ID]: { access: "v1:A" } } },
    });

    fs.writeFileSync(`${fixture.marker}.hold`, "", "utf8");
    const inFlight = main.loadFullModelCatalog!({ refresh: true });
    void inFlight.catch(() => undefined);
    try {
      await expect.poll(() => fs.readFileSync(fixture.marker, "utf8")).toBe("start\ndone\nstart\n");
      const nextConfig = {
        ...initialConfig,
        agents: {
          ...initialConfig.agents,
          entries: {
            ...initialConfig.agents.entries,
            sibling: {
              ...initialConfig.agents.entries.sibling,
              tools: { exec: { security: "full", ask: "always" } },
            },
          },
        },
      } satisfies OpenClawConfig;
      await refreshPreparedModelRuntimeSnapshots(nextConfig, {
        ...options,
        agentIds: new Set(["sibling"]),
      });
      const retained = getPreparedModelRuntimeSnapshot({ ...mainInput, config: nextConfig })!;
      expect(buildCounts).toEqual([2, 1]);
      expect(retained.modelCatalog).toBe(main.modelCatalog);
      expect(retained.metadataSnapshot).toBe(main.metadataSnapshot);
      expect(retained.readFullModelCatalog!()).toBe(catalog);
      await expect(loadPreparedModelRuntimeAuth(sibling, authScope)).rejects.toThrow("superseded");
      await expect(sibling.loadFullModelCatalog!()).rejects.toThrow("superseded");

      fs.rmSync(`${fixture.marker}.hold`);
      const refreshed = await inFlight;
      expect(refreshed).not.toBe(catalog);
      expect(retained.readFullModelCatalog!()).toBe(refreshed);
      expect(refreshed.entries).toContainEqual(
        expect.objectContaining({ id: "proof-refresh-2-sqlite-true-shared-true-unrelated-true" }),
      );
      fs.writeFileSync(fixture.externalAuthPath, "B", "utf8");
      await expect(loadPreparedModelRuntimeAuth(retained, authScope)).resolves.toMatchObject({
        authStore: { profiles: { [EXTERNAL_AUTH_PROFILE_ID]: { access: "v1:B" } } },
      });
      await expect(retained.loadFullModelCatalog!({ refresh: true })).resolves.toMatchObject({
        entries: expect.arrayContaining([
          expect.objectContaining({ id: "proof-refresh-3-sqlite-true-shared-true-unrelated-true" }),
        ]),
      });
      const replaced = getPreparedModelRuntimeSnapshot({ ...siblingInput, config: nextConfig })!;
      await expect(loadPreparedModelRuntimeAuth(replaced, authScope)).resolves.toMatchObject({
        authStore: { profiles: { [EXTERNAL_AUTH_PROFILE_ID]: { access: "v1:B" } } },
      });
    } finally {
      fs.rmSync(`${fixture.marker}.hold`, { force: true });
      await Promise.allSettled([inFlight]);
    }
  });

  it.each([
    ["gateway", "catalog"],
    ["gateway", "auth-refresh"],
    ["none", "catalog"],
    ["none", "auth-refresh"],
    ["activation", "catalog"],
    ["activation", "auth-refresh"],
  ] as const)(
    "keeps %s metadata discovery scope with %s first",
    async (metadataWorkspace, first) => {
      const fixture = await createStaticSnapshot(0, {}, { metadataWorkspace });
      if (first === "auth-refresh") {
        const auth = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
          providerIds: [PROVIDER_ID],
        });
        expect(auth?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
          access: "v1:A",
        });
      }
      const catalog = await fixture.snapshot.loadFullModelCatalog?.();
      expect(catalog?.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
      );
    },
  );

  it("publishes account-scoped harness models only in the full catalog", async () => {
    const fixture = await createStaticSnapshot(0);

    expect(fixture.snapshot.modelCatalog.entries).not.toContainEqual(
      expect.objectContaining({ id: "account-scoped-model" }),
    );

    const catalog = await fixture.snapshot.loadFullModelCatalog?.();

    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "account-scoped-model",
      }),
    );
  });

  it("preserves exact configured native auth across a full catalog refresh", async () => {
    const fixture = await createStaticSnapshot(
      0,
      {},
      {
        metadataWorkspace: "none",
        provideMetadataToWorker: true,
      },
    );
    const syntheticAuthProbePath = path.join(fixture.root, "synthetic-auth-probes.txt");

    expect(fixture.snapshot.authModes[HARNESS_ID]).toBe("api_key");
    expect(fixture.snapshot.authModes[PROVIDER_ID]).toBeUndefined();
    fs.rmSync(fixture.externalAuthPath);
    fs.writeFileSync(syntheticAuthProbePath, "", "utf8");
    await loadPreparedModelRuntimeAuth(fixture.snapshot, { providerIds: [] });
    fs.writeFileSync(syntheticAuthProbePath, "", "utf8");

    const catalog = await fixture.snapshot.loadFullModelCatalog?.({ refresh: true });
    const fullAuth = getPreparedModelFullCatalogAuth(catalog!);

    expect(fs.readFileSync(syntheticAuthProbePath, "utf8").trim().split("\n")).toEqual([
      HARNESS_ID,
    ]);
    expect(fullAuth?.authModes[HARNESS_ID]).toBe("api_key");
    expect(fullAuth?.authModes[PROVIDER_ID]).toBeUndefined();
  });

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

  it("preserves a materialized SecretRef when durable auth retains only its descriptor", async () => {
    const fixture = await createStaticSnapshot(0);
    saveAuthProfileStore(
      {
        version: 1,
        profiles: {
          [PROFILE_ID]: {
            type: "token",
            provider: SHARED_AUTH_PROVIDER_ID,
            tokenRef: { source: "env", provider: "default", id: "SHARED_SECRET_REF" },
          },
        },
      },
      fixture.agentDir,
    );

    const catalog = await fixture.snapshot.loadFullModelCatalog?.();

    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "proof-refresh-1-sqlite-true-shared-true-unrelated-true",
      }),
    );
    expect(getPreparedModelFullCatalogAuth(catalog!)).toMatchObject({
      authStore: {
        profiles: {
          [PROFILE_ID]: expect.objectContaining({
            token: MATERIALIZED_SECRET,
            tokenRef: { source: "env", provider: "default", id: "SHARED_SECRET_REF" },
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
      const fullCatalog = await fixture.snapshot.loadFullModelCatalog?.({ refresh: true });
      const fullAuth = fullCatalog && getPreparedModelFullCatalogAuth(fullCatalog);
      if (!fullAuth) {
        throw new Error("full catalog omitted prepared auth");
      }
      return await loadPreparedGatewayModelCatalogSnapshot({
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
      const loadProjectedCatalogSnapshot = async () => projected;
      registerGatewayModelCatalogPrivateAccess(loadProjectedCatalogSnapshot, {
        loadDeferred: async () => projected,
        readPrepared: async () => projected,
      });
      const context = {
        getRuntimeConfig: () => config,
        loadGatewayModelCatalogSnapshot: loadProjectedCatalogSnapshot,
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

  it("refreshes plugin external auth without changing the prepared plugin generation", async () => {
    const fixture = await createStaticSnapshot(0);
    fs.rmSync(fixture.externalAuthPath);
    const loggedOutAtStartup = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [PROVIDER_ID],
    });
    expect(loggedOutAtStartup?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toBeUndefined();

    fs.writeFileSync(fixture.externalAuthPath, "A", "utf8");
    const loggedIn = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [PROVIDER_ID],
    });
    expect(loggedIn?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
      access: "v1:A",
    });

    writeFixturePlugin({ root: fixture.root, spinMs: 0, pluginVersion: "v2" });
    fs.writeFileSync(fixture.externalAuthPath, "B", "utf8");

    const refreshed = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [PROVIDER_ID],
    });
    expect(refreshed?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
      access: "v1:B",
    });

    const catalog = await fixture.snapshot.loadFullModelCatalog?.({ refresh: true });
    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "plugin-generation-v1",
      }),
    );
    expect(catalog?.entries).not.toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "plugin-generation-v2",
      }),
    );
    expect(
      getPreparedModelFullCatalogAuth(catalog!)?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID],
    ).toMatchObject({ access: "v1:B" });

    fs.rmSync(fixture.externalAuthPath);
    const loggedOut = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [PROVIDER_ID],
    });
    expect(loggedOut?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toBeUndefined();
  });

  it("makes a post-startup Codex login available to direct models.list", async () => {
    // A developer's ambient OpenAI key would count as usable openai auth and
    // mark the route available before the staged Codex login exists.
    vi.stubEnv("OPENAI_API_KEY", undefined);
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
      plugins: {
        ...fixture.config.plugins,
        entries: {
          ...fixture.config.plugins?.entries,
          // This test proves auth-store refresh, not harness discovery. A live
          // model/list against a developer's real Codex login would mark the
          // route available before the staged auth.json exists.
          codex: { config: { discovery: { enabled: false } } },
        },
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
      const loadSnapshot = async (
        loadParams: Parameters<typeof loadGatewayModelCatalogSnapshot>[0],
      ) =>
        await loadGatewayModelCatalogSnapshot({
          ...loadParams,
          getConfig: () => config,
          loadPublishedPreparedModelCatalogOwnerSnapshot: async () => owner,
        });
      registerGatewayModelCatalogPrivateAccess(loadSnapshot, {
        loadDeferred: (loadParams) =>
          loadPreparedGatewayModelCatalogSnapshot({
            ...loadParams,
            getConfig: () => config,
            loadPublishedPreparedModelCatalogOwnerSnapshot: async () => owner,
            refreshAuth: true,
          }),
        readPrepared: async () => undefined,
      });
      const context = {
        getRuntimeConfig: () => config,
        loadGatewayModelCatalogSnapshot: loadSnapshot,
        logGateway: { debug: () => undefined },
      } as unknown as GatewayRequestContext;
      return await buildModelsListResult({ context, params: { view: "all", refresh: true } });
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

  it("refreshes and removes a Codex login that existed in the prepared generation", async () => {
    const codexHome = tempDirs.make("openclaw-prepared-codex-");
    writeCodexAuth(codexHome, "startup");
    const previousCodexHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    let fixture: Awaited<ReturnType<typeof createStaticSnapshot>>;
    try {
      fixture = await createStaticSnapshot(0, {}, { hydrateExternalCliProviderIds: ["openai"] });
    } finally {
      if (previousCodexHome === undefined) {
        delete process.env.CODEX_HOME;
      } else {
        process.env.CODEX_HOME = previousCodexHome;
      }
    }
    const preparedStore = getPreparedModelRuntimeAuthStore(fixture.snapshot);
    expect(fixture.hydratedAuthStore?.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      type: "oauth",
      refresh: "refresh-startup-not-real",
    });
    expect(preparedStore?.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      type: "oauth",
      refresh: "refresh-startup-not-real",
    });
    expect(preparedStore && getRuntimeExternalCliProfileIds(preparedStore)).toEqual([
      OPENAI_CODEX_DEFAULT_PROFILE_ID,
    ]);

    writeCodexAuth(codexHome, "rotated");
    const rotated = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [],
      profileIds: [OPENAI_CODEX_DEFAULT_PROFILE_ID],
    });
    expect(rotated?.authStore.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toMatchObject({
      type: "oauth",
      refresh: "refresh-rotated-not-real",
    });

    fs.rmSync(path.join(codexHome, "auth.json"));
    const loggedOut = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: ["openai"],
    });
    expect(loggedOut?.authStore.profiles[OPENAI_CODEX_DEFAULT_PROFILE_ID]).toBeUndefined();
  });

  it("shares in-flight discovery, caches completion, and explicitly refreshes prepared facts", async () => {
    const fixture = await createReadyWorkerFixture(750);
    let settled = false;
    const first = fixture.snapshot.loadFullModelCatalog?.().finally(() => {
      settled = true;
    });
    const second = fixture.snapshot.loadFullModelCatalog?.();
    const completion = Promise.all([first, second]);
    void completion.catch(() => {});
    try {
      await waitForMarker(fixture.marker);

      expect(settled).toBe(false);
      const [catalog, sharedCatalog] = await completion;
      expect(sharedCatalog).toBe(catalog);
      expect(catalog?.entries).toContainEqual(
        expect.objectContaining({
          provider: PROVIDER_ID,
          id: "proof-refresh-1-sqlite-true-shared-true-unrelated-true",
        }),
      );
      await expect(fixture.snapshot.loadFullModelCatalog?.()).resolves.toBe(catalog);
      await expect(fixture.snapshot.loadFullModelCatalog?.({ refresh: true })).resolves.toEqual(
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
    } finally {
      fixture.supersede();
      await Promise.allSettled([completion]);
    }
  });

  it("terminates discovery when its owning generation is superseded", async () => {
    const fixture = await createReadyWorkerFixture(10_000);
    const catalog = fixture.snapshot.loadFullModelCatalog?.();
    void catalog?.catch(() => {});
    try {
      await waitForMarker(fixture.marker);
      fixture.supersede();

      await expect(catalog).rejects.toThrow("superseded");
      await new Promise<void>((resolve) => {
        setTimeout(resolve, 100);
      });
      expect(fs.readFileSync(fixture.marker, "utf8")).toBe("start\n");
    } finally {
      fixture.supersede();
      await Promise.allSettled([catalog]);
    }
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
        runtimeCapabilityModels: [],
        configuredGeneratedCatalogPluginIds: [],
        templateAuthStorage: AuthStorage.inMemory({}),
      } satisfies PreparedModelRuntimeAgentFacts,
      pluginMetadataSnapshot: fixture.pluginMetadataSnapshot,
    });

    const catalog = await createPreparedModelCatalogWorker({
      input,
      isCurrent: () => true,
    }).loadCatalog();

    expect(catalog.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "ref-proof-api-true-token-true",
      }),
    );
  });
});
