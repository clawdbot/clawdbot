import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isEmbeddedMode, setEmbeddedMode } from "../infra/embedded-mode.js";
import { defaultRuntime } from "../runtime.js";

const agentCommandFromIngressMock = vi.fn();
let registeredListener: ((evt: unknown) => void) | undefined;

vi.mock("../agents/agent-command.js", () => ({
  agentCommandFromIngress: (...args: unknown[]) => agentCommandFromIngressMock(...args),
}));

vi.mock("../infra/agent-events.js", () => ({
  onAgentEvent: (listener: (evt: unknown) => void) => {
    registeredListener = listener;
    return () => {
      if (registeredListener === listener) {
        registeredListener = undefined;
      }
    };
  },
}));

vi.mock("../cli/deps.js", () => ({
  createDefaultDeps: () => ({}),
}));

vi.mock("../config/sessions.js", () => ({
  resolveAgentMainSessionKey: () => "agent:main:main",
  resolveStorePath: () => "/tmp/openclaw-sessions.json",
  updateSessionStore: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveSessionAgentId: () => "main",
}));

vi.mock("../agents/defaults.js", () => ({
  DEFAULT_PROVIDER: "openai",
}));

vi.mock("../agents/model-selection.js", () => ({
  buildAllowedModelSet: ({ catalog }: { catalog: unknown[] }) => ({ allowedCatalog: catalog }),
  resolveThinkingDefault: () => undefined,
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: () => ({}),
  loadConfig: () => ({}),
}));

vi.mock("../gateway/cli-session-history.js", () => ({
  augmentChatHistoryWithCliSessionImports: ({ localMessages }: { localMessages?: unknown[] }) =>
    localMessages ?? [],
}));

vi.mock("../gateway/chat-display-projection.js", () => ({
  projectChatDisplayMessages: (messages: unknown[]) => messages,
  projectRecentChatDisplayMessages: (messages: unknown[]) => messages,
  resolveEffectiveChatHistoryMaxChars: () => 100_000,
}));

vi.mock("../gateway/server-constants.js", () => ({
  getMaxChatHistoryMessagesBytes: () => 100_000,
}));

vi.mock("../gateway/server-methods/chat.js", () => ({
  CHAT_HISTORY_MAX_SINGLE_MESSAGE_BYTES: 100_000,
  augmentChatHistoryWithCanvasBlocks: (messages: unknown[]) => messages,
  enforceChatHistoryFinalBudget: ({ messages }: { messages: unknown[] }) => ({ messages }),
  replaceOversizedChatHistoryMessages: ({ messages }: { messages: unknown[] }) => ({ messages }),
}));

vi.mock("../gateway/session-utils.js", () => ({
  listAgentsForGateway: () => [],
  listSessionsFromStoreAsync: async () => ({ sessions: [] }),
  loadCombinedSessionStoreForGateway: () => ({
    storePath: "/tmp/openclaw-sessions.json",
    store: {},
  }),
  loadSessionEntry: (sessionKey: string) => ({
    cfg: {},
    canonicalKey: sessionKey,
    entry: {},
  }),
  migrateAndPruneGatewaySessionStoreKey: ({ key }: { key: string }) => ({ primaryKey: key }),
  readSessionMessagesAsync: async () => [],
  resolveGatewaySessionStoreTarget: ({ key }: { key: string }) => ({
    canonicalKey: key,
    storePath: "/tmp/openclaw-sessions.json",
  }),
  resolveSessionModelRef: () => ({ provider: "openai", model: "gpt-5.4" }),
}));

vi.mock("../gateway/server-model-catalog.js", () => ({
  loadGatewayModelCatalog: () => [],
}));

vi.mock("../gateway/session-reset-service.js", () => ({
  performGatewaySessionReset: () => ({ ok: true, key: "agent:main:main", entry: {} }),
}));

vi.mock("../gateway/session-utils.fs.js", () => ({
  capArrayByJsonBytes: (items: unknown[]) => ({ items }),
}));

vi.mock("../gateway/sessions-patch.js", () => ({
  applySessionsPatchToStore: () => ({ entry: {} }),
}));

vi.mock("../gateway/server-methods/agent-timestamp.js", () => ({
  injectTimestamp: (message: string) => message,
  timestampOptsFromConfig: () => ({}),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("EmbeddedTuiBackend", () => {
  const originalRuntimeLog = defaultRuntime.log;
  const originalRuntimeError = defaultRuntime.error;

  beforeEach(() => {
    agentCommandFromIngressMock.mockReset();
    registeredListener = undefined;
    setEmbeddedMode(false);
    defaultRuntime.log = originalRuntimeLog;
    defaultRuntime.error = originalRuntimeError;
  });

  afterEach(() => {
    setEmbeddedMode(false);
    defaultRuntime.log = originalRuntimeLog;
    defaultRuntime.error = originalRuntimeError;
  });

  it("bridges assistant and lifecycle events into chat events", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    const onConnected = vi.fn();
    backend.onConnected = onConnected;
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await flushMicrotasks();
    expect(onConnected).toHaveBeenCalledTimes(1);

    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "hello",
      runId: "run-local-1",
    });

    registeredListener?.({
      runId: "run-local-1",
      stream: "assistant",
      data: { text: "hello", delta: "hello" },
    });
    registeredListener?.({
      runId: "run-local-1",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    pending.resolve({ payloads: [{ text: "hello" }], meta: {} });
    await flushMicrotasks();

    expect(events).toEqual([
      {
        event: "agent",
        payload: {
          runId: "run-local-1",
          stream: "assistant",
          data: { text: "hello", delta: "hello" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-local-1",
          sessionKey: "agent:main:main",
          state: "delta",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            timestamp: expect.any(Number),
          },
        },
      },
      {
        event: "agent",
        payload: {
          runId: "run-local-1",
          stream: "lifecycle",
          data: { phase: "end", stopReason: "stop" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-local-1",
          sessionKey: "agent:main:main",
          state: "final",
          stopReason: "stop",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "hello" }],
            timestamp: expect.any(Number),
          },
        },
      },
    ]);
  });

  it("keeps final short replies like No after suppressing lead-fragment deltas", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "answer shortly",
      runId: "run-local-no",
    });

    registeredListener?.({
      runId: "run-local-no",
      stream: "assistant",
      data: { text: "No", delta: "No" },
    });
    registeredListener?.({
      runId: "run-local-no",
      stream: "lifecycle",
      data: { phase: "end", stopReason: "stop" },
    });

    pending.resolve({ payloads: [{ text: "No" }], meta: {} });
    await flushMicrotasks();

    const chatPayloads = events
      .filter((entry) => entry.event === "chat")
      .map(
        (entry) =>
          entry.payload as { state?: string; message?: { content?: Array<{ text?: string }> } },
      );
    const nonEmptyDeltas = chatPayloads.filter(
      (payload) => payload.state === "delta" && payload.message?.content?.[0]?.text,
    );
    expect(nonEmptyDeltas).toHaveLength(0);
    expect(chatPayloads.at(-1)).toEqual(
      expect.objectContaining({
        state: "final",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "No" }],
          timestamp: expect.any(Number),
        },
      }),
    );
  });

  it("emits side-result events for local /btw runs", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    agentCommandFromIngressMock.mockResolvedValueOnce({
      payloads: [{ text: "nothing important" }],
      meta: {},
    });

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "/btw what changed?",
      runId: "run-btw-1",
    });
    await flushMicrotasks();

    expect(events).toEqual([
      {
        event: "chat.side_result",
        payload: {
          kind: "btw",
          runId: "run-btw-1",
          sessionKey: "agent:main:main",
          question: "what changed?",
          text: "nothing important",
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-btw-1",
          sessionKey: "agent:main:main",
          state: "final",
        },
      },
    ]);
  });

  it("registers tool-first local runs before forwarding agent events", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    const pending = deferred<{
      payloads: Array<{ text: string }>;
      meta: Record<string, unknown>;
    }>();
    agentCommandFromIngressMock.mockReturnValueOnce(pending.promise);

    const backend = new EmbeddedTuiBackend();
    const events: Array<{ event: string; payload: unknown }> = [];
    backend.onEvent = (evt) => {
      events.push({ event: evt.event, payload: evt.payload });
    };

    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "run tool first",
      runId: "run-tool-first",
    });

    registeredListener?.({
      runId: "run-tool-first",
      stream: "tool",
      data: { phase: "start", toolCallId: "tc-tool-first", name: "exec" },
    });
    pending.resolve({ payloads: [{ text: "done" }], meta: {} });
    await flushMicrotasks();

    expect(events).toEqual([
      {
        event: "chat",
        payload: {
          runId: "run-tool-first",
          sessionKey: "agent:main:main",
          state: "delta",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "" }],
            timestamp: expect.any(Number),
          },
        },
      },
      {
        event: "agent",
        payload: {
          runId: "run-tool-first",
          stream: "tool",
          data: { phase: "start", toolCallId: "tc-tool-first", name: "exec" },
        },
      },
      {
        event: "chat",
        payload: {
          runId: "run-tool-first",
          sessionKey: "agent:main:main",
          state: "final",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "done" }],
            timestamp: expect.any(Number),
          },
        },
      },
    ]);
  });

  it("aborts active local runs", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    let capturedSignal: AbortSignal | undefined;
    agentCommandFromIngressMock.mockImplementationOnce((opts: { abortSignal?: AbortSignal }) => {
      capturedSignal = opts.abortSignal;
      return new Promise((_, reject) => {
        opts.abortSignal?.addEventListener("abort", () => reject(new Error("aborted")), {
          once: true,
        });
      });
    });

    const backend = new EmbeddedTuiBackend();
    backend.start();
    await backend.sendChat({
      sessionKey: "agent:main:main",
      message: "long task",
      runId: "run-abort-1",
    });

    const result = await backend.abortChat({
      sessionKey: "agent:main:main",
      runId: "run-abort-1",
    });
    await flushMicrotasks();

    expect(result).toEqual({ ok: true, aborted: true });
    expect(capturedSignal?.aborted).toBe(true);
  });

  it("passes explicit chat timeouts to the agent command as seconds", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");
    agentCommandFromIngressMock.mockResolvedValueOnce({
      payloads: [{ text: "hello" }],
      meta: {},
    });

    const backend = new EmbeddedTuiBackend();
    backend.start();
    try {
      await backend.sendChat({
        sessionKey: "agent:main:main",
        message: "Wake up, my friend!",
        runId: "run-explicit-timeout",
        timeoutMs: 300_000,
      });
      await flushMicrotasks();

      expect(agentCommandFromIngressMock).toHaveBeenCalledTimes(1);
      expect(agentCommandFromIngressMock.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          timeout: "300",
        }),
      );
    } finally {
      backend.stop();
    }
  });

  it("restores embedded mode and runtime loggers on stop", async () => {
    const { EmbeddedTuiBackend } = await import("./embedded-backend.js");

    const backend = new EmbeddedTuiBackend();
    backend.start();

    expect(isEmbeddedMode()).toBe(true);
    expect(defaultRuntime.log).not.toBe(originalRuntimeLog);
    expect(defaultRuntime.error).not.toBe(originalRuntimeError);

    backend.stop();

    expect(isEmbeddedMode()).toBe(false);
    expect(defaultRuntime.log).toBe(originalRuntimeLog);
    expect(defaultRuntime.error).toBe(originalRuntimeError);
  });
});
