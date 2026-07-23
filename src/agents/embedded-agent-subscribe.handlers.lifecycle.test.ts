// Lifecycle handler tests cover terminal agent_end behavior, sanitized errors,
// lifecycle events, and deferred reply cleanup.
import { describe, expect, it, vi } from "vitest";
import { createInlineCodeState } from "../../packages/markdown-core/src/code-spans.js";
import { createHookRunner } from "../plugins/hooks.js";
import { createMockPluginRegistry, TEST_PLUGIN_AGENT_CTX } from "../plugins/hooks.test-fixtures.js";
import { handleAgentEnd, handleAgentStart } from "./embedded-agent-subscribe.handlers.lifecycle.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";

const { emitAgentEventMock } = vi.hoisted(() => ({
  emitAgentEventMock: vi.fn(),
}));
const DEFAULT_BEFORE_AGENT_FINALIZE_TIMEOUT_MS = 15_000;
const BEFORE_AGENT_FINALIZE_EVENT = {
  runId: "run-1",
  sessionId: "session-1",
  sessionKey: "agent:main:session-1",
  turnId: "turn-1",
  provider: "openai",
  model: "freeze-e2e",
  cwd: "/repo",
  transcriptPath: "/tmp/session.jsonl",
  stopHookActive: false,
  lastAssistantMessage: "done",
};

vi.mock("../infra/agent-events.js", () => ({
  emitAgentEvent: emitAgentEventMock,
  getAgentEventLifecycleGeneration: () => "test-generation",
  isAgentEventLifecycleGenerationCurrent: (generation: string) => generation === "test-generation",
  registerAgentEventLifecycleRotationHandler: vi.fn(),
}));

function createContext(
  lastAssistant: unknown,
  overrides?: {
    onAgentEvent?: (event: unknown) => void | Promise<void>;
    onBeforeLifecycleTerminal?: () => void | Promise<void>;
    onBeforeTerminalDelivery?: () => void | Promise<void>;
    onBlockReply?: ((payload: unknown) => void) | undefined;
    onBlockReplyFlush?: () => void | Promise<void>;
    resolveTerminalStopReason?: () => string | undefined;
  },
): EmbeddedAgentSubscribeContext {
  // Lifecycle tests only need terminal state and delivery callbacks; omitted
  // fields stay as no-op mocks so failure assertions stay focused.
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
      onBeforeTerminalDelivery: overrides?.onBeforeTerminalDelivery,
      resolveTerminalStopReason: overrides?.resolveTerminalStopReason,
      ...(onBlockReply ? { onBlockReply } : {}),
      onBlockReplyFlush: overrides?.onBlockReplyFlush,
    },
    state: {
      lastAssistant: lastAssistant as EmbeddedAgentSubscribeContext["state"]["lastAssistant"],
      pendingCompactionRetry: 0,
      pendingToolMediaUrls: [],
      pendingToolAudioAsVoice: false,
      pendingToolTrustedLocalMedia: false,
      deferredBlockReplies: [],
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
    emitAssistantStreamData: vi.fn(),
    flushDeferredAssistantPartialReplies: vi.fn(),
    flushDeferredBlockReplies: vi.fn(),
    clearDeferredAssistantPartialReplies: vi.fn(),
    clearDeferredBlockReplies: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
  } as unknown as EmbeddedAgentSubscribeContext;
}

async function handleAgentEndAndReadWarnMeta(ctx: EmbeddedAgentSubscribeContext) {
  // Error lifecycle assertions share the same structured warning envelope.
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
  it("contains rejected lifecycle start event callbacks", async () => {
    const onAgentEvent = vi.fn().mockRejectedValue(new Error("progress failed"));
    const ctx = createContext(undefined, { onAgentEvent });

    handleAgentStart(ctx);
    await Promise.resolve();

    expect(ctx.log.warn).toHaveBeenCalledWith(
      expect.stringContaining("lifecycle agent event callback failed"),
    );
  });

  it("keeps explicit session and agent identity on lifecycle start events", () => {
    emitAgentEventMock.mockClear();
    const ctx = createContext(undefined);
    ctx.params.sessionId = "session-1";
    ctx.params.agentId = "main";

    handleAgentStart(ctx);

    expect(emitAgentEventMock).toHaveBeenCalledWith({
      runId: "run-1",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      agentId: "main",
      stream: "lifecycle",
      data: expect.objectContaining({ phase: "start" }),
    });
  });

  it("keeps the execution lifecycle generation on terminal events", async () => {
    emitAgentEventMock.mockClear();
    const ctx = createContext(undefined);
    ctx.params.lifecycleGeneration = "pre-restart-generation";
    ctx.params.sessionId = "session-1";
    ctx.params.agentId = "main";

    await handleAgentEnd(ctx);

    expect(emitAgentEventMock).toHaveBeenCalledWith({
      runId: "run-1",
      sessionKey: "agent:main:main",
      sessionId: "session-1",
      agentId: "main",
      lifecycleGeneration: "pre-restart-generation",
      stream: "lifecycle",
      data: expect.objectContaining({ phase: "end" }),
    });
  });

  it("suppresses raw assistant error messages in user-facing lifecycle events", async () => {
    // Canary text proves provider error strings are sanitized before lifecycle
    // events reach channel integrations.
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
      sessionKey: "agent:main:main",
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

  it("overrides embedded abort terminals with the restart stop reason", async () => {
    emitAgentEventMock.mockClear();
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, {
      onAgentEvent,
      resolveTerminalStopReason: () => "restart",
    });
    ctx.state.terminalStopReason = "aborted";
    ctx.state.terminalAborted = true;

    await handleAgentEnd(ctx);

    expect(emitAgentEventMock).toHaveBeenCalledWith({
      runId: "run-1",
      sessionKey: "agent:main:main",
      stream: "lifecycle",
      data: expect.objectContaining({
        phase: "end",
        stopReason: "restart",
        aborted: true,
      }),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        stopReason: "restart",
        aborted: true,
      },
    });
  });

  it("emits explicit aborted terminal metadata on lifecycle end events", async () => {
    emitAgentEventMock.mockClear();
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.terminalStopReason = "end_turn";
    ctx.state.terminalAborted = true;

    await handleAgentEnd(ctx);

    expect(emitAgentEventMock).toHaveBeenCalledWith({
      runId: "run-1",
      sessionKey: "agent:main:main",
      stream: "lifecycle",
      data: expect.objectContaining({
        phase: "end",
        stopReason: "end_turn",
        aborted: true,
      }),
    });
    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        stopReason: "end_turn",
        aborted: true,
      },
    });
  });

  it("carries a sanitized tool-error summary on aborted terminals", async () => {
    emitAgentEventMock.mockClear();
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.terminalAborted = true;
    ctx.state.lastToolError = {
      toolName: "edit",
      validationErrorSummary: "edit tool validation failed: invalid arguments",
      error:
        'Validation failed for tool "edit":\n  - edits: must have required properties edits\n\nReceived arguments:\n{\n  "path": "secret.txt"\n}',
    };

    await handleAgentEnd(ctx);

    expect(emitAgentEventMock).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: "run-1",
        stream: "lifecycle",
        data: expect.objectContaining({
          phase: "end",
          aborted: true,
          toolErrorSummary: "edit tool validation failed: invalid arguments",
        }),
      }),
    );
    // The echoed model arguments must never ride the lifecycle event.
    expect(JSON.stringify(onAgentEvent.mock.calls)).not.toContain("Received arguments");
  });

  it("does not expose arbitrary tool errors on aborted terminals", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.terminalAborted = true;
    ctx.state.lastToolError = {
      toolName: "browser",
      error: "tab not found: secret-token",
    };

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: expect.not.objectContaining({ toolErrorSummary: expect.anything() }),
    });
  });

  it("keeps normal lifecycle end events explicitly non-aborted", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(undefined, { onAgentEvent });
    ctx.state.terminalStopReason = "end_turn";
    ctx.state.terminalAborted = false;

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        stopReason: "end_turn",
        aborted: false,
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
        stopReason: "toolUse",
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
        stopReason: "toolUse",
        livenessState: "abandoned",
        replayInvalid: true,
      },
    });
  });

  it("keeps tool-use terminal incomplete when tool media is pending", async () => {
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
    ctx.state.pendingToolMediaUrls = ["/tmp/render.png"];

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        stopReason: "toolUse",
        livenessState: "abandoned",
        replayInvalid: true,
      },
    });
  });

  it("marks token-limited terminal text as abandoned before runner finalization", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "length",
        content: [{ type: "text", text: "Partial answer" }],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = ["Partial answer"];

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        stopReason: "length",
        livenessState: "abandoned",
        replayInvalid: true,
      },
    });
  });

  it("preserves token-limited terminal tool media before runner finalization", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "length",
        content: [{ type: "text", text: "Partial answer" }],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";
    ctx.state.assistantTexts = ["Partial answer"];
    ctx.state.pendingToolMediaUrls = ["/tmp/render.png"];

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        stopReason: "length",
        livenessState: "working",
      },
    });
  });

  it("preserves token-limited deferred media before terminal delivery", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "length",
        content: [],
      },
      { onAgentEvent },
    );
    ctx.state.livenessState = "working";
    ctx.state.deferredBlockReplies = [{ mediaUrls: ["/tmp/render.png"] }];

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        stopReason: "length",
        livenessState: "working",
      },
    });
  });

  it("preserves token-limited message-tool-only delivery before runner finalization", async () => {
    const onAgentEvent = vi.fn();
    const ctx = createContext(
      {
        role: "assistant",
        stopReason: "length",
        content: [],
      },
      { onAgentEvent },
    );
    ctx.params.sourceReplyDeliveryMode = "message_tool_only";
    ctx.state.livenessState = "working";
    ctx.state.messageToolOnlySourceReplyDelivered = true;

    await handleAgentEnd(ctx);

    expect(onAgentEvent).toHaveBeenCalledWith({
      stream: "lifecycle",
      data: {
        phase: "end",
        stopReason: "length",
        livenessState: "working",
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

  it("resolves compaction retry after a timed-out terminal hook finalizes the original answer", async () => {
    vi.useFakeTimers();
    try {
      const logger = { error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
      const runner = createHookRunner(
        createMockPluginRegistry([
          {
            hookName: "before_agent_finalize",
            handler: vi.fn(() => new Promise(() => {})),
          },
        ]),
        { logger },
      );
      const onBeforeTerminalDelivery = vi.fn(async () => {
        await runner.runBeforeAgentFinalize(BEFORE_AGENT_FINALIZE_EVENT, TEST_PLUGIN_AGENT_CTX);
        return undefined;
      });
      const ctx = createContext(
        {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "stop",
        },
        { onBeforeTerminalDelivery },
      );
      ctx.state.assistantTexts = ["done"];
      ctx.state.pendingCompactionRetry = 1;

      const endPromise = handleAgentEnd(ctx);
      await Promise.resolve();

      expect(onBeforeTerminalDelivery).toHaveBeenCalledTimes(1);
      expect(ctx.resolveCompactionRetry).not.toHaveBeenCalled();
      expect(ctx.flushBlockReplyBuffer).not.toHaveBeenCalledWith({ final: true });

      await vi.advanceTimersByTimeAsync(DEFAULT_BEFORE_AGENT_FINALIZE_TIMEOUT_MS);
      await endPromise;

      expect(logger.error).toHaveBeenCalledWith(
        "[hooks] before_agent_finalize handler from test-plugin failed: timed out after 15000ms",
      );
      expect(ctx.clearDeferredAssistantPartialReplies).not.toHaveBeenCalled();
      expect(ctx.clearDeferredBlockReplies).not.toHaveBeenCalled();
      expect(ctx.flushDeferredAssistantPartialReplies).toHaveBeenCalledTimes(1);
      expect(ctx.flushDeferredBlockReplies).toHaveBeenCalledTimes(1);
      expect(ctx.flushBlockReplyBuffer).toHaveBeenCalledWith({ final: true });
      expect(ctx.resolveCompactionRetry).toHaveBeenCalledTimes(1);
      expect(ctx.maybeResolveCompactionWait).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
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
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
