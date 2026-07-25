// Subagent registry helper tests cover orphan reconciliation and compact logging
// for announce delivery give-up paths.
import { promises as fs } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../runtime.js";
import {
  backfillCollectorArchiveAtMs,
  capFrozenResultText,
  logAnnounceGiveUp,
  reconcileOrphanedRestoredRuns,
  reconcileOrphanedRun,
  resolveSubagentArchiveAtMs,
  safeRemoveAttachmentsDir,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";
import { updateSwarmCollectorCompletion } from "./swarm-collector.js";

function createRunEntry(overrides: Partial<SubagentRunRecord> = {}): SubagentRunRecord {
  return {
    runId: "run-1",
    childSessionKey: "agent:main:subagent:child",
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    task: "finish the task",
    cleanup: "keep",
    retainAttachmentsOnKeep: true,
    createdAt: 500,
    startedAt: 1_000,
    ...overrides,
  };
}

describe("capFrozenResultText", () => {
  it("preserves a valid UTF-8 prefix within the frozen-result byte budget", () => {
    const result = capFrozenResultText("😀".repeat(25_601));

    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100 * 1024);
    expect(result).not.toContain("�");
    expect(result).toContain("[truncated: frozen completion output exceeded 100KB");
  });
});

describe("resolveSubagentArchiveAtMs", () => {
  const cfg = { agents: { defaults: { subagents: { archiveAfterMinutes: 5 } } } };

  it("defers collector retention until terminal completion", () => {
    for (const cleanup of ["keep", "delete"] as const) {
      expect(
        resolveSubagentArchiveAtMs({
          cfg,
          now: 1_000,
          spawnMode: "run",
          cleanup,
          collect: true,
        }),
      ).toBeUndefined();
    }
  });

  it("starts collector retention when terminal completion is frozen", () => {
    const entry = createRunEntry({
      collect: true,
      endedAt: 2_000,
      outcome: { status: "ok" },
      completion: { required: false, resultText: "done", capturedAt: 2_000 },
    });

    expect(updateSwarmCollectorCompletion(entry, cfg)).toBe(true);
    expect(entry.collectorCompletion).toEqual({ status: "done" });
    expect(entry.archiveAtMs).toBe(302_000);
  });

  it("starts retention when a delayed result first becomes waitable", () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const entry = createRunEntry({
      collect: true,
      endedAt: 2_000,
      outcome: { status: "ok" },
      completion: { required: false, resultText: "done" },
    });

    expect(updateSwarmCollectorCompletion(entry, cfg)).toBe(true);
    expect(entry.completion?.capturedAt).toBe(10_000);
    expect(entry.archiveAtMs).toBe(310_000);
    vi.useRealTimers();
  });

  it("backfills legacy collectors from their terminal time", () => {
    const entry = createRunEntry({
      collect: true,
      endedAt: 2_000,
      archiveAtMs: 10_000,
    });

    expect(backfillCollectorArchiveAtMs(entry, cfg)).toBe(true);
    expect(entry.archiveAtMs).toBe(302_000);
    expect(backfillCollectorArchiveAtMs(entry, cfg)).toBe(false);
  });

  it("clears stale deadlines from active, persistent, or retention-disabled collectors", () => {
    const active = createRunEntry({ collect: true, archiveAtMs: 10_000 });
    expect(backfillCollectorArchiveAtMs(active, cfg)).toBe(true);
    expect(active.archiveAtMs).toBeUndefined();

    const persistent = createRunEntry({
      collect: true,
      spawnMode: "session",
      endedAt: 2_000,
      archiveAtMs: 10_000,
    });
    expect(backfillCollectorArchiveAtMs(persistent, cfg)).toBe(true);
    expect(persistent.archiveAtMs).toBeUndefined();

    const completed = createRunEntry({ collect: true, endedAt: 2_000, archiveAtMs: 10_000 });
    expect(
      backfillCollectorArchiveAtMs(completed, {
        agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
      }),
    ).toBe(true);
    expect(completed.archiveAtMs).toBeUndefined();
  });

  it("preserves ordinary keep and persistent session semantics", () => {
    expect(
      resolveSubagentArchiveAtMs({
        cfg,
        now: 1_000,
        spawnMode: "run",
        cleanup: "keep",
      }),
    ).toBeUndefined();
    expect(
      resolveSubagentArchiveAtMs({
        cfg,
        now: 1_000,
        spawnMode: "session",
        cleanup: "delete",
        collect: true,
      }),
    ).toBeUndefined();
  });
});

describe("reconcileOrphanedRestoredRuns", () => {
  it("keeps waitable collector tombstones after delete-mode sessions disappear", () => {
    const entry = createRunEntry({
      collect: true,
      cleanup: "delete",
      endedAt: 2_000,
      completion: { required: false, resultText: "done", capturedAt: 2_000 },
      collectorCompletion: { status: "done" },
    });
    const runs = new Map([[entry.runId, entry]]);

    expect(reconcileOrphanedRestoredRuns({ runs, resumedRuns: new Set() })).toBe(false);
    expect(runs.get(entry.runId)).toBe(entry);
  });
});

describe("safeRemoveAttachmentsDir", () => {
  it("reports non-ENOENT realpath failures instead of treating cleanup as complete", async () => {
    const realpathSpy = vi
      .spyOn(fs, "realpath")
      .mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

    await expect(
      safeRemoveAttachmentsDir(
        createRunEntry({
          attachmentsDir: "/tmp/openclaw-child-attachments",
          attachmentsRootDir: "/tmp/openclaw-attachments",
        }),
      ),
    ).resolves.toBe(false);

    realpathSpy.mockRestore();
  });
});

describe("reconcileOrphanedRun", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("preserves timing on orphaned error outcomes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    const resumedRuns = new Set([entry.runId]);

    expect(
      reconcileOrphanedRun({
        runId: entry.runId,
        entry,
        reason: "missing-session-id",
        source: "resume",
        runs,
        resumedRuns,
      }),
    ).toBe(true);

    expect(entry.endedAt).toBe(4_000);
    expect(entry.outcome).toEqual({
      status: "error",
      error: "orphaned subagent run (missing-session-id)",
      startedAt: 1_000,
      endedAt: 4_000,
      elapsedMs: 3_000,
    });
    expect(runs.has(entry.runId)).toBe(false);
    expect(resumedRuns.has(entry.runId)).toBe(false);
  });
});

describe("logAnnounceGiveUp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes the last delivery error in retry-limit warnings", () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000);
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      endedAt: 4_000,
      delivery: {
        status: "failed",
        attemptCount: 3,
        lastError: "direct-primary: routed-dispatch-did-not-queue-final",
      },
    });

    logAnnounceGiveUp(entry, "retry-limit");

    expect(logSpy).toHaveBeenCalledWith(
      '[warn] Subagent announce give up (retry-limit) run=run-1 child=agent:main:subagent:child requester=agent:main:main retries=3 endedAgo=5s deliveryError="direct-primary: routed-dispatch-did-not-queue-final"',
    );
    logSpy.mockRestore();
  });

  it("normalizes multiline delivery errors onto one gateway log line", () => {
    // Gateway logs are line-oriented; multiline provider errors must be
    // collapsed before they enter warning text.
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      delivery: {
        status: "failed",
        lastError: "gateway timeout\nphase: routed dispatch failed",
      },
    });

    logAnnounceGiveUp(entry, "expiry");

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('deliveryError="gateway timeout phase: routed dispatch failed"'),
    );
    logSpy.mockRestore();
  });

  it("keeps bounded delivery errors UTF-16 well-formed", () => {
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      delivery: {
        status: "failed",
        lastError: `${"x".repeat(1_999)}🚀tail`,
      },
    });

    logAnnounceGiveUp(entry, "expiry");

    const line = String(logSpy.mock.calls[0]?.[0]);
    expect(line).toContain(`${"x".repeat(1_999)}…`);
    expect(line).not.toContain("\uD83D");
    logSpy.mockRestore();
  });
});
