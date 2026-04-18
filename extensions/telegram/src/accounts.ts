import util from "node:util";
import {
  createAccountActionGate,
  normalizeAccountId,
  normalizeOptionalAccountId,
  resolveAccountWithDefaultFallback,
  type OpenClawConfig,
} from "openclaw/plugin-sdk/account-core";
import type {
  TelegramAccountConfig,
  TelegramActionConfig,
} from "openclaw/plugin-sdk/config-runtime";
import { formatSetExplicitDefaultInstruction } from "openclaw/plugin-sdk/routing";
import { createSubsystemLogger, isTruthyEnvValue } from "openclaw/plugin-sdk/runtime-env";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import { mergeTelegramAccountConfig, resolveTelegramAccountConfig } from "./account-config.js";
import {
  listTelegramAccountIds as listSelectedTelegramAccountIds,
  resolveDefaultTelegramAccountSelection,
} from "./account-selection.js";
import type { TelegramTransport } from "./fetch.js";
import { resolveTelegramToken } from "./token.js";

export { mergeTelegramAccountConfig, resolveTelegramAccountConfig } from "./account-config.js";

let log: ReturnType<typeof createSubsystemLogger> | null = null;

function getLog() {
  if (!log) {
    log = createSubsystemLogger("telegram/accounts");
  }
  return log;
}

function formatDebugArg(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value instanceof Error) {
    return value.stack ?? value.message;
  }
  return util.inspect(value, { colors: false, depth: null, compact: true, breakLength: Infinity });
}

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_TELEGRAM_ACCOUNTS)) {
    const parts = args.map((arg) => formatDebugArg(arg));
    getLog().warn(parts.join(" ").trim());
  }
};

export type ResolvedTelegramAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  token: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: TelegramAccountConfig;
};

export type TelegramMediaRuntimeOptions = {
  token: string;
  transport?: TelegramTransport;
  apiRoot?: string;
  trustedLocalFileRoots?: readonly string[];
  dangerouslyAllowPrivateNetwork?: boolean;
};

export function listTelegramAccountIds(cfg: OpenClawConfig): string[] {
  const ids = listSelectedTelegramAccountIds(cfg);
  debugAccounts("listTelegramAccountIds", ids);
  return ids;
}

let emittedMissingDefaultWarn = false;

/** @internal Reset the once-per-process warning flag. Exported for tests only. */
export function resetMissingDefaultWarnFlag(): void {
  emittedMissingDefaultWarn = false;
}

export function resolveDefaultTelegramAccountId(cfg: OpenClawConfig): string {
  const selection = resolveDefaultTelegramAccountSelection(cfg);
  if (selection.shouldWarnMissingDefault && !emittedMissingDefaultWarn) {
    emittedMissingDefaultWarn = true;
    getLog().warn(
      `channels.telegram: accounts.default is missing; falling back to "${selection.accountId}". ` +
        `${formatSetExplicitDefaultInstruction("telegram")} to avoid routing surprises in multi-account setups.`,
    );
  }
  return selection.accountId;
}

export function createTelegramActionGate(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean {
  const accountId = normalizeAccountId(
    params.accountId ?? resolveDefaultTelegramAccountId(params.cfg),
  );
  return createAccountActionGate({
    baseActions: params.cfg.channels?.telegram?.actions,
    accountActions: resolveTelegramAccountConfig(params.cfg, accountId)?.actions,
  });
}

export function resolveTelegramMediaRuntimeOptions(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
  token: string;
  transport?: TelegramTransport;
}): TelegramMediaRuntimeOptions {
  const normalizedAccountId = normalizeOptionalAccountId(params.accountId);
  const accountCfg = normalizedAccountId
    ? mergeTelegramAccountConfig(params.cfg, normalizedAccountId)
    : params.cfg.channels?.telegram;
  return {
    token: params.token,
    transport: params.transport,
    apiRoot: accountCfg?.apiRoot,
    trustedLocalFileRoots: accountCfg?.trustedLocalFileRoots,
    dangerouslyAllowPrivateNetwork: accountCfg?.network?.dangerouslyAllowPrivateNetwork,
  };
}

export type TelegramPollActionGateState = {
  sendMessageEnabled: boolean;
  pollEnabled: boolean;
  enabled: boolean;
};

export function resolveTelegramPollActionGateState(
  isActionEnabled: (key: keyof TelegramActionConfig, defaultValue?: boolean) => boolean,
): TelegramPollActionGateState {
  const sendMessageEnabled = isActionEnabled("sendMessage");
  const pollEnabled = isActionEnabled("poll");
  return {
    sendMessageEnabled,
    pollEnabled,
    enabled: sendMessageEnabled && pollEnabled,
  };
}

export function resolveTelegramAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedTelegramAccount {
  const baseEnabled = params.cfg.channels?.telegram?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeTelegramAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveTelegramToken(params.cfg, { accountId });
    debugAccounts("resolve", {
      accountId,
      enabled,
      tokenSource: tokenResolution.source,
    });
    return {
      accountId,
      enabled,
      name: normalizeOptionalString(merged.name),
      token: tokenResolution.token,
      tokenSource: tokenResolution.source,
      config: merged,
    } satisfies ResolvedTelegramAccount;
  };

  // If accountId is omitted, prefer a configured account token over failing on
  // the implicit "default" account. This keeps env-based setups working while
  // making config-only tokens work for things like heartbeats.
  return resolveAccountWithDefaultFallback({
    accountId: params.accountId,
    normalizeAccountId,
    resolvePrimary: resolve,
    hasCredential: (account) => account.tokenSource !== "none",
    resolveDefaultAccountId: () => resolveDefaultTelegramAccountId(params.cfg),
  });
}

export function listEnabledTelegramAccounts(cfg: OpenClawConfig): ResolvedTelegramAccount[] {
  return listTelegramAccountIds(cfg)
    .map((accountId) => resolveTelegramAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
