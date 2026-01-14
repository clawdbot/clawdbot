import fs from "node:fs";

import type { ClawdbotConfig } from "../config/config.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../routing/session-key.js";

export type TelegramTokenSource = "env" | "tokenFile" | "config" | "none";

export type TelegramTokenResolution = {
  token: string;
  source: TelegramTokenSource;
};

type ResolveTelegramTokenOpts = {
  envToken?: string | null;
  accountId?: string | null;
  logMissingFile?: (message: string) => void;
};

export function resolveTelegramToken(
  cfg?: ClawdbotConfig,
  opts: ResolveTelegramTokenOpts = {},
): TelegramTokenResolution {
  const accountId = normalizeAccountId(opts.accountId);
  const telegramCfg = cfg?.channels?.telegram;
  const accountCfg =
    accountId !== DEFAULT_ACCOUNT_ID
      ? telegramCfg?.accounts?.[accountId]
      : telegramCfg?.accounts?.[DEFAULT_ACCOUNT_ID];
  const accountTokenFile = accountCfg?.tokenFile?.trim();
  if (accountTokenFile) {
    if (!fs.existsSync(accountTokenFile)) {
      opts.logMissingFile?.(
        `channels.telegram.accounts.${accountId}.tokenFile not found: ${accountTokenFile}`,
      );
      return { token: "", source: "none" };
    }
    try {
      const token = fs.readFileSync(accountTokenFile, "utf-8").trim();
      if (token) {
        return { token, source: "tokenFile" };
      }
    } catch (err) {
      opts.logMissingFile?.(
        `channels.telegram.accounts.${accountId}.tokenFile read failed: ${String(
          err,
        )}`,
      );
      return { token: "", source: "none" };
    }
    return { token: "", source: "none" };
  }

  const accountToken = accountCfg?.botToken?.trim();
  if (accountToken) {
    return { token: accountToken, source: "config" };
  }

  const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
  const envToken = allowEnv
    ? (opts.envToken ?? process.env.TELEGRAM_BOT_TOKEN)?.trim()
    : "";
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  const tokenFile = telegramCfg?.tokenFile?.trim();
  if (tokenFile && allowEnv) {
    if (!fs.existsSync(tokenFile)) {
      opts.logMissingFile?.(
        `channels.telegram.tokenFile not found: ${tokenFile}`,
      );
      return { token: "", source: "none" };
    }
    try {
      const token = fs.readFileSync(tokenFile, "utf-8").trim();
      if (token) {
        return { token, source: "tokenFile" };
      }
    } catch (err) {
      opts.logMissingFile?.(
        `channels.telegram.tokenFile read failed: ${String(err)}`,
      );
      return { token: "", source: "none" };
    }
  }

  const configToken = telegramCfg?.botToken?.trim();
  if (configToken && allowEnv) {
    return { token: configToken, source: "config" };
  }

  return { token: "", source: "none" };
}
