import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { inspectChannelAccount } from "../../channels/account-inspection.js";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import {
  resolveChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "../../channels/account-summary.js";
import type { ChannelPlugin } from "../../channels/plugins/types.plugin.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";

const PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR =
  "imsg cannot access ~/Library/Messages/chat.db. Grant Full Disk Access to the Gateway/launcher process and restart Gateway.";

const redactIMessageProbeErrorMessage = (message: string): string => {
  const trimmed = message.trim();
  if (!trimmed) {
    return "";
  }
  return trimmed.replaceAll(
    /\/Users\/[^/\s]+\/Library\/Messages\/chat\.db/g,
    "~/Library/Messages/chat.db",
  );
};

export function buildNonSensitiveProbeFailure(
  channelId: string,
  probe: unknown,
): Record<string, unknown> | undefined {
  const record = asNullableRecord(probe);
  if (channelId !== "imessage" || !record || record.ok !== false) {
    return undefined;
  }
  if (typeof record.error !== "string") {
    return undefined;
  }

  // Preserve the actionable Full Disk Access failure while stripping the local
  // username path before health leaves the gateway.
  const error = redactIMessageProbeErrorMessage(record.error);
  if (
    !/\bimsg\b/i.test(error) ||
    !error.includes("~/Library/Messages/chat.db") ||
    !/\bFull Disk Access\b/i.test(error)
  ) {
    return undefined;
  }
  return { ok: false, error: PUBLIC_IMESSAGE_FULL_DISK_ACCESS_ERROR };
}

function readBooleanField(value: unknown, key: string): boolean | undefined {
  const record = asNullableRecord(value);
  if (!record) {
    return undefined;
  }
  return typeof record[key] === "boolean" ? record[key] : undefined;
}

const hasAccountValue = (account: unknown): boolean => account !== null && account !== undefined;

function resolveProbeAccountEnabled(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  account: unknown;
  diagnostics: string[];
}): boolean {
  const fallback = readBooleanField(params.account, "enabled") ?? true;
  try {
    return resolveChannelAccountEnabled({
      plugin: params.plugin,
      account: params.account,
      cfg: params.cfg,
    });
  } catch (error) {
    params.diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to evaluate enabled state (${formatErrorMessage(error)}).`,
    );
    return fallback;
  }
}

async function resolveProbeAccountConfigured(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
  account: unknown;
  diagnostics: string[];
}): Promise<boolean> {
  const fallback = readBooleanField(params.account, "configured") ?? true;
  try {
    return await resolveChannelAccountConfigured({
      plugin: params.plugin,
      account: params.account,
      cfg: params.cfg,
      readAccountConfiguredField: true,
    });
  } catch (error) {
    params.diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to evaluate configured state (${formatErrorMessage(error)}).`,
    );
    return fallback;
  }
}

export async function resolveHealthAccountContext(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accountId: string;
}): Promise<{
  probeAccount: unknown;
  inspectedAccount: unknown;
  enabled: boolean;
  configured: boolean | undefined;
  diagnostics: string[];
}> {
  const diagnostics: string[] = [];
  let inspectedAccount: unknown;
  try {
    inspectedAccount = await inspectChannelAccount(params);
  } catch (error) {
    diagnostics.push(
      `${params.plugin.id}:${params.accountId}: failed to inspect account (${formatErrorMessage(error)}).`,
    );
  }

  const inspectedEnabled = readBooleanField(inspectedAccount, "enabled");
  const inspectedConfigured = readBooleanField(inspectedAccount, "configured");
  let account: unknown;
  if (inspectedEnabled !== false && !hasConfiguredUnavailableCredentialStatus(inspectedAccount)) {
    try {
      account = params.plugin.config.resolveAccount(params.cfg, params.accountId);
    } catch (error) {
      diagnostics.push(
        `${params.plugin.id}:${params.accountId}: failed to resolve account (${formatErrorMessage(error)}).`,
      );
    }
  }

  if (!hasAccountValue(account)) {
    return {
      probeAccount: undefined,
      inspectedAccount,
      enabled: inspectedEnabled ?? false,
      configured: inspectedConfigured,
      diagnostics,
    };
  }

  const enabled = resolveProbeAccountEnabled({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
    account,
    diagnostics,
  });
  const configured = await resolveProbeAccountConfigured({
    plugin: params.plugin,
    cfg: params.cfg,
    accountId: params.accountId,
    account,
    diagnostics,
  });

  return {
    probeAccount: account,
    inspectedAccount,
    enabled,
    configured,
    diagnostics,
  };
}
