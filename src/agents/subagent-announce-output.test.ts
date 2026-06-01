import { afterEach, describe, expect, it, vi } from "vitest";
import {
  testing,
  applySubagentWaitOutcome,
  buildCompactAnnounceStatsLine,
  buildChildCompletionFindings,
  readSubagentOutput,
} from "./subagent-announce-output.js";

type CallGateway = typeof import("../gateway/call.js").callGateway;
type GetRuntimeConfig = typeof import("./subagent-announce.runtime.js").getRuntimeConfig;
type ReadSessionEntry = typeof import("./subagent-announce.runtime.js").readSessionEntry;
type ReadSessionMessagesAsync =
  typeof import("./subagent-announce.runtime.js").readSessionMessagesAsync;
type ResolveAgentIdFromSessionKey =
  typeof import("./subagent-announce.runtime.js").resolveAgentIdFromSessionKey;
type ResolveStorePath = typeof import("./subagent-announce.runtime.js").resolveStorePath;

function installOutputDeps(params: {
  messages: Array<unknown>;
  transcriptMessages?: Array<unknown>;
}) {
  const callGateway = vi.fn(async () => ({ messages: params.messages }));
  const readSessionMessagesAsync = vi.fn(async () => params.transcriptMessages ?? []);
  testing.setDepsForTest({
    callGateway: callGateway as unknown as CallGateway,
    readSessionMessagesAsync: readSessionMessagesAsync as unknown as ReadSessionMessagesAsync,
  });
  return { callGateway, readSessionMessagesAsync };
}

function sessionsYieldTurn(message = "Waiting for subagent completion.") {
  return [
    {
      role: "assistant",
      stopReason: "toolUse",
      content: [
        { type: "text", text: message },
        {
          type: "toolCall",
          id: "call-yield",
          name: "sessions_yield",
          arguments: { message },
        },
      ],
    },
    {
      role: "toolResult",
      toolCallId: "call-yield",
      toolName: "sessions_yield",
      content: [
        {
          type: "text",
          text: JSON.stringify({ status: "yielded", message }, null, 2),
        },
      ],
      details: { status: "yielded", message },
    },
  ];
}

describe("buildCompactAnnounceStatsLine", () => {
  afterEach(() => {
    testing.setDepsForTest();
  });

  it("rolls one-decimal thousand token stats over to the million unit", async () => {
    testing.setDepsForTest({
      getRuntimeConfig: (() => ({ session: { store: "memory" } })) as GetRuntimeConfig,
      readSessionEntry: (() => ({
        sessionId: "child-session",
        updatedAt: 0,
        inputTokens: 999_999,
        outputTokens: 0,
        totalTokens: 999_999,
      })) as ReadSessionEntry,
      resolveAgentIdFromSessionKey: (() => "main") as ResolveAgentIdFromSessionKey,
      resolveStorePath: (() => "/tmp/openclaw-session-store") as ResolveStorePath,
    });

    await expect(
      buildCompactAnnounceStatsLine({
        sessionKey: "agent:main:subagent:child",
      }),
    ).resolves.toBe("Stats: runtime n/a • tokens 1.0m (in 1.0m / out 0)");
  });
});

describe("readSubagentOutput", () => {
  afterEach(() => {
    testing.setDepsForTest();
  });

  it("does not treat a sessions_yield wait turn as subagent completion output", async () => {
    const deps = installOutputDeps({
      messages: sessionsYieldTurn(),
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
    expect(deps.callGateway).toHaveBeenCalledOnce();
  });

  it("returns final assistant output that arrives after a sessions_yield wait turn", async () => {
    installOutputDeps({
      messages: [
        ...sessionsYieldTurn(),
        {
          role: "system",
          content: [{ type: "text", text: "Compaction" }],
          __openclaw: { kind: "compaction" },
        },
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "Created /tmp/final-deck.pptx" }],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      "Created /tmp/final-deck.pptx",
    );
  });

  it("returns only the latest assistant turn, not trailing tool output", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [
            { type: "text", text: "Mapped the code path." },
            { type: "toolCall", id: "call-read", name: "read", arguments: {} },
          ],
        },
        {
          role: "toolResult",
          content: "tool result should not become the child result",
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      "Mapped the code path.",
    );
  });

  it("keeps earlier visible assistant text across a trailing empty assistant turn", async () => {
    installOutputDeps({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "Mapped the code path." }],
        },
        {
          role: "assistant",
          stopReason: "toolUse",
          content: [{ type: "toolCall", id: "call-read", name: "read", arguments: {} }],
        },
        {
          role: "toolResult",
          content: "tool result should not become the child result",
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBe(
      "Mapped the code path.",
    );
  });

  it("does not fall back to tool output when the last assistant turn is empty", async () => {
    installOutputDeps({
      messages: [
        {
          role: "toolResult",
          content: "tool output only",
        },
        {
          role: "assistant",
          stopReason: "stop",
          content: [],
        },
      ],
    });

    await expect(readSubagentOutput("agent:main:subagent:child")).resolves.toBeUndefined();
  });

  it("reads recovered output from the private transcript before gateway history", async () => {
    const deps = installOutputDeps({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "stale visible output" }],
        },
      ],
      transcriptMessages: [
        {
          role: "assistant",
          stopReason: "stop",
          content: [{ type: "text", text: "fresh recovered output" }],
        },
      ],
    });

    await expect(
      readSubagentOutput("agent:main:subagent:child", undefined, {
        sessionFile: "/tmp/openclaw-internal-run.jsonl",
      }),
    ).resolves.toBe("fresh recovered output");
    expect(deps.readSessionMessagesAsync).toHaveBeenCalledWith(
      "agent:main:subagent:child",
      undefined,
      "/tmp/openclaw-internal-run.jsonl",
      { mode: "recent", maxMessages: 100, maxBytes: 1024 * 1024 },
    );
    expect(deps.callGateway).not.toHaveBeenCalled();
  });

  it("does not read visible gateway history when a private transcript is empty", async () => {
    const deps = installOutputDeps({
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "stale visible output" }],
        },
      ],
      transcriptMessages: [],
    });

    await expect(
      readSubagentOutput("agent:main:subagent:child", undefined, {
        sessionFile: "/tmp/openclaw-empty-internal-run.jsonl",
      }),
    ).resolves.toBeUndefined();
    expect(deps.callGateway).not.toHaveBeenCalled();
  });
});

describe("buildChildCompletionFindings", () => {
  it("does not convert ANNOUNCE_SKIP child completions into no-output findings", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:silent",
        task: "silent task",
        createdAt: 1,
        completion: { resultText: "ANNOUNCE_SKIP" },
        outcome: { status: "ok" },
      },
    ]);

    expect(findings).toBeUndefined();
  });

  it("keeps failed ANNOUNCE_SKIP child completions visible", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:silent",
        task: "silent task",
        createdAt: 1,
        completion: { resultText: "ANNOUNCE_SKIP" },
        outcome: { status: "error", error: "boom" },
      },
    ]);

    expect(findings).toContain("status: error: boom");
    expect(findings).toContain("ANNOUNCE_SKIP");
  });

  it("uses frozen child completion text when normalized completion is absent", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:child",
        task: "child task",
        createdAt: 1,
        frozenResultText: "final child output",
        outcome: { status: "ok" },
      },
    ]);

    expect(findings).toContain("final child output");
    expect(findings).not.toContain("(no output)");
  });

  it("uses pending delivery payload text when completion text has been cleared", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:child",
        task: "child task",
        createdAt: 1,
        completion: { resultText: null },
        delivery: {
          payload: {
            frozenResultText: "delivery payload output",
          },
        },
        outcome: { status: "ok" },
      },
    ]);

    expect(findings).toContain("delivery payload output");
    expect(findings).not.toContain("(no output)");
  });

  it("numbers findings contiguously after skipped silent completions", () => {
    const findings = buildChildCompletionFindings([
      {
        childSessionKey: "agent:main:subagent:silent",
        task: "silent task",
        createdAt: 1,
        completion: { resultText: "ANNOUNCE_SKIP" },
        outcome: { status: "ok" },
      },
      {
        childSessionKey: "agent:main:subagent:visible",
        task: "visible task",
        createdAt: 2,
        completion: { resultText: "actual output" },
        outcome: { status: "ok" },
      },
    ]);

    expect(findings).toContain("1. visible task");
    expect(findings).not.toContain("2. visible task");
  });
});

describe("applySubagentWaitOutcome", () => {
  it("treats blocked ok wait snapshots as errors", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "ok",
        startedAt: 100,
        endedAt: 150,
        livenessState: "blocked",
        error: "Context overflow: prompt too large for the model.",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "error",
      error: "Context overflow: prompt too large for the model.",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("keeps provider hard timeouts stronger than blocked wait metadata", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "error",
        startedAt: 100,
        endedAt: 150,
        livenessState: "blocked",
        timeoutPhase: "provider",
        providerStarted: true,
        error: "model timed out",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "timeout",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("keeps rpc timeout wait snapshots as timeout outcomes", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "timeout",
        startedAt: 100,
        endedAt: 150,
        stopReason: "rpc",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "timeout",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });

  it("treats aborted ok wait snapshots as terminated subagent errors", () => {
    const applied = applySubagentWaitOutcome({
      wait: {
        status: "ok",
        startedAt: 100,
        endedAt: 150,
        stopReason: "aborted",
      },
      outcome: undefined,
    });

    expect(applied.outcome).toEqual({
      status: "error",
      error: "subagent run terminated",
      startedAt: 100,
      endedAt: 150,
      elapsedMs: 50,
    });
  });
});
