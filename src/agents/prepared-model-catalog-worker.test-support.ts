import fs from "node:fs";
import path from "node:path";
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
}): string {
  const pluginDir = path.join(params.root, "plugin");
  fs.mkdirSync(pluginDir, { recursive: true });
  let pluginFile = path.join(pluginDir, "index.cjs");
  const syntheticAuthProbePath = path.join(params.root, "synthetic-auth-probes.txt");
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
      }, {
        provider: ${JSON.stringify(DISCOVERED_HARNESS_ID)},
        id: "discovered-native-model",
        name: "Discovered native model",
      }, {
        provider: ${JSON.stringify(MISSING_AUTH_HARNESS_ID)},
        id: "missing-auth-native-model",
        name: "Missing auth native model",
      }],
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
