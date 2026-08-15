// Docs spellcheck tests cover codespell wrapper configuration.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SCRIPT_PATH = "scripts/docs-spellcheck.sh";
const DICTIONARY_PATH = "scripts/codespell-dictionary.txt";
const IGNORE_PATH = "scripts/codespell-ignore.txt";

function nonEmptyLines(path: string): string[] {
  return readFileSync(path, "utf8").split("\n").filter(Boolean);
}

describe("scripts/docs-spellcheck.sh", () => {
  it("uses the repository dictionary and ignore files", () => {
    const script = readFileSync(SCRIPT_PATH, "utf8");

    expect(script).toContain("-D");
    expect(script).toContain("-");
    expect(script).toContain("-D\n  scripts/codespell-dictionary.txt");
    expect(script).toContain("-I\n  scripts/codespell-ignore.txt");
  });

  it("keeps codespell config entries non-empty and unique", () => {
    for (const path of [DICTIONARY_PATH, IGNORE_PATH]) {
      const lines = nonEmptyLines(path);

      expect(lines.length).toBeGreaterThan(0);
      expect(new Set(lines).size).toBe(lines.length);
      for (const line of lines) {
        expect(line).toBe(line.trim());
      }
    }
  });
});
