import fs from "node:fs";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { resolveDefaultSecretProviderAlias } from "openclaw/plugin-sdk/provider-auth";
import { coerceSecretRef, normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { getPlatformAdapter } from "../engine/adapter/index.js";
import {
  DEFAULT_ACCOUNT_ID as ENGINE_DEFAULT_ACCOUNT_ID,
  applyAccountConfig,
  listAccountIds,
  resolveAccountBase,
  resolveDefaultAccountId,
} from "../engine/config/resolve.js";
import type { ResolvedQQBotAccount, QQBotAccountConfig } from "../types.js";

export const DEFAULT_ACCOUNT_ID = ENGINE_DEFAULT_ACCOUNT_ID;

interface QQBotChannelConfig extends QQBotAccountConfig {
  accounts?: Record<string, QQBotAccountConfig>;
  defaultAccount?: string;
}

function assertNotLegacySecretRefMarker(value: unknown, path: string): void {
  const normalized = normalizeSecretInputString(value);
  if (!normalized || !/^secretref(?:-env)?:/i.test(normalized)) {
    return;
  }
  throw new Error(
    `${path}: legacy SecretRef marker strings are not valid QQ Bot clientSecret values; use a structured SecretRef object instead.`,
  );
}

function resolveEnvSecretRefValue(params: {
  cfg: OpenClawConfig;
  value: unknown;
  env?: NodeJS.ProcessEnv;
}): string | undefined {
  const ref = coerceSecretRef(params.value, params.cfg.secrets?.defaults);
  if (!ref || ref.source !== "env") {
    return undefined;
  }

  const providerConfig = params.cfg.secrets?.providers?.[ref.provider];
  if (providerConfig) {
    if (providerConfig.source !== "env") {
      throw new Error(
        `Secret provider "${ref.provider}" has source "${providerConfig.source}" but ref requests "env".`,
      );
    }
    if (providerConfig.allowlist && !providerConfig.allowlist.includes(ref.id)) {
      throw new Error(
        `Environment variable "${ref.id}" is not allowlisted in secrets.providers.${ref.provider}.allowlist.`,
      );
    }
  } else if (ref.provider !== resolveDefaultSecretProviderAlias(params.cfg, "env")) {
    throw new Error(
      `Secret provider "${ref.provider}" is not configured (ref: env:${ref.provider}:${ref.id}).`,
    );
  }

  return normalizeSecretInputString((params.env ?? process.env)[ref.id]);
}

function resolveQQBotClientSecretInput(params: {
  cfg: OpenClawConfig;
  value: unknown;
  path: string;
}): string | undefined {
  assertNotLegacySecretRefMarker(params.value, params.path);

  const envSecret = resolveEnvSecretRefValue({
    cfg: params.cfg,
    value: params.value,
  });
  if (envSecret) {
    return envSecret;
  }

  return getPlatformAdapter().resolveSecretInputString({
    value: params.value,
    path: params.path,
  });
}

/** List all configured QQBot account IDs. */
export function listQQBotAccountIds(cfg: OpenClawConfig): string[] {
  return listAccountIds(cfg as unknown as Record<string, unknown>);
}

/** Resolve the default QQBot account ID. */
export function resolveDefaultQQBotAccountId(cfg: OpenClawConfig): string {
  return resolveDefaultAccountId(cfg as unknown as Record<string, unknown>);
}

/** Resolve QQBot account config for runtime or setup flows. */
export function resolveQQBotAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
  opts?: { allowUnresolvedSecretRef?: boolean },
): ResolvedQQBotAccount {
  const raw = cfg as unknown as Record<string, unknown>;
  const base = resolveAccountBase(raw, accountId);

  const qqbot = cfg.channels?.qqbot as QQBotChannelConfig | undefined;
  /**
   * Legacy top-level account uses `channels.qqbot` as the base, but per-account
   * fields (allowFrom, streaming, …) often live under `accounts.default`.
   * Merge that slice so runtime sees `config.streaming` etc.
   */
  const accountConfig: QQBotAccountConfig =
    base.accountId === DEFAULT_ACCOUNT_ID
      ? {
          ...qqbot,
          ...qqbot?.accounts?.[DEFAULT_ACCOUNT_ID],
        }
      : (qqbot?.accounts?.[base.accountId] ?? {});

  let clientSecret = "";
  let secretSource: "config" | "file" | "env" | "none" = "none";

  const clientSecretPath =
    base.accountId === DEFAULT_ACCOUNT_ID
      ? "channels.qqbot.clientSecret"
      : `channels.qqbot.accounts.${base.accountId}.clientSecret`;

  const adapter = getPlatformAdapter();
  if (adapter.hasConfiguredSecret(accountConfig.clientSecret)) {
    clientSecret = opts?.allowUnresolvedSecretRef
      ? (adapter.normalizeSecretInputString(accountConfig.clientSecret) ?? "")
      : (resolveQQBotClientSecretInput({
          cfg,
          value: accountConfig.clientSecret,
          path: clientSecretPath,
        }) ?? "");
    secretSource = "config";
  } else if (accountConfig.clientSecretFile) {
    try {
      clientSecret = fs.readFileSync(accountConfig.clientSecretFile, "utf8").trim();
      secretSource = "file";
    } catch {
      secretSource = "none";
    }
  } else if (process.env.QQBOT_CLIENT_SECRET && base.accountId === DEFAULT_ACCOUNT_ID) {
    clientSecret = process.env.QQBOT_CLIENT_SECRET;
    secretSource = "env";
  }

  return {
    accountId: base.accountId,
    name: accountConfig.name,
    enabled: base.enabled,
    appId: base.appId,
    clientSecret,
    secretSource,
    systemPrompt: base.systemPrompt,
    markdownSupport: base.markdownSupport,
    config: accountConfig,
  };
}

/** Apply account config updates back into the OpenClaw config object. */
export function applyQQBotAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
  input: {
    appId?: string;
    clientSecret?: string;
    clientSecretFile?: string;
    name?: string;
  },
): OpenClawConfig {
  return applyAccountConfig(
    cfg as unknown as Record<string, unknown>,
    accountId,
    input,
  ) as OpenClawConfig;
}
