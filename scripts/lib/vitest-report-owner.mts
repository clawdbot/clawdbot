import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { JsonTestResults } from "vitest/node";
import { parseVitestExecutionArgs } from "./vitest-cli.mts";
import type { VitestReportCapture } from "./vitest-report-capture.mts";

export type VitestReportOutcome = {
  code: number;
  signal: NodeJS.Signals | null;
  noOutputTimedOut?: boolean;
};
type Invocation = { config: string; args: string[]; includePatterns?: string[] | null };
type Attempt = { json: string; blob: string; outcome?: VitestReportOutcome; error?: string };

const captureReporter = fileURLToPath(new URL("./vitest-report-capture.mts", import.meta.url));
const consoleReporters = new Set([
  "json",
  "default",
  "verbose",
  "dot",
  "agent",
  "minimal",
  "tree",
  "github-actions",
  "hanging-process",
]);

function withoutOutputArgs(args: string[]) {
  const result: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === "--") {
      return [...result, ...args.slice(index)];
    }
    if (/^--(?:output(?:File|-file)(?:\.[^=]+)?|coverage\.reportsDirectory)(?:=|$)/u.test(arg)) {
      if (!arg.includes("=")) {
        index++;
      }
    } else {
      result.push(arg);
    }
  }
  return result;
}

function caseInventory(reports: JsonTestResults[]) {
  return reports
    .flatMap((report) =>
      report.testResults.flatMap((file) =>
        file.assertionResults.map((test) =>
          JSON.stringify([file.name, test.fullName, test.status]),
        ),
      ),
    )
    .toSorted();
}

/** Own file artifacts only; callers retain admission, retry, environment and process ownership. */
export async function createVitestReportOwner(invocations: Invocation[], cwd: string) {
  if (
    invocations.length < 2 ||
    invocations.some(({ args }) => args[0] !== "run") ||
    !invocations.some(({ args }) => args.some((arg) => /^--reporters?(?:=|$)/u.test(arg))) ||
    !invocations.some(({ args }) =>
      args.some((arg) => /^--output(?:File|-file)(?:\.|=|$)/u.test(arg)),
    )
  ) {
    return null;
  }
  const { parseCLI } = await import("vitest/node");
  const parsed = invocations.map(({ args }) => parseVitestExecutionArgs(args, parseCLI));
  if (parsed.some((entry) => !entry || entry.options.watch)) {
    return null;
  }
  const runOptions = parsed.map((entry) => entry!.options);
  const requests = runOptions.map((option) => {
    // Native CLI's singular alias is distinct from config-defined reporters.
    const reporters = (option as typeof option & { reporter?: string[] }).reporter ?? [];
    const output =
      typeof option.outputFile === "string" ? option.outputFile : option.outputFile?.json;
    return reporters.includes("json") && output && !option.watch ? { reporters, output } : null;
  });
  if (requests.every((request) => !request)) {
    return null;
  }
  assert(requests.every(Boolean), "Every invocation must share the explicit JSON file request");
  const request = requests[0]!;
  assert(
    requests.every((entry) => entry!.output === request.output),
    "JSON destinations differ across invocations",
  );
  assert(
    requests.every((entry) => entry!.reporters.every((name) => consoleReporters.has(name))),
    "Multi-invocation JSON supports native JSON plus console reporters. Run other file/custom reporters separately with unique destinations.",
  );
  const { readJsonFile, validateVitestJsonReport } = await import("../test-report-utils.mts");
  function readNativeReport(file: string) {
    const invalid = validateVitestJsonReport(file);
    assert.equal(invalid, null);
    return readJsonFile(file) as JsonTestResults;
  }

  const requested = path.resolve(cwd, request.output);
  fs.mkdirSync(path.dirname(requested), { recursive: true });
  const directory = fs.mkdtempSync(`${requested}.reports-`);
  const entries = invocations.map(({ config, args, includePatterns }, invocation) => ({
    invocation: invocation + 1,
    config,
    args,
    includePatterns,
    state: "unstarted",
    acceptedAttempt: null as number | null,
    attempts: [] as Attempt[],
  }));
  const index = {
    requested,
    complete: false,
    entries,
    error: "",
    aggregate: "",
    publication: "",
    merge: null as VitestReportOutcome | null,
  };
  const save = () =>
    fs.writeFileSync(path.join(directory, "index.json"), JSON.stringify(index, null, 2));
  save();
  console.error(`[test] native report set: ${directory}`);

  return {
    attempt(invocation: number, args: string[]) {
      const entry = entries[invocation]!;
      const attemptDirectory = path.join(
        directory,
        `${invocation + 1}`,
        `${entry.attempts.length + 1}`,
      );
      fs.mkdirSync(attemptDirectory, { recursive: true });
      const attempt: Attempt = {
        json: path.join(attemptDirectory, "report.json"),
        blob: path.join(attemptDirectory, "blob.json"),
      };
      entry.attempts.push(attempt);
      entry.state = "started";
      save();
      const reportArgs = [
        `--outputFile.json=${attempt.json}`,
        `--outputFile.blob=${attempt.blob}`,
        `--coverage.reportsDirectory=${path.join(attemptDirectory, "coverage")}`,
        "--reporter=blob",
        `--reporter=${captureReporter}`,
      ];
      const original = withoutOutputArgs(args);
      const separator = original.indexOf("--");
      original.splice(separator < 0 ? original.length : separator, 0, ...reportArgs);
      return {
        args: original,
        complete(outcome: VitestReportOutcome) {
          attempt.outcome = outcome;
          entry.state = "finished";
          save();
        },
        fail(error: unknown) {
          attempt.error = String(error);
          entry.state = "error";
          save();
        },
      };
    },
    async finish(
      runMerge: (args: string[]) => Promise<VitestReportOutcome>,
      incompleteReason?: string,
    ) {
      try {
        if (incompleteReason) {
          throw new Error(incompleteReason);
        }
        const attempts = entries.map((entry) => entry.attempts.at(-1));
        assert(
          attempts.every(
            (attempt) =>
              attempt?.outcome &&
              !attempt.error &&
              !attempt.outcome.signal &&
              !attempt.outcome.noOutputTimedOut,
          ),
          "Report set incomplete: unstarted, interrupted or unsuccessful attempt completion",
        );
        const accepted = attempts as Attempt[];
        entries.forEach((entry) => {
          entry.acceptedAttempt = entry.attempts.length;
        });
        const reports = accepted.map((attempt) => readNativeReport(attempt.json));
        const captures = accepted.map(
          (attempt) => readJsonFile(`${attempt.json}.capture.json`) as VitestReportCapture,
        );
        assert(
          captures.every(
            (capture) =>
              capture.ended && capture.ended.reason !== "interrupted" && !capture.processTimedOut,
          ),
          "Native report completion evidence missing or interrupted",
        );
        const taskIds = captures.flatMap((capture) =>
          capture.modules.map((module) => module.taskId),
        );
        assert.equal(
          new Set(taskIds).size,
          taskIds.length,
          "Native merge would replace overlapping task identities; originals retained. Run overlapping selections separately with unique output files.",
        );
        captures.forEach((capture, i) => {
          if (
            !capture.coverageDirectory ||
            (reports[i]!.numFailedTests > 0 && !capture.coverageOnFailure)
          ) {
            return;
          }
          for (const file of capture.coverageFiles) {
            assert(
              fs.statSync(path.join(capture.coverageDirectory, file)).isFile(),
              `Missing native coverage report: ${file}`,
            );
          }
        });
        const destinations = new Set(
          captures.map((capture) => path.resolve(capture.root, request.output)),
        );
        assert.equal(
          destinations.size,
          1,
          "Relative outputFile resolves to different project roots; use an absolute destination",
        );
        const destination = [...destinations][0]!;
        const projectConfigs = [
          ...new Map(
            captures
              .flatMap((capture) => capture.projects)
              .map((project) => [JSON.stringify(project), project]),
          ).values(),
        ].map((project) => {
          assert(typeof project.config === "string", "Missing native project configuration");
          assert(typeof project.namePrefix === "string", "Missing native project name prefix");
          return {
            config: project.config,
            root: project.root,
            namePrefix: project.namePrefix,
          };
        });
        const blobs = path.join(directory, "accepted-blobs");
        fs.mkdirSync(blobs);
        accepted.forEach((attempt, i) =>
          fs.copyFileSync(attempt.blob, path.join(blobs, `${i}.json`)),
        );
        const staged = path.join(directory, "aggregate.json");
        const config = path.join(directory, "vitest.merge.config.mjs");
        fs.writeFileSync(
          config,
          `export default ${JSON.stringify({
            root: cwd,
            test: {
              // An omitted list lets native Vitest host a wholly empty blob replay.
              projects: projectConfigs.length ? projectConfigs : undefined,
              coverage: { enabled: false },
              passWithNoTests: captures.every((capture) => capture.passWithNoTests),
              dangerouslyIgnoreUnhandledErrors: captures.every(
                (capture) => capture.ignoreUnhandledErrors || capture.ended!.unhandledErrors === 0,
              ),
              reporters: [
                ["json", {}],
                [captureReporter, { expected: captures }],
              ],
            },
          })};\n`,
        );
        const mergeArgs = [
          "run",
          "--mergeReports",
          blobs,
          "--config",
          config,
          "--configLoader=runner",
          `--outputFile.json=${staged}`,
        ];
        if (typeof runOptions[0]?.pool === "string") {
          mergeArgs.push("--pool", runOptions[0].pool);
        }
        index.merge = await runMerge(mergeArgs);
        const merged = readNativeReport(staged);
        const replay = readJsonFile(`${staged}.capture.json`) as VitestReportCapture;
        assert(
          replay.ended &&
            !replay.processTimedOut &&
            !index.merge.signal &&
            !index.merge.noOutputTimedOut,
          "Native merge did not complete",
        );
        assert.equal(
          replay.ended.unhandledErrors,
          captures.reduce((total, capture) => total + capture.ended!.unhandledErrors, 0),
          "Native merge added or lost unhandled errors",
        );
        // Exit 1 also represents a complete failed test run. A replay failure must not be mistaken for it.
        const expectedFailure = captures.some(
          (capture) =>
            capture.ended!.reason === "failed" ||
            capture.ended!.failedModules ||
            (!capture.ignoreUnhandledErrors && capture.ended!.unhandledErrors),
        );
        assert(
          index.merge.code === 0 || (index.merge.code === 1 && expectedFailure),
          "Native merge failed",
        );
        assert.deepEqual(
          caseInventory([merged]),
          caseInventory(reports),
          "Native aggregate case inventory differs from accepted reports",
        );
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        const publication = fs.mkdtempSync(`${destination}.publish-`);
        index.publication = publication;
        save();
        const publicationFile = path.join(publication, "report.json");
        fs.copyFileSync(staged, publicationFile);
        fs.renameSync(publicationFile, destination);
        fs.rmdirSync(publication);
        index.publication = "";
        index.aggregate = destination;
        index.complete = true;
        console.error(
          `[test] native JSON aggregate: ${destination}; originals: ${directory}. Native merge omits snapshot summaries and JSON coverageMap; startTime is merge time. Use index.json for process outcomes.`,
        );
        return index.merge.code;
      } catch (error) {
        index.error = String(error);
        console.error(`[test] report publication failed; retained ${directory}: ${index.error}`);
        return 1;
      } finally {
        save();
      }
    },
  };
}

export type VitestReportOwner = Awaited<ReturnType<typeof createVitestReportOwner>>;
