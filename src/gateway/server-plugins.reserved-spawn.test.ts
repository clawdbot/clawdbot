// Gateway plugin reserved-spawn tests lock the narrow Plugin SDK to core seam.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { withPluginRuntimePluginIdScope } from "../plugins/runtime/gateway-request-scope.js";

const spawnSubagentDirect = vi.hoisted(() => vi.fn());
const getAgentRunContext = vi.hoisted(() => vi.fn());
const getSubagentRunByRunId = vi.hoisted(() => vi.fn());
const getLatestSubagentRunByChildSessionKey = vi.hoisted(() => vi.fn());

vi.mock("../agents/subagent-spawn.js", () => ({
  spawnSubagentDirect,
}));
vi.mock("../agents/subagent-registry.js", () => ({
  getLatestSubagentRunByChildSessionKey,
  getSubagentRunByRunId,
}));
vi.mock("../infra/agent-events.js", () => ({
  getAgentRunContext,
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
    getAgentRunContext.mockReset().mockReturnValue(undefined);
    getSubagentRunByRunId.mockReset().mockReturnValue(undefined);
    getLatestSubagentRunByChildSessionKey.mockReset().mockReturnValue(undefined);
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

  it.each([
    {
      name: "active Gateway run",
      arrange: () => getAgentRunContext.mockReturnValue({ sessionKey: "agent:other:main" }),
      expected: "runId is already active",
    },
    {
      name: "persisted run",
      arrange: () => getSubagentRunByRunId.mockReturnValue({ runId: reservation.runId }),
      expected: "runId already exists",
    },
    {
      name: "persisted child",
      arrange: () =>
        getLatestSubagentRunByChildSessionKey.mockReturnValue({
          childSessionKey: reservation.childSessionKey,
        }),
      expected: "childSessionKey already exists",
    },
  ])(
    "rejects a reserved identity collision before dispatch: $name",
    async ({ arrange, expected }) => {
      arrange();

      await expect(
        withPluginRuntimePluginIdScope("agentic-os", () =>
          createGatewaySubagentRuntime().spawnReserved(reservation),
        ),
      ).rejects.toThrow(expected);
      expect(spawnSubagentDirect).not.toHaveBeenCalled();
    },
  );

  it("allows exactly one concurrent claimant for the same reserved identities", async () => {
    let resolveFirst:
      | ((value: {
          status: "accepted";
          childSessionKey: string;
          runId: string;
          mode: "run";
        }) => void)
      | undefined;
    spawnSubagentDirect.mockImplementationOnce(
      async () =>
        await new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const runtime = createGatewaySubagentRuntime();
    const first = withPluginRuntimePluginIdScope("agentic-os", () =>
      runtime.spawnReserved(reservation),
    );
    await vi.waitFor(() => expect(spawnSubagentDirect).toHaveBeenCalledTimes(1));

    await expect(
      withPluginRuntimePluginIdScope("agentic-os", () => runtime.spawnReserved(reservation)),
    ).rejects.toThrow("already claimed");
    expect(spawnSubagentDirect).toHaveBeenCalledTimes(1);

    resolveFirst?.({
      status: "accepted",
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
      mode: "run",
    });
    await expect(first).resolves.toMatchObject({
      childSessionKey: reservation.childSessionKey,
      runId: reservation.runId,
    });
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
