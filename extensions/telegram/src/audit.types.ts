import type { TelegramNetworkConfig } from "openclaw/plugin-sdk/config-types";

export type TelegramGroupMembershipAuditEntry = {
  chatId: string;
  ok: boolean;
  status?: string | null;
  error?: string | null;
  matchKey?: string;
  matchSource?: "id";
};

export type TelegramGroupMembershipAudit = {
  ok: boolean;
  checkedGroups: number;
  unresolvedGroups: number;
  hasWildcardUnmentionedGroups: boolean;
  groups: TelegramGroupMembershipAuditEntry[];
  elapsedMs: number;
};

export type AuditTelegramGroupMembershipParams = {
  token: string;
  botId: number;
  groupIds: string[];
  proxyUrl?: string;
  network?: TelegramNetworkConfig;
  apiRoot?: string;
  timeoutMs: number;
};
