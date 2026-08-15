// Builds and validates channel pairing challenges for first-time setup.
import { getGlobalHookRunner } from "../plugins/hook-runner-global.js";
import { normalizeAccountId } from "../routing/account-id.js";
import { buildPairingReply } from "./pairing-messages.js";

type PairingMeta = Record<string, string | undefined>;

type PairingChallengeParams = {
  channel: string;
  accountId?: string;
  senderId: string;
  senderIdLine: string;
  meta?: PairingMeta;
  upsertPairingRequest: (params: {
    id: string;
    meta?: PairingMeta;
  }) => Promise<{ code: string; created: boolean }>;
  sendPairingReply: (text: string) => Promise<void>;
  buildReplyText?: (params: { code: string; senderIdLine: string }) => string;
  onCreated?: (params: { code: string }) => void;
  onReplyError?: (err: unknown) => void;
};

async function runPairingRequestedHook(params: {
  channel: string;
  accountId?: string;
  senderId: string;
  code: string;
  meta?: PairingMeta;
}): Promise<void> {
  const hookRunner = getGlobalHookRunner();
  if (!hookRunner?.hasHooks("channel_pairing_requested")) {
    return;
  }
  await hookRunner.runChannelPairingRequested(
    {
      channel: params.channel,
      accountId: params.accountId,
      senderId: params.senderId,
      code: params.code,
      metadata: params.meta,
    },
    {
      channelId: params.channel,
      accountId: params.accountId,
      senderId: params.senderId,
    },
  );
}

/**
 * Shared pairing challenge issuance for DM pairing policy pathways.
 * Ensures every channel follows the same create-if-missing + reply flow.
 */
export async function issuePairingChallenge(
  params: PairingChallengeParams,
): Promise<{ created: boolean; code?: string }> {
  const { code, created } = await params.upsertPairingRequest({
    id: params.senderId,
    meta: params.meta,
  });
  if (!created) {
    return { created: false };
  }
  params.onCreated?.({ code });
  const accountId = params.accountId ? normalizeAccountId(params.accountId) : undefined;
  // Notification/audit hooks must not delay the pairing-code reply.
  void runPairingRequestedHook({
    channel: params.channel,
    accountId,
    senderId: params.senderId,
    code,
    meta: params.meta,
  }).catch(() => undefined);
  const replyText =
    params.buildReplyText?.({ code, senderIdLine: params.senderIdLine }) ??
    buildPairingReply({
      channel: params.channel,
      idLine: params.senderIdLine,
      code,
    });
  try {
    await params.sendPairingReply(replyText);
  } catch (err) {
    params.onReplyError?.(err);
  }
  return { created: true, code };
}
