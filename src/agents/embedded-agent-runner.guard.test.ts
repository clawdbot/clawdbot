// Covers session-manager guard behavior for tool-result pairing and transcript
// redaction.
import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import type { AgentMessage } from "openclaw/plugin-sdk/agent-core";
import { SessionManager } from "openclaw/plugin-sdk/agent-sessions";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFileBackedSessionManagerForTest } from "../../test/helpers/session-manager-file-fixture.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { attachRuntimeUserTurnTranscriptContext } from "../sessions/user-turn-transcript-runtime-context.js";
import {
  createUserTurnTranscriptRecorder,
  type PersistedUserTurnMessage,
} from "../sessions/user-turn-transcript.js";
import { createTestUserTurnTranscriptTarget } from "../sessions/user-turn-transcript.test-support.js";
import { flushPendingToolResultsAfterIdle } from "./embedded-agent-runner/wait-for-idle-before-flush.js";
import { guardSessionManager } from "./session-tool-result-guard-wrapper.js";
import { sanitizeToolUseResultPairing } from "./session-transcript-repair.js";
import { makeAgentAssistantMessage } from "./test-helpers/agent-message-fixtures.js";

function assistantToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "n", arguments: {} }],
  } as AgentMessage;
}

function getMessages(sm: ReturnType<typeof guardSessionManager>): AgentMessage[] {
  return sm
    .getEntries()
    .filter((entry) => entry.type === "message")
    .map((entry) => (entry as { message: AgentMessage }).message);
}

describe("guardSessionManager integration", () => {
  const tempDirs = useAutoCleanupTempDirTracker(afterEach);

  afterEach(() => {
    resetGlobalHookRunner();
    vi.useRealTimers();
  });

  it("persists synthetic toolResult before subsequent assistant message", () => {
    // Providers require every assistant tool call to be followed by a result
    // before the next assistant turn.
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(assistantToolCall("call_1"));
    appendMessage({
      role: "assistant",
      content: [{ type: "text", text: "followup" }],
    } as AgentMessage);

    const messages = getMessages(sm);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "assistant"]);
    expect((messages[1] as { toolCallId?: string }).toolCallId).toBe("call_1");
    expect(sanitizeToolUseResultPairing(messages).map((m) => m.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
    ]);
  });

  it("keeps real toolResult pending across delivery-mirror assistant messages", () => {
    // Delivery mirrors are display copies, not real model turns; they must not
    // cause the guard to synthesize missing tool results.
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(assistantToolCall("call_1"));
    appendMessage({
      role: "assistant",
      provider: "openclaw",
      model: "delivery-mirror",
      content: [{ type: "text", text: "display copy" }],
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "n",
      content: [{ type: "text", text: "real output" }],
      isError: false,
    } as AgentMessage);

    const messages = getMessages(sm);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "assistant", "toolResult"]);
    expect((messages[1] as { model?: string }).model).toBe("delivery-mirror");
    expect((messages[2] as { isError?: boolean }).isError).toBe(false);
    expect((messages[2] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      "real output",
    );
    expect(JSON.stringify(messages)).not.toContain("missing tool result");
  });

  it("uses Codex-style aborted synthetic results for interrupted Responses tool calls", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      allowSyntheticToolResults: true,
      missingToolResultText: "aborted",
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(assistantToolCall("call_responses_1"));
    appendMessage({
      role: "user",
      content: [{ type: "text", text: "interrupting prompt" }],
      timestamp: Date.now(),
    } as AgentMessage);

    const messages = getMessages(sm);

    expect(messages.map((m) => m.role)).toEqual(["assistant", "toolResult", "user"]);
    expect((messages[1] as { toolCallId?: string }).toolCallId).toBe("call_responses_1");
    expect((messages[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      "aborted",
    );
  });

  it("applies prepared user persistence fields to the next real user message", () => {
    const sm = guardSessionManager(SessionManager.inMemory(), {
      preparedUserTurnMessage: {
        role: "user",
        content: "What is in this image?",
        timestamp: 123,
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      } as Extract<AgentMessage, { role: "user" }>,
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage({
      role: "user",
      content: [
        { type: "text", text: "[media attached: media://inbound/a.png]\nWhat is in this image?" },
      ],
    } as AgentMessage);
    appendMessage({ role: "user", content: "follow-up" } as AgentMessage);

    const messages = getMessages(sm);

    expect(messages[0]).toMatchObject({
      role: "user",
      content: "What is in this image?",
      MediaPath: "/tmp/a.png",
      MediaPaths: ["/tmp/a.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
    expect(messages[1]).toEqual({ role: "user", content: "follow-up" });
  });

  it("correlates nested user persists with their exact runtime messages", () => {
    const outerRuntime = { role: "user", content: "outer" } as AgentMessage;
    const nestedRuntime = { role: "user", content: "nested" } as AgentMessage;
    const correlations: Array<{ persisted: AgentMessage; runtime?: AgentMessage }> = [];
    let nested = false;
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (...args: unknown[]) => {
            const { message } = args[0] as { message: AgentMessage };
            if (!nested && message.role === "user" && message.content === "outer") {
              nested = true;
              appendMessage(nestedRuntime);
            }
            return undefined;
          },
        },
      ]),
    );
    const sm = guardSessionManager(SessionManager.inMemory(), {
      onUserMessagePersisted: (persisted, runtime) => {
        correlations.push({ persisted, runtime });
      },
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage(outerRuntime);

    expect(correlations).toEqual([
      { persisted: nestedRuntime, runtime: nestedRuntime },
      { persisted: outerRuntime, runtime: outerRuntime },
    ]);
  });

  it("correlates a suppressed user persist with its exact runtime message", () => {
    const runtimeMessage = { role: "user", content: "already durable" } as AgentMessage;
    const suppressed: Array<{ persisted: AgentMessage; runtime?: AgentMessage }> = [];
    const sm = guardSessionManager(SessionManager.inMemory(), {
      preparedUserTurnMessage: {
        role: "user",
        content: "already durable",
        timestamp: 1,
        __openclaw: { senderName: "Alice" },
      } as PersistedUserTurnMessage,
      suppressNextUserMessagePersistence: true,
      onUserMessagePersistenceSuppressed: (persisted, runtime) => {
        suppressed.push({ persisted, runtime });
      },
    });

    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    appendMessage(runtimeMessage);

    expect(sm.getEntries()).toEqual([]);
    expect(suppressed).toEqual([
      {
        persisted: expect.objectContaining({
          content: "already durable",
          __openclaw: { senderName: "Alice" },
        }),
        runtime: runtimeMessage,
      },
    ]);
  });

  it("lets a write hook remove sender identity while preserving auth state", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () => ({
            message: {
              role: "user",
              content: "[redacted by hook]",
              timestamp: 124,
              __openclaw: { hookOwned: true },
            } as AgentMessage,
          }),
        },
      ]),
    );
    const sm = guardSessionManager(SessionManager.inMemory(), {
      preparedUserTurnMessage: {
        role: "user",
        content: "private group prompt",
        timestamp: 123,
        __openclaw: {
          senderIsOwner: true,
          senderId: "secret-user",
          senderName: "secret-name",
        },
      } as Extract<AgentMessage, { role: "user" }>,
    });

    sm.appendMessage({ role: "user", content: "runtime prompt", timestamp: 125 });

    const message = sm.getEntries().find((entry) => entry.type === "message") as
      | { message?: AgentMessage }
      | undefined;
    expect(message?.message).toMatchObject({
      role: "user",
      content: "[redacted by hook]",
      __openclaw: {
        hookOwned: true,
        senderIsOwner: true,
      },
    });
    expect(JSON.stringify(message?.message)).not.toContain("secret-user");
    expect(JSON.stringify(message?.message)).not.toContain("secret-name");
  });

  it("commits queued group sender metadata to JSONL and completes its recorder", () => {
    const dir = tempDirs.make("openclaw-queued-group-turn-");
    const sessionManager = createFileBackedSessionManagerForTest(dir, dir);
    const sessionFile = sessionManager.getSessionFile();
    if (!sessionFile) {
      throw new Error("expected file-backed session manager");
    }
    const recorder = createUserTurnTranscriptRecorder({
      input: {
        text: "visible group prompt",
        sender: { id: "user-42", name: "Ada", username: "ada42" },
      },
      target: createTestUserTurnTranscriptTarget(),
    });
    const preparedMessage = recorder.message;
    if (!preparedMessage) {
      throw new Error("expected prepared group turn");
    }
    const sm = guardSessionManager(sessionManager, {
      inputProvenance: { kind: "inter_session", sourceTool: "sessions_send" },
    });
    const runtimeMessage = attachRuntimeUserTurnTranscriptContext(
      {
        role: "user",
        content: [{ type: "text", text: "runtime group prompt" }],
        timestamp: 456,
      },
      { message: preparedMessage, recorder },
    );

    sm.appendMessage(runtimeMessage);
    sm.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "acknowledged" }],
      }),
    );

    const entries = readFileSync(sessionFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { type: string; message?: AgentMessage });
    expect(entries.find((entry) => entry.message?.role === "user")?.message).toMatchObject({
      role: "user",
      content: "visible group prompt",
      __openclaw: {
        senderId: "user-42",
        senderName: "Ada",
        senderUsername: "ada42",
      },
      provenance: { kind: "inter_session", sourceTool: "sessions_send" },
    });
    expect(recorder.hasPersisted()).toBe(true);
  });

  it("marks the exact queued recorder blocked when a write hook suppresses its user message", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () => ({ block: true }),
        },
      ]),
    );
    const recorder = createUserTurnTranscriptRecorder({
      input: { text: "queued prompt" },
      target: createTestUserTurnTranscriptTarget(),
    });
    const preparedMessage = expectDefined(recorder.message, "expected prepared queued turn");
    const runtimeMessage = attachRuntimeUserTurnTranscriptContext(
      {
        role: "user",
        content: "runtime queued prompt",
        timestamp: 456,
      },
      { message: preparedMessage, recorder },
    );
    const sm = guardSessionManager(SessionManager.inMemory());

    sm.appendMessage(runtimeMessage);

    expect(getMessages(sm)).toEqual([]);
    expect(recorder.isBlocked()).toBe(true);
  });

  it("does not consume prepared user persistence for before-agent-run blocked messages", () => {
    // Blocked messages are audit records, not the actual user turn that should
    // receive prepared media metadata.
    const sm = guardSessionManager(SessionManager.inMemory(), {
      preparedUserTurnMessage: {
        role: "user",
        content: "visible prompt",
        timestamp: 123,
        MediaPath: "/tmp/a.png",
        MediaPaths: ["/tmp/a.png"],
        MediaType: "image/png",
        MediaTypes: ["image/png"],
      } as Extract<AgentMessage, { role: "user" }>,
    });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage({
      role: "user",
      content: [{ type: "text", text: "blocked" }],
      timestamp: 124,
      __openclaw: { beforeAgentRunBlocked: { blockedBy: "test", blockedAt: 123 } },
    } as AgentMessage);
    appendMessage({ role: "user", content: "runtime prompt" } as AgentMessage);

    const messages = getMessages(sm);

    expect(messages[0]).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "blocked" }],
      __openclaw: { beforeAgentRunBlocked: { blockedBy: "test", blockedAt: 123 } },
    });
    expect(messages[0]).not.toHaveProperty("MediaPath");
    expect(messages[1]).toMatchObject({
      role: "user",
      content: "visible prompt",
      MediaPath: "/tmp/a.png",
      MediaPaths: ["/tmp/a.png"],
      MediaType: "image/png",
      MediaTypes: ["image/png"],
    });
  });

  it("redacts configured text patterns before persisting transcript messages", () => {
    const cfg = {
      logging: {
        redactPatterns: [String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`],
      },
    } satisfies OpenClawConfig;
    const sm = guardSessionManager(SessionManager.inMemory(), { config: cfg });
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;

    appendMessage({
      role: "assistant",
      content: [
        { type: "thinking", thinking: "the email is peter@dc.io", thinkingSignature: "sig" },
        { type: "text", text: "contact peter@dc.io" },
        { type: "toolCall", id: "call_1", name: "read", arguments: { path: "/tmp/peter@dc.io" } },
      ],
      stopReason: "toolUse",
    } as AgentMessage);
    appendMessage({
      role: "toolResult",
      toolCallId: "call_1",
      toolName: "read",
      content: [{ type: "text", text: "peter@dc.io\n" }],
      isError: false,
    } as AgentMessage);

    const messages = getMessages(sm);

    const serialized = JSON.stringify(messages);

    expect(serialized).not.toContain("the email is peter@dc.io");
    expect(serialized).not.toContain("contact peter@dc.io");
    expect(serialized).not.toContain("peter@dc.io\\n");
    expect(serialized).not.toContain('"/tmp/peter@dc.io"');
    expect(serialized).toContain('"thinking":"the email is peter@d***.io"');
    expect(serialized).toContain('"text":"contact peter@d***.io"');
    expect(serialized).toContain('"text":"peter@d***.io\\n"');
    expect(serialized).toContain('"/tmp/peter@d***.io"');
  });

  it("can skip plugin write hooks without skipping core transcript redaction", () => {
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: () => ({
            message: makeAgentAssistantMessage({
              content: [{ type: "text", text: "changed by hook" }],
            }),
          }),
        },
      ]),
    );
    const sm = guardSessionManager(SessionManager.inMemory(), {
      config: {
        logging: {
          redactPatterns: [String.raw`([\w]|[-.])+@([\w]|[-.])+\.\w+`],
        },
      },
      skipBeforeMessageWriteHooks: true,
    });

    sm.appendMessage(
      makeAgentAssistantMessage({
        content: [{ type: "text", text: "contact peter@dc.io" }],
      }),
    );

    const entry = sm.getEntries().find((candidate) => candidate.type === "message");
    expect(entry).toMatchObject({
      message: {
        role: "assistant",
        content: [{ type: "text", text: "contact peter@d***.io" }],
      },
    });
  });
});

function idleToolCall(id: string): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name: "exec", arguments: {} }],
    stopReason: "toolUse",
  } as AgentMessage;
}

function toolResult(id: string, text: string): AgentMessage {
  return {
    role: "toolResult",
    toolCallId: id,
    content: [{ type: "text", text }],
    isError: false,
  } as AgentMessage;
}

function deferred<T>() {
  // Tests control when waitForIdle resolves so real tool results can race the
  // synthetic flush path deterministically.
  let resolve: ((value: T | PromiseLike<T>) => void) | undefined;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  if (!resolve) {
    throw new Error("Expected wait-for-idle deferred resolver to be initialized");
  }
  return { promise, resolve };
}

describe("flushPendingToolResultsAfterIdle", () => {
  it("waits for idle so real tool results can land before flush", async () => {
    // Waiting gives the tool runner a chance to persist its real output before
    // the guard synthesizes a missing result.
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    const idle = deferred<void>();
    const agent = { waitForIdle: () => idle.promise };

    appendMessage(idleToolCall("call_retry_1"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent,
      sessionManager: sm,
      timeoutMs: 1_000,
    });

    await Promise.resolve();
    expect(getMessages(sm).map((message) => message.role)).toEqual(["assistant"]);

    appendMessage(toolResult("call_retry_1", "command output here"));
    idle.resolve();
    await flushPromise;

    const messages = getMessages(sm);
    expect(messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect((messages[1] as { isError?: boolean }).isError).not.toBe(true);
    expect((messages[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toBe(
      "command output here",
    );
  });

  it("flushes pending tool call after timeout when idle never resolves", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    vi.useFakeTimers();

    appendMessage(idleToolCall("call_orphan_1"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent: { waitForIdle: () => new Promise<void>(() => {}) },
      sessionManager: sm,
      timeoutMs: 30,
    });
    await vi.advanceTimersByTimeAsync(30);
    await flushPromise;

    const messages = getMessages(sm);
    expect(messages.length).toBe(2);
    expect(expectDefined(messages[1], "messages[1] test invariant").role).toBe("toolResult");
    expect((messages[1] as { isError?: boolean }).isError).toBe(true);
    expect((messages[1] as { content?: Array<{ text?: string }> }).content?.[0]?.text).toContain(
      "missing tool result",
    );
  });

  it("flushes pending on cleanup timeout instead of leaving orphaned tool calls", async () => {
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    vi.useFakeTimers();

    appendMessage(idleToolCall("call_orphan_2"));
    const flushPromise = flushPendingToolResultsAfterIdle({
      agent: { waitForIdle: () => new Promise<void>(() => {}) },
      sessionManager: sm,
      timeoutMs: 30,
    });
    await vi.advanceTimersByTimeAsync(30);
    await flushPromise;

    const messages = getMessages(sm);
    expect(messages.map((message) => message.role)).toEqual(["assistant", "toolResult"]);
    expect((messages[1] as { toolCallId?: string }).toolCallId).toBe("call_orphan_2");
    expect((messages[1] as { isError?: boolean }).isError).toBe(true);

    appendMessage({
      role: "user",
      content: "still there?",
      timestamp: Date.now(),
    } as AgentMessage);
    expect(getMessages(sm).map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "user",
    ]);
  });

  it("clears timeout handle when waitForIdle resolves first", async () => {
    vi.useFakeTimers();
    await flushPendingToolResultsAfterIdle({
      agent: { waitForIdle: async () => {} },
      sessionManager: guardSessionManager(SessionManager.inMemory()),
      timeoutMs: 30_000,
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clamps oversized idle wait timeouts before scheduling", async () => {
    // JavaScript timers overflow above the platform max; clamp to keep huge
    // configs from firing immediately.
    const idle = deferred<void>();
    const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
    try {
      const flushPromise = flushPendingToolResultsAfterIdle({
        agent: { waitForIdle: () => idle.promise },
        sessionManager: guardSessionManager(SessionManager.inMemory()),
        timeoutMs: Number.MAX_SAFE_INTEGER,
      });
      idle.resolve();
      await flushPromise;

      expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), MAX_TIMER_TIMEOUT_MS);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it("immediately flushes pending tool results without waiting when timeoutMs is 0 or less", async () => {
    // Non-positive timeouts are an explicit "do not wait" policy.
    const sm = guardSessionManager(SessionManager.inMemory());
    const appendMessage = sm.appendMessage.bind(sm) as unknown as (message: AgentMessage) => void;
    const idle = deferred<void>();
    const waitForIdleSpy = vi.fn(() => idle.promise);
    const agent = { waitForIdle: waitForIdleSpy };

    appendMessage(idleToolCall("call_orphan_immediate"));
    await flushPendingToolResultsAfterIdle({ agent, sessionManager: sm, timeoutMs: 0 });

    expect(waitForIdleSpy).not.toHaveBeenCalled();
    expect(getMessages(sm).map((message) => message.role)).toEqual(["assistant", "toolResult"]);

    appendMessage(idleToolCall("call_orphan_negative"));
    await flushPendingToolResultsAfterIdle({ agent, sessionManager: sm, timeoutMs: -100 });

    expect(waitForIdleSpy).not.toHaveBeenCalled();
    expect(getMessages(sm).map((message) => message.role)).toEqual([
      "assistant",
      "toolResult",
      "assistant",
      "toolResult",
    ]);
  });
});
