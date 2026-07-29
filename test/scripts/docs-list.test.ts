// docs-list tests cover source docs metadata discovery for docs-aware tooling.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];
const repoRoot = path.resolve(import.meta.dirname, "../..");
const docsListScriptPath = path.join(repoRoot, "scripts", "docs-list.js");

function makeTempRepoRoot(prefix: string): string {
  return makeTempDir(tempDirs, prefix);
}

function runDocsList(cwd: string): string {
  return execFileSync(process.execPath, [docsListScriptPath], {
    cwd,
    encoding: "utf8",
  });
}

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

describe("docs-list", () => {
  it("prints single-line read_when strings as read hints", () => {
    const tempRepoRoot = makeTempRepoRoot("openclaw-docs-list-");
    mkdirSync(path.join(tempRepoRoot, "docs"), { recursive: true });
    writeFileSync(
      path.join(tempRepoRoot, "docs", "page.md"),
      `---
summary: "Single-line read_when page"
read_when: "Read this page when the hint is inline."
---
`,
      "utf8",
    );

    const output = runDocsList(tempRepoRoot);

    expect(output).toContain("page.md - Single-line read_when page");
    expect(output).toContain("Read when: Read this page when the hint is inline.");
  });
});
