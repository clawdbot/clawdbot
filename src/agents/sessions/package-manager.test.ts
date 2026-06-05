// Package manager tests cover resource discovery boundaries for package,
// project, and npm-declared agent resources.
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DefaultPackageManager } from "./package-manager.js";
import { SettingsManager } from "./settings-manager.js";

const tempDirs: string[] = [];

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("DefaultPackageManager", () => {
  it("keeps manifest resource entries inside the package root", async () => {
    // Manifest globs are package-owned; path traversal or symlink hops must not
    // expose arbitrary host files as skills.
    const root = await makeTempDir("openclaw-package-manager-");
    const packageRoot = join(root, "package");
    const outsideRoot = join(root, "outside");
    const insideSkill = join(packageRoot, "skills", "inside", "SKILL.md");
    const outsideSkill = join(outsideRoot, "SKILL.md");
    await mkdir(join(packageRoot, "skills", "inside"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(insideSkill, "# Inside\n", "utf-8");
    await writeFile(outsideSkill, "# Outside\n", "utf-8");

    const entries = ["skills/inside/SKILL.md", "../outside/SKILL.md", "../outside/*.md"];
    try {
      await symlink(outsideRoot, join(packageRoot, "skills", "linked"), "dir");
      entries.push("skills/linked/SKILL.md");
    } catch {
      // Some filesystems disallow directory symlinks; path traversal coverage is still enough there.
    }

    await writeFile(
      join(packageRoot, "package.json"),
      JSON.stringify({ openclaw: { skills: entries } }),
      "utf-8",
    );

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    });

    const resolved = await manager.resolve();
    const skillPaths = resolved.skills.map((skill) => skill.path);

    expect(skillPaths).toContain(insideSkill);
    expect(skillPaths).not.toContain(outsideSkill);
  });

  it("keeps convention-discovered resource entries inside the package root", async () => {
    const root = await makeTempDir("openclaw-package-manager-");
    const packageRoot = join(root, "package");
    const outsideRoot = join(root, "outside");
    const insideSkill = join(packageRoot, "skills", "inside", "SKILL.md");
    await mkdir(join(packageRoot, "skills", "inside"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(insideSkill, "# Inside\n", "utf-8");
    await writeFile(join(outsideRoot, "SKILL.md"), "# Outside\n", "utf-8");
    await writeFile(join(packageRoot, "package.json"), JSON.stringify({ name: "pkg" }), "utf-8");

    try {
      await symlink(outsideRoot, join(packageRoot, "skills", "linked"), "dir");
    } catch {
      // Some filesystems disallow directory symlinks; skip the symlink-only assertion there.
    }

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: [packageRoot] }),
    });

    const resolved = await manager.resolve();
    const skillPaths = resolved.skills.map((skill) => skill.path);

    expect(skillPaths).toContain(insideSkill);
    expect(skillPaths.some((skillPath) => skillPath.includes(join("skills", "linked")))).toBe(
      false,
    );
  });

  it("keeps auto-discovered project skills inside their skill root", async () => {
    const root = await makeTempDir("openclaw-package-manager-");
    const agentsSkillsRoot = join(root, ".agents", "skills");
    const insideSkill = join(agentsSkillsRoot, "inside", "SKILL.md");
    const outsideRoot = join(root, "outside");
    await mkdir(join(root, ".git"));
    await mkdir(join(agentsSkillsRoot, "inside"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(insideSkill, "# Inside\n", "utf-8");
    await writeFile(join(outsideRoot, "SKILL.md"), "# Outside\n", "utf-8");

    try {
      await symlink(outsideRoot, join(agentsSkillsRoot, "linked"), "dir");
    } catch {
      // Some filesystems disallow directory symlinks; the inside assertion still proves discovery.
    }

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({}),
    });

    const resolved = await manager.resolve();
    const skillPaths = resolved.skills.map((skill) => skill.path);

    expect(skillPaths).toContain(insideSkill);
    expect(skillPaths.some((skillPath) => skillPath.includes(join("skills", "linked")))).toBe(
      false,
    );
  });

  it("keeps auto-discovered project resources inside their resource roots", async () => {
    // Project resources may be auto-discovered, but each resource type remains
    // confined to its expected root.
    const root = await makeTempDir("openclaw-package-manager-");
    const configRoot = join(root, ".openclaw");
    const outsideRoot = join(root, "outside");
    const insidePrompt = join(configRoot, "prompts", "inside.md");
    const insideTheme = join(configRoot, "themes", "inside.json");
    const insideExtension = join(configRoot, "extensions", "inside.ts");
    await mkdir(join(root, ".git"));
    await mkdir(join(configRoot, "prompts"), { recursive: true });
    await mkdir(join(configRoot, "themes"), { recursive: true });
    await mkdir(join(configRoot, "extensions"), { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(insidePrompt, "# Inside\n", "utf-8");
    await writeFile(insideTheme, "{}\n", "utf-8");
    await writeFile(insideExtension, "export default {};\n", "utf-8");
    await writeFile(join(outsideRoot, "outside.md"), "# Outside\n", "utf-8");
    await writeFile(join(outsideRoot, "outside.json"), "{}\n", "utf-8");
    await writeFile(join(outsideRoot, "outside.ts"), "export default {};\n", "utf-8");

    try {
      await symlink(join(outsideRoot, "outside.md"), join(configRoot, "prompts", "linked.md"));
      await symlink(join(outsideRoot, "outside.json"), join(configRoot, "themes", "linked.json"));
      await symlink(join(outsideRoot, "outside.ts"), join(configRoot, "extensions", "linked.ts"));
      await symlink(outsideRoot, join(configRoot, "extensions", "linked-dir"), "dir");
    } catch {
      // Some filesystems disallow symlinks; the inside assertions still prove discovery.
    }

    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({}),
    });

    const resolved = await manager.resolve();

    expect(resolved.prompts.map((prompt) => prompt.path)).toContain(insidePrompt);
    expect(resolved.themes.map((theme) => theme.path)).toContain(insideTheme);
    expect(resolved.extensions.map((extension) => extension.path)).toContain(insideExtension);
    expect(resolved.prompts.some((prompt) => prompt.path.includes("linked"))).toBe(false);
    expect(resolved.themes.some((theme) => theme.path.includes("linked"))).toBe(false);
    expect(resolved.extensions.some((extension) => extension.path.includes("linked"))).toBe(false);
  });

  it("does not auto-install missing npm package resources", async () => {
    const root = await makeTempDir("openclaw-package-manager-");
    const manager = new DefaultPackageManager({
      cwd: root,
      agentDir: join(root, "agent"),
      settingsManager: SettingsManager.inMemory({ packages: ["npm:@openclaw/missing-test"] }),
    });

    const resolved = await manager.resolve();

    expect(resolved.extensions).toEqual([]);
    expect(resolved.skills).toEqual([]);
    expect(resolved.prompts).toEqual([]);
    expect(resolved.themes).toEqual([]);
  });
});
