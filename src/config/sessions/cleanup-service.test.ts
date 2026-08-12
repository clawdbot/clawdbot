import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntryLifecycleRemoval } from "./session-accessor.js";
import type { SessionEntry } from "./types.js";

const mocks = vi.hoisted(() => {
  const unbind = vi.fn(async () => []);
  return {
    fs: { existsSync: vi.fn(() => false) },
    unbind,
    getSessionBindingService: vi.fn(() => ({ unbind })),
    loadSessionStore: vi.fn(() => ({})),
    cloneSessionStoreRecord: vi.fn((s: Record<string, SessionEntry>) => ({ ...s })),
    applySessionEntryLifecycleMutation: vi.fn(
      async (params: { removals: SessionEntryLifecycleRemoval[] }) => ({
        removedSessionKeys: params.removals.map((r) => r.sessionKey),
        maintenanceReport: null,
        afterCount: 0,
        unreferencedArtifacts: {
          scannedFiles: 0,
          removedFiles: 0,
          freedBytes: 0,
          olderThanMs: 604_800_000,
        },
      }),
    ),
    purgeDeletedAgentSessionEntries: vi.fn(async () => {}),
    resolveSessionFilePath: vi.fn(() => "/state/sessions/sess.jsonl"),
    resolveSessionFilePathOptions: vi.fn(() => ({})),
    pruneStaleEntries: vi.fn(() => 0),
    capEntryCount: vi.fn(() => 0),
    enforceSessionDiskBudget: vi.fn(async () => null),
    pruneUnreferencedSessionArtifacts: vi.fn(async () => ({
      scannedFiles: 0,
      removedFiles: 0,
      freedBytes: 0,
      olderThanMs: 0,
    })),
    resolveSessionArtifactCanonicalPathsForEntry: vi.fn(() => []),
    resolveMaintenanceConfig: vi.fn(() => ({
      mode: "enforce" as const,
      pruneAfterMs: 604_800_000,
      maxEntries: 500,
      resetArchiveRetentionMs: 604_800_000,
      maxDiskBytes: null,
      highWaterBytes: null,
    })),
  };
});

vi.mock("node:fs", () => ({ default: mocks.fs }));
vi.mock("../../infra/outbound/session-binding-service.js", () => ({
  getSessionBindingService: mocks.getSessionBindingService,
}));
vi.mock("./store.js", () => ({
  loadSessionStore: mocks.loadSessionStore,
}));
vi.mock("./session-accessor.js", () => ({
  applySessionEntryLifecycleMutation: mocks.applySessionEntryLifecycleMutation,
  purgeDeletedAgentSessionEntries: mocks.purgeDeletedAgentSessionEntries,
}));
vi.mock("./store-cache.js", () => ({
  cloneSessionStoreRecord: mocks.cloneSessionStoreRecord,
}));
vi.mock("./paths.js", () => ({
  resolveSessionFilePath: mocks.resolveSessionFilePath,
  resolveSessionFilePathOptions: mocks.resolveSessionFilePathOptions,
  resolveStorePath: vi.fn(() => "/state/sessions.json"),
}));
vi.mock("./store-maintenance.js", () => ({
  pruneStaleEntries: mocks.pruneStaleEntries,
  capEntryCount: mocks.capEntryCount,
}));
vi.mock("./disk-budget.js", () => ({
  enforceSessionDiskBudget: mocks.enforceSessionDiskBudget,
  pruneUnreferencedSessionArtifacts: mocks.pruneUnreferencedSessionArtifacts,
  resolveSessionArtifactCanonicalPathsForEntry: mocks.resolveSessionArtifactCanonicalPathsForEntry,
}));
vi.mock("./store-maintenance-runtime.js", () => ({
  resolveMaintenanceConfig: mocks.resolveMaintenanceConfig,
}));
vi.mock("./targets.js", () => ({ resolveSessionStoreTargets: vi.fn() }));
vi.mock("../../agents/agent-scope.js", () => ({ resolveDefaultAgentId: vi.fn(() => "main") }));
vi.mock("../../gateway/session-store-key.js", () => ({
  resolveStoredSessionOwnerAgentId: vi.fn(),
}));
vi.mock("../../logging/logger.js", () => ({
  getLogger: vi.fn(() => ({ debug: vi.fn() })),
}));
vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: vi.fn((id: string) => id),
}));

import { runSessionsCleanup } from "./cleanup-service.js";

const TARGET = { agentId: "main", storePath: "/state/sessions.json" };

function makeEntry(sessionId: string): SessionEntry {
  return { sessionId, updatedAt: 0 } as SessionEntry;
}

describe("runSessionsCleanup: conversation binding unbind after missing-transcript prune", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.unbind.mockResolvedValue([]);
    mocks.fs.existsSync.mockReturnValue(false);
    mocks.resolveSessionFilePath.mockReturnValue("/state/sessions/sess.jsonl");
    mocks.resolveSessionFilePathOptions.mockReturnValue({});
    mocks.pruneStaleEntries.mockReturnValue(0);
    mocks.capEntryCount.mockReturnValue(0);
    mocks.enforceSessionDiskBudget.mockResolvedValue(null);
    mocks.pruneUnreferencedSessionArtifacts.mockResolvedValue({
      scannedFiles: 0,
      removedFiles: 0,
      freedBytes: 0,
      olderThanMs: 604_800_000,
    });
    mocks.resolveSessionArtifactCanonicalPathsForEntry.mockReturnValue([]);
    mocks.resolveMaintenanceConfig.mockReturnValue({
      mode: "enforce" as const,
      pruneAfterMs: 604_800_000,
      maxEntries: 500,
      resetArchiveRetentionMs: 604_800_000,
      maxDiskBytes: null,
      highWaterBytes: null,
    });
    mocks.getSessionBindingService.mockReturnValue({ unbind: mocks.unbind });
    mocks.applySessionEntryLifecycleMutation.mockImplementation(
      async (params: { removals: SessionEntryLifecycleRemoval[] }) => ({
        removedSessionKeys: params.removals.map((r) => r.sessionKey),
        maintenanceReport: null,
        afterCount: 0,
        unreferencedArtifacts: {
          scannedFiles: 0,
          removedFiles: 0,
          freedBytes: 0,
          olderThanMs: 604_800_000,
        },
      }),
    );
  });

  it("unbinds conversation bindings for session entries whose transcripts are pruned", async () => {
    const store = { "agent:main:main": makeEntry("sess-abc") };
    mocks.loadSessionStore.mockReturnValue(store);
    mocks.cloneSessionStoreRecord.mockImplementation((s: Record<string, SessionEntry>) => ({
      ...s,
    }));

    await runSessionsCleanup({
      cfg: {} as never,
      opts: { fixMissing: true, dryRun: false },
      targets: [TARGET],
    });

    expect(mocks.unbind).toHaveBeenCalledOnce();
    expect(mocks.unbind).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:main",
      reason: "cleanup-missing-transcript",
    });
  });

  it("unbinds each pruned key when multiple session transcripts are missing", async () => {
    const store = {
      "agent:main:main": makeEntry("sess-1"),
      "agent:review:main": makeEntry("sess-2"),
    };
    mocks.loadSessionStore.mockReturnValue(store);
    mocks.cloneSessionStoreRecord.mockImplementation((s: Record<string, SessionEntry>) => ({
      ...s,
    }));

    await runSessionsCleanup({
      cfg: {} as never,
      opts: { fixMissing: true, dryRun: false },
      targets: [TARGET],
    });

    expect(mocks.unbind).toHaveBeenCalledTimes(2);
    expect(mocks.unbind).toHaveBeenCalledWith({
      targetSessionKey: "agent:main:main",
      reason: "cleanup-missing-transcript",
    });
    expect(mocks.unbind).toHaveBeenCalledWith({
      targetSessionKey: "agent:review:main",
      reason: "cleanup-missing-transcript",
    });
  });

  it("does not unbind or touch the store during dry-run", async () => {
    const store = { "agent:main:main": makeEntry("sess-abc") };
    mocks.loadSessionStore.mockReturnValue(store);
    mocks.cloneSessionStoreRecord.mockImplementation((s: Record<string, SessionEntry>) => ({
      ...s,
    }));

    await runSessionsCleanup({
      cfg: {} as never,
      opts: { fixMissing: true, dryRun: true },
      targets: [TARGET],
    });

    expect(mocks.applySessionEntryLifecycleMutation).not.toHaveBeenCalled();
    expect(mocks.unbind).not.toHaveBeenCalled();
  });

  it("does not unbind when fixMissing is not requested", async () => {
    const store = { "agent:main:main": makeEntry("sess-abc") };
    mocks.loadSessionStore.mockReturnValue(store);
    mocks.cloneSessionStoreRecord.mockImplementation((s: Record<string, SessionEntry>) => ({
      ...s,
    }));

    await runSessionsCleanup({
      cfg: {} as never,
      opts: { fixMissing: false, dryRun: false },
      targets: [TARGET],
    });

    expect(mocks.unbind).not.toHaveBeenCalled();
  });

  it("does not unbind entries whose transcripts still exist on disk", async () => {
    const store = { "agent:main:main": makeEntry("sess-alive") };
    mocks.loadSessionStore.mockReturnValue(store);
    mocks.cloneSessionStoreRecord.mockImplementation((s: Record<string, SessionEntry>) => ({
      ...s,
    }));
    mocks.fs.existsSync.mockReturnValue(true);
    mocks.applySessionEntryLifecycleMutation.mockResolvedValueOnce({
      removedSessionKeys: [],
      maintenanceReport: null,
      afterCount: 0,
      unreferencedArtifacts: { scannedFiles: 0, removedFiles: 0, freedBytes: 0, olderThanMs: 0 },
    });

    await runSessionsCleanup({
      cfg: {} as never,
      opts: { fixMissing: true, dryRun: false },
      targets: [TARGET],
    });

    expect(mocks.unbind).not.toHaveBeenCalled();
  });
});
