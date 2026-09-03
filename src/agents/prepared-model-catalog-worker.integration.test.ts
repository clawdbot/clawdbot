import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { buildModelsListResult } from "../gateway/server-methods/models-list-result.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import {
  loadGatewayModelCatalogSnapshot,
  loadPreparedGatewayModelCatalogSnapshot,
} from "../gateway/server-model-catalog.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { resolveAgentDir, resolveAgentWorkspaceDir } from "./agent-scope-config.js";
import { OPENAI_CODEX_DEFAULT_PROFILE_ID } from "./auth-profiles/constants.js";
import { getRuntimeExternalCliProfileIds } from "./auth-profiles/runtime-external-profile-references.js";
import { saveAuthProfileStore } from "./auth-profiles/store.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import {
  createPreparedModelCatalogWorker,
  createPreparedModelCatalogWorkerInput,
} from "./prepared-model-catalog-worker.js";
import {
  DISCOVERED_HARNESS_ID,
  PROVIDER_ID,
  HARNESS_ID,
  MISSING_AUTH_HARNESS_ID,
  SHARED_AUTH_PROVIDER_ID,
  PROFILE_ID,
  MATERIALIZED_SECRET,
  REF_ONLY_API_PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_PROVIDER_ID,
  REF_ONLY_TOKEN_ENV,
  DURABLE_AUTH_PROVIDER_ID,
  DURABLE_AUTH_KEY,
  EXTERNAL_AUTH_PROFILE_ID,
  EXTERNAL_AUTH_PATH_ENV,
  createCatalogFixture,
  createJwtWithExp,
  writeCodexAuth,
  writeFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthStore,
  loadPreparedModelRuntimeAuth,
  setPreparedModelRuntimeAuthLoader,
} from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import type { PreparedModelRuntimeAgentFacts } from "./prepared-model-runtime.catalog-contract.js";
import {
  getPreparedModelRuntimeSnapshot,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";
import { AuthStorage } from "./sessions/auth-storage.js";
import {
  markPluginMetadataSnapshotProvided,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest, waitForWorkers, waitForMarker } =
  usePreparedCatalogWorkerFixtures();

async function createStaticSnapshot(
  spinMs: number,
  envOverride: NodeJS.ProcessEnv = {},
  options?: {
    hydrateExternalCliProviderIds?: readonly string[];
    builtPluginVersion?: string;
    asyncSyntheticAuth?: boolean;
    prepareInboundPluginRegistry?: boolean;
    readOnly?: boolean;
    metadataWorkspace?: "gateway" | "none" | "activation";
    provideMetadataToWorker?: boolean;
  },
) {
  const fixture = createCatalogFixture(makeTempDir, spinMs, envOverride, options);
  const { agentDir, workspaceDir, config, env, root } = fixture;
  const input = {
    agentId: "main",
    agentDir,
    inheritedAuthDir: agentDir,
    workspaceDir,
    config,
    env,
    ...(options?.readOnly ? { readOnly: true } : {}),
  };
  let current = true;
  const isCurrent = () => current;
  const supersede = () => {
    current = false;
  };
  retireAfterTest(supersede);
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
  const results = await startSerializedSnapshotBuildBatch(
    [
      {
        input,
        catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
        isGenerationCurrent: isCurrent,
        isBuildCurrent: isCurrent,
        prepareInboundPluginRegistry: options?.prepareInboundPluginRegistry,
      },
    ],
    new Map(),
    30_000,
    "static",
    undefined,
    providedMetadataSnapshot,
  ).pending;
  const build = results[0]!;
  return {
    ...fixture,
    pluginMetadataSnapshot: build.pluginGeneration.pluginMetadataSnapshot,
    snapshot: build.snapshot,
    isCurrent,
    supersede,
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

describe("prepared model catalog worker boundary", () => {
  beforeEach(() => {
    vi.stubEnv("CODEX_HOME", makeTempDir("openclaw-worker-empty-codex-"));
  });

  it.each([
    { owner: "configured Gateway", prepareInboundPluginRegistry: true, version: "built" },
    { owner: "standalone", prepareInboundPluginRegistry: false, version: "v1" },
  ])("keeps the $owner artifact selection in catalog and auth workers", async (selection) => {
    const fixture = await createStaticSnapshot(
      0,
      {},
      {
        builtPluginVersion: "built",
        prepareInboundPluginRegistry: selection.prepareInboundPluginRegistry,
      },
    );
    const catalog = await fixture.snapshot.loadFullModelCatalog!();
    expect.soft(catalog.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: `plugin-generation-${selection.version}`,
      }),
    );
    const auth = await loadPreparedModelRuntimeAuth(fixture.snapshot, {
      providerIds: [PROVIDER_ID],
    });
    expect(auth?.authStore.profiles[EXTERNAL_AUTH_PROFILE_ID]).toMatchObject({
      access: `${selection.version}:A`,
    });
    expect(
      new Set(
        fs
          .readFileSync(path.join(fixture.root, "discovery-artifacts.txt"), "utf8")
          .trim()
          .split("\n"),
      ),
    ).toEqual(new Set([selection.version]));
  });

  it("keeps explicit read-only full inventories discoverable without a runtime registry", async () => {
    const fixture = await createStaticSnapshot(0, {}, { readOnly: true });
    expect(fixture.snapshot.pluginRegistry).toBeUndefined();

    const catalog = await fixture.snapshot.loadFullModelCatalog!();
    expect(catalog.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
    );
  });

  it("preserves prepared catalog ownership across ambient environment changes", async () => {
    const homeA = makeTempDir("openclaw-catalog-owner-home-a-");
    const homeB = makeTempDir("openclaw-catalog-owner-home-b-");
    const codexHome = makeTempDir("openclaw-catalog-owner-empty-codex-");
    vi.stubEnv("HOME", homeA);
    vi.stubEnv("OPENCLAW_HOME", homeA);
    vi.stubEnv("CODEX_HOME", codexHome);
    const fixture = createCatalogFixture(makeTempDir, 0);
    vi.stubEnv("OPENCLAW_STATE_DIR", fixture.env.OPENCLAW_STATE_DIR);
    const config = {
      ...fixture.config,
      agents: { ...fixture.config.agents, entries: { main: {} } },
    } satisfies OpenClawConfig;
    const agentDir = resolveAgentDir(config, "main", fixture.env);
    const workspaceDir = resolveAgentWorkspaceDir(config, "main", fixture.env);
    expect(agentDir).toBe(fixture.agentDir);
    const input = {
      agentId: "main",
      agentDir,
      inheritedAuthDir: agentDir,
      config,
      env: fixture.env,
    };
    let current = true;
    const supersede = () => {
      current = false;
    };
    retireAfterTest(supersede);
    const isCurrent = () => current;
    const build = startSerializedSnapshotBuildBatch(
      [
        {
          input,
          catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
          isGenerationCurrent: isCurrent,
          isBuildCurrent: isCurrent,
        },
      ],
      new Map(),
      30_000,
      "static",
    );
    let snapshot: Awaited<typeof build.pending>[number]["snapshot"] | undefined;
    let driftedAgentDir: string | undefined;
    try {
      snapshot = (await build.pending)[0]!.snapshot;
      const modelCatalog = await snapshot.loadFullModelCatalog!();
      expect(modelCatalog.entries).toContainEqual(
        expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
      );
      const auth = getPreparedModelFullCatalogAuth(modelCatalog)!;
      const candidate = { ...snapshot, ...auth, modelCatalog };
      const project = () =>
        loadPreparedGatewayModelCatalogSnapshot({
          getConfig: () => config,
          loadPublishedPreparedModelCatalogOwnerSnapshot: async () => candidate,
        });
      const expectedOwner = { agentId: "main", agentDir, workspaceDir, catalogComplete: true };
      await expect(project()).resolves.toMatchObject(expectedOwner);

      vi.stubEnv("HOME", homeB);
      vi.stubEnv("OPENCLAW_HOME", homeB);
      vi.stubEnv("OPENCLAW_STATE_DIR", path.join(homeB, "state"));
      driftedAgentDir = resolveAgentDir(config, "main");
      expect(driftedAgentDir).not.toBe(agentDir);
      expect(resolveAgentWorkspaceDir(config, "main")).not.toBe(workspaceDir);
      await expect(project()).resolves.toMatchObject(expectedOwner);
    } finally {
      supersede();
      await build.completion;
      if (snapshot) {
        // Requesting after retirement also closes the fixture worker immediately.
        await Promise.allSettled([loadPreparedModelRuntimeAuth(snapshot, { providerIds: [] })]);
      }
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env: fixture.env });
      if (driftedAgentDir) {
        unregisterResolvedAgentDir({ agentId: "main", agentDir: driftedAgentDir });
      }
      vi.unstubAllEnvs();
    }
  });

  it("keeps an unaffected configured worker live across a scoped sibling reload", async () => {
    const fixture = createCatalogFixture(makeTempDir, 0);
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

  it.each([false, true])(
    "pairs full catalog native routes with exact-generation auth (async: %s)",
    async (asyncSyntheticAuth) => {
      const fixture = await createStaticSnapshot(
        0,
        {},
        {
          metadataWorkspace: "none",
          provideMetadataToWorker: true,
          asyncSyntheticAuth,
        },
      );
      const syntheticAuthProbePath = path.join(fixture.root, "synthetic-auth-probes.txt");

      expect(fixture.snapshot.authModes[HARNESS_ID]).toBe("api_key");
      expect(fixture.snapshot.authModes[DISCOVERED_HARNESS_ID]).toBeUndefined();
      expect(fixture.snapshot.authModes[MISSING_AUTH_HARNESS_ID]).toBeUndefined();
      expect(fixture.snapshot.authModes[PROVIDER_ID]).toBeUndefined();
      fs.writeFileSync(syntheticAuthProbePath, "", "utf8");
      await loadPreparedModelRuntimeAuth(fixture.snapshot, { providerIds: [] });
      fs.writeFileSync(syntheticAuthProbePath, "", "utf8");

      const catalog = await fixture.snapshot.loadFullModelCatalog?.({ refresh: true });
      const fullAuth = getPreparedModelFullCatalogAuth(catalog!);

      if (asyncSyntheticAuth) {
        expect(
          fs
            .readFileSync(path.join(fixture.root, "synthetic-auth-owner.txt"), "utf8")
            .trim()
            .split("\n"),
        ).toContain("parent");
      } else {
        expect(fs.readFileSync(syntheticAuthProbePath, "utf8").trim().split("\n")).toEqual([
          HARNESS_ID,
          DISCOVERED_HARNESS_ID,
          MISSING_AUTH_HARNESS_ID,
        ]);
      }
      expect(fullAuth?.authModes[HARNESS_ID]).toBe("api_key");
      expect(fullAuth?.authModes[DISCOVERED_HARNESS_ID]).toBe("api_key");
      expect(fullAuth?.authModes[MISSING_AUTH_HARNESS_ID]).toBeUndefined();
      expect(fullAuth?.authModes[PROVIDER_ID]).toBe("oauth");
    },
  );

  it("aborts and joins parent auth preparation before retiring a superseded catalog", async () => {
    const fixture = await createStaticSnapshot(0, {}, { asyncSyntheticAuth: true });
    const hold = path.join(fixture.root, "synthetic-auth-hold");
    const started = path.join(fixture.root, "synthetic-auth-owner.txt");
    const cancelled = path.join(fixture.root, "synthetic-auth-cancel.txt");
    fs.rmSync(started, { force: true });
    fs.writeFileSync(hold, "");
    let settled = false;
    const catalog = fixture.snapshot.loadFullModelCatalog!().finally(() => {
      settled = true;
    });
    void catalog.catch(() => {});
    try {
      await waitForMarker(started);
      fixture.supersede();
      await waitForMarker(cancelled);
      expect(settled).toBe(false);
      fs.rmSync(hold);
      await expect(catalog).rejects.toThrow("superseded");
      expect(fs.readFileSync(cancelled, "utf8")).toBe("abort\njoined\n");
      await waitForWorkers();
    } finally {
      fs.rmSync(hold, { force: true });
      fixture.supersede();
      await Promise.allSettled([catalog]);
    }
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
        models: expect.arrayContaining([
          expect.objectContaining({ id: "durable-model", available: true }),
        ]),
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
    expect(removed.result.models).toContainEqual(
      expect.objectContaining({ id: "durable-model", available: false }),
    );
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
    const codexHome = makeTempDir("openclaw-models-list-codex-");
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

    expect((await listModels()).models).toContainEqual(
      expect.objectContaining({ id: "gpt-5.4", available: false }),
    );
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

    expect((await listModels()).models).toContainEqual(
      expect.objectContaining({ id: "gpt-5.4", available: true }),
    );
    fs.rmSync(path.join(codexHome, "auth.json"));
    expect((await listModels()).models).toContainEqual(
      expect.objectContaining({ id: "gpt-5.4", available: false }),
    );
  });

  it("refreshes and removes a Codex login that existed in the prepared generation", async () => {
    const codexHome = makeTempDir("openclaw-prepared-codex-");
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
    const fixture = await createReadyWorkerFixture(0);
    const barrier = `${fixture.marker}.hold`;
    // Keep discovery pending for both callers without relying on parent-thread scheduling.
    fs.writeFileSync(barrier, "", "utf8");
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
      fs.rmSync(barrier);
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
      fs.rmSync(barrier, { force: true });
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
      await waitForWorkers();
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
      isCurrent: fixture.isCurrent,
    }).loadCatalog();

    expect(catalog.entries).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "ref-proof-api-true-token-true",
      }),
    );
  });
});
