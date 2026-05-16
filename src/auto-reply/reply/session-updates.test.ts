import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";

const TEST_WORKSPACE_DIR = "/tmp/workspace";
type TestSkillSnapshot = NonNullable<SessionEntry["skillsSnapshot"]>;

function strippedSnapshot(skillName = "test"): TestSkillSnapshot {
  return {
    prompt: "skills prompt",
    skills: [{ name: skillName }],
    version: 0,
  };
}

function testSessionEntry(sessionId: string, skillsSnapshot: TestSkillSnapshot): SessionEntry {
  return {
    sessionId,
    updatedAt: Date.now(),
    skillsSnapshot,
  };
}

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
  getRemoteSkillEligibilityMock,
  resolveAgentConfigMock,
  resolveSessionAgentIdMock,
  resolveAgentIdFromSessionKeyMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]) => ({
    prompt: "",
    skills: [] as unknown[],
    resolvedSkills: [] as unknown[],
  })),
  ensureSkillsWatcherMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(() => 0),
  shouldRefreshSnapshotForVersionMock: vi.fn(() => false),
  getRemoteSkillEligibilityMock: vi.fn(() => ({
    platforms: [],
    hasBin: () => false,
    hasAnyBin: () => false,
  })),
  resolveAgentConfigMock: vi.fn(() => undefined),
  resolveSessionAgentIdMock: vi.fn(() => "writer"),
  resolveAgentIdFromSessionKeyMock: vi.fn(() => "main"),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

vi.mock("../../agents/skills.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../agents/skills/refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(),
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

vi.mock("../../infra/skills-remote.js", () => ({
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: (id: string) => id,
  normalizeMainKey: (key?: string) => key ?? "main",
  resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyMock,
}));

const { ensureSkillSnapshot, __testing_resetResolvedSkillsCache } =
  await import("./session-updates.js");

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __testing_resetResolvedSkillsCache();
    buildWorkspaceSkillSnapshotMock.mockReturnValue({ prompt: "", skills: [], resolvedSkills: [] });
    getSkillsSnapshotVersionMock.mockReturnValue(0);
    shouldRefreshSnapshotForVersionMock.mockReturnValue(false);
    getRemoteSkillEligibilityMock.mockReturnValue({
      platforms: [],
      hasBin: () => false,
      hasAnyBin: () => false,
    });
    resolveAgentConfigMock.mockReturnValue(undefined);
    resolveSessionAgentIdMock.mockReturnValue("writer");
    resolveAgentIdFromSessionKeyMock.mockReturnValue("main");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses config-aware session agent resolution for legacy session keys", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    await ensureSkillSnapshot({
      sessionKey: "main",
      isFirstTurnInSession: false,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });

    expect(resolveSessionAgentIdMock).toHaveBeenCalledWith({
      sessionKey: "main",
      config: {
        agents: {
          list: [{ id: "writer", default: true }],
        },
      },
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
    const [[workspaceDir, snapshotParams]] = buildWorkspaceSkillSnapshotMock.mock
      .calls as unknown as Array<[string, { agentId?: string }]>;
    expect(workspaceDir).toBe(TEST_WORKSPACE_DIR);
    expect(snapshotParams.agentId).toBe("writer");
    expect(resolveAgentIdFromSessionKeyMock).not.toHaveBeenCalled();
  });

  it("reuses cached resolvedSkills across calls with same workspaceDir/version/filter", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    const sessionStore: Record<string, SessionEntry> = {};
    const sessionKey = "main";
    const snapshot = strippedSnapshot();
    const sessionEntry = testSessionEntry("sess-1", snapshot);

    await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey,
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    const sessionEntry2 = testSessionEntry("sess-2", { ...snapshot });
    await ensureSkillSnapshot({
      sessionEntry: sessionEntry2,
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });

  it("invalidates cache when skillFilter changes", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    const sessionStore: Record<string, SessionEntry> = {};
    const sessionKey = "main";
    const snapshot = strippedSnapshot();
    const sessionEntry = testSessionEntry("sess-1", snapshot);

    await ensureSkillSnapshot({
      sessionEntry,
      sessionStore,
      sessionKey,
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    const sessionEntry2 = testSessionEntry("sess-2", {
      ...snapshot,
      skillFilter: ["old-filter"],
    });
    await ensureSkillSnapshot({
      sessionEntry: sessionEntry2,
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: TEST_WORKSPACE_DIR,
      skillFilter: ["new-filter"],
      cfg: {},
    });
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("invalidates cache when non-skills config gates change", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    buildWorkspaceSkillSnapshotMock.mockImplementation((_workspaceDir, opts) => {
      const config = (opts as { config?: { channels?: { discord?: { token?: string } } } }).config;
      return {
        prompt: "",
        skills: [],
        resolvedSkills: config?.channels?.discord?.token ? [{ name: "discord" }] : [],
      };
    });

    const snapshot = strippedSnapshot("discord");

    const first = await ensureSkillSnapshot({
      sessionEntry: testSessionEntry("sess-1", snapshot),
      sessionStore: {},
      sessionKey: "main",
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: { channels: { discord: { token: "enabled" } } },
    });

    expect(first.skillsSnapshot?.resolvedSkills).toEqual([{ name: "discord" }]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);

    const second = await ensureSkillSnapshot({
      sessionEntry: testSessionEntry("sess-2", { ...snapshot }),
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: { channels: { discord: {} } },
    });

    expect(second.skillsSnapshot?.resolvedSkills).toEqual([]);
    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(2);
  });

  it("redacts secret values in the cache key while preserving eligibility presence", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");

    buildWorkspaceSkillSnapshotMock.mockReturnValue({
      prompt: "",
      skills: [],
      resolvedSkills: [{ name: "discord" }],
    });

    const snapshot = strippedSnapshot("discord");

    await ensureSkillSnapshot({
      sessionEntry: testSessionEntry("sess-1", snapshot),
      sessionStore: {},
      sessionKey: "main",
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: { channels: { discord: { token: "first-secret" } } },
    });

    await ensureSkillSnapshot({
      sessionEntry: testSessionEntry("sess-2", { ...snapshot }),
      sessionStore: {},
      sessionKey: "other",
      isFirstTurnInSession: false,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: { channels: { discord: { token: "rotated-secret" } } },
    });

    expect(buildWorkspaceSkillSnapshotMock).toHaveBeenCalledTimes(1);
  });
});
