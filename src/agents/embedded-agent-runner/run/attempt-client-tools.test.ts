import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../../../config/types.openclaw.js";
import { setPluginToolMeta } from "../../../plugins/tools.js";
import { applyCodeModeCatalog, createCodeModeTools } from "../../code-mode.js";
import { createStubTool } from "../../test-helpers/agent-tool-stubs.js";
import {
  applyToolSearchCatalog,
  createToolSearchCatalogRef,
  TOOL_SEARCH_RAW_TOOL_NAME,
} from "../../tool-search.js";
import { prepareEmbeddedAttemptClientTools } from "./attempt-client-tools.js";

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
    effectiveTools: [],
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
  it("hides client tools behind the code-mode catalog when code mode is engaged", () => {
    const catalogRef = seedCatalog("code-mode", CODE_MODE_CONFIG);

    const result = prepare({
      codeModeControlsEnabledForRun: true,
      attemptConfig: CODE_MODE_CONFIG,
      // Deliberately catalog-disabled: the code-mode branch must not read this.
      toolSearchRuntimeConfig: CATALOGS_DISABLED_CONFIG,
      catalogRef,
    });

    expect(result.clientToolDefs).toEqual([]);
    expect(result.allCustomTools).toEqual([]);
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
