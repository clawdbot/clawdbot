import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawCrablineChannelDriverSelection } from "@openclaw/crabline";
import { assertQaSuiteArtifactWritten } from "./artifact-assertion.js";
import {
  hasQaCrablineArtifactPath,
  resolveQaCrablineChannelDriverArtifactPaths,
  type QaSuiteChannelDriverSelection,
} from "./crabline-artifacts.js";
import { buildQaSuiteEvidenceSummary, QA_EVIDENCE_FILENAME } from "./evidence-summary.js";
import type { QaProviderMode } from "./model-selection.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { renderQaMarkdownReport, type QaReportScenario } from "./report.js";
import type { RuntimeId } from "./runtime-parity.js";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import type { QaScorecardChannelDriver, QaScorecardEvidenceMode } from "./scorecard-taxonomy.js";
import { splitModelRef } from "./suite-planning.js";
import { countQaSuiteFailedScenarios, type QaSuiteSummaryJson } from "./suite-summary.js";
import { createQaSuiteReportNotes } from "./suite-support.js";
import type { QaSuiteScenarioResult } from "./suite-types.js";

type QaCrablineRuntime = typeof import("@openclaw/crabline");
type QaCrablineChannelDriverSmokeResult = Awaited<
  ReturnType<QaCrablineRuntime["runOpenClawCrablineChannelDriverSmoke"]>
>;

export type QaSuiteSummaryJsonParams = {
  scenarios: QaSuiteScenarioResult[];
  startedAt: Date;
  finishedAt: Date;
  metrics?: QaSuiteSummaryJson["metrics"];
  evidence?: QaSuiteSummaryJson["evidence"];
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
  channelDriver?: QaScorecardChannelDriver | null;
  channelDriverSelection?: QaSuiteChannelDriverSelection | null;
  scenarioIds?: readonly string[];
  runtimePair?: [RuntimeId, RuntimeId];
};

/**
 * Strongly-typed shape of `qa-suite-summary.json`. The GPT-5.6 Luna parity gate
 * (agentic-parity-report.ts, #64441) and any future parity wrapper can
 * import this type instead of re-declaring the shape, so changes to the
 * summary schema propagate through to every consumer at type-check time.
 */
export type QaSuiteGatewayRssSample = NonNullable<
  NonNullable<QaSuiteSummaryJson["metrics"]>["gatewayProcessRssSamples"]
>[number];

export type QaSuiteGatewayHeapSnapshot = NonNullable<
  NonNullable<QaSuiteSummaryJson["metrics"]>["gatewayHeapSnapshots"]
>[number];

/**
 * Pure-ish JSON builder for qa-suite-summary.json. Exported so the GPT-5.6 Luna
 * parity gate (agentic-parity-report.ts, #64441) and any future parity
 * runner can assert-and-trust the provider/model that produced a given
 * summary instead of blindly accepting the caller's candidateLabel /
 * baselineLabel. Without the `run` block, a maintainer who swaps candidate
 * and baseline summary paths could silently produce a mislabeled verdict.
 *
 * `scenarioIds` is only recorded when the caller passed a non-empty array
 * (an explicit scenario selection). A missing or empty array means "no
 * filter, full lane-selected catalog", which the summary encodes as `null`
 * so parity/report tooling doesn't mistake a full run for an explicit
 * empty selection.
 */
export function buildQaSuiteSummaryJson(params: QaSuiteSummaryJsonParams): QaSuiteSummaryJson {
  const primarySplit = splitModelRef(params.primaryModel);
  const alternateSplit = splitModelRef(params.alternateModel);
  return {
    scenarios: params.scenarios,
    counts: {
      total: params.scenarios.length,
      passed: params.scenarios.filter((scenario) => scenario.status === "pass").length,
      failed: countQaSuiteFailedScenarios(params.scenarios),
      skipped: params.scenarios.filter((scenario) => scenario.status === "skip").length,
    },
    ...(params.metrics ? { metrics: params.metrics } : {}),
    ...(params.evidence ? { evidence: params.evidence } : {}),
    run: {
      startedAt: params.startedAt.toISOString(),
      finishedAt: params.finishedAt.toISOString(),
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      primaryProvider: primarySplit?.provider ?? null,
      primaryModelName: primarySplit?.model ?? null,
      alternateModel: params.alternateModel,
      alternateProvider: alternateSplit?.provider ?? null,
      alternateModelName: alternateSplit?.model ?? null,
      fastMode: params.fastMode,
      concurrency: params.concurrency,
      channelDriver: params.channelDriver ?? params.channelDriverSelection?.channelDriver ?? null,
      channel: params.channelDriverSelection?.channel ?? null,
      channelCapabilityMatrixPath: params.channelDriverSelection?.capabilityMatrixPath ?? null,
      channelDriverSmokePath: params.channelDriverSelection?.smokeArtifactPath ?? null,
      scenarioIds:
        params.scenarioIds && params.scenarioIds.length > 0 ? [...params.scenarioIds] : null,
      runtimePair: params.runtimePair ?? null,
    },
  };
}

export async function writeQaSuiteArtifacts(params: {
  repoRoot?: string;
  outputDir: string;
  startedAt: Date;
  finishedAt: Date;
  scenarios: QaSuiteScenarioResult[];
  scenarioDefinitions?: readonly QaSeedScenarioWithSource[];
  evidenceMode?: QaScorecardEvidenceMode;
  metrics?: QaSuiteSummaryJson["metrics"];
  transport: QaTransportAdapter;
  // Reuse the canonical QaProviderMode union instead of re-declaring it
  // inline. Loop 6 already unified `QaSuiteSummaryJsonParams.providerMode`
  // on this type; keeping the writer in sync prevents drift when model-
  // selection.ts adds a new provider mode.
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
  channelDriver?: QaScorecardChannelDriver | null;
  channelDriverSelection?: OpenClawCrablineChannelDriverSelection | null;
  isolatedWorkers?: boolean;
  scenarioIds?: readonly string[];
  runtimePair?: [RuntimeId, RuntimeId];
  writeEvidenceFile?: boolean;
  runCrablineChannelDriverSmoke?: (
    params: Parameters<QaCrablineRuntime["runOpenClawCrablineChannelDriverSmoke"]>[0],
  ) => Promise<QaCrablineChannelDriverSmokeResult>;
}) {
  const reportPath = path.join(params.outputDir, "qa-suite-report.md");
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  const evidencePath = path.join(params.outputDir, QA_EVIDENCE_FILENAME);
  const crablineChannelDriverSelection = params.channelDriverSelection;
  // Non-Crabline package acceptance mounts this source without plugin-local
  // dependencies. Keep the owner runtime outside every unrelated live path.
  const crablineRuntime = crablineChannelDriverSelection
    ? await import("@openclaw/crabline")
    : undefined;
  let crablineChannelDriverSmoke: QaCrablineChannelDriverSmokeResult | undefined;
  if (crablineChannelDriverSelection) {
    const runCrablineChannelDriverSmoke =
      params.runCrablineChannelDriverSmoke ??
      crablineRuntime?.runOpenClawCrablineChannelDriverSmoke;
    if (!runCrablineChannelDriverSmoke) {
      throw new Error("Crabline runtime did not provide its channel-driver smoke helper.");
    }
    crablineChannelDriverSmoke = await runCrablineChannelDriverSmoke({
      outputDir: params.outputDir,
      selection: crablineChannelDriverSelection,
    });
  }
  const crablineChannelDriverArtifactPaths = resolveQaCrablineChannelDriverArtifactPaths({
    result: crablineChannelDriverSmoke,
    selection: crablineChannelDriverSelection,
  });
  const effectiveChannelDriverSelection: QaSuiteChannelDriverSelection | null | undefined =
    crablineChannelDriverSelection && crablineChannelDriverArtifactPaths
      ? {
          ...crablineChannelDriverSelection,
          ...crablineChannelDriverArtifactPaths,
        }
      : crablineChannelDriverSelection;
  const report = renderQaMarkdownReport({
    title: "OpenClaw QA Scenario Suite",
    startedAt: params.startedAt,
    finishedAt: params.finishedAt,
    checks: [],
    scenarios: params.scenarios.map((scenario) => ({
      name: scenario.name,
      status: scenario.status,
      details: scenario.details,
      steps: scenario.steps,
    })) satisfies QaReportScenario[],
    notes: createQaSuiteReportNotes({
      ...params,
      channelDriverSelection: effectiveChannelDriverSelection,
      createCrablineChannelReportNotes: crablineRuntime?.createOpenClawCrablineChannelReportNotes,
    }),
  });
  const evidence =
    params.scenarioDefinitions && params.scenarioDefinitions.length > 0
      ? buildQaSuiteEvidenceSummary({
          artifactPaths: [
            { kind: "summary", path: path.basename(summaryPath) },
            { kind: "report", path: path.basename(reportPath) },
            ...(effectiveChannelDriverSelection
              ? [
                  {
                    kind: "channel-capability-matrix",
                    path: effectiveChannelDriverSelection.capabilityMatrixPath,
                  },
                  {
                    kind: "channel-driver-smoke",
                    path: effectiveChannelDriverSelection.smokeArtifactPath,
                  },
                ]
              : []),
          ],
          evidenceMode: params.evidenceMode,
          channelId: params.channelDriverSelection?.channel ?? params.transport.id,
          channelDriver: params.channelDriver ?? params.channelDriverSelection?.channelDriver,
          env: process.env,
          generatedAt: params.finishedAt.toISOString(),
          primaryModel: params.primaryModel,
          providerMode: params.providerMode,
          repoRoot: params.repoRoot,
          scenarioDefinitions: params.scenarioDefinitions,
          scenarioResults: params.scenarios,
        })
      : undefined;
  if (
    crablineChannelDriverSelection &&
    crablineChannelDriverSmoke &&
    !hasQaCrablineArtifactPath(crablineChannelDriverSmoke.capabilityMatrixPath)
  ) {
    await fs.writeFile(
      path.join(params.outputDir, crablineChannelDriverSelection.capabilityMatrixPath),
      `${JSON.stringify(
        {
          version: 1,
          source: "openclaw/crabline",
          channelDriver: crablineChannelDriverSelection.channelDriver,
          selectedChannel: crablineChannelDriverSelection.channel,
          manifestPath: crablineChannelDriverSmoke.manifestPath,
          report: crablineChannelDriverSmoke.capabilityReport,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  if (
    crablineChannelDriverSelection &&
    crablineChannelDriverSmoke &&
    !hasQaCrablineArtifactPath(crablineChannelDriverSmoke.smokeArtifactPath)
  ) {
    await fs.writeFile(
      path.join(params.outputDir, crablineChannelDriverSelection.smokeArtifactPath),
      `${JSON.stringify(
        {
          version: 1,
          source: "openclaw/crabline",
          channelDriver: crablineChannelDriverSelection.channelDriver,
          selectedChannel: crablineChannelDriverSelection.channel,
          manifestPath: crablineChannelDriverSmoke.manifestPath,
          smoke: crablineChannelDriverSmoke.smoke,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }
  const writeEvidenceFile = params.writeEvidenceFile ?? true;
  await fs.writeFile(reportPath, report, "utf8");
  if (evidence && writeEvidenceFile) {
    await fs.writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
  }
  await fs.writeFile(
    summaryPath,
    `${JSON.stringify(
      buildQaSuiteSummaryJson({
        ...params,
        channelDriverSelection: effectiveChannelDriverSelection,
      }),
      null,
      2,
    )}\n`,
    "utf8",
  );
  await assertQaSuiteArtifactWritten("report", reportPath);
  await assertQaSuiteArtifactWritten("summary", summaryPath);
  if (evidence && writeEvidenceFile) {
    await assertQaSuiteArtifactWritten("evidence", evidencePath);
  }
  return { evidence, evidencePath, report, reportPath, summaryPath };
}
