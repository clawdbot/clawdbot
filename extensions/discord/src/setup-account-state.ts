// Discord plugin module implements setup account state behavior.
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { inspectDiscordAccountTokenState } from "./account-token-inspect.js";
import {
  resolveDefaultDiscordAccountId,
  mergeDiscordAccountConfig,
  resolveDiscordAccountConfig,
} from "./accounts.js";
import type { DiscordAccountConfig } from "./runtime-api.js";
import { resolveDiscordToken } from "./token.js";

type InspectedDiscordSetupAccount = {
  accountId: string;
  enabled: boolean;
  token: string;
  tokenSource: "env" | "config" | "none";
  tokenStatus: "available" | "configured_unavailable" | "missing";
  configured: boolean;
  config: DiscordAccountConfig;
};

export function resolveDefaultDiscordSetupAccountId(cfg: OpenClawConfig): string {
  return resolveDefaultDiscordAccountId(cfg);
}

export function resolveDiscordSetupAccountConfig(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): { accountId: string; config: DiscordAccountConfig } {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordSetupAccountId(params.cfg),
  );
  return {
    accountId,
    config: mergeDiscordAccountConfig(params.cfg, accountId),
  };
}

export function inspectDiscordSetupAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): InspectedDiscordSetupAccount {
  const { accountId, config } = resolveDiscordSetupAccountConfig(params);
  const enabled = params.cfg.channels?.discord?.enabled !== false && config.enabled !== false;
  const accountConfig = resolveDiscordAccountConfig(params.cfg, accountId);
  const hasAccountToken = Boolean(
    accountConfig && Object.hasOwn(accountConfig as Record<string, unknown>, "token"),
  );
  return inspectDiscordAccountTokenState({
    base: {
      accountId,
      enabled,
    },
    config,
    accountToken: accountConfig?.token,
    hasAccountToken,
    channelToken: params.cfg.channels?.discord?.token,
    // Known divergence: setup keeps the runtime-aware resolver for its final branch.
    resolveFallbackToken: () => resolveDiscordToken(params.cfg, { accountId }),
  });
}
