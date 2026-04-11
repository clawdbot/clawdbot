import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { startQaGatewayChild } from "../../gateway-child.js";
import {
  defaultQaModelForMode,
  normalizeQaProviderMode,
  type QaProviderModeInput,
} from "../../run-config.js";
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
  | "telegram-context-command"
  | "telegram-mentioned-message-reply"
  | "telegram-mention-gating";

type TelegramQaScenarioRun = {
  expectReply: boolean;
  input: string;
  expectedTextIncludes?: string[];
  matchText?: string;
};

type TelegramQaScenarioDefinition = LiveTransportScenarioDefinition<TelegramQaScenarioId> & {
  buildRun: (sutUsername: string) => TelegramQaScenarioRun;
};

type TelegramObservedMessage = {
  updateId: number;
  messageId: number;
  chatId: number;
  senderId: number;
  senderIsBot: boolean;
  senderUsername?: string;
  text: string;
  caption?: string;
  replyToMessageId?: number;
  timestamp: number;
  inlineButtons: string[];
  mediaKinds: string[];
};

type TelegramObservedMessageArtifact = Omit<TelegramObservedMessage, "text" | "caption"> & {
  text?: string;
  caption?: string;
};

type TelegramQaScenarioResult = {
  id: string;
  title: string;
  status: "pass" | "fail";
  details: string;
};

type TelegramQaCanaryPhase = "sut_reply_timeout" | "sut_reply_not_threaded" | "sut_reply_empty";

export type TelegramQaRunResult = {
  outputDir: string;
  reportPath: string;
  summaryPath: string;
  observedMessagesPath: string;
  scenarios: TelegramQaScenarioResult[];
};

type TelegramQaSummary = {
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
  message?: TelegramMessage;
};

type TelegramSendMessageResult = {
  message_id: number;
  chat: {
    id: number;
  };
};

const TELEGRAM_QA_SCENARIOS: TelegramQaScenarioDefinition[] = [
  {
    id: "telegram-help-command",
    standardId: "help-command",
    title: "Telegram help command reply",
    timeoutMs: 45_000,
    buildRun: (sutUsername) => ({
      expectReply: true,
      input: `/help@${sutUsername}`,
      expectedTextIncludes: ["/new", "/commands for full list"],
    }),
  },
  {
    id: "telegram-commands-command",
    title: "Telegram commands list reply",
    timeoutMs: 45_000,
    buildRun: (sutUsername) => ({
      expectReply: true,
      input: `/commands@${sutUsername}`,
      expectedTextIncludes: ["/help", "More: /tools for available capabilities"],
    }),
  },
  {
    id: "telegram-tools-compact-command",
    title: "Telegram tools compact reply",
    timeoutMs: 45_000,
    buildRun: (sutUsername) => ({
      expectReply: true,
      input: `/tools@${sutUsername} compact`,
      expectedTextIncludes: ["exec", "Use /tools verbose for descriptions."],
    }),
  },
  {
    id: "telegram-whoami-command",
    title: "Telegram whoami reply",
    timeoutMs: 45_000,
    buildRun: (sutUsername) => ({
      expectReply: true,
      input: `/whoami@${sutUsername}`,
      expectedTextIncludes: ["🧭 Identity", "Channel: telegram"],
    }),
  },
  {
    id: "telegram-context-command",
    title: "Telegram context reply",
    timeoutMs: 45_000,
    buildRun: (sutUsername) => ({
      expectReply: true,
      input: `/context@${sutUsername}`,
      expectedTextIncludes: ["/context list", "Inline shortcut"],
    }),
  },
  {
    id: "telegram-mentioned-message-reply",
    title: "Telegram mentioned message gets a reply",
    timeoutMs: 45_000,
    buildRun: (sutUsername) => {
      const token = `TELEGRAM_QA_REPLY_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: true,
        input: `@${sutUsername} reply with only this exact marker: ${token}`,
        expectedTextIncludes: [token],
        matchText: token,
      };
    },
  },
  {
    id: "telegram-mention-gating",
    standardId: "mention-gating",
    title: "Telegram group message without mention does not trigger",
    timeoutMs: 8_000,
    buildRun: () => {
      const token = `TELEGRAM_QA_NOMENTION_${randomUUID().slice(0, 8).toUpperCase()}`;
      return {
        expectReply: false,
        input: `reply with only this exact marker: ${token}`,
        matchText: token,
      };
    },
  },
];

export const TELEGRAM_QA_STANDARD_SCENARIO_IDS = collectLiveTransportStandardScenarioCoverage({
  alwaysOnStandardScenarioIds: ["canary"],
  scenarios: TELEGRAM_QA_SCENARIOS,
});

const TELEGRAM_QA_ENV_KEYS = [
  "OPENCLAW_QA_TELEGRAM_GROUP_ID",
  "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN",
  "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN",
] as const;

function resolveEnvValue(env: NodeJS.ProcessEnv, key: (typeof TELEGRAM_QA_ENV_KEYS)[number]) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

export function resolveTelegramQaRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
): TelegramQaRuntimeEnv {
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

export function normalizeTelegramObservedMessage(
  update: TelegramUpdate,
): TelegramObservedMessage | null {
  const message = update.message;
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
    plugins: {
      ...baseCfg.plugins,
      allow: pluginAllow,
      entries: pluginEntries,
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
        allowed_updates: ["message"],
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

async function sendGroupMessage(token: string, groupId: string, text: string) {
  return await callTelegramApi<TelegramSendMessageResult>(token, "sendMessage", {
    chat_id: groupId,
    text,
    disable_notification: true,
  });
}

async function waitForObservedMessage(params: {
  token: string;
  initialOffset: number;
  timeoutMs: number;
  predicate: (message: TelegramObservedMessage) => boolean;
  observedMessages: TelegramObservedMessage[];
}) {
  const startedAt = Date.now();
  let offset = params.initialOffset;
  while (Date.now() - startedAt < params.timeoutMs) {
    const remainingMs = Math.max(
      1_000,
      Math.min(10_000, params.timeoutMs - (Date.now() - startedAt)),
    );
    const timeoutSeconds = Math.max(1, Math.min(10, Math.floor(remainingMs / 1000)));
    const updates = await callTelegramApi<TelegramUpdate[]>(
      params.token,
      "getUpdates",
      {
        offset,
        timeout: timeoutSeconds,
        allowed_updates: ["message"],
      },
      timeoutSeconds * 1000 + 5_000,
    );
    if (updates.length === 0) {
      continue;
    }
    offset = (updates.at(-1)?.update_id ?? offset) + 1;
    for (const update of updates) {
      const normalized = normalizeTelegramObservedMessage(update);
      if (!normalized) {
        continue;
      }
      params.observedMessages.push(normalized);
      if (params.predicate(normalized)) {
        return { message: normalized, nextOffset: offset };
      }
    }
  }
  throw new Error(`timed out after ${params.timeoutMs}ms waiting for Telegram message`);
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

function renderTelegramQaMarkdown(params: {
  cleanupIssues: string[];
  groupId: string;
  startedAt: string;
  finishedAt: string;
  scenarios: TelegramQaScenarioResult[];
}) {
  const lines = [
    "# Telegram QA Report",
    "",
    `- Group: \`${params.groupId}\``,
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
}) {
  return params.observedMessages.map<TelegramObservedMessageArtifact>((message) =>
    params.includeContent
      ? { ...message }
      : {
          updateId: message.updateId,
          messageId: message.messageId,
          chatId: message.chatId,
          senderId: message.senderId,
          senderIsBot: message.senderIsBot,
          senderUsername: message.senderUsername,
          replyToMessageId: message.replyToMessageId,
          timestamp: message.timestamp,
          inlineButtons: message.inlineButtons,
          mediaKinds: message.mediaKinds,
        },
  );
}

function findScenario(ids?: string[]) {
  return selectLiveTransportScenarios({
    ids,
    laneLabel: "Telegram",
    scenarios: TELEGRAM_QA_SCENARIOS,
  });
}

function matchesTelegramScenarioReply(params: {
  groupId: string;
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
  observedMessages: TelegramObservedMessage[];
}) {
  const offset = await flushTelegramUpdates(params.driverToken);
  const driverMessage = await sendGroupMessage(
    params.driverToken,
    params.groupId,
    `/help@${params.sutUsername}`,
  );
  let firstUnthreadedReply:
    | Pick<TelegramObservedMessage, "messageId" | "replyToMessageId" | "text">
    | undefined;
  let sutObserved: Awaited<ReturnType<typeof waitForObservedMessage>>;
  try {
    sutObserved = await waitForObservedMessage({
      token: params.driverToken,
      initialOffset: offset,
      timeoutMs: 30_000,
      observedMessages: params.observedMessages,
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
      "SUT bot did not send any group reply after the canary command within 30s.",
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
}

function canaryFailureMessage(params: {
  error: unknown;
  groupId: string;
  driverBotId: number;
  driverUsername?: string;
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
        .map(([key, value]) => `- ${key}: ${String(value)}`)
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
    `- groupId: ${params.groupId}`,
    `- driverBotId: ${params.driverBotId}`,
    `- driverUsername: ${params.driverUsername ?? "<none>"}`,
    `- sutBotId: ${params.sutBotId}`,
    `- sutUsername: ${params.sutUsername}`,
    ...context,
    "Remediation:",
    ...remediation,
  ].join("\n");
}

export async function runTelegramQaLive(params: {
  repoRoot?: string;
  outputDir?: string;
  providerMode?: QaProviderModeInput;
  primaryModel?: string;
  alternateModel?: string;
  fastMode?: boolean;
  scenarioIds?: string[];
  sutAccountId?: string;
}): Promise<TelegramQaRunResult> {
  const repoRoot = path.resolve(params.repoRoot ?? process.cwd());
  const outputDir =
    params.outputDir ??
    path.join(repoRoot, ".artifacts", "qa-e2e", `telegram-${Date.now().toString(36)}`);
  await fs.mkdir(outputDir, { recursive: true });

  const runtimeEnv = resolveTelegramQaRuntimeEnv();
  const providerMode = normalizeQaProviderMode(params.providerMode ?? "live-frontier");
  const primaryModel = params.primaryModel?.trim() || defaultQaModelForMode(providerMode);
  const alternateModel = params.alternateModel?.trim() || defaultQaModelForMode(providerMode, true);
  const sutAccountId = params.sutAccountId?.trim() || "sut";
  const scenarios = findScenario(params.scenarioIds);
  const observedMessages: TelegramObservedMessage[] = [];
  const includeObservedMessageContent = process.env.OPENCLAW_QA_TELEGRAM_CAPTURE_CONTENT === "1";
  const startedAt = new Date().toISOString();

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
    qaBusBaseUrl: "http://127.0.0.1:43123",
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

  const scenarioResults: TelegramQaScenarioResult[] = [];
  const cleanupIssues: string[] = [];
  let canaryFailure: string | null = null;
  try {
    await waitForTelegramChannelRunning(gatewayHarness.gateway, sutAccountId);
    try {
      await runCanary({
        driverToken: runtimeEnv.driverToken,
        groupId: runtimeEnv.groupId,
        sutUsername,
        sutBotId: sutIdentity.id,
        observedMessages,
      });
    } catch (error) {
      canaryFailure = canaryFailureMessage({
        error,
        groupId: runtimeEnv.groupId,
        driverBotId: driverIdentity.id,
        driverUsername: driverIdentity.username,
        sutBotId: sutIdentity.id,
        sutUsername,
      });
      scenarioResults.push({
        id: "telegram-canary",
        title: "Telegram canary",
        status: "fail",
        details: canaryFailure,
      });
    }
    if (!canaryFailure) {
      let driverOffset = await flushTelegramUpdates(runtimeEnv.driverToken);
      for (const scenario of scenarios) {
        const scenarioRun = scenario.buildRun(sutUsername);
        try {
          const sent = await sendGroupMessage(
            runtimeEnv.driverToken,
            runtimeEnv.groupId,
            scenarioRun.input,
          );
          const matched = await waitForObservedMessage({
            token: runtimeEnv.driverToken,
            initialOffset: driverOffset,
            timeoutMs: scenario.timeoutMs,
            observedMessages,
            predicate: (message) =>
              matchesTelegramScenarioReply({
                groupId: runtimeEnv.groupId,
                matchText: scenarioRun.matchText,
                message,
                sentMessageId: sent.message_id,
                sutBotId: sutIdentity.id,
              }),
          });
          driverOffset = matched.nextOffset;
          if (!scenarioRun.expectReply) {
            throw new Error(`unexpected reply message ${matched.message.messageId} matched`);
          }
          assertTelegramScenarioReply({
            expectedTextIncludes: scenarioRun.expectedTextIncludes,
            message: matched.message,
          });
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "pass",
            details: `reply message ${matched.message.messageId} matched`,
          });
        } catch (error) {
          if (!scenarioRun.expectReply) {
            const details = formatErrorMessage(error);
            if (
              details === `timed out after ${scenario.timeoutMs}ms waiting for Telegram message`
            ) {
              scenarioResults.push({
                id: scenario.id,
                title: scenario.title,
                status: "pass",
                details: "no reply",
              });
              continue;
            }
          }
          scenarioResults.push({
            id: scenario.id,
            title: scenario.title,
            status: "fail",
            details: formatErrorMessage(error),
          });
        }
      }
    }
  } finally {
    try {
      await gatewayHarness.stop();
    } catch (error) {
      appendLiveLaneIssue(cleanupIssues, "live gateway cleanup", error);
    }
  }

  const finishedAt = new Date().toISOString();
  const summary: TelegramQaSummary = {
    groupId: runtimeEnv.groupId,
    startedAt,
    finishedAt,
    cleanupIssues,
    counts: {
      total: scenarioResults.length,
      passed: scenarioResults.filter((entry) => entry.status === "pass").length,
      failed: scenarioResults.filter((entry) => entry.status === "fail").length,
    },
    scenarios: scenarioResults,
  };
  const reportPath = path.join(outputDir, "telegram-qa-report.md");
  const summaryPath = path.join(outputDir, "telegram-qa-summary.json");
  const observedMessagesPath = path.join(outputDir, "telegram-qa-observed-messages.json");
  await fs.writeFile(
    reportPath,
    `${renderTelegramQaMarkdown({
      cleanupIssues,
      groupId: runtimeEnv.groupId,
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
        details: cleanupIssues,
        artifacts: artifactPaths,
      }),
    );
  }

  return {
    outputDir,
    reportPath,
    summaryPath,
    observedMessagesPath,
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
  assertTelegramScenarioReply,
  classifyCanaryReply,
  findScenario,
  matchesTelegramScenarioReply,
  normalizeTelegramObservedMessage,
  resolveTelegramQaRuntimeEnv,
};
