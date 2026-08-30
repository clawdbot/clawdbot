// Cron model selection and thinking stay with their prepared workspace owner.
import fs from "node:fs/promises";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveAgentConfig } from "../../agents/agent-scope.js";
import type { ResolvedPublishedModelCatalogOwner } from "../../agents/prepared-model-catalog.types.js";
import { createPluginMetadataSnapshot } from "../../config/plugin-auto-enable.test-helpers.js";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { installPluginMetadataOwner } from "../../plugins/current-plugin-metadata.test-support.js";
import { createPluginCache } from "../../plugins/plugin-cache.js";
import {
  createPluginMetadataOwner,
  getPluginMetadataWorkspaceSnapshot,
} from "../../plugins/plugin-metadata-collection.js";
import { clearPluginMetadataLifecycleCaches } from "../../plugins/plugin-metadata-lifecycle.js";
import * as pluginMetadataSnapshotRuntime from "../../plugins/plugin-metadata-snapshot.js";
import {
  createColdPluginFixture,
  isColdPluginRuntimeLoaded,
} from "../../plugins/test-helpers/cold-plugin-fixtures.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";

const scopedThinkingCatalogMock = vi.fn(
  async (..._args: unknown[]): Promise<Array<Record<string, unknown>>> => [],
);

vi.mock("./run-model-selection.runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./run-model-selection.runtime.js")>();
  return {
    ...actual,
    loadProviderScopedThinkingCatalog: (...args: unknown[]) => scopedThinkingCatalogMock(...args),
  };
});

const thinkingConfig: OpenClawConfig = {};
const owner: ResolvedPublishedModelCatalogOwner = {
  catalogOwner: { agentId: "main", workspaceDir: "/tmp/cron-workspace" },
  agentId: "main",
  agentDir: "/tmp/cron-agent",
  workspaceDir: "/tmp/cron-workspace",
  config: thinkingConfig,
  authModes: {},
  authStore: { version: 1, profiles: {} },
  metadataSnapshot: createPluginMetadataSnapshot({
    config: thinkingConfig,
    workspaceDir: "/tmp/cron-workspace",
    manifestRegistry: { plugins: [], diagnostics: [] },
  }),
  modelCatalog: { entries: [], routeVariants: [] },
};

describe("resolveCronThinkingSelection scoped hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scopedThinkingCatalogMock.mockResolvedValue([]);
  });

  it("hydrates a runtime-only model through the provider-scoped helper", async () => {
    scopedThinkingCatalogMock.mockResolvedValue([
      { provider: "ollama", id: "minimax-m3:cloud", reasoning: true },
    ]);
    const { resolveCronThinkingSelection } = await import("./model-selection.js");
    const selection = await resolveCronThinkingSelection({
      cfg: {},
      owner,
      provider: "ollama",
      model: "minimax-m3:cloud",
      jobThinking: "medium",
    });
    expect(selection.requestedThinkLevel).toBe("medium");
    expect(selection.catalog).toEqual([
      expect.objectContaining({ provider: "ollama", id: "minimax-m3:cloud", reasoning: true }),
    ]);
    expect(scopedThinkingCatalogMock).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: "ollama",
        model: "minimax-m3:cloud",
        agentId: "main",
        agentDir: "/tmp/cron-agent",
        workspaceDir: "/tmp/cron-workspace",
      }),
    );
  });

  it("keeps the owner catalog and skips hydration when thinking is off", async () => {
    const { resolveCronThinkingSelection } = await import("./model-selection.js");
    const selection = await resolveCronThinkingSelection({
      cfg: {},
      owner,
      provider: "ollama",
      model: "minimax-m3:cloud",
      jobThinking: "off",
    });
    expect(selection.requestedThinkLevel).toBe("off");
    expect(scopedThinkingCatalogMock).not.toHaveBeenCalled();
  });
});

describe("resolveCronModelSelection prepared metadata", () => {
  it.each([
    { selection: "default", model: "default", modelSource: "default", rejected: false },
    { selection: "agent", model: "agent", modelSource: "agent", rejected: false },
    { selection: "subagent", model: "subagent", modelSource: "subagent", rejected: false },
    { selection: "hook", model: "policy-default", modelSource: "hook", rejected: false },
    { selection: "payload", model: "payload", modelSource: "payload", rejected: false },
    { selection: "session", model: "session", modelSource: "session", rejected: false },
    { selection: "override", model: "override", modelSource: "agent", rejected: false },
    { selection: "blocked", model: "blocked", modelSource: "payload", rejected: true },
    { selection: "inherited policy", model: "policy-work", modelSource: "payload", rejected: true },
    { selection: "agent policy", model: "policy-work", modelSource: "payload", rejected: false },
  ])(
    "keeps $selection resolution with the captured workspace after publication",
    async ({ selection, model, modelSource, rejected }) => {
      await withOpenClawTestState({ scenario: "minimal" }, async (state) => {
        const modelIds = [
          "default",
          "agent",
          "subagent",
          "payload",
          "session",
          "override",
          "blocked",
          "policy-default",
          "policy-work",
        ];
        const buildConfig = async (generation: string) => {
          const mainWorkspace = state.path(generation, "main");
          const workWorkspace = state.path(generation, "work");
          const fixtures: ReturnType<typeof createColdPluginFixture>[] = [];
          for (const [agentId, workspaceDir] of [
            ["main", mainWorkspace],
            ["work", workWorkspace],
          ] as const) {
            const pluginId = `cron-normalizer-${generation}-${agentId}`;
            const rootDir = path.join(workspaceDir, ".openclaw", "extensions", pluginId);
            await fs.mkdir(rootDir, { recursive: true });
            fixtures.push(
              createColdPluginFixture({
                rootDir,
                pluginId,
                manifest: {
                  providers: ["custom"],
                  channels: [],
                  channelConfigs: {},
                  providerAuthChoices: [],
                  modelIdNormalization: {
                    providers: {
                      custom: {
                        aliases: Object.fromEntries(
                          modelIds.map((id) => [id, `${generation}-${agentId}-${id}`]),
                        ),
                      },
                    },
                  },
                },
              }),
            );
          }
          const policyAlias = selection === "inherited policy" || selection === "agent policy";
          const config: OpenClawConfig = {
            plugins: {
              allow: fixtures.map((fixture) => fixture.pluginId),
              slots: { memory: "none" },
              entries: Object.fromEntries(
                fixtures.map((fixture) => [fixture.pluginId, { enabled: true }]),
              ),
            },
            models: {
              providers: {
                custom: {
                  baseUrl: "http://127.0.0.1:1/v1",
                  api: "openai-completions",
                  models: modelIds.map<ModelDefinitionConfig>((id) => ({
                    id,
                    name: id,
                    reasoning: false,
                    input: ["text"],
                    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                    contextWindow: 4096,
                    maxTokens: 256,
                  })),
                },
              },
            },
            agents: {
              ownership: "explicit",
              defaults: {
                systemAgent: { agentId: "main" },
                workspace: mainWorkspace,
                model: { primary: "custom/default" },
                models: { "custom/policy-default": { alias: "approved" } },
                modelPolicy: {
                  allow: policyAlias
                    ? ["approved"]
                    : selection === "override"
                      ? ["custom/default"]
                      : modelIds.filter((id) => id !== "blocked").map((id) => `custom/${id}`),
                },
              },
              entries: {
                main: { workspace: mainWorkspace },
                work: {
                  workspace: workWorkspace,
                  models: { "custom/policy-work": { alias: "approved" } },
                  ...(selection === "agent" || selection === "override"
                    ? { model: { primary: "custom/agent" } }
                    : {}),
                  ...(selection === "subagent" ? { subagents: { model: "custom/subagent" } } : {}),
                  ...(selection === "agent policy" ? { modelPolicy: { allow: ["approved"] } } : {}),
                },
              },
            },
            ...(selection === "hook" ? { hooks: { gmail: { model: "approved" } } } : {}),
          };
          return { config, workWorkspace, fixtures };
        };
        const captured = await buildConfig("captured");
        const ambient = await buildConfig("ambient");
        const pluginCache = createPluginCache();
        const metadataOwner = createPluginMetadataOwner(pluginCache);
        const dispose = installPluginMetadataOwner(metadataOwner, pluginCache);
        const loadSnapshot = vi.spyOn(pluginMetadataSnapshotRuntime, "loadPluginMetadataSnapshot");
        try {
          const metadata = metadataOwner.prepare({ config: captured.config });
          metadataOwner.publish(metadata, { config: captured.config });
          const capturedOwner: ResolvedPublishedModelCatalogOwner = {
            catalogOwner: { agentId: "work", workspaceDir: captured.workWorkspace },
            agentId: "work",
            agentDir: state.agentDir("work"),
            workspaceDir: captured.workWorkspace,
            config: captured.config,
            authModes: {},
            authStore: { version: 1, profiles: {} },
            metadataSnapshot: getPluginMetadataWorkspaceSnapshot(metadata, {
              workspaceDir: captured.workWorkspace,
            }),
            modelCatalog: { entries: [], routeVariants: [] },
          };
          metadataOwner.publish(metadataOwner.prepare({ config: ambient.config }), {
            config: ambient.config,
          });
          // Count discovery only after fixture preparation and both publications.
          const preparedLoads = loadSnapshot.mock.calls.length;
          const { resolveCronModelSelection } = await import("./model-selection.js");
          const agentConfig = resolveAgentConfig(captured.config, "work");
          const result = await resolveCronModelSelection({
            cfg: captured.config,
            owner: capturedOwner,
            agentConfigOverride:
              selection === "override"
                ? { ...agentConfig, model: { primary: "custom/override" } }
                : agentConfig,
            agentId: "work",
            agentDir: capturedOwner.agentDir,
            workspaceDir: captured.workWorkspace,
            sessionEntry:
              selection === "session"
                ? { providerOverride: "custom", modelOverride: "session" }
                : {},
            payload: {
              kind: "agentTurn",
              message: "report",
              ...(selection === "payload" || selection === "blocked"
                ? { model: `custom/${selection}` }
                : {}),
              ...(selection === "inherited policy" || selection === "agent policy"
                ? { model: "approved" }
                : {}),
            },
            isGmailHook: selection === "hook",
          });
          if (rejected) {
            expect(result).toEqual({
              ok: false,
              error: expect.stringContaining(`custom/captured-work-${model} is not in`),
            });
          } else {
            expect(result).toMatchObject({
              ok: true,
              provider: "custom",
              model: `captured-work-${model}`,
              modelSource,
            });
          }
          expect(loadSnapshot.mock.calls.length).toBe(preparedLoads);
          expect([...captured.fixtures, ...ambient.fixtures].some(isColdPluginRuntimeLoaded)).toBe(
            false,
          );
        } finally {
          loadSnapshot.mockRestore();
          dispose();
          clearPluginMetadataLifecycleCaches();
        }
      });
    },
  );
});
