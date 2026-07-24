// Guided channel-setup wizard flow shared by `openclaw channels add` (clack
// prompter) and the gateway `wizard.start {flow:"channels"}` RPC (session
// prompter driving the Control UI / native clients).
import { resolveAgentWorkspaceDir, resolveDefaultAgentId } from "../../agents/agent-scope.js";
import { findChannelEntryByIdOrAlias } from "../../channels/plugins/entry-resolution.js";
import { getLoadedChannelPlugin } from "../../channels/plugins/index.js";
import type { ChannelSetupPlugin } from "../../channels/plugins/setup-wizard-types.js";
import { readConfigFileSnapshot, type OpenClawConfig } from "../../config/config.js";
import { commitConfigWithPendingPluginInstalls } from "../../plugins/install-record-commit.js";
import { refreshPluginRegistryAfterConfigMutation } from "../../plugins/registry-refresh.js";
import { DEFAULT_ACCOUNT_ID } from "../../routing/session-key.js";
import type { RuntimeEnv } from "../../runtime.js";
import type { WizardPrompter } from "../../wizard/prompts.js";
import { applyAgentBindings, describeBinding } from "../agents.bindings.js";
import type { ChannelChoice } from "../onboard-types.js";
import { applyAccountName } from "./add-mutators.js";

type OnboardChannelsModule = typeof import("../onboard-channels.js");

async function loadOnboardChannels(): Promise<OnboardChannelsModule> {
  return await import("../onboard-channels.js");
}

/** Resolve a raw channel name/alias against the installed setup entries. */
export async function resolveInitialWizardChannel(
  raw: string,
  cfg: OpenClawConfig,
): Promise<ChannelChoice | undefined> {
  const [{ listActiveChannelSetupPlugins }, { resolveChannelSetupEntries }] = await Promise.all([
    import("../../channels/plugins/setup-registry.js"),
    import("../channel-setup/discovery.js"),
  ]);
  const resolved = resolveChannelSetupEntries({
    cfg,
    installedPlugins: listActiveChannelSetupPlugins(),
    workspaceDir: resolveAgentWorkspaceDir(cfg, resolveDefaultAgentId(cfg)),
  });
  return findChannelEntryByIdOrAlias(resolved.entries, raw)?.id;
}

type ChannelsAddWizardFlowParams = {
  cfg: OpenClawConfig;
  baseHash?: string;
  runtime: RuntimeEnv;
  prompter: WizardPrompter;
  initialChannel?: ChannelChoice;
  directEntryChannel?: ChannelChoice;
  beforePersistentEffect?: () => Promise<void>;
  /**
   * The controlling client completes device linking itself after config is
   * written (e.g. the Control UI renders the WhatsApp QR via web.login.*), so
   * setup surfaces must skip terminal-interactive login flows.
   */
  deferDeviceLinkToClient?: boolean;
  /** Reports the channel accounts actually configured, after config commit. */
  onConfigured?: (accounts: Array<{ channel: string; accountId: string }>) => void;
};

/** Run the interactive channel-setup flow and persist the resulting config. */
export async function runChannelsAddWizardFlow(params: ChannelsAddWizardFlowParams): Promise<void> {
  const { cfg, baseHash, runtime, prompter } = params;
  const [{ buildAgentSummaries }, onboardChannels] = await Promise.all([
    import("../agents.config.js"),
    loadOnboardChannels(),
  ]);
  const postWriteHooks = onboardChannels.createChannelOnboardingPostWriteHookCollector();
  let selection: ChannelChoice[] = [];
  const accountIds: Partial<Record<ChannelChoice, string>> = {};
  const resolvedPlugins = new Map<ChannelChoice, ChannelSetupPlugin>();
  await prompter.intro("Channel setup");
  let nextConfig = await onboardChannels.setupChannels(cfg, runtime, prompter, {
    ...(params.initialChannel ? { initialSelection: [params.initialChannel] } : {}),
    ...(params.directEntryChannel ? { directEntryChannel: params.directEntryChannel } : {}),
    allowDisable: false,
    allowIMessageInstall: true,
    allowSignalInstall: true,
    ...(params.beforePersistentEffect
      ? { beforePersistentEffect: params.beforePersistentEffect }
      : {}),
    ...(params.deferDeviceLinkToClient ? { deferDeviceLinkToClient: true } : {}),
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
  const commitWizardConfig = async (config: OpenClawConfig) => {
    await params.beforePersistentEffect?.();
    const committed = await commitConfigWithPendingPluginInstalls({
      nextConfig: config,
      ...(baseHash !== undefined ? { baseHash } : {}),
    });
    if (committed.movedInstallRecords) {
      await refreshPluginRegistryAfterConfigMutation({
        config: committed.config,
        reason: "source-changed",
        installRecords: committed.installRecords,
        logger: { warn: (message) => runtime.log(message) },
      });
    }
    await onboardChannels.runCollectedChannelOnboardingPostWriteHooks({
      hooks: postWriteHooks.drain(),
      cfg: committed.config,
      runtime,
      ...(params.beforePersistentEffect
        ? { beforePersistentEffect: params.beforePersistentEffect }
        : {}),
    });
    return committed.config;
  };
  if (selection.length === 0) {
    if (nextConfig !== cfg) {
      await commitWizardConfig(nextConfig);
      await prompter.outro("Channels updated.");
      return;
    }
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

  await commitWizardConfig(nextConfig);
  params.onConfigured?.(
    selection.map((channel) => ({
      channel,
      accountId: accountIds[channel] ?? DEFAULT_ACCOUNT_ID,
    })),
  );
  await prompter.outro("Channels updated.");
}

/**
 * Gateway entry for `wizard.start {flow:"channels"}`. Unlike the CLI path this
 * must never call runtime.exit — failures throw and surface as wizard errors.
 */
export async function runChannelsSetupWizard(
  opts: {
    channel?: string;
    onConfigured?: (accounts: Array<{ channel: string; accountId: string }>) => void;
    /** Revalidate/lock cancellation immediately before durable effects. */
    beforePersistentEffect?: () => Promise<void>;
  },
  runtime: RuntimeEnv,
  prompter: WizardPrompter,
): Promise<void> {
  const snapshot = await readConfigFileSnapshot();
  if (snapshot.exists && !snapshot.valid) {
    throw new Error(
      "OpenClaw config is invalid; run `openclaw doctor --fix`, then retry channel setup.",
    );
  }
  const cfg = (snapshot.sourceConfig ?? snapshot.config) as OpenClawConfig;
  const initialChannel = opts.channel
    ? await resolveInitialWizardChannel(opts.channel, cfg)
    : undefined;
  await runChannelsAddWizardFlow({
    cfg,
    ...(snapshot.hash !== undefined ? { baseHash: snapshot.hash } : {}),
    runtime,
    prompter,
    ...(initialChannel ? { initialChannel } : {}),
    deferDeviceLinkToClient: true,
    ...(opts.onConfigured ? { onConfigured: opts.onConfigured } : {}),
    ...(opts.beforePersistentEffect ? { beforePersistentEffect: opts.beforePersistentEffect } : {}),
  });
}
