// Codex tests cover user input bridge plugin behavior.
import type { EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import { describe, expect, it, vi } from "vitest";
import { resolveCodexUserInputAction } from "./user-input-actions.js";
import { createCodexUserInputBridge } from "./user-input-bridge.js";

function createParams(): EmbeddedRunAttemptParams {
  return {
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    onBlockReply: vi.fn(),
    onAgentEvent: vi.fn(),
  } as unknown as EmbeddedRunAttemptParams;
}

function expectFirstBlockReplyText(params: EmbeddedRunAttemptParams): string {
  const onBlockReply = params.onBlockReply;
  if (onBlockReply === undefined) {
    throw new Error("Expected onBlockReply callback");
  }
  const payload = vi.mocked(onBlockReply).mock.calls[0]?.[0];
  if (typeof payload?.text !== "string") {
    throw new Error("Expected first block reply text");
  }
  return payload.text;
}

describe("Codex app-server user input bridge", () => {
  it("prompts the originating chat and resolves request_user_input from the next queued message", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-1",
      params: {
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
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    expect(expectFirstBlockReplyText(params)).toContain("Pick a mode");
    expect(bridge.handleQueuedMessage("2")).toBe(true);

    await expect(response).resolves.toEqual({
      answers: { choice: { answers: ["Deep"] } },
    });
  });

  it("emits a web question card and typed channel actions", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-actions",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-actions",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [{ label: "Fast" }, { label: "Deep" }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    expect(params.onAgentEvent).toHaveBeenCalledWith({
      stream: "question",
      data: expect.objectContaining({ phase: "requested", itemId: "tool-actions" }),
    });
    const presentation = vi.mocked(params.onBlockReply!).mock.calls[0]?.[0].presentation;
    const block = presentation?.blocks[0];
    expect(block?.type).toBe("buttons");
    if (block?.type !== "buttons") {
      throw new Error("expected typed question buttons");
    }
    const action = block.buttons[1]?.action;
    expect(action?.type).toBe("command");
    if (action?.type !== "command") {
      throw new Error("expected command action");
    }
    const match = action.command.match(/^\/codex answer ([0-9a-f-]+) choice:1$/u);
    expect(match).not.toBeNull();
    expect(resolveCodexUserInputAction(match![1]!, { type: "choice", optionIndex: 1 })).toBe(true);

    await expect(response).resolves.toEqual({ answers: { mode: { answers: ["Deep"] } } });
    expect(params.onAgentEvent).toHaveBeenLastCalledWith({
      stream: "question",
      data: expect.objectContaining({ phase: "resolved", itemId: "tool-actions" }),
    });
  });

  it("keeps numeric labels distinct from typed option indexes", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const response = bridge.handleRequest({
      id: "input-numeric-label",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-numeric-label",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [{ label: "2" }, { label: "Deep" }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    const event = vi
      .mocked(params.onAgentEvent!)
      .mock.calls.find(([payload]) => payload.stream === "question")?.[0];
    const actionId =
      event && typeof event.data === "object" && event.data && "actionToken" in event.data
        ? event.data.actionToken
        : undefined;
    expect(typeof actionId).toBe("string");
    expect(
      resolveCodexUserInputAction(String(actionId), {
        type: "answers",
        answers: { mode: "2" },
      }),
    ).toBe(true);
    await expect(response).resolves.toEqual({ answers: { mode: { answers: ["2"] } } });
  });

  it("preserves case-distinct structured option labels", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const response = bridge.handleRequest({
      id: "input-case-label",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-case-label",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [{ label: "FAST" }, { label: " fast " }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    const event = vi
      .mocked(params.onAgentEvent!)
      .mock.calls.find(([payload]) => payload.stream === "question")?.[0];
    const actionId =
      event && typeof event.data === "object" && event.data && "actionToken" in event.data
        ? event.data.actionToken
        : undefined;
    expect(
      resolveCodexUserInputAction(String(actionId), {
        type: "answers",
        answers: { mode: " fast " },
      }),
    ).toBe(true);
    await expect(response).resolves.toEqual({ answers: { mode: { answers: [" fast "] } } });
  });

  it("preserves reserved question ids in structured answers", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const response = bridge.handleRequest({
      id: "input-reserved-id",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-reserved-id",
        questions: [
          {
            id: "__proto__",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [{ label: "Safe" }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    const event = vi
      .mocked(params.onAgentEvent!)
      .mock.calls.find(([payload]) => payload.stream === "question")?.[0];
    const actionId =
      event && typeof event.data === "object" && event.data && "actionToken" in event.data
        ? event.data.actionToken
        : undefined;
    expect(
      resolveCodexUserInputAction(String(actionId), {
        type: "answers",
        answers: Object.fromEntries([["__proto__", "Safe"]]),
      }),
    ).toBe(true);
    await expect(response).resolves.toEqual({
      answers: Object.fromEntries([["__proto__", { answers: ["Safe"] }]]),
    });
  });

  it("does not expose secret questions as channel buttons", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const response = bridge.handleRequest({
      id: "input-secret",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-secret",
        questions: [
          {
            id: "secret",
            header: "Secret",
            question: "Enter it",
            isOther: true,
            isSecret: true,
            options: [{ label: "Stored value" }],
          },
        ],
      },
    });
    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledOnce());
    expect(vi.mocked(params.onBlockReply!).mock.calls[0]?.[0].presentation).toBeUndefined();
    expect(params.onAgentEvent).toHaveBeenCalledWith({
      stream: "question",
      data: expect.not.objectContaining({ actionToken: expect.anything() }),
    });
    expect(bridge.handleQueuedMessage("private")).toBe(true);
    await response;
  });

  it("does not let a captured handle settle a replacement request", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });
    const question = {
      id: "answer",
      header: "Answer",
      question: "Continue?",
      isOther: true,
      isSecret: false,
      options: null,
    };
    const firstResponse = bridge.handleRequest({
      id: "input-first",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-first",
        questions: [question],
      },
    });
    const firstHandle = bridge.claimPendingRequest();
    expect(firstHandle).toBeDefined();

    const secondResponse = bridge.handleRequest({
      id: "input-second",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-second",
        questions: [question],
      },
    });

    await expect(firstResponse).resolves.toEqual({ answers: {} });
    expect(firstHandle?.cancel()).toBe(false);
    expect(bridge.claimPendingRequest()).toBeDefined();
    bridge.cancelPending();
    await expect(secondResponse).resolves.toEqual({ answers: {} });
  });

  it("maps keyed multi-question replies to Codex answer ids", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-2",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "repo",
            header: "Repository",
            question: "Which repo?",
            isOther: true,
            isSecret: false,
            options: null,
          },
          {
            id: "scope",
            header: "Scope",
            question: "Which scope?",
            isOther: false,
            isSecret: false,
            options: [{ label: "Tests", description: "Only tests" }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    expect(bridge.handleQueuedMessage("repo: openclaw\nscope: Tests")).toBe(true);

    await expect(response).resolves.toEqual({
      answers: {
        repo: { answers: ["openclaw"] },
        scope: { answers: ["Tests"] },
      },
    });
  });

  it("rejects free-form option replies when Other is disabled", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-options",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "mode",
            header: "Mode",
            question: "Pick a mode",
            isOther: false,
            isSecret: false,
            options: [{ label: "Fast", description: "Use less reasoning" }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    expect(bridge.handleQueuedMessage("banana")).toBe(true);

    await expect(response).resolves.toEqual({
      answers: { mode: { answers: [] } },
    });
  });

  it("escapes prompt question and option text before chat display", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-escaped",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "mode",
            header: "Mode <@U123>",
            question: "Pick [trusted](https://evil) @here",
            isOther: false,
            isSecret: false,
            options: [{ label: "Fast <@U123>", description: "Use [less](https://evil)" }],
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    const text = expectFirstBlockReplyText(params);
    expect(text).toContain("Mode &lt;\uff20U123&gt;");
    expect(text).toContain("Pick \uff3btrusted\uff3d\uff08https://evil\uff09 \uff20here");
    expect(text).toContain(
      "Fast &lt;\uff20U123&gt; - Use \uff3bless\uff3d\uff08https://evil\uff09",
    );
    expect(text).not.toContain("<@U123>");
    expect(text).not.toContain("[trusted](https://evil)");
    expect(text).not.toContain("@here");

    expect(bridge.handleQueuedMessage("1")).toBe(true);
    await expect(response).resolves.toEqual({
      answers: { mode: { answers: ["Fast <@U123>"] } },
    });
  });

  it("clears pending prompts when Codex resolves the server request itself", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    const response = bridge.handleRequest({
      id: "input-3",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "tool-1",
        questions: [
          {
            id: "answer",
            header: "Answer",
            question: "Continue?",
            isOther: true,
            isSecret: false,
            options: null,
          },
        ],
      },
    });

    await vi.waitFor(() => expect(params.onBlockReply).toHaveBeenCalledTimes(1));
    bridge.handleNotification({
      method: "serverRequest/resolved",
      params: { threadId: "thread-1", requestId: "input-3" },
    });

    await expect(response).resolves.toEqual({ answers: {} });
    expect(bridge.handleQueuedMessage("too late")).toBe(false);
  });

  it("resolves malformed empty question prompts without waiting for chat input", async () => {
    const params = createParams();
    const bridge = createCodexUserInputBridge({
      paramsForRun: params,
      threadId: "thread-1",
      turnId: "turn-1",
    });

    await expect(
      bridge.handleRequest({
        id: "input-empty",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          itemId: "tool-1",
          questions: [],
        },
      }),
    ).resolves.toEqual({ answers: {} });
    expect(params.onBlockReply).not.toHaveBeenCalled();
    expect(bridge.handleQueuedMessage("late answer")).toBe(false);
  });
});
