// Zalo plugin module implements token behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/core";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { resolveSecretInputString, type SecretInputStringResolutionMode } from "./secret-input.js";
import type { ZaloConfig, ZaloTokenStatus } from "./types.js";

type ZaloTokenResolution = BaseTokenResolution & {
  source: "env" | "config" | "configFile" | "none";
  status: ZaloTokenStatus;
};

function readTokenFromFile(tokenFile: string | undefined): string {
  return tryReadSecretFileSync(tokenFile, "Zalo token file", { rejectSymlink: true }) ?? "";
}

export function resolveZaloToken(
  config: ZaloConfig | undefined,
  accountId?: string | null,
  options?: { mode?: SecretInputStringResolutionMode },
): ZaloTokenResolution {
  const resolvedAccountId = normalizeAccountId(accountId ?? config?.defaultAccount);
  const isDefaultAccount = resolvedAccountId === DEFAULT_ACCOUNT_ID;
  const baseConfig = config;
  const accountConfig = resolveAccountEntry(
    baseConfig?.accounts as Record<string, ZaloConfig> | undefined,
    normalizeAccountId(resolvedAccountId),
  );
  const accountHasBotToken = Boolean(accountConfig && Object.hasOwn(accountConfig, "botToken"));

  if (accountConfig && accountHasBotToken) {
    const token = resolveSecretInputString({
      value: accountConfig.botToken,
      path: `channels.zalo.accounts.${resolvedAccountId}.botToken`,
      mode: options?.mode,
    });
    if (token.status === "available") {
      return { token: token.value, source: "config", status: "available" };
    }
    if (token.status === "configured_unavailable") {
      return { token: "", source: "config", status: "configured_unavailable" };
    }
    const fileToken = readTokenFromFile(accountConfig.tokenFile);
    if (fileToken) {
      return { token: fileToken, source: "configFile", status: "available" };
    }
  }

  if (!accountHasBotToken) {
    const fileToken = readTokenFromFile(accountConfig?.tokenFile);
    if (fileToken) {
      return { token: fileToken, source: "configFile", status: "available" };
    }
  }

  if (!accountHasBotToken) {
    const token = resolveSecretInputString({
      value: baseConfig?.botToken,
      path: "channels.zalo.botToken",
      mode: options?.mode,
    });
    if (token.status === "available") {
      return { token: token.value, source: "config", status: "available" };
    }
    if (token.status === "configured_unavailable") {
      return { token: "", source: "config", status: "configured_unavailable" };
    }
    const fileToken = readTokenFromFile(baseConfig?.tokenFile);
    if (fileToken) {
      return { token: fileToken, source: "configFile", status: "available" };
    }
  }

  if (isDefaultAccount) {
    const envToken = process.env.ZALO_BOT_TOKEN?.trim();
    if (envToken) {
      return { token: envToken, source: "env", status: "available" };
    }
  }

  return { token: "", source: "none", status: "missing" };
}
