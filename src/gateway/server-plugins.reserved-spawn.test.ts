// Gateway plugin reserved-spawn tests lock the narrow Plugin SDK to core seam.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  withPluginRuntimeGatewayRequestScope,
  withPluginRuntimePluginIdScope,
} from "../plugins/runtime/gateway-request-scope.js";
import type { GatewayRequestContext } from "./server-methods/types.js";

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
  onAgentEvent: vi.fn(),
}));

import { createGatewaySubagentRuntime } from "./server-plugins.js";

const reservation = {
  requesterSessionKey: "agent:main:main",
  targetAgentId: "worker",
  childSessionKey: "agent:worker:subagent:plugin-reserved-child",
  runId: "plugin-reserved-run",
  task: "run the reserved child",
} as const;

function withReservedPluginScope<T>(
  run: () => T,
  dedupe: GatewayRequestContext["dedupe"] = new Map(),
): T {
  return withPluginRuntimeGatewayRequestScope(
    {
      context: { dedupe } as GatewayRequestContext,
      isWebchatConnect: () => false,
    },
    () => withPluginRuntimePluginIdScope("agentic-os", run),
  );
}

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

  it("requires a live Gateway context", async () => {
    await expect(
      withPluginRuntimePluginIdScope("agentic-os", () =>
        createGatewaySubagentRuntime().spawnReserved(reservation),
      ),
    ).rejects.toThrow("requires a live Gateway context");
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
      name: "noncanonical child",
      params: {
        ...reservation,
        childSessionKey: "agent:worker:subagent:Plugin-Reserved-Child",
      },
      expected: "canonical values",
    },
    {
      name: "blank task",
      params: { ...reservation, task: " " },
      expected: "task must be non-empty",
    },
  ])("rejects malformed reserved spawn input: $name", async ({ params, expected }) => {
    await expect(
      withReservedPluginScope(() => createGatewaySubagentRuntime().spawnReserved(params)),
    ).rejects.toThrow(expected);
    expect(spawnSubagentDirect).not.toHaveBeenCalled();
  });

  it("forwards only generic reservation and ownership data", async () => {
    const runtime = createGatewaySubagentRuntime();
    const dedupe: GatewayRequestContext["dedupe"] = new Map();
    spawnSubagentDirect.mockImplementationOnce(
      async (_params: unknown, context: { reservedSubagentClaimToken?: string }) => {
        const reserved = dedupe.get(`agent:${reservation.runId}`);
        expect(reserved?.payload).toMatchObject({
          pluginRuntimeOwnerId: "agentic-os",
          runId: reservation.runId,
          sessionKey: reservation.childSessionKey,
          reservedSubagentClaimToken: context.reservedSubagentClaimToken,
        });
        return {
          status: "accepted",
          childSessionKey: reservation.childSessionKey,
          runId: reservation.runId,
          mode: "run",
        };
      },
    );

    await expect(
      withReservedPluginScope(() => runtime.spawnReserved(reservation), dedupe),
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
        reservedSubagentClaimToken: expect.any(String),
      },
    );
    expect(dedupe.has(`agent:${reservation.runId}`)).toBe(false);
  });

  it.each([
    {
      name: "cached Gateway run",
      arrange: () => undefined,
      dedupe: new Map([
        [
          `agent:${reservation.runId}`,
          {
            ts: Date.now(),
            ok: true,
            payload: {
              status: "accepted",
              runId: reservation.runId,
              sessionKey: "agent:other:main",
            },
          },
        ],
      ]) as GatewayRequestContext["dedupe"],
      expected: "runId already exists in the Gateway dedupe cache",
    },
    {
      name: "active Gateway run",
      arrange: () => getAgentRunContext.mockReturnValue({ sessionKey: "agent:other:main" }),
      dedupe: new Map() as GatewayRequestContext["dedupe"],
      expected: "runId is already active",
    },
    {
      name: "persisted run",
      arrange: () => getSubagentRunByRunId.mockReturnValue({ runId: reservation.runId }),
      dedupe: new Map() as GatewayRequestContext["dedupe"],
      expected: "runId already exists",
    },
    {
      name: "persisted child",
      arrange: () =>
        getLatestSubagentRunByChildSessionKey.mockReturnValue({
          childSessionKey: reservation.childSessionKey,
        }),
      dedupe: new Map() as GatewayRequestContext["dedupe"],
      expected: "childSessionKey already exists",
    },
  ])(
    "rejects a reserved identity collision before dispatch: $name",
    async ({ arrange, dedupe, expected }) => {
      arrange();

      await expect(
        withReservedPluginScope(
          () => createGatewaySubagentRuntime().spawnReserved(reservation),
          dedupe,
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
    const first = withReservedPluginScope(() => runtime.spawnReserved(reservation));
    await vi.waitFor(() => expect(spawnSubagentDirect).toHaveBeenCalledTimes(1));

    await expect(withReservedPluginScope(() => runtime.spawnReserved(reservation))).rejects.toThrow(
      "already claimed",
    );
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
      withReservedPluginScope(() => createGatewaySubagentRuntime().spawnReserved(reservation)),
    ).rejects.toThrow("returned different child or run identities");
  });
});
