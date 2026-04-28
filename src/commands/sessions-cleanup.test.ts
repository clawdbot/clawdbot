import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../config/sessions.js";
import type { RuntimeEnv } from "../runtime.js";

const mocks = vi.hoisted(() => ({
  loadConfig: vi.fn(),
  resolveSessionStoreTargets: vi.fn(),
  resolveSessionStoreTargetsOrExit: vi.fn(),
  resolveMaintenanceConfig: vi.fn(),
  loadSessionStore: vi.fn(),
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
  pruneStaleEntries: vi.fn(),
  capEntryCount: vi.fn(),
  updateSessionStore: vi.fn(),
  enforceSessionDiskBudget: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  getRuntimeConfig: mocks.loadConfig,
  loadConfig: mocks.loadConfig,
}));

vi.mock("./session-store-targets.js", () => ({
  resolveSessionStoreTargets: mocks.resolveSessionStoreTargets,
  resolveSessionStoreTargetsOrExit: mocks.resolveSessionStoreTargetsOrExit,
}));

vi.mock("../config/sessions.js", () => ({
  resolveMaintenanceConfig: mocks.resolveMaintenanceConfig,
  loadSessionStore: mocks.loadSessionStore,
  resolveSessionFilePath: mocks.resolveSessionFilePath,
  resolveSessionFilePathOptions: mocks.resolveSessionFilePathOptions,
  pruneStaleEntries: mocks.pruneStaleEntries,
  capEntryCount: mocks.capEntryCount,
  updateSessionStore: mocks.updateSessionStore,
  enforceSessionDiskBudget: mocks.enforceSessionDiskBudget,
}));

import { sessionsCleanupCommand } from "./sessions-cleanup.js";

function makeRuntime(): { runtime: RuntimeEnv; logs: string[] } {
  const logs: string[] = [];
  return {
    runtime: {
      log: (msg: unknown) => logs.push(String(msg)),
      error: () => {},
      exit: () => {},
    },
    logs,
  };
}

describe("sessionsCleanupCommand", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadConfig.mockReturnValue({ session: { store: "/cfg/sessions.json" } });
    mocks.resolveSessionStoreTargets.mockReturnValue([
      { agentId: "main", storePath: "/resolved/sessions.json" },
    ]);
    mocks.resolveSessionStoreTargetsOrExit.mockImplementation(
      (params: { cfg: unknown; opts: unknown; runtime: RuntimeEnv }) => {
        try {
          return mocks.resolveSessionStoreTargets(params.cfg, params.opts);
        } catch (error) {
          params.runtime.error(error instanceof Error ? error.message : String(error));
          params.runtime.exit(1);
          return null;
        }
      },
    );
    mocks.resolveMaintenanceConfig.mockReturnValue({
      mode: "warn",
      pruneAfterMs: 7 * 24 * 60 * 60 * 1000,
      maxEntries: 500,
      resetArchiveRetentionMs: 7 * 24 * 60 * 60 * 1000,
      maxDiskBytes: null,
      highWaterBytes: null,
    });
    mocks.pruneStaleEntries.mockImplementation(
      (
        store: Record<string, SessionEntry>,
        _maxAgeMs: number,
        opts?: { onPruned?: (params: { key: string; entry: SessionEntry }) => void },
      ) => {
        if (store.stale) {
          opts?.onPruned?.({ key: "stale", entry: store.stale });
          delete store.stale;
          return 1;
        }
        return 0;
      },
    );
    mocks.resolveSessionFilePathOptions.mockReturnValue({});
    mocks.resolveSessionFilePath.mockImplementation(
      (sessionId: string) => `/missing/${sessionId}.jsonl`,
    );
    mocks.capEntryCount.mockImplementation(() => 0);
    mocks.updateSessionStore.mockResolvedValue(0);
    mocks.enforceSessionDiskBudget.mockResolvedValue({
      totalBytesBefore: 1000,
      totalBytesAfter: 700,
      removedFiles: 1,
      removedEntries: 1,
      freedBytes: 300,
      maxBytes: 900,
      highWaterBytes: 700,
      overBudget: true,
    });
  });

  it("emits a single JSON object for non-dry runs and applies maintenance", async () => {
    mocks.loadSessionStore
      .mockReturnValueOnce({
        stale: { sessionId: "stale", updatedAt: 1 },
        fresh: { sessionId: "fresh", updatedAt: 2 },
      })
      .mockReturnValueOnce({
        fresh: { sessionId: "fresh", updatedAt: 2 },
      });
    mocks.updateSessionStore.mockImplementation(
      async (
        _storePath: string,
        mutator: (store: Record<string, SessionEntry>) => Promise<void> | void,
        opts?: {
          onMaintenanceApplied?: (report: {
            mode: "warn" | "enforce";
            beforeCount: number;
            afterCount: number;
            pruned: number;
            capped: number;
            diskBudget: Record<string, unknown> | null;
          }) => Promise<void> | void;
        },
      ) => {
        await mutator({});
        await opts?.onMaintenanceApplied?.({
          mode: "enforce",
          beforeCount: 3,
          afterCount: 1,
          pruned: 0,
          capped: 2,
          diskBudget: {
            totalBytesBefore: 1200,
            totalBytesAfter: 800,
            removedFiles: 0,
            removedEntries: 0,
            freedBytes: 400,
            maxBytes: 1000,
            highWaterBytes: 800,
            overBudget: true,
          },
        });
        return 0;
      },
    );

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        enforce: true,
        activeKey: "agent:main:main",
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.applied).toBe(true);
    expect(payload.mode).toBe("enforce");
    expect(payload.beforeCount).toBe(3);
    expect(payload.appliedCount).toBe(1);
    expect(payload.pruned).toBe(0);
    expect(payload.capped).toBe(2);
    expect(payload.diskBudget).toEqual(
      expect.objectContaining({
        removedFiles: 0,
        removedEntries: 0,
      }),
    );
    expect(mocks.updateSessionStore).toHaveBeenCalledWith(
      "/resolved/sessions.json",
      expect.any(Function),
      expect.objectContaining({
        activeSessionKey: "agent:main:main",
        maintenanceOverride: { mode: "enforce" },
        onMaintenanceApplied: expect.any(Function),
      }),
    );
  });

  it("returns dry-run JSON without mutating the store", async () => {
    mocks.loadSessionStore.mockReturnValue({
      stale: { sessionId: "stale", updatedAt: 1 },
      fresh: { sessionId: "fresh", updatedAt: 2 },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        dryRun: true,
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.dryRun).toBe(true);
    expect(payload.applied).toBeUndefined();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(payload.diskBudget).toEqual(
      expect.objectContaining({
        removedFiles: 1,
        removedEntries: 1,
      }),
    );
  });

  it("counts missing transcript entries when --fix-missing is enabled in dry-run", async () => {
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.loadSessionStore.mockReturnValue({
      missing: { sessionId: "missing-transcript", updatedAt: 1 },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        dryRun: true,
        fixMissing: true,
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.beforeCount).toBe(1);
    expect(payload.afterCount).toBe(0);
    expect(payload.missing).toBe(1);
  });

  it("renders a dry-run action table with keep/prune actions", async () => {
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.loadSessionStore.mockReturnValue({
      stale: { sessionId: "stale", updatedAt: 1, model: "pi:opus" },
      fresh: { sessionId: "fresh", updatedAt: 2, model: "pi:opus" },
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        dryRun: true,
      },
      runtime,
    );

    expect(logs.some((line) => line.includes("Planned session actions:"))).toBe(true);
    expect(logs.some((line) => line.includes("Action") && line.includes("Key"))).toBe(true);
    expect(logs.some((line) => line.includes("fresh") && line.includes("keep"))).toBe(true);
    expect(logs.some((line) => line.includes("stale") && line.includes("prune-stale"))).toBe(true);
  });

  it("returns grouped JSON for --all-agents dry-runs", async () => {
    mocks.resolveSessionStoreTargets.mockReturnValue([
      { agentId: "main", storePath: "/resolved/main-sessions.json" },
      { agentId: "work", storePath: "/resolved/work-sessions.json" },
    ]);
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.loadSessionStore
      .mockReturnValueOnce({ stale: { sessionId: "stale-main", updatedAt: 1 } })
      .mockReturnValueOnce({ stale: { sessionId: "stale-work", updatedAt: 1 } });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        dryRun: true,
        allAgents: true,
      },
      runtime,
    );

    expect(logs).toHaveLength(1);
    const payload = JSON.parse(logs[0] ?? "{}") as Record<string, unknown>;
    expect(payload.allAgents).toBe(true);
    expect(Array.isArray(payload.stores)).toBe(true);
    expect((payload.stores as unknown[]).length).toBe(2);
  });
});
