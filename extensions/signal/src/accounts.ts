// Signal plugin module implements accounts behavior.
import {
  createAccountListHelpers,
  normalizeAccountId,
  resolveAccountEntry,
  resolveMergedAccountConfig,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-resolution";
import type { ReplyToMode } from "openclaw/plugin-sdk/config-contracts";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import type { SignalAccountConfig } from "./account-types.js";

export type ResolvedSignalAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  baseUrl: string;
  configured: boolean;
  config: SignalAccountConfig;
};

const { listAccountIds, resolveDefaultAccountId } = createAccountListHelpers("signal", {
  implicitDefaultAccount: {
    channelKeys: ["account"],
  },
});
export const listSignalAccountIds = listAccountIds;
export const resolveDefaultSignalAccountId = resolveDefaultAccountId;

function mergeSignalAccountConfig(cfg: OpenClawConfig, accountId: string): SignalAccountConfig {
  return resolveMergedAccountConfig<SignalAccountConfig>({
    channelConfig: cfg.channels?.signal as SignalAccountConfig | undefined,
    accounts: cfg.channels?.signal?.accounts as
      | Record<string, Partial<SignalAccountConfig>>
      | undefined,
    accountId,
    nestedObjectKeys: ["aliases"],
  });
}

export function resolveSignalAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedSignalAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
  );
  const baseEnabled = params.cfg.channels?.signal?.enabled !== false;
  const merged = mergeSignalAccountConfig(params.cfg, accountId);
  const accountEnabled = merged.enabled !== false;
  const enabled = baseEnabled && accountEnabled;
  const host = normalizeOptionalString(merged.httpHost) ?? "127.0.0.1";
  const port = merged.httpPort ?? 8080;
  const baseUrl = normalizeOptionalString(merged.httpUrl) ?? `http://${host}:${port}`;
  const configured = Boolean(
    normalizeOptionalString(merged.account) ||
    normalizeOptionalString(merged.configPath) ||
    normalizeOptionalString(merged.httpUrl) ||
    normalizeOptionalString(merged.cliPath) ||
    normalizeOptionalString(merged.httpHost) ||
    typeof merged.httpPort === "number" ||
    typeof merged.autoStart === "boolean",
  );
  return {
    accountId,
    enabled,
    name: normalizeOptionalString(merged.name),
    baseUrl,
    configured,
    config: merged,
  };
}

export function listEnabledSignalAccounts(cfg: OpenClawConfig): ResolvedSignalAccount[] {
  return listSignalAccountIds(cfg)
    .map((accountId) => resolveSignalAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}

function normalizeSignalReplyToMode(value: unknown): ReplyToMode | undefined {
  return value === "off" || value === "first" || value === "all" || value === "batched"
    ? value
    : undefined;
}

export function resolveSignalReplyToMode(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  chatType?: string | null;
}): ReplyToMode {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultSignalAccountId(params.cfg),
  );
  const signalConfig = params.cfg.channels?.signal;
  const accountConfig = resolveAccountEntry(
    signalConfig?.accounts as Record<string, SignalAccountConfig> | undefined,
    accountId,
  );
  const chatType =
    params.chatType === "direct" || params.chatType === "group" ? params.chatType : undefined;
  if (chatType) {
    const accountScoped = normalizeSignalReplyToMode(
      accountConfig?.replyToModeByChatType?.[chatType],
    );
    if (accountScoped) {
      return accountScoped;
    }
    const accountDefault = normalizeSignalReplyToMode(accountConfig?.replyToMode);
    if (accountDefault) {
      return accountDefault;
    }
    const channelScoped = normalizeSignalReplyToMode(
      signalConfig?.replyToModeByChatType?.[chatType],
    );
    if (channelScoped) {
      return channelScoped;
    }
  }
  return (
    normalizeSignalReplyToMode(accountConfig?.replyToMode) ??
    normalizeSignalReplyToMode(signalConfig?.replyToMode) ??
    "all"
  );
}
