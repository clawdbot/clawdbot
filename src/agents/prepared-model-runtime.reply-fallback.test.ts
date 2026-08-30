// Preserve module setup before modules that consume it.
// oxfmt-ignore
import {
  cleanupPreparedModelRuntimeHarness,
  getPreparedModelRuntimeMocks,
  resetPreparedModelRuntimeHarness,
} from "./prepared-model-runtime.test-harness.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveModelFallbackOptions } from "../auto-reply/reply/agent-runner-run-params.js";
import { runPreparedReply } from "../auto-reply/reply/get-reply-run.js";
import type { RunPreparedReplyParams } from "../auto-reply/reply/get-reply-run.types.js";
import { bindPreparedReplyDispatchRuntime } from "../auto-reply/reply/prepared-reply-dispatch-context.js";
import type { FollowupRun } from "../auto-reply/reply/queue.js";
import { createPluginMetadataSnapshot } from "../config/plugin-auto-enable.test-helpers.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { listRuntimePluginIdsFromRegistry } from "../plugins/active-runtime-registry.js";
import type { PluginManifestRecord } from "../plugins/manifest-registry.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { createPluginRecord } from "../plugins/status.test-helpers.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../test-utils/openclaw-test-state.js";
import * as agentScope from "./agent-scope.js";
import { resolveAgentRuntimePluginLoadPlan } from "./harness/runtime-plugin-load-plan.js";
import { resolveModelCandidateChain } from "./model-fallback-candidates.js";
import { getPreparedModelRuntimePluginGeneration } from "./prepared-model-runtime-generation-scope.js";
import {
  acquireAgentRunPreparedModelRuntime,
  loadPublishedGatewayReplyDispatchRuntime,
  refreshPreparedModelRuntimeSnapshots,
} from "./prepared-model-runtime.js";

const reply = vi.hoisted(() => ({ context: vi.fn(), execute: vi.fn() }));
vi.mock("../auto-reply/reply/get-reply-run-context.js", () => ({
  prepareReplyRunContext: reply.context,
}));
vi.mock("../auto-reply/reply/get-reply-run-admission.js", () => ({
  prepareReplyRunAdmission: async (context: unknown) => context,
}));
vi.mock("../auto-reply/reply/get-reply-run-execute.js", () => ({
  executePreparedReplyRun: reply.execute,
}));

const mocks = getPreparedModelRuntimeMocks();
let state: OpenClawTestState;

describe("prepared reply fallback ownership", () => {
  beforeEach(async () => {
    state = await createOpenClawTestState({ label: "prepared-model-runtime" });
    resetPreparedModelRuntimeHarness(state);
    vi.clearAllMocks();
    const actual = await vi.importActual<typeof import("./agent-scope.js")>("./agent-scope.js");
    vi.spyOn(agentScope, "resolveAgentConfig").mockImplementation(actual.resolveAgentConfig);
    vi.spyOn(agentScope, "resolveAgentModelFallbacksOverride").mockImplementation(
      actual.resolveAgentModelFallbacksOverride,
    );
    vi.spyOn(agentScope, "resolveEffectiveModelFallbacks").mockImplementation(
      actual.resolveEffectiveModelFallbacks,
    );
    vi.spyOn(agentScope, "resolveSubagentSpawnModelFallbacksOverride").mockImplementation(
      actual.resolveSubagentSpawnModelFallbacksOverride,
    );
  });
  afterEach(() => vi.restoreAllMocks());

  it.each([
    { scope: "agent", source: "auto", locked: false },
    { scope: "subagent", source: "auto", locked: false },
    { scope: "per-agent subagent", source: "auto", locked: false },
    { scope: "fallback-only subagent", source: "auto", locked: false },
    { scope: "subagent", source: "user", locked: false },
    { scope: "subagent", source: "auto", locked: true },
  ] as const)(
    "admits $scope routes with source=$source, locked=$locked without widening execution policy",
    async ({ scope, source, locked }) => {
      const config: OpenClawConfig = {
        agents: {
          entries: {
            default:
              scope === "per-agent subagent" || scope === "fallback-only subagent"
                ? {
                    subagents: {
                      model: {
                        ...(scope === "per-agent subagent" ? { primary: "selected/model" } : {}),
                        fallbacks: ["fallback/model"],
                      },
                    },
                  }
                : {},
          },
          defaults: {
            model: {
              primary: "initial/model",
              fallbacks: scope === "agent" ? ["fallback/model"] : [],
            },
            subagents: {
              model: {
                primary: "selected/model",
                fallbacks: scope === "per-agent subagent" ? [] : ["fallback/model"],
              },
            },
          },
        },
        plugins: { allow: ["initial", "selected", "fallback"], slots: { memory: "none" } },
      };
      const manifests: PluginManifestRecord[] = ["initial", "selected", "fallback"].map((id) => ({
        id,
        name: id,
        origin: "bundled",
        channels: [],
        providers: [id],
        cliBackends: [],
        skills: [],
        hooks: [],
        rootDir: `/plugins/${id}`,
        source: `/plugins/${id}/index.js`,
        manifestPath: `/plugins/${id}/openclaw.plugin.json`,
        activation: { onStartup: false, onProviders: [id] },
      }));
      const metadata = createPluginMetadataSnapshot({
        config,
        manifestRegistry: { plugins: manifests, diagnostics: [] },
      });
      mocks.configuredAgentIds = ["default"];
      mocks.loadAgentRuntimePluginRegistryHandle.mockImplementation((params) => {
        const registry = createEmptyPluginRegistry();
        const plan = resolveAgentRuntimePluginLoadPlan({
          config,
          workspaceDir: "/tmp/unused-workspace",
          metadataSnapshot: metadata,
          basePluginIds: params.reusableRegistry
            ? listRuntimePluginIdsFromRegistry(params.reusableRegistry)
            : [],
          selections: params.selections ?? [],
        });
        registry.plugins.push(
          ...(plan.pluginIds ?? []).map((id) => createPluginRecord({ id, origin: "bundled" })),
        );
        return registry;
      });
      await refreshPreparedModelRuntimeSnapshots(config, {
        gatewayLifecycle: true,
        catalogMode: "static",
        allowGatewaySubagentBinding: true,
        pluginMetadataSnapshot: metadata,
      });
      const dispatch = (await loadPublishedGatewayReplyDispatchRuntime({ agentId: "default" }))!;
      const run = {
        config,
        agentId: "default",
        agentDir: dispatch.agentDir,
        workspaceDir: dispatch.workspaceDir,
        provider: "selected",
        model: "model",
        sessionKey: scope === "agent" ? "agent:default:main" : "agent:default:subagent:test",
        hasSessionModelOverride: true,
        modelOverrideSource: source,
        modelSelectionLocked: locked,
        hasAutoFallbackProvenance: true,
      } as FollowupRun["run"];
      reply.context.mockResolvedValue({ kind: "run", workspaceDir: dispatch.workspaceDir });
      reply.execute.mockImplementation(async () => {
        const pluginGeneration = getPreparedModelRuntimePluginGeneration()!;
        const candidates = resolveModelCandidateChain({
          ...resolveModelFallbackOptions(run),
          manifestPlugins: metadata.plugins,
        });
        expect(candidates.map((candidate) => candidate.provider)).toEqual(
          source === "user" || locked ? ["selected"] : ["selected", "fallback"],
        );
        const nested = await acquireAgentRunPreparedModelRuntime(
          {
            config,
            agentId: run.agentId,
            agentDir: run.agentDir,
            workspaceDir: run.workspaceDir,
            allowGatewaySubagentBinding: true,
            runtimePluginSelections: candidates.map((candidate) => ({
              provider: candidate.provider,
              modelId: candidate.model,
            })),
          },
          { pluginGeneration },
        );
        nested.release();
        return { text: "fallback admitted" };
      });
      const execute = bindPreparedReplyDispatchRuntime(dispatch, () =>
        runPreparedReply({ provider: run.provider, model: run.model } as RunPreparedReplyParams),
      );

      await expect(execute()).resolves.toEqual({ text: "fallback admitted" });
      expect(reply.execute).toHaveBeenCalledOnce();
    },
  );
});

afterEach(async ({ task }) => {
  await cleanupPreparedModelRuntimeHarness(state, task.result?.state === "fail");
});
