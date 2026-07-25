import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { parseFrontmatter, resolveOpenClawMetadata } from "./frontmatter.js";
import { loadSkills } from "./session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function loadSkillsFromPath(dir: string) {
  return loadSkills({ cwd: dir, agentDir: dir, skillPaths: [dir], includeDefaults: false });
}

describe("loadSkills", () => {
  it("reports directory scan failures as diagnostics", async () => {
    const tempDir = tempDirs.make("openclaw-skill-scan-");
    const regularFile = path.join(tempDir, "not-a-directory");
    await fs.writeFile(regularFile, "not a skill directory");

    const result = loadSkillsFromPath(regularFile);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ type: "warning", path: regularFile }),
    ]);
  });

  it("does not load dash-prefixed Markdown as frontmatter", async () => {
    const tempDir = tempDirs.make("openclaw-skill-scan-");
    const skillDir = path.join(tempDir, "dash-prefix");
    await fs.mkdir(skillDir);
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(
      skillFile,
      "----\nname: bogus\ndescription: must remain Markdown\n---\n# Body\n",
      "utf-8",
    );

    const result = loadSkillsFromPath(tempDir);

    expect(result.skills).toEqual([]);
    expect(result.diagnostics).toContainEqual({
      type: "warning",
      message: "description is required",
      path: skillFile,
    });
  });

  it("loads skills with JSON5-style trailing commas in metadata frontmatter", async () => {
    const tempDir = tempDirs.make("openclaw-skill-scan-");
    const skillDir = path.join(tempDir, "json5-metadata");
    await fs.mkdir(skillDir);
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.writeFile(
      skillFile,
      `---
name: json5-metadata
description: Skill with JSON5-style metadata.
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
disable-model-invocation: true
---
# JSON5 Metadata
`,
      "utf-8",
    );

    const result = loadSkillsFromPath(tempDir);
    const frontmatter = parseFrontmatter(await fs.readFile(skillFile, "utf-8"));

    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "json5-metadata",
        description: "Skill with JSON5-style metadata.",
        disableModelInvocation: true,
        filePath: skillFile,
      }),
    ]);
    expect(resolveOpenClawMetadata(frontmatter)?.requires?.env).toEqual(["EXAMPLE_VAR"]);
  });

  it("reports malformed frontmatter by file and keeps loading sibling skills", async () => {
    const tempDir = tempDirs.make("openclaw-skill-scan-");
    const brokenDir = path.join(tempDir, "broken");
    const validDir = path.join(tempDir, "valid");
    await fs.mkdir(brokenDir);
    await fs.mkdir(validDir);
    const brokenFile = path.join(brokenDir, "SKILL.md");
    await fs.writeFile(
      brokenFile,
      `---
name: [broken
description: Broken skill
---
`,
      "utf-8",
    );
    await fs.writeFile(
      path.join(validDir, "SKILL.md"),
      `---
name: valid
description: Valid sibling
---
`,
      "utf-8",
    );

    const result = loadSkillsFromPath(tempDir);

    expect(result.skills.map((skill) => skill.name)).toEqual(["valid"]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        type: "warning",
        path: brokenFile,
        message: expect.stringContaining("invalid frontmatter: BAD_INDENT"),
      }),
    ]);
  });
});
