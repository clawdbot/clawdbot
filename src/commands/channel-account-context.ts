import { resolveChannelDefaultAccountId } from "../channels/plugins/helpers.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { isRecord } from "../utils.js";

type ChannelDefaultAccountContext = {
  accountIds: string[];
  defaultAccountId: string;
  account: unknown;
  enabled: boolean;
  configured: boolean;
  diagnostics: string[];
  /**
   * Indicates read-only resolution was used instead of strict full-account resolution.
   * This is expected for read_only mode and does not necessarily mean an error occurred.
   */
  degraded: boolean;
};

type ChannelAccountContextMode = "strict" | "read_only";

function getBooleanField(value: unknown, key: string): boolean | undefined {
  const record = isRecord(value) ? value : null;
  if (!record) {
    return undefined;
  }
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

function formatContextDiagnostic(params: {
  commandName?: string;
  pluginId: string;
  accountId: string;
  message: string;
}): string {
  const prefix = params.commandName ? `${params.commandName}: ` : "";
  return `${prefix}channels.${params.pluginId}.accounts.${params.accountId}: ${params.message}`;
}

export async function resolveDefaultChannelAccountContext(
  plugin: ChannelPlugin,
  cfg: OpenClawConfig,
  options?: { mode?: ChannelAccountContextMode; commandName?: string },
): Promise<ChannelDefaultAccountContext> {
  const mode = options?.mode ?? "strict";
  const accountIds = plugin.config.listAccountIds(cfg);
  const defaultAccountId = resolveChannelDefaultAccountId({
    plugin,
    cfg,
    accountIds,
  });
  if (mode === "strict") {
    const account = plugin.config.resolveAccount(cfg, defaultAccountId);
    const enabled = plugin.config.isEnabled ? plugin.config.isEnabled(account, cfg) : true;
    const configured = plugin.config.isConfigured
      ? await plugin.config.isConfigured(account, cfg)
      : true;
    return {
      accountIds,
      defaultAccountId,
      account,
      enabled,
      configured,
      diagnostics: [],
      degraded: false,
    };
  }

  const diagnostics: string[] = [];
  let degraded = false;

  const inspected =
    plugin.config.inspectAccount?.(cfg, defaultAccountId) ??
    (await inspectReadOnlyChannelAccount({
      channelId: plugin.id,
      cfg,
      accountId: defaultAccountId,
    }));

  let account = inspected;
  if (!account) {
    try {
      account = plugin.config.resolveAccount(cfg, defaultAccountId);
    } catch (error) {
      degraded = true;
      diagnostics.push(
        formatContextDiagnostic({
          commandName: options?.commandName,
          pluginId: plugin.id,
          accountId: defaultAccountId,
          message: `failed to resolve account (${formatErrorMessage(error)}); skipping read-only checks.`,
        }),
      );
      return {
        accountIds,
        defaultAccountId,
        account: {},
        enabled: false,
        configured: false,
        diagnostics,
        degraded,
      };
    }
  } else {
    degraded = true;
  }

  const inspectEnabled = getBooleanField(account, "enabled");
  let enabled = inspectEnabled ?? true;
  if (inspectEnabled === undefined && plugin.config.isEnabled) {
    try {
      enabled = plugin.config.isEnabled(account, cfg);
    } catch (error) {
      degraded = true;
      enabled = false;
      diagnostics.push(
        formatContextDiagnostic({
          commandName: options?.commandName,
          pluginId: plugin.id,
          accountId: defaultAccountId,
          message: `failed to evaluate enabled state (${formatErrorMessage(error)}); treating as disabled.`,
        }),
      );
    }
  }

  const inspectConfigured = getBooleanField(account, "configured");
  let configured = inspectConfigured ?? true;
  if (inspectConfigured === undefined && plugin.config.isConfigured) {
    try {
      configured = await plugin.config.isConfigured(account, cfg);
    } catch (error) {
      degraded = true;
      configured = false;
      diagnostics.push(
        formatContextDiagnostic({
          commandName: options?.commandName,
          pluginId: plugin.id,
          accountId: defaultAccountId,
          message: `failed to evaluate configured state (${formatErrorMessage(error)}); treating as unconfigured.`,
        }),
      );
    }
  }

  return {
    accountIds,
    defaultAccountId,
    account,
    enabled,
    configured,
    diagnostics,
    degraded,
  };
}
