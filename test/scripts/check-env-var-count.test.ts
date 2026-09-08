import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectEnvVarNames,
  isCountedSourcePath,
  main,
} from "../../scripts/check-env-var-count.mts";
import { withEnv } from "../../src/test-utils/env.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function createRepo(files: Record<string, string> = {}) {
  const root = tempDirs.make("openclaw-env-count-");
  const git = (...args: string[]) =>
    execFileSync(
      "git",
      ["-c", "user.name=OpenClaw", "-c", "user.email=test@openclaw.local", ...args],
      { cwd: root, stdio: "ignore" },
    );
  const write = (file: string, source: string) => {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), source);
  };
  git("init");
  for (const [file, source] of Object.entries(files)) {
    write(file, source);
  }
  return { root, git, write };
}

describe("check-env-var-count", () => {
  it("counts production source and excludes tests and QA Lab", () => {
    expect(isCountedSourcePath("src/config/paths.ts")).toBe(true);
    expect(isCountedSourcePath("packages/api/src/index.ts")).toBe(true);
    expect(isCountedSourcePath("extensions/demo/src/index.ts")).toBe(true);
    expect(isCountedSourcePath("src/config/paths.test.ts")).toBe(false);
    expect(isCountedSourcePath("extensions/qa-lab/src/index.ts")).toBe(false);
  });

  it("keeps an empty index separate from untracked worktree sources", () => {
    const { root, write } = createRepo();
    expect(collectEnvVarNames(root, { staged: true })).toEqual([]);
    write("src/runtime.ts", "OPENCLAW_UNTRACKED");
    expect(collectEnvVarNames(root, { staged: true })).toEqual([]);
    expect(collectEnvVarNames(root)).toEqual(["OPENCLAW_UNTRACKED"]);
  });

  it("collects distinct names from the whole selected snapshot without crossing file boundaries", () => {
    const { root, git, write } = createRepo({
      ".gitignore": "src/ignored.ts\n",
      "src/partial.ts": "OPENCLAW_HEAD",
      "src/modified.ts": "OPENCLAW_OLD",
      "src/removed.ts": "OPENCLAW_REMOVED",
      "src/gone.ts": "OPENCLAW_GONE",
      "src/empty.ts": "",
      "src/boundary-a.ts": "OPENCLAW_",
      "src/boundary-b.ts": "BOUNDARY_TRAP",
      "src/unchanged.ts": "é 🦞 東京\nOPENCLAW_SHARED\0OPENCLAW_UNICODE",
      "packages/api/index.mts": "OPENCLAW_SHARED OPENCLAW_SHARED",
      "extensions/demo/index.cjs": "OPENCLAW_PLUGIN",
      "src/runtime.test.ts": "OPENCLAW_EXCLUDED",
      "src/__tests__/index.ts": "OPENCLAW_EXCLUDED",
      "packages/api/test/index.ts": "OPENCLAW_EXCLUDED",
      "extensions/demo/index.spec.ts": "OPENCLAW_EXCLUDED",
      "extensions/qa-lab/index.ts": "OPENCLAW_EXCLUDED",
      "extensions/test-support/index.ts": "OPENCLAW_EXCLUDED",
      "src/runtime.json": "OPENCLAW_EXCLUDED",
      "ui/src/runtime.ts": "OPENCLAW_EXCLUDED",
    });
    git("add", ".");
    git("commit", "-m", "base");
    write("src/partial.ts", "OPENCLAW_INDEX");
    write("src/modified.ts", "OPENCLAW_MODIFIED");
    write("src/added.ts", "OPENCLAW_ADDED");
    git("add", ".");
    write("src/partial.ts", "OPENCLAW_WORKTREE");
    write("src/added.ts", "OPENCLAW_UNSTAGED_ADDITION");
    git("rm", "--cached", "src/removed.ts");
    fs.rmSync(path.join(root, "src/gone.ts"));
    write("src/untracked.ts", "OPENCLAW_UNTRACKED");
    write("src/ignored.ts", "OPENCLAW_IGNORED");

    const shared = ["OPENCLAW_MODIFIED", "OPENCLAW_PLUGIN", "OPENCLAW_SHARED", "OPENCLAW_UNICODE"];
    expect(collectEnvVarNames(root, { staged: true })).toEqual(
      [...shared, "OPENCLAW_ADDED", "OPENCLAW_GONE", "OPENCLAW_INDEX"].toSorted(),
    );
    expect(collectEnvVarNames(root)).toEqual(
      [
        ...shared,
        "OPENCLAW_REMOVED",
        "OPENCLAW_UNSTAGED_ADDITION",
        "OPENCLAW_UNTRACKED",
        "OPENCLAW_WORKTREE",
      ].toSorted(),
    );
  });

  it("uses a constant number of Git processes as the staged source set grows", () => {
    const counts = [8, 16].map((fileCount) => {
      const names = Array.from({ length: fileCount }, (_, index) => `OPENCLAW_N${index}`);
      const { root, git } = createRepo(
        Object.fromEntries(names.map((name, index) => [`src/file-${index}.ts`, name])),
      );
      git("add", ".");
      const traceFile = path.join(root, "git-trace.jsonl");
      const collected = withEnv({ GIT_TRACE2_EVENT: traceFile }, () =>
        collectEnvVarNames(root, { staged: true }),
      );
      expect(collected).toEqual(names.toSorted());
      return fs
        .readFileSync(traceFile, "utf8")
        .trim()
        .split("\n")
        .filter((line) => JSON.parse(line).event === "start").length;
    });
    expect(Math.min(...counts)).toBeGreaterThan(0);
    expect(Math.max(...counts)).toBeLessThanOrEqual(2);
    expect(new Set(counts).size).toBe(1);
  });

  it.skipIf(process.platform === "win32")("preserves valid unusual staged filenames", () => {
    const { root, git } = createRepo({
      "src/space name.ts": "OPENCLAW_SPACE",
      "packages/api/tab\tname.ts": "OPENCLAW_TAB",
      "extensions/demo/newline\nname.ts": "OPENCLAW_NEWLINE",
      "src/conflict blob 0\n\nx blob 0\n\nx blob 0\n\n.ts": "OPENCLAW_HEADER",
    });
    git("add", ".");
    expect(collectEnvVarNames(root, { staged: true })).toEqual([
      "OPENCLAW_HEADER",
      "OPENCLAW_NEWLINE",
      "OPENCLAW_SPACE",
      "OPENCLAW_TAB",
    ]);
  });

  it.each([
    "src/conflict.ts",
    ...(process.platform === "win32" ? [] : ["src/conflict blob 0\n\nx blob 0\n\nx blob 0\n\n.ts"]),
  ])("rejects an unresolved stage-zero source: %s", (file) => {
    const { root } = createRepo({ [file]: "OPENCLAW_WORKTREE" });
    const oid = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: "OPENCLAW_CONFLICT",
      encoding: "utf8",
    }).trim();
    execFileSync("git", ["update-index", "-z", "--index-info"], {
      cwd: root,
      input: [1, 2, 3].map((stage) => `100644 ${oid} ${stage}\t${file}\0`).join(""),
    });
    expect(() => collectEnvVarNames(root, { staged: true })).toThrow();
  });

  it("fails closed when the base ref cannot be resolved", () => {
    const { root } = createRepo({ "config/env-var-count-budget.txt": "0\n" });
    expect(() => main(["--base", "missing"], root)).toThrow(/Could not resolve/u);
  });

  it("still checks the budget when the base shares no reachable ancestor", () => {
    // Shallow clones and grafted agent checkouts resolve the base but truncate its history.
    const { root, git, write } = createRepo({
      "config/env-var-count-budget.txt": "1\n",
      "src/runtime.ts": "process.env.OPENCLAW_ONLY;\n",
    });
    git("add", ".");
    git("commit", "-m", "detached base");
    // Name the base explicitly; init.defaultBranch varies by environment.
    git("branch", "-M", "severed-base");
    git("checkout", "--orphan", "severed");
    git("add", ".");
    git("commit", "-m", "severed history");
    expect(() => main(["--base", "severed-base"], root)).not.toThrow();

    write("src/runtime.ts", "process.env.OPENCLAW_ONE; process.env.OPENCLAW_TWO;\n");
    expect(() => main(["--base", "severed-base"], root)).toThrow(/exceeds budget/u);
  });

  it("compares against the fork budget when the base branch later shrinks", () => {
    const { root, git, write } = createRepo({
      "config/env-var-count-budget.txt": "2\n",
      "src/runtime.ts": "process.env.OPENCLAW_ONE; process.env.OPENCLAW_TWO;\n",
    });
    git("add", ".");
    git("commit", "-m", "base");
    git("branch", "release");
    write("config/env-var-count-budget.txt", "1\n");
    write("src/runtime.ts", "process.env.OPENCLAW_ONE;\n");
    git("add", ".");
    git("commit", "-m", "shrink main");
    git("branch", "moving-main");
    git("checkout", "release");
    expect(() => main(["--base", "moving-main"], root)).not.toThrow();
  });

  describe.each([false, true])("budget enforcement with staged=%s", (staged) => {
    it.each([
      { name: "exact count", base: 2, budget: 2, count: 2, error: undefined },
      { name: "count growth", base: 2, budget: 2, count: 3, error: /exceeds budget/u },
      { name: "stale headroom", base: 2, budget: 2, count: 1, error: /is below budget/u },
      {
        name: "retired 501 to 502 increase",
        base: 501,
        budget: 502,
        count: 502,
        error: /budget grew/u,
      },
      {
        name: "retired 502 to 503 increase",
        base: 502,
        budget: 503,
        count: 503,
        error: /budget grew/u,
      },
    ])("checks $name", ({ base, budget, count, error }) => {
      const { root, git, write } = createRepo({
        "config/env-var-count-budget.txt": `${base}\n`,
        "src/runtime.ts": Array.from({ length: base }, (_, index) => `OPENCLAW_BASE_${index}`).join(
          "\n",
        ),
      });
      git("add", ".");
      git("commit", "-m", "base");
      write("config/env-var-count-budget.txt", `${budget}\n`);
      write(
        "src/runtime.ts",
        Array.from({ length: count }, (_, index) => `OPENCLAW_NEXT_${index}`).join("\n"),
      );
      if (staged) {
        git("add", ".");
        write("config/env-var-count-budget.txt", "0\n");
        write("src/runtime.ts", "");
      }
      const run = () => main([...(staged ? ["--staged"] : []), "--base", "HEAD"], root);
      if (error) {
        expect(run).toThrow(error);
      } else {
        expect(run()).toBe(count);
      }
    });
  });
});
