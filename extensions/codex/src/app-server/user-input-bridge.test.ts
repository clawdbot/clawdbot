// Codex tests cover gateway-backed request_user_input behavior.
import {
  claimPendingAgentQuestionAnswer,
  type AgentHarnessQuestionGatewayCall,
  type EmbeddedRunAttemptParams,
} from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { createCodexUserInputBridge } from "./user-input-bridge.js";

type GatewayCallRecord = { method: string; opts: unknown; params: unknown };

function createParams(signal?: AbortSignal): EmbeddedRunAttemptParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    agentId: "main",
    timeoutMs: 90_000,
    onBlockReply: vi.fn(),
    onAgentEvent: vi.fn(),
    abortSignal: signal,
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
      return { id: (params as { id: string }).id, expiresAtMs: Date.now() + 90_000 };
    }
    if (method === "question.waitAnswer") {
      return await wait;
    }
    if (method === "question.resolve") {
      const resolveParams = params as {
        answers?: { answers: Record<string, { answers: string[] }> };
        cancel?: boolean;
      };
      const result = resolveParams.cancel
        ? { status: "cancelled" as const }
        : { status: "answered" as const, answers: resolveParams.answers! };
      settleWait?.(result);
      return result;
    }
    throw new Error(`unexpected gateway method: ${method}`);
  };
  return { call, calls };
}

function requestParams(overrides: Record<string, unknown> = {}) {
  return {
    threadId: "thread-1",
    turnId: "turn-1",
    itemId: "tool-1",
    questions: [
      {
        id: "choice",
        header: "Mode",
        question: "Pick a mode",
        isOther: false,
        isSecret: false,
        options: [
          { label: "Fast", description: "Use less reasoning" },
          { label: "Deep", description: "Use more reasoning" },
        ],
      },
    ],
    ...overrides,
  };
}

describe("Codex app-server user input bridge", () => {
  it("registers, presents, claims, and returns gateway answers", async () => {
    const params = createParams();
    const gateway = createGatewayStub();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      gatewayCall: gateway.call,
    });

    const response = bridge.handleRequest({ id: "input-1", params: requestParams() });
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());

    const request = gateway.calls.find((entry) => entry.method === "question.request");
    if (!request) {
      throw new Error("expected question.request");
    }
    expect(request?.params).toMatchObject({
      sessionKey: "agent:main:session-1",
      agentId: "main",
      timeoutMs: 90_000,
      questions: requestParams().questions,
    });
    const payload = vi.mocked(params.onBlockReply!).mock.calls[0]![0];
    expect(payload.channelData).toEqual({
      askUser: { questionId: (request.params as { id: string }).id },
    });
    expect(payload.presentationTextMode).toBe("fallback");
    expect(payload.text).toContain("Reply with the number or option text.");
    expect(payload.text).not.toContain("your own answer");
    const buttons = payload.presentation?.blocks.find((block) => block.type === "buttons");
    expect(buttons?.type === "buttons" ? buttons.buttons[1]?.action : undefined).toMatchObject({
      type: "question",
      optionValue: "Deep",
    });

    await expect(
      claimPendingAgentQuestionAnswer({ sessionKey: params.sessionKey, text: "2" }),
    ).resolves.toBe(true);
    await expect(response).resolves.toEqual({ answers: { choice: { answers: ["Deep"] } } });
  });

  it("cancels the gateway record on run abort", async () => {
    const controller = new AbortController();
    const params = createParams(controller.signal);
    const gateway = createGatewayStub();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      signal: controller.signal,
      gatewayCall: gateway.call,
    });
    const response = bridge.handleRequest({ id: "input-abort", params: requestParams() });
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    controller.abort();

    await expect(response).resolves.toEqual({ answers: {} });
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
    const params = createParams(controller.signal);
    const gateway = createGatewayStub();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      signal: controller.signal,
      gatewayCall: gateway.call,
    });

    await expect(
      bridge.handleRequest({ id: "input-already-aborted", params: requestParams() }),
    ).resolves.toEqual({ answers: {} });
    expect(gateway.calls).toEqual([]);
    expect(params.onBlockReply).not.toHaveBeenCalled();
  });

  it("keeps secret questions on the warned text-only path", async () => {
    const params = createParams();
    const gateway = createGatewayStub();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      gatewayCall: gateway.call,
    });
    const response = bridge.handleRequest({
      id: "input-secret",
      params: requestParams({
        questions: [
          {
            id: "token",
            header: "Secret",
            question: "Enter token",
            isOther: true,
            isSecret: true,
            options: null,
          },
        ],
      }),
    });
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());

    const payload = vi.mocked(params.onBlockReply!).mock.calls[0]![0];
    expect(payload.text).toContain("This channel may show your reply");
    expect(payload.channelData).toBeUndefined();
    expect(gateway.calls).toHaveLength(0);
    expect(bridge.claimPendingRequest()?.answer("private")).toBe(true);
    await expect(response).resolves.toEqual({ answers: { token: { answers: ["private"] } } });
  });

  it("cancels the matching gateway record on serverRequest/resolved", async () => {
    const params = createParams();
    const gateway = createGatewayStub();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      gatewayCall: gateway.call,
    });
    const response = bridge.handleRequest({ id: 42, params: requestParams() });
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    bridge.handleNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: 42 },
    });

    await expect(response).resolves.toEqual({ answers: {} });
    expect(gateway.calls).toContainEqual(
      expect.objectContaining({
        method: "question.resolve",
        params: expect.objectContaining({ cancel: true, resolvedBy: "run-abort" }),
      }),
    );
  });

  it("passes Codex autoResolutionMs and option-less free text through", async () => {
    const params = createParams();
    const gateway = createGatewayStub();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
      gatewayCall: gateway.call,
    });
    const response = bridge.handleRequest({
      id: "input-free",
      params: requestParams({
        autoResolutionMs: 60_000,
        questions: [
          {
            id: "notes",
            header: "Notes",
            question: "What should change?",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      }),
    });
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    expect(gateway.calls[0]?.params).toMatchObject({
      timeoutMs: 60_000,
      questions: [expect.objectContaining({ id: "notes", options: [] })],
    });
    await claimPendingAgentQuestionAnswer({ sessionKey: params.sessionKey, text: "Refactor it" });
    await expect(response).resolves.toEqual({
      answers: { notes: { answers: ["Refactor it"] } },
    });
  });
});
