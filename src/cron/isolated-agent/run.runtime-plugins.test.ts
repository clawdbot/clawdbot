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
});
