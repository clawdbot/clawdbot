// Talk agent consult dispatch tests pin the trusted internal chat.send
// contract: synthetic consult input must never persist as a visible
// user-authored turn (see issue #133855).
import { beforeEach, describe, expect, it, vi } from "vitest";

const dispatchCalls = vi.hoisted(() => ({
  trustedInternal: vi.fn(),
  trustedInternalWithTools: vi.fn(),
}));

vi.mock("./server-methods/chat-send-handler.js", () => ({
  handleChatSend: vi.fn(),
  handleChatSendWithRuntimeTools: vi.fn(),
  handleTrustedInternalChatSend: dispatchCalls.trustedInternal,
  handleTrustedInternalChatSendWithRuntimeTools: dispatchCalls.trustedInternalWithTools,
}));

import { startTalkRealtimeAgentConsult } from "./talk-agent-consult.js";

type CapturedChatSendOptions = {
  params: Record<string, unknown>;
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
};

function captureDispatch(impl: (options: CapturedChatSendOptions) => void) {
  return (options: CapturedChatSendOptions) => {
    impl(options);
    options.respond(true, { status: "started", runId: "run-consult-1" });
    return Promise.resolve();
  };
}

function consultParams() {
  return {
    context: {
      getRuntimeConfig: () => ({}),
      logGateway: { warn: vi.fn() },
    },
    client: null,
    isWebchatConnect: () => false,
    requestId: "req-1",
    sessionKey: "agent:main:main",
    callId: "call-1",
    args: {
      question: "What changes were made in the Dockerfile to fix it?",
      responseStyle: "concise spoken summary",
    },
  };
}

describe("startTalkRealtimeAgentConsult dispatch", () => {
  beforeEach(() => {
    dispatchCalls.trustedInternal.mockReset();
    dispatchCalls.trustedInternalWithTools.mockReset();
  });

  it("dispatches through the trusted internal channel with a hidden system turn", async () => {
    let captured: CapturedChatSendOptions | undefined;
    dispatchCalls.trustedInternal.mockImplementation(
      captureDispatch((options) => {
        captured = options;
      }),
    );

    const result = await startTalkRealtimeAgentConsult({
      ...consultParams(),
      client: { connect: { scopes: ["operator.admin"] } } as never,
    });

    expect(result).toMatchObject({ ok: true, runId: "run-consult-1" });
    expect(dispatchCalls.trustedInternal).toHaveBeenCalledTimes(1);
    expect(dispatchCalls.trustedInternalWithTools).not.toHaveBeenCalled();
    expect(captured).toBeDefined();
    const params = captured!.params;
    expect(String(params.message).startsWith("[System] ")).toBe(true);
    expect(params.deliver).toBe(false);
    expect(params.suppressCommandInterpretation).toBe(true);
    expect(params.systemInputProvenance).toEqual({
      kind: "internal_system",
      sourceSessionKey: "agent:main:main",
      sourceTool: "talk.agentConsult",
    });
    // The structured consult input must survive flattening.
    expect(params.message).toContain("What changes were made in the Dockerfile to fix it?");
    expect(params.message).toContain("concise spoken summary");
  });

  it("carries the Talk caller's resolved tool boundary on the trusted internal dispatch", async () => {
    dispatchCalls.trustedInternalWithTools.mockImplementation(captureDispatch(() => {}));

    const result = await startTalkRealtimeAgentConsult({
      ...consultParams(),
      client: {
        connect: { scopes: ["operator.read"] },
      } as never,
    });

    expect(result).toMatchObject({ ok: true, runId: "run-consult-1" });
    expect(dispatchCalls.trustedInternalWithTools).toHaveBeenCalledTimes(1);
    expect(dispatchCalls.trustedInternal).not.toHaveBeenCalled();
    const toolsAllow = dispatchCalls.trustedInternalWithTools.mock.calls[0][1] as string[];
    expect(toolsAllow).toContain("memory_search");
    expect(toolsAllow).not.toContain("exec");
  });
});
