import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";
import { z } from "zod";
import { startQaGatewayChild } from "../../gateway-child.js";
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
  type QaCredentialRole,
} from "../shared/credential-lease.runtime.js";
import { startQaLiveLaneGateway } from "../shared/live-gateway.runtime.js";
import { appendLiveLaneIssue, buildLiveLaneArtifactsError } from "../shared/live-lane-helpers.js";
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
  | "telegram-help-command"
  | "telegram-commands-command"
  | "telegram-tools-compact-command"
  | "telegram-whoami-command"
  | "telegram-status-command"
  | "telegram-repeated-command-authorization"
  | "telegram-other-bot-command-gating"
  | "telegram-context-command"
  | "telegram-current-session-status-tool"
  | "telegram-stream-final-single-message"
  | "telegram-long-final-three-chunks"
  | "telegram-long-final-reuses-preview"
  | "telegram-reply-chain-exact-marker"
  | "telegram-mentioned-message-reply"
  | "telegram-mention-gating";

type TelegramQaScenarioStep = {
  allowAnySutReply?: boolean;
  driverGroupAuthorization?: "allow" | "deny";
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
  defaultEnabled?: boolean;
  defaultProviderModes?: readonly QaProviderMode[];
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

type TelegramObservedMessageArtifact = {
  updateId?: number;
  messageId?: number;
  chatId?: number;
  senderId?: number;
  senderIsBot: boolean;
  senderUsername?: string;
  scenarioId?: string;
  scenarioTitle?: string;
  matchedScenario?: boolean;
  text?: string;
  caption?: string;
  replyToMessageId?: number;
  inlineButtonCount?: number;
  timestamp?: number;
  inlineButtons?: string[];
  mediaKinds: string[];
};

const DEFAULT_TELEGRAM_QA_CANARY_TIMEOUT_MS = 30_000;

type TelegramQaScenarioResult = {
  id: string;
  title: string;
  status: "pass" | "fail";
  details: string;
  rttMs?: number;
  requestStartedAt?: string;
  responseObservedAt?: string;
  sentMessageId?: number;
  responseMessageId?: number;
};

type TelegramQaCanaryPhase = "sut_reply_timeout" | "sut_reply_not_threaded" | "sut_reply_empty";

type TelegramQaRunResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  observedMessagesPath: string;
  gatewayDebugDirPath?: string;
  scenarios: TelegramQaScenarioResult[];
};

type TelegramQaSummary = {
  credentials: {
    credentialId?: string;
    kind: string;
    ownerId?: string;
    role?: QaCredentialRole;
    source: "convex" | "env";
  };
  groupId: string;
  startedAt: string;
  finishedAt: string;
  cleanupIssues: string[];
  counts: {
    total: number;
    passed: number;
    failed: number;
  };
  scenarios: TelegramQaScenarioResult[];
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

type TelegramMessage = {
  message_id: number;
  date: number;
  text?: string;
  caption?: string;
  reply_markup?: TelegramReplyMarkup;
  reply_to_message?: { message_id?: number };
  from?: {
    id?: number;
    is_bot?: boolean;
    username?: string;
  };
  chat: {
    id: number;
  };
  photo?: unknown[];
  document?: unknown;
  audio?: unknown;
  video?: unknown;
  voice?: unknown;
  sticker?: unknown;
};

type TelegramUpdate = {
  update_id: number;
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
    id: "telegram-help-command",
    standardId: "help-command",
    title: "Telegram help command reply",
    rationale: "Canary-grade native command reply path.",
    timeoutMs: 45_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        expectReply: true,
        input: `/help@${sutUsername}`,
        expectedTextIncludes: ["/new", "/commands for full list"],
      }),
  },
  {
    id: "telegram-commands-command",
    title: "Telegram commands list reply",
    rationale: "Native command catalog must render in Telegram group replies.",
    timeoutMs: 45_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        expectReply: true,
        input: `/commands@${sutUsername}`,
        expectedTextIncludes: ["Commands (1/", "/session", "/verbose"],
      }),
  },
  {
    id: "telegram-tools-compact-command",
    title: "Telegram tools compact reply",
    rationale: "Tool catalog rendering catches command dispatch plus model-tool inventory drift.",
    timeoutMs: 45_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        expectReply: true,
        input: `/tools@${sutUsername} compact`,
        expectedTextIncludes: ["exec", "Use /tools verbose for descriptions."],
      }),
  },
  {
    id: "telegram-whoami-command",
    title: "Telegram whoami reply",
    rationale: "Identity command proves Telegram channel context is attached to native commands.",
    timeoutMs: 45_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        expectReply: true,
        input: `/whoami@${sutUsername}`,
        expectedTextIncludes: ["🧭 Identity", "Channel: telegram"],
      }),
  },
  {
    id: "telegram-status-command",
    title: "Telegram status command reply",
    rationale: "Recent Telegram group regressions broke /status while normal chat still worked.",
    regressionRefs: ["openclaw/openclaw#74698"],
    timeoutMs: 45_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        expectReply: true,
        input: `/status@${sutUsername}`,
        expectedTextIncludes: ["OpenClaw", "Model:", "Session:", "Activation:"],
      }),
  },
  {
    id: "telegram-repeated-command-authorization",
    title: "Telegram repeated command authorization",
    rationale:
      "Allowlisted bot-to-bot operators should not hit a fresh auth gate for each native slash command.",
    timeoutMs: 45_000,
    buildRun: (sutUsername) => {
      const steps = [
        {
          driverGroupAuthorization: "deny",
          expectReply: false,
          input: `/status@${sutUsername}`,
          timeoutMs: 8_000,
        },
        {
          driverGroupAuthorization: "allow",
          expectReply: true,
          input: `/status@${sutUsername}`,
          expectedTextIncludes: ["OpenClaw", "Session:"],
        },
        {
          expectReply: true,
          input: `/help@${sutUsername}`,
          expectedTextIncludes: ["/new", "/commands for full list"],
        },
        {
          expectReply: true,
          input: `/commands@${sutUsername}`,
          expectedTextIncludes: ["Commands (1/", "/session", "/verbose"],
        },
      ] satisfies TelegramQaScenarioStep[];
      return { steps };
    },
  },
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
    id: "telegram-context-command",
    title: "Telegram context reply",
    rationale: "Context command exercises native command routing into Telegram-specific help text.",
    timeoutMs: 45_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        expectReply: true,
        input: `/context@${sutUsername}`,
        expectedTextIncludes: ["/context list", "Inline shortcut"],
      }),
  },
  {
    id: "telegram-current-session-status-tool",
    title: "Telegram current session_status tool call",
    defaultEnabled: false,
    rationale:
      "Opt-in threaded probe for current Telegram group session resolution through model tools.",
    timeoutMs: 60_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        expectReply: true,
        input: `@${sutUsername} Telegram current session_status QA check. Call session_status with sessionKey set to current, then reply with the exact QA marker and resolved session key.`,
        expectedTextIncludes: ["QA-TELEGRAM-CURRENT-SESSION-OK", ":telegram:group:"],
        replyToLatestSutMessage: true,
      }),
  },
  {
    id: "telegram-mentioned-message-reply",
    title: "Telegram mentioned message gets a reply",
    rationale: "Bot-to-bot group mention routing must produce a threaded SUT reply.",
    timeoutMs: 45_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        expectReply: true,
        input: `@${sutUsername} Telegram QA mention routing check. Reply with a short acknowledgement.`,
        replyToLatestSutMessage: true,
      }),
  },
  {
    id: "telegram-reply-chain-exact-marker",
    title: "Telegram reply-chain exact marker",
    defaultProviderModes: ["mock-openai"],
    rationale: "Mock-backed reply-chain check proves quoted bot-to-bot follow-ups keep threading.",
    timeoutMs: 45_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        expectReply: true,
        input: `@${sutUsername} Telegram reply-chain marker QA. Reply exactly: QA-TELEGRAM-REPLY-CHAIN-OK`,
        expectedTextIncludes: ["QA-TELEGRAM-REPLY-CHAIN-OK"],
        expectedJoinedSutTextIncludes: ["QA-TELEGRAM-REPLY-CHAIN-OK"],
        expectedSutMessageCount: 1,
        replyToLatestSutMessage: true,
        settleMs: 4_000,
      }),
  },
  {
    id: "telegram-stream-final-single-message",
    title: "Telegram streamed final stays one message",
    defaultProviderModes: ["mock-openai"],
    rationale: "Regression guard for duplicate final replies from Telegram streaming paths.",
    regressionRefs: ["openclaw/openclaw#39905"],
    timeoutMs: 45_000,
    buildRun: (sutUsername) =>
      telegramQaStepRun({
        allowAnySutReply: true,
        expectReply: true,
        input: `@${sutUsername} Quiet streaming QA check. Reply exactly: QA-TELEGRAM-STREAM-SINGLE-OK`,
        expectedTextIncludes: ["QA-TELEGRAM-STREAM-SINGLE-OK"],
        expectedJoinedSutTextIncludes: ["QA-TELEGRAM-STREAM-SINGLE-OK"],
        expectedSutMessageCount: 1,
        replyToLatestSutMessage: true,
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
const TELEGRAM_QA_CAPTURE_CONTENT_ENV = "OPENCLAW_QA_TELEGRAM_CAPTURE_CONTENT";
const QA_REDACT_PUBLIC_METADATA_ENV = "OPENCLAW_QA_REDACT_PUBLIC_METADATA";
const QA_SUITE_PROGRESS_ENV = "OPENCLAW_QA_SUITE_PROGRESS";
const TELEGRAM_QA_PROGRESS_DETAIL_LIMIT = 240;
const TELEGRAM_QA_PROGRESS_PREFIX = "[qa-telegram-live]";
const execFileAsync = promisify(execFile);

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

function isTruthyOptIn(value: string | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readConfigRecord(root: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = root[key];
  if (!isRecord(value)) {
    throw new Error(`Telegram QA config missing object at ${key}`);
  }
  return value;
}

function parseTelegramQaProgressBooleanEnv(value: string | undefined): boolean | undefined {
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
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallbackMs;
  }
  return Math.floor(parsed);
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

function formatTelegramQaTimeoutSeconds(timeoutMs: number) {
  return `${Math.round(timeoutMs / 1_000)}s`;
}

function writeTelegramQaProgress(enabled: boolean, message: string) {
  if (!enabled) {
    return;
  }
  process.stderr.write(`${TELEGRAM_QA_PROGRESS_PREFIX} ${message}\n`);
}

function sanitizeTelegramQaProgressValue(value: string): string {
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

function formatTelegramQaProgressDetails(details: string): string {
  const sanitized = sanitizeTelegramQaProgressValue(details);
  if (sanitized.length <= TELEGRAM_QA_PROGRESS_DETAIL_LIMIT) {
    return sanitized;
  }
  return `${sanitized.slice(0, TELEGRAM_QA_PROGRESS_DETAIL_LIMIT - 3).trimEnd()}...`;
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
    senderIsBot: message.from.is_bot === true,
    senderUsername: message.from.username,
    text: message.text ?? message.caption ?? "",
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
  const pluginAllow = [...new Set([...(baseCfg.plugins?.allow ?? []), "telegram"])];
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
  const { response, release } = await fetchWithSsrFGuard({
    url: `https://api.telegram.org/bot${token}/${method}`,
    init: {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
    },
    signal: AbortSignal.timeout(timeoutMs),
    policy: { hostnameAllowlist: ["api.telegram.org"] },
    auditContext: "qa-lab-telegram-live",
  });
  try {
    const payload = (await response.json()) as TelegramApiEnvelope<T>;
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
  await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(100, remainingMs))));
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
          assertTelegramScenarioReply({
            expectedTextIncludes: params.expectedTextIncludes,
            message: observedMessage,
          });
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
) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 45_000) {
    try {
      const payload = (await gateway.call(
        "channels.status",
        { probe: false, timeoutMs: 2_000 },
        { timeoutMs: 5_000 },
      )) as {
        channelAccounts?: Record<
          string,
          Array<{ accountId?: string; running?: boolean; restartPending?: boolean }>
        >;
      };
      const accounts = payload.channelAccounts?.telegram ?? [];
      const match = accounts.find((entry) => entry.accountId === accountId);
      if (match?.running && match.restartPending !== true) {
        return;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`telegram account "${accountId}" did not become ready`);
}

async function setTelegramQaDriverGroupAuthorization(params: {
  driverBotId: number;
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  groupId: string;
  sutAccountId: string;
  authorized: boolean;
}) {
  await params.gateway.restartAfterStateMutation(async ({ configPath }) => {
    const parsed: unknown = JSON.parse(await fs.readFile(configPath, "utf8"));
    if (!isRecord(parsed)) {
      throw new Error("Telegram QA config root must be an object");
    }
    const channels = readConfigRecord(parsed, "channels");
    const telegram = readConfigRecord(channels, "telegram");
    const accounts = readConfigRecord(telegram, "accounts");
    const account = readConfigRecord(accounts, params.sutAccountId);
    const groups = readConfigRecord(account, "groups");
    const group = readConfigRecord(groups, params.groupId);
    group.allowFrom = params.authorized ? [String(params.driverBotId)] : [];
    await fs.writeFile(configPath, `${JSON.stringify(parsed, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  });
  await waitForTelegramChannelRunning(params.gateway, params.sutAccountId);
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

function buildObservedMessagesArtifact(params: {
  observedMessages: TelegramObservedMessage[];
  includeContent: boolean;
  redactMetadata: boolean;
}) {
  return params.observedMessages.map<TelegramObservedMessageArtifact>((message) => {
    const scenarioContext = {
      ...(message.scenarioId ? { scenarioId: message.scenarioId } : {}),
      ...(message.scenarioTitle ? { scenarioTitle: message.scenarioTitle } : {}),
      ...(typeof message.matchedScenario === "boolean"
        ? { matchedScenario: message.matchedScenario }
        : {}),
    };
    const base = params.redactMetadata
      ? {
          ...scenarioContext,
          senderIsBot: message.senderIsBot,
          inlineButtonCount: message.inlineButtons.length,
          mediaKinds: message.mediaKinds,
        }
      : {
          ...scenarioContext,
          senderIsBot: message.senderIsBot,
          timestamp: message.timestamp,
          inlineButtons: message.inlineButtons,
          mediaKinds: message.mediaKinds,
          updateId: message.updateId,
          messageId: message.messageId,
          chatId: message.chatId,
          senderId: message.senderId,
          senderUsername: message.senderUsername,
          replyToMessageId: message.replyToMessageId,
        };
    if (!params.includeContent) {
      return base;
    }
    return {
      ...base,
      text: message.text,
      caption: message.caption,
    };
  });
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
  return Boolean(params.matchText && params.message.text.includes(params.matchText));
}

function assertTelegramScenarioReply(params: {
  expectedTextIncludes?: string[];
  message: TelegramObservedMessage;
}) {
  if (!params.message.text.trim()) {
    throw new Error(`reply message ${params.message.messageId} was empty`);
  }
  for (const expected of params.expectedTextIncludes ?? []) {
    if (!params.message.text.includes(expected)) {
      throw new Error(
        `reply message ${params.message.messageId} missing expected text: ${expected}`,
      );
    }
  }
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
  groupId: string;
  latestSutMessageId?: number;
  observedMessages: TelegramObservedMessage[];
  scenario: TelegramQaScenarioDefinition;
  step: TelegramQaScenarioStep;
  sutBotId: number;
}) {
  const stepTimeoutMs = params.step.expectReply
    ? resolveTelegramQaScenarioTimeoutMs(params.step.timeoutMs ?? params.scenario.timeoutMs)
    : (params.step.timeoutMs ?? params.scenario.timeoutMs);
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
    if (
      !params.step.expectReply &&
      formatErrorMessage(error) ===
        `timed out after ${stepTimeoutMs}ms waiting for Telegram message`
    ) {
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
  if (!sutObserved.message.text.trim()) {
    throw new TelegramQaCanaryError(
      "sut_reply_empty",
      "SUT bot replied to the canary message but the reply text was empty.",
      {
        groupId: params.groupId,
        sutBotId: params.sutBotId,
        driverMessageId: driverMessage.message_id,
        sutMessageId: sutObserved.message.messageId,
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
          "3. Inspect the observed messages artifact for the mismatched SUT message id and reply target.",
        ];
      case "sut_reply_empty":
        return [
          "1. Inspect the observed messages artifact to confirm whether the SUT sent media-only or blank text.",
          "2. Check whether the Telegram native command response path produced an empty or suppressed reply.",
          "3. Confirm the SUT command completed successfully in gateway logs.",
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

async function runInstalledOpenClawTelegramOnboardingPreflight(params: {
  openClawCommand: string;
  providerMode: ReturnType<typeof normalizeQaProviderMode>;
  sutToken: string;
}) {
  const tempRoot = await fs.mkdtemp(
    path.join(resolvePreferredOpenClawTmpDir(), "openclaw-npm-telegram-"),
  );
  const homeDir = path.join(tempRoot, "home");
  const stateDir = path.join(homeDir, ".openclaw");
  await fs.mkdir(stateDir, { recursive: true });
  const tokenPath = path.join(tempRoot, "sut-token.txt");
  await fs.writeFile(tokenPath, params.sutToken, { encoding: "utf8", mode: 0o600 });
  const env = {
    ...process.env,
    HOME: homeDir,
    OPENCLAW_HOME: stateDir,
    OPENCLAW_CONFIG_PATH: path.join(stateDir, "openclaw.json"),
    OPENCLAW_STATE_DIR: stateDir,
    OPENCLAW_GATEWAY_TOKEN: "npm-telegram-live-onboard",
    ...(params.providerMode === "live-frontier"
      ? {}
      : { OPENAI_API_KEY: process.env.OPENAI_API_KEY ?? "sk-openclaw-npm-telegram-preflight" }),
  };
  try {
    await execFileAsync(
      params.openClawCommand,
      [
        "onboard",
        "--non-interactive",
        "--accept-risk",
        "--mode",
        "local",
        "--auth-choice",
        "openai-api-key",
        "--secret-input-mode",
        "ref",
        "--gateway-port",
        "18789",
        "--gateway-bind",
        "loopback",
        "--skip-daemon",
        "--skip-ui",
        "--skip-skills",
        "--skip-health",
        "--json",
      ],
      { env },
    );
    await execFileAsync(
      params.openClawCommand,
      ["channels", "add", "--channel", "telegram", "--token-file", tokenPath],
      { env },
    );
    await execFileAsync(params.openClawCommand, ["doctor", "--non-interactive"], { env });
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

export async function runTelegramQaLive(params: {
  repoRoot?: string;
  outputDir?: string;
  sutOpenClawCommand?: string;
  preflightInstalledOnboarding?: boolean;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  scenarioIds?: string[];
  sutAccountId?: string;
  credentialSource?: string;
  credentialRole?: string;
}): Promise<TelegramQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `telegram-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const providerMode = normalizeQaProviderMode(
    params.providerMode ?? DEFAULT_QA_LIVE_PROVIDER_MODE,
  );
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findScenario(params.scenarioIds, providerMode);
  const progressEnabled = shouldLogTelegramQaLiveProgress();
  writeTelegramQaProgress(
    progressEnabled,
    `run start: scenarios=${scenarios.length} providerMode=${providerMode} fastMode=${params.fastMode === true ? "on" : "off"}`,
  );

  const credentialLease = await acquireQaCredentialLease({
    kind: "telegram",
    source: params.credentialSource,
    role: params.credentialRole,
    resolveEnvPayload: () => resolveTelegramQaRuntimeEnv(),
    parsePayload: parseTelegramQaCredentialPayload,
  });
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
  const redactPublicMetadata = isTruthyOptIn(process.env[QA_REDACT_PUBLIC_METADATA_ENV]);
  const includeObservedMessageContent = isTruthyOptIn(process.env[TELEGRAM_QA_CAPTURE_CONTENT_ENV]);
  writeTelegramQaProgress(
    progressEnabled,
    `runtime: redactMetadata=${redactPublicMetadata ? "on" : "off"} captureContent=${includeObservedMessageContent ? "on" : "off"}`,
  );
  const startedAt = new Date().toISOString();
  const scenarioResults: TelegramQaScenarioResult[] = [];
  const cleanupIssues: string[] = [];
  const gatewayDebugDirPath = path.join(outputDir, "gateway-debug");
  let preservedGatewayDebugArtifacts = false;
  let canaryFailure: string | null = null;
  try {
    if (params.sutOpenClawCommand && params.preflightInstalledOnboarding === true) {
      writeTelegramQaProgress(progressEnabled, "installed package onboarding preflight start");
      await runInstalledOpenClawTelegramOnboardingPreflight({
        openClawCommand: params.sutOpenClawCommand,
        providerMode,
        sutToken: runtimeEnv.sutToken,
      });
      writeTelegramQaProgress(progressEnabled, "installed package onboarding preflight pass");
    }

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
      command: params.sutOpenClawCommand
        ? {
            executablePath: params.sutOpenClawCommand,
            usePackagedPlugins: true,
          }
        : undefined,
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
      await waitForTelegramChannelRunning(gatewayHarness.gateway, sutAccountId);
      assertLeaseHealthy();
      let latestSutMessageId: number | undefined;
      try {
        writeTelegramQaProgress(progressEnabled, "canary start");
        const canaryTiming = await runCanary({
          driverToken: runtimeEnv.driverToken,
          groupId: runtimeEnv.groupId,
          sutUsername,
          sutBotId: sutIdentity.id,
          timeoutMs: resolveTelegramQaCanaryTimeoutMs(),
          observedMessages,
        });
        latestSutMessageId = canaryTiming.responseMessageId;
        scenarioResults.push({
          id: "telegram-canary",
          title: "Telegram canary",
          status: "pass",
          details: redactPublicMetadata
            ? `reply matched in ${canaryTiming.rttMs}ms`
            : `reply message ${canaryTiming.responseMessageId} matched in ${canaryTiming.rttMs}ms`,
          rttMs: canaryTiming.rttMs,
          requestStartedAt: canaryTiming.requestStartedAt,
          responseObservedAt: canaryTiming.responseObservedAt,
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
              if (step.driverGroupAuthorization) {
                await setTelegramQaDriverGroupAuthorization({
                  driverBotId: driverIdentity.id,
                  gateway: gatewayHarness.gateway,
                  groupId: runtimeEnv.groupId,
                  sutAccountId,
                  authorized: step.driverGroupAuthorization === "allow",
                });
                driverOffset = await flushTelegramUpdates(runtimeEnv.driverToken);
              }
              const stepResult = await runTelegramQaScenarioStep({
                driverOffset,
                driverToken: runtimeEnv.driverToken,
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
            const result = {
              id: scenario.id,
              title: scenario.title,
              status: "pass",
              details: redactPublicMetadata
                ? `reply matched in ${rttMs}ms${suffix}`
                : `reply message ${lastMatched.message.messageId} matched in ${rttMs}ms${suffix}`,
              rttMs,
              requestStartedAt: firstRequestStartedAt,
              responseObservedAt: new Date(lastMatched.observedAtMs).toISOString(),
              sentMessageId: redactPublicMetadata ? undefined : lastSentMessageId,
              responseMessageId: redactPublicMetadata ? undefined : lastMatched.message.messageId,
            } satisfies TelegramQaScenarioResult;
            scenarioResults.push(result);
            writeTelegramQaProgress(
              progressEnabled,
              `scenario pass ${scenarioIndexLabel}: ${scenarioIdForLog}`,
            );
          } catch (error) {
            const result = {
              id: scenario.id,
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
    await leaseHeartbeat.stop();
    try {
      await credentialLease.release();
    } catch (error) {
      appendLiveLaneIssue(cleanupIssues, "credential lease release", error);
    }
  }

  const finishedAt = new Date().toISOString();
  const publishedCleanupIssues = redactPublicMetadata
    ? cleanupIssues.map(() => "details redacted (OPENCLAW_QA_REDACT_PUBLIC_METADATA=1)")
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
  const summary: TelegramQaSummary = {
    credentials: {
      source: credentialLease.source,
      kind: credentialLease.kind,
      role: credentialLease.role,
      ownerId: redactPublicMetadata ? undefined : credentialLease.ownerId,
      credentialId: redactPublicMetadata ? undefined : credentialLease.credentialId,
    },
    groupId: redactPublicMetadata ? "<redacted>" : runtimeEnv.groupId,
    startedAt,
    finishedAt,
    cleanupIssues: publishedCleanupIssues,
    counts: {
      total: scenarioResults.length,
      passed: passedCount,
      failed: failedCount,
    },
    scenarios: scenarioResults,
  };
  const reportPath = path.join(outputDir, "telegram-qa-report.md");
  const summaryPath = path.join(outputDir, "telegram-qa-summary.json");
  const observedMessagesPath = path.join(outputDir, "telegram-qa-observed-messages.json");
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
  await fs.writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await fs.writeFile(
    observedMessagesPath,
    `${JSON.stringify(
      buildObservedMessagesArtifact({
        observedMessages,
        includeContent: includeObservedMessageContent,
        redactMetadata: redactPublicMetadata,
      }),
      null,
      2,
    )}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  const artifactPaths = {
    report: reportPath,
    summary: summaryPath,
    observedMessages: observedMessagesPath,
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
    observedMessagesPath,
    ...(preservedGatewayDebugArtifacts ? { gatewayDebugDirPath } : {}),
    scenarios: scenarioResults,
  };
}

export const __testing = {
  TELEGRAM_QA_SCENARIOS,
  TELEGRAM_QA_STANDARD_SCENARIO_IDS,
  buildTelegramQaConfig,
  buildObservedMessagesArtifact,
  canaryFailureMessage,
  callTelegramApi,
  assertTelegramScenarioMessageSet,
  isRecoverableTelegramQaPollError,
  assertTelegramScenarioReply,
  classifyCanaryReply,
  findScenario,
  listTelegramQaScenarioCatalog,
  matchesTelegramScenarioReply,
  normalizeTelegramObservedMessage,
  parseTelegramQaProgressBooleanEnv,
  parseTelegramQaCredentialPayload,
  resolveTelegramQaCanaryTimeoutMs,
  resolveTelegramQaScenarioTimeoutMs,
  resolveTelegramQaRuntimeEnv,
  sanitizeTelegramQaProgressValue,
  shouldLogTelegramQaLiveProgress,
  formatTelegramQaProgressDetails,
  renderTelegramQaMarkdown,
  waitForObservedMessage,
};
