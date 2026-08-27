import { beforeEach, describe, expect, it, vi } from "vitest";

const listSessionEntriesReadOnlyMock = vi.hoisted(() => vi.fn());
const applySessionEntryLifecycleMutationMock = vi.hoisted(() =>
  vi.fn(async () => ({ archivedTranscriptDirectories: [] })),
);
const resolveAllAgentSessionStoreTargetsSyncMock = vi.hoisted(() => vi.fn());
const shortenHomePathMock = vi.hoisted(() => (path: string) => path);

vi.mock("../config/sessions/session-accessor.sqlite-entry.js", () => ({
  listSessionEntriesReadOnly: listSessionEntriesReadOnlyMock,
}));

vi.mock("../config/sessions/session-accessor.sqlite-projection.js", () => ({
  applySessionEntryLifecycleMutation: applySessionEntryLifecycleMutationMock,
}));

vi.mock("../config/sessions/targets.js", () => ({
  resolveAllAgentSessionStoreTargetsSync: resolveAllAgentSessionStoreTargetsSyncMock,
}));

vi.mock("../utils.js", () => ({
  shortenHomePath: shortenHomePathMock,
}));

const { detectLegacyBootSessionEntries, repairLegacyBootSessionEntries } =
  await import("./doctor-session-legacy-boot.js");

function makeEntry(overrides?: { lifecycleRevision?: string; createdAt?: number }) {
  return {
    sessionId: "session-id",
    updatedAt: 1700000000000,
    systemSent: false,
    label: "Boot",
    ...overrides,
  };
}

const cfg = {} as unknown as import("../config/types.openclaw.js").OpenClawConfig;

describe("detectLegacyBootSessionEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an empty array when no targets exist", () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([]);
    expect(detectLegacyBootSessionEntries({ cfg })).toEqual([]);
  });

  it("returns an empty array when no legacy boot entries exist", () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/agents/main/sessions" },
    ]);
    listSessionEntriesReadOnlyMock.mockReturnValue([
      { sessionKey: "agent:main:boot", entry: makeEntry({ lifecycleRevision: "abc-123" }) },
      { sessionKey: "agent:main:telegram:direct:42", entry: makeEntry() },
    ]);

    const findings = detectLegacyBootSessionEntries({ cfg });

    expect(findings).toEqual([]);
    expect(listSessionEntriesReadOnlyMock).toHaveBeenCalledWith({
      agentId: "main",
      storePath: "/state/agents/main/sessions",
      env: process.env,
    });
  });

  it("detects boot entries missing lifecycleRevision and createdAt", () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/agents/main/sessions" },
    ]);
    listSessionEntriesReadOnlyMock.mockReturnValue([
      { sessionKey: "agent:main:boot", entry: makeEntry() },
      { sessionKey: "agent:main:boot", entry: makeEntry({ lifecycleRevision: "abc-123" }) },
    ]);

    const findings = detectLegacyBootSessionEntries({ cfg });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      checkId: "core/doctor/legacy-boot-session-state",
      severity: "warning",
      target: "agent:main:boot",
      path: "/state/agents/main/sessions",
    });
  });

  it("preserves revision-less boot entries that have createdAt provenance", () => {
    // A current post-7.1 entry may lack lifecycleRevision but still have
    // createdAt — the dual-field check prevents deleting valid state.
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/agents/main/sessions" },
    ]);
    listSessionEntriesReadOnlyMock.mockReturnValue([
      { sessionKey: "agent:main:boot", entry: makeEntry({ createdAt: 1720000000000 }) },
    ]);

    const findings = detectLegacyBootSessionEntries({ cfg });

    expect(findings).toEqual([]);
  });

  it("propagates lock errors instead of masking them as clean stores", () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/agents/main/sessions" },
    ]);
    listSessionEntriesReadOnlyMock.mockImplementation(() => {
      throw new Error("database locked");
    });

    expect(() => detectLegacyBootSessionEntries({ cfg })).toThrow("database locked");
  });

  it("preserves unrelated session keys that end with :boot", () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/agents/main/sessions" },
    ]);
    listSessionEntriesReadOnlyMock.mockReturnValue([
      { sessionKey: "agent:main:boot", entry: makeEntry() },
      { sessionKey: "custom:boot", entry: makeEntry() },
      { sessionKey: "workspace:main:boot", entry: makeEntry() },
    ]);

    const findings = detectLegacyBootSessionEntries({ cfg });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.target).toBe("agent:main:boot");
  });

  it("detects legacy boot entries for all agents in a shared store", () => {
    // Shared store deduplication keeps only one target, but the single DB contains
    // sessions for multiple agents. Each agent's legacy boot entry must be detected.
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/shared/openclaw-agent.sqlite" },
    ]);
    listSessionEntriesReadOnlyMock.mockReturnValue([
      { sessionKey: "agent:main:boot", entry: makeEntry() },
      { sessionKey: "agent:ops:boot", entry: makeEntry() },
      {
        sessionKey: "agent:ops:telegram:direct:42",
        entry: makeEntry({ lifecycleRevision: "abc" }),
      },
    ]);

    const findings = detectLegacyBootSessionEntries({ cfg });

    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.target).toSorted((a, b) => a.localeCompare(b))).toEqual([
      "agent:main:boot",
      "agent:ops:boot",
    ]);
  });
});

describe("repairLegacyBootSessionEntries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does nothing when no legacy boot entries exist", async () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([]);

    const result = await repairLegacyBootSessionEntries({ cfg });

    expect(result).toEqual({ changes: [] });
    expect(applySessionEntryLifecycleMutationMock).not.toHaveBeenCalled();
  });

  it("reports would-remove effects in dry-run mode without mutating state", async () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/agents/main/sessions" },
    ]);
    listSessionEntriesReadOnlyMock.mockReturnValue([
      { sessionKey: "agent:main:boot", entry: makeEntry() },
    ]);

    const result = await repairLegacyBootSessionEntries({ cfg, dryRun: true });

    expect(applySessionEntryLifecycleMutationMock).not.toHaveBeenCalled();
    expect(result.status).toBe("repaired");
    expect(result.changes).toHaveLength(1);
    expect(result.effects).toHaveLength(1);
    expect(result.effects?.[0]).toMatchObject({
      kind: "state",
      action: "would-remove-legacy-boot-session-entry",
    });
  });

  it("removes legacy boot entries grouped by store", async () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/agents/main/sessions" },
      { agentId: "ops", storePath: "/state/agents/ops/sessions" },
    ]);
    listSessionEntriesReadOnlyMock.mockImplementation(({ agentId }: { agentId: string }) => {
      if (agentId === "main") {
        return [
          { sessionKey: "agent:main:boot", entry: makeEntry() },
          { sessionKey: "agent:main:boot", entry: makeEntry() },
        ];
      }
      return [{ sessionKey: "agent:ops:boot", entry: makeEntry() }];
    });

    const result = await repairLegacyBootSessionEntries({ cfg });

    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalledTimes(2);
    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/state/agents/main/sessions",
        removals: [
          { sessionKey: "agent:main:boot", expectedEntry: expect.any(Object) },
          { sessionKey: "agent:main:boot", expectedEntry: expect.any(Object) },
        ],
        skipMaintenance: true,
      }),
    );
    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/state/agents/ops/sessions",
        removals: [{ sessionKey: "agent:ops:boot", expectedEntry: expect.any(Object) }],
        skipMaintenance: true,
      }),
    );
    expect(result.status).toBe("repaired");
    expect(result.changes).toHaveLength(3);
    expect(result.effects).toHaveLength(3);
    expect(result.effects?.every((e) => e.action === "remove-legacy-boot-session-entry")).toBe(
      true,
    );
  });

  it("is idempotent when removal targets are already gone", async () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/agents/main/sessions" },
    ]);
    listSessionEntriesReadOnlyMock.mockReturnValue([]);

    const result = await repairLegacyBootSessionEntries({ cfg });

    expect(result).toEqual({ changes: [] });
    expect(applySessionEntryLifecycleMutationMock).not.toHaveBeenCalled();
  });

  it("reports warnings when a store removal fails", async () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/agents/main/sessions" },
    ]);
    listSessionEntriesReadOnlyMock.mockReturnValue([
      { sessionKey: "agent:main:boot", entry: makeEntry() },
    ]);
    applySessionEntryLifecycleMutationMock.mockRejectedValue(new Error("transaction conflict"));

    const result = await repairLegacyBootSessionEntries({ cfg });

    expect(result.status).toBe("failed");
    expect(result.changes).toEqual([]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings?.[0]).toContain("transaction conflict");
  });

  it("does not remove unrelated session keys that end with :boot", async () => {
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/agents/main/sessions" },
    ]);
    listSessionEntriesReadOnlyMock.mockReturnValue([
      { sessionKey: "agent:main:boot", entry: makeEntry() },
      { sessionKey: "custom:boot", entry: makeEntry() },
      { sessionKey: "workspace:main:boot", entry: makeEntry() },
    ]);
    applySessionEntryLifecycleMutationMock.mockResolvedValue({ archivedTranscriptDirectories: [] });

    const result = await repairLegacyBootSessionEntries({ cfg });

    expect(result.status).toBe("repaired");
    expect(result.changes).toHaveLength(1);
    expect(result.changes?.[0]).toContain("agent:main:boot");
    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalledTimes(1);
    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/state/agents/main/sessions",
        removals: [{ sessionKey: "agent:main:boot", expectedEntry: expect.any(Object) }],
        skipMaintenance: true,
      }),
    );
  });

  it("removes legacy boot entries for all agents in a shared store", async () => {
    // Deduplicated shared target: one physical store, multiple agent entries.
    resolveAllAgentSessionStoreTargetsSyncMock.mockReturnValue([
      { agentId: "main", storePath: "/state/shared/openclaw-agent.sqlite" },
    ]);
    listSessionEntriesReadOnlyMock.mockReturnValue([
      { sessionKey: "agent:main:boot", entry: makeEntry() },
      { sessionKey: "agent:ops:boot", entry: makeEntry() },
    ]);
    applySessionEntryLifecycleMutationMock.mockResolvedValue({ archivedTranscriptDirectories: [] });

    const result = await repairLegacyBootSessionEntries({ cfg });

    expect(result.status).toBe("repaired");
    expect(result.changes).toHaveLength(2);
    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalledTimes(1);
    expect(applySessionEntryLifecycleMutationMock).toHaveBeenCalledWith(
      expect.objectContaining({
        storePath: "/state/shared/openclaw-agent.sqlite",
        removals: expect.arrayContaining([
          { sessionKey: "agent:main:boot", expectedEntry: expect.any(Object) },
          { sessionKey: "agent:ops:boot", expectedEntry: expect.any(Object) },
        ]),
        skipMaintenance: true,
      }),
    );
  });
});
