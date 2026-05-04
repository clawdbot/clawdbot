import type { OpenClawConfig } from "openclaw/plugin-sdk/config-types";
import { requireRuntimeConfig } from "openclaw/plugin-sdk/plugin-config-runtime";
import type { RetryConfig, RetryRunner } from "openclaw/plugin-sdk/retry-runtime";
import { normalizeAccountId } from "openclaw/plugin-sdk/routing";
import type { RuntimeEnv } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import {
  mergeDiscordAccountConfig,
  resolveDiscordAccount,
  type ResolvedDiscordAccount,
} from "./accounts.js";
import { RequestClient } from "./internal/discord.js";
import { resolveDiscordProxyFetchForAccount } from "./proxy-fetch.js";
import { createDiscordRequestClient } from "./proxy-request-client.js";
import { createDiscordRetryRunner } from "./retry.js";
import type { DiscordRuntimeAccountContext } from "./send.types.js";
import { normalizeDiscordToken } from "./token.js";

export type DiscordClientOpts = {
  cfg: OpenClawConfig;
  token?: string;
  accountId?: string;
  rest?: RequestClient;
  retry?: RetryConfig;
  verbose?: boolean;
};

export function createDiscordRuntimeAccountContext(params: {
  cfg: OpenClawConfig;
  accountId: string;
}): DiscordRuntimeAccountContext {
  return {
    cfg: params.cfg,
    accountId: normalizeAccountId(params.accountId),
  };
}

export function resolveDiscordClientAccountContext(
  opts: Pick<DiscordClientOpts, "cfg" | "accountId">,
  runtime?: Pick<RuntimeEnv, "error">,
) {
  const resolvedCfg = requireRuntimeConfig(opts.cfg, "Discord client");
  const account = resolveAccountWithoutToken({
    cfg: resolvedCfg,
    accountId: opts.accountId,
  });
  return {
    cfg: resolvedCfg,
    account,
    proxyFetch: resolveDiscordProxyFetchForAccount(account, resolvedCfg, runtime),
  };
}

function resolveToken(params: {
  account: ResolvedDiscordAccount;
  accountId: string;
  fallbackToken?: string;
}) {
  const fallback = normalizeDiscordToken(params.fallbackToken, "channels.discord.token");
  if (!fallback) {
    if (params.account.tokenStatus === "configured_unavailable") {
      throw new Error(
        `Discord bot token configured for account "${params.accountId}" is unavailable; resolve SecretRefs against the active runtime snapshot before using this account.`,
      );
    }
    throw new Error(
      `Discord bot token missing for account "${params.accountId}" (set discord.accounts.${params.accountId}.token or DISCORD_BOT_TOKEN for default).`,
    );
  }
  return fallback;
}

function resolveRest(
  token: string,
  account: ResolvedDiscordAccount,
  cfg: OpenClawConfig,
  rest?: RequestClient,
  proxyFetch?: typeof fetch,
) {
  if (rest) {
    return rest;
  }
  const resolvedProxyFetch = proxyFetch ?? resolveDiscordProxyFetchForAccount(account, cfg);
  return createDiscordRequestClient(
    token,
    resolvedProxyFetch ? { fetch: resolvedProxyFetch } : undefined,
  );
}

function resolveAccountWithoutToken(params: {
  cfg: OpenClawConfig;
  accountId?: string;
}): ResolvedDiscordAccount {
  const accountId = normalizeAccountId(params.accountId);
  const merged = mergeDiscordAccountConfig(params.cfg, accountId);
  const baseEnabled = params.cfg.channels?.discord?.enabled !== false;
  const accountEnabled = merged.enabled !== false;
  return {
    accountId,
    enabled: baseEnabled && accountEnabled,
    name: normalizeOptionalString(merged.name),
    token: "",
    tokenSource: "none",
    tokenStatus: "missing",
    config: merged,
  };
}

export function createDiscordRestClient(opts: DiscordClientOpts) {
  const explicitToken = normalizeDiscordToken(opts.token, "channels.discord.token");
  const proxyContext = resolveDiscordClientAccountContext(opts);
  const resolvedCfg = proxyContext.cfg;
  const account = explicitToken
    ? proxyContext.account
    : resolveDiscordAccount({ cfg: resolvedCfg, accountId: opts.accountId });
  const token =
    explicitToken ??
    resolveToken({
      account,
      accountId: account.accountId,
      fallbackToken: account.token,
    });
  const rest = resolveRest(token, account, resolvedCfg, opts.rest, proxyContext.proxyFetch);
  return { token, rest, account };
}

export function createDiscordClient(opts: DiscordClientOpts): {
  token: string;
  rest: RequestClient;
  request: RetryRunner;
} {
  const { token, rest, account } = createDiscordRestClient(opts);
  const request = createDiscordRetryRunner({
    retry: opts.retry,
    configRetry: account.config.retry,
    verbose: opts.verbose,
  });
  return { token, rest, request };
}

export function resolveDiscordRest(opts: DiscordClientOpts) {
  return createDiscordRestClient(opts).rest;
}
