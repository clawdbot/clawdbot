import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  hasContext: true,
  dispatch: vi.fn(),
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

import { getGatewaySessionSpawnContext } from "./gateway-session-spawn-context.js";
import { callInProcessGatewayToolWithCreation } from "./in-process-gateway.js";

describe("trusted in-process Gateway session creation", () => {
  beforeEach(() => {
    mocks.hasContext = true;
    mocks.dispatch.mockReset().mockResolvedValue({ key: "agent:main:dashboard:child" });
    mocks.callGatewayTool.mockReset().mockResolvedValue({ key: "agent:main:dashboard:child" });
  });

  it("surfaces creation provenance only on in-process dispatch", async () => {
    const creation = {
      via: "spawn" as const,
      actor: { type: "agent" as const, id: "agent:main:main" },
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
        actor: { type: "agent", id: "agent:main:main" },
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
