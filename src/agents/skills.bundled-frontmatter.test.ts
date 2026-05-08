import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseFrontmatter } from "./skills/frontmatter.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

describe("bundled taskflow skill frontmatter", () => {
  it("keeps the taskflow skills parseable from their shipped files", async () => {
    const skillPaths = [
      "skills/taskflow/SKILL.md",
      "skills/taskflow-inbox-triage/SKILL.md",
    ] as const;

    for (const relativePath of skillPaths) {
      const raw = await fs.readFile(path.join(repoRoot, relativePath), "utf8");
      const frontmatter = parseFrontmatter(raw);

      expect(frontmatter.name, relativePath).toEqual(expect.any(String));
      expect(frontmatter.name.length, relativePath).toBeGreaterThan(0);
      expect(frontmatter.description, relativePath).toEqual(expect.any(String));
      expect(frontmatter.description.length, relativePath).toBeGreaterThan(0);
    }
  });
});
