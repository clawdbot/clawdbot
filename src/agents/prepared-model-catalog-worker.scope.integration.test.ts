import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { unregisterResolvedAgentDir } from "./agent-dir-registry.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import { resolveModelCatalogPluginScope } from "./prepared-model-catalog-plugin-scope.js";
import {
  DUPLICATE_ALIAS_PLUGIN_ID,
  DUPLICATE_ALIAS_PROVIDER_ID,
  EXTERNAL_AUTH_PATH_ENV,
  HARNESS_ID,
  MEDIA_ONLY_PLUGIN_ID,
  MEDIA_ONLY_PROVIDER_ID,
  PLUGIN_ID,
  PROVIDER_ALIAS_ID,
  PROVIDER_ID,
  REF_ONLY_API_ENV,
  REF_ONLY_TOKEN_ENV,
  UNRELATED_PLUGIN_WORKER_MARKER_ENV,
  writeDuplicateAliasFixturePlugin,
  writeFixturePlugin,
  writeMediaOnlyFixturePlugin,
} from "./prepared-model-catalog-worker.test-support.js";
import { startSerializedSnapshotBuild } from "./prepared-model-runtime.build.js";
import { usePreparedCatalogWorkerFixtures } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

const { makeTempDir, retireAfterTest } = usePreparedCatalogWorkerFixtures();

async function createScopedWorkerFixture(kind: "duplicate-alias" | "media-only") {
  const root = makeTempDir("openclaw-model-catalog-scope-worker-");
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspace");
  const marker = path.join(root, "worker-marker.txt");
  const externalAuthPath = path.join(root, "external-auth.txt");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.writeFileSync(externalAuthPath, "A", "utf8");

  const pluginFile = writeFixturePlugin({ root, spinMs: 0 });
  const extraPluginFile =
    kind === "media-only"
      ? writeMediaOnlyFixturePlugin(root)
      : writeDuplicateAliasFixturePlugin(root);
  const extraPluginId = kind === "media-only" ? MEDIA_ONLY_PLUGIN_ID : DUPLICATE_ALIAS_PLUGIN_ID;
  const modelProviderId = kind === "duplicate-alias" ? PROVIDER_ALIAS_ID : PROVIDER_ID;
  const config = {
    agents: {
      defaults: {
        model: `${modelProviderId}/sqlite-model`,
        models: {
          [`${modelProviderId}/sqlite-model`]: { agentRuntime: { id: HARNESS_ID } },
        },
      },
    },
    plugins: {
      allow: [PLUGIN_ID, extraPluginId],
      load: { paths: [pluginFile, extraPluginFile] },
      entries: {
        [PLUGIN_ID]: { enabled: true },
        [extraPluginId]: { enabled: true },
      },
    },
  } satisfies OpenClawConfig;
  const env = {
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_WORKER_CATALOG_MARKER: marker,
    [EXTERNAL_AUTH_PATH_ENV]: externalAuthPath,
    [UNRELATED_PLUGIN_WORKER_MARKER_ENV]: path.join(root, "unrelated-worker-plugin.txt"),
    [REF_ONLY_API_ENV]: "ref-only-api-secret-not-real",
    [REF_ONLY_TOKEN_ENV]: "ref-only-token-secret-not-real",
  };
  replaceRuntimeAuthProfileStoreSnapshots([
    {
      agentDir,
      store: {
        version: 1,
        profiles:
          kind === "media-only"
            ? {
                [`${MEDIA_ONLY_PROVIDER_ID}:default`]: {
                  type: "api_key",
                  provider: MEDIA_ONLY_PROVIDER_ID,
                  key: "media-only-secret-not-real",
                },
              }
            : {},
      },
    },
  ]);

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
  const prepared = await startSerializedSnapshotBuild(
    {
      input,
      catalogOwner: preparePublishedModelCatalogOwnerIdentity(input),
      isGenerationCurrent: () => current,
    },
    new Map(),
    30_000,
    "static",
  ).pending;
  return prepared;
}

describe("prepared model catalog worker contributor scope", () => {
  it("does not require a model row for an active media-only provider", async () => {
    const prepared = await createScopedWorkerFixture("media-only");
    const scope = resolveModelCatalogPluginScope(prepared.pluginGeneration.pluginMetadataSnapshot);

    expect(scope.pluginIds).toContain(MEDIA_ONLY_PLUGIN_ID);
    expect(scope.expectedProviderIds).not.toContain(MEDIA_ONLY_PROVIDER_ID);
    const catalog = await prepared.snapshot.loadFullModelCatalog?.();
    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "account-scoped-model" }),
    );
    expect(catalog?.entries.some((entry) => entry.provider === MEDIA_ONLY_PROVIDER_ID)).toBe(false);
  });

  it("keeps the first manifest target when duplicate aliases reach the worker", async () => {
    const prepared = await createScopedWorkerFixture("duplicate-alias");
    const scope = resolveModelCatalogPluginScope(prepared.pluginGeneration.pluginMetadataSnapshot);

    expect(scope.catalogProviderAliases.get(PROVIDER_ALIAS_ID)).toBe(PROVIDER_ID);
    expect(scope.catalogProviderAliases.get(PROVIDER_ALIAS_ID)).not.toBe(
      DUPLICATE_ALIAS_PROVIDER_ID,
    );
    const catalog = await prepared.snapshot.loadFullModelCatalog?.();
    expect(catalog?.entries).toContainEqual(
      expect.objectContaining({ provider: PROVIDER_ID, id: "account-scoped-model" }),
    );
    expect(catalog?.entries.some((entry) => entry.provider === DUPLICATE_ALIAS_PROVIDER_ID)).toBe(
      false,
    );
  });
});
