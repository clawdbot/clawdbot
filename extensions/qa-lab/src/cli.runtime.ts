import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  buildQaAgenticParityComparison,
  renderQaAgenticParityMarkdownReport,
  type QaParitySuiteSummary,
} from "./agentic-parity-report.js";
import { resolveQaParityPackScenarioIds } from "./agentic-parity.js";
import { runQaCharacterEval, type QaCharacterModelOptions } from "./character-eval.js";
import { resolveRepoRelativeOutputDir } from "./cli-paths.js";
import { buildQaCoverageInventory, renderQaCoverageMarkdownReport } from "./coverage-report.js";
import { buildQaDockerHarnessImage, writeQaDockerHarnessFiles } from "./docker-harness.js";
import { runQaDockerUp } from "./docker-up.runtime.js";
import type { QaCliBackendAuthMode } from "./gateway-child.js";
import { startQaLabServer } from "./lab-server.js";
import { runQaManualLane } from "./manual-lane.runtime.js";
import { runQaMultipass } from "./multipass.runtime.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE, getQaProvider } from "./providers/index.js";
import {
  QA_FRONTIER_PARITY_BASELINE_LABEL,
  QA_FRONTIER_PARITY_CANDIDATE_LABEL,
} from "./providers/live-frontier/parity.js";
import { startQaProviderServer } from "./providers/server-runtime.js";
import {
  addQaCredentialSet,
  listQaCredentialSets,
  QaCredentialAdminError,
  removeQaCredentialSet,
  type QaCredentialRecord,
} from "./qa-credentials-admin.runtime.js";
import { normalizeQaThinkingLevel, type QaThinkingLevel } from "./qa-gateway-config.js";
import { normalizeQaTransportId, type QaTransportId } from "./qa-transport-registry.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderMode,
  type QaProviderModeInput,
} from "./run-config.js";
import { readQaScenarioPack } from "./scenario-catalog.js";
import { runQaSuiteFromRuntime } from "./suite-launch.runtime.js";
import { readQaSuiteFailedScenarioCountFromSummary } from "./suite-summary.js";

const QA_SUITE_INFRA_RETRY_LIMIT = 1;

type InterruptibleServer = {
  baseUrl: string;
  stop(): Promise<void>;
};

function resolveQaManualLaneModels(opts: {
  providerMode: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
}) {
  const primaryModel = opts.primaryModel?.trim() || defaultQaModelForMode(opts.providerMode);
  const alternateModel = opts.alternateModel?.trim();
  return {
    primaryModel,
    alternateModel:
      alternateModel && alternateModel.length > 0
        ? alternateModel
        : opts.primaryModel?.trim()
          ? primaryModel
          : defaultQaModelForMode(opts.providerMode, true),
  };
}

function parseQaThinkingLevel(
  label: string,
  value: string | undefined,
): QaThinkingLevel | undefined {
  if (value === undefined) {
    return undefined;
  }
  const normalized = normalizeQaThinkingLevel(value);
  if (!normalized) {
    throw new Error(
      `${label} must be one of off, minimal, low, medium, high, xhigh, adaptive, max`,
    );
  }
  return normalized;
}

function parseQaModelThinkingOverrides(entries: readonly string[] | undefined) {
  const overrides: Record<string, QaThinkingLevel> = {};
  for (const entry of entries ?? []) {
    const separatorIndex = entry.lastIndexOf("=");
    if (separatorIndex <= 0 || separatorIndex === entry.length - 1) {
      throw new Error(`--model-thinking must use provider/model=level, got "${entry}"`);
    }
    const model = entry.slice(0, separatorIndex).trim();
    const level = parseQaThinkingLevel("--model-thinking", entry.slice(separatorIndex + 1).trim());
    if (!model || !level) {
      throw new Error(`--model-thinking must use provider/model=level, got "${entry}"`);
    }
    overrides[model] = level;
  }
  return Object.keys(overrides).length > 0 ? overrides : undefined;
}

function parseQaBooleanModelOption(label: string, value: string) {
  switch (value.trim().toLowerCase()) {
    case "1":
    case "on":
    case "true":
    case "yes":
      return true;
    case "0":
    case "false":
    case "no":
    case "off":
      return false;
    default:
      throw new Error(`${label} fast must be one of true, false, on, off, yes, no, 1, 0`);
  }
}

function parseQaPositiveIntegerOption(label: string, value: number | undefined) {
  if (value === undefined) {
    return undefined;
  }
  if (!Number.isFinite(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return Math.floor(value);
}

async function readQaFailedScenarioCountFromSummary(summaryPath: string) {
  let summaryText: string;
  try {
    summaryText = await fs.readFile(summaryPath, "utf8");
  } catch (error) {
    throw new Error(
      `Could not read QA summary JSON at ${summaryPath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  let payload: unknown;
  try {
    payload = JSON.parse(summaryText) as unknown;
  } catch (error) {
    throw new Error(
      `Could not parse QA summary JSON at ${summaryPath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  const failedScenarioCount = readQaSuiteFailedScenarioCountFromSummary(payload);
  if (failedScenarioCount !== null) {
    return failedScenarioCount;
  }
  throw new Error(
    `QA summary at ${summaryPath} did not include counts.failed or scenarios[].status.`,
  );
}

function isQaSuiteInfraRetryableError(error: unknown) {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes("agent.wait timeout") ||
    message.includes("qa cli timed out") ||
    message.includes("readyz") ||
    message.includes("gateway healthy") ||
    message.includes("transport ready") ||
    message.includes("waiting for qa-channel ready") ||
    message.includes("econnreset") ||
    message.includes("econnrefused") ||
    message.includes("socket hang up") ||
    message.includes("could not read qa summary json") ||
    message.includes("could not parse qa summary json") ||
    message.includes("did not include counts.failed or scenarios[].status") ||
    message.includes("did not produce report artifact")
  );
}

async function assertQaSuiteArtifacts(result: { reportPath: string; summaryPath: string }) {
  try {
    await fs.access(result.reportPath);
  } catch (error) {
    throw new Error(
      `QA suite did not produce report artifact at ${result.reportPath}: ${formatErrorMessage(error)}`,
      { cause: error },
    );
  }
  await readQaFailedScenarioCountFromSummary(result.summaryPath);
}

async function runQaSuiteFromRuntimeWithInfraRetry(
  params: Parameters<typeof runQaSuiteFromRuntime>[0],
  maxRetries = QA_SUITE_INFRA_RETRY_LIMIT,
) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      const result = await runQaSuiteFromRuntime(params);
      await assertQaSuiteArtifacts(result);
      return result;
    } catch (error) {
      const retryable = isQaSuiteInfraRetryableError(error);
      if (!retryable || attempt >= maxRetries) {
        throw error;
      }
      process.stderr.write(
        `[qa-suite] infra retry ${attempt + 1}/${maxRetries}: ${formatErrorMessage(error)}\n`,
      );
    }
  }
  throw new Error("unreachable qa suite retry state");
}

async function runQaParityPreflight(params: {
  repoRoot: string;
  transportId: QaTransportId;
  providerMode: QaProviderMode;
  primaryModel?: string;
  alternateModel?: string;
  allowFailures?: boolean;
}) {
  const outputDir = path.join(
    params.repoRoot,
    ".artifacts",
    "qa-e2e",
    "preflight",
    `suite-${Date.now().toString(36)}`,
  );
  const result = await runQaSuiteFromRuntimeWithInfraRetry({
    repoRoot: params.repoRoot,
    outputDir,
    transportId: params.transportId,
    providerMode: params.providerMode,
    primaryModel: params.primaryModel,
    alternateModel: params.alternateModel,
    scenarioIds: ["approval-turn-tool-followthrough"],
    concurrency: 1,
  });
  process.stdout.write(`QA parity preflight watch: ${result.watchUrl}\n`);
  process.stdout.write(`QA parity preflight report: ${result.reportPath}\n`);
  process.stdout.write(`QA parity preflight summary: ${result.summaryPath}\n`);
  const failedScenarioCount = await readQaFailedScenarioCountFromSummary(result.summaryPath);
  if (failedScenarioCount > 0) {
    if (params.allowFailures === true) {
      return;
    }
    throw new Error(
      `QA parity preflight failed with ${failedScenarioCount} failing scenario${failedScenarioCount === 1 ? "" : "s"}.`,
    );
  }
}

function parseQaCliBackendAuthMode(value: string | undefined): QaCliBackendAuthMode | undefined {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  if (normalized === "auto" || normalized === "api-key" || normalized === "subscription") {
    return normalized;
  }
  throw new Error("--cli-auth-mode must be one of auto, api-key, subscription");
}

function parseQaCredentialListStatus(value: string | undefined) {
  if (value === undefined) {
    return undefined;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "active" || normalized === "disabled" || normalized === "all") {
    return normalized;
  }
  throw new Error('--status must be one of "active", "disabled", or "all".');
}

function normalizeQaCredentialAdminError(error: unknown) {
  if (error instanceof QaCredentialAdminError) {
    return {
      code: error.code,
      message: error.message,
    };
  }
  return {
    code: "UNEXPECTED_ERROR",
    message: formatErrorMessage(error),
  };
}

function writeQaCredentialCommandErrorJson(action: string, error: unknown) {
  const normalized = normalizeQaCredentialAdminError(error);
  process.stdout.write(
    `${JSON.stringify(
      {
        status: "error",
        action,
        code: normalized.code,
        message: normalized.message,
      },
      null,
      2,
    )}\n`,
  );
}

function parseQaModelSpecs(label: string, entries: readonly string[] | undefined) {
  const models: string[] = [];
  const optionsByModel: Record<string, QaCharacterModelOptions> = {};

  for (const entry of entries ?? []) {
    const parts = entry.split(",").map((part) => part.trim());
    const model = parts[0];
    if (!model) {
      throw new Error(`${label} must start with provider/model, got "${entry}"`);
    }
    models.push(model);
    const options: QaCharacterModelOptions = {};
    for (const part of parts.slice(1)) {
      if (!part) {
        throw new Error(`${label} option cannot be empty in "${entry}"`);
      }
      if (part === "fast") {
        options.fastMode = true;
        continue;
      }
      if (part === "no-fast") {
        options.fastMode = false;
        continue;
      }
      const separatorIndex = part.indexOf("=");
      if (separatorIndex <= 0 || separatorIndex === part.length - 1) {
        throw new Error(
          `${label} options must be thinking=<level>, fast, no-fast, or fast=<boolean>, got "${part}"`,
        );
      }
      const key = part.slice(0, separatorIndex).trim();
      const value = part.slice(separatorIndex + 1).trim();
      switch (key) {
        case "thinking": {
          const thinkingDefault = parseQaThinkingLevel(`${label} thinking`, value);
          if (!thinkingDefault) {
            throw new Error(
              `${label} thinking must be one of off, minimal, low, medium, high, xhigh, adaptive, max`,
            );
          }
          options.thinkingDefault = thinkingDefault;
          break;
        }
        case "fast":
          options.fastMode = parseQaBooleanModelOption(label, value);
          break;
        default:
          throw new Error(`${label} does not support option "${key}" in "${entry}"`);
      }
    }
    if (Object.keys(options).length > 0) {
      optionsByModel[model] = { ...optionsByModel[model], ...options };
    }
  }

  return {
    models,
    optionsByModel: Object.keys(optionsByModel).length > 0 ? optionsByModel : undefined,
  };
}

async function runInterruptibleServer(label: string, server: InterruptibleServer) {
  process.stdout.write(`${label}: ${server.baseUrl}\n`);
  process.stdout.write("Press Ctrl+C to stop.\n");

  const shutdown = async () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    await server.stop();
    process.exit(0);
  };

  const onSignal = () => {
    void shutdown();
  };

  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  await new Promise(() => undefined);
}

async function readQaCredentialPayloadFile(filePath: string) {
  const text = await fs.readFile(filePath, "utf8");
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`Payload file must contain valid JSON: ${formatErrorMessage(error)}`, {
      cause: error,
    });
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Payload file JSON must be an object.");
  }
  return payload as Record<string, unknown>;
}

function formatQaCredentialLeaseState(credential: QaCredentialRecord) {
  if (!credential.lease) {
    return "no";
  }
  return `yes(${credential.lease.actorRole}:${credential.lease.ownerId})`;
}

function printQaCredentialListTable(credentials: QaCredentialRecord[]) {
  if (credentials.length === 0) {
    process.stdout.write("No credentials matched.\n");
    return;
  }
  const rows = credentials.map((credential) => ({
    credentialId: credential.credentialId,
    kind: credential.kind,
    status: credential.status,
    leased: formatQaCredentialLeaseState(credential),
    note: credential.note ?? "",
  }));
  const idWidth = Math.max("credentialId".length, ...rows.map((row) => row.credentialId.length));
  const kindWidth = Math.max("kind".length, ...rows.map((row) => row.kind.length));
  const statusWidth = Math.max("status".length, ...rows.map((row) => row.status.length));
  const leaseWidth = Math.max("leased".length, ...rows.map((row) => row.leased.length));
  process.stdout.write(
    `${"credentialId".padEnd(idWidth)}  ${"kind".padEnd(kindWidth)}  ${"status".padEnd(statusWidth)}  ${"leased".padEnd(leaseWidth)}  note\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `${row.credentialId.padEnd(idWidth)}  ${row.kind.padEnd(kindWidth)}  ${row.status.padEnd(statusWidth)}  ${row.leased.padEnd(leaseWidth)}  ${row.note}\n`,
    );
  }
}

export async function runQaLabSelfCheckCommand(opts: { repoRoot?: string; output?: string }) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const server = await startQaLabServer({
    repoRoot,
    outputPath: opts.output ? path.resolve(repoRoot, opts.output) : undefined,
  });
  try {
    const result = await server.runSelfCheck();
    process.stdout.write(`QA self-check report: ${result.outputPath}\n`);
  } finally {
    await server.stop();
  }
}

export async function runQaSuiteCommand(opts: {
  repoRoot?: string;
  outputDir?: string;
  transportId?: string;
  runner?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  thinking?: string;
  cliAuthMode?: string;
  parityPack?: string;
  scenarioIds?: string[];
  concurrency?: number;
  allowFailures?: boolean;
  image?: string;
  cpus?: number;
  memory?: string;
  disk?: string;
  preflight?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const transportId = normalizeQaTransportId(opts.transportId);
  const runner = (opts.runner ?? "host").trim().toLowerCase();
  const scenarioIds = resolveQaParityPackScenarioIds({
    parityPack: opts.parityPack,
    scenarioIds: opts.scenarioIds,
  });
  const allowFailures = opts.allowFailures === true;
  if (runner !== "host" && runner !== "multipass") {
    throw new Error(`--runner must be one of host or multipass, got "${opts.runner}".`);
  }
  const providerMode = normalizeQaProviderMode(opts.providerMode);
  const claudeCliAuthMode = parseQaCliBackendAuthMode(opts.cliAuthMode);
  if (opts.preflight === true && runner !== "host") {
    throw new Error("--preflight requires --runner host.");
  }
  if (
    runner === "host" &&
    (opts.image !== undefined ||
      opts.cpus !== undefined ||
      opts.memory !== undefined ||
      opts.disk !== undefined)
  ) {
    throw new Error("--image, --cpus, --memory, and --disk require --runner multipass.");
  }
  if (runner === "multipass" && opts.cliAuthMode !== undefined) {
    throw new Error("--cli-auth-mode requires --runner host.");
  }
  if (runner === "multipass") {
    const thinkingDefault = parseQaThinkingLevel("--thinking", opts.thinking);
    const result = await runQaMultipass({
      repoRoot,
      outputDir: resolveRepoRelativeOutputDir(repoRoot, opts.outputDir),
      transportId,
      providerMode,
      primaryModel: opts.primaryModel,
      alternateModel: opts.alternateModel,
      fastMode: opts.fastMode,
      ...(thinkingDefault ? { thinkingDefault } : {}),
      allowFailures: true,
      scenarioIds,
      ...(opts.concurrency !== undefined
        ? { concurrency: parseQaPositiveIntegerOption("--concurrency", opts.concurrency) }
        : {}),
      image: opts.image,
      cpus: parseQaPositiveIntegerOption("--cpus", opts.cpus),
      memory: opts.memory,
      disk: opts.disk,
    });
    process.stdout.write(`QA Multipass dir: ${result.outputDir}\n`);
    process.stdout.write(`QA Multipass report: ${result.reportPath}\n`);
    process.stdout.write(`QA Multipass summary: ${result.summaryPath}\n`);
    process.stdout.write(`QA Multipass host log: ${result.hostLogPath}\n`);
    process.stdout.write(`QA Multipass bootstrap log: ${result.bootstrapLogPath}\n`);
    if (!allowFailures) {
      const failedScenarioCount = await readQaFailedScenarioCountFromSummary(result.summaryPath);
      if (failedScenarioCount > 0) {
        process.exitCode = 1;
      }
    }
    return;
  }
  if (opts.preflight === true) {
    await runQaParityPreflight({
      repoRoot,
      transportId,
      providerMode,
      primaryModel: opts.primaryModel,
      alternateModel: opts.alternateModel,
      allowFailures,
    });
    return;
  }
  const thinkingDefault = parseQaThinkingLevel("--thinking", opts.thinking);
  const result = await runQaSuiteFromRuntimeWithInfraRetry({
    repoRoot,
    outputDir: resolveRepoRelativeOutputDir(repoRoot, opts.outputDir),
    transportId,
    providerMode,
    primaryModel: opts.primaryModel,
    alternateModel: opts.alternateModel,
    fastMode: opts.fastMode,
    ...(thinkingDefault ? { thinkingDefault } : {}),
    ...(claudeCliAuthMode ? { claudeCliAuthMode } : {}),
    scenarioIds,
    ...(opts.concurrency !== undefined
      ? { concurrency: parseQaPositiveIntegerOption("--concurrency", opts.concurrency) }
      : {}),
  });
  process.stdout.write(`QA suite watch: ${result.watchUrl}\n`);
  process.stdout.write(`QA suite report: ${result.reportPath}\n`);
  process.stdout.write(`QA suite summary: ${result.summaryPath}\n`);
  const failedScenarioCount = readQaSuiteFailedScenarioCountFromSummary(result);
  if (!allowFailures && failedScenarioCount !== null && failedScenarioCount > 0) {
    process.exitCode = 1;
  }
}

export async function runQaParityReportCommand(opts: {
  repoRoot?: string;
  candidateSummary: string;
  baselineSummary: string;
  candidateLabel?: string;
  baselineLabel?: string;
  outputDir?: string;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir =
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `parity-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const candidateSummaryPath = path.resolve(repoRoot, opts.candidateSummary);
  const baselineSummaryPath = path.resolve(repoRoot, opts.baselineSummary);
  const candidateSummary = JSON.parse(
    await fs.readFile(candidateSummaryPath, "utf8"),
  ) as QaParitySuiteSummary;
  const baselineSummary = JSON.parse(
    await fs.readFile(baselineSummaryPath, "utf8"),
  ) as QaParitySuiteSummary;

  const comparison = buildQaAgenticParityComparison({
    candidateLabel: opts.candidateLabel?.trim() || QA_FRONTIER_PARITY_CANDIDATE_LABEL,
    baselineLabel: opts.baselineLabel?.trim() || QA_FRONTIER_PARITY_BASELINE_LABEL,
    candidateSummary,
    baselineSummary,
  });
  const report = renderQaAgenticParityMarkdownReport(comparison);
  const reportPath = path.join(outputDir, "qa-agentic-parity-report.md");
  const summaryPath = path.join(outputDir, "qa-agentic-parity-summary.json");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(comparison, null, 2)}\n`, "utf8");

  process.stdout.write(`QA parity report: ${reportPath}\n`);
  process.stdout.write(`QA parity summary: ${summaryPath}\n`);
  process.stdout.write(`QA parity verdict: ${comparison.pass ? "pass" : "fail"}\n`);
  if (!comparison.pass) {
    process.exitCode = 1;
  }
}

export async function runQaCoverageReportCommand(opts: {
  repoRoot?: string;
  output?: string;
  json?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const inventory = buildQaCoverageInventory(readQaScenarioPack().scenarios);
  const outputPath = opts.output ? path.resolve(repoRoot, opts.output) : undefined;
  const body = opts.json
    ? `${JSON.stringify(inventory, null, 2)}\n`
    : renderQaCoverageMarkdownReport(inventory);

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, body, "utf8");
    process.stdout.write(`QA coverage report: ${outputPath}\n`);
    return;
  }

  process.stdout.write(body);
}

export async function runQaCharacterEvalCommand(opts: {
  repoRoot?: string;
  outputDir?: string;
  model?: string[];
  scenario?: string;
  fast?: boolean;
  thinking?: string;
  modelThinking?: string[];
  judgeModel?: string[];
  judgeTimeoutMs?: number;
  blindJudgeModels?: boolean;
  concurrency?: number;
  judgeConcurrency?: number;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const candidates = parseQaModelSpecs("--model", opts.model);
  const judges = parseQaModelSpecs("--judge-model", opts.judgeModel);
  const result = await runQaCharacterEval({
    repoRoot,
    outputDir: resolveRepoRelativeOutputDir(repoRoot, opts.outputDir),
    models: candidates.models,
    scenarioId: opts.scenario,
    candidateFastMode: opts.fast,
    candidateThinkingDefault: parseQaThinkingLevel("--thinking", opts.thinking),
    candidateThinkingByModel: parseQaModelThinkingOverrides(opts.modelThinking),
    candidateModelOptions: candidates.optionsByModel,
    judgeModels: judges.models.length > 0 ? judges.models : undefined,
    judgeModelOptions: judges.optionsByModel,
    judgeTimeoutMs: opts.judgeTimeoutMs,
    judgeBlindModels: opts.blindJudgeModels === true ? true : undefined,
    candidateConcurrency: parseQaPositiveIntegerOption("--concurrency", opts.concurrency),
    judgeConcurrency: parseQaPositiveIntegerOption("--judge-concurrency", opts.judgeConcurrency),
    progress: (message) => process.stderr.write(`${message}\n`),
  });
  process.stdout.write(`QA character eval report: ${result.reportPath}\n`);
  process.stdout.write(`QA character eval summary: ${result.summaryPath}\n`);
}

export async function runQaManualLaneCommand(opts: {
  repoRoot?: string;
  transportId?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  message: string;
  timeoutMs?: number;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const transportId = normalizeQaTransportId(opts.transportId);
  const providerMode: QaProviderMode =
    opts.providerMode === undefined
      ? DEFAULT_QA_LIVE_PROVIDER_MODE
      : normalizeQaProviderMode(opts.providerMode);
  const models = resolveQaManualLaneModels({
    providerMode,
    primaryModel: opts.primaryModel,
    alternateModel: opts.alternateModel,
  });
  const result = await runQaManualLane({
    repoRoot,
    transportId,
    providerMode,
    primaryModel: models.primaryModel,
    alternateModel: models.alternateModel,
    fastMode: opts.fastMode,
    message: opts.message,
    timeoutMs: opts.timeoutMs,
  });
  process.stdout.write(JSON.stringify(result, null, 2));
  process.stdout.write("\n");
}

export async function runQaCredentialsAddCommand(opts: {
  actorId?: string;
  endpointPrefix?: string;
  json?: boolean;
  kind: string;
  note?: string;
  payloadFile: string;
  repoRoot?: string;
  siteUrl?: string;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  try {
    const payloadPath = path.resolve(repoRoot, opts.payloadFile);
    const payload = await readQaCredentialPayloadFile(payloadPath);
    const result = await addQaCredentialSet({
      kind: opts.kind,
      payload,
      note: opts.note,
      actorId: opts.actorId,
      siteUrl: opts.siteUrl,
      endpointPrefix: opts.endpointPrefix,
    });
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ status: "ok", action: "add", credential: result.credential }, null, 2)}\n`,
      );
      return;
    }
    process.stdout.write(`QA credential added: ${result.credential.credentialId}\n`);
    process.stdout.write(`Kind: ${result.credential.kind}\n`);
    process.stdout.write(`Status: ${result.credential.status}\n`);
    if (result.credential.note) {
      process.stdout.write(`Note: ${result.credential.note}\n`);
    }
  } catch (error) {
    if (opts.json) {
      writeQaCredentialCommandErrorJson("add", error);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

export async function runQaCredentialsRemoveCommand(opts: {
  actorId?: string;
  credentialId: string;
  endpointPrefix?: string;
  json?: boolean;
  siteUrl?: string;
}) {
  try {
    const result = await removeQaCredentialSet({
      credentialId: opts.credentialId,
      actorId: opts.actorId,
      siteUrl: opts.siteUrl,
      endpointPrefix: opts.endpointPrefix,
    });
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "ok",
            action: "remove",
            changed: result.changed,
            credential: result.credential,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    process.stdout.write(
      result.changed
        ? `QA credential removed (disabled): ${result.credential.credentialId}\n`
        : `QA credential already disabled: ${result.credential.credentialId}\n`,
    );
  } catch (error) {
    if (opts.json) {
      writeQaCredentialCommandErrorJson("remove", error);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

export async function runQaCredentialsListCommand(opts: {
  actorId?: string;
  endpointPrefix?: string;
  json?: boolean;
  kind?: string;
  limit?: number;
  showSecrets?: boolean;
  siteUrl?: string;
  status?: string;
}) {
  try {
    const result = await listQaCredentialSets({
      actorId: opts.actorId,
      siteUrl: opts.siteUrl,
      endpointPrefix: opts.endpointPrefix,
      kind: opts.kind?.trim(),
      status: parseQaCredentialListStatus(opts.status),
      includePayload: opts.showSecrets,
      limit: parseQaPositiveIntegerOption("--limit", opts.limit),
    });
    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify(
          {
            status: "ok",
            action: "list",
            count: result.credentials.length,
            credentials: result.credentials,
          },
          null,
          2,
        )}\n`,
      );
      return;
    }
    printQaCredentialListTable(result.credentials);
    if (opts.showSecrets && result.credentials.length > 0) {
      process.stdout.write("\nPayloads:\n");
      for (const credential of result.credentials) {
        process.stdout.write(
          `${credential.credentialId}: ${JSON.stringify(credential.payload ?? null)}\n`,
        );
      }
    }
  } catch (error) {
    if (opts.json) {
      writeQaCredentialCommandErrorJson("list", error);
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

export async function runQaLabUiCommand(opts: {
  repoRoot?: string;
  host?: string;
  port?: number;
  advertiseHost?: string;
  advertisePort?: number;
  controlUiUrl?: string;
  controlUiToken?: string;
  controlUiProxyTarget?: string;
  uiDistDir?: string;
  autoKickoffTarget?: string;
  embeddedGateway?: string;
  sendKickoffOnStart?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const server = await startQaLabServer({
    repoRoot,
    host: opts.host,
    port: Number.isFinite(opts.port) ? opts.port : undefined,
    advertiseHost: opts.advertiseHost,
    advertisePort: Number.isFinite(opts.advertisePort) ? opts.advertisePort : undefined,
    controlUiUrl: opts.controlUiUrl,
    controlUiToken: opts.controlUiToken,
    controlUiProxyTarget: opts.controlUiProxyTarget,
    uiDistDir: opts.uiDistDir,
    autoKickoffTarget: opts.autoKickoffTarget,
    embeddedGateway: opts.embeddedGateway,
    sendKickoffOnStart: opts.sendKickoffOnStart,
  });
  await runInterruptibleServer("QA Lab UI", server);
}

export async function runQaDockerScaffoldCommand(opts: {
  repoRoot?: string;
  outputDir: string;
  gatewayPort?: number;
  qaLabPort?: number;
  providerBaseUrl?: string;
  image?: string;
  usePrebuiltImage?: boolean;
  bindUiDist?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir = resolveRepoRelativeOutputDir(repoRoot, opts.outputDir);
  if (!outputDir) {
    throw new Error("--output-dir is required.");
  }
  const result = await writeQaDockerHarnessFiles({
    outputDir,
    repoRoot,
    gatewayPort: Number.isFinite(opts.gatewayPort) ? opts.gatewayPort : undefined,
    qaLabPort: Number.isFinite(opts.qaLabPort) ? opts.qaLabPort : undefined,
    providerBaseUrl: opts.providerBaseUrl,
    imageName: opts.image,
    usePrebuiltImage: opts.usePrebuiltImage,
    bindUiDist: opts.bindUiDist,
  });
  process.stdout.write(`QA docker scaffold: ${result.outputDir}\n`);
}

export async function runQaDockerBuildImageCommand(opts: { repoRoot?: string; image?: string }) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const result = await buildQaDockerHarnessImage({
    repoRoot,
    imageName: opts.image,
  });
  process.stdout.write(`QA docker image: ${result.imageName}\n`);
}

export async function runQaDockerUpCommand(opts: {
  repoRoot?: string;
  outputDir?: string;
  gatewayPort?: number;
  qaLabPort?: number;
  providerBaseUrl?: string;
  image?: string;
  usePrebuiltImage?: boolean;
  bindUiDist?: boolean;
  skipUiBuild?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const result = await runQaDockerUp({
    repoRoot,
    outputDir: resolveRepoRelativeOutputDir(repoRoot, opts.outputDir),
    gatewayPort: Number.isFinite(opts.gatewayPort) ? opts.gatewayPort : undefined,
    qaLabPort: Number.isFinite(opts.qaLabPort) ? opts.qaLabPort : undefined,
    providerBaseUrl: opts.providerBaseUrl,
    image: opts.image,
    usePrebuiltImage: opts.usePrebuiltImage,
    bindUiDist: opts.bindUiDist,
    skipUiBuild: opts.skipUiBuild,
  });
  process.stdout.write(`QA docker dir: ${result.outputDir}\n`);
  process.stdout.write(`QA Lab UI: ${result.qaLabUrl}\n`);
  process.stdout.write(`Gateway UI: ${result.gatewayUrl}\n`);
  process.stdout.write(`Stop: ${result.stopCommand}\n`);
}

export async function runQaProviderServerCommand(
  providerMode: QaProviderMode,
  opts: { host?: string; port?: number },
) {
  const provider = getQaProvider(providerMode);
  const standaloneCommand = provider.standaloneCommand;
  if (!standaloneCommand) {
    throw new Error(`QA provider "${providerMode}" does not expose a standalone server command.`);
  }
  const server = await startQaProviderServer(providerMode, {
    host: opts.host,
    port: Number.isFinite(opts.port) ? opts.port : undefined,
  });
  if (!server) {
    throw new Error(`QA provider "${providerMode}" does not expose a standalone server command.`);
  }
  await runInterruptibleServer(standaloneCommand.serverLabel, server);
}

export const __testing = {
  resolveRepoRelativeOutputDir,
};
