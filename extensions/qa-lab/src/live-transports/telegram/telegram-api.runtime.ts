import { setTimeout as sleep } from "node:timers/promises";
// Qa Lab plugin module owns Telegram live adapter API and credential behavior.
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
import { z } from "zod";

export type TelegramQaRuntimeEnv = {
  groupId: string;
  driverToken: string;
  sutToken: string;
};

export type TelegramBotIdentity = {
  id: number;
  is_bot: boolean;
  first_name: string;
  username?: string;
};

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

export type TelegramUpdate = Pick<TelegramBotUpdate, "update_id"> & {
  edited_message?: TelegramMessage;
  message?: TelegramMessage;
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

type TelegramChannelStatus = {
  accountId?: string;
  connected?: boolean;
  lastConnectedAt?: number;
  lastDisconnect?: unknown;
  lastError?: string | null;
  restartPending?: boolean;
  running?: boolean;
};

type TelegramGatewayClient = {
  call: (method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<unknown>;
};

const TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS = 45_000;
const TELEGRAM_QA_ENV_FIELDS = [
  { field: "groupId", envKey: "OPENCLAW_QA_TELEGRAM_GROUP_ID" },
  { field: "driverToken", envKey: "OPENCLAW_QA_TELEGRAM_DRIVER_BOT_TOKEN" },
  { field: "sutToken", envKey: "OPENCLAW_QA_TELEGRAM_SUT_BOT_TOKEN" },
] as const;

const telegramQaCredentialPayloadSchema = z.object({
  groupId: z.string().trim().min(1),
  driverToken: z.string().trim().min(1),
  sutToken: z.string().trim().min(1),
});

function resolveEnvValue(
  env: NodeJS.ProcessEnv,
  key: (typeof TELEGRAM_QA_ENV_FIELDS)[number]["envKey"],
) {
  const value = env[key]?.trim();
  if (!value) {
    throw new Error(`Missing ${key}.`);
  }
  return value;
}

export function resolveTelegramQaRuntimeEnv(
  env: NodeJS.ProcessEnv = process.env,
): TelegramQaRuntimeEnv {
  return parseTelegramQaCredentialPayload(
    Object.fromEntries(
      TELEGRAM_QA_ENV_FIELDS.map(({ envKey, field }) => [field, resolveEnvValue(env, envKey)]),
    ),
  );
}

export function parseTelegramQaCredentialPayload(payload: unknown): TelegramQaRuntimeEnv {
  const parsed = telegramQaCredentialPayloadSchema.parse(payload);
  if (!/^-?\d+$/u.test(parsed.groupId)) {
    throw new Error("Telegram credential payload groupId must be a numeric Telegram chat id.");
  }
  return parsed;
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
  for (const kind of ["document", "audio", "video", "voice", "sticker"] as const) {
    if (message[kind]) {
      kinds.push(kind);
    }
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
  return typeof value.expression === "string" ? value.expression : "";
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

function flattenTelegramRichBlocks(value: unknown): string {
  const blocks = Array.isArray(value) ? value : [value];
  return blocks
    .map((block) => flattenTelegramRichBlock(block))
    .filter((part) => part.trim())
    .join("\n");
}

function flattenTelegramRichBlock(value: unknown): string {
  if (typeof value === "string" || Array.isArray(value)) {
    return flattenTelegramRichText(value);
  }
  if (!isRecord(value)) {
    return "";
  }
  const parts = [
    "text" in value ? flattenTelegramRichText(value.text) : "",
    "summary" in value ? flattenTelegramRichText(value.summary) : "",
    typeof value.label === "string" ? value.label : "",
    typeof value.expression === "string" ? value.expression : "",
    "blocks" in value ? flattenTelegramRichBlocks(value.blocks) : "",
    "items" in value ? flattenTelegramRichBlocks(value.items) : "",
    "cells" in value ? flattenTelegramRichTableCells(value.cells) : "",
    "caption" in value ? flattenTelegramRichBlock(value.caption) : "",
    "credit" in value ? flattenTelegramRichText(value.credit) : "",
  ];
  return parts.filter((part) => part.trim()).join("\n");
}

function selectTelegramObservedText(message: TelegramMessage) {
  return (
    message.text ||
    message.caption ||
    message.rich_message?.markdown ||
    message.rich_message?.html ||
    flattenTelegramRichBlocks(message.rich_message?.blocks) ||
    ""
  );
}

export function normalizeTelegramObservedMessage(
  update: TelegramUpdate,
): TelegramObservedMessage | null {
  const message = update.edited_message ?? update.message;
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
    timestamp: message.date * 1_000,
    inlineButtons: flattenInlineButtons(message.reply_markup),
    mediaKinds: detectMediaKinds(message),
  };
}

export function buildTelegramQaConfig(
  baseCfg: OpenClawConfig,
  params: {
    groupId: string;
    sutToken: string;
    driverBotId: number;
    sutAccountId: string;
  },
): OpenClawConfig {
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
      allow: uniqueStrings([...(baseCfg.plugins?.allow ?? []), "telegram"]),
      entries: {
        ...baseCfg.plugins?.entries,
        telegram: { enabled: true },
      },
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

export async function callTelegramApi<T>(
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
      headers: { "content-type": "application/json" },
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

export function isRecoverableTelegramQaPollError(error: unknown): boolean {
  const message = formatErrorMessage(error).toLowerCase();
  return [
    "fetch failed",
    "aborted due to timeout",
    "operation was aborted",
    "request timed out",
    "aborterror",
    "econnreset",
    "etimedout",
    "socket hang up",
    "terminated",
  ].some((fragment) => message.includes(fragment));
}

export async function waitForTelegramPollRetryDelay(remainingMs = 250) {
  await sleep(Math.min(250, Math.max(100, remainingMs)));
}

export async function flushTelegramUpdates(token: string) {
  const startedAt = Date.now();
  let offset = 0;
  while (Date.now() - startedAt < 15_000) {
    const updates = await callTelegramApi<TelegramUpdate[]>(
      token,
      "getUpdates",
      { offset, timeout: 0, allowed_updates: ["message", "edited_message"] },
      15_000,
    );
    if (updates.length === 0) {
      return offset;
    }
    offset = (updates.at(-1)?.update_id ?? offset) + 1;
  }
  throw new Error("timed out after 15000ms draining Telegram updates");
}

function resolveTelegramQaReadyTimeoutMs(env: NodeJS.ProcessEnv = process.env) {
  const raw = env.OPENCLAW_QA_TRANSPORT_READY_TIMEOUT_MS;
  return raw
    ? (parseStrictPositiveInteger(raw) ?? TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS)
    : TELEGRAM_QA_DEFAULT_READY_TIMEOUT_MS;
}

export async function waitForTelegramChannelRunning(
  gateway: TelegramGatewayClient,
  accountId: string,
  options?: { env?: NodeJS.ProcessEnv; pollMs?: number; timeoutMs?: number },
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
      )) as { channelAccounts?: Record<string, TelegramChannelStatus[]> };
      const match = (payload.channelAccounts?.telegram ?? []).find(
        (entry) => entry.accountId === accountId,
      );
      lastProbeError = undefined;
      lastStatus = match;
      if (match?.running && match.connected === true && match.restartPending !== true) {
        return;
      }
    } catch (error) {
      lastProbeError = formatErrorMessage(error);
    }
    await sleep(pollMs);
  }
  const details = lastStatus
    ? `; last status: ${JSON.stringify(lastStatus)}`
    : lastProbeError
      ? `; last probe error: ${lastProbeError}`
      : "";
  throw new Error(`telegram account "${accountId}" did not become ready${details}`);
}
