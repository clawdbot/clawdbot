import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const scriptPath = path.resolve("scripts/dated-todo-scan.mts");
const tempDirs: string[] = [];

afterEach(() => {
  cleanupTempDirs(tempDirs);
});

function writeFixture(root: string, file: string, contents: string) {
  const target = path.join(root, file);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, contents);
}

describe("dated-todo-scan", () => {
  it("finds nearby dated commitments, ignores noise, and includes deprecated compat records", () => {
    const root = makeTempDir(tempDirs, "dated-todo-scan-");
    const reportRoot = makeTempDir(tempDirs, "dated-todo-report-");
    writeFixture(root, "src/direct.ts", "// TODO: remove this after 2026-10-01\n");
    writeFixture(root, "src/expiry.ts", "// Compatibility expiry: March 1 2027.\n");
    writeFixture(root, "src/expiration.ts", "// Temporary expiration: March 1, 2027.\n");
    writeFixture(root, "src/no-comma-space.ts", "// TODO remove after March 1,2027.\n");
    writeFixture(root, "src/timestamp.ts", "// Temporary expiry 2026-10-01T00:00:00Z.\n");
    writeFixture(root, "config/outside.ts", "// TODO remove after 2027-06-01.\n");
    writeFixture(root, "config/ignored.ts", "// TODO remove after 2027-06-02.\n");
    writeFixture(root, ".gitignore", "config/ignored.ts\n");
    writeFixture(
      root,
      "docs/adjacent.md",
      "<!-- temporary workaround -->\nDeadline: March 2027.\n",
    );
    writeFixture(
      root,
      "test/removal.test.ts",
      "const removalDatePendingCompatCodes = [\n  // keep until July 2028\n];\n",
    );
    writeFixture(root, "src/history.ts", "// Released on 2026-01-01.\n");
    writeFixture(root, "src/no-date.ts", "// TODO: improve this eventually.\n");
    writeFixture(
      root,
      "src/too-far.ts",
      "// FIXME: remove this\nconst gap = true;\n// 2027-04-01\n",
    );
    writeFixture(root, "CHANGELOG.md", "TODO remove after 2026-09-01\n");
    writeFixture(root, "test/fixtures/noise.ts", "// TODO remove after 2026-09-01\n");
    writeFixture(root, "docs/.generated/noise.md", "Temporary until 2026-09-01\n");
    writeFixture(root, "locales/en.json", '{"todo":"remove after 2026-09-01"}\n');
    writeFixture(
      root,
      "src/plugins/compat/registry.ts",
      [
        'const prefix = { code: "fixture-deprecation-extra" };',
        'const record = { code: "fixture-deprecation" };',
        "",
      ].join("\n"),
    );
    spawnSync("git", ["init", "-q"], { cwd: root });
    spawnSync("git", ["add", "."], { cwd: root });
    spawnSync("git", ["add", "-f", "config/ignored.ts"], { cwd: root });
    writeFixture(root, "src/untracked.ts", "// TODO remove after 2026-12-01\n");

    const compatReport = path.join(reportRoot, "compat.json");
    writeFileSync(
      compatReport,
      JSON.stringify({
        compat: {
          records: [
            {
              code: "fixture-deprecation",
              status: "deprecated",
              removeAfter: "2026-11-15",
              replacement: "fixture replacement",
            },
            { code: "active-record", status: "active", removeAfter: "2026-12-01" },
            { code: "undated-deprecation", status: "deprecated" },
          ],
        },
      }),
    );
    const output = path.join(root, ".artifacts", "candidates.json");
    const result = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        scriptPath,
        "--root",
        root,
        "--output",
        output,
        "--compat-report",
        compatReport,
      ],
      { encoding: "utf8" },
    );

    expect(result.status, result.stderr).toBe(0);
    const candidates = JSON.parse(readFileSync(output, "utf8")) as Array<{
      file: string;
      line: number;
      text: string;
      source: string;
    }>;
    expect(candidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ file: "src/direct.ts", line: 1, source: "scan" }),
        expect.objectContaining({ file: "src/expiration.ts", line: 1, source: "scan" }),
        expect.objectContaining({ file: "src/expiry.ts", line: 1, source: "scan" }),
        expect.objectContaining({ file: "src/no-comma-space.ts", line: 1, source: "scan" }),
        expect.objectContaining({ file: "src/timestamp.ts", line: 1, source: "scan" }),
        expect.objectContaining({ file: "config/outside.ts", line: 1, source: "scan" }),
        expect.objectContaining({ file: "config/ignored.ts", line: 1, source: "scan" }),
        expect.objectContaining({ file: "docs/adjacent.md", line: 1, source: "scan" }),
        expect.objectContaining({ file: "test/removal.test.ts", line: 2, source: "scan" }),
        expect.objectContaining({
          file: "src/plugins/compat/registry.ts",
          line: 2,
          source: "compat-registry",
          text: expect.stringContaining("fixture-deprecation: removeAfter 2026-11-15"),
        }),
      ]),
    );
    expect(candidates.map((candidate) => candidate.file)).not.toEqual(
      expect.arrayContaining([
        "CHANGELOG.md",
        "docs/.generated/noise.md",
        "locales/en.json",
        "src/history.ts",
        "src/no-date.ts",
        "src/too-far.ts",
        "src/untracked.ts",
        "test/fixtures/noise.ts",
      ]),
    );
    expect(candidates.filter((candidate) => candidate.source === "compat-registry")).toHaveLength(
      1,
    );
  });
});
