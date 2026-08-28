/**
 * Tests for volitional compaction counter truthfulness and log-level correctness.
 *
 * Regression coverage for the volitional compaction outcome-accounting fix arc:
 * - Counter increments ONLY on {ok:true, compacted:true}
 * - Legit-skip reasons (nothing to compact, below threshold, etc.) log at info
 * - Real failures (unknown model, provider errors) log at warn
 *
 * See: docs/design/continue-work-signal-v2.md
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  _resetGuardState,
  _resetVolitionalCounts,
  createRequestCompactionTool,
  getVolitionalCompactionCount,
  type RequestCompactionToolOpts,
} from "./request-compaction-tool.js";

// ---------------------------------------------------------------------------
// Logger mock setup
// ---------------------------------------------------------------------------

const logMocks = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "continuation/request-compaction",
    isEnabled: () => true,
    debug: (...args: unknown[]) => logMocks.debug(...args),
    info: (...args: unknown[]) => logMocks.info(...args),
    warn: (...args: unknown[]) => logMocks.warn(...args),
    error: (...args: unknown[]) => logMocks.error(...args),
    child: () => ({
      debug: logMocks.debug,
      info: logMocks.info,
      warn: logMocks.warn,
      error: logMocks.error,
    }),
  }),
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

const SESSION_KEY = "agent:main:discord:channel:volitional-test";
const SESSION_ID = "volitional-test-session-id";
const TURN_REASON = "context pressure at 85%, working state evacuated";

function buildOpts(overrides: Partial<RequestCompactionToolOpts> = {}): RequestCompactionToolOpts {
  return {
    agentSessionKey: SESSION_KEY,
    sessionId: SESSION_ID,
    getContextUsage: () => 0.85, // Above 70% threshold
    triggerCompaction: vi.fn(async () => ({ ok: true, compacted: true })),
    ...overrides,
  };
}

async function executeTool(
  opts: RequestCompactionToolOpts,
): Promise<{ status: string; [key: string]: unknown }> {
  const tool = createRequestCompactionTool(opts);
  const result = await tool.execute("call-id", { reason: TURN_REASON });
  const content = (result as { content: Array<{ type: string; text: string }> }).content;
  return JSON.parse(content[0]?.text ?? "{}");
}

/**
 * Drain microtask queue to let fire-and-forget promises resolve.
 * The triggerCompaction callback is invoked via void promise, so we need
 * to give it time to complete before checking side effects.
 */
async function drainMicrotasks(): Promise<void> {
  // Multiple awaits to ensure nested promises resolve
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

// ---------------------------------------------------------------------------
// Tests: Counter truthfulness
// ---------------------------------------------------------------------------

describe("volitional compaction counter truthfulness", () => {
  beforeEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
    vi.restoreAllMocks();
  });

  it("increments counter on {ok:true, compacted:true}", async () => {
    const triggerCompaction = vi.fn<RequestCompactionToolOpts["triggerCompaction"]>(async () => ({
      ok: true,
      compacted: true,
    }));
    const countBefore = getVolitionalCompactionCount(SESSION_KEY);

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const countAfter = getVolitionalCompactionCount(SESSION_KEY);
    expect(countAfter).toBe(countBefore + 1);
    expect(triggerCompaction).toHaveBeenCalledTimes(1);
  });

  it("threads run and diag attribution from enqueue to background compaction", async () => {
    const triggerCompaction = vi.fn<RequestCompactionToolOpts["triggerCompaction"]>(async () => ({
      ok: true,
      compacted: true,
    }));

    const result = await executeTool(
      buildOpts({
        runId: "run-volitional-1",
        triggerCompaction,
      }),
    );
    await drainMicrotasks();

    const request = triggerCompaction.mock.calls[0]?.[0];
    expect(request).toBeDefined();
    if (!request) {
      throw new Error("expected request_compaction attribution payload");
    }
    expect(request).toMatchObject({
      sessionKey: SESSION_KEY,
      sessionId: SESSION_ID,
      runId: "run-volitional-1",
      trigger: "volitional",
      reason: TURN_REASON,
      contextUsage: 0.85,
    });
    expect(request.diagId).toMatch(/^cmp-/u);
    expect(result).toMatchObject({
      status: "compaction_requested",
      compactionRequestId: request.diagId,
      trigger: "volitional",
    });
    expect(logMocks.info).toHaveBeenCalledWith(
      expect.stringContaining(
        `[request_compaction:enqueuing] session=${SESSION_KEY} runId=run-volitional-1 diagId=${request.diagId} trigger=volitional`,
      ),
    );
    expect(logMocks.info).toHaveBeenCalledWith(
      expect.stringContaining(
        `[request_compaction:resolved-success] session=${SESSION_KEY} runId=run-volitional-1 diagId=${request.diagId} trigger=volitional outcome=compacted`,
      ),
    );
  });

  it("does NOT increment counter on {ok:true, compacted:false, reason:'nothing to compact'}", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "Nothing to compact (session too small)",
    }));
    const countBefore = getVolitionalCompactionCount(SESSION_KEY);

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const countAfter = getVolitionalCompactionCount(SESSION_KEY);
    expect(countAfter).toBe(countBefore); // No increment
  });

  it("does NOT increment counter on {ok:true, compacted:false, reason:'below threshold'}", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "Below threshold for compaction",
    }));
    const countBefore = getVolitionalCompactionCount(SESSION_KEY);

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const countAfter = getVolitionalCompactionCount(SESSION_KEY);
    expect(countAfter).toBe(countBefore);
  });

  it("does NOT increment counter on {ok:true, compacted:false, reason:'already compacted'}", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "Already compacted recently",
    }));
    const countBefore = getVolitionalCompactionCount(SESSION_KEY);

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const countAfter = getVolitionalCompactionCount(SESSION_KEY);
    expect(countAfter).toBe(countBefore);
  });

  it("does NOT increment counter on {ok:true, compacted:false, reason:'no real conversation messages'}", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "No real conversation messages to compact",
    }));
    const countBefore = getVolitionalCompactionCount(SESSION_KEY);

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const countAfter = getVolitionalCompactionCount(SESSION_KEY);
    expect(countAfter).toBe(countBefore);
  });

  it("does NOT increment counter on {ok:false, reason:'unknown model'}", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "Unknown model: openai/gpt-5.4",
    }));
    const countBefore = getVolitionalCompactionCount(SESSION_KEY);

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const countAfter = getVolitionalCompactionCount(SESSION_KEY);
    expect(countAfter).toBe(countBefore);
  });

  it("does NOT increment counter on provider_error_4xx failures", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "Provider returned 401 Unauthorized",
    }));
    const countBefore = getVolitionalCompactionCount(SESSION_KEY);

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const countAfter = getVolitionalCompactionCount(SESSION_KEY);
    expect(countAfter).toBe(countBefore);
  });

  it("does NOT increment counter on provider_error_5xx failures", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "Provider returned 503 Service Unavailable",
    }));
    const countBefore = getVolitionalCompactionCount(SESSION_KEY);

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const countAfter = getVolitionalCompactionCount(SESSION_KEY);
    expect(countAfter).toBe(countBefore);
  });

  it("does NOT increment counter on freeform failure reasons", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "Something went wrong unexpectedly",
    }));
    const countBefore = getVolitionalCompactionCount(SESSION_KEY);

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const countAfter = getVolitionalCompactionCount(SESSION_KEY);
    expect(countAfter).toBe(countBefore);
  });

  it("accumulates counter correctly across multiple successful compactions", async () => {
    // Use different session keys to avoid rate limiting
    const sessionKey1 = `${SESSION_KEY}-1`;
    const sessionKey2 = `${SESSION_KEY}-2`;

    const triggerCompaction1 = vi.fn(async () => ({ ok: true, compacted: true }));
    const triggerCompaction2 = vi.fn(async () => ({ ok: true, compacted: true }));

    await executeTool(
      buildOpts({ agentSessionKey: sessionKey1, triggerCompaction: triggerCompaction1 }),
    );
    await drainMicrotasks();

    await executeTool(
      buildOpts({ agentSessionKey: sessionKey2, triggerCompaction: triggerCompaction2 }),
    );
    await drainMicrotasks();

    expect(getVolitionalCompactionCount(sessionKey1)).toBe(1);
    expect(getVolitionalCompactionCount(sessionKey2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Tests: Log level correctness per outcome
// ---------------------------------------------------------------------------

describe("volitional compaction log levels", () => {
  beforeEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
    vi.restoreAllMocks();
  });

  it("logs at INFO level with [resolved-skip] anchor for 'nothing to compact'", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "Nothing to compact (session too small)",
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    expect(logMocks.info).toHaveBeenCalled();
    const infoCall = logMocks.info.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-skip]"),
    );
    expect(infoCall).toBeDefined();
    expect(logMocks.warn).not.toHaveBeenCalledWith(
      expect.stringContaining("[request_compaction:resolved-skip]"),
    );
  });

  it("logs at INFO level with [resolved-skip] anchor for 'below threshold'", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "Below threshold for compaction",
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    expect(logMocks.info).toHaveBeenCalled();
    const infoCall = logMocks.info.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-skip]"),
    );
    expect(infoCall).toBeDefined();
  });

  it("logs at INFO level with [resolved-skip] anchor for 'already compacted'", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "Already compacted recently",
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    expect(logMocks.info).toHaveBeenCalled();
    const infoCall = logMocks.info.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-skip]"),
    );
    expect(infoCall).toBeDefined();
  });

  it("logs at WARN level with [resolved-failure] anchor for 'unknown model'", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "Unknown model: openai/gpt-5.4",
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    expect(logMocks.warn).toHaveBeenCalled();
    const warnCall = logMocks.warn.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-failure]"),
    );
    expect(warnCall).toBeDefined();
    expect(logMocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("[request_compaction:resolved-failure]"),
    );
  });

  it("logs at WARN level with [resolved-failure] anchor for provider 4xx errors", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "Provider returned 401 Unauthorized",
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const warnCall = logMocks.warn.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-failure]"),
    );
    expect(warnCall).toBeDefined();
  });

  it("logs at WARN level with [resolved-failure] anchor for provider 5xx errors", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "Provider returned 503 Service Unavailable",
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const warnCall = logMocks.warn.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-failure]"),
    );
    expect(warnCall).toBeDefined();
  });

  it("logs at WARN level for {ok:true, compacted:false} with non-legit reason", async () => {
    // This is the edge case: ok=true but compacted=false with a reason that
    // is NOT a legitimate skip (e.g., some unexpected error message)
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "Unexpected internal error occurred",
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const warnCall = logMocks.warn.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-failure]"),
    );
    expect(warnCall).toBeDefined();
  });

  it("logs at ERROR level with [background-error] anchor when triggerCompaction throws", async () => {
    const triggerCompaction = vi.fn(async () => {
      throw new Error("Network timeout during compaction");
    });

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    expect(logMocks.error).toHaveBeenCalled();
    const errorCall = logMocks.error.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:background-error]"),
    );
    expect(errorCall).toBeDefined();
  });

  it("does not log skip/failure for successful compaction", async () => {
    const triggerCompaction = vi.fn(async () => ({ ok: true, compacted: true }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    // Should not have resolved-skip or resolved-failure logs
    const skipCall = logMocks.info.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-skip]"),
    );
    const failCall = logMocks.warn.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-failure]"),
    );
    expect(skipCall).toBeUndefined();
    expect(failCall).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Tests: isLegitSkipReason boundary cases
// ---------------------------------------------------------------------------

describe("isLegitSkipReason boundary cases", () => {
  beforeEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
    vi.clearAllMocks();
  });

  afterEach(() => {
    _resetGuardState();
    _resetVolitionalCounts();
    vi.restoreAllMocks();
  });

  it("treats case-insensitive 'NOTHING TO COMPACT' as legit skip", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "NOTHING TO COMPACT",
    }));
    const countBefore = getVolitionalCompactionCount(SESSION_KEY);

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    // Should be treated as legit skip: no counter increment, info log
    expect(getVolitionalCompactionCount(SESSION_KEY)).toBe(countBefore);
    const infoCall = logMocks.info.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-skip]"),
    );
    expect(infoCall).toBeDefined();
  });

  it("treats reason with extra whitespace as legit skip", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "  nothing to compact  ",
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const infoCall = logMocks.info.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-skip]"),
    );
    expect(infoCall).toBeDefined();
  });

  it("does NOT treat partial match 'nothing' as legit skip", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: true,
      compacted: false,
      reason: "nothing",
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    // Should be treated as failure, not skip
    const warnCall = logMocks.warn.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-failure]"),
    );
    expect(warnCall).toBeDefined();
  });

  it("handles undefined reason as non-legit", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: undefined,
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const warnCall = logMocks.warn.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-failure]"),
    );
    expect(warnCall).toBeDefined();
  });

  it("handles empty string reason as non-legit", async () => {
    const triggerCompaction = vi.fn(async () => ({
      ok: false,
      compacted: false,
      reason: "",
    }));

    await executeTool(buildOpts({ triggerCompaction }));
    await drainMicrotasks();

    const warnCall = logMocks.warn.mock.calls.find((call) =>
      String(call[0]).includes("[request_compaction:resolved-failure]"),
    );
    expect(warnCall).toBeDefined();
  });
});
