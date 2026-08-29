import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { fileURLToPath } from "node:url";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexPlugin from "../../extensions/codex/index.js";
import { createAgentHarnessCatalogEvaluator } from "../../src/agents/harness/model-catalog-readiness.js";
import type { AgentHarness } from "../../src/agents/harness/types.js";
import type { OpenClawConfig } from "../../src/config/types.openclaw.js";
import {
  buildModelsListResult,
  createGatewayAgentModelCatalogProjector,
} from "../../src/gateway/server-methods/models-list-result.js";
import {
  listModels,
  WITHOUT_OPENAI_ENV_AUTH,
} from "../../src/gateway/server-methods/models-list-result.openai-routes.test-support.js";
import type { GatewayRequestContext } from "../../src/gateway/server-methods/types.js";
import { loadManifestMetadataSnapshot } from "../../src/plugins/manifest-contract-eligibility.js";
import { createEmptyPluginRegistry } from "../../src/plugins/registry-empty.js";
import {
  captureActivePluginRegistrySnapshot,
  restoreActivePluginRegistrySnapshot,
  setActivePluginRegistry,
} from "../../src/plugins/runtime.js";
import { withEnvAsync } from "../../src/test-utils/env.js";
import { withOpenClawTestState } from "../../src/test-utils/openclaw-test-state.js";

const transport = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("openclaw/plugin-sdk/simple-completion-runtime", () => ({
  runHostPreparedIsolatedCompletion: vi.fn(),
}));
vi.mock("openclaw/plugin-sdk/agent-harness-runtime", () => ({
  AgentHarnessPreflightError: class extends Error {},
  embeddedAgentLog: { debug: vi.fn(), warn: vi.fn() },
  formatErrorMessage: String,
  OPENCLAW_VERSION: "test",
}));
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawn: transport.spawn,
}));

describe("models.list native account catalog", () => {
  afterEach(() => vi.restoreAllMocks());

  it("makes a native user-home API-key catalog selectable without a ChatGPT route", async () => {
    await withOpenClawTestState(
      { layout: "state-only", prefix: "native-catalog-" },
      async (state) => {
        await withEnvAsync(
          {
            ...WITHOUT_OPENAI_ENV_AUTH,
            CODEX_HOME: `${state.home}/codex`,
            SYNTHETIC_ABSENT_KEY: undefined,
          },
          async () => {
            const stdout = new PassThrough();
            const requests: string[] = [];
            let account: Record<string, unknown> | null = { type: "apiKey" };
            const child = Object.assign(new EventEmitter(), {
              stdout,
              stderr: new PassThrough(),
              stdin: new Writable({
                write(chunk, _encoding, callback) {
                  const request = JSON.parse(chunk.toString()) as { id?: number; method: string };
                  requests.push(request.method);
                  if (request.id !== undefined) {
                    const result =
                      request.method === "initialize"
                        ? { userAgent: "openclaw/0.149.1 (test)" }
                        : request.method === "account/read"
                          ? { account, requiresOpenaiAuth: true }
                          : request.method === "model/list"
                            ? {
                                data: [
                                  {
                                    id: "synthetic-opaque",
                                    model: "synthetic-opaque",
                                    displayName: "Synthetic name",
                                    description: "Synthetic model",
                                    supportsPersonality: false,
                                    inputModalities: ["text"],
                                    supportedReasoningEfforts: [
                                      { reasoningEffort: "low", description: "Low" },
                                    ],
                                    defaultReasoningEffort: "low",
                                    hidden: false,
                                    isDefault: true,
                                  },
                                ],
                                nextCursor: null,
                              }
                            : {};
                    queueMicrotask(() =>
                      stdout.write(`${JSON.stringify({ id: request.id, result })}\n`),
                    );
                  }
                  callback();
                },
              }),
              kill: vi.fn(),
              killed: false,
            });
            child.stdin.once("finish", () => child.emit("exit", 0, null));
            transport.spawn.mockImplementation((command: string) => {
              expect(command).toBe("/synthetic/codex");
              return child;
            });
            const config: OpenClawConfig = {
              agents: {
                defaults: {
                  workspace: state.workspaceDir,
                  model: "openai/synthetic-opaque",
                  models: { "openai/synthetic-opaque": { agentRuntime: { id: "codex" } } },
                },
              },
              plugins: {
                entries: {
                  codex: {
                    enabled: true,
                    config: {
                      appServer: {
                        command: "/synthetic/codex",
                        homeScope: "user",
                        approvalPolicy: "on-request",
                        sandbox: "workspace-write",
                      },
                      computerUse: { enabled: false },
                    },
                  },
                },
              },
            };
            const harnesses: AgentHarness[] = [];
            codexPlugin.register(
              createTestPluginApi({
                id: "codex",
                rootDir: fileURLToPath(new URL("../../extensions/codex/", import.meta.url)),
                config,
                pluginConfig: config.plugins?.entries?.codex?.config,
                runtime: { config: { current: () => config } } as never,
                registerAgentHarness: (harness) => harnesses.push(harness),
              }),
            );
            const harness = harnesses.find((entry) => entry.id === "codex");
            if (!harness) {
              throw new Error("Codex plugin did not register its harness");
            }
            const scope = {
              config,
              agentId: "main",
              agentDir: state.agentDir(),
              workspaceDir: state.workspaceDir,
            };
            let discoveryError: unknown;
            const loadCatalog = harness.loadModelCatalog!.bind(harness);
            harness.loadModelCatalog = async (params) => {
              try {
                return await loadCatalog(params);
              } catch (error) {
                discoveryError = error;
                throw error;
              }
            };
            const registry = createEmptyPluginRegistry();
            registry.agentHarnesses.push({ pluginId: "codex", source: "test", harness });
            const previous = captureActivePluginRegistrySnapshot();
            setActivePluginRegistry(registry);
            try {
              const result = await listModels({
                ...scope,
                cfg: config,
                catalog: [],
                view: "all",
                refresh: true,
              });
              expect(discoveryError).toBeUndefined();
              expect(result.models).toEqual([
                expect.objectContaining({
                  id: "synthetic-opaque",
                  name: "Synthetic name",
                  available: true,
                  reasoning: true,
                }),
              ]);
              expect(requests).toContain("account/read");
              expect(requests).not.toContain("account/login/start");
              const rows = [...(await loadCatalog(scope))];
              expect(rows[0]).toMatchObject({ nativeRuntime: "codex", name: "Synthetic name" });
              expect(rows[0]).not.toHaveProperty("api");
              expect(rows[0]).not.toHaveProperty("baseUrl");
              expect(result.models[0]).not.toHaveProperty("nativeRuntime");
              const readiness = (cfg = config) =>
                harness.readModelCatalogReadiness?.({
                  ...scope,
                  config: cfg,
                  provider: "openai",
                  modelId: "synthetic-opaque",
                });
              expect(readiness()).toEqual({ accountType: "apiKey" });
              const configured = (cfg = config) =>
                listModels({
                  ...scope,
                  cfg,
                  catalog: structuredClone(rows),
                  view: "configured",
                  preparedOnly: true,
                });
              const calls = requests.length;
              expect((await configured()).models[0]?.available).toBe(true);
              expect(requests).toHaveLength(calls);
              expect((await configured({ ...config })).models[0]?.available).toBe(false);

              // A rejected explicit session lock cannot borrow native account readiness.
              const snapshot = { entries: rows, routeVariants: rows };
              const projector = createGatewayAgentModelCatalogProjector({
                cfg: config,
                agentId: "main",
                snapshot,
                metadataSnapshot: loadManifestMetadataSnapshot({ config, env: process.env }),
                preparedAuthStore: { version: 1, profiles: {} },
                lockedProfileId: "openai:missing",
              });
              const locked = await buildModelsListResult({
                context: {
                  getRuntimeConfig: () => config,
                  loadGatewayModelCatalogSnapshot: vi.fn(),
                  logGateway: { debug: vi.fn() },
                } as unknown as GatewayRequestContext,
                agentId: "main",
                params: { view: "configured" },
                preloadedOnly: true,
                preloadedCatalog: { agentId: "main", config, snapshot },
                catalogProjector: projector,
              });
              expect(locked.models[0]?.available).toBe(false);

              stdout.write(
                `${JSON.stringify({ method: "account/updated", params: { authMode: null } })}\n`,
              );
              expect((await configured()).models[0]?.available).toBe(false);
              for (const observed of [
                {
                  value: { type: "chatgpt", email: "synthetic@example.test", planType: "plus" },
                  mode: "chatgpt",
                  available: true,
                },
                { value: null, mode: undefined, available: false },
                { value: { type: "apiKey" }, mode: "apiKey", available: true },
              ]) {
                account = observed.value;
                const refreshed = await listModels({
                  ...scope,
                  cfg: config,
                  catalog: rows,
                  view: "all",
                  refresh: true,
                });
                expect(refreshed.models[0]?.available).toBe(observed.available);
                expect(readiness()).toEqual(
                  observed.mode ? { accountType: observed.mode } : undefined,
                );
              }
              const hostRoutes: OpenClawConfig["models"][] = [
                {
                  providers: {
                    openai: {
                      api: "openai-responses",
                      baseUrl: "https://host.example.test/v1",
                      models: [],
                    },
                  },
                },
                {
                  providers: {
                    openai: {
                      baseUrl: "",
                      models: [
                        {
                          id: " openai/synthetic-opaque ",
                          name: "Synthetic name",
                          api: "openai-responses",
                          baseUrl: "https://host.example.test/v1",
                          reasoning: true,
                          input: ["text"],
                          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                          maxTokens: 100,
                        },
                      ],
                    },
                  },
                },
                {
                  providers: {
                    openai: {
                      baseUrl: "",
                      apiKey: { source: "env", provider: "default", id: "SYNTHETIC_ABSENT_KEY" },
                      models: [],
                    },
                  },
                },
              ];
              for (const [routeIndex, models] of hostRoutes.entries()) {
                const hostConfig = { ...config, models };
                const host = await listModels({
                  ...scope,
                  cfg: hostConfig,
                  catalog: rows,
                  view: "configured",
                });
                expect(readiness(hostConfig)).toEqual({ accountType: "apiKey" });
                expect(host.models[0]?.available, `host route ${routeIndex}`).toBe(false);
              }
              expect(requests).not.toContain("account/login/start");
              child.emit("exit", 0, null);
              expect((await configured()).models[0]?.available).toBe(false);
              expect(
                createAgentHarnessCatalogEvaluator(scope)(rows[0]!, {
                  availability: true,
                  selectedAuthMode: "oauth",
                  evidence: "runtime",
                  routeResolution: null,
                }).availability,
              ).toBe(false);
              const hostRow = { ...rows[0]! };
              delete hostRow.nativeRuntime;
              const hostEvidence = {
                availability: true,
                selectedAuthMode: "oauth",
                evidence: "runtime" as const,
                routeResolution: null,
              };
              expect(createAgentHarnessCatalogEvaluator(scope)(hostRow, hostEvidence)).toBe(
                hostEvidence,
              );
              const replacement = createEmptyPluginRegistry();
              setActivePluginRegistry(replacement);
              expect((await configured()).models[0]?.available).toBe(false);
            } finally {
              await harness.dispose?.();
              child.emit("exit", 0, null);
              restoreActivePluginRegistrySnapshot(previous);
            }
          },
        );
      },
    );
  });
});
