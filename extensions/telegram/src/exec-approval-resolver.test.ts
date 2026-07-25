// Telegram tests cover the unified operator approval resolver.
import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalGatewayRuntimeHoisted = vi.hoisted(() => ({
  resolveApprovalOverGatewaySpy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (...args: unknown[]) =>
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy(...args),
}));

describe("resolveTelegramApproval", () => {
  beforeEach(() => {
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy.mockReset();
  });

  it.each([
    ["exec", "plugin:id-that-still-belongs-to-exec", "allow-once"],
    ["plugin", "plain-plugin-id", "allow-always"],
  ] as const)(
    "passes explicit %s ownership without inferring it from %s",
    async (approvalKind, approvalId, decision) => {
      const result = {
        applied: false,
        approval: { status: "denied", decision: "deny" },
      };
      approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy.mockResolvedValue(result);
      const { resolveTelegramApproval } = await import("./exec-approval-resolver.js");

      await expect(
        resolveTelegramApproval({
          cfg: {} as never,
          gatewayUrl: undefined,
          approvalId,
          approvalKind,
          decision: decision as ExecApprovalReplyDecision,
          senderId: "9",
        }),
      ).resolves.toBe(result);

      expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
        cfg: {} as never,
        approvalId,
        approvalKind,
        decision,
        senderId: "9",
        gatewayUrl: undefined,
        clientDisplayName: "Telegram approval (9)",
      });
    },
  );

  it("keeps command/value compatibility on an explicit legacy adapter", async () => {
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy.mockResolvedValue(undefined);
    const { resolveTelegramLegacyApproval } = await import("./exec-approval-resolver.js");

    await resolveTelegramLegacyApproval({
      cfg: {} as never,
      approvalId: "legacy-plugin-id",
      approvalKind: "plugin",
      decision: "deny",
      senderId: "9",
    });

    expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      cfg: {} as never,
      approvalId: "legacy-plugin-id",
      decision: "deny",
      senderId: "9",
      gatewayUrl: undefined,
      resolveMethod: "plugin",
      clientDisplayName: "Telegram approval (9)",
    });
  });
});
