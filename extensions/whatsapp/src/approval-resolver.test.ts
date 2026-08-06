// WhatsApp tests cover canonical multi-surface approval resolver outcomes.
import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalGatewayRuntimeHoisted = vi.hoisted(() => ({
  resolveApprovalOverGatewaySpy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (...args: unknown[]) =>
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy(...args),
}));

describe("resolveWhatsAppApproval", () => {
  beforeEach(() => {
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy.mockReset();
  });

  it("returns the canonical first-answer result without inferring ownership from the id", async () => {
    const result = {
      applied: false,
      approval: { status: "denied", decision: "deny" },
    };
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy.mockResolvedValue(result);
    const { resolveWhatsAppApproval } = await import("./approval-resolver.js");

    await expect(
      resolveWhatsAppApproval({
        cfg: {} as never,
        approvalId: "plugin:looks-plugin-but-is-exec",
        approvalKind: "exec",
        decision: "allow-once",
        senderId: "+15551230000",
      }),
    ).resolves.toBe(result);

    expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      cfg: {},
      approvalId: "plugin:looks-plugin-but-is-exec",
      approvalKind: "exec",
      decision: "allow-once",
      senderId: "+15551230000",
      gatewayUrl: undefined,
      clientDisplayName: "WhatsApp approval (+15551230000)",
    });
  });
});
