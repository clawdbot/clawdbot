// Run diagnostic event tests cover emitted diagnostics from isolated cron runs.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  onDiagnosticEvent,
  onInternalDiagnosticEvent,
  resetDiagnosticEventsForTest,
} from "../../infra/diagnostic-events.js";
import { resetDiagnosticStateForTest } from "../../logging/diagnostic.js";

vi.mock("../../agents/auth-profiles/source-check.js", () => ({
  hasAnyAuthProfileStoreSource: vi.fn(() => false),
}));

import {
  clearFastTestEnv,
  loadRunCronIsolatedAgentTurn,
  makeCronSession,
  makeCronSessionEntry,
  resetRunCronIsolatedAgentTurnHarness,
  resolveCronSessionMock,
  restoreFastTestEnv,
  runWithModelFallbackMock,
} from "./run.test-harness.js";

const runCronIsolatedAgentTurn = await loadRunCronIsolatedAgentTurn();

function makeParams() {
  return {
    cfg: {},
    deps: {} as never,
    job: {
      id: "cron-diag-events",
      name: "Diag Events",
      enabled: true,
      createdAtMs: 0,
      updatedAtMs: 0,
      schedule: { kind: "cron" as const, expr: "0 * * * *", tz: "UTC" },
      sessionTarget: "isolated" as const,
      state: {},
      wakeMode: "next-heartbeat" as const,
      payload: { kind: "agentTurn" as const, message: "run task" },
    },
    message: "run task",
    sessionKey: "cron:diag-events",
  };
}

type EventRecord = {
  type: string;
  sessionKey?: string;
  sessionId?: string;
  source?: string;
  state?: string;
  outcome?: string;
};

describe("runCronIsolatedAgentTurn diagnostic events", () => {
  let previousFastTestEnv: string | undefined;

  beforeEach(() => {
    previousFastTestEnv = clearFastTestEnv();
    resetRunCronIsolatedAgentTurnHarness();
    resetDiagnosticStateForTest();
    resetDiagnosticEventsForTest();
  });

  afterEach(() => {
    restoreFastTestEnv(previousFastTestEnv);
  });

  it("emits a paired queued/processing/idle/processed lifecycle for an isolated cron run", async () => {
    const events: EventRecord[] = [];
    const unsubscribe = onDiagnosticEvent((evt) => {
      const e = evt as EventRecord;
      if (
        e.type === "message.queued" ||
        e.type === "session.state" ||
        e.type === "message.processed"
      ) {
        events.push(e);
      }
    });

    try {
      const result = await runCronIsolatedAgentTurn(makeParams());
      expect(result.status).toBe("ok");
    } finally {
      unsubscribe();
    }

    const ofType = (type: string) => events.filter((e) => e.type === type);
    expect(ofType("message.queued")).toHaveLength(1);
    expect(ofType("message.queued")[0]?.source).toBe("cron-isolated");

    const stateEvents = ofType("session.state");
    expect(stateEvents.map((e) => e.state)).toEqual(["processing", "idle"]);

    const processed = ofType("message.processed");
    expect(processed).toHaveLength(1);
    expect(processed[0]?.outcome).toBe("completed");

    const queuedKey = ofType("message.queued")[0]?.sessionKey;
    expect(queuedKey).toBeTruthy();
    for (const e of events) {
      expect(e.sessionKey).toBe(queuedKey);
    }

    const orderedTypes = events.map((e) => e.type);
    expect(orderedTypes[0]).toBe("message.queued");
    expect(orderedTypes[orderedTypes.length - 1]).toBe("message.processed");
    expect(orderedTypes).toContain("session.state");
  });

  it("emits no lifecycle events when diagnostics.enabled is false", async () => {
    const events: EventRecord[] = [];
    const unsubscribe = onDiagnosticEvent((evt) => {
      const e = evt as EventRecord;
      if (
        e.type === "message.queued" ||
        e.type === "session.state" ||
        e.type === "message.processed"
      ) {
        events.push(e);
      }
    });

    try {
      const params = makeParams();
      params.cfg = { diagnostics: { enabled: false } } as never;
      const result = await runCronIsolatedAgentTurn(params);
      expect(result.status).toBe("ok");
    } finally {
      unsubscribe();
    }

    expect(events).toEqual([]);
  });

  it("emits final lifecycle events under the adopted run session id", async () => {
    resolveCronSessionMock.mockReturnValue(
      makeCronSession({
        sessionEntry: makeCronSessionEntry({
          sessionId: "fallback-run-session",
          sessionFile: "/tmp/fallback-run-session.jsonl",
        }),
      }),
    );
    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "test output" }],
        meta: {
          agentMeta: {
            sessionId: "persisted-run-session",
            sessionFile: "/tmp/persisted-run-session.jsonl",
            usage: { input: 10, output: 20 },
          },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
    });

    const events: EventRecord[] = [];
    const unsubscribe = onDiagnosticEvent((evt) => {
      const e = evt as EventRecord;
      if (
        e.type === "message.queued" ||
        e.type === "session.state" ||
        e.type === "message.processed"
      ) {
        events.push(e);
      }
    });

    try {
      const result = await runCronIsolatedAgentTurn(makeParams());
      expect(result.status).toBe("ok");
    } finally {
      unsubscribe();
    }

    expect(events).toMatchObject([
      { type: "message.queued", sessionId: "fallback-run-session" },
      { type: "session.state", state: "processing", sessionId: "fallback-run-session" },
      { type: "session.state", state: "idle", sessionId: "persisted-run-session" },
      { type: "message.processed", sessionId: "persisted-run-session" },
    ]);
  });

  it("emits model.usage for cron runs with billed aggregate usage", async () => {
    const usageEvents: Array<{
      type: string;
      sessionKey?: string;
      sessionId?: string;
      channel?: string;
      agentId?: string;
      provider?: string;
      model?: string;
      usage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
        promptTokens?: number;
        total?: number;
      };
      lastCallUsage?: {
        input?: number;
        output?: number;
        cacheRead?: number;
        cacheWrite?: number;
      };
      context?: { limit?: number; used?: number };
      durationMs?: number;
    }> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "model.usage") {
        usageEvents.push(evt);
      }
    });

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "test output" }],
        meta: {
          agentMeta: {
            sessionId: "cron-usage-session",
            sessionFile: "/tmp/cron-usage-session.jsonl",
            provider: "test-provider",
            model: "test-model",
            usage: { input: 50, output: 100, cacheRead: 7, cacheWrite: 3, total: 55 },
            lastCallUsage: { input: 40, output: 5, cacheRead: 6, cacheWrite: 4 },
          },
        },
      },
      provider: "fallback-provider",
      model: "fallback-model",
    });

    try {
      const result = await runCronIsolatedAgentTurn(makeParams());
      expect(result.status).toBe("ok");
    } finally {
      unsubscribe();
    }

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: "model.usage",
      sessionKey: "agent:default:cron:diag-events:run:test-session-id",
      sessionId: "cron-usage-session",
      channel: "cron",
      agentId: "default",
      provider: "test-provider",
      model: "test-model",
      usage: {
        input: 50,
        output: 100,
        cacheRead: 7,
        cacheWrite: 3,
        promptTokens: 60,
        total: 160,
      },
      lastCallUsage: { input: 40, output: 5, cacheRead: 6, cacheWrite: 4 },
      context: { limit: 128000, used: 50 },
    });
    expect(usageEvents[0]?.durationMs).toEqual(expect.any(Number));
    expect(usageEvents[0]?.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("does not emit model.usage when diagnostics are disabled", async () => {
    const usageEvents: Array<{ type: string }> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "model.usage") {
        usageEvents.push(evt);
      }
    });

    try {
      const params = makeParams();
      params.cfg = { diagnostics: { enabled: false } } as never;
      const result = await runCronIsolatedAgentTurn(params);
      expect(result.status).toBe("ok");
    } finally {
      unsubscribe();
    }

    expect(usageEvents).toEqual([]);
  });

  it("emits billed model usage when the cron run is aborted before finalization", async () => {
    const abortController = new AbortController();
    const usageEvents: Array<{
      type: string;
      sessionId?: string;
      usage?: { input?: number; output?: number; total?: number };
    }> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "model.usage") {
        usageEvents.push(evt);
      }
    });

    runWithModelFallbackMock.mockImplementationOnce(async () => {
      abortController.abort("cron: job execution timed out");
      return {
        result: {
          payloads: [{ text: "late output" }],
          meta: {
            agentMeta: {
              sessionId: "late-session",
              usage: { input: 50, output: 10, total: 60 },
            },
          },
        },
        provider: "openai",
        model: "gpt-5.4",
      };
    });

    try {
      const result = await runCronIsolatedAgentTurn({
        ...makeParams(),
        abortSignal: abortController.signal,
      });
      expect(result.status).toBe("error");
      expect(result.error).toBe("cron: job execution timed out");
    } finally {
      unsubscribe();
    }

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]).toMatchObject({
      type: "model.usage",
      sessionId: "test-session-id",
      usage: { input: 50, output: 10, total: 60 },
    });
  });

  it("preserves total-only model usage in cron diagnostics", async () => {
    const usageEvents: Array<{
      type: string;
      usage?: { input?: number; output?: number; promptTokens?: number; total?: number };
      costUsd?: number;
    }> = [];
    const unsubscribe = onInternalDiagnosticEvent((evt) => {
      if (evt.type === "model.usage") {
        usageEvents.push(evt);
      }
    });

    runWithModelFallbackMock.mockResolvedValue({
      result: {
        payloads: [{ text: "test output" }],
        meta: {
          agentMeta: {
            usage: { total: 42 },
          },
        },
      },
      provider: "openai",
      model: "gpt-5.4",
    });

    try {
      const result = await runCronIsolatedAgentTurn(makeParams());
      expect(result.status).toBe("ok");
    } finally {
      unsubscribe();
    }

    expect(usageEvents).toHaveLength(1);
    expect(usageEvents[0]?.usage).toMatchObject({
      input: 0,
      output: 0,
      promptTokens: 0,
      total: 42,
    });
    expect(usageEvents[0]?.costUsd).toBeUndefined();
  });
});
