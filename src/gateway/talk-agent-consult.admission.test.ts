// Talk agent consult admission tests: the realtime provider fires consults
// long after the voice session's creating request has released its gateway
// root admission, and in-process callbacks still inherit that retired root
// through async context. The consult dispatch must detach from it so agent
// work re-enters admission instead of being rejected as subordinate work of
// a closed root (issue #134081).
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  isGatewaySubordinateWorkAdmissionClosed,
  resetGatewayWorkAdmission,
  tryBeginGatewayRootWorkAdmission,
} from "../process/gateway-work-admission.js";

const dispatchCalls = vi.hoisted(() => ({
  chatSend: vi.fn(),
  chatSendWithRuntimeTools: vi.fn(),
}));

vi.mock("./server-methods/chat-send-handler.js", () => ({
  handleChatSend: dispatchCalls.chatSend,
  handleChatSendWithRuntimeTools: dispatchCalls.chatSendWithRuntimeTools,
}));

import { startTalkRealtimeAgentConsult } from "./talk-agent-consult.js";

type CapturedChatSendOptions = {
  params: Record<string, unknown>;
  respond: (ok: boolean, result?: unknown, error?: unknown) => void;
};

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
    args: { question: "What changed in the Dockerfile?" },
  };
}

describe("startTalkRealtimeAgentConsult admission boundary", () => {
  beforeEach(() => {
    resetGatewayWorkAdmission();
    dispatchCalls.chatSend.mockReset();
    dispatchCalls.chatSendWithRuntimeTools.mockReset();
  });

  it("dispatches agent work that is not subordinate to a released root admission", async () => {
    let admissionClosedAtDispatch: boolean | undefined;
    dispatchCalls.chatSendWithRuntimeTools.mockImplementation(
      (options: CapturedChatSendOptions) => {
        admissionClosedAtDispatch = isGatewaySubordinateWorkAdmissionClosed();
        options.respond(true, { status: "started", runId: "run-consult-1" });
        return Promise.resolve();
      },
    );

    const lease = tryBeginGatewayRootWorkAdmission();
    expect(lease).not.toBeNull();
    await lease!.run(async () => {
      // The creating request completes (releasing its root) while the
      // long-lived realtime callback chain survives and fires a consult.
      lease!.release();
      const result = await startTalkRealtimeAgentConsult(consultParams());
      expect(result).toMatchObject({ ok: true, runId: "run-consult-1" });
    });

    expect(admissionClosedAtDispatch).toBe(false);
  });

  it("still starts a normal consult run when no root admission is inherited", async () => {
    dispatchCalls.chatSendWithRuntimeTools.mockImplementation(
      (options: CapturedChatSendOptions) => {
        options.respond(true, { status: "started", runId: "run-consult-2" });
        return Promise.resolve();
      },
    );

    const result = await startTalkRealtimeAgentConsult(consultParams());

    expect(result).toMatchObject({ ok: true, runId: "run-consult-2" });
    expect(isGatewaySubordinateWorkAdmissionClosed()).toBe(false);
  });
});
