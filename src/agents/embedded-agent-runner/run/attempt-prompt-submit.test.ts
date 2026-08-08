import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ImageContent } from "../../../llm/types.js";
import type { AgentMessage } from "../../runtime/index.js";
import {
  clearProviderPromptState,
  getProviderPromptState,
  wrapStreamFnWithProviderPromptState,
} from "../provider-prompt-state.js";
import {
  clearEmbeddedSessionPromptStates,
  getEmbeddedSessionPromptState,
} from "../session-prompt-state.js";
import { dropThinkingBlocks } from "../thinking.js";
import { submitEmbeddedAttemptPrompt } from "./attempt-prompt-submit.js";
import { wrapStreamFnWithMessageTransform } from "./message-transform-stream-wrapper.js";
import { MidTurnPrecheckSignal } from "./midturn-precheck.js";
import type { RuntimeContextCustomMessage } from "./runtime-context-prompt.js";

const sessionId = "attempt-prompt-submit-test";

function wrapProviderBoundary(streamFn: StreamFn): StreamFn {
  return wrapStreamFnWithProviderPromptState({
    streamFn,
    state: getProviderPromptState(sessionId),
    effectiveContextTokenBudget: 8_000,
  });
}

function createSession() {
  const state = {
    messages: [{ role: "user", content: "transcript prompt", timestamp: 1 }] as AgentMessage[],
  };
  const baseStreamFn = wrapProviderBoundary(() => {
    throw new Error("stream function should not be called directly");
  });
  const originalTransformContext = async (messages: AgentMessage[]) => messages;
  const agent = {
    state,
    streamFn: baseStreamFn,
    transformContext: originalTransformContext,
  };
  const activeSession = {
    get messages() {
      return state.messages;
    },
    agent,
  };
  return { activeSession, baseStreamFn, originalTransformContext };
}

function createBaseInput() {
  const sessionPromptState = getEmbeddedSessionPromptState(sessionId);
  return {
    attempt: { runId: sessionId, sessionId },
    appendContext: "append context",
    contextTokenBudget: 8_000,
    images: [] as ImageContent[],
    modelPrompt: "model prompt",
    midTurnPrecheckEnabled: false,
    onFinalPromptText: vi.fn(),
    onSteeringAcknowledged: vi.fn(),
    prependContext: "prepend context",
    runtimeOnly: false,
    reserveTokens: 1_000,
    sessionPromptState,
    systemPrompt: "system prompt",
    toolResultAggregateMaxChars: 8_000,
    toolResultMaxChars: 4_000,
    toolResultPromptProjectionState: sessionPromptState.toolResults,
    trajectoryRecorder: null,
    transcriptLeafId: null,
    transcriptPrompt: "transcript prompt",
  };
}

afterEach(() => {
  clearEmbeddedSessionPromptStates([sessionId]);
  clearProviderPromptState(sessionId);
});

describe("submitEmbeddedAttemptPrompt", () => {
  it("submits runtime-only prompts without images and acknowledges steering", async () => {
    const { activeSession, baseStreamFn, originalTransformContext } = createSession();
    const input = createBaseInput();
    const promptActiveSession = vi.fn(
      async (
        prompt: string,
        options?: { images?: ImageContent[]; preflightResult?: (submitted: boolean) => void },
      ) => {
        expect(prompt).toBe("transcript prompt");
        expect(options).not.toHaveProperty("images");
        expect(input.onFinalPromptText).toHaveBeenCalledWith("transcript prompt");
        expect(activeSession.agent.streamFn).toBe(baseStreamFn);
        expect(getProviderPromptState(sessionId).contextAdmission).toBeTypeOf("function");
        expect(activeSession.agent.transformContext).not.toBe(originalTransformContext);
        options?.preflightResult?.(true);
      },
    );

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      images: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
      leasedSteering: { leaseId: "lease-1", runIds: ["missing-run"] },
      promptActiveSession,
      runtimeOnly: true,
    });

    expect(input.onSteeringAcknowledged).toHaveBeenCalledOnce();
    expect(activeSession.agent.streamFn).toBe(baseStreamFn);
    expect(getProviderPromptState(sessionId).contextAdmission).toBeUndefined();
    expect(activeSession.agent.transformContext).toBe(originalTransformContext);
  });

  it("cleans up runtime context and transforms when normal submission fails", async () => {
    const { activeSession, baseStreamFn, originalTransformContext } = createSession();
    const input = createBaseInput();
    const image: ImageContent = { type: "image", data: "aW1hZ2U=", mimeType: "image/png" };
    const runtimeContextMessage: RuntimeContextCustomMessage = {
      role: "custom",
      customType: "openclaw.runtime-context",
      content: "runtime context",
      display: false,
      details: { source: "openclaw-runtime-context", runtimeContextCarrier: true },
      timestamp: 2,
    };
    const promptActiveSession = vi.fn(
      async (
        _prompt: string,
        options?: { images?: ImageContent[]; preflightResult?: (submitted: boolean) => void },
      ) => {
        expect(activeSession.messages).toContain(runtimeContextMessage);
        expect(options?.images).toEqual([image]);
        expect(getProviderPromptState(sessionId).contextAdmission).toBeTypeOf("function");
        options?.preflightResult?.(true);
        throw new Error("provider failed");
      },
    );

    await expect(
      submitEmbeddedAttemptPrompt({
        ...input,
        activeSession,
        images: [image],
        promptActiveSession,
        runtimeContextMessage,
      }),
    ).rejects.toThrow("provider failed");

    expect(input.onFinalPromptText).toHaveBeenCalledWith("transcript prompt");
    expect(input.onSteeringAcknowledged).not.toHaveBeenCalled();
    expect(activeSession.messages).not.toContain(runtimeContextMessage);
    expect(activeSession.agent.streamFn).toBe(baseStreamFn);
    expect(getProviderPromptState(sessionId).contextAdmission).toBeUndefined();
    expect(activeSession.agent.transformContext).toBe(originalTransformContext);
  });

  it("passes through context-free session stream invocations", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const streamFn = vi.fn(() => undefined as never);
    activeSession.agent.streamFn = wrapProviderBoundary(streamFn as unknown as StreamFn);

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      promptActiveSession: async () => {
        await (activeSession.agent.streamFn as unknown as () => Promise<void>)();
      },
    });

    expect(streamFn).toHaveBeenCalledOnce();
    expect(streamFn).toHaveBeenCalledWith(
      undefined,
      undefined,
      expect.objectContaining({ onPayload: expect.any(Function) }),
    );
  });

  it("caps oversized MCP tool results at the provider boundary", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const oversized = "x".repeat(5 * 1024 * 1024);
    const small = "small MCP result";
    activeSession.agent.state.messages = [
      { role: "user", content: "call MCP tools", timestamp: 1 },
      {
        role: "toolResult",
        toolCallId: "mcp-huge-call",
        toolName: "huge__return_text",
        content: [{ type: "text", text: oversized }],
        isError: false,
        details: { mcpServer: "huge", mcpTool: "return_text" },
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "mcp-small-call",
        toolName: "huge__small_text",
        content: [{ type: "text", text: small }],
        isError: false,
        details: { mcpServer: "huge", mcpTool: "small_text" },
        timestamp: 3,
      },
    ] as AgentMessage[];
    let providerMessages: AgentMessage[] = [];
    activeSession.agent.streamFn = wrapProviderBoundary(((_model, context) => {
      providerMessages = (context as { messages: AgentMessage[] }).messages;
      return undefined as never;
    }) as StreamFn);

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      promptActiveSession: async () => {
        await activeSession.agent.streamFn(
          {} as never,
          { messages: activeSession.messages } as never,
          {} as never,
        );
      },
    });

    type ToolResultMessage = Extract<AgentMessage, { role: "toolResult" }>;
    const hugeResult = providerMessages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "mcp-huge-call",
    );
    const smallResult = providerMessages.find(
      (message): message is ToolResultMessage =>
        message.role === "toolResult" && message.toolCallId === "mcp-small-call",
    );
    expect(hugeResult?.content[0]).toMatchObject({
      type: "text",
      text: expect.stringMatching(/more characters truncated/),
    });
    expect(hugeResult?.content[0]?.type === "text" ? hugeResult.content[0].text.length : 0).toBe(
      input.toolResultMaxChars,
    );
    expect(smallResult?.content).toEqual([{ type: "text", text: small }]);
    const originalHugeResult = activeSession.messages[1];
    expect(originalHugeResult?.role).toBe("toolResult");
    expect(
      originalHugeResult?.role === "toolResult" ? originalHugeResult.content : undefined,
    ).toEqual([{ type: "text", text: oversized }]);
  });

  it("routes pressure from the complete provider context before dispatch", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const providerDispatch = vi.fn(async (_model: unknown, _context: unknown, options: unknown) => {
      const hooks = options as {
        onPayload?: (payload: unknown, model: unknown) => Promise<unknown>;
        onResponse?: (response: unknown, model: unknown) => Promise<unknown>;
      };
      await hooks.onPayload?.({ input: "raw" }, {});
      await hooks.onResponse?.({ status: 200, headers: {} }, {});
      return undefined as never;
    });
    activeSession.agent.streamFn = wrapProviderBoundary(providerDispatch as unknown as StreamFn);

    await expect(
      submitEmbeddedAttemptPrompt({
        ...input,
        activeSession,
        contextTokenBudget: 4_000,
        midTurnPrecheckEnabled: true,
        reserveTokens: 1_000,
        promptActiveSession: async () => {
          await activeSession.agent.streamFn(
            {} as never,
            { messages: activeSession.messages } as never,
            {} as never,
          );
          try {
            await activeSession.agent.streamFn(
              {} as never,
              {
                messages: [
                  { role: "user", content: "earlier prompt", timestamp: 1 },
                  { role: "assistant", content: "h".repeat(8_000), timestamp: 2 },
                  ...activeSession.messages,
                ],
                tools: [
                  {
                    name: "large_tool",
                    description: "x".repeat(5_000),
                    parameters: { type: "object", properties: {} },
                  },
                ],
              } as never,
              {} as never,
            );
          } catch {
            // AgentCore owns stream failures and resolves prompt() after appending an assistant error.
          }
        },
      }),
    ).rejects.toBeInstanceOf(MidTurnPrecheckSignal);

    expect(providerDispatch).toHaveBeenCalledOnce();
  });

  it("admits the context after outbound thinking transforms", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    const providerMessages: AgentMessage[][] = [];
    const providerDispatch = ((_model, context) => {
      providerMessages.push((context as { messages: AgentMessage[] }).messages);
      return undefined as never;
    }) as StreamFn;
    activeSession.agent.streamFn = wrapStreamFnWithMessageTransform(
      wrapProviderBoundary(providerDispatch),
      dropThinkingBlocks,
    );

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      contextTokenBudget: 4_000,
      midTurnPrecheckEnabled: true,
      reserveTokens: 1_000,
      promptActiveSession: async () => {
        await activeSession.agent.streamFn(
          {} as never,
          { messages: activeSession.messages } as never,
          {} as never,
        );
        await activeSession.agent.streamFn(
          {} as never,
          {
            messages: [
              { role: "user", content: "first", timestamp: 1 },
              {
                role: "assistant",
                content: [
                  { type: "thinking", thinking: "x".repeat(30_000) },
                  { type: "text", text: "old answer" },
                ],
                timestamp: 2,
              },
              { role: "user", content: "second", timestamp: 3 },
              {
                role: "assistant",
                content: [{ type: "text", text: "latest answer" }],
                timestamp: 4,
              },
              { role: "user", content: "continue", timestamp: 5 },
            ],
          } as never,
          {} as never,
        );
      },
    });

    expect(providerMessages).toHaveLength(2);
    expect(providerMessages[1]?.[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "old answer" }],
    });
  });

  it("records the prompt as sent only after the provider responds", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    activeSession.agent.state.messages = [
      {
        role: "user",
        content: "first turn",
        idempotencyKey: "turn-1",
        timestamp: 1,
      } as AgentMessage,
    ] as AgentMessage[];
    activeSession.agent.streamFn = wrapProviderBoundary((async (
      _model: unknown,
      _context: unknown,
      options: unknown,
    ) => {
      const hooks = options as {
        onPayload?: (payload: unknown, model: unknown) => Promise<unknown>;
        onResponse?: (response: unknown, model: unknown) => Promise<unknown>;
      };
      await hooks.onPayload?.({ input: "raw" }, {});
      await hooks.onResponse?.({ status: 200, headers: {} }, {});
      return undefined as never;
    }) as unknown as StreamFn);

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      promptActiveSession: async () => {
        await activeSession.agent.streamFn(
          {} as never,
          { messages: activeSession.messages } as never,
          {} as never,
        );
      },
    });

    expect(input.sessionPromptState.sentUserTurnIds.has("turn-1")).toBe(true);
  });

  it("does not record the prompt as sent when setup fails after payload preparation", async () => {
    const { activeSession } = createSession();
    const input = createBaseInput();
    activeSession.agent.state.messages = [
      {
        role: "user",
        content: "first turn",
        idempotencyKey: "turn-1",
        timestamp: 1,
      } as AgentMessage,
    ] as AgentMessage[];
    activeSession.agent.streamFn = wrapProviderBoundary((async (
      _model: unknown,
      _context: unknown,
      options: unknown,
    ) => {
      await (
        options as { onPayload?: (payload: unknown, model: unknown) => Promise<unknown> }
      ).onPayload?.({ input: "raw" }, {});
      throw new Error("connection refused");
    }) as unknown as StreamFn);

    await submitEmbeddedAttemptPrompt({
      ...input,
      activeSession,
      promptActiveSession: async () => {
        await expect(
          activeSession.agent.streamFn(
            {} as never,
            { messages: activeSession.messages } as never,
            {
              onPayload: (payload: unknown) => payload,
            } as never,
          ),
        ).rejects.toThrow("connection refused");
      },
    });

    expect(input.sessionPromptState.sentUserTurnIds.has("turn-1")).toBe(false);
  });
});
