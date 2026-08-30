import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolSearchCatalogRef } from "../../tool-search.js";
import {
  cleanupTempPaths,
  createContextEngineAttemptRunner,
  createContextEngineBootstrapAndAssemble,
  getHoisted,
  preloadRunEmbeddedAttemptForTests,
  resetEmbeddedAttemptHarness,
} from "./attempt-spawn-workspace.test-support.js";

const hoisted = getHoisted();
const tempPaths: string[] = [];

function catalogProbeTools() {
  return [
    {
      name: "tool_search",
      description: "tool-search control surface",
      parameters: { type: "object", properties: {} },
      execute: async () => "",
    },
    {
      name: "cataloged_probe_tool",
      description: "deferred behind the catalog",
      parameters: { type: "object", properties: {} },
      execute: async () => "",
    },
  ];
}

function requireAttemptCatalogRef(): ToolSearchCatalogRef {
  const options = hoisted.createOpenClawCodingToolsMock.mock.calls.at(-1)?.[0] as
    | { toolSearchCatalogRef?: ToolSearchCatalogRef }
    | undefined;
  if (!options?.toolSearchCatalogRef) {
    throw new Error("Expected the embedded attempt to own its Tool Search catalog");
  }
  return options.toolSearchCatalogRef;
}

describe("runEmbeddedAttempt tool-search catalog cleanup", () => {
  beforeAll(async () => {
    await preloadRunEmbeddedAttemptForTests();
  });

  beforeEach(() => {
    resetEmbeddedAttemptHarness();
  });

  afterEach(async () => {
    await cleanupTempPaths(tempPaths);
    tempPaths.length = 0;
  });

  it.each([
    {
      mode: "code-mode",
      tools: { codeMode: { enabled: true } },
      cancel: false,
    },
    {
      mode: "tool-search-tools",
      tools: { toolSearch: { enabled: true, mode: "tools" } },
      cancel: false,
    },
    {
      mode: "tool-search-directory",
      tools: { toolSearch: { enabled: true, mode: "directory" } },
      cancel: false,
    },
    {
      mode: "cancelled-code-mode",
      tools: { codeMode: { enabled: true } },
      cancel: true,
    },
  ] as const)(
    "clears the $mode run catalog when preparation fails or is cancelled",
    async ({ mode, tools, cancel }) => {
      const runId = `run-catalog-diagnostics-${mode}`;
      const diagnosticsError = new Error(`failed ${mode} tool diagnostics`);
      const abortController = new AbortController();
      let catalogRef: ToolSearchCatalogRef | undefined;
      const logDiagnostics = vi.fn(() => {
        catalogRef = requireAttemptCatalogRef();
        expect(catalogRef.current?.entries).toContainEqual(
          expect.objectContaining({ name: "cataloged_probe_tool" }),
        );
        if (cancel) {
          abortController.abort(diagnosticsError);
        } else {
          throw diagnosticsError;
        }
      });
      hoisted.createOpenClawCodingToolsMock.mockImplementation(() => catalogProbeTools());

      const attempt = createContextEngineAttemptRunner({
        contextEngine: createContextEngineBootstrapAndAssemble(),
        sessionKey: "agent:main:telegram:direct:123",
        tempPaths,
        attemptOverrides: {
          runId,
          abortSignal: abortController.signal,
          disableTools: false,
          config: { tools },
          runtimePlan: {
            tools: {
              normalize: (normalizedTools: unknown[]) => normalizedTools,
              logDiagnostics,
            },
          } as never,
        },
      });

      await expect(attempt).rejects.toBe(diagnosticsError);
      expect(logDiagnostics).toHaveBeenCalledOnce();
      expect(catalogRef).toBeDefined();
      expect(catalogRef?.current).toBeUndefined();
    },
  );
});
