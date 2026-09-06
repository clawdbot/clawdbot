import fs from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { getModelCompletionTransport } from "../llm/model-runtime-binding.js";
import { loadAndActivateRootPluginRegistry } from "../plugins/loader.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { clearPluginMetadataLifecycleCaches } from "../plugins/plugin-metadata-lifecycle.js";
import {
  createColdPluginFixture,
  createColdPluginHermeticEnv,
  isColdPluginRuntimeLoaded,
} from "../plugins/test-helpers/cold-plugin-fixtures.js";
import { createSyncSuiteTempRootTracker } from "../plugins/test-helpers/fs-fixtures.js";
import { withEnvAsync } from "../test-utils/env.js";
import type { resolveModelAsync } from "./embedded-agent-runner/model.js";
import {
  acquireAgentRunPreparedModelRuntime,
  type PreparedModelRuntimeSnapshot,
} from "./prepared-model-runtime.js";
import { resetPreparedModelRuntimeSnapshotsForTest } from "./prepared-model-runtime.test-support.js";
import { getModelProviderLocalServiceReconciler } from "./provider-local-service-reconcile.js";
import { getModelProviderLocalService } from "./provider-local-service.js";
import { AuthStorage, ModelRegistry } from "./sessions/index.js";
import {
  completeWithPreparedSimpleCompletionModel,
  prepareSimpleCompletionModel,
  prepareSimpleCompletionModelForAgent,
} from "./simple-completion-runtime.js";

const tempRoots = createSyncSuiteTempRootTracker("openclaw-simple-completion-plugin-scope");

function createTransportOwnerFixture(
  rootDir: string,
  owner: "A" | "B",
  registerProviderStream = true,
) {
  fs.mkdirSync(rootDir);
  const fixture = createColdPluginFixture({
    rootDir,
    pluginId: `completion-owner-${owner.toLowerCase()}`,
    providerId: "completion-owner-provider",
  });
  const reconcileFailureMarker = path.join(rootDir, "fail-reconcile");
  const createStreamSource = registerProviderStream
    ? `createStreamFn() {
        const source = getApiProvider("openai-completions");
        if (!source) throw new Error("OpenAI completion transport is not registered");
        return (model, context, options) => source.streamSimple(
          { ...model, api: "openai-completions" }, context,
          { ...options, headers: { ...options?.headers, "x-completion-stream": owner } },
        );
      },`
    : "";
  fs.writeFileSync(
    fixture.runtimeSource,
    `const fs = require("node:fs");
const { getApiProvider } = require("openclaw/plugin-sdk/llm");
const owner = ${JSON.stringify(owner)};
const reconcileFailureMarker = ${JSON.stringify(reconcileFailureMarker)};
fs.writeFileSync(${JSON.stringify(fixture.runtimeMarker)}, "loaded", "utf8");
module.exports = {
  id: ${JSON.stringify(fixture.pluginId)},
  register(api) {
    api.registerProvider({
      id: ${JSON.stringify(fixture.providerId)}, label: owner, auth: [],
      async prepareRuntimeAuth() { return { apiKey: "fixture-auth-" + owner }; },
      ${createStreamSource}
      async reconcileLocalService({ baseUrl, signal }) {
        if (fs.existsSync(reconcileFailureMarker)) {
          throw new Error("fixture reconciliation failed");
        }
        const origin = new URL(baseUrl).origin;
        const response = await fetch(origin + "/models?reload=1", { signal });
        if (!response.ok) throw new Error("fixture reload failed: HTTP " + response.status);
      },
      wrapSimpleCompletionStreamFn({ streamFn }) {
        return (model, context, options) => streamFn(model, context, {
          ...options, headers: { ...options?.headers, "x-completion-wrapper": owner },
        });
      },
    });
  },
};
`,
    "utf8",
  );
  return { ...fixture, reconcileFailureMarker };
}

afterEach(() => {
  resetPreparedModelRuntimeSnapshotsForTest();
  clearPluginMetadataLifecycleCaches();
  resetPluginLoaderTestStateForTest();
  tempRoots.cleanup();
});

describe("simple completion prepared plugin scope", () => {
  it.each([
    {
      name: "direct provider and model",
      expectedModelId: "selected-model",
      prepare: (params: {
        config: OpenClawConfig;
        modelResolver: typeof resolveModelAsync;
        provider: string;
        modelId: string;
      }) =>
        prepareSimpleCompletionModel({
          cfg: params.config,
          agentId: "main",
          provider: params.provider,
          modelId: params.modelId,
          modelResolver: params.modelResolver,
        }),
    },
    {
      name: "agent-selected manifest utility model",
      expectedModelId: "utility-model",
      prepare: (params: {
        config: OpenClawConfig;
        modelResolver: typeof resolveModelAsync;
        provider: string;
        modelId: string;
      }) =>
        prepareSimpleCompletionModelForAgent({
          cfg: params.config,
          agentId: "main",
          useUtilityModel: true,
          modelResolver: params.modelResolver,
        }),
    },
  ])(
    "loads only the selected plugin generation for $name",
    async ({ expectedModelId, prepare }) => {
      const tempRoot = tempRoots.makeTempDir();
      const selectedRoot = path.join(tempRoot, "selected");
      const unrelatedRoot = path.join(tempRoot, "unrelated");
      fs.mkdirSync(selectedRoot, { recursive: true });
      fs.mkdirSync(unrelatedRoot, { recursive: true });
      const selected = createColdPluginFixture({
        rootDir: selectedRoot,
        pluginId: "selected-provider-plugin",
        providerId: "selected-provider",
        manifest: {
          modelCatalog: {
            providers: {
              "selected-provider": {
                defaultUtilityModel: "utility-model",
                models: [{ id: "primary-model" }, { id: "utility-model" }],
              },
            },
          },
        },
      });
      const unrelated = createColdPluginFixture({
        rootDir: unrelatedRoot,
        pluginId: "unrelated-provider-plugin",
        providerId: "unrelated-provider",
        runtimeMessage: "unrelated provider runtime must remain cold",
      });
      fs.writeFileSync(
        selected.runtimeSource,
        `const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(selected.runtimeMarker)}, "loaded", "utf8");
module.exports = {
  id: ${JSON.stringify(selected.pluginId)},
  register(api) {
    api.registerProvider({ id: ${JSON.stringify(selected.providerId)}, label: "Selected", auth: [] });
  },
};
`,
        "utf8",
      );
      const config = {
        agents: {
          defaults: { model: `${selected.providerId}/primary-model@work` },
        },
        plugins: {
          load: { paths: [selected.rootDir, unrelated.rootDir] },
          slots: { memory: "none" },
          entries: {
            [selected.pluginId]: { enabled: true },
            [unrelated.pluginId]: { enabled: true },
          },
        },
      } satisfies OpenClawConfig;
      let preparedRuntime: PreparedModelRuntimeSnapshot | undefined;
      const modelResolver: typeof resolveModelAsync = vi.fn(
        async (provider, modelId, _agentDir, _cfg, options) => {
          preparedRuntime = options?.preparedModelRuntime;
          return {
            error: `stop after selected resolver ${provider}/${modelId}`,
            authStorage: options?.authStorage ?? AuthStorage.inMemory({}),
            modelRegistry:
              options?.modelRegistry ?? ModelRegistry.inMemory(AuthStorage.inMemory({})),
          };
        },
      );
      const env = {
        ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: tempRoots.makeTempDir() }),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
      };

      const result = await withEnvAsync(env, () =>
        prepare({
          config,
          modelResolver,
          provider: selected.providerId,
          modelId: expectedModelId,
        }),
      );

      expect(result).toMatchObject({
        error: `stop after selected resolver ${selected.providerId}/${expectedModelId}`,
      });
      expect(modelResolver).toHaveBeenCalledOnce();
      expect(isColdPluginRuntimeLoaded(selected)).toBe(true);
      expect(isColdPluginRuntimeLoaded(unrelated)).toBe(false);
      expect(preparedRuntime?.metadataSnapshot.pluginIds).toContain(selected.pluginId);
      expect(preparedRuntime?.metadataSnapshot.pluginIds).not.toContain(unrelated.pluginId);
      expect(preparedRuntime?.metadataSnapshot.plugins.map((plugin) => plugin.id)).toEqual([
        selected.pluginId,
      ]);
    },
  );

  it.each(["acquired", "borrowed", "empty"] as const)(
    "keeps %s transport ownership across ambient replacement and repeated completion",
    async (mode) => {
      const tempRoot = fs.realpathSync(tempRoots.makeTempDir());
      const selected = createTransportOwnerFixture(path.join(tempRoot, "selected"), "A");
      const ambient = createTransportOwnerFixture(path.join(tempRoot, "ambient"), "B");
      const unrelatedRoot = path.join(tempRoot, "unrelated");
      fs.mkdirSync(unrelatedRoot);
      const unrelated = createColdPluginFixture({
        rootDir: unrelatedRoot,
        pluginId: "unrelated-provider-plugin",
        providerId: "unrelated-provider",
      });
      let requestCount = 0;
      const server = createServer((request, response) => {
        request.resume();
        requestCount += 1;
        const text = [
          requestCount,
          request.headers["x-completion-stream"] ?? "none",
          request.headers["x-completion-wrapper"] ?? "none",
          request.headers.authorization,
        ].join("|");
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(
          `data: ${JSON.stringify({
            id: "completion-owner-response",
            object: "chat.completion.chunk",
            model: "selected-model",
            choices: [{ index: 0, delta: { content: text }, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
        );
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => {
          server.removeListener("error", reject);
          resolve();
        });
      });
      try {
        const address = server.address();
        if (!address || typeof address === "string") {
          throw new Error("Completion owner fixture did not expose a TCP port");
        }
        const configFor = (fixture: typeof selected): OpenClawConfig => ({
          agents: {
            defaults: { workspace: fixture.rootDir, model: `${fixture.providerId}/selected-model` },
          },
          models: {
            providers: {
              [fixture.providerId]: {
                api: "openai-completions",
                apiKey: "fixture-auth-source",
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                models: [
                  {
                    id: "selected-model",
                    name: "Selected",
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 8192,
                    maxTokens: 1024,
                  },
                ],
              },
            },
          },
          plugins: {
            load: { paths: [fixture.rootDir, unrelated.rootDir] },
            slots: { memory: "none" },
            entries: {
              [fixture.pluginId]: { enabled: true },
              [unrelated.pluginId]: { enabled: true },
            },
          },
        });
        const cfg = configFor(selected);
        const env = {
          ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: tempRoots.makeTempDir() }),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
          OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
        };
        await withEnvAsync(env, async () => {
          const input = {
            config: cfg,
            agentId: "main",
            agentDir: path.join(tempRoot, "agent"),
            workspaceDir: selected.rootDir,
          };
          const lease =
            mode === "acquired"
              ? undefined
              : await acquireAgentRunPreparedModelRuntime(
                  {
                    ...input,
                    readOnly: mode === "empty",
                    loadRuntimePlugins: mode === "borrowed",
                    ...(mode === "borrowed"
                      ? {
                          runtimePluginSelections: [
                            {
                              provider: selected.providerId,
                              modelId: "selected-model",
                              agentId: "main",
                            },
                          ],
                        }
                      : {}),
                  },
                  { catalogMode: "static" },
                );
          try {
            if (mode === "empty") {
              expect(lease?.snapshot.pluginRegistry).toBeUndefined();
            }
            const activateAmbient = () =>
              loadAndActivateRootPluginRegistry({
                config: configFor(ambient),
                workspaceDir: ambient.rootDir,
                onlyPluginIds: [ambient.pluginId],
                throwOnLoadError: true,
              });
            if (mode !== "acquired") {
              activateAmbient();
            }
            const prepared = await prepareSimpleCompletionModel({
              cfg,
              agentId: "main",
              agentDir: input.agentDir,
              workspaceDir: input.workspaceDir,
              provider: selected.providerId,
              modelId: "selected-model",
              ...(lease ? { preparedModelRuntime: lease.snapshot } : {}),
            });
            if ("error" in prepared) {
              throw new Error(prepared.error);
            }
            if (mode === "acquired") {
              activateAmbient();
            }
            // Callers use the logical API before dispatch, including CLI system-prompt selection.
            expect(prepared.model.api).toBe("openai-completions");
            expect(isColdPluginRuntimeLoaded(ambient)).toBe(true);
            const owner = mode === "empty" ? "none" : "A";
            const auth = mode === "empty" ? "fixture-auth-source" : "fixture-auth-A";
            for (const turn of [1, 2]) {
              const result = await completeWithPreparedSimpleCompletionModel({
                model: prepared.model,
                auth: prepared.auth,
                cfg,
                context: { messages: [{ role: "user", content: `Turn ${turn}`, timestamp: turn }] },
              });
              expect(result).toMatchObject({
                stopReason: "stop",
                content: [{ type: "text", text: `${turn}|${owner}|${owner}|Bearer ${auth}` }],
              });
            }
            expect(prepared.model.api).toBe("openai-completions");
            expect(isColdPluginRuntimeLoaded(unrelated)).toBe(false);
          } finally {
            lease?.release();
          }
        });
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    },
  );

  it.each([
    { name: "reloads before the request", failReconciliation: false },
    { name: "fails closed before the request", failReconciliation: true },
  ])("$name for managed simple completions", async ({ failReconciliation }) => {
    const tempRoot = fs.realpathSync(tempRoots.makeTempDir());
    const selected = createTransportOwnerFixture(path.join(tempRoot, "selected"), "A", false);
    const requestPaths: string[] = [];
    const server = createServer((request, response) => {
      request.resume();
      const requestUrl = new URL(request.url ?? "/", "http://127.0.0.1");
      requestPaths.push(`${requestUrl.pathname}${requestUrl.search}`);
      if (requestUrl.pathname === "/health" || requestUrl.pathname === "/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"ok":true}');
        return;
      }
      response.writeHead(200, { "content-type": "text/event-stream" });
      response.end(
        `data: ${JSON.stringify({
          id: "managed-completion-response",
          object: "chat.completion.chunk",
          model: "selected-model",
          choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }],
        })}\n\ndata: [DONE]\n\n`,
      );
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") {
        throw new Error("Managed completion fixture did not expose a TCP port");
      }
      const origin = `http://127.0.0.1:${address.port}`;
      const cfg: OpenClawConfig = {
        agents: {
          defaults: { workspace: selected.rootDir, model: `${selected.providerId}/selected-model` },
        },
        models: {
          providers: {
            [selected.providerId]: {
              api: "openai-completions",
              apiKey: "fixture-auth-source",
              baseUrl: `${origin}/v1`,
              localService: {
                command: process.execPath,
                args: ["--version"],
                healthUrl: `${origin}/health`,
                idleStopMs: 1,
              },
              models: [
                {
                  id: "selected-model",
                  name: "Selected",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 8192,
                  maxTokens: 1024,
                },
              ],
            },
          },
        },
        plugins: {
          load: { paths: [selected.rootDir] },
          slots: { memory: "none" },
          entries: { [selected.pluginId]: { enabled: true } },
        },
      };
      const env = {
        ...createColdPluginHermeticEnv(tempRoot, { bundledPluginsDir: tempRoots.makeTempDir() }),
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_STATE_DIR: path.join(tempRoot, "state"),
      };
      await withEnvAsync(env, async () => {
        const prepared = await prepareSimpleCompletionModel({
          cfg,
          agentId: "main",
          agentDir: path.join(tempRoot, "agent"),
          workspaceDir: selected.rootDir,
          provider: selected.providerId,
          modelId: "selected-model",
        });
        if ("error" in prepared) {
          throw new Error(prepared.error);
        }
        const completionTransport = getModelCompletionTransport(prepared.model);
        if (!completionTransport) {
          throw new Error("Managed completion transport was not prepared");
        }
        expect(getModelProviderLocalService(prepared.model)).toBeDefined();
        expect(getModelProviderLocalService(completionTransport)).toBeDefined();
        expect(getModelProviderLocalServiceReconciler(prepared.model)).toBeTypeOf("function");
        expect(getModelProviderLocalServiceReconciler(completionTransport)).toBeTypeOf("function");
        if (failReconciliation) {
          fs.writeFileSync(selected.reconcileFailureMarker, "fail", "utf8");
          await expect(
            completeWithPreparedSimpleCompletionModel({
              model: prepared.model,
              auth: prepared.auth,
              cfg,
              context: { messages: [{ role: "user", content: "Complete", timestamp: 1 }] },
            }),
          ).resolves.toMatchObject({ stopReason: "error", content: [] });
        } else {
          await expect(
            completeWithPreparedSimpleCompletionModel({
              model: prepared.model,
              auth: prepared.auth,
              cfg,
              context: { messages: [{ role: "user", content: "Complete", timestamp: 1 }] },
            }),
          ).resolves.toMatchObject({
            stopReason: "stop",
            content: [{ type: "text", text: "done" }],
          });
        }
      });
      const reloadIndex = requestPaths.indexOf("/models?reload=1");
      const modelRequestIndex = requestPaths.findIndex(
        (requestPath) => requestPath !== "/health" && requestPath !== "/models?reload=1",
      );
      if (failReconciliation) {
        expect(reloadIndex).toBe(-1);
        expect(modelRequestIndex).toBe(-1);
      } else {
        expect(reloadIndex).toBeGreaterThanOrEqual(0);
        expect(modelRequestIndex).toBeGreaterThan(reloadIndex);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
