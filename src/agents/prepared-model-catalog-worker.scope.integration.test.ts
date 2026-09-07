import fs from "node:fs";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelsHandlers } from "../gateway/server-methods/models.js";
import type { GatewayRequestContext, RespondFn } from "../gateway/server-methods/types.js";
import { registerGatewayModelCatalogPrivateAccess } from "../gateway/server-model-catalog-auth.js";
import type { PreparedGatewayModelCatalogSnapshot } from "../gateway/server-model-catalog-auth.js";
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
import { getPreparedModelRuntimeAuthStore } from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

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
    const config = {
      agents: {
        defaults: {
          model: `${PROVIDER_ID}/sqlite-model`,
          models: {
            [`${PROVIDER_ID}/sqlite-model`]: { agentRuntime: { id: HARNESS_ID } },
          },
        },
        list: [{ id: "main", default: true, agentDir, workspace: workspaceDir }],
      },
      plugins: {
        allow: [PLUGIN_ID, UNRELATED_PLUGIN_ID],
        load: { paths: [pluginFile, unrelatedPluginFile] },
        entries: {
          [PLUGIN_ID]: { enabled: true },
          [UNRELATED_PLUGIN_ID]: { enabled: true },
        },
      },
    } satisfies OpenClawConfig;
    const env = {
      ...process.env,
      OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
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
      ).pending
    )[0];
    if (!prepared) {
      throw new Error("prepared runtime produced no snapshot");
    }
    const authStore = getPreparedModelRuntimeAuthStore(prepared.snapshot);
    if (!authStore) {
      throw new Error("prepared runtime produced no auth store");
    }
    const projectSnapshot = async (full: boolean): Promise<PreparedGatewayModelCatalogSnapshot> => {
      const modelCatalog = full
        ? await prepared.snapshot.loadFullModelCatalog!()
        : prepared.snapshot.modelCatalog;
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
        authModes: prepared.snapshot.authModes,
        authStore,
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
  });
});
