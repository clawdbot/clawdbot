import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApprovalOverGateway } from "./approval-gateway-resolver.js";

const hoisted = vi.hoisted(() => ({
  withOperatorApprovalsGatewayClient: vi.fn(),
  clientRequest: vi.fn(),
}));

vi.mock("../gateway/operator-approvals-client.js", () => ({
  withOperatorApprovalsGatewayClient: hoisted.withOperatorApprovalsGatewayClient,
}));

function requireFirstMockCall<T>(mock: { mock: { calls: T[][] } }, label: string): T[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("resolveApprovalOverGateway", () => {
  beforeEach(() => {
    hoisted.clientRequest.mockReset().mockResolvedValue({ ok: true });
    hoisted.withOperatorApprovalsGatewayClient.mockReset().mockImplementation(async (_, run) => {
      await run({ request: hoisted.clientRequest });
    });
  });

  it("routes exec approvals through exec.approval.resolve", async () => {
    await resolveApprovalOverGateway({
      cfg: { gateway: { auth: { token: "cfg-token" } } } as never,
      approvalId: "approval-1",
      decision: "allow-once",
      gatewayUrl: "ws://gateway.example.test",
      clientDisplayName: "QuietChat approval (default)",
    });

    expect(hoisted.withOperatorApprovalsGatewayClient).toHaveBeenCalledTimes(1);
    const [gatewayClientOptions, gatewayClientRunner] = requireFirstMockCall(
      hoisted.withOperatorApprovalsGatewayClient,
      "gateway client",
    );
    expect(gatewayClientOptions).toEqual({
      config: { gateway: { auth: { token: "cfg-token" } } },
      gatewayUrl: "ws://gateway.example.test",
      clientDisplayName: "QuietChat approval (default)",
    });
    expect(gatewayClientRunner).toBeTypeOf("function");
    expect(hoisted.clientRequest).toHaveBeenCalledWith("exec.approval.resolve", {
      id: "approval-1",
      decision: "allow-once",
    });
  });

  it("routes plugin approvals through plugin.approval.resolve", async () => {
    await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "plugin:approval-1",
      decision: "deny",
    });

    expect(hoisted.clientRequest).toHaveBeenCalledTimes(1);
    expect(hoisted.clientRequest).toHaveBeenCalledWith("plugin.approval.resolve", {
      id: "plugin:approval-1",
      decision: "deny",
    });
  });

  it("routes explicit plugin resolution through plugin.approval.resolve", async () => {
    await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "approval-1",
      decision: "allow-once",
      resolveMethod: "plugin",
    });

    expect(hoisted.clientRequest).toHaveBeenCalledTimes(1);
    expect(hoisted.clientRequest).toHaveBeenCalledWith("plugin.approval.resolve", {
      id: "approval-1",
      decision: "allow-once",
    });
  });

  it("falls back to plugin.approval.resolve only for not-found exec approvals when enabled", async () => {
    const notFoundError = Object.assign(new Error("unknown or expired approval id"), {
      gatewayCode: "APPROVAL_NOT_FOUND",
    });
    hoisted.clientRequest.mockRejectedValueOnce(notFoundError).mockResolvedValueOnce({ ok: true });

    await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "approval-1",
      decision: "allow-always",
      allowPluginFallback: true,
    });

    expect(hoisted.clientRequest.mock.calls).toEqual([
      ["exec.approval.resolve", { id: "approval-1", decision: "allow-always" }],
      ["plugin.approval.resolve", { id: "approval-1", decision: "allow-always" }],
    ]);
  });

  it("does not fall back for non-not-found exec approval failures", async () => {
    hoisted.clientRequest.mockRejectedValueOnce(new Error("permission denied"));

    await expect(
      resolveApprovalOverGateway({
        cfg: {} as never,
        approvalId: "approval-1",
        decision: "deny",
        allowPluginFallback: true,
      }),
    ).rejects.toThrow("permission denied");

    expect(hoisted.clientRequest).toHaveBeenCalledTimes(1);
  });
});
