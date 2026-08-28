// Zalo plugin module implements token behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { BaseTokenResolution } from "openclaw/plugin-sdk/channel-contract";
import { resolveAccountEntry } from "openclaw/plugin-sdk/routing";
import { tryReadSecretFileSync } from "openclaw/plugin-sdk/secret-file-runtime";
import { resolveSecretInputString, type SecretInputStringResolutionMode } from "./secret-input.js";
import type { ResolvedZaloAccount, ZaloConfig, ZaloTokenStatus } from "./types.js";

type ZaloTokenResolution = BaseTokenResolution & {
  source: "env" | "config" | "configFile" | "none";
  status: ZaloTokenStatus;
  credentialDiagnostics?: ResolvedZaloAccount["credentialDiagnostics"];
};

function readTokenFromFile(tokenFile: string, configPath: string): ZaloTokenResolution {
  const result = tryReadSecretFileSync(
    tokenFile,
    "Zalo token file",
    { rejectSymlink: true },
    {
      configPath,
    },
  );
  return result.status === "available"
    ? { token: result.value, source: "configFile", status: "available" }
    : {
        token: "",
        source: "configFile",
        status: "configured_unavailable",
        credentialDiagnostics: [result.diagnostic],
      };
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
  }

  if (accountConfig?.tokenFile?.trim()) {
    return readTokenFromFile(
      accountConfig.tokenFile,
      `channels.zalo.accounts.${resolvedAccountId}.tokenFile`,
    );
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
    if (baseConfig?.tokenFile?.trim()) {
      return readTokenFromFile(baseConfig.tokenFile, "channels.zalo.tokenFile");
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
