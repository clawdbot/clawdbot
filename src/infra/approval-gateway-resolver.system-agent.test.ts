import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveApprovalOverGateway } from "./approval-gateway-resolver.js";

const hoisted = vi.hoisted(() => ({
  withOperatorApprovalsGatewayClient: vi.fn(),
  clientRequest: vi.fn(),
}));

vi.mock("../gateway/operator-approvals-client.js", () => ({
  withOperatorApprovalsGatewayClient: hoisted.withOperatorApprovalsGatewayClient,
}));

describe("resolveApprovalOverGateway system-agent approvals", () => {
  beforeEach(() => {
    hoisted.clientRequest.mockReset().mockResolvedValue({
      applied: true,
      approval: {
        id: "system-agent:approval-1",
        status: "allowed",
      },
    });
    hoisted.withOperatorApprovalsGatewayClient.mockReset().mockImplementation(async (_, run) => {
      return await run({ request: hoisted.clientRequest });
    });
  });

  it("routes the protocol system-agent kind through the canonical method", async () => {
    await resolveApprovalOverGateway({
      cfg: {} as never,
      approvalId: "system-agent:approval-1",
      approvalKind: "system-agent",
      decision: "allow-once",
    });

    expect(hoisted.clientRequest).toHaveBeenCalledTimes(1);
    expect(hoisted.clientRequest).toHaveBeenCalledWith("approval.resolve", {
      id: "system-agent:approval-1",
      kind: "system-agent",
      decision: "allow-once",
    });
  });
});
