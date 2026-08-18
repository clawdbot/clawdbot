import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runQaScenarioCommandLifecycle } from "./test-file-scenario-command-lifecycle.js";
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
const makeTempDir = (prefix: string) => harness.makeTempDir(prefix);
const makeTempRepo = (prefix: string) => harness.makeTempRepo(prefix);

afterEach(async () => {
  await harness.cleanup();
});

describe("qa test file scenario runner", () => {
  it.each([
    { executionKind: "vitest" as const, commandCount: 1 },
    { executionKind: "playwright" as const, commandCount: 2 },
  ])(
    "applies the resolved command timeout to every $executionKind subprocess",
    async ({ commandCount, executionKind }) => {
      const repoRoot = await makeTempRepo(`qa-${executionKind}-command-timeout-`);
      const outputDir = path.join(repoRoot, ".artifacts", "qa-e2e", `scenario-${executionKind}`);
      const commands: QaScenarioCommandExecution[] = [];

      await runQaTestFileScenarios({
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
        commandTimeoutMs: 321,
        runCommand: async (command) => {
          commands.push(command);
          await writeNativeVitestReport(command, { passed: 1 });
          return { exitCode: 0, stdout: "native pass\n", stderr: "" };
        },
      });

      expect(commands).toHaveLength(commandCount);
      expect(commands.map((command) => command.timeoutMs)).toEqual(
        Array.from({ length: commandCount }, () => 321),
      );
    },
  );

  it.each(["vitest", "playwright"] as const)(
    "terminates a hanging $executionKind subprocess with failure evidence",
    async (executionKind) => {
      const repoRoot = await makeTempRepo(`qa-${executionKind}-hung-command-`);
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
        commandTimeoutMs: 100,
        runCommand: (execution) =>
          runQaScenarioCommandLifecycle({
            ...execution,
            args: ["-e", "setInterval(() => {}, 1_000)"],
          }),
      });

      expect(result.results[0]).toMatchObject({
        failureMessage: expect.stringContaining("timed out after 100ms"),
        status: "fail",
      });
      expect(result.evidence.entries[0]?.result.status).toBe("fail");
    },
  );

  it("fails script scenarios that exit cleanly after timeout termination", async () => {
    const repoRoot = process.cwd();
    const tempRoot = await makeTempDir("qa-script-timeout-clean-exit-");
    const scriptPath = path.join(tempRoot, "clean-exit-after-timeout.ts");
    await fs.writeFile(
      scriptPath,
      [
        "process.stdout.write('waiting for timeout\\n');",
        "process.on('SIGTERM', () => process.exit(0));",
        "setInterval(() => {}, 1000);",
      ].join("\n"),
      "utf8",
    );

    const result = await runQaTestFileScenarios({
      repoRoot,
      outputDir: path.join(tempRoot, "out"),
      ...QA_TEST_RUNNER_DEFAULTS,
      scenarios: [makeTestFileScenario("script", scriptPath)],
      commandTimeoutMs: 100,
    });

    expect(result.results[0]?.status).toBe("fail");
    expect(result.results[0]?.failureMessage).toMatch(/timed out after 100ms/u);
  });
});
