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

import type { AgentRunApprovalHost } from "../agent-run-approval.js";
import {
  callAgentGatewayWithApprovalHost,
  callInProcessGatewayToolWithCreation,
} from "./in-process-gateway.js";

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
});

describe("host-aware agent Gateway dispatch", () => {
  beforeEach(() => {
    mocks.hasContext = true;
    mocks.dispatch.mockReset().mockResolvedValue({ runId: "run-1" });
    mocks.callGatewayTool.mockReset();
  });

  it("keeps the exact process-local approval host on in-process agent launches", async () => {
    const approvalHost: AgentRunApprovalHost = {
      plugin: {
        request: vi.fn(),
      },
    };
    const callGateway = vi.fn();

    await callAgentGatewayWithApprovalHost({
      approvalHost,
      callGateway,
      request: {
        method: "agent",
        params: { message: "hello", sessionKey: "agent:main:worker" },
        timeoutMs: 10_000,
      },
    });

    expect(mocks.dispatch).toHaveBeenCalledWith(
      "agent",
      { message: "hello", sessionKey: "agent:main:worker" },
      {
        agentRunApprovalHost: approvalHost,
        forceSyntheticClient: true,
        syntheticScopes: ["operator.write"],
        timeoutMs: 10_000,
      },
    );
    expect(callGateway).not.toHaveBeenCalled();
  });

  it("serializes an explicit fail-closed marker when no approval host exists", async () => {
    mocks.hasContext = false;
    const callGateway = vi.fn().mockResolvedValue({ runId: "run-1" });

    await callAgentGatewayWithApprovalHost({
      callGateway,
      request: {
        method: "agent",
        params: { message: "hello", sessionKey: "agent:main:worker" },
        timeoutMs: 10_000,
      },
    });

    expect(callGateway).toHaveBeenCalledWith({
      method: "agent",
      params: {
        message: "hello",
        sessionKey: "agent:main:worker",
        approvalHostMode: "none",
      },
      scopes: ["operator.write"],
      timeoutMs: 10_000,
    });
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });

  it("rejects process-local approval hosts outside an in-process Gateway context", async () => {
    mocks.hasContext = false;
    const callGateway = vi.fn();
    const approvalHost: AgentRunApprovalHost = {
      plugin: {
        request: vi.fn(),
      },
    };

    await expect(
      callAgentGatewayWithApprovalHost({
        approvalHost,
        callGateway,
        request: {
          method: "agent",
          params: { message: "hello", sessionKey: "agent:main:worker" },
        },
      }),
    ).rejects.toThrow("Process-local approval hosts cannot cross the Gateway transport.");
    expect(callGateway).not.toHaveBeenCalled();
    expect(mocks.dispatch).not.toHaveBeenCalled();
  });
});
