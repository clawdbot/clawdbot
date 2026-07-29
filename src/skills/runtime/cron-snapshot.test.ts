// Cron snapshot tests cover runtime skill state attached to scheduled runs.
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  resolveNodeExecEligibilityMock,
  getRemoteSkillEligibilityMock,
  resolveReusableWorkspaceSkillSnapshotMock,
  resolveEffectiveAgentSkillFilterMock,
} = vi.hoisted(() => ({
  resolveNodeExecEligibilityMock: vi.fn().mockReturnValue({ canExec: false }),
  getRemoteSkillEligibilityMock: vi.fn(),
  resolveReusableWorkspaceSkillSnapshotMock: vi.fn(),
  resolveEffectiveAgentSkillFilterMock: vi.fn(),
}));

vi.mock("./cron-snapshot.runtime.js", () => ({
  resolveNodeExecEligibility: resolveNodeExecEligibilityMock,
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
  resolveReusableWorkspaceSkillSnapshot: resolveReusableWorkspaceSkillSnapshotMock,
  resolveEffectiveAgentSkillFilter: resolveEffectiveAgentSkillFilterMock,
}));

const { resolveCronSkillsSnapshot } = await import("./cron-snapshot.js");

describe("resolveCronSkillsSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resolveEffectiveAgentSkillFilterMock.mockReturnValue(undefined);
    getRemoteSkillEligibilityMock.mockReturnValue({
      platforms: [],
      hasBin: () => false,
      hasAnyBin: () => false,
    });
    resolveReusableWorkspaceSkillSnapshotMock.mockReturnValue({
      snapshot: { prompt: "fresh", skills: [] },
      shouldRefresh: true,
      snapshotVersion: 0,
    });
  });

  it("refreshes when the cached skill filter changes", async () => {
    resolveEffectiveAgentSkillFilterMock.mockReturnValue(["docs-search", "github"]);

    const result = await resolveCronSkillsSnapshot({
      workspaceDir: "/tmp/workspace",
      config: {} as never,
      agentId: "writer",
      existingSnapshot: {
        prompt: "old",
        skills: [{ name: "github" }],
        skillFilter: ["github"],
        version: 0,
      },
      isFastTestEnv: false,
    });

    expect(resolveReusableWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    const snapshotOptions = resolveReusableWorkspaceSkillSnapshotMock.mock.calls[0]?.[0] as
      | { agentId?: string; watch?: boolean; hydrateExisting?: boolean }
      | undefined;
    expect(snapshotOptions?.agentId).toBe("writer");
    expect(snapshotOptions?.watch).toBe(false);
    expect(snapshotOptions?.hydrateExisting).toBe(false);
    expect(result).toEqual({ prompt: "fresh", skills: [] });
  });

  it("refreshes when the process version resets to 0 but the cached snapshot is stale", async () => {
    await resolveCronSkillsSnapshot({
      workspaceDir: "/tmp/workspace",
      config: {} as never,
      agentId: "writer",
      existingSnapshot: {
        prompt: "old",
        skills: [{ name: "github" }],
        version: 42,
      },
      isFastTestEnv: false,
    });

    expect(resolveReusableWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
  });
});
