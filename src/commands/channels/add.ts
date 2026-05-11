import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { getBundledChannelSetupPlugin } from "../../channels/plugins/bundled.js";
import { parseOptionalDelimitedEntries } from "../../channels/plugins/helpers.js";
import { getLoadedChannelPlugin, normalizeChannelId } from "../../channels/plugins/index.js";
import { moveSingleAccountChannelSectionToDefaultAccount } from "../../channels/plugins/setup-helpers.js";
import type { ChannelSetupPlugin } from "../../channels/plugins/setup-wizard-types.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { ChannelId, ChannelSetupInput } from "../../channels/plugins/types.public.js";
import { formatCliCommand } from "../../cli/command-format.js";
import {
  formatUnknownChannelMessage,
  formatUnsupportedChannelActionMessage,
} from "../../cli/error-format.js";
import { commitConfigWithPendingPluginInstalls } from "../../cli/plugins-install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../cli/plugins-registry-refresh.js";
import type { OpenClawConfig } from "../../config/config.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../routing/session-key.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { createLazyImportLoader } from "../../shared/lazy-promise.js";
import { normalizeOptionalLowercaseString } from "../../shared/string-coerce.js";
import { createClackPrompter } from "../../wizard/clack-prompter.js";
import { WizardCancelledError } from "../../wizard/prompts.js";
import { applyAgentBindings, describeBinding } from "../agents.bindings.js";
import type { ChannelChoice } from "../onboard-types.js";
import { applyAccountName, applyChannelAccountConfig } from "./add-mutators.js";
import { channelLabel } from "./runtime-label.js";
import { requireValidConfigFileSnapshot, shouldUseWizard } from "./shared.js";

type ChannelSetupPluginInstallModule = typeof import("../channel-setup/plugin-install.js");
type OnboardChannelsModule = typeof import("../onboard-channels.js");

const channelSetupPluginInstallLoader = createLazyImportLoader<ChannelSetupPluginInstallModule>(
  () => import("../channel-setup/plugin-install.js"),
);
const onboardChannelsLoader = createLazyImportLoader<OnboardChannelsModule>(
  () => import("../onboard-channels.js"),
);

function loadChannelSetupPluginInstall(): Promise<ChannelSetupPluginInstallModule> {
  return channelSetupPluginInstallLoader.load();
}

function loadOnboardChannels(): Promise<OnboardChannelsModule> {
  return onboardChannelsLoader.load();
}

export type ChannelsAddOptions = {
  channel?: string;
  account?: string;
} & Record<string, unknown>;

const CHANNEL_ADD_CONTROL_OPTION_KEYS = new Set(["channel", "account"]);
const NEXTCLOUD_TALK_CLI_ALIASES = new Set(["nextcloud-talk", "nc-talk", "nc"]);

async function resolveCatalogChannelEntry(raw: string, cfg: OpenClawConfig | null) {
  const trimmed = normalizeOptionalLowercaseString(raw);
  if (!trimmed) {
    return undefined;
  }
  const entries = cfg
    ? await import("../channel-setup/trusted-catalog.js").then(
        ({ listTrustedChannelPluginCatalogEntries }) =>
          listTrustedChannelPluginCatalogEntries({
            cfg,
            workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
          }),
      )
    : await import("../../channels/plugins/catalog.js").then(
        ({ listChannelPluginCatalogEntries }) =>
          listChannelPluginCatalogEntries({ excludeWorkspace: true }),
      );
  return entries.find((entry) => {
    if (normalizeOptionalLowercaseString(entry.id) === trimmed) {
      return true;
    }
    return (entry.meta.aliases ?? []).some(
      (alias) => normalizeOptionalLowercaseString(alias) === trimmed,
    );
  });
}

function parseOptionalInt(value: unknown): number | undefined {
  if (typeof value === "number") {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    return Number.parseInt(value, 10);
  }
  return undefined;
}

function parseOptionalDelimitedInput(value: unknown): string[] | undefined {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string");
  }
  return parseOptionalDelimitedEntries(typeof value === "string" ? value : undefined);
}

function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function buildChannelSetupInput(opts: ChannelsAddOptions): ChannelSetupInput {
  const input: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(opts)) {
    if (CHANNEL_ADD_CONTROL_OPTION_KEYS.has(key) || value === undefined) {
      continue;
    }
    input[key] = value;
  }

  const rawChannel = readOptionalString(opts.channel)?.trim().toLowerCase();
  if (rawChannel && NEXTCLOUD_TALK_CLI_ALIASES.has(rawChannel)) {
    input.baseUrl ??= readOptionalString(input.url);
    input.secret ??= readOptionalString(input.token) ?? readOptionalString(input.password);
    input.secretFile ??= readOptionalString(input.tokenFile);
  }

  input.initialSyncLimit = parseOptionalInt(opts.initialSyncLimit);
  input.groupChannels = parseOptionalDelimitedInput(opts.groupChannels);
  input.dmAllowlist = parseOptionalDelimitedInput(opts.dmAllowlist);
  return input as ChannelSetupInput;
}

export async function channelsAddCommand(
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv = defaultRuntime,
  params?: { hasFlags?: boolean },
) {
  try {
    return await channelsAddCommandImpl(opts, runtime, params);
  } catch (err) {
    if (err instanceof WizardCancelledError) {
      runtime.exit(1);
      return;
    }
    throw err;
  }
}

async function channelsAddCommandImpl(
  opts: ChannelsAddOptions,
  runtime: RuntimeEnv,
  params?: { hasFlags?: boolean },
) {
  const configSnapshot = await requireValidConfigFileSnapshot(runtime);
  if (!configSnapshot) {
    return;
  }
  const cfg = (configSnapshot.sourceConfig ?? configSnapshot.config) as OpenClawConfig;
  const baseHash = configSnapshot.hash;
  let nextConfig = cfg;
  let pluginRegistrySourceChanged = false;

  const useWizard = shouldUseWizard(params);
  if (useWizard) {
    const [{ buildAgentSummaries }, onboardChannels] = await Promise.all([
      import("../agents.config.js"),
      loadOnboardChannels(),
    ]);
    const prompter = createClackPrompter();
    const postWriteHooks = onboardChannels.createChannelOnboardingPostWriteHookCollector();
    let selection: ChannelChoice[] = [];
    const accountIds: Partial<Record<ChannelChoice, string>> = {};
    const resolvedPlugins = new Map<ChannelChoice, ChannelSetupPlugin>();
    await prompter.intro("Channel setup");
    let nextConfig = await onboardChannels.setupChannels(cfg, runtime, prompter, {
      allowDisable: false,
      allowSignalInstall: true,
      onPostWriteHook: (hook) => {
        postWriteHooks.collect(hook);
      },
      promptAccountIds: true,
      deferStatusUntilSelection: true,
      skipStatusNote: true,
      onSelection: (value) => {
        selection = value;
      },
      onAccountId: (channel, accountId) => {
        accountIds[channel] = accountId;
      },
      onResolvedPlugin: (channel, plugin) => {
        resolvedPlugins.set(channel, plugin);
      },
    });
    if (selection.length === 0) {
      await prompter.outro("No channel changes made.");
      return;
    }

    const wantsNames = await prompter.confirm({
      message: "Name these channel accounts now? (optional)",
      initialValue: false,
    });
    if (wantsNames) {
      for (const channel of selection) {
        const accountId = accountIds[channel] ?? DEFAULT_ACCOUNT_ID;
        const plugin = resolvedPlugins.get(channel) ?? getLoadedChannelPlugin(channel);
        const account = plugin?.config.resolveAccount(nextConfig, accountId) as
          | { name?: string }
          | undefined;
        const snapshot = plugin?.config.describeAccount?.(account, nextConfig);
        const existingName = snapshot?.name ?? account?.name;
        const name = await prompter.text({
          message: `${channel} display name for account "${accountId}"`,
          initialValue: existingName,
        });
        if (name?.trim()) {
          nextConfig = applyAccountName({
            cfg: nextConfig,
            channel,
            accountId,
            name,
            plugin,
          });
        }
      }
    }

    const bindTargets = selection
      .map((channel) => ({
        channel,
        accountId: accountIds[channel]?.trim(),
      }))
      .filter(
        (
          value,
        ): value is {
          channel: ChannelChoice;
          accountId: string;
        } => Boolean(value.accountId),
      );
    if (bindTargets.length > 0) {
      const bindNow = await prompter.confirm({
        message: "Route these channel accounts to agents now?",
        initialValue: true,
      });
      if (bindNow) {
        const agentSummaries = buildAgentSummaries(nextConfig);
        const defaultAgentId = resolveDefaultAgentId(nextConfig);
        for (const target of bindTargets) {
          const targetAgentId = await prompter.select({
            message: `Send ${target.channel}/${target.accountId} messages to agent`,
            options: agentSummaries.map((agent) => ({
              value: agent.id,
              label: agent.isDefault ? `${agent.id} (default)` : agent.id,
            })),
            initialValue: defaultAgentId,
          });
          const bindingResult = applyAgentBindings(nextConfig, [
            {
              agentId: targetAgentId,
              match: { channel: target.channel, accountId: target.accountId },
            },
          ]);
          nextConfig = bindingResult.config;
          if (bindingResult.added.length > 0 || bindingResult.updated.length > 0) {
            await prompter.note(
              [
                ...bindingResult.added.map((binding) => `Added: ${describeBinding(binding)}`),
                ...bindingResult.updated.map((binding) => `Updated: ${describeBinding(binding)}`),
              ].join("\n"),
              "Routing bindings",
            );
          }
          if (bindingResult.conflicts.length > 0) {
            await prompter.note(
              [
                "Skipped bindings already claimed by another agent:",
                ...bindingResult.conflicts.map(
                  (conflict) =>
                    `- ${describeBinding(conflict.binding)} (agent=${conflict.existingAgentId})`,
                ),
              ].join("\n"),
              "Routing bindings",
            );
          }
        }
      }
    }

    const committed = await commitConfigWithPendingPluginInstalls({
      nextConfig,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    const writtenConfig = committed.config;
    if (committed.movedInstallRecords) {
      await refreshPluginRegistryAfterConfigMutation({
        config: writtenConfig,
        reason: "source-changed",
        installRecords: committed.installRecords,
        logger: { warn: (message) => runtime.log(message) },
      });
    }
    await onboardChannels.runCollectedChannelOnboardingPostWriteHooks({
      hooks: postWriteHooks.drain(),
      cfg: writtenConfig,
      runtime,
    });
    await prompter.outro("Channels updated.");
    return;
  }

  const rawChannel = opts.channel ?? "";
  let channel = normalizeChannelId(rawChannel);
  let catalogEntry = channel ? undefined : await resolveCatalogChannelEntry(rawChannel, nextConfig);
  const resolveWorkspaceDir = () =>
    resolveAgentWorkspaceDir(nextConfig, resolveDefaultAgentId(nextConfig));
  // May load a scoped plugin when the channel is not already registered.
  const loadScopedPlugin = async (
    channelId: ChannelId,
    pluginId?: string,
  ): Promise<ChannelPlugin | undefined> => {
    const existing = getLoadedChannelPlugin(channelId);
    if (existing?.setup?.applyAccountConfig) {
      return existing;
    }
    const { loadChannelSetupPluginRegistrySnapshotForChannel } =
      await loadChannelSetupPluginInstall();
    const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg: nextConfig,
      runtime,
      channel: channelId,
      ...(pluginId ? { pluginId } : {}),
      workspaceDir: resolveWorkspaceDir(),
      forceSetupOnlyChannelPlugins: true,
    });
    return (
      snapshot.channelSetups.find((entry) => entry.plugin.id === channelId)?.plugin ??
      getBundledChannelSetupPlugin(channelId) ??
      snapshot.channels.find((entry) => entry.plugin.id === channelId)?.plugin ??
      existing
    );
  };

  if (!channel && catalogEntry) {
    const workspaceDir = resolveWorkspaceDir();
    const { isCatalogChannelInstalled } = await import("../channel-setup/discovery.js");
    if (
      !isCatalogChannelInstalled({
        cfg: nextConfig,
        entry: catalogEntry,
        workspaceDir,
      })
    ) {
      const { ensureChannelSetupPluginInstalled } = await loadChannelSetupPluginInstall();
      const prompter = createClackPrompter();
      const result = await ensureChannelSetupPluginInstalled({
        cfg: nextConfig,
        entry: catalogEntry,
        prompter,
        runtime,
        workspaceDir,
        promptInstall: false,
      });
      nextConfig = result.cfg;
      if (!result.installed) {
        return;
      }
      pluginRegistrySourceChanged = true;
      catalogEntry = {
        ...catalogEntry,
        ...(result.pluginId ? { pluginId: result.pluginId } : {}),
      };
    }
    channel = normalizeChannelId(catalogEntry.id) ?? (catalogEntry.id as ChannelId);
  }

  if (!channel) {
    const hint = catalogEntry
      ? `Plugin ${catalogEntry.meta.label} could not be loaded after install. Run openclaw doctor --fix, then retry openclaw channels add.`
      : formatUnknownChannelMessage({ channel: rawChannel });
    runtime.error(hint);
    runtime.exit(1);
    return;
  }

  const plugin = await loadScopedPlugin(channel, catalogEntry?.pluginId);
  if (!plugin?.setup?.applyAccountConfig) {
    runtime.error(
      `${formatUnsupportedChannelActionMessage({
        channel,
        action: "non-interactive add",
      })} Run ${formatCliCommand("openclaw channels add")} with no flags for guided setup.`,
    );
    runtime.exit(1);
    return;
  }
  const input = buildChannelSetupInput(opts);
  const accountId =
    plugin.setup.resolveAccountId?.({
      cfg: nextConfig,
      accountId: opts.account,
      input,
    }) ?? normalizeAccountId(opts.account);

  const validationError = plugin.setup.validateInput?.({
    cfg: nextConfig,
    accountId,
    input,
  });
  if (validationError) {
    runtime.error(validationError);
    runtime.exit(1);
    return;
  }

  const prevConfig = nextConfig;

  if (accountId !== DEFAULT_ACCOUNT_ID) {
    nextConfig = moveSingleAccountChannelSectionToDefaultAccount({
      cfg: nextConfig,
      channelKey: channel,
    });
  }

  nextConfig = applyChannelAccountConfig({
    cfg: nextConfig,
    channel,
    accountId,
    input,
    plugin,
  });
  await plugin.lifecycle?.onAccountConfigChanged?.({
    prevCfg: prevConfig,
    nextCfg: nextConfig,
    accountId,
    runtime,
  });

  const committed = await commitConfigWithPendingPluginInstalls({
    nextConfig,
    ...(baseHash !== undefined ? { baseHash } : {}),
  });
  const writtenConfig = committed.config;
  if (committed.movedInstallRecords || pluginRegistrySourceChanged) {
    await refreshPluginRegistryAfterConfigMutation({
      config: writtenConfig,
      reason: "source-changed",
      ...(committed.movedInstallRecords ? { installRecords: committed.installRecords } : {}),
      logger: { warn: (message) => runtime.log(message) },
    });
  }
  runtime.log(`Added ${plugin.meta.label ?? channelLabel(channel)} account "${accountId}".`);
  const afterAccountConfigWritten = plugin.setup?.afterAccountConfigWritten;
  if (afterAccountConfigWritten) {
    const { runCollectedChannelOnboardingPostWriteHooks } = await loadOnboardChannels();
    await runCollectedChannelOnboardingPostWriteHooks({
      hooks: [
        {
          channel,
          accountId,
          run: async ({ cfg: writtenCfg, runtime: hookRuntime }) =>
            await afterAccountConfigWritten({
              previousCfg: cfg,
              cfg: writtenCfg,
              accountId,
              input,
              runtime: hookRuntime,
            }),
        },
      ],
      cfg: writtenConfig,
      runtime,
    });
  }
}
