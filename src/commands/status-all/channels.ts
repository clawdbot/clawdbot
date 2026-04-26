import fs from "node:fs";
import { resolveInspectedChannelAccount } from "../../channels/account-inspection.js";
import { hasConfiguredUnavailableCredentialStatus } from "../../channels/account-snapshot-fields.js";
import {
  buildChannelAccountSnapshot,
  formatChannelAllowFrom,
} from "../../channels/account-summary.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { listReadOnlyChannelPluginsForConfig } from "../../channels/plugins/read-only.js";
import { formatChannelStatusState } from "../../channels/plugins/status-state.js";
import type {
  ChannelAccountSnapshot,
  ChannelId,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { asRecord } from "../../shared/record-coerce.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import {
  summarizeTokenConfig,
  type ChannelAccountTokenSummaryRow,
} from "./channels-token-summary.js";
import { formatTimeAgo } from "./format.js";

export type ChannelRow = {
  id: ChannelId;
  label: string;
  enabled: boolean;
  state: "ok" | "setup" | "warn" | "off";
  detail: string;
};

type ChannelAccountRow = ChannelAccountTokenSummaryRow & {
  accountId: string;
  configured: boolean;
};

type ResolvedChannelAccountRowParams = {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  accountId: string;
};

function existsSyncMaybe(p: string | undefined): boolean | null {
  const path = normalizeOptionalString(p) ?? "";
  if (!path) {
    return null;
  }
  try {
    return fs.existsSync(path);
  } catch {
    return null;
  }
}

async function resolveChannelAccountRow(
  params: ResolvedChannelAccountRowParams,
): Promise<ChannelAccountRow> {
  const { plugin, cfg, sourceConfig, accountId } = params;
  const { account, enabled, configured } = await resolveInspectedChannelAccount({
    plugin,
    cfg,
    sourceConfig,
    accountId,
  });
  const snapshot = buildChannelAccountSnapshot({
    plugin,
    cfg,
    accountId,
    account,
    enabled,
    configured,
  });
  return { accountId, account, enabled, configured, snapshot };
}

const formatAccountLabel = (params: { accountId: string; name?: string }) => {
  const base = params.accountId || "default";
  if (params.name?.trim()) {
    return `${base} (${params.name.trim()})`;
  }
  return base;
};

const buildAccountNotes = (params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  entry: ChannelAccountRow;
}) => {
  const { plugin, cfg, entry } = params;
  const notes: string[] = [];
  const snapshot = entry.snapshot;
  if (snapshot.enabled === false) {
    notes.push("disabled");
  }
  if (snapshot.dmPolicy) {
    notes.push(`dm:${snapshot.dmPolicy}`);
  }
  if (snapshot.tokenSource && snapshot.tokenSource !== "none") {
    notes.push(`token:${snapshot.tokenSource}`);
  }
  if (snapshot.botTokenSource && snapshot.botTokenSource !== "none") {
    notes.push(`bot:${snapshot.botTokenSource}`);
  }
  if (snapshot.appTokenSource && snapshot.appTokenSource !== "none") {
    notes.push(`app:${snapshot.appTokenSource}`);
  }
  if (
    snapshot.signingSecretSource &&
    snapshot.signingSecretSource !== "none" /* pragma: allowlist secret */
  ) {
    notes.push(`signing:${snapshot.signingSecretSource}`);
  }
  if (hasConfiguredUnavailableCredentialStatus(entry.account)) {
    notes.push("secret unavailable in this command path");
  }
  if (snapshot.baseUrl) {
    notes.push(snapshot.baseUrl);
  }
  if (snapshot.port != null) {
    notes.push(`port:${snapshot.port}`);
  }
  if (snapshot.cliPath) {
    notes.push(`cli:${snapshot.cliPath}`);
  }
  if (snapshot.dbPath) {
    notes.push(`db:${snapshot.dbPath}`);
  }

  const allowFrom =
    plugin.config.resolveAllowFrom?.({ cfg, accountId: snapshot.accountId }) ?? snapshot.allowFrom;
  if (allowFrom?.length) {
    const formatted = formatChannelAllowFrom({
      plugin,
      cfg,
      accountId: snapshot.accountId,
      allowFrom,
    }).slice(0, 3);
    if (formatted.length > 0) {
      notes.push(`allow:${formatted.join(",")}`);
    }
  }

  return notes;
};

function resolveLinkFields(summary: unknown): {
  statusState: string | null;
  linked: boolean | null;
  authAgeMs: number | null;
  selfE164: string | null;
} {
  const rec = asRecord(summary);
  const statusState = typeof rec.statusState === "string" ? rec.statusState : null;
  const linked = typeof rec.linked === "boolean" ? rec.linked : null;
  const authAgeMs = typeof rec.authAgeMs === "number" ? rec.authAgeMs : null;
  const self = asRecord(rec.self);
  const selfE164 = typeof self.e164 === "string" && self.e164.trim() ? self.e164.trim() : null;
  return { statusState, linked, authAgeMs, selfE164 };
}

function collectMissingPaths(accounts: ChannelAccountRow[]): string[] {
  const missing: string[] = [];
  for (const entry of accounts) {
    const accountRec = asRecord(entry.account);
    const snapshotRec = asRecord(entry.snapshot);
    for (const key of [
      "tokenFile",
      "botTokenFile",
      "appTokenFile",
      "cliPath",
      "dbPath",
      "authDir",
    ]) {
      const raw =
        (accountRec[key] as string | undefined) ?? (snapshotRec[key] as string | undefined);
      const ok = existsSyncMaybe(raw);
      if (ok === false) {
        missing.push(String(raw));
      }
    }
  }
  return missing;
}

// `status --all` channels table.
// Keep this generic: channel-specific rules belong in the channel plugin.
export async function buildChannelsTable(
  cfg: OpenClawConfig,
  opts?: { showSecrets?: boolean; sourceConfig?: OpenClawConfig },
): Promise<{
  rows: ChannelRow[];
  details: Array<{
    title: string;
    columns: string[];
    rows: Array<Record<string, string>>;
  }>;
}> {
  const showSecrets = opts?.showSecrets === true;
  const rows: ChannelRow[] = [];
  const details: Array<{
    title: string;
    columns: string[];
    rows: Array<Record<string, string>>;
  }> = [];

  const sourceConfig = opts?.sourceConfig ?? cfg;
  for (const plugin of listReadOnlyChannelPluginsForConfig(cfg, {
    activationSourceConfig: sourceConfig,
    includeSetupRuntimeFallback: false,
  })) {
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds,
    });
    const resolvedAccountIds = accountIds.length > 0 ? accountIds : [defaultAccountId];

    const accounts: ChannelAccountRow[] = [];
    for (const accountId of resolvedAccountIds) {
      accounts.push(
        await resolveChannelAccountRow({
          plugin,
          cfg,
          sourceConfig,
          accountId,
        }),
      );
    }

    const anyEnabled = accounts.some((a) => a.enabled);
    const enabledAccounts = accounts.filter((a) => a.enabled);
    const configuredAccounts = enabledAccounts.filter((a) => a.configured);
    const unavailableConfiguredAccounts = enabledAccounts.filter((a) =>
      hasConfiguredUnavailableCredentialStatus(a.account),
    );
    const defaultEntry = accounts.find((a) => a.accountId === defaultAccountId) ?? accounts[0];

    const summary = plugin.status?.buildChannelSummary
      ? await plugin.status.buildChannelSummary({
          account: defaultEntry?.account ?? {},
          cfg,
          defaultAccountId,
          snapshot:
            defaultEntry?.snapshot ?? ({ accountId: defaultAccountId } as ChannelAccountSnapshot),
        })
      : undefined;

    const link = resolveLinkFields(summary);
    const missingPaths = collectMissingPaths(enabledAccounts);
    const tokenSummary = summarizeTokenConfig({
      accounts,
      showSecrets,
    });

    const issues = plugin.status?.collectStatusIssues
      ? plugin.status.collectStatusIssues(accounts.map((a) => a.snapshot))
      : [];

    const label = plugin.meta.label ?? plugin.id;

    const state = (() => {
      if (!anyEnabled) {
        return "off";
      }
      if (missingPaths.length > 0) {
        return "warn";
      }
      if (issues.length > 0) {
        return "warn";
      }
      if (unavailableConfiguredAccounts.length > 0) {
        return "warn";
      }
      if (link.statusState === "unstable") {
        return "warn";
      }
      if (link.linked === false) {
        return "setup";
      }
      if (tokenSummary.state) {
        return tokenSummary.state;
      }
      if (link.linked === true) {
        return "ok";
      }
      if (configuredAccounts.length > 0) {
        return "ok";
      }
      return "setup";
    })();

    const detail = (() => {
      if (!anyEnabled) {
        if (!defaultEntry) {
          return "disabled";
        }
        return plugin.config.disabledReason?.(defaultEntry.account, cfg) ?? "disabled";
      }
      if (missingPaths.length > 0) {
        return `missing file (${missingPaths[0]})`;
      }
      if (issues.length > 0) {
        return issues[0]?.message ?? "misconfigured";
      }
      if (link.statusState) {
        if (link.statusState === "linked") {
          const extra: string[] = [];
          if (link.selfE164) {
            extra.push(link.selfE164);
          }
          if (link.authAgeMs != null && link.authAgeMs >= 0) {
            extra.push(`auth ${formatTimeAgo(link.authAgeMs)}`);
          }
          if (accounts.length > 1 || plugin.meta.forceAccountBinding) {
            extra.push(`accounts ${accounts.length || 1}`);
          }
          return extra.length > 0
            ? `${formatChannelStatusState(link.statusState)} · ${extra.join(" · ")}`
            : formatChannelStatusState(link.statusState);
        }
        return formatChannelStatusState(link.statusState);
      }

      if (link.linked !== null) {
        const base = link.linked ? "linked" : "not linked";
        const extra: string[] = [];
        if (link.linked && link.selfE164) {
          extra.push(link.selfE164);
        }
        if (link.linked && link.authAgeMs != null && link.authAgeMs >= 0) {
          extra.push(`auth ${formatTimeAgo(link.authAgeMs)}`);
        }
        if (accounts.length > 1 || plugin.meta.forceAccountBinding) {
          extra.push(`accounts ${accounts.length || 1}`);
        }
        return extra.length > 0 ? `${base} · ${extra.join(" · ")}` : base;
      }

      if (unavailableConfiguredAccounts.length > 0) {
        if (tokenSummary.detail?.includes("unavailable")) {
          return tokenSummary.detail;
        }
        return `configured credentials unavailable in this command path · accounts ${unavailableConfiguredAccounts.length}`;
      }

      if (tokenSummary.detail) {
        return tokenSummary.detail;
      }

      if (configuredAccounts.length > 0) {
        const head = "configured";
        if (accounts.length <= 1 && !plugin.meta.forceAccountBinding) {
          return head;
        }
        return `${head} · accounts ${configuredAccounts.length}/${enabledAccounts.length || 1}`;
      }

      const reason =
        defaultEntry && plugin.config.unconfiguredReason
          ? plugin.config.unconfiguredReason(defaultEntry.account, cfg)
          : null;
      return reason ?? "not configured";
    })();

    rows.push({
      id: plugin.id,
      label,
      enabled: anyEnabled,
      state,
      detail,
    });

    if (configuredAccounts.length > 0) {
      details.push({
        title: `${label} accounts`,
        columns: ["Account", "Status", "Notes"],
        rows: configuredAccounts.map((entry) => {
          const notes = buildAccountNotes({ plugin, cfg, entry });
          return {
            Account: formatAccountLabel({
              accountId: entry.accountId,
              name: entry.snapshot.name,
            }),
            Status:
              entry.enabled && !hasConfiguredUnavailableCredentialStatus(entry.account)
                ? "OK"
                : "WARN",
            Notes: notes.join(" · "),
          };
        }),
      });
    }
  }

  return {
    rows,
    details,
  };
}
