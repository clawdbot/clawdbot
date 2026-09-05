import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import type { PreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog-auth.js";
import { loadPluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import {
  HARNESS_ID,
  PLUGIN_ID,
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
  UNRELATED_PLUGIN_ID,
  UNRELATED_PLUGIN_WORKER_MARKER_ENV,
  writeFixturePlugin,
  writeUnrelatedFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import {
  getPreparedModelFullCatalogAuth,
  getPreparedModelRuntimeAuthStore,
} from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import {
  markPluginMetadataSnapshotProvided,
  usePreparedCatalogWorkerFixtures,
} from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();
const BUNDLED_PROVIDER_ID = "worker-refreshable-fixture";
const BUNDLED_MODEL_ID = "discovered-model";

function writeBundledRefreshableProvider(bundledRoot: string): void {
  const pluginDir = path.join(bundledRoot, BUNDLED_PROVIDER_ID);
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.writeFileSync(
    path.join(pluginDir, "package.json"),
    JSON.stringify({
      name: "@fixture/worker-refreshable",
      version: "1.0.0",
      openclaw: { extensions: ["./index.cjs"] },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: BUNDLED_PROVIDER_ID,
      activation: { onStartup: false },
      enabledByDefault: true,
      providers: [BUNDLED_PROVIDER_ID],
      modelCatalog: { discovery: { [BUNDLED_PROVIDER_ID]: "refreshable" } },
      syntheticAuthRefs: [BUNDLED_PROVIDER_ID],
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "index.cjs"),
    `module.exports = {
  id: ${JSON.stringify(BUNDLED_PROVIDER_ID)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(BUNDLED_PROVIDER_ID)},
      label: "Refreshable bundled provider",
      auth: [],
      resolveSyntheticAuth: () => ({
        apiKey: "worker-fixture-local-not-real",
        source: "fixture local service",
        mode: "api-key",
      }),
      catalog: {
        run: () => ({ provider: {
          baseUrl: "https://worker-catalog.invalid/v1",
          api: "openai-completions",
          models: [{ id: ${JSON.stringify(BUNDLED_MODEL_ID)}, name: "Discovered model" }],
        } }),
      },
    });
  },
};
`,
    "utf8",
  );
}

describe("prepared model catalog worker plugin scope", () => {
  it("keeps catalog contributors on the models.list route without importing unrelated plugins", async () => {
    const root = makeTempDir("openclaw-model-catalog-scope-worker-");
    const stateDir = path.join(root, "state");
    const agentDir = path.join(stateDir, "agents", "main", "agent");
    const workspaceDir = path.join(root, "workspace");
    const marker = path.join(root, "worker-marker.txt");
    const unrelatedMarker = path.join(root, "unrelated-worker-plugin.txt");
    fs.mkdirSync(agentDir, { recursive: true });
    fs.mkdirSync(workspaceDir, { recursive: true });

    const pluginFile = writeFixturePlugin({ root, spinMs: 0 });
    const unrelatedPluginFile = writeUnrelatedFixturePlugin(root);
    const bundledRoot = path.join(root, "bundled");
    writeBundledRefreshableProvider(bundledRoot);
    const config = {
      agents: {
        defaults: {
          model: `${PROVIDER_ID}/sqlite-model`,
          models: {
            [`${PROVIDER_ID}/sqlite-model`]: { agentRuntime: { id: HARNESS_ID } },
            [`${BUNDLED_PROVIDER_ID}/*`]: { agentRuntime: { id: "openclaw" } },
          },
        },
        list: [{ id: "main", default: true, agentDir, workspace: workspaceDir }],
      },
      models: {
        providers: {
          [BUNDLED_PROVIDER_ID]: {
            api: "openai-completions",
            baseUrl: "https://worker-catalog.invalid/v1",
            models: [],
          },
        },
      },
      plugins: {
        allow: [PLUGIN_ID, UNRELATED_PLUGIN_ID, BUNDLED_PROVIDER_ID],
        load: { paths: [pluginFile, unrelatedPluginFile] },
        entries: {
          [PLUGIN_ID]: { enabled: true },
          [UNRELATED_PLUGIN_ID]: { enabled: true },
          [BUNDLED_PROVIDER_ID]: { enabled: true },
        },
      },
    } satisfies OpenClawConfig;
    const env = {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "0",
      OPENCLAW_BUNDLED_PLUGINS_DIR: bundledRoot,
      OPENCLAW_STATE_DIR: stateDir,
      OPENCLAW_WORKER_CATALOG_MARKER: marker,
      [UNRELATED_PLUGIN_WORKER_MARKER_ENV]: unrelatedMarker,
      [REF_ONLY_API_ENV]: "ref-only-api-secret-not-real",
      [REF_ONLY_TOKEN_ENV]: "ref-only-token-secret-not-real",
    };
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir, store: { version: 1, profiles: {} } }]);

    const input = {
      agentId: "main",
      agentDir,
      inheritedAuthDir: agentDir,
      workspaceDir,
      config,
      env,
      runtimePluginSelections: [
        { provider: PROVIDER_ID, modelId: "sqlite-model", runtime: HARNESS_ID },
      ],
    };
    let current = true;
    retireAfterTest(() => {
      current = false;
      unregisterResolvedAgentDir({ agentId: "main", agentDir, env });
    });
    const prepared = (
      await startSerializedSnapshotBuildBatch(
        [
          {
            input,
            catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
            isGenerationCurrent: () => current,
            isBuildCurrent: () => current,
          },
        ],
        new Map(),
        30_000,
        "static",
        undefined,
        markPluginMetadataSnapshotProvided(
          loadPluginMetadataSnapshot({ config, env, workspaceDir }),
        ),
      ).pending
    )[0];
    if (!prepared) {
      throw new Error("prepared runtime produced no snapshot");
    }
    expect(prepared.snapshot.metadataSnapshot.plugins).toContainEqual(
      expect.objectContaining({ id: BUNDLED_PROVIDER_ID, origin: "bundled" }),
    );
    const authStore = getPreparedModelRuntimeAuthStore(prepared.snapshot);
    if (!authStore) {
      throw new Error("prepared runtime produced no auth store");
    }
    const projectSnapshot = async (full: boolean): Promise<PreparedGatewayModelCatalogSnapshot> => {
      const modelCatalog = full
        ? await prepared.snapshot.loadFullModelCatalog!()
        : prepared.snapshot.modelCatalog;
      const auth = full
        ? expectDefined(getPreparedModelFullCatalogAuth(modelCatalog), "full catalog auth")
        : { authModes: prepared.snapshot.authModes, authStore };
      return {
        ...modelCatalog,
        agentId: "main",
        agentDir,
        workspaceDir,
        config,
        observationConfig: prepared.snapshot.observationConfig,
        isCurrent: prepared.snapshot.isCurrent,
        pluginRegistry: prepared.snapshot.pluginRegistry,
        catalogComplete: full,
        ...auth,
        metadataSnapshot: prepared.snapshot.metadataSnapshot,
        authMaterializations: [],
      };
    };
    const loadGatewayModelCatalogSnapshot: GatewayRequestContext["loadGatewayModelCatalogSnapshot"] =
      async (params) => {
        const {
          authModes: _authModes,
          authStore: _authStore,
          metadataSnapshot: _metadataSnapshot,
          authMaterializations: _authMaterializations,
          observationConfig: _observationConfig,
          isCurrent: _isCurrent,
          pluginRegistry: _pluginRegistry,
          ...snapshot
        } = await projectSnapshot(params?.readOnly === false);
        return snapshot;
      };
    registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
      loadDeferred: async (params) => await projectSnapshot(params?.readOnly === false),
      readPrepared: async () => await projectSnapshot(false),
    });
    const respond = vi.fn();
    const context = Object.assign({} as GatewayRequestContext, {
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot,
      logGateway: { debug: vi.fn(), warn: vi.fn() },
    });
    await expectDefined(
      modelsHandlers["models.list"],
      'modelsHandlers["models.list"] test invariant',
    )({
      req: { type: "req", id: "models-list-worker-scope", method: "models.list", params: {} },
      params: { view: "all" },
      respond: respond as RespondFn,
      client: null,
      isWebchatConnect: () => false,
      context,
    });

    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        models: expect.arrayContaining([
          expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
        ]),
      }),
      undefined,
    );
    expect(fs.existsSync(unrelatedMarker)).toBe(false);
    expect(respond).toHaveBeenCalledWith(
      true,
      expect.objectContaining({
        models: expect.arrayContaining([
          expect.objectContaining({
            provider: BUNDLED_PROVIDER_ID,
            id: BUNDLED_MODEL_ID,
            available: true,
          }),
        ]),
      }),
      undefined,
    );
  });
});
