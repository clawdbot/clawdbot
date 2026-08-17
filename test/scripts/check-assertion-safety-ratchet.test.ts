import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  countUnsafeAssertions,
  isGovernedAssertionSourcePath,
  main,
  parseAssertionSafetyBaseline,
} from "../../scripts/check-assertion-safety-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
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

function git(cwd: string, args: string[]) {
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
});

describe("check-assertion-safety-ratchet", () => {
  it("counts only governed assertions without a SAFETY invariant", () => {
    const source = [
      "const frozen = value as const;",
      "const checked = value satisfies Shape;",
      "// SAFETY: the schema parser established Shape.",
      "const safe = value as Shape;",
      "const inlineSafe = value as Shape; // SAFETY: the schema parser established Shape.",
      "const afterInline = value as Shape;",
      "const present = value!;",
      'const note = "// SAFETY: string content is not a comment.";',
      "const unsafe = value as Shape;",
      "const angle = <Shape>value;",
      "const unknown = value as unknown;",
      "const angleUnknown = <unknown>value;",
    ].join("\n");

    expect(countUnsafeAssertions(source, "src/example.ts")).toBe(3);
    expect(
      countUnsafeAssertions("value as unknown as Shape;", "src/agents/agent-model-discovery.ts"),
    ).toBe(1);
    expect(countUnsafeAssertions("value as unknown as Shape;", "src/example.ts")).toBe(1);
    expect(
      countUnsafeAssertions("declare const value: unknown as Shape;", "src/example.d.ts"),
    ).toBe(0);
    expect(isGovernedAssertionSourcePath("src/example.ts")).toBe(true);
    expect(isGovernedAssertionSourcePath("extensions/example/src/index.tsx")).toBe(true);
    expect(isGovernedAssertionSourcePath("src/example.test.ts")).toBe(false);
    expect(isGovernedAssertionSourcePath("packages/example/test-utils/value.ts")).toBe(false);
    expect(isGovernedAssertionSourcePath("scripts/example.ts")).toBe(false);
  });

  it("blocks new debt, accepts SAFETY comments, and prunes reduced counts", () => {
    const root = tempDirs.make("openclaw-assertion-safety-");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const baselinePath = path.join(root, "config/assertion-safety-baseline.txt");
    const sourcePath = path.join(root, "src/example.ts");
    fs.writeFileSync(baselinePath, "src/example.ts\t1\n");
    fs.writeFileSync(sourcePath, "export const first = value as string;\n");
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base"],
    ]) {
      git(root, args);
    }

    fs.appendFileSync(sourcePath, "export const second = value as number;\n");
    const errors: string[] = [];
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(1);
    expect(errors.join("\n")).toContain("src/example.ts: 2 > 1");
    expect(errors.join("\n")).toContain("// SAFETY:");

    fs.writeFileSync(
      sourcePath,
      [
        "export const first = value as string;",
        "// SAFETY: the parser guarantees this value is numeric.",
        "export const second = value as number;",
        "",
      ].join("\n"),
    );
    expect(main(root, ["--base", "HEAD"])).toBe(0);

    fs.writeFileSync(
      sourcePath,
      [
        "// SAFETY: the parser guarantees this value is text.",
        "export const first = value as string;",
        "// SAFETY: the parser guarantees this value is numeric.",
        "export const second = value as number;",
        "",
      ].join("\n"),
    );
    expect(main(root, ["--base", "HEAD"])).toBe(1);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(0);
    expect(parseAssertionSafetyBaseline(fs.readFileSync(baselinePath, "utf8"))).toEqual(new Map());
  });

  it("allows rebaselining assertion debt already present in the base tree", () => {
    const root = tempDirs.make("openclaw-assertion-safety-base-drift-");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    const baselinePath = path.join(root, "config/assertion-safety-baseline.txt");
    const sourcePath = path.join(root, "src/example.ts");
    fs.writeFileSync(baselinePath, "src/example.ts\t1\n");
    fs.writeFileSync(
      sourcePath,
      [
        "export const first = value as string;",
        "export const mergedConcurrently = value as number;",
        "",
      ].join("\n"),
    );
    for (const args of [
      ["init"],
      ["config", "user.email", "test@example.com"],
      ["config", "user.name", "Test"],
      ["add", "."],
      ["commit", "-m", "base with stale assertion baseline"],
    ]) {
      git(root, args);
    }

    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});

    expect(main(root, ["--base", "HEAD"])).toBe(0);
    expect(main(root, ["--base", "HEAD", "--prune"])).toBe(0);
    expect(parseAssertionSafetyBaseline(fs.readFileSync(baselinePath, "utf8"))).toEqual(
      new Map([["src/example.ts", 2]]),
    );
  });

  it("compares an explicit moving base at the branch fork", () => {
    const root = tempDirs.make("openclaw-assertion-safety-diverged-");
    fs.mkdirSync(path.join(root, "config"), { recursive: true });
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "config/assertion-safety-baseline.txt"),
      "src/a.ts\t1\nsrc/b.ts\t1\n",
    );
    fs.writeFileSync(path.join(root, "src/a.ts"), "export const a = value as string;\n");
    fs.writeFileSync(path.join(root, "src/b.ts"), "export const b = value as string;\n");
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

    fs.writeFileSync(path.join(root, "config/assertion-safety-baseline.txt"), "src/a.ts\t1\n");
    fs.rmSync(path.join(root, "src/b.ts"));
    git(root, ["add", "."]);
    git(root, ["commit", "-m", "shrink main debt"]);
    git(root, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
    git(root, ["checkout", "release"]);

    expect(main(root, ["--base", "origin/main"])).toBe(0);
  });
});
