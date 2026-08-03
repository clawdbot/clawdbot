import fs from "node:fs/promises";
import path from "node:path";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { readJsonFileIfExists } from "./test-file-scenario-script-evidence.js";

type NativeTestFileScenario = Pick<QaSeedScenarioWithSource, "id"> & {
  execution: Extract<
    QaSeedScenarioWithSource["execution"],
    { kind: "script" | "vitest" | "playwright" }
  >;
};

export function resolveNativeVitestReportPath(
  scenario: Pick<NativeTestFileScenario, "id">,
  outputDir: string,
): string {
  return path.join(outputDir, `${scenario.id}.vitest-report.json`);
}

async function canonicalizeNativeTestFilePath(params: {
  canonicalRepoRoot: string;
  repoRoot: string;
  testPath: string;
}) {
  const absoluteTestPath = path.resolve(params.repoRoot, params.testPath);
  const canonicalTestPath = await fs.realpath(absoluteTestPath).catch(() => undefined);
  if (canonicalTestPath) {
    return canonicalTestPath;
  }

  const repoRelativePath = path.relative(params.repoRoot, absoluteTestPath);
  if (
    repoRelativePath !== ".." &&
    !repoRelativePath.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(repoRelativePath)
  ) {
    return path.resolve(params.canonicalRepoRoot, repoRelativePath);
  }
  return absoluteTestPath;
}

export async function readNativeVitestExecutionFailure(params: {
  outputDir: string;
  repoRoot: string;
  scenario: NativeTestFileScenario;
}): Promise<string | undefined> {
  const reportPath = resolveNativeVitestReportPath(params.scenario, params.outputDir);
  const report = await readJsonFileIfExists(reportPath);
  if (!report || typeof report !== "object") {
    return `Vitest exited successfully without writing a valid JSON test report at ${reportPath}.`;
  }
  const { numFailedTests, numPassedTests, success, testResults } = report as {
    numFailedTests?: unknown;
    numPassedTests?: unknown;
    success?: unknown;
    testResults?: Array<{
      name?: unknown;
      assertionResults?: Array<{ fullName?: unknown; status?: unknown; title?: unknown }>;
    }>;
  };
  if (
    success !== true ||
    typeof numPassedTests !== "number" ||
    !Number.isSafeInteger(numPassedTests) ||
    numPassedTests < 1 ||
    numFailedTests !== 0
  ) {
    return "Vitest exited successfully without reporting a successfully executed test.";
  }
  const expectedTestPath = await fs
    .realpath(path.resolve(params.repoRoot, params.scenario.execution.path))
    .catch(() => undefined);
  if (!expectedTestPath) {
    return `Vitest exited successfully without an existing requested test file ${params.scenario.execution.path}.`;
  }
  const canonicalRepoRoot = await fs.realpath(params.repoRoot);
  const matchingTestResult = (
    await Promise.all(
      (Array.isArray(testResults) ? testResults : []).map(async (result) => {
        if (!result || typeof result.name !== "string") {
          return undefined;
        }
        const reportedTestPath = await canonicalizeNativeTestFilePath({
          canonicalRepoRoot,
          repoRoot: params.repoRoot,
          testPath: result.name,
        });
        return reportedTestPath === expectedTestPath ? result : undefined;
      }),
    )
  ).find((result) => result !== undefined);
  const passedAssertions = Array.isArray(matchingTestResult?.assertionResults)
    ? matchingTestResult.assertionResults.filter((assertion) => assertion.status === "passed")
    : [];
  if (passedAssertions.length === 0) {
    return `Vitest exited successfully without a passed assertion for the requested test file ${params.scenario.execution.path}.`;
  }
  const testNamePattern =
    params.scenario.execution.kind === "playwright"
      ? params.scenario.execution.testNamePattern
      : undefined;
  if (testNamePattern) {
    let requestedTestName: RegExp;
    try {
      // Vitest resolves string --testNamePattern values with the same RegExp constructor.
      requestedTestName = new RegExp(testNamePattern);
    } catch {
      return `Vitest exited successfully with an invalid requested test name pattern ${JSON.stringify(testNamePattern)}.`;
    }
    if (
      !passedAssertions.some((assertion) => {
        const assertionName =
          typeof assertion.fullName === "string" ? assertion.fullName : assertion.title;
        return typeof assertionName === "string" && requestedTestName.test(assertionName);
      })
    ) {
      return `Vitest exited successfully without a passed assertion for the requested test name pattern ${JSON.stringify(testNamePattern)}.`;
    }
  }
  return undefined;
}
