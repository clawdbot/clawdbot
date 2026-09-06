// Skill root discovery tests cover bounded recursive scanning and nested repo-style roots.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
}));

let tempRoot = "";
let workspaceCaseIndex = 0;

async function createTempWorkspaceDir() {
  const workspaceDir = path.join(tempRoot, `workspace-${++workspaceCaseIndex}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

function captureWarningLogger() {
  setLoggerOverride({ level: "silent", consoleLevel: "warn" });
  const warn = vi.fn();
  loggingState.rawConsole = {
    log: vi.fn(),
    info: vi.fn(),
    warn,
    error: vi.fn(),
  };
  return warn;
}

function collectMatching<T>(items: readonly T[], predicate: (item: T) => boolean): T[] {
  const matches: T[] = [];
  for (const item of items) {
    if (predicate(item)) {
      matches.push(item);
    }
  }
  return matches;
}

function loadTestWorkspaceSkills(
  workspaceDir: string,
  opts?: Parameters<typeof loadWorkspaceSkills>[1],
) {
  return loadWorkspaceSkills(workspaceDir, {
    managedSkillsDir: path.join(workspaceDir, ".managed"),
    bundledSkillsDir: "",
    pluginSkillsDir: path.join(workspaceDir, ".plugin-skills"),
    ...opts,
  });
}

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-discovery-"));
});

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

afterAll(async () => {
  await fs.rm(tempRoot, { recursive: true, force: true });
});

describe("discoverSkillCandidates", () => {
  it("discovers SKILL.md two levels deep under a grouping subfolder", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    // Grouped layout: skills/group/skill/SKILL.md (no SKILL.md at skills/group/).
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "group", "nested-skill"),
      name: "nested-skill",
      description: "Nested under a group folder",
    });

    const entries = loadTestWorkspaceSkills(workspaceDir);
    const names = entries.map((entry) => entry.skill.name);
    expect(names).toContain("nested-skill");
  });

  it("keeps loading direct skills (skills/skill/SKILL.md) unchanged", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "direct-skill"),
      name: "direct-skill",
      description: "Direct skill at first level",
    });
    // Sibling group with a deeper skill.
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "group", "grouped-skill"),
      name: "grouped-skill",
      description: "Skill nested under a group",
    });

    const names = loadTestWorkspaceSkills(workspaceDir).map((entry) => entry.skill.name);
    expect(names).toContain("direct-skill");
    expect(names).toContain("grouped-skill");
  });

  it("does not count invalid grouped candidates against the loaded skill cap", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    for (const nestedName of ["a", "b"]) {
      const invalidDir = path.join(workspaceDir, "skills", "00-group", nestedName);
      await fs.mkdir(invalidDir, { recursive: true });
      await fs.writeFile(
        path.join(invalidDir, "SKILL.md"),
        `---\nname: ${nestedName}\n---\n\n# Invalid\n`,
        "utf-8",
      );
    }
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "01-valid"),
      name: "valid-skill",
      description: "Valid sibling after invalid grouped candidates",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxCandidatesPerRoot: 10,
            maxSkillsLoadedPerSource: 1,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toEqual(["valid-skill"]);
  });

  it("loads earlier grouped skills before later direct siblings hit the source cap", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "00-group", "grouped"),
      name: "grouped-skill",
      description: "Grouped skill before direct siblings",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "01-direct"),
      name: "direct-skill",
      description: "Direct sibling after grouped skill",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxCandidatesPerRoot: 10,
            maxSkillsLoadedPerSource: 1,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toEqual(["grouped-skill"]);
  });

  it("keeps later grouped siblings discoverable when an earlier group is noisy", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    async function createNoisyTree(dir: string, depth: number): Promise<void> {
      if (depth === 0) {
        return;
      }
      for (const name of ["00-a", "01-b"]) {
        const childDir = path.join(dir, name);
        await fs.mkdir(childDir, { recursive: true });
        await createNoisyTree(childDir, depth - 1);
      }
    }
    await createNoisyTree(path.join(workspaceDir, "skills", "00-noisy"), 6);
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "01-later", "later-skill"),
      name: "later-skill",
      description: "Grouped sibling after a noisy tree",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxCandidatesPerRoot: 2,
            maxSkillsLoadedPerSource: 10,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("later-skill");
  });

  it("discovers deeply nested SKILL.md files within the Codex-compatible depth", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "a", "b", "c"),
      name: "deep-skill",
      description: "Discovered through grouped folders",
    });

    const names = loadTestWorkspaceSkills(workspaceDir).map((entry) => entry.skill.name);
    expect(names).toContain("deep-skill");
  });

  it("discovers deeply nested skills in configured roots named skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const parentDir = await createTempWorkspaceDir();
    const skillsDir = path.join(parentDir, "skills");
    await writeSkill({
      dir: path.join(skillsDir, "d0", "d1", "d2", "d3", "d4", "d5"),
      name: "configured-deep-skill",
      description: "Depth 6 from configured skills root",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [skillsDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("configured-deep-skill");
  });

  it("uses the nested skills folder as the depth root for repo-style extra dirs", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(repoDir, "skills", "d0", "d1", "d2", "d3", "d4", "d5"),
      name: "repo-depth-skill",
      description: "Depth 6 from nested skills root",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [repoDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("repo-depth-skill");
  });

  it("ignores invalid outside candidates when resolving repo-style extra dirs", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
    await fs.mkdir(path.join(repoDir, "examples", "bad"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "examples", "bad", "SKILL.md"), "---\nname: bad\n---\n");
    await writeSkill({
      dir: path.join(repoDir, "skills", "group", "valid"),
      name: "repo-nested-skill",
      description: "Valid nested repo skill",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [repoDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("repo-nested-skill");
    expect(names).not.toContain("bad");
  });

  it("ignores invalid root SKILL.md files when resolving repo-style extra dirs", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
    await fs.writeFile(path.join(repoDir, "SKILL.md"), "---\nname: bad\n---\n");
    await writeSkill({
      dir: path.join(repoDir, "examples", "valid"),
      name: "outside-valid-skill",
      description: "Valid outside repo skill",
    });
    await writeSkill({
      dir: path.join(repoDir, "skills", "group", "valid"),
      name: "repo-nested-skill",
      description: "Valid nested repo skill",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [repoDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("repo-nested-skill");
    expect(names).not.toContain("outside-valid-skill");
    expect(names).not.toContain("bad");
  });

  it("treats invalid outside SKILL.md files as terminal during repo-root detection", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
    await fs.mkdir(path.join(repoDir, "examples", "bad", "child"), { recursive: true });
    await fs.writeFile(path.join(repoDir, "examples", "bad", "SKILL.md"), "---\nname: bad\n---\n");
    await writeSkill({
      dir: path.join(repoDir, "examples", "bad", "child"),
      name: "outside-child",
      description: "Valid child hidden behind invalid terminal parent",
    });
    await writeSkill({
      dir: path.join(repoDir, "skills", "group", "valid"),
      name: "repo-nested-skill",
      description: "Valid nested repo skill",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [repoDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("repo-nested-skill");
    expect(names).not.toContain("outside-child");
  });

  it("keeps a configured direct skill root even when it has nested skill fixtures", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: skillDir,
      name: "direct-root",
      description: "Configured direct skill root",
    });
    await writeSkill({
      dir: path.join(skillDir, "skills", "examples", "fixture"),
      name: "fixture-skill",
      description: "Nested fixture skill should not replace the root",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [skillDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("direct-root");
    expect(names).not.toContain("fixture-skill");
  });

  it("does not re-root extra dirs from ignored nested skill files", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(repoDir, "valid"),
      name: "valid-root-skill",
      description: "Direct child skill under configured root",
    });
    await writeSkill({
      dir: path.join(repoDir, "skills", "node_modules", "pkg"),
      name: "ignored-package-skill",
      description: "Ignored nested dependency fixture",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [repoDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("valid-root-skill");
    expect(names).not.toContain("ignored-package-skill");
  });

  it("keeps direct child skills when a configured root also has a skills child", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillRootDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(skillRootDir, "valid"),
      name: "valid-root-skill",
      description: "Direct child skill under configured root",
    });
    await writeSkill({
      dir: path.join(skillRootDir, "skills", "examples", "fixture"),
      name: "fixture-skill",
      description: "Nested fixture should not replace the configured root",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [skillRootDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("valid-root-skill");
    expect(names).toContain("fixture-skill");
  });

  it("keeps nested skills when top-level candidate cap is filled by direct skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillRootDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(skillRootDir, "00-valid"),
      name: "valid-root-skill",
      description: "Direct child skill under configured root",
    });
    await writeSkill({
      dir: path.join(skillRootDir, "skills", "examples", "fixture"),
      name: "fixture-skill",
      description: "Nested fixture should still be scanned",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [skillRootDir] },
          limits: {
            maxCandidatesPerRoot: 1,
            maxSkillsLoadedPerSource: 10,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("valid-root-skill");
    expect(names).toContain("fixture-skill");
  });

  it("keeps nested skills depth when a configured root also has direct skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillRootDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(skillRootDir, "valid"),
      name: "valid-root-skill",
      description: "Direct child skill under configured root",
    });
    await writeSkill({
      dir: path.join(skillRootDir, "skills", "d0", "d1", "d2", "d3", "d4", "d5"),
      name: "deep-nested-skill",
      description: "Depth 6 from nested skills root",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [skillRootDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("valid-root-skill");
    expect(names).toContain("deep-nested-skill");
  });

  it("keeps configured root grouping outside skills within watcher depth", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillRootDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(skillRootDir, "group", "within-depth"),
      name: "within-depth",
      description: "Depth 2 from configured root",
    });
    await writeSkill({
      dir: path.join(skillRootDir, "group", "d1", "too-deep"),
      name: "too-deep",
      description: "Depth 3 from configured root",
    });
    await writeSkill({
      dir: path.join(skillRootDir, "skills", "d0", "d1", "d2", "d3", "d4", "d5"),
      name: "deep-nested-skill",
      description: "Depth 6 from nested skills root",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [skillRootDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("within-depth");
    expect(names).toContain("deep-nested-skill");
    expect(names).not.toContain("too-deep");
  });

  it("keeps grouped child skills when a configured root also has a skills child", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillRootDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(skillRootDir, "group", "valid"),
      name: "valid-grouped-skill",
      description: "Grouped child skill under configured root",
    });
    await writeSkill({
      dir: path.join(skillRootDir, "skills", "examples", "fixture"),
      name: "fixture-skill",
      description: "Nested fixture should not replace the configured root",
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [skillRootDir] },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("valid-grouped-skill");
    expect(names).toContain("fixture-skill");
  });

  it("does not descend beyond the bounded grouped skill depth", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "d0", "d1", "d2", "d3", "d4", "d5"),
      name: "within-depth",
      description: "Depth 6 loads",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "e0", "e1", "e2", "e3", "e4", "e5", "e6"),
      name: "too-deep",
      description: "Depth 7 does not load",
    });

    const names = loadTestWorkspaceSkills(workspaceDir).map((entry) => entry.skill.name);
    expect(names).toContain("within-depth");
    expect(names).not.toContain("too-deep");
  });

  it("does not inspect child skills when an immediate SKILL.md is invalid", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const parentDir = path.join(workspaceDir, "skills", "group", "parent");
    await fs.mkdir(parentDir, { recursive: true });
    await fs.writeFile(path.join(parentDir, "SKILL.md"), "---\nname: parent\n---\n", "utf-8");
    await writeSkill({
      dir: path.join(parentDir, "child"),
      name: "too-deep",
      description: "Should not be discovered through invalid parent fallback",
    });
    const nestedFile = path.join(parentDir, "malformed-child", "SKILL.md");
    await fs.mkdir(path.dirname(nestedFile));
    await fs.writeFile(
      nestedFile,
      "---\nname: [malformed\ndescription: Ignored child\n---\n",
      "utf-8",
    );
    const warn = captureWarningLogger();

    const names = loadTestWorkspaceSkills(workspaceDir).map((entry) => entry.skill.name);
    expect(names).not.toContain("too-deep");
    const warningText = warn.mock.calls.flat().map(String).join("\n");
    expect(warningText).toContain(path.join(parentDir, "SKILL.md"));
    expect(warningText).not.toContain(nestedFile);
  });

  it("treats an immediate SKILL.md as terminal and does not descend", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "group"),
      name: "group",
      description: "Direct skill at the group level",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "group", "inner"),
      name: "inner",
      description: "Should be ignored when parent is itself a skill",
    });

    const names = loadTestWorkspaceSkills(workspaceDir).map((entry) => entry.skill.name);
    expect(names).toContain("group");
    expect(names).not.toContain("inner");
  });

  it("warns and caps discovery in large grouping subfolders", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    for (let i = 0; i < 3; i += 1) {
      const name = `nested-skill-${i}`;
      await writeSkill({
        dir: path.join(workspaceDir, "skills", "group", name),
        name,
        description: `Nested skill ${i}`,
      });
    }
    const warn = captureWarningLogger();

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxCandidatesPerRoot: 2,
            maxSkillsLoadedPerSource: 10,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(
      names.reduce((count, name) => count + (name.startsWith("nested-skill-") ? 1 : 0), 0),
    ).toBe(2);
    expect(
      warn.mock.calls
        .map(([line]) => String(line))
        .some((line) =>
          line.includes("Nested skills directory has many entries, truncating discovery."),
        ),
    ).toBe(true);
  });

  it("does not spend nested candidate budget on ignored raw entries", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const groupDir = path.join(workspaceDir, "skills", "group");
    await fs.mkdir(groupDir, { recursive: true });
    for (let i = 0; i < 50; i += 1) {
      await fs.writeFile(path.join(groupDir, `ignored-${String(i).padStart(2, "0")}.txt`), "");
    }
    for (const name of ["valid-a", "valid-b", "valid-c"]) {
      await writeSkill({
        dir: path.join(groupDir, name),
        name,
        description: `${name} nested under a group`,
      });
    }

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          limits: {
            maxCandidatesPerRoot: 2,
            maxSkillsLoadedPerSource: 10,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(collectMatching(names, (name) => name.startsWith("valid-"))).toEqual([
      "valid-a",
      "valid-b",
    ]);
  });

  it("limits discovery for nested repo-style skills roots (dir/skills/*)", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
    for (let i = 0; i < 8; i += 1) {
      const name = `repo-skill-${String(i).padStart(2, "0")}`;
      await writeSkill({
        dir: path.join(repoDir, "skills", name),
        name,
        description: `Desc ${i}`,
      });
    }

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [repoDir] },
          limits: {
            maxCandidatesPerRoot: 5,
            maxSkillsLoadedPerSource: 5,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toStrictEqual([
      "repo-skill-00",
      "repo-skill-01",
      "repo-skill-02",
      "repo-skill-03",
      "repo-skill-04",
    ]);
  });

  it("skips skills whose SKILL.md exceeds maxSkillFileBytes", async () => {
    const workspaceDir = await createTempWorkspaceDir();
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

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: { skills: { limits: { maxSkillFileBytes: 1000 } } },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("small-skill");
    expect(names).not.toContain("big-skill");
  });

  it("detects nested skills roots beyond the first 25 entries", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const repoDir = await createTempWorkspaceDir();
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

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [repoDir] },
          limits: {
            maxCandidatesPerRoot: 30,
            maxSkillsLoadedPerSource: 30,
          },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).toContain("late-skill");
  });

  it("enforces maxSkillFileBytes for root-level SKILL.md", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const rootSkillDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: rootSkillDir,
      name: "root-big-skill",
      description: "Big",
      body: "x".repeat(5_000),
    });

    const names = loadTestWorkspaceSkills(workspaceDir, {
      config: {
        skills: {
          load: { extraDirs: [rootSkillDir] },
          limits: { maxSkillFileBytes: 1000 },
        },
      },
    }).map((entry) => entry.skill.name);

    expect(names).not.toContain("root-big-skill");
  });
});
