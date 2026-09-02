/**
 * Signal reactions via signal-cli JSON-RPC API
 */

import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import { resolveSignalAccount } from "./accounts.js";
import { signalRpcRequest, type SignalTransportKind } from "./client-adapter.js";
import { normalizeSignalReactionRecipient } from "./normalize.js";
import { resolveSignalRpcContext } from "./rpc-context.js";

export type SignalReactionOpts = {
  cfg: OpenClawConfig;
  baseUrl?: string;
  transportKind?: SignalTransportKind;
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

async function sendReactionSignalCore(params: {
  recipient: string;
  targetTimestamp: number;
  emoji: string;
  remove: boolean;
  opts: SignalReactionOpts;
}): Promise<SignalReactionResult> {
  const cfg = requireRuntimeConfig(params.opts.cfg, "Signal reactions");
  const accountInfo = resolveSignalAccount({
    cfg,
    accountId: params.opts.accountId,
  });
  const { baseUrl, account } = resolveSignalRpcContext(params.opts, accountInfo);

  const normalizedRecipient = normalizeSignalReactionRecipient(params.recipient);
  const groupId = params.opts.groupId?.trim();
  const operation = `Signal reaction${params.remove ? " removal" : ""}`;
  if (!normalizedRecipient && !groupId) {
    throw new Error(`Recipient or groupId is required for ${operation}`);
  }
  if (!Number.isFinite(params.targetTimestamp) || params.targetTimestamp <= 0) {
    throw new Error(`Valid targetTimestamp is required for ${operation}`);
  }
  const normalizedEmoji = params.emoji?.trim();
  if (!normalizedEmoji) {
    throw new Error(`Emoji is required for ${operation}`);
  }

  const targetAuthor = [params.opts.targetAuthor, params.opts.targetAuthorUuid, normalizedRecipient]
    .map((candidate) => normalizeSignalReactionRecipient(candidate ?? ""))
    .find(Boolean);
  if (groupId && !targetAuthor) {
    throw new Error(
      `targetAuthor is required for group reaction${params.remove ? " removal" : "s"}`,
    );
  }

  const requestParams: Record<string, unknown> = {
    emoji: normalizedEmoji,
    targetTimestamp: params.targetTimestamp,
    ...(params.remove ? { remove: true } : {}),
    ...(targetAuthor ? { targetAuthor } : {}),
  };
  if (normalizedRecipient) {
    requestParams.recipients = [normalizedRecipient];
  }
  if (groupId) {
    requestParams.groupIds = [groupId];
  }
  if (account) {
    requestParams.account = account;
  }

  const result = await signalRpcRequest<{ timestamp?: number }>("sendReaction", requestParams, {
    baseUrl,
    timeoutMs: params.opts.timeoutMs,
    transportKind: params.opts.transportKind ?? accountInfo.transport.kind,
  });

  return {
    ok: true,
    timestamp: result?.timestamp,
  };
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
  opts: SignalReactionOpts,
): Promise<SignalReactionResult> {
  return await sendReactionSignalCore({
    recipient,
    targetTimestamp,
    emoji,
    remove: false,
    opts,
  });
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
  opts: SignalReactionOpts,
): Promise<SignalReactionResult> {
  return await sendReactionSignalCore({
    recipient,
    targetTimestamp,
    emoji,
    remove: true,
    opts,
  });
}
