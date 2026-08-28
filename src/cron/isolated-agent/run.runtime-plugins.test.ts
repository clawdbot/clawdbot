// Runtime plugin tests cover run-owned registry handles for isolated cron turns.
import { describe, expect, it } from "vitest";
import { makeIsolatedAgentParamsFixture } from "./job-fixtures.js";
import { setupRunCronIsolatedAgentTurnSuite } from "./run.suite-helpers.js";
import {
  loadAgentRuntimePluginRegistryHandleMock,
  loadModelCatalogOwnerMock,
  loadRunCronIsolatedAgentTurn,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

describe("runCronIsolatedAgentTurn runtime plugin owner", () => {
  setupRunCronIsolatedAgentTurnSuite();

  it("carries a gateway-bindable selected registry handle into the run", async () => {
    const params = makeIsolatedAgentParamsFixture({
      job: {
        payload: {
          kind: "agentTurn",
          message: "test",
          fallbacks: ["anthropic/claude-sonnet-4-6"],
        },
      },
    });

    await expect(runCronIsolatedAgentTurn(params)).resolves.toMatchObject({ status: "ok" });
    expect(loadModelCatalogOwnerMock).toHaveBeenCalledWith({
      config: params.cfg,
      readOnly: true,
      allowGatewaySubagentBinding: true,
    });
    expect(loadAgentRuntimePluginRegistryHandleMock).toHaveBeenCalledWith({
      config: { agents: { defaults: {} } },
      workspaceDir: "/tmp/workspace",
      allowGatewaySubagentBinding: true,
      selections: [
        {
          provider: "openai",
          modelId: "gpt-5.4",
          agentId: "default",
        },
        {
          provider: "anthropic",
          modelId: "claude-sonnet-4-6",
          agentId: "default",
        },
      ],
    });
  });

  it("reuses the published owner metadata snapshot for the run registry load", async () => {
    const metadataSnapshot = { plugins: [], index: { plugins: [] } };
    loadModelCatalogOwnerMock.mockImplementation(
      async (params: { agentId?: string; config: object }) => ({
        agentId: params.agentId ?? "default",
        agentDir: "/tmp/agent-dir",
        workspaceDir: "/tmp/workspace",
        config: params.config,
        metadataSnapshot,
        modelCatalog: { entries: [], routeVariants: [] },
      }),
    );

    await expect(runCronIsolatedAgentTurn(makeIsolatedAgentParamsFixture())).resolves.toMatchObject(
      { status: "ok" },
    );
    expect(loadAgentRuntimePluginRegistryHandleMock).toHaveBeenCalledOnce();
    // Exact snapshot identity: a rebuilt copy would still re-hash every installed plugin.
    expect(loadAgentRuntimePluginRegistryHandleMock.mock.calls[0]?.[0].metadataSnapshot).toBe(
      metadataSnapshot,
    );
  });
});
