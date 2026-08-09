import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectCurrentSuppressions,
  diffBaseline,
  findBaselineExpansion,
  hasAllRuleDisable,
  hasMaxLinesDisable,
  isGovernedSourcePath,
  main,
  parseBaseline,
} from "../../scripts/check-max-lines-ratchet.mjs";

const tempDirs: string[] = [];
const nestedGitEnvKeys = [
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_COMMON_DIR",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_DIR",
  "GIT_GRAFT_FILE",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_NAMESPACE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_OBJECT_DIRECTORY",
  "GIT_PREFIX",
  "GIT_QUARANTINE_PATH",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_WORK_TREE",
] as const;

function git(cwd: string, args: string[]): void {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
  };
  for (const key of nestedGitEnvKeys) {
    delete env[key];
  }
  execFileSync("git", args, { cwd, env, stdio: "ignore" });
}

afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true });
  }
});

describe("check-max-lines-ratchet", () => {
  it("recognizes suppressions without matching reason prose", () => {
    expect(hasMaxLinesDisable("/* oxlint-disable max-lines -- TODO: split. */\n")).toBe(true);
    expect(hasMaxLinesDisable("// eslint-disable-next-line no-console, max-lines\n")).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable */\n")).toBe(false);
    expect(hasMaxLinesDisable("// oxlint-disable-line -- all rules\n")).toBe(false);
    expect(hasMaxLinesDisable("/* oxlint-disable max-lines - TODO: split. */\n")).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable max-lines--temporary */\n")).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable - all rules */\n")).toBe(false);
    expect(hasMaxLinesDisable("/* oxlint-disable eslint/max-lines */\n")).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable\nmax-lines\n-- TODO: split. */\n")).toBe(true);
    expect(
      hasMaxLinesDisable(
        "export const value = 1;\n/* oxlint-disable max-lines -- TODO: split. */\n",
      ),
    ).toBe(true);
    expect(
      hasMaxLinesDisable("if (true) {\n  const value = 1;\n  /* oxlint-disable max-lines */\n}\n"),
    ).toBe(true);
    expect(hasMaxLinesDisable("/* oxlint-disable no-console -- mentions max-lines */\n")).toBe(
      false,
    );
    expect(hasMaxLinesDisable("// Example: oxlint-disable max-lines\n")).toBe(false);
    expect(hasMaxLinesDisable('const example = "/* oxlint-disable max-lines */";\n')).toBe(false);
    expect(hasAllRuleDisable("/* oxlint-disable */\n")).toBe(true);
    expect(hasAllRuleDisable("// oxlint-disable-line -- all rules\n")).toBe(true);
    expect(hasAllRuleDisable("/* oxlint-disable max-lines */\n")).toBe(false);
  });

  it("limits source roots and excludes generated output", () => {
    expect(isGovernedSourcePath("src/runtime.ts")).toBe(true);
    expect(isGovernedSourcePath("extensions/demo/index.mjs")).toBe(true);
    expect(isGovernedSourcePath("scripts/tool.mjs")).toBe(false);
    expect(isGovernedSourcePath("packages/api/protocol-gen/types.ts")).toBe(false);
    expect(isGovernedSourcePath("ui/src/i18n/locales/en.ts")).toBe(false);
    expect(isGovernedSourcePath("src/wizard/i18n/locales/en.ts")).toBe(false);
    expect(isGovernedSourcePath("src/schema.generated.ts")).toBe(false);
  });

  it("reports new suppressions, stale debt, and baseline growth", () => {
    const baseline = parseBaseline("# debt\nsrc/a.ts\nsrc/b.ts\n");
    expect(diffBaseline(["src/b.ts", "src/c.ts"], baseline)).toEqual({
      added: ["src/c.ts"],
      stale: ["src/a.ts"],
    });
    expect(findBaselineExpansion(baseline, new Set(["src/a.ts"]))).toEqual(["src/b.ts"]);
  });

  it("rejects baseline growth even when the new suppression is listed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(
      path.join(root, "src/a.ts"),
      "/* oxlint-disable max-lines -- TODO: split. */\n",
    );
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      git(root, args);
    }

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\nsrc/b.ts\n");
    fs.writeFileSync(
      path.join(root, "src/b.ts"),
      "/* oxlint-disable max-lines -- TODO: split. */\n",
    );
    git(root, ["add", "."]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(1);
  });

  it("rejects replacing an explicit max-lines suppression with an all-rule disable", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-all-rule-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable max-lines */\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      git(root, args);
    }

    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable */\n");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(1);
  });

  it("rejects a new all-rule disable without baseline growth", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-all-rule-new-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      git(root, args);
    }

    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable */\n");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(1);
  });

  it("transfers grandfathered debt across a verified rename", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-rename-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(
      path.join(root, "src/a.ts"),
      "export const a = 1;\n/* oxlint-disable max-lines -- TODO: split. */\n",
    );
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      git(root, args);
    }
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    git(root, ["mv", "src/a.ts", "src/b.ts"]);
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/b.ts\n");

    expect(main(root)).toBe(0);
  });

  it("defaults worktree comparisons to origin/main", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-default-base-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable max-lines */\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      git(root, args);
    }
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\nsrc/b.ts\n");
    fs.writeFileSync(path.join(root, "src/b.ts"), "/* oxlint-disable max-lines */\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "grow baseline"]);
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root)).toBe(1);
  });

  it("compares divergent worktrees against their main merge base", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-diverged-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\nsrc/b.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable max-lines */\n");
    fs.writeFileSync(path.join(root, "src/b.ts"), "/* oxlint-disable max-lines */\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
      ["branch", "release"],
    ]) {
      git(root, args);
    }

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/b.ts"), "export const b = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "shrink main debt"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, ["checkout", "release"]);

    expect(main(root)).toBe(0);
  });

  it("falls back to main when no merge base is available", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-disconnected-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable max-lines */\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "release"],
      ["branch", "-m", "release"],
    ]) {
      git(root, args);
    }
    git(root, ["checkout", "--orphan", "main"]);
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "disconnected main"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, ["checkout", "release"]);

    expect(main(root)).toBe(1);
  });

  it("checks staged content instead of unstaged worktree edits", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-staged-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      git(root, args);
    }

    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "src/a.ts\n");
    fs.writeFileSync(path.join(root, "src/a.ts"), "/* oxlint-disable */\n");
    git(root, ["add", "."]);
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = 1;\n");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root, ["--staged", "--base", "HEAD"])).toBe(1);
  });

  it.skipIf(process.platform === "win32")("keeps staged filenames NUL-framed", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-nul-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    git(root, ["init"]);
    const filePath = "src/newline\nname.ts";
    fs.writeFileSync(path.join(root, filePath), "/* oxlint-disable max-lines */\n");
    git(root, ["add", "."]);

    expect(collectCurrentSuppressions(root, { staged: true })).toEqual([filePath]);
  });

  it("checks untracked sources and tolerates unstaged deletions", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-max-lines-worktree-"));
    tempDirs.push(root);
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "config/max-lines-baseline.txt"), "");
    fs.writeFileSync(path.join(root, "src/deleted.ts"), "export const deleted = true;\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      git(root, args);
    }
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    fs.rmSync(path.join(root, "src/deleted.ts"));
    expect(main(root)).toBe(0);

    fs.writeFileSync(path.join(root, "src/untracked.ts"), "/* oxlint-disable max-lines */\n");
    vi.spyOn(console, "error").mockImplementation(() => {});

    expect(main(root)).toBe(1);
  });
});
