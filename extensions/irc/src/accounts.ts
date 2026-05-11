import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveMergedAccountConfig } from "openclaw/plugin-sdk/account-resolution";
import {
  parseOptionalDelimitedEntries,
  tryReadSecretFileSync,
} from "openclaw/plugin-sdk/channel-core";
import { normalizeResolvedSecretInputString } from "openclaw/plugin-sdk/secret-input";
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalString,
} from "openclaw/plugin-sdk/string-coerce-runtime";
import type { CoreConfig, IrcAccountConfig, IrcNickServConfig } from "./types.js";

const TRUTHY_ENV = new Set(["true", "1", "yes", "on"]);

export type ResolvedIrcAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  configured: boolean;
  host: string;
  port: number;
  tls: boolean;
  nick: string;
  username: string;
  realname: string;
  password: string;
  passwordSource: "env" | "passwordFile" | "config" | "none";
  config: IrcAccountConfig;
};

function parseTruthy(value?: string): boolean {
  if (!value) {
    return false;
  }
  return TRUTHY_ENV.has(normalizeLowercaseStringOrEmpty(value));
}

function parseIntEnv(value?: string): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 65535) {
    return undefined;
  }
  return parsed;
}

const { listAccountIds: listIrcAccountIds, resolveDefaultAccountId: resolveDefaultIrcAccountId } =
  createAccountListHelpers("irc", { normalizeAccountId });
export { listIrcAccountIds, resolveDefaultIrcAccountId };

function mergeIrcAccountConfig(cfg: CoreConfig, accountId: string): IrcAccountConfig {
  return resolveMergedAccountConfig<IrcAccountConfig>({
    channelConfig: cfg.channels?.irc as IrcAccountConfig | undefined,
    accounts: cfg.channels?.irc?.accounts as Record<string, Partial<IrcAccountConfig>> | undefined,
    accountId,
    omitKeys: ["defaultAccount"],
    normalizeAccountId,
    nestedObjectKeys: ["nickserv"],
  });
}

function resolvePassword(accountId: string, merged: IrcAccountConfig) {
  if (accountId === DEFAULT_ACCOUNT_ID) {
    const envPassword = process.env.IRC_PASSWORD?.trim();
    if (envPassword) {
      return { password: envPassword, source: "env" as const };
    }
  }

  if (merged.passwordFile?.trim()) {
    const filePassword = tryReadSecretFileSync(merged.passwordFile, "IRC password file", {
      rejectSymlink: true,
    });
    if (filePassword) {
      return { password: filePassword, source: "passwordFile" as const };
    }
  }

  const configPassword = normalizeResolvedSecretInputString({
    value: merged.password,
    path: `channels.irc.accounts.${accountId}.password`,
  });
  if (configPassword) {
    return { password: configPassword, source: "config" as const };
  }

  return { password: "", source: "none" as const };
}

function resolveNickServConfig(accountId: string, nickserv?: IrcNickServConfig): IrcNickServConfig {
  const base = nickserv ?? {};
  const envPassword =
    accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_NICKSERV_PASSWORD?.trim() : undefined;
  const envRegisterEmail =
    accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_NICKSERV_REGISTER_EMAIL?.trim() : undefined;

  const passwordFile = base.passwordFile?.trim();
  let resolvedPassword =
    normalizeResolvedSecretInputString({
      value: base.password,
      path: `channels.irc.accounts.${accountId}.nickserv.password`,
    }) ||
    envPassword ||
    "";
  if (!resolvedPassword && passwordFile) {
    resolvedPassword =
      tryReadSecretFileSync(passwordFile, "IRC NickServ password file", {
        rejectSymlink: true,
      }) ?? "";
  }

  const merged: IrcNickServConfig = {
    ...base,
    service: normalizeOptionalString(base.service),
    passwordFile: passwordFile || undefined,
    password: resolvedPassword || undefined,
    registerEmail: base.registerEmail?.trim() || envRegisterEmail || undefined,
  };
  return merged;
}

export function resolveIrcAccount(params: {
  cfg: CoreConfig;
  accountId?: string | null;
}): ResolvedIrcAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.irc?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeIrcAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;

    const tls =
      typeof merged.tls === "boolean"
        ? merged.tls
        : accountId === DEFAULT_ACCOUNT_ID && process.env.IRC_TLS
          ? parseTruthy(process.env.IRC_TLS)
          : true;

    const envPort =
      accountId === DEFAULT_ACCOUNT_ID ? parseIntEnv(process.env.IRC_PORT) : undefined;
    const port = merged.port ?? envPort ?? (tls ? 6697 : 6667);
    const envChannels =
      accountId === DEFAULT_ACCOUNT_ID
        ? parseOptionalDelimitedEntries(process.env.IRC_CHANNELS)
        : undefined;

    const host = (
      merged.host?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_HOST?.trim() : "") ||
      ""
    ).trim();
    const nick = (
      merged.nick?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_NICK?.trim() : "") ||
      ""
    ).trim();
    const username = (
      merged.username?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_USERNAME?.trim() : "") ||
      nick ||
      "openclaw"
    ).trim();
    const realname = (
      merged.realname?.trim() ||
      (accountId === DEFAULT_ACCOUNT_ID ? process.env.IRC_REALNAME?.trim() : "") ||
      "OpenClaw"
    ).trim();

    const passwordResolution = resolvePassword(accountId, merged);
    const nickserv = resolveNickServConfig(accountId, merged.nickserv);

    const config: IrcAccountConfig = {
      ...merged,
      channels: merged.channels ?? envChannels,
      tls,
      port,
      host,
      nick,
      username,
      realname,
      nickserv,
    };

    return {
      accountId,
      enabled,
      name: normalizeOptionalString(merged.name),
      configured: Boolean(host && nick),
      host,
      port,
      tls,
      nick,
      username,
      realname,
      password: passwordResolution.password,
      passwordSource: passwordResolution.source,
      config,
    } satisfies ResolvedIrcAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) {
    return primary;
  }
  if (primary.configured) {
    return primary;
  }

  const fallbackId = resolveDefaultIrcAccountId(params.cfg);
  if (fallbackId === primary.accountId) {
    return primary;
  }
  const fallback = resolve(fallbackId);
  if (!fallback.configured) {
    return primary;
  }
  return fallback;
}

export function listEnabledIrcAccounts(cfg: CoreConfig): ResolvedIrcAccount[] {
  return listIrcAccountIds(cfg)
    .map((accountId) => resolveIrcAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
