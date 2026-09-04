import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getFileLockProcessStartTime } from "openclaw/plugin-sdk/process-runtime";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
import { auditShortTermPromotionArtifacts } from "./short-term-promotion-artifacts.js";
import {
  configureMemoryCoreDreamingStateForTests,
  resetMemoryCoreDreamingStateForTests,
  shortTermTestState as testing,
} from "./test-helpers.js";

describe("memory workspace lock orphan recovery", () => {
  let fixtureRoot = "";
  let caseId = 0;

  beforeAll(async () => {
    await configureMemoryCoreDreamingStateForTests();
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "memory-lock-"));
  });

  afterAll(async () => {
    if (fixtureRoot) {
      await fs.rm(fixtureRoot, { recursive: true, force: true });
    }
    resetMemoryCoreDreamingStateForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  async function makeWorkspace(): Promise<string> {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    return workspaceDir;
  }

  it("reclaims a stale legacy lock after its process id is reused", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const workspaceDir = await makeWorkspace();
    await testing.writeShortTermLock(workspaceDir, {
      owner: `${process.pid}:${now - 120_000}`,
      acquiredAt: now - 120_000,
    });

    const result = withMemoryWorkspaceLock(workspaceDir, async () => "recovered").then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error: String(error) }),
    );
    await vi.advanceTimersByTimeAsync(10_040);

    expect(await result).toEqual({ status: "resolved", value: "recovered" });
  });

  it("reclaims a stale lock when a live process id has a different start identity", async () => {
    vi.useFakeTimers();
    const now = Date.now();
    vi.setSystemTime(now);
    const ownerStartTime = getFileLockProcessStartTime(process.ppid);
    expect(ownerStartTime).not.toBeNull();
    if (ownerStartTime === null) {
      throw new Error("Expected the test runner process start identity");
    }
    const workspaceDir = await makeWorkspace();
    await testing.writeShortTermLock(workspaceDir, {
      owner: `${process.ppid}:${now - 120_000}`,
      ownerStartTime: ownerStartTime + 1,
      acquiredAt: now - 120_000,
    });

    const result = withMemoryWorkspaceLock(workspaceDir, async () => "recovered").then(
      (value) => ({ status: "resolved" as const, value }),
      (error: unknown) => ({ status: "rejected" as const, error: String(error) }),
    );
    await vi.advanceTimersByTimeAsync(10_040);

    expect(await result).toEqual({ status: "resolved", value: "recovered" });
  });

  it("keeps a stale-looking lock while its owner task is active", async () => {
    const workspaceDir = await makeWorkspace();
    let enteredResolve: (() => void) | undefined;
    let releaseResolve: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => {
      enteredResolve = resolve;
    });
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const owner = withMemoryWorkspaceLock(workspaceDir, async () => {
      enteredResolve?.();
      await release;
    });
    await entered;

    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 120_000);
    try {
      const audit = await auditShortTermPromotionArtifacts({ workspaceDir });
      expect(audit.issues.map((issue) => issue.code)).not.toContain("recall-lock-stale");
    } finally {
      vi.restoreAllMocks();
      releaseResolve?.();
      await owner;
    }
  });
});
