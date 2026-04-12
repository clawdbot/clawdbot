import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../logging/logger.js";
import { loggingState } from "../logging/state.js";
import { withPathResolutionEnv } from "../test-utils/env.js";
import { writeSkill } from "./skills.e2e-test-helpers.js";
import { loadWorkspaceSkillEntries } from "./skills.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "./skills/home-env.test-support.js";
import { readSkillFrontmatterSafe } from "./skills/local-loader.js";
import { writePluginWithSkill } from "./test-helpers/skill-plugin-fixtures.js";

const tempDirs: string[] = [];
let fakeHome = "";
let envSnapshot: SkillsHomeEnvSnapshot;

async function createTempWorkspaceDir() {
  const workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-"));
  tempDirs.push(workspaceDir);
  return workspaceDir;
}

function withWorkspaceHome<T>(workspaceDir: string, cb: () => T): T {
  return withPathResolutionEnv(workspaceDir, { PATH: "" }, () => cb());
}

beforeEach(async () => {
  fakeHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-home-"));
  tempDirs.push(fakeHome);
  envSnapshot = setMockSkillsHomeEnv(fakeHome);
});

afterEach(async () => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
  await restoreMockSkillsHomeEnv(envSnapshot, async () => {
    await Promise.all(
      tempDirs
        .splice(0, tempDirs.length)
        .map((dir) => fs.rm(dir, { recursive: true, force: true })),
    );
  });
});

async function setupWorkspaceWithProsePlugin() {
  const workspaceDir = await createTempWorkspaceDir();
  const managedDir = path.join(workspaceDir, ".managed");
  const bundledDir = path.join(workspaceDir, ".bundled");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "open-prose");

  await writePluginWithSkill({
    pluginRoot,
    pluginId: "open-prose",
    skillId: "prose",
    skillDescription: "test",
  });

  return { workspaceDir, managedDir, bundledDir };
}

async function setupWorkspaceWithDiffsPlugin() {
  const workspaceDir = await createTempWorkspaceDir();
  const managedDir = path.join(workspaceDir, ".managed");
  const bundledDir = path.join(workspaceDir, ".bundled");
  const pluginRoot = path.join(workspaceDir, ".openclaw", "extensions", "diffs");

  await writePluginWithSkill({
    pluginRoot,
    pluginId: "diffs",
    skillId: "diffs",
    skillDescription: "test",
  });

  return { workspaceDir, managedDir, bundledDir };
}

describe("loadWorkspaceSkillEntries", () => {
  it("handles an empty managed skills dir without throwing", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const managedDir = path.join(workspaceDir, ".managed");
    await fs.mkdir(managedDir, { recursive: true });

    const entries = withWorkspaceHome(workspaceDir, () =>
      loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: managedDir,
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      }),
    );

    expect(entries).toEqual([]);
  });

  it("includes plugin-shipped skills when the plugin is enabled", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithProsePlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          entries: { "open-prose": { enabled: true } },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("prose");
  });

  it("excludes plugin-shipped skills when the plugin is not allowed", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithProsePlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          allow: ["something-else"],
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("prose");
  });

  it("includes diffs plugin skill when the plugin is enabled", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithDiffsPlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          entries: { diffs: { enabled: true } },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("diffs");
  });

  it("excludes diffs plugin skill when the plugin is disabled", async () => {
    const { workspaceDir, managedDir, bundledDir } = await setupWorkspaceWithDiffsPlugin();

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        plugins: {
          entries: { diffs: { enabled: false } },
        },
      },
      managedSkillsDir: managedDir,
      bundledSkillsDir: bundledDir,
    });

    expect(entries.map((entry) => entry.skill.name)).not.toContain("diffs");
  });

  it("falls back to the skill directory name when frontmatter omits name", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    const skillDir = path.join(workspaceDir, "skills", "fallback-name");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(
      path.join(skillDir, "SKILL.md"),
      ["---", "description: Skill without explicit name", "---", "", "# Fallback"].join("\n"),
      "utf8",
    );

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.map((entry) => entry.skill.name)).toContain("fallback-name");
  });

  it("marks disable-model-invocation skills as hidden in exposure metadata for newly loaded entries", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "hidden-skill"),
      name: "hidden-skill",
      description: "Hidden prompt entry",
      frontmatterExtra: "disable-model-invocation: true",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    const hiddenEntry = entries.find((entry) => entry.skill.name === "hidden-skill");

    expect(hiddenEntry?.invocation?.disableModelInvocation).toBe(true);
    expect(hiddenEntry?.exposure?.includeInAvailableSkillsPrompt).toBe(false);
  });

  it("inherits agents.defaults.skills when an agent omits skills", async () => {
    const workspaceDir = await createTempWorkspaceDir();
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

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer" }],
        },
      },
      agentId: "writer",
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.map((entry) => entry.skill.name)).toEqual(["github"]);
  });

  it("uses agents.list[].skills as a full replacement for defaults", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "github"),
      name: "github",
      description: "GitHub",
    });
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "docs-search"),
      name: "docs-search",
      description: "Docs",
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        agents: {
          defaults: {
            skills: ["github"],
          },
          list: [{ id: "writer", skills: ["docs-search"] }],
        },
      },
      agentId: "writer",
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.map((entry) => entry.skill.name)).toEqual(["docs-search"]);
  });

  it("keeps remote-eligible skills when agent filtering is active", async () => {
    const workspaceDir = await createTempWorkspaceDir();
    await writeSkill({
      dir: path.join(workspaceDir, "skills", "remote-only"),
      name: "remote-only",
      description: "Needs a remote bin",
      metadata: '{"openclaw":{"requires":{"anyBins":["missingbin","sandboxbin"]}}}',
    });

    const entries = loadWorkspaceSkillEntries(workspaceDir, {
      config: {
        agents: {
          defaults: {
            skills: ["remote-only"],
          },
          list: [{ id: "writer" }],
        },
      },
      agentId: "writer",
      eligibility: {
        remote: {
          platforms: ["linux"],
          hasBin: () => false,
          hasAnyBin: (bins: string[]) => bins.includes("sandboxbin"),
          note: "sandbox",
        },
      },
      managedSkillsDir: path.join(workspaceDir, ".managed"),
      bundledSkillsDir: path.join(workspaceDir, ".bundled"),
    });

    expect(entries.map((entry) => entry.skill.name)).toEqual(["remote-only"]);
  });

  it.runIf(process.platform !== "win32")(
    "skips workspace skill directories that resolve outside the workspace root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const outsideDir = await createTempWorkspaceDir();
      const escapedSkillDir = path.join(outsideDir, "outside-skill");
      await writeSkill({
        dir: escapedSkillDir,
        name: "outside-skill",
        description: "Outside",
      });
      await fs.mkdir(path.join(workspaceDir, "skills"), { recursive: true });
      const requestedPath = path.join(workspaceDir, "skills", "escaped-skill");
      await fs.symlink(escapedSkillDir, requestedPath, "dir");
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      const warn = vi.fn();
      loggingState.rawConsole = {
        log: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      };

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
      const [line] = warn.mock.calls[0] ?? [];
      const warningLine = String(line);
      expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
      expect(warningLine).toContain("reason=symlink-escape");
      expect(warningLine).toContain("source=openclaw-workspace");
      expect(warningLine).toContain(`root=${path.join(workspaceDir, "skills")}`);
      expect(warningLine).toContain(`requested=${requestedPath}`);
      expect(warningLine).toContain("resolved=");
    },
  );

  it.runIf(process.platform !== "win32")(
    "calls out bundled symlink escapes as likely local checkout mutations",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const bundledDir = path.join(workspaceDir, ".bundled");
      const outsideDir = await createTempWorkspaceDir();
      const escapedSkillDir = path.join(outsideDir, "outside-bundled-skill");
      await writeSkill({
        dir: escapedSkillDir,
        name: "outside-bundled-skill",
        description: "Outside bundled",
      });
      await fs.mkdir(bundledDir, { recursive: true });
      const requestedPath = path.join(bundledDir, "escaped-bundled-skill");
      await fs.symlink(escapedSkillDir, requestedPath, "dir");
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      const warn = vi.fn();
      loggingState.rawConsole = {
        log: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      };

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: bundledDir,
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-bundled-skill");
      const [line] = warn.mock.calls[0] ?? [];
      const warningLine = String(line);
      expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
      expect(warningLine).toContain("source=openclaw-bundled");
      expect(warningLine).toContain("reason=bundled-symlink-escape");
      expect(warningLine).toContain("hint=likely-stray-local-symlink-or-checkout-mutation");
      expect(warningLine).toContain(`requested=${requestedPath}`);
      expect(warningLine).toContain("resolved=");
    },
  );

  it.runIf(process.platform !== "win32")(
    "uses compact home-relative paths in escaped skill console warnings",
    async () => {
      const workspaceDir = path.join(fakeHome, "workspace");
      const outsideDir = path.join(fakeHome, "outside");
      tempDirs.push(workspaceDir, outsideDir);
      const bundledDir = path.join(workspaceDir, ".bundled");
      const escapedSkillDir = path.join(outsideDir, "outside-bundled-skill");
      await writeSkill({
        dir: escapedSkillDir,
        name: "outside-bundled-skill",
        description: "Outside bundled",
      });
      await fs.mkdir(bundledDir, { recursive: true });
      const requestedPath = path.join(bundledDir, "escaped-bundled-skill");
      await fs.symlink(escapedSkillDir, requestedPath, "dir");
      setLoggerOverride({ level: "silent", consoleLevel: "warn" });
      const warn = vi.fn();
      loggingState.rawConsole = {
        log: vi.fn(),
        info: vi.fn(),
        warn,
        error: vi.fn(),
      };

      loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: bundledDir,
      });

      const [line] = warn.mock.calls[0] ?? [];
      const warningLine = String(line);
      expect(warningLine).toContain("root=~/workspace/.bundled");
      expect(warningLine).toContain("requested=~/workspace/.bundled/escaped-bundled-skill");
      expect(warningLine).toContain("resolved=~/outside/outside-bundled-skill");
    },
  );

  it.runIf(process.platform !== "win32")(
    "skips workspace skill files that resolve outside the workspace root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const outsideDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: outsideDir,
        name: "outside-file-skill",
        description: "Outside file",
      });
      const skillDir = path.join(workspaceDir, "skills", "escaped-file");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(skillDir, "SKILL.md"));

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-file-skill");
    },
  );

  it.runIf(process.platform !== "win32")(
    "skips symlinked SKILL.md even when the target stays inside the workspace root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const targetDir = path.join(workspaceDir, "safe-target");
      await writeSkill({
        dir: targetDir,
        name: "symlink-target",
        description: "Target skill",
      });

      const skillDir = path.join(workspaceDir, "skills", "symlinked");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.symlink(path.join(targetDir, "SKILL.md"), path.join(skillDir, "SKILL.md"));

      const entries = loadWorkspaceSkillEntries(workspaceDir, {
        managedSkillsDir: path.join(workspaceDir, ".managed"),
        bundledSkillsDir: path.join(workspaceDir, ".bundled"),
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("symlink-target");
    },
  );

  it.runIf(process.platform !== "win32")(
    "reads skill frontmatter when the allowed root is the filesystem root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillDir = path.join(workspaceDir, "skills", "root-allowed");
      await writeSkill({
        dir: skillDir,
        name: "root-allowed",
        description: "Readable from filesystem root",
      });

      const frontmatter = readSkillFrontmatterSafe({
        rootDir: path.parse(skillDir).root,
        filePath: path.join(skillDir, "SKILL.md"),
      });

      expect(frontmatter).toMatchObject({
        name: "root-allowed",
        description: "Readable from filesystem root",
      });
    },
  );
});
