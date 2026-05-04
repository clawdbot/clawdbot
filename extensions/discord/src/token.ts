import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/routing";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import {
  normalizeResolvedSecretInputString,
  resolveSecretInputString,
} from "openclaw/plugin-sdk/secret-input";
import { selectDiscordRuntimeConfig } from "./runtime-config.js";

type DiscordTokenSource = "env" | "config" | "none";
export type DiscordCredentialStatus = "available" | "configured_unavailable" | "missing";

export type DiscordTokenResolution = BaseTokenResolution & {
  source: DiscordTokenSource;
  tokenStatus: DiscordCredentialStatus;
};

type DiscordTokenValueResolution =
  | { status: "available"; value: string }
  | { status: "configured_unavailable" }
  | { status: "missing" };

function stripDiscordBotPrefix(token: string): string {
  return token.replace(/^Bot\s+/i, "");
}

export function normalizeDiscordToken(raw: unknown, path: string): string | undefined {
  const trimmed = normalizeResolvedSecretInputString({ value: raw, path });
  if (!trimmed) {
    return undefined;
  }
  return stripDiscordBotPrefix(trimmed);
}

function resolveDiscordTokenValue(params: {
  cfg: OpenClawConfig;
  value: unknown;
  path: string;
}): DiscordTokenValueResolution {
  const resolved = resolveSecretInputString({
    value: params.value,
    path: params.path,
    defaults: params.cfg.secrets?.defaults,
    mode: "inspect",
  });
  if (resolved.status === "available") {
    return {
      status: "available",
      value: stripDiscordBotPrefix(resolved.value),
    };
  }
  if (resolved.status === "configured_unavailable") {
    return { status: "configured_unavailable" };
  }
  return { status: "missing" };
}

export function resolveDiscordToken(
  cfg: OpenClawConfig,
  opts: { accountId?: string | null; envToken?: string | null } = {},
): DiscordTokenResolution {
  const selectedCfg = selectDiscordRuntimeConfig(cfg);
  const accountId = normalizeAccountId(opts.accountId);
  const discordCfg = selectedCfg?.channels?.discord;
  const accountCfg = resolveAccountEntry(discordCfg?.accounts, accountId);
  const hasAccountToken = Boolean(
    accountCfg &&
    Object.prototype.hasOwnProperty.call(accountCfg as Record<string, unknown>, "token"),
  );
  const accountToken = resolveDiscordTokenValue({
    cfg: selectedCfg,
    value: (accountCfg as { token?: unknown } | undefined)?.token,
    path: `channels.discord.accounts.${accountId}.token`,
  });
  if (accountToken.status === "available" && accountToken.value) {
    return { token: accountToken.value, source: "config", tokenStatus: "available" };
  }
  if (accountToken.status === "configured_unavailable") {
    return { token: "", source: "config", tokenStatus: "configured_unavailable" };
  }
  if (hasAccountToken) {
    return { token: "", source: "none", tokenStatus: "missing" };
  }

  const configToken = resolveDiscordTokenValue({
    cfg: selectedCfg,
    value: discordCfg?.token,
    path: "channels.discord.token",
  });
  if (configToken.status === "available" && configToken.value) {
    return { token: configToken.value, source: "config", tokenStatus: "available" };
  }
  if (configToken.status === "configured_unavailable") {
    return { token: "", source: "config", tokenStatus: "configured_unavailable" };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? normalizeDiscordToken(opts.envToken ?? process.env.DISCORD_BOT_TOKEN, "DISCORD_BOT_TOKEN")
    : undefined;
  if (envToken) {
    return { token: envToken, source: "env", tokenStatus: "available" };
  }

  return { token: "", source: "none", tokenStatus: "missing" };
}
