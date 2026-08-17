import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasContext: true,
  dispatch: vi.fn(),
  callGateway: vi.fn(),
  callGatewayTool: vi.fn(),
}));

vi.mock("../../gateway/method-scopes.js", () => ({
  resolveLeastPrivilegeOperatorScopesForMethod: () => ["operator.write"],
}));

vi.mock("../../gateway/server-plugins.js", () => ({
  dispatchGatewayMethodInProcess: mocks.dispatch,
  getInProcessGatewayRequestContext: vi.fn(),
  hasInProcessGatewayContext: () => mocks.hasContext,
}));

vi.mock("./gateway.js", () => ({ callGatewayTool: mocks.callGatewayTool }));
vi.mock("../../gateway/call.js", () => ({ callGateway: mocks.callGateway }));

import { getGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import {
  callAgentToolGatewayRequest,
  callInProcessGatewayToolWithCreation,
} from "./in-process-gateway.js";

describe("trusted in-process Gateway session creation", () => {
  beforeEach(() => {
    mocks.hasContext = true;
    mocks.dispatch.mockReset().mockResolvedValue({ key: "agent:main:dashboard:child" });
    mocks.callGateway.mockReset().mockResolvedValue({ status: "ok" });
    mocks.callGatewayTool.mockReset().mockResolvedValue({ key: "agent:main:dashboard:child" });
  });

  it("surfaces creation provenance only on in-process dispatch", async () => {
    const creation = {
      via: "spawn" as const,
      actor: { type: "agent" as const, id: "main" },
      requesterSessionKey: "agent:main:main",
    };
    await callInProcessGatewayToolWithCreation("sessions.create", { agentId: "main" }, creation);

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "sessions.create",
      { agentId: "main" },
      {
        forceSyntheticClient: true,
        sessionCreation: creation,
        syntheticScopes: ["operator.write"],
      },
    );
    expect(mocks.callGatewayTool).not.toHaveBeenCalled();

    mocks.hasContext = false;
    await callInProcessGatewayToolWithCreation("sessions.create", { agentId: "main" }, creation);

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "sessions.create",
      {},
      { agentId: "main" },
      { scopes: ["operator.write"] },
    );
  });

  it("carries visible-spawn policy through signed identity on fallback dispatch", async () => {
    mocks.hasContext = false;
    const inheritedToolPolicy = {
      version: 1 as const,
      allow: ["read", "sessions_spawn"],
      deny: ["exec"],
    };

    mocks.callGatewayTool.mockImplementationOnce(async () => {
      expect(getGatewaySessionSpawnContext()).toEqual({
        completionOwnerSessionKey: "agent:main:discord:direct:alice",
        inheritedToolPolicy,
      });
      return { key: "agent:main:dashboard:child" };
    });

    await callInProcessGatewayToolWithCreation(
      "sessions.create",
      { agentId: "main", parentSessionKey: "agent:main:main", spawnDepth: 1 },
      {
        via: "spawn",
        actor: { type: "agent", id: "main" },
        requesterSessionKey: "agent:main:main",
        completionOwnerSessionKey: "agent:main:discord:direct:alice",
        inheritedToolPolicy,
      },
    );

    expect(mocks.callGatewayTool).toHaveBeenCalledWith(
      "sessions.create",
      {},
      { agentId: "main", parentSessionKey: "agent:main:main", spawnDepth: 1 },
      {
        scopes: ["operator.write"],
        requireAgentRuntimeIdentity: true,
      },
    );
    expect(getGatewaySessionSpawnContext()).toBeUndefined();
  });
});

describe("request-shaped in-process Gateway dispatch", () => {
  beforeEach(() => {
    mocks.hasContext = true;
    mocks.dispatch.mockReset().mockResolvedValue({ runId: "run-1" });
    mocks.callGateway.mockReset().mockResolvedValue({ runId: "run-1" });
  });

  it("uses the local router with least privilege and transport-equivalent request options", async () => {
    const controller = new AbortController();
    const onAccepted = vi.fn();
    const agentToolCaller = {
      agentId: "main",
      sessionKey: "agent:main:discord:direct:colin",
    };

    await callAgentToolGatewayRequest({
      method: "agent",
      params: { sessionKey: "agent:main:worker", message: "run" },
      agentToolCaller,
      expectFinal: true,
      onAccepted,
      signal: controller.signal,
    });

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "agent",
      { sessionKey: "agent:main:worker", message: "run" },
      {
        forceSyntheticClient: true,
        agentToolCaller,
        syntheticScopes: ["operator.write"],
        expectFinal: true,
        onAccepted,
        signal: controller.signal,
        timeoutMs: 10_000,
      },
    );
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it.each([
    [null, undefined],
    [0, 0],
    [25_000, 25_000],
  ] as const)("maps timeout %s to the local dispatch deadline", async (timeoutMs, expected) => {
    await callAgentToolGatewayRequest({ method: "sessions.list", timeoutMs });

    const options = mocks.dispatch.mock.calls[0]?.[2] as { timeoutMs?: number } | undefined;
    expect(options?.timeoutMs).toBe(expected);
  });

  it("routes abort cleanup through the same local caller", async () => {
    mocks.dispatch.mockImplementation(
      async (
        method: string,
        _params: unknown,
        options?: { onSignalAbort?: () => Promise<void> },
      ) => {
        if (method === "conversations.turn.cancel") {
          return { status: "ok" };
        }
        await options?.onSignalAbort?.();
        throw new Error("primary aborted");
      },
    );

    await expect(
      callAgentToolGatewayRequest({
        method: "conversations.turn",
        params: { turnId: "turn-1" },
        onSignalAbort: async (request) => {
          await request("conversations.turn.cancel", { turnId: "turn-1" });
        },
      }),
    ).rejects.toThrow("primary aborted");
    expect(mocks.dispatch.mock.calls).toContainEqual([
      "conversations.turn.cancel",
      { turnId: "turn-1" },
      expect.objectContaining({ forceSyntheticClient: true }),
    ]);
    expect(
      mocks.dispatch.mock.calls.filter(([method]) => method === "conversations.turn.cancel"),
    ).toHaveLength(1);
    expect(mocks.callGateway).not.toHaveBeenCalled();
  });

  it("falls back to the original Gateway request outside the Gateway process", async () => {
    mocks.hasContext = false;
    const request = {
      method: "sessions.list",
      params: { limit: 5 },
      timeoutMs: 2_000,
      agentToolCaller: {
        agentId: "main",
        sessionKey: "agent:main:discord:direct:colin",
      },
    } as const;

    await callAgentToolGatewayRequest(request);

    expect(mocks.callGateway).toHaveBeenCalledWith({
      method: "sessions.list",
      params: { limit: 5 },
      timeoutMs: 2_000,
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
