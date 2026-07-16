import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/core";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { normalizeResolvedSecretInputString, normalizeSecretInputString } from "./secret-input.js";
import type { ZaloConfig } from "./types.js";

export type ZaloTokenResolution = BaseTokenResolution & {
  source: "env" | "config" | "configFile" | "none";
};

function readTokenFromFile(tokenFile: string | undefined): string {
  return tryReadSecretFileSync(tokenFile, "Zalo token file", { rejectSymlink: true }) ?? "";
}

export function resolveZaloToken(
  config: ZaloConfig | undefined,
  accountId?: string | null,
  options?: { allowUnresolvedSecretRef?: boolean },
): ZaloTokenResolution {
  const resolvedAccountId = normalizeAccountId(accountId ?? config?.defaultAccount);
  const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const baseConfig = config;
  const accountConfig = resolveAccountEntry(
    baseConfig?.accounts as Record<string, ZaloConfig> | undefined,
    normalizeAccountId(resolvedAccountId),
  );
  const accountHasBotToken = Boolean(
    accountConfig && Object.prototype.hasOwnProperty.call(accountConfig, "botToken"),
  );

  if (accountConfig && accountHasBotToken) {
    const token = options?.allowUnresolvedSecretRef
      ? normalizeSecretInputString(accountConfig.botToken)
      : normalizeResolvedSecretInputString({
          value: accountConfig.botToken,
          path: `channels.zalo.accounts.${resolvedAccountId}.botToken`,
        });
    if (token) {
      return { token, source: "config" };
    }
    const fileToken = readTokenFromFile(accountConfig.tokenFile);
    if (fileToken) {
      return { token: fileToken, source: "configFile" };
    }
  }

  if (!accountHasBotToken) {
    const fileToken = readTokenFromFile(accountConfig?.tokenFile);
    if (fileToken) {
      return { token: fileToken, source: "configFile" };
    }
  }

  if (!accountHasBotToken) {
    const token = options?.allowUnresolvedSecretRef
      ? normalizeSecretInputString(baseConfig?.botToken)
      : normalizeResolvedSecretInputString({
          value: baseConfig?.botToken,
          path: "channels.zalo.botToken",
        });
    if (token) {
      return { token, source: "config" };
    }
    const fileToken = readTokenFromFile(baseConfig?.tokenFile);
    if (fileToken) {
      return { token: fileToken, source: "configFile" };
    }
  }

  if (isDefaultAccount) {
    const envToken = process.env.ZALO_BOT_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, source: "env" };
    }
  }

  return { token: "", source: "none" };
}
