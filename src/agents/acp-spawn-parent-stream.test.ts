import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeMockedModule } from "../test-utils/vitest-module-mocks.js";

const enqueueSystemEventMock = vi.fn();
const requestHeartbeatMock = vi.fn();
const readAcpSessionEntryMock = vi.fn();
const resolveSessionFilePathMock = vi.fn();
const resolveSessionFilePathOptionsMock = vi.fn();

vi.mock("../infra/system-events.js", () => ({
  enqueueSystemEvent: (...args: unknown[]) => enqueueSystemEventMock(...args),
}));

vi.mock("../infra/heartbeat-wake.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../infra/heartbeat-wake.js")>(
      "../infra/heartbeat-wake.js",
    ),
    () => ({
      requestHeartbeat: (...args: unknown[]) => requestHeartbeatMock(...args),
    }),
  );
});

vi.mock("../acp/runtime/session-meta.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../acp/runtime/session-meta.js")>(
      "../acp/runtime/session-meta.js",
    ),
    () => ({
      readAcpSessionEntry: (...args: unknown[]) => readAcpSessionEntryMock(...args),
    }),
  );
});

vi.mock("../config/sessions/paths.js", async () => {
  return await mergeMockedModule(
    await vi.importActual<typeof import("../config/sessions/paths.js")>(
      "../config/sessions/paths.js",
    ),
    () => ({
      resolveSessionFilePath: (...args: unknown[]) => resolveSessionFilePathMock(...args),
      resolveSessionFilePathOptions: (...args: unknown[]) =>
        resolveSessionFilePathOptionsMock(...args),
    }),
  );
});

let emitAgentEvent: typeof import("../infra/agent-events.js").emitAgentEvent;
let resolveAcpSpawnStreamLogPath: typeof import("./acp-spawn-parent-stream.js").resolveAcpSpawnStreamLogPath;
let startAcpSpawnParentStreamRelay: typeof import("./acp-spawn-parent-stream.js").startAcpSpawnParentStreamRelay;

function collectedTexts() {
  return enqueueSystemEventMock.mock.calls.map((call) =>
    typeof call[0] === "string" ? call[0] : (JSON.stringify(call[0]) ?? ""),
  );
}

function expectTextWithFragment(texts: string[], fragment: string): void {
  expect(texts.join("\n")).toContain(fragment);
}

function expectNoTextWithFragment(texts: string[], fragment: string): void {
  expect(texts.join("\n")).not.toContain(fragment);
}

function firstMockCall(
  mock: { mock: { calls: Array<readonly unknown[]> } },
  label: string,
): readonly unknown[] {
  const call = mock.mock.calls[0];
  if (!call) {
    throw new Error(`expected ${label} call`);
  }
  return call;
}

describe("startAcpSpawnParentStreamRelay", () => {
  beforeAll(async () => {
    ({ emitAgentEvent } = await import("../infra/agent-events.js"));
    ({ resolveAcpSpawnStreamLogPath, startAcpSpawnParentStreamRelay } =
      await import("./acp-spawn-parent-stream.js"));
  });

  beforeEach(() => {
    enqueueSystemEventMock.mockClear();
    requestHeartbeatMock.mockClear();
    readAcpSessionEntryMock.mockReset();
    resolveSessionFilePathMock.mockReset();
    resolveSessionFilePathOptionsMock.mockReset();
    resolveSessionFilePathOptionsMock.mockImplementation((value: unknown) => value);
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-04T01:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("relays assistant progress and completion to the parent session", () => {
    const deliveryContext = {
      channel: "forum",
      to: "-1001234567890",
      accountId: "default",
      threadId: 1122,
    };
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-1",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-1",
      agentId: "codex",
      deliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-1",
      stream: "assistant",
      data: {
        delta: "hello from child",
      },
    });
    vi.advanceTimersByTime(15);

    emitAgentEvent({
      runId: "run-1",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1_000,
        endedAt: 3_100,
      },
    });

    expect(collectedTexts()).toEqual([
      "Started codex session agent:codex:acp:child-1. Streaming progress updates to parent session.",
      "codex: hello from child",
      "codex run completed in 2s.",
    ]);
    const systemEventCalls = enqueueSystemEventMock.mock.calls as Array<
      [
        string,
        {
          contextKey?: string;
          sessionKey?: string;
          deliveryContext?: unknown;
          trusted?: boolean;
        },
      ]
    >;
    expect(
      systemEventCalls.map(([, options]) => ({
        contextKey: options.contextKey,
        sessionKey: options.sessionKey,
        deliveryContext: options.deliveryContext,
        trusted: options.trusted,
      })),
    ).toEqual([
      {
        contextKey: "acp-spawn:run-1:start",
        sessionKey: "agent:main:main",
        deliveryContext,
        trusted: false,
      },
      {
        contextKey: "acp-spawn:run-1:progress",
        sessionKey: "agent:main:main",
        deliveryContext,
        trusted: false,
      },
      {
        contextKey: "acp-spawn:run-1:done",
        sessionKey: "agent:main:main",
        deliveryContext,
        trusted: false,
      },
    ]);
    const heartbeatCalls = requestHeartbeatMock.mock.calls as Array<
      [{ source?: string; intent?: string; reason?: string; sessionKey?: string }]
    >;
    expect(heartbeatCalls.map(([options]) => options)).toEqual([
      {
        source: "acp-spawn",
        intent: "event",
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      },
      {
        source: "acp-spawn",
        intent: "event",
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      },
      {
        source: "acp-spawn",
        intent: "event",
        reason: "acp:spawn:stream",
        sessionKey: "agent:main:main",
      },
    ]);
    relay.dispose();
  });

  it("remaps cron-run parent session keys while relaying stream events", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-cron",
      parentSessionKey: "agent:ops:cron:nightly:run:run-1:subagent:worker",
      childSessionKey: "agent:codex:acp:child-cron",
      agentId: "codex",
      mainKey: "primary",
      sessionScope: "global",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-cron",
      stream: "assistant",
      data: {
        delta: "hello from child",
      },
    });
    vi.advanceTimersByTime(15);

    const progressEvent = enqueueSystemEventMock.mock.calls.find(
      ([text]) => typeof text === "string" && text.includes("codex: hello from child"),
    );
    expect(progressEvent?.[0]).toContain("codex: hello from child");
    const progressOptions = progressEvent?.[1] as
      | { contextKey?: unknown; sessionKey?: unknown; trusted?: unknown }
      | undefined;
    expect(progressOptions?.contextKey).toBe("acp-spawn:run-cron:progress");
    expect(progressOptions?.sessionKey).toBe("global");
    expect(progressOptions?.trusted).toBe(false);
    const heartbeatOptions = firstMockCall(requestHeartbeatMock, "heartbeat request")[0] as
      | { agentId?: string; reason?: string }
      | undefined;
    expect(heartbeatOptions?.agentId).toBe("ops");
    expect(heartbeatOptions?.reason).toBe("acp:spawn:stream");
    expect(heartbeatOptions).not.toHaveProperty("sessionKey");
    relay.dispose();
  });

  it("emits a no-output notice and a resumed notice when output returns", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-2",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-2",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 1_000,
      noOutputPollMs: 250,
    });

    vi.advanceTimersByTime(1_500);
    expectTextWithFragment(collectedTexts(), "has produced no output for 1s");

    emitAgentEvent({
      runId: "run-2",
      stream: "assistant",
      data: {
        delta: "resumed output",
      },
    });
    vi.advanceTimersByTime(5);

    const texts = collectedTexts();
    expectTextWithFragment(texts, "resumed output.");
    expectTextWithFragment(texts, "codex: resumed output");

    emitAgentEvent({
      runId: "run-2",
      stream: "lifecycle",
      data: {
        phase: "error",
        error: "boom",
      },
    });
    expectTextWithFragment(collectedTexts(), "run failed: boom");
    relay.dispose();
  });

  it("auto-disposes stale relays after max lifetime timeout", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-3",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-3",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 0,
      maxRelayLifetimeMs: 1_000,
    });

    vi.advanceTimersByTime(1_001);
    expectTextWithFragment(collectedTexts(), "stream relay timed out after 1s");

    const before = enqueueSystemEventMock.mock.calls.length;
    emitAgentEvent({
      runId: "run-3",
      stream: "assistant",
      data: {
        delta: "late output",
      },
    });
    vi.advanceTimersByTime(5);

    expect(enqueueSystemEventMock.mock.calls).toHaveLength(before);
    relay.dispose();
  });

  it("supports delayed start notices", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-4",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-4",
      agentId: "codex",
      emitStartNotice: false,
    });

    expectNoTextWithFragment(collectedTexts(), "Started codex session");

    relay.notifyStarted();

    expectTextWithFragment(collectedTexts(), "Started codex session");
    relay.dispose();
  });

  it("can keep background relays out of the parent session while still logging", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-quiet",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-quiet",
      agentId: "codex",
      surfaceUpdates: false,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    relay.notifyStarted();
    emitAgentEvent({
      runId: "run-quiet",
      stream: "assistant",
      data: {
        delta: "hello from child",
      },
    });
    vi.advanceTimersByTime(15);
    emitAgentEvent({
      runId: "run-quiet",
      stream: "lifecycle",
      data: {
        phase: "end",
      },
    });

    expect(collectedTexts()).toStrictEqual([]);
    expect(requestHeartbeatMock).not.toHaveBeenCalled();
    relay.dispose();
  });

  it("preserves delta whitespace boundaries in progress relays", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-5",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-5",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-5",
      stream: "assistant",
      data: {
        delta: "hello",
      },
    });
    emitAgentEvent({
      runId: "run-5",
      stream: "assistant",
      data: {
        delta: " world",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expectTextWithFragment(texts, "codex: hello world");
    relay.dispose();
  });

  it("suppresses commentary-phase assistant relay text", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-commentary",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-commentary",
      stream: "assistant",
      data: {
        delta: "checking thread context; then post a tight progress reply here.",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expectNoTextWithFragment(texts, "checking thread context");
    expectNoTextWithFragment(texts, "post a tight progress reply here");
    relay.dispose();
  });

  it("still relays final_answer assistant text after suppressed commentary", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-final",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-final",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-final",
      stream: "assistant",
      data: {
        delta: "checking thread context; then post a tight progress reply here.",
        phase: "commentary",
      },
    });
    emitAgentEvent({
      runId: "run-final",
      stream: "assistant",
      data: {
        delta: "final answer ready",
        phase: "final_answer",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expectNoTextWithFragment(texts, "checking thread context");
    expectTextWithFragment(texts, "codex: final answer ready");
    relay.dispose();
  });

  it("resolves ACP spawn stream log path from session metadata", () => {
    readAcpSessionEntryMock.mockReturnValue({
      storePath: "/tmp/openclaw/agents/codex/sessions/sessions.json",
      entry: {
        sessionId: "sess-123",
        sessionFile: "/tmp/openclaw/agents/codex/sessions/sess-123.jsonl",
      },
    });
    resolveSessionFilePathMock.mockReturnValue(
      "/tmp/openclaw/agents/codex/sessions/sess-123.jsonl",
    );

    const resolved = resolveAcpSpawnStreamLogPath({
      childSessionKey: "agent:codex:acp:child-1",
    });

    expect(resolved).toBe("/tmp/openclaw/agents/codex/sessions/sess-123.acp-stream.jsonl");
    expect(readAcpSessionEntryMock).toHaveBeenCalledWith({
      sessionKey: "agent:codex:acp:child-1",
    });
    expect(resolveSessionFilePathMock).toHaveBeenCalledTimes(1);
    const [sessionId, entry, options] = firstMockCall(
      resolveSessionFilePathMock,
      "session file path resolution",
    ) as [string, { sessionId?: unknown }, { storePath?: unknown }];
    expect(sessionId).toBe("sess-123");
    expect(entry.sessionId).toBe("sess-123");
    expect(options.storePath).toBe("/tmp/openclaw/agents/codex/sessions/sessions.json");
  });
});
