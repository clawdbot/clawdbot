import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { replaceRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import { ensureAuthProfileStore } from "./auth-profiles/store.js";
import {
  encodePluginModelCatalogRelativePath,
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  replacePersistedPluginModelCatalogs,
} from "./plugin-model-catalog.js";
import { writeSyntheticAuthDiscoveryFixture } from "./test-helpers/prepared-model-catalog-worker-fixture.js";

export const PROVIDER_ID = "worker-catalog-fixture";
export const HARNESS_ID = "worker-catalog-fixture-harness";
const UNRELATED_SYNTHETIC_AUTH_ID = `${PROVIDER_ID}-unrelated-harness`;
export const SHARED_AUTH_PROVIDER_ID = `${PROVIDER_ID}-shared-auth`;
const PLUGIN_ID = "worker-catalog-fixture";
export const PROFILE_ID = `${SHARED_AUTH_PROVIDER_ID}:named`;
export const MATERIALIZED_SECRET = "materialized-worker-secret-not-real";
const UNRELATED_SECRET = "unrelated-worker-secret-not-real";
export const REF_ONLY_API_PROVIDER_ID = `${PROVIDER_ID}-ref-api`;
export const REF_ONLY_API_ENV = "OPENCLAW_WORKER_REF_ONLY_API_KEY";
export const REF_ONLY_TOKEN_PROVIDER_ID = `${PROVIDER_ID}-ref-token`;
export const REF_ONLY_TOKEN_ENV = "OPENCLAW_WORKER_REF_ONLY_TOKEN";
export const DURABLE_AUTH_PROVIDER_ID = `${PROVIDER_ID}-durable-auth`;
export const DURABLE_AUTH_KEY = "post-startup-durable-key-not-real";
export const EXTERNAL_AUTH_PROFILE_ID = `${PROVIDER_ID}:external`;
export const EXTERNAL_AUTH_PATH_ENV = "OPENCLAW_WORKER_EXTERNAL_AUTH_PATH";

export function writeFixturePlugin(params: {
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

export function createCatalogFixtureAtRoot(
  root: string,
  spinMs: number,
  envOverride: NodeJS.ProcessEnv = {},
  options?: {
    hydrateExternalCliProviderIds?: readonly string[];
  },
) {
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
