// Subagent registry helper tests cover orphan reconciliation and compact logging
// for announce delivery give-up paths.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultRuntime } from "../../../runtime.js";
import { updateSwarmCollectorCompletion } from "../swarm/swarm-collector.js";
import {
  capFrozenResultText,
  logAnnounceGiveUp,
  reconcileOrphanedRestoredRuns,
  reconcileOrphanedRun,
  resolveAnnounceRetryDelayMs,
  safeRemoveAttachmentsDir,
  updateSubagentArchiveAtMs,
} from "./subagent-registry-helpers.js";
import type { SubagentRunRecord } from "./subagent-registry.types.js";

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
    execution: { status: "running", startedAt: 1_000 },
    ...overrides,
  };
}

describe("resolveAnnounceRetryDelayMs", () => {
  it("preserves the zero-jitter retry schedule through attempt 10", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);

    expect(
      Array.from({ length: 10 }, (_, index) => resolveAnnounceRetryDelayMs(index + 1)),
    ).toEqual([
      15_000, 30_000, 60_000, 120_000, 240_000, 300_000, 300_000, 300_000, 300_000, 300_000,
    ]);
    randomSpy.mockRestore();
  });

  it("applies positive jitter without exceeding the five-minute cap", () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(1);

    expect(resolveAnnounceRetryDelayMs(1)).toBe(18_000);
    expect(resolveAnnounceRetryDelayMs(6)).toBe(300_000);
    randomSpy.mockRestore();
  });
});

describe("capFrozenResultText", () => {
  it("preserves a valid UTF-8 prefix within the frozen-result byte budget", () => {
    const result = capFrozenResultText("😀".repeat(25_601));

    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(100 * 1024);
    expect(result).not.toContain("�");
    expect(result).toContain("[truncated: frozen completion output exceeded 100KB");
  });
});

describe("updateSubagentArchiveAtMs", () => {
  const cfg = { agents: { defaults: { subagents: { archiveAfterMinutes: 5 } } } };

  it("defers delete-mode and collector retention until terminal completion", () => {
    for (const overrides of [
      { cleanup: "delete" as const },
      { cleanup: "keep" as const, collect: true },
      { cleanup: "delete" as const, collect: true },
    ]) {
      const entry = createRunEntry(overrides);
      expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(false);
      expect(entry.archiveAtMs).toBeUndefined();
    }
  });

  it("starts ordinary delete-mode retention at execution completion", () => {
    const entry = createRunEntry({
      cleanup: "delete",
      createdAt: 500,
      execution: { status: "terminal", startedAt: 1_000, endedAt: 602_000 },
      archiveAtMs: 300_500,
    });

    expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(true);
    expect(entry.archiveAtMs).toBe(902_000);
    expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(false);
  });

  it("starts collector retention when terminal completion is frozen", () => {
    const entry = createRunEntry({
      collect: true,
      execution: {
        status: "terminal",
        startedAt: 1_000,
        endedAt: 2_000,
        outcome: { status: "ok" },
      },
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
      execution: {
        status: "terminal",
        startedAt: 1_000,
        endedAt: 2_000,
        outcome: { status: "ok" },
      },
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
      execution: { status: "terminal", startedAt: 1_000, endedAt: 2_000 },
      archiveAtMs: 10_000,
    });

    expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(true);
    expect(entry.archiveAtMs).toBe(302_000);
    expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(false);
  });

  it("clears stale deadlines from active, paused, persistent, and retained runs", () => {
    for (const overrides of [
      { cleanup: "delete" as const },
      { collect: true },
      {
        cleanup: "delete" as const,
        pauseReason: "sessions_yield" as const,
        execution: { status: "terminal" as const, startedAt: 1_000, endedAt: 2_000 },
      },
      {
        cleanup: "keep" as const,
        execution: { status: "terminal" as const, startedAt: 1_000, endedAt: 2_000 },
      },
    ]) {
      const entry = createRunEntry({ ...overrides, archiveAtMs: 10_000 });
      expect(updateSubagentArchiveAtMs(entry, cfg)).toBe(true);
      expect(entry.archiveAtMs).toBeUndefined();
    }

    const persistent = createRunEntry({
      collect: true,
      spawnMode: "session",
      execution: { status: "terminal", startedAt: 1_000, endedAt: 2_000 },
      archiveAtMs: 10_000,
    });
    expect(updateSubagentArchiveAtMs(persistent, cfg)).toBe(true);
    expect(persistent.archiveAtMs).toBeUndefined();
  });

  it("never arms retention when archiveAfterMinutes is zero", () => {
    for (const collect of [false, true]) {
      const entry = createRunEntry({
        cleanup: "delete",
        collect,
        execution: { status: "terminal", startedAt: 1_000, endedAt: 2_000 },
        archiveAtMs: 10_000,
      });

      expect(
        updateSubagentArchiveAtMs(entry, {
          agents: { defaults: { subagents: { archiveAfterMinutes: 0 } } },
        }),
      ).toBe(true);
      expect(entry.archiveAtMs).toBeUndefined();
    }
  });
});

describe("reconcileOrphanedRestoredRuns", () => {
  it("keeps waitable collector tombstones after delete-mode sessions disappear", () => {
    const entry = createRunEntry({
      collect: true,
      cleanup: "delete",
      execution: { status: "terminal", startedAt: 1_000, endedAt: 2_000 },
      completion: { required: false, resultText: "done", capturedAt: 2_000 },
      collectorCompletion: { status: "done" },
    });
    const runs = new Map([[entry.runId, entry]]);

    expect(reconcileOrphanedRestoredRuns({ runs, resumedRuns: new Set() })).toBe(false);
    expect(runs.get(entry.runId)).toBe(entry);
  });

  it.each(["reserved", "attempted", "consumed", "accepted", "abandoned"] as const)(
    "preserves orphaned restart recovery rows in the %s phase",
    (phase) => {
      const entry = createRunEntry({
        execution: {
          status: "interrupted",
          startedAt: 1_000,
          restartRecovery: {
            sessionId: "session-1",
            sessionMarker: "session-1:1000",
            idempotencyKey: "subagent-recovery:receipt",
            phase,
            ...(phase === "reserved" ? {} : { lifecycleGeneration: "generation-1" }),
          },
        },
      });
      const runs = new Map([[entry.runId, entry]]);
      const resumedRuns = new Set([entry.runId]);

      expect(reconcileOrphanedRestoredRuns({ runs, resumedRuns })).toBe(false);
      expect(runs.get(entry.runId)).toBe(entry);
      expect(resumedRuns.has(entry.runId)).toBe(true);
      expect(entry.execution.restartRecovery?.phase).toBe(phase);
    },
  );

  it.each(["pending", "suspended", "in_progress"] as const)(
    "preserves orphaned required completion delivery in the %s state",
    (status) => {
      const entry = createRunEntry({
        expectsCompletionMessage: true,
        execution: { status: "terminal", startedAt: 1_000, endedAt: 2_000 },
        completion: { required: true, resultText: "done", capturedAt: 2_000 },
        delivery: {
          status,
          ...(status === "suspended" ? { suspendedAt: 2_100 } : {}),
          ...(status === "in_progress"
            ? { disposition: "session_queued" as const, queueId: "queue-1" }
            : {}),
          payload: {
            requesterSessionKey: "agent:main:main",
            requesterDisplayKey: "main",
            childSessionKey: "agent:main:subagent:child",
            childRunId: "run-1",
            task: "finish the task",
            outcome: { status: "ok" },
            terminalReply: { disposition: "visible", text: "done" },
          },
        },
      });
      const runs = new Map([[entry.runId, entry]]);
      const resumedRuns = new Set([entry.runId]);

      expect(reconcileOrphanedRestoredRuns({ runs, resumedRuns })).toBe(false);
      expect(runs.get(entry.runId)).toBe(entry);
      expect(resumedRuns.has(entry.runId)).toBe(true);
    },
  );
});

describe("safeRemoveAttachmentsDir", () => {
  it("removes only the generated directory under the host-owned root", async () => {
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachment-state-"));
    const attachmentId = "2d4a8398-4d5a-4c20-9c16-0a5f6627cf92";
    const attachmentDir = path.join(stateDir, "attachments", "subagents", "main", attachmentId);
    const siblingDir = path.join(stateDir, "attachments", "subagents", "main", "sibling");
    await fs.mkdir(attachmentDir, { recursive: true });
    await fs.mkdir(siblingDir, { recursive: true });
    await fs.writeFile(path.join(attachmentDir, "staged.txt"), "staged");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    await expect(safeRemoveAttachmentsDir(createRunEntry({ attachmentId }))).resolves.toBe(true);
    await expect(fs.access(attachmentDir)).rejects.toHaveProperty("code", "ENOENT");
    await expect(fs.access(siblingDir)).resolves.toBeUndefined();

    vi.unstubAllEnvs();
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("ignores shipped workspace paths after they are replaced with an external symlink", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachment-root-"));
    const externalDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachment-external-"));
    const relDir = ".openclaw/attachments/run-1";
    const externalSentinel = path.join(externalDir, "sentinel.txt");
    await fs.mkdir(path.join(workspaceDir, ".openclaw", "attachments"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, relDir));
    await fs.writeFile(path.join(workspaceDir, relDir, "staged.txt"), "staged");
    await fs.writeFile(externalSentinel, "must-survive");
    await fs.rm(path.join(workspaceDir, ".openclaw", "attachments"), { recursive: true });
    await fs.symlink(externalDir, path.join(workspaceDir, ".openclaw", "attachments"));

    await expect(
      safeRemoveAttachmentsDir(
        createRunEntry({ attachmentsRootDir: workspaceDir, attachmentsDir: relDir }),
      ),
    ).resolves.toBe(true);
    await expect(fs.readFile(externalSentinel, "utf8")).resolves.toBe("must-survive");
    await expect(fs.readdir(externalDir)).resolves.toEqual(["sentinel.txt"]);

    await fs.rm(workspaceDir, { recursive: true, force: true });
    await fs.rm(externalDir, { recursive: true, force: true });
  });
});

describe("reconcileOrphanedRun", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("removes orphaned runs without publishing a discarded terminal projection", () => {
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

    expect(entry.execution).toEqual({ status: "running", startedAt: 1_000 });
    expect(runs.has(entry.runId)).toBe(false);
    expect(resumedRuns.has(entry.runId)).toBe(false);
  });

  it("retains a replayable required completion without its child session", () => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      execution: { status: "terminal", startedAt: 1_000, endedAt: 2_000 },
      completion: { required: true, resultText: "done", capturedAt: 2_000 },
      delivery: {
        status: "pending",
        payload: {
          requesterSessionKey: "agent:main:main",
          requesterDisplayKey: "main",
          childSessionKey: "agent:main:subagent:child",
          childRunId: "run-1",
          task: "finish the task",
          outcome: { status: "ok" },
          terminalReply: { disposition: "visible", text: "done" },
        },
      },
    });
    const runs = new Map([[entry.runId, entry]]);
    const resumedRuns = new Set([entry.runId]);

    expect(
      reconcileOrphanedRun({
        runId: entry.runId,
        entry,
        reason: "missing-session-entry",
        source: "resume",
        runs,
        resumedRuns,
      }),
    ).toBe(false);
    expect(runs.get(entry.runId)).toBe(entry);
    expect(resumedRuns.has(entry.runId)).toBe(true);
  });

  const replayPayload = {
    requesterSessionKey: "agent:main:main",
    requesterDisplayKey: "main",
    childSessionKey: "agent:main:subagent:child",
    childRunId: "run-1",
    task: "finish the task",
    outcome: { status: "ok" as const },
    terminalReply: { disposition: "visible" as const, text: "done" },
  };

  it.each([
    { name: "delivered", delivery: { status: "delivered" as const } },
    {
      name: "not required",
      completion: { required: false },
      delivery: { status: "pending" as const },
    },
    { name: "no replay payload", delivery: { status: "pending" as const } },
    {
      name: "ambiguous",
      delivery: {
        status: "pending" as const,
        disposition: "ambiguous" as const,
        payload: replayPayload,
      },
    },
    {
      name: "permanent failure",
      delivery: {
        status: "pending" as const,
        disposition: "permanent_failure" as const,
        payload: replayPayload,
      },
    },
    {
      name: "intentional non-delivery",
      delivery: {
        status: "pending" as const,
        disposition: "intentional_non_delivery" as const,
        payload: replayPayload,
      },
    },
    {
      name: "suppressed",
      suppressCompletionDelivery: true,
      delivery: { status: "pending" as const, payload: replayPayload },
    },
  ])("prunes orphaned completion rows after $name delivery", (overrides) => {
    const entry = createRunEntry({
      expectsCompletionMessage: true,
      execution: { status: "terminal", startedAt: 1_000, endedAt: 2_000 },
      completion: { required: true, resultText: "done", capturedAt: 2_000 },
      ...overrides,
    });
    const runs = new Map([[entry.runId, entry]]);

    expect(
      reconcileOrphanedRun({
        runId: entry.runId,
        entry,
        reason: "missing-session-entry",
        source: "resume",
        runs,
        resumedRuns: new Set(),
      }),
    ).toBe(true);
    expect(runs.has(entry.runId)).toBe(false);
  });
});

describe("logAnnounceGiveUp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("includes the last delivery error in expiry warnings", () => {
    vi.useFakeTimers();
    vi.setSystemTime(9_000);
    const logSpy = vi.spyOn(defaultRuntime, "log").mockImplementation(() => {});
    const entry = createRunEntry({
      execution: { status: "terminal", startedAt: 1_000, endedAt: 4_000 },
      delivery: {
        status: "failed",
        attemptCount: 3,
        lastError: "direct-primary: routed-dispatch-did-not-queue-final",
      },
    });

    logAnnounceGiveUp(entry, "expiry");

    expect(logSpy).toHaveBeenCalledWith(
      '[warn] Subagent announce give up (expiry) run=run-1 child=agent:main:subagent:child requester=agent:main:main retries=3 endedAgo=5s deliveryError="direct-primary: routed-dispatch-did-not-queue-final"',
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
