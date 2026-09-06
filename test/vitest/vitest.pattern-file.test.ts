import { describe, expect, it } from "vitest";
import {
  collectVitestExcludePatterns,
  intersectIncludePatterns,
  matchesVitestCliSelection,
  narrowIncludePatternsForCli,
} from "./vitest.pattern-file.ts";

describe("native CLI selection", () => {
  const file = "extensions/qa-lab/src/suite-process-lifecycle.test.ts";
  it.each([
    { args: ["--configLoader", "runner"], selected: true },
    { args: ["--configLoader=", "runner"], selected: true },
    { args: ["--isolate=", "false"], selected: true },
    { args: ["--config-loader", "runner"], selected: true },
    { args: ["--isolate", "false"], selected: true },
    { args: ["--passWithNoTests", "true"], selected: true },
    { args: ["--no-isolate", "false"], selected: false },
    { args: ["-no-isolate", "true"], selected: false },
    { args: ["--", "unrelated.test.ts"], selected: true },
    { args: ["--", `--exclude=${file}`], selected: true },
    { args: [`${file}:12`], selected: true },
    { args: ["--testNamePattern", "unrelated.test.ts"], selected: true },
    { args: ["unrelated.test.ts", "run"], selected: false },
  ])("projects native operands without consuming controls: $args", ({ args, selected }) => {
    expect(matchesVitestCliSelection(file, [file], ["run", ...args], "", {})).toBe(selected);
  });

  it("does not narrow discovery from config-loader operands or separator tails", () => {
    const include = [file];
    for (const args of [
      ["--configLoader", "test/runner.test.ts"],
      ["--", "test/other.test.ts"],
    ]) {
      expect(narrowIncludePatternsForCli(include, ["node", "vitest", "run", ...args])).toBeNull();
    }
    expect(collectVitestExcludePatterns(["--exclude", "before", "--", "--exclude=after"])).toEqual([
      "before",
    ]);
  });
});

describe("intersectIncludePatterns", () => {
  it("projects arbitrary candidate globs onto a finite literal owner", () => {
    const owner = [
      "ui/src/e2e/chat.e2e.test.ts",
      "ui/src/e2e/chat.capture.e2e.test.ts",
      "ui/src/pages/workboard/workboard.e2e.test.ts",
    ];

    expect(intersectIncludePatterns(owner, ["ui/src/e2e/*.e2e.test.ts"])).toEqual([
      "ui/src/e2e/chat.e2e.test.ts",
      "ui/src/e2e/chat.capture.e2e.test.ts",
    ]);
    expect(
      intersectIncludePatterns(owner, [
        "ui/src/e2e/chat*.e2e.test.ts",
        "ui/src/e2e/chat.e2e.test.ts",
      ]),
    ).toEqual(["ui/src/e2e/chat.e2e.test.ts", "ui/src/e2e/chat.capture.e2e.test.ts"]);
  });

  it("retains the ambiguity guard for glob-owned inventories", () => {
    expect(() =>
      intersectIncludePatterns(["ui/src/**/*.e2e.test.ts"], ["ui/src/e2e/*.e2e.test.ts"]),
    ).toThrow("cannot safely intersect non-literal include path");
  });
});
