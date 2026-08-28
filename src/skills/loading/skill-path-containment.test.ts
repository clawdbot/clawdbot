// Skill path containment tests cover root escapes, allowed symlinks, and diagnostics.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resetLogger, setLoggerOverride } from "../../logging/logger.js";
import { loggingState } from "../../logging/state.js";
import { writeSkill } from "../test-support/e2e-test-helpers.js";
import {
  restoreMockSkillsHomeEnv,
  setMockSkillsHomeEnv,
  type SkillsHomeEnvSnapshot,
} from "../test-support/home-env.test-support.js";
import { readSkillFrontmatterSafe } from "./local-loader.js";
import { loadWorkspaceSkills } from "./workspace-skill-loader.js";

vi.mock("./plugin-skills.js", () => ({
  resolvePluginSkillRoots: () => [],
}));

let fakeHome = "";
let envSnapshot: SkillsHomeEnvSnapshot;
let tempRoot = "";
let workspaceCaseIndex = 0;

async function createTempWorkspaceDir() {
  const workspaceDir = path.join(tempRoot, `workspace-${++workspaceCaseIndex}`);
  await fs.mkdir(workspaceDir, { recursive: true });
  return workspaceDir;
}

async function writeHardlinkedSkill(params: { dir: string; name: string; description: string }) {
  const sourceDir = path.join(tempRoot, `hardlink-source-${++workspaceCaseIndex}`);
  await writeSkill({ ...params, dir: sourceDir });
  await fs.mkdir(params.dir, { recursive: true });
  const skillFilePath = path.join(params.dir, "SKILL.md");
  await fs.link(path.join(sourceDir, "SKILL.md"), skillFilePath);
  expect((await fs.stat(skillFilePath)).nlink).toBeGreaterThan(1);
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

function firstWarningLine(warn: ReturnType<typeof vi.fn>): string {
  const [line] = warn.mock.calls[0] ?? [];
  return String(line);
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

async function createEscapedBundledSkillFixture(params?: {
  workspaceDir?: string;
  outsideDir?: string;
}) {
  const workspaceDir = params?.workspaceDir ?? (await createTempWorkspaceDir());
  const outsideDir = params?.outsideDir ?? (await createTempWorkspaceDir());
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
  return { workspaceDir, outsideDir, bundledDir, escapedSkillDir, requestedPath };
}

beforeAll(async () => {
  tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-skills-containment-"));
  fakeHome = path.join(tempRoot, "home");
  await fs.mkdir(fakeHome, { recursive: true });
  envSnapshot = setMockSkillsHomeEnv(fakeHome);
});

afterEach(() => {
  setLoggerOverride(null);
  loggingState.rawConsole = null;
  resetLogger();
});

afterAll(async () => {
  await restoreMockSkillsHomeEnv(envSnapshot, async () => {
    await fs.rm(tempRoot, { recursive: true, force: true });
  });
});

describe("skill path containment", () => {
  it.each([
    { source: "bundled", expectedSource: "openclaw-bundled" },
    { source: "custodian", expectedSource: "openclaw-custodian" },
  ] as const)("loads hardlinked packaged $source skills", async ({ source, expectedSource }) => {
    const workspaceDir = await createTempWorkspaceDir();
    const bundledSkillsDir = path.join(workspaceDir, "package", "skills");
    const skillRoot =
      source === "bundled"
        ? bundledSkillsDir
        : path.join(path.dirname(bundledSkillsDir), "custodian-skills");
    const skillName = `${source}-hardlinked-skill`;
    await writeHardlinkedSkill({
      dir: path.join(skillRoot, skillName),
      name: skillName,
      description: `Packaged ${source} skill`,
    });
    const warn = captureWarningLogger();

    const entries = loadTestWorkspaceSkills(workspaceDir, {
      bundledSkillsDir,
      agentId: "ops",
      config: {
        agents: {
          defaults: { systemAgent: { agentId: "ops" } },
          entries: { ops: {} },
        },
      },
    });

    expect(entries).toEqual([
      expect.objectContaining({
        skill: expect.objectContaining({ name: skillName, source: expectedSource }),
      }),
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([
    { source: "workspace", expectedSource: "openclaw-workspace" },
    { source: "managed", expectedSource: "openclaw-managed" },
    { source: "config-extra", expectedSource: "openclaw-extra" },
  ] as const)(
    "rejects hardlinked $source skills while preserving ordinary files",
    async ({ source, expectedSource }) => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillRoot =
        source === "workspace"
          ? path.join(workspaceDir, "skills")
          : source === "managed"
            ? path.join(workspaceDir, ".managed")
            : path.join(workspaceDir, "extra-skills");
      const rejectedSkillName = `${source}-hardlinked-skill`;
      const acceptedSkillName = `${source}-ordinary-skill`;
      await writeHardlinkedSkill({
        dir: path.join(skillRoot, rejectedSkillName),
        name: rejectedSkillName,
        description: `Untrusted ${source} hardlink`,
      });
      await writeSkill({
        dir: path.join(skillRoot, acceptedSkillName),
        name: acceptedSkillName,
        description: `Ordinary ${source} skill`,
      });
      const warn = captureWarningLogger();

      const entries = loadTestWorkspaceSkills(
        workspaceDir,
        source === "config-extra"
          ? { config: { skills: { load: { extraDirs: [skillRoot] } } } }
          : undefined,
      );

      expect(entries).toEqual([
        expect.objectContaining({
          skill: expect.objectContaining({ name: acceptedSkillName, source: expectedSource }),
        }),
      ]);
      const warningLine = firstWarningLine(warn);
      expect(warningLine).toContain("Skipping invalid skill:");
      expect(warningLine).toContain(rejectedSkillName);
      expect(warningLine).toMatch(/hardlink/iu);
    },
  );

  it.runIf(process.platform !== "win32")(
    "skips workspace skill paths that resolve outside the workspace root",
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
      const fileLinkSkillDir = path.join(workspaceDir, "skills", "escaped-file");
      await fs.mkdir(fileLinkSkillDir, { recursive: true });
      await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(fileLinkSkillDir, "SKILL.md"));
      const targetDir = path.join(workspaceDir, "safe-target");
      await writeSkill({
        dir: targetDir,
        name: "symlink-target",
        description: "Target skill",
      });
      const symlinkedSkillDir = path.join(workspaceDir, "skills", "symlinked");
      await fs.mkdir(symlinkedSkillDir, { recursive: true });
      await fs.symlink(path.join(targetDir, "SKILL.md"), path.join(symlinkedSkillDir, "SKILL.md"));
      const warn = captureWarningLogger();

      const entries = loadTestWorkspaceSkills(workspaceDir);

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-skill");
      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-file-skill");
      expect(entries.map((entry) => entry.skill.name)).not.toContain("symlink-target");
      const warningLine = firstWarningLine(warn);
      expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
      expect(warningLine).toContain("reason=symlink-escape");
      expect(warningLine).toContain("source=openclaw-workspace");
      expect(warningLine).toContain(`root=${path.join(workspaceDir, "skills")}`);
      expect(warningLine).toContain(`requested=${requestedPath}`);
      expect(warningLine).toContain("resolved=");
    },
  );

  it.runIf(process.platform !== "win32")(
    "allows configured skill symlink targets outside their source root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const skillName = `manager-${++workspaceCaseIndex}`;
      const targetRoot = path.join(tempRoot, `${skillName}-skills`);
      const targetSkillDir = path.join(targetRoot, skillName);
      await writeSkill({
        dir: targetSkillDir,
        name: skillName,
        description: "Manager skill",
      });
      const workspaceSkillsDir = path.join(workspaceDir, "skills");
      await fs.mkdir(workspaceSkillsDir, { recursive: true });
      const symlinkPath = path.join(workspaceSkillsDir, skillName);
      await fs.symlink(targetSkillDir, symlinkPath, "dir");
      const warn = captureWarningLogger();

      try {
        const entries = loadTestWorkspaceSkills(workspaceDir, {
          config: {
            skills: {
              load: {
                allowSymlinkTargets: [targetRoot],
              },
            },
          },
        });

        expect(entries.map((entry) => entry.skill.name)).toContain(skillName);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        await fs.unlink(symlinkPath).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "loads managed skill directory symlinks outside the managed root",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const managedDir = path.join(workspaceDir, ".managed");
      const skillName = `managed-${++workspaceCaseIndex}`;
      const targetSkillDir = path.join(tempRoot, `${skillName}-target`, skillName);
      await writeSkill({
        dir: targetSkillDir,
        name: skillName,
        description: "Managed symlink target",
      });
      await fs.mkdir(managedDir, { recursive: true });
      const symlinkPath = path.join(managedDir, skillName);
      await fs.symlink(targetSkillDir, symlinkPath, "dir");
      const warn = captureWarningLogger();

      try {
        const entries = loadTestWorkspaceSkills(workspaceDir, {
          managedSkillsDir: managedDir,
        });

        expect(entries.map((entry) => entry.skill.name)).toContain(skillName);
        expect(warn).not.toHaveBeenCalled();
      } finally {
        await fs.unlink(symlinkPath).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps SKILL.md containment for managed symlinked skill directories",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const managedDir = path.join(workspaceDir, ".managed");
      const skillName = `managed-file-link-${++workspaceCaseIndex}`;
      const targetSkillDir = path.join(tempRoot, `${skillName}-target`, skillName);
      const outsideDir = path.join(tempRoot, `${skillName}-outside`);
      await fs.mkdir(targetSkillDir, { recursive: true });
      await fs.mkdir(outsideDir, { recursive: true });
      await writeSkill({
        dir: outsideDir,
        name: skillName,
        description: "Escaped metadata",
      });
      await fs.symlink(path.join(outsideDir, "SKILL.md"), path.join(targetSkillDir, "SKILL.md"));
      await fs.mkdir(managedDir, { recursive: true });
      const symlinkPath = path.join(managedDir, skillName);
      await fs.symlink(targetSkillDir, symlinkPath, "dir");
      const warn = captureWarningLogger();

      try {
        const entries = loadTestWorkspaceSkills(workspaceDir, {
          managedSkillsDir: managedDir,
        });

        expect(entries.map((entry) => entry.skill.name)).not.toContain(skillName);
        const warningLine = firstWarningLine(warn);
        expect(warningLine).toContain("Skipping escaped skill path outside its configured root:");
        expect(warningLine).toContain("source=openclaw-managed");
        expect(warningLine).toContain("reason=symlink-escape");
      } finally {
        await fs.unlink(symlinkPath).catch(() => undefined);
      }
    },
  );

  it.runIf(process.platform !== "win32")(
    "calls out bundled symlink escapes with compact home-relative paths",
    async () => {
      const { workspaceDir, bundledDir, requestedPath } = await createEscapedBundledSkillFixture();
      const warn = captureWarningLogger();

      const entries = loadTestWorkspaceSkills(workspaceDir, {
        bundledSkillsDir: bundledDir,
      });

      expect(entries.map((entry) => entry.skill.name)).not.toContain("outside-bundled-skill");
      const warningLine = firstWarningLine(warn);
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
      const { workspaceDir, bundledDir } = await createEscapedBundledSkillFixture({
        workspaceDir: path.join(fakeHome, "workspace"),
        outsideDir: path.join(fakeHome, "outside"),
      });
      const warn = captureWarningLogger();

      loadTestWorkspaceSkills(workspaceDir, {
        bundledSkillsDir: bundledDir,
      });

      const warningLine = firstWarningLine(warn);
      expect(warningLine).toContain("root=~/workspace/.bundled");
      expect(warningLine).toContain("requested=~/workspace/.bundled/escaped-bundled-skill");
      expect(warningLine).toContain("resolved=~/outside/outside-bundled-skill");
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

      expect(frontmatter?.name).toBe("root-allowed");
      expect(frontmatter?.description).toBe("Readable from filesystem root");
    },
  );

  it.runIf(process.platform !== "win32")(
    "does not follow outside symlink dirs during repo-root detection",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const repoDir = await createTempWorkspaceDir();
      const outsideDir = await createTempWorkspaceDir();
      await writeSkill({
        dir: path.join(outsideDir, "linked"),
        name: "outside-linked-skill",
        description: "Outside linked skill",
      });
      await fs.mkdir(path.join(repoDir, "examples"), { recursive: true });
      await fs.symlink(outsideDir, path.join(repoDir, "examples", "linked"), "dir");
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
      expect(names).not.toContain("outside-linked-skill");
    },
  );

  it.runIf(process.platform !== "win32")(
    "keeps configured roots with possible symlink skills outside nested skills",
    async () => {
      const workspaceDir = await createTempWorkspaceDir();
      const repoDir = await createTempWorkspaceDir();
      const targetRoot = path.join(tempRoot, `linked-root-${workspaceCaseIndex++}`);
      const targetSkillDir = path.join(targetRoot, "linked-skill");
      await writeSkill({
        dir: targetSkillDir,
        name: "linked-skill",
        description: "Allowed linked skill",
      });
      await fs.mkdir(path.join(repoDir, "group"), { recursive: true });
      await fs.symlink(targetSkillDir, path.join(repoDir, "group", "linked-skill"), "dir");
      await writeSkill({
        dir: path.join(repoDir, "skills", "group", "valid"),
        name: "repo-nested-skill",
        description: "Valid nested repo skill",
      });

      const names = loadTestWorkspaceSkills(workspaceDir, {
        config: {
          skills: {
            load: {
              allowSymlinkTargets: [targetRoot],
              extraDirs: [repoDir],
            },
          },
        },
      }).map((entry) => entry.skill.name);

      expect(names).toContain("linked-skill");
      expect(names).toContain("repo-nested-skill");
    },
  );
});
