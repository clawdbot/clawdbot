// Telegram Mini App owner checks.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { expandTelegramAllowFromWithAccessGroups } from "../access-groups.js";
import { mergeTelegramAccountConfig } from "../accounts.js";
import { isNumericTelegramSenderUserId, normalizeTelegramAllowFromEntry } from "../allow-from.js";

export async function isTelegramMiniAppOwner(params: {
  cfg: OpenClawConfig;
  accountId: string;
  userId: string;
}): Promise<boolean> {
  const userId = params.userId.trim();
  if (!isNumericTelegramSenderUserId(userId)) {
    return false;
  }
  const account = mergeTelegramAccountConfig(params.cfg, params.accountId);
  const allowFrom = [...(account.allowFrom ?? []), ...(params.cfg.commands?.ownerAllowFrom ?? [])];
  // Dashboard access is stricter than core senderIsOwner: wildcard and username
  // allowFrom entries never grant the numeric-id match that mints an operator credential.
  const expanded = await expandTelegramAllowFromWithAccessGroups({
    cfg: params.cfg,
    accountId: params.accountId,
    allowFrom,
    senderId: userId,
  });
  return expanded.some((entry) => normalizeTelegramAllowFromEntry(entry) === userId);
}
