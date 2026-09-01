import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { loadOpenClawPluginsWithInternalOverrides } from "../plugins/loader-runtime-load.js";
import { resetPluginLoaderTestStateForTest } from "../plugins/loader.test-fixtures.js";
import { createPluginRuntime } from "../plugins/runtime/index.js";
import { buildPluginRuntimeLoadOptions } from "../plugins/runtime/load-context.js";
import { resolvePluginRuntimeLoadContext } from "../plugins/runtime/load-context.resolve.js";
import { resolvePluginTools } from "../plugins/tools.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { getTaskFlowByIdForOwner, listTaskFlowsForOwner } from "./task-flow-owner-access.js";
import { reloadTaskFlowRegistryFromStore } from "./task-flow-registry.js";
import { resetTaskFlowRegistryForTests } from "./task-runtime.test-helpers.js";

const PLUGIN_ID = "a09-managed-flow-fixture";
const TOOL_NAME = "a09_managed_flow";
const OWNER_KEY = "agent:main:a09";

function resetTestState(): void {
  resetPluginLoaderTestStateForTest();
  resetTaskFlowRegistryForTests({ persist: false });
}

beforeEach(resetTestState);
afterEach(resetTestState);

describe("plugin-managed TaskFlows", () => {
  it("loads a real plugin tool that creates and finishes an owner-scoped managed flow", async () => {
    await withOpenClawTestState(
      {
        env: { OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1" },
        layout: "state-only",
        prefix: "openclaw-plugin-managed-flow-",
      },
      async (state) => {
        resetTaskFlowRegistryForTests();
        const pluginEntry = await state.writeText(
          `plugins/${PLUGIN_ID}/index.cjs`,
          `module.exports = {
  id: ${JSON.stringify(PLUGIN_ID)},
  register(api) {
    api.registerTool((ctx) => {
      const flows = api.runtime.tasks.managedFlows.fromToolContext(ctx);
      return {
        name: ${JSON.stringify(TOOL_NAME)},
        description: "Create and finish a managed TaskFlow.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {},
        },
        async execute() {
          const created = flows.createManaged({
            controllerId: "fixture/a09-managed-flow",
            goal: "Prove plugin-managed flow registration",
            currentStep: "create",
            stateJson: { phase: "created" },
            createdAt: 100,
            updatedAt: 100,
          });
          const finished = flows.finish({
            flowId: created.flowId,
            expectedRevision: created.revision,
            stateJson: { phase: "finished" },
            updatedAt: 200,
            endedAt: 200,
          });
          if (!finished.applied) {
            throw new Error("fixture managed-flow mutation failed: " + finished.code);
          }
          return {
            content: [{ type: "text", text: finished.flow.flowId }],
            details: {
              flowId: finished.flow.flowId,
              revision: finished.flow.revision,
            },
          };
        },
      };
    }, { name: ${JSON.stringify(TOOL_NAME)} });
  },
};
`,
        );
        await state.writeJson(`plugins/${PLUGIN_ID}/openclaw.plugin.json`, {
          id: PLUGIN_ID,
          contracts: { tools: [TOOL_NAME] },
          configSchema: {
            type: "object",
            additionalProperties: false,
            properties: {},
          },
        });

        const config: OpenClawConfig = {
          plugins: {
            enabled: true,
            allow: [PLUGIN_ID],
            load: { paths: [pluginEntry] },
            entries: {
              [PLUGIN_ID]: { enabled: true },
            },
            slots: { memory: "none" },
          },
        };
        const env = state.env;
        const loadContext = resolvePluginRuntimeLoadContext({
          config,
          env,
          onlyPluginIds: [PLUGIN_ID],
          workspaceDir: state.workspaceDir,
        });
        const metadataSnapshot = loadContext.metadataSnapshot;
        if (!metadataSnapshot) {
          throw new Error("production load context did not resolve plugin metadata");
        }
        const registry = loadOpenClawPluginsWithInternalOverrides(
          {
            ...buildPluginRuntimeLoadOptions(loadContext),
            activate: false,
            cache: false,
            onlyPluginIds: [PLUGIN_ID],
          },
          {
            // The production host-owned path supplies the real runtime directly instead of
            // recompiling its lazy source graph when the fixture first reads api.runtime.
            runtime: createPluginRuntime(),
            moduleLoader: {
              installNativeSdkResolver: false,
              loaderFilename: import.meta.url,
              tryNative: false,
            },
          },
        );

        expect(registry.plugins).toEqual(
          expect.arrayContaining([expect.objectContaining({ id: PLUGIN_ID, status: "loaded" })]),
        );
        expect(registry.tools).toEqual([
          expect.objectContaining({ pluginId: PLUGIN_ID, names: [TOOL_NAME] }),
        ]);
        expect(registry.diagnostics.filter((entry) => entry.level === "error")).toEqual([]);

        const tools = resolvePluginTools({
          context: {
            config,
            runtimeConfig: loadContext.config,
            sessionKey: OWNER_KEY,
            workspaceDir: state.workspaceDir,
          },
          env,
          preparedRuntime: {
            loadContext,
            metadataSnapshot,
            registry,
          },
          toolAllowlist: [TOOL_NAME],
        });
        const tool = tools.find((entry) => entry.name === TOOL_NAME);
        if (!tool) {
          throw new Error("production tool resolution did not materialize the fixture tool");
        }

        const result = await tool.execute("call-a09-managed-flow", {}, undefined);
        const details = result.details as { flowId?: string; revision?: number } | undefined;
        expect(details).toEqual({
          flowId: expect.any(String),
          revision: 1,
        });
        const flowId = details?.flowId;
        expect(flowId).toBeDefined();
        if (!flowId) {
          throw new Error("fixture tool did not return a TaskFlow id");
        }

        reloadTaskFlowRegistryFromStore();
        expect(getTaskFlowByIdForOwner({ flowId, callerOwnerKey: OWNER_KEY })).toMatchObject({
          flowId,
          syncMode: "managed",
          ownerKey: OWNER_KEY,
          controllerId: "fixture/a09-managed-flow",
          revision: 1,
          status: "succeeded",
          goal: "Prove plugin-managed flow registration",
          currentStep: "create",
          stateJson: { phase: "finished" },
          createdAt: 100,
          updatedAt: 200,
          endedAt: 200,
        });
        expect(listTaskFlowsForOwner({ callerOwnerKey: OWNER_KEY })).toHaveLength(1);
        expect(
          getTaskFlowByIdForOwner({ flowId, callerOwnerKey: "agent:main:other" }),
        ).toBeUndefined();
        expect(listTaskFlowsForOwner({ callerOwnerKey: "agent:main:other" })).toEqual([]);
      },
    );
  });
});
