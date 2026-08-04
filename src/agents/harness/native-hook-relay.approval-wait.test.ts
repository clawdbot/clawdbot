import { afterEach, describe, expect, it, vi } from "vitest";
import { callGatewayTool } from "../tools/gateway.js";
import { invokeNativeHookRelay, registerNativeHookRelay, testing } from "./native-hook-relay.js";

vi.mock("../tools/gateway.js", () => ({
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  vi.restoreAllMocks();
  mockCallGatewayTool.mockReset();
  testing.clearNativeHookRelaysForTests();
});

describe("native hook relay approval wait handling", () => {
  it("defers when waitDecision reports a stale approval id", async () => {
    mockCallGatewayTool
      .mockResolvedValueOnce({ id: "plugin:approval-stale", status: "accepted" })
      .mockRejectedValueOnce(new Error("approval expired or not found"));
    const relay = registerNativeHookRelay({
      provider: "codex",
      sessionId: "session-1",
      runId: "run-1",
    });

    await expect(
      invokeNativeHookRelay({
        provider: "codex",
        relayId: relay.relayId,
        event: "permission_request",
        rawPayload: {
          hook_event_name: "PermissionRequest",
          tool_name: "Bash",
          tool_input: { command: "cat /tmp/private-key" },
        },
      }),
    ).resolves.toEqual({ stdout: "", stderr: "", exitCode: 0 });

    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });
});
