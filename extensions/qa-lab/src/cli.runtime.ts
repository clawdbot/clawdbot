// Qa Lab plugin module implements cli behavior.
import fs from "node:fs/promises";
import path from "node:path";
import {
  OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
  resolveOpenClawCrablineChannelDriverSelection,
} from "@openclaw/crabline";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildQaAgenticParityComparison,
  buildQaRuntimeParityReport,
  renderQaAgenticParityMarkdownReport,
  renderQaRuntimeParityMarkdownReport,
  type QaParitySuiteSummary,
  type QaRuntimeParitySuiteSummary,
} from "./agentic-parity-report.js";
import { resolveQaParityPackScenarioIds } from "./agentic-parity.js";
import { createQaArtifactRunId } from "./artifact-run-id.js";
import { runQaCharacterEval, type QaCharacterModelOptions } from "./character-eval.js";
import { resolveRepoRelativeOutputDir } from "./cli-paths.js";
import {
  buildQaConfidenceReport,
  readQaConfidenceManifestFile,
  renderQaConfidenceMarkdownReport,
  writeQaConfidenceSelfTestArtifacts,
} from "./confidence-report.js";
import {
  buildQaCoverageInventory,
  findQaScenarioMatches,
  renderQaCoverageMarkdownReport,
  renderQaScenarioMatchesMarkdownReport,
} from "./coverage-report.js";
import { buildQaDockerHarnessImage, writeQaDockerHarnessFiles } from "./docker-harness.js";
import { runQaDockerUp } from "./docker-up.runtime.js";
import { QaSuiteArtifactError, QaSuiteInfraError } from "./errors.js";
import type { QaCliBackendAuthMode } from "./gateway-child.js";
import {
  createMockJsonlReplayCellRunner,
  renderJsonlReplayMarkdownReport,
  runJsonlReplay,
  type JsonlReplayInput,
} from "./jsonl-replay.js";
import { startQaLabServer } from "./lab-server.js";
import { listLiveTransportQaAdapterFactories } from "./live-transports/cli.js";
import { loadNonYamlScenarioRefs } from "./live-transports/shared/live-transport-scenarios.js";
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
  diagnoseQaCredentialBroker,
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
import type { RuntimeId } from "./runtime-parity.js";
import {
  QA_RUNTIME_PARITY_TIERS,
  readQaScenarioPack,
  type QaRuntimeParityTier,
} from "./scenario-catalog.js";
import { resolveQaScenarioPackScenarioIds } from "./scenario-packs.js";
import { attachQaProfileScorecardEvidenceToFile } from "./scorecard-evidence.js";
import {
  qaScorecardChannelDriverSchema,
  readQaScorecardTaxonomyReport,
  type QaScorecardCategoryCoverageReport,
  type QaScorecardChannelDriver,
  type QaScorecardEvidenceMode,
} from "./scorecard-taxonomy.js";
import { isQaSelfCheckSuccessful } from "./self-check.js";
import { runQaFlowSuiteFromRuntime, runQaSuite } from "./suite-launch.runtime.js";
import {
  resolveQaSuiteScenarioChannel,
  resolveQaSuiteScenarioChannels,
  scenarioMatchesQaProviderLane,
} from "./suite-planning.js";
import { readQaSuiteFailedOrSkippedScenarioCountFromFile } from "./suite-summary.js";
import {
  buildTokenEfficiencyReport,
  renderTokenEfficiencyMarkdownReport,
  type TokenEfficiencySuiteSummary,
} from "./token-efficiency-report.js";
import {
  buildQaToolCoverageReport,
  renderQaToolCoverageMarkdownReport,
  type QaToolCoverageSuiteSummary,
} from "./tool-coverage-report.js";

const QA_SUITE_INFRA_RETRY_LIMIT = 1;
const QA_CREDENTIAL_PAYLOAD_MAX_BYTES_ENV = "OPENCLAW_QA_CREDENTIAL_PAYLOAD_MAX_BYTES";
const DEFAULT_QA_CREDENTIAL_PAYLOAD_MAX_BYTES = 64 * 1024 * 1024;
const QA_SUITE_INFRA_RETRY_NETWORK_ERROR_CODES = new Set([
  "ECONNRESET",
  "ECONNREFUSED",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_SOCKET",
]);

type InterruptibleServer = {
  baseUrl: string;
  stop(): Promise<void>;
};

export type QaLabSelfCheckCommandOptions = {
  repoRoot?: string;
  output?: string;
};

type QaScenarioProviderCommandOptions = {
  transportId?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
};

type QaScenarioRunCommandOptions = QaScenarioProviderCommandOptions & {
  evidenceMode?: QaScorecardEvidenceMode;
  repoRoot?: string;
  outputDir?: string;
  concurrency?: number;
  allowFailures?: boolean;
};

export type QaProfileCommandOptions = QaScenarioRunCommandOptions & {
  profile: string;
  surface?: string;
  category?: string;
  scenarioIds?: string[];
};

export type QaSuiteCommandOptions = QaScenarioRunCommandOptions & {
  channelDriver?: string;
  channel?: string;
  runner?: string;
  thinking?: string;
  cliAuthMode?: string;
  parityPack?: string;
  pack?: string;
  scenarioIds?: string[];
  enabledPluginIds?: string[];
  image?: string;
  cpus?: number;
  memory?: string;
  disk?: string;
  preflight?: boolean;
  runtimePair?: string;
  runtimeParityTier?: string[];
};

function normalizeQaSuiteChannelDriver(
  input?: string | null,
): QaScorecardChannelDriver | undefined {
  const normalized = input?.trim().toLowerCase();
  if (!normalized) {
    return undefined;
  }
  const parsed = qaScorecardChannelDriverSchema.safeParse(normalized);
  if (parsed.success) {
    return parsed.data;
  }
  throw new Error(`--channel-driver must be one of qa-channel, crabline, or live, got "${input}".`);
}

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
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeQaOptionalModelRef(input: string | undefined) {
  const model = input?.trim();
  return model && model.length > 0 ? model : undefined;
}

function normalizeQaRuntimeId(value: string): RuntimeId | undefined {
  if (value === "openclaw" || value === "pi") {
    return "openclaw";
  }
  if (value === "codex") {
    return "codex";
  }
  return undefined;
}

function parseQaRuntimePair(value: string | undefined): [RuntimeId, RuntimeId] | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const runtimes = value
    .split(",")
    .map((part) => part.trim().toLowerCase())
    .filter(Boolean)
    .map(normalizeQaRuntimeId);
  if (runtimes.length !== 2) {
    throw new Error('--runtime-pair must use exactly two runtimes, e.g. "openclaw,codex".');
  }
  const [left, right] = runtimes;
  if (!left || !right) {
    throw new Error('--runtime-pair only supports "openclaw" and "codex".');
  }
  if (left === right) {
    throw new Error("--runtime-pair must compare two different runtimes.");
  }
  return ["openclaw", "codex"];
}

function parseQaRuntimeParityTierFilters(input: string[] | undefined): QaRuntimeParityTier[] {
  const rawValues = [
    ...new Set(
      (input ?? [])
        .flatMap((value) => value.split(","))
        .map((value) => value.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
  const validTiers = new Set<string>(QA_RUNTIME_PARITY_TIERS);
  for (const value of rawValues) {
    if (!validTiers.has(value)) {
      throw new Error(
        `--runtime-parity-tier must be one of ${QA_RUNTIME_PARITY_TIERS.join(", ")}, got "${value}".`,
      );
    }
  }
  return rawValues as QaRuntimeParityTier[];
}

function resolveQaRuntimeParityTierScenarioIds(params: {
  scenarioIds: string[];
  runtimeParityTiers: readonly QaRuntimeParityTier[];
  runtimePair: boolean;
}): { scenarioIds: string[]; excludedNonFlowScenarios: string[] } {
  if (params.runtimeParityTiers.length === 0) {
    return { scenarioIds: params.scenarioIds, excludedNonFlowScenarios: [] };
  }
  const tierSet = new Set(params.runtimeParityTiers);
  const matchingScenarios = readQaScenarioPack().scenarios.filter(
    (scenario) => scenario.runtimeParityTier && tierSet.has(scenario.runtimeParityTier),
  );
  if (matchingScenarios.length === 0) {
    throw new Error(
      `--runtime-parity-tier matched no scenarios for ${params.runtimeParityTiers.join(", ")}.`,
    );
  }
  const compatibleScenarios = params.runtimePair
    ? matchingScenarios.filter((scenario) => scenario.execution.kind === "flow")
    : matchingScenarios;
  const excludedNonFlowScenarios = params.runtimePair
    ? matchingScenarios
        .filter((scenario) => scenario.execution.kind !== "flow")
        .map((scenario) => `${scenario.id} (${scenario.execution.kind})`)
    : [];
  if (compatibleScenarios.length === 0) {
    throw new Error(
      `--runtime-parity-tier matched no execution.kind: flow scenarios for ${params.runtimeParityTiers.join(", ")}; incompatible scenario(s): ${excludedNonFlowScenarios.join(", ")}.`,
    );
  }
  return {
    scenarioIds: uniqueStrings([
      ...params.scenarioIds,
      ...compatibleScenarios.map((scenario) => scenario.id),
    ]),
    excludedNonFlowScenarios,
  };
}

function rejectNonFlowScenarioIds(params: {
  option: "--runner multipass" | "--runtime-pair";
  scenarioIds: readonly string[];
}) {
  const scenarioIds = params.scenarioIds;
  if (scenarioIds.length === 0) {
    return;
  }
  const scenarioById = new Map(
    readQaScenarioPack().scenarios.map((scenario) => [scenario.id, scenario]),
  );
  const nonFlowScenarios = scenarioIds.flatMap((scenarioId) => {
    const scenario = scenarioById.get(scenarioId);
    return scenario && scenario.execution.kind !== "flow"
      ? [`${scenario.id} (${scenario.execution.kind})`]
      : [];
  });
  if (nonFlowScenarios.length > 0) {
    throw new Error(
      `${params.option} requires execution.kind: flow scenarios; unsupported scenario(s): ${nonFlowScenarios.join(", ")}`,
    );
  }
}

function isQaSuiteInfraRetryableError(error: unknown) {
  if (error instanceof QaSuiteArtifactError || error instanceof QaSuiteInfraError) {
    return true;
  }
  return hasQaSuiteRetryableNetworkCode(error);
}

function hasQaSuiteRetryableNetworkCode(error: unknown) {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current !== "object") {
      return false;
    }
    const record = current as { cause?: unknown; code?: unknown };
    if (
      typeof record.code === "string" &&
      QA_SUITE_INFRA_RETRY_NETWORK_ERROR_CODES.has(record.code.toUpperCase())
    ) {
      return true;
    }
    current = record.cause;
  }
  return false;
}

async function runQaSuiteWithInfraRetry<Result>(
  run: () => Promise<Result>,
  maxRetries = QA_SUITE_INFRA_RETRY_LIMIT,
) {
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await run();
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
    `suite-${createQaArtifactRunId()}`,
  );
  const result = await runQaSuiteWithInfraRetry(() =>
    runQaFlowSuiteFromRuntime({
      repoRoot: params.repoRoot,
      outputDir,
      transportId: params.transportId,
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      alternateModel: params.alternateModel,
      scenarioIds: ["approval-turn-tool-followthrough"],
      concurrency: 1,
    }),
  );
  process.stdout.write(`QA parity preflight watch: ${result.watchUrl}\n`);
  process.stdout.write(`QA parity preflight report: ${result.reportPath}\n`);
  process.stdout.write(`QA parity preflight summary: ${result.summaryPath}\n`);
  const blockingScenarioCount = await readQaSuiteFailedOrSkippedScenarioCountFromFile(
    result.summaryPath,
  );
  if (blockingScenarioCount > 0) {
    if (params.allowFailures === true) {
      return;
    }
    throw new Error(
      `QA parity preflight failed with ${blockingScenarioCount} failing or skipped scenario${blockingScenarioCount === 1 ? "" : "s"}.`,
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
  await new Promise(() => {});
}

function resolveQaCredentialPayloadFileMaxBytes(env: NodeJS.ProcessEnv = process.env) {
  const raw = env[QA_CREDENTIAL_PAYLOAD_MAX_BYTES_ENV]?.trim();
  if (!raw) {
    return DEFAULT_QA_CREDENTIAL_PAYLOAD_MAX_BYTES;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined) {
    throw new Error(`${QA_CREDENTIAL_PAYLOAD_MAX_BYTES_ENV} must be a positive integer.`);
  }
  return parsed;
}

async function readQaCredentialPayloadFile(filePath: string) {
  const maxBytes = resolveQaCredentialPayloadFileMaxBytes();
  const stat = await fs.stat(filePath);
  if (!stat.isFile()) {
    throw new Error("Payload file must be a regular JSON file.");
  }
  if (stat.size > maxBytes) {
    throw new Error(
      `Payload file exceeds ${QA_CREDENTIAL_PAYLOAD_MAX_BYTES_ENV} (${maxBytes} bytes).`,
    );
  }
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
    fingerprint: credential.credentialFingerprint ?? "",
    kind: credential.kind,
    status: credential.status,
    leased: formatQaCredentialLeaseState(credential),
    note: credential.note ?? "",
  }));
  const idWidth = Math.max("credentialId".length, ...rows.map((row) => row.credentialId.length));
  const fingerprintWidth = Math.max(
    "fingerprint".length,
    ...rows.map((row) => row.fingerprint.length),
  );
  const kindWidth = Math.max("kind".length, ...rows.map((row) => row.kind.length));
  const statusWidth = Math.max("status".length, ...rows.map((row) => row.status.length));
  const leaseWidth = Math.max("leased".length, ...rows.map((row) => row.leased.length));
  process.stdout.write(
    `${"credentialId".padEnd(idWidth)}  ${"fingerprint".padEnd(fingerprintWidth)}  ${"kind".padEnd(kindWidth)}  ${"status".padEnd(statusWidth)}  ${"leased".padEnd(leaseWidth)}  note\n`,
  );
  for (const row of rows) {
    process.stdout.write(
      `${row.credentialId.padEnd(idWidth)}  ${row.fingerprint.padEnd(fingerprintWidth)}  ${row.kind.padEnd(kindWidth)}  ${row.status.padEnd(statusWidth)}  ${row.leased.padEnd(leaseWidth)}  ${row.note}\n`,
    );
  }
}

function printQaCredentialDoctorTable(
  result: Awaited<ReturnType<typeof diagnoseQaCredentialBroker>>,
) {
  process.stdout.write(`QA credentials doctor: ${result.status}\n`);
  const nameWidth = Math.max("check".length, ...result.checks.map((check) => check.name.length));
  for (const check of result.checks) {
    process.stdout.write(
      `${check.name.padEnd(nameWidth)}  ${check.status.padEnd(4)}  ${check.details ?? ""}\n`,
    );
  }
}

export async function runQaLabSelfCheckCommand(opts: QaLabSelfCheckCommandOptions) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const server = await startQaLabServer({
    repoRoot,
    outputPath: opts.output ? path.resolve(repoRoot, opts.output) : undefined,
  });
  try {
    const result = await server.runSelfCheck();
    process.stdout.write(`QA self-check report: ${result.outputPath}\n`);
    if (!isQaSelfCheckSuccessful(result)) {
      throw new Error(`QA self-check failed. See ${result.outputPath}.`);
    }
  } finally {
    await server.stop();
  }
}

export async function runQaProfileCommand(opts: QaProfileCommandOptions) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const scenarioPack = readQaScenarioPack();
  const scorecardReport = readQaScorecardTaxonomyReport(scenarioPack.scenarios);
  const profile = normalizeQaRunProfile(
    opts.profile,
    scorecardReport.profiles.map((entry) => entry.id),
  );
  const profileReport = scorecardReport.profiles.find((entry) => entry.id === profile);
  if (!profileReport) {
    throw new Error(`taxonomy.yaml does not define QA run profile ${profile}.`);
  }
  const categories = scorecardReport.categories.filter((category) =>
    qaScorecardCategoryMatchesRunProfile(category, {
      profile,
      surface: opts.surface,
      category: opts.category,
    }),
  );
  if (categories.length === 0) {
    throw new Error(formatQaRunProfileNoMatchMessage(opts));
  }

  const scenarioBySourcePath = new Map(
    scenarioPack.scenarios.map((scenario) => [scenario.sourcePath, scenario] as const),
  );
  const taxonomyScenariosForCategories = uniqueStrings(
    categories.flatMap((category) => category.scenarioRefs),
  )
    .map((scenarioRef) => scenarioBySourcePath.get(scenarioRef))
    .filter((scenario): scenario is NonNullable<typeof scenario> => scenario !== undefined);
  const requestedScenarioIds = uniqueStrings(
    (opts.scenarioIds ?? []).map((scenarioId) => scenarioId.trim()).filter(Boolean),
  );
  const taxonomyScenarios =
    requestedScenarioIds.length === 0
      ? taxonomyScenariosForCategories
      : taxonomyScenariosForCategories.filter((scenario) =>
          requestedScenarioIds.includes(scenario.id),
        );
  if (requestedScenarioIds.length > 0 && taxonomyScenarios.length === 0) {
    throw new Error(
      `qa run did not find taxonomy scenarios for ${formatQaRunProfileFilterList(opts)} --scenario ${requestedScenarioIds.join(",")}.`,
    );
  }
  const matchedScenarioIds = new Set(taxonomyScenarios.map((scenario) => scenario.id));
  const missingScenarioIds = requestedScenarioIds.filter(
    (scenarioId) => !matchedScenarioIds.has(scenarioId),
  );
  if (missingScenarioIds.length > 0) {
    throw new Error(
      `qa run did not find taxonomy scenarios for ${formatQaRunProfileFilterList(opts)} --scenario ${missingScenarioIds.join(",")}.`,
    );
  }
  const providerMode = opts.providerMode ?? defaultQaRunProfileProviderMode(profile);
  const normalizedProviderMode = normalizeQaProviderMode(providerMode);
  const primaryModel = opts.primaryModel?.trim() || defaultQaModelForMode(normalizedProviderMode);
  const scenarios = taxonomyScenarios.filter((scenario) =>
    scenarioMatchesQaProviderLane({
      scenario,
      providerMode: normalizedProviderMode,
      primaryModel,
      channelDriver: profileReport.channelDriver,
    }),
  );
  if (scenarios.length === 0) {
    throw new Error(
      `qa run --qa-profile ${profile} did not resolve any executable QA scenarios for provider mode ${normalizedProviderMode}.`,
    );
  }

  process.stdout.write(
    `QA run profile: ${profile}; categories: ${categories.length}; scenarios: ${scenarios.length}\n`,
  );
  let evidencePath: string | undefined;
  await withTemporaryQaProfileEnv(profile, async () => {
    const suiteResult = await runQaSuiteCommand({
      repoRoot,
      outputDir: opts.outputDir,
      evidenceMode: opts.evidenceMode,
      transportId: opts.transportId,
      providerMode,
      primaryModel: opts.primaryModel,
      alternateModel: opts.alternateModel,
      fastMode: opts.fastMode,
      scenarioIds: scenarios.map((scenario) => scenario.id),
      concurrency: opts.concurrency,
      allowFailures: opts.allowFailures,
      channelDriver: profileReport.channelDriver,
    });
    evidencePath =
      suiteResult && "evidencePath" in suiteResult ? suiteResult.evidencePath : undefined;
  });
  if (!evidencePath) {
    throw new Error("qa run --qa-profile did not produce qa-evidence.json.");
  }
  await attachQaProfileScorecardEvidenceToFile({
    evidencePath,
    evidenceMode: opts.evidenceMode,
    profile,
    filters: {
      surface: opts.surface,
      category: opts.category,
    },
    categories,
  });
  process.stdout.write(`QA profile scorecard: ${evidencePath}\n`);
}

function selectQaScenarioDefinitionsForChannelResolution(params: {
  scenarioIds: string[];
  providerMode: QaProviderMode;
  primaryModel: string;
  channelDriver?: QaScorecardChannelDriver | null;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  const scenarios = readQaScenarioPack().scenarios;
  if (params.scenarioIds.length > 0) {
    const scenarioById = new Map(scenarios.map((scenario) => [scenario.id, scenario]));
    return params.scenarioIds.flatMap((scenarioId) => {
      const scenario = scenarioById.get(scenarioId);
      return scenario ? [scenario] : [];
    });
  }
  return scenarios.filter((scenario) =>
    scenarioMatchesQaProviderLane({
      scenario,
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      channelDriver: params.channelDriver,
      claudeCliAuthMode: params.claudeCliAuthMode,
    }),
  );
}

function normalizeQaRunProfile(value: string, profileIds: readonly string[]) {
  if (profileIds.length === 0) {
    throw new Error("taxonomy.yaml does not define QA run profiles.");
  }
  const normalized = value.trim();
  if (profileIds.includes(normalized)) {
    return normalized;
  }
  throw new Error(`--qa-profile must be one of ${profileIds.join(", ")}, got "${value}".`);
}

function defaultQaRunProfileProviderMode(profile: string): QaProviderModeInput {
  return profile === "smoke-ci" ? "mock-openai" : DEFAULT_QA_LIVE_PROVIDER_MODE;
}

function qaScorecardCategoryMatchesRunProfile(
  category: QaScorecardCategoryCoverageReport,
  opts: { profile: string; surface?: string; category?: string },
): boolean {
  if (!category.profiles.includes(opts.profile)) {
    return false;
  }
  if (opts.surface?.trim()) {
    const surface = opts.surface.trim();
    if (category.taxonomySurfaceId !== surface && !category.id.startsWith(`${surface}.`)) {
      return false;
    }
  }
  if (opts.category?.trim() && category.id !== opts.category.trim()) {
    return false;
  }
  return true;
}

function formatQaRunProfileNoMatchMessage(
  opts: Pick<QaProfileCommandOptions, "profile" | "surface" | "category">,
) {
  return `qa run did not find taxonomy categories for ${formatQaRunProfileFilterList(opts)}.`;
}

function formatQaRunProfileFilterList(
  opts: Pick<QaProfileCommandOptions, "profile" | "surface" | "category">,
) {
  const filters = [
    `--qa-profile ${opts.profile}`,
    opts.surface?.trim() ? `--surface ${opts.surface.trim()}` : null,
    opts.category?.trim() ? `--category ${opts.category.trim()}` : null,
  ].filter((filter): filter is string => filter !== null);
  return filters.join(" ");
}

async function withTemporaryQaProfileEnv<T>(profile: string, run: () => Promise<T>): Promise<T> {
  const previousProfile = process.env.OPENCLAW_QA_PROFILE;
  process.env.OPENCLAW_QA_PROFILE = profile;
  try {
    return await run();
  } finally {
    if (previousProfile === undefined) {
      delete process.env.OPENCLAW_QA_PROFILE;
    } else {
      process.env.OPENCLAW_QA_PROFILE = previousProfile;
    }
  }
}

export async function runQaSuiteCommand(opts: QaSuiteCommandOptions) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const transportId = normalizeQaTransportId(opts.transportId);
  const runner = (opts.runner ?? "host").trim().toLowerCase();
  const runtimePair = parseQaRuntimePair(opts.runtimePair);
  const explicitScenarioIds = resolveQaScenarioPackScenarioIds({
    pack: opts.pack,
    scenarioIds: resolveQaParityPackScenarioIds({
      parityPack: opts.parityPack,
      scenarioIds: opts.scenarioIds,
    }),
  });
  const runtimeParityTiers = parseQaRuntimeParityTierFilters(opts.runtimeParityTier);
  const runtimeParityTierSelection = resolveQaRuntimeParityTierScenarioIds({
    scenarioIds: explicitScenarioIds,
    runtimeParityTiers,
    runtimePair: runtimePair !== undefined,
  });
  const scenarioIds = runtimeParityTierSelection.scenarioIds;
  if (runtimePair) {
    rejectNonFlowScenarioIds({ option: "--runtime-pair", scenarioIds });
  }
  if (runtimeParityTierSelection.excludedNonFlowScenarios.length > 0) {
    process.stderr.write(
      `QA runtime-pair tier selection excluded incompatible non-flow scenario(s): ${runtimeParityTierSelection.excludedNonFlowScenarios.join(", ")}\n`,
    );
  }
  const allowFailures = opts.allowFailures === true;
  const providerMode = normalizeQaProviderMode(opts.providerMode);
  const claudeCliAuthMode = parseQaCliBackendAuthMode(opts.cliAuthMode);
  const primaryModel = normalizeQaOptionalModelRef(opts.primaryModel);
  const alternateModel = normalizeQaOptionalModelRef(opts.alternateModel);
  const channelDriver = normalizeQaSuiteChannelDriver(opts.channelDriver);
  if (opts.channel?.trim() && channelDriver !== "crabline" && channelDriver !== "live") {
    throw new Error("--channel override requires --channel-driver crabline or live.");
  }
  const liveChannelId = channelDriver === "live" ? opts.channel?.trim() : undefined;
  const liveAdapterFactories = liveChannelId ? listLiveTransportQaAdapterFactories() : undefined;
  const liveAdapterFactory = liveChannelId
    ? liveAdapterFactories?.find((factory) => factory.id === liveChannelId)
    : undefined;
  if (liveChannelId && !liveAdapterFactory) {
    throw new Error(`unknown live QA adapter: ${liveChannelId}`);
  }
  const liveScenarioIds =
    liveAdapterFactory && scenarioIds.length === 0
      ? [...(liveAdapterFactory.scenarioIds ?? [])]
      : scenarioIds;
  if (liveAdapterFactory && liveScenarioIds.length === 0) {
    throw new Error(`live QA adapter ${liveChannelId} does not declare default scenarios`);
  }
  if (runner !== "host" && runner !== "multipass") {
    throw new Error(`--runner must be one of host or multipass, got "${opts.runner}".`);
  }
  if (opts.preflight === true && runner !== "host") {
    throw new Error("--preflight requires --runner host.");
  }
  const channelDriverScenarios =
    channelDriver === "crabline"
      ? selectQaScenarioDefinitionsForChannelResolution({
          scenarioIds,
          providerMode,
          primaryModel: primaryModel ?? defaultQaModelForMode(providerMode),
          channelDriver,
          claudeCliAuthMode,
        })
      : [];
  const channelDriverChannels =
    channelDriver === "crabline"
      ? resolveQaSuiteScenarioChannels({
          defaultChannel: OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
          explicitChannel: opts.channel,
          scenarios: channelDriverScenarios,
        })
      : [];
  if (runner === "multipass" && channelDriverChannels.length > 1) {
    resolveQaSuiteScenarioChannel({
      defaultChannel: OPENCLAW_CRABLINE_DEFAULT_CHANNEL,
      explicitChannel: opts.channel,
      scenarios: channelDriverScenarios,
    });
  }
  const [singleChannelDriverChannel] = channelDriverChannels;
  const channelDriverSelection =
    channelDriver === "crabline" && channelDriverChannels.length === 1 && singleChannelDriverChannel
      ? resolveOpenClawCrablineChannelDriverSelection({
          channel: singleChannelDriverChannel,
        })
      : undefined;
  const hostScenarioIds =
    runner === "host" && channelDriverChannels.length > 1 && scenarioIds.length === 0
      ? channelDriverScenarios
          .filter((scenario) => scenario.execution.kind === "flow")
          .map((scenario) => scenario.id)
      : scenarioIds;
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
  if (runner === "multipass" && liveChannelId) {
    throw new Error("--channel-driver live with --channel requires --runner host.");
  }
  if (runtimePair && liveChannelId) {
    throw new Error("--runtime-pair is not supported with a live QA adapter.");
  }
  if (runner === "multipass") {
    rejectNonFlowScenarioIds({ option: "--runner multipass", scenarioIds });
    const thinkingDefault = parseQaThinkingLevel("--thinking", opts.thinking);
    const result = await runQaMultipass({
      repoRoot,
      outputDir: resolveRepoRelativeOutputDir(repoRoot, opts.outputDir),
      transportId,
      ...(opts.providerMode !== undefined ? { providerMode } : {}),
      primaryModel,
      alternateModel,
      fastMode: opts.fastMode,
      ...(thinkingDefault ? { thinkingDefault } : {}),
      allowFailures: true,
      scenarioIds,
      ...(opts.concurrency !== undefined
        ? { concurrency: parseQaPositiveIntegerOption("--concurrency", opts.concurrency) }
        : {}),
      ...(runtimePair ? { runtimePair } : {}),
      ...(channelDriverSelection ? { channelDriverSelection } : {}),
      ...(opts.enabledPluginIds !== undefined ? { enabledPluginIds: opts.enabledPluginIds } : {}),
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
      const blockingScenarioCount = await readQaSuiteFailedOrSkippedScenarioCountFromFile(
        result.summaryPath,
      );
      if (blockingScenarioCount > 0) {
        process.exitCode = 1;
      }
    }
    return result;
  }
  if (opts.preflight === true) {
    await runQaParityPreflight({
      repoRoot,
      transportId,
      providerMode,
      primaryModel,
      alternateModel,
      allowFailures,
    });
    return undefined;
  }
  const thinkingDefault = parseQaThinkingLevel("--thinking", opts.thinking);
  const runtimeResult = await runQaSuiteWithInfraRetry(() =>
    runQaSuite({
      repoRoot,
      outputDir: resolveRepoRelativeOutputDir(repoRoot, opts.outputDir),
      evidenceMode: opts.evidenceMode,
      transportId,
      channelDriver,
      ...(liveChannelId
        ? {
            adapterFactories: liveAdapterFactories,
            channelId: liveChannelId,
            adapterOptions: {
              repoRoot,
            },
          }
        : {}),
      channelDriverSelection,
      ...(opts.providerMode !== undefined ? { providerMode } : {}),
      primaryModel,
      alternateModel,
      fastMode: opts.fastMode,
      ...(thinkingDefault ? { thinkingDefault } : {}),
      ...(claudeCliAuthMode ? { claudeCliAuthMode } : {}),
      scenarioIds: liveChannelId ? liveScenarioIds : hostScenarioIds,
      ...(opts.enabledPluginIds !== undefined ? { enabledPluginIds: opts.enabledPluginIds } : {}),
      ...(liveChannelId
        ? { concurrency: 1 }
        : opts.concurrency !== undefined
          ? { concurrency: parseQaPositiveIntegerOption("--concurrency", opts.concurrency) }
          : {}),
      ...(runtimePair ? { runtimePair } : {}),
    }),
  );
  switch (runtimeResult.executionKind) {
    case "suite": {
      const result = runtimeResult.result;
      process.stdout.write(`QA suite report: ${result.reportPath}\n`);
      process.stdout.write(`QA suite evidence: ${result.evidencePath}\n`);
      process.stdout.write(`QA suite summary: ${result.summaryPath}\n`);
      if (!allowFailures && result.scenarios.some((scenario) => scenario.status !== "pass")) {
        process.exitCode = 1;
      }
      return result;
    }
    case "flow": {
      const result = runtimeResult.result;
      process.stdout.write(`QA suite watch: ${result.watchUrl}\n`);
      process.stdout.write(`QA suite report: ${result.reportPath}\n`);
      process.stdout.write(`QA suite evidence: ${result.evidencePath}\n`);
      process.stdout.write(`QA suite summary: ${result.summaryPath}\n`);
      const blockingScenarioCount = await readQaSuiteFailedOrSkippedScenarioCountFromFile(
        result.summaryPath,
      );
      if (!allowFailures && blockingScenarioCount > 0) {
        process.exitCode = 1;
      }
      return result;
    }
  }
  return undefined;
}

export async function runQaParityReportCommand(opts: {
  repoRoot?: string;
  candidateSummary?: string;
  baselineSummary?: string;
  candidateLabel?: string;
  baselineLabel?: string;
  outputDir?: string;
  runtimeAxis?: boolean;
  summary?: string;
  tokenEfficiency?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  if (opts.tokenEfficiency === true && opts.runtimeAxis !== true) {
    throw new Error("--token-efficiency requires --runtime-axis.");
  }
  const outputDir =
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `parity-${createQaArtifactRunId()}`);
  await fs.mkdir(outputDir, { recursive: true });

  if (opts.runtimeAxis === true) {
    if (!opts.summary?.trim()) {
      throw new Error("--runtime-axis requires --summary.");
    }
    const summaryPath = path.resolve(repoRoot, opts.summary);
    const summary = JSON.parse(
      await fs.readFile(summaryPath, "utf8"),
    ) as QaRuntimeParitySuiteSummary;
    const reportPayload = buildQaRuntimeParityReport({ summary });
    const report = renderQaRuntimeParityMarkdownReport(reportPayload);
    const reportPath = path.join(outputDir, "qa-runtime-parity-report.md");
    const runtimeSummaryPath = path.join(outputDir, "qa-runtime-parity-summary.json");
    await fs.writeFile(reportPath, report, "utf8");
    await fs.writeFile(runtimeSummaryPath, `${JSON.stringify(reportPayload, null, 2)}\n`, "utf8");

    process.stdout.write(`QA runtime parity report: ${reportPath}\n`);
    process.stdout.write(`QA runtime parity summary: ${runtimeSummaryPath}\n`);
    process.stdout.write(`QA runtime parity verdict: ${reportPayload.pass ? "pass" : "fail"}\n`);

    let tokenEfficiencyPass = true;
    if (opts.tokenEfficiency === true) {
      const tokenPayload = buildTokenEfficiencyReport({
        summary: summary as TokenEfficiencySuiteSummary,
      });
      tokenEfficiencyPass = tokenPayload.pass;
      const tokenReport = renderTokenEfficiencyMarkdownReport(tokenPayload);
      const tokenReportPath = path.join(outputDir, "qa-runtime-token-efficiency-report.md");
      const tokenSummaryPath = path.join(outputDir, "qa-runtime-token-efficiency-summary.json");
      await fs.writeFile(tokenReportPath, tokenReport, "utf8");
      await fs.writeFile(tokenSummaryPath, `${JSON.stringify(tokenPayload, null, 2)}\n`, "utf8");
      process.stdout.write(`QA runtime token efficiency report: ${tokenReportPath}\n`);
      process.stdout.write(`QA runtime token efficiency summary: ${tokenSummaryPath}\n`);
      process.stdout.write(
        `QA runtime token efficiency verdict: ${tokenPayload.status === "skipped" ? "skipped" : tokenPayload.pass ? "pass" : "fail"}\n`,
      );
    }

    if (!reportPayload.pass || !tokenEfficiencyPass) {
      process.exitCode = 1;
    }
    return;
  }

  if (!opts.candidateSummary?.trim() || !opts.baselineSummary?.trim()) {
    throw new Error(
      "--candidate-summary and --baseline-summary are required unless --runtime-axis is set.",
    );
  }
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

export async function runQaConfidenceReportCommand(opts: {
  repoRoot?: string;
  manifest: string;
  artifactRoot?: string;
  outputDir?: string;
  strictZeroUnknowns?: boolean;
  strictGlobalPass?: boolean;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const manifestPath = path.resolve(repoRoot, opts.manifest);
  const artifactRoot = path.resolve(repoRoot, opts.artifactRoot ?? ".");
  const outputDir =
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `confidence-${createQaArtifactRunId()}`);
  await fs.mkdir(outputDir, { recursive: true });
  const manifest = await readQaConfidenceManifestFile(manifestPath);
  const reportPayload = await buildQaConfidenceReport({
    manifest,
    artifactRoot,
    strictZeroUnknowns: opts.strictZeroUnknowns === true,
    strictGlobalPass: opts.strictGlobalPass === true,
  });
  const report = renderQaConfidenceMarkdownReport(reportPayload);
  const reportPath = path.join(outputDir, "qa-confidence-report.md");
  const summaryPath = path.join(outputDir, "qa-confidence-summary.json");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(reportPayload, null, 2)}\n`, "utf8");
  process.stdout.write(`QA confidence report: ${reportPath}\n`);
  process.stdout.write(`QA confidence summary: ${summaryPath}\n`);
  process.stdout.write(`QA confidence verdict: ${reportPayload.pass ? "pass" : "fail"}\n`);
  if (!reportPayload.pass) {
    process.exitCode = 1;
  }
}

export async function runQaConfidenceSelfTestCommand(opts: {
  repoRoot?: string;
  outputDir?: string;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputDir =
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `confidence-self-test-${createQaArtifactRunId()}`);
  const result = await writeQaConfidenceSelfTestArtifacts({ outputDir });
  process.stdout.write(`QA confidence self-test report: ${result.reportPath}\n`);
  process.stdout.write(`QA confidence self-test summary: ${result.summaryPath}\n`);
  process.stdout.write(
    `QA confidence self-test verdict: ${result.summary.pass ? "pass" : "fail"}\n`,
  );
  if (!result.summary.pass) {
    process.exitCode = 1;
  }
}

export async function runQaCoverageReportCommand(opts: {
  repoRoot?: string;
  output?: string;
  json?: boolean;
  tools?: boolean;
  summary?: string;
  match?: string[];
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const outputPath = opts.output ? path.resolve(repoRoot, opts.output) : undefined;
  const scenarios = readQaScenarioPack().scenarios;
  let body: string;
  let outputLabel = "QA coverage report";
  if (opts.tools === true) {
    if (opts.match && opts.match.length > 0) {
      throw new Error("--match cannot be combined with --tools.");
    }
    const summary = opts.summary?.trim()
      ? (JSON.parse(
          await fs.readFile(path.resolve(repoRoot, opts.summary), "utf8"),
        ) as QaToolCoverageSuiteSummary)
      : undefined;
    const report = buildQaToolCoverageReport({ scenarios, summary });
    body = opts.json
      ? `${JSON.stringify(report, null, 2)}\n`
      : renderQaToolCoverageMarkdownReport(report);
    outputLabel = "QA tool coverage report";
    if (summary && !report.pass) {
      process.exitCode = 1;
    }
  } else {
    if (opts.summary?.trim()) {
      throw new Error("--summary requires --tools.");
    }
    const query = opts.match?.join(" ").trim();
    if (query) {
      const matches = findQaScenarioMatches(scenarios, query);
      body = opts.json
        ? `${JSON.stringify({ query, matches }, null, 2)}\n`
        : renderQaScenarioMatchesMarkdownReport({ query, matches });
      outputLabel = "QA scenario match report";
    } else {
      const inventory = buildQaCoverageInventory(scenarios, {
        nonYamlScenarios: await loadNonYamlScenarioRefs(),
      });
      body = opts.json
        ? `${JSON.stringify(inventory, null, 2)}\n`
        : renderQaCoverageMarkdownReport(inventory);
    }
  }

  if (outputPath) {
    await fs.mkdir(path.dirname(outputPath), { recursive: true });
    await fs.writeFile(outputPath, body, "utf8");
    process.stdout.write(`${outputLabel}: ${outputPath}\n`);
    return;
  }

  process.stdout.write(body);
}

export async function runQaJsonlReplayCommand(opts: {
  repoRoot?: string;
  transcripts?: string;
  outputDir?: string;
  runtimePair?: string;
  providerMode?: QaProviderModeInput;
}) {
  const repoRoot = path.resolve(opts.repoRoot ?? process.cwd());
  const runtimePair = parseQaRuntimePair(opts.runtimePair) ?? ["openclaw", "codex"];
  if (runtimePair[0] !== "openclaw" || runtimePair[1] !== "codex") {
    throw new Error('--runtime-pair for jsonl-replay must be "openclaw,codex".');
  }
  const providerMode = normalizeQaProviderMode(opts.providerMode ?? "mock-openai");
  if (providerMode !== "mock-openai") {
    throw new Error("qa jsonl-replay currently supports mock-openai curated fixtures only.");
  }
  const transcriptDir = path.resolve(repoRoot, opts.transcripts ?? "qa/scenarios/jsonl-replay");
  const outputDir =
    resolveRepoRelativeOutputDir(repoRoot, opts.outputDir) ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `jsonl-replay-${createQaArtifactRunId()}`);
  await fs.mkdir(outputDir, { recursive: true });
  const result = await runJsonlReplay(
    {
      directory: transcriptDir,
      runtimePair: runtimePair as JsonlReplayInput["runtimePair"],
      providerMode,
    },
    { runCell: createMockJsonlReplayCellRunner() },
  );
  const reportPayload = {
    generatedAt: new Date().toISOString(),
    providerMode,
    runtimePair: runtimePair as JsonlReplayInput["runtimePair"],
    transcripts: result.transcripts,
  };
  const report = renderJsonlReplayMarkdownReport(reportPayload);
  const reportPath = path.join(outputDir, "qa-jsonl-replay-report.md");
  const summaryPath = path.join(outputDir, "qa-jsonl-replay-summary.json");
  await fs.writeFile(reportPath, report, "utf8");
  await fs.writeFile(summaryPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  process.stdout.write(`QA JSONL replay report: ${reportPath}\n`);
  process.stdout.write(`QA JSONL replay summary: ${summaryPath}\n`);
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

export async function runQaCredentialsDoctorCommand(opts: {
  actorId?: string;
  endpointPrefix?: string;
  json?: boolean;
  siteUrl?: string;
}) {
  const result = await diagnoseQaCredentialBroker({
    actorId: opts.actorId,
    endpointPrefix: opts.endpointPrefix,
    siteUrl: opts.siteUrl,
  });
  if (opts.json) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    printQaCredentialDoctorTable(result);
  }
  if (result.status === "fail") {
    process.exitCode = 1;
  }
}

export async function runQaLabUiCommand(opts: {
  repoRoot?: string;
  host?: string;
  port?: number;
  advertiseHost?: string;
  advertisePort?: number;
  controlUiUrl?: string;
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
    controlUiProxyToken: process.env.OPENCLAW_QA_CONTROL_UI_PROXY_TOKEN,
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

export const testing = {
  resolveRepoRelativeOutputDir,
};
export { testing as __testing };
