import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { getBundledChannelSetupPlugin } from "../channels/plugins/bundled.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { listActiveChannelSetupPlugins } from "../channels/plugins/setup-registry.js";
import type {
  ChannelSetupPlugin,
  ChannelSetupWizardAdapter,
} from "../channels/plugins/setup-wizard-types.js";
import { formatCliCommand } from "../cli/command-format.js";
import {
  resolveChannelSetupEntries,
  shouldShowChannelInSetup,
} from "../commands/channel-setup/discovery.js";
import {
  ensureChannelSetupPluginInstalled,
  loadChannelSetupPluginRegistrySnapshotForChannel,
} from "../commands/channel-setup/plugin-install.js";
import { resolveChannelSetupWizardAdapterForPlugin } from "../commands/channel-setup/registry.js";
import {
  getTrustedChannelPluginCatalogEntry,
  listTrustedChannelPluginCatalogEntries,
} from "../commands/channel-setup/trusted-catalog.js";
import type {
  ChannelSetupConfiguredResult,
  ChannelSetupResult,
  ChannelSetupStatus,
  ChannelOnboardingPostWriteHook,
  SetupChannelsOptions,
} from "../commands/channel-setup/types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import { isChannelConfigured } from "../config/channel-configured.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveBundledPluginSources } from "../plugins/bundled-sources.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import {
  maybeConfigureDmPolicies,
  promptConfiguredAction,
  promptRemovalAccountId,
  formatAccountLabel,
} from "./channel-setup.prompts.js";
import {
  collectChannelStatus,
  findBundledSourceForCatalogChannel,
  noteChannelPrimer,
  resolveCatalogChannelSelectionHint,
  resolveChannelSelectionNoteLines,
  resolveChannelSetupSelectionContributions,
  resolveQuickstartDefault,
} from "./channel-setup.status.js";
export { noteChannelStatus } from "./channel-setup.status.js";

export function createChannelOnboardingPostWriteHookCollector() {
  const hooks = new Map<string, ChannelOnboardingPostWriteHook>();
  return {
    collect(hook: ChannelOnboardingPostWriteHook) {
      hooks.set(`${hook.channel}:${hook.accountId}`, hook);
    },
    drain(): ChannelOnboardingPostWriteHook[] {
      const next = [...hooks.values()];
      hooks.clear();
      return next;
    },
  };
}

export async function runCollectedChannelOnboardingPostWriteHooks(params: {
  hooks: ChannelOnboardingPostWriteHook[];
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
}): Promise<void> {
  for (const hook of params.hooks) {
    try {
      await hook.run({ cfg: params.cfg, runtime: params.runtime });
    } catch (err) {
      const message = formatErrorMessage(err);
      params.runtime.error(
        `Channel ${hook.channel} post-setup warning for "${hook.accountId}": ${message}`,
      );
    }
  }
}

export function createChannelOnboardingPostWriteHook(params: {
  accountId?: string;
  adapter?: Pick<ChannelSetupWizardAdapter, "afterConfigWritten">;
  channel: ChannelChoice;
  previousCfg: OpenClawConfig;
}): ChannelOnboardingPostWriteHook | undefined {
  if (!params.accountId || !params.adapter?.afterConfigWritten) {
    return undefined;
  }
  return {
    channel: params.channel,
    accountId: params.accountId,
    run: async ({ cfg, runtime }) =>
      await params.adapter?.afterConfigWritten?.({
        previousCfg: params.previousCfg,
        cfg,
        accountId: params.accountId!,
        runtime,
      }),
  };
}

// Channel-specific prompts moved into setup flow adapters.

export async function setupChannels(
  cfg: OpenClawConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options?: SetupChannelsOptions,
): Promise<OpenClawConfig> {
  let next = cfg;
  const deferStatusUntilSelection = options?.deferStatusUntilSelection === true;
  const forceAllowFromChannels = new Set(options?.forceAllowFromChannels ?? []);
  const accountOverrides: Partial<Record<ChannelChoice, string>> = {
    ...options?.accountIds,
  };
  const scopedPluginsById = new Map<ChannelChoice, ChannelSetupPlugin>();
  const resolveWorkspaceDir = () => resolveAgentWorkspaceDir(next, resolveDefaultAgentId(next));
  const rememberScopedPlugin = (plugin: ChannelSetupPlugin) => {
    const channel = plugin.id;
    scopedPluginsById.set(channel, plugin);
    options?.onResolvedPlugin?.(channel, plugin);
  };
  const activePluginsById = new Map<ChannelChoice, ChannelSetupPlugin>();
  const rememberActivePlugin = (plugin: ChannelSetupPlugin) => {
    activePluginsById.set(plugin.id, plugin);
    return plugin;
  };
  const getVisibleChannelPlugin = (channel: ChannelChoice): ChannelSetupPlugin | undefined =>
    scopedPluginsById.get(channel) ?? activePluginsById.get(channel);
  const listVisibleInstalledPlugins = (): ChannelSetupPlugin[] => {
    const merged = new Map<string, ChannelSetupPlugin>();
    const registryPlugins = listActiveChannelSetupPlugins().map(rememberActivePlugin);
    for (const plugin of registryPlugins) {
      if (shouldShowChannelInSetup(plugin.meta)) {
        merged.set(plugin.id, plugin);
      }
    }
    for (const plugin of scopedPluginsById.values()) {
      if (shouldShowChannelInSetup(plugin.meta)) {
        merged.set(plugin.id, plugin);
      }
    }
    return Array.from(merged.values());
  };
  const resolveVisibleChannelEntries = () =>
    resolveChannelSetupEntries({
      cfg: next,
      installedPlugins: listVisibleInstalledPlugins(),
      workspaceDir: resolveWorkspaceDir(),
    });
  const loadScopedChannelPlugin = async (
    channel: ChannelChoice,
    pluginId?: string,
    setup?: {
      forceReload?: boolean;
      forceSetupOnlyChannelPlugins?: boolean;
    },
  ): Promise<ChannelSetupPlugin | undefined> => {
    const existing = getVisibleChannelPlugin(channel);
    if (existing && setup?.forceReload !== true) {
      return existing;
    }
    const snapshot = loadChannelSetupPluginRegistrySnapshotForChannel({
      cfg: next,
      runtime,
      channel,
      ...(pluginId ? { pluginId } : {}),
      workspaceDir: resolveWorkspaceDir(),
      forceSetupOnlyChannelPlugins: setup?.forceSetupOnlyChannelPlugins ?? true,
    });
    const plugin =
      snapshot.channelSetups.find((entry) => entry.plugin.id === channel)?.plugin ??
      snapshot.channels.find((entry) => entry.plugin.id === channel)?.plugin;
    if (plugin) {
      rememberScopedPlugin(plugin);
      return plugin;
    }
    const bundledPlugin = getBundledChannelSetupPlugin(channel);
    if (bundledPlugin) {
      rememberScopedPlugin(bundledPlugin);
      return bundledPlugin;
    }
    return undefined;
  };
  const getVisibleSetupFlowAdapter = (channel: ChannelChoice) => {
    const scopedPlugin = scopedPluginsById.get(channel);
    if (scopedPlugin) {
      return resolveChannelSetupWizardAdapterForPlugin(scopedPlugin);
    }
    return resolveChannelSetupWizardAdapterForPlugin(getVisibleChannelPlugin(channel));
  };
  const preloadConfiguredExternalPlugins = async () => {
    // Keep setup memory bounded by snapshot-loading only configured external plugins.
    listVisibleInstalledPlugins();
    const workspaceDir = resolveWorkspaceDir();
    const preloadTasks: Promise<unknown>[] = [];
    // Security: keep trusted workspace overrides eligible during setup while
    // falling back from untrusted workspace shadows to the non-workspace entry.
    for (const entry of listTrustedChannelPluginCatalogEntries({ cfg: next, workspaceDir })) {
      const channel = entry.id as ChannelChoice;
      if (getVisibleChannelPlugin(channel)) {
        continue;
      }
      const explicitlyEnabled =
        next.plugins?.entries?.[entry.pluginId ?? channel]?.enabled === true;
      if (!explicitlyEnabled && !isChannelConfigured(next, channel)) {
        continue;
      }
      preloadTasks.push(loadScopedChannelPlugin(channel, entry.pluginId));
    }
    await Promise.all(preloadTasks);
  };
  if (!deferStatusUntilSelection) {
    await preloadConfiguredExternalPlugins();
  }

  const statusSummary = deferStatusUntilSelection
    ? { statusByChannel: new Map<ChannelChoice, ChannelSetupStatus>(), statusLines: [] }
    : await collectChannelStatus({
        cfg: next,
        options,
        accountOverrides,
        installedPlugins: listVisibleInstalledPlugins(),
        resolveAdapter: getVisibleSetupFlowAdapter,
      });
  const { statusByChannel, statusLines } = statusSummary;
  if (!options?.skipStatusNote && statusLines.length > 0) {
    await prompter.note(statusLines.join("\n"), "Channel status");
  }

  const shouldConfigure = options?.skipConfirm
    ? true
    : await prompter.confirm({
        message: "Set up a chat channel now?",
        initialValue: true,
      });
  if (!shouldConfigure) {
    return cfg;
  }

  const primerChannels = resolveVisibleChannelEntries().entries.map((entry) => ({
    id: entry.id,
    label: entry.meta.label,
    blurb: entry.meta.blurb,
  }));
  await noteChannelPrimer(prompter, primerChannels);

  const quickstartDefault =
    options?.initialSelection?.[0] ??
    (deferStatusUntilSelection ? undefined : resolveQuickstartDefault(statusByChannel));

  const shouldPromptAccountIds = options?.promptAccountIds === true;
  const accountIdsByChannel = new Map<ChannelChoice, string>();
  const recordAccount = (channel: ChannelChoice, accountId: string) => {
    options?.onAccountId?.(channel, accountId);
    const adapter = getVisibleSetupFlowAdapter(channel);
    adapter?.onAccountRecorded?.(accountId, options);
    accountIdsByChannel.set(channel, accountId);
  };

  const selection: ChannelChoice[] = [];
  const addSelection = (channel: ChannelChoice) => {
    if (!selection.includes(channel)) {
      selection.push(channel);
    }
  };

  const resolveConfigDisabledHint = (channel: ChannelChoice): string | undefined => {
    if (next.plugins?.enabled === false) {
      return "plugins disabled";
    }
    if (next.plugins?.entries?.[channel]?.enabled === false) {
      return "plugin disabled";
    }
    if (
      typeof (next.channels as Record<string, { enabled?: boolean }> | undefined)?.[channel]
        ?.enabled === "boolean"
    ) {
      return (next.channels as Record<string, { enabled?: boolean }>)[channel]?.enabled === false
        ? "disabled"
        : undefined;
    }
    return undefined;
  };

  const resolveDisabledHint = (channel: ChannelChoice): string | undefined => {
    const configDisabledHint = resolveConfigDisabledHint(channel);
    if (configDisabledHint || deferStatusUntilSelection) {
      return configDisabledHint;
    }
    const plugin = getVisibleChannelPlugin(channel);
    if (!plugin) {
      return undefined;
    }
    const accountId = resolveChannelDefaultAccountId({ plugin, cfg: next });
    const account = plugin.config.resolveAccount(next, accountId);
    let enabled: boolean | undefined;
    if (plugin.config.isEnabled) {
      enabled = plugin.config.isEnabled(account, next);
    } else if (typeof (account as { enabled?: boolean })?.enabled === "boolean") {
      enabled = (account as { enabled?: boolean }).enabled;
    }
    return enabled === false ? "disabled" : undefined;
  };

  const getChannelEntries = () => {
    const resolved = resolveVisibleChannelEntries();
    return {
      entries: resolved.entries,
      catalogById: resolved.installableCatalogById,
      installedCatalogById: resolved.installedCatalogById,
    };
  };

  // Decorates the runtime status map with synthetic `selectionHint` entries for
  // installable catalog channels (e.g. WeCom shipped via npm). In QuickStart we
  // run with `deferStatusUntilSelection`, which leaves `statusByChannel` empty
  // until the user picks a channel — without this overlay the selection menu
  // would render those options without any "download from <npm-spec>" hint.
  //
  // Bundled channels (Signal / Tlon / Twitch / Slack ...) reach this code path
  // too whenever their plugin is not yet enabled, because they share the same
  // "installable catalog" bucket. For those we must NOT show "download from
  // <npm-spec>" — the plugin already lives under `extensions/<id>` and the
  // hint would mislead users into thinking the plugin is missing.
  const buildStatusByChannelForSelection = (
    catalogById: ReturnType<typeof getChannelEntries>["catalogById"],
  ): Map<ChannelChoice, ChannelSetupStatus> => {
    const decorated = new Map(statusByChannel);
    if (catalogById.size === 0) {
      return decorated;
    }
    const bundledSources = resolveBundledPluginSources({
      workspaceDir: resolveWorkspaceDir(),
    });
    for (const [channel, entry] of catalogById) {
      if (decorated.has(channel)) {
        continue;
      }
      const bundledLocalPath =
        findBundledSourceForCatalogChannel({ bundled: bundledSources, entry })?.localPath ?? null;
      decorated.set(channel, {
        channel,
        configured: false,
        statusLines: [],
        selectionHint: resolveCatalogChannelSelectionHint(entry, { bundledLocalPath }),
      });
    }
    return decorated;
  };

  const refreshStatus = async (channel: ChannelChoice) => {
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (!adapter) {
      return;
    }
    const status = await adapter.getStatus({ cfg: next, options, accountOverrides });
    statusByChannel.set(channel, status);
  };

  const enableBundledPluginForSetup = async (channel: ChannelChoice): Promise<boolean> => {
    if (getVisibleChannelPlugin(channel)) {
      await refreshStatus(channel);
      return true;
    }
    const disabledHint = resolveConfigDisabledHint(channel);
    if (disabledHint) {
      await prompter.note(
        `${channel} cannot be configured while ${disabledHint}. Enable it, then run ${formatCliCommand(
          "openclaw channels add",
        )} again.`,
        "Channel setup",
      );
      return false;
    }
    const result = enablePluginInConfig(next, channel);
    next = result.config;
    if (!result.enabled) {
      await prompter.note(
        `Cannot enable ${channel}: ${result.reason ?? "plugin disabled"}. Run ${formatCliCommand(
          "openclaw plugins list",
        )} to inspect plugin state.`,
        "Channel setup",
      );
      return false;
    }
    const plugin = await loadScopedChannelPlugin(channel);
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (!plugin) {
      if (adapter) {
        await prompter.note(
          `${channel} plugin not available (continuing with setup). If the channel still doesn't work after setup, run \`${formatCliCommand(
            "openclaw plugins list",
          )}\` and \`${formatCliCommand("openclaw plugins enable " + channel)}\`, then restart the gateway.`,
          "Channel setup",
        );
        await refreshStatus(channel);
        return true;
      }
      await prompter.note(`${channel} plugin not available.`, "Channel setup");
      return false;
    }
    await refreshStatus(channel);
    return true;
  };

  const applySetupResult = async (channel: ChannelChoice, result: ChannelSetupResult) => {
    const previousCfg = next;
    next = result.cfg;
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (result.accountId) {
      recordAccount(channel, result.accountId);
      const postWriteHook = createChannelOnboardingPostWriteHook({
        accountId: result.accountId,
        adapter,
        channel,
        previousCfg,
      });
      if (postWriteHook) {
        options?.onPostWriteHook?.(postWriteHook);
      }
    }
    addSelection(channel);
    await refreshStatus(channel);
  };

  const applyCustomSetupResult = async (
    channel: ChannelChoice,
    result: ChannelSetupConfiguredResult,
  ) => {
    if (result === "skip") {
      return false;
    }
    await applySetupResult(channel, result);
    return true;
  };

  const configureChannel = async (channel: ChannelChoice) => {
    if (scopedPluginsById.has(channel)) {
      await loadScopedChannelPlugin(channel, undefined, {
        forceReload: true,
        forceSetupOnlyChannelPlugins: true,
      });
    }
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (!adapter) {
      await prompter.note(
        `${channel} does not have an interactive setup screen yet. Run ${formatCliCommand(
          `openclaw channels add --channel ${channel} --help`,
        )} for supported flags.`,
        "Channel setup",
      );
      return;
    }
    const result = await adapter.configure({
      cfg: next,
      runtime,
      prompter,
      options,
      accountOverrides,
      shouldPromptAccountIds,
      forceAllowFrom: forceAllowFromChannels.has(channel),
    });
    await applySetupResult(channel, result);
  };

  const handleConfiguredChannel = async (channel: ChannelChoice, label: string) => {
    const plugin = getVisibleChannelPlugin(channel);
    const adapter = getVisibleSetupFlowAdapter(channel);
    if (adapter?.configureWhenConfigured) {
      const custom = await adapter.configureWhenConfigured({
        cfg: next,
        runtime,
        prompter,
        options,
        accountOverrides,
        shouldPromptAccountIds,
        forceAllowFrom: forceAllowFromChannels.has(channel),
        configured: true,
        label,
      });
      if (!(await applyCustomSetupResult(channel, custom))) {
        return;
      }
      return;
    }
    const supportsDisable = Boolean(
      options?.allowDisable && (plugin?.config.setAccountEnabled || adapter?.disable),
    );
    const supportsDelete = Boolean(options?.allowDisable && plugin?.config.deleteAccount);
    const action = await promptConfiguredAction({
      prompter,
      label,
      supportsDisable,
      supportsDelete,
    });

    if (action === "skip") {
      return;
    }
    if (action === "update") {
      await configureChannel(channel);
      return;
    }
    if (!options?.allowDisable) {
      return;
    }

    if (action === "delete" && !supportsDelete) {
      await prompter.note(`${label} does not support deleting config entries.`, "Remove channel");
      return;
    }

    const shouldPromptAccount =
      action === "delete"
        ? Boolean(plugin?.config.deleteAccount)
        : Boolean(plugin?.config.setAccountEnabled);
    const accountId = shouldPromptAccount
      ? await promptRemovalAccountId({
          cfg: next,
          prompter,
          label,
          channel,
          plugin,
        })
      : DEFAULT_ACCOUNT_ID;
    const resolvedAccountId =
      normalizeAccountId(accountId) ??
      (plugin ? resolveChannelDefaultAccountId({ plugin, cfg: next }) : DEFAULT_ACCOUNT_ID);
    const accountLabel = formatAccountLabel(resolvedAccountId);

    if (action === "delete") {
      const confirmed = await prompter.confirm({
        message: `Delete ${label} account "${accountLabel}"?`,
        initialValue: false,
      });
      if (!confirmed) {
        return;
      }
      if (plugin?.config.deleteAccount) {
        next = plugin.config.deleteAccount({ cfg: next, accountId: resolvedAccountId });
      }
      await refreshStatus(channel);
      return;
    }

    if (plugin?.config.setAccountEnabled) {
      next = plugin.config.setAccountEnabled({
        cfg: next,
        accountId: resolvedAccountId,
        enabled: false,
      });
    } else if (adapter?.disable) {
      next = adapter.disable(next);
    }
    await refreshStatus(channel);
  };

  const handleChannelChoice = async (
    channel: ChannelChoice,
  ): Promise<"done" | "retry_selection"> => {
    const { catalogById, installedCatalogById } = getChannelEntries();
    const catalogEntry = catalogById.get(channel);
    const installedCatalogEntry = installedCatalogById.get(channel);
    const deferredDisabledHint = deferStatusUntilSelection
      ? resolveConfigDisabledHint(channel)
      : undefined;
    if (deferredDisabledHint) {
      await prompter.note(
        `${channel} cannot be configured while ${deferredDisabledHint}. Enable it before setup.`,
        "Channel setup",
      );
      return "done";
    }
    if (catalogEntry) {
      const workspaceDir = resolveWorkspaceDir();
      const result = await ensureChannelSetupPluginInstalled({
        cfg: next,
        entry: catalogEntry,
        prompter,
        runtime,
        workspaceDir,
        autoConfirmSingleSource: true,
      });
      next = result.cfg;
      if (!result.installed) {
        return "retry_selection";
      }
      await loadScopedChannelPlugin(channel, result.pluginId ?? catalogEntry.pluginId);
      await refreshStatus(channel);
    } else if (installedCatalogEntry) {
      let plugin = await loadScopedChannelPlugin(channel, installedCatalogEntry.pluginId);
      if (!plugin && installedCatalogEntry.install?.npmSpec) {
        // The channel is recorded in the user's config (e.g. a stale
        // `channels.<id>` entry left over from a previous install) but the
        // plugin runtime cannot be loaded from disk — typically because the
        // externalized npm package was uninstalled or pruned during an
        // upgrade. Rather than dead-ending with "plugin not available", fall
        // back to the catalog-driven install flow so onboard can recover by
        // reinstalling the official external plugin.
        //
        // Preserve the same disabled-config guard used by
        // `enableBundledPluginForSetup` so an operator-disabled channel
        // cannot be silently reinstalled/re-enabled through this path.
        const disabledHint = resolveConfigDisabledHint(channel);
        if (disabledHint) {
          await prompter.note(
            `${channel} cannot be configured while ${disabledHint}. Enable it before setup.`,
            "Channel setup",
          );
          return "done";
        }
        const workspaceDir = resolveWorkspaceDir();
        const result = await ensureChannelSetupPluginInstalled({
          cfg: next,
          entry: installedCatalogEntry,
          prompter,
          runtime,
          workspaceDir,
          autoConfirmSingleSource: true,
        });
        next = result.cfg;
        if (!result.installed) {
          return "retry_selection";
        }
        plugin = await loadScopedChannelPlugin(
          channel,
          result.pluginId ?? installedCatalogEntry.pluginId,
        );
      }
      if (!plugin) {
        await prompter.note(`${channel} plugin not available.`, "Channel setup");
        return "done";
      }
      await refreshStatus(channel);
    } else {
      // Neither discovery bucket yielded an entry for this channel. This can
      // happen when `channels.<id>` in user config carries stale fields (e.g.
      // `appId`, tokens) left over from a previous install: `isStatically-
      // ChannelConfigured` returns true, which removes the channel from the
      // `installableCatalogEntries` bucket, while a missing/pruned plugin on
      // disk keeps it out of `installedCatalogEntries`. Before falling back
      // to the bundled-plugin enable path, consult the catalog directly so
      // users with a stale config entry for an externalized channel (qqbot,
      // imessage, discord, whatsapp, ...) still get auto-install instead
      // of a dead-end "plugin not available" note.
      const fallbackCatalogEntry = getTrustedChannelPluginCatalogEntry(channel, {
        cfg: next,
        workspaceDir: resolveWorkspaceDir(),
      });
      if (fallbackCatalogEntry?.install?.npmSpec) {
        // Preserve the same disabled-config guard used by
        // `enableBundledPluginForSetup` so an operator-disabled channel
        // cannot be silently reinstalled/re-enabled through this path. This
        // mirrors the guard that was previously enforced inside the
        // bundled-enable fallback.
        const disabledHint = resolveConfigDisabledHint(channel);
        if (disabledHint) {
          await prompter.note(
            `${channel} cannot be configured while ${disabledHint}. Enable it before setup.`,
            "Channel setup",
          );
          return "done";
        }
        const workspaceDir = resolveWorkspaceDir();
        const result = await ensureChannelSetupPluginInstalled({
          cfg: next,
          entry: fallbackCatalogEntry,
          prompter,
          runtime,
          workspaceDir,
          autoConfirmSingleSource: true,
        });
        next = result.cfg;
        if (!result.installed) {
          return "retry_selection";
        }
        await loadScopedChannelPlugin(channel, result.pluginId ?? fallbackCatalogEntry.pluginId);
        await refreshStatus(channel);
      } else {
        const enabled = await enableBundledPluginForSetup(channel);
        if (!enabled) {
          return "done";
        }
      }
    }

    const plugin = getVisibleChannelPlugin(channel);
    const adapter = getVisibleSetupFlowAdapter(channel);
    const label = plugin?.meta.label ?? catalogEntry?.meta.label ?? channel;
    const status = statusByChannel.get(channel);
    const configured = status?.configured ?? false;
    if (adapter?.configureInteractive) {
      const custom = await adapter.configureInteractive({
        cfg: next,
        runtime,
        prompter,
        options,
        accountOverrides,
        shouldPromptAccountIds,
        forceAllowFrom: forceAllowFromChannels.has(channel),
        configured,
        label,
      });
      if (!(await applyCustomSetupResult(channel, custom))) {
        return "done";
      }
      return "done";
    }
    if (configured) {
      await handleConfiguredChannel(channel, label);
      return "done";
    }
    await configureChannel(channel);
    return "done";
  };

  if (options?.quickstartDefaults) {
    while (true) {
      const { entries, catalogById } = getChannelEntries();
      const choice = await prompter.select({
        message: "Select channel (QuickStart)",
        options: [
          ...resolveChannelSetupSelectionContributions({
            entries,
            statusByChannel: buildStatusByChannelForSelection(catalogById),
            resolveDisabledHint,
          }).map((contribution) => contribution.option),
          {
            value: "__skip__",
            label: "Skip for now",
            hint: `You can add channels later via \`${formatCliCommand("openclaw channels add")}\``,
          },
        ],
        initialValue: quickstartDefault,
        searchable: true,
      });
      if (choice === "__skip__") {
        break;
      }
      if ((await handleChannelChoice(choice)) === "done") {
        break;
      }
    }
  } else {
    const doneValue = "__done__" as const;
    const initialValue = options?.initialSelection?.[0] ?? quickstartDefault;
    while (true) {
      const { entries, catalogById } = getChannelEntries();
      const choice = await prompter.select({
        message: "Select a channel",
        options: [
          ...resolveChannelSetupSelectionContributions({
            entries,
            statusByChannel: buildStatusByChannelForSelection(catalogById),
            resolveDisabledHint,
          }).map((contribution) => contribution.option),
          {
            value: doneValue,
            label: "Finished",
            hint: selection.length > 0 ? "Done" : "Skip for now",
          },
        ],
        initialValue,
      });
      if (choice === doneValue) {
        break;
      }
      await handleChannelChoice(choice);
    }
  }

  options?.onSelection?.(selection);

  const selectedLines = resolveChannelSelectionNoteLines({
    cfg: next,
    installedPlugins: listVisibleInstalledPlugins(),
    selection,
  });
  if (selectedLines.length > 0) {
    await prompter.note(selectedLines.join("\n"), "Selected channels");
  }

  if (!options?.skipDmPolicyPrompt) {
    next = await maybeConfigureDmPolicies({
      cfg: next,
      selection,
      prompter,
      accountIdsByChannel,
      resolveAdapter: getVisibleSetupFlowAdapter,
    });
  }

  return next;
}
