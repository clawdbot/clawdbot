/**
 * Classifier-code emission on volitional-compaction warn / error paths.
 *
 * Pins that every journal line written on the resolved-failure and
 * background-error branches carries the
 * structured `code=<classifyCompactionReason(...)>` field alongside the
 * raw reason. Journal queries and /status drill-downs shouldn't depend
 * on raw-string grep for the failure taxonomy.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Capture every subsystem logger method the tool calls so assertions
// can read back the exact message text emitted. vi.mock is hoisted, so
// this file is scoped to the emission tests — the broader
// request-compaction-tool.test.ts runs without the logger mock.
const capturedLogs: Array<{ level: string; message: string }> = [];
vi.mock("../../logging/subsystem.js", () => {
  const record =
    (level: string) =>
    (message: string): void => {
      capturedLogs.push({ level, message });
    };
  const logger = {
    subsystem: "test",
    isEnabled: () => true,
    trace: record("trace"),
    debug: record("debug"),
    info: record("info"),
    warn: record("warn"),
    error: record("error"),
    fatal: record("fatal"),
    raw: record("raw"),
    child: () => logger,
  };
  return {
    createSubsystemLogger: () => logger,
  };
});

import {
  _resetGuardState,
  _resetVolitionalCounts,
  createRequestCompactionTool,
  type RequestCompactionToolOpts,
} from "./request-compaction-tool.js";

const SESSION_KEY = "agent:main:discord:channel:test-session";
const SESSION_ID = "test-session-205";
const REASON = "context pressure at 92%, stage set for compaction.";

function buildOpts(overrides: Partial<RequestCompactionToolOpts> = {}): RequestCompactionToolOpts {
  return {
    agentSessionKey: SESSION_KEY,
    sessionId: SESSION_ID,
    getContextUsage: () => 0.85,
    triggerCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
    enqueueSystemEvent: vi.fn(),
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  // triggerCompaction is fire-and-forget (.then().finally()); settle the promise chain.
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
  await new Promise((resolve) => {
    setImmediate(resolve);
  });
}

describe("request_compaction tool — classifier emission", () => {
  beforeEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
    capturedLogs.length = 0;
  });

  afterEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
    vi.restoreAllMocks();
  });

  it("warn log on resolve-with-failure includes code=<classifier-result> and the raw reason", async () => {
    const tool = createRequestCompactionTool(
      buildOpts({
        triggerCompaction: vi.fn(async () => ({
          ok: false,
          compacted: false,
          reason: "Unknown model openai/gpt-5.4",
        })),
      }),
    );

    await tool.execute("call-warn-unknown-model", { reason: REASON });
    await flushMicrotasks();

    const warn = capturedLogs.find(
      (l) => l.level === "warn" && l.message.includes("[request_compaction:resolved-failure]"),
    );
    expect(warn, "resolved-failure warn log should fire").toBeDefined();
    expect(warn!.message).toContain("code=unknown_model");
    expect(warn!.message).toContain("reason=Unknown model openai/gpt-5.4");
  });

  it("warn log on a generic Cancellation message emits code (currently 'unknown' per classifier taxonomy)", async () => {
    const tool = createRequestCompactionTool(
      buildOpts({
        triggerCompaction: vi.fn(async () => ({
          ok: false,
          compacted: false,
          reason: "Compaction cancelled",
        })),
      }),
    );

    await tool.execute("call-warn-cancelled", { reason: REASON });
    await flushMicrotasks();

    const warn = capturedLogs.find(
      (l) => l.level === "warn" && l.message.includes("[request_compaction:resolved-failure]"),
    );
    expect(warn, "resolved-failure warn log should fire for cancellation").toBeDefined();
    // 'cancelled' has no dedicated band in classifyCompactionReason today; asserting
    // the code= field is present (not absent) pins the emission contract so future
    // classifier extensions (cancelled → "cancelled") don't regress silently.
    expect(warn!.message).toMatch(/\bcode=\w+\b/);
  });

  it("error log on promise rejection includes code=<classifier-result>", async () => {
    const tool = createRequestCompactionTool(
      buildOpts({
        triggerCompaction: vi.fn(async () => {
          throw new Error("Unknown model openai/gpt-5.4");
        }),
      }),
    );

    await tool.execute("call-error-unknown-model", { reason: REASON });
    await flushMicrotasks();

    const err = capturedLogs.find(
      (l) => l.level === "error" && l.message.includes("[request_compaction:background-error]"),
    );
    expect(err, "background-error log should fire").toBeDefined();
    expect(err!.message).toContain("code=unknown_model");
    expect(err!.message).toContain("error=Unknown model openai/gpt-5.4");
  });

  it("info log on legit skip (below threshold) does NOT fire the warn path", async () => {
    const tool = createRequestCompactionTool(
      buildOpts({
        triggerCompaction: vi.fn(async () => ({
          ok: true,
          compacted: false,
          reason: "nothing to compact",
        })),
      }),
    );

    await tool.execute("call-info-skip", { reason: REASON });
    await flushMicrotasks();

    const info = capturedLogs.find(
      (l) => l.level === "info" && l.message.includes("[request_compaction:resolved-skip]"),
    );
    expect(info, "resolved-skip info log should fire for legit skip").toBeDefined();

    const warn = capturedLogs.find(
      (l) => l.level === "warn" && l.message.includes("[request_compaction:resolved-failure]"),
    );
    expect(warn, "warn should NOT fire on legit skip").toBeUndefined();
  });
});
