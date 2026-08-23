// Covers gateway waitDecision id binding for native hook relay permission approvals.
import { afterEach, describe, expect, it, vi } from "vitest";
import { callGatewayTool } from "../tools/gateway.js";
import { invokeNativeHookRelay, registerNativeHookRelay, testing } from "./native-hook-relay.js";

vi.mock("../tools/gateway.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../tools/gateway.js")>()),
  callGatewayTool: vi.fn(),
}));

const mockCallGatewayTool = vi.mocked(callGatewayTool);

afterEach(() => {
  // restoreAllMocks does not clear call history on module-mock vi.fn()s.
  mockCallGatewayTool.mockReset();
  vi.restoreAllMocks();
  testing.clearNativeHookRelaysForTests();
});

function mockGatewayApproval(waitResult: { id?: string; decision?: string | null }) {
  mockCallGatewayTool.mockImplementation(async (method: string) => {
    if (method === "plugin.approval.request") {
      return { id: "approval-1", status: "accepted" };
    }
    if (method === "plugin.approval.waitDecision") {
      return waitResult;
    }
    throw new Error(`unexpected gateway method: ${method}`);
  });
}

async function invokePermissionRequest(relayId: string) {
  return invokeNativeHookRelay({
    provider: "codex",
    relayId,
    event: "permission_request",
    rawPayload: {
      hook_event_name: "PermissionRequest",
      cwd: "/repo",
      tool_name: "Bash",
      tool_use_id: "native-binding-call-1",
      tool_input: { command: "printf binding" },
    },
  });
}

describe("native hook relay approval id binding", () => {
  it("accepts a waitDecision reply bound to the requested approval id", async () => {
    mockGatewayApproval({ id: "approval-1", decision: "allow-once" });
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-binding-match",
      sessionId: "session-1",
      runId: "run-1",
    });

    const response = await invokePermissionRequest(relay.relayId);

    expect(JSON.parse(response.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "PermissionRequest",
        decision: { behavior: "allow" },
      },
    });
  });

  it("defers when a waitDecision reply carries a different approval id", async () => {
    mockGatewayApproval({ id: "approval-other", decision: "allow-once" });
    const relay = registerNativeHookRelay({
      provider: "codex",
      relayId: "codex-approval-binding-mismatch",
      sessionId: "session-1",
      runId: "run-1",
    });

    const response = await invokePermissionRequest(relay.relayId);

    // A misrouted reply must never release the gate; the relay falls back to
    // the provider's own approval path via the noop response.
    expect(response).toEqual({ stdout: "", stderr: "", exitCode: 0 });
    expect(mockCallGatewayTool.mock.calls.map(([method]) => method)).toEqual([
      "plugin.approval.request",
      "plugin.approval.waitDecision",
    ]);
  });
});
