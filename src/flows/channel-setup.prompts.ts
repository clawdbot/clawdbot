// Channel setup prompt helpers build interactive prompts for channel setup.
import { formatDocsLink } from "../../packages/terminal-core/src/links.js";
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
import { t } from "../wizard/i18n/index.js";
import type { WizardPrompter, WizardSelectOption } from "../wizard/prompts.js";

// Prompt helpers for channel setup flows; keeps wizard copy and config mutation centralized.
type ConfiguredChannelAction = "update" | "disable" | "delete" | "skip";

/** Formats account ids for channel setup prompts. */
export function formatAccountLabel(accountId: string): string {
  return accountId === DEFAULT_ACCOUNT_ID ? "default (primary)" : accountId;
}

/** Asks what to do with an already-configured channel account. */
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
      label: t("wizard.channels.modifySettings"),
    },
    ...(supportsDisable
      ? [
          {
            value: "disable" as const,
            label: t("wizard.channels.disableKeepConfig"),
          },
        ]
      : []),
    ...(supportsDelete
      ? [
          {
            value: "delete" as const,
            label: t("wizard.channels.deleteConfig"),
          },
        ]
      : []),
    {
      value: "skip",
      label: t("wizard.channels.skipLeaveAsIs"),
    },
  ];
  return await prompter.select({
    message: t("wizard.channels.configuredAction", { label }),
    options,
    initialValue: "update",
  });
}

/** Selects the account to remove/update when a channel supports multiple accounts. */
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
    message: t("wizard.channels.account", { label }),
    options: accountIds.map((accountId) => ({
      value: accountId,
      label: formatAccountLabel(accountId),
    })),
    initialValue: defaultAccountId,
  });
  return normalizeAccountId(selected) ?? defaultAccountId;
}

/** Optionally configures DM access policies for selected channel setup adapters. */
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
    message: t("wizard.channels.configureDmPolicies"),
    initialValue: false,
  });
  if (!wants) {
    return params.cfg;
  }

  let cfg = params.cfg;
  for (const policy of dmPolicies) {
    const accountId = accountIdsByChannel?.get(policy.channel);
    // Multi-account channels can remap the policy keys for the selected account.
    const { policyKey, allowFromKey } = policy.resolveConfigKeys?.(cfg, accountId) ?? {
      policyKey: policy.policyKey,
      allowFromKey: policy.allowFromKey,
    };
    await prompter.note(
      [
        t("wizard.channels.dmPolicyDefault"),
        t("wizard.channels.dmPolicyApprove", {
          command: formatCliCommand(`openclaw pairing approve ${policy.channel} <code>`),
        }),
        t("wizard.channels.dmPolicyAllowlist", { allowFromKey, policyKey }),
        t("wizard.channels.dmPolicyOpen", { allowFromKey, policyKey }),
        t("wizard.channels.dmPolicyMultiUser", {
          command: formatCliCommand('openclaw config set session.dmScope "per-channel-peer"'),
        }),
        t("wizard.channels.docs", {
          link: formatDocsLink("/channels/pairing", "channels/pairing"),
        }),
      ].join("\n"),
      t("wizard.channels.dmAccessTitle", { label: policy.label }),
    );
    const nextPolicy = (await prompter.select({
      message: t("wizard.channels.dmPolicy", { label: policy.label }),
      options: [
        { value: "pairing", label: t("wizard.channels.dmPolicyPairing") },
        { value: "allowlist", label: t("wizard.channels.dmPolicyAllowlistOption") },
        { value: "open", label: t("wizard.channels.dmPolicyOpenOption") },
        { value: "disabled", label: t("wizard.channels.dmPolicyDisabledOption") },
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
