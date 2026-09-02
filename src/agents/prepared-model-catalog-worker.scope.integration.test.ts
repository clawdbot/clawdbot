import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

describe("prepared model catalog worker plugin scope", () => {
  it("keeps catalog contributors without importing unrelated plugins", async () => {
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
    const catalog = await prepared?.snapshot.loadFullModelCatalog?.();

    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "plugin-generation-v1" }),
    );
    expect(fs.existsSync(unrelatedMarker)).toBe(false);
  });
});
