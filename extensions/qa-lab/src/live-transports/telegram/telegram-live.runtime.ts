// Qa Lab plugin module implements telegram live behavior.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { TelegramBotMessage, TelegramBotUpdate } from "@openclaw/telegram/api.js";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import {
  parseStrictPositiveInteger,
  resolveTimerTimeoutMs,
} from "openclaw/plugin-sdk/number-runtime";
import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { isRecord, uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { truncateUtf16Safe } from "openclaw/plugin-sdk/text-utility-runtime";
import { z } from "zod";
import { createQaArtifactRunId } from "../../artifact-run-id.js";
import {
  QA_EVIDENCE_FILENAME,
  buildLiveTransportEvidenceSummary,
  type QaEvidenceTiming,
} from "../../evidence-summary.js";
import { startQaGatewayChild, type QaGatewayChildCommand } from "../../gateway-child.js";
import {
  assertQaGatewayCredentialLeaseQuarantine,
  shouldRetainQaGatewayCredentialLease,
} from "../../gateway-process-boundary.js";
import { isTruthyOptIn } from "../../mantis-options.runtime.js";
import {
  parseQaProgressBooleanEnv as parseTelegramQaProgressBooleanEnv,
  sanitizeQaProgressValue as sanitizeTelegramQaProgressValue,
} from "../../progress-format.js";
import { DEFAULT_QA_LIVE_PROVIDER_MODE } from "../../providers/index.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderMode,
  type QaProviderModeInput,
} from "../../run-config.js";
import {
  acquireQaCredentialLease,
  startQaCredentialLeaseHeartbeat,
} from "../shared/credential-lease.runtime.js";
import {
  appendQaLiveLaneIssue as appendLiveLaneIssue,
  buildQaLiveLaneArtifactsError as buildLiveLaneArtifactsError,
  redactQaLiveLaneIssues,
} from "../shared/live-artifacts.js";
import { startQaLiveLaneGateway } from "../shared/live-gateway.runtime.js";
import { assertLiveScenarioReply as assertTelegramScenarioReply } from "../shared/live-scenario-reply.js";
import type { LiveTransportCheckResult } from "../shared/live-transport-result.js";
import {
  normalizeLiveTransportRttOptions,
  summarizeLiveTransportRttSamples,
  type LiveTransportRttOptions,
  type LiveTransportRttSample,
} from "../shared/live-transport-rtt.js";
import {
  collectLiveTransportStandardScenarioCoverage,
  selectLiveTransportScenarios,
  type LiveTransportScenarioDefinition,
} from "../shared/live-transport-scenarios.js";

type TelegramQaRuntimeEnv = {
  groupId: string;
  driverToken: string;
  sutToken: string;
};

type TelegramBotIdentity = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
};

type TelegramQaScenarioId =
  | "telegram-other-bot-command-gating"
  | "telegram-stream-final-single-message"
  | "telegram-long-final-three-chunks"
  | "telegram-long-final-reuses-preview"
  | "telegram-mentioned-message-reply"
  | "telegram-mention-gating";

type TelegramQaScenarioStep = {
  allowAnySutReply?: boolean;
  expectReply: boolean;
  input: string;
  expectedTextIncludes?: string[];
  expectedJoinedSutTextIncludes?: string[];
  expectedSutMessageCount?: number;
  expectedSutMessageCountRange?: readonly [number, number];
  matchText?: string;
  replyToLatestSutMessage?: boolean;
  settleMs?: number;
  timeoutMs?: number;
};

type TelegramQaScenarioRun = {
  steps: TelegramQaScenarioStep[];
};

type TelegramQaScenarioDefinition = LiveTransportScenarioDefinition<TelegramQaScenarioId> & {
  buildRun: (sutUsername: string) => TelegramQaScenarioRun;
  buildRttRun?: (params: { rttIndex: number; sutUsername: string }) => TelegramQaScenarioRun;
  defaultEnabled?: boolean;
  defaultProviderModes?: readonly QaProviderMode[];
  evidenceCoverageIds?: readonly string[];
  regressionRefs?: readonly string[];
  rationale: string;
};

type TelegramObservedMessage = {
  updateId: number;
  messageId: number;
  chatId: number;
  senderId: number;
  senderIsBot: boolean;
  senderUsername?: string;
  scenarioId?: string;
  scenarioTitle?: string;
  matchedScenario?: boolean;
  text: string;
  caption?: string;
  replyToMessageId?: number;
  timestamp: number;
  inlineButtons: string[];
  mediaKinds: string[];
};

const DEFAULT_TELEGRAM_QA_CANARY_TIMEOUT_MS = 30_000;
const TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS = 45_000;

type TelegramQaScenarioResult = LiveTransportCheckResult;

function telegramLiveTransportCoverageIds(scenario: TelegramQaScenarioDefinition) {
  if (scenario.evidenceCoverageIds) {
    return scenario.evidenceCoverageIds;
  }
  return scenario.standardId ? [`channels.telegram.${scenario.standardId}`] : [];
}

type TelegramQaRttOptions = LiveTransportRttOptions<TelegramQaScenarioId>;

type TelegramQaRttResult = {
  details: string;
  driverOffset: number;
  failed: number;
  latestSutMessageId?: number;
  passed: number;
  timing: QaEvidenceTiming;
};

type TelegramQaCanaryPhase = "sut_reply_timeout" | "sut_reply_not_threaded" | "sut_reply_empty";

type TelegramQaRunResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  gatewayDebugDirPath?: string;
  scenarios: TelegramQaScenarioResult[];
};

type TelegramChannelStatus = {
  connected?: boolean;
  lastConnectedAt?: number;
  lastDisconnect?: unknown;
  lastError?: string | null;
  restartPending?: boolean;
  running?: boolean;
};

class TelegramQaCanaryError extends Error {
  phase: TelegramQaCanaryPhase;
  context: Record<string, string | number | undefined>;

  constructor(
    phase: TelegramQaCanaryPhase,
    message: string,
    context: Record<string, string | number | undefined>,
  ) {
    super(message);
    this.name = "TelegramQaCanaryError";
    this.phase = phase;
    this.context = context;
  }
}

function isTelegramQaCanaryError(error: unknown): error is TelegramQaCanaryError {
  return (
    error instanceof TelegramQaCanaryError ||
    (typeof error === "object" &&
      error !== null &&
      typeof (error as { phase?: unknown }).phase === "string" &&
      typeof (error as { context?: unknown }).context === "object" &&
      (error as { context?: unknown }).context !== null)
  );
}

type TelegramApiEnvelope<T> = {
  ok: boolean;
  result?: T;
  description?: string;
};

type TelegramReplyMarkup = {
  inline_keyboard?: Array<Array<{ text?: string }>>;
};

type TelegramRichMessage = {
  markdown?: string;
  html?: string;
  blocks?: unknown[];
};

type TelegramMessage = Pick<TelegramBotMessage, "date" | "message_id"> &
  Partial<Pick<TelegramBotMessage, "caption" | "text">> & {
    audio?: unknown;
    chat: { id: number };
    document?: unknown;
    from?: Pick<NonNullable<TelegramBotMessage["from"]>, "id" | "is_bot" | "username">;
    photo?: unknown[];
    rich_message?: TelegramRichMessage;
    reply_markup?: TelegramReplyMarkup;
    reply_to_message?: { message_id?: number };
    sticker?: unknown;
    video?: unknown;
    voice?: unknown;
  };

type TelegramUpdate = Pick<TelegramBotUpdate, "update_id"> & {
  edited_message?: TelegramMessage;
  message?: TelegramMessage;
};

type TelegramSendMessageResult = {
  message_id: number;
  chat: {
    id: number;
  };
};

function telegramQaStepRun(step: TelegramQaScenarioStep): TelegramQaScenarioRun {
  return { steps: [step] };
}

const TELEGRAM_QA_SCENARIOS: TelegramQaScenarioDefinition[] = [
  {
    id: "telegram-other-bot-command-gating",
    title: "Telegram command addressed to another bot is ignored",
    rationale: "Bot-to-bot groups must not let commands addressed to another bot wake the SUT.",
    timeoutMs: 8_000,
    buildRun: () =>
      telegramQaStepRun({
        expectReply: false,
        input: "/status@OpenClawQaOtherBot",
      }),
  },
  {
    id: "telegram-mentioned-message-reply",
    title: "Telegram mentioned message gets a reply",
    evidenceCoverageIds: ["channels.telegram.mention-gating"],
    rationale: "Bot-to-bot group mention routing must produce a threaded SUT reply.",
    timeoutMs: 45_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        expectReply: true,
        input: `@${sutUsername} Telegram QA mention routing check. Reply with a short acknowledgement.`,
        replyToLatestSutMessage: true,
      }),
    buildRttRun: ({ rttIndex, sutUsername }) => {
      const marker = `QA-TELEGRAM-RTT-${rttIndex}-${randomUUID().slice(0, 8).toUpperCase()}`;
      return telegramQaStepRun({
        expectReply: true,
        input: `@${sutUsername} Telegram RTT check ${rttIndex}. Reply exactly: ${marker}`,
        expectedTextIncludes: [marker],
        matchText: marker,
        replyToLatestSutMessage: true,
      });
    },
  },
  {
    id: "telegram-stream-final-single-message",
    title: "Telegram streamed final stays one message",
    defaultEnabled: false,
    defaultProviderModes: ["mock-openai"],
    rationale: "Opt-in regression guard for duplicate final replies from Telegram streaming paths.",
    regressionRefs: ["openclaw/openclaw#39905"],
    timeoutMs: 75_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        allowAnySutReply: true,
        expectReply: true,
        input: `@${sutUsername} Quiet streaming QA check. Reply exactly: QA-TELEGRAM-STREAM-SINGLE-OK`,
        expectedTextIncludes: ["QA-TELEGRAM-STREAM-SINGLE-OK"],
        expectedJoinedSutTextIncludes: ["QA-TELEGRAM-STREAM-SINGLE-OK"],
        expectedSutMessageCount: 1,
        settleMs: 4_000,
      }),
  },
  {
    id: "telegram-long-final-reuses-preview",
    title: "Telegram long final reuses the preview message",
    defaultProviderModes: ["mock-openai"],
    rationale: "Regression guard for long streamed finals leaving stale preview messages behind.",
    regressionRefs: ["openclaw/openclaw#39905"],
    timeoutMs: 60_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        allowAnySutReply: true,
        expectReply: true,
        input: `@${sutUsername} Telegram long final QA check. Use the scripted long final response.`,
        expectedTextIncludes: ["TELEGRAM-LONG-FINAL-BEGIN"],
        expectedJoinedSutTextIncludes: ["TELEGRAM-LONG-FINAL-BEGIN", "TELEGRAM-LONG-FINAL-END"],
        expectedSutMessageCountRange: [1, 2],
        replyToLatestSutMessage: true,
        settleMs: 4_000,
      }),
  },
  {
    id: "telegram-long-final-three-chunks",
    title: "Telegram three-chunk final keeps only final chunks",
    defaultEnabled: false,
    rationale: "Opt-in stress probe for Telegram long final chunk accounting.",
    regressionRefs: ["openclaw/openclaw#39905"],
    timeoutMs: 60_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        allowAnySutReply: true,
        expectReply: true,
        input: `@${sutUsername} Telegram long final three chunk QA check. Use the scripted three chunk final response.`,
        expectedTextIncludes: ["TELEGRAM-LONG-FINAL-3CHUNK-BEGIN"],
        expectedJoinedSutTextIncludes: [
          "TELEGRAM-LONG-FINAL-3CHUNK-BEGIN",
          "TELEGRAM-LONG-FINAL-3CHUNK-END",
        ],
        expectedSutMessageCount: 3,
        replyToLatestSutMessage: true,
        settleMs: 4_000,
      }),
  },
  {
    id: "telegram-mention-gating",
    standardId: "mention-gating",
    title: "Telegram group message without mention does not trigger",
    rationale: "Required group mention gate should suppress ordinary group chatter.",
    timeoutMs: 8_000,
    buildRun: () => {
      const token = `TELEGRAM_QA_NOMENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return telegramQaStepRun({
        expectReply: false,
        input: `reply with only this exact marker: ${token}`,
        matchText: token,
      });
    },
  },
];

const TELEGRAM_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  alwaysOnStandardScenarioIds: ["canary"],
  scenarios: TELEGRAM_QA_SCENARIOS,
});

const TELEGRAM_QA_ENV_KEYS = [
  "OPENCLAW_QA_TELEGRAM_GROUP_ID",
  "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
] as const;
const QA_REDACT_PUBLIC_METADATA_ENV = "OPENCLAW_QA_REDACT_PUBLIC_METADATA";
const QA_SUITE_PROGRESS_ENV = "OPENCLAW_QA_SUITE_PROGRESS";
const TELEGRAM_QA_PROGRESS_DETAIL_LIMIT = 240;
const TELEGRAM_QA_PROGRESS_PREFIX = "[qa-telegram-live]";

const telegramQaCredentialPayloadSchema = z.object({
  groupId: z.string().trim().min(1),
  driverToken: z.string().trim().min(1),
  sutToken: z.string().trim().min(1),
});

function resolveEnvValue(env: NodeJS.ProcessEnv, key: (typeof TELEGRAM_QA_ENV_KEYS)[number]) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

function shouldLogTelegramQaLiveProgress(env: NodeJS.ProcessEnv = process.env) {
  const override = parseTelegramQaProgressBooleanEnv(env[QA_SUITE_PROGRESS_ENV]);
  if (override !== undefined) {
    return override;
  }
  return parseTelegramQaProgressBooleanEnv(env.CI) === true;
}

function parsePositiveTelegramQaEnvMs(env: NodeJS.ProcessEnv, name: string, fallbackMs: number) {
  const raw = env[name];
  if (raw === undefined) {
    return fallbackMs;
  }
  const parsed = parseStrictPositiveInteger(raw);
  if (parsed === undefined) {
    return fallbackMs;
  }
  return parsed;
}

function resolveTelegramQaCanaryTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  return parsePositiveTelegramQaEnvMs(
    env,
    "OPENCLAW_QA_TELEGRAM_CANARY_TIMEOUT_MS",
    DEFAULT_TELEGRAM_QA_CANARY_TIMEOUT_MS,
  );
}

function resolveTelegramQaScenarioTimeoutMs(
  fallbackMs: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  return parsePositiveTelegramQaEnvMs(env, "OPENCLAW_QA_TELEGRAM_SCENARIO_TIMEOUT_MS", fallbackMs);
}

function resolveTelegramQaReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS;
  if (!raw) {
    return TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS;
  }
  return parseStrictPositiveInteger(raw) ?? TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS;
}

function normalizeTelegramQaRttOptions(params: {
  count?: number;
  checkIds?: readonly string[];
  maxFailures?: number;
  timeoutMs?: number;
}): TelegramQaRttOptions | undefined {
  const knownScenarioIds = new Set(TELEGRAM_QA_SCENARIOS.map((scenario) => scenario.id));
  return normalizeLiveTransportRttOptions({
    count: params.count,
    defaultCheckIds: ["telegram-mentioned-message-reply"],
    knownCheckIds: knownScenarioIds,
    maxFailures: params.maxFailures,
    rawCheckIds: params.checkIds,
    timeoutMs: params.timeoutMs,
    unknownCheckMessage: (checkId) => `unknown Telegram QA RTT check: ${checkId}`,
  });
}

function assertTelegramQaRttCheckSupport(params: {
  rttOptions?: TelegramQaRttOptions;
  scenarios: TelegramQaScenarioDefinition[];
}) {
  if (!params.rttOptions) {
    return;
  }
  const selectedScenarioIds = new Set(params.scenarios.map((scenario) => scenario.id));
  for (const scenarioId of params.rttOptions.checkIds) {
    if (!selectedScenarioIds.has(scenarioId)) {
      throw new Error(`Telegram QA RTT check ${scenarioId} is not selected.`);
    }
  }
  for (const scenario of params.scenarios) {
    if (params.rttOptions.checkIds.has(scenario.id) && !scenario.buildRttRun) {
      throw new Error(`Telegram QA scenario ${scenario.id} does not support RTT measurement.`);
    }
  }
}

function formatTelegramQaTimeoutSeconds(timeoutMs: number) {
  return `${Math.round(timeoutMs / 1_000)}s`;
}

function writeTelegramQaProgress(enabled: boolean, message: string) {
  if (!enabled) {
    return;
  }
  process.stderr.write(`${TELEGRAM_QA_PROGRESS_PREFIX} ${message}\n`);
}

function formatTelegramQaProgressDetails(details: string): string {
  const sanitized = sanitizeTelegramQaProgressValue(details);
  if (sanitized.length <= TELEGRAM_QA_PROGRESS_DETAIL_LIMIT) {
    return sanitized;
  }
  return `${truncateUtf16Safe(sanitized, TELEGRAM_QA_PROGRESS_DETAIL_LIMIT - 3).trimEnd()}...`;
}

function resolveTelegramQaRuntimeEnv(env: NodeJS.ProcessEnv = process.env): TelegramQaRuntimeEnv {
  const groupId = resolveEnvValue(env, "OPENCLAW_QA_TELEGRAM_GROUP_ID");
  if (!/^-?\d+$/u.test(groupId)) {
    throw new Error("OPENCLAW_QA_TELEGRAM_GROUP_ID must be a numeric Telegram chat id.");
  }
  return {
    groupId,
    driverToken: resolveEnvValue(env, "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN"),
    sutToken: resolveEnvValue(env, "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN"),
  };
}

function parseTelegramQaCredentialPayload(payload: unknown): TelegramQaRuntimeEnv {
  const parsed = telegramQaCredentialPayloadSchema.parse(payload);
  if (!/^-?\d+$/u.test(parsed.groupId)) {
    throw new Error("Telegram credential payload groupId must be a numeric Telegram chat id.");
  }
  return {
    groupId: parsed.groupId,
    driverToken: parsed.driverToken,
    sutToken: parsed.sutToken,
  };
}

function flattenInlineButtons(replyMarkup?: TelegramReplyMarkup) {
  return (replyMarkup?.inline_keyboard ?? [])
    .flat()
    .map((button) => button.text?.trim())
    .filter((text): text is string => Boolean(text));
}

function detectMediaKinds(message: TelegramMessage) {
  const kinds: string[] = [];
  if (Array.isArray(message.photo) && message.photo.length > 0) {
    kinds.push("photo");
  }
  if (message.document) {
    kinds.push("document");
  }
  if (message.audio) {
    kinds.push("audio");
  }
  if (message.video) {
    kinds.push("video");
  }
  if (message.voice) {
    kinds.push("voice");
  }
  if (message.sticker) {
    kinds.push("sticker");
  }
  return kinds;
}

function flattenTelegramRichText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((part) => flattenTelegramRichText(part)).join("");
  }
  if (!isRecord(value)) {
    return "";
  }
  if ("text" in value) {
    return flattenTelegramRichText(value.text);
  }
  if (typeof value.alternative_text === "string") {
    return value.alternative_text;
  }
  if (typeof value.expression === "string") {
    return value.expression;
  }
  return "";
}

function flattenTelegramRichBlock(value: unknown): string {
  if (typeof value === "string" || Array.isArray(value)) {
    return flattenTelegramRichText(value);
  }
  if (!isRecord(value)) {
    return "";
  }
  const parts: string[] = [];
  if ("text" in value) {
    parts.push(flattenTelegramRichText(value.text));
  }
  if ("summary" in value) {
    parts.push(flattenTelegramRichText(value.summary));
  }
  if (typeof value.label === "string") {
    parts.push(value.label);
  }
  if (typeof value.expression === "string") {
    parts.push(value.expression);
  }
  if ("blocks" in value) {
    parts.push(flattenTelegramRichBlocks(value.blocks));
  }
  if ("items" in value) {
    parts.push(flattenTelegramRichBlocks(value.items));
  }
  if ("cells" in value) {
    parts.push(flattenTelegramRichTableCells(value.cells));
  }
  if ("caption" in value) {
    parts.push(flattenTelegramRichBlock(value.caption));
  }
  if ("credit" in value) {
    parts.push(flattenTelegramRichText(value.credit));
  }
  return parts.filter((part) => part.trim()).join("\n");
}

function flattenTelegramRichBlocks(value: unknown): string {
  const blocks = Array.isArray(value) ? value : [value];
  return blocks
    .map((block) => flattenTelegramRichBlock(block))
    .filter((part) => part.trim())
    .join("\n");
}

function flattenTelegramRichTableCells(value: unknown): string {
  if (!Array.isArray(value)) {
    return flattenTelegramRichBlock(value);
  }
  return value
    .map((row) => {
      const cells = Array.isArray(row) ? row : [row];
      return cells
        .map((cell) => flattenTelegramRichBlock(cell))
        .filter((cell) => cell.trim())
        .join("\t");
    })
    .filter((row) => row.trim())
    .join("\n");
}

function selectTelegramRichMessageText(richMessage: TelegramRichMessage | undefined) {
  return (
    richMessage?.markdown || richMessage?.html || flattenTelegramRichBlocks(richMessage?.blocks)
  );
}

function selectTelegramObservedText(message: TelegramMessage) {
  return (
    message.text || message.caption || selectTelegramRichMessageText(message.rich_message) || ""
  );
}

function normalizeTelegramObservedMessage(update: TelegramUpdate): TelegramObservedMessage | null {
  const message = update.message ?? update.edited_message;
  if (!message?.from?.id) {
    return null;
  }
  return {
    updateId: update.update_id,
    messageId: message.message_id,
    chatId: message.chat.id,
    senderId: message.from.id,
    senderIsBot: message.from.is_bot,
    senderUsername: message.from.username,
    text: selectTelegramObservedText(message),
    caption: message.caption,
    replyToMessageId: message.reply_to_message?.message_id,
    timestamp: message.date * 1000,
    inlineButtons: flattenInlineButtons(message.reply_markup),
    mediaKinds: detectMediaKinds(message),
  };
}

function buildTelegramQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    groupId: string;
    sutToken: string;
    driverBotId: number;
    sutAccountId: string;
  },
): OpenClawConfig {
  const pluginAllow = uniqueStrings([...(baseCfg.plugins?.allow ?? []), "telegram"]);
  const pluginEntries = {
    ...baseCfg.plugins?.entries,
    telegram: { enabled: true },
  };
  return {
    ...baseCfg,
    agents: {
      ...baseCfg.agents,
      defaults: {
        ...baseCfg.agents?.defaults,
        models: {
          ...baseCfg.agents?.defaults?.models,
          "openai/gpt-5.6-luna": {
            ...baseCfg.agents?.defaults?.models?.["openai/gpt-5.6-luna"],
            agentRuntime: { id: "openclaw" },
          },
        },
        skipBootstrap: true,
      },
    },
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: pluginEntries,
    },
    messages: {
      ...baseCfg.messages,
      groupChat: {
        ...baseCfg.messages?.groupChat,
        visibleReplies: "automatic",
      },
    },
    channels: {
      ...baseCfg.channels,
      telegram: {
        enabled: true,
        defaultAccount: params.sutAccountId,
        accounts: {
          [params.sutAccountId]: {
            enabled: true,
            botToken: params.sutToken,
            dmPolicy: "disabled",
            replyToMode: "first",
            groups: {
              [params.groupId]: {
                groupPolicy: "allowlist",
                allowFrom: [String(params.driverBotId)],
                requireMention: true,
              },
            },
          },
        },
      },
    },
  };
}

async function callTelegramApi<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
  timeoutMs = 15_000,
): Promise<T> {
  const requestTimeoutMs = resolveTimerTimeoutMs(timeoutMs, 15_000);
  const { response, release } = await fetchWithSsrFGuard({
    url: `https://api.telegram.org/bot${token}/${method}`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    },
    timeoutMs: requestTimeoutMs,
    policy: { hostnameAllowlist: ["api.telegram.org"] },
    auditContext: "qa-lab-telegram-live",
    capture: false,
  });
  try {
    const payload = await readProviderJsonResponse<TelegramApiEnvelope<T>>(
      response,
      `qa-lab-telegram-live.${method}`,
    );
    if (!response.ok || !payload.ok || payload.result === undefined) {
      throw new Error(
        payload.description?.trim() || `${method} failed with status ${response.status}`,
      );
    }
    return payload.result;
  } finally {
    await release();
  }
}

function isRecoverableTelegramQaPollError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return (
    message.includes("fetch failed") ||
    message.includes("aborted due to timeout") ||
    message.includes("operation was aborted") ||
    message.includes("request timed out") ||
    message.includes("aborterror") ||
    message.includes("econnreset") ||
    message.includes("etimedout") ||
    message.includes("socket hang up") ||
    message.includes("terminated")
  );
}

async function getBotIdentity(token: string) {
  return await callTelegramApi<TelegramBotIdentity>(token, "getMe");
}

async function flushTelegramUpdates(token: string) {
  const startedAt = Date.now();
  let offset = 0;
  while (Date.now() - startedAt < 15_000) {
    const updates = await callTelegramApi<TelegramUpdate[]>(
      token,
      "getUpdates",
      {
        offset,
        timeout: 0,
        allowed_updates: ["message", "edited_message"],
      },
      15_000,
    );
    if (updates.length === 0) {
      return offset;
    }
    offset = (updates.at(-1)?.update_id ?? offset) + 1;
  }
  throw new Error("timed out after 15000ms draining Telegram updates");
}

async function sendGroupMessage(
  token: string,
  groupId: string,
  text: string,
  opts: { replyToMessageId?: number } = {},
) {
  return await callTelegramApi<TelegramSendMessageResult>(token, "sendMessage", {
    chat_id: groupId,
    text,
    disable_notification: true,
    ...(opts.replyToMessageId !== undefined
      ? {
          reply_parameters: {
            message_id: opts.replyToMessageId,
            allow_sending_without_reply: true,
          },
        }
      : {}),
  });
}

async function waitForTelegramPollRetryDelay(remainingMs: number) {
  await new Promise((resolve) => {
    setTimeout(resolve, Math.min(250, Math.max(100, remainingMs)));
  });
}

async function waitForObservedMessage(params: {
  token: string;
  initialOffset: number;
  timeoutMs: number;
  predicate: (message: TelegramObservedMessage) => boolean;
  observedMessages: TelegramObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
  expectedTextIncludes?: string[];
  validateMatchedMessage?: (message: TelegramObservedMessage) => void;
}) {
  const startedAt = Date.now();
  let offset = params.initialOffset;
  let lastPollingError: unknown;
  let lastExpectedMismatch: Error | undefined;
  while (Date.now() - startedAt < params.timeoutMs) {
    const remainingMs = Math.max(
      1_000,
      Math.min(10_000, params.timeoutMs - (Date.now() - startedAt)),
    );
    const timeoutSeconds = Math.max(1, Math.min(10, Math.floor(remainingMs / 1000)));
    let updates: TelegramUpdate[];
    try {
      updates = await callTelegramApi<TelegramUpdate[]>(
        params.token,
        "getUpdates",
        {
          offset,
          timeout: timeoutSeconds,
          allowed_updates: ["message", "edited_message"],
        },
        timeoutSeconds * 1000 + 5_000,
      );
      lastPollingError = undefined;
    } catch (error) {
      if (!isRecoverableTelegramQaPollError(error)) {
        throw error;
      }
      lastPollingError = error;
      await waitForTelegramPollRetryDelay(params.timeoutMs - (Date.now() - startedAt));
      continue;
    }
    const batchObservedAtMs = Date.now();
    if (updates.length === 0) {
      continue;
    }
    offset = (updates.at(-1)?.update_id ?? offset) + 1;
    for (const update of updates) {
      const normalized = normalizeTelegramObservedMessage(update);
      if (!normalized) {
        continue;
      }
      const matchedScenario = params.predicate(normalized);
      const observedMessage: TelegramObservedMessage = {
        ...normalized,
        scenarioId: params.observationScenarioId,
        scenarioTitle: params.observationScenarioTitle,
        matchedScenario,
      };
      params.observedMessages.push(observedMessage);
      if (matchedScenario) {
        try {
          if (params.validateMatchedMessage) {
            params.validateMatchedMessage(observedMessage);
          } else {
            assertTelegramScenarioReply({
              expectedTextIncludes: params.expectedTextIncludes,
              message: observedMessage,
            });
          }
        } catch (error) {
          lastExpectedMismatch =
            error instanceof Error ? error : new Error(formatErrorMessage(error));
          continue;
        }
        return { message: observedMessage, nextOffset: offset, observedAtMs: batchObservedAtMs };
      }
    }
  }
  if (lastExpectedMismatch) {
    throw lastExpectedMismatch;
  }
  const timeoutMessage = `timed out after ${params.timeoutMs}ms waiting for Telegram message`;
  if (lastPollingError) {
    throw new Error(
      `${timeoutMessage}; last polling error: ${formatErrorMessage(lastPollingError)}`,
    );
  }
  throw new Error(timeoutMessage);
}

async function collectObservedMessages(params: {
  token: string;
  initialOffset: number;
  settleMs: number;
  predicate: (message: TelegramObservedMessage) => boolean;
  observedMessages: TelegramObservedMessage[];
  observationScenarioId: string;
  observationScenarioTitle: string;
}) {
  const startedAt = Date.now();
  let offset = params.initialOffset;
  while (Date.now() - startedAt < params.settleMs) {
    const remainingMs = Math.max(1, params.settleMs - (Date.now() - startedAt));
    const timeoutSeconds = Math.max(1, Math.min(2, Math.ceil(remainingMs / 1000)));
    let updates: TelegramUpdate[];
    try {
      updates = await callTelegramApi<TelegramUpdate[]>(
        params.token,
        "getUpdates",
        {
          offset,
          timeout: timeoutSeconds,
          allowed_updates: ["message", "edited_message"],
        },
        timeoutSeconds * 1000 + 5_000,
      );
    } catch (error) {
      if (!isRecoverableTelegramQaPollError(error)) {
        throw error;
      }
      await waitForTelegramPollRetryDelay(params.settleMs - (Date.now() - startedAt));
      continue;
    }
    if (updates.length === 0) {
      continue;
    }
    offset = (updates.at(-1)?.update_id ?? offset) + 1;
    for (const update of updates) {
      const normalized = normalizeTelegramObservedMessage(update);
      if (!normalized) {
        continue;
      }
      params.observedMessages.push({
        ...normalized,
        scenarioId: params.observationScenarioId,
        scenarioTitle: params.observationScenarioTitle,
        matchedScenario: params.predicate(normalized),
      });
    }
  }
  return offset;
}

function assertTelegramScenarioMessageSet(params: {
  expectedJoinedSutTextIncludes?: string[];
  expectedSutMessageCount?: number;
  expectedSutMessageCountRange?: readonly [number, number];
  groupId: string;
  observedMessages: TelegramObservedMessage[];
  scenarioId: string;
  sutBotId: number;
}) {
  if (
    params.expectedSutMessageCount === undefined &&
    params.expectedSutMessageCountRange === undefined &&
    (params.expectedJoinedSutTextIncludes ?? []).length === 0
  ) {
    return;
  }
  const byMessageId = new Map<number, TelegramObservedMessage>();
  for (const message of params.observedMessages) {
    if (
      message.scenarioId === params.scenarioId &&
      message.chatId === Number(params.groupId) &&
      message.senderId === params.sutBotId
    ) {
      byMessageId.set(message.messageId, message);
    }
  }
  const messages = [...byMessageId.values()].toSorted((a, b) => a.messageId - b.messageId);
  if (
    params.expectedSutMessageCount !== undefined &&
    messages.length !== params.expectedSutMessageCount
  ) {
    throw new Error(
      `expected ${params.expectedSutMessageCount} SUT message(s), observed ${messages.length}: ${messages
        .map((message) => message.messageId)
        .join(", ")}`,
    );
  }
  if (params.expectedSutMessageCountRange !== undefined) {
    const [min, max] = params.expectedSutMessageCountRange;
    if (messages.length < min || messages.length > max) {
      throw new Error(
        `expected ${min}-${max} SUT message(s), observed ${messages.length}: ${messages
          .map((message) => message.messageId)
          .join(", ")}`,
      );
    }
  }
  const joinedText = messages.map((message) => message.text).join("");
  for (const expected of params.expectedJoinedSutTextIncludes ?? []) {
    if (!joinedText.includes(expected)) {
      throw new Error(`joined SUT reply text missing expected text: ${expected}`);
    }
  }
}

async function waitForTelegramChannelRunning(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  accountId: string,
  options?: {
    env?: NodeJS.ProcessEnv;
    pollMs?: number;
    timeoutMs?: number;
  },
) {
  const startedAt = Date.now();
  const timeoutMs = options?.timeoutMs ?? resolveTelegramQaReadyTimeoutMs(options?.env);
  const pollMs = options?.pollMs ?? 500;
  let lastProbeError: string | undefined;
  let lastStatus: TelegramChannelStatus | undefined;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{
            accountId?: string;
            connected?: boolean;
            lastConnectedAt?: number;
            lastDisconnect?: unknown;
            lastError?: string | null;
            running?: boolean;
            restartPending?: boolean;
          }>
        >;
      };
      const accounts = payload.channelAccounts?.telegram ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      lastProbeError = undefined;
      lastStatus = match
        ? {
            connected: match.connected,
            lastConnectedAt: match.lastConnectedAt,
            lastDisconnect: match.lastDisconnect,
            lastError: match.lastError,
            restartPending: match.restartPending,
            running: match.running,
          }
        : undefined;
      if (match?.running && match.connected === true && match.restartPending !== true) {
        return;
      }
    } catch (error) {
      lastProbeError = formatErrorMessage(error);
      // retry
    }
    await new Promise((resolve) => {
      setTimeout(resolve, pollMs);
    });
  }
  const details = lastStatus
    ? `; last status: ${JSON.stringify(lastStatus)}`
    : lastProbeError
      ? `; last probe error: ${lastProbeError}`
      : "";
  throw new Error(`telegram account "${accountId}" did not become ready${details}`);
}

function renderTelegramQaMarkdown(params: {
  cleanupIssues: string[];
  credentialSource: "convex" | "env";
  redactMetadata: boolean;
  groupId: string;
  gatewayDebugDirPath?: string;
  startedAt: string;
  finishedAt: string;
  scenarios: TelegramQaScenarioResult[];
}) {
  const lines = [
    "# Telegram QA Report",
    "",
    `- Credential source: \`${params.credentialSource}\``,
    `- Group: \`${params.groupId}\``,
    `- Metadata redaction: \`${params.redactMetadata ? "enabled" : "disabled"}\``,
    `- Started: ${params.startedAt}`,
    `- Finished: ${params.finishedAt}`,
    "",
    "## Scenarios",
    "",
  ];
  for (const scenario of params.scenarios) {
    lines.push(`### ${scenario.title}`);
    lines.push("");
    lines.push(`- Status: ${scenario.status}`);
    lines.push(`- Details: ${scenario.details}`);
    if (scenario.rttMs !== undefined) {
      lines.push(`- RTT: ${scenario.rttMs}ms`);
    }
    if (scenario.timing?.samples !== undefined) {
      lines.push(
        `- Samples: ${scenario.timing.samples - (scenario.timing.failedSamples ?? 0)}/${scenario.timing.samples}`,
      );
      if (scenario.timing.avgMs !== undefined) {
        lines.push(`- Avg: ${scenario.timing.avgMs}ms`);
      }
      if (scenario.timing.p50Ms !== undefined) {
        lines.push(`- P50: ${scenario.timing.p50Ms}ms`);
      }
      if (scenario.timing.p95Ms !== undefined) {
        lines.push(`- P95: ${scenario.timing.p95Ms}ms`);
      }
      if (scenario.timing.maxMs !== undefined) {
        lines.push(`- Max: ${scenario.timing.maxMs}ms`);
      }
    }
    lines.push("");
  }
  if (params.gatewayDebugDirPath) {
    lines.push("## Gateway Debug");
    lines.push("");
    lines.push(`- Preserved at: \`${params.gatewayDebugDirPath}\``);
    lines.push("");
  }
  if (params.cleanupIssues.length > 0) {
    lines.push("## Cleanup");
    lines.push("");
    for (const issue of params.cleanupIssues) {
      lines.push(`- ${issue}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

function shouldRunTelegramScenarioByDefault(
  scenario: TelegramQaScenarioDefinition,
  providerMode: QaProviderMode,
) {
  if (scenario.defaultEnabled === false) {
    return false;
  }
  return !scenario.defaultProviderModes || scenario.defaultProviderModes.includes(providerMode);
}

function findScenario(
  ids?: string[],
  providerMode: QaProviderMode = DEFAULT_QA_LIVE_PROVIDER_MODE,
) {
  const scenarios =
    ids && ids.length > 0
      ? TELEGRAM_QA_SCENARIOS
      : TELEGRAM_QA_SCENARIOS.filter((scenario) =>
          shouldRunTelegramScenarioByDefault(scenario, providerMode),
        );
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "Telegram",
    scenarios,
  });
}

export function listTelegramQaScenarioCatalog(
  providerMode: QaProviderMode = DEFAULT_QA_LIVE_PROVIDER_MODE,
) {
  return TELEGRAM_QA_SCENARIOS.map((scenario) => ({
    id: scenario.id,
    title: scenario.title,
    defaultEnabled: shouldRunTelegramScenarioByDefault(scenario, providerMode),
    rationale: scenario.rationale,
    regressionRefs: [...(scenario.regressionRefs ?? [])],
  }));
}

function matchesTelegramScenarioReply(params: {
  groupId: string;
  allowAnySutReply?: boolean;
  matchText?: string;
  message: TelegramObservedMessage;
  sentMessageId: number;
  sutBotId: number;
}) {
  if (
    params.message.chatId !== Number(params.groupId) ||
    params.message.senderId !== params.sutBotId
  ) {
    return false;
  }
  if (params.message.replyToMessageId === params.sentMessageId) {
    return true;
  }
  if (params.allowAnySutReply === true) {
    return params.message.messageId > params.sentMessageId;
  }
  return Boolean(
    params.matchText &&
    params.message.messageId > params.sentMessageId &&
    params.message.text.includes(params.matchText),
  );
}

function assertTelegramCanaryPresenceReply(message: TelegramObservedMessage) {
  if (!message.senderIsBot) {
    throw new Error(`canary reply message ${message.messageId} was not sent by a bot`);
  }
  // Telegram rich-message updates can arrive to the driver bot with no text
  // body. The release canary proves command delivery plus threaded SUT output;
  // text assertions stay on explicit command/scenario checks.
}

function isTelegramObservedMessageTimeoutError(error: unknown, timeoutMs: number) {
  return formatErrorMessage(error).startsWith(
    `timed out after ${timeoutMs}ms waiting for Telegram message`,
  );
}

function resolveTelegramQaScenarioSteps(run: TelegramQaScenarioRun): TelegramQaScenarioStep[] {
  if (run.steps.length === 0) {
    throw new Error("Telegram QA scenario must include at least one step");
  }
  return run.steps;
}

async function runTelegramQaScenarioStep(params: {
  driverOffset: number;
  driverToken: string;
  env: NodeJS.ProcessEnv;
  groupId: string;
  latestSutMessageId?: number;
  observedMessages: TelegramObservedMessage[];
  replyTimeoutMs?: number;
  scenario: TelegramQaScenarioDefinition;
  step: TelegramQaScenarioStep;
  sutBotId: number;
}) {
  const fallbackTimeoutMs = params.step.timeoutMs ?? params.scenario.timeoutMs;
  const stepTimeoutMs = params.step.expectReply
    ? (params.replyTimeoutMs ?? resolveTelegramQaScenarioTimeoutMs(fallbackTimeoutMs, params.env))
    : fallbackTimeoutMs;
  const requestStartedAtMs = Date.now();
  const sent = await sendGroupMessage(
    params.driverToken,
    params.groupId,
    params.step.input,
    params.step.replyToLatestSutMessage
      ? { replyToMessageId: params.latestSutMessageId }
      : undefined,
  );
  try {
    const matched = await waitForObservedMessage({
      token: params.driverToken,
      initialOffset: params.driverOffset,
      timeoutMs: stepTimeoutMs,
      observedMessages: params.observedMessages,
      observationScenarioId: params.scenario.id,
      observationScenarioTitle: params.scenario.title,
      expectedTextIncludes: params.step.expectReply ? params.step.expectedTextIncludes : undefined,
      predicate: (message) =>
        matchesTelegramScenarioReply({
          allowAnySutReply: params.step.allowAnySutReply,
          groupId: params.groupId,
          matchText: params.step.matchText,
          message,
          sentMessageId: sent.message_id,
          sutBotId: params.sutBotId,
        }),
    });
    if (!params.step.expectReply) {
      throw new Error(`unexpected reply message ${matched.message.messageId} matched`);
    }
    return {
      matched,
      requestStartedAt: new Date(requestStartedAtMs).toISOString(),
      requestStartedAtMs,
      sentMessageId: sent.message_id,
    };
  } catch (error) {
    if (!params.step.expectReply && isTelegramObservedMessageTimeoutError(error, stepTimeoutMs)) {
      return {
        matched: undefined,
        requestStartedAt: new Date(requestStartedAtMs).toISOString(),
        requestStartedAtMs,
        sentMessageId: sent.message_id,
      };
    }
    throw error;
  }
}

async function runTelegramQaRttChecks(params: {
  driverOffset: number;
  driverToken: string;
  env: NodeJS.ProcessEnv;
  groupId: string;
  latestSutMessageId?: number;
  observedMessages: TelegramObservedMessage[];
  rttOptions: TelegramQaRttOptions;
  scenario: TelegramQaScenarioDefinition;
  sutBotId: number;
  sutUsername: string;
}): Promise<TelegramQaRttResult> {
  if (!params.scenario.buildRttRun) {
    throw new Error(`Telegram QA scenario ${params.scenario.id} does not support RTT measurement.`);
  }
  let driverOffset = params.driverOffset;
  let latestSutMessageId = params.latestSutMessageId;
  const samples: LiveTransportRttSample[] = [];
  let failures = 0;
  let passed = 0;
  for (let index = 1; passed < params.rttOptions.count; index += 1) {
    const run = params.scenario.buildRttRun({
      rttIndex: index,
      sutUsername: params.sutUsername,
    });
    const steps = resolveTelegramQaScenarioSteps(run);
    const step = steps[0];
    if (steps.length !== 1 || !step) {
      throw new Error(`Telegram QA RTT check ${params.scenario.id} must have one step.`);
    }
    try {
      driverOffset = await flushTelegramUpdates(params.driverToken);
      const stepResult = await runTelegramQaScenarioStep({
        driverOffset,
        driverToken: params.driverToken,
        env: params.env,
        groupId: params.groupId,
        latestSutMessageId,
        observedMessages: params.observedMessages,
        replyTimeoutMs: params.rttOptions.timeoutMs,
        scenario: params.scenario,
        step,
        sutBotId: params.sutBotId,
      });
      if (!stepResult.matched) {
        throw new Error("RTT check did not expect a reply");
      }
      driverOffset = stepResult.matched.nextOffset;
      latestSutMessageId = stepResult.matched.message.messageId;
      const rttMs = stepResult.matched.observedAtMs - stepResult.requestStartedAtMs;
      samples.push({
        status: "pass",
        rttMs,
      });
      passed += 1;
    } catch {
      failures += 1;
      samples.push({
        status: "fail",
      });
    }
    if (failures >= params.rttOptions.maxFailures) {
      break;
    }
  }

  const summary = summarizeLiveTransportRttSamples(samples);
  return {
    details: `${summary.passed}/${samples.length} RTT checks passed`,
    driverOffset,
    failed: summary.failed,
    latestSutMessageId,
    passed: summary.passed,
    timing: summary.timing,
  };
}

function classifyCanaryReply(params: {
  message: TelegramObservedMessage;
  groupId: string;
  sutBotId: number;
  driverMessageId: number;
}) {
  if (
    params.message.chatId !== Number(params.groupId) ||
    params.message.senderId !== params.sutBotId
  ) {
    return "ignore" as const;
  }
  return params.message.replyToMessageId === params.driverMessageId
    ? ("match" as const)
    : ("unthreaded" as const);
}

async function runCanary(params: {
  driverToken: string;
  groupId: string;
  sutUsername: string;
  sutBotId: number;
  timeoutMs: number;
  observedMessages: TelegramObservedMessage[];
}) {
  const offset = await flushTelegramUpdates(params.driverToken);
  const requestStartedAtMs = Date.now();
  const driverMessage = await sendGroupMessage(
    params.driverToken,
    params.groupId,
    `/help@${params.sutUsername}`,
  );
  const requestStartedAt = new Date(requestStartedAtMs).toISOString();
  let firstUnthreadedReply:
    | Pick<TelegramObservedMessage, "messageId" | "replyToMessageId" | "text">
    | undefined;
  let sutObserved: Awaited<ReturnType<typeof waitForObservedMessage>>;
  try {
    sutObserved = await waitForObservedMessage({
      token: params.driverToken,
      initialOffset: offset,
      timeoutMs: params.timeoutMs,
      observedMessages: params.observedMessages,
      observationScenarioId: "telegram-canary",
      observationScenarioTitle: "Telegram canary",
      validateMatchedMessage: assertTelegramCanaryPresenceReply,
      predicate: (message) => {
        const classification = classifyCanaryReply({
          message,
          groupId: params.groupId,
          sutBotId: params.sutBotId,
          driverMessageId: driverMessage.message_id,
        });
        if (classification === "ignore") {
          return false;
        }
        if (classification === "unthreaded") {
          firstUnthreadedReply ??= {
            messageId: message.messageId,
            replyToMessageId: message.replyToMessageId,
            text: message.text,
          };
          return false;
        }
        return classification === "match";
      },
    });
  } catch (error) {
    if (firstUnthreadedReply) {
      throw new TelegramQaCanaryError(
        "sut_reply_not_threaded",
        "SUT bot replied, but not as a reply to the canary driver message.",
        {
          groupId: params.groupId,
          sutBotId: params.sutBotId,
          driverMessageId: driverMessage.message_id,
          sutMessageId: firstUnthreadedReply.messageId,
          sutReplyToMessageId: firstUnthreadedReply.replyToMessageId,
        },
      );
    }
    throw new TelegramQaCanaryError(
      "sut_reply_timeout",
      `SUT bot did not send any group reply after the canary command within ${formatTelegramQaTimeoutSeconds(params.timeoutMs)}.`,
      {
        groupId: params.groupId,
        sutBotId: params.sutBotId,
        driverMessageId: driverMessage.message_id,
        cause: formatErrorMessage(error),
      },
    );
  }
  return {
    requestStartedAt,
    responseObservedAt: new Date(sutObserved.observedAtMs).toISOString(),
    rttMs: sutObserved.observedAtMs - requestStartedAtMs,
    sentMessageId: driverMessage.message_id,
    responseMessageId: sutObserved.message.messageId,
  };
}

function canaryFailureMessage(params: {
  error: unknown;
  groupId: string;
  driverBotId: number;
  driverUsername?: string;
  redactMetadata?: boolean;
  sutBotId: number;
  sutUsername: string;
}) {
  const error = params.error;
  const details = formatErrorMessage(error);
  const phase = isTelegramQaCanaryError(error) ? error.phase : "unknown";
  const canonicalContext = new Set([
    "groupId",
    "driverBotId",
    "driverUsername",
    "sutBotId",
    "sutUsername",
  ]);
  const context = isTelegramQaCanaryError(error)
    ? Object.entries(error.context)
        .filter(([key, value]) => value !== undefined && value !== "" && !canonicalContext.has(key))
        .map(([key, value]) =>
          params.redactMetadata ? `- ${key}: <redacted>` : `- ${key}: ${String(value)}`,
        )
    : [];
  const remediation = (() => {
    switch (phase) {
      case "sut_reply_timeout":
        return [
          "1. Enable Bot-to-Bot Communication Mode for both the driver and SUT bots in @BotFather.",
          "2. Confirm the SUT bot is present in the target private group and can receive /help@BotUsername commands there.",
          "3. Confirm the QA child gateway started the SUT Telegram account with the expected token.",
        ];
      case "sut_reply_not_threaded":
        return [
          "1. Check whether the SUT bot is replying in the group without threading to the driver message.",
          "2. Confirm the Telegram native command path preserves reply-to behavior for group commands.",
          "3. Inspect telegram-qa-report.md and gateway debug logs for the mismatched SUT message id and reply target.",
        ];
      case "sut_reply_empty":
        return [
          "1. Check whether the Telegram native command response path produced an empty or suppressed reply.",
          "2. Confirm the SUT command completed successfully in gateway logs.",
          "3. Inspect telegram-qa-report.md for the matched message ids and phase context.",
        ];
      default:
        return [
          "1. Enable Bot-to-Bot Communication Mode for both the driver and SUT bots in @BotFather.",
          "2. Ensure the driver bot can observe bot traffic in the private group by making it admin or disabling privacy mode, then re-add it.",
          "3. Ensure both bots are members of the same private group.",
          "4. Confirm the SUT bot is allowed to receive /help@BotUsername commands in that group.",
        ];
    }
  })();
  return [
    "Telegram QA canary failed.",
    `Phase: ${phase}`,
    details,
    "Context:",
    `- groupId: ${params.redactMetadata ? "<redacted>" : params.groupId}`,
    `- driverBotId: ${params.redactMetadata ? "<redacted>" : params.driverBotId}`,
    `- driverUsername: ${params.redactMetadata ? "<redacted>" : (params.driverUsername ?? "<none>")}`,
    `- sutBotId: ${params.redactMetadata ? "<redacted>" : params.sutBotId}`,
    `- sutUsername: ${params.redactMetadata ? "<redacted>" : params.sutUsername}`,
    ...context,
    "Remediation:",
    ...remediation,
  ].join("\n");
}

export async function runTelegramQaLive(params: {
  env?: NodeJS.ProcessEnv;
  repoRoot?: string;
  outputDir?: string;
  sutOpenClawCommand?: QaGatewayChildCommand;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  scenarioIds?: string[];
  rttCount?: number;
  rttTimeoutMs?: number;
  maxRttFailures?: number;
  rttCheckIds?: string[];
  sutAccountId?: string;
  credentialSource?: string;
  credentialRole?: string;
  redactPublicMetadata?: boolean;
  progressEnabled?: boolean;
  canaryTimeoutMs?: number;
}): Promise<TelegramQaRunResult> {
  const env = params.env ?? process.env;
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `telegram-${createQaArtifactRunId()}`);
  await fs.mkdir(outputDir, { recursive: true });

  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findScenario(params.scenarioIds, providerMode);
  const rttOptions = normalizeTelegramQaRttOptions({
    checkIds: params.rttCheckIds,
    count: params.rttCount,
    maxFailures: params.maxRttFailures,
    timeoutMs: params.rttTimeoutMs,
  });
  assertTelegramQaRttCheckSupport({ rttOptions, scenarios });
  const progressEnabled = params.progressEnabled ?? shouldLogTelegramQaLiveProgress(env);
  writeTelegramQaProgress(
    progressEnabled,
    `run start: scenarios=${scenarios.length} providerMode=${providerMode} fastMode=${params.fastMode === true ? "on" : "off"} rttChecks=${rttOptions?.count ?? 0}`,
  );

  const credentialLease = await acquireQaCredentialLease({
    env,
    kind: "telegram",
    source: params.credentialSource,
    role: params.credentialRole,
    resolveEnvPayload: () => resolveTelegramQaRuntimeEnv(env),
    parsePayload: parseTelegramQaCredentialPayload,
  });
  try {
    assertQaGatewayCredentialLeaseQuarantine(credentialLease, env);
  } catch (error) {
    await credentialLease.release();
    throw error;
  }
  const leaseHeartbeat = startQaCredentialLeaseHeartbeat(credentialLease);
  const assertLeaseHealthy = () => {
    leaseHeartbeat.throwIfFailed();
  };
  writeTelegramQaProgress(
    progressEnabled,
    `credentials ready: source=${credentialLease.source} role=${credentialLease.role ?? "<none>"}`,
  );

  const runtimeEnv = credentialLease.payload;
  const observedMessages: TelegramObservedMessage[] = [];
  const redactPublicMetadata =
    params.redactPublicMetadata ?? isTruthyOptIn(env[QA_REDACT_PUBLIC_METADATA_ENV]);
  writeTelegramQaProgress(
    progressEnabled,
    `runtime: redactMetadata=${redactPublicMetadata ? "on" : "off"}`,
  );
  const startedAt = new Date().toISOString();
  const scenarioResults: TelegramQaScenarioResult[] = [];
  const cleanupIssues: string[] = [];
  const gatewayDebugDirPath = path.join(outputDir, "gateway-debug");
  let preservedGatewayDebugArtifacts = false;
  let canaryFailure: string | null = null;
  try {
    const driverIdentity = await getBotIdentity(runtimeEnv.driverToken);
    const sutIdentity = await getBotIdentity(runtimeEnv.sutToken);
    const sutUsername = sutIdentity.username?.trim();
    const uniqueIds = new Set([driverIdentity.id, sutIdentity.id]);
    if (uniqueIds.size !== 2) {
      throw new Error("Telegram QA requires two distinct bots for driver and SUT.");
    }
    if (!sutUsername) {
      throw new Error("Telegram QA requires the SUT bot to have a Telegram username.");
    }

    await Promise.all([
      flushTelegramUpdates(runtimeEnv.driverToken),
      flushTelegramUpdates(runtimeEnv.sutToken),
    ]);

    const gatewayHarness = await startQaLiveLaneGateway({
      repoRoot,
      command: params.sutOpenClawCommand,
      transport: {
        requiredPluginIds: [],
        createGatewayConfig: () => ({}),
      },
      transportBaseUrl: "http://127.0.0.1:0",
      providerMode,
      primaryModel,
      alternateModel,
      fastMode: params.fastMode,
      controlUiEnabled: false,
      mutateConfig: (cfg) =>
        buildTelegramQaConfig(cfg, {
          groupId: runtimeEnv.groupId,
          sutToken: runtimeEnv.sutToken,
          driverBotId: driverIdentity.id,
          sutAccountId,
        }),
    });
    try {
      await waitForTelegramChannelRunning(gatewayHarness.gateway, sutAccountId, { env });
      assertLeaseHealthy();
      let latestSutMessageId: number | undefined;
      try {
        writeTelegramQaProgress(progressEnabled, "canary start");
        const canaryTiming = await runCanary({
          driverToken: runtimeEnv.driverToken,
          groupId: runtimeEnv.groupId,
          sutUsername,
          sutBotId: sutIdentity.id,
          timeoutMs: params.canaryTimeoutMs ?? resolveTelegramQaCanaryTimeoutMs(env),
          observedMessages,
        });
        latestSutMessageId = canaryTiming.responseMessageId;
        scenarioResults.push({
          id: "telegram-canary",
          coverageIds: ["channels.telegram.canary"],
          title: "Telegram canary",
          status: "pass",
          details: redactPublicMetadata
            ? `reply matched in ${canaryTiming.rttMs}ms`
            : `reply message ${canaryTiming.responseMessageId} matched in ${canaryTiming.rttMs}ms`,
          rttMs: canaryTiming.rttMs,
          requestStartedAt: canaryTiming.requestStartedAt,
          responseObservedAt: canaryTiming.responseObservedAt,
          rttMeasurement: {
            finalMatchedReplyRttMs: canaryTiming.rttMs,
            requestStartedAt: canaryTiming.requestStartedAt,
            responseObservedAt: canaryTiming.responseObservedAt,
            source: "request-to-observed-message",
          },
          sentMessageId: redactPublicMetadata ? undefined : canaryTiming.sentMessageId,
          responseMessageId: redactPublicMetadata ? undefined : canaryTiming.responseMessageId,
        });
        writeTelegramQaProgress(progressEnabled, "canary pass");
      } catch (error) {
        canaryFailure = canaryFailureMessage({
          error,
          groupId: runtimeEnv.groupId,
          driverBotId: driverIdentity.id,
          driverUsername: driverIdentity.username,
          redactMetadata: redactPublicMetadata,
          sutBotId: sutIdentity.id,
          sutUsername,
        });
        scenarioResults.push({
          id: "telegram-canary",
          coverageIds: ["channels.telegram.canary"],
          title: "Telegram canary",
          status: "fail",
          details: canaryFailure,
        });
        writeTelegramQaProgress(
          progressEnabled,
          `canary fail: details=${formatTelegramQaProgressDetails(canaryFailure)}`,
        );
      }
      assertLeaseHealthy();
      if (!canaryFailure) {
        let driverOffset = await flushTelegramUpdates(runtimeEnv.driverToken);
        for (const [scenarioIndex, scenario] of scenarios.entries()) {
          const scenarioIndexLabel = `${scenarioIndex + 1}/${scenarios.length}`;
          const scenarioIdForLog = sanitizeTelegramQaProgressValue(scenario.id);
          writeTelegramQaProgress(
            progressEnabled,
            `scenario start ${scenarioIndexLabel}: ${scenarioIdForLog}`,
          );
          assertLeaseHealthy();
          const scenarioRun = scenario.buildRun(sutUsername);
          try {
            const scenarioSteps = resolveTelegramQaScenarioSteps(scenarioRun);
            let firstRequestStartedAt: string | undefined;
            let lastRequestStartedAtMs = 0;
            let lastMatched: Awaited<ReturnType<typeof waitForObservedMessage>> | undefined;
            let lastSentMessageId: number | undefined;
            for (const step of scenarioSteps) {
              driverOffset = await flushTelegramUpdates(runtimeEnv.driverToken);
              const stepResult = await runTelegramQaScenarioStep({
                driverOffset,
                driverToken: runtimeEnv.driverToken,
                env,
                groupId: runtimeEnv.groupId,
                latestSutMessageId,
                observedMessages,
                scenario,
                step,
                sutBotId: sutIdentity.id,
              });
              firstRequestStartedAt ??= stepResult.requestStartedAt;
              lastRequestStartedAtMs = stepResult.requestStartedAtMs;
              lastSentMessageId = stepResult.sentMessageId;
              const matched = stepResult.matched;
              if (!matched) {
                continue;
              }
              driverOffset = matched.nextOffset;
              if (step.settleMs !== undefined) {
                driverOffset = await collectObservedMessages({
                  token: runtimeEnv.driverToken,
                  initialOffset: driverOffset,
                  settleMs: step.settleMs,
                  observedMessages,
                  observationScenarioId: scenario.id,
                  observationScenarioTitle: scenario.title,
                  predicate: (message) =>
                    matchesTelegramScenarioReply({
                      allowAnySutReply: step.allowAnySutReply,
                      groupId: runtimeEnv.groupId,
                      matchText: step.matchText,
                      message,
                      sentMessageId: stepResult.sentMessageId,
                      sutBotId: sutIdentity.id,
                    }),
                });
              }
              assertTelegramScenarioReply({
                expectedTextIncludes: step.expectedTextIncludes,
                message: matched.message,
              });
              assertTelegramScenarioMessageSet({
                expectedJoinedSutTextIncludes: step.expectedJoinedSutTextIncludes,
                expectedSutMessageCount: step.expectedSutMessageCount,
                expectedSutMessageCountRange: step.expectedSutMessageCountRange,
                groupId: runtimeEnv.groupId,
                observedMessages,
                scenarioId: scenario.id,
                sutBotId: sutIdentity.id,
              });
              latestSutMessageId = matched.message.messageId;
              lastMatched = matched;
            }
            if (!lastMatched || !firstRequestStartedAt || lastSentMessageId === undefined) {
              const result = {
                id: scenario.id,
                coverageIds: telegramLiveTransportCoverageIds(scenario),
                title: scenario.title,
                status: "pass",
                details: "no reply",
              } satisfies TelegramQaScenarioResult;
              scenarioResults.push(result);
              writeTelegramQaProgress(
                progressEnabled,
                `scenario pass ${scenarioIndexLabel}: ${scenarioIdForLog}`,
              );
              continue;
            }
            const lastStep = scenarioSteps.at(-1);
            const rttMs = lastMatched.observedAtMs - lastRequestStartedAtMs;
            const suffix =
              scenarioSteps.length === 1
                ? lastStep?.expectedSutMessageCount === undefined
                  ? lastStep?.expectedSutMessageCountRange === undefined
                    ? ""
                    : `; observed ${lastStep.expectedSutMessageCountRange[0]}-${lastStep.expectedSutMessageCountRange[1]} SUT message(s)`
                  : `; observed ${lastStep.expectedSutMessageCount} SUT message(s)`
                : `; ${scenarioSteps.filter((step) => step.expectReply).length} command replies matched`;
            let resultStatus: "pass" | "fail" = "pass";
            let details = redactPublicMetadata
              ? `reply matched in ${rttMs}ms${suffix}`
              : `reply message ${lastMatched.message.messageId} matched in ${rttMs}ms${suffix}`;
            let resultRttMs: number | undefined = rttMs;
            let timing: QaEvidenceTiming | undefined;
            if (rttOptions?.checkIds.has(scenario.id)) {
              const rttResult = await runTelegramQaRttChecks({
                driverOffset,
                driverToken: runtimeEnv.driverToken,
                env,
                groupId: runtimeEnv.groupId,
                latestSutMessageId,
                observedMessages,
                rttOptions,
                scenario,
                sutBotId: sutIdentity.id,
                sutUsername,
              });
              driverOffset = rttResult.driverOffset;
              latestSutMessageId = rttResult.latestSutMessageId ?? latestSutMessageId;
              timing = rttResult.timing;
              resultRttMs = rttResult.timing.p50Ms;
              details = `${details}; ${rttResult.details}`;
              if (rttResult.passed < rttOptions.count) {
                resultStatus = "fail";
              }
            }
            const result = {
              id: scenario.id,
              coverageIds: telegramLiveTransportCoverageIds(scenario),
              title: scenario.title,
              status: resultStatus,
              details,
              rttMs: resultRttMs,
              timing,
              requestStartedAt: firstRequestStartedAt,
              responseObservedAt: new Date(lastMatched.observedAtMs).toISOString(),
              rttMeasurement: timing
                ? undefined
                : {
                    finalMatchedReplyRttMs: rttMs,
                    requestStartedAt: new Date(lastRequestStartedAtMs).toISOString(),
                    responseObservedAt: new Date(lastMatched.observedAtMs).toISOString(),
                    source: "request-to-observed-message",
                  },
              sentMessageId: redactPublicMetadata ? undefined : lastSentMessageId,
              responseMessageId: redactPublicMetadata ? undefined : lastMatched.message.messageId,
            } satisfies TelegramQaScenarioResult;
            scenarioResults.push(result);
            writeTelegramQaProgress(
              progressEnabled,
              `scenario ${resultStatus} ${scenarioIndexLabel}: ${scenarioIdForLog}`,
            );
          } catch (error) {
            const result = {
              id: scenario.id,
              coverageIds: telegramLiveTransportCoverageIds(scenario),
              title: scenario.title,
              status: "fail",
              details: formatErrorMessage(error),
            } satisfies TelegramQaScenarioResult;
            scenarioResults.push(result);
            writeTelegramQaProgress(
              progressEnabled,
              `scenario fail ${scenarioIndexLabel}: ${scenarioIdForLog} details=${formatTelegramQaProgressDetails(result.details)}`,
            );
          }
          assertLeaseHealthy();
        }
      }
    } finally {
      try {
        const shouldPreserveGatewayDebugArtifacts = scenarioResults.some(
          (scenario) => scenario.status === "fail",
        );
        await gatewayHarness.stop(
          shouldPreserveGatewayDebugArtifacts ? { preserveToDir: gatewayDebugDirPath } : undefined,
        );
        preservedGatewayDebugArtifacts = shouldPreserveGatewayDebugArtifacts;
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "live gateway cleanup", error);
      }
    }
  } finally {
    if (await shouldRetainQaGatewayCredentialLease(env)) {
      try {
        await credentialLease.heartbeat();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential lease quarantine heartbeat", error);
      }
      try {
        await leaseHeartbeat.stop();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential lease heartbeat stop", error);
      }
      cleanupIssues.push(
        "credential lease retained for two hours because isolated SUT quiescence was not proven",
      );
    } else {
      await leaseHeartbeat.stop();
      try {
        await credentialLease.release();
      } catch (error) {
        appendLiveLaneIssue(cleanupIssues, "credential lease release", error);
      }
    }
  }

  const finishedAt = new Date().toISOString();
  const publishedCleanupIssues = redactPublicMetadata
    ? redactQaLiveLaneIssues(cleanupIssues)
    : cleanupIssues;
  const passedCount = scenarioResults.filter((entry) => entry.status === "pass").length;
  const failedCount = scenarioResults.filter((entry) => entry.status === "fail").length;
  writeTelegramQaProgress(
    progressEnabled,
    `run complete: passed=${passedCount} failed=${failedCount} total=${scenarioResults.length}`,
  );
  if (cleanupIssues.length > 0) {
    writeTelegramQaProgress(progressEnabled, `cleanup issues: count=${cleanupIssues.length}`);
  }
  const reportPath = path.join(outputDir, "telegram-qa-report.md");
  const summaryPath = path.join(outputDir, QA_EVIDENCE_FILENAME);
  const evidence = buildLiveTransportEvidenceSummary({
    artifactPaths: [
      { kind: "summary", path: path.basename(summaryPath) },
      { kind: "report", path: path.basename(reportPath) },
    ],
    env,
    generatedAt: finishedAt,
    primaryModel,
    providerMode,
    repoRoot,
    checks: scenarioResults,
    transportId: "telegram",
  });
  await fs.writeFile(
    reportPath,
    `${renderTelegramQaMarkdown({
      cleanupIssues: publishedCleanupIssues,
      credentialSource: credentialLease.source,
      redactMetadata: redactPublicMetadata,
      groupId: redactPublicMetadata ? "<redacted>" : runtimeEnv.groupId,
      gatewayDebugDirPath: preservedGatewayDebugArtifacts ? gatewayDebugDirPath : undefined,
      startedAt,
      finishedAt,
      scenarios: scenarioResults,
    })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await fs.writeFile(summaryPath, `${JSON.stringify(evidence, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  const artifactPaths = {
    report: reportPath,
    summary: summaryPath,
    ...(preservedGatewayDebugArtifacts ? { gatewayDebug: gatewayDebugDirPath } : {}),
  };
  if (canaryFailure) {
    throw new Error(
      buildLiveLaneArtifactsError({
        heading: canaryFailure,
        artifacts: artifactPaths,
      }),
    );
  }
  if (cleanupIssues.length > 0) {
    throw new Error(
      buildLiveLaneArtifactsError({
        heading: "Telegram QA cleanup failed after artifacts were written.",
        details: publishedCleanupIssues,
        artifacts: artifactPaths,
      }),
    );
  }

  return {
    outputDir,
    reportPath,
    summaryPath,
    ...(preservedGatewayDebugArtifacts ? { gatewayDebugDirPath } : {}),
    scenarios: scenarioResults,
  };
}

export const testing = {
  TELEGRAM_QA_SCENARIOS,
  TELEGRAM_QA_STANDARD_SCENARIO_IDS,
  buildTelegramQaConfig,
  canaryFailureMessage,
  callTelegramApi,
  assertTelegramCanaryPresenceReply,
  assertTelegramScenarioMessageSet,
  isRecoverableTelegramQaPollError,
  assertTelegramScenarioReply,
  classifyCanaryReply,
  findScenario,
  flushTelegramUpdates,
  isTelegramObservedMessageTimeoutError,
  listTelegramQaScenarioCatalog,
  matchesTelegramScenarioReply,
  normalizeTelegramObservedMessage,
  parseTelegramQaProgressBooleanEnv,
  parseTelegramQaCredentialPayload,
  normalizeTelegramQaRttOptions,
  resolveTelegramQaCanaryTimeoutMs,
  resolveTelegramQaReadyTimeoutMs,
  resolveTelegramQaScenarioTimeoutMs,
  resolveTelegramQaRuntimeEnv,
  sanitizeTelegramQaProgressValue,
  shouldLogTelegramQaLiveProgress,
  formatTelegramQaProgressDetails,
  renderTelegramQaMarkdown,
  waitForTelegramChannelRunning,
  waitForObservedMessage,
};
export { testing as __testing };
