import type { ClawdbotConfig } from "../../config/config.js";
import type { ProviderId } from "../../providers/plugins/types.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../routing/session-key.js";

type ChatProvider = ProviderId;

function providerHasAccounts(cfg: ClawdbotConfig, provider: ChatProvider) {
  if (provider === "whatsapp") return true;
  const base = (cfg as Record<string, unknown>)[provider] as
    | { accounts?: Record<string, unknown> }
    | undefined;
  return Boolean(base?.accounts && Object.keys(base.accounts).length > 0);
}

function shouldStoreNameInAccounts(
  cfg: ClawdbotConfig,
  provider: ChatProvider,
  accountId: string,
): boolean {
  if (provider === "whatsapp") return true;
  if (accountId !== DEFAULT_ACCOUNT_ID) return true;
  return providerHasAccounts(cfg, provider);
}

function migrateBaseNameToDefaultAccount(
  cfg: ClawdbotConfig,
  provider: ChatProvider,
): ClawdbotConfig {
  if (provider === "whatsapp") return cfg;
  const base = (cfg as Record<string, unknown>)[provider] as
    | { name?: string; accounts?: Record<string, Record<string, unknown>> }
    | undefined;
  const baseName = base?.name?.trim();
  if (!baseName) return cfg;
  const accounts: Record<string, Record<string, unknown>> = {
    ...base?.accounts,
  };
  const defaultAccount = accounts[DEFAULT_ACCOUNT_ID] ?? {};
  if (!defaultAccount.name) {
    accounts[DEFAULT_ACCOUNT_ID] = { ...defaultAccount, name: baseName };
  }
  const { name: _ignored, ...rest } = base ?? {};
  return {
    ...cfg,
    [provider]: {
      ...rest,
      accounts,
    },
  } as ClawdbotConfig;
}

export function applyAccountName(params: {
  cfg: ClawdbotConfig;
  provider: ChatProvider;
  accountId: string;
  name?: string;
}): ClawdbotConfig {
  const trimmed = params.name?.trim();
  if (!trimmed) return params.cfg;
  const accountId = normalizeAccountId(params.accountId);
  if (params.provider === "whatsapp") {
    return {
      ...params.cfg,
      whatsapp: {
        ...params.cfg.whatsapp,
        accounts: {
          ...params.cfg.whatsapp?.accounts,
          [accountId]: {
            ...params.cfg.whatsapp?.accounts?.[accountId],
            name: trimmed,
          },
        },
      },
    };
  }
  const key = params.provider;
  const useAccounts = shouldStoreNameInAccounts(params.cfg, key, accountId);
  if (!useAccounts && accountId === DEFAULT_ACCOUNT_ID) {
    const baseConfig = (params.cfg as Record<string, unknown>)[key];
    const safeBase =
      typeof baseConfig === "object" && baseConfig
        ? (baseConfig as Record<string, unknown>)
        : {};
    return {
      ...params.cfg,
      [key]: {
        ...safeBase,
        name: trimmed,
      },
    } as ClawdbotConfig;
  }
  const base = (params.cfg as Record<string, unknown>)[key] as
    | { name?: string; accounts?: Record<string, Record<string, unknown>> }
    | undefined;
  const baseAccounts: Record<
    string,
    Record<string, unknown>
  > = base?.accounts ?? {};
  const existingAccount = baseAccounts[accountId] ?? {};
  const baseWithoutName =
    accountId === DEFAULT_ACCOUNT_ID
      ? (({ name: _ignored, ...rest }) => rest)(base ?? {})
      : (base ?? {});
  return {
    ...params.cfg,
    [key]: {
      ...baseWithoutName,
      accounts: {
        ...baseAccounts,
        [accountId]: {
          ...existingAccount,
          name: trimmed,
        },
      },
    },
  } as ClawdbotConfig;
}

export function applyProviderAccountConfig(params: {
  cfg: ClawdbotConfig;
  provider: ChatProvider;
  accountId: string;
  name?: string;
  token?: string;
  tokenFile?: string;
  botToken?: string;
  appToken?: string;
  signalNumber?: string;
  cliPath?: string;
  dbPath?: string;
  service?: "imessage" | "sms" | "auto";
  region?: string;
  authDir?: string;
  httpUrl?: string;
  httpHost?: string;
  httpPort?: string;
  useEnv?: boolean;
}): ClawdbotConfig {
  const accountId = normalizeAccountId(params.accountId);
  const name = params.name?.trim() || undefined;
  const namedConfig = applyAccountName({
    cfg: params.cfg,
    provider: params.provider,
    accountId,
    name,
  });
  const next =
    accountId !== DEFAULT_ACCOUNT_ID
      ? migrateBaseNameToDefaultAccount(namedConfig, params.provider)
      : namedConfig;

  if (params.provider === "whatsapp") {
    const entry = {
      ...next.whatsapp?.accounts?.[accountId],
      ...(params.authDir ? { authDir: params.authDir } : {}),
      enabled: true,
    };
    return {
      ...next,
      whatsapp: {
        ...next.whatsapp,
        accounts: {
          ...next.whatsapp?.accounts,
          [accountId]: entry,
        },
      },
    };
  }

  if (params.provider === "telegram") {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        telegram: {
          ...next.telegram,
          enabled: true,
          ...(params.useEnv
            ? {}
            : params.tokenFile
              ? { tokenFile: params.tokenFile }
              : params.token
                ? { botToken: params.token }
                : {}),
        },
      };
    }
    return {
      ...next,
      telegram: {
        ...next.telegram,
        enabled: true,
        accounts: {
          ...next.telegram?.accounts,
          [accountId]: {
            ...next.telegram?.accounts?.[accountId],
            enabled: true,
            ...(params.tokenFile
              ? { tokenFile: params.tokenFile }
              : params.token
                ? { botToken: params.token }
                : {}),
          },
        },
      },
    };
  }

  if (params.provider === "discord") {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        discord: {
          ...next.discord,
          enabled: true,
          ...(params.useEnv ? {} : params.token ? { token: params.token } : {}),
        },
      };
    }
    return {
      ...next,
      discord: {
        ...next.discord,
        enabled: true,
        accounts: {
          ...next.discord?.accounts,
          [accountId]: {
            ...next.discord?.accounts?.[accountId],
            enabled: true,
            ...(params.token ? { token: params.token } : {}),
          },
        },
      },
    };
  }

  if (params.provider === "slack") {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        slack: {
          ...next.slack,
          enabled: true,
          ...(params.useEnv
            ? {}
            : {
                ...(params.botToken ? { botToken: params.botToken } : {}),
                ...(params.appToken ? { appToken: params.appToken } : {}),
              }),
        },
      };
    }
    return {
      ...next,
      slack: {
        ...next.slack,
        enabled: true,
        accounts: {
          ...next.slack?.accounts,
          [accountId]: {
            ...next.slack?.accounts?.[accountId],
            enabled: true,
            ...(params.botToken ? { botToken: params.botToken } : {}),
            ...(params.appToken ? { appToken: params.appToken } : {}),
          },
        },
      },
    };
  }

  if (params.provider === "signal") {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        signal: {
          ...next.signal,
          enabled: true,
          ...(params.signalNumber ? { account: params.signalNumber } : {}),
          ...(params.cliPath ? { cliPath: params.cliPath } : {}),
          ...(params.httpUrl ? { httpUrl: params.httpUrl } : {}),
          ...(params.httpHost ? { httpHost: params.httpHost } : {}),
          ...(params.httpPort ? { httpPort: Number(params.httpPort) } : {}),
        },
      };
    }
    return {
      ...next,
      signal: {
        ...next.signal,
        enabled: true,
        accounts: {
          ...next.signal?.accounts,
          [accountId]: {
            ...next.signal?.accounts?.[accountId],
            enabled: true,
            ...(params.signalNumber ? { account: params.signalNumber } : {}),
            ...(params.cliPath ? { cliPath: params.cliPath } : {}),
            ...(params.httpUrl ? { httpUrl: params.httpUrl } : {}),
            ...(params.httpHost ? { httpHost: params.httpHost } : {}),
            ...(params.httpPort ? { httpPort: Number(params.httpPort) } : {}),
          },
        },
      },
    };
  }

  if (params.provider === "imessage") {
    if (accountId === DEFAULT_ACCOUNT_ID) {
      return {
        ...next,
        imessage: {
          ...next.imessage,
          enabled: true,
          ...(params.cliPath ? { cliPath: params.cliPath } : {}),
          ...(params.dbPath ? { dbPath: params.dbPath } : {}),
          ...(params.service ? { service: params.service } : {}),
          ...(params.region ? { region: params.region } : {}),
        },
      };
    }
    return {
      ...next,
      imessage: {
        ...next.imessage,
        enabled: true,
        accounts: {
          ...next.imessage?.accounts,
          [accountId]: {
            ...next.imessage?.accounts?.[accountId],
            enabled: true,
            ...(params.cliPath ? { cliPath: params.cliPath } : {}),
            ...(params.dbPath ? { dbPath: params.dbPath } : {}),
            ...(params.service ? { service: params.service } : {}),
            ...(params.region ? { region: params.region } : {}),
          },
        },
      },
    };
  }

  if (params.provider === "msteams") {
    return {
      ...next,
      msteams: {
        ...next.msteams,
        enabled: true,
      },
    };
  }

  return next;
}
