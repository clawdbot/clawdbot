import { expectDefined } from "@openclaw/normalization-core";
import { asOptionalRecord } from "@openclaw/normalization-core/record-coerce";
// Channel selection chooses a deliverable message channel from explicit input,
// tool context fallback, or configured plugin accounts.
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import { formatUnknownChannelMessage } from "../../cli/error-format.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import {
  type OfficialExternalPluginRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHint,
  resolveMissingOfficialExternalChannelPluginRepairHints,
} from "../../plugins/official-external-plugin-repair-hints.js";
import { defaultRuntime } from "../../runtime.js";
import { isAccountEnabled } from "../../shared/account-enabled.js";
import {
  isDeliverableMessageChannel,
  normalizeMessageChannel,
} from "../../utils/message-channel.js";
import { createDedupeCache } from "../dedupe.js";
import { formatErrorMessage } from "../errors.js";
import {
  normalizeDeliverableOutboundChannel,
  resolveOutboundChannelPlugin,
} from "./channel-resolution.js";
import { listRuntimeVisibleChannelPlugins } from "./runtime-visible-channels.js";

/** Source that explains how message channel selection chose its result. */
type MessageChannelSelectionSource = "explicit" | "tool-context-fallback" | "single-configured";

function resolveAvailableKnownChannel(params: {
  cfg: OpenClawConfig;
  value?: string | null;
  agentId?: string;
}): { channel: string; plugin: ChannelPlugin } | undefined {
  const normalized = normalizeDeliverableOutboundChannel(params.value);
  if (!normalized) {
    return undefined;
  }
  // Pass `allowBootstrap: true` so the in-agent message tool path can resolve
  // outbound channels in processes where external channel adapters have not
  // been eagerly loaded (e.g. `openclaw agent --local`). Already-loaded and
  // bundled plugins still resolve through side-effect-free fast paths first.
  // Without the bootstrap fallback, official external channels can surface as
  // the recurring "Channel is unavailable" error on `--local`-routed
  // dispatches that the CLI send-path could deliver to.
  // Adjacent to #77254 (cron-announce / final-reply paths); this closes the
  // remaining in-agent caller in the same family.
  const plugin = resolveOutboundChannelPlugin({
    channel: normalized,
    cfg: params.cfg,
    agentId: params.agentId,
    allowBootstrap: true,
  });
  return plugin ? { channel: normalized, plugin } : undefined;
}

/** Checks whether a channel has a non-disabled config entry. */
export function isConfiguredChannel(cfg: OpenClawConfig, channelId: string): boolean {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return false;
  }
  const entry = (channels as Record<string, unknown>)[channelId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return false;
  }
  return (entry as { enabled?: unknown }).enabled !== false;
}

function listConfiguredOfficialExternalRepairHints(
  cfg: OpenClawConfig,
): OfficialExternalPluginRepairHint[] {
  const channels = cfg.channels;
  if (!channels || typeof channels !== "object" || Array.isArray(channels)) {
    return [];
  }
  return resolveMissingOfficialExternalChannelPluginRepairHints({
    config: cfg,
    channelIds: Object.keys(channels).filter((channelId) => isConfiguredChannel(cfg, channelId)),
  });
}

function formatMissingOfficialExternalChannelsMessage(
  hints: readonly OfficialExternalPluginRepairHint[],
): string {
  if (hints.length === 1) {
    const hint = hints[0];
    if (!hint) {
      return "";
    }
    return `Configured official external channel ${hint.label} is missing its plugin. ${hint.repairHint}`;
  }
  const labels = hints.map((hint) => hint.label).join(", ");
  const installCommands = hints.map((hint) => hint.installCommand).join("; ");
  return `Configured official external channels ${labels} are missing their plugins. Run: openclaw doctor --fix, or install individually: ${installCommands}.`;
}

function formatNoConfiguredChannelsMessage(): string {
  return [
    "Channel is required (no configured channels detected).",
    "Run openclaw channels add to configure one, or pass --channel <channel> after enabling a channel.",
    "Use openclaw channels list --all to see available channel ids.",
  ].join(" ");
}

function formatMultipleConfiguredChannelsMessage(configured: readonly string[]): string {
  return [
    `Channel is required when multiple channels are configured: ${configured.join(", ")}.`,
    "Pass --channel <channel> to choose one.",
  ].join(" ");
}

const CHANNEL_SELECTION_ERROR_DEDUPE_LIMIT = 1024;
// Bound process-lifetime warning state; evicted plugin/account failures may log again.
const loggedChannelSelectionErrors = createDedupeCache({
  ttlMs: 0,
  maxSize: CHANNEL_SELECTION_ERROR_DEDUPE_LIMIT,
});

function logChannelSelectionError(params: {
  pluginId: string;
  accountId: string;
  operation: "inspectAccount" | "resolveAccount" | "isConfigured";
  error: unknown;
}) {
  const message = formatErrorMessage(params.error);
  const key = `${params.pluginId}:${params.accountId}:${params.operation}:${message}`;
  if (loggedChannelSelectionErrors.check(key)) {
    return;
  }
  defaultRuntime.error?.(
    `[channel-selection] ${params.pluginId}(${params.accountId}) ${params.operation} failed: ${message}`,
  );
}

type AccountResolutionMode = "strict" | "read_only";

async function isPluginConfigured(
  plugin: ChannelPlugin,
  cfg: OpenClawConfig,
  accountResolution: AccountResolutionMode,
): Promise<boolean> {
  const accountIds = plugin.config.listAccountIds(cfg);
  for (const accountId of accountIds) {
    let operation: "inspectAccount" | "resolveAccount" = "inspectAccount";
    let account: unknown;
    try {
      if (accountResolution === "read_only") {
        const inspection = asOptionalRecord(await plugin.config.inspectAccount?.(cfg, accountId));
        if (inspection) {
          // Inspection is metadata, never input to runtime account hooks.
          if (isAccountEnabled(inspection) && inspection.configured === true) {
            return true;
          }
          continue;
        }
      }
      operation = "resolveAccount";
      account = plugin.config.resolveAccount(cfg, accountId);
    } catch (error) {
      logChannelSelectionError({
        pluginId: plugin.id,
        accountId,
        operation,
        error,
      });
      continue;
    }
    const enabled = plugin.config.isEnabled
      ? plugin.config.isEnabled(account, cfg)
      : isAccountEnabled(account);
    if (!enabled) {
      continue;
    }
    try {
      const configured = (await plugin.config.isConfigured?.(account, cfg)) ?? true;
      if (configured) {
        return true;
      }
    } catch (error) {
      logChannelSelectionError({
        pluginId: plugin.id,
        accountId,
        operation: "isConfigured",
        error,
      });
    }
  }

  return false;
}

async function listConfiguredMessageChannelPlugins(
  cfg: OpenClawConfig,
  accountResolution: AccountResolutionMode = "strict",
): Promise<ChannelPlugin[]> {
  const plugins: ChannelPlugin[] = [];
  for (const plugin of listRuntimeVisibleChannelPlugins()) {
    if (!isDeliverableMessageChannel(plugin.id)) {
      continue;
    }
    if (await isPluginConfigured(plugin, cfg, accountResolution)) {
      plugins.push(plugin);
    }
  }
  return plugins;
}

/** Lists deliverable channels with at least one enabled, configured account. */
export async function listConfiguredMessageChannels(cfg: OpenClawConfig): Promise<string[]> {
  return (await listConfiguredMessageChannelPlugins(cfg)).map((plugin) => plugin.id);
}

/** Resolves the message action channel from explicit input, context fallback, or config. */
export async function resolveMessageChannelSelection(params: {
  cfg: OpenClawConfig;
  channel?: string | null;
  fallbackChannel?: string | null;
  agentId?: string;
  // Strict callers select usable runtime accounts. Directory inspection opts in before it knows
  // which account-scoped SecretRefs to redeem.
  accountResolution?: AccountResolutionMode;
}): Promise<{
  channel: string;
  plugin: ChannelPlugin;
  configured: string[];
  source: MessageChannelSelectionSource;
}> {
  const normalized = normalizeMessageChannel(params.channel);
  if (normalized) {
    const availableExplicit = resolveAvailableKnownChannel({
      cfg: params.cfg,
      value: params.channel,
      agentId: params.agentId,
    });
    if (!availableExplicit) {
      const fallback = resolveAvailableKnownChannel({
        cfg: params.cfg,
        value: params.fallbackChannel,
        agentId: params.agentId,
      });
      if (fallback) {
        return {
          channel: fallback.channel,
          plugin: fallback.plugin,
          configured: [],
          source: "tool-context-fallback",
        };
      }
      if (!isDeliverableMessageChannel(normalized)) {
        throw new Error(formatUnknownChannelMessage({ channel: normalized }));
      }
      const repairHint = isConfiguredChannel(params.cfg, normalized)
        ? resolveMissingOfficialExternalChannelPluginRepairHint({
            config: params.cfg,
            channelId: normalized,
          })
        : null;
      if (repairHint?.channelId === normalized) {
        throw new Error(`Channel is unavailable: ${normalized}. ${repairHint.repairHint}`);
      }
      throw new Error(`Channel is unavailable: ${normalized}`);
    }
    return {
      channel: availableExplicit.channel,
      plugin: availableExplicit.plugin,
      configured: [],
      source: "explicit",
    };
  }

  const fallback = resolveAvailableKnownChannel({
    cfg: params.cfg,
    value: params.fallbackChannel,
    agentId: params.agentId,
  });
  if (fallback) {
    return {
      channel: fallback.channel,
      plugin: fallback.plugin,
      configured: [],
      source: "tool-context-fallback",
    };
  }

  const configuredPlugins = await listConfiguredMessageChannelPlugins(
    params.cfg,
    params.accountResolution,
  );
  const configured = configuredPlugins.map((plugin) => plugin.id);
  if (configuredPlugins.length === 1) {
    const plugin = expectDefined(configuredPlugins[0], "configured plugin at 0");
    return {
      channel: plugin.id,
      plugin,
      configured,
      source: "single-configured",
    };
  }
  if (configured.length === 0) {
    const repairHints = listConfiguredOfficialExternalRepairHints(params.cfg);
    if (repairHints.length > 0) {
      throw new Error(
        `Channel is required (no available channels detected). ${formatMissingOfficialExternalChannelsMessage(repairHints)}`,
      );
    }
    throw new Error(formatNoConfiguredChannelsMessage());
  }
  throw new Error(formatMultipleConfiguredChannelsMessage(configured));
}
