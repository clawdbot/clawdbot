import fs from "node:fs/promises";
import path from "node:path";
import {
  buildQaAgenticParityComparison,
  renderQaAgenticParityMarkdownReport,
  type QaParitySuiteSummary,
} from "./agentic-parity-report.js";
import { resolveQaParityPackScenarioIds } from "./agentic-parity.js";
import { runQaCharacterEval, type QaCharacterModelOptions } from "./character-eval.js";
import { resolveRepoRelativeOutputDir } from "./cli-paths.js";
import { buildQaDockerHarnessImage, writeQaDockerHarnessFiles } from "./docker-harness.js";
import { runQaDockerUp } from "./docker-up.runtime.js";
import type { QaCliBackendAuthMode } from "./gateway-child.js";
import { startQaLabServer } from "./lab-server.js";
import { runQaManualLane } from "./manual-lane.runtime.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import { runQaMultipass } from "./multipass.runtime.js";
import { normalizeQaThinkingLevel, type QaThinkingLevel } from "./qa-gateway-config.js";
import { normalizeQaTransportId } from "./qa-transport-registry.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderMode,
  type QaProviderModeInput,
} from "./run-config.js";
import { runQaSuiteFromRuntime } from "./suite-launch.runtime.js";

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
    throw new Error(`${label} must be one of off, minimal, low, medium, high, xhigh, adaptive`);
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
              `${label} thinking must be one of off, minimal, low, medium, high, xhigh, adaptive`,
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
  cliAuthMode?: string;
  parityPack?: string;
  scenarioIds?: string[];
  concurrency?: number;
  image?: string;
  cpus?: number;
  memory?: string;
  disk?: string;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const transportId = normalizeQaTransportId(opts.transportId);
  const runner = (opts.runner ?? "host").trim().toLowerCase();
  const scenarioIds = resolveQaParityPackScenarioIds({
    parityPack: opts.parityPack,
    scenarioIds: opts.scenarioIds,
  });
  if (runner !== "host" && runner !== "multipass") {
    throw new Error(`--runner must be one of host or multipass, got "${opts.runner}".`);
  }
  const providerMode = normalizeQaProviderMode(opts.providerMode);
  const claudeCliAuthMode = parseQaCliBackendAuthMode(opts.cliAuthMode);
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
    const result = await runQaMultipass({
      repoRoot,
      outputDir: resolveRepoRelativeOutputDir(repoRoot, opts.outputDir),
      transportId,
      providerMode,
      primaryModel: opts.primaryModel,
      alternateModel: opts.alternateModel,
      fastMode: opts.fastMode,
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
    return;
  }
  const result = await runQaSuiteFromRuntime({
    repoRoot,
    outputDir: resolveRepoRelativeOutputDir(repoRoot, opts.outputDir),
    transportId,
    providerMode,
    primaryModel: opts.primaryModel,
    alternateModel: opts.alternateModel,
    fastMode: opts.fastMode,
    ...(claudeCliAuthMode ? { claudeCliAuthMode } : {}),
    scenarioIds,
    ...(opts.concurrency !== undefined
      ? { concurrency: parseQaPositiveIntegerOption("--concurrency", opts.concurrency) }
      : {}),
  });
  process.stdout.write(`QA suite watch: ${result.watchUrl}\n`);
  process.stdout.write(`QA suite report: ${result.reportPath}\n`);
  process.stdout.write(`QA suite summary: ${result.summaryPath}\n`);
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
    candidateLabel: opts.candidateLabel?.trim() || "openai/gpt-5.4",
    baselineLabel: opts.baselineLabel?.trim() || "anthropic/claude-opus-4-6",
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
    opts.providerMode === undefined ? "live-frontier" : normalizeQaProviderMode(opts.providerMode);
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

export async function runQaMockOpenAiCommand(opts: { host?: string; port?: number }) {
  const server = await startQaMockOpenAiServer({
    host: opts.host,
    port: Number.isFinite(opts.port) ? opts.port : undefined,
  });
  await runInterruptibleServer("QA mock OpenAI", server);
}

export const __testing = {
  resolveRepoRelativeOutputDir,
};
