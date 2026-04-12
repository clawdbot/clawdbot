import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { disposeRegisteredAgentHarnesses } from "openclaw/plugin-sdk/agent-harness";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  formatMemoryDreamingDay,
  resolveSessionTranscriptsDirForAgent,
} from "openclaw/plugin-sdk/memory-core";
import { buildAgentSessionKey } from "openclaw/plugin-sdk/routing";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";
import { ensureRepoBoundDirectory, resolveRepoRelativeOutputDir } from "./cli-paths.js";
import { waitForCronRunCompletion } from "./cron-run-wait.js";
import {
  hasDiscoveryLabels,
  reportsDiscoveryScopeLeak,
  reportsMissingDiscoveryFiles,
} from "./discovery-eval.js";
import { extractQaToolPayload } from "./extract-tool-payload.js";
import { startQaGatewayChild, type QaCliBackendAuthMode } from "./gateway-child.js";
import type {
  QaLabLatestReport,
  QaLabScenarioOutcome,
  QaLabServerHandle,
  QaLabServerStartParams,
} from "./lab-server.types.js";
import { resolveQaLiveTurnTimeoutMs } from "./live-timeout.js";
import { startQaMockOpenAiServer } from "./mock-openai-server.js";
import {
  defaultQaModelForMode,
  isQaFastModeEnabled,
  normalizeQaProviderMode,
  type QaProviderMode,
} from "./model-selection.js";
import { hasModelSwitchContinuityEvidence } from "./model-switch-eval.js";
import type { QaThinkingLevel } from "./qa-gateway-config.js";
import {
  createQaTransportAdapter,
  normalizeQaTransportId,
  type QaTransportId,
} from "./qa-transport-registry.js";
import type {
  QaTransportAdapter,
  QaTransportActionName,
  QaTransportState,
} from "./qa-transport.js";
import {
  createFailureAwareTransportWaitForCondition,
  findFailureOutboundMessage as findTransportFailureOutboundMessage,
} from "./qa-transport.js";
import { extractQaFailureReplyText } from "./reply-failure.js";
import { renderQaMarkdownReport, type QaReportCheck, type QaReportScenario } from "./report.js";
import { qaChannelPlugin, type QaBusMessage } from "./runtime-api.js";
import { readQaBootstrapScenarioCatalog } from "./scenario-catalog.js";
import { runScenarioFlow } from "./scenario-flow-runner.js";
import { createQaScenarioRuntimeApi } from "./scenario-runtime-api.js";

type QaSuiteStep = {
  name: string;
  run: () => Promise<string | void>;
};

type QaSuiteScenarioResult = {
  name: string;
  status: "pass" | "fail";
  steps: QaReportCheck[];
  details?: string;
};

type QaSuiteEnvironment = {
  lab: QaLabServerHandle;
  mock: Awaited<ReturnType<typeof startQaMockOpenAiServer>> | null;
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  cfg: OpenClawConfig;
  transport: QaTransportAdapter;
  repoRoot: string;
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
};

export type QaSuiteStartLabFn = (params?: QaLabServerStartParams) => Promise<QaLabServerHandle>;

export type QaSuiteRunParams = {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderMode | "live-openai";
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
  controlUiEnabled?: boolean;
};

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

type QaSkillStatusEntry = {
  name?: string;
  eligible?: boolean;
  disabled?: boolean;
  blockedByAllowlist?: boolean;
};

type QaConfigSnapshot = {
  hash?: string;
  config?: Record<string, unknown>;
};

type QaDreamingStatus = {
  enabled?: boolean;
  shortTermCount?: number;
  promotedTotal?: number;
  phaseSignalCount?: number;
  lightPhaseHitCount?: number;
  remPhaseHitCount?: number;
  phases?: {
    deep?: {
      managedCronPresent?: boolean;
      nextRunAtMs?: number;
    };
  };
};

type QaRawSessionStoreEntry = {
  sessionId?: string;
  status?: string;
  spawnedBy?: string;
  label?: string;
  abortedLastRun?: boolean;
  updatedAt?: number;
};

const DEFAULT_QA_SUITE_CONCURRENCY = 64;

function normalizeQaSuiteConcurrency(value: number | undefined, scenarioCount: number) {
  const envValue = Number(process.env.OPENCLAW_QA_SUITE_CONCURRENCY);
  const raw =
    typeof value === "number" && Number.isFinite(value)
      ? value
      : Number.isFinite(envValue)
        ? envValue
        : DEFAULT_QA_SUITE_CONCURRENCY;
  return Math.max(1, Math.min(Math.floor(raw), Math.max(1, scenarioCount)));
}

async function mapQaSuiteWithConcurrency<T, U>(
  items: readonly T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<U>,
) {
  const results = Array.from<U>({ length: items.length });
  let nextIndex = 0;
  const workerCount = Math.min(Math.max(1, Math.floor(concurrency)), items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

function splitModelRef(ref: string) {
  const slash = ref.indexOf("/");
  if (slash <= 0 || slash === ref.length - 1) {
    return null;
  }
  return {
    provider: ref.slice(0, slash),
    model: ref.slice(slash + 1),
  };
}

function normalizeQaConfigString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function scenarioMatchesLiveLane(params: {
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number];
  primaryModel: string;
  providerMode: "mock-openai" | "live-frontier";
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  if (params.providerMode !== "live-frontier") {
    return true;
  }
  const selected = splitModelRef(params.primaryModel);
  const config = params.scenario.execution.config ?? {};
  const requiredProvider = normalizeQaConfigString(config.requiredProvider);
  if (requiredProvider && selected?.provider !== requiredProvider) {
    return false;
  }
  const requiredModel = normalizeQaConfigString(config.requiredModel);
  if (requiredModel && selected?.model !== requiredModel) {
    return false;
  }
  const requiredAuthMode = normalizeQaConfigString(config.authMode);
  if (requiredAuthMode && params.claudeCliAuthMode !== requiredAuthMode) {
    return false;
  }
  return true;
}

function selectQaSuiteScenarios(params: {
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"];
  scenarioIds?: string[];
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  claudeCliAuthMode?: QaCliBackendAuthMode;
}) {
  const requestedScenarioIds =
    params.scenarioIds && params.scenarioIds.length > 0 ? new Set(params.scenarioIds) : null;
  const requestedScenarios = requestedScenarioIds
    ? params.scenarios.filter((scenario) => requestedScenarioIds.has(scenario.id))
    : params.scenarios;
  if (requestedScenarioIds) {
    const foundScenarioIds = new Set(requestedScenarios.map((scenario) => scenario.id));
    const missingScenarioIds = [...requestedScenarioIds].filter(
      (scenarioId) => !foundScenarioIds.has(scenarioId),
    );
    if (missingScenarioIds.length > 0) {
      throw new Error(`unknown QA scenario id(s): ${missingScenarioIds.join(", ")}`);
    }
    return requestedScenarios;
  }
  return requestedScenarios.filter((scenario) =>
    scenarioMatchesLiveLane({
      scenario,
      providerMode: params.providerMode,
      primaryModel: params.primaryModel,
      claudeCliAuthMode: params.claudeCliAuthMode,
    }),
  );
}

function collectQaSuitePluginIds(
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"],
) {
  return [
    ...new Set(
      scenarios.flatMap((scenario) =>
        Array.isArray(scenario.plugins)
          ? scenario.plugins
              .map((pluginId) => pluginId.trim())
              .filter((pluginId) => pluginId.length > 0)
          : [],
      ),
    ),
  ];
}

function isQaPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function applyQaMergePatch(base: unknown, patch: unknown): unknown {
  if (!isQaPlainObject(patch)) {
    return patch;
  }
  const result = isQaPlainObject(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[key];
      continue;
    }
    result[key] = isQaPlainObject(value) ? applyQaMergePatch(result[key], value) : value;
  }
  return result;
}

function collectQaSuiteGatewayConfigPatch(
  scenarios: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"],
): Record<string, unknown> | undefined {
  let merged: Record<string, unknown> | undefined;
  for (const scenario of scenarios) {
    if (!isQaPlainObject(scenario.gatewayConfigPatch)) {
      continue;
    }
    merged = applyQaMergePatch(merged ?? {}, scenario.gatewayConfigPatch) as Record<
      string,
      unknown
    >;
  }
  return merged;
}

function liveTurnTimeoutMs(env: QaSuiteEnvironment, fallbackMs: number) {
  return resolveQaLiveTurnTimeoutMs(env, fallbackMs);
}

async function resolveQaSuiteOutputDir(repoRoot: string, outputDir?: string) {
  const targetDir = !outputDir
    ? path.join(repoRoot, ".artifacts", "qa-e2e", `suite-${Date.now().toString(36)}`)
    : outputDir;
  if (!path.isAbsolute(targetDir)) {
    const resolved = resolveRepoRelativeOutputDir(repoRoot, targetDir);
    if (!resolved) {
      throw new Error("QA suite outputDir must be set.");
    }
    return await ensureRepoBoundDirectory(repoRoot, resolved, "QA suite outputDir", {
      mode: 0o700,
    });
  }
  return await ensureRepoBoundDirectory(repoRoot, targetDir, "QA suite outputDir", {
    mode: 0o700,
  });
}

export type QaSuiteResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  report: string;
  scenarios: QaSuiteScenarioResult[];
  watchUrl: string;
};

async function waitForCondition<T>(
  check: () => T | Promise<T | null | undefined> | null | undefined,
  timeoutMs = 15_000,
  intervalMs = 100,
): Promise<T> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await check();
    if (value !== null && value !== undefined) {
      return value;
    }
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms`);
}

function findFailureOutboundMessage(
  state: QaTransportState,
  options?: { sinceIndex?: number; cursorSpace?: "all" | "outbound" },
) {
  return findTransportFailureOutboundMessage(state, options);
}

function createScenarioWaitForCondition(state: QaTransportState) {
  return createFailureAwareTransportWaitForCondition(state);
}

async function waitForOutboundMessage(
  state: QaTransportState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs = 15_000,
  options?: { sinceIndex?: number },
) {
  return await waitForCondition(() => {
    const failureMessage = findFailureOutboundMessage(state, options);
    if (failureMessage) {
      throw new Error(extractQaFailureReplyText(failureMessage.text) ?? failureMessage.text);
    }
    const match = state
      .getSnapshot()
      .messages.filter((message) => message.direction === "outbound")
      .slice(options?.sinceIndex ?? 0)
      .find(predicate);
    if (!match) {
      return undefined;
    }
    const failureReply = extractQaFailureReplyText(match.text);
    if (failureReply) {
      throw new Error(failureReply);
    }
    return match;
  }, timeoutMs);
}

async function waitForNoOutbound(state: QaTransportState, timeoutMs = 1_200) {
  await sleep(timeoutMs);
  const outbound = state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound");
  if (outbound.length > 0) {
    throw new Error(`expected no outbound messages, saw ${outbound.length}`);
  }
}

function recentOutboundSummary(state: QaTransportState, limit = 5) {
  return state
    .getSnapshot()
    .messages.filter((message) => message.direction === "outbound")
    .slice(-limit)
    .map((message) => `${message.conversation.id}:${message.text}`)
    .join(" | ");
}

function formatConversationTranscript(
  state: QaTransportState,
  params: {
    conversationId: string;
    threadId?: string;
    limit?: number;
  },
) {
  return formatTransportTranscript(state, params);
}

function readTransportTranscript(
  state: QaTransportState,
  params: {
    conversationId: string;
    threadId?: string;
    direction?: "inbound" | "outbound";
    limit?: number;
  },
) {
  const messages = state
    .getSnapshot()
    .messages.filter(
      (message) =>
        message.conversation.id === params.conversationId &&
        (params.threadId ? message.threadId === params.threadId : true) &&
        (params.direction ? message.direction === params.direction : true),
    );
  return params.limit ? messages.slice(-params.limit) : messages;
}

function formatTransportTranscript(
  state: QaTransportState,
  params: {
    conversationId: string;
    threadId?: string;
    direction?: "inbound" | "outbound";
    limit?: number;
  },
) {
  const messages = readTransportTranscript(state, params);
  return messages
    .map((message) => {
      const direction = message.direction === "inbound" ? "user" : "assistant";
      const speaker = message.senderName?.trim() || message.senderId;
      const attachmentSummary =
        message.attachments && message.attachments.length > 0
          ? ` [attachments: ${message.attachments
              .map((attachment) => `${attachment.kind}:${attachment.fileName ?? attachment.id}`)
              .join(", ")}]`
          : "";
      return `${direction.toUpperCase()} ${speaker}: ${message.text}${attachmentSummary}`;
    })
    .join("\n\n");
}

async function waitForTransportOutboundMessage(
  state: QaTransportState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs?: number,
) {
  return await waitForOutboundMessage(state, predicate, timeoutMs);
}

async function waitForChannelOutboundMessage(
  state: QaTransportState,
  predicate: (message: QaBusMessage) => boolean,
  timeoutMs?: number,
) {
  return await waitForTransportOutboundMessage(state, predicate, timeoutMs);
}

async function waitForNoTransportOutbound(state: QaTransportState, timeoutMs = 1_200) {
  await waitForNoOutbound(state, timeoutMs);
}

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

async function fetchJson<T>(url: string): Promise<T> {
  const { response, release } = await fetchWithSsrFGuard({
    url,
    policy: { allowPrivateNetwork: true },
    auditContext: "qa-lab-suite-fetch-json",
  });
  try {
    if (!response.ok) {
      throw new Error(`request failed ${response.status}: ${url}`);
    }
    return (await response.json()) as T;
  } finally {
    await release();
  }
}

async function waitForGatewayHealthy(env: QaSuiteEnvironment, timeoutMs = 45_000) {
  await waitForCondition(
    async () => {
      try {
        const { response, release } = await fetchWithSsrFGuard({
          url: `${env.gateway.baseUrl}/readyz`,
          policy: { allowPrivateNetwork: true },
          auditContext: "qa-lab-suite-wait-for-gateway-healthy",
        });
        try {
          return response.ok ? true : undefined;
        } finally {
          await release();
        }
      } catch {
        return undefined;
      }
    },
    timeoutMs,
    250,
  );
}

async function waitForTransportReady(env: QaSuiteEnvironment, timeoutMs = 45_000) {
  await env.transport.waitReady({
    gateway: env.gateway,
    timeoutMs,
  });
}

async function waitForQaChannelReady(env: QaSuiteEnvironment, timeoutMs = 45_000) {
  // Compatibility alias for existing markdown scenarios while qa-channel
  // remains the only suite transport.
  await waitForTransportReady(env, timeoutMs);
}

async function waitForConfigRestartSettle(
  env: QaSuiteEnvironment,
  restartDelayMs = 1_000,
  timeoutMs = 60_000,
) {
  // config.patch/config.apply can still restart asynchronously after the RPC returns
  // in reload-off or restart-required hot-mode paths. Give that window time to fire.
  await sleep(restartDelayMs + 750);
  await waitForGatewayHealthy(env, timeoutMs);
}

function isGatewayRestartRace(error: unknown) {
  const text = formatGatewayPrimaryErrorText(error);
  return (
    text.includes("gateway closed (1012)") ||
    text.includes("gateway closed (1006") ||
    text.includes("abnormal closure") ||
    text.includes("service restart")
  );
}

function isConfigHashConflict(error: unknown) {
  return formatGatewayPrimaryErrorText(error).includes("config changed since last load");
}

function formatGatewayPrimaryErrorText(error: unknown) {
  const text = formatErrorMessage(error);
  const gatewayLogsIndex = text.indexOf("\nGateway logs:");
  return (gatewayLogsIndex >= 0 ? text.slice(0, gatewayLogsIndex) : text).trim();
}

function getGatewayRetryAfterMs(error: unknown) {
  const text = formatGatewayPrimaryErrorText(error);
  const millisecondsMatch = /retryAfterMs["=: ]+(\d+)/i.exec(text);
  if (millisecondsMatch) {
    const parsed = Number(millisecondsMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }
  const secondsMatch = /retry after (\d+)s/i.exec(text);
  if (secondsMatch) {
    const parsed = Number(secondsMatch[1]);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed * 1_000;
    }
  }
  return null;
}

async function readConfigSnapshot(env: QaSuiteEnvironment) {
  const snapshot = (await env.gateway.call(
    "config.get",
    {},
    { timeoutMs: 60_000 },
  )) as QaConfigSnapshot;
  if (!snapshot.hash || !snapshot.config) {
    throw new Error("config.get returned no hash/config");
  }
  return {
    hash: snapshot.hash,
    config: snapshot.config,
  } satisfies { hash: string; config: Record<string, unknown> };
}

async function runConfigMutation(params: {
  env: QaSuiteEnvironment;
  action: "config.patch" | "config.apply";
  raw: string;
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  note?: string;
  restartDelayMs?: number;
}) {
  const restartDelayMs = params.restartDelayMs ?? 1_000;
  let lastConflict: unknown = null;
  for (let attempt = 1; attempt <= 8; attempt += 1) {
    const snapshot = await readConfigSnapshot(params.env);
    try {
      const result = await params.env.gateway.call(
        params.action,
        {
          raw: params.raw,
          baseHash: snapshot.hash,
          ...(params.sessionKey ? { sessionKey: params.sessionKey } : {}),
          ...(params.deliveryContext ? { deliveryContext: params.deliveryContext } : {}),
          ...(params.note ? { note: params.note } : {}),
          restartDelayMs,
        },
        { timeoutMs: 45_000 },
      );
      await waitForConfigRestartSettle(params.env, restartDelayMs);
      return result;
    } catch (error) {
      if (isConfigHashConflict(error)) {
        lastConflict = error;
        await waitForGatewayHealthy(params.env, Math.max(15_000, restartDelayMs + 10_000)).catch(
          () => undefined,
        );
        continue;
      }
      const retryAfterMs = getGatewayRetryAfterMs(error);
      if (retryAfterMs && attempt < 8) {
        await sleep(retryAfterMs + 500);
        await waitForGatewayHealthy(params.env, Math.max(15_000, restartDelayMs + 10_000)).catch(
          () => undefined,
        );
        continue;
      }
      if (!isGatewayRestartRace(error)) {
        throw error;
      }
      await waitForConfigRestartSettle(params.env, restartDelayMs);
      return { ok: true, restarted: true };
    }
  }
  throw lastConflict ?? new Error(`${params.action} failed after retrying config hash conflicts`);
}

async function patchConfig(params: {
  env: QaSuiteEnvironment;
  patch: Record<string, unknown>;
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  note?: string;
  restartDelayMs?: number;
}) {
  return await runConfigMutation({
    env: params.env,
    action: "config.patch",
    raw: JSON.stringify(params.patch, null, 2),
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    note: params.note,
    restartDelayMs: params.restartDelayMs,
  });
}

async function applyConfig(params: {
  env: QaSuiteEnvironment;
  nextConfig: Record<string, unknown>;
  sessionKey?: string;
  deliveryContext?: {
    channel?: string;
    to?: string;
    accountId?: string;
    threadId?: string | number;
  };
  note?: string;
  restartDelayMs?: number;
}) {
  return await runConfigMutation({
    env: params.env,
    action: "config.apply",
    raw: JSON.stringify(params.nextConfig, null, 2),
    sessionKey: params.sessionKey,
    deliveryContext: params.deliveryContext,
    note: params.note,
    restartDelayMs: params.restartDelayMs,
  });
}

async function createSession(env: QaSuiteEnvironment, label: string, key?: string) {
  const created = (await env.gateway.call(
    "sessions.create",
    {
      label,
      ...(key ? { key } : {}),
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 60_000),
    },
  )) as { key?: string };
  const sessionKey = created.key?.trim();
  if (!sessionKey) {
    throw new Error("sessions.create returned no key");
  }
  return sessionKey;
}

async function readEffectiveTools(env: QaSuiteEnvironment, sessionKey: string) {
  const payload = (await env.gateway.call(
    "tools.effective",
    {
      sessionKey,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 90_000),
    },
  )) as {
    groups?: Array<{ tools?: Array<{ id?: string }> }>;
  };
  const ids = new Set<string>();
  for (const group of payload.groups ?? []) {
    for (const tool of group.tools ?? []) {
      if (tool.id?.trim()) {
        ids.add(tool.id.trim());
      }
    }
  }
  return ids;
}

async function readSkillStatus(env: QaSuiteEnvironment, agentId = "qa") {
  const payload = (await env.gateway.call(
    "skills.status",
    {
      agentId,
    },
    {
      timeoutMs: liveTurnTimeoutMs(env, 45_000),
    },
  )) as {
    skills?: QaSkillStatusEntry[];
  };
  return payload.skills ?? [];
}

async function readRawQaSessionStore(env: QaSuiteEnvironment) {
  const storePath = path.join(
    env.gateway.tempRoot,
    "state",
    "agents",
    "qa",
    "sessions",
    "sessions.json",
  );
  try {
    const raw = await fs.readFile(storePath, "utf8");
    return JSON.parse(raw) as Record<string, QaRawSessionStoreEntry>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw error;
  }
}

async function runQaCli(
  env: QaSuiteEnvironment,
  args: string[],
  opts?: { timeoutMs?: number; json?: boolean },
) {
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  const distEntryPath = path.join(env.repoRoot, "dist", "index.js");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [distEntryPath, ...args], {
      cwd: env.gateway.tempRoot,
      env: env.gateway.runtimeEnv,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`qa cli timed out: openclaw ${args.join(" ")}`));
    }, opts?.timeoutMs ?? 60_000);
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timeout);
      if (code === 0) {
        resolve();
        return;
      }
      reject(
        new Error(
          `qa cli failed (${code ?? "unknown"}): ${Buffer.concat(stderr).toString("utf8").trim()}`,
        ),
      );
    });
  });
  const text = Buffer.concat(stdout).toString("utf8").trim();
  if (!opts?.json) {
    return text;
  }
  return text ? (JSON.parse(text) as unknown) : {};
}

function extractMediaPathFromText(text: string | undefined): string | undefined {
  return /MEDIA:([^\n]+)/.exec(text ?? "")?.[1]?.trim();
}

async function resolveGeneratedImagePath(params: {
  env: QaSuiteEnvironment;
  promptSnippet: string;
  startedAtMs: number;
  timeoutMs: number;
}) {
  return await waitForCondition(
    async () => {
      if (params.env.mock) {
        const requests = await fetchJson<Array<{ allInputText?: string; toolOutput?: string }>>(
          `${params.env.mock.baseUrl}/debug/requests`,
        );
        for (let index = requests.length - 1; index >= 0; index -= 1) {
          const request = requests[index];
          if (!(request.allInputText ?? "").includes(params.promptSnippet)) {
            continue;
          }
          const mediaPath = extractMediaPathFromText(request.toolOutput);
          if (mediaPath) {
            return mediaPath;
          }
        }
      }

      const mediaDir = path.join(
        params.env.gateway.tempRoot,
        "state",
        "media",
        "tool-image-generation",
      );
      const entries = await fs.readdir(mediaDir).catch(() => []);
      const candidates = await Promise.all(
        entries.map(async (entry) => {
          const fullPath = path.join(mediaDir, entry);
          const stat = await fs.stat(fullPath).catch(() => null);
          if (!stat?.isFile()) {
            return null;
          }
          return {
            fullPath,
            mtimeMs: stat.mtimeMs,
          };
        }),
      );
      return candidates
        .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry))
        .filter((entry) => entry.mtimeMs >= params.startedAtMs - 1_000)
        .toSorted((left, right) => right.mtimeMs - left.mtimeMs)
        .at(0)?.fullPath;
    },
    params.timeoutMs,
    250,
  );
}

async function startAgentRun(
  env: QaSuiteEnvironment,
  params: {
    sessionKey: string;
    message: string;
    to?: string;
    threadId?: string;
    provider?: string;
    model?: string;
    timeoutMs?: number;
    attachments?: Array<{
      mimeType: string;
      fileName: string;
      content: string;
    }>;
  },
) {
  const target = params.to ?? "dm:qa-operator";
  const delivery = env.transport.buildAgentDelivery({ target });
  const started = (await env.gateway.call(
    "agent",
    {
      idempotencyKey: randomUUID(),
      agentId: "qa",
      sessionKey: params.sessionKey,
      message: params.message,
      deliver: true,
      channel: delivery.channel,
      to: target,
      replyChannel: delivery.replyChannel,
      replyTo: delivery.replyTo,
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.provider ? { provider: params.provider } : {}),
      ...(params.model ? { model: params.model } : {}),
      ...(params.attachments ? { attachments: params.attachments } : {}),
    },
    {
      timeoutMs: params.timeoutMs ?? 30_000,
    },
  )) as { runId?: string; status?: string };
  if (!started.runId) {
    throw new Error(`agent call did not return a runId: ${JSON.stringify(started)}`);
  }
  return started;
}

async function waitForAgentRun(env: QaSuiteEnvironment, runId: string, timeoutMs = 30_000) {
  return (await env.gateway.call(
    "agent.wait",
    {
      runId,
      timeoutMs,
    },
    {
      timeoutMs: timeoutMs + 5_000,
    },
  )) as { status?: string; error?: string };
}

async function listCronJobs(env: QaSuiteEnvironment) {
  const payload = (await env.gateway.call(
    "cron.list",
    {
      includeDisabled: true,
      limit: 200,
      sortBy: "name",
      sortDir: "asc",
    },
    { timeoutMs: 30_000 },
  )) as {
    jobs?: Array<{
      id?: string;
      name?: string;
      payload?: { kind?: string; text?: string };
      state?: { nextRunAtMs?: number };
    }>;
  };
  return payload.jobs ?? [];
}

async function readDoctorMemoryStatus(env: QaSuiteEnvironment) {
  return (await env.gateway.call("doctor.memory.status", {}, { timeoutMs: 30_000 })) as {
    dreaming?: QaDreamingStatus;
  };
}

async function forceMemoryIndex(params: {
  env: QaSuiteEnvironment;
  query: string;
  expectedNeedle: string;
}) {
  await waitForGatewayHealthy(params.env, 60_000);
  await waitForTransportReady(params.env, 60_000);
  await runQaCli(params.env, ["memory", "index", "--agent", "qa", "--force"], {
    timeoutMs: liveTurnTimeoutMs(params.env, 60_000),
  });
  const payload = await waitForCondition(
    async () => {
      const result = (await runQaCli(
        params.env,
        ["memory", "search", "--agent", "qa", "--json", "--query", params.query],
        {
          timeoutMs: liveTurnTimeoutMs(params.env, 60_000),
          json: true,
        },
      )) as { results?: Array<{ snippet?: string; text?: string; path?: string }> };
      const haystack = JSON.stringify(result.results ?? []);
      return haystack.includes(params.expectedNeedle) ? result : undefined;
    },
    liveTurnTimeoutMs(params.env, 20_000),
    500,
  );
  const haystack = JSON.stringify(payload.results ?? []);
  if (!haystack.includes(params.expectedNeedle)) {
    throw new Error(`memory index missing expected fact after reindex: ${haystack}`);
  }
}

function findSkill(skills: QaSkillStatusEntry[], name: string) {
  return skills.find((skill) => skill.name === name);
}

async function writeWorkspaceSkill(params: {
  env: QaSuiteEnvironment;
  name: string;
  body: string;
}) {
  const skillDir = path.join(params.env.gateway.workspaceDir, "skills", params.name);
  await fs.mkdir(skillDir, { recursive: true });
  const skillPath = path.join(skillDir, "SKILL.md");
  await fs.writeFile(skillPath, `${params.body.trim()}\n`, "utf8");
  return skillPath;
}

async function callPluginToolsMcp(params: {
  env: QaSuiteEnvironment;
  toolName: string;
  args: Record<string, unknown>;
}) {
  const transportEnv = Object.fromEntries(
    Object.entries(params.env.gateway.runtimeEnv).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/mcp/plugin-tools-serve.ts"],
    stderr: "pipe",
    env: transportEnv,
  });
  const client = new Client({ name: "openclaw-qa-suite", version: "0.0.0" }, {});
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const tool = listed.tools.find((entry) => entry.name === params.toolName);
    if (!tool) {
      throw new Error(`MCP tool missing: ${params.toolName}`);
    }
    return await client.callTool({
      name: params.toolName,
      arguments: params.args,
    });
  } finally {
    await client.close().catch(() => {});
  }
}

async function runAgentPrompt(
  env: QaSuiteEnvironment,
  params: {
    sessionKey: string;
    message: string;
    to?: string;
    threadId?: string;
    provider?: string;
    model?: string;
    timeoutMs?: number;
    attachments?: Array<{
      mimeType: string;
      fileName: string;
      content: string;
    }>;
  },
) {
  const started = await startAgentRun(env, params);
  const waited = await waitForAgentRun(env, started.runId!, params.timeoutMs ?? 30_000);
  if (waited.status !== "ok") {
    throw new Error(
      `agent.wait returned ${waited.status ?? "unknown"}: ${waited.error ?? "no error"}`,
    );
  }
  return {
    started,
    waited,
  };
}

async function ensureImageGenerationConfigured(env: QaSuiteEnvironment) {
  const imageModelRef = "openai/gpt-image-1";
  await patchConfig({
    env,
    patch:
      env.providerMode === "mock-openai"
        ? {
            plugins: {
              allow: [...new Set(["memory-core", "openai", ...env.transport.requiredPluginIds])],
              entries: {
                openai: {
                  enabled: true,
                },
              },
            },
            models: {
              providers: {
                openai: {
                  baseUrl: `${env.mock?.baseUrl}/v1`,
                  apiKey: "test",
                  api: "openai-responses",
                  models: [
                    {
                      id: "gpt-image-1",
                      name: "gpt-image-1",
                      api: "openai-responses",
                      reasoning: false,
                      input: ["text"],
                      cost: {
                        input: 0,
                        output: 0,
                        cacheRead: 0,
                        cacheWrite: 0,
                      },
                      contextWindow: 128_000,
                      maxTokens: 4096,
                    },
                  ],
                },
              },
            },
            agents: {
              defaults: {
                imageGenerationModel: {
                  primary: imageModelRef,
                },
              },
            },
          }
        : {
            agents: {
              defaults: {
                imageGenerationModel: {
                  primary: imageModelRef,
                },
              },
            },
          },
  });
  await waitForGatewayHealthy(env);
  await waitForTransportReady(env, 60_000);
}

async function handleQaAction(params: {
  env: QaSuiteEnvironment;
  action: QaTransportActionName;
  args: Record<string, unknown>;
}) {
  const result = await params.env.transport.handleAction({
    action: params.action,
    args: params.args,
    cfg: params.env.cfg,
  });
  return extractQaToolPayload(result as Parameters<typeof extractQaToolPayload>[0]);
}

function createScenarioFlowApi(
  env: QaSuiteEnvironment,
  scenario: ReturnType<typeof readQaBootstrapScenarioCatalog>["scenarios"][number],
) {
  return createQaScenarioRuntimeApi({
    env,
    scenario,
    deps: {
      fs,
      path,
      sleep,
      randomUUID,
      runScenario,
      waitForOutboundMessage,
      waitForTransportOutboundMessage,
      waitForChannelOutboundMessage,
      waitForNoOutbound,
      waitForNoTransportOutbound,
      recentOutboundSummary,
      formatConversationTranscript,
      readTransportTranscript,
      formatTransportTranscript,
      fetchJson,
      waitForGatewayHealthy,
      waitForTransportReady,
      waitForQaChannelReady,
      waitForConfigRestartSettle,
      patchConfig,
      applyConfig,
      readConfigSnapshot,
      createSession,
      readEffectiveTools,
      readSkillStatus,
      readRawQaSessionStore,
      runQaCli,
      extractMediaPathFromText,
      resolveGeneratedImagePath,
      startAgentRun,
      waitForAgentRun,
      listCronJobs,
      waitForCronRunCompletion,
      readDoctorMemoryStatus,
      forceMemoryIndex,
      findSkill,
      writeWorkspaceSkill,
      callPluginToolsMcp,
      runAgentPrompt,
      ensureImageGenerationConfigured,
      handleQaAction,
      extractQaToolPayload,
      formatMemoryDreamingDay,
      resolveSessionTranscriptsDirForAgent,
      buildAgentSessionKey,
      normalizeLowercaseStringOrEmpty,
      formatErrorMessage,
      liveTurnTimeoutMs,
      resolveQaLiveTurnTimeoutMs,
      splitModelRef,
      qaChannelPlugin,
      hasDiscoveryLabels,
      reportsDiscoveryScopeLeak,
      reportsMissingDiscoveryFiles,
      hasModelSwitchContinuityEvidence,
    },
    constants: {
      imageUnderstandingPngBase64: _QA_IMAGE_UNDERSTANDING_PNG_BASE64,
      imageUnderstandingLargePngBase64: _QA_IMAGE_UNDERSTANDING_LARGE_PNG_BASE64,
      imageUnderstandingValidPngBase64: QA_IMAGE_UNDERSTANDING_VALID_PNG_BASE64,
    },
  });
}

export const qaSuiteTesting = {
  collectQaSuiteGatewayConfigPatch,
  collectQaSuitePluginIds,
  createScenarioWaitForCondition,
  findFailureOutboundMessage,
  getGatewayRetryAfterMs,
  isConfigHashConflict,
  mapQaSuiteWithConcurrency,
  normalizeQaSuiteConcurrency,
  scenarioMatchesLiveLane,
  selectQaSuiteScenarios,
  readTransportTranscript,
  formatTransportTranscript,
  resolveQaSuiteOutputDir,
  waitForTransportOutboundMessage,
  waitForNoTransportOutbound,
  waitForOutboundMessage,
};

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
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
}) {
  return params.transport.createReportNotes(params);
}

async function writeQaSuiteArtifacts(params: {
  outputDir: string;
  startedAt: Date;
  finishedAt: Date;
  scenarios: QaSuiteScenarioResult[];
  transport: QaTransportAdapter;
  providerMode: "mock-openai" | "live-frontier";
  primaryModel: string;
  alternateModel: string;
  fastMode: boolean;
  concurrency: number;
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
    `${JSON.stringify(
      {
        scenarios: params.scenarios,
        counts: {
          total: params.scenarios.length,
          passed: params.scenarios.filter((scenario) => scenario.status === "pass").length,
          failed: params.scenarios.filter((scenario) => scenario.status === "fail").length,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return { report, reportPath, summaryPath };
}

export async function runQaSuite(params?: QaSuiteRunParams): Promise<QaSuiteResult> {
  const startedAt = new Date();
  const repoRoot = path.resolve(params?.repoRoot ?? process.cwd());
  const providerMode = normalizeQaProviderMode(params?.providerMode ?? "live-frontier");
  const transportId = normalizeQaTransportId(params?.transportId);
  const primaryModel = params?.primaryModel ?? defaultQaModelForMode(providerMode);
  const alternateModel =
    params?.alternateModel ?? defaultQaModelForMode(providerMode, { alternate: true });
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
  const enabledPluginIds = collectQaSuitePluginIds(selectedCatalogScenarios);
  const gatewayConfigPatch = collectQaSuiteGatewayConfigPatch(selectedCatalogScenarios);
  const concurrency = normalizeQaSuiteConcurrency(
    params?.concurrency,
    selectedCatalogScenarios.length,
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

    try {
      updateScenarioRun();
      const scenarios: QaSuiteScenarioResult[] = await mapQaSuiteWithConcurrency(
        selectedCatalogScenarios,
        concurrency,
        async (scenario, index): Promise<QaSuiteScenarioResult> => {
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
              concurrency: 1,
              startLab,
              // Isolated workers do not need their own Control UI proxy. The
              // outer lab already owns the watch surface, so skip per-worker
              // Control UI asset resolution and startup overhead.
              controlUiEnabled: false,
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
            return scenarioResult;
          }
        },
      );
      const finishedAt = new Date();
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
      });
      lab.setLatestReport({
        outputPath: reportPath,
        markdown: report,
        generatedAt: finishedAt.toISOString(),
      } satisfies QaLabLatestReport);
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
  const lab =
    params?.lab ??
    (await requireQaSuiteStartLab(startLab)({
      repoRoot,
      host: "127.0.0.1",
      port: 0,
      embeddedGateway: "disabled",
    }));
  const transport = createQaTransportAdapter({
    id: transportId,
    state: lab.state,
  });
  const mock =
    providerMode === "mock-openai"
      ? await startQaMockOpenAiServer({
          host: "127.0.0.1",
          port: 0,
        })
      : null;
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
    mutateConfig: gatewayConfigPatch
      ? (cfg) => applyQaMergePatch(cfg, gatewayConfigPatch) as OpenClawConfig
      : undefined,
  });
  lab.setControlUi({
    controlUiProxyTarget: gateway.baseUrl,
    controlUiToken: gateway.token,
  });
  const env: QaSuiteEnvironment = {
    lab,
    mock,
    gateway,
    cfg: transport.createGatewayConfig({
      baseUrl: lab.listenUrl,
    }),
    transport,
    repoRoot,
    providerMode,
    primaryModel,
    alternateModel,
  };

  let preserveGatewayRuntimeDir: string | undefined;
  try {
    // The gateway child already waits for /readyz before returning, but the
    // selected transport can still be finishing account startup. Pay that
    // readiness cost once here so the first scenario does not race bootstrap.
    await waitForTransportReady(env, 120_000).catch(async () => {
      await waitForGatewayHealthy(env, 120_000);
      await waitForTransportReady(env, 120_000);
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

    for (const [index, scenario] of selectedCatalogScenarios.entries()) {
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
      transport,
      providerMode,
      primaryModel,
      alternateModel,
      fastMode,
      concurrency,
    });
    const latestReport = {
      outputPath: reportPath,
      markdown: report,
      generatedAt: finishedAt.toISOString(),
    } satisfies QaLabLatestReport;
    lab.setLatestReport(latestReport);

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
