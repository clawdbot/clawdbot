import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectChangedFileLocs,
  countPhysicalLines,
  findLocRatchetViolations,
  isProductionTypeScriptFile,
  parseArgs,
  parseNameStatusZ,
} from "../../scripts/check-ts-max-loc.js";
import { cleanupTempDirs, makeTempRepoRoot } from "../helpers/temp-repo.js";

const tempDirs: string[] = [];

function nestedGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of [
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_QUARANTINE_PATH",
    "GIT_WORK_TREE",
  ]) {
    delete env[key];
  }
  return env;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: nestedGitEnv() }).trim();
}

function writeLines(cwd: string, filePath: string, lines: number): void {
  const absolutePath = path.join(cwd, filePath);
  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(
    absolutePath,
    Array.from({ length: lines }, (_, index) => `// line ${index + 1}`).join("\n") + "\n",
    "utf8",
  );
}

function createRepo(files: Record<string, number>): string {
  const cwd = makeTempRepoRoot(tempDirs, "openclaw-loc-ratchet-");
  git(cwd, ["init", "-q", "--initial-branch=main"]);
  for (const [filePath, lines] of Object.entries(files)) {
    writeLines(cwd, filePath, lines);
  }
  git(cwd, ["add", "."]);
  git(cwd, [
    "-c",
    "user.email=test@example.com",
    "-c",
    "user.name=Test User",
    "commit",
    "-q",
    "-m",
    "initial",
  ]);
  return cwd;
}

afterEach(() => cleanupTempDirs(tempDirs));

describe("scripts/check-ts-max-loc", () => {
  it("parses comparison modes and rejects ambiguous staged refs", () => {
    expect(parseArgs(["--base", "main", "--head", "feature", "--", "src/a.ts"])).toEqual({
      base: "main",
      head: "feature",
      maxLines: 500,
      paths: ["src/a.ts"],
      staged: false,
    });
    expect(parseArgs(["--staged", "--max", "700"])).toMatchObject({
      maxLines: 700,
      staged: true,
    });
    expect(() => parseArgs(["--staged", "--base", "HEAD"])).toThrow("--staged cannot be combined");
    expect(() => parseArgs(["--max", "0"])).toThrow("--max requires a positive integer");
  });

  it("counts physical lines and excludes test and generated locale files", () => {
    expect(countPhysicalLines("")).toBe(0);
    expect(countPhysicalLines("one\n")).toBe(1);
    expect(countPhysicalLines("one\ntwo")).toBe(2);
    expect(isProductionTypeScriptFile("src/runtime.ts")).toBe(true);
    expect(isProductionTypeScriptFile("src/runtime.test.ts")).toBe(false);
    expect(isProductionTypeScriptFile("test/helpers/runtime.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/test-utils/command-runner.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/gateway/test-helpers.e2e.ts")).toBe(false);
    expect(isProductionTypeScriptFile("test-fixtures/runtime.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/plugins/runtime.test-fixtures.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/agents/model.e2e-harness.ts")).toBe(false);
    expect(isProductionTypeScriptFile("extensions/qa-lab/src/auth-profile.fixture.ts")).toBe(false);
    expect(isProductionTypeScriptFile("extensions/browser/src/session.mock.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/commands/agent-command.test-mocks.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/commands/channels.mock-harness.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/commands/doctor.fast-path-mocks.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/cli/test-runtime-mock.ts")).toBe(false);
    expect(isProductionTypeScriptFile("test-harness/runtime.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/acme-test-support/runner.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/test-helper-runtime.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/state/openclaw-state-schema.generated.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/state/openclaw-state-db.generated.d.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/generated/runtime.ts")).toBe(false);
    expect(isProductionTypeScriptFile("src/regenerated-runtime.ts")).toBe(true);
    expect(isProductionTypeScriptFile("extensions/voice-call/src/providers/mock.ts")).toBe(true);
    expect(isProductionTypeScriptFile("scripts/control-ui-mock-dev.ts")).toBe(true);
    expect(isProductionTypeScriptFile("src/fixture-loader.ts")).toBe(true);
    expect(isProductionTypeScriptFile("src/test-supportability.ts")).toBe(true);
    expect(isProductionTypeScriptFile("ui/src/i18n/locales/en.ts")).toBe(false);
  });

  it("parses NUL-delimited renames and copies without path ambiguity", () => {
    expect(
      parseNameStatusZ("M\0src/a.ts\0R100\0src/old.ts\0src/new.ts\0C100\0src/a.ts\0src/copy.ts\0"),
    ).toEqual([
      { path: "src/a.ts", status: "M" },
      { path: "src/new.ts", previousPath: "src/old.ts", status: "R" },
      { path: "src/copy.ts", previousPath: "src/a.ts", status: "C" },
    ]);
  });

  it("rejects new oversized files and path-scopes the worktree check", async () => {
    const cwd = createRepo({ "src/existing.ts": 10 });
    writeLines(cwd, "src/too-large.ts", 501);
    writeLines(cwd, "src/ignored.ts", 600);

    const results = await collectChangedFileLocs({
      base: "HEAD",
      cwd,
      paths: ["src/too-large.ts"],
    });

    expect(results).toEqual([{ path: "src/too-large.ts", status: "A", lines: 501 }]);
    expect(findLocRatchetViolations(results)).toEqual([
      { path: "src/too-large.ts", status: "A", lines: 501, reason: "new-file" },
    ]);
  });

  it("allows legacy files to hold or shrink but rejects growth and limit crossings", async () => {
    const cwd = createRepo({ "src/legacy.ts": 600, "src/small.ts": 500 });
    writeLines(cwd, "src/legacy.ts", 601);
    writeLines(cwd, "src/small.ts", 501);

    const results = await collectChangedFileLocs({ base: "HEAD", cwd });
    expect(findLocRatchetViolations(results)).toEqual([
      {
        baseLines: 600,
        lines: 601,
        path: "src/legacy.ts",
        reason: "grew",
        status: "M",
      },
      {
        baseLines: 500,
        lines: 501,
        path: "src/small.ts",
        reason: "crossed-limit",
        status: "M",
      },
    ]);

    writeLines(cwd, "src/legacy.ts", 599);
    writeLines(cwd, "src/small.ts", 500);
    expect(findLocRatchetViolations(await collectChangedFileLocs({ base: "HEAD", cwd }))).toEqual(
      [],
    );
  });

  it("inherits production rename size but treats an untracked copy as new", async () => {
    const cwd = createRepo({ "src/legacy.ts": 600 });
    git(cwd, ["mv", "src/legacy.ts", "src/renamed.ts"]);
    copyFileSync(path.join(cwd, "src/renamed.ts"), path.join(cwd, "src/copied.ts"));

    const results = await collectChangedFileLocs({ base: "HEAD", cwd });
    expect(results).toEqual([
      { lines: 600, path: "src/copied.ts", status: "A" },
      {
        baseLines: 600,
        lines: 600,
        path: "src/renamed.ts",
        previousPath: "src/legacy.ts",
        status: "R",
      },
    ]);
    expect(findLocRatchetViolations(results)).toEqual([
      { lines: 600, path: "src/copied.ts", reason: "new-file", status: "A" },
    ]);
  });

  it("checks recreated untracked content after a staged deletion", async () => {
    const cwd = createRepo({ "src/recreated.ts": 10 });
    git(cwd, ["rm", "src/recreated.ts"]);
    writeLines(cwd, "src/recreated.ts", 501);

    const results = await collectChangedFileLocs({ base: "HEAD", cwd });
    expect(results).toEqual([{ baseLines: 10, lines: 501, path: "src/recreated.ts", status: "M" }]);
    expect(findLocRatchetViolations(results)).toEqual([
      {
        baseLines: 10,
        lines: 501,
        path: "src/recreated.ts",
        reason: "crossed-limit",
        status: "M",
      },
    ]);
  });

  it("reads staged content instead of later unstaged edits", async () => {
    const cwd = createRepo({ "src/existing.ts": 10 });
    writeLines(cwd, "src/staged.ts", 501);
    git(cwd, ["add", "src/staged.ts"]);
    writeLines(cwd, "src/staged.ts", 1);

    const results = await collectChangedFileLocs({ cwd, staged: true });
    expect(findLocRatchetViolations(results)).toEqual([
      { lines: 501, path: "src/staged.ts", reason: "new-file", status: "A" },
    ]);
  });

  it("reads an explicit head tree and ignores deleted production files", async () => {
    const cwd = createRepo({ "src/deleted.ts": 10 });
    const base = git(cwd, ["rev-parse", "HEAD"]);
    writeLines(cwd, "src/new.ts", 501);
    git(cwd, ["add", "."]);
    git(cwd, ["rm", "src/deleted.ts"]);
    git(cwd, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "change",
    ]);
    writeLines(cwd, "src/new.ts", 1);

    const results = await collectChangedFileLocs({ base, cwd, head: "HEAD" });
    expect(results).toEqual([{ path: "src/new.ts", status: "A", lines: 501 }]);
  });

  it("uses the exact requested base for divergent explicit head comparisons", async () => {
    const cwd = createRepo({ "src/legacy.ts": 600 });
    git(cwd, ["branch", "feature"]);
    writeLines(cwd, "src/legacy.ts", 400);
    git(cwd, ["add", "src/legacy.ts"]);
    git(cwd, [
      "-c",
      "user.email=test@example.com",
      "-c",
      "user.name=Test User",
      "commit",
      "-q",
      "-m",
      "shrink on base",
    ]);

    const results = await collectChangedFileLocs({ base: "main", cwd, head: "feature" });
    expect(results).toEqual([{ baseLines: 400, lines: 600, path: "src/legacy.ts", status: "M" }]);
    expect(findLocRatchetViolations(results)).toEqual([
      {
        baseLines: 400,
        lines: 600,
        path: "src/legacy.ts",
        reason: "crossed-limit",
        status: "M",
      },
    ]);
  });
});
