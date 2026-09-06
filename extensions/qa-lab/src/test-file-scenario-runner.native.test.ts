import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateQaEvidenceSummaryJson } from "./evidence-summary.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import {
  runQaTestFileScenarios,
  type QaScenarioCommandExecution,
} from "./test-file-scenario-runner.js";
import {
  QA_TEST_RUNNER_DEFAULTS,
  createScenarioRunnerTestHarness,
  makeTestFileScenario,
  writeNativeVitestReport,
} from "./test-file-scenario-runner.test-support.js";

const harness = createScenarioRunnerTestHarness();
const makeTempRepo = (prefix: string) => harness.makeTempRepo(prefix);

afterEach(async () => {
  await harness.cleanup();
});

describe("qa test file scenario runner", () => {
  it("keeps every Playwright scenario pattern aligned with an executable test", async () => {
    for (const scenario of readQaScenarioPack().scenarios) {
      const execution = scenario.execution;
      if (execution.kind !== "playwright" || !execution.testNamePattern) {
        continue;
      }
      const testSource = await fs.readFile(execution.path, "utf8");
      const testNamePattern = new RegExp(execution.testNamePattern);
      const testNames = testSource.matchAll(/\bit\s*\(\s*["'`]([^"'`\n]+)["'`]/gu);
      expect(
        Array.from(testNames, (match) => match[1] ?? "").some((name) => testNamePattern.test(name)),
        `${scenario.id} testNamePattern matches an executable test`,
      ).toBe(true);
    }
  });

  it("runs Playwright scenarios with the repo UI e2e command and writes Playwright evidence", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-scenario-");
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [
        makeTestFileScenario(
          "playwright",
          "ui/src/e2e/chat-flow.e2e.test.ts",
          "^chat > sends a chat turn through the GUI$",
        ),
      ],
      runCommand: async (command) => {
        commands.push(command);
        await writeNativeVitestReport(command, {
          passed: 1,
          ancestorTitles: ["chat"],
          testName: "sends a chat turn through the GUI",
        });
        return {
          exitCode: 0,
          stdout: "pass\n",
          stderr: "",
        };
      },
      env: {
        OPENCLAW_QA_REF: "scenario-ref",
      } as NodeJS.ProcessEnv,
    });

    expect(result.executionKind).toBe("playwright");
    expect(commands.map((command) => command.args)).toEqual([
      ["--import", "tsx", "scripts/ensure-playwright-chromium.mts"],
      [
        "scripts/run-vitest.mjs",
        "run",
        "--config",
        "test/vitest/vitest.ui-e2e.config.ts",
        "--configLoader",
        "runner",
        "ui/src/e2e/chat-flow.e2e.test.ts",
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile.json=${path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-playwright",
          "scenario-playwright.vitest-report.json",
        )}`,
        "--testNamePattern",
        "^chat > sends a chat turn through the GUI$",
      ],
    ]);
    expect(commands.map((command) => command.timeoutMs)).toEqual([1_800_000, 1_800_000]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.schemaVersion).toBe(2);
    expect(evidence.entries).toHaveLength(1);
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "playwright-test",
        id: "scenario-playwright",
        source: {
          path: "ui/src/e2e/chat-flow.e2e.test.ts",
        },
      },
      coverage: [
        {
          id: "ui.control",
          role: "primary",
        },
        {
          id: "ui.streaming",
          role: "secondary",
        },
      ],
      refs: [
        {
          kind: "docs",
          path: "docs/concepts/qa-e2e-automation.md",
        },
        {
          kind: "code",
          path: "ui/src/e2e/chat-flow.e2e.test.ts",
        },
      ],
      execution: {
        runner: "playwright",
        artifacts: [
          {
            kind: "log",
            path: ".artifacts/qa-e2e/scenario-playwright/scenario-playwright.log",
            source: "playwright",
          },
        ],
      },
      result: {
        status: "pass",
      },
    });
  });

  it("can return aggregate evidence without retaining a duplicate evidence file", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-memory-evidence-");
    const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright");
    await fs.mkdir(outputDir, { recursive: true });
    await fs.writeFile(path.join(outputDir, "qa-evidence.json"), "stale evidence\n", "utf8");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir,
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("playwright", "ui/src/e2e/chat-flow.e2e.test.ts")],
      writeEvidenceFile: false,
      runCommand: async (command) => {
        await writeNativeVitestReport(command, { passed: 1 });
        return {
          exitCode: 0,
          stdout: "pass\n",
          stderr: "",
        };
      },
    });

    expect(result.evidence.entries).toHaveLength(1);
    await expect(fs.access(result.evidencePath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("runs Vitest scenarios with the declared test path and writes Vitest evidence", async () => {
    const repoRoot = await makeTempRepo("qa-vitest-scenario-");
    const commands: QaScenarioCommandExecution[] = [];
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-vitest"),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("vitest", "extensions/qa-lab/src/coverage-report.test.ts")],
      runCommand: async (command) => {
        commands.push(command);
        return {
          exitCode: 1,
          stdout: "",
          stderr: "failed\n",
        };
      },
    });

    expect(result.executionKind).toBe("vitest");
    expect(commands.map((command) => command.args)).toEqual([
      [
        "scripts/run-vitest.mjs",
        "extensions/qa-lab/src/coverage-report.test.ts",
        "--reporter=verbose",
        "--reporter=json",
        `--outputFile.json=${path.join(
          repoRoot,
          ".artifacts",
          "qa-e2e",
          "scenario-vitest",
          "scenario-vitest.vitest-report.json",
        )}`,
      ],
    ]);
    expect(commands.map((command) => command.timeoutMs)).toEqual([1_800_000]);
    const evidence = validateQaEvidenceSummaryJson(
      JSON.parse(await fs.readFile(result.evidencePath, "utf8")),
    );
    expect(evidence.entries[0]).toMatchObject({
      test: {
        kind: "vitest-test",
        id: "scenario-vitest",
        source: {
          path: "extensions/qa-lab/src/coverage-report.test.ts",
        },
      },
      coverage: [
        {
          id: "qa.coverage",
          role: "primary",
        },
        {
          id: "qa.reporting",
          role: "secondary",
        },
      ],
      execution: {
        runner: "vitest",
        artifacts: [
          {
            kind: "log",
            path: ".artifacts/qa-e2e/scenario-vitest/scenario-vitest.log",
            source: "vitest",
          },
        ],
      },
      result: {
        status: "fail",
        failure: {
          reason: "node exited with 1",
        },
      },
    });
  });

  it.each([
    { executionKind: "vitest" as const, passed: 0, expectedStatus: "fail" as const },
    { executionKind: "playwright" as const, passed: 0, expectedStatus: "fail" as const },
    { executionKind: "vitest" as const, passed: 1, expectedStatus: "pass" as const },
    { executionKind: "playwright" as const, passed: 1, expectedStatus: "pass" as const },
  ])(
    "requires an actually passed $executionKind test when the native child exits successfully ($passed passed)",
    async ({ executionKind, expectedStatus, passed }) => {
      const repoRoot = await makeTempRepo(`qa-${executionKind}-executed-tests-`);
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", `scenario-${executionKind}`);
      const scenarioPath =
        executionKind === "playwright"
          ? "ui/src/e2e/chat-flow.e2e.test.ts"
          : "extensions/qa-lab/src/coverage-report.test.ts";
      const commands: QaScenarioCommandExecution[] = [];
      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir,
        ...QA_TEST_RUNNER_DEFAULTS,
        scenarios: [makeTestFileScenario(executionKind, scenarioPath)],
        runCommand: async (command) => {
          commands.push(command);
          await writeNativeVitestReport(command, { passed });
          return { exitCode: 0, stdout: "child exited successfully\n", stderr: "" };
        },
      });

      expect(result.results[0]).toMatchObject({ status: expectedStatus });
      expect(result.evidence.entries[0]?.result.status).toBe(expectedStatus);
      expect(
        commands.filter((command) => command.args[0] === "scripts/run-vitest.mjs"),
      ).toHaveLength(1);
      if (expectedStatus === "fail") {
        expect(result.results[0]?.failureMessage).toBe(
          "Vitest exited successfully without reporting a successfully executed test.",
        );
      }
    },
  );

  it.each([{ executionKind: "vitest" as const }, { executionKind: "playwright" as const }])(
    "rejects a passing $executionKind report for an unrelated test file",
    async ({ executionKind }) => {
      const repoRoot = await makeTempRepo(`qa-${executionKind}-wrong-report-file-`);
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", `scenario-${executionKind}`);
      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir,
        ...QA_TEST_RUNNER_DEFAULTS,
        scenarios: [
          makeTestFileScenario(
            executionKind,
            executionKind === "playwright"
              ? "ui/src/e2e/chat-flow.e2e.test.ts"
              : "extensions/qa-lab/src/coverage-report.test.ts",
          ),
        ],
        runCommand: async (command) => {
          await writeNativeVitestReport(command, {
            passed: 1,
            testFilePath: "extensions/qa-lab/src/unrelated.test.ts",
          });
          return { exitCode: 0, stdout: "unrelated test passed\n", stderr: "" };
        },
      });

      expect(result.results[0]).toMatchObject({
        failureMessage: expect.stringContaining("requested test file"),
        status: "fail",
      });
      expect(result.evidence.entries[0]?.result.status).toBe("fail");
    },
  );

  it.each([{ executionKind: "vitest" as const }, { executionKind: "playwright" as const }])(
    "rejects a passing $executionKind report when the requested test file does not exist",
    async ({ executionKind }) => {
      const repoRoot = await makeTempRepo(`qa-${executionKind}-missing-requested-test-`);
      const scenarioPath =
        executionKind === "playwright"
          ? "ui/src/e2e/chat-flow.e2e.test.ts"
          : "extensions/qa-lab/src/coverage-report.test.ts";
      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", `scenario-${executionKind}`),
        ...QA_TEST_RUNNER_DEFAULTS,
        scenarios: [makeTestFileScenario(executionKind, scenarioPath)],
        runCommand: async (command) => {
          await writeNativeVitestReport(command, {
            createRequestedTestFile: false,
            passed: 1,
          });
          return { exitCode: 0, stdout: "missing test reportedly passed\n", stderr: "" };
        },
      });

      expect(result.results[0]).toMatchObject({
        failureMessage: expect.stringContaining("existing requested test file"),
        status: "fail",
      });
      expect(result.evidence.entries[0]?.result.status).toBe("fail");
    },
  );

  it.skipIf(process.platform === "win32")(
    "authenticates requested tests when the checkout root is a symlink",
    async () => {
      const canonicalRoot = await fs.realpath(await makeTempRepo("qa-vitest-symlinked-checkout-"));
      const symlinkedRoot = path.join(canonicalRoot, "checkout-alias");
      await fs.symlink(canonicalRoot, symlinkedRoot, "dir");
      const scenarioPath = "extensions/qa-lab/src/coverage-report.test.ts";
      const result = await runQaTestFileScenarios({
        repoRoot: symlinkedRoot,
        outputDir: path.join(symlinkedRoot, ".artifacts", "qa-e2e", "scenario-vitest"),
        ...QA_TEST_RUNNER_DEFAULTS,
        scenarios: [makeTestFileScenario("vitest", scenarioPath)],
        runCommand: async (command) => {
          await writeNativeVitestReport(command, {
            passed: 1,
            testFilePath: path.join(canonicalRoot, scenarioPath),
          });
          return { exitCode: 0, stdout: "canonical test passed\n", stderr: "" };
        },
      });

      expect(result.results[0]).toMatchObject({ status: "pass" });
      expect(result.evidence.entries[0]?.result.status).toBe("pass");
    },
  );

  it("rejects a passing Playwright report that misses the requested test name", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-wrong-report-test-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [
        makeTestFileScenario(
          "playwright",
          "ui/src/e2e/chat-flow.e2e.test.ts",
          "required visual assertion",
        ),
      ],
      runCommand: async (command) => {
        await writeNativeVitestReport(command, {
          passed: 1,
          testName: "unrelated visual assertion",
        });
        return { exitCode: 0, stdout: "unrelated assertion passed\n", stderr: "" };
      },
    });

    expect(result.results[0]).toMatchObject({
      failureMessage: expect.stringContaining("requested test name"),
      status: "fail",
    });
    expect(result.evidence.entries[0]?.result.status).toBe("fail");
  });

  it("records invalid Playwright test-name patterns as failed scenario evidence", async () => {
    const repoRoot = await makeTempRepo("qa-playwright-invalid-report-pattern-");
    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "scenario-playwright"),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("playwright", "ui/src/e2e/chat-flow.e2e.test.ts", "[")],
      runCommand: async (command) => {
        await writeNativeVitestReport(command, {
          passed: 1,
          testName: "executed visual assertion",
        });
        return { exitCode: 0, stdout: "visual assertion passed\n", stderr: "" };
      },
    });

    expect(result.results[0]).toMatchObject({
      failureMessage: expect.stringContaining("invalid requested test name pattern"),
      status: "fail",
    });
    expect(result.evidence.entries[0]?.result.status).toBe("fail");
  });

  it.each([{ executionKind: "vitest" as const }, { executionKind: "playwright" as const }])(
    "does not reuse a prior passing $executionKind report when the next child writes none",
    async ({ executionKind }) => {
      const repoRoot = await makeTempRepo(`qa-${executionKind}-stale-vitest-report-`);
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", `scenario-${executionKind}`);
      const scenarioPath =
        executionKind === "playwright"
          ? "ui/src/e2e/chat-flow.e2e.test.ts"
          : "extensions/qa-lab/src/coverage-report.test.ts";
      const reportPath = path.join(outputDir, `scenario-${executionKind}.vitest-report.json`);
      let writeReport = true;
      const runParams = {
        repoRoot,
        outputDir,
        ...QA_TEST_RUNNER_DEFAULTS,
        scenarios: [makeTestFileScenario(executionKind, scenarioPath)],
        runCommand: async (command: QaScenarioCommandExecution) => {
          if (writeReport) {
            await writeNativeVitestReport(command, { passed: 1 });
          }
          return { exitCode: 0, stdout: "child exited successfully\n", stderr: "" };
        },
      };

      const firstRun = await runQaTestFileScenarios(runParams);
      expect(firstRun.results[0]).toMatchObject({ status: "pass" });
      await expect(fs.access(reportPath)).resolves.toBeUndefined();

      writeReport = false;
      const secondRun = await runQaTestFileScenarios(runParams);
      expect(secondRun.results[0]).toMatchObject({
        failureMessage: `Vitest exited successfully without writing a valid JSON test report at ${reportPath}.`,
        status: "fail",
      });
      expect(secondRun.evidence.entries[0]?.result.status).toBe("fail");
      await expect(fs.access(reportPath)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it.each([
    { failFast: true, expectedScenarioIds: ["first-native-scenario"] },
    {
      failFast: false,
      expectedScenarioIds: ["first-native-scenario", "later-native-scenario"],
    },
    {
      failFast: undefined,
      expectedScenarioIds: ["first-native-scenario", "later-native-scenario"],
    },
  ])(
    "honors native scenario fail-fast mode ($failFast)",
    async ({ failFast, expectedScenarioIds }) => {
      const repoRoot = await makeTempRepo("qa-vitest-fail-fast-");
      const runCommand = vi.fn(async () => ({
        exitCode: 1,
        stdout: "",
        stderr: "native scenario failed\n",
      }));
      const firstScenario = {
        ...makeTestFileScenario("vitest", "extensions/qa-lab/src/coverage-report.test.ts"),
        id: "first-native-scenario",
      };
      const laterScenario = {
        ...makeTestFileScenario("vitest", "extensions/qa-lab/src/cli.test.ts"),
        id: "later-native-scenario",
      };

      const result = await runQaTestFileScenarios({
        repoRoot,
        outputDir: path.join(repoRoot, ".artifacts", "qa-e2e", "native-fail-fast"),
        ...QA_TEST_RUNNER_DEFAULTS,
        failFast,
        scenarios: [firstScenario, laterScenario],
        runCommand,
      });

      expect(runCommand).toHaveBeenCalledTimes(expectedScenarioIds.length);
      expect(result.results.map((scenario) => scenario.scenario.id)).toEqual(expectedScenarioIds);
      expect(result.results.every((scenario) => scenario.status === "fail")).toBe(true);
      expect(result.evidence.entries.map((entry) => entry.test.id)).toEqual(expectedScenarioIds);
    },
  );
});
