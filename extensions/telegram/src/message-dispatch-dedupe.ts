import path from "node:path";
import type { Message } from "grammy/types";
import { createClaimableDedupe, type ClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";

const TELEGRAM_MESSAGE_DISPATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TELEGRAM_MESSAGE_DISPATCH_MEMORY_MAX = 5000;
const TELEGRAM_MESSAGE_DISPATCH_FILE_MAX = 50_000;

export type TelegramMessageDispatchReplayGuard = ClaimableDedupe;

export type TelegramMessageDispatchClaim =
  | { kind: "claimed"; key: string }
  | { kind: "duplicate" }
  | { kind: "invalid" };

function sanitizeFileSegment(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "default";
  }
  return trimmed.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function buildTelegramMessageDispatchReplayKey(msg: Message): string | null {
  const chatId = msg.chat?.id;
  const messageId = msg.message_id;
  if (chatId == null || typeof messageId !== "number" || messageId <= 0) {
    return null;
  }
  return JSON.stringify(["message", String(chatId), messageId]);
}

export function createTelegramMessageDispatchReplayGuard(params: {
  storePath: string;
  onDiskError?: (error: unknown) => void;
}): TelegramMessageDispatchReplayGuard {
  return createClaimableDedupe({
    ttlMs: TELEGRAM_MESSAGE_DISPATCH_TTL_MS,
    memoryMaxSize: TELEGRAM_MESSAGE_DISPATCH_MEMORY_MAX,
    fileMaxEntries: TELEGRAM_MESSAGE_DISPATCH_FILE_MAX,
    resolveFilePath: (namespace) =>
      path.join(
        path.dirname(params.storePath),
        `${path.basename(params.storePath)}.telegram-message-dispatch-${sanitizeFileSegment(
          namespace,
        )}.json`,
      ),
    onDiskError: params.onDiskError,
  });
}

export async function claimTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  msg: Message;
}): Promise<TelegramMessageDispatchClaim> {
  const key = buildTelegramMessageDispatchReplayKey(params.msg);
  if (!key) {
    return { kind: "invalid" };
  }

  let releaseRetries = 0;
  while (true) {
    const claim = await params.guard.claim(key, { namespace: params.accountId });
    if (claim.kind === "claimed") {
      return { kind: "claimed", key };
    }
    if (claim.kind === "duplicate") {
      return { kind: "duplicate" };
    }
    try {
      await claim.pending;
      return { kind: "duplicate" };
    } catch {
      releaseRetries += 1;
      if (releaseRetries > 1) {
        return { kind: "duplicate" };
      }
    }
  }
}

function normalizeReplayKeys(keys?: readonly string[]): string[] {
  return [...new Set((keys ?? []).map((key) => key.trim()).filter(Boolean))];
}

export async function commitTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  keys?: readonly string[];
}): Promise<void> {
  const keys = normalizeReplayKeys(params.keys);
  await Promise.all(keys.map((key) => params.guard.commit(key, { namespace: params.accountId })));
}

export function releaseTelegramMessageDispatchReplay(params: {
  guard: TelegramMessageDispatchReplayGuard;
  accountId: string;
  keys?: readonly string[];
  error?: unknown;
}): void {
  const keys = normalizeReplayKeys(params.keys);
  for (const key of keys) {
    params.guard.release(key, { namespace: params.accountId, error: params.error });
  }
}
