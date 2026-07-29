// Copilot tests cover SDK ask_user gateway behavior.
import {
  claimPendingAgentQuestionAnswer,
  type AgentHarnessQuestionGatewayCall,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCopilotUserInputBridge } from "./user-input-bridge.js";

type GatewayCallRecord = { method: string; opts: unknown; params: unknown };

function createParams(): EmbeddedRunAttemptParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    agentId: "main",
    timeoutMs: 75_000,
    onBlockReply: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
}

function createGatewayStub() {
  const calls: GatewayCallRecord[] = [];
  let settleWait: ((value: unknown) => void) | undefined;
  const wait = new Promise<unknown>((resolve) => {
    settleWait = resolve;
  });
  const call: AgentHarnessQuestionGatewayCall = async (method, opts, params) => {
    calls.push({ method, opts, params });
    if (method === "question.request") {
      return { id: (params as { id: string }).id, expiresAtMs: Date.now() + 75_000 };
    }
    if (method === "question.waitAnswer") {
      return await wait;
    }
    if (method === "question.resolve") {
      const resolved = params as {
        answers?: { answers: Record<string, string[]> };
        cancel?: boolean;
      };
      const result = resolved.cancel
        ? { status: "cancelled" as const }
        : { status: "answered" as const, answers: resolved.answers! };
      settleWait?.(result);
      return result;
    }
    throw new Error(`unexpected gateway method: ${method}`);
  };
  return { call, calls };
}

describe("Copilot user input bridge", () => {
  it("registers, presents, claims, and returns a selected option", async () => {
    const params = createParams();
    const gateway = createGatewayStub();
    const bridge = createCopilotUserInputBridge({
      paramsForRun: params,
      gatewayCall: gateway.call,
    });
    const response = bridge.onUserInputRequest(
      { question: "Pick a mode", choices: ["Fast", "Deep"], allowFreeform: false },
      { sessionId: "sdk-session-1" },
    );
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    const request = gateway.calls[0];
    if (!request) {
      throw new Error("expected question.request");
    }

    expect(request.params).toMatchObject({
      sessionKey: "agent:main:session-1",
      agentId: "main",
      timeoutMs: 75_000,
      questions: [
        expect.objectContaining({
          questionId: "answer",
          options: [{ label: "Fast" }, { label: "Deep" }],
        }),
      ],
    });
    const payload = vi.mocked(params.onBlockReply!).mock.calls[0]![0];
    expect(payload.channelData).toEqual({
      askUser: { questionId: (request.params as { id: string }).id },
    });
    expect(payload.presentationTextMode).toBe("fallback");
    expect(payload.text).toContain("Reply with the number or option text.");
    expect(payload.text).not.toContain("your own answer");

    await expect(
      claimPendingAgentQuestionAnswer({ sessionKey: params.sessionKey, text: "2" }),
    ).resolves.toBe(true);
    await expect(response).resolves.toEqual({ answer: "Deep", wasFreeform: false });
  });

  it("supports option-less free-form questions", async () => {
    const params = createParams();
    const gateway = createGatewayStub();
    const bridge = createCopilotUserInputBridge({
      paramsForRun: params,
      gatewayCall: gateway.call,
    });
    const response = bridge.onUserInputRequest(
      { question: "Which branch?", allowFreeform: true },
      { sessionId: "sdk-session-1" },
    );
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    expect(gateway.calls[0]?.params).toMatchObject({
      questions: [expect.objectContaining({ options: [] })],
    });
    expect(vi.mocked(params.onBlockReply!).mock.calls[0]![0].presentation).toBeUndefined();

    await claimPendingAgentQuestionAnswer({
      sessionKey: params.sessionKey,
      text: "fix/harness-parity",
    });
    await expect(response).resolves.toEqual({ answer: "fix/harness-parity", wasFreeform: true });
  });

  it("escapes SDK-controlled prompt text before delivery", async () => {
    const params = createParams();
    const gateway = createGatewayStub();
    const bridge = createCopilotUserInputBridge({
      paramsForRun: params,
      gatewayCall: gateway.call,
    });
    const response = bridge.onUserInputRequest(
      {
        question: "Pick [trusted](https://evil) <@U123> @here\u202e",
        choices: ["One @everyone", "Two `code`"],
        allowFreeform: false,
      },
      { sessionId: "sdk-session-1" },
    );
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    const text = vi.mocked(params.onBlockReply!).mock.calls[0]![0].text ?? "";
    expect(text).not.toContain("@here");
    expect(text).not.toContain("@everyone");
    expect(text).not.toContain("<@U123>");
    expect(text).not.toContain("[trusted](https://evil)");
    expect(text).not.toContain("`code`");
    expect(text).toContain("\uff20here");
    expect(text).toContain("\uff3btrusted\uff3d");
    const presentation = vi.mocked(params.onBlockReply!).mock.calls[0]![0].presentation;
    const visiblePresentation = presentation?.blocks.map((block) =>
      block.type === "text"
        ? block.text
        : block.type === "buttons"
          ? block.buttons.map((button) => button.label).join(" ")
          : "",
    );
    expect(JSON.stringify(visiblePresentation)).not.toContain("@here");
    expect(JSON.stringify(visiblePresentation)).not.toContain("@everyone");
    expect(JSON.stringify(visiblePresentation)).not.toContain("<@U123>");
    expect(JSON.stringify(visiblePresentation)).not.toContain("[trusted](https://evil)");
    bridge.cancelPending();
    await response;
  });

  it("cancels the gateway record and returns an empty answer on abort", async () => {
    const params = createParams();
    const controller = new AbortController();
    const gateway = createGatewayStub();
    const bridge = createCopilotUserInputBridge({
      paramsForRun: params,
      signal: controller.signal,
      gatewayCall: gateway.call,
    });
    const response = bridge.onUserInputRequest(
      { question: "Continue?", choices: ["Yes", "No"], allowFreeform: false },
      { sessionId: "sdk-session-1" },
    );
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    controller.abort();

    await expect(response).resolves.toEqual({ answer: "", wasFreeform: true });
    expect(gateway.calls).toContainEqual(
      expect.objectContaining({
        method: "question.resolve",
        params: expect.objectContaining({ cancel: true, resolvedBy: "run-abort" }),
      }),
    );
  });

  it("does not register a gateway question after the run already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const params = createParams();
    const gateway = createGatewayStub();
    const bridge = createCopilotUserInputBridge({
      paramsForRun: params,
      signal: controller.signal,
      gatewayCall: gateway.call,
    });

    await expect(
      bridge.onUserInputRequest(
        { question: "Continue?", choices: ["Yes", "No"], allowFreeform: false },
        { sessionId: "sdk-session-1" },
      ),
    ).resolves.toEqual({ answer: "", wasFreeform: true });
    expect(gateway.calls).toEqual([]);
    expect(params.onBlockReply).not.toHaveBeenCalled();
  });
});
