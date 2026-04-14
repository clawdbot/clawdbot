import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  buildWorkspaceSkillSnapshotMock,
  canExecRequestNodeMock,
  getRemoteSkillEligibilityMock,
  getSkillsSnapshotVersionMock,
  resolveAgentSkillsFilterMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn(),
  canExecRequestNodeMock: vi.fn().mockReturnValue(false),
  getRemoteSkillEligibilityMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(),
  resolveAgentSkillsFilterMock: vi.fn(),
}));

vi.mock("./skills-snapshot.runtime.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
  canExecRequestNode: canExecRequestNodeMock,
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  resolveAgentSkillsFilter: resolveAgentSkillsFilterMock,
}));

const { resolveCronSkillsSnapshot } = await import("./skills-snapshot.js");

describe("resolveCronSkillsSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    resolveAgentSkillsFilterMock.mockReturnValue(undefined);
    getRemoteSkillEligibilityMock.mockReturnValue({
      platforms: [],
      hasBin: () => false,
      hasAnyBin: () => false,
    });
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "fresh", skills: [] });
  });

  it("refreshes when the cached skill filter changes", async () => {
    resolveAgentSkillsFilterMock.mockReturnValue(["docs-search", "github"]);

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

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
    expect(buildWorkspaceSkillSnapshotMock.mock.calls[0]?.[1]).toMatchObject({
      agentId: "writer",
      snapshotVersion: 0,
    });
    expect(result).toEqual({ prompt: "fresh", skills: [] });
  });

  it("refreshes when the process version resets to 0 but the cached snapshot is stale", async () => {
    getSkillsSnapshotVersionMock.mockReturnValue(0);

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

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();
  });
});
