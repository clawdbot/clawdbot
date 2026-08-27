// Proves isolated cron/hook runs carry the published Gateway plugin generation
// into embedded execution instead of rebuilding metadata per run (#125596 family).
import { describe, expect, it, vi } from "vitest";
import { getPreparedModelRuntimePluginGeneration } from "../../agents/prepared-model-runtime-generation-scope.js";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadRunCronIsolatedAgentTurn,
  mockRunCronFallbackPassthrough,
  runEmbeddedAgentMock,
} from "./run.test-harness.js";

const preparedRuntimeMocks = vi.hoisted(() => ({
  acquireRuntime: vi.fn(),
  loadDispatchRuntime: vi.fn(),
}));

vi.mock("../../agents/prepared-model-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../agents/prepared-model-runtime.js")>()),
  acquireAgentRunPreparedModelRuntime: preparedRuntimeMocks.acquireRuntime,
  loadPublishedGatewayReplyDispatchRuntime: preparedRuntimeMocks.loadDispatchRuntime,
}));

const { PreparedModelRuntimeOwnerNotPublishedError } = await vi.importActual<
  typeof import("../../agents/prepared-model-runtime.errors.js")
>("../../agents/prepared-model-runtime.errors.js");

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn plugin generation carry", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("admits the published generation and keeps it active through embedded execution", async () => {
    const metadataSnapshot = { plugins: [], index: { plugins: [] } };
    const pluginGeneration = {
      configuredCatalogEntries: [],
      inlineProviderModels: [],
      pluginMetadataSnapshot: metadataSnapshot,
    } as never;
    const config = {};
    preparedRuntimeMocks.loadDispatchRuntime.mockResolvedValue({
      agentId: "default",
      agentDir: "/tmp/dispatch-agent-dir",
      workspaceDir: "/tmp/dispatch-workspace",
      config,
      pluginGeneration,
    });
    const release = vi.fn();
    preparedRuntimeMocks.acquireRuntime.mockResolvedValue({
      snapshot: { config, metadataSnapshot },
      release,
    });
    mockRunCronFallbackPassthrough();
    let embeddedRunGeneration: unknown = "not-captured";
    runEmbeddedAgentMock.mockImplementation(async () => {
      embeddedRunGeneration = getPreparedModelRuntimePluginGeneration();
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });

    await expect(runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture())).resolves.toMatchObject(
      { status: "ok" },
    );
    expect(preparedRuntimeMocks.loadDispatchRuntime).toHaveBeenCalledWith({ agentId: "default" });
    expect(preparedRuntimeMocks.acquireRuntime).toHaveBeenCalledWith(
      {
        config,
        agentId: "default",
        agentDir: "/tmp/dispatch-agent-dir",
        allowGatewaySubagentBinding: true,
        workspaceDir: "/tmp/workspace",
      },
      { catalogMode: "static", pluginGeneration },
    );
    expect(embeddedRunGeneration).toBe(pluginGeneration);
    expect(release).toHaveBeenCalledOnce();
    expect(getPreparedModelRuntimePluginGeneration()).toBeUndefined();
  });

  it("runs without a generation when no Gateway publication exists", async () => {
    preparedRuntimeMocks.loadDispatchRuntime.mockResolvedValue(undefined);
    mockRunCronFallbackPassthrough();
    let embeddedRunGeneration: unknown = "not-captured";
    runEmbeddedAgentMock.mockImplementation(async () => {
      embeddedRunGeneration = getPreparedModelRuntimePluginGeneration();
      return { payloads: [{ text: "test output" }], meta: { agentMeta: {} } };
    });

    await expect(runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture())).resolves.toMatchObject(
      { status: "ok" },
    );
    expect(preparedRuntimeMocks.acquireRuntime).not.toHaveBeenCalled();
    expect(embeddedRunGeneration).toBeUndefined();
  });

  it("falls back to generation-free execution when the owner is not published", async () => {
    preparedRuntimeMocks.loadDispatchRuntime.mockRejectedValue(
      new PreparedModelRuntimeOwnerNotPublishedError("owner not published"),
    );

    await expect(runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture())).resolves.toMatchObject(
      { status: "ok" },
    );
    expect(preparedRuntimeMocks.acquireRuntime).not.toHaveBeenCalled();
  });
});
