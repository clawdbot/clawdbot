// Compaction handler tests cover session-store reconciliation and lifecycle
// logging for automatic and manual embedded run compactions.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  readCompactionCount,
  seedSessionStore,
  waitForCompactionCount,
} from "./embedded-agent-subscribe.compaction-test-helpers.js";
import {
  handleCompactionEnd,
  handleCompactionStart,
} from "./embedded-agent-subscribe.handlers.compaction.js";
import reconcileSessionStoreCompactionCountAfterSuccess from "./embedded-agent-subscribe.handlers.compaction.runtime.js";
import type { EmbeddedAgentSubscribeContext } from "./embedded-agent-subscribe.handlers.types.js";
import type { AgentMessage } from "./runtime/index.js";
import { makeZeroUsageSnapshot, type AssistantUsageSnapshot } from "./usage.js";

function createCompactionContext(params: {
  storePath: string;
  sessionKey: string;
  agentId?: string;
  initialCount: number;
  onAgentEvent?: EmbeddedAgentSubscribeContext["params"]["onAgentEvent"];
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
  messages?: AgentMessage[];
}): EmbeddedAgentSubscribeContext {
  // Minimal context preserves only the compaction counters and callbacks the
  // handlers mutate, making store reconciliation assertions direct.
  let compactionCount = params.initialCount;
  return {
    params: {
      runId: "run-test",
      session: { messages: params.messages ?? [] } as never,
      config: { session: { store: params.storePath } } as never,
      sessionKey: params.sessionKey,
      sessionId: "session-1",
      agentId: params.agentId ?? "test-agent",
      onAgentEvent: params.onAgentEvent,
    },
    state: {
      compactionInFlight: true,
      pendingCompactionRetry: 0,
    } as never,
    log: {
      debug: vi.fn(),
      info: params.info ?? vi.fn(),
      warn: params.warn ?? vi.fn(),
    },
    ensureCompactionPromise: vi.fn(),
    noteCompactionRetry: vi.fn(),
    maybeResolveCompactionWait: vi.fn(),
    resolveCompactionRetry: vi.fn(),
    resetForCompactionRetry: vi.fn(),
    incrementCompactionCount: () => {
      compactionCount += 1;
    },
    getCompactionCount: () => compactionCount,
    noteCompactionTokensAfter: vi.fn(),
    getLastCompactionTokensAfter: vi.fn(() => undefined),
  } as unknown as EmbeddedAgentSubscribeContext;
}

function makeUsageSnapshot(totalTokens: number): AssistantUsageSnapshot {
  return {
    input: totalTokens,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens,
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      total: 0,
    },
  };
}

function makeAssistantUsageMessage(params: {
  text: string;
  usage: AssistantUsageSnapshot;
  timestamp?: number;
}): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text: params.text }],
    stopReason: "stop",
    usage: params.usage,
    ...(params.timestamp !== undefined ? { timestamp: params.timestamp } : {}),
  } as AgentMessage;
}

function makeCompactionSummaryMessage(timestamp?: number): AgentMessage {
  return {
    role: "compactionSummary",
    summary: "compressed",
    tokensBefore: 120_000,
    ...(timestamp !== undefined ? { timestamp } : {}),
  } as AgentMessage;
}

const completedCompactionEnd = () =>
  ({
    type: "compaction_end",
    reason: "threshold",
    outcome: { status: "completed", tokensBefore: 100, tokensAfter: 50, willRetry: false },
  }) as const;

function finishCompaction(ctx: EmbeddedAgentSubscribeContext): void {
  handleCompactionEnd(ctx, completedCompactionEnd());
}

function loggedInfoMetaAt(info: ReturnType<typeof vi.fn>, index: number): Record<string, unknown> {
  // Logging assertions need structured metadata, not just console strings.
  const [, meta] = info.mock.calls[index] ?? [];
  if (!meta || typeof meta !== "object" || Array.isArray(meta)) {
    throw new Error(`expected info metadata for call ${index + 1}`);
  }
  return meta as Record<string, unknown>;
}

function loggedInfoMessageAt(info: ReturnType<typeof vi.fn>, index: number): string {
  const [message] = info.mock.calls[index] ?? [];
  if (typeof message !== "string") {
    throw new Error(`expected info message for call ${index + 1}`);
  }
  return message;
}

describe("reconcileSessionStoreCompactionCountAfterSuccess", () => {
  it("raises the stored compaction count to the observed value", async () => {
    // Store count can lag the in-memory count after async writes; reconciliation
    // moves it forward without double-counting.
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-reconcile-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: "test-agent",
      configStore: storePath,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(2);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
  });

  it("does not double count when the store is already at or above the observed value", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-idempotent-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 3,
    });

    const nextCount = await reconcileSessionStoreCompactionCountAfterSuccess({
      sessionKey,
      agentId: "test-agent",
      configStore: storePath,
      observedCompactionCount: 2,
      now: 2_000,
    });

    expect(nextCount).toBe(3);
    expect(await readCompactionCount(storePath, sessionKey)).toBe(3);
  });
});

describe("compaction lifecycle logging", () => {
  it("logs lifecycle events at info level for gateway watch visibility", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-log-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 0,
    });
    const info = vi.fn();
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      info,
    });

    handleCompactionStart(ctx, {
      type: "compaction_start",
      reason: "threshold",
    });
    handleCompactionEnd(ctx, completedCompactionEnd());

    expect(loggedInfoMessageAt(info, 0)).toBe("embedded run auto-compaction start");
    const startMeta = loggedInfoMetaAt(info, 0);
    expect(startMeta.event).toBe("embedded_run_compaction_start");
    expect(startMeta.reason).toBe("threshold");
    expect(startMeta.runId).toBe("run-test");
    expect(startMeta.consoleMessage).toBe(
      "embedded run auto-compaction start: runId=run-test reason=threshold",
    );

    expect(loggedInfoMessageAt(info, 1)).toBe("embedded run auto-compaction complete");
    const endMeta = loggedInfoMetaAt(info, 1);
    expect(endMeta.event).toBe("embedded_run_compaction_end");
    expect(endMeta.reason).toBe("threshold");
    expect(endMeta.runId).toBe("run-test");
    expect(endMeta.completed).toBe(true);
    expect(endMeta.compactionCount).toBe(1);
    expect(endMeta.consoleMessage).toBe(
      "embedded run auto-compaction complete: runId=run-test reason=threshold compactionCount=1 willRetry=false",
    );
  });

  it("logs a benign manual skip at info", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-incomplete-log-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 0,
    });
    const info = vi.fn();
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      info,
    });

    handleCompactionStart(ctx, {
      type: "compaction_start",
      reason: "manual",
    });
    handleCompactionEnd(ctx, {
      type: "compaction_end",
      reason: "manual",
      outcome: { status: "skipped", reason: "Nothing to compact (session too small)" },
    });

    expect(loggedInfoMessageAt(info, 0)).toBe("embedded run manual compaction start");
    const startMeta = loggedInfoMetaAt(info, 0);
    expect(startMeta.event).toBe("embedded_run_compaction_start");
    expect(startMeta.reason).toBe("manual");
    expect(startMeta.runId).toBe("run-test");
    expect(startMeta.consoleMessage).toBe(
      "embedded run manual compaction start: runId=run-test reason=manual",
    );

    expect(loggedInfoMessageAt(info, 1)).toBe("embedded run manual compaction skipped");
    const endMeta = loggedInfoMetaAt(info, 1);
    expect(endMeta.event).toBe("embedded_run_compaction_end");
    expect(endMeta.reason).toBe("manual");
    expect(endMeta.outcome).toBe("skipped");
    expect(endMeta.runId).toBe("run-test");
    expect(endMeta.completed).toBe(false);
    expect(endMeta.reasonClass).toBe("no_compactable_entries");
    expect(endMeta.consoleMessage).toBe(
      "embedded run manual compaction skipped: runId=run-test reason=no_compactable_entries",
    );
  });

  it("warns with classified, bounded metadata for failed compaction", () => {
    const warn = vi.fn();
    const ctx = createCompactionContext({
      storePath: path.join(os.tmpdir(), "openclaw-compaction-failed-log", "sessions.json"),
      sessionKey: "main",
      initialCount: 0,
      warn,
    });
    const reason = `Provider unavailable: ${"provider detail ".repeat(100)}`;

    handleCompactionEnd(ctx, {
      type: "compaction_end",
      reason: "overflow",
      outcome: { status: "failed", reason },
    });

    expect(warn).toHaveBeenCalledOnce();
    const metadata = loggedInfoMetaAt(warn, 0);
    expect(metadata).toMatchObject({
      event: "embedded_run_compaction_end",
      reason: "overflow",
      outcome: "failed",
      reasonClass: "unknown",
      outcomeReason: reason,
    });
    expect(String(metadata.reasonDetail)).toHaveLength(100);
    expect(String(metadata.consoleMessage)).not.toContain("provider detail provider detail");
  });

  it("defaults an unknown synthetic compaction start to threshold logs", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-legacy-log-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 0,
    });
    const info = vi.fn();
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      info,
    });

    handleCompactionStart(ctx, {
      type: "compaction_start",
    });
    handleCompactionEnd(ctx, completedCompactionEnd());

    expect(loggedInfoMessageAt(info, 0)).toBe("embedded run auto-compaction start");
    const startMeta = loggedInfoMetaAt(info, 0);
    expect(startMeta.event).toBe("embedded_run_compaction_start");
    expect(startMeta.reason).toBe("threshold");
    expect(startMeta.runId).toBe("run-test");
    expect(startMeta.consoleMessage).toBe(
      "embedded run auto-compaction start: runId=run-test reason=threshold",
    );

    expect(loggedInfoMessageAt(info, 1)).toBe("embedded run auto-compaction complete");
    const endMeta = loggedInfoMetaAt(info, 1);
    expect(endMeta.event).toBe("embedded_run_compaction_end");
    expect(endMeta.reason).toBe("threshold");
    expect(endMeta.runId).toBe("run-test");
    expect(endMeta.completed).toBe(true);
    expect(endMeta.compactionCount).toBe(1);
    expect(endMeta.consoleMessage).toBe(
      "embedded run auto-compaction complete: runId=run-test reason=threshold compactionCount=1 willRetry=false",
    );
  });
});

describe("handleCompactionEnd", () => {
  it("reconciles the session store after a successful compaction end event", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-handler-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    await seedSessionStore({
      storePath,
      sessionKey,
      compactionCount: 1,
    });

    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 1,
    });

    handleCompactionEnd(ctx, completedCompactionEnd());

    await waitForCompactionCount({
      storePath,
      sessionKey,
      expected: 2,
    });

    expect(await readCompactionCount(storePath, sessionKey)).toBe(2);
    expect(ctx.noteCompactionTokensAfter).toHaveBeenCalledWith(50);
    expect(ctx.log.debug).toHaveBeenCalledWith(
      expect.stringContaining(
        "[compaction-attribution] end runId=run-test sessionKey=main trigger=budget outcome=compacted willRetry=false compactionCount.before=1 compactionCount.after=2 compactionCount.delta=1",
      ),
    );
  });

  it("emits terminal compaction attribution data for count deltas", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-attribution-"));
    const storePath = path.join(tmp, "sessions.json");
    await seedSessionStore({
      storePath,
      sessionKey: "main",
      compactionCount: 4,
    });
    const events: Array<{ stream: string; data: Record<string, unknown> }> = [];
    const ctx = createCompactionContext({
      storePath,
      sessionKey: "main",
      initialCount: 4,
      onAgentEvent: (event) => {
        events.push(event as { stream: string; data: Record<string, unknown> });
      },
    });

    handleCompactionEnd(ctx, {
      type: "compaction_end",
      reason: "overflow",
      outcome: { status: "completed", tokensBefore: 120, tokensAfter: 12, willRetry: true },
    });

    await waitForCompactionCount({
      storePath,
      sessionKey: "main",
      expected: 5,
    });

    expect(events).toContainEqual({
      stream: "compaction",
      data: {
        phase: "end",
        completed: true,
        willRetry: true,
        outcome: "completed",
        trigger: "overflow",
        sessionKey: "main",
        compactionCountBefore: 4,
        compactionCountAfter: 5,
        compactionCountDelta: 1,
      },
    });
  });

  it("clears stale assistant usage before compaction and preserves fresh usage after it", async () => {
    const staleUsage = makeUsageSnapshot(123_000);
    const freshUsage = makeUsageSnapshot(1_250);
    const messages = [
      makeAssistantUsageMessage({
        text: "pre-compaction answer",
        timestamp: 1_000,
        usage: staleUsage,
      }),
      makeCompactionSummaryMessage(2_000),
      { role: "user", content: "new question", timestamp: 3_000 },
      makeAssistantUsageMessage({
        text: "fresh answer",
        timestamp: 4_000,
        usage: freshUsage,
      }),
    ] as AgentMessage[];
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-usage-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      messages,
    });

    finishCompaction(ctx);

    const staleAssistant = messages[0] as Extract<AgentMessage, { role: "assistant" }>;
    const freshAssistant = messages[3] as Extract<AgentMessage, { role: "assistant" }>;
    expect(staleAssistant.usage).toEqual(makeZeroUsageSnapshot());
    expect(freshAssistant.usage).toEqual(freshUsage);
  });

  it("preserves live assistant usage when compaction fails or is aborted", async () => {
    // A failed/aborted end never rewrote history; zeroing usage here would
    // disable the persistent-error compaction trigger for degraded sessions.
    const failureEnds = [
      { name: "failed", outcome: { status: "failed", reason: "summary failed" } },
      { name: "aborted", outcome: { status: "aborted" } },
    ] as const;
    for (const failure of failureEnds) {
      const liveUsage = makeUsageSnapshot(123_000);
      const messages = [
        makeAssistantUsageMessage({
          text: `live answer (${failure.name})`,
          timestamp: 1_000,
          usage: liveUsage,
        }),
      ] as AgentMessage[];
      const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-usage-keep-"));
      const storePath = path.join(tmp, "sessions.json");
      const ctx = createCompactionContext({
        storePath,
        sessionKey: "main",
        initialCount: 0,
        messages,
      });

      handleCompactionEnd(ctx, {
        type: "compaction_end",
        reason: "threshold",
        outcome: failure.outcome,
      });

      const liveAssistant = messages[0] as Extract<AgentMessage, { role: "assistant" }>;
      expect(liveAssistant.usage, failure.name).toEqual(liveUsage);
    }
  });

  it("uses the compaction timestamp for summary-first transcripts", async () => {
    const staleUsage = makeUsageSnapshot(120_000);
    const freshUsage = makeUsageSnapshot(1_250);
    const compactionTimestamp = 2_000;
    const messages = [
      makeCompactionSummaryMessage(compactionTimestamp),
      makeAssistantUsageMessage({
        text: "kept pre-compaction answer",
        timestamp: compactionTimestamp - 1,
        usage: staleUsage,
      }),
      makeAssistantUsageMessage({
        text: "fresh answer",
        timestamp: compactionTimestamp + 1,
        usage: freshUsage,
      }),
    ] as AgentMessage[];
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-summary-first-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      messages,
    });

    finishCompaction(ctx);

    const staleAssistant = messages[1] as Extract<AgentMessage, { role: "assistant" }>;
    const freshAssistant = messages[2] as Extract<AgentMessage, { role: "assistant" }>;
    expect(staleAssistant.usage).toEqual(makeZeroUsageSnapshot());
    expect(freshAssistant.usage).toEqual(freshUsage);
  });

  it("uses index fallback only for legacy transcripts without timestamps", async () => {
    const staleUsage = makeUsageSnapshot(120_000);
    const freshUsage = makeUsageSnapshot(1_250);
    const messages = [
      makeAssistantUsageMessage({
        text: "legacy pre-compaction answer",
        usage: staleUsage,
      }),
      makeCompactionSummaryMessage(),
      makeAssistantUsageMessage({
        text: "legacy fresh answer",
        usage: freshUsage,
      }),
    ] as AgentMessage[];
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-legacy-usage-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      messages,
    });

    finishCompaction(ctx);

    const staleAssistant = messages[0] as Extract<AgentMessage, { role: "assistant" }>;
    const freshAssistant = messages[2] as Extract<AgentMessage, { role: "assistant" }>;
    expect(staleAssistant.usage).toEqual(makeZeroUsageSnapshot());
    expect(freshAssistant.usage).toEqual(freshUsage);
  });

  it("clears assistant usage when final compaction has no summary marker", async () => {
    const firstUsage = makeUsageSnapshot(120_000);
    const secondUsage = makeUsageSnapshot(1_250);
    const messages = [
      makeAssistantUsageMessage({
        text: "first answer before marker-free compaction",
        usage: firstUsage,
      }),
      { role: "user", content: "new question" },
      makeAssistantUsageMessage({
        text: "second answer before marker-free compaction",
        usage: secondUsage,
      }),
    ] as AgentMessage[];
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-no-summary-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      messages,
    });

    finishCompaction(ctx);

    const firstAssistant = messages[0] as Extract<AgentMessage, { role: "assistant" }>;
    const secondAssistant = messages[2] as Extract<AgentMessage, { role: "assistant" }>;
    expect(firstAssistant.usage).toEqual(makeZeroUsageSnapshot());
    expect(secondAssistant.usage).toEqual(makeZeroUsageSnapshot());
  });

  it("does not let legacy index fallback erase timestamp-fresh usage", async () => {
    const freshUsage = makeUsageSnapshot(1_250);
    const messages = [
      makeAssistantUsageMessage({
        text: "fresh answer written before delayed summary",
        timestamp: 3_000,
        usage: freshUsage,
      }),
      makeCompactionSummaryMessage(2_000),
    ] as AgentMessage[];
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-compaction-timestamp-fresh-"));
    const storePath = path.join(tmp, "sessions.json");
    const sessionKey = "main";
    const ctx = createCompactionContext({
      storePath,
      sessionKey,
      initialCount: 0,
      messages,
    });

    finishCompaction(ctx);

    const freshAssistant = messages[0] as Extract<AgentMessage, { role: "assistant" }>;
    expect(freshAssistant.usage).toEqual(freshUsage);
  });
});
