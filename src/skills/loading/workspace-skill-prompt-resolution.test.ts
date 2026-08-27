// Workspace skill prompt resolution tests cover snapshot reuse and degraded-secret filtering.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { setActiveDegradedSecretOwners } from "../../secrets/runtime-degraded-state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { createCanonicalFixtureSkill } from "../test-support/test-helpers.js";
import { WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION, type SkillEntry } from "../types.js";
import { buildSkillSnapshot, resolveSkillsPrompt } from "./workspace-skill-prompt.js";

const loggingMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("../../logging/subsystem.js", () => ({
  createSubsystemLogger: () => ({
    subsystem: "skills",
    isEnabled: () => false,
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: loggingMocks.warn,
    error: vi.fn(),
    fatal: vi.fn(),
    raw: vi.fn(),
    child: vi.fn(),
  }),
}));

afterEach(() => {
  setActiveDegradedSecretOwners([]);
  loggingMocks.warn.mockClear();
});

function createEntry(name: string): SkillEntry {
  return {
    skill: createCanonicalFixtureSkill({
      name,
      description: name,
      filePath: `/app/skills/${name}/SKILL.md`,
      baseDir: `/app/skills/${name}`,
      source: "openclaw-workspace",
    }),
    frontmatter: {},
  };
}

describe("resolveSkillsPrompt", () => {
  it("prefers snapshot prompt when available", () => {
    const prompt = resolveSkillsPrompt({
      skillsSnapshot: { prompt: "SNAPSHOT", skills: [] },
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toBe("SNAPSHOT");
  });
  it("builds prompt from entries when snapshot is missing", () => {
    const entry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "demo-skill",
        description: "Demo",
        filePath: "/app/skills/demo-skill/SKILL.md",
        baseDir: "/app/skills/demo-skill",
        source: "openclaw-bundled",
      }),
      frontmatter: {},
    };
    const prompt = resolveSkillsPrompt({
      entries: [entry],
      workspaceDir: "/tmp/openclaw",
    });
    expect(prompt).toContain("<available_skills>");
    expect(prompt).toContain("/app/skills/demo-skill/SKILL.md");
  });

  it("keeps an empty snapshot authoritative over current entries", () => {
    const entry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "new-skill",
        description: "New",
        filePath: "/app/skills/new-skill/SKILL.md",
        baseDir: "/app/skills/new-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    expect(
      resolveSkillsPrompt({
        skillsSnapshot: { prompt: "", skills: [] },
        entries: [entry],
        workspaceDir: "/tmp/openclaw",
      }),
    ).toBe("");
  });

  it("fails closed before filtering an unsupported degraded prompt format", () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "skill:cold-skill",
        state: "unavailable",
        paths: ["skills.entries.cold-skill.apiKey"],
        refKeys: ["env:default:MISSING_SKILL_KEY"],
        reason: "secret provider failed",
      },
    ]);

    expect(
      resolveSkillsPrompt({
        skillsSnapshot: {
          prompt:
            "LEAKED COLD INSTRUCTIONS\n<available_skills>\n  <skill>\n    <name>cold-skill</name>\n  </skill>\n</available_skills>",
          skills: [{ name: "cold-skill", skillKey: "cold-skill" }],
          promptFormatVersion: WORKSPACE_SKILLS_PROMPT_FORMAT_VERSION - 1,
        },
        workspaceDir: "/tmp/openclaw",
      }),
    ).toBe("");
  });

  it("fails closed for a legacy snapshot whose owner identity is ambiguous", () => {
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "skill:cold-skill",
        state: "unavailable",
        paths: ["skills.entries.cold-skill.apiKey"],
        refKeys: ["env:default:MISSING_SKILL_KEY"],
        reason: "secret provider failed",
      },
    ]);

    const prompt = resolveSkillsPrompt({
      skillsSnapshot: {
        prompt: "LEGACY SKILL PROMPT",
        skills: [{ name: "cold-skill" }, { name: "healthy-skill" }],
      },
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).toBe("");
  });

  it.each([
    {
      name: "legacy owner identity",
      reason: "legacy-skill-identity",
      mutate: (snapshot: ReturnType<typeof buildSkillSnapshot>) => ({
        ...snapshot,
        skills: snapshot.skills.map(({ name }) => ({ name })),
      }),
    },
    {
      name: "structurally anomalous catalog",
      reason: "invalid-catalog-structure",
      mutate: (snapshot: ReturnType<typeof buildSkillSnapshot>) => ({
        ...snapshot,
        prompt: `${snapshot.prompt}\n<available_skills></available_skills>`,
      }),
    },
  ])(
    "lazily rebuilds healthy entries for a degraded modern $name snapshot",
    ({ reason, mutate }) => {
      const entries = [createEntry("cold-skill"), createEntry("healthy-skill")];
      const snapshot = mutate(buildSkillSnapshot("/tmp/openclaw", { entries }));
      const loadEntries = vi.fn(() => entries);
      setActiveDegradedSecretOwners([
        {
          ownerKind: "capability",
          ownerId: "skill:cold-skill",
          state: "unavailable",
          paths: ["skills.entries.cold-skill.apiKey"],
          refKeys: ["env:default:MISSING_SKILL_KEY"],
          reason: "secret provider failed",
        },
      ]);

      const prompt = resolveSkillsPrompt({
        skillsSnapshot: snapshot,
        loadEntries,
        workspaceDir: "/tmp/openclaw",
      });

      expect(loadEntries).toHaveBeenCalledOnce();
      expect(prompt).not.toContain("cold-skill/SKILL.md");
      expect(prompt).toContain("healthy-skill/SKILL.md");
      expect(loggingMocks.warn).toHaveBeenCalledWith(
        "Cached skills prompt could not be safely filtered; rebuilding from current skill entries.",
        { reason },
      );
    },
  );

  it("does not load entries while reusing a valid modern snapshot", () => {
    const entries = [createEntry("healthy-skill")];
    const snapshot = buildSkillSnapshot("/tmp/openclaw", { entries });
    const loadEntries = vi.fn(() => entries);

    expect(
      resolveSkillsPrompt({
        skillsSnapshot: snapshot,
        loadEntries,
        workspaceDir: "/tmp/openclaw",
      }),
    ).toBe(snapshot.prompt.trim());
    expect(loadEntries).not.toHaveBeenCalled();
  });

  it("matches unavailable owners against a snapshot skill's config key", () => {
    const cold: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "cold-skill",
        description: "Cold",
        filePath: "/app/skills/cold-skill/SKILL.md",
        baseDir: "/app/skills/cold-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
      metadata: { skillKey: "cold-alias" },
    };
    const healthy: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "healthy-skill",
        description: "Healthy",
        filePath: "/app/skills/healthy-skill/SKILL.md",
        baseDir: "/app/skills/healthy-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const snapshot = buildSkillSnapshot("/tmp/openclaw", {
      entries: [cold, healthy],
    });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "skill:cold-alias",
        state: "unavailable",
        paths: ["skills.entries.cold-alias.apiKey"],
        refKeys: ["env:default:MISSING_SKILL_KEY"],
        reason: "secret provider failed",
      },
    ]);

    const prompt = resolveSkillsPrompt({
      skillsSnapshot: snapshot,
      entries: [cold, healthy],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("/app/skills/cold-skill/SKILL.md");
    expect(prompt).toContain("/app/skills/healthy-skill/SKILL.md");
  });

  it("does not add supplied skills outside the saved snapshot during a degraded rebuild", () => {
    const capturedEntries = [createEntry("cold-skill"), createEntry("healthy-skill")];
    const snapshot = buildSkillSnapshot("/tmp/openclaw", {
      entries: capturedEntries,
    });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "skill:cold-skill",
        state: "unavailable",
        paths: ["skills.entries.cold-skill.apiKey"],
        refKeys: ["env:default:MISSING_SKILL_KEY"],
        reason: "secret provider failed",
      },
    ]);

    const prompt = resolveSkillsPrompt({
      skillsSnapshot: snapshot,
      entries: [...capturedEntries, createEntry("new-skill")],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("/app/skills/cold-skill/SKILL.md");
    expect(prompt).toContain("/app/skills/healthy-skill/SKILL.md");
    expect(prompt).not.toContain("/app/skills/new-skill/SKILL.md");
  });

  it("preserves captured skill content during degraded prompt filtering", async () => {
    const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skill-prompt-"));
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "cold-skill"),
      name: "cold-skill",
      description: "Captured cold",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "healthy-skill"),
      name: "healthy-skill",
      description: "Captured healthy",
    });
    const snapshot = buildSkillSnapshot(workspaceDir);
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "healthy-skill"),
      name: "healthy-skill",
      description: "Replacement healthy",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "new-skill"),
      name: "new-skill",
      description: "New skill",
    });
    setActiveDegradedSecretOwners([
      {
        ownerKind: "capability",
        ownerId: "skill:cold-skill",
        state: "unavailable",
        paths: ["skills.entries.cold-skill.apiKey"],
        refKeys: ["env:default:MISSING_SKILL_KEY"],
        reason: "secret provider failed",
      },
    ]);

    try {
      const prompt = resolveSkillsPrompt({
        skillsSnapshot: snapshot,
        workspaceDir,
      });

      expect(prompt).not.toContain("cold-skill/SKILL.md");
      expect(prompt).toContain("healthy-skill/SKILL.md");
      expect(prompt).toContain("Captured healthy");
      expect(prompt).not.toContain("Replacement healthy");
      expect(prompt).not.toContain("new-skill/SKILL.md");
    } finally {
      await fs.rm(workspaceDir, { recursive: true, force: true });
    }
  });

  it("keeps legacy entries with disableModelInvocation hidden when exposure metadata is absent", () => {
    const hidden: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
        disableModelInvocation: true,
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPrompt({
      entries: [hidden],
      workspaceDir: "/tmp/openclaw",
    });

    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("inherits agents.defaults.skills when rebuilding prompt for an agent", () => {
    const visible: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "github",
        description: "GitHub",
        filePath: "/app/skills/github/SKILL.md",
        baseDir: "/app/skills/github",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const hidden: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "hidden-skill",
        description: "Hidden",
        filePath: "/app/skills/hidden-skill/SKILL.md",
        baseDir: "/app/skills/hidden-skill",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPrompt({
      entries: [visible, hidden],
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).toContain("/app/skills/github/SKILL.md");
    expect(prompt).not.toContain("/app/skills/hidden-skill/SKILL.md");
  });

  it("uses agents.list[].skills as a full replacement for defaults", () => {
    const inheritedEntry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "weather",
        description: "Weather",
        filePath: "/app/skills/weather/SKILL.md",
        baseDir: "/app/skills/weather",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };
    const explicitEntry: SkillEntry = {
      skill: createCanonicalFixtureSkill({
        name: "docs-search",
        description: "Docs",
        filePath: "/app/skills/docs-search/SKILL.md",
        baseDir: "/app/skills/docs-search",
        source: "openclaw-workspace",
      }),
      frontmatter: {},
    };

    const prompt = resolveSkillsPrompt({
      entries: [inheritedEntry, explicitEntry],
      config: {
        agents: {
          defaults: {
            skills: ["weather"],
          },
          list: [{ id: "writer", skills: ["docs-search"] }],
        },
      },
      workspaceDir: "/tmp/openclaw",
      agentId: "writer",
    });

    expect(prompt).not.toContain("/app/skills/weather/SKILL.md");
    expect(prompt).toContain("/app/skills/docs-search/SKILL.md");
  });
});
