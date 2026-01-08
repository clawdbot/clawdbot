import chalk from "chalk";

import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  loadAuthProfileStore,
} from "../agents/auth-profiles.js";
import type { ClawdbotConfig } from "../config/config.js";
import { readConfigFileSnapshot, writeConfigFile } from "../config/config.js";
import {
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "../discord/accounts.js";
import { callGateway } from "../gateway/call.js";
import {
  listIMessageAccountIds,
  resolveIMessageAccount,
} from "../imessage/accounts.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { defaultRuntime } from "../runtime.js";
import {
  listSignalAccountIds,
  resolveSignalAccount,
} from "../signal/accounts.js";
import { listSlackAccountIds, resolveSlackAccount } from "../slack/accounts.js";
import {
  listTelegramAccountIds,
  resolveTelegramAccount,
} from "../telegram/accounts.js";
import { formatTerminalLink } from "../utils.js";
import {
  listWhatsAppAccountIds,
  resolveWhatsAppAuthDir,
} from "../web/accounts.js";
import { webAuthExists } from "../web/session.js";
import { createClackPrompter } from "../wizard/clack-prompter.js";
import { setupProviders } from "./onboard-providers.js";
import type { ProviderChoice } from "./onboard-types.js";

const DOCS_BASE = "https://docs.clawd.bot";

const CHAT_PROVIDERS = [
  "whatsapp",
  "telegram",
  "discord",
  "slack",
  "signal",
  "imessage",
] as const;

type ChatProvider = (typeof CHAT_PROVIDERS)[number];

type ProvidersListOptions = {
  json?: boolean;
};

type ProvidersStatusOptions = {
  json?: boolean;
  probe?: boolean;
  timeout?: string;
};

export type ProvidersAddOptions = {
  provider?: string;
  account?: string;
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
};

export type ProvidersRemoveOptions = {
  provider?: string;
  account?: string;
  delete?: boolean;
};

function docsLink(path: string, label?: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  const url = `${DOCS_BASE}${cleanPath}`;
  return formatTerminalLink(label ?? url, url, { fallback: url });
}

function normalizeChatProvider(raw?: string): ChatProvider | null {
  const trimmed = (raw ?? "").trim().toLowerCase();
  if (!trimmed) return null;
  const normalized = trimmed === "imsg" ? "imessage" : trimmed;
  return CHAT_PROVIDERS.includes(normalized as ChatProvider)
    ? (normalized as ChatProvider)
    : null;
}

async function requireValidConfig(
  runtime: RuntimeEnv,
): Promise<ClawdbotConfig | null> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    const issues =
      snapshot.issues.length > 0
        ? snapshot.issues
            .map((issue) => `- ${issue.path}: ${issue.message}`)
            .join("\n")
        : "Unknown validation issue.";
    runtime.error(`Config invalid:\n${issues}`);
    runtime.error("Fix the config or run clawdbot doctor.");
    runtime.exit(1);
    return null;
  }
  return snapshot.config;
}

function formatAccountLabel(params: { accountId: string; name?: string }) {
  const base = params.accountId || DEFAULT_ACCOUNT_ID;
  if (params.name?.trim()) return `${base} (${params.name.trim()})`;
  return base;
}

function formatEnabled(value: boolean | undefined): string {
  return value === false ? "disabled" : "enabled";
}

function formatConfigured(value: boolean): string {
  return value ? "configured" : "not configured";
}

function formatTokenSource(source?: string): string {
  if (!source || source === "none") return "token=none";
  return `token=${source}`;
}

function applyAccountName(params: {
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
  if (accountId === DEFAULT_ACCOUNT_ID) {
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
    | { accounts?: Record<string, Record<string, unknown>> }
    | undefined;
  const baseAccounts: Record<
    string,
    Record<string, unknown>
  > = base?.accounts ?? {};
  const existingAccount = baseAccounts[accountId] ?? {};
  return {
    ...params.cfg,
    [key]: {
      ...base,
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

function applyProviderAccountConfig(params: {
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
  const next = applyAccountName({
    cfg: params.cfg,
    provider: params.provider,
    accountId,
    name,
  });

  if (params.provider === "whatsapp") {
    const entry = {
      ...next.whatsapp?.accounts?.[accountId],
      ...(params.authDir ? { authDir: params.authDir } : {}),
      enabled: true,
      ...(name ? { name } : {}),
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
          ...(name ? { name } : {}),
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
            ...(name ? { name } : {}),
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
          ...(name ? { name } : {}),
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
            ...(name ? { name } : {}),
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
          ...(name ? { name } : {}),
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
            ...(name ? { name } : {}),
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
          ...(name ? { name } : {}),
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
            ...(name ? { name } : {}),
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
          ...(name ? { name } : {}),
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
            ...(name ? { name } : {}),
          },
        },
      },
    };
  }

  return next;
}

export async function providersListCommand(
  opts: ProvidersListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const whatsappAccounts = listWhatsAppAccountIds(cfg);
  const telegramAccounts = listTelegramAccountIds(cfg);
  const discordAccounts = listDiscordAccountIds(cfg);
  const slackAccounts = listSlackAccountIds(cfg);
  const signalAccounts = listSignalAccountIds(cfg);
  const imessageAccounts = listIMessageAccountIds(cfg);

  const authStore = loadAuthProfileStore();
  const authProfiles = Object.entries(authStore.profiles).map(
    ([profileId, profile]) => ({
      id: profileId,
      provider: profile.provider,
      type: profile.type,
      isExternal:
        profileId === CLAUDE_CLI_PROFILE_ID ||
        profileId === CODEX_CLI_PROFILE_ID,
    }),
  );

  if (opts.json) {
    const payload = {
      chat: {
        whatsapp: whatsappAccounts,
        telegram: telegramAccounts,
        discord: discordAccounts,
        slack: slackAccounts,
        signal: signalAccounts,
        imessage: imessageAccounts,
      },
      auth: authProfiles,
    };
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }

  const lines: string[] = [];
  lines.push("Chat providers:");

  for (const accountId of whatsappAccounts) {
    const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
    const linked = await webAuthExists(authDir);
    const name = cfg.whatsapp?.accounts?.[accountId]?.name;
    lines.push(
      `- WhatsApp ${formatAccountLabel({
        accountId,
        name,
      })}: ${linked ? "linked" : "not linked"}, ${formatEnabled(
        cfg.whatsapp?.accounts?.[accountId]?.enabled ??
          cfg.web?.enabled ??
          true,
      )}`,
    );
  }

  for (const accountId of telegramAccounts) {
    const account = resolveTelegramAccount({ cfg, accountId });
    lines.push(
      `- Telegram ${formatAccountLabel({
        accountId,
        name: account.name,
      })}: ${formatConfigured(Boolean(account.token))}, ${formatTokenSource(
        account.tokenSource,
      )}, ${formatEnabled(account.enabled)}`,
    );
  }

  for (const accountId of discordAccounts) {
    const account = resolveDiscordAccount({ cfg, accountId });
    lines.push(
      `- Discord ${formatAccountLabel({
        accountId,
        name: account.name,
      })}: ${formatConfigured(Boolean(account.token))}, ${formatTokenSource(
        account.tokenSource,
      )}, ${formatEnabled(account.enabled)}`,
    );
  }

  for (const accountId of slackAccounts) {
    const account = resolveSlackAccount({ cfg, accountId });
    const configured = Boolean(account.botToken && account.appToken);
    lines.push(
      `- Slack ${formatAccountLabel({
        accountId,
        name: account.name,
      })}: ${formatConfigured(configured)}, bot=${account.botTokenSource}, app=${account.appTokenSource}, ${formatEnabled(
        account.enabled,
      )}`,
    );
  }

  for (const accountId of signalAccounts) {
    const account = resolveSignalAccount({ cfg, accountId });
    lines.push(
      `- Signal ${formatAccountLabel({
        accountId,
        name: account.name,
      })}: ${formatConfigured(account.configured)}, base=${account.baseUrl}, ${formatEnabled(
        account.enabled,
      )}`,
    );
  }

  for (const accountId of imessageAccounts) {
    const account = resolveIMessageAccount({ cfg, accountId });
    lines.push(
      `- iMessage ${formatAccountLabel({
        accountId,
        name: account.name,
      })}: ${formatEnabled(account.enabled)}`,
    );
  }

  lines.push("");
  lines.push("Auth providers (OAuth + API keys):");
  if (authProfiles.length === 0) {
    lines.push("- none");
  } else {
    for (const profile of authProfiles) {
      const external = profile.isExternal ? " (synced)" : "";
      lines.push(`- ${profile.id} (${profile.type}${external})`);
    }
  }

  lines.push("");
  lines.push(
    `Docs: ${docsLink("/gateway/configuration", "gateway/configuration")}`,
  );

  runtime.log(lines.join("\n"));
}

export async function providersStatusCommand(
  opts: ProvidersStatusOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const timeoutMs = Number(opts.timeout ?? 10_000);
  try {
    const payload = await callGateway({
      method: "providers.status",
      params: { probe: Boolean(opts.probe), timeoutMs },
      timeoutMs,
    });
    if (opts.json) {
      runtime.log(JSON.stringify(payload, null, 2));
      return;
    }
    const data = payload as Record<string, unknown>;
    const lines: string[] = [];
    lines.push(chalk.green("Gateway reachable."));
    const accountLines = (
      label: string,
      accounts: Array<Record<string, unknown>>,
    ) =>
      accounts.map((account) => {
        const bits: string[] = [];
        if (typeof account.enabled === "boolean") {
          bits.push(account.enabled ? "enabled" : "disabled");
        }
        if (typeof account.configured === "boolean") {
          bits.push(account.configured ? "configured" : "not configured");
        }
        if (typeof account.linked === "boolean") {
          bits.push(account.linked ? "linked" : "not linked");
        }
        if (typeof account.running === "boolean") {
          bits.push(account.running ? "running" : "stopped");
        }
        const probe = account.probe as { ok?: boolean } | undefined;
        if (probe && typeof probe.ok === "boolean") {
          bits.push(probe.ok ? "works" : "probe failed");
        }
        const accountId =
          typeof account.accountId === "string" ? account.accountId : "default";
        const labelText = `${label} ${accountId}`;
        return `- ${labelText}: ${bits.join(", ")}`;
      });

    if (Array.isArray(data.whatsappAccounts)) {
      lines.push(
        ...accountLines(
          "WhatsApp",
          data.whatsappAccounts as Array<Record<string, unknown>>,
        ),
      );
    }
    if (Array.isArray(data.telegramAccounts)) {
      lines.push(
        ...accountLines(
          "Telegram",
          data.telegramAccounts as Array<Record<string, unknown>>,
        ),
      );
    }
    if (Array.isArray(data.discordAccounts)) {
      lines.push(
        ...accountLines(
          "Discord",
          data.discordAccounts as Array<Record<string, unknown>>,
        ),
      );
    }
    if (Array.isArray(data.slackAccounts)) {
      lines.push(
        ...accountLines(
          "Slack",
          data.slackAccounts as Array<Record<string, unknown>>,
        ),
      );
    }
    if (Array.isArray(data.signalAccounts)) {
      lines.push(
        ...accountLines(
          "Signal",
          data.signalAccounts as Array<Record<string, unknown>>,
        ),
      );
    }
    if (Array.isArray(data.imessageAccounts)) {
      lines.push(
        ...accountLines(
          "iMessage",
          data.imessageAccounts as Array<Record<string, unknown>>,
        ),
      );
    }

    runtime.log(lines.join("\n"));
  } catch (err) {
    runtime.error(`Gateway not reachable: ${String(err)}`);
    runtime.exit(1);
  }
}

export async function providersAddCommand(
  opts: ProvidersAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const useWizard = params?.hasFlags === false;
  if (useWizard) {
    const prompter = createClackPrompter();
    let selection: ProviderChoice[] = [];
    const accountIds: Partial<Record<ProviderChoice, string>> = {};
    await prompter.intro("Provider setup");
    let nextConfig = await setupProviders(cfg, runtime, prompter, {
      allowDisable: false,
      allowSignalInstall: true,
      promptAccountIds: true,
      onSelection: (value) => {
        selection = value;
      },
      onAccountId: (provider, accountId) => {
        accountIds[provider] = accountId;
      },
    });
    if (selection.length === 0) {
      await prompter.outro("No providers selected.");
      return;
    }

    const wantsNames = await prompter.confirm({
      message: "Add display names for these accounts? (optional)",
      initialValue: false,
    });
    if (wantsNames) {
      for (const provider of selection) {
        const accountId = accountIds[provider] ?? DEFAULT_ACCOUNT_ID;
        const existingName =
          provider === "whatsapp"
            ? nextConfig.whatsapp?.accounts?.[accountId]?.name
            : provider === "telegram"
              ? (nextConfig.telegram?.accounts?.[accountId]?.name ??
                nextConfig.telegram?.name)
              : provider === "discord"
                ? (nextConfig.discord?.accounts?.[accountId]?.name ??
                  nextConfig.discord?.name)
                : provider === "slack"
                  ? (nextConfig.slack?.accounts?.[accountId]?.name ??
                    nextConfig.slack?.name)
                  : provider === "signal"
                    ? (nextConfig.signal?.accounts?.[accountId]?.name ??
                      nextConfig.signal?.name)
                    : provider === "imessage"
                      ? (nextConfig.imessage?.accounts?.[accountId]?.name ??
                        nextConfig.imessage?.name)
                      : undefined;
        const name = await prompter.text({
          message: `${provider} account name (${accountId})`,
          initialValue: existingName,
        });
        if (name?.trim()) {
          nextConfig = applyAccountName({
            cfg: nextConfig,
            provider,
            accountId,
            name,
          });
        }
      }
    }

    await writeConfigFile(nextConfig);
    await prompter.outro("Providers updated.");
    return;
  }

  const provider = normalizeChatProvider(opts.provider);
  if (!provider) {
    runtime.error(`Unknown provider: ${String(opts.provider ?? "")}`);
    runtime.exit(1);
    return;
  }

  const accountId = normalizeAccountId(opts.account);
  const useEnv = opts.useEnv === true;

  if (provider === "telegram") {
    if (useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      runtime.error(
        "TELEGRAM_BOT_TOKEN can only be used for the default account.",
      );
      runtime.exit(1);
      return;
    }
    if (!useEnv && !opts.token && !opts.tokenFile) {
      runtime.error(
        "Telegram requires --token or --token-file (or --use-env).",
      );
      runtime.exit(1);
      return;
    }
  }
  if (provider === "discord") {
    if (useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      runtime.error(
        "DISCORD_BOT_TOKEN can only be used for the default account.",
      );
      runtime.exit(1);
      return;
    }
    if (!useEnv && !opts.token) {
      runtime.error("Discord requires --token (or --use-env).");
      runtime.exit(1);
      return;
    }
  }
  if (provider === "slack") {
    if (useEnv && accountId !== DEFAULT_ACCOUNT_ID) {
      runtime.error(
        "Slack env tokens can only be used for the default account.",
      );
      runtime.exit(1);
      return;
    }
    if (!useEnv && (!opts.botToken || !opts.appToken)) {
      runtime.error(
        "Slack requires --bot-token and --app-token (or --use-env).",
      );
      runtime.exit(1);
      return;
    }
  }
  if (provider === "signal") {
    if (
      !opts.signalNumber &&
      !opts.httpUrl &&
      !opts.httpHost &&
      !opts.httpPort &&
      !opts.cliPath
    ) {
      runtime.error(
        "Signal requires --signal-number or --http-url/--http-host/--http-port/--cli-path.",
      );
      runtime.exit(1);
      return;
    }
  }

  const nextConfig = applyProviderAccountConfig({
    cfg,
    provider,
    accountId,
    name: opts.name,
    token: opts.token,
    tokenFile: opts.tokenFile,
    botToken: opts.botToken,
    appToken: opts.appToken,
    signalNumber: opts.signalNumber,
    cliPath: opts.cliPath,
    dbPath: opts.dbPath,
    service: opts.service,
    region: opts.region,
    authDir: opts.authDir,
    httpUrl: opts.httpUrl,
    httpHost: opts.httpHost,
    httpPort: opts.httpPort,
    useEnv,
  });

  await writeConfigFile(nextConfig);
  runtime.log(`Added ${provider} account "${accountId}".`);
}

export async function providersRemoveCommand(
  opts: ProvidersRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const useWizard = params?.hasFlags === false;
  const prompter = useWizard ? createClackPrompter() : null;
  let provider = normalizeChatProvider(opts.provider);
  let accountId = normalizeAccountId(opts.account);
  const deleteConfig = Boolean(opts.delete);

  if (useWizard && prompter) {
    await prompter.intro("Remove provider account");
    provider = (await prompter.select({
      message: "Provider",
      options: CHAT_PROVIDERS.map((value) => ({
        value,
        label: value,
      })),
    })) as ChatProvider;

    const listAccounts =
      provider === "whatsapp"
        ? listWhatsAppAccountIds
        : provider === "telegram"
          ? listTelegramAccountIds
          : provider === "discord"
            ? listDiscordAccountIds
            : provider === "slack"
              ? listSlackAccountIds
              : provider === "signal"
                ? listSignalAccountIds
                : listIMessageAccountIds;
    accountId = await (async () => {
      const ids = listAccounts(cfg);
      const choice = (await prompter.select({
        message: "Account",
        options: ids.map((id) => ({
          value: id,
          label: id === DEFAULT_ACCOUNT_ID ? "default (primary)" : id,
        })),
        initialValue: ids[0] ?? DEFAULT_ACCOUNT_ID,
      })) as string;
      return normalizeAccountId(choice);
    })();

    const wantsDisable = await prompter.confirm({
      message: `Disable ${provider} account "${accountId}"? (keeps config)`,
      initialValue: true,
    });
    if (!wantsDisable) {
      await prompter.outro("Cancelled.");
      return;
    }
  } else {
    if (!provider) {
      runtime.error("Provider is required. Use --provider <name>.");
      runtime.exit(1);
      return;
    }
    if (!deleteConfig) {
      const confirm = createClackPrompter();
      const ok = await confirm.confirm({
        message: `Disable ${provider} account "${accountId}"? (keeps config)`,
        initialValue: true,
      });
      if (!ok) {
        return;
      }
    }
  }

  let next = { ...cfg };
  const accountKey = accountId || DEFAULT_ACCOUNT_ID;

  const setAccountEnabled = (key: ChatProvider, enabled: boolean) => {
    if (key === "whatsapp") {
      next = {
        ...next,
        whatsapp: {
          ...next.whatsapp,
          accounts: {
            ...next.whatsapp?.accounts,
            [accountKey]: {
              ...next.whatsapp?.accounts?.[accountKey],
              enabled,
            },
          },
        },
      };
      return;
    }
    const base = (next as Record<string, unknown>)[key] as
      | {
          accounts?: Record<string, Record<string, unknown>>;
          enabled?: boolean;
        }
      | undefined;
    const baseAccounts: Record<
      string,
      Record<string, unknown>
    > = base?.accounts ?? {};
    const existingAccount = baseAccounts[accountKey] ?? {};
    if (accountKey === DEFAULT_ACCOUNT_ID && !base?.accounts) {
      next = {
        ...next,
        [key]: {
          ...base,
          enabled,
        },
      } as ClawdbotConfig;
      return;
    }
    next = {
      ...next,
      [key]: {
        ...base,
        accounts: {
          ...baseAccounts,
          [accountKey]: {
            ...existingAccount,
            enabled,
          },
        },
      },
    } as ClawdbotConfig;
  };

  const deleteAccount = (key: ChatProvider) => {
    if (key === "whatsapp") {
      const accounts = { ...next.whatsapp?.accounts };
      delete accounts[accountKey];
      next = {
        ...next,
        whatsapp: {
          ...next.whatsapp,
          accounts: Object.keys(accounts).length ? accounts : undefined,
        },
      };
      return;
    }
    const base = (next as Record<string, unknown>)[key] as
      | {
          accounts?: Record<string, Record<string, unknown>>;
          enabled?: boolean;
        }
      | undefined;
    if (accountKey !== DEFAULT_ACCOUNT_ID) {
      const accounts = { ...base?.accounts };
      delete accounts[accountKey];
      next = {
        ...next,
        [key]: {
          ...base,
          accounts: Object.keys(accounts).length ? accounts : undefined,
        },
      } as ClawdbotConfig;
      return;
    }
    if (base?.accounts && Object.keys(base.accounts).length > 0) {
      const accounts = { ...base.accounts };
      delete accounts[accountKey];
      next = {
        ...next,
        [key]: {
          ...base,
          accounts: Object.keys(accounts).length ? accounts : undefined,
          ...(key === "telegram"
            ? { botToken: undefined, tokenFile: undefined, name: undefined }
            : key === "discord"
              ? { token: undefined, name: undefined }
              : key === "slack"
                ? { botToken: undefined, appToken: undefined, name: undefined }
                : key === "signal"
                  ? {
                      account: undefined,
                      httpUrl: undefined,
                      httpHost: undefined,
                      httpPort: undefined,
                      cliPath: undefined,
                      name: undefined,
                    }
                  : key === "imessage"
                    ? {
                        cliPath: undefined,
                        dbPath: undefined,
                        service: undefined,
                        region: undefined,
                        name: undefined,
                      }
                    : {}),
        },
      } as ClawdbotConfig;
      return;
    }
    // No accounts map: remove entire provider section.
    const clone = { ...next } as Record<string, unknown>;
    delete clone[key];
    next = clone as ClawdbotConfig;
  };

  if (deleteConfig) {
    deleteAccount(provider);
  } else {
    setAccountEnabled(provider, false);
  }

  await writeConfigFile(next);
  if (useWizard && prompter) {
    await prompter.outro(
      deleteConfig
        ? `Deleted ${provider} account "${accountKey}".`
        : `Disabled ${provider} account "${accountKey}".`,
    );
  } else {
    runtime.log(
      deleteConfig
        ? `Deleted ${provider} account "${accountKey}".`
        : `Disabled ${provider} account "${accountKey}".`,
    );
  }
}
