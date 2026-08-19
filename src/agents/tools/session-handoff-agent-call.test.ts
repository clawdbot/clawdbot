import { beforeEach, describe, expect, it, vi } from "vitest";
import { callSessionHandoffAgent } from "./session-handoff-agent-call.js";

const mocks = vi.hoisted(() => ({
  callGatewayTool: vi.fn(async () => ({ runId: "target-run" })),
}));

vi.mock("./gateway.js", () => ({
  callGatewayTool: mocks.callGatewayTool,
}));

beforeEach(() => {
  vi.clearAllMocks();
});

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

  it("returns the accepted response while retaining the final request", async () => {
    let resolveFinal = (_value: unknown) => {};
    mocks.callGatewayTool.mockImplementationOnce(
      async (_method, _options, _params, extra) =>
        await new Promise((resolve) => {
          resolveFinal = resolve;
          extra?.onAccepted?.({ runId: "target-run", status: "accepted" });
        }),
    );

    const response = await callSessionHandoffAgent<{ runId: string }>({
      request: {
        method: "agent",
        params: {
          sessionKey: "agent:main:target",
          idempotencyKey: "target-run",
          message: "work",
        },
        expectFinal: true,
      },
      authority: { agentId: "main", sessionKey: "agent:main:source" },
      context: {
        inheritedToolPolicy: { version: 1, allow: ["read"], deny: [] },
        requester: { messageProvider: "discord", senderId: "speaker-1" },
      },
    });

    expect(response).toEqual({ runId: "target-run", status: "accepted" });
    expect(mocks.callGatewayTool.mock.calls[0]?.[3]).toMatchObject({ expectFinal: true });
    resolveFinal({ runId: "target-run", status: "ok" });
  });
});
