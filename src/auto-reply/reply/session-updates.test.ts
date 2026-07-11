// Tests session update fanout and persisted lifecycle records.
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import type { SessionEntry } from "../../config/sessions/types.js";

const TEST_WORKSPACE_DIR = "/tmp/workspace";

const {
  buildWorkspaceSkillSnapshotMock,
  ensureSkillsWatcherMock,
  getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersionMock,
  getRemoteSkillEligibilityMock,
  resolveAgentConfigMock,
  resolveSessionAgentIdMock,
  resolveAgentIdFromSessionKeyMock,
  resolveNodeExecEligibilityMock,
} = vi.hoisted(() => ({
  buildWorkspaceSkillSnapshotMock: vi.fn((..._args: unknown[]) => ({
    prompt: "",
    skills: [] as unknown[],
    resolvedSkills: [] as unknown[],
  })),
  ensureSkillsWatcherMock: vi.fn(),
  getSkillsSnapshotVersionMock: vi.fn(() => 0),
  shouldRefreshSnapshotForVersionMock: vi.fn((_cached?: number, _next?: number) => false),
  getRemoteSkillEligibilityMock: vi.fn(() => ({
    platforms: [],
    hasBin: () => false,
    hasAnyBin: () => false,
  })),
  resolveAgentConfigMock: vi.fn(() => undefined),
  resolveSessionAgentIdMock: vi.fn(() => "writer"),
  resolveAgentIdFromSessionKeyMock: vi.fn(() => "main"),
  resolveNodeExecEligibilityMock: vi.fn(() => ({ canExec: false })),
}));

vi.mock("../../agents/agent-scope.js", () => ({
  resolveAgentConfig: resolveAgentConfigMock,
  resolveSessionAgentId: resolveSessionAgentIdMock,
}));

vi.mock("../../agents/exec-defaults.js", () => ({
  resolveNodeExecEligibility: resolveNodeExecEligibilityMock,
}));

vi.mock("../../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: getRemoteSkillEligibilityMock,
}));

vi.mock("../../skills/loading/workspace.js", () => ({
  buildWorkspaceSkillSnapshot: buildWorkspaceSkillSnapshotMock,
}));

vi.mock("../../skills/runtime/refresh.js", () => ({
  ensureSkillsWatcher: ensureSkillsWatcherMock,
}));

vi.mock("../../skills/runtime/refresh-state.js", () => ({
  getSkillsSnapshotVersion: getSkillsSnapshotVersionMock,
  shouldRefreshSnapshotForVersion: shouldRefreshSnapshotForVersionMock,
}));

vi.mock("../../config/sessions.js", () => ({
  updateSessionStore: vi.fn(),
  resolveSessionFilePath: vi.fn(),
  resolveSessionFilePathOptions: vi.fn(),
}));

vi.mock("../../routing/session-key.js", () => ({
  normalizeAgentId: (id: string) => id,
  normalizeMainKey: (key?: string) => key ?? "main",
  resolveAgentIdFromSessionKey: resolveAgentIdFromSessionKeyMock,
}));

const { ensureSkillSnapshot } = await import("./session-updates.js");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

describe("ensureSkillSnapshot", () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    resolveNodeExecEligibilityMock.mockReturnValue({ canExec: false });
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
      execOverrides: { host: "node", node: "build-node", security: "allowlist" },
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
    expect(resolveNodeExecEligibilityMock).toHaveBeenCalledWith(
      expect.objectContaining({
        execOverrides: { host: "node", node: "build-node", security: "allowlist" },
      }),
    );
  });

  it("keeps a concurrent rename and unpin while persisting a skill snapshot", async () => {
    vi.stubEnv("OPENCLAW_TEST_FAST", "0");
    const root = tempDirs.make("openclaw-session-updates-");
    const storePath = path.join(root, "sessions.json");
    const sessionKey = "agent:main:reply";
    const staleEntry: SessionEntry = {
      sessionId: "reply-session",
      updatedAt: 1,
      label: "Before rename",
      pinnedAt: 100,
    };
    await fs.writeFile(
      storePath,
      JSON.stringify({
        [sessionKey]: {
          sessionId: staleEntry.sessionId,
          updatedAt: 2,
          label: "After rename",
          sendPolicy: "deny",
        },
      }),
      "utf8",
    );
    const sessionStore = { [sessionKey]: staleEntry };

    const result = await ensureSkillSnapshot({
      sessionEntry: staleEntry,
      sessionStore,
      sessionKey,
      storePath,
      isFirstTurnInSession: true,
      workspaceDir: TEST_WORKSPACE_DIR,
      cfg: {},
    });

    expect(result.sessionEntry).toMatchObject({
      sessionId: "reply-session",
      label: "After rename",
      sendPolicy: "deny",
      systemSent: true,
    });
    expect(result.sessionEntry?.pinnedAt).toBeUndefined();
    expect(sessionStore[sessionKey]).toBe(result.sessionEntry);
    const persisted = JSON.parse(await fs.readFile(storePath, "utf8")) as Record<
      string,
      SessionEntry
    >;
    expect(persisted[sessionKey]?.label).toBe("After rename");
    expect(persisted[sessionKey]?.pinnedAt).toBeUndefined();
    expect(persisted[sessionKey]?.sendPolicy).toBe("deny");
    expect(persisted[sessionKey]?.skillsSnapshot).toBeDefined();
  });
});
