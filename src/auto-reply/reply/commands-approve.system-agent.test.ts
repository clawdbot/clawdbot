import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleApproveCommandFromContext } from "./commands-approve.js";

const hoisted = vi.hoisted(() => ({
  getChannelPlugin: vi.fn(),
  resolveChannelApprovalCapability: vi.fn(),
  resolveApprovalOverGateway: vi.fn(),
  resolveApprovalCommandAuthorization: vi.fn(),
  requireGatewayClientScope: vi.fn(),
}));

vi.mock("../../channels/plugins/index.js", () => ({
  getChannelPlugin: hoisted.getChannelPlugin,
  resolveChannelApprovalCapability: hoisted.resolveChannelApprovalCapability,
}));

vi.mock("../../infra/approval-gateway-resolver.js", () => ({
  resolveApprovalOverGateway: hoisted.resolveApprovalOverGateway,
}));

vi.mock("../../infra/channel-approval-auth.js", () => ({
  resolveApprovalCommandAuthorization: hoisted.resolveApprovalCommandAuthorization,
}));

vi.mock("./channel-context.js", () => ({
  resolveChannelAccountId: vi.fn(() => "default"),
}));

vi.mock("./command-gates.js", () => ({
  requireGatewayClientScope: hoisted.requireGatewayClientScope,
}));

vi.mock("../../globals.js", () => ({
  logVerbose: vi.fn(),
}));

function buildParams(isAuthorizedSender: boolean) {
  return {
    cfg: { commands: { text: true } },
    ctx: {
      Provider: "whatsapp",
      Surface: "whatsapp",
      CommandSource: "text",
      SenderId: "owner",
    },
    command: {
      commandBodyNormalized: "/approve system-agent:abc12345 allow-once",
      isAuthorizedSender,
      senderId: "owner",
      channel: "whatsapp",
      channelId: "whatsapp",
    },
  } as never;
}

describe("handleApproveCommandFromContext system-agent approvals", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hoisted.getChannelPlugin.mockReturnValue(undefined);
    hoisted.resolveChannelApprovalCapability.mockReturnValue(undefined);
    hoisted.resolveApprovalCommandAuthorization.mockReturnValue({
      authorized: true,
      explicit: false,
    });
    hoisted.requireGatewayClientScope.mockReturnValue(null);
    hoisted.resolveApprovalOverGateway.mockResolvedValue({ applied: true });
  });

  it("uses canonical system-agent resolution without legacy probing", async () => {
    const result = await handleApproveCommandFromContext(buildParams(true), true);

    expect(result).toEqual({
      shouldContinue: false,
      reply: {
        text: "✅ Approval allow-once submitted for system-agent:abc12345.",
      },
    });
    expect(hoisted.resolveApprovalOverGateway).toHaveBeenCalledTimes(1);
    expect(hoisted.resolveApprovalOverGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        approvalId: "system-agent:abc12345",
        approvalKind: "system-agent",
        decision: "allow-once",
      }),
    );
    expect(hoisted.resolveApprovalOverGateway.mock.calls[0]?.[0]).not.toHaveProperty(
      "resolveMethod",
    );
  });

  it("does not bypass the existing authorized-sender gate", async () => {
    const result = await handleApproveCommandFromContext(buildParams(false), true);

    expect(result).toEqual({ shouldContinue: false });
    expect(hoisted.resolveApprovalOverGateway).not.toHaveBeenCalled();
  });
});
