import { type ClawdbotConfig, writeConfigFile } from "../../config/config.js";
import {
  getProviderPlugin,
  listProviderPlugins,
  normalizeProviderId,
} from "../../providers/plugins/index.js";
import {
  DEFAULT_ACCOUNT_ID,
  normalizeAccountId,
} from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import {
  type ChatProvider,
  providerLabel,
  requireValidConfig,
  shouldUseWizard,
} from "./shared.js";

export type ProvidersRemoveOptions = {
  provider?: string;
  account?: string;
  delete?: boolean;
};

function listAccountIds(cfg: ClawdbotConfig, provider: ChatProvider): string[] {
  const plugin = getProviderPlugin(provider);
  if (!plugin) return [];
  return plugin.config.listAccountIds(cfg);
}

export async function providersRemoveCommand(
  opts: ProvidersRemoveOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;

  const useWizard = shouldUseWizard(params);
  const prompter = useWizard ? createClackPrompter() : null;
  let provider = normalizeProviderId(opts.provider);
  let accountId = normalizeAccountId(opts.account);
  const deleteConfig = Boolean(opts.delete);

  if (useWizard && prompter) {
    await prompter.intro("Remove provider account");
    provider = (await prompter.select({
      message: "Provider",
      options: listProviderPlugins().map((plugin) => ({
        value: plugin.id,
        label: plugin.meta.label,
      })),
    })) as ChatProvider;

    accountId = await (async () => {
      const ids = listAccountIds(cfg, provider);
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
      message: `Disable ${providerLabel(provider)} account "${accountId}"? (keeps config)`,
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
        message: `Disable ${providerLabel(provider)} account "${accountId}"? (keeps config)`,
        initialValue: true,
      });
      if (!ok) {
        return;
      }
    }
  }

  if (provider === "msteams") {
    accountId = DEFAULT_ACCOUNT_ID;
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
    if (key === "msteams") {
      next = {
        ...next,
        msteams: {
          ...next.msteams,
          enabled,
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
    if (key === "msteams") {
      const clone = { ...next } as Record<string, unknown>;
      delete clone.msteams;
      next = clone as ClawdbotConfig;
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
        ? `Deleted ${providerLabel(provider)} account "${accountKey}".`
        : `Disabled ${providerLabel(provider)} account "${accountKey}".`,
    );
  } else {
    runtime.log(
      deleteConfig
        ? `Deleted ${providerLabel(provider)} account "${accountKey}".`
        : `Disabled ${providerLabel(provider)} account "${accountKey}".`,
    );
  }
}
