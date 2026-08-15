// Config path docs tests validate documented config path references.
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";

const DOCS_WITH_CONFIG_PATH_EXAMPLES = [
  "docs/cli/config.md",
  "docs/tools/exec.md",
  "docs/nodes/index.md",
];

function findUnquotedBracketPathExamples(markdown: string, docPath: string): string[] {
  const failures: string[] = [];

  for (const [index, line] of markdown.split(/\r?\n/).entries()) {
    const match = line.match(/\bopenclaw\s+config\s+(?:get|set|unset)\s+(\S+)/);
    if (!match) {
      continue;
    }

    const pathArg = expectDefined(match[1], "match[1] test invariant");
    if (pathArg.includes("[") && !pathArg.startsWith("'") && !pathArg.startsWith('"')) {
      failures.push(`${docPath}:${index + 1}: ${pathArg}`);
    }
  }

  return failures;
}

describe("config path docs", () => {
  it("quotes bracket-notation config paths in shell examples", async () => {
    const failures: string[] = [];

    for (const docPath of DOCS_WITH_CONFIG_PATH_EXAMPLES) {
      const markdown = await fs.readFile(path.join(process.cwd(), docPath), "utf8");
      failures.push(...findUnquotedBracketPathExamples(markdown, docPath));
    }

    expect(failures).toEqual([]);
  });
});
