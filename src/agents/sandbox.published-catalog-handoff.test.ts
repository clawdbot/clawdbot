// The per-run handoff must carry this run's sync result, not the shared cache.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  resolveSyncedSkillsCacheKey,
  writeSyncedSkillsUsageCache,
} from "../skills/loading/workspace-skill-sync-cache.js";
import type { SkillSnapshot } from "../skills/types.js";

const syncSkillsToWorkspaceMock = vi.hoisted(() =>
  vi.fn(
    async (_params: {
      targetWorkspaceDir: string;
    }): Promise<{
      skillUsagePaths: never[];
      skillsSnapshot: SkillSnapshot;
    }> => ({
      skillUsagePaths: [],
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [] },
    }),
  ),
);

vi.mock("./exec-defaults.js", () => ({
  resolveNodeExecEligibility: vi.fn(() => ({ canExec: false })),
}));

vi.mock("../skills/runtime/remote.js", () => ({
  getRemoteSkillEligibility: vi.fn(() => ({ note: "test-remote" })),
}));

vi.mock("../skills/loading/workspace-skill-sync.runtime.js", () => ({
  syncWorkspaceSkills: syncSkillsToWorkspaceMock,
}));

import { ensureSandboxWorkspaceForSession } from "./sandbox/context.js";
import { readPublishedSandboxSkills } from "./sandbox/published-skills-handoff.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sandboxConfig(workspaceRoot: string): OpenClawConfig {
  return {
    agents: {
      defaults: {
        sandbox: {
          mode: "all",
          scope: "session",
          workspaceAccess: "ro",
          workspaceRoot,
        },
      },
    },
  };
}

describe("published sandbox catalog handoff", () => {
  afterEach(() => {
    syncSkillsToWorkspaceMock.mockReset();
    syncSkillsToWorkspaceMock.mockResolvedValue({
      skillUsagePaths: [],
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [] },
    });
  });

  it("keeps this run's catalog after a queued sync overwrites the shared cache", async () => {
    const bundledDir = tempDirs.make("openclaw-catalog-handoff-bundled-");
    const workspaceDir = tempDirs.make("openclaw-catalog-handoff-workspace-");
    const ownSnapshot = {
      prompt: "<available_skills>one</available_skills>",
      skills: [{ name: "alpha" }],
      resolvedSkills: [],
    } satisfies SkillSnapshot;
    const queuedSnapshot = {
      prompt: "<available_skills>two</available_skills>",
      skills: [{ name: "beta" }],
      resolvedSkills: [],
    } satisfies SkillSnapshot;
    syncSkillsToWorkspaceMock.mockImplementationOnce(
      async (params: { targetWorkspaceDir: string }) => {
        // A queued later sync can publish and write the cache after this result
        // is selected. The prompt must still read the snapshot it was handed.
        writeSyncedSkillsUsageCache(resolveSyncedSkillsCacheKey(params.targetWorkspaceDir), {
          manifestKey: "queued",
          skillUsagePaths: [],
          skillsSnapshot: queuedSnapshot,
        });
        return { skillUsagePaths: [], skillsSnapshot: ownSnapshot };
      },
    );

    const result = await ensureSandboxWorkspaceForSession({
      config: sandboxConfig(path.join(bundledDir, "sandboxes")),
      sessionKey: "agent:main:main",
      workspaceDir,
    });
    if (!result) {
      throw new Error("expected sandbox workspace resolution");
    }
    expect(readPublishedSandboxSkills(result)).toEqual(ownSnapshot);
  });
});
