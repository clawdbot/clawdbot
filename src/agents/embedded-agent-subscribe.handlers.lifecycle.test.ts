import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { handleAgentEnd } from "./embedded-agent-subscribe.handlers.lifecycle.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";

const { emitAgentEventMock } = vi.hoisted(() => ({
  emitAgentEventMock: vi.fn(),
}));

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: emitAgentEventMock,
}));

function createContext(
  lastAssistant: unknown,
  overrides?: {
    onAgentEvent?: (event: unknown) => void;
    onBeforeLifecycleTerminal?: () => void | Promise<void>;
    onBlockReply?: ((payload: unknown) => void) | undefined;
    onBlockReplyFlush?: () => void | Promise<void>;
  },
): EmbeddedAgentSubscribeContext {
  const hasOnBlockReplyOverride = Boolean(overrides && "onBlockReply" in overrides);
  const onBlockReply = hasOnBlockReplyOverride ? overrides?.onBlockReply : vi.fn();
  const emitBlockReply = vi.fn();
  return {
    params: {
      runId: "run-1",
      config: {},
      sessionKey: "agent:main:main",
      onAgentEvent: overrides?.onAgentEvent,
      onBeforeLifecycleTerminal: overrides?.onBeforeLifecycleTerminal,
      ...(onBlockReply ? { onBlockReply } : {}),
      onBlockReplyFlush: overrides?.onBlockReplyFlush,
    },
    state: {
      lastAssistant: lastAssistant as EmbeddedAgentSubscribeContext["state"]["lastAssistant"],
      pendingCompactionRetry: 0,
      pendingToolMediaUrls: [],
      pendingToolAudioAsVoice: false,
      replayState: { replayInvalid: false, hadPotentialSideEffects: false },
      blockState: {
        thinking: true,
        final: true,
        inlineCode: createInlineCodeState(),
      },
    },
    log: {
      debug: vi.fn(),
      warn: vi.fn(),
    },
    flushBlockReplyBuffer: vi.fn(),
    emitBlockReply,
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
  } as unknown as EmbeddedAgentSubscribeContext;
}

async function handleAgentEndAndReadWarnMeta(ctx: EmbeddedAgentSubscribeContext) {
  await handleAgentEnd(ctx);

  const warn = vi.mocked(ctx.log.warn);
  expect(warn).toHaveBeenCalledTimes(1);
  const [message, meta] = firstMockCall(warn);
  expect(message).toBe("embedded run agent end");
  return readRecord(meta);
}

function readRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    throw new Error("expected metadata record");
  }
  return value as Record<string, unknown>;
}

function firstMockCall(mock: { mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> } }) {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error("expected first mock call");
  }
  return call;
}

function firstWarnMeta(ctx: EmbeddedAgentSubscribeContext): Record<string, unknown> {
  return readRecord(firstMockCall(vi.mocked(ctx.log.warn))[1]);
}

describe("handleAgentEnd", () => {
  it("suppresses raw assistant error messages in user-facing lifecycle events", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "SECRET_CANARY_69737",
        content: [],
      },
      { onAgentEvent },
    );

    await handleAgentEnd(ctx);

    const meta = firstWarnMeta(ctx);
    expect(meta.error).not.toContain("SECRET_CANARY_69737");
    expect(meta.error).toBe("LLM request failed.");
    const userFacingLifecycleText = JSON.stringify(onAgentEvent.mock.calls);
    expect(userFacingLifecycleText).not.toContain("SECRET_CANARY_69737");
    expect(userFacingLifecycleText).toContain("LLM request failed.");
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "LLM request failed.",
      },
    });
  });

  it("suppresses structured provider error messages in user-facing lifecycle events", async () => {
    const onAgentEvent = vi.fn();
    const rawError =
      '{"type":"error","error":{"type":"server_error","message":"SECRET_CANARY_69737"}}';
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: rawError,
        content: [{ type: "text", text: rawError }],
      },
      { onAgentEvent },
    );

    await handleAgentEnd(ctx);

    const meta = firstWarnMeta(ctx);
    expect(meta.error).toBe("LLM request failed.");
    const userFacingLifecycleText = JSON.stringify(onAgentEvent.mock.calls);
    expect(userFacingLifecycleText).not.toContain("SECRET_CANARY_69737");
    expect(userFacingLifecycleText).not.toContain("LLM error server_error");
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "LLM request failed.",
      },
    });
  });

  it("logs the resolved error message when run ends with assistant error", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "connection refused",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";

    const warnMeta = await handleAgentEndAndReadWarnMeta(ctx);
    expect(warnMeta.event).toBe("embedded_run_agent_end");
    expect(warnMeta.runId).toBe("run-1");
    expect(warnMeta.error).toBe("LLM request failed: connection refused by the provider endpoint.");
    expect(warnMeta.providerRuntimeFailureKind).toBe("timeout");
    expect(warnMeta.rawErrorPreview).toBe("connection refused");
    expect(warnMeta.consoleMessage).toBe(
      "embedded run agent end: runId=run-1 isError=true model=unknown provider=unknown error=LLM request failed: connection refused by the provider endpoint. rawError=connection refused",
    );
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "LLM request failed: connection refused by the provider endpoint.",
        livenessState: "blocked",
      },
    });
  });

  it("emits aborted terminal stop reasons on lifecycle end events", async () => {
    emitAgentEventMock.mockClear();
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.terminalStopReason = "aborted";

    await handleAgentEnd(ctx);

    expect(emitAgentEventMock).toHaveBeenCalledWith({
      runId: "run-1",
      stream: "lifecycle",
      data: expect.objectContaining({
        phase: "end",
        stopReason: "aborted",
      }),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        stopReason: "aborted",
      },
    });
  });

  it("attaches raw provider error metadata and includes model/provider in console output", async () => {
    const ctx = createContext({
      role: "assistant",
      stopReason: "error",
      provider: "anthropic",
      model: "claude-test",
      errorMessage: '{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
      content: [{ type: "text", text: "" }],
    });

    const warnMeta = await handleAgentEndAndReadWarnMeta(ctx);
    expect(warnMeta.event).toBe("embedded_run_agent_end");
    expect(warnMeta.runId).toBe("run-1");
    expect(warnMeta.error).toBe(
      "The AI service is temporarily overloaded. Please try again in a moment.",
    );
    expect(warnMeta.failoverReason).toBe("overloaded");
    expect(warnMeta.providerRuntimeFailureKind).toBe("timeout");
    expect(warnMeta.providerErrorType).toBe("overloaded_error");
    expect(warnMeta.consoleMessage).toBe(
      'embedded run agent end: runId=run-1 isError=true model=claude-test provider=anthropic error=The AI service is temporarily overloaded. Please try again in a moment. rawError={"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    );
  });

  it("sanitizes model and provider before writing consoleMessage", async () => {
    const ctx = createContext({
      role: "assistant",
      stopReason: "error",
      provider: "anthropic\u001b]8;;https://evil.test\u0007",
      model: "claude\tsonnet\n4",
      errorMessage: "connection refused",
      content: [{ type: "text", text: "" }],
    });

    await handleAgentEnd(ctx);

    const meta = firstWarnMeta(ctx);
    expect(meta.consoleMessage).toBe(
      "embedded run agent end: runId=run-1 isError=true model=claude sonnet 4 provider=anthropic]8;;https://evil.test error=LLM request failed: connection refused by the provider endpoint. rawError=connection refused",
    );
    expect(meta?.consoleMessage).not.toContain("\n");
    expect(meta?.consoleMessage).not.toContain("\r");
    expect(meta?.consoleMessage).not.toContain("\t");
    expect(meta?.consoleMessage).not.toContain("\u001b");
  });

  it("redacts logged error text before emitting lifecycle events", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "x-api-key: sk-abcdefghijklmnopqrstuvwxyz123456",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent },
    );

    await handleAgentEnd(ctx);

    const meta = firstWarnMeta(ctx);
    expect(meta.event).toBe("embedded_run_agent_end");
    expect(meta.error).toBe("LLM request failed.");
    expect(meta.rawErrorPreview).toBe("x-api-key: ***");
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "LLM request failed.",
      },
    });
  });

  it("logs runtime failure kind for missing-scope auth errors", async () => {
    const ctx = createContext({
      role: "assistant",
      stopReason: "error",
      provider: "openai",
      model: "gpt-5.4",
      errorMessage:
        '401 {"type":"error","error":{"type":"permission_error","message":"Missing scopes: api.responses.write"}}',
      content: [{ type: "text", text: "" }],
    });

    await handleAgentEnd(ctx);

    const meta = firstWarnMeta(ctx);
    expect(meta.failoverReason).toBe("auth");
    expect(meta.providerRuntimeFailureKind).toBe("auth_scope");
    expect(meta.httpCode).toBe("401");
  });

  it.each([
    {
      errorMessage: "403 <!DOCTYPE html><html><body>Access denied</body></html>",
      expectedError:
        "Authentication failed at the provider. Re-authenticate and verify your provider credentials and account access.",
      expectedKind: "auth_html",
      expectedPreview: "403 <!DOCTYPE html><html><body>Access denied</body></html>",
    },
    {
      errorMessage: "401 <!DOCTYPE html><html><body>Unauthorized</body></html>",
      expectedError:
        "Authentication failed at the provider. Re-authenticate and verify your provider credentials and account access.",
      expectedKind: "auth_html",
      expectedPreview: "401 <!DOCTYPE html><html><body>Unauthorized</body></html>",
    },
  ])(
    "omits raw HTML auth bodies from consoleMessage for $expectedKind failures",
    async ({ errorMessage, expectedError, expectedKind, expectedPreview }) => {
      const ctx = createContext({
        role: "assistant",
        stopReason: "error",
        provider: "openai",
        model: "gpt-5.4",
        errorMessage,
        content: [{ type: "text", text: "" }],
      });

      await handleAgentEnd(ctx);

      const meta = firstWarnMeta(ctx);
      expect(meta.providerRuntimeFailureKind).toBe(expectedKind);
      expect(meta.rawErrorPreview).toBe(expectedPreview);
      expect(meta.error).toBe(expectedError);
      const consoleMsg = typeof meta.consoleMessage === "string" ? meta.consoleMessage : "";
      expect(consoleMsg).not.toContain("rawError=");
      expect(consoleMsg).not.toContain("<html>");
    },
  );

  it("keeps non-error run-end logging on debug only", async () => {
    const ctx = createContext(undefined);

    await handleAgentEnd(ctx);

    expect(ctx.log.warn).not.toHaveBeenCalled();
    expect(ctx.log.debug).toHaveBeenCalledWith("embedded run agent end: runId=run-1 isError=false");
  });

  it("surfaces replay-invalid paused lifecycle end state when present", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.replayState = { ...ctx.state.replayState, replayInvalid: true };
    ctx.state.livenessState = "paused";

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "paused",
        replayInvalid: true,
      },
    });
  });

  it("derives abandoned lifecycle end state when replay-invalid work finished without a reply", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.replayState = { ...ctx.state.replayState, replayInvalid: true };
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = [];
    ctx.state.messagingToolSentTexts = [];
    ctx.state.messagingToolSentMediaUrls = [];
    ctx.state.successfulCronAdds = 0;

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "abandoned",
        replayInvalid: true,
      },
    });
  });

  it("marks incomplete tool-use lifecycle end state before runner finalization", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = [];

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "abandoned",
        replayInvalid: true,
      },
    });
  });

  it("marks tool-use terminal with pre-tool text as abandoned (#76477)", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "toolUse",
        content: [
          { type: "text", text: "Initial analysis..." },
          { type: "tool_use", id: "tool_1", name: "read", input: { path: "src/index.ts" } },
        ],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = ["Initial analysis..."];

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "abandoned",
        replayInvalid: true,
      },
    });
  });

  it("keeps accumulated deterministic side effects from being marked abandoned", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.replayState = { ...ctx.state.replayState, replayInvalid: true };
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = [];
    ctx.state.hadDeterministicSideEffect = true;

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "working",
        replayInvalid: true,
      },
    });
  });

  it("keeps accepted session spawns from being marked abandoned", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.replayState = { ...ctx.state.replayState, replayInvalid: true };
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = [];
    ctx.state.acceptedSessionSpawns = [
      {
        runId: "run-child",
        childSessionKey: "agent:claude:subagent:child",
      },
    ];

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        livenessState: "working",
        replayInvalid: true,
      },
    });
  });

  it("flushes orphaned tool media as a media-only block reply", async () => {
    const ctx = createContext(undefined);
    ctx.state.pendingToolMediaUrls = ["/tmp/reply.opus"];
    ctx.state.pendingToolAudioAsVoice = true;

    await handleAgentEnd(ctx);

    expect(ctx.emitBlockReply).toHaveBeenCalledWith({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(ctx.state.pendingToolMediaUrls).toStrictEqual([]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(false);
  });

  it("preserves orphaned tool media when no block reply callback is configured", async () => {
    const ctx = createContext(undefined, { onBlockReply: undefined });
    ctx.state.pendingToolMediaUrls = ["/tmp/reply.opus"];
    ctx.state.pendingToolAudioAsVoice = true;

    await handleAgentEnd(ctx);

    expect(ctx.emitBlockReply).not.toHaveBeenCalled();
    expect(ctx.state.pendingToolMediaUrls).toEqual(["/tmp/reply.opus"]);
    expect(ctx.state.pendingToolAudioAsVoice).toBe(true);
  });

  it("emits orphaned tool media before the lifecycle end event", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.pendingToolMediaUrls = ["/tmp/reply.opus"];
    ctx.state.pendingToolAudioAsVoice = true;

    await handleAgentEnd(ctx);

    const blockReplyOrder = vi.mocked(ctx.emitBlockReply).mock.invocationCallOrder[0] as
      | number
      | undefined;
    const lifecycleOrder = onAgentEvent.mock.invocationCallOrder[0] as number | undefined;

    expect(ctx.emitBlockReply).toHaveBeenCalledTimes(1);
    expect(ctx.emitBlockReply).toHaveBeenCalledWith({
      mediaUrls: ["/tmp/reply.opus"],
      audioAsVoice: true,
    });
    expect(blockReplyOrder).toBeTypeOf("number");
    if (typeof blockReplyOrder !== "number") {
      throw new Error("Expected orphaned media block reply call order.");
    }
    expect(lifecycleOrder).toBeGreaterThan(blockReplyOrder);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("resolves compaction wait before awaiting an async block reply flush", async () => {
    let resolveFlush: (() => void) | undefined;
    const ctx = createContext(undefined);
    ctx.flushBlockReplyBuffer = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFlush = resolve;
          }),
      )
      .mockImplementation(() => {});

    const endPromise = handleAgentEnd(ctx);

    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(ctx.resolveCompactionRetry).not.toHaveBeenCalled();

    resolveFlush?.();
    await endPromise;
  });

  it("resolves compaction wait before awaiting an async channel flush", async () => {
    let resolveChannelFlush: (() => void) | undefined;
    const onBlockReplyFlush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChannelFlush = resolve;
        }),
    );
    const ctx = createContext(undefined, { onBlockReplyFlush });

    const endPromise = handleAgentEnd(ctx);

    expect(ctx.maybeResolveCompactionWait).toHaveBeenCalledTimes(1);
    expect(onBlockReplyFlush).toHaveBeenCalledTimes(1);

    resolveChannelFlush?.();
    await endPromise;
  });

  it("runs the before-lifecycle callback before the lifecycle end event", async () => {
    const order: string[] = [];
    const onAgentEvent = vi.fn(() => {
      order.push("event");
    });
    const onBeforeLifecycleTerminal = vi.fn(() => {
      order.push("before");
    });
    const ctx = createContext(undefined, {
      onAgentEvent,
      onBeforeLifecycleTerminal,
    });

    await handleAgentEnd(ctx);

    expect(order).toEqual(["before", "event"]);
    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("runs an async before-lifecycle callback before the lifecycle end event", async () => {
    const order: string[] = [];
    const onAgentEvent = vi.fn(() => {
      order.push("event");
    });
    const onBeforeLifecycleTerminal = vi.fn(() =>
      Promise.resolve().then(() => {
        order.push("before");
      }),
    );
    const ctx = createContext(undefined, {
      onAgentEvent,
      onBeforeLifecycleTerminal,
    });

    await handleAgentEnd(ctx);

    expect(order).toEqual(["before", "event"]);
    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("still emits lifecycle terminal when sync before-lifecycle callback throws", async () => {
    const onAgentEvent = vi.fn();
    const onBeforeLifecycleTerminal = vi.fn(() => {
      throw new Error("hook exploded");
    });
    const ctx = createContext(undefined, {
      onAgentEvent,
      onBeforeLifecycleTerminal,
    });

    await handleAgentEnd(ctx);

    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("still emits lifecycle terminal when async before-lifecycle callback rejects", async () => {
    const onAgentEvent = vi.fn();
    const onBeforeLifecycleTerminal = vi.fn(() => Promise.reject(new Error("hook failed")));
    const ctx = createContext(undefined, {
      onAgentEvent,
      onBeforeLifecycleTerminal,
    });

    await handleAgentEnd(ctx);

    expect(onBeforeLifecycleTerminal).toHaveBeenCalledTimes(1);
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("emits lifecycle end after async channel flush completes", async () => {
    let resolveChannelFlush: (() => void) | undefined;
    const onAgentEvent = vi.fn();
    const onBlockReplyFlush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChannelFlush = resolve;
        }),
    );
    const ctx = createContext(undefined, { onAgentEvent, onBlockReplyFlush });

    const endPromise = handleAgentEnd(ctx);

    expect(onAgentEvent).not.toHaveBeenCalled();

    resolveChannelFlush?.();
    await endPromise;

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("emits lifecycle error after async channel flush completes", async () => {
    let resolveChannelFlush: (() => void) | undefined;
    const onAgentEvent = vi.fn();
    const onBlockReplyFlush = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveChannelFlush = resolve;
        }),
    );
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "error",
        errorMessage: "connection refused",
        content: [{ type: "text", text: "" }],
      },
      { onAgentEvent, onBlockReplyFlush },
    );

    const endPromise = handleAgentEnd(ctx);

    expect(onAgentEvent).not.toHaveBeenCalled();

    resolveChannelFlush?.();
    await endPromise;

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "LLM request failed: connection refused by the provider endpoint.",
      },
    });
  });

  it("emits lifecycle end when block reply flush rejects", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.flushBlockReplyBuffer = vi.fn().mockRejectedValue(new Error("flush failed"));

    await expect(handleAgentEnd(ctx)).rejects.toThrow("flush failed");

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("emits lifecycle end when channel flush rejects", async () => {
    const onAgentEvent = vi.fn();
    const onBlockReplyFlush = vi.fn().mockRejectedValue(new Error("channel flush failed"));
    const ctx = createContext(undefined, { onAgentEvent, onBlockReplyFlush });

    await expect(handleAgentEnd(ctx)).rejects.toThrow("channel flush failed");

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });

  it("final-flushes block replies before clearing pending fence fragments", async () => {
    const ctx = createContext(undefined);
    ctx.state.blockState.pendingFenceFragment = "```";
    ctx.flushBlockReplyBuffer = vi.fn((options?: { final?: boolean }) => {
      if (vi.mocked(ctx.flushBlockReplyBuffer).mock.calls.length === 1) {
        expect(options).toEqual({ final: true });
        expect(ctx.state.blockState.pendingFenceFragment).toBe("```");
      }
    });

    await handleAgentEnd(ctx);

    expect(ctx.flushBlockReplyBuffer).toHaveBeenNthCalledWith(1, { final: true });
    expect(ctx.state.blockState.pendingFenceFragment).toBeUndefined();
  });

  it("emits lifecycle end when block reply flush throws", () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.flushBlockReplyBuffer = vi.fn(() => {
      throw new Error("flush exploded");
    });

    expect(() => handleAgentEnd(ctx)).toThrow("flush exploded");

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: { phase: "end" },
    });
  });
});
