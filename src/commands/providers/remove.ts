import { type ClawdbotConfig, writeConfigFile } from "../../config/config.js";
import { resolveProviderDefaultAccountId } from "../../providers/plugins/helpers.js";
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

  const plugin = getProviderPlugin(provider);
  if (!plugin) {
    runtime.error(`Unknown provider: ${provider}`);
    runtime.exit(1);
    return;
  }

  const resolvedAccountId =
    normalizeAccountId(accountId) ??
    resolveProviderDefaultAccountId({ plugin, cfg });
  const accountKey = resolvedAccountId || DEFAULT_ACCOUNT_ID;

  let next = { ...cfg };
  if (deleteConfig) {
    if (!plugin.config.deleteAccount) {
      runtime.error(`Provider ${provider} does not support delete.`);
      runtime.exit(1);
      return;
    }
    next = plugin.config.deleteAccount({
      cfg: next,
      accountId: resolvedAccountId,
    });
  } else {
    if (!plugin.config.setAccountEnabled) {
      runtime.error(`Provider ${provider} does not support disable.`);
      runtime.exit(1);
      return;
    }
    next = plugin.config.setAccountEnabled({
      cfg: next,
      accountId: resolvedAccountId,
      enabled: false,
    });
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
