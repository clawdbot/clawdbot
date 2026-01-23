import fs from "node:fs";
import type { TelegramClient } from "@mtcute/node";
import { InputMedia } from "@mtcute/core";

import { getTelegramUserRuntime } from "./runtime.js";
import { resolveTelegramUserAccount } from "./accounts.js";
import { createTelegramUserClient } from "./client.js";
import { resolveTelegramUserSessionPath } from "./session.js";
import type { CoreConfig } from "./types.js";

export type TelegramUserSendResult = {
  messageId: string;
  chatId: string;
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
