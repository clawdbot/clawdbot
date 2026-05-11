import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { disposeRegisteredAgentHarnesses } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { startQaGatewayChild, type QaCliBackendAuthMode } from "./gateway-child.js";
import type {
  QaLabLatestReport,
  QaLabScenarioOutcome,
  QaLabServerHandle,
  QaLabServerStartParams,
} from "./lab-server.types.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import {
  isQaFastModeEnabled,
  normalizeQaProviderMode,
  type QaProviderMode,
} from "./model-selection.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "./providers/index.js";
import { startQaProviderServer } from "./providers/server-runtime.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";
import {
  createQaTransportAdapter,
  defaultQaSuiteConcurrencyForTransport,
  normalizeQaTransportId,
  type QaTransportId,
} from "./qa-transport-registry.js";
import type { QaTransportAdapter } from "./qa-transport.js";
import { renderQaMarkdownReport, type QaReportCheck, type QaReportScenario } from "./report.js";
import { defaultQaModelForMode } from "./run-config.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import {
  applyQaMergePatch,
  collectQaSuiteGatewayConfigPatch,
  collectQaSuiteGatewayRuntimeOptions,
  collectQaSuitePluginIds,
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  resolveQaSuiteWorkerStartStaggerMs,
  resolveQaSuiteOutputDir,
  scenarioRequiresControlUi,
  selectQaSuiteScenarios,
  splitModelRef,
} from "./suite-planning.js";
import { createQaSuiteScenarioFlowApi } from "./suite-runtime-flow.js";
import { waitForGatewayHealthy, waitForTransportReady } from "./suite-runtime-gateway.js";
import type { QaSuiteRuntimeEnv } from "./suite-runtime-types.js";
import { countQaSuiteFailedScenarios, type QaSuiteSummaryJson } from "./suite-summary.js";
import { closeQaWebSessions } from "./web-runtime.js";

type QaSuiteStep = {
  name: string;
  run: () => Promise<string | void>;
};

export type QaSuiteScenarioResult = {
  name: string;
  status: "pass" | "fail";
  steps: QaReportCheck[];
  details?: string;
};

type QaSuiteEnvironment = {
  lab: QaLabServerHandle;
  webSessionIds: Set<string>;
} & QaSuiteRuntimeEnv;

export type QaSuiteStartLabFn = (params?: QaLabServerStartParams) => Promise<QaLabServerHandle>;

export type QaSuiteRunParams = {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderMode;
  transportId?: QaTransportId;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  thinkingDefault?: QaThinkingLevel;
  claudeCliAuthMode?: QaCliBackendAuthMode;
  scenarioIds?: string[];
  lab?: QaLabServerHandle;
  startLab?: QaSuiteStartLabFn;
  concurrency?: number;
  enabledPluginIds?: string[];
  controlUiEnabled?: boolean;
  transportReadyTimeoutMs?: number;
};

function parseQaSuiteBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "0" || normalized === "false" || normalized === "no" || normalized === "off") {
    return false;
  }
  return undefined;
}

function shouldLogQaSuiteProgress(env: NodeJS.ProcessEnv = process.env) {
  const override = parseQaSuiteBooleanEnv(env.OPENCLAW_QA_SUITE_PROGRESS);
  if (override !== undefined) {
    return override;
  }
  return parseQaSuiteBooleanEnv(env.CI) === true;
}

function resolveQaSuiteTransportReadyTimeoutMs(
  explicitTimeoutMs?: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  if (
    typeof explicitTimeoutMs === "number" &&
    Number.isFinite(explicitTimeoutMs) &&
    explicitTimeoutMs > 0
  ) {
    return Math.floor(explicitTimeoutMs);
  }
  const raw = env.OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS;
  if (!raw) {
    return 120_000;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return 120_000;
  }
  return Math.floor(parsed);
}

function writeQaSuiteProgress(enabled: boolean, message: string) {
  if (!enabled) {
    return;
  }
  process.stderr.write(`[qa-suite] ${message}\n`);
}

function sanitizeQaSuiteProgressValue(value: string): string {
  let normalized = "";
  for (const char of value) {
    const code = char.codePointAt(0);
    if (code === undefined) {
      continue;
    }
    const isControl = code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    normalized += isControl ? " " : char;
  }
  normalized = normalized.replace(/\s+/gu, " ").trim();
  return normalized.length > 0 ? normalized : "<empty>";
}

function requireQaSuiteStartLab(startLab: QaSuiteStartLabFn | undefined): QaSuiteStartLabFn {
  if (startLab) {
    return startLab;
  }
  throw new Error(
    "QA suite requires startLab when no lab handle is provided; use the runtime launcher or pass startLab explicitly.",
  );
}

const _QA_IMAGE_UNDERSTANDING_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAAAAklEQVR4AewaftIAAAK4SURBVO3BAQEAMAwCIG//znsQgXfJBZjUALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsl9wFmNQAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwP4TIF+7ciPkoAAAAASUVORK5CYII=";

const _QA_IMAGE_UNDERSTANDING_LARGE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAYAAABccqhmAAACuklEQVR4Ae3BAQEAMAwCIG//znsQgXfJBZjUALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsBpjVALMaYFYDzGqAWQ0wqwFmNcCsl9wFmNQAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwGmNUAsxpgVgPMaoBZDTCrAWY1wKwP4TIF+2YE/z8AAAAASUVORK5CYII=";

const QA_IMAGE_UNDERSTANDING_VALID_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALklEQVR4nO3OoQEAAAyDsP7/9HYGJgJNdtuVDQAAAAAAACAHxH8AAAAAAACAHvBX0fhq85dN7QAAAABJRU5ErkJggg==";

function liveTurnTimeoutMs(
  env: Pick<QaSuiteRuntimeEnv, "providerMode" | "primaryModel" | "alternateModel">,
  fallbackMs: number,
) {
  return resolveQaLiveTurnTimeoutMs(env, fallbackMs);
}

export type QaSuiteResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  report: string;
  scenarios: QaSuiteScenarioResult[];
  watchUrl: string;
};

async function runScenario(name: string, steps: QaSuiteStep[]): Promise<QaSuiteScenarioResult> {
  const stepResults: QaReportCheck[] = [];
  for (const step of steps) {
    try {
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] start scenario="${name}" step="${step.name}"`);
      }
      const details = await step.run();
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] pass scenario="${name}" step="${step.name}"`);
      }
      stepResults.push({
        name: step.name,
        status: "pass",
        ...(details ? { details } : {}),
      });
    } catch (error) {
      const details = formatErrorMessage(error);
      if (process.env.OPENCLAW_QA_DEBUG === "1") {
        console.error(`[qa-suite] fail scenario="${name}" step="${step.name}" details=${details}`);
      }
      stepResults.push({
        name: step.name,
        status: "fail",
        details,
      });
      return {
        name,
        status: "fail",
        steps: stepResults,
        details,
      };
    }
  }
  return {
    name,
    status: "pass",
    steps: stepResults,
  };
}

function createScenarioFlowApi(
  env: QaSuiteEnvironment,
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  return createQaSuiteScenarioFlowApi({
    env,
    scenario,
    runScenario,
    splitModelRef,
    formatErrorMessage,
    liveTurnTimeoutMs,
    resolveQaLiveTurnTimeoutMs,
    constants: {
      imageUnderstandingPngBase64: _QA_IMAGE_UNDERSTANDING_PNG_BASE64,
      imageUnderstandingLargePngBase64: _QA_IMAGE_UNDERSTANDING_LARGE_PNG_BASE64,
      imageUnderstandingValidPngBase64: QA_IMAGE_UNDERSTANDING_VALID_PNG_BASE64,
    },
  });
}

async function runScenarioDefinition(
  env: QaSuiteEnvironment,
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  const api = createScenarioFlowApi(env, scenario);
  if (!scenario.execution.flow) {
    throw new Error(`scenario missing flow: ${scenario.id}`);
  }
  return await runScenarioFlow({
    api,
    flow: scenario.execution.flow,
    scenarioTitle: scenario.title,
  });
}

function createQaSuiteReportNotes(params: {
  transport: QaTransportAdapter;
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
}) {
  return params.transport.createReportNotes(params);
}

function normalizeQaSuiteModelRef(input: string | undefined, fallback: string) {
  const model = input?.trim();
  return model && model.length > 0 ? model : fallback;
}

export type QaSuiteSummaryJsonParams = {
  scenarios: QaSuiteScenarioResult[];
  startedAt: Date;
  finishedAt: Date;
  metrics?: QaSuiteSummaryJson["metrics"];
  providerMode: QaProviderMode;
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
  scenarioIds?: readonly string[];
};

/**
 * Strongly-typed shape of `qa-suite-summary.json`. The GPT-5.5 parity gate
 * (agentic-parity-report.ts, #64441) and any future parity wrapper can
 * import this type instead of re-declaring the shape, so changes to the
 * summary schema propagate through to every consumer at type-check time.
 */
export type { QaSuiteSummaryJson } from "./suite-summary.js";

/**
 * Pure-ish JSON builder for qa-suite-summary.json. Exported so the GPT-5.5
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
    },
    ...(params.metrics ? { metrics: params.metrics } : {}),
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
      scenarioIds:
        params.scenarioIds && params.scenarioIds.length > 0 ? [...params.scenarioIds] : null,
    },
  };
}

async function writeQaSuiteArtifacts(params: {
  outputDir: string;
  startedAt: Date;
  finishedAt: Date;
  scenarios: QaSuiteScenarioResult[];
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
  scenarioIds?: readonly string[];
}) {
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
    notes: createQaSuiteReportNotes(params),
  });
  const reportPath = path.join(params.outputDir, "qa-suite-report.md");
  const summaryPath = path.join(params.outputDir, "qa-suite-summary.json");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(
    summaryPath,
    `${JSON.stringify(buildQaSuiteSummaryJson(params), null, 2)}\n`,
    "utf8",
  );
  return { report, reportPath, summaryPath };
}

function buildQaSuiteRuntimeMetrics(params: {
  startedAt: Date;
  finishedAt: Date;
  gatewayProcessCpuStartMs: number | null;
  gatewayProcessCpuEndMs: number | null;
  gatewayProcessRssStartBytes: number | null;
  gatewayProcessRssEndBytes: number | null;
}): QaSuiteSummaryJson["metrics"] {
  const wallMs = Math.max(1, params.finishedAt.getTime() - params.startedAt.getTime());
  const rssMetrics =
    params.gatewayProcessRssStartBytes === null || params.gatewayProcessRssEndBytes === null
      ? {}
      : {
          gatewayProcessRssStartBytes: params.gatewayProcessRssStartBytes,
          gatewayProcessRssEndBytes: params.gatewayProcessRssEndBytes,
          gatewayProcessRssDeltaBytes:
            params.gatewayProcessRssEndBytes - params.gatewayProcessRssStartBytes,
        };
  if (params.gatewayProcessCpuStartMs === null || params.gatewayProcessCpuEndMs === null) {
    return { wallMs, ...rssMetrics };
  }
  const gatewayProcessCpuMs = Math.max(
    0,
    params.gatewayProcessCpuEndMs - params.gatewayProcessCpuStartMs,
  );
  return {
    wallMs,
    gatewayProcessCpuMs,
    gatewayCpuCoreRatio: Math.round((gatewayProcessCpuMs / wallMs) * 1000) / 1000,
    ...rssMetrics,
  };
}

export async function runQaSuite(params?: QaSuiteRunParams): Promise<QaSuiteResult> {
  const startedAt = new Date();
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const providerMode = normalizeQaProviderMode(
    params?.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const transportId = normalizeQaTransportId(params?.transportId);
  const primaryModel = normalizeQaSuiteModelRef(
    params?.primaryModel,
    defaultQaModelForMode(providerMode),
  );
  const alternateModel = normalizeQaSuiteModelRef(
    params?.alternateModel,
    defaultQaModelForMode(providerMode, true),
  );
  const fastMode =
    typeof params?.fastMode === "boolean"
      ? params.fastMode
      : isQaFastModeEnabled({ primaryModel, alternateModel });
  const outputDir = await resolveQaSuiteOutputDir(repoRoot, params?.outputDir);
  const catalog = readQaBootstrapScenarioCatalog();
  const selectedCatalogScenarios = selectQaSuiteScenarios({
    scenarios: catalog.scenarios,
    scenarioIds: params?.scenarioIds,
    providerMode,
    primaryModel,
    claudeCliAuthMode: params?.claudeCliAuthMode,
  });
  const enabledPluginIds = [
    ...new Set([
      ...collectQaSuitePluginIds(selectedCatalogScenarios),
      ...(params?.enabledPluginIds ?? []).map((pluginId) => pluginId.trim()).filter(Boolean),
    ]),
  ];
  const gatewayConfigPatch = collectQaSuiteGatewayConfigPatch(selectedCatalogScenarios);
  const gatewayRuntimeOptions = collectQaSuiteGatewayRuntimeOptions(selectedCatalogScenarios);
  const concurrency = normalizeQaSuiteConcurrency(
    params?.concurrency,
    selectedCatalogScenarios.length,
    defaultQaSuiteConcurrencyForTransport(transportId),
  );
  const progressEnabled = shouldLogQaSuiteProgress();
  writeQaSuiteProgress(
    progressEnabled,
    `run start: scenarios=${selectedCatalogScenarios.length} concurrency=${concurrency} transport=${transportId}`,
  );

  if (concurrency > 1 && selectedCatalogScenarios.length > 1) {
    const ownsLab = !params?.lab;
    const startLab = requireQaSuiteStartLab(params?.startLab);
    const lab =
      params?.lab ??
      (await startLab({
        repoRoot,
        host: "127.0.0.1",
        port: 0,
        embeddedGateway: "disabled",
      }));
    const transport = createQaTransportAdapter({
      id: transportId,
      state: lab.state,
    });
    const liveScenarioOutcomes: QaLabScenarioOutcome[] = selectedCatalogScenarios.map(
      (scenario) => ({
        id: scenario.id,
        name: scenario.title,
        status: "pending",
      }),
    );
    const updateScenarioRun = () =>
      lab.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: startedAt.toISOString(),
        scenarios: [...liveScenarioOutcomes],
      });
    const completedScenarioResults: Array<QaSuiteScenarioResult | undefined> = Array.from({
      length: selectedCatalogScenarios.length,
    });
    let artifactWriteQueue = Promise.resolve();
    const writePartialArtifacts = () => {
      const partialScenarios = completedScenarioResults.filter(
        (scenario): scenario is QaSuiteScenarioResult => scenario !== undefined,
      );
      if (partialScenarios.length === 0) {
        return;
      }
      artifactWriteQueue = artifactWriteQueue
        .then(async () => {
          const partialFinishedAt = new Date();
          const { report, reportPath } = await writeQaSuiteArtifacts({
            outputDir,
            startedAt,
            finishedAt: partialFinishedAt,
            scenarios: partialScenarios,
            transport,
            providerMode,
            primaryModel,
            alternateModel,
            fastMode,
            concurrency,
            scenarioIds:
              params?.scenarioIds && params.scenarioIds.length > 0
                ? selectedCatalogScenarios.map((scenario) => scenario.id)
                : undefined,
          });
          lab.setLatestReport({
            outputPath: reportPath,
            markdown: report,
            generatedAt: partialFinishedAt.toISOString(),
          } satisfies QaLabLatestReport);
        })
        .catch((error) => {
          writeQaSuiteProgress(
            progressEnabled,
            `partial artifact write failed: ${sanitizeQaSuiteProgressValue(formatErrorMessage(error))}`,
          );
        });
    };

    try {
      updateScenarioRun();
      const workerStartStaggerMs = resolveQaSuiteWorkerStartStaggerMs(concurrency);
      writeQaSuiteProgress(progressEnabled, `scenario start stagger=${workerStartStaggerMs}ms`);
      const scenarios: QaSuiteScenarioResult[] = await mapQaSuiteWithConcurrency(
        selectedCatalogScenarios,
        concurrency,
        async (scenario, index): Promise<QaSuiteScenarioResult> => {
          const scenarioIdForLog = sanitizeQaSuiteProgressValue(scenario.id);
          writeQaSuiteProgress(
            progressEnabled,
            `scenario start (${index + 1}/${selectedCatalogScenarios.length}): ${scenarioIdForLog}`,
          );
          liveScenarioOutcomes[index] = {
            id: scenario.id,
            name: scenario.title,
            status: "running",
            startedAt: new Date().toISOString(),
          };
          updateScenarioRun();
          try {
            const scenarioOutputDir = path.join(outputDir, "scenarios", scenario.id);
            const result: QaSuiteResult = await runQaSuite({
              repoRoot,
              outputDir: scenarioOutputDir,
              providerMode,
              transportId,
              primaryModel,
              alternateModel,
              fastMode,
              thinkingDefault: params?.thinkingDefault,
              claudeCliAuthMode: params?.claudeCliAuthMode,
              scenarioIds: [scenario.id],
              enabledPluginIds: params?.enabledPluginIds,
              concurrency: 1,
              startLab,
              // Most isolated workers do not need their own Control UI proxy.
              // Control UI scenarios do, because they open the worker's
              // gateway-backed app directly.
              controlUiEnabled: scenarioRequiresControlUi(scenario),
            });
            const scenarioResult: QaSuiteScenarioResult =
              result.scenarios[0] ??
              ({
                name: scenario.title,
                status: "fail",
                details: "isolated scenario run returned no scenario result",
                steps: [
                  {
                    name: "isolated scenario worker",
                    status: "fail",
                    details: "isolated scenario run returned no scenario result",
                  },
                ],
              } satisfies QaSuiteScenarioResult);
            liveScenarioOutcomes[index] = {
              id: scenario.id,
              name: scenario.title,
              status: scenarioResult.status,
              details: scenarioResult.details,
              steps: scenarioResult.steps,
              startedAt: liveScenarioOutcomes[index]?.startedAt,
              finishedAt: new Date().toISOString(),
            };
            updateScenarioRun();
            writeQaSuiteProgress(
              progressEnabled,
              `scenario ${scenarioResult.status} (${index + 1}/${selectedCatalogScenarios.length}): ${scenarioIdForLog}`,
            );
            completedScenarioResults[index] = scenarioResult;
            writePartialArtifacts();
            return scenarioResult;
          } catch (error) {
            const details = formatErrorMessage(error);
            const scenarioResult = {
              name: scenario.title,
              status: "fail",
              details,
              steps: [
                {
                  name: "isolated scenario worker",
                  status: "fail",
                  details,
                },
              ],
            } satisfies QaSuiteScenarioResult;
            liveScenarioOutcomes[index] = {
              id: scenario.id,
              name: scenario.title,
              status: "fail",
              details,
              steps: scenarioResult.steps,
              startedAt: liveScenarioOutcomes[index]?.startedAt,
              finishedAt: new Date().toISOString(),
            };
            updateScenarioRun();
            writeQaSuiteProgress(
              progressEnabled,
              `scenario fail (${index + 1}/${selectedCatalogScenarios.length}): ${scenarioIdForLog}`,
            );
            completedScenarioResults[index] = scenarioResult;
            writePartialArtifacts();
            return scenarioResult;
          }
        },
        { startStaggerMs: workerStartStaggerMs },
      );
      await artifactWriteQueue;
      const finishedAt = new Date();
      const failedCount = scenarios.filter((scenario) => scenario.status === "fail").length;
      lab.setScenarioRun({
        kind: "suite",
        status: "completed",
        startedAt: startedAt.toISOString(),
        finishedAt: finishedAt.toISOString(),
        scenarios: [...liveScenarioOutcomes],
      });
      const { report, reportPath, summaryPath } = await writeQaSuiteArtifacts({
        outputDir,
        startedAt,
        finishedAt,
        scenarios,
        transport,
        providerMode,
        primaryModel,
        alternateModel,
        fastMode,
        concurrency,
        // When the caller supplied an explicit non-empty --scenario filter,
        // record the executed (post-selectQaSuiteScenarios-normalized) ids
        // so the summary matches what actually ran. When the caller passed
        // nothing or an empty array ("no filter, full lane catalog"),
        // preserve the unfiltered = null semantic so the summary stays
        // distinguishable from an explicit all-scenarios selection.
        scenarioIds:
          params?.scenarioIds && params.scenarioIds.length > 0
            ? selectedCatalogScenarios.map((scenario) => scenario.id)
            : undefined,
      });
      lab.setLatestReport({
        outputPath: reportPath,
        markdown: report,
        generatedAt: finishedAt.toISOString(),
      } satisfies QaLabLatestReport);
      writeQaSuiteProgress(
        progressEnabled,
        `run complete: passed=${scenarios.length - failedCount} failed=${failedCount} total=${scenarios.length}`,
      );
      return {
        outputDir,
        reportPath,
        summaryPath,
        report,
        scenarios,
        watchUrl: lab.baseUrl,
      } satisfies QaSuiteResult;
    } finally {
      await disposeRegisteredAgentHarnesses();
      if (ownsLab) {
        await lab.stop();
      }
    }
  }

  const ownsLab = !params?.lab;
  const startLab = params?.startLab;
  writeQaSuiteProgress(progressEnabled, "lab start");
  const lab =
    params?.lab ??
    (await requireQaSuiteStartLab(startLab)({
      repoRoot,
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    }));
  writeQaSuiteProgress(progressEnabled, `lab ready: ${sanitizeQaSuiteProgressValue(lab.baseUrl)}`);
  const transport = createQaTransportAdapter({
    id: transportId,
    state: lab.state,
  });
  writeQaSuiteProgress(progressEnabled, `provider start: ${providerMode}`);
  const mock = await startQaProviderServer(providerMode);
  writeQaSuiteProgress(
    progressEnabled,
    `provider ready: ${sanitizeQaSuiteProgressValue(mock?.baseUrl ?? "live")}`,
  );
  writeQaSuiteProgress(progressEnabled, "gateway start");
  const gateway = await startQaGatewayChild({
    repoRoot,
    providerBaseUrl: mock ? `${mock.baseUrl}/v1` : undefined,
    transport,
    transportBaseUrl: lab.listenUrl,
    controlUiAllowedOrigins: [lab.listenUrl],
    providerMode,
    primaryModel,
    alternateModel,
    fastMode,
    thinkingDefault: params?.thinkingDefault,
    claudeCliAuthMode: params?.claudeCliAuthMode,
    controlUiEnabled: params?.controlUiEnabled ?? true,
    enabledPluginIds,
    forwardHostHome: gatewayRuntimeOptions?.forwardHostHome,
    mutateConfig: gatewayConfigPatch
      ? (cfg) => applyQaMergePatch(cfg, gatewayConfigPatch) as OpenClawConfig
      : undefined,
  });
  writeQaSuiteProgress(
    progressEnabled,
    `gateway ready: ${sanitizeQaSuiteProgressValue(gateway.baseUrl)}`,
  );
  lab.setControlUi({
    controlUiProxyTarget: gateway.baseUrl,
    controlUiToken: gateway.token,
  });
  const env: QaSuiteEnvironment = {
    lab,
    mock,
    gateway,
    // Markdown scenarios should see the full staged gateway config, not just
    // the transport fragment. Routing/session/plugin assertions depend on it.
    cfg: gateway.cfg,
    transport,
    repoRoot,
    providerMode,
    primaryModel,
    alternateModel,
    webSessionIds: new Set(),
  };

  let preserveGatewayRuntimeDir: string | undefined;
  try {
    const transportReadyTimeoutMs = resolveQaSuiteTransportReadyTimeoutMs(
      params?.transportReadyTimeoutMs,
    );
    // The gateway child already waits for /readyz before returning, but the
    // selected transport can still be finishing account startup. Pay that
    // readiness cost once here so the first scenario does not race bootstrap.
    await waitForTransportReady(env, transportReadyTimeoutMs).catch(async () => {
      await waitForGatewayHealthy(env, transportReadyTimeoutMs);
      await waitForTransportReady(env, transportReadyTimeoutMs);
    });
    await sleep(1_000);
    const scenarios: QaSuiteScenarioResult[] = [];
    const liveScenarioOutcomes: QaLabScenarioOutcome[] = selectedCatalogScenarios.map(
      (scenario) => ({
        id: scenario.id,
        name: scenario.title,
        status: "pending",
      }),
    );

    lab.setScenarioRun({
      kind: "suite",
      status: "running",
      startedAt: startedAt.toISOString(),
      scenarios: liveScenarioOutcomes,
    });

    const gatewayProcessCpuStartMs = gateway.getProcessCpuMs?.() ?? null;
    const gatewayProcessRssStartBytes = gateway.getProcessRssBytes?.() ?? null;
    for (const [index, scenario] of selectedCatalogScenarios.entries()) {
      const scenarioIdForLog = sanitizeQaSuiteProgressValue(scenario.id);
      writeQaSuiteProgress(
        progressEnabled,
        `scenario start (${index + 1}/${selectedCatalogScenarios.length}): ${scenarioIdForLog}`,
      );
      liveScenarioOutcomes[index] = {
        id: scenario.id,
        name: scenario.title,
        status: "running",
        startedAt: new Date().toISOString(),
      };
      lab.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: startedAt.toISOString(),
        scenarios: [...liveScenarioOutcomes],
      });

      const result = await runScenarioDefinition(env, scenario);
      scenarios.push(result);
      writeQaSuiteProgress(
        progressEnabled,
        `scenario ${result.status} (${index + 1}/${selectedCatalogScenarios.length}): ${scenarioIdForLog}`,
      );
      liveScenarioOutcomes[index] = {
        id: scenario.id,
        name: scenario.title,
        status: result.status,
        details: result.details,
        steps: result.steps,
        startedAt: liveScenarioOutcomes[index]?.startedAt,
        finishedAt: new Date().toISOString(),
      };
      lab.setScenarioRun({
        kind: "suite",
        status: "running",
        startedAt: startedAt.toISOString(),
        scenarios: [...liveScenarioOutcomes],
      });
    }

    const finishedAt = new Date();
    const metrics = buildQaSuiteRuntimeMetrics({
      startedAt,
      finishedAt,
      gatewayProcessCpuStartMs,
      gatewayProcessCpuEndMs: gateway.getProcessCpuMs?.() ?? null,
      gatewayProcessRssStartBytes,
      gatewayProcessRssEndBytes: gateway.getProcessRssBytes?.() ?? null,
    });
    const failedCount = scenarios.filter((scenario) => scenario.status === "fail").length;
    if (scenarios.some((scenario) => scenario.status === "fail")) {
      preserveGatewayRuntimeDir = path.join(outputDir, "artifacts", "gateway-runtime");
    }
    lab.setScenarioRun({
      kind: "suite",
      status: "completed",
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      scenarios: [...liveScenarioOutcomes],
    });
    const { report, reportPath, summaryPath } = await writeQaSuiteArtifacts({
      outputDir,
      startedAt,
      finishedAt,
      scenarios,
      metrics,
      transport,
      providerMode,
      primaryModel,
      alternateModel,
      fastMode,
      concurrency,
      // Same "filtered → executed list, unfiltered → null" convention as
      // the concurrent-path writeQaSuiteArtifacts call above.
      scenarioIds:
        params?.scenarioIds && params.scenarioIds.length > 0
          ? selectedCatalogScenarios.map((scenario) => scenario.id)
          : undefined,
    });
    const latestReport = {
      outputPath: reportPath,
      markdown: report,
      generatedAt: finishedAt.toISOString(),
    } satisfies QaLabLatestReport;
    lab.setLatestReport(latestReport);
    writeQaSuiteProgress(
      progressEnabled,
      `run complete: passed=${scenarios.length - failedCount} failed=${failedCount} total=${scenarios.length}`,
    );

    return {
      outputDir,
      reportPath,
      summaryPath,
      report,
      scenarios,
      watchUrl: lab.baseUrl,
    } satisfies QaSuiteResult;
  } catch (error) {
    preserveGatewayRuntimeDir = path.join(outputDir, "artifacts", "gateway-runtime");
    throw error;
  } finally {
    await closeQaWebSessions(env.webSessionIds);
    const keepTemp = process.env.OPENCLAW_QA_KEEP_TEMP === "1" || false;
    await gateway.stop({
      keepTemp,
      preserveToDir: keepTemp ? undefined : preserveGatewayRuntimeDir,
    });
    await disposeRegisteredAgentHarnesses();
    await mock?.stop();
    if (ownsLab) {
      await lab.stop();
    } else {
      lab.setControlUi({
        controlUiUrl: null,
        controlUiToken: null,
        controlUiProxyTarget: null,
      });
    }
  }
}

export const qaSuiteProgressTesting = {
  parseQaSuiteBooleanEnv,
  resolveQaSuiteTransportReadyTimeoutMs,
  sanitizeQaSuiteProgressValue,
  shouldLogQaSuiteProgress,
};
