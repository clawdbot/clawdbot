import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../../plugins/tool-metadata.js";
import { setChannelAgentToolMeta } from "../../channel-tool-metadata.js";
import { createCodeModeCatalogProjection } from "../../code-mode-catalog.js";
import { markCodeModeControlTool } from "../../code-mode-control-tools.js";
import { applyCodeModeCatalog, createCodeModeTools } from "../../code-mode.js";
import { runUntilCompleted } from "../../code-mode.test-support.js";
import { createAgentHarnessPromptToolPolicy } from "../../harness/prompt-tool-policy.js";
import { wrapToolDefinition } from "../../sessions/tools/tool-definition-wrapper.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import { compactToolSearchCatalogEntry } from "../../tool-search-catalog.js";
import {
  applyToolSearchCatalog,
  clearToolSearchCatalog,
  createToolSearchCatalogRef,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "../../tool-search.js";
import { jsonResult } from "../../tools/common.js";
import { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";
import { wrapEmbeddedAttemptToolWithActivity } from "./tool-activity-heartbeat.js";

const CODE_MODE_CONFIG: OpenClawConfig = { tools: { codeMode: true, toolSearch: false } };
const TOOL_SEARCH_CONFIG: OpenClawConfig = {
  tools: { codeMode: false, toolSearch: { enabled: true, mode: "tools" } },
};
const CATALOGS_DISABLED_CONFIG: OpenClawConfig = {
  tools: { codeMode: false, toolSearch: false },
};

function clientTool(name: string) {
  return {
    type: "function" as const,
    function: { name, description: `client ${name}`, parameters: { type: "object" } },
  };
}

/**
 * Seeds `catalogRef.current` the way the runner does before client tools are
 * appended; without a registered catalog the append is a no-op and both
 * branches look identical.
 */
function seedCatalog(mode: "code-mode" | "tool-search", config: OpenClawConfig) {
  const catalogRef = createToolSearchCatalogRef();
  // A catalog only registers when its own control tools are present, so the
  // seed has to carry them exactly as the runner's tool surface does.
  const controlTools =
    mode === "code-mode"
      ? createCodeModeTools({
          config,
          catalogRef,
          executeTool: async () => ({ content: [], details: {} }),
        })
      : [createStubTool(TOOL_SEARCH_RAW_TOOL_NAME)];
  const seedParams = {
    tools: [...controlTools, createStubTool("seeded_target")],
    config,
    sessionId: "session",
    sessionKey: "session-key",
    agentId: "main",
    runId: "run",
    catalogRef,
  };
  const seeded =
    mode === "code-mode" ? applyCodeModeCatalog(seedParams) : applyToolSearchCatalog(seedParams);
  // Guard the fixture itself: an unregistered catalog would make the append a
  // no-op and every assertion below would pass for the wrong reason.
  expect(seeded.catalogRegistered).toBe(true);
  return catalogRef;
}

function prepare(input: {
  codeModeControlsEnabledForRun: boolean;
  attemptConfig: OpenClawConfig;
  toolSearchRuntimeConfig: OpenClawConfig;
  catalogRef: ReturnType<typeof createToolSearchCatalogRef>;
  effectiveTools?: ReturnType<typeof createStubTool>[];
  uncompactedEffectiveTools?: ReturnType<typeof createStubTool>[];
  clientTools?: ReturnType<typeof clientTool>[];
}) {
  return prepareEmbeddedAttemptClientTools({
    attempt: {
      config: input.attemptConfig,
      sessionId: "session",
      runId: "run",
    },
    catalogToolHookContext: undefined,
    codeModeControlsEnabledForRun: input.codeModeControlsEnabledForRun,
    deferredDirectoryToolsCallable: false,
    effectiveTools: input.effectiveTools ?? [],
    replaySafetyOptions: { declaredReplaySafe: () => undefined },
    sandboxEnabled: false,
    sandboxSessionKey: "session-key",
    sessionAgentId: "main",
    toolSearchCatalogRef: input.catalogRef,
    toolSearchRuntimeConfig: input.toolSearchRuntimeConfig,
    uncompactedEffectiveTools: input.uncompactedEffectiveTools ?? [],
    clientTools: input.clientTools ?? [clientTool("client_probe")],
  } as unknown as Parameters<typeof prepareEmbeddedAttemptClientTools>[0]);
}

describe("prepareEmbeddedAttemptClientTools", () => {
  it("records core read entitlement without plugin or channel shadows", () => {
    const coreRead = createStubTool("read");
    const pluginRead = createStubTool("read");
    const channelRead = createStubTool("read");
    const catalogRef = createToolSearchCatalogRef();
    setPluginToolMeta(pluginRead, { pluginId: "example-plugin", optional: false });
    setChannelAgentToolMeta(channelRead as never, { channelId: "example-channel" });

    expect(
      [coreRead, pluginRead, channelRead].map(
        (tool) =>
          prepare({
            codeModeControlsEnabledForRun: false,
            attemptConfig: CATALOGS_DISABLED_CONFIG,
            toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
            catalogRef,
            uncompactedEffectiveTools: [tool],
          }).coreReadAuthorized,
      ),
    ).toEqual([true, false, false]);
  });

  it("collects only the marked Code Mode exec as a code-mode exec tool name", () => {
    const catalogRef = createToolSearchCatalogRef();
    const markedExec = markCodeModeControlTool(createStubTool("exec"));
    const plainExec = createStubTool("exec");

    expect(
      [markedExec, plainExec].map((tool) =>
        Array.from(
          prepare({
            codeModeControlsEnabledForRun: true,
            attemptConfig: CATALOGS_DISABLED_CONFIG,
            toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
            catalogRef,
            effectiveTools: [tool],
            uncompactedEffectiveTools: [],
          }).codeModeExecToolNames,
        ),
      ),
    ).toEqual([["exec"], []]);
  });

  it.each([CODE_MODE_CONFIG, CATALOGS_DISABLED_CONFIG])(
    "hides client tools when the attempt engages code mode",
    (config) => {
      const catalogRef = seedCatalog("code-mode", config);

      const result = prepare({
        codeModeControlsEnabledForRun: true,
        attemptConfig: config,
        // Deliberately catalog-disabled: the code-mode branch must not read this.
        toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
        catalogRef,
      });

      expect(result.clientToolDefs).toEqual([]);
      expect(result.allCustomTools).toEqual([]);
    },
  );

  it("advertises and invokes final callable owners after a normalized client collision", async () => {
    const catalogRef = createToolSearchCatalogRef();
    const codeModeSkills = [
      {
        name: "fixture-skill",
        description: "Keep existing Code Mode skill guidance.",
        location: "/fixture/SKILL.md",
        source: { filePath: "/fixture/SKILL.md", readContent: "fixture" },
      },
    ];
    const receivedSecrets: unknown[] = [];
    const trustedPlugin = Object.assign(createStubTool("llm-task"), {
      description: "harvesting trusted helper",
      parameters: Type.Object({ secret: Type.String() }),
      outputSchema: Type.Object({ receipt: Type.String() }, { additionalProperties: false }),
      execute: async (_toolCallId: string, input: unknown) => {
        receivedSecrets.push(input);
        return jsonResult({ receipt: "trusted-plugin" });
      },
    });
    setPluginToolMeta(trustedPlugin, { pluginId: "trusted-plugin", optional: false });
    const shadowedPlugin = Object.assign(createStubTool("hidden_owner"), {
      description: "orchard harvesting orchard harvesting",
    });
    setPluginToolMeta(shadowedPlugin, { pluginId: "trusted-plugin", optional: false });
    const controls = createCodeModeTools({
      config: CODE_MODE_CONFIG,
      sessionId: "session",
      sessionKey: "session-key",
      agentId: "main",
      runId: "run",
      catalogRef,
      codeModeSkills,
    });
    const compacted = applyCodeModeCatalog({
      tools: [...controls, trustedPlugin, shadowedPlugin],
      config: CODE_MODE_CONFIG,
      sessionId: "session",
      sessionKey: "session-key",
      agentId: "main",
      runId: "run",
      catalogRef,
      codeModeSkills,
    });
    const initialExec = compacted.tools.find((tool) => tool.name === "exec");
    expect(initialExec?.description).toContain(
      "- llm_task { secret: string } -> { receipt: string }",
    );
    expect(initialExec?.description).toContain("Skills are available through the async `skills`");

    const prepared = prepare({
      codeModeControlsEnabledForRun: true,
      attemptConfig: CODE_MODE_CONFIG,
      toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
      catalogRef,
      effectiveTools: compacted.tools.map((tool) =>
        wrapEmbeddedAttemptToolWithActivity(tool, "run"),
      ),
      uncompactedEffectiveTools: [trustedPlugin, shadowedPlugin],
      clientTools: [clientTool("llm_task"), clientTool("hidden_owner")],
    });
    const projection = createCodeModeCatalogProjection(
      (catalogRef.current?.entries ?? []).map(compactToolSearchCatalogEntry),
    );
    const trustedBinding = projection.bindings.find((binding) => binding.name === "llm-task");
    expect(trustedBinding?.callableName).toMatch(/^llm_task_[a-f0-9]{8}$/);
    expect(projection.byCallableName.get("llm_task")?.source).toBe("client");

    const providerExec = prepared.allCustomTools.find((tool) => tool.name === "exec");
    expect(providerExec?.description).toContain("- llm_task unknown -> ?");
    expect(providerExec?.description).toContain(
      `- ${trustedBinding?.callableName} { secret: string } -> { receipt: string }`,
    );
    expect(providerExec?.description).toContain("Skills are available through the async `skills`");

    const guestResult = await runUntilCompleted({
      execTool: controls[0]!,
      waitTool: controls[1]!,
      code: `
        const [match] = await catalog.search("orchard harvesting", { limit: 1 });
        const result = await match({ secret: "fixture-secret-never-client" });
        return { callableName: match.callableName, result };
      `,
    });
    expect(guestResult.value).toEqual({
      callableName: trustedBinding?.callableName,
      result: { receipt: "trusted-plugin" },
    });
    expect(receivedSecrets).toEqual([{ secret: "fixture-secret-never-client" }]);
    expect(prepared.clientToolCallSlots).toEqual([]);

    createAgentHarnessPromptToolPolicy({
      tools: prepared.allCustomTools,
      catalogRef,
      codeModeControlsEnabled: true,
    }).apply({ toolsAllow: ["llm-task"] });
    expect(providerExec?.description).toContain(
      "- llm_task { secret: string } -> { receipt: string }",
    );
    expect(providerExec?.description).not.toContain("- llm_task unknown -> ?");
    expect(providerExec?.description).not.toContain(trustedBinding?.callableName);
    expect(providerExec?.description).toContain("Skills are available through the async `skills`");
  });

  it("hides client tools behind the tool-search catalog when code mode is not engaged", () => {
    const catalogRef = seedCatalog("tool-search", TOOL_SEARCH_CONFIG);

    const result = prepare({
      codeModeControlsEnabledForRun: false,
      // Deliberately catalog-disabled: the tool-search branch must not read this.
      attemptConfig: CATALOGS_DISABLED_CONFIG,
      toolSearchRuntimeConfig: TOOL_SEARCH_CONFIG,
      catalogRef,
    });

    expect(result.clientToolDefs).toEqual([]);
    expect(result.allCustomTools).toEqual([]);
  });

  it("keeps registry descriptions current until catalog cleanup releases every wrapper", () => {
    const catalogRef = createToolSearchCatalogRef();
    const catalogTools = [createStubTool("allowed_target"), createStubTool("removed_target")];
    const controls = createCodeModeTools({
      config: CODE_MODE_CONFIG,
      sessionId: "session",
      sessionKey: "session-key",
      agentId: "main",
      runId: "run",
      catalogRef,
    });
    const compacted = applyCodeModeCatalog({
      tools: [...controls, ...catalogTools],
      config: CODE_MODE_CONFIG,
      sessionId: "session",
      sessionKey: "session-key",
      agentId: "main",
      runId: "run",
      catalogRef,
    });
    const originalExec = compacted.tools.find((tool) => tool.name === "exec")!;
    const activityTools = compacted.tools.map((tool) =>
      wrapEmbeddedAttemptToolWithActivity(tool, "run"),
    );
    const activityExec = activityTools.find((tool) => tool.name === "exec")!;
    const prepared = prepare({
      codeModeControlsEnabledForRun: true,
      attemptConfig: CODE_MODE_CONFIG,
      toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
      catalogRef,
      effectiveTools: activityTools,
      uncompactedEffectiveTools: catalogTools,
      clientTools: [],
    });
    const originalDefinition = prepared.allCustomTools.find((tool) => tool.name === "exec")!;
    const activeRegistryExec = wrapToolDefinition(originalDefinition);

    createAgentHarnessPromptToolPolicy({
      tools: prepared.allCustomTools,
      catalogRef,
      codeModeControlsEnabled: true,
    }).apply({ toolsAllow: ["allowed_target"] });

    const refreshedRegistryExec = wrapToolDefinition(originalDefinition);
    for (const tool of [
      originalExec,
      activityExec,
      originalDefinition,
      activeRegistryExec,
      refreshedRegistryExec,
    ]) {
      expect(tool.description).toContain("- allowed_target");
      expect(tool.description).not.toContain("- removed_target");
    }

    const expiredCatalogObserver = catalogRef.onChange!;
    clearToolSearchCatalog({ catalogRef, runId: "run" });
    expect(catalogRef.current).toBeUndefined();
    expect(catalogRef.onChange).toBeUndefined();

    for (const tool of [originalExec, activityExec, originalDefinition, activeRegistryExec]) {
      tool.description = "released description";
    }
    expiredCatalogObserver();
    for (const tool of [originalExec, activityExec, originalDefinition, activeRegistryExec]) {
      expect(tool.description).toBe("released description");
    }

    const postCleanupRegistryExec = wrapToolDefinition(originalDefinition);
    postCleanupRegistryExec.description = "released registry wrapper";
    expiredCatalogObserver();
    expect(postCleanupRegistryExec.description).toBe("released registry wrapper");
  });

  it("releases the previous description observer when a run catalog observer is replaced", () => {
    const catalogRef = createToolSearchCatalogRef();
    const context = {
      config: CODE_MODE_CONFIG,
      sessionId: "session",
      sessionKey: "session-key",
      agentId: "main",
      runId: "run",
      catalogRef,
    };
    const originalControls = createCodeModeTools(context);
    const first = applyCodeModeCatalog({
      ...context,
      tools: [...originalControls, createStubTool("original_target")],
    });
    const originalExec = first.tools.find((tool) => tool.name === "exec")!;
    const originalWrapper = wrapEmbeddedAttemptToolWithActivity(originalExec, "run");
    const expiredCatalogObserver = catalogRef.onChange!;

    const replacementControls = createCodeModeTools(context);
    const replacement = applyCodeModeCatalog({
      ...context,
      tools: [...replacementControls, createStubTool("replacement_target")],
    });
    const replacementExec = replacement.tools.find((tool) => tool.name === "exec")!;
    expect(catalogRef.onChange).not.toBe(expiredCatalogObserver);
    expect(replacementExec.description).toContain("- replacement_target");

    originalExec.description = "released original description";
    originalWrapper.description = "released original wrapper";
    expiredCatalogObserver();
    expect(originalExec.description).toBe("released original description");
    expect(originalWrapper.description).toBe("released original wrapper");
    expect(replacementExec.description).toContain("- replacement_target");

    clearToolSearchCatalog({ catalogRef, runId: "run" });
  });

  it("keeps client tools directly callable when neither catalog is engaged", () => {
    const catalogRef = seedCatalog("tool-search", TOOL_SEARCH_CONFIG);

    const result = prepare({
      codeModeControlsEnabledForRun: false,
      attemptConfig: TOOL_SEARCH_CONFIG,
      toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
      catalogRef,
    });

    expect(result.clientToolDefs.map((tool) => tool.name)).toEqual(["client_probe"]);
  });

  it("binds side-effect metadata to the concrete plugin tool owner", () => {
    const catalogRef = seedCatalog("tool-search", TOOL_SEARCH_CONFIG);
    const memoryStore = createStubTool("memory_store");
    const memoryForget = createStubTool("memory_forget");
    for (const tool of [memoryStore, memoryForget]) {
      setPluginToolMeta(tool as never, {
        pluginId: "memory-lancedb",
        optional: false,
        sideEffecting: true,
      });
    }

    const result = prepare({
      codeModeControlsEnabledForRun: false,
      attemptConfig: CATALOGS_DISABLED_CONFIG,
      toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
      catalogRef,
      uncompactedEffectiveTools: [memoryStore, memoryForget],
    });

    expect(result.sideEffectToolOwners).toEqual(
      new Map([
        ["memory_store", '["memory-lancedb","memory_store"]'],
        ["memory_forget", '["memory-lancedb","memory_forget"]'],
      ]),
    );
  });

  it.each(["memory_store", "Memory_Store"])(
    "keeps client shadow %s admitted but drops ambiguous side-effect ownership",
    (clientName) => {
      const catalogRef = seedCatalog("tool-search", TOOL_SEARCH_CONFIG);
      const memoryStore = createStubTool("memory_store");
      setPluginToolMeta(memoryStore as never, {
        pluginId: "memory-lancedb",
        optional: false,
        sideEffecting: true,
      });

      const result = prepare({
        codeModeControlsEnabledForRun: false,
        attemptConfig: CATALOGS_DISABLED_CONFIG,
        toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
        catalogRef,
        uncompactedEffectiveTools: [memoryStore],
        clientTools: [clientTool(clientName)],
      });

      expect(result.clientToolDefs.map((tool) => tool.name)).toEqual([clientName]);
      expect(result.sideEffectToolOwners).toEqual(new Map());
    },
  );

  it("keeps non-side-effecting plugin shadows admissible", () => {
    const catalogRef = seedCatalog("tool-search", TOOL_SEARCH_CONFIG);
    const pluginTool = createStubTool("plugin_probe");
    setPluginToolMeta(pluginTool as never, {
      pluginId: "example-plugin",
      optional: false,
    });

    const result = prepare({
      codeModeControlsEnabledForRun: false,
      attemptConfig: CATALOGS_DISABLED_CONFIG,
      toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
      catalogRef,
      uncompactedEffectiveTools: [pluginTool],
      clientTools: [clientTool("plugin_probe")],
    });

    expect(result.clientToolDefs.map((tool) => tool.name)).toEqual(["plugin_probe"]);
    expect(result.sideEffectToolOwners).toEqual(new Map());
  });
});
