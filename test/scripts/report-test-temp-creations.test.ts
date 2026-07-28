import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectTempCreationFindingsFromDiff,
  formatGithubWarning,
} from "../../scripts/report-test-temp-creations.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const repoRoot = process.cwd();
const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nestedGitEnvKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_QUARANTINE_PATH",
  "GIT_WORK_TREE",
] as const;

function createNestedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of nestedGitEnvKeys) {
    delete env[key];
  }
  return env;
}

describe("report-test-temp-creations", () => {
  it("keeps a non-executed warning fixture for changed-gate proof", () => {
    // openclaw-temp-dir: allow test fixture for the temp warning report
    const warningFixture = 'fs.mkdtempSync("openclaw-warning-fixture-")';

    expect(warningFixture).toContain("mkdtempSync");
  });

  it("reports added bare temp creation lines using changed-lane test path scope", () => {
    const bareTempSource = [
      "const tempRoot = fs.",
      "mkdtemp",
      'Sync(path.join(os.tmpdir(), "case-"));',
    ].join("");
    const mkdtempSource = ["const tempRoot = fs.", "mkdtemp", 'Sync("case-");'].join("");
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "--- a/src/example.test.ts",
      "+++ b/src/example.test.ts",
      "@@ -10,0 +11,3 @@",
      `+${bareTempSource}`,
      '+const helperRoot = makeTempDir(tempDirs, "case-");',
      "+console.log(tempRoot, helperRoot);",
      "diff --git a/src/example.ts b/src/example.ts",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -4,0 +5,1 @@",
      `+${["const productionTemp = fs.", "mkdtemp", 'Sync("case-");'].join("")}`,
      "diff --git a/test/helper.test-support.mjs b/test/helper.test-support.mjs",
      "--- a/test/helper.test-support.mjs",
      "+++ b/test/helper.test-support.mjs",
      "@@ -1,0 +2,1 @@",
      `+${mkdtempSource}`,
      "diff --git a/test/helpers/temp-fixture.ts b/test/helpers/temp-fixture.ts",
      "--- a/test/helpers/temp-fixture.ts",
      "+++ b/test/helpers/temp-fixture.ts",
      "@@ -1,0 +2,1 @@",
      `+${mkdtempSource}`,
      "diff --git a/test/helpers/temp-dir.ts b/test/helpers/temp-dir.ts",
      "--- a/test/helpers/temp-dir.ts",
      "+++ b/test/helpers/temp-dir.ts",
      "@@ -1,0 +2,1 @@",
      `+${mkdtempSource}`,
      "diff --git a/packages/foo/__tests__/helper.ts b/packages/foo/__tests__/helper.ts",
      "--- a/packages/foo/__tests__/helper.ts",
      "+++ b/packages/foo/__tests__/helper.ts",
      "@@ -1,0 +2,1 @@",
      `+${mkdtempSource}`,
      "diff --git a/extensions/discord/src/monitor/message-handler.test-helpers.ts b/extensions/discord/src/monitor/message-handler.test-helpers.ts",
      "--- a/extensions/discord/src/monitor/message-handler.test-helpers.ts",
      "+++ b/extensions/discord/src/monitor/message-handler.test-helpers.ts",
      "@@ -1,0 +2,1 @@",
      `+${mkdtempSource}`,
    ].join("\n");

    expect(collectTempCreationFindingsFromDiff(diff)).toEqual([
      {
        file: "src/example.test.ts",
        line: 11,
        reason: "new mkdtemp temp directory creation",
        source: bareTempSource,
      },
      ...[
        "test/helper.test-support.mjs",
        "test/helpers/temp-fixture.ts",
        "packages/foo/__tests__/helper.ts",
        "extensions/discord/src/monitor/message-handler.test-helpers.ts",
      ].map((file) => ({
        file,
        line: 2,
        reason: "new mkdtemp temp directory creation",
        source: mkdtempSource,
      })),
    ]);
  });

  it("reports repository-observed mkdtemp call forms", () => {
    const sources = [
      ["const root = await fs.promises.", "mkdtemp", '(path.join(os.tmpdir(), "case-"));'].join(""),
      ["const root = await fs.", "mkdtemp", '(path.join(os.tmpdir(), "case-"));'].join(""),
      ["const root = await fsPromises.", "mkdtemp", '("/tmp/openclaw-case-");'].join(""),
      ["const root = await ", "mkdtemp", '(path.join(tmpdir(), "case-"));'].join(""),
      ["const root = ", "mkdtemp", 'Sync(join(tmpdir(), "case-"));'].join(""),
    ];
    const diff = [
      "diff --git a/test/scripts/temp-patterns.test.ts b/test/scripts/temp-patterns.test.ts",
      "--- a/test/scripts/temp-patterns.test.ts",
      "+++ b/test/scripts/temp-patterns.test.ts",
      "@@ -1,0 +1,5 @@",
      ...sources.map((source) => `+${source}`),
    ].join("\n");

    expect(collectTempCreationFindingsFromDiff(diff)).toEqual(
      sources.map((source, index) => ({
        file: "test/scripts/temp-patterns.test.ts",
        line: index + 1,
        reason: "new mkdtemp temp directory creation",
        source,
      })),
    );
  });

  it("honors explicit allow comments with reasons", () => {
    const mkdtempCall = ["fs.", "mkdtemp", 'Sync("case-")'].join("");
    const tmpDirCall = ["tmp.", "dir", 'Sync({ prefix: "case-" })'].join("");
    const allowedSource = `const allowed = ${mkdtempCall};`;
    const inlineAllowedSource = `const inlineAllowed = ${tmpDirCall}; // openclaw-temp-dir: allow verifies tmp API behavior`;
    const blockedSource = `const blocked = ${mkdtempCall};`;
    const stringMarkerSource = `const stringMarker = ${mkdtempCall}; const note = "openclaw-temp-dir: allow quoted text";`;
    const emptyReasonSource = `const emptyReason = ${mkdtempCall};`;
    const diff = [
      "diff --git a/test/helpers/raw-temp.test.ts b/test/helpers/raw-temp.test.ts",
      "--- a/test/helpers/raw-temp.test.ts",
      "+++ b/test/helpers/raw-temp.test.ts",
      "@@ -1,0 +2,5 @@",
      "+// openclaw-temp-dir: allow verifies raw fs cleanup behavior",
      `+${allowedSource}`,
      `+${inlineAllowedSource}`,
      `+${blockedSource}`,
      `+${stringMarkerSource}`,
      "diff --git a/test/helpers/empty-allow.test.ts b/test/helpers/empty-allow.test.ts",
      "--- a/test/helpers/empty-allow.test.ts",
      "+++ b/test/helpers/empty-allow.test.ts",
      "@@ -1,0 +2,2 @@",
      "+// openclaw-temp-dir: allow",
      `+${emptyReasonSource}`,
    ].join("\n");

    expect(collectTempCreationFindingsFromDiff(diff)).toEqual([
      {
        file: "test/helpers/raw-temp.test.ts",
        line: 5,
        reason: "new mkdtemp temp directory creation",
        source: blockedSource,
      },
      {
        file: "test/helpers/raw-temp.test.ts",
        line: 6,
        reason: "new mkdtemp temp directory creation",
        source: stringMarkerSource,
      },
      {
        file: "test/helpers/empty-allow.test.ts",
        line: 3,
        reason: "new mkdtemp temp directory creation",
        source: emptyReasonSource,
      },
    ]);
  });

  it("reports added imports and calls for manual temp-dir helpers", () => {
    const file = "test/scripts/manual-temp.test.ts";
    const source = [
      'import { afterEach } from "vitest";',
      'import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";',
      "const tempDirs = new Set<string>();",
      "afterEach(() => cleanupTempDirs(tempDirs));",
      'const workspace = makeTempDir(tempDirs, "case-");',
    ].join("\n");
    const diff = [
      "diff --git a/test/scripts/manual-temp.test.ts b/test/scripts/manual-temp.test.ts",
      "--- a/test/scripts/manual-temp.test.ts",
      "+++ b/test/scripts/manual-temp.test.ts",
      "@@ -1,0 +1,5 @@",
      '+import { afterEach } from "vitest";',
      '+import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";',
      "+const tempDirs = new Set<string>();",
      "+afterEach(() => cleanupTempDirs(tempDirs));",
      '+const workspace = makeTempDir(tempDirs, "case-");',
    ].join("\n");

    expect(
      collectTempCreationFindingsFromDiff(diff, { fileTextByPath: { [file]: source } }),
    ).toEqual([
      {
        file,
        line: 2,
        reason: "new manual temp-dir helper import",
        source: 'import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";',
      },
      {
        file,
        line: 4,
        reason: "new manual temp-dir helper usage",
        source: "afterEach(() => cleanupTempDirs(tempDirs));",
      },
      {
        file,
        line: 5,
        reason: "new manual temp-dir helper usage",
        source: 'const workspace = makeTempDir(tempDirs, "case-");',
      },
    ]);
  });

  it("reports multiline imports from the shared temp-dir helper", () => {
    const file = "src/example.test.ts";
    const source = [
      "import {",
      "  createTempDirTracker,",
      '} from "../test/helpers/temp-dir.js";',
      "const tempDirs = createTempDirTracker();",
    ].join("\n");
    const diff = [
      "diff --git a/src/example.test.ts b/src/example.test.ts",
      "--- a/src/example.test.ts",
      "+++ b/src/example.test.ts",
      "@@ -1,0 +1,4 @@",
      "+import {",
      "+  createTempDirTracker,",
      '+} from "../test/helpers/temp-dir.js";',
      "+const tempDirs = createTempDirTracker();",
    ].join("\n");

    expect(
      collectTempCreationFindingsFromDiff(diff, { fileTextByPath: { [file]: source } }),
    ).toEqual([
      {
        file,
        line: 2,
        reason: "new manual temp-dir helper import",
        source: 'import { createTempDirTracker, } from "../test/helpers/temp-dir.js";',
      },
      {
        file,
        line: 4,
        reason: "new manual temp-dir helper usage",
        source: "const tempDirs = createTempDirTracker();",
      },
    ]);
  });

  it("reports manual helpers added to existing multiline imports", () => {
    const file = "test/scripts/manual-temp.test.ts";
    const source = [
      "import {",
      "  useAutoCleanupTempDirTracker,",
      "  makeTempDir,",
      '} from "../helpers/temp-dir.js";',
      "const tempDirs = useAutoCleanupTempDirTracker(afterEach);",
    ].join("\n");
    const diff = [
      "diff --git a/test/scripts/manual-temp.test.ts b/test/scripts/manual-temp.test.ts",
      "--- a/test/scripts/manual-temp.test.ts",
      "+++ b/test/scripts/manual-temp.test.ts",
      "@@ -1,3 +1,4 @@",
      " import {",
      "   useAutoCleanupTempDirTracker,",
      "+  makeTempDir,",
      ' } from "../helpers/temp-dir.js";',
    ].join("\n");

    expect(
      collectTempCreationFindingsFromDiff(diff, { fileTextByPath: { [file]: source } }),
    ).toEqual([
      {
        file,
        line: 3,
        reason: "new manual temp-dir helper import",
        source:
          'import { useAutoCleanupTempDirTracker, makeTempDir, } from "../helpers/temp-dir.js";',
      },
    ]);
  });

  it("allows the auto-cleaning temp-dir helper", () => {
    const file = "test/scripts/auto-temp.test.ts";
    const source = [
      'import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";',
      "const tempDirs = useAutoCleanupTempDirTracker(afterEach);",
      'const workspace = tempDirs.make("case-");',
    ].join("\n");
    const diff = [
      "diff --git a/test/scripts/auto-temp.test.ts b/test/scripts/auto-temp.test.ts",
      "--- a/test/scripts/auto-temp.test.ts",
      "+++ b/test/scripts/auto-temp.test.ts",
      "@@ -1,0 +1,3 @@",
      '+import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";',
      "+const tempDirs = useAutoCleanupTempDirTracker(afterEach);",
      '+const workspace = tempDirs.make("case-");',
    ].join("\n");

    expect(
      collectTempCreationFindingsFromDiff(diff, { fileTextByPath: { [file]: source } }),
    ).toEqual([]);
  });

  it("ignores manual helper fixture strings and the helper test file", () => {
    const fixtureFile = "test/scripts/report-test-temp-creations.test.ts";
    const helperTestFile = "test/helpers/temp-dir.test.ts";
    const fixtureSource = [
      'import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";',
      'const fixture = "makeTempDir(tempDirs, \\"case-\\")";',
    ].join("\n");
    const helperTestSource = [
      'import { createTempDirTracker } from "./temp-dir.js";',
      "const tempDirs = createTempDirTracker();",
    ].join("\n");
    const diff = [
      "diff --git a/test/scripts/report-test-temp-creations.test.ts b/test/scripts/report-test-temp-creations.test.ts",
      "--- a/test/scripts/report-test-temp-creations.test.ts",
      "+++ b/test/scripts/report-test-temp-creations.test.ts",
      "@@ -1,0 +1,5 @@",
      '+const importFixture = "import { makeTempDir } from \\"../helpers/temp-dir.js\\";";',
      "+const callFixture = [",
      '+  "makeTempDir",',
      '+  "(tempDirs, \\"case-\\")",',
      '+].join("");',
      "diff --git a/test/helpers/temp-dir.test.ts b/test/helpers/temp-dir.test.ts",
      "--- a/test/helpers/temp-dir.test.ts",
      "+++ b/test/helpers/temp-dir.test.ts",
      "@@ -1,0 +1,2 @@",
      '+import { createTempDirTracker } from "./temp-dir.js";',
      "+const tempDirs = createTempDirTracker();",
    ].join("\n");

    expect(
      collectTempCreationFindingsFromDiff(diff, {
        fileTextByPath: {
          [fixtureFile]: fixtureSource,
          [helperTestFile]: helperTestSource,
        },
      }),
    ).toEqual([]);
  });

  it("prints help with usage, outputs, and examples", () => {
    const output = execFileSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "report-test-temp-creations.mjs"), "--help"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );

    expect(output).toContain("Usage: node scripts/report-test-temp-creations.mjs");
    expect(output).toContain("Outputs:");
    expect(output).toContain("--no-merge-base");
    expect(output).toContain("Examples:");
  });

  it("formats GitHub warning annotations for CI report mode", () => {
    expect(
      formatGithubWarning({
        file: "test/helpers/temp,fixture.ts",
        line: 12,
        reason: "new mkdtemp temp directory creation",
        // openclaw-temp-dir: allow test fixture for GitHub warning formatting
        source: "const tempRoot = fs.mkdtempSync();",
      }),
    ).toBe(
      "::warning file=test/helpers/temp%2Cfixture.ts,line=12::new mkdtemp temp directory creation: prefer useAutoCleanupTempDirTracker(afterEach) from test/helpers/temp-dir.ts for new test-owned temp directories.",
    );
  });

  it("reads staged source for manual helper scans", () => {
    const root = tempDirs.make("openclaw-temp-report-staged-source-");
    const env = createNestedGitEnv();
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root, env });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "--allow-empty",
        "-q",
        "-m",
        "initial",
      ],
      { cwd: root, env },
    );

    fs.mkdirSync(path.join(root, "test", "scripts"), { recursive: true });
    const stagedManualFile = path.join(root, "test", "scripts", "staged-manual.test.ts");
    const stagedAutoFile = path.join(root, "test", "scripts", "staged-auto.test.ts");
    const manualSource = [
      'import { makeTempDir } from "../helpers/temp-dir.js";',
      "const tempDirs = new Set<string>();",
      'const workspace = makeTempDir(tempDirs, "case-");',
    ].join("\n");
    const autoSource = [
      'import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";',
      "const tempDirs = useAutoCleanupTempDirTracker(afterEach);",
      'const workspace = tempDirs.make("case-");',
    ].join("\n");
    fs.writeFileSync(stagedManualFile, `${manualSource}\n`, "utf8");
    fs.writeFileSync(stagedAutoFile, `${autoSource}\n`, "utf8");
    execFileSync("git", ["add", "test/scripts"], { cwd: root, env });
    fs.writeFileSync(stagedManualFile, `${autoSource}\n`, "utf8");
    fs.writeFileSync(stagedAutoFile, `${manualSource}\n`, "utf8");

    const result = spawnSync(
      process.execPath,
      [path.join(repoRoot, "scripts", "report-test-temp-creations.mjs"), "--staged", "--json"],
      {
        cwd: root,
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        file: "test/scripts/staged-manual.test.ts",
        line: 1,
        reason: "new manual temp-dir helper import",
        source: 'import { makeTempDir } from "../helpers/temp-dir.js";',
      },
      {
        file: "test/scripts/staged-manual.test.ts",
        line: 3,
        reason: "new manual temp-dir helper usage",
        source: 'const workspace = makeTempDir(tempDirs, "case-");',
      },
    ]);
  });

  it("exits non-zero for staged findings when requested", () => {
    const root = tempDirs.make("openclaw-temp-report-");
    const env = createNestedGitEnv();
    execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: root, env });
    fs.mkdirSync(path.join(root, "test", "helpers"), { recursive: true });
    fs.writeFileSync(path.join(root, "test", "helpers", "case.ts"), "const value = 1;\n", "utf8");
    execFileSync("git", ["add", "test/helpers/case.ts"], { cwd: root, env });
    execFileSync(
      "git",
      [
        "-c",
        "user.email=test@example.com",
        "-c",
        "user.name=Test User",
        "commit",
        "-q",
        "-m",
        "initial",
      ],
      { cwd: root, env },
    );

    const source = [
      "const tempRoot = fs.",
      "mkdtemp",
      'Sync(path.join(os.tmpdir(), "case-"));\n',
    ].join("");
    fs.appendFileSync(path.join(root, "test", "helpers", "case.ts"), source, "utf8");
    execFileSync("git", ["add", "test/helpers/case.ts"], { cwd: root, env });

    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "scripts", "report-test-temp-creations.mjs"),
        "--staged",
        "--fail-on-findings",
      ],
      {
        cwd: root,
        encoding: "utf8",
        env,
      },
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("test/helpers/case.ts");
  });

  it("falls back to a two-dot diff when refs have no merge base", () => {
    const root = tempDirs.make("openclaw-temp-report-no-merge-base-");
    const env = createNestedGitEnv();
    const git = (...args: string[]) =>
      execFileSync(
        "git",
        ["-c", "user.email=test@example.com", "-c", "user.name=Test User", ...args],
        { cwd: root, env },
      );
    git("init", "-q", "--initial-branch=main");
    git("commit", "--allow-empty", "-q", "-m", "base");
    git("checkout", "--orphan", "feature", "-q");
    fs.mkdirSync(path.join(root, "test", "scripts"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "test", "scripts", "feature.test.ts"),
      'const tempRoot = fs.mkdtempSync("case-");\n',
      "utf8",
    );
    git("add", "test/scripts/feature.test.ts");
    git("commit", "-q", "-m", "feature");

    const result = spawnSync(
      process.execPath,
      [
        path.join(repoRoot, "scripts", "report-test-temp-creations.mjs"),
        "--base",
        "main",
        "--head",
        "feature",
        "--json",
      ],
      { cwd: root, encoding: "utf8", env },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        file: "test/scripts/feature.test.ts",
        line: 1,
        reason: "new mkdtemp temp directory creation",
        source: 'const tempRoot = fs.mkdtempSync("case-");',
      },
    ]);
  });
});
