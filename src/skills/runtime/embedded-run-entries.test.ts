// Embedded run entry tests cover runtime skill entries serialized into agent runs.
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
  type OpenClawConfig,
} from "../../config/config.js";
import * as skillsLoaderModule from "../loading/workspace-skill-loader.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import type { SkillEntry, SkillSnapshot } from "../types.js";
import { resolveEmbeddedRunSkillEntries } from "./embedded-run-entries.js";

describe("resolveEmbeddedRunSkillEntries", () => {
  const loadWorkspaceSkillsSpy = vi.spyOn(skillsLoaderModule, "loadWorkspaceSkills");

  beforeEach(() => {
    clearRuntimeConfigSnapshot();
    loadWorkspaceSkillsSpy.mockReset();
    loadWorkspaceSkillsSpy.mockReturnValue([]);
  });

  it("loads skill entries with config when no resolved snapshot skills exist", () => {
    const config: OpenClawConfig = {
      plugins: {
        entries: {
          diffs: { enabled: true },
        },
      },
    };

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(result.shouldLoadSkillEntries).toBe(true);
    expect(loadWorkspaceSkillsSpy).toHaveBeenCalledTimes(1);
    expect(loadWorkspaceSkillsSpy).toHaveBeenCalledWith("/tmp/workspace", { config });
  });

  it("threads agentId through live skill loading", () => {
    resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      agentId: "writer",
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(loadWorkspaceSkillsSpy).toHaveBeenCalledWith("/tmp/workspace", {
      config: {},
      agentId: "writer",
    });
  });

  it("can constrain live loading to materialized workspace skills", () => {
    const eligibility = {
      remote: {
        platforms: ["linux"],
        hasBin: () => false,
        hasAnyBin: () => true,
        note: "sandbox",
      },
    };

    resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace/.openclaw/sandbox-skills",
      config: {},
      eligibility,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
      workspaceOnly: true,
    });

    expect(loadWorkspaceSkillsSpy).toHaveBeenCalledWith("/tmp/workspace/.openclaw/sandbox-skills", {
      config: {},
      eligibility,
      workspaceOnly: true,
    });
  });

  it("prefers the active runtime snapshot when caller config still contains SecretRefs", () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: {
              source: "file",
              provider: "default",
              id: "/skills/entries/diffs/apiKey",
            },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: "resolved-key",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: sourceConfig,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(loadWorkspaceSkillsSpy).toHaveBeenCalledWith("/tmp/workspace", {
      config: runtimeConfig,
    });
  });

  it("prefers caller config when the active runtime snapshot still contains raw skill SecretRefs", () => {
    const sourceConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: {
              source: "file",
              provider: "default",
              id: "/skills/entries/diffs/apiKey",
            },
          },
        },
      },
    };
    const runtimeConfig: OpenClawConfig = structuredClone(sourceConfig);
    const callerConfig: OpenClawConfig = {
      skills: {
        entries: {
          diffs: {
            apiKey: "resolved-key",
          },
        },
      },
    };
    setRuntimeConfigSnapshot(runtimeConfig, sourceConfig);

    resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: callerConfig,
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [],
      },
    });

    expect(loadWorkspaceSkillsSpy).toHaveBeenCalledWith("/tmp/workspace", {
      config: callerConfig,
    });
  });

  it("skips skill entry loading when resolved snapshot skills are present", () => {
    const snapshot: SkillSnapshot = {
      prompt: "skills prompt",
      skills: [{ name: "diffs" }],
      resolvedSkills: [],
    };

    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      skillsSnapshot: snapshot,
    });

    expect(result.shouldLoadSkillEntries).toBe(false);
    expect(result.skillEntries).toEqual([]);
    expect(loadWorkspaceSkillsSpy).not.toHaveBeenCalled();
  });

  it("exposes a cached lazy loader without eagerly loading a modern snapshot", () => {
    const loadedEntries: SkillEntry[] = [
      {
        skill: createCanonicalFixtureSkill({
          name: "healthy",
          description: "healthy",
          filePath: "/tmp/workspace/skills/healthy/SKILL.md",
          baseDir: "/tmp/workspace/skills/healthy",
          source: "test",
        }),
        frontmatter: {},
      },
    ];
    loadWorkspaceSkillsSpy.mockReturnValue(loadedEntries);
    const result = resolveEmbeddedRunSkillEntries({
      workspaceDir: "/tmp/workspace",
      config: {},
      skillsSnapshot: {
        prompt: "skills prompt",
        skills: [{ name: "healthy", skillKey: "healthy" }],
        resolvedSkills: [],
      },
    });

    expect(loadWorkspaceSkillsSpy).not.toHaveBeenCalled();
    expect(result.loadSkillEntries()).toBe(loadedEntries);
    expect(result.loadSkillEntries()).toBe(loadedEntries);
    expect(loadWorkspaceSkillsSpy).toHaveBeenCalledOnce();
  });
});
