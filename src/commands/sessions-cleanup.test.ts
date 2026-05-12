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
  resolveSessionCleanupAction: vi.fn(),
  runSessionsCleanup: vi.fn(),
  serializeSessionCleanupResult: vi.fn(),
  callGateway: vi.fn(),
  isGatewayTransportError: vi.fn(),
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
  resolveSessionCleanupAction: mocks.resolveSessionCleanupAction,
  runSessionsCleanup: mocks.runSessionsCleanup,
  serializeSessionCleanupResult: mocks.serializeSessionCleanupResult,
}));

vi.mock("../gateway/call.js", () => ({
  callGateway: mocks.callGateway,
  isGatewayTransportError: mocks.isGatewayTransportError,
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

function expectLogsToInclude(logs: readonly string[], text: string): void {
  const matches = logs.filter((line) => line.includes(text));
  expect(matches.length).toBeGreaterThan(0);
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
    mocks.callGateway.mockResolvedValue(null);
    mocks.isGatewayTransportError.mockReturnValue(true);
    mocks.resolveSessionCleanupAction.mockImplementation(
      (params: {
        key: string;
        missingKeys: Set<string>;
        staleKeys: Set<string>;
        cappedKeys: Set<string>;
        budgetEvictedKeys: Set<string>;
        dmScopeRetiredKeys: Set<string>;
      }) => {
        if (params.dmScopeRetiredKeys.has(params.key)) {
          return "retire-dm-scope";
        }
        if (params.missingKeys.has(params.key)) {
          return "prune-missing";
        }
        if (params.staleKeys.has(params.key)) {
          return "prune-stale";
        }
        if (params.cappedKeys.has(params.key)) {
          return "cap-overflow";
        }
        if (params.budgetEvictedKeys.has(params.key)) {
          return "evict-budget";
        }
        return "keep";
      },
    );
    mocks.serializeSessionCleanupResult.mockImplementation(
      (params: { mode: string; dryRun: boolean; summaries: Record<string, unknown>[] }) => {
        if (params.summaries.length === 1) {
          return params.summaries[0] ?? {};
        }
        return {
          allAgents: true,
          mode: params.mode,
          dryRun: params.dryRun,
          stores: params.summaries,
        };
      },
    );
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [],
      appliedSummaries: [],
    });
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
    mocks.callGateway.mockRejectedValue(
      Object.assign(new Error("closed"), { name: "GatewayTransportError" }),
    );
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "enforce",
      previewResults: [],
      appliedSummaries: [
        {
          agentId: "main",
          storePath: "/resolved/sessions.json",
          mode: "enforce",
          dryRun: false,
          beforeCount: 3,
          afterCount: 1,
          missing: 0,
          dmScopeRetired: 0,
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
          wouldMutate: true,
          applied: true,
          appliedCount: 1,
        },
      ],
    });

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
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      agentId: "main",
      storePath: "/resolved/sessions.json",
      mode: "enforce",
      dryRun: false,
      beforeCount: 3,
      afterCount: 1,
      missing: 0,
      dmScopeRetired: 0,
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
      wouldMutate: true,
      applied: true,
      appliedCount: 1,
    });
    expect(mocks.runSessionsCleanup).toHaveBeenCalledOnce();
    const cleanupCall = mocks.runSessionsCleanup.mock.calls.at(0)?.[0];
    expect(cleanupCall?.cfg).toEqual({ session: { store: "/cfg/sessions.json" } });
    expect(cleanupCall?.opts.enforce).toBe(true);
    expect(cleanupCall?.opts.activeKey).toBe("agent:main:main");
    expect(cleanupCall?.targets).toEqual([
      { agentId: "main", storePath: "/resolved/sessions.json" },
    ]);
  });

  it("delegates non-store enforcing cleanup through the Gateway writer when reachable", async () => {
    mocks.callGateway.mockResolvedValue({
      agentId: "main",
      storePath: "/resolved/sessions.json",
      mode: "enforce",
      dryRun: false,
      beforeCount: 3,
      afterCount: 1,
      missing: 0,
      dmScopeRetired: 0,
      pruned: 2,
      capped: 0,
      diskBudget: null,
      wouldMutate: true,
      applied: true,
      appliedCount: 1,
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        json: true,
        enforce: true,
      },
      runtime,
    );

    expect(mocks.callGateway).toHaveBeenCalledOnce();
    const gatewayCall = mocks.callGateway.mock.calls.at(0)?.[0];
    expect(gatewayCall?.method).toBe("sessions.cleanup");
    expect(gatewayCall?.params.enforce).toBe(true);
    expect(gatewayCall?.requiredMethods).toEqual(["sessions.cleanup"]);
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
    expect(logs).toHaveLength(1);
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      agentId: "main",
      storePath: "/resolved/sessions.json",
      mode: "enforce",
      dryRun: false,
      beforeCount: 3,
      afterCount: 1,
      missing: 0,
      dmScopeRetired: 0,
      pruned: 2,
      capped: 0,
      diskBudget: null,
      wouldMutate: true,
      applied: true,
      appliedCount: 1,
    });
  });

  it("returns dry-run JSON without mutating the store", async () => {
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [
        {
          summary: {
            agentId: "main",
            storePath: "/resolved/sessions.json",
            mode: "warn",
            dryRun: true,
            beforeCount: 2,
            afterCount: 1,
            missing: 0,
            dmScopeRetired: 0,
            pruned: 1,
            capped: 0,
            diskBudget: {
              totalBytesBefore: 1000,
              totalBytesAfter: 700,
              removedFiles: 1,
              removedEntries: 1,
              freedBytes: 300,
              maxBytes: 900,
              highWaterBytes: 700,
              overBudget: true,
            },
            wouldMutate: true,
          },
          beforeStore: {},
          missingKeys: new Set<string>(),
          staleKeys: new Set<string>(),
          cappedKeys: new Set<string>(),
          budgetEvictedKeys: new Set<string>(),
          dmScopeRetiredKeys: new Set<string>(),
        },
      ],
      appliedSummaries: [],
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
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      agentId: "main",
      storePath: "/resolved/sessions.json",
      mode: "warn",
      dryRun: true,
      beforeCount: 2,
      afterCount: 1,
      missing: 0,
      dmScopeRetired: 0,
      pruned: 1,
      capped: 0,
      diskBudget: {
        totalBytesBefore: 1000,
        totalBytesAfter: 700,
        removedFiles: 1,
        removedEntries: 1,
        freedBytes: 300,
        maxBytes: 900,
        highWaterBytes: 700,
        overBudget: true,
      },
      wouldMutate: true,
    });
    expect(mocks.runSessionsCleanup).toHaveBeenCalled();
    expect(mocks.updateSessionStore).not.toHaveBeenCalled();
  });

  it("counts missing transcript entries when --fix-missing is enabled in dry-run", async () => {
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [
        {
          summary: {
            agentId: "main",
            storePath: "/resolved/sessions.json",
            mode: "warn",
            dryRun: true,
            beforeCount: 1,
            afterCount: 0,
            missing: 1,
            dmScopeRetired: 0,
            pruned: 0,
            capped: 0,
            diskBudget: null,
            wouldMutate: true,
          },
          beforeStore: {},
          missingKeys: new Set(["missing"]),
          staleKeys: new Set<string>(),
          cappedKeys: new Set<string>(),
          budgetEvictedKeys: new Set<string>(),
          dmScopeRetiredKeys: new Set<string>(),
        },
      ],
      appliedSummaries: [],
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
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      agentId: "main",
      storePath: "/resolved/sessions.json",
      mode: "warn",
      dryRun: true,
      beforeCount: 1,
      afterCount: 0,
      missing: 1,
      dmScopeRetired: 0,
      pruned: 0,
      capped: 0,
      diskBudget: null,
      wouldMutate: true,
    });
  });

  it("renders a dry-run action table with keep/prune actions", async () => {
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [
        {
          summary: {
            agentId: "main",
            storePath: "/resolved/sessions.json",
            mode: "warn",
            dryRun: true,
            beforeCount: 2,
            afterCount: 1,
            missing: 0,
            dmScopeRetired: 0,
            pruned: 1,
            capped: 0,
            unreferencedArtifacts: {
              scannedFiles: 5,
              removedFiles: 2,
              freedBytes: 128,
              olderThanMs: 604800000,
            },
            diskBudget: null,
            wouldMutate: true,
          },
          beforeStore: {
            stale: { sessionId: "stale", updatedAt: 1, model: "pi:opus" },
            fresh: { sessionId: "fresh", updatedAt: 2, model: "pi:opus" },
          },
          missingKeys: new Set<string>(),
          staleKeys: new Set(["stale"]),
          cappedKeys: new Set<string>(),
          budgetEvictedKeys: new Set<string>(),
          dmScopeRetiredKeys: new Set<string>(),
        },
      ],
      appliedSummaries: [],
    });

    const { runtime, logs } = makeRuntime();
    await sessionsCleanupCommand(
      {
        dryRun: true,
      },
      runtime,
    );

    expectLogsToInclude(logs, "Planned session actions:");
    expectLogsToInclude(logs, "Would prune unreferenced artifacts: 2");
    const tableHeaderLines = logs.filter((line) => line.includes("Action") && line.includes("Key"));
    expect(tableHeaderLines.length).toBeGreaterThan(0);
    const freshKeepLines = logs.filter((line) => line.includes("fresh") && line.includes("keep"));
    expect(freshKeepLines.length).toBeGreaterThan(0);
    const stalePruneLines = logs.filter(
      (line) => line.includes("stale") && line.includes("prune-stale"),
    );
    expect(stalePruneLines.length).toBeGreaterThan(0);
  });

  it("returns grouped JSON for --all-agents dry-runs", async () => {
    mocks.resolveSessionStoreTargets.mockReturnValue([
      { agentId: "main", storePath: "/resolved/main-sessions.json" },
      { agentId: "work", storePath: "/resolved/work-sessions.json" },
    ]);
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.runSessionsCleanup.mockResolvedValue({
      mode: "warn",
      previewResults: [
        {
          summary: {
            agentId: "main",
            storePath: "/resolved/main-sessions.json",
            mode: "warn",
            dryRun: true,
            beforeCount: 1,
            afterCount: 0,
            missing: 0,
            dmScopeRetired: 0,
            pruned: 1,
            capped: 0,
            diskBudget: null,
            wouldMutate: true,
          },
          beforeStore: {},
          missingKeys: new Set<string>(),
          staleKeys: new Set(["stale"]),
          cappedKeys: new Set<string>(),
          budgetEvictedKeys: new Set<string>(),
          dmScopeRetiredKeys: new Set<string>(),
        },
        {
          summary: {
            agentId: "work",
            storePath: "/resolved/work-sessions.json",
            mode: "warn",
            dryRun: true,
            beforeCount: 1,
            afterCount: 0,
            missing: 0,
            dmScopeRetired: 0,
            pruned: 1,
            capped: 0,
            diskBudget: null,
            wouldMutate: true,
          },
          beforeStore: {},
          missingKeys: new Set<string>(),
          staleKeys: new Set(["stale"]),
          cappedKeys: new Set<string>(),
          budgetEvictedKeys: new Set<string>(),
          dmScopeRetiredKeys: new Set<string>(),
        },
      ],
      appliedSummaries: [],
    });

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
    expect(JSON.parse(logs[0] ?? "{}")).toEqual({
      allAgents: true,
      mode: "warn",
      dryRun: true,
      stores: [
        {
          agentId: "main",
          storePath: "/resolved/main-sessions.json",
          mode: "warn",
          dryRun: true,
          beforeCount: 1,
          afterCount: 0,
          missing: 0,
          dmScopeRetired: 0,
          pruned: 1,
          capped: 0,
          diskBudget: null,
          wouldMutate: true,
        },
        {
          agentId: "work",
          storePath: "/resolved/work-sessions.json",
          mode: "warn",
          dryRun: true,
          beforeCount: 1,
          afterCount: 0,
          missing: 0,
          dmScopeRetired: 0,
          pruned: 1,
          capped: 0,
          diskBudget: null,
          wouldMutate: true,
        },
      ],
    });
  });
});
