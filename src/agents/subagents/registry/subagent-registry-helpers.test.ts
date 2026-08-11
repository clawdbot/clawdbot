// Subagent registry helper tests cover orphan reconciliation and compact logging
// for announce delivery give-up paths.
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { __setFsSafeTestHooksForTest } from "@openclaw/fs-safe/test-hooks";
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

const ATTACHMENT_ID = "00000000-0000-4000-8000-000000000001";

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
});

describe("safeRemoveAttachmentsDir", () => {
  it("refuses a cleanup target equal to its recorded root", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachments-root-"));
    await fs.writeFile(path.join(rootDir, "sentinel.txt"), "unchanged");
    try {
      await expect(
        safeRemoveAttachmentsDir(
          createRunEntry({ attachmentsDir: rootDir, attachmentsRootDir: rootDir }),
        ),
      ).resolves.toBe(false);
      await expect(fs.readFile(path.join(rootDir, "sentinel.txt"), "utf8")).resolves.toBe(
        "unchanged",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("refuses an arbitrary descendant that is not a generated attachment receipt", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachments-shape-"));
    const arbitraryDir = path.join(rootDir, "other", ATTACHMENT_ID);
    await fs.mkdir(arbitraryDir, { recursive: true });
    await fs.writeFile(path.join(arbitraryDir, "sentinel.txt"), "unchanged");
    try {
      await expect(
        safeRemoveAttachmentsDir(
          createRunEntry({ attachmentsDir: arbitraryDir, attachmentsRootDir: rootDir }),
        ),
      ).resolves.toBe(false);
      await expect(fs.readFile(path.join(arbitraryDir, "sentinel.txt"), "utf8")).resolves.toBe(
        "unchanged",
      );
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("reconstructs a persisted sandbox boundary for cleanup", async () => {
    const sandboxWorkspaceDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "openclaw-attachments-sandbox-"),
    );
    const targetWorkspaceDir = path.join(sandboxWorkspaceDir, "worker");
    const attachmentsDir = path.join(targetWorkspaceDir, ".openclaw", "attachments", ATTACHMENT_ID);
    const sandboxAttachmentsDir = `/workspace/worker/.openclaw/attachments/${ATTACHMENT_ID}`;
    await fs.mkdir(attachmentsDir, { recursive: true });
    const remove = vi.fn(async () => {
      await fs.rm(attachmentsDir, { recursive: true, force: true });
    });
    const sandboxIdentity = {
      backendId: "ssh",
      runtimeId: "runtime-main",
      configLabel: "worker@example.test",
    };
    const resolveSandbox = vi.fn(
      async () =>
        ({
          ...sandboxIdentity,
          backend: { configLabel: sandboxIdentity.configLabel },
          fsBridge: { remove },
        }) as never,
    );
    const createIngress = vi.fn((sandbox: { fsBridge: unknown }) => sandbox.fsBridge) as never;
    try {
      await expect(
        safeRemoveAttachmentsDir(
          createRunEntry({
            attachmentsDir,
            attachmentsRootDir: targetWorkspaceDir,
            attachmentsSandboxSessionKey: "agent:main:main",
            attachmentsSandboxAgentId: "main",
            attachmentsSandboxWorkspaceDir: sandboxWorkspaceDir,
            attachmentsSandboxIdentity: sandboxIdentity,
            attachmentsSandboxDir: sandboxAttachmentsDir,
          }),
          {
            config: {},
            resolveSandbox,
            createIngress,
          },
        ),
      ).resolves.toBe(true);
      expect(resolveSandbox).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceDir: sandboxWorkspaceDir }),
      );
      expect(createIngress).toHaveBeenCalledOnce();
      expect(remove).toHaveBeenCalledWith({
        filePath: sandboxAttachmentsDir,
        recursive: true,
        force: true,
      });
    } finally {
      await fs.rm(sandboxWorkspaceDir, { recursive: true, force: true });
    }
  });

  it("retains cleanup ownership when the sandbox runtime identity changed", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachments-runtime-"));
    const attachmentsDir = path.join(rootDir, ".openclaw", "attachments", ATTACHMENT_ID);
    await fs.mkdir(attachmentsDir, { recursive: true });
    const remove = vi.fn(async () => undefined);
    try {
      await expect(
        safeRemoveAttachmentsDir(
          createRunEntry({
            attachmentsDir,
            attachmentsRootDir: rootDir,
            attachmentsSandboxSessionKey: "agent:main:main",
            attachmentsSandboxAgentId: "main",
            attachmentsSandboxWorkspaceDir: rootDir,
            attachmentsSandboxIdentity: {
              backendId: "ssh",
              runtimeId: "runtime-main",
              configLabel: "old-target@example.test",
            },
            attachmentsSandboxDir: `/workspace/.openclaw/attachments/${ATTACHMENT_ID}`,
          }),
          {
            config: {},
            resolveSandbox: vi.fn(
              async () =>
                ({
                  backendId: "ssh",
                  runtimeId: "runtime-main",
                  backend: { configLabel: "new-target@example.test" },
                  fsBridge: { remove },
                }) as never,
            ),
            createIngress: vi.fn((sandbox: { fsBridge: unknown }) => sandbox.fsBridge) as never,
          },
        ),
      ).resolves.toBe(false);
      expect(remove).not.toHaveBeenCalled();
      await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("refuses sandbox cleanup without its persisted mutation workspace", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachments-boundary-"));
    const attachmentsDir = path.join(rootDir, ".openclaw", "attachments", ATTACHMENT_ID);
    await fs.mkdir(attachmentsDir, { recursive: true });
    try {
      await expect(
        safeRemoveAttachmentsDir(
          createRunEntry({
            attachmentsDir,
            attachmentsRootDir: rootDir,
            attachmentsSandboxSessionKey: "agent:main:main",
            attachmentsSandboxAgentId: "main",
          }),
        ),
      ).resolves.toBe(false);
      await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it("refuses sandbox cleanup without its persisted bridge target", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachments-target-"));
    const attachmentsDir = path.join(rootDir, ".openclaw", "attachments", ATTACHMENT_ID);
    await fs.mkdir(attachmentsDir, { recursive: true });
    try {
      await expect(
        safeRemoveAttachmentsDir(
          createRunEntry({
            attachmentsDir,
            attachmentsRootDir: rootDir,
            attachmentsSandboxSessionKey: "agent:main:main",
            attachmentsSandboxAgentId: "main",
            attachmentsSandboxWorkspaceDir: rootDir,
          }),
        ),
      ).resolves.toBe(false);
      await expect(fs.access(attachmentsDir)).resolves.toBeUndefined();
    } finally {
      await fs.rm(rootDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "refuses canonical cleanup through a symlinked attachment root",
    async () => {
      const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-root-"));
      const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-legacy-outside-"));
      const legacyRootDir = path.join(workspaceDir, ".openclaw", "attachments");
      const outsideAttachmentDir = path.join(outsideDir, ATTACHMENT_ID);
      await fs.mkdir(path.dirname(legacyRootDir), { recursive: true });
      await fs.mkdir(outsideAttachmentDir);
      await fs.writeFile(path.join(outsideAttachmentDir, "sentinel.txt"), "unchanged");
      await fs.symlink(outsideDir, legacyRootDir, "dir");
      try {
        await expect(
          safeRemoveAttachmentsDir(
            createRunEntry({
              attachmentsDir: path.join(legacyRootDir, ATTACHMENT_ID),
              attachmentsRootDir: workspaceDir,
            }),
          ),
        ).resolves.toBe(false);
        await expect(
          fs.readFile(path.join(outsideAttachmentDir, "sentinel.txt"), "utf8"),
        ).resolves.toBe("unchanged");
      } finally {
        await fs.rm(workspaceDir, { recursive: true, force: true });
        await fs.rm(outsideDir, { recursive: true, force: true });
      }
    },
  );

  it("refuses a recorded directory outside its attachment root", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachments-cleanup-"));
    const rootDir = path.join(tempDir, "root");
    const outsideDir = path.join(tempDir, "outside");
    await fs.mkdir(rootDir);
    await fs.mkdir(outsideDir);
    await fs.writeFile(path.join(outsideDir, "sentinel.txt"), "unchanged");
    try {
      await expect(
        safeRemoveAttachmentsDir(
          createRunEntry({
            attachmentsDir: outsideDir,
            attachmentsRootDir: rootDir,
          }),
        ),
      ).resolves.toBe(false);
      await expect(fs.readFile(path.join(outsideDir, "sentinel.txt"), "utf8")).resolves.toBe(
        "unchanged",
      );
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")(
    "does not recursively remove through a symlink inside the attachment root",
    async () => {
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-attachments-symlink-"));
      const rootDir = path.join(tempDir, "root");
      const outsideDir = path.join(tempDir, "outside");
      const linkedDir = path.join(rootDir, ".openclaw", "attachments", ATTACHMENT_ID);
      await fs.mkdir(path.dirname(linkedDir), { recursive: true });
      await fs.mkdir(outsideDir);
      await fs.writeFile(path.join(outsideDir, "sentinel.txt"), "unchanged");
      await fs.symlink(outsideDir, linkedDir, "dir");
      try {
        await expect(
          safeRemoveAttachmentsDir(
            createRunEntry({
              attachmentsDir: linkedDir,
              attachmentsRootDir: rootDir,
            }),
          ),
        ).resolves.toBe(false);
        await expect(fs.readFile(path.join(outsideDir, "sentinel.txt"), "utf8")).resolves.toBe(
          "unchanged",
        );
      } finally {
        await fs.rm(tempDir, { recursive: true, force: true });
      }
    },
  );
});

describe("reconcileOrphanedRun", () => {
  afterEach(() => {
    vi.useRealTimers();
    __setFsSafeTestHooksForTest(undefined);
  });

  it("removes orphaned runs without publishing a discarded terminal projection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(4_000);
    const entry = createRunEntry();
    const runs = new Map([[entry.runId, entry]]);
    const resumedRuns = new Set([entry.runId]);

    expect(
      await reconcileOrphanedRun({
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

  it("keeps the orphan row until rooted attachment cleanup settles", async () => {
    const rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-orphan-owner-"));
    const attachmentsDir = path.join(rootDir, ".openclaw", "attachments", ATTACHMENT_ID);
    await fs.mkdir(attachmentsDir, { recursive: true });
    await fs.writeFile(path.join(attachmentsDir, "attachment.txt"), "private");
    const entry = createRunEntry({
      cleanup: "delete",
      attachmentsRootDir: rootDir,
      attachmentsDir,
    });
    const runs = new Map([[entry.runId, entry]]);
    const resumedRuns = new Set([entry.runId]);
    let releaseRemoval!: () => void;
    const removalReleased = new Promise<void>((resolve) => {
      releaseRemoval = resolve;
    });
    let cleanupStarted!: () => void;
    const cleanupStartedPromise = new Promise<void>((resolve) => {
      cleanupStarted = resolve;
    });
    let blocked = false;
    __setFsSafeTestHooksForTest({
      beforeRootFallbackMutation: async (operation) => {
        if (operation !== "remove" || blocked) {
          return;
        }
        blocked = true;
        cleanupStarted();
        await removalReleased;
      },
    });
    try {
      const reconciliation = reconcileOrphanedRun({
        runId: entry.runId,
        entry,
        reason: "missing-session-id",
        source: "resume",
        runs,
        resumedRuns,
      });

      await cleanupStartedPromise;
      expect(runs.get(entry.runId)).toBe(entry);
      releaseRemoval();
      await expect(reconciliation).resolves.toBe(true);
      expect(runs.has(entry.runId)).toBe(false);
      expect(resumedRuns.has(entry.runId)).toBe(false);
    } finally {
      releaseRemoval();
      await fs.rm(rootDir, { recursive: true, force: true });
    }
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
