// Session snapshot tests cover runtime skill state captured for agent sessions.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION } from "../types.js";
import type { SkillSnapshot } from "../types.js";

const TEST_WORKSPACE_DIR = "/tmp/workspace";

function strippedSnapshot(skillName = "test", version = 1): SkillSnapshot {
  return {
    prompt: "skills prompt",
    skills: [{ name: skillName }],
    version,
    promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION,
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
  getSkillsSnapshotVersionMock: vi.fn(() => 1),
  shouldRefreshSnapshotForVersionMock: vi.fn((cached = 0, next = 0) =>
    next === 0 ? cached > 0 : cached < next,
  ),
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

let resolveReusableWorkspaceSkillSnapshot: typeof import("./session-snapshot.js").resolveReusableWorkspaceSkillSnapshot;

describe("resolveReusableWorkspaceSkillSnapshot", () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ resolveReusableWorkspaceSkillSnapshot } = await import("./session-snapshot.js"));
    vi.clearAllMocks();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", skills: [], resolvedSkills: [] });
    ensureSkillsWatcherMock.mockImplementation(() => undefined);
    getSkillsSnapshotVersionMock.mockReturnValue(1);
    shouldRefreshSnapshotForVersionMock.mockImplementation((cached = 0, next = 0) =>
      next === 0 ? cached > 0 : cached < next,
    );
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

  it("refreshes when effective node-skill eligibility changes", () => {
    const result = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      eligibility: { nodeSkills: { canExec: false } },
      existingSnapshot: {
        ...strippedSnapshot(),
        nodeSkillsEligibility: { canExec: true, node: "build-node" },
      },
    });

    expect(result.shouldRefresh).toBe(true);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("reads the skills snapshot version after watcher-side invalidation", () => {
    getSkillsSnapshotVersionMock.mockReturnValue(1);
    ensureSkillsWatcherMock.mockImplementation(() => {
      getSkillsSnapshotVersionMock.mockReturnValue(5);
    });

    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: { skills: { load: { extraDirs: ["/tmp/shared-skills"] } } },
      existingSnapshot: strippedSnapshot("test", 1),
    });

    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(1, 5);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [, snapshotParams] = expectDefined(
      (
        buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<
          [string, { snapshotVersion?: number }]
        >
      )[0],
      "(buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<\n        [string, { snapshotVersion?: number }]\n      >)[0] test invariant",
    );
    expect(snapshotParams.snapshotVersion).toBe(5);
  });

  it("refreshes persisted version-0 snapshots after process restart", () => {
    const result = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: strippedSnapshot("test", 0),
    });

    expect(result.shouldRefresh).toBe(true);
    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(0, 1);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [, snapshotParams] = expectDefined(
      (
        buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<
          [string, { snapshotVersion?: number }]
        >
      )[0],
      "(buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<\n        [string, { snapshotVersion?: number }]\n      >)[0] test invariant",
    );
    expect(snapshotParams.snapshotVersion).toBe(1);
  });

  it("refreshes persisted timestamp-version snapshots from earlier processes", () => {
    getSkillsSnapshotVersionMock.mockReturnValue(10_000);

    const result = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: strippedSnapshot("test", 9_999),
    });

    expect(result.shouldRefresh).toBe(true);
    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(9_999, 10_000);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [, snapshotParams] = expectDefined(
      (
        buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<
          [string, { snapshotVersion?: number }]
        >
      )[0],
      "(buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<\n        [string, { snapshotVersion?: number }]\n      >)[0] test invariant",
    );
    expect(snapshotParams.snapshotVersion).toBe(10_000);
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

  it("refreshes persisted snapshots missing the current prompt format marker", () => {
    ensureSkillsWatcherMock.mockImplementation(() => undefined);
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    const oldSnapshot = {
      ...strippedSnapshot(),
      version: 5,
      promptFormatVersion: undefined,
    };

    const result = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: oldSnapshot,
    });

    expect(result.shouldRefresh).toBe(true);
    expect(shouldRefreshSnapshotForVersionMock).toHaveBeenCalledWith(5, 0);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [, snapshotParams] = expectDefined(
      (
        buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<
          [string, { snapshotVersion?: number }]
        >
      )[0],
      "(buildWorkspaceSkillSnapshotMock.mock.calls as unknown as Array<\n        [string, { snapshotVersion?: number }]\n      >)[0] test invariant",
    );
    expect(snapshotParams.snapshotVersion).toBe(0);
  });
});
