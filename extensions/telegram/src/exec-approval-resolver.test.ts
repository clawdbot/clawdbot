import type { ExecApprovalReplyDecision } from "openclaw/plugin-sdk/approval-reply-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";

const approvalGatewayRuntimeHoisted = vi.hoisted(() => ({
  resolveApprovalOverGatewaySpy: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/approval-gateway-runtime", () => ({
  resolveApprovalOverGateway: (...args: unknown[]) =>
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy(...args),
}));

describe("resolveTelegramExecApproval", () => {
  async function invokeResolver(params: {
    approvalId: string;
    decision: ExecApprovalReplyDecision;
    senderId: string;
    allowPluginFallback?: boolean;
  }) {
    const { resolveTelegramExecApproval } = await import("./exec-approval-resolver.js");

    await resolveTelegramExecApproval({
      cfg: {} as never,
      gatewayUrl: undefined,
      ...params,
    });
  }

  function expectApprovalGatewayCall(params: {
    approvalId: string;
    decision: ExecApprovalReplyDecision;
    senderId: string;
    allowPluginFallback?: boolean;
  }) {
    expect(approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy).toHaveBeenCalledWith({
      cfg: {} as never,
      approvalId: params.approvalId,
      decision: params.decision,
      senderId: params.senderId,
      gatewayUrl: undefined,
      allowPluginFallback: params.allowPluginFallback,
      clientDisplayName: `Telegram approval (${params.senderId})`,
    });
  }

  beforeEach(() => {
    approvalGatewayRuntimeHoisted.resolveApprovalOverGatewaySpy
      .mockReset()
      .mockResolvedValue(undefined);
  });

  it("routes plugin approval ids through plugin.approval.resolve", async () => {
    await invokeResolver({
      approvalId: "plugin:abc123",
      decision: "allow-once",
      senderId: "9",
    });

    expectApprovalGatewayCall({
      approvalId: "plugin:abc123",
      decision: "allow-once",
      senderId: "9",
    });
  });

  it.each([
    "falls back to plugin.approval.resolve when exec approval ids are unknown",
    "falls back to plugin.approval.resolve for structured approval-not-found errors",
  ])("%s", async () => {
    await invokeResolver({
      approvalId: "legacy-plugin-123",
      decision: "allow-always",
      senderId: "9",
      allowPluginFallback: true,
    });

    expectApprovalGatewayCall({
      approvalId: "legacy-plugin-123",
      decision: "allow-always",
      senderId: "9",
      allowPluginFallback: true,
    });
  });

  it("passes fallback disablement through unchanged", async () => {
    await invokeResolver({
      approvalId: "legacy-plugin-123",
      decision: "allow-always",
      senderId: "9",
    });

    expectApprovalGatewayCall({
      approvalId: "legacy-plugin-123",
      decision: "allow-always",
      senderId: "9",
    });
  });
});
