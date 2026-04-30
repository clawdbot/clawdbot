import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveFocusTargetSession } from "./commands-subagents/shared.js";

const hoisted = vi.hoisted(() => ({
  callGatewayMock: vi.fn(),
}));

vi.mock("../../gateway/call.js", () => ({
  callGateway: (params: unknown) => hoisted.callGatewayMock(params),
}));

describe("resolveFocusTargetSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("restricts gateway fallback resolution to a subagent requester's children", async () => {
    hoisted.callGatewayMock.mockResolvedValue({
      key: "agent:main:subagent:child",
    });

    const result = await resolveFocusTargetSession({
      runs: [],
      token: "child",
      requesterKey: "agent:main:subagent:parent",
    });

    expect(result?.targetSessionKey).toBe("agent:main:subagent:child");
    expect(hoisted.callGatewayMock).toHaveBeenCalledWith({
      method: "sessions.resolve",
      params: {
        key: "child",
        spawnedBy: "agent:main:subagent:parent",
      },
    });
  });
});
