import { describe, expect, it } from "vitest";
import {
  checkUnusedFiles,
  compareUnusedFilesToAllowlist,
  parseKnipCompactUnusedFiles,
} from "../../scripts/check-deadcode-unused-files.mjs";

describe("check-deadcode-unused-files", () => {
  it("parses the compact Knip unused-file section", () => {
    expect(
      parseKnipCompactUnusedFiles(`
> openclaw@2026.4.27 deadcode:knip /repo
> pnpm dlx knip --reporter compact --files

Unused files (2)
src/b.ts: src/b.ts
src/a.ts: src/a.ts

Unused dependencies (1)
left-pad: package.json
`),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("parses Knip's files-only compact output", () => {
    expect(parseKnipCompactUnusedFiles("src/b.ts: src/b.ts\nsrc/a.ts: src/a.ts\n")).toEqual([
      "src/a.ts",
      "src/b.ts",
    ]);
  });

  it("reports unexpected and stale allowlist entries", () => {
    expect(
      compareUnusedFilesToAllowlist(["src/a.ts", "src/new.ts"], ["src/a.ts", "src/old.ts"]),
    ).toMatchObject({
      unexpected: ["src/new.ts"],
      stale: ["src/old.ts"],
      duplicateAllowedCount: 0,
      allowlistIsSorted: true,
    });
  });

  it("accepts optional allowlist entries whether Knip reports them or not", () => {
    expect(
      compareUnusedFilesToAllowlist(
        ["src/a.ts", "src/platform.ts"],
        ["src/a.ts"],
        ["src/platform.ts"],
      ),
    ).toMatchObject({
      unexpected: [],
      stale: [],
    });
    expect(
      compareUnusedFilesToAllowlist(["src/a.ts"], ["src/a.ts"], ["src/platform.ts"]),
    ).toMatchObject({
      unexpected: [],
      stale: [],
    });
  });

  it("accepts exactly allowlisted unused files", () => {
    expect(checkUnusedFiles("Unused files (1)\nsrc/a.ts: src/a.ts\n", ["src/a.ts"])).toMatchObject({
      ok: true,
      message: "",
    });
  });

  it("rejects unsorted allowlists", () => {
    expect(
      compareUnusedFilesToAllowlist(["src/a.ts", "src/b.ts"], ["src/b.ts", "src/a.ts"]),
    ).toMatchObject({
      allowlistIsSorted: false,
    });
  });
});
