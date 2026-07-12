/** Tests ACP child-to-parent stream relay notices, routing, and log path resolution. */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
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

const progressCommentaryDeliveryContext = {
  channel: "forum",
  to: "-1001234567890",
  accountId: "default",
  threadId: 1122,
};

function progressModeConfig(acp?: OpenClawConfig["acp"]): OpenClawConfig {
  return {
    ...(acp ? { acp } : {}),
    channels: {
      forum: {
        streaming: {
          mode: "progress",
          progress: {
            commentary: true,
          },
        },
      },
    },
  };
}

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
        },
      ]
    >;
    expect(
      systemEventCalls.map(([, options]) => ({
        contextKey: options.contextKey,
        sessionKey: options.sessionKey,
        deliveryContext: options.deliveryContext,
      })),
    ).toEqual([
      {
        contextKey: "acp-spawn:run-1:start",
        sessionKey: "agent:main:main",
        deliveryContext,
      },
      {
        contextKey: "acp-spawn:run-1:progress",
        sessionKey: "agent:main:main",
        deliveryContext,
      },
      {
        contextKey: "acp-spawn:run-1:done",
        sessionKey: "agent:main:main",
        deliveryContext,
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
      | { contextKey?: unknown; sessionKey?: unknown }
      | undefined;
    expect(progressOptions?.contextKey).toBe("acp-spawn:run-cron:progress");
    expect(progressOptions?.sessionKey).toBe("global");
    const heartbeatOptions = firstMockCall(requestHeartbeatMock, "heartbeat request")[0] as
      | { agentId?: string; reason?: string }
      | undefined;
    expect(heartbeatOptions?.agentId).toBe("ops");
    expect(heartbeatOptions?.reason).toBe("acp:spawn:stream");
    expect(heartbeatOptions).not.toHaveProperty("sessionKey");
    relay.dispose();
  });

  it("emits a pre-prompt stall notice and a resumed notice when output returns", () => {
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
    expectTextWithFragment(collectedTexts(), "no prompt submission was observed for 1s");

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

  it("classifies stalls after prompt submission but before the first runtime event", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-prompt-stall",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-prompt-stall",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 1_000,
      noOutputPollMs: 250,
    });

    emitAgentEvent({
      runId: "run-prompt-stall",
      stream: "acp",
      data: {
        phase: "prompt_submitted",
        at: Date.now(),
        proxyEnvKeys: ["HTTPS_PROXY"],
      },
    });
    vi.advanceTimersByTime(1_500);

    const texts = collectedTexts();
    expectTextWithFragment(texts, "prompt was submitted but no ACP runtime event arrived for 1s");
    expectTextWithFragment(texts, "proxy env: HTTPS_PROXY");
    expectNoTextWithFragment(texts, "waiting for interactive input");
    relay.dispose();
  });

  it("classifies runtime activity without visible assistant output separately from input waits", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-runtime-stall",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-runtime-stall",
      agentId: "codex",
      streamFlushMs: 1,
      noOutputNoticeMs: 1_000,
      noOutputPollMs: 250,
    });

    emitAgentEvent({
      runId: "run-runtime-stall",
      stream: "acp",
      data: {
        phase: "prompt_submitted",
        at: Date.now(),
        proxyEnvKeys: [],
      },
    });
    vi.advanceTimersByTime(750);
    emitAgentEvent({
      runId: "run-runtime-stall",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        text: "connecting to upstream",
      },
    });
    vi.advanceTimersByTime(750);
    expectNoTextWithFragment(collectedTexts(), "has ACP runtime activity");

    vi.advanceTimersByTime(500);

    const texts = collectedTexts();
    expectTextWithFragment(
      texts,
      "has ACP runtime activity but no visible assistant output for 1s",
    );
    expectTextWithFragment(texts, "Last ACP event: status");
    expectNoTextWithFragment(texts, "waiting for interactive input");
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

  it("relays the latest replaceable assistant snapshot instead of superseded drafts", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-replaceable-assistant",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-replaceable-assistant",
      agentId: "codex",
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-replaceable-assistant",
      stream: "assistant",
      data: {
        text: "coordination draft",
        delta: "coordination draft",
        replaceable: true,
      },
    });
    emitAgentEvent({
      runId: "run-replaceable-assistant",
      stream: "assistant",
      data: {
        text: "final answer",
        delta: "",
        replace: true,
        replaceable: true,
      },
    });
    emitAgentEvent({
      runId: "run-replaceable-assistant",
      stream: "lifecycle",
      data: {
        phase: "end",
        startedAt: 1_000,
        endedAt: 2_000,
      },
    });

    const texts = collectedTexts();
    expectNoTextWithFragment(texts, "coordination draft");
    expectTextWithFragment(texts, "codex: final answer");
    relay.dispose();
  });

  it("relays commentary-phase assistant text in parent progress mode by default", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary-default",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-commentary-default",
      agentId: "codex",
      cfg: {
        channels: {
          discord: {},
        },
      },
      deliveryContext: {
        ...progressCommentaryDeliveryContext,
        channel: "discord",
      },
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-commentary-default",
      stream: "assistant",
      data: {
        delta: "checking thread context; then post a tight progress reply here.",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expectTextWithFragment(
      texts,
      "codex: checking thread context; then post a tight progress reply here.",
    );
    relay.dispose();
  });

  it.each([
    {
      label: "generic",
      channelId: "forum",
      deliveryContext: progressCommentaryDeliveryContext,
    },
    {
      label: "Telegram",
      channelId: "telegram",
      deliveryContext: {
        ...progressCommentaryDeliveryContext,
        channel: "telegram",
      },
    },
  ])("defaults commentary on for $label parent progress mode", ({ channelId, deliveryContext }) => {
    const runId = `run-${channelId}-commentary-default`;
    const relay = startAcpSpawnParentStreamRelay({
      runId,
      parentSessionKey: "agent:main:main",
      childSessionKey: `agent:codex:acp:child-${channelId}-commentary-default`,
      agentId: "codex",
      cfg: {
        channels: {
          [channelId]: {
            streaming: {
              mode: "progress",
            },
          },
        },
      },
      deliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId,
      stream: "assistant",
      data: {
        delta: "checking thread context; then post a tight progress reply here.",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(15);

    expectTextWithFragment(
      collectedTexts(),
      "codex: checking thread context; then post a tight progress reply here.",
    );
    relay.dispose();
  });

  it("flushes visible commentary before final answer text", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary-final",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-commentary-final",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-commentary-final",
      stream: "assistant",
      data: {
        delta: "Note: Checking the requested response shape only.",
        phase: "commentary",
      },
    });
    emitAgentEvent({
      runId: "run-commentary-final",
      stream: "assistant",
      data: {
        delta: "ready",
      },
    });
    vi.advanceTimersByTime(15);

    expect(collectedTexts()).toEqual([
      "codex: Note: Checking the requested response shape only.",
      "codex: ready",
    ]);
    relay.dispose();
  });

  it("relays preamble item progress without duplicating snapshots", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-preamble-item",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-preamble-item",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-preamble-item",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking",
      },
    });
    emitAgentEvent({
      runId: "run-preamble-item",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the app-server stream",
      },
    });
    vi.advanceTimersByTime(15);

    expect(collectedTexts()).toEqual(["codex: Checking the app-server stream"]);
    relay.dispose();
  });

  it("replaces buffered preamble item progress when snapshots change text", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-preamble-item-replacement",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-preamble-item-replacement",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-preamble-item-replacement",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking config",
      },
    });
    emitAgentEvent({
      runId: "run-preamble-item-replacement",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Reading files",
      },
    });
    vi.advanceTimersByTime(15);

    expect(collectedTexts()).toEqual(["codex: Reading files"]);
    relay.dispose();
  });

  it("omits already flushed preamble item progress from later prefix snapshots", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-preamble-item-after-flush",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-preamble-item-after-flush",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-preamble-item-after-flush",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking",
      },
    });
    vi.advanceTimersByTime(15);
    emitAgentEvent({
      runId: "run-preamble-item-after-flush",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the app-server stream",
      },
    });
    vi.advanceTimersByTime(15);

    expect(collectedTexts()).toEqual(["codex: Checking", "codex: the app-server stream"]);
    relay.dispose();
  });

  it("uses Discord default progress mode for parent commentary", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-discord-default-progress",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-discord-default-progress",
      agentId: "codex",
      cfg: {
        channels: {
          discord: {},
        },
      },
      deliveryContext: {
        ...progressCommentaryDeliveryContext,
        channel: "discord",
      },
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-discord-default-progress",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the app-server stream",
      },
    });
    vi.advanceTimersByTime(15);

    expect(collectedTexts()).toEqual(["codex: Checking the app-server stream"]);
    relay.dispose();
  });

  it("honors explicit Discord parent streaming off", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-discord-streaming-off",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-discord-streaming-off",
      agentId: "codex",
      cfg: {
        channels: {
          discord: {
            streaming: {
              mode: "off",
            },
          },
        },
      },
      deliveryContext: {
        ...progressCommentaryDeliveryContext,
        channel: "discord",
      },
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-discord-streaming-off",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the app-server stream",
      },
    });
    vi.advanceTimersByTime(15);

    expect(collectedTexts()).toEqual([]);
    relay.dispose();
  });

  it("suppresses commentary-phase assistant text when parent progress commentary is disabled", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary-disabled",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-commentary-disabled",
      agentId: "codex",
      cfg: {
        channels: {
          forum: {
            streaming: {
              mode: "progress",
              progress: {
                commentary: false,
              },
            },
          },
        },
      },
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-commentary-disabled",
      stream: "assistant",
      data: {
        delta: "checking thread context; then post a tight progress reply here.",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(15);

    expectNoTextWithFragment(collectedTexts(), "checking thread context");
    relay.dispose();
  });

  it("suppresses preamble item progress when parent progress commentary is disabled", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-preamble-item-disabled",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-preamble-item-disabled",
      agentId: "codex",
      cfg: {
        channels: {
          forum: {
            streaming: {
              mode: "progress",
              progress: {
                commentary: false,
              },
            },
          },
        },
      },
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-preamble-item-disabled",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the app-server stream",
      },
    });
    vi.advanceTimersByTime(15);

    expectNoTextWithFragment(collectedTexts(), "Checking the app-server stream");
    relay.dispose();
  });

  it("applies normalized account commentary opt-outs", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-account-commentary-disabled",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-account-commentary-disabled",
      agentId: "codex",
      cfg: {
        channels: {
          forum: {
            streaming: {
              mode: "progress",
            },
            accounts: {
              "Carey Notifications": {
                streaming: {
                  progress: {
                    commentary: false,
                  },
                },
              },
            },
          },
        },
      },
      deliveryContext: {
        ...progressCommentaryDeliveryContext,
        accountId: "carey-notifications",
      },
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-account-commentary-disabled",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the app-server stream",
      },
    });
    vi.advanceTimersByTime(15);

    expect(collectedTexts()).toEqual([]);
    relay.dispose();
  });

  it("applies account streaming mode opt-outs", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-account-stream-mode-off",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-account-stream-mode-off",
      agentId: "codex",
      cfg: {
        channels: {
          forum: {
            streaming: {
              mode: "progress",
              progress: {
                commentary: true,
              },
            },
            accounts: {
              work: {
                streaming: { mode: "off" },
              },
            },
          },
        },
      },
      deliveryContext: {
        ...progressCommentaryDeliveryContext,
        accountId: "work",
      },
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-account-stream-mode-off",
      stream: "item",
      data: {
        itemId: "preamble-1",
        kind: "preamble",
        progressText: "Checking the app-server stream",
      },
    });
    vi.advanceTimersByTime(15);

    expect(collectedTexts()).toEqual([]);
    relay.dispose();
  });

  it("inherits parent channel progress mode for account commentary overrides", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-account-commentary-enabled",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-account-commentary-enabled",
      agentId: "codex",
      cfg: {
        channels: {
          forum: {
            streaming: {
              mode: "progress",
            },
            accounts: {
              work: {
                streaming: {
                  progress: {
                    commentary: true,
                  },
                },
              },
            },
          },
        },
      },
      deliveryContext: {
        ...progressCommentaryDeliveryContext,
        accountId: "work",
      },
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-account-commentary-enabled",
      stream: "assistant",
      data: {
        delta: "checking account-scoped progress config.",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(15);

    expectTextWithFragment(collectedTexts(), "codex: checking account-scoped progress config.");
    relay.dispose();
  });

  it("preserves explicit channel streaming off for account commentary overrides", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-account-commentary-channel-off",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-account-commentary-channel-off",
      agentId: "codex",
      cfg: {
        channels: {
          discord: {
            streaming: {
              mode: "off",
            },
            accounts: {
              carey: {
                streaming: {
                  progress: {
                    commentary: true,
                  },
                },
              },
            },
          },
        },
      },
      deliveryContext: {
        ...progressCommentaryDeliveryContext,
        channel: "discord",
        accountId: "carey",
      },
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-account-commentary-channel-off",
      stream: "assistant",
      data: {
        delta: "Checking",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(15);

    expect(collectedTexts()).toEqual([]);
    relay.dispose();
  });

  it("inherits legacy parent channel progress mode for account commentary overrides", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-account-legacy-commentary-enabled",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-account-legacy-commentary-enabled",
      agentId: "codex",
      cfg: {
        channels: {
          forum: {
            streaming: "progress",
            accounts: {
              work: {
                streaming: {
                  progress: {
                    commentary: true,
                  },
                },
              },
            },
          },
        },
      },
      deliveryContext: {
        ...progressCommentaryDeliveryContext,
        accountId: "work",
      },
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-account-legacy-commentary-enabled",
      stream: "assistant",
      data: {
        delta: "checking legacy progress config.",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(15);

    expectTextWithFragment(collectedTexts(), "codex: checking legacy progress config.");
    relay.dispose();
  });

  it("relays ACP status progress when progress commentary and tag visibility are enabled", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-status-commentary-enabled",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-status-commentary-enabled",
      agentId: "codex",
      cfg: progressModeConfig({
        stream: {
          tagVisibility: {
            plan: true,
          },
        },
      }),
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-status-commentary-enabled",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        tag: "plan",
        text: "plan: inspect the runtime handoff first",
      },
    });
    vi.advanceTimersByTime(15);

    expectTextWithFragment(collectedTexts(), "codex: plan: inspect the runtime handoff first");
    relay.dispose();
  });

  it("flushes buffered commentary before ACP status progress", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary-status-boundary",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-commentary-status-boundary",
      agentId: "codex",
      cfg: progressModeConfig({
        stream: {
          tagVisibility: {
            plan: true,
          },
        },
      }),
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
      emitStartNotice: false,
    });

    emitAgentEvent({
      runId: "run-commentary-status-boundary",
      stream: "assistant",
      data: {
        delta: "checking files",
        phase: "commentary",
      },
    });
    emitAgentEvent({
      runId: "run-commentary-status-boundary",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        tag: "plan",
        text: "plan: inspect the runtime handoff first",
      },
    });

    expect(collectedTexts()).toEqual([
      "codex: checking files",
      "codex: plan: inspect the runtime handoff first",
    ]);
    relay.dispose();
  });

  it("does not relay hidden ACP status tags when progress commentary is enabled", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-status-commentary-hidden",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-status-commentary-hidden",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-status-commentary-hidden",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        tag: "usage_update",
        text: "usage updated: 10/100",
      },
    });
    emitAgentEvent({
      runId: "run-status-commentary-hidden",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        tag: "available_commands_update",
        text: "available commands updated (7)",
      },
    });
    vi.advanceTimersByTime(15);

    const texts = collectedTexts();
    expectNoTextWithFragment(texts, "usage updated");
    expectNoTextWithFragment(texts, "available commands updated");
    relay.dispose();
  });

  it("does not relay ACP status tags hidden by default when progress commentary is enabled", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-status-commentary-default-hidden",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-status-commentary-default-hidden",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 10,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-status-commentary-default-hidden",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        tag: "plan",
        text: "plan: inspect the runtime handoff first",
      },
    });
    vi.advanceTimersByTime(15);

    expectNoTextWithFragment(collectedTexts(), "inspect the runtime handoff");
    relay.dispose();
  });

  it("classifies opted-in commentary as visible output for stall notices", () => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-commentary-visible-stall",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:child-commentary-visible-stall",
      agentId: "codex",
      cfg: progressModeConfig(),
      deliveryContext: progressCommentaryDeliveryContext,
      streamFlushMs: 1,
      noOutputNoticeMs: 1_000,
      noOutputPollMs: 250,
    });

    emitAgentEvent({
      runId: "run-commentary-visible-stall",
      stream: "acp",
      data: {
        phase: "prompt_submitted",
        at: Date.now(),
        proxyEnvKeys: [],
      },
    });
    emitAgentEvent({
      runId: "run-commentary-visible-stall",
      stream: "acp",
      data: {
        phase: "runtime_event",
        eventType: "status",
        text: "connecting to upstream",
      },
    });
    emitAgentEvent({
      runId: "run-commentary-visible-stall",
      stream: "assistant",
      data: {
        delta: "checking active files before patching.",
        phase: "commentary",
      },
    });
    vi.advanceTimersByTime(5);
    vi.advanceTimersByTime(1_500);

    const texts = collectedTexts();
    expectTextWithFragment(texts, "codex: checking active files before patching.");
    expectNoTextWithFragment(texts, "has ACP runtime activity but no visible assistant output");
    expectTextWithFragment(texts, "has produced no visible output for 1s");
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

  it.each([
    {
      name: "preview cutoff",
      delta: `${"a".repeat(218)}😀tail`,
      expected: `${"a".repeat(218)}…`,
    },
    {
      name: "retained buffer start",
      delta: `😀${"b".repeat(3_999)}`,
      expected: `${"b".repeat(219)}…`,
    },
  ])("keeps $name on UTF-16 boundaries", ({ delta, expected }) => {
    const relay = startAcpSpawnParentStreamRelay({
      runId: "run-utf16-safe",
      parentSessionKey: "agent:main:main",
      childSessionKey: "agent:codex:acp:utf16-safe",
      agentId: "codex",
      streamFlushMs: 0,
      noOutputNoticeMs: 120_000,
    });

    emitAgentEvent({
      runId: "run-utf16-safe",
      stream: "assistant",
      data: { delta },
    });

    expect(collectedTexts()[1]).toBe(`codex: ${expected}`);
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
