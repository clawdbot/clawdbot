import {
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
} from "../channels/account-snapshot-fields.js";
import {
  buildChannelAccountSnapshot,
  formatChannelAllowFrom,
  resolveChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "../channels/account-summary.js";
import { listChannelPlugins } from "../channels/plugins/index.js";
import type { ChannelPlugin } from "../channels/plugins/types.plugin.js";
import type { ChannelAccountSnapshot } from "../channels/plugins/types.public.js";
import { inspectReadOnlyChannelAccount } from "../channels/read-only-account-inspect.js";
import { type OpenClawConfig, loadConfig } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { theme } from "../terminal/theme.js";
import { formatTimeAgo } from "./format-time/format-relative.ts";

export type ChannelSummaryOptions = {
  colorize?: boolean;
  includeAllowFrom?: boolean;
  sourceConfig?: OpenClawConfig;
};

const DEFAULT_OPTIONS: Omit<Required<ChannelSummaryOptions>, "sourceConfig"> = {
  colorize: false,
  includeAllowFrom: false,
};

type ChannelAccountEntry = {
  accountId: string;
  account: unknown;
  enabled: boolean;
  configured: boolean;
  snapshot: ChannelAccountSnapshot;
};

const formatAccountLabel = (params: { accountId: string; name?: string }) => {
  const base = params.accountId || DEFAULT_ACCOUNT_ID;
  if (params.name?.trim()) {
    return `${base} (${params.name.trim()})`;
  }
  return base;
};

const accountLine = (label: string, details: string[]) =>
  `  - ${label}${details.length ? ` (${details.join(", ")})` : ""}`;

const buildAccountDetails = (params: {
  entry: ChannelAccountEntry;
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  includeAllowFrom: boolean;
}): string[] => {
  const details: string[] = [];
  const snapshot = params.entry.snapshot;
  if (snapshot.enabled === false) {
    details.push("disabled");
  }
  if (snapshot.dmPolicy) {
    details.push(`dm:${snapshot.dmPolicy}`);
  }
  if (snapshot.tokenSource && snapshot.tokenSource !== "none") {
    details.push(`token:${snapshot.tokenSource}`);
  }
  if (snapshot.botTokenSource && snapshot.botTokenSource !== "none") {
    details.push(`bot:${snapshot.botTokenSource}`);
  }
  if (snapshot.appTokenSource && snapshot.appTokenSource !== "none") {
    details.push(`app:${snapshot.appTokenSource}`);
  }
  if (
    snapshot.signingSecretSource &&
    snapshot.signingSecretSource !== "none" /* pragma: allowlist secret */
  ) {
    details.push(`signing:${snapshot.signingSecretSource}`);
  }
  if (hasConfiguredUnavailableCredentialStatus(params.entry.account)) {
    details.push("secret unavailable in this command path");
  }
  if (snapshot.baseUrl) {
    details.push(snapshot.baseUrl);
  }
  if (snapshot.port != null) {
    details.push(`port:${snapshot.port}`);
  }
  if (snapshot.cliPath) {
    details.push(`cli:${snapshot.cliPath}`);
  }
  if (snapshot.dbPath) {
    details.push(`db:${snapshot.dbPath}`);
  }

  if (params.includeAllowFrom && snapshot.allowFrom?.length) {
    const formatted = formatChannelAllowFrom({
      plugin: params.plugin,
      cfg: params.cfg,
      accountId: snapshot.accountId,
      allowFrom: snapshot.allowFrom,
    }).slice(0, 2);
    if (formatted.length > 0) {
      details.push(`allow:${formatted.join(",")}`);
    }
  }
  return details;
};

async function inspectChannelAccount(
  plugin: ChannelPlugin,
  cfg: OpenClawConfig,
  accountId: string,
) {
  return (
    plugin.config.inspectAccount?.(cfg, accountId) ??
    (await inspectReadOnlyChannelAccount({
      channelId: plugin.id,
      cfg,
      accountId,
    }))
  );
}

export async function buildChannelSummary(
  cfg?: OpenClawConfig,
  options?: ChannelSummaryOptions,
): Promise<string[]> {
  const effective = cfg ?? loadConfig();
  const lines: string[] = [];
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const tint = (value: string, color?: (input: string) => string) =>
    resolved.colorize && color ? color(value) : value;
  const sourceConfig = options?.sourceConfig ?? effective;

  for (const plugin of listChannelPlugins()) {
    const accountIds = plugin.config.listAccountIds(effective);
    const defaultAccountId =
      plugin.config.defaultAccountId?.(effective) ?? accountIds[0] ?? DEFAULT_ACCOUNT_ID;
    const resolvedAccountIds = accountIds.length > 0 ? accountIds : [defaultAccountId];
    const entries: ChannelAccountEntry[] = [];

    for (const accountId of resolvedAccountIds) {
      const sourceInspectedAccount = await inspectChannelAccount(plugin, sourceConfig, accountId);
      const resolvedInspectedAccount = await inspectChannelAccount(plugin, effective, accountId);
      const resolvedInspection = resolvedInspectedAccount as {
        enabled?: boolean;
        configured?: boolean;
      } | null;
      const sourceInspection = sourceInspectedAccount as {
        enabled?: boolean;
        configured?: boolean;
      } | null;
      const resolvedAccount =
        resolvedInspectedAccount ?? plugin.config.resolveAccount(effective, accountId);
      const useSourceUnavailableAccount = Boolean(
        sourceInspectedAccount &&
        hasConfiguredUnavailableCredentialStatus(sourceInspectedAccount) &&
        (!hasResolvedCredentialValue(resolvedAccount) ||
          (sourceInspection?.configured === true && resolvedInspection?.configured === false)),
      );
      const account = useSourceUnavailableAccount ? sourceInspectedAccount : resolvedAccount;
      const selectedInspection = useSourceUnavailableAccount
        ? sourceInspection
        : resolvedInspection;
      const enabled =
        selectedInspection?.enabled ??
        resolveChannelAccountEnabled({ plugin, account, cfg: effective });
      const configured =
        selectedInspection?.configured ??
        (await resolveChannelAccountConfigured({
          plugin,
          account,
          cfg: effective,
          readAccountConfiguredField: true,
        }));
      const snapshot = buildChannelAccountSnapshot({
        plugin,
        account,
        cfg: effective,
        accountId,
        enabled,
        configured,
      });
      entries.push({ accountId, account, enabled, configured, snapshot });
    }

    const configuredEntries = entries.filter((entry) => entry.configured);
    const anyEnabled = entries.some((entry) => entry.enabled);
    const fallbackEntry =
      entries.find((entry) => entry.accountId === defaultAccountId) ?? entries[0];
    const summary = plugin.status?.buildChannelSummary
      ? await plugin.status.buildChannelSummary({
          account: fallbackEntry?.account ?? {},
          cfg: effective,
          defaultAccountId,
          snapshot:
            fallbackEntry?.snapshot ?? ({ accountId: defaultAccountId } as ChannelAccountSnapshot),
        })
      : undefined;

    const summaryRecord = summary;
    const linked =
      summaryRecord && typeof summaryRecord.linked === "boolean" ? summaryRecord.linked : null;
    const configured =
      summaryRecord && typeof summaryRecord.configured === "boolean"
        ? summaryRecord.configured
        : configuredEntries.length > 0;

    const status = !anyEnabled
      ? "disabled"
      : linked !== null
        ? linked
          ? "linked"
          : "not linked"
        : configured
          ? "configured"
          : "not configured";

    const statusColor =
      status === "linked" || status === "configured"
        ? theme.success
        : status === "not linked"
          ? theme.error
          : theme.muted;
    const baseLabel = plugin.meta.label ?? plugin.id;
    let line = `${baseLabel}: ${status}`;

    const authAgeMs =
      summaryRecord && typeof summaryRecord.authAgeMs === "number" ? summaryRecord.authAgeMs : null;
    const self = summaryRecord?.self as { e164?: string | null } | undefined;
    if (self?.e164) {
      line += ` ${self.e164}`;
    }
    if (authAgeMs != null && authAgeMs >= 0) {
      line += ` auth ${formatTimeAgo(authAgeMs)}`;
    }

    lines.push(tint(line, statusColor));

    if (configuredEntries.length > 0) {
      for (const entry of configuredEntries) {
        const details = buildAccountDetails({
          entry,
          plugin,
          cfg: effective,
          includeAllowFrom: resolved.includeAllowFrom,
        });
        lines.push(
          accountLine(
            formatAccountLabel({
              accountId: entry.accountId,
              name: entry.snapshot.name,
            }),
            details,
          ),
        );
      }
    }
  }

  return lines;
}
