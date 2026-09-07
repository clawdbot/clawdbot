import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";

const execFileAsync = promisify(execFile);
const pluginRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(pluginRoot, "skills");

function listPublishedSkills() {
  return fs
    .readdirSync(skillsRoot, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && fs.existsSync(path.join(skillsRoot, entry.name, "SKILL.md")),
    )
    .map((entry) => entry.name)
    .toSorted();
}

describe("official Slack skill vendor", () => {
  it("preserves pinned vendor bytes and declared adaptations", async () => {
    const { stdout } = await execFileAsync(process.execPath, [
      path.join(pluginRoot, "scripts", "verify-official-skills.mjs"),
    ]);

    expect(stdout).toContain("Verified 3 Slack skill vendor files");
    expect(stdout).toContain("f3f404205cbbfa18fabc79cc9d06fb444efff075");
  });

  it("publishes only the Slack conversation and Block Kit skills", () => {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, "openclaw.plugin.json"), "utf8"),
    ) as { skills?: string[] };
    const published = listPublishedSkills();

    expect(manifest.skills).toEqual(["./skills"]);
    expect(published).toEqual(["block-kit", "slack"]);
  });

  it("keeps published skill metadata and local references valid", () => {
    for (const skillName of listPublishedSkills()) {
      const skillPath = path.join(skillsRoot, skillName, "SKILL.md");
      const source = fs.readFileSync(skillPath, "utf8");
      const frontmatterMatch = /^---\n([\s\S]*?)\n---\n/.exec(source);

      expect(frontmatterMatch, `${skillName} must start with YAML frontmatter`).not.toBeNull();
      const frontmatter = parseYaml(frontmatterMatch?.[1] ?? "") as {
        name?: unknown;
        description?: unknown;
        "allowed-tools"?: unknown;
      };
      expect(frontmatter.name).toBe(skillName);
      expect(typeof frontmatter.description).toBe("string");
      expect(frontmatter["allowed-tools"]).toEqual(["message"]);

      for (const link of source.matchAll(/\]\(([^)]+)\)/g)) {
        const target = link[1]?.split("#", 1)[0]?.trim();
        if (!target || /^[a-z]+:/i.test(target)) {
          continue;
        }
        expect(fs.existsSync(path.resolve(path.dirname(skillPath), target)), target).toBe(true);
      }
    }
  });

  it("keeps the official guide adapted to OpenClaw's available capabilities", () => {
    const guide = fs.readFileSync(
      path.join(skillsRoot, "block-kit", "references", "official-block-kit.md"),
      "utf8",
    );

    expect(guide).toContain("official-common-patterns.md");
    expect(guide).toContain("blocks.validate");
    expect(guide.match(/--data-urlencode/g)).toHaveLength(2);
    expect(guide).not.toMatch(/^\s+-d '(?:blocks|view)=/m);
    expect(guide).not.toMatch(
      /slack:slack-(?:api|cli)|AskUserQuestion|WebFetch|Bash tool|`references\/common-patterns\.md`/,
    );
  });
});
