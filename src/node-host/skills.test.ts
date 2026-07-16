import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveNodeHostedSkillDirectory, scanNodeHostedSkills } from "./skills.js";

const roots: string[] = [];

function createRoot(): string {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-node-skills-")));
  roots.push(root);
  return root;
}

function writeSkill(
  root: string,
  name: string,
  description: string,
  body = "# Instructions",
): string {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const content = `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
  return content;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe("scanNodeHostedSkills", () => {
  it("resolves a matching node skill locator against a custom state directory", () => {
    const stateDir = createRoot();
    const skillDir = path.join(stateDir, "skills", "profile-skill");
    writeSkill(path.join(stateDir, "skills"), "profile-skill", "Profile skill");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    expect(resolveNodeHostedSkillDirectory("node://node-1/skills/profile-skill", "node-1")).toBe(
      fs.realpathSync(skillDir),
    );
    expect(() =>
      resolveNodeHostedSkillDirectory("node://node-2/skills/profile-skill", "node-1"),
    ).toThrow("invalid for this node");
    expect(() =>
      resolveNodeHostedSkillDirectory("node://node-1/skills/../profile-skill", "node-1"),
    ).toThrow("invalid for this node");
    if (process.platform !== "win32") {
      const outsideDir = path.join(stateDir, "outside");
      writeSkill(stateDir, "outside", "Outside");
      fs.symlinkSync(outsideDir, path.join(stateDir, "skills", "escape"));
      expect(() =>
        resolveNodeHostedSkillDirectory("node://node-1/skills/escape", "node-1"),
      ).toThrow("unavailable");
    }
  });

  it("uses the active OpenClaw profile skills directory by default", () => {
    const stateDir = createRoot();
    const content = writeSkill(path.join(stateDir, "skills"), "profile-skill", "Profile skill");
    vi.stubEnv("OPENCLAW_STATE_DIR", stateDir);

    expect(scanNodeHostedSkills()).toEqual([
      { name: "profile-skill", description: "Profile skill", content },
    ]);
  });

  it("loads descriptors and preserves the full SKILL.md content", () => {
    const root = createRoot();
    const content = writeSkill(root, "release-helper", "Prepare a release", "# Release\nDo it.");

    expect(scanNodeHostedSkills({ skillsDir: root })).toEqual([
      { name: "release-helper", description: "Prepare a release", content },
    ]);
  });

  it("loads JSON5-style metadata frontmatter", () => {
    const root = createRoot();
    const skillDir = path.join(root, "json5-metadata");
    fs.mkdirSync(skillDir);
    const content = `---
name: json5-metadata
description: JSON5-style metadata
metadata:
  {
    "openclaw":
      {
        "requires":
          {
            "env": ["EXAMPLE_VAR"],
          },
      },
  }
---
`;
    fs.writeFileSync(path.join(skillDir, "SKILL.md"), content);

    expect(scanNodeHostedSkills({ skillsDir: root })).toEqual([
      { name: "json5-metadata", description: "JSON5-style metadata", content },
    ]);
  });

  it("skips invalid and oversized skills with warnings", () => {
    const root = createRoot();
    writeSkill(root, "valid-skill", "Valid");
    const invalidDir = path.join(root, "invalid");
    fs.mkdirSync(invalidDir);
    fs.writeFileSync(path.join(invalidDir, "SKILL.md"), "# Missing frontmatter");
    const malformedDir = path.join(root, "malformed");
    fs.mkdirSync(malformedDir);
    const malformedFile = path.join(malformedDir, "SKILL.md");
    fs.writeFileSync(
      malformedFile,
      "---\nname: [malformed\ndescription: Malformed frontmatter\n---\n",
    );
    writeSkill(root, "oversized", "Oversized", "x".repeat(64 * 1024));
    const mismatchedDir = path.join(root, "folder-name");
    fs.mkdirSync(mismatchedDir);
    fs.writeFileSync(
      path.join(mismatchedDir, "SKILL.md"),
      "---\nname: frontmatter-name\ndescription: Mismatched\n---\n",
    );
    const warn = vi.fn();

    const skills = scanNodeHostedSkills({ skillsDir: root, warn });

    expect(skills.map((skill) => skill.name)).toEqual(["valid-skill"]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("invalid or missing frontmatter"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(malformedFile));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("BAD_INDENT"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeds 65536 bytes"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("directory, name, and frontmatter"));
  });

  it("keeps nested diagnostics separate from the current candidate", () => {
    const root = createRoot();
    const candidateDir = path.join(root, "candidate");
    fs.mkdirSync(path.join(candidateDir, "nested"), { recursive: true });
    const candidateFile = path.join(candidateDir, "SKILL.md");
    fs.writeFileSync(candidateFile, "# Missing frontmatter\n");
    const nestedFile = path.join(candidateDir, "nested", "SKILL.md");
    fs.writeFileSync(nestedFile, "---\nname: [nested\ndescription: Malformed nested skill\n---\n");
    const warn = vi.fn();

    expect(scanNodeHostedSkills({ skillsDir: root, warn })).toEqual([]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining(nestedFile));
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(`${candidateFile}): has invalid or missing frontmatter`),
    );
  });

  it("rejects a root-level skill because its node locator is not representable", () => {
    const root = path.join(createRoot(), "skills");
    fs.mkdirSync(root);
    const childContent = writeSkill(root, "valid-child", "Valid child");
    fs.writeFileSync(
      path.join(root, "SKILL.md"),
      "---\nname: skills\ndescription: Root skill\n---\n",
    );
    const warn = vi.fn();

    expect(scanNodeHostedSkills({ skillsDir: root, warn })).toEqual([
      { name: "valid-child", description: "Valid child", content: childContent },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("named child directory"));
  });

  it("warns and continues when the optional root skill cannot be inspected", () => {
    const root = createRoot();
    const childContent = writeSkill(root, "valid-child", "Valid child");
    fs.symlinkSync("SKILL.md", path.join(root, "SKILL.md"));
    const brokenDir = path.join(root, "broken-child");
    fs.mkdirSync(brokenDir);
    fs.symlinkSync("SKILL.md", path.join(brokenDir, "SKILL.md"));
    const warn = vi.fn();

    expect(scanNodeHostedSkills({ skillsDir: root, warn })).toEqual([
      { name: "valid-child", description: "Valid child", content: childContent },
    ]);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("skill scan skipped"));
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken-child/SKILL.md"));
  });

  it("enforces count and total-content caps", () => {
    const countRoot = createRoot();
    for (let index = 0; index < 65; index += 1) {
      writeSkill(countRoot, `count-${String(index).padStart(2, "0")}`, "Counted");
    }
    const countWarn = vi.fn();
    expect(scanNodeHostedSkills({ skillsDir: countRoot, warn: countWarn })).toHaveLength(64);
    expect(countWarn).toHaveBeenCalledWith(expect.stringContaining("exceeds 64 skills"));

    const totalRoot = createRoot();
    for (let index = 0; index < 9; index += 1) {
      writeSkill(
        totalRoot,
        `large-${String(index).padStart(2, "0")}`,
        "Large",
        "x".repeat(60 * 1024),
      );
    }
    const totalWarn = vi.fn();
    expect(scanNodeHostedSkills({ skillsDir: totalRoot, warn: totalWarn })).toHaveLength(8);
    expect(totalWarn).toHaveBeenCalledWith(expect.stringContaining("exceeds 524288 total bytes"));
  });
});
