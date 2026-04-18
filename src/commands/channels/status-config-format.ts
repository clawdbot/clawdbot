import {
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
} from "../../channels/account-snapshot-fields.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import {
  buildChannelAccountSnapshot,
  buildReadOnlySourceChannelAccountSnapshot,
} from "../../channels/plugins/status.js";
import type { ChannelAccountSnapshot } from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/config.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";

type ChatChannel = string;

function formatAccountLabel(params: { accountId: string; name?: string }) {
  const base = params.accountId || "default";
  if (params.name?.trim()) {
    return `${base} (${params.name.trim()})`;
  }
  return base;
}

function formatChannelAccountLabel(params: {
  channel: ChatChannel;
  accountId: string;
  name?: string;
}): string {
  const channelText =
    listChannelPlugins().find((plugin) => plugin.id === params.channel)?.meta.label ??
    params.channel;
  return `${channelText} ${formatAccountLabel({
    accountId: params.accountId,
    name: params.name,
  })}`;
}

function appendEnabledConfiguredLinkedBits(bits: string[], account: Record<string, unknown>) {
  if (typeof account.enabled === "boolean") {
    bits.push(account.enabled ? "enabled" : "disabled");
  }
  if (typeof account.configured === "boolean") {
    if (account.configured) {
      bits.push("configured");
      if (hasConfiguredUnavailableCredentialStatus(account)) {
        bits.push("secret unavailable in this command path");
      }
    } else {
      bits.push("not configured");
    }
  }
  if (typeof account.linked === "boolean") {
    bits.push(account.linked ? "linked" : "not linked");
  }
}

function appendModeBit(bits: string[], account: Record<string, unknown>) {
  if (typeof account.mode === "string" && account.mode.length > 0) {
    bits.push(`mode:${account.mode}`);
  }
}

function appendTokenSourceBits(bits: string[], account: Record<string, unknown>) {
  const appendSourceBit = (label: string, sourceKey: string, statusKey: string) => {
    const source = account[sourceKey];
    if (typeof source !== "string" || !source || source === "none") {
      return;
    }
    const status = account[statusKey];
    const unavailable = status === "configured_unavailable" ? " (unavailable)" : "";
    bits.push(`${label}:${source}${unavailable}`);
  };

  appendSourceBit("token", "tokenSource", "tokenStatus");
  appendSourceBit("bot", "botTokenSource", "botTokenStatus");
  appendSourceBit("app", "appTokenSource", "appTokenStatus");
  appendSourceBit("signing", "signingSecretSource", "signingSecretStatus");
}

function appendBaseUrlBit(bits: string[], account: Record<string, unknown>) {
  if (typeof account.baseUrl === "string" && account.baseUrl) {
    bits.push(`url:${account.baseUrl}`);
  }
}

function buildChannelAccountLine(
  provider: ChatChannel,
  account: Record<string, unknown>,
  bits: string[],
): string {
  const accountId = typeof account.accountId === "string" ? account.accountId : "default";
  const name = normalizeOptionalString(account.name) ?? "";
  const labelText = formatChannelAccountLabel({
    channel: provider,
    accountId,
    name: name || undefined,
  });
  return `- ${labelText}: ${bits.join(", ")}`;
}

export async function formatConfigChannelsStatusLines(
  cfg: OpenClawConfig,
  meta: { path?: string; mode?: "local" | "remote" },
  opts?: { sourceConfig?: OpenClawConfig },
): Promise<string[]> {
  const lines: string[] = [];
  lines.push(theme.warn("Gateway not reachable; showing config-only status."));
  if (meta.path) {
    lines.push(`Config: ${meta.path}`);
  }
  if (meta.mode) {
    lines.push(`Mode: ${meta.mode}`);
  }
  if (meta.path || meta.mode) {
    lines.push("");
  }

  const accountLines = (provider: ChatChannel, accounts: Array<Record<string, unknown>>) =>
    accounts.map((account) => {
      const bits: string[] = [];
      appendEnabledConfiguredLinkedBits(bits, account);
      appendModeBit(bits, account);
      appendTokenSourceBits(bits, account);
      appendBaseUrlBit(bits, account);
      return buildChannelAccountLine(provider, account, bits);
    });

  const plugins = listChannelPlugins();
  const sourceConfig = opts?.sourceConfig ?? cfg;
  for (const plugin of plugins) {
    const accountIds = plugin.config.listAccountIds(cfg);
    if (!accountIds.length) {
      continue;
    }
    const snapshots: ChannelAccountSnapshot[] = [];
    for (const accountId of accountIds) {
      const sourceSnapshot = await buildReadOnlySourceChannelAccountSnapshot({
        plugin,
        cfg: sourceConfig,
        accountId,
      });
      const resolvedSnapshot = await buildChannelAccountSnapshot({
        plugin,
        cfg,
        accountId,
      });
      snapshots.push(
        sourceSnapshot &&
          hasConfiguredUnavailableCredentialStatus(sourceSnapshot) &&
          (!hasResolvedCredentialValue(resolvedSnapshot) ||
            (sourceSnapshot.configured === true && resolvedSnapshot.configured === false))
          ? sourceSnapshot
          : resolvedSnapshot,
      );
    }
    if (snapshots.length > 0) {
      lines.push(...accountLines(plugin.id, snapshots));
    }
  }

  lines.push("");
  lines.push(
    `Tip: ${formatDocsLink("/cli#status", "status --deep")} adds gateway health probes to status output (requires a reachable gateway).`,
  );
  return lines;
}
