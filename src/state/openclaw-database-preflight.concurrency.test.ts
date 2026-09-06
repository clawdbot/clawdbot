import { realpathSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesForTest,
  OPENCLAW_AGENT_SCHEMA_VERSION,
  openOpenClawAgentDatabase,
} from "./openclaw-agent-db.js";
import { preflightOpenClawDatabaseSchemas } from "./openclaw-database-preflight.js";
import { OPENCLAW_STATE_SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import { closeOpenClawStateDatabaseForTest } from "./openclaw-state-db.js";

const snapshotProbe = vi.hoisted(() => ({
  trackedPaths: new Set<string>(),
  active: 0,
  maxActive: 0,
  trackedCalls: 0,
  startedPaths: [] as string[],
  completedPaths: [] as string[],
  gatesByPath: new Map<string, Promise<void>>(),
  failuresByPath: new Map<string, string>(),
  waitForAbortPaths: new Set<string>(),
}));

vi.mock("../infra/sqlite-readonly-location.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../infra/sqlite-readonly-location.js")>();

  return {
    ...actual,
    prepareSqliteReadOnlyLocation: async (
      pathname: string,
      options?: Parameters<typeof actual.prepareSqliteReadOnlyLocation>[1],
    ) => {
      if (!snapshotProbe.trackedPaths.has(pathname)) {
        return actual.prepareSqliteReadOnlyLocation(pathname, options);
      }

      snapshotProbe.trackedCalls += 1;
      snapshotProbe.startedPaths.push(pathname);
      snapshotProbe.active += 1;
      snapshotProbe.maxActive = Math.max(snapshotProbe.maxActive, snapshotProbe.active);

      try {
        if (snapshotProbe.waitForAbortPaths.has(pathname)) {
          const signal = options?.signal;
          if (!signal) {
            throw new Error("expected AbortSignal");
          }

          await new Promise<void>((_resolve, reject) => {
            const rejectAborted = () => {
              reject(
                signal.reason instanceof Error ? signal.reason : new Error("preflight aborted"),
              );
            };

            if (signal.aborted) {
              rejectAborted();
            } else {
              signal.addEventListener("abort", rejectAborted, { once: true });
            }
          });
        } else {
          const gate = snapshotProbe.gatesByPath.get(pathname);
          if (gate) {
            await gate;
          } else {
            await new Promise<void>((resolve) => {
              setImmediate(resolve);
            });
          }
        }

        const failure = snapshotProbe.failuresByPath.get(pathname);
        if (failure) {
          throw new Error(failure);
        }

        return {
          location: pathname,
          cleanup: () => true,
        };
      } finally {
        snapshotProbe.active -= 1;
        snapshotProbe.completedPaths.push(pathname);
      }
    },
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 10);
    });
  }

  throw new Error("timed out waiting for preflight probe");
}

afterEach(() => {
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();

  snapshotProbe.trackedPaths.clear();
  snapshotProbe.active = 0;
  snapshotProbe.maxActive = 0;
  snapshotProbe.trackedCalls = 0;
  snapshotProbe.startedPaths.length = 0;
  snapshotProbe.completedPaths.length = 0;
  snapshotProbe.gatesByPath.clear();
  snapshotProbe.failuresByPath.clear();
  snapshotProbe.waitForAbortPaths.clear();
});

describe("OpenClaw database schema preflight concurrency", () => {
  it("preflights registered agent databases with bounded concurrency", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-concurrency-");
    const env = { OPENCLAW_STATE_DIR: stateDir };

    const agentPaths = ["main", "ops", "ba", "xz"].map(
      (agentId) =>
        openOpenClawAgentDatabase({
          agentId,
          env,
        }).path,
    );

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    for (const agentPath of agentPaths) {
      snapshotProbe.trackedPaths.add(realpathSync.native(agentPath));
    }

    const result = await preflightOpenClawDatabaseSchemas({
      env,
      supportedVersions: {
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
    });

    expect(result).toEqual({
      incompatible: [],
      indeterminate: [],
    });

    expect(snapshotProbe.trackedCalls).toBe(agentPaths.length);
    expect(snapshotProbe.maxActive).toBeGreaterThan(1);
    expect(snapshotProbe.maxActive).toBeLessThanOrEqual(2);
  });

  it("preserves inspection order when concurrent snapshots finish out of order", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-order-");
    const env = { OPENCLAW_STATE_DIR: stateDir };

    const agentPaths = ["main", "ops", "ba", "xz"].map(
      (agentId) =>
        openOpenClawAgentDatabase({
          agentId,
          env,
        }).path,
    );

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    const realPaths = agentPaths.map((agentPath) => realpathSync.native(agentPath));

    for (const realPath of realPaths) {
      snapshotProbe.trackedPaths.add(realPath);
      snapshotProbe.failuresByPath.set(realPath, `forced preflight failure for ${realPath}`);
    }

    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const firstRealPath = realPaths[0];
    if (firstRealPath === undefined) {
      throw new Error("expected at least one registered agent database");
    }
    snapshotProbe.gatesByPath.set(firstRealPath, firstGate);

    const preflightPromise = preflightOpenClawDatabaseSchemas({
      env,
      supportedVersions: {
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
    });

    await waitUntil(() => snapshotProbe.completedPaths.length === 3);
    releaseFirst();

    const result = await preflightPromise;

    expect(snapshotProbe.completedPaths).not.toEqual(snapshotProbe.startedPaths);

    expect(result.indeterminate.map((inspection) => realpathSync.native(inspection.path))).toEqual(
      snapshotProbe.startedPaths,
    );
  });

  it("does not start queued agent snapshots after cancellation", async () => {
    const stateDir = tempDirs.make("openclaw-database-preflight-abort-");
    const env = { OPENCLAW_STATE_DIR: stateDir };

    const agentPaths = ["main", "ops", "ba", "xz"].map(
      (agentId) =>
        openOpenClawAgentDatabase({
          agentId,
          env,
        }).path,
    );

    closeOpenClawAgentDatabasesForTest();
    closeOpenClawStateDatabaseForTest();

    for (const agentPath of agentPaths) {
      const realPath = realpathSync.native(agentPath);
      snapshotProbe.trackedPaths.add(realPath);
      snapshotProbe.waitForAbortPaths.add(realPath);
    }

    const controller = new AbortController();

    const preflightPromise = preflightOpenClawDatabaseSchemas({
      env,
      signal: controller.signal,
      supportedVersions: {
        state: OPENCLAW_STATE_SCHEMA_VERSION,
        agent: OPENCLAW_AGENT_SCHEMA_VERSION,
      },
    });

    await waitUntil(() => snapshotProbe.active === 2);

    controller.abort(new Error("stop database preflight"));

    await expect(preflightPromise).rejects.toThrow("stop database preflight");

    await waitUntil(() => snapshotProbe.active === 0);

    expect(snapshotProbe.trackedCalls).toBe(2);
    expect(snapshotProbe.startedPaths).toHaveLength(2);
    expect(snapshotProbe.maxActive).toBe(2);
  });
});
