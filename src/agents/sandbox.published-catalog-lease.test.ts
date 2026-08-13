// Published sandbox catalog leases are opt-in and pin the sync-returned generation.
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import type { OpenClawConfig } from "../config/config.js";
import {
  collectRetainedSyncedSkillGenerations,
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
      generation: number;
    }> => ({
      skillUsagePaths: [],
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [] },
      generation: 0,
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
import {
  readPublishedSandboxSkills,
  releasePublishedSandboxSkills,
} from "./sandbox/published-skills-handoff.js";

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

describe("published sandbox catalog leases", () => {
  afterEach(() => {
    syncSkillsToWorkspaceMock.mockReset();
    syncSkillsToWorkspaceMock.mockResolvedValue({
      skillUsagePaths: [],
      skillsSnapshot: { prompt: "", skills: [], resolvedSkills: [] },
      generation: 0,
    });
  });

  it("does not keep a generation lease unless prompt readers opt in", async () => {
    const bundledDir = tempDirs.make("openclaw-catalog-lease-bundled-");
    const workspaceDir = tempDirs.make("openclaw-catalog-lease-workspace-");
    const skillsSnapshot = {
      prompt: "<available_skills></available_skills>",
      skills: [{ name: "demo" }],
      resolvedSkills: [],
    } satisfies SkillSnapshot;
    syncSkillsToWorkspaceMock.mockResolvedValueOnce({
      skillUsagePaths: [],
      skillsSnapshot,
      generation: 1,
    });

    const result = await ensureSandboxWorkspaceForSession({
      config: sandboxConfig(path.join(bundledDir, "sandboxes")),
      sessionKey: "agent:main:main",
      workspaceDir,
    });
    if (!result) {
      throw new Error("expected sandbox workspace resolution");
    }

    expect(readPublishedSandboxSkills(result)).toBeUndefined();
    expect(
      collectRetainedSyncedSkillGenerations({
        targetSkillsDir: resolveSyncedSkillsCacheKey(result.workspaceDir),
        currentGeneration: 3,
        previousGeneration: 2,
      }).has(1),
    ).toBe(false);
  });

  it("leases the sync-returned generation after a queued cache write", async () => {
    const bundledDir = tempDirs.make("openclaw-catalog-lease-bundled-");
    const workspaceDir = tempDirs.make("openclaw-catalog-lease-workspace-");
    const firstSnapshot = {
      prompt: "<available_skills>one</available_skills>",
      skills: [{ name: "alpha" }],
      resolvedSkills: [],
    } satisfies SkillSnapshot;
    const laterSnapshot = {
      prompt: "<available_skills>two</available_skills>",
      skills: [{ name: "beta" }],
      resolvedSkills: [],
    } satisfies SkillSnapshot;
    syncSkillsToWorkspaceMock.mockImplementationOnce(
      async (params: { targetWorkspaceDir: string }) => {
        // A queued later sync can publish and write the cache after this result
        // is selected. The lease must still pin generation 1, not the cache.
        writeSyncedSkillsUsageCache(resolveSyncedSkillsCacheKey(params.targetWorkspaceDir), {
          generation: 2,
          manifestKey: "queued",
          skillUsagePaths: [],
          skillsSnapshot: laterSnapshot,
        });
        return {
          skillUsagePaths: [],
          skillsSnapshot: firstSnapshot,
          generation: 1,
        };
      },
    );

    const result = await ensureSandboxWorkspaceForSession({
      config: sandboxConfig(path.join(bundledDir, "sandboxes")),
      sessionKey: "agent:main:main",
      workspaceDir,
      retainPublishedSkills: true,
    });
    if (!result) {
      throw new Error("expected sandbox workspace resolution");
    }
    try {
      expect(readPublishedSandboxSkills(result)?.skillsSnapshot).toEqual(firstSnapshot);
      expect(
        collectRetainedSyncedSkillGenerations({
          targetSkillsDir: resolveSyncedSkillsCacheKey(result.workspaceDir),
          currentGeneration: 2,
          previousGeneration: 0,
        }).has(1),
      ).toBe(true);
    } finally {
      releasePublishedSandboxSkills(result);
    }
  });
});
