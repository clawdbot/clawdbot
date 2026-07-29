// Gateway plugin reserved-spawn tests lock the narrow Plugin SDK to core seam.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withPluginRuntimePluginIdScope } from "../plugins/runtime/gateway-request-scope.js";

const spawnSubagentDirect = vi.hoisted(() => vi.fn());

vi.mock("../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect,
}));

import { createGatewaySubagentRuntime } from "./server-plugins.js";

const reservation = {
  requesterSessionKey: "agent:main:main",
  targetAgentId: "worker",
  childSessionKey: "agent:worker:subagent:plugin-reserved-child",
  runId: "plugin-reserved-run",
  task: "run the reserved child",
} as const;

describe("createGatewaySubagentRuntime.spawnReserved", () => {
  beforeEach(() => {
    spawnSubagentDirect.mockReset();
    spawnSubagentDirect.mockResolvedValue({
      status: "accepted",
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      mode: "run",
    });
  });

  it("requires an active plugin scope", async () => {
    await expect(createGatewaySubagentRuntime().spawnReserved(reservation)).rejects.toThrow(
      "requires an active plugin runtime scope",
    );
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: "unscoped requester",
      params: { ...reservation, requesterSessionKey: "main" },
      expected: "canonical agent session key",
    },
    {
      name: "invalid target",
      params: { ...reservation, targetAgentId: "Worker Agent" },
      expected: "targetAgentId is invalid",
    },
    {
      name: "blank task",
      params: { ...reservation, task: " " },
      expected: "task must be non-empty",
    },
  ])("rejects malformed reserved spawn input: $name", async ({ params, expected }) => {
    await expect(
      withPluginRuntimePluginIdScope("agentic-os", () =>
        createGatewaySubagentRuntime().spawnReserved(params),
      ),
    ).rejects.toThrow(expected);
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("forwards only generic reservation and ownership data", async () => {
    const runtime = createGatewaySubagentRuntime();

    await expect(
      withPluginRuntimePluginIdScope("agentic-os", () => runtime.spawnReserved(reservation)),
    ).resolves.toEqual({
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      mode: "run",
    });
    expect(spawnSubagentDirect).toHaveBeenCalledWith(
      {
        task: reservation.task,
        agentId: reservation.targetAgentId,
        mode: "run",
        expectsCompletionMessage: false,
      },
      {
        agentSessionKey: reservation.requesterSessionKey,
        authorizedTargetAgentId: reservation.targetAgentId,
        preallocatedChildSessionKey: reservation.childSessionKey,
        preallocatedRunId: reservation.runId,
        pluginOwnerId: "agentic-os",
      },
    );
  });

  it("fails closed when core returns different identities", async () => {
    spawnSubagentDirect.mockResolvedValueOnce({
      status: "accepted",
      childSessionKey: "agent:worker:subagent:different",
      runId: reservation.runId,
      mode: "run",
    });

    await expect(
      withPluginRuntimePluginIdScope("agentic-os", () =>
        createGatewaySubagentRuntime().spawnReserved(reservation),
      ),
    ).rejects.toThrow("returned different child or run identities");
  });
});
