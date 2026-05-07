import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import {
  expandAllowFromWithAccessGroups,
  parseAccessGroupAllowFromEntry,
} from "openclaw/plugin-sdk/security-runtime";
import { isSenderAllowed, normalizeAllowFrom } from "./bot-access.js";

export async function expandTelegramAllowFromWithAccessGroups(params: {
  cfg?: OpenClawConfig;
  allowFrom?: Array<string | number>;
  accountId?: string;
  senderId?: string;
}): Promise<string[]> {
  const allowFrom = (params.allowFrom ?? []).map(String);
  const senderId = params.senderId?.trim() ?? "";
  const expanded =
    params.cfg && senderId
      ? await expandAllowFromWithAccessGroups({
          cfg: params.cfg,
          allowFrom,
          channel: "telegram",
          accountId: params.accountId ?? "default",
          senderId,
          isSenderAllowed: (candidateSenderId, allowEntries) =>
            isSenderAllowed({
              allow: normalizeAllowFrom(allowEntries),
              senderId: candidateSenderId,
            }),
        })
      : allowFrom;
  const originalEntries = new Set(allowFrom);
  const matched = expanded.some((entry) => !originalEntries.has(entry));
  return matched
    ? expanded.filter((entry) => parseAccessGroupAllowFromEntry(entry) == null)
    : expanded;
}
