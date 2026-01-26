/**
 * Signal reactions via signal-cli JSON-RPC API
 */

import { loadConfig } from "../config/config.js";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest } from "./client.js";

export type SignalReactionOpts = {
  baseUrl?: string;
  account?: string;
  accountId?: string;
  timeoutMs?: number;
  targetAuthor?: string;
  targetAuthorUuid?: string;
  groupId?: string;
};

export type SignalReactionResult = {
  ok: boolean;
  timestamp?: number;
};

function normalizeSignalId(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return "";
  return trimmed.replace(/^signal:/i, "").trim();
}

function normalizeSignalUuid(raw: string): string {
  const trimmed = normalizeSignalId(raw);
  if (!trimmed) return "";
  if (trimmed.toLowerCase().startsWith("uuid:")) {
    return trimmed.slice("uuid:".length).trim();
  }
  return trimmed;
}

function resolveTargetAuthorParams(params: {
  targetAuthor?: string;
  targetAuthorUuid?: string;
  fallback?: string;
}): { targetAuthor?: string } {
  const candidates = [params.targetAuthor, params.targetAuthorUuid, params.fallback];
  for (const candidate of candidates) {
    const raw = candidate?.trim();
    if (!raw) continue;
    const normalized = normalizeSignalUuid(raw);
    if (normalized) return { targetAuthor: normalized };
  }
  return {};
}

function resolveReactionRpcContext(
  opts: SignalReactionOpts,
  accountInfo?: ReturnType<typeof resolveSignalAccount>,
) {
  const hasBaseUrl = Boolean(opts.baseUrl?.trim());
  const hasAccount = Boolean(opts.account?.trim());
  const resolvedAccount =
    accountInfo ||
    (!hasBaseUrl || !hasAccount
      ? resolveSignalAccount({
          cfg: loadConfig(),
          accountId: opts.accountId,
        })
      : undefined);
  const baseUrl = opts.baseUrl?.trim() || resolvedAccount?.baseUrl;
  if (!baseUrl) {
    throw new Error("Signal base URL is required");
  }
  const account = opts.account?.trim() || resolvedAccount?.config.account?.trim();
  return { baseUrl, account };
}

/**
 * Send a Signal reaction to a message
 * @param recipient - UUID or E.164 phone number of the message author
 * @param targetTimestamp - Message ID (timestamp) to react to
 * @param emoji - Emoji to react with
 * @param opts - Optional account/connection overrides
 */
export async function sendReactionSignal(
  recipient: string,
  targetTimestamp: number,
  emoji: string,
  opts: SignalReactionOpts = {},
): Promise<SignalReactionResult> {
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveReactionRpcContext(opts, accountInfo);

  const normalizedRecipient = normalizeSignalUuid(recipient);
  const groupId = opts.groupId?.trim();
  if (!normalizedRecipient && !groupId) {
    throw new Error("Recipient or groupId is required for Signal reaction");
  }
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    throw new Error("Valid targetTimestamp is required for Signal reaction");
  }
  if (!emoji?.trim()) {
    throw new Error("Emoji is required for Signal reaction");
  }

  const targetAuthorParams = resolveTargetAuthorParams({
    targetAuthor: opts.targetAuthor,
    targetAuthorUuid: opts.targetAuthorUuid,
    fallback: normalizedRecipient,
  });
  if (groupId && !targetAuthorParams.targetAuthor) {
    throw new Error("targetAuthor is required for group reactions");
  }

  const params: Record<string, unknown> = {
    emoji: emoji.trim(),
    targetTimestamp,
    ...targetAuthorParams,
  };
  if (normalizedRecipient) params.recipients = [normalizedRecipient];
  if (groupId) params.groupIds = [groupId];
  if (account) params.account = account;

  const result = await signalRpcRequest<{ timestamp?: number }>("sendReaction", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });

  return {
    ok: true,
    timestamp: result?.timestamp,
  };
}

/**
 * Remove a Signal reaction from a message
 * @param recipient - UUID or E.164 phone number of the message author
 * @param targetTimestamp - Message ID (timestamp) to remove reaction from
 * @param emoji - Emoji to remove
 * @param opts - Optional account/connection overrides
 */
export async function removeReactionSignal(
  recipient: string,
  targetTimestamp: number,
  emoji: string,
  opts: SignalReactionOpts = {},
): Promise<SignalReactionResult> {
  const accountInfo = resolveSignalAccount({
    cfg: loadConfig(),
    accountId: opts.accountId,
  });
  const { baseUrl, account } = resolveReactionRpcContext(opts, accountInfo);

  const normalizedRecipient = normalizeSignalUuid(recipient);
  const groupId = opts.groupId?.trim();
  if (!normalizedRecipient && !groupId) {
    throw new Error("Recipient or groupId is required for Signal reaction removal");
  }
  if (!Number.isFinite(targetTimestamp) || targetTimestamp <= 0) {
    throw new Error("Valid targetTimestamp is required for Signal reaction removal");
  }
  if (!emoji?.trim()) {
    throw new Error("Emoji is required for Signal reaction removal");
  }

  const targetAuthorParams = resolveTargetAuthorParams({
    targetAuthor: opts.targetAuthor,
    targetAuthorUuid: opts.targetAuthorUuid,
    fallback: normalizedRecipient,
  });
  if (groupId && !targetAuthorParams.targetAuthor) {
    throw new Error("targetAuthor is required for group reaction removal");
  }

  const params: Record<string, unknown> = {
    emoji: emoji.trim(),
    targetTimestamp,
    remove: true,
    ...targetAuthorParams,
  };
  if (normalizedRecipient) params.recipients = [normalizedRecipient];
  if (groupId) params.groupIds = [groupId];
  if (account) params.account = account;

  const result = await signalRpcRequest<{ timestamp?: number }>("sendReaction", params, {
    baseUrl,
    timeoutMs: opts.timeoutMs,
  });

  return {
    ok: true,
    timestamp: result?.timestamp,
  };
}
