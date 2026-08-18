// Discord plugin module implements account inspect behavior.
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { normalizeSecretInputString } from "openclaw/plugin-sdk/secret-input";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { inspectDiscordAccountTokenState } from "./account-token-inspect.js";
import {
  mergeDiscordAccountConfig,
  resolveDefaultDiscordAccountId,
  resolveDiscordAccountConfig,
} from "./accounts.js";
import type { DiscordAccountConfig, OpenClawConfig } from "./runtime-api.js";
import type { DiscordCredentialStatus } from "./token.js";

export type InspectedDiscordAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "config" | "none";
  tokenStatus: DiscordCredentialStatus;
  configured: boolean;
  config: DiscordAccountConfig;
};

export function inspectDiscordAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  envToken?: string | null;
}): InspectedDiscordAccount {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultDiscordAccountId(params.cfg),
  );
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const enabled = params.cfg.channels?.discord?.enabled !== false && merged.enabled !== false;
  const accountConfig = resolveDiscordAccountConfig(params.cfg, accountId);
  const hasAccountToken = Boolean(
    accountConfig && Object.hasOwn(accountConfig as Record<string, unknown>, "token"),
  );
  return inspectDiscordAccountTokenState({
    base: {
      accountId,
      enabled,
      name: normalizeOptionalString(merged.name),
    },
    config: merged,
    accountToken: accountConfig?.token,
    hasAccountToken,
    channelToken: params.cfg.channels?.discord?.token,
    // Known divergence: doctor inspection must use its injected environment snapshot.
    resolveFallbackToken: () => {
      const allowEnv = accountId === DEFAULT_ACCOUNT_ID;
      const envToken = allowEnv
        ? normalizeSecretInputString(params.envToken ?? process.env.DISCORD_BOT_TOKEN)
        : undefined;
      return {
        token: envToken?.replace(/^Bot\s+/i, "") ?? "",
        source: envToken ? ("env" as const) : ("none" as const),
      };
    },
  });
}
