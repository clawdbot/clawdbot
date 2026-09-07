// Session snapshot tests cover runtime skill state captured for agent sessions.
import { expectDefined } from "@openclaw/normalization-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawConfig } from "../../config/config.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
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
  loadMergedWorkspaceSkillsMock,
  shouldRefreshSnapshotForVersionMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]) => ({
    prompt: "",
    skills: [] as unknown[],
    resolvedSkills: [] as unknown[],
  })),
  ensureSkillsWatcherMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(() => 1),
  loadMergedWorkspaceSkillsMock: vi.fn(
    (_params: { pluginMetadataSnapshot?: PluginMetadataSnapshot }) => [],
  ),
  shouldRefreshSnapshotForVersionMock: vi.fn((cached = 0, next = 0) =>
    next === 0 ? cached > 0 : cached < next,
  ),
}));

vi.mock("../loading/workspace-skill-loader.js", () => ({
  loadMergedWorkspaceSkills: loadMergedWorkspaceSkillsMock,
  normalizeWorkspaceSkillRoots: (roots: {
    agentWorkspaceDir: string;
    executionSkillsDir?: string;
  }) => roots,
}));

vi.mock("../loading/workspace-skill-prompt.js", () => ({
  buildSkillSnapshot: buildWorkspaceSkillSnapshotMock,
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

  it("reuses prepared plugin metadata for watcher reconciliation and skill loading", () => {
    const pluginMetadataSnapshot = { policyHash: "prepared" } as PluginMetadataSnapshot;

    resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      executionSkillsDir: "/tmp/execution/skills",
      config: {},
      pluginMetadataSnapshot,
    });

    expect(loadMergedWorkspaceSkillsMock).toHaveBeenCalledOnce();
    expect(loadMergedWorkspaceSkillsMock.mock.calls[0]?.[0].pluginMetadataSnapshot).toBe(
      pluginMetadataSnapshot,
    );
    expect(ensureSkillsWatcherMock).toHaveBeenCalledWith(
      expect.objectContaining({ pluginMetadataSnapshot }),
    );
  });

  it("reuses complete cached snapshots for fresh sessions until the snapshot version changes", () => {
    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "cached skills prompt",
      skills: [{ name: "cached-skill" }],
      resolvedSkills: [{ name: "cached-skill" }],
    });
    const params = { workspaceDir: TEST_WORKSPACE_DIR, config: {} };

    const first = resolveReusableWorkspaceSkillSnapshot(params);
    const second = resolveReusableWorkspaceSkillSnapshot(params);

    expect(second.snapshot).toBe(first.snapshot);
    expect(second.snapshot.prompt).toBe("cached skills prompt");
    expect(second.snapshot.skills).toEqual([{ name: "cached-skill" }]);
    expect(second.snapshot.resolvedSkills).toEqual([{ name: "cached-skill" }]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledOnce();

    getSkillsSnapshotVersionMock.mockReturnValue(2);
    resolveReusableWorkspaceSkillSnapshot(params);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
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

  it("refreshes snapshots from before config-key skill identities", () => {
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    const result = resolveReusableWorkspaceSkillSnapshot({
      workspaceDir: TEST_WORKSPACE_DIR,
      config: {},
      existingSnapshot: {
        ...strippedSnapshot(),
        promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION - 1,
      },
    });

    expect(result.shouldRefresh).toBe(true);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
