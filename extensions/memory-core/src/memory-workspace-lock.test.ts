// Workspace lock tests cover orphaned-row recovery for the sqlite-backed lock.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { OpenKeyedStoreOptions } from "openclaw/plugin-sdk/plugin-state-runtime";
import { createPluginStateKeyedStoreForTests } from "openclaw/plugin-sdk/plugin-state-test-runtime";
import { afterAll, beforeAll, afterEach, describe, expect, it, vi } from "vitest";
import { configureMemoryCoreDreamingState, memoryCoreWorkspaceStateKey } from "./dreaming-state.js";
import { SHORT_TERM_LOCK_TTL_MS, withMemoryWorkspaceLock } from "./memory-workspace-lock.js";
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
    if (!fixtureRoot) {
      return;
    }
    await fs.rm(fixtureRoot, { recursive: true, force: true });
    resetMemoryCoreDreamingStateForTests();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function makeWorkspace(): Promise<string> {
    const workspaceDir = path.join(fixtureRoot, `case-${caseId++}`);
    await fs.mkdir(path.join(workspaceDir, "memory", ".dreams"), { recursive: true });
    return workspaceDir;
  }

  it("steals an orphaned lock whose recycled owner pid still answers the liveness probe", async () => {
    const workspaceDir = await makeWorkspace();
    // The container-restart shape from #134999: the owner pid is alive in the
    // new pid namespace (here: this very process), so only the lock TTL's age
    // bound can unwedge the row. The fallback keeps this test behavioral when
    // the source is reverted for red-green runs.
    const lockTtlMs = Number.isFinite(SHORT_TERM_LOCK_TTL_MS)
      ? SHORT_TERM_LOCK_TTL_MS
      : 10 * 60_000;
    await testing.writeShortTermLock(workspaceDir, {
      owner: `${process.pid}:${Date.now() - lockTtlMs - 5_000}`,
      acquiredAt: Date.now() - lockTtlMs - 5_000,
    });

    await expect(withMemoryWorkspaceLock(workspaceDir, async () => "recovered")).resolves.toBe(
      "recovered",
    );
  });

  it("registers the workspace lock with a store TTL so orphaned rows self-expire", async () => {
    const workspaceDir = await makeWorkspace();
    const registered: Array<{ key: string; ttlMs?: number }> = [];
    configureMemoryCoreDreamingState(<T>(options: OpenKeyedStoreOptions) => {
      const store = createPluginStateKeyedStoreForTests<T>("memory-core", {
        ...options,
        env: { ...process.env },
      });
      return {
        ...store,
        registerIfAbsent: (key: string, value: T, opts?: { ttlMs?: number }) => {
          registered.push({ key, ttlMs: opts?.ttlMs });
          return store.registerIfAbsent(key, value, opts);
        },
      };
    });
    try {
      await withMemoryWorkspaceLock(workspaceDir, async () => undefined);
    } finally {
      await configureMemoryCoreDreamingStateForTests();
    }

    const lockKey = memoryCoreWorkspaceStateKey(workspaceDir);
    expect(registered.filter((entry) => entry.key === lockKey)).toEqual([
      { key: lockKey, ttlMs: SHORT_TERM_LOCK_TTL_MS },
    ]);
  });
});
