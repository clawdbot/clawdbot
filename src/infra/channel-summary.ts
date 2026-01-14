import { listChannelPlugins } from "../channels/plugins/index.js";
import type {
  ChannelAccountSnapshot,
  ChannelPlugin,
} from "../channels/plugins/types.js";
import { type ClawdbotConfig, loadConfig } from "../config/config.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import { theme } from "../terminal/theme.js";

export type ChannelSummaryOptions = {
  colorize?: boolean;
  includeAllowFrom?: boolean;
};

const DEFAULT_OPTIONS: Required<ChannelSummaryOptions> = {
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
  if (params.name?.trim()) return `${base} (${params.name.trim()})`;
  return base;
};

const accountLine = (label: string, details: string[]) =>
  `  - ${label}${details.length ? ` (${details.join(", ")})` : ""}`;

const resolveAccountEnabled = (
  plugin: ChannelPlugin,
  account: unknown,
  cfg: ClawdbotConfig,
): boolean => {
  if (plugin.config.isEnabled) {
    return plugin.config.isEnabled(account, cfg);
  }
  if (!account || typeof account !== "object") return true;
  const enabled = (account as { enabled?: boolean }).enabled;
  return enabled !== false;
};

const resolveAccountConfigured = async (
  plugin: ChannelPlugin,
  account: unknown,
  cfg: ClawdbotConfig,
): Promise<boolean> => {
  if (plugin.config.isConfigured) {
    return await plugin.config.isConfigured(account, cfg);
  }
  return true;
};

const buildAccountSnapshot = (params: {
  plugin: ChannelPlugin;
  account: unknown;
  cfg: ClawdbotConfig;
  accountId: string;
  enabled: boolean;
  configured: boolean;
}): ChannelAccountSnapshot => {
  const described = params.plugin.config.describeAccount
    ? params.plugin.config.describeAccount(params.account, params.cfg)
    : undefined;
  return {
    enabled: params.enabled,
    configured: params.configured,
    ...described,
    accountId: params.accountId,
  };
};

const formatAllowFrom = (params: {
  plugin: ChannelPlugin;
  cfg: ClawdbotConfig;
  accountId?: string | null;
  allowFrom: Array<string | number>;
}) => {
  if (params.plugin.config.formatAllowFrom) {
    return params.plugin.config.formatAllowFrom({
      cfg: params.cfg,
      accountId: params.accountId,
      allowFrom: params.allowFrom,
    });
  }
  return params.allowFrom.map((entry) => String(entry).trim()).filter(Boolean);
};

const buildAccountDetails = (params: {
  entry: ChannelAccountEntry;
  plugin: ChannelPlugin;
  cfg: ClawdbotConfig;
  includeAllowFrom: boolean;
}): string[] => {
  const details: string[] = [];
  const snapshot = params.entry.snapshot;
  if (snapshot.enabled === false) details.push("disabled");
  if (snapshot.dmPolicy) details.push(`dm:${snapshot.dmPolicy}`);
  if (snapshot.tokenSource && snapshot.tokenSource !== "none") {
    details.push(`token:${snapshot.tokenSource}`);
  }
  if (snapshot.botTokenSource && snapshot.botTokenSource !== "none") {
    details.push(`bot:${snapshot.botTokenSource}`);
  }
  if (snapshot.appTokenSource && snapshot.appTokenSource !== "none") {
    details.push(`app:${snapshot.appTokenSource}`);
  }
  if (snapshot.baseUrl) details.push(snapshot.baseUrl);
  if (snapshot.port != null) details.push(`port:${snapshot.port}`);
  if (snapshot.cliPath) details.push(`cli:${snapshot.cliPath}`);
  if (snapshot.dbPath) details.push(`db:${snapshot.dbPath}`);

  if (params.includeAllowFrom && snapshot.allowFrom?.length) {
    const formatted = formatAllowFrom({
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

export async function buildChannelSummary(
  cfg?: ClawdbotConfig,
  options?: ChannelSummaryOptions,
): Promise<string[]> {
  const effective = cfg ?? loadConfig();
  const lines: string[] = [];
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const tint = (value: string, color?: (input: string) => string) =>
    resolved.colorize && color ? color(value) : value;

  for (const plugin of listChannelPlugins()) {
    const accountIds = plugin.config.listAccountIds(effective);
    const defaultAccountId =
      plugin.config.defaultAccountId?.(effective) ??
      accountIds[0] ??
      DEFAULT_ACCOUNT_ID;
    const resolvedAccountIds =
      accountIds.length > 0 ? accountIds : [defaultAccountId];
    const entries: ChannelAccountEntry[] = [];

    for (const accountId of resolvedAccountIds) {
      const account = plugin.config.resolveAccount(effective, accountId);
      const enabled = resolveAccountEnabled(plugin, account, effective);
      const configured = await resolveAccountConfigured(
        plugin,
        account,
        effective,
      );
      const snapshot = buildAccountSnapshot({
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
      entries.find((entry) => entry.accountId === defaultAccountId) ??
      entries[0];
    const summary = plugin.status?.buildChannelSummary
      ? await plugin.status.buildChannelSummary({
          account: fallbackEntry?.account ?? {},
          cfg: effective,
          defaultAccountId,
          snapshot:
            fallbackEntry?.snapshot ??
            ({ accountId: defaultAccountId } as ChannelAccountSnapshot),
        })
      : undefined;

    const summaryRecord = summary as Record<string, unknown> | undefined;
    const linked =
      summaryRecord && typeof summaryRecord.linked === "boolean"
        ? summaryRecord.linked
        : null;
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
      summaryRecord && typeof summaryRecord.authAgeMs === "number"
        ? summaryRecord.authAgeMs
        : null;
    const self = summaryRecord?.self as { e164?: string | null } | undefined;
    if (self?.e164) line += ` ${self.e164}`;
    if (authAgeMs != null && authAgeMs >= 0) {
      line += ` auth ${formatAge(authAgeMs)}`;
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

export function formatAge(ms: number): string {
  if (ms < 0) return "unknown";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}
