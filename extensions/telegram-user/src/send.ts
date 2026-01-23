import fs from "node:fs";
import type { TelegramClient } from "@mtcute/node";
import { InputMedia } from "@mtcute/core";
import type { PollInput } from "clawdbot/plugin-sdk";

import { getTelegramUserRuntime } from "./runtime.js";
import { resolveTelegramUserAccount } from "./accounts.js";
import { createTelegramUserClient } from "./client.js";
import { resolveTelegramUserSessionPath } from "./session.js";
import type { CoreConfig } from "./types.js";

export type TelegramUserSendResult = {
  messageId: string;
  chatId: string;
};

type NormalizedPollInput = {
  question: string;
  options: string[];
  maxSelections: number;
};

export type TelegramUserSendOpts = {
  client?: TelegramClient;
  accountId?: string;
  replyToId?: number;
  mediaUrl?: string;
};

const normalizeTarget = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed) throw new Error("Recipient is required for Telegram User sends");
  return trimmed
    .replace(/^(telegram-user|telegram|tg):/i, "")
    .replace(/^user:/i, "")
    .trim();
};

export function normalizeTelegramUserMessagingTarget(raw: string): string {
  return normalizeTarget(raw);
}

export function looksLikeTelegramUserTargetId(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /^-?\d+$/.test(trimmed) || /^@?[a-z0-9_]{5,}$/i.test(trimmed);
}

function resolveTelegramUserPeer(target: string): number | string {
  if (/^-?\d+$/.test(target)) {
    const parsed = Number.parseInt(target, 10);
    if (Number.isFinite(parsed)) return parsed;
  }
  return target;
}

function normalizePollInput(input: PollInput): NormalizedPollInput {
  const question = input.question.trim();
  if (!question) {
    throw new Error("Poll question is required");
  }
  const options = (input.options ?? []).map((option) => option.trim()).filter(Boolean);
  if (options.length < 2) {
    throw new Error("Poll requires at least 2 options");
  }
  if (options.length > 10) {
    throw new Error("Poll supports at most 10 options");
  }
  const maxSelectionsRaw = input.maxSelections;
  const maxSelections =
    typeof maxSelectionsRaw === "number" && Number.isFinite(maxSelectionsRaw)
      ? Math.floor(maxSelectionsRaw)
      : 1;
  if (maxSelections < 1) {
    throw new Error("maxSelections must be at least 1");
  }
  if (maxSelections > options.length) {
    throw new Error("maxSelections cannot exceed option count");
  }
  return { question, options, maxSelections };
}

async function resolveClient(params: {
  client?: TelegramClient;
  cfg: CoreConfig;
  accountId?: string;
}): Promise<{ client: TelegramClient; stopOnDone: boolean }> {
  if (params.client) return { client: params.client, stopOnDone: false };
  const account = resolveTelegramUserAccount({
    cfg: params.cfg,
    accountId: params.accountId,
  });
  const apiId = account.credentials.apiId;
  const apiHash = account.credentials.apiHash;
  if (!apiId || !apiHash) {
    throw new Error("Telegram user credentials missing (apiId/apiHash required).");
  }
  const storagePath = resolveTelegramUserSessionPath(account.accountId);
  if (!fs.existsSync(storagePath)) {
    throw new Error(
      "Telegram user session missing. Run `clawdbot channels login --channel telegram-user` first.",
    );
  }
  const client = createTelegramUserClient({ apiId, apiHash, storagePath });
  await client.start();
  return { client, stopOnDone: true };
}

export async function sendMessageTelegramUser(
  to: string,
  text: string,
  opts: TelegramUserSendOpts = {},
): Promise<TelegramUserSendResult> {
  const cfg = getTelegramUserRuntime().config.loadConfig() as CoreConfig;
  const { client, stopOnDone } = await resolveClient({
    client: opts.client,
    cfg,
    accountId: opts.accountId,
  });
  try {
    const target = resolveTelegramUserPeer(normalizeTarget(to));
    const message = await client.sendText(target, text, {
      ...(opts.replyToId ? { replyTo: opts.replyToId } : {}),
    });
    return { messageId: String(message.id), chatId: String(target) };
  } finally {
    if (stopOnDone) {
      await client.destroy();
    }
  }
}

export async function sendMediaTelegramUser(
  to: string,
  text: string,
  opts: TelegramUserSendOpts & { mediaUrl: string; maxBytes?: number },
): Promise<TelegramUserSendResult> {
  const cfg = getTelegramUserRuntime().config.loadConfig() as CoreConfig;
  const { client, stopOnDone } = await resolveClient({
    client: opts.client,
    cfg,
    accountId: opts.accountId,
  });
  try {
    const target = resolveTelegramUserPeer(normalizeTarget(to));
    const media = await getTelegramUserRuntime().media.loadWebMedia(opts.mediaUrl, opts.maxBytes);
    const input = InputMedia.auto(media.buffer, {
      fileName: media.fileName ?? undefined,
      fileMime: media.contentType,
      caption: text,
    });
    const message = await client.sendMedia(target, input, {
      ...(opts.replyToId ? { replyTo: opts.replyToId } : {}),
    });
    return { messageId: String(message.id), chatId: String(target) };
  } finally {
    if (stopOnDone) {
      await client.destroy();
    }
  }
}

export async function sendPollTelegramUser(
  to: string,
  poll: PollInput,
  opts: TelegramUserSendOpts = {},
): Promise<TelegramUserSendResult> {
  const cfg = getTelegramUserRuntime().config.loadConfig() as CoreConfig;
  const { client, stopOnDone } = await resolveClient({
    client: opts.client,
    cfg,
    accountId: opts.accountId,
  });
  try {
    const target = resolveTelegramUserPeer(normalizeTarget(to));
    const normalized = normalizePollInput(poll);
    const input = InputMedia.poll({
      question: normalized.question,
      answers: normalized.options,
      multiple: normalized.maxSelections > 1,
    });
    const message = await client.sendMedia(target, input, {
      ...(opts.replyToId ? { replyTo: opts.replyToId } : {}),
    });
    return { messageId: String(message.id), chatId: String(target) };
  } finally {
    if (stopOnDone) {
      await client.destroy();
    }
  }
}
