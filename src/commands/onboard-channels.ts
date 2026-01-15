import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../agents/agent-scope.js";
import { listChannelPluginCatalogEntries } from "../channels/plugins/catalog.js";
import { listChannelPlugins, getChannelPlugin } from "../channels/plugins/index.js";
import { formatChannelPrimerLine, formatChannelSelectionLine } from "../channels/registry.js";
import type { ClawdbotConfig } from "../config/config.js";
import type { DmPolicy } from "../config/types.js";
import type { RuntimeEnv } from "../runtime.js";
import { formatDocsLink } from "../terminal/links.js";
import type { WizardPrompter } from "../wizard/prompts.js";
import type { ChannelChoice } from "./onboard-types.js";
import {
  getChannelOnboardingAdapter,
  listChannelOnboardingAdapters,
} from "./onboarding/registry.js";
import {
  ensureOnboardingPluginInstalled,
  reloadOnboardingPluginRegistry,
} from "./onboarding/plugin-install.js";
import type { ChannelOnboardingDmPolicy, SetupChannelsOptions } from "./onboarding/types.js";

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
      "Approve with: clawdbot pairing approve <channel> <code>",
      'Public DMs require dmPolicy="open" + allowFrom=["*"].',
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
  cfg: ClawdbotConfig;
  selection: ChannelChoice[];
  prompter: WizardPrompter;
}): Promise<ClawdbotConfig> {
  const { selection, prompter } = params;
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
        `Approve: clawdbot pairing approve ${policy.channel} <code>`,
        `Public DMs: ${policy.policyKey}="open" + ${policy.allowFromKey} includes "*".`,
        `Docs: ${formatDocsLink("/start/pairing", "start/pairing")}`,
      ].join("\n"),
      `${policy.label} DM access`,
    );
    return (await prompter.select({
      message: `${policy.label} DM policy`,
      options: [
        { value: "pairing", label: "Pairing (recommended)" },
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
  }

  return cfg;
}

// Channel-specific prompts moved into onboarding adapters.

export async function setupChannels(
  cfg: ClawdbotConfig,
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
  options?: SetupChannelsOptions,
): Promise<ClawdbotConfig> {
  let next = cfg;
  const forceAllowFromChannels = new Set(options?.forceAllowFromChannels ?? []);
  const accountOverrides: Partial<Record<ChannelChoice, string>> = {
    ...options?.accountIds,
  };
  if (options?.whatsappAccountId?.trim()) {
    accountOverrides.whatsapp = options.whatsappAccountId.trim();
  }

  const installedPlugins = listChannelPlugins();
  const catalogEntries = listChannelPluginCatalogEntries().filter(
    (entry) => !installedPlugins.some((plugin) => plugin.id === entry.id),
  );
  const statusEntries = await Promise.all(
    listChannelOnboardingAdapters().map((adapter) =>
      adapter.getStatus({ cfg, options, accountOverrides }),
    ),
  );
  const catalogStatuses = catalogEntries.map((entry) => ({
    channel: entry.id,
    configured: false,
    statusLines: [`${entry.meta.label}: install plugin to enable`],
    selectionHint: "plugin · install",
    quickstartScore: 0,
  }));
  const combinedStatuses = [...statusEntries, ...catalogStatuses];
  const statusByChannel = new Map(combinedStatuses.map((entry) => [entry.channel, entry]));
  const statusLines = combinedStatuses.flatMap((entry) => entry.statusLines);
  if (statusLines.length > 0) {
    await prompter.note(statusLines.join("\n"), "Channel status");
  }

  const shouldConfigure = options?.skipConfirm
    ? true
    : await prompter.confirm({
        message: "Configure chat channels now?",
        initialValue: true,
      });
  if (!shouldConfigure) return cfg;

  const primerChannels = [
    ...installedPlugins.map((plugin) => ({
      id: plugin.id as ChannelChoice,
      label: plugin.meta.label,
      blurb: plugin.meta.blurb,
    })),
    ...catalogEntries.map((entry) => ({
      id: entry.id as ChannelChoice,
      label: entry.meta.label,
      blurb: entry.meta.blurb,
    })),
  ];
  await noteChannelPrimer(prompter, primerChannels);

  const selectionOptions = [
    ...installedPlugins.map((plugin) => ({
      id: plugin.id as ChannelChoice,
      meta: plugin.meta,
    })),
    ...catalogEntries.map((entry) => ({
      id: entry.id as ChannelChoice,
      meta: entry.meta,
    })),
  ].map((entry) => {
    const meta = entry.meta;
    const status = statusByChannel.get(entry.id);
    return {
      value: meta.id,
      label: meta.selectionLabel ?? meta.label,
      ...(status?.selectionHint ? { hint: status.selectionHint } : {}),
    };
  });

  const quickstartDefault =
    options?.initialSelection?.[0] ?? resolveQuickstartDefault(statusByChannel);

  let selection: ChannelChoice[];
  if (options?.quickstartDefaults) {
    const choice = (await prompter.select({
      message: "Select channel (QuickStart)",
      options: [
        ...selectionOptions,
        {
          value: "__skip__",
          label: "Skip for now",
          hint: "You can add channels later via `clawdbot channels add`",
        },
      ],
      initialValue: quickstartDefault,
    })) as ChannelChoice | "__skip__";
    selection = choice === "__skip__" ? [] : [choice];
  } else {
    const initialSelection = options?.initialSelection ?? [];
    selection = (await prompter.multiselect({
      message: "Select channels (Space to toggle, Enter to continue)",
      options: selectionOptions,
      initialValues: initialSelection.length ? initialSelection : undefined,
    })) as ChannelChoice[];
  }

  const catalogById = new Map(catalogEntries.map((entry) => [entry.id as ChannelChoice, entry]));
  if (selection.some((channel) => catalogById.has(channel))) {
    const workspaceDir = resolveAgentWorkspaceDir(next, resolveDefaultAgentId(next));
    for (const channel of selection) {
      const entry = catalogById.get(channel);
      if (!entry) continue;
      const result = await ensureOnboardingPluginInstalled({
        cfg: next,
        entry,
        prompter,
        runtime,
        workspaceDir,
      });
      next = result.cfg;
      if (!result.installed) {
        selection = selection.filter((id) => id !== channel);
        continue;
      }
      reloadOnboardingPluginRegistry({
        cfg: next,
        runtime,
        workspaceDir,
      });
    }
  }

  options?.onSelection?.(selection);

  const selectionNotes = new Map<string, string>();
  for (const plugin of installedPlugins) {
    selectionNotes.set(plugin.id, formatChannelSelectionLine(plugin.meta, formatDocsLink));
  }
  for (const entry of catalogEntries) {
    selectionNotes.set(entry.id, formatChannelSelectionLine(entry.meta, formatDocsLink));
  }
  const selectedLines = selection
    .map((channel) => selectionNotes.get(channel))
    .filter((line): line is string => Boolean(line));
  if (selectedLines.length > 0) {
    await prompter.note(selectedLines.join("\n"), "Selected channels");
  }

  const shouldPromptAccountIds = options?.promptAccountIds === true;
  const recordAccount = (channel: ChannelChoice, accountId: string) => {
    options?.onAccountId?.(channel, accountId);
    const adapter = getChannelOnboardingAdapter(channel);
    adapter?.onAccountRecorded?.(accountId, options);
  };

  for (const channel of selection) {
    const adapter = getChannelOnboardingAdapter(channel);
    if (!adapter) continue;
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
  }

  if (!options?.skipDmPolicyPrompt) {
    next = await maybeConfigureDmPolicies({ cfg: next, selection, prompter });
  }

  if (options?.allowDisable) {
    for (const [channelId, status] of statusByChannel) {
      if (selection.includes(channelId)) continue;
      if (!status.configured) continue;
      const adapter = getChannelOnboardingAdapter(channelId);
      if (!adapter?.disable) continue;
      const meta = getChannelPlugin(channelId)?.meta;
      const disable = await prompter.confirm({
        message: `Disable ${meta?.label ?? channelId} channel?`,
        initialValue: false,
      });
      if (disable) {
        next = adapter.disable(next);
      }
    }
  }

  return next;
}
