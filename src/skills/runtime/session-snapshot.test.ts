import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { SkillSnapshot } from "../types.js";

const TEST_WORKSPACE_DIR = "/tmp/workspace";

function strippedSnapshot(skillName = "test"): SkillSnapshot {
  return {
    prompt: "skills prompt",
    skills: [{ name: skillName }],
    version: 0,
  };
}

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]) => ({
    prompt: "",
    skills: [] as unknown[],
    resolvedSkills: [] as unknown[],
  })),
  ensureSkillsWatcherMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(() => 0),
  shouldRefreshSnapshotForVersionMock: vi.fn((_cached?: number, _next?: number) => false),
}));

vi.mock("../loading/workspace.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("./refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
}));

vi.mock("./refresh-state.js", () => ({
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

const { resolveReusableWorkspaceSkillSnapshot, resetResolvedSkillsCacheForTests } =
  await import("./session-snapshot.js");

describe("resolveReusableWorkspaceSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetResolvedSkillsCacheForTests();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", skills: [], resolvedSkills: [] });
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
  });

  it("reuses cached resolvedSkills across calls with the same workspace, version, and filter", () => {
    const snapshot = strippedSnapshot();

    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: snapshot,
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: { ...snapshot },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates cached resolvedSkills when skillFilter changes", () => {
    const snapshot = strippedSnapshot();

    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: snapshot,
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      skillFilter: ["new-filter"],
      existingSnapshot: {
        ...snapshot,
        skillFilter: ["old-filter"],
      },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("reads the skills snapshot version after watcher-side invalidation", () => {
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    ensureSkillsWatcherMock.mockImplementation(() => {
      getSkillsSnapshotVersionMock.mockReturnValue(5);
    });
    shouldRefreshSnapshotForVersionMock.mockImplementation((cached = 0, next = 0) => cached < next);

    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { skills: { load: { extraDirs: ["/tmp/shared-skills"] } } },
      existingSnapshot: strippedSnapshot(),
    });

    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(0, 5);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [[, snapshotParams]] = buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<
      [string, { snapshotVersion?: number }]
    >;
    expect(snapshotParams.snapshotVersion).toBe(5);
  });

  it("invalidates cached resolvedSkills when non-skills config gates change", () => {
    buildWorkspaceSkillSnapshotMock.mockImplementation((_workspaceDir, opts) => {
      const config = (opts as { config?: { channels?: { discord?: { token?: string } } } }).config;
      return {
        prompt: "",
        skills: [],
        resolvedSkills: config?.channels?.discord?.token ? [{ name: "discord" }] : [],
      };
    });

    const snapshot = strippedSnapshot("discord");

    const first = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { channels: { discord: { token: "enabled" } } } as OpenClawConfig,
      existingSnapshot: snapshot,
    });

    expect(first.snapshot.resolvedSkills).toEqual([{ name: "discord" }]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    const second = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { channels: { discord: {} } } as OpenClawConfig,
      existingSnapshot: { ...snapshot },
    });

    expect(second.snapshot.resolvedSkills).toEqual([]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("redacts secret values in the cache key while preserving eligibility presence", () => {
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "",
      skills: [],
      resolvedSkills: [{ name: "discord" }],
    });

    const snapshot = strippedSnapshot("discord");

    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { channels: { discord: { token: "first-secret" } } } as OpenClawConfig,
      existingSnapshot: snapshot,
    });

    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { channels: { discord: { token: "rotated-secret" } } } as OpenClawConfig,
      existingSnapshot: { ...snapshot },
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
