import fs from "node:fs";
import path from "node:path";
import { expect, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createGatewayChatMetadataRuntime } from "../gateway/server-methods/chat-metadata-runtime.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "../gateway/server-methods/models-list-result.js";
import type { GatewayRequestContext } from "../gateway/server-methods/types.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { createEmptyPluginRegistry } from "../plugins/registry.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../plugins/runtime.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
import { preparePublishedModelCatalogOwnerIdentity } from "./prepared-model-catalog-owner.js";
import { getPreparedModelFullCatalogAuth } from "./prepared-model-runtime-auth.js";
import { startSerializedSnapshotBuildBatch } from "./prepared-model-runtime.build.js";
import type { PreparedModelRuntimeSnapshot } from "./prepared-model-runtime.types.js";
import { writeSyntheticAuthDiscoveryFixture } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

export const PROVIDER_ID = "worker-catalog-fixture";
export const HARNESS_ID = "worker-catalog-fixture-harness";
export const DISCOVERED_HARNESS_ID = `${PROVIDER_ID}-discovered-harness`;
export const MISSING_AUTH_HARNESS_ID = `${PROVIDER_ID}-missing-auth-harness`;
const UNRELATED_SYNTHETIC_AUTH_ID = `${PROVIDER_ID}-unrelated-harness`;
export const SHARED_AUTH_PROVIDER_ID = `${PROVIDER_ID}-shared-auth`;
export const PLUGIN_ID = "worker-catalog-fixture";
export const PROFILE_ID = `${SHARED_AUTH_PROVIDER_ID}:named`;
export const MATERIALIZED_SECRET = "materialized-worker-secret-not-real";
export const UNRELATED_SECRET = "unrelated-worker-secret-not-real";
export const REF_ONLY_API_PROVIDER_ID = `${PROVIDER_ID}-ref-api`;
export const REF_ONLY_API_ENV = "OPENCLAW_WORKER_REF_ONLY_API_KEY";
export const REF_ONLY_TOKEN_PROVIDER_ID = `${PROVIDER_ID}-ref-token`;
export const REF_ONLY_TOKEN_ENV = "OPENCLAW_WORKER_REF_ONLY_TOKEN";
export const DURABLE_AUTH_PROVIDER_ID = `${PROVIDER_ID}-durable-auth`;
export const DURABLE_AUTH_KEY = "post-startup-durable-key-not-real";
export const EXTERNAL_AUTH_PROFILE_ID = `${PROVIDER_ID}:external`;
export const EXTERNAL_AUTH_PATH_ENV = "OPENCLAW_WORKER_EXTERNAL_AUTH_PATH";
export const UNRELATED_PLUGIN_ID = "worker-catalog-unrelated";
export const UNRELATED_PLUGIN_WORKER_MARKER_ENV = "OPENCLAW_WORKER_UNRELATED_PLUGIN_MARKER";

export function writeUnrelatedFixturePlugin(root: string): string {
  const pluginDir = path.join(root, "unrelated-plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  const pluginFile = path.join(pluginDir, "index.cjs");
  fs.writeFileSync(
    pluginFile,
    `const fs = require("node:fs");
const { isMainThread } = require("node:worker_threads");
if (!isMainThread) {
  fs.writeFileSync(process.env.${UNRELATED_PLUGIN_WORKER_MARKER_ENV}, "loaded", "utf8");
}
module.exports = { id: ${JSON.stringify(UNRELATED_PLUGIN_ID)}, register() {} };
`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: UNRELATED_PLUGIN_ID,
      configSchema: { type: "object", additionalProperties: false, properties: {} },
    }),
    "utf8",
  );
  return pluginFile;
}

export function createJwtWithExp(exp: number, marker?: string): string {
  const payload = Buffer.from(JSON.stringify({ exp, ...(marker ? { marker } : {}) })).toString(
    "base64url",
  );
  return `header.${payload}.signature`;
}

export function writeCodexAuth(codexHome: string, marker: string): void {
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

export function writeFixturePlugin(params: {
  root: string;
  spinMs: number;
  pluginVersion?: string;
  builtPluginVersion?: string;
  nativeCatalog?: boolean;
}): string {
  const pluginDir = path.join(params.root, "plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  let pluginFile = path.join(pluginDir, "index.cjs");
  const syntheticAuthProbePath = path.join(params.root, "synthetic-auth-probes.txt");
  const catalogRoute = params.nativeCatalog
    ? `nativeRuntime: ${JSON.stringify(HARNESS_ID)},`
    : 'api: "openai-completions",\n          baseUrl: "https://worker-catalog.invalid/v1",';
  const readinessReader = params.nativeCatalog
    ? 'readModelCatalogReadiness: () => nativeCatalogObserved ? { accountType: "chatgpt" } : undefined,'
    : "";
  writeSyntheticAuthDiscoveryFixture({
    root: params.root,
    pluginDir,
    harnessId: HARNESS_ID,
    unrelatedId: UNRELATED_SYNTHETIC_AUTH_ID,
    pluginVersion: params.pluginVersion ?? "v1",
  });
  fs.writeFileSync(
    pluginFile,
    `const fs = require("node:fs");
module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    let nativeCatalogObserved = false;
    api.registerAgentHarness({
      id: ${JSON.stringify(HARNESS_ID)},
      label: "Worker catalog fixture harness",
      authBootstrap: "harness",
      supports: () => ({ supported: true }),
      runAttempt: async () => ({ ok: false, error: "unused" }),
      loadModelCatalog: async () => {
        nativeCatalogObserved = true;
        return [{
          provider: ${JSON.stringify(PROVIDER_ID)},
          id: "account-scoped-model",
          name: "Account scoped model",
          ${catalogRoute}
        }, {
          provider: ${JSON.stringify(DISCOVERED_HARNESS_ID)},
          id: "discovered-native-model",
          name: "Discovered native model",
        }, {
          provider: ${JSON.stringify(MISSING_AUTH_HARNESS_ID)},
          id: "missing-auth-native-model",
          name: "Missing auth native model",
        }];
      },
      ${readinessReader}
    });
    for (const [id, authenticated] of [
      [${JSON.stringify(DISCOVERED_HARNESS_ID)}, true],
      [${JSON.stringify(MISSING_AUTH_HARNESS_ID)}, false],
    ]) {
      api.registerProvider({
        id,
        label: id,
        auth: [],
        resolveSyntheticAuth() {
          fs.appendFileSync(${JSON.stringify(syntheticAuthProbePath)}, id + "\\n");
          return authenticated
            ? { apiKey: "discovered-native-login-not-real", source: "fixture native login", mode: "oauth" }
            : undefined;
        },
      });
    }
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
            // Darwin's directory watch can start after removal; observe file state instead.
            const check = () => {
              if (!fs.existsSync(barrier)) { fs.unwatchFile(barrier, check); resolve(); }
            };
            fs.watchFile(barrier, { interval: 10 }, check);
            check();
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
  if (params.builtPluginVersion) {
    const sourceFile = path.join(pluginDir, "index.cts");
    fs.renameSync(pluginFile, sourceFile);
    fs.renameSync(
      path.join(pluginDir, "provider-discovery.cjs"),
      path.join(pluginDir, "provider-discovery.cts"),
    );
    const builtFile = writeFixturePlugin({
      root: params.root,
      spinMs: params.spinMs,
      pluginVersion: params.builtPluginVersion,
    });
    const distDir = path.join(pluginDir, "dist");
    fs.mkdirSync(distDir);
    fs.renameSync(builtFile, path.join(distDir, "index.cjs"));
    fs.renameSync(
      path.join(pluginDir, "provider-discovery.cjs"),
      path.join(distDir, "provider-discovery.cjs"),
    );
    pluginFile = sourceFile;
  }
  fs.writeFileSync(
    path.join(pluginDir, "openclaw.plugin.json"),
    JSON.stringify({
      id: PLUGIN_ID,
      providers: [PROVIDER_ID, DISCOVERED_HARNESS_ID, MISSING_AUTH_HARNESS_ID],
      cliBackends: [
        HARNESS_ID,
        DISCOVERED_HARNESS_ID,
        MISSING_AUTH_HARNESS_ID,
        UNRELATED_SYNTHETIC_AUTH_ID,
      ],
      syntheticAuthRefs: [
        HARNESS_ID,
        DISCOVERED_HARNESS_ID,
        MISSING_AUTH_HARNESS_ID,
        UNRELATED_SYNTHETIC_AUTH_ID,
      ],
      providerCatalogEntry: params.builtPluginVersion
        ? "./provider-discovery.cts"
        : "./provider-discovery.cjs",
      configSchema: { type: "object", additionalProperties: false, properties: {} },
      contracts: { externalAuthProviders: [PROVIDER_ID] },
      modelCatalog: { discovery: { [PROVIDER_ID]: "runtime" }, runtimeAugment: true },
    }),
    "utf8",
  );
  return pluginFile;
}

async function expectNativeHarnessModelsPublished(params: {
  config: OpenClawConfig;
  metadataSnapshot: PluginMetadataSnapshot;
  snapshot: PreparedModelRuntimeSnapshot;
}): Promise<void> {
  const registry = params.snapshot.pluginRegistry;
  if (!registry) {
    throw new Error("expected prepared plugin registry");
  }
  const previousRegistry = captureActivePluginRegistrySnapshot();
  setActivePluginRegistry(createEmptyPluginRegistry());
  try {
    const catalog = await params.snapshot.loadFullModelCatalog?.();
    const nativeEntry = catalog?.entries.find(({ id }) => id === "account-scoped-model");
    expect(nativeEntry).toMatchObject({ provider: PROVIDER_ID, nativeRuntime: HARNESS_ID });
    if (!catalog) {
      throw new Error("expected full prepared catalog");
    }
    const fullAuth = getPreparedModelFullCatalogAuth(catalog);
    if (!fullAuth) {
      throw new Error("expected prepared full-catalog auth");
    }
    const context = {
      getRuntimeConfig: () => params.config,
      logGateway: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    } as unknown as GatewayRequestContext;
    const projector = createGatewayAgentModelCatalogProjector({
      cfg: params.config,
      agentId: "main",
      snapshot: catalog,
      metadataSnapshot: params.metadataSnapshot,
      preparedAuthStore: fullAuth.authStore,
      preparedRuntimeAuthModes: fullAuth.authModes,
      pluginRegistry: registry,
      isCurrent: params.snapshot.isCurrent,
      observationConfig: params.snapshot.observationConfig,
    });
    const hostEvaluation = await projector.evaluateEntry(nativeEntry!);
    expect(projector.evaluateNative(nativeEntry!, hostEvaluation)).toMatchObject({
      availability: true,
    });
    const preparedModels = await buildModelsListResult({
      context,
      agentId: "main",
      params: { view: "configured" },
      preloadedCatalog: { agentId: "main", config: params.config, snapshot: catalog },
      preloadedOnly: true,
      catalogProjector: projector,
    });
    expect(preparedModels.models).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "account-scoped-model",
        available: true,
      }),
    );

    const chatMetadata = createGatewayChatMetadataRuntime({
      getConfig: () => params.config,
      getContext: () => context,
      log: context.logGateway,
      deps: {
        getPreparedOwner: () => params.snapshot,
        getPreparedAuthStore: () => fullAuth.authStore,
        getAuthStoreRevision: () => 1,
        getSkillsVersion: () => 1,
        getPluginRegistryVersion: () => 1,
        buildCommands: async () => ({ commands: [] }),
      },
    });
    await chatMetadata.refresh();
    const metadata = await chatMetadata.read({ agentId: "main" });
    expect(metadata.models).toContainEqual(
      expect.objectContaining({
        provider: PROVIDER_ID,
        id: "account-scoped-model",
        available: true,
      }),
    );
  } finally {
    restoreActivePluginRegistrySnapshot(previousRegistry);
  }
}

export async function expectNativeHarnessModelsPublishedFromWorker(params: {
  makeTempDir: (prefix: string) => string;
  retireAfterTest: (retire: () => void) => void;
}): Promise<void> {
  const root = params.makeTempDir("openclaw-native-model-catalog-worker-");
  const stateDir = path.join(root, "state");
  const agentDir = path.join(stateDir, "agents", "main", "agent");
  const workspaceDir = path.join(root, "workspace");
  const marker = path.join(root, "worker-marker.txt");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.mkdirSync(workspaceDir, { recursive: true });
  const pluginFile = writeFixturePlugin({ root, spinMs: 0, nativeCatalog: true });
  const config = {
    agents: {
      defaults: {
        model: `${PROVIDER_ID}/sqlite-model`,
        models: {
          [`${PROVIDER_ID}/sqlite-model`]: { agentRuntime: { id: HARNESS_ID } },
          [`${PROVIDER_ID}/account-scoped-model`]: { agentRuntime: { id: HARNESS_ID } },
        },
      },
    },
    plugins: {
      allow: [PLUGIN_ID],
      load: { paths: [pluginFile] },
      entries: { [PLUGIN_ID]: { enabled: true } },
    },
  } satisfies OpenClawConfig;
  const env = {
    ...process.env,
    OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_WORKER_CATALOG_MARKER: marker,
    [EXTERNAL_AUTH_PATH_ENV]: "",
    [REF_ONLY_API_ENV]: "ref-only-api-secret-not-real",
    [REF_ONLY_TOKEN_ENV]: "ref-only-token-secret-not-real",
  };
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
  const input = {
    agentId: "main",
    agentDir,
    inheritedAuthDir: agentDir,
    workspaceDir,
    config,
    env,
  };
  let current = true;
  params.retireAfterTest(() => {
    current = false;
  });
  const build = (
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
  )[0]!;
  await expectNativeHarnessModelsPublished({
    config,
    metadataSnapshot: build.pluginGeneration.pluginMetadataSnapshot,
    snapshot: build.snapshot,
  });
}
