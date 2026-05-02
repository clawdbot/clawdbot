import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import { getChannelSetupPlugin } from "../channels/plugins/setup-registry.js";
import type { ChannelSetupPlugin } from "../channels/plugins/setup-wizard-types.js";
import { formatCliCommand } from "../cli/command-format.js";
import type {
  ChannelSetupDmPolicy,
  ChannelSetupWizardAdapter,
} from "../commands/channel-setup/types.js";
import type { ChannelChoice } from "../commands/onboard-types.js";
import type { DmPolicy } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";
import { formatDocsLink } from "../terminal/links.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";

type ConfiguredChannelAction = "update" | "disable" | "delete" | "skip";

export function formatAccountLabel(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? "default (primary)" : accountId;
}

export async function promptConfiguredAction(params: {
  prompter: WizardPrompter;
  label: string;
  supportsDisable: boolean;
  supportsDelete: boolean;
}): Promise<ConfiguredChannelAction> {
  const { prompter, label, supportsDisable, supportsDelete } = params;
  const options: Array<WizardSelectOption<ConfiguredChannelAction>> = [
    {
      value: "update",
      label: "Modify settings",
    },
    ...(supportsDisable
      ? [
          {
            value: "disable" as const,
            label: "Disable (keeps config)",
          },
        ]
      : []),
    ...(supportsDelete
      ? [
          {
            value: "delete" as const,
            label: "Delete config",
          },
        ]
      : []),
    {
      value: "skip",
      label: "Skip (leave as-is)",
    },
  ];
  return await prompter.select({
    message: `${label} already configured. What do you want to do?`,
    options,
    initialValue: "update",
  });
}

export async function promptRemovalAccountId(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  label: string;
  channel: ChannelChoice;
  plugin?: ChannelSetupPlugin;
}): Promise<string> {
  const { cfg, prompter, label, channel } = params;
  const plugin = params.plugin ?? getChannelSetupPlugin(channel);
  if (!plugin) {
    return DEFAULT_ACCOUNT_ID;
  }
  const accountIds = plugin.config.listAccountIds(cfg).filter(Boolean);
  const defaultAccountId = resolveChannelDefaultAccountId({ plugin, cfg, accountIds });
  if (accountIds.length <= 1) {
    return defaultAccountId;
  }
  const selected = await prompter.select({
    message: `${label} account`,
    options: accountIds.map((accountId) => ({
      value: accountId,
      label: formatAccountLabel(accountId),
    })),
    initialValue: defaultAccountId,
  });
  return normalizeAccountId(selected) ?? defaultAccountId;
}

export async function maybeConfigureDmPolicies(params: {
  cfg: OpenClawConfig;
  selection: ChannelChoice[];
  prompter: WizardPrompter;
  accountIdsByChannel?: Map<ChannelChoice, string>;
  resolveAdapter?: (channel: ChannelChoice) => ChannelSetupWizardAdapter | undefined;
}): Promise<OpenClawConfig> {
  const { selection, prompter, accountIdsByChannel } = params;
  const resolve = params.resolveAdapter ?? (() => undefined);
  const dmPolicies = selection
    .map((channel) => resolve(channel)?.dmPolicy)
    .filter(Boolean) as ChannelSetupDmPolicy[];
  if (dmPolicies.length === 0) {
    return params.cfg;
  }

  const wants = await prompter.confirm({
    message: "Configure DM access policies now? (default: pairing)",
    initialValue: false,
  });
  if (!wants) {
    return params.cfg;
  }

  let cfg = params.cfg;
  for (const policy of dmPolicies) {
    const accountId = accountIdsByChannel?.get(policy.channel);
    const { policyKey, allowFromKey } = policy.resolveConfigKeys?.(cfg, accountId) ?? {
      policyKey: policy.policyKey,
      allowFromKey: policy.allowFromKey,
    };
    await prompter.note(
      [
        "Default: pairing (unknown DMs get a pairing code).",
        `Approve: ${formatCliCommand(`openclaw pairing approve ${policy.channel} <code>`)}`,
        `Allowlist DMs: ${policyKey}="allowlist" + ${allowFromKey} entries.`,
        `Public DMs: ${policyKey}="open" + ${allowFromKey} includes "*".`,
        "Multi-user DMs: run: " +
          formatCliCommand('openclaw config set session.dmScope "per-channel-peer"') +
          ' (or "per-account-channel-peer" for multi-account channels) to isolate sessions.',
        `Docs: ${formatDocsLink("/channels/pairing", "channels/pairing")}`,
      ].join("\n"),
      `${policy.label} DM access`,
    );
    const nextPolicy = (await prompter.select({
      message: `${policy.label} DM policy`,
      options: [
        { value: "pairing", label: "Pairing (recommended)" },
        { value: "allowlist", label: "Allowlist (specific users only)" },
        { value: "open", label: "Open (public inbound DMs)" },
        { value: "disabled", label: "Disabled (ignore DMs)" },
      ],
    })) as DmPolicy;
    const current = policy.getCurrent(cfg, accountId);
    if (nextPolicy !== current) {
      cfg = policy.setPolicy(cfg, nextPolicy, accountId);
    }
    if (nextPolicy === "allowlist" && policy.promptAllowFrom) {
      cfg = await policy.promptAllowFrom({
        cfg,
        prompter,
        accountId,
      });
    }
  }

  return cfg;
}
