import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createVitestReportFixture, type ReportFixtureMode } from "./vitest-report-fixture.js";

const json = (file: string) => JSON.parse(fs.readFileSync(file, "utf8"));
const inventory = (report: {
  testResults: { assertionResults: { fullName: string; status: string }[] }[];
}) =>
  report.testResults
    .flatMap((file) => file.assertionResults.map((test) => [test.fullName.trim(), test.status]))
    .sort();
const expected = [
  ["alpha/one", "passed"],
  ["alpha/two", "passed"],
  ["beta/one", "passed"],
  ["beta/skip", "skipped"],
  ["beta/todo", "todo"],
];

describe.skipIf(process.platform === "win32")("native multi-invocation report ownership", () => {
  const dirs = useAutoCleanupTempDirTracker(afterEach);
  const run = (mode: ReportFixtureMode) => createVitestReportFixture(dirs.make("oc-report-"))(mode);

  it.each([
    "serial",
    "parallel",
    "batch",
    "batch-parallel",
    "retry",
    "watchdog",
    "dotted",
    "metadata",
    "ignored-unhandled",
  ] as const)(
    "retains the exact case union and native originals: %s",
    { timeout: 60000 },
    async (mode) => {
      const result = await run(mode);
      expect(result.code, result.stderr).toBe(0);
      expect(inventory(json(result.output))).toEqual(expected);
      const index = json(path.join(result.reportSet!, "index.json"));
      expect(index.complete).toBe(true);
      const parts = index.entries.map((entry: { attempts: { json: string; blob: string }[] }) =>
        entry.attempts.at(-1)!,
      );
      expect(parts).toHaveLength(2);
      for (const part of parts) {
        expect(fs.existsSync(part.blob)).toBe(true);
        expect(json(`${part.json}.capture.json`).ended).toBeTruthy();
      }
      if (mode === "watchdog") {
        expect(index.entries[0].attempts).toHaveLength(2);
        expect(index.entries[0].attempts[0].outcome.noOutputTimedOut).toBe(true);
      }
      if (mode === "metadata") {
        expect(parts.map((part: { json: string }) => json(part.json).snapshot.matched)).toEqual([
          1, 1,
        ]);
        expect(json(result.output).snapshot.matched).toBe(0);
        expect(json(result.output).coverageMap).toBeUndefined();
        for (const part of parts) {
          expect(Object.keys(json(part.json).coverageMap)).toHaveLength(1);
          expect(
            fs.existsSync(path.join(path.dirname(part.json), "coverage/coverage-final.json")),
          ).toBe(true);
        }
      }
    },
  );

  it.each(["failure", "batch-failure", "unhandled"] as const)(
    "publishes complete evidence without erasing native failure: %s",
    { timeout: 60000 },
    async (mode) => {
      const result = await run(mode);
      expect(result.code, result.stderr).toBe(1);
      const cases = expected.map((entry) => [...entry]);
      if (mode === "failure" || mode === "batch-failure") cases[2]![1] = "failed";
      expect(inventory(json(result.output))).toEqual(cases);
      const index = json(path.join(result.reportSet!, "index.json"));
      expect(index.complete).toBe(true);
      expect(index.entries[1].attempts[0].outcome.code).toBe(1);
      if (mode === "unhandled") {
        const part = index.entries[1].attempts[0].json;
        expect(json(part).success).toBe(true);
        expect(json(`${part}.capture.json`).ended.unhandledErrors).toBe(1);
        expect(result.stderr).toContain("owned unhandled rejection");
      }
    },
  );

  it.each([
    "missing",
    "coverage-missing",
    "teardown-timeout",
    "corrupt",
    "merge-failure",
    "child-write",
    "final-write",
    "publish-write",
    "identity",
    "tuple",
    "fail-fast",
    "cancel",
    "batch-fail-fast",
    "batch-cancel",
  ] as const)(
    "never publishes incomplete or failed evidence: %s",
    { timeout: 60000 },
    async (mode) => {
      const result = await run(mode);
      expect(result.code !== 0 || result.signal !== null, result.stderr).toBe(true);
      const index = json(path.join(result.reportSet!, "index.json"));
      const first = index.entries[0].attempts[0];
      const staged = path.join(result.reportSet!, "aggregate.json");
      if (mode === "cancel" || mode === "batch-cancel") {
        expect(result.signal).toBe("SIGTERM");
        expect(first.outcome.signal).toBe("SIGTERM");
        const events = fs
          .readFileSync(path.join(path.dirname(result.output), "executed.jsonl"), "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(events.map((event) => event.name)).toEqual(["alpha/one"]);
        const capture = json(`${first.json}.capture.json`);
        expect(fs.readFileSync(path.join(capture.root, "ready"), "utf8")).toBe(
          String(events[0].pid),
        );
        expect(() => process.kill(events[0].pid, 0)).toThrow(
          expect.objectContaining({ code: "ESRCH" }),
        );
      } else if (mode === "fail-fast" || mode === "batch-fail-fast") {
        const report = json(first.json);
        expect(inventory(report)).toEqual([
          ["alpha/one", "failed"],
          ["alpha/two", "passed"],
        ]);
        expect(report.testResults[0].assertionResults[0].failureMessages.join("\n")).toContain(
          "expected 1 to be 2",
        );
        expect(first.outcome.code).toBe(1);
        expect(json(`${first.json}.capture.json`).ended.reason).toBe("failed");
      } else if (mode === "tuple") {
        expect(result.stderr).toContain("cannot preserve config-owned reporter options");
      } else {
        const capture = json(`${first.json}.capture.json`);
        expect(capture.ended.reason).toBe("passed");
        if (mode === "child-write") {
          expect(fs.statSync(first.json).isDirectory()).toBe(true);
          expect(first.outcome.code).toBe(1);
          expect(result.stderr).toContain("EISDIR");
        } else {
          const original = mode === "missing" ? `${first.json}.native-original` : first.json;
          expect(inventory(json(original))).toEqual(expected.slice(0, 2));
          expect(first.outcome.code).toBe(0);
        }
        if (mode === "missing") {
          expect(fs.existsSync(first.json)).toBe(false);
          expect(index.error).toContain("missing Vitest JSON report");
        } else if (mode === "coverage-missing") {
          const lcov = path.join(capture.coverageDirectory, "lcov.info");
          expect(fs.readFileSync(`${lcov}.native-original`, "utf8")).toContain("covered.ts");
          expect(fs.existsSync(lcov)).toBe(false);
          expect(index.error).toContain(lcov);
        } else if (mode === "teardown-timeout") {
          expect(capture.processTimedOut).toBe(true);
          expect(index.error).toContain("completion evidence missing or interrupted");
        } else if (mode !== "child-write") {
          const second = index.entries[1].attempts[0];
          expect(inventory(json(second.json))).toEqual(expected.slice(2));
          expect(second.outcome.code).toBe(0);
          expect(index.merge.code).toBe(mode === "publish-write" ? 0 : 1);
          if (mode === "corrupt") {
            expect(fs.readFileSync(first.blob, "utf8")).toBe("owned corruption");
            expect(() => json(`${first.blob}.native-original`)).not.toThrow();
            expect(result.stderr).toContain('"owned corruption" is not valid JSON');
          } else if (mode === "merge-failure") {
            expect(result.stderr).toContain("owned native merge failure");
          } else if (mode === "identity") {
            expect(result.stderr).toContain("Native merge project identity changed");
          } else if (mode === "final-write") {
            expect(fs.statSync(staged).isDirectory()).toBe(true);
            expect(index.error).toContain("EISDIR");
          } else if (mode === "publish-write") {
            expect(inventory(json(staged))).toEqual(expected);
            expect(fs.readFileSync(path.join(result.output, "old"), "utf8")).toBe("old");
            expect(fs.readFileSync(path.join(index.publication, "report.json"))).toEqual(
              fs.readFileSync(staged),
            );
            expect(index.error).toMatch(/rename/);
          }
        }
      }
      expect(index.complete).toBe(false);
      expect(index.error).not.toBe("");
      expect(index.aggregate).toBe("");
      if (!["corrupt", "merge-failure", "identity", "final-write", "publish-write"].includes(mode))
        expect(index.merge).toBeNull();
      if (["missing", "corrupt", "merge-failure", "final-write", "identity"].includes(mode))
        expect(fs.readFileSync(result.output, "utf8")).toBe("old report");
      if (["fail-fast", "cancel", "batch-fail-fast", "batch-cancel"].includes(mode))
        expect(index.entries[1].attempts).toHaveLength(0);
    },
  );

  it(
    "retains independent failures when a reachable selection overlaps native task IDs",
    { timeout: 60000 },
    async () => {
      const result = await run("overlap");
      expect(result.code, result.stderr).toBe(1);
      const index = json(path.join(result.reportSet!, "index.json"));
      expect(index.complete).toBe(false);
      expect(index.error).toContain("overlapping task identities");
      expect(fs.existsSync(result.output)).toBe(false);
      const failures = index.entries.map(
        (entry: { attempts: { json: string }[] }) =>
          json(entry.attempts[0]!.json).testResults[0].assertionResults[0].failureMessages[0],
      );
      expect(failures).toHaveLength(2);
      expect(new Set(failures).size).toBe(2);
    },
  );

  it.each([
    ["help", ["--help"], "help"],
    ["short help", ["-h"], "help"],
    ["native dash prefix", ["---help"], "help"],
    ["false help", ["--help=false"], "tests"],
    ["separate false help", ["--help", "false"], "tests"],
    ["negated help", ["--no-help"], "tests"],
    ["negated alias", ["--no-h"], "tests"],
    ["help then negation", ["--help", "--no-help"], "tests"],
    ["false alias precedence", ["--help=false", "-h"], "tests"],
    ["long alias precedence", ["--help=false", "--h"], "tests"],
    ["repeated false", ["--help=false", "--help=false"], "help"],
    ["short group", ["-vh"], "help"],
    ["unknown under help", ["--not-an-option", "--help"], "help"],
    ["missing under help", ["--pool", "--help"], "help"],
    ["unknown without help", ["--not-an-option", "--help=false"], "error"],
    ["missing without help", ["--pool", "--no-help"], "error"],
    ["named run version", ["--version"], "tests"],
    ["negated version", ["--no-version"], "tests"],
    ["wrapper consumes separators", ["--", "--help"], "help"],
    ["list tags", ["--listTags"], "native-error"],
    ["clear cache", ["--clearCache"], "idle"],
    ["standalone", ["--standalone"], "native-error"],
  ] as const)(
    "leaves native control execution with the project child: %s",
    { timeout: 60000 },
    async (_, nativeArgs, kind) => {
      const result = await createVitestReportFixture(dirs.make("oc-report-control-"))("serial", {
        entry: "projects",
        nativeArgs: [...nativeArgs],
      });
      expect(result.code, result.stderr).toBe(kind === "error" || kind === "native-error" ? 1 : 0);
      expect(result.stderr).not.toContain("report publication failed");
      expect(result.stdout.match(/Usage:/gu) ?? []).toHaveLength(kind === "help" ? 2 : 0);
      if (kind === "tests") {
        expect(inventory(json(result.output))).toEqual(expected);
        expect(json(path.join(result.reportSet!, "index.json")).complete).toBe(true);
      } else {
        expect(result.reportSet).toBeUndefined();
        expect(fs.existsSync(result.output)).toBe(false);
        if (kind === "error") expect(result.stderr).toMatch(/Unknown option|value is missing/u);
        if (kind === "native-error")
          expect(result.stderr).toMatch(/No test tags found|standalone mode requires --watch/u);
      }
    },
  );

  it.each([
    ["batch", undefined, ["--help"], 2, false],
    ["batch", undefined, ["--help=false"], 0, true],
    ["batch", undefined, ["--", "--help"], 0, true],
    ["batch", "batch-cli", ["--help"], 0, false],
    ["batch", "batch-cli", ["--", "--help"], 0, false],
    ["single", "projects", ["--help"], 1, false],
  ] as const)(
    "preserves sibling and single-process metadata ownership: %s %s %j",
    { timeout: 60000 },
    async (mode, entry, nativeArgs, helpBlocks, tests) => {
      const result = await createVitestReportFixture(dirs.make("oc-report-control-"))(mode, {
        entry,
        nativeArgs: [...nativeArgs],
      });
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout.match(/Usage:/gu) ?? []).toHaveLength(helpBlocks);
      expect(result.stderr).not.toContain("report publication failed");
      if (tests) expect(inventory(json(result.output))).toEqual(expected);
      else expect(result.reportSet).toBeUndefined();
      if (entry === "batch-cli")
        expect(result.stderr.match(/Usage: pnpm test:extensions:batch/gu)).toHaveLength(1);
    },
  );

  it("keeps non-report metadata native", { timeout: 60000 }, async () => {
    const result = await createVitestReportFixture(dirs.make("oc-report-control-"))("serial", {
      entry: "projects",
      nativeArgs: ["--help"],
      report: false,
    });
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.match(/Usage:/gu)).toHaveLength(2);
    expect(result.reportSet).toBeUndefined();
  });

  it("preserves an explicitly accepted empty selection", { timeout: 60000 }, async () => {
    const result = await run("empty");
    expect(result.code, result.stderr).toBe(0);
    expect(inventory(json(result.output))).toEqual([]);
    expect(json(path.join(result.reportSet!, "index.json")).complete).toBe(true);
  });

  it("leaves a single invocation native", { timeout: 60000 }, async () => {
    const result = await run("single");
    expect(result.code, result.stderr).toBe(0);
    expect(result.reportSet).toBeUndefined();
    expect(inventory(json(result.output))).toEqual(expected.slice(0, 2));
  });

  it("merges actual planner chunks of the same config once each", { timeout: 60000 }, async () => {
    const result = await run("chunks");
    expect(result.code, result.stderr).toBe(0);
    expect(inventory(json(result.output))).toEqual(
      Array.from({ length: 2 }, (_, i) => [`chunk/${i}`, "passed"]).sort(),
    );
    const index = json(path.join(result.reportSet!, "index.json"));
    expect(
      index.entries.map((entry: { includePatterns: string[] }) => entry.includePatterns),
    ).toEqual([
      ["extensions/telegram/src/owned-one.test.ts"],
      ["extensions/telegram/src/owned-two.test.ts"],
    ]);
    expect(new Set(index.entries.map((entry: { config: string }) => entry.config)).size).toBe(1);
  });
});
