import { describe, expect, it, vi } from "vitest";
import { callSessionHandoffAgent } from "./session-handoff-agent-call.js";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(async () => ({ runId: "target-run" })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: mocks.callGatewayTool,
}));

describe("callSessionHandoffAgent", () => {
  it("fences server admission with an exact-run abort mutation", async () => {
    const signal = new AbortController().signal;
    await callSessionHandoffAgent({
      request: {
        method: "agent",
        params: {
          sessionKey: "agent:main:target",
          idempotencyKey: "target-run",
          message: "work",
        },
        signal,
      },
      authority: { agentId: "main", sessionKey: "agent:main:source" },
      context: {
        inheritedToolPolicy: { version: 1, allow: ["read"], deny: [] },
        requester: { messageProvider: "discord", senderId: "speaker-1" },
      },
    });

    const extra = mocks.callGatewayTool.mock.calls[0]?.[3];
    expect(extra).toMatchObject({ requireAgentRuntimeIdentity: true, signal });
    const abortRequest = vi.fn(async () => ({ ok: true }));
    await extra?.onSignalAbort?.(abortRequest);
    expect(abortRequest).toHaveBeenCalledWith(
      "chat.abort",
      { sessionKey: "agent:main:target", runId: "target-run" },
      { timeoutMs: 5_000 },
    );
  });
});
