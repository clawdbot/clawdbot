import fs from "node:fs/promises";
import path from "node:path";
import {
  QA_EVIDENCE_FILENAME,
  QA_EVIDENCE_SUMMARY_KIND,
  QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
  type QaEvidenceSummaryJson,
  validateQaEvidenceSummaryJson,
} from "./evidence-summary.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { createTempDirHarness } from "./temp-dir.test-helper.js";
import type {
  QaScenarioCommandExecution,
  runQaTestFileScenarios,
} from "./test-file-scenario-runner.js";

export const QA_TEST_RUNNER_DEFAULTS = {
  providerMode: "mock-openai",
  primaryModel: "mock-openai/gpt-5.6-luna",
} satisfies Pick<Parameters<typeof runQaTestFileScenarios>[0], "primaryModel" | "providerMode">;

export function createScenarioRunnerTestHarness() {
  const tempDirs = createTempDirHarness();

  return {
    makeTempDir: tempDirs.makeTempDir,
    makeTempRepo: (prefix: string) => tempDirs.makeTempDir(prefix),
    cleanup: tempDirs.cleanup,
  };
}

export function makeTestFileScenario(
  executionKind: "script" | "vitest" | "playwright",
  pathLocal: string,
  testNamePattern?: string,
): QaSeedScenarioWithSource {
  return {
    id: `scenario-${executionKind}`,
    title: `${executionKind} scenario`,
    surface: executionKind === "playwright" ? "control-ui" : "qa-lab",
    category: executionKind === "playwright" ? "control-ui.browser-ui" : "qa-lab.coverage",
    coverage: {
      primary: [executionKind === "playwright" ? "ui.control" : "qa.coverage"],
      secondary: [executionKind === "playwright" ? "ui.streaming" : "qa.reporting"],
    },
    objective: `Exercise ${executionKind} scenario evidence.`,
    successCriteria: ["The scenario writes structured evidence."],
    docsRefs: ["docs/concepts/qa-e2e-automation.md"],
    codeRefs: [pathLocal],
    sourcePath: `qa/scenarios/ui/scenario-${executionKind}.md`,
    execution: {
      kind: executionKind,
      path: pathLocal,
      ...(testNamePattern ? { testNamePattern } : {}),
      ...(executionKind === "script"
        ? { args: ["--once", "--artifact-base", "${outputDir}"] }
        : {}),
    },
  };
}

export function makeDockerE2eScenario(id: string, lane: string): QaSeedScenarioWithSource {
  const scenario = makeTestFileScenario("script", "test/e2e/qa-lab/runtime/docker-e2e-lane.ts");
  if (scenario.execution.kind !== "script") {
    throw new Error("expected script scenario");
  }
  return {
    ...scenario,
    id,
    execution: {
      ...scenario.execution,
      args: ["--lane", lane],
    },
  };
}

export async function writeDockerCandidateManifest(
  command: QaScenarioCommandExecution,
  manifest: unknown,
) {
  const manifestArg = command.args.find((arg) => arg.startsWith("--prepare-only="));
  if (!manifestArg) {
    throw new Error("missing prep-only manifest argument");
  }
  await fs.writeFile(manifestArg.slice("--prepare-only=".length), `${JSON.stringify(manifest)}\n`);
  return { exitCode: 0, stdout: "", stderr: "" };
}

export async function writeNativeVitestReport(
  command: QaScenarioCommandExecution,
  counts: {
    createRequestedTestFile?: boolean;
    failed?: number;
    passed: number;
    testFilePath?: string;
    testName?: string;
  },
) {
  const reportArg = command.args.find((arg) => arg.startsWith("--outputFile.json="));
  if (!reportArg) {
    return;
  }
  const requestedTestPath = command.args.find((arg) => arg.endsWith(".test.ts"));
  if (requestedTestPath && counts.createRequestedTestFile !== false) {
    const requestedTestFile = path.resolve(command.cwd, requestedTestPath);
    await fs.mkdir(path.dirname(requestedTestFile), { recursive: true });
    await fs.writeFile(requestedTestFile, "// native scenario fixture\n", "utf8");
  }
  const testNamePatternIndex = command.args.indexOf("--testNamePattern");
  const testName =
    counts.testName ??
    (testNamePatternIndex < 0 ? undefined : command.args[testNamePatternIndex + 1]) ??
    "executes the requested scenario";
  await fs.writeFile(
    reportArg.slice("--outputFile.json=".length),
    JSON.stringify({
      numFailedTests: counts.failed ?? 0,
      numPassedTests: counts.passed,
      success: (counts.failed ?? 0) === 0,
      testResults: [
        {
          name: path.resolve(command.cwd, counts.testFilePath ?? requestedTestPath ?? "unknown"),
          status: counts.passed > 0 ? "passed" : "skipped",
          assertionResults:
            counts.passed > 0 ? [{ fullName: testName, title: testName, status: "passed" }] : [],
        },
      ],
    }),
    "utf8",
  );
}

type ScriptEvidenceArtifact = {
  kind: string;
  path: string;
  source?: string;
};

type ScriptProducerEvidenceParams = {
  additionalEntries?: QaEvidenceSummaryJson["entries"];
  artifacts?: ScriptEvidenceArtifact[];
  coverage?: QaEvidenceSummaryJson["entries"][number]["coverage"];
  failureReason?: string;
  producerId?: string;
  profile?: string;
  status: "blocked" | "fail" | "pass";
};

export function buildScriptProducerEvidence(
  params: ScriptProducerEvidenceParams,
): QaEvidenceSummaryJson {
  return validateQaEvidenceSummaryJson({
    kind: QA_EVIDENCE_SUMMARY_KIND,
    schemaVersion: QA_EVIDENCE_SUMMARY_SCHEMA_VERSION,
    generatedAt: "2026-06-14T00:00:00.000Z",
    evidenceMode: "full",
    ...(params.profile ? { profile: params.profile } : {}),
    entries: [
      {
        test: {
          kind: "script-producer-check",
          id: params.producerId ?? "script-producer.web-ui.smoke",
          title: "Script producer: web-ui smoke",
          source: { path: "external/qa/evidence-producer.mjs" },
        },
        coverage: params.coverage ?? [{ id: "ui.control", role: "primary" }],
        execution: {
          runner: "evidence-producer-script",
          environment: { ref: "scenario-ref", os: "darwin", nodeVersion: "v24.0.0" },
          provider: {
            id: "script-producer",
            live: false,
            model: { name: null, ref: null },
            fixture: "synthetic-script-evidence",
          },
          packageSource: { kind: "source-checkout", sha: "abc123" },
          artifacts: (params.artifacts ?? []).map((artifact) =>
            Object.assign({ source: "script-producer:web-ui:smoke" }, artifact),
          ),
        },
        result: {
          status: params.status,
          ...(params.failureReason ? { failure: { reason: params.failureReason } } : {}),
          timing: { wallMs: 1 },
        },
      },
      ...(params.additionalEntries ?? []),
    ],
  });
}

export async function writeScriptProducerEvidence(
  params: ScriptProducerEvidenceParams & {
    evidenceLocation?: "run" | "scenario-root";
    latestRun?: "absolute" | "none" | "relative";
    outputDir: string;
    scenarioId?: string;
  },
) {
  const scenarioArtifactBase = path.join(params.outputDir, params.scenarioId ?? "scenario-script");
  const evidenceDir =
    params.evidenceLocation === "scenario-root"
      ? scenarioArtifactBase
      : path.join(scenarioArtifactBase, "run-1");
  const evidencePath = path.join(evidenceDir, QA_EVIDENCE_FILENAME);
  await fs.mkdir(evidenceDir, { recursive: true });
  await fs.writeFile(
    evidencePath,
    `${JSON.stringify(buildScriptProducerEvidence(params), null, 2)}\n`,
    "utf8",
  );
  const latestRun = params.latestRun ?? "absolute";
  if (latestRun !== "none") {
    await fs.writeFile(
      path.join(scenarioArtifactBase, "latest-run.json"),
      `${JSON.stringify(
        {
          qaEvidence:
            latestRun === "relative"
              ? path.relative(scenarioArtifactBase, evidencePath)
              : evidencePath,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  return { evidenceDir, evidencePath, scenarioArtifactBase };
}
