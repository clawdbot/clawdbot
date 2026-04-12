import fs from "node:fs";
import {
  hasConfiguredUnavailableCredentialStatus,
  hasResolvedCredentialValue,
} from "../../channels/account-snapshot-fields.js";
import {
  buildChannelAccountSnapshot,
  formatChannelAllowFrom,
  resolveChannelAccountConfigured,
  resolveChannelAccountEnabled,
} from "../../channels/account-summary.js";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import type {
  ChannelAccountSnapshot,
  ChannelId,
  ChannelPlugin,
} from "../../channels/plugins/types.public.js";
import { inspectReadOnlyChannelAccount } from "../../channels/read-only-account-inspect.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { sha256HexPrefix } from "../../logging/redact-identifier.js";
import { asRecord } from "../../shared/record-coerce.js";
import { normalizeOptionalString } from "../../shared/string-coerce.js";
import { formatTimeAgo } from "./format.js";

export type ChannelRow = {
  id: ChannelId;
  label: string;
  enabled: boolean;
  state: "ok" | "setup" | "warn" | "off";
  detail: string;
};

type ChannelAccountRow = {
  accountId: string;
  account: unknown;
  enabled: boolean;
  configured: boolean;
  snapshot: ChannelAccountSnapshot;
};

type ResolvedChannelAccountRowParams = {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  sourceConfig: OpenClawConfig;
  accountId: string;
};

function summarizeSources(sources: Array<string | undefined>): {
  label: string;
  parts: string[];
} {
  const counts = new Map<string, number>();
  for (const s of sources) {
    const key = s?.trim() ? s.trim() : "unknown";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const parts = [...counts.entries()]
    .toSorted((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key}${n > 1 ? `×${n}` : ""}`);
  const label = parts.length > 0 ? parts.join("+") : "unknown";
  return { label, parts };
}

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

function formatTokenHint(token: string, opts: { showSecrets: boolean }): string {
  const t = token.trim();
  if (!t) {
    return "empty";
  }
  if (!opts.showSecrets) {
    return `sha256:${sha256HexPrefix(t, 8)} · len ${t.length}`;
  }
  const head = t.slice(0, 4);
  const tail = t.slice(-4);
  if (t.length <= 10) {
    return `${t} · len ${t.length}`;
  }
  return `${head}…${tail} · len ${t.length}`;
}

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

async function resolveChannelAccountRow(
  params: ResolvedChannelAccountRowParams,
): Promise<ChannelAccountRow> {
  const { plugin, cfg, sourceConfig, accountId } = params;
  const sourceInspectedAccount = await inspectChannelAccount(plugin, sourceConfig, accountId);
  const resolvedInspectedAccount = await inspectChannelAccount(plugin, cfg, accountId);
  const resolvedInspection = resolvedInspectedAccount as {
    enabled?: boolean;
    configured?: boolean;
  } | null;
  const sourceInspection = sourceInspectedAccount as {
    enabled?: boolean;
    configured?: boolean;
  } | null;
  const resolvedAccount = resolvedInspectedAccount ?? plugin.config.resolveAccount(cfg, accountId);
  const useSourceUnavailableAccount = Boolean(
    sourceInspectedAccount &&
    hasConfiguredUnavailableCredentialStatus(sourceInspectedAccount) &&
    (!hasResolvedCredentialValue(resolvedAccount) ||
      (sourceInspection?.configured === true && resolvedInspection?.configured === false)),
  );
  const account = useSourceUnavailableAccount ? sourceInspectedAccount : resolvedAccount;
  const selectedInspection = useSourceUnavailableAccount ? sourceInspection : resolvedInspection;
  const enabled =
    selectedInspection?.enabled ?? resolveChannelAccountEnabled({ plugin, account, cfg });
  const configured =
    selectedInspection?.configured ??
    (await resolveChannelAccountConfigured({
      plugin,
      account,
      cfg,
      readAccountConfiguredField: true,
    }));
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
  linked: boolean | null;
  authAgeMs: number | null;
  selfE164: string | null;
} {
  const rec = asRecord(summary);
  const linked = typeof rec.linked === "boolean" ? rec.linked : null;
  const authAgeMs = typeof rec.authAgeMs === "number" ? rec.authAgeMs : null;
  const self = asRecord(rec.self);
  const selfE164 = typeof self.e164 === "string" && self.e164.trim() ? self.e164.trim() : null;
  return { linked, authAgeMs, selfE164 };
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

function summarizeTokenConfig(params: {
  plugin: ChannelPlugin;
  cfg: OpenClawConfig;
  accounts: ChannelAccountRow[];
  showSecrets: boolean;
}): { state: "ok" | "setup" | "warn" | null; detail: string | null } {
  const enabled = params.accounts.filter((a) => a.enabled);
  if (enabled.length === 0) {
    return { state: null, detail: null };
  }

  const accountRecs = enabled.map((a) => asRecord(a.account));
  const hasBotTokenField = accountRecs.some((r) => "botToken" in r);
  const hasAppTokenField = accountRecs.some((r) => "appToken" in r);
  const hasSigningSecretField = accountRecs.some(
    (r) => "signingSecret" in r || "signingSecretSource" in r || "signingSecretStatus" in r,
  );
  const hasTokenField = accountRecs.some((r) => "token" in r);

  if (!hasBotTokenField && !hasAppTokenField && !hasSigningSecretField && !hasTokenField) {
    return { state: null, detail: null };
  }

  const accountIsHttpMode = (rec: Record<string, unknown>) =>
    typeof rec.mode === "string" && rec.mode.trim() === "http";
  const hasCredentialAvailable = (
    rec: Record<string, unknown>,
    valueKey: string,
    statusKey: string,
  ) => {
    const value = rec[valueKey];
    if (typeof value === "string" && value.trim()) {
      return true;
    }
    return rec[statusKey] === "available";
  };

  if (
    hasBotTokenField &&
    hasSigningSecretField &&
    enabled.every((a) => accountIsHttpMode(asRecord(a.account)))
  ) {
    const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
    const ready = enabled.filter((a) => {
      const rec = asRecord(a.account);
      return (
        hasCredentialAvailable(rec, "botToken", "botTokenStatus") &&
        hasCredentialAvailable(rec, "signingSecret", "signingSecretStatus")
      );
    });
    const partial = enabled.filter((a) => {
      const rec = asRecord(a.account);
      const hasBot = hasCredentialAvailable(rec, "botToken", "botTokenStatus");
      const hasSigning = hasCredentialAvailable(rec, "signingSecret", "signingSecretStatus");
      return (hasBot && !hasSigning) || (!hasBot && hasSigning);
    });

    if (unavailable.length > 0) {
      return {
        state: "warn",
        detail: `configured http credentials unavailable in this command path · accounts ${unavailable.length}`,
      };
    }

    if (partial.length > 0) {
      return {
        state: "warn",
        detail: `partial credentials (need bot+signing) · accounts ${partial.length}`,
      };
    }

    if (ready.length === 0) {
      return { state: "setup", detail: "no credentials (need bot+signing)" };
    }

    const botSources = summarizeSources(ready.map((a) => a.snapshot.botTokenSource ?? "none"));
    const signingSources = summarizeSources(
      ready.map((a) => a.snapshot.signingSecretSource ?? "none"),
    );
    const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
    const botToken = typeof sample.botToken === "string" ? sample.botToken : "";
    const signingSecret = typeof sample.signingSecret === "string" ? sample.signingSecret : "";
    const botHint = botToken.trim()
      ? formatTokenHint(botToken, { showSecrets: params.showSecrets })
      : "";
    const signingHint = signingSecret.trim()
      ? formatTokenHint(signingSecret, { showSecrets: params.showSecrets })
      : "";
    const hint =
      botHint || signingHint ? ` (bot ${botHint || "?"}, signing ${signingHint || "?"})` : "";
    return {
      state: "ok",
      detail: `credentials ok (bot ${botSources.label}, signing ${signingSources.label})${hint} · accounts ${ready.length}/${enabled.length || 1}`,
    };
  }

  if (hasBotTokenField && hasAppTokenField) {
    const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
    const ready = enabled.filter((a) => {
      const rec = asRecord(a.account);
      const bot = normalizeOptionalString(rec.botToken) ?? "";
      const app = normalizeOptionalString(rec.appToken) ?? "";
      return Boolean(bot) && Boolean(app);
    });
    const partial = enabled.filter((a) => {
      const rec = asRecord(a.account);
      const bot = normalizeOptionalString(rec.botToken) ?? "";
      const app = normalizeOptionalString(rec.appToken) ?? "";
      const hasBot = Boolean(bot);
      const hasApp = Boolean(app);
      return (hasBot && !hasApp) || (!hasBot && hasApp);
    });

    if (partial.length > 0) {
      return {
        state: "warn",
        detail: `partial tokens (need bot+app) · accounts ${partial.length}`,
      };
    }

    if (unavailable.length > 0) {
      return {
        state: "warn",
        detail: `configured tokens unavailable in this command path · accounts ${unavailable.length}`,
      };
    }

    if (ready.length === 0) {
      return { state: "setup", detail: "no tokens (need bot+app)" };
    }

    const botSources = summarizeSources(ready.map((a) => a.snapshot.botTokenSource ?? "none"));
    const appSources = summarizeSources(ready.map((a) => a.snapshot.appTokenSource ?? "none"));

    const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
    const botToken = typeof sample.botToken === "string" ? sample.botToken : "";
    const appToken = typeof sample.appToken === "string" ? sample.appToken : "";
    const botHint = botToken.trim()
      ? formatTokenHint(botToken, { showSecrets: params.showSecrets })
      : "";
    const appHint = appToken.trim()
      ? formatTokenHint(appToken, { showSecrets: params.showSecrets })
      : "";

    const hint = botHint || appHint ? ` (bot ${botHint || "?"}, app ${appHint || "?"})` : "";
    return {
      state: "ok",
      detail: `tokens ok (bot ${botSources.label}, app ${appSources.label})${hint} · accounts ${ready.length}/${enabled.length || 1}`,
    };
  }

  if (hasBotTokenField) {
    const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
    const ready = enabled.filter((a) => {
      const rec = asRecord(a.account);
      const bot = normalizeOptionalString(rec.botToken) ?? "";
      return Boolean(bot);
    });

    if (unavailable.length > 0) {
      return {
        state: "warn",
        detail: `configured bot token unavailable in this command path · accounts ${unavailable.length}`,
      };
    }

    if (ready.length === 0) {
      return { state: "setup", detail: "no bot token" };
    }

    const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
    const botToken = typeof sample.botToken === "string" ? sample.botToken : "";
    const botHint = botToken.trim()
      ? formatTokenHint(botToken, { showSecrets: params.showSecrets })
      : "";
    const hint = botHint ? ` (${botHint})` : "";

    return {
      state: "ok",
      detail: `bot token config${hint} · accounts ${ready.length}/${enabled.length || 1}`,
    };
  }

  const unavailable = enabled.filter((a) => hasConfiguredUnavailableCredentialStatus(a.account));
  const ready = enabled.filter((a) => {
    const rec = asRecord(a.account);
    return Boolean(normalizeOptionalString(rec.token));
  });
  if (unavailable.length > 0) {
    return {
      state: "warn",
      detail: `configured token unavailable in this command path · accounts ${unavailable.length}`,
    };
  }
  if (ready.length === 0) {
    return { state: "setup", detail: "no token" };
  }

  const sources = summarizeSources(ready.map((a) => a.snapshot.tokenSource));
  const sample = ready[0]?.account ? asRecord(ready[0].account) : {};
  const token = typeof sample.token === "string" ? sample.token : "";
  const hint = token.trim()
    ? ` (${formatTokenHint(token, { showSecrets: params.showSecrets })})`
    : "";
  return {
    state: "ok",
    detail: `token ${sources.label}${hint} · accounts ${ready.length}/${enabled.length || 1}`,
  };
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

  for (const plugin of listChannelPlugins()) {
    const accountIds = plugin.config.listAccountIds(cfg);
    const defaultAccountId = resolveChannelDefaultAccountId({
      plugin,
      cfg,
      accountIds,
    });
    const resolvedAccountIds = accountIds.length > 0 ? accountIds : [defaultAccountId];

    const accounts: ChannelAccountRow[] = [];
    const sourceConfig = opts?.sourceConfig ?? cfg;
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
      plugin,
      cfg,
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
