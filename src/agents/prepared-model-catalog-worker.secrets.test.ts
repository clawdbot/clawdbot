import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigIoContext } from "../config/io.context.js";
import { readConfigFileSnapshotFromContext } from "../config/io.snapshot.js";
import {
  getAuthoredConfigSecretRef,
  getConfigResolutionFacts,
} from "../config/resolution-facts.js";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import { clearRuntimeAuthProfileStoreSnapshots } from "./auth-profiles/runtime-snapshots.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import { NON_ENV_SECRETREF_MARKER } from "./model-auth-markers.js";
import { resolveUsableCustomProviderApiKey } from "./model-auth-provider-config.js";
import * as modelsConfig from "./models-config.js";
import { createPreparedModelCatalogWorkerInput } from "./prepared-model-catalog-worker.js";
import { runPreparedModelCatalogWorkerRequest } from "./prepared-model-catalog.worker.js";
import {
  prepareAgentCatalogSource,
  prepareWorkspaceBuildGroup,
} from "./prepared-model-runtime.facts.js";

// Run the real worker entrypoint without attaching it to Vitest's own worker port.
vi.mock("node:worker_threads", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:worker_threads")>()),
  parentPort: null,
}));

const provider = "worker-secret-fixture";
let state: OpenClawTestState;
beforeEach(async () => {
  state = await createOpenClawTestState({ label: "catalog-worker-secrets" });
  await state.writeAuthProfiles({ version: 1, profiles: {} });
});
afterEach(async () => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
  clearRuntimeConfigSnapshot();
  await state.cleanup();
});

describe("serialized catalog credential provenance", () => {
  it.each<{
    owner: "config" | "profile";
    label: string;
    value: string;
    loader?: { authored: string; env?: NodeJS.ProcessEnv; pending?: boolean };
  }>([
    { owner: "config", label: "literal bytes", value: "synthetic-worker-config-key" },
    { owner: "config", label: "marker bytes", value: NON_ENV_SECRETREF_MARKER },
    { owner: "config", label: "env-template bytes", value: "${OPAQUE_WORKER_KEY}" },
    { owner: "profile", label: "profile-only sibling", value: "synthetic-worker-profile-key" },
    {
      owner: "config",
      label: "loader-substituted literal",
      value: "${LITERAL_KEY}",
      loader: { authored: "${SOURCE_KEY}", env: { SOURCE_KEY: "${LITERAL_KEY}" } },
    },
    {
      owner: "config",
      label: "loader-escaped literal",
      value: "${LITERAL_KEY}",
      loader: { authored: "$${LITERAL_KEY}" },
    },
    {
      owner: "config",
      label: "loader-pending shorthand",
      value: "$PENDING_KEY",
      loader: { authored: "$PENDING_KEY", pending: true },
    },
  ])(
    "preserves $owner $label through discovery and the writable plan",
    async ({ owner, value, loader }) => {
      const requests: boolean[] = [];
      const server = createServer((request, response) => {
        requests.push(
          request.url === "/v1/models" && request.headers.authorization === `Bearer ${value}`,
        );
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({ data: [{ id: "discovered-model", name: "Discovered model" }] }),
        );
      });
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Expected loopback catalog server");
      }
      try {
        const baseUrl = `http://127.0.0.1:${address.port}/v1`;
        const pluginFile = await state.writeText(
          "catalog-plugin/index.cjs",
          `
module.exports = {
  id: ${JSON.stringify(provider)},
  register(api) {
    const baseUrl = ${JSON.stringify(baseUrl)};
    api.registerProvider({
      id: ${JSON.stringify(provider)}, label: "Worker secret fixture", auth: [],
      staticCatalog: { run: async () => ({ provider: { baseUrl, api: "openai-completions", models: [] } }) },
      catalog: { run: async (context) => {
        const auth = context.resolveProviderApiKey(${JSON.stringify(provider)});
        if (!auth.discoveryApiKey) return null;
        const response = await fetch(baseUrl + "/models", { headers: { authorization: "Bearer " + auth.discoveryApiKey } });
        const body = await response.json();
        return { provider: { baseUrl, api: "openai-completions", apiKey: auth.apiKey, models: body.data } };
      } },
    });
  },
};
`,
        );
        await state.writeJson("catalog-plugin/openclaw.plugin.json", {
          id: provider,
          providers: [provider],
          providerCatalogEntry: "./index.cjs",
          modelCatalog: { discovery: { [provider]: "runtime" } },
          configSchema: { type: "object", additionalProperties: false, properties: {} },
        });
        const ref = { source: "store", provider: "default", id: "WORKER_CONFIG_KEY" } as const;
        const source = {
          plugins: {
            allow: [provider],
            load: { paths: [pluginFile] },
            slots: { memory: "none" },
            entries: { [provider]: { enabled: true } },
          },
          agents: {
            defaults: {
              workspace: state.workspaceDir,
              model: { primary: "healthy-fixture/model" },
              modelPolicy: { allow: ["healthy-fixture/model", `${provider}/*`] },
            },
          },
          models: {
            providers: {
              "healthy-fixture": {
                baseUrl: "https://healthy.example/v1",
                api: "openai-completions",
                apiKey: "synthetic-healthy-key",
                models: [
                  {
                    id: "model",
                    name: "Model",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 4096,
                    maxTokens: 512,
                  },
                ],
              },
              [provider]: {
                baseUrl,
                api: "openai-completions",
                models: [],
                ...(owner === "config" ? { apiKey: loader?.authored ?? ref } : {}),
              },
            },
          },
        } satisfies OpenClawConfig;
        let runtime: OpenClawConfig = {
          ...source,
          models: {
            providers: {
              ...source.models.providers,
              [provider]: {
                ...source.models.providers[provider],
                ...(owner === "config" ? { apiKey: value } : {}),
              },
            },
          },
        };
        const env = {
          ...state.env,
          LITERAL_KEY: undefined,
          PENDING_KEY: undefined,
          ...loader?.env,
        };
        let runtimeSource: OpenClawConfig = source;
        if (loader) {
          await state.writeConfig(source);
          const snapshot = await readConfigFileSnapshotFromContext(
            createConfigIoContext({
              configPath: state.configPath,
              env,
              homedir: () => state.home,
              observe: false,
            }),
          );
          expect(snapshot.valid).toBe(true);
          runtime = snapshot.config;
          runtimeSource = snapshot.sourceConfig;
          expect(getConfigResolutionFacts(runtime)).not.toBeNull();
        }
        setRuntimeConfigSnapshot(runtime, runtimeSource);
        const prepared = await prepareWorkspaceBuildGroup(
          [
            {
              agentId: "main",
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
              config: runtime,
              env,
              skipCredentials: true,
            },
          ],
          "static",
        );
        expect(requests).toEqual([]);
        const authStore: AuthProfileStore = {
          version: 1,
          profiles:
            owner === "profile"
              ? {
                  [`${provider}:fixture`]: { type: "api_key", provider, keyRef: ref, key: value },
                }
              : {},
        };
        const params = {
          agentFacts: { ...prepared.agentFacts[0]!, authStore },
          pluginMetadataSnapshot: prepared.pluginGeneration.pluginMetadataSnapshot,
        };
        expect(params.agentFacts.providerIds).toContain(provider);
        const expectedAuth = loader?.pending ? undefined : value;
        const nativeAuth = loader
          ? resolveUsableCustomProviderApiKey({ cfg: runtime, provider, env })?.apiKey
          : undefined;
        let nativeRequests: boolean[] | undefined;
        if (loader) {
          await prepareAgentCatalogSource(
            params.agentFacts,
            prepared.pluginGeneration,
            "live",
            false,
            { authStore },
          );
          nativeRequests = requests.splice(0);
        }
        const nativeRuntimeFacts = getConfigResolutionFacts(runtime);
        const nativeSourceFacts = getConfigResolutionFacts(runtimeSource);
        const serialized = structuredClone(createPreparedModelCatalogWorkerInput(params));
        let alternativeFingerprint: string | undefined;
        if (owner === "config" && !loader?.pending) {
          const alternativeSource: OpenClawConfig = {
            ...source,
            models: {
              providers: {
                ...source.models.providers,
                [provider]: {
                  ...source.models.providers[provider],
                  apiKey: loader ? value : { ...ref, id: "OTHER_WORKER_KEY" },
                },
              },
            },
          };
          let alternativeRuntime = runtime;
          let alternativeRuntimeSource = alternativeSource;
          if (loader) {
            await state.writeConfig(alternativeSource);
            const snapshot = await readConfigFileSnapshotFromContext(
              createConfigIoContext({
                configPath: state.configPath,
                env,
                homedir: () => state.home,
                observe: false,
              }),
            );
            expect(snapshot.valid).toBe(true);
            // Identical decoded bytes, but this source actually authored the pending reference.
            expect(snapshot.config).toEqual(runtime);
            expect(snapshot.sourceConfig).toEqual(runtimeSource);
            alternativeRuntime = snapshot.config;
            alternativeRuntimeSource = snapshot.sourceConfig;
          }
          setRuntimeConfigSnapshot(alternativeRuntime, alternativeRuntimeSource);
          alternativeFingerprint = createPreparedModelCatalogWorkerInput({
            ...params,
            agentFacts: {
              ...params.agentFacts,
              input: { ...params.agentFacts.input, config: alternativeRuntime },
            },
          }).generationFingerprint;
        }
        // Workers inherit neither the parent's source snapshot nor its WeakMap resolution facts.
        clearRuntimeConfigSnapshot();
        clearRuntimeAuthProfileStoreSnapshots();
        const plans: Array<Awaited<ReturnType<typeof modelsConfig.planOpenClawModelsJsonSource>>> =
          [];
        const plan = modelsConfig.planOpenClawModelsJsonSource;
        vi.spyOn(modelsConfig, "planOpenClawModelsJsonSource").mockImplementation(
          async (...args) => {
            const result = await plan(...args);
            plans.push(result);
            return result;
          },
        );
        const result = await runPreparedModelCatalogWorkerRequest(serialized, {
          kind: "catalog",
        });
        expect(result.status).toBe("ok");
        const runtimeFacts = getConfigResolutionFacts(serialized.input.config);
        const sourceFacts = getConfigResolutionFacts(serialized.sourceConfigForSecrets);
        expect(runtimeFacts === null).toBe(nativeRuntimeFacts === null);
        expect(sourceFacts === null).toBe(nativeSourceFacts === null);
        expect(runtimeFacts === sourceFacts).toBe(nativeRuntimeFacts === nativeSourceFacts);
        if (loader) {
          const expectedRef = loader.pending
            ? { source: "env", provider: "default", id: "PENDING_KEY" }
            : null;
          const workerAuth = resolveUsableCustomProviderApiKey({
            cfg: serialized.input.config,
            provider,
            env,
          })?.apiKey;
          expect({
            nativeAuthMatches: nativeAuth === expectedAuth,
            nativeRequests,
            workerAuthMatches: workerAuth === expectedAuth,
            workerRequests: requests,
            authoredRef: getAuthoredConfigSecretRef(
              serialized.input.config,
              `models.providers.${provider}.apiKey`,
            ),
          }).toEqual({
            nativeAuthMatches: true,
            nativeRequests: loader.pending ? [] : [true],
            workerAuthMatches: true,
            workerRequests: loader.pending ? [] : [true],
            authoredRef: expectedRef,
          });
          if (loader.pending) {
            return;
          }
        }
        expect(requests).toEqual([true]);
        expect(result).toMatchObject({
          snapshot: {
            entries: expect.arrayContaining([
              expect.objectContaining({ provider, id: "discovered-model" }),
            ]),
          },
        });
        expect(plans).toHaveLength(1);
        const catalog = plans[0]!.pluginCatalogs.find((entry) => entry.pluginId === provider);
        if (!catalog) {
          throw new Error("Expected the provider-owned writable catalog");
        }
        expect(JSON.parse(catalog.contents)).toMatchObject({
          providers: { [provider]: { apiKey: loader ? value : NON_ENV_SECRETREF_MARKER } },
        });
        expect(JSON.stringify(plans)).not.toContain("discoveryApiKey");
        if (!loader && value !== NON_ENV_SECRETREF_MARKER) {
          expect(JSON.stringify(plans).includes(value)).toBe(false);
        }
        if (alternativeFingerprint !== undefined) {
          expect(serialized.generationFingerprint).not.toBe(alternativeFingerprint);
        }
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );
});
