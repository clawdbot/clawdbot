// Runs allowlisted TUI PTY cases and emits authenticated QA script evidence.
import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import {
  QA_EVIDENCE_FILENAME,
  readQaScenarioById,
  type QaEvidenceSummaryJson,
  type QaSeedScenarioWithSource,
} from "../../../../extensions/qa-lab/api.js";
import { coerceErrorMessage as formatErrorMessage } from "../../../../scripts/lib/error-format.mts";
import { createQaScriptEvidenceWriter } from "../runtime/script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/tui/tui-pty-evidence-producer.ts";
const VITEST_CONFIG_PATH = "test/vitest/vitest.tui-pty.config.ts";
const LOCAL_PTY_TEST_FILE = "src/tui/tui-pty-local.e2e.test.ts";
const REPORT_FILENAME = "vitest-report.json";
const PROOF_MATRIX_FILENAME = "proof-matrix.json";
const REPORT_FRESHNESS_TOLERANCE_MS = 2_000;
const MAX_PATTERN_LENGTH = 1_024;
const BUILT_CLI_REQUIREMENT =
  "cliMode=built requires readable openclaw.mjs and at least one readable dist/entry.js or dist/entry.mjs";

export const TUI_PTY_TEST_FILE_ALLOWLIST = [
  "src/tui/tui-pty-harness-assertion-test-support.test.ts",
  "src/tui/tui-pty-harness.e2e.test.ts",
  LOCAL_PTY_TEST_FILE,
  "src/tui/tui-reset-transition-pty.e2e.test.ts",
] as const;

type AllowedTuiPtyTestFile = (typeof TUI_PTY_TEST_FILE_ALLOWLIST)[number];

export type TuiPtyCase = {
  coverageId: string;
  testFile: AllowedTuiPtyTestFile;
  testNamePattern: string;
};

export type TuiPtyCliMode = "source" | "built";

export type TuiPtyProducerOptions = {
  artifactBase: string;
  repoRoot: string;
  scenarioId: string;
};

type VitestAssertionResult = {
  fullName?: unknown;
  status?: unknown;
  title?: unknown;
};

type VitestTestResult = {
  assertionResults?: unknown;
  name?: unknown;
};

type VitestJsonReport = {
  numFailedTests?: unknown;
  numPassedTests?: unknown;
  success?: unknown;
  testResults?: unknown;
};

type ProducerCommand = {
  args: string[];
  command: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

type CommandResult = {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
};

type ProducerDependencies = {
  loadScenario?: (scenarioId: string) => QaSeedScenarioWithSource;
  now?: () => number;
  runCommand?: (
    command: ProducerCommand,
    appendLog: (chunk: unknown) => void,
  ) => Promise<CommandResult>;
};

type ProofMatrixCase = TuiPtyCase & {
  matchedAssertions: string[];
};

function readOptionValue(argv: readonly string[], index: number, option: string) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

export function parseTuiPtyProducerOptions(
  argv: readonly string[],
  repoRoot = process.cwd(),
): TuiPtyProducerOptions {
  let artifactBase = "";
  let scenarioId = "";
  const seen = new Set<string>();

  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option !== "--artifact-base" && option !== "--scenario-id") {
      throw new Error(`unsupported TUI PTY evidence producer argument: ${option}`);
    }
    if (seen.has(option)) {
      throw new Error(`${option} was provided more than once`);
    }
    seen.add(option);
    const value = readOptionValue(argv, index, option);
    index += 1;
    if (option === "--artifact-base") {
      artifactBase = value;
    } else {
      scenarioId = value;
    }
  }

  if (!artifactBase.trim()) {
    throw new Error("--artifact-base is required");
  }
  if (!scenarioId.trim()) {
    throw new Error("--scenario-id is required");
  }
  return {
    artifactBase: path.resolve(repoRoot, artifactBase),
    repoRoot: path.resolve(repoRoot),
    scenarioId: scenarioId.trim(),
  };
}

function isAllowedTestFile(value: string): value is AllowedTuiPtyTestFile {
  return (TUI_PTY_TEST_FILE_ALLOWLIST as readonly string[]).includes(value);
}

function readTuiPtyCase(value: unknown, index: number): TuiPtyCase {
  if (!isRecord(value)) {
    throw new Error(`execution.config.tuiPtyCases[${index}] must be an object`);
  }
  const allowedKeys = new Set(["coverageId", "testFile", "testNamePattern"]);
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpectedKey) {
    throw new Error(
      `execution.config.tuiPtyCases[${index}] contains unsupported key ${unexpectedKey}`,
    );
  }
  const coverageId = typeof value.coverageId === "string" ? value.coverageId.trim() : "";
  const testFile = typeof value.testFile === "string" ? value.testFile.trim() : "";
  const testNamePattern =
    typeof value.testNamePattern === "string" ? value.testNamePattern.trim() : "";
  if (!coverageId) {
    throw new Error(`execution.config.tuiPtyCases[${index}].coverageId is required`);
  }
  if (!isAllowedTestFile(testFile)) {
    throw new Error(
      `execution.config.tuiPtyCases[${index}].testFile is not allowlisted: ${testFile || "<empty>"}`,
    );
  }
  if (!testNamePattern) {
    throw new Error(`execution.config.tuiPtyCases[${index}].testNamePattern is required`);
  }
  if (testNamePattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(
      `execution.config.tuiPtyCases[${index}].testNamePattern exceeds ${MAX_PATTERN_LENGTH} characters`,
    );
  }
  try {
    RegExp(testNamePattern);
  } catch (error) {
    throw new Error(
      `execution.config.tuiPtyCases[${index}].testNamePattern is invalid: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  return { coverageId, testFile, testNamePattern };
}

export function validateTuiPtyScenario(scenario: QaSeedScenarioWithSource): {
  cases: TuiPtyCase[];
  cliMode: TuiPtyCliMode;
} {
  if (scenario.execution.kind !== "script") {
    throw new Error(`scenario ${scenario.id} must use execution.kind=script`);
  }
  if (scenario.execution.path !== SOURCE_PATH) {
    throw new Error(`scenario ${scenario.id} must execute ${SOURCE_PATH}`);
  }
  const requireBuiltCli = scenario.execution.config?.requireBuiltCli;
  if (requireBuiltCli !== undefined && typeof requireBuiltCli !== "boolean") {
    throw new Error("execution.config.requireBuiltCli must be a boolean when provided");
  }
  const cliMode: TuiPtyCliMode = requireBuiltCli === true ? "built" : "source";
  const rawCases = scenario.execution.config?.tuiPtyCases;
  if (!Array.isArray(rawCases) || rawCases.length === 0) {
    throw new Error(`scenario ${scenario.id} must configure a non-empty tuiPtyCases array`);
  }

  const cases = rawCases.map(readTuiPtyCase);
  const declaredCoverage = new Set([
    ...(scenario.coverage?.primary ?? []),
    ...(scenario.coverage?.secondary ?? []),
  ]);
  const seenCases = new Set<string>();
  for (const configuredCase of cases) {
    if (!declaredCoverage.has(configuredCase.coverageId)) {
      throw new Error(
        `TUI PTY case declares coverage ID not owned by scenario ${scenario.id}: ${configuredCase.coverageId}`,
      );
    }
    const caseKey = [
      configuredCase.coverageId,
      configuredCase.testFile,
      configuredCase.testNamePattern,
    ].join("\u0000");
    if (seenCases.has(caseKey)) {
      throw new Error(
        `scenario ${scenario.id} contains a duplicate TUI PTY case for ${configuredCase.coverageId}`,
      );
    }
    seenCases.add(caseKey);
  }

  const representedCoverage = new Set(cases.map((configuredCase) => configuredCase.coverageId));
  const missingPrimary = (scenario.coverage?.primary ?? []).filter(
    (coverageId) => !representedCoverage.has(coverageId),
  );
  if (missingPrimary.length > 0) {
    throw new Error(
      `scenario ${scenario.id} has primary coverage IDs without TUI PTY cases: ${missingPrimary.join(", ")}`,
    );
  }
  const hasNonLocalCase = cases.some(
    (configuredCase) => configuredCase.testFile !== LOCAL_PTY_TEST_FILE,
  );
  if (cliMode === "built" && hasNonLocalCase) {
    throw new Error(
      `execution.config.requireBuiltCli=true requires every testFile to be exactly ${LOCAL_PTY_TEST_FILE}`,
    );
  }
  return { cases, cliMode };
}

export function buildTuiPtyVitestCommand(params: {
  cases: readonly TuiPtyCase[];
  cliMode: TuiPtyCliMode;
  repoRoot: string;
  reportPath: string;
}): ProducerCommand {
  const testFiles = [
    ...new Set(params.cases.map((configuredCase) => configuredCase.testFile)),
  ].toSorted((left, right) => left.localeCompare(right));
  const testNamePattern = params.cases
    .map((configuredCase) => `(?:${configuredCase.testNamePattern})`)
    .join("|");
  const usesLocalPty = testFiles.includes(LOCAL_PTY_TEST_FILE);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    OPENCLAW_BEHAVIOR_EVIDENCE: "1",
    OPENCLAW_VITEST_FS_MODULE_CACHE_PATH: path.join(
      path.dirname(params.reportPath),
      "vitest-fs-module-cache",
    ),
  };
  if (usesLocalPty) {
    env.OPENCLAW_TUI_PTY_INCLUDE_LOCAL = "1";
  } else {
    delete env.OPENCLAW_TUI_PTY_INCLUDE_LOCAL;
  }
  if (params.cliMode === "built") {
    env.OPENCLAW_TUI_PTY_USE_BUILT_CLI = "1";
  } else {
    delete env.OPENCLAW_TUI_PTY_USE_BUILT_CLI;
  }
  return {
    command: process.execPath,
    cwd: params.repoRoot,
    args: [
      "scripts/run-vitest.mjs",
      "run",
      "--config",
      VITEST_CONFIG_PATH,
      ...testFiles,
      "--testNamePattern",
      testNamePattern,
      "--reporter=verbose",
      "--reporter=json",
      `--outputFile.json=${params.reportPath}`,
    ],
    env,
  };
}

async function runProducerCommand(
  command: ProducerCommand,
  appendLog: (chunk: unknown) => void,
): Promise<CommandResult> {
  return await new Promise((resolve, reject) => {
    const child = spawn(command.command, command.args, {
      cwd: command.cwd,
      env: command.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.on("data", appendLog);
    child.stderr.on("data", appendLog);
    child.on("error", reject);
    child.on("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
}

function assertionName(assertion: VitestAssertionResult) {
  if (typeof assertion.fullName === "string") {
    return assertion.fullName;
  }
  return typeof assertion.title === "string" ? assertion.title : undefined;
}

async function canonicalizeReportedTestPath(repoRoot: string, reportedPath: string) {
  const absolutePath = path.resolve(repoRoot, reportedPath);
  return await fs.realpath(absolutePath).catch(() => absolutePath);
}

export async function verifyTuiPtyVitestReport(params: {
  cases: readonly TuiPtyCase[];
  report: VitestJsonReport;
  repoRoot: string;
}): Promise<ProofMatrixCase[]> {
  if (
    params.report.success !== true ||
    params.report.numFailedTests !== 0 ||
    typeof params.report.numPassedTests !== "number" ||
    !Number.isSafeInteger(params.report.numPassedTests) ||
    params.report.numPassedTests < 1 ||
    !Array.isArray(params.report.testResults)
  ) {
    throw new Error("Vitest report does not describe a successful test run");
  }

  const testResults = params.report.testResults.filter(isRecord) as VitestTestResult[];
  const resultPaths = await Promise.all(
    testResults.map(async (result) => {
      const name = typeof result.name === "string" ? result.name : "";
      return name ? await canonicalizeReportedTestPath(params.repoRoot, name) : "";
    }),
  );

  const proofCases: ProofMatrixCase[] = [];
  for (const configuredCase of params.cases) {
    const expectedPath = await fs.realpath(path.resolve(params.repoRoot, configuredCase.testFile));
    const resultIndex = resultPaths.indexOf(expectedPath);
    if (resultIndex < 0) {
      throw new Error(
        `Vitest report has no result for configured test file ${configuredCase.testFile}`,
      );
    }
    const assertionResults = testResults[resultIndex]?.assertionResults;
    const passedAssertions = Array.isArray(assertionResults)
      ? assertionResults
          .filter(isRecord)
          .filter((assertion) => assertion.status === "passed")
          .map(assertionName)
          .filter((name): name is string => Boolean(name))
      : [];
    const pattern = new RegExp(configuredCase.testNamePattern);
    const matchedAssertions = passedAssertions.filter((name) => {
      pattern.lastIndex = 0;
      return pattern.test(name);
    });
    if (matchedAssertions.length === 0) {
      throw new Error(
        `Vitest report has no passed assertion for ${configuredCase.testFile} matching ${JSON.stringify(configuredCase.testNamePattern)}`,
      );
    }
    proofCases.push({ ...configuredCase, matchedAssertions });
  }
  return proofCases;
}

async function writeJson(filePath: string, value: unknown) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function buildProofMatrix(
  scenarioId: string,
  cliMode: TuiPtyCliMode,
  cases: readonly ProofMatrixCase[],
) {
  return {
    schemaVersion: 1,
    scenarioId,
    cliMode,
    generatedAt: new Date().toISOString(),
    cases,
  };
}

async function requireBuiltCliArtifacts(repoRoot: string, cliMode: TuiPtyCliMode) {
  if (cliMode !== "built") {
    return;
  }
  const [launcher, ...entries] = await Promise.allSettled(
    ["openclaw.mjs", "dist/entry.js", "dist/entry.mjs"].map((file) =>
      fs.access(path.join(repoRoot, file), fsConstants.R_OK),
    ),
  );
  if (launcher?.status !== "fulfilled" || !entries.some((entry) => entry.status === "fulfilled")) {
    throw new Error(BUILT_CLI_REQUIREMENT);
  }
}

function sanitizeVitestReport(report: VitestJsonReport, proofCases: readonly ProofMatrixCase[]) {
  const allowedFiles = new Set(proofCases.map((configuredCase) => configuredCase.testFile));
  const testResults = Array.isArray(report.testResults)
    ? report.testResults.map((result) => {
        if (!isRecord(result) || typeof result.name !== "string") {
          return result;
        }
        const resultName = result.name;
        const matchingFile = [...allowedFiles].find((file) => resultName.endsWith(file));
        return { ...result, name: matchingFile ?? "<unrecognized-test-file>" };
      })
    : report.testResults;
  return { ...report, testResults };
}

export async function runTuiPtyEvidenceProducer(
  options: TuiPtyProducerOptions,
  dependencies: ProducerDependencies = {},
): Promise<QaEvidenceSummaryJson> {
  const scenario = (dependencies.loadScenario ?? readQaScenarioById)(options.scenarioId);
  if (scenario.id !== options.scenarioId) {
    throw new Error(
      `loaded scenario ${scenario.id} does not match requested scenario ${options.scenarioId}`,
    );
  }
  const { cases, cliMode } = validateTuiPtyScenario(scenario);
  const reportPath = path.join(options.artifactBase, REPORT_FILENAME);
  const proofMatrixPath = path.join(options.artifactBase, PROOF_MATRIX_FILENAME);
  const target = {
    codeRefs: scenario.codeRefs,
    docsRefs: scenario.docsRefs,
    id: scenario.id,
    sourcePath: SOURCE_PATH,
    title: scenario.title,
  };
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "tui-pty-evidence-producer.log",
    primaryModel: "mock-openai/tui-pty",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target,
  });
  const startedAt = (dependencies.now ?? Date.now)();
  writer.appendLog(`cliMode=${cliMode}\n`);
  await fs.mkdir(options.artifactBase, { recursive: true });
  await Promise.all([fs.rm(reportPath, { force: true }), fs.rm(proofMatrixPath, { force: true })]);
  const initialProofCases = cases.map((configuredCase) => ({
    ...configuredCase,
    matchedAssertions: [],
  }));
  await writeJson(proofMatrixPath, buildProofMatrix(scenario.id, cliMode, initialProofCases));

  try {
    await requireBuiltCliArtifacts(options.repoRoot, cliMode);
    const command = buildTuiPtyVitestCommand({
      cases,
      cliMode,
      reportPath,
      repoRoot: options.repoRoot,
    });
    writer.appendLog(
      `$ ${path.basename(command.command)} ${command.args
        .map((arg) =>
          JSON.stringify(
            arg.startsWith("--outputFile.json=") ? `--outputFile.json=${REPORT_FILENAME}` : arg,
          ),
        )
        .join(" ")}\n`,
    );
    const result = await (dependencies.runCommand ?? runProducerCommand)(command, (chunk) =>
      writer.appendLog(chunk),
    );
    if (result.exitCode !== 0 || result.signal) {
      throw new Error(
        result.signal
          ? `TUI PTY Vitest terminated by ${result.signal}`
          : `TUI PTY Vitest exited with ${String(result.exitCode)}`,
      );
    }

    const reportStat = await fs.stat(reportPath).catch(() => undefined);
    if (!reportStat) {
      throw new Error(`TUI PTY Vitest did not write ${REPORT_FILENAME}`);
    }
    if (reportStat.mtimeMs < startedAt - REPORT_FRESHNESS_TOLERANCE_MS) {
      throw new Error(`TUI PTY Vitest report is stale: ${REPORT_FILENAME}`);
    }
    const report = JSON.parse(await fs.readFile(reportPath, "utf8")) as VitestJsonReport;
    const proofCases = await verifyTuiPtyVitestReport({
      cases,
      report,
      repoRoot: options.repoRoot,
    });
    await writeJson(reportPath, sanitizeVitestReport(report, proofCases));
    await writeJson(proofMatrixPath, buildProofMatrix(scenario.id, cliMode, proofCases));
    return await writer.write({
      artifacts: [
        { kind: "vitest-report", filePath: REPORT_FILENAME },
        { kind: "proof-matrix", filePath: PROOF_MATRIX_FILENAME },
      ],
      details: `Authenticated ${proofCases.length} TUI PTY coverage case(s).`,
      durationMs: Math.max(1, (dependencies.now ?? Date.now)() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`\nfail: ${details}\n`);
    return await writer.write({
      artifacts: [{ kind: "proof-matrix", filePath: PROOF_MATRIX_FILENAME }],
      details,
      durationMs: Math.max(1, (dependencies.now ?? Date.now)() - startedAt),
      status: "fail",
    });
  }
}

async function main(argv: readonly string[]) {
  const evidence = await runTuiPtyEvidenceProducer(parseTuiPtyProducerOptions(argv));
  const status = evidence.entries[0]?.result.status;
  console.log(`TUI PTY evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`TUI PTY status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
