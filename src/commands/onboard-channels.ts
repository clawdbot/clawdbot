import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPluginCatalogEntries } from "../channels/plugins/catalog.js";
import { listChannelPlugins, getChannelPlugin } from "../channels/plugins/index.js";
import type { ChannelMeta } from "../channels/plugins/types.js";
import {
  formatChannelPrimerLine,
  formatChannelSelectionLine,
  listChatChannels,
} from "../channels/registry.js";
import type { MoltbotConfig } from "../config/config.js";
import { isChannelConfigured } from "../config/plugin-auto-enable.js";
import type { DmPolicy } from "../config/types.js";
import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import { formatCliCommand } from "../cli/command-format.js";
import { enablePluginInConfig } from "../plugins/enable.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";
import type { ChannelChoice } from "./onboard-types.js";
import {
  getChannelOnboardingAdapter,
  listChannelOnboardingAdapters,
} from "./onboarding/registry.js";
import {
  ensureOnboardingPluginInstalled,
  reloadOnboardingPluginRegistry,
} from "./onboarding/plugin-install.js";
import type {
  ChannelOnboardingDmPolicy,
  ChannelOnboardingStatus,
  SetupChannelsOptions,
} from "./onboarding/types.js";

type ConfiguredChannelAction = "update" | "disable" | "delete" | "skip";

type ChannelStatusSummary = {
  installedPlugins: ReturnType<typeof listChannelPlugins>;
  catalogEntries: ReturnType<typeof listChannelPluginCatalogEntries>;
  statusByChannel: Map<ChannelChoice, ChannelOnboardingStatus>;
  statusLines: string[];
};

function formatAccountLabel(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? "default (primary)" : accountId;
}

async function promptConfiguredAction(params: {
  prompter: WizardPrompter;
  label: string;
  supportsDisable: boolean;
  supportsDelete: boolean;
}): Promise<ConfiguredChannelAction> {
  const { prompter, label, supportsDisable, supportsDelete } = params;
  const updateOption: WizardSelectOption<ConfiguredChannelAction> = {
    value: "update",
    label: "Modify settings",
  };
  const disableOption: WizardSelectOption<ConfiguredChannelAction> = {
    value: "disable",
    label: "Disable (keeps config)",
  };
  const deleteOption: WizardSelectOption<ConfiguredChannelAction> = {
    value: "delete",
    label: "Delete config",
  };
  const skipOption: WizardSelectOption<ConfiguredChannelAction> = {
    value: "skip",
    label: "Skip (leave as-is)",
  };
  const options: Array<WizardSelectOption<ConfiguredChannelAction>> = [
    updateOption,
    ...(supportsDisable ? [disableOption] : []),
    ...(supportsDelete ? [deleteOption] : []),
    skipOption,
  ];
  return (await prompter.select({
    message: `${label} already configured. What do you want to do?`,
    options,
    initialValue: "update",
  })) as ConfiguredChannelAction;
}

async function promptRemovalAccountId(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
  label: string;
  channel: ChannelChoice;
}): Promise<string> {
  const { cfg, prompter, label, channel } = params;
  const plugin = getChannelPlugin(channel);
  if (!plugin) return DEFAULT_ACCOUNT_ID;
  const accountIds = plugin.config.listAccountIds(cfg).filter(Boolean);
  const defaultAccountId = resolveChannelDefaultAccountId({ plugin, cfg, accountIds });
  if (accountIds.length <= 1) return defaultAccountId;
  const selected = (await prompter.select({
    message: `${label} account`,
    options: accountIds.map((accountId) => ({
      value: accountId,
      label: formatAccountLabel(accountId),
    })),
    initialValue: defaultAccountId,
  })) as string;
  return normalizeAccountId(selected) ?? defaultAccountId;
}

async function collectChannelStatus(params: {
  cfg: MoltbotConfig;
  options?: SetupChannelsOptions;
  accountOverrides: Partial<Record<ChannelChoice, string>>;
}): Promise<ChannelStatusSummary> {
  const installedPlugins = listChannelPlugins();
  const installedIds = new Set(installedPlugins.map((plugin) => plugin.id));
  const workspaceDir = resolveAgentWorkspaceDir(params.cfg, resolveDefaultAgentId(params.cfg));
  const catalogEntries = listChannelPluginCatalogEntries({ workspaceDir }).filter(
    (entry) => !installedIds.has(entry.id),
  );
  const statusEntries = await Promise.all(
    listChannelOnboardingAdapters().map((adapter) =>
      adapter.getStatus({
        cfg: params.cfg,
        options: params.options,
        accountOverrides: params.accountOverrides,
      }),
    ),
  );
  const statusByChannel = new Map(statusEntries.map((entry) => [entry.channel, entry]));
  const fallbackStatuses = listChatChannels()
    .filter((meta) => !statusByChannel.has(meta.id))
    .map((meta) => {
      const configured = isChannelConfigured(params.cfg, meta.id);
      const statusLabel = configured ? "configured (plugin disabled)" : "not configured";
      return {
        channel: meta.id,
        configured,
        statusLines: [`${meta.label}: ${statusLabel}`],
        selectionHint: configured ? "configured · plugin disabled" : "not configured",
        quickstartScore: 0,
      };
    });
  const catalogStatuses = catalogEntries.map((entry) => ({
    channel: entry.id,
    configured: false,
    statusLines: [`${entry.meta.label}: install plugin to enable`],
    selectionHint: "plugin · install",
    quickstartScore: 0,
  }));
  const combinedStatuses = [...statusEntries, ...fallbackStatuses, ...catalogStatuses];
  const mergedStatusByChannel = new Map(combinedStatuses.map((entry) => [entry.channel, entry]));
  const statusLines = combinedStatuses.flatMap((entry) => entry.statusLines);
  return {
    installedPlugins,
    catalogEntries,
    statusByChannel: mergedStatusByChannel,
    statusLines,
  };
}

export async function noteChannelStatus(params: {
  cfg: MoltbotConfig;
  prompter: WizardPrompter;
  options?: SetupChannelsOptions;
  accountOverrides?: Partial<Record<ChannelChoice, string>>;
}): Promise<void> {
  const { statusLines } = await collectChannelStatus({
    cfg: params.cfg,
    options: params.options,
    accountOverrides: params.accountOverrides ?? {},
  });
  if (statusLines.length > 0) {
    await params.prompter.note(statusLines.join("\n"), "Channel status");
  }
}

async function noteChannelPrimer(
  prompter: WizardPrompter,
  channels: Array<{ id: ChannelChoice; blurb: string; label: string }>,
): Promise<void> {
  const channelLines = channels.map((channel) =>
    formatChannelPrimerLine({
      id: channel.id,
      label: channel.label,
      selectionLabel: channel.label,
      docsPath: "/",
      blurb: channel.blurb,
    }),
  );
  await prompter.note(
    [
      "DM security: default is pairing; unknown DMs get a pairing code.",
      `Approve with: ${formatCliCommand("moltbot pairing approve <channel> <code>")}`,
      'Public DMs require dmPolicy="open" + allowFrom=["*"].',
      'Multi-user DMs: set session.dmScope="per-channel-peer" to isolate sessions.',
      `Docs: ${formatDocsLink("/start/pairing", "start/pairing")}`,
      "",
      ...channelLines,
    ].join("\n"),
    "How channels work",
  );
}

function resolveQuickstartDefault(
  statusByChannel: Map<ChannelChoice, { quickstartScore?: number }>,
): ChannelChoice | undefined {
  let best: { channel: ChannelChoice; score: number } | null = null;
  for (const [channel, status] of statusByChannel) {
    if (status.quickstartScore == null) continue;
    if (!best || status.quickstartScore > best.score) {
      best = { channel, score: status.quickstartScore };
    }
  }
  return best?.channel;
}

async function maybeConfigureDmPolicies(params: {
  cfg: MoltbotConfig;
  selection: ChannelChoice[];
  prompter: WizardPrompter;
  accountIdsByChannel?: Map<ChannelChoice, string>;
}): Promise<MoltbotConfig> {
  const { selection, prompter, accountIdsByChannel } = params;
  const dmPolicies = selection
    .map((channel) => getChannelOnboardingAdapter(channel)?.dmPolicy)
    .filter(Boolean) as ChannelOnboardingDmPolicy[];
  if (dmPolicies.length === 0) return params.cfg;

  const wants = await prompter.confirm({
    message: "Configure DM access policies now? (default: pairing)",
    initialValue: false,
  });
  if (!wants) return params.cfg;

  let cfg = params.cfg;
  const selectPolicy = async (policy: ChannelOnboardingDmPolicy) => {
    await prompter.note(
      [
        "Default: pairing (unknown DMs get a pairing code).",
        `Approve: ${formatCliCommand(`moltbot pairing approve ${policy.channel} <code>`)}`,
        `Allowlist DMs: ${policy.policyKey}="allowlist" + ${policy.allowFromKey} entries.`,
        `Public DMs: ${policy.policyKey}="open" + ${policy.allowFromKey} includes "*".`,
        'Multi-user DMs: set session.dmScope="per-channel-peer" to isolate sessions.',
        `Docs: ${formatDocsLink("/start/pairing", "start/pairing")}`,
      ].join("\n"),
      `${policy.label} DM access`,
    );
    return (await prompter.select({
      message: `${policy.label} DM policy`,
      options: [
        { value: "pairing", label: "Pairing (recommended)" },
        { value: "allowlist", label: "Allowlist (specific users only)" },
        { value: "open", label: "Open (public inbound DMs)" },
        { value: "disabled", label: "Disabled (ignore DMs)" },
      ],
    })) as DmPolicy;
  };

  for (const policy of dmPolicies) {
    const current = policy.getCurrent(cfg);
    const nextPolicy = await selectPolicy(policy);
    if (nextPolicy !== current) {
      cfg = policy.setPolicy(cfg, nextPolicy);
    }
    if (nextPolicy === "allowlist" && policy.promptAllowFrom) {
      cfg = await policy.promptAllowFrom({
        cfg,
        prompter,
        accountId: accountIdsByChannel?.get(policy.channel),
      });
    }
  }

  return cfg;
}

// Channel-specific prompts moved into onboarding adapters.

export async function setupChannels(
  cfg: MoltbotConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options?: SetupChannelsOptions,
): Promise<MoltbotConfig> {
  let next = cfg;
  const forceAllowFromChannels = new Set(options?.forceAllowFromChannels ?? []);
  const accountOverrides: Partial<Record<ChannelChoice, string>> = {
    ...options?.accountIds,
  };
  if (options?.whatsappAccountId?.trim()) {
    accountOverrides.whatsapp = options.whatsappAccountId.trim();
  }

  const { installedPlugins, catalogEntries, statusByChannel, statusLines } =
    await collectChannelStatus({ cfg: next, options, accountOverrides });
  if (!options?.skipStatusNote && statusLines.length > 0) {
    await prompter.note(statusLines.join("\n"), "Channel status");
  }

  const shouldConfigure = options?.skipConfirm
    ? true
    : await prompter.confirm({
        message: "Configure chat channels now?",
        initialValue: true,
      });
  if (!shouldConfigure) return cfg;

  const corePrimer = listChatChannels().map((meta) => ({
    id: meta.id as ChannelChoice,
    label: meta.label,
    blurb: meta.blurb,
  }));
  const coreIds = new Set(corePrimer.map((entry) => entry.id));
  const primerChannels = [
    ...corePrimer,
    ...installedPlugins
      .filter((plugin) => !coreIds.has(plugin.id as ChannelChoice))
      .map((plugin) => ({
        id: plugin.id as ChannelChoice,
        label: plugin.meta.label,
        blurb: plugin.meta.blurb,
      })),
    ...catalogEntries
      .filter((entry) => !coreIds.has(entry.id as ChannelChoice))
      .map((entry) => ({
        id: entry.id as ChannelChoice,
        label: entry.meta.label,
        blurb: entry.meta.blurb,
      })),
  ];
  await noteChannelPrimer(prompter, primerChannels);

  const quickstartDefault =
    options?.initialSelection?.[0] ?? resolveQuickstartDefault(statusByChannel);

  const shouldPromptAccountIds = options?.promptAccountIds === true;
  const accountIdsByChannel = new Map<ChannelChoice, string>();
  const recordAccount = (channel: ChannelChoice, accountId: string) => {
    options?.onAccountId?.(channel, accountId);
    const adapter = getChannelOnboardingAdapter(channel);
    adapter?.onAccountRecorded?.(accountId, options);
    accountIdsByChannel.set(channel, accountId);
  };

  const selection: ChannelChoice[] = [];
  const addSelection = (channel: ChannelChoice) => {
    if (!selection.includes(channel)) selection.push(channel);
  };

  const resolveDisabledHint = (channel: ChannelChoice): string | undefined => {
    const plugin = getChannelPlugin(channel);
    if (!plugin) {
      if (next.plugins?.entries?.[channel]?.enabled === false) return "plugin disabled";
      if (next.plugins?.enabled === false) return "plugins disabled";
      return undefined;
    }
    const accountId = resolveChannelDefaultAccountId({ plugin, cfg: next });
    const account = plugin.config.resolveAccount(next, accountId);
    let enabled: boolean | undefined;
    if (plugin.config.isEnabled) {
      enabled = plugin.config.isEnabled(account, next);
    } else if (typeof (account as { enabled?: boolean })?.enabled === "boolean") {
      enabled = (account as { enabled?: boolean }).enabled;
    } else if (
      typeof (next.channels as Record<string, { enabled?: boolean }> | undefined)?.[channel]
        ?.enabled === "boolean"
    ) {
      enabled = (next.channels as Record<string, { enabled?: boolean }>)[channel]?.enabled;
    }
    return enabled === false ? "disabled" : undefined;
  };

  const buildSelectionOptions = (
    entries: Array<{
      id: ChannelChoice;
      meta: { id: string; label: string; selectionLabel?: string };
    }>,
  ) =>
    entries.map((entry) => {
      const status = statusByChannel.get(entry.id);
      const disabledHint = resolveDisabledHint(entry.id);
      const hint = [status?.selectionHint, disabledHint].filter(Boolean).join(" · ") || undefined;
      return {
        value: entry.meta.id,
        label: entry.meta.selectionLabel ?? entry.meta.label,
        ...(hint ? { hint } : {}),
      };
    });

  const getChannelEntries = () => {
    const core = listChatChannels();
    const installed = listChannelPlugins();
    const installedIds = new Set(installed.map((plugin) => plugin.id));
    const workspaceDir = resolveAgentWorkspaceDir(next, resolveDefaultAgentId(next));
    const catalog = listChannelPluginCatalogEntries({ workspaceDir }).filter(
      (entry) => !installedIds.has(entry.id),
    );
    const metaById = new Map<string, ChannelMeta>();
    for (const meta of core) {
      metaById.set(meta.id, meta);
    }
    for (const plugin of installed) {
      metaById.set(plugin.id, plugin.meta);
    }
    for (const entry of catalog) {
      if (!metaById.has(entry.id)) {
        metaById.set(entry.id, entry.meta);
      }
    }
    const entries = Array.from(metaById, ([id, meta]) => ({
      id: id as ChannelChoice,
      meta,
    }));
    return {
      entries,
      catalog,
      catalogById: new Map(catalog.map((entry) => [entry.id as ChannelChoice, entry])),
    };
  };

  const refreshStatus = async (channel: ChannelChoice) => {
    const adapter = getChannelOnboardingAdapter(channel);
    if (!adapter) return;
    const status = await adapter.getStatus({ cfg: next, options, accountOverrides });
    statusByChannel.set(channel, status);
  };

  const ensureBundledPluginEnabled = async (channel: ChannelChoice): Promise<boolean> => {
    if (getChannelPlugin(channel)) return true;
    const result = enablePluginInConfig(next, channel);
    next = result.config;
    if (!result.enabled) {
      await prompter.note(
        `Cannot enable ${channel}: ${result.reason ?? "plugin disabled"}.`,
        "Channel setup",
      );
      return false;
    }
    const workspaceDir = resolveAgentWorkspaceDir(next, resolveDefaultAgentId(next));
    reloadOnboardingPluginRegistry({
      cfg: next,
      runtime,
      workspaceDir,
    });
    if (!getChannelPlugin(channel)) {
      await prompter.note(`${channel} plugin not available.`, "Channel setup");
      return false;
    }
    await refreshStatus(channel);
    return true;
  };

  const configureChannel = async (channel: ChannelChoice) => {
    const adapter = getChannelOnboardingAdapter(channel);
    if (!adapter) {
      await prompter.note(`${channel} does not support onboarding yet.`, "Channel setup");
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
    next = result.cfg;
    if (result.accountId) {
      recordAccount(channel, result.accountId);
    }
    addSelection(channel);
    await refreshStatus(channel);
  };

  const handleConfiguredChannel = async (channel: ChannelChoice, label: string) => {
    const plugin = getChannelPlugin(channel);
    const adapter = getChannelOnboardingAdapter(channel);
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

    if (action === "skip") return;
    if (action === "update") {
      await configureChannel(channel);
      return;
    }
    if (!options?.allowDisable) return;

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
      if (!confirmed) return;
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

  const handleChannelChoice = async (channel: ChannelChoice) => {
    const { catalogById } = getChannelEntries();
    const catalogEntry = catalogById.get(channel);
    if (catalogEntry) {
      const workspaceDir = resolveAgentWorkspaceDir(next, resolveDefaultAgentId(next));
      const result = await ensureOnboardingPluginInstalled({
        cfg: next,
        entry: catalogEntry,
        prompter,
        runtime,
        workspaceDir,
      });
      next = result.cfg;
      if (!result.installed) return;
      reloadOnboardingPluginRegistry({
        cfg: next,
        runtime,
        workspaceDir,
      });
      await refreshStatus(channel);
    } else {
      const enabled = await ensureBundledPluginEnabled(channel);
      if (!enabled) return;
    }

    const plugin = getChannelPlugin(channel);
    const label = plugin?.meta.label ?? catalogEntry?.meta.label ?? channel;
    const status = statusByChannel.get(channel);
    const configured = status?.configured ?? false;
    if (configured) {
      await handleConfiguredChannel(channel, label);
      return;
    }
    await configureChannel(channel);
  };

  if (options?.quickstartDefaults) {
    const { entries } = getChannelEntries();
    const choice = (await prompter.select({
      message: "Select channel (QuickStart)",
      options: [
        ...buildSelectionOptions(entries),
        {
          value: "__skip__",
          label: "Skip for now",
          hint: `You can add channels later via \`${formatCliCommand("moltbot channels add")}\``,
        },
      ],
      initialValue: quickstartDefault,
    })) as ChannelChoice | "__skip__";
    if (choice !== "__skip__") {
      await handleChannelChoice(choice);
    }
  } else {
    const doneValue = "__done__" as const;
    const initialValue = options?.initialSelection?.[0] ?? quickstartDefault;
    while (true) {
      const { entries } = getChannelEntries();
      const choice = (await prompter.select({
        message: "Select a channel",
        options: [
          ...buildSelectionOptions(entries),
          {
            value: doneValue,
            label: "Finished",
            hint: selection.length > 0 ? "Done" : "Skip for now",
          },
        ],
        initialValue,
      })) as ChannelChoice | typeof doneValue;
      if (choice === doneValue) break;
      await handleChannelChoice(choice);
    }
  }

  options?.onSelection?.(selection);

  const selectionNotes = new Map<string, string>();
  const { entries: selectionEntries } = getChannelEntries();
  for (const entry of selectionEntries) {
    selectionNotes.set(entry.id, formatChannelSelectionLine(entry.meta, formatDocsLink));
  }
  const selectedLines = selection
    .map((channel) => selectionNotes.get(channel))
    .filter((line): line is string => Boolean(line));
  if (selectedLines.length > 0) {
    await prompter.note(selectedLines.join("\n"), "Selected channels");
  }

  if (!options?.skipDmPolicyPrompt) {
    next = await maybeConfigureDmPolicies({
      cfg: next,
      selection,
      prompter,
      accountIdsByChannel,
    });
  }

  return next;
}
