import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { withMockedWindowsPlatform } from "../../test-utils/vitest-spies.js";
import { parseSkillFrontmatter, resolveSkillManifestMetadata } from "./frontmatter.js";
import { loadSingleSkillDirectory, type LocalSkillLoadDiagnostic } from "./local-loader.js";
import { loadSkills } from "./session.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function loadSkillsFromPath(dir: string) {
  return loadSkills({ cwd: dir, agentDir: dir, skillPaths: [dir], includeDefaults: false });
}

describe("loadSkills", () => {
  it.each(["user", "project", "path"] as const)(
    "preserves %s session provenance and its untrimmed fallback name beside local loading",
    async (source) => {
      const root = tempDirs.make("openclaw-skill-materialization-");
      const agentDir = path.join(root, "agent");
      const cwd = path.join(root, "project");
      const skillRoot =
        source === "user"
          ? path.join(agentDir, "skills")
          : source === "project"
            ? path.join(cwd, ".openclaw", "skills")
            : path.join(root, "selected");
      const skillDir = path.join(skillRoot, " padded-name");
      const filePath = path.join(skillDir, "SKILL.md");
      await fs.mkdir(skillDir, { recursive: true });
      await fs.writeFile(
        filePath,
        '---\ndescription: "  Padded metadata.  "\ndisable-model-invocation: true\n---\n# Shared Title\n',
      );

      const session = loadSkills({ cwd, agentDir, skillPaths: [filePath], includeDefaults: false });
      expect(session.skills).toEqual([
        {
          name: " padded-name",
          displayName: "Shared Title",
          description: "Padded metadata.",
          filePath,
          baseDir: skillDir,
          source,
          sourceInfo: {
            path: filePath,
            source: "local",
            scope: source === "path" ? "temporary" : source,
            origin: "top-level",
            baseDir: skillDir,
          },
          disableModelInvocation: true,
        },
      ]);
      expect(session.diagnostics).toEqual([
        {
          type: "warning",
          path: filePath,
          message: "name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)",
        },
      ]);

      const diagnostics: LocalSkillLoadDiagnostic[] = [];
      const local = loadSingleSkillDirectory({
        skillDir,
        source: "workspace",
        rootRealPath: await fs.realpath(skillDir),
        onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      });
      expect(local?.skill).toEqual({
        name: "padded-name",
        displayName: "Shared Title",
        description: "Padded metadata.",
        filePath,
        baseDir: skillDir,
        source: "workspace",
        sourceInfo: {
          path: filePath,
          source: "workspace",
          scope: "project",
          origin: "top-level",
          baseDir: skillDir,
        },
        disableModelInvocation: true,
      });
      expect(diagnostics).toEqual([]);
    },
  );

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
    const frontmatter = parseSkillFrontmatter(await fs.readFile(skillFile, "utf-8"));

    expect(result.diagnostics).toEqual([]);
    expect(result.skills).toEqual([
      expect.objectContaining({
        name: "json5-metadata",
        displayName: "JSON5 Metadata",
        description: "Skill with JSON5-style metadata.",
        disableModelInvocation: true,
        filePath: skillFile,
      }),
    ]);
    expect(resolveSkillManifestMetadata(frontmatter)?.requires?.env).toEqual(["EXAMPLE_VAR"]);
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

  it("keeps case-variant Windows project skill paths in project scope", async () => {
    const root = tempDirs.make("openclaw-skill-scan-");
    const projectDir = path.join(root, "project");
    const skillDir = path.join(projectDir, ".openclaw", "skills", "project-skill");
    const skillFile = path.join(skillDir, "SKILL.md");
    await fs.mkdir(skillDir, { recursive: true });
    await fs.writeFile(skillFile, "---\nname: project-skill\ndescription: Project skill.\n---\n");

    expect(
      withMockedWindowsPlatform(
        () =>
          loadSkills({
            cwd: path.join(root, "PROJECT"),
            agentDir: path.join(root, "agent"),
            skillPaths: [skillFile],
            includeDefaults: false,
          }).skills[0]?.source,
      ),
    ).toBe("project");
  });
});
