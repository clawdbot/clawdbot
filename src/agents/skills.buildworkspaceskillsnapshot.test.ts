import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withPathResolutionEnv } from "../test-utils/env.js";
import { createFixtureSuite } from "../test-utils/fixture-suite.js";
import { createTempHomeEnv, type TempHomeEnv } from "../test-utils/temp-home.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { buildWorkspaceSkillSnapshot, buildWorkspaceSkillsPrompt } from "./skills.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "./skills/home-env.test-support.js";

const fixtureSuite = createFixtureSuite("openclaw-skills-snapshot-suite-");
let truncationWorkspaceTemplateDir = "";
let nestedRepoTemplateDir = "";
let tempHome: TempHomeEnv | null = null;
let skillsHomeEnv: SkillsHomeEnvSnapshot | null = null;

beforeAll(async () => {
  await fixtureSuite.setup();
  tempHome = await createTempHomeEnv("openclaw-skills-snapshot-home-");
  skillsHomeEnv = setMockSkillsHomeEnv(tempHome.home);
  truncationWorkspaceTemplateDir = await fixtureSuite.createCaseDir(
    "template-truncation-workspace",
  );
  for (let i = 0; i < 8; i += 1) {
    const name = `skill-${String(i).padStart(2, "0")}`;
    await writeSkill({
      dir: path.join(truncationWorkspaceTemplateDir, "skills", name),
      name,
      description: "x".repeat(800),
    });
  }

  nestedRepoTemplateDir = await fixtureSuite.createCaseDir("template-skills-repo");
  for (let i = 0; i < 8; i += 1) {
    const name = `repo-skill-${String(i).padStart(2, "0")}`;
    await writeSkill({
      dir: path.join(nestedRepoTemplateDir, "skills", name),
      name,
      description: `Desc ${i}`,
    });
  }
});

afterAll(async () => {
  if (skillsHomeEnv) {
    await restoreMockSkillsHomeEnv(skillsHomeEnv);
    skillsHomeEnv = null;
  }
  if (tempHome) {
    await tempHome.restore();
    tempHome = null;
  }
  await fixtureSuite.cleanup();
});

function withWorkspaceHome<T>(workspaceDir: string, cb: () => T): T {
  return withPathResolutionEnv(workspaceDir, { PATH: "" }, () => cb());
}

function buildSnapshot(
  workspaceDir: string,
  options?: Parameters<typeof buildWorkspaceSkillSnapshot>[1],
) {
  return withWorkspaceHome(workspaceDir, () =>
    buildWorkspaceSkillSnapshot(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      ...options,
    }),
  );
}

async function cloneTemplateDir(templateDir: string, prefix: string): Promise<string> {
  const cloned = await fixtureSuite.createCaseDir(prefix);
  await fs.cp(templateDir, cloned, { recursive: true });
  return cloned;
}

function expectSnapshotNamesAndPrompt(
  snapshot: ReturnType<typeof buildWorkspaceSkillSnapshot>,
  params: { contains?: string[]; omits?: string[] },
) {
  for (const name of params.contains ?? []) {
    expect(snapshot.skills.map((skill) => skill.name)).toContain(name);
    expect(snapshot.prompt).toContain(name);
  }
  for (const name of params.omits ?? []) {
    expect(snapshot.skills.map((skill) => skill.name)).not.toContain(name);
    expect(snapshot.prompt).not.toContain(name);
  }
}

describe("buildWorkspaceSkillSnapshot", () => {
  it("returns an empty snapshot when skills dirs are missing", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");

    const snapshot = buildSnapshot(workspaceDir);

    expect(snapshot.prompt).toBe("");
    expect(snapshot.skills).toEqual([]);
  });

  it("omits disable-model-invocation skills from the prompt", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "visible-skill"),
      name: "visible-skill",
      description: "Visible skill",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden-skill"),
      name: "hidden-skill",
      description: "Hidden skill",
      frontmatterExtra: "disable-model-invocation: true",
    });

    const snapshot = buildSnapshot(workspaceDir);

    expect(snapshot.prompt).toContain("visible-skill");
    expect(snapshot.prompt).not.toContain("hidden-skill");
    expect(snapshot.skills.map((skill) => skill.name)).toContain("hidden-skill");
    expect(snapshot.skills.map((skill) => skill.name)).toContain("visible-skill");
  });

  it("keeps prompt output aligned with buildWorkspaceSkillsPrompt", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "visible"),
      name: "visible",
      description: "Visible",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden"),
      name: "hidden",
      description: "Hidden",
      frontmatterExtra: "disable-model-invocation: true",
    });
    const config = {
      skills: {
        limits: {
          maxSkillsInPrompt: 1,
          maxSkillsPromptChars: 200,
        },
      },
    } as const;
    const opts = {
      config,
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      eligibility: {
        remote: {
          platforms: ["linux"],
          hasBin: (_bin: string) => true,
          hasAnyBin: (_bins: string[]) => true,
          note: "Remote note",
        },
      },
    };

    const snapshot = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillSnapshot(workspaceDir, opts),
    );
    const prompt = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillsPrompt(workspaceDir, opts),
    );

    expect(snapshot.prompt).toBe(prompt);
  });

  it("truncates the skills prompt when it exceeds the configured char budget", async () => {
    const workspaceDir = await cloneTemplateDir(truncationWorkspaceTemplateDir, "workspace");

    const snapshot = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillSnapshot(workspaceDir, {
        config: {
          skills: {
            limits: {
              maxSkillsInPrompt: 100,
              maxSkillsPromptChars: 500,
            },
          },
        },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      }),
    );

    expect(snapshot.prompt).toContain("⚠️ Skills truncated");
    expect(snapshot.prompt.length).toBeLessThan(2000);
  });

  it("uses agents.list[].skills as a full replacement for inherited defaults", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "github"),
      name: "github",
      description: "GitHub",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "weather"),
      name: "weather",
      description: "Weather",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "docs-search"),
      name: "docs-search",
      description: "Docs",
    });

    const snapshot = buildSnapshot(workspaceDir, {
      agentId: "writer",
      config: {
        agents: {
          defaults: {
            skills: ["github", "weather"],
          },
          list: [{ id: "writer", skills: ["docs-search", "github"] }],
        },
      },
    });

    expect(snapshot.skills.map((skill) => skill.name).toSorted()).toEqual([
      "docs-search",
      "github",
    ]);
    expect(snapshot.skillFilter).toEqual(["docs-search", "github"]);
  });

  it("limits discovery for nested repo-style skills roots (dir/skills/*)", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const repoDir = await cloneTemplateDir(nestedRepoTemplateDir, "skills-repo");

    const snapshot = withWorkspaceHome(workspaceDir, () =>
      buildWorkspaceSkillSnapshot(workspaceDir, {
        config: {
          skills: {
            load: {
              extraDirs: [repoDir],
            },
            limits: {
              maxCandidatesPerRoot: 5,
              maxSkillsLoadedPerSource: 5,
            },
          },
        },
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      }),
    );

    // We should only have loaded a small subset.
    expect(snapshot.skills.length).toBeLessThanOrEqual(5);
    expect(snapshot.prompt).toContain("repo-skill-00");
    expect(snapshot.prompt).not.toContain("repo-skill-07");
  });

  it("skips skills whose SKILL.md exceeds maxSkillFileBytes", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");

    await writeSkill({
      dir: path.join(workspaceDir, "skills", "small-skill"),
      name: "small-skill",
      description: "Small",
    });

    await writeSkill({
      dir: path.join(workspaceDir, "skills", "big-skill"),
      name: "big-skill",
      description: "Big",
      body: "x".repeat(5_000),
    });

    const snapshot = buildSnapshot(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxSkillFileBytes: 1000,
          },
        },
      },
    });

    expectSnapshotNamesAndPrompt(snapshot, {
      contains: ["small-skill"],
      omits: ["big-skill"],
    });
  });

  it("detects nested skills roots beyond the first 25 entries", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const repoDir = await fixtureSuite.createCaseDir("skills-repo");

    // Create 30 nested dirs, but only the last one is an actual skill.
    for (let i = 0; i < 30; i += 1) {
      await fs.mkdir(path.join(repoDir, "skills", `entry-${String(i).padStart(2, "0")}`), {
        recursive: true,
      });
    }

    await writeSkill({
      dir: path.join(repoDir, "skills", "entry-29"),
      name: "late-skill",
      description: "Nested skill discovered late",
    });

    const snapshot = buildSnapshot(workspaceDir, {
      config: {
        skills: {
          load: {
            extraDirs: [repoDir],
          },
          limits: {
            maxCandidatesPerRoot: 30,
            maxSkillsLoadedPerSource: 30,
          },
        },
      },
    });

    expectSnapshotNamesAndPrompt(snapshot, {
      contains: ["late-skill"],
    });
  });

  it("enforces maxSkillFileBytes for root-level SKILL.md", async () => {
    const workspaceDir = await fixtureSuite.createCaseDir("workspace");
    const rootSkillDir = await fixtureSuite.createCaseDir("root-skill");

    await writeSkill({
      dir: rootSkillDir,
      name: "root-big-skill",
      description: "Big",
      body: "x".repeat(5_000),
    });

    const snapshot = buildSnapshot(workspaceDir, {
      config: {
        skills: {
          load: {
            extraDirs: [rootSkillDir],
          },
          limits: {
            maxSkillFileBytes: 1000,
          },
        },
      },
    });

    expectSnapshotNamesAndPrompt(snapshot, {
      omits: ["root-big-skill"],
    });
  });
});
