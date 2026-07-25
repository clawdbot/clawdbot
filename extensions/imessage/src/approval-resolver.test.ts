// Imessage tests cover the unified operator approval resolver.
import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalGatewayRuntimeHoisted = vi.hoisted(() => ({
  resolveApprovalOverGatewaySpy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (...args: unknown[]) =>
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy(...args),
}));

describe("resolveIMessageApproval", () => {
  beforeEach(() => {
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy.mockReset();
  });

  it("returns canonical first-answer state with explicit ownership", async () => {
    const result = {
      applied: false,
      approval: { status: "denied", decision: "deny", reason: "user" },
    };
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy.mockResolvedValue(result);
    const { resolveIMessageApproval } = await import("./approval-resolver.js");

    await expect(
      resolveIMessageApproval({
        cfg: {} as never,
        approvalId: "plugin:looks-like-a-plugin-but-is-exec",
        approvalKind: "exec",
        decision: "allow-once",
        senderId: "+15551230000",
      }),
    ).resolves.toBe(result);

    expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      cfg: {} as never,
      approvalId: "plugin:looks-like-a-plugin-but-is-exec",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
      clientDisplayName: "iMessage approval (+15551230000)",
    });
  });
});
