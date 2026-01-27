import crypto from "node:crypto";
import fs from "node:fs";
import { resolveChannelDefaultAccountId } from "../../channels/plugins/helpers.js";
import { listChannelPlugins } from "../../channels/plugins/index.js";
import type {
  ChannelAccountSnapshot,
  ChannelId,
  ChannelPlugin,
} from "../../channels/plugins/types.js";
import type { MoltbotConfig } from "../../config/config.js";
import { formatAge } from "./format.js";

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

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

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
    .sort((a, b) => b[1] - a[1])
    .map(([key, n]) => `${key}${n > 1 ? `×${n}` : ""}`);
  const label = parts.length > 0 ? parts.join("+") : "unknown";
  return { label, parts };
}

function existsSyncMaybe(p: string | undefined): boolean | null {
  const path = p?.trim() || "";
  if (!path) return null;
  try {
    return fs.existsSync(path);
  } catch {
    return null;
  }
}

function sha256HexPrefix(value: string, len = 8): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, len);
}

function formatTokenHint(token: string, opts: { showSecrets: boolean }): string {
  const t = token.trim();
  if (!t) return "empty";
  if (!opts.showSecrets) return `sha256:${sha256HexPrefix(t)} · len ${t.length}`;
  const head = t.slice(0, 4);
  const tail = t.slice(-4);
  if (t.length <= 10) return `${t} · len ${t.length}`;
  return `${head}…${tail} · len ${t.length}`;
}

const formatAccountLabel = (params: { accountId: string; name?: string }) => {
  const base = params.accountId || "default";
  if (params.name?.trim()) return `${base} (${params.name.trim()})`;
  return base;
};

const resolveAccountEnabled = (
  plugin: ChannelPlugin,
  account: unknown,
  cfg: MoltbotConfig,
): boolean => {
  if (plugin.config.isEnabled) return plugin.config.isEnabled(account, cfg);
  const enabled = asRecord(account).enabled;
  return enabled !== false;
};

const resolveAccountConfigured = async (
  plugin: ChannelPlugin,
  account: unknown,
  cfg: MoltbotConfig,
): Promise<boolean> => {
  if (plugin.config.isConfigured) {
    return await plugin.config.isConfigured(account, cfg);
  }
  const configured = asRecord(account).configured;
  return configured !== false;
};

const buildAccountSnapshot = (params: {
  plugin: ChannelPlugin;
  account: unknown;
  cfg: MoltbotConfig;
  accountId: string;
  enabled: boolean;
  configured: boolean;
}): ChannelAccountSnapshot => {
  const described = params.plugin.config.describeAccount?.(params.account, params.cfg);
  return {
    enabled: params.enabled,
    configured: params.configured,
    ...described,
    accountId: params.accountId,
  };
};

const formatAllowFrom = (params: {
  plugin: ChannelPlugin;
  cfg: MoltbotConfig;
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

const buildAccountNotes = (params: {
  plugin: ChannelPlugin;
  cfg: MoltbotConfig;
  entry: ChannelAccountRow;
}) => {
  const { plugin, cfg, entry } = params;
  const notes: string[] = [];
  const snapshot = entry.snapshot;
  if (snapshot.enabled === false) notes.push("disabled");
  if (snapshot.dmPolicy) notes.push(`dm:${snapshot.dmPolicy}`);
  if (snapshot.tokenSource && snapshot.tokenSource !== "none") {
    notes.push(`token:${snapshot.tokenSource}`);
  }
  if (snapshot.botTokenSource && snapshot.botTokenSource !== "none") {
    notes.push(`bot:${snapshot.botTokenSource}`);
  }
  if (snapshot.appTokenSource && snapshot.appTokenSource !== "none") {
    notes.push(`app:${snapshot.appTokenSource}`);
  }
  if (snapshot.baseUrl) notes.push(snapshot.baseUrl);
  if (snapshot.port != null) notes.push(`port:${snapshot.port}`);
  if (snapshot.cliPath) notes.push(`cli:${snapshot.cliPath}`);
  if (snapshot.dbPath) notes.push(`db:${snapshot.dbPath}`);

  const allowFrom =
    plugin.config.resolveAllowFrom?.({ cfg, accountId: snapshot.accountId }) ?? snapshot.allowFrom;
  if (allowFrom?.length) {
    const formatted = formatAllowFrom({
      plugin,
      cfg,
      accountId: snapshot.accountId,
      allowFrom,
    }).slice(0, 3);
    if (formatted.length > 0) notes.push(`allow:${formatted.join(",")}`);
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
      if (ok === false) missing.push(String(raw));
    }
  }
  return missing;
}

function summarizeTokenConfig(params: {
  plugin: ChannelPlugin;
  cfg: MoltbotConfig;
  accounts: ChannelAccountRow[];
  showSecrets: boolean;
}): { state: "ok" | "setup" | "warn" | null; detail: string | null } {
  const enabled = params.accounts.filter((a) => a.enabled);
  if (enabled.length === 0) return { state: null, detail: null };

  const accountRecs = enabled.map((a) => asRecord(a.account));
  const hasBotOrAppTokenFields = accountRecs.some((r) => "botToken" in r || "appToken" in r);
  const hasTokenField = accountRecs.some((r) => "token" in r);

  if (!hasBotOrAppTokenFields && !hasTokenField) {
    return { state: null, detail: null };
  }

  if (hasBotOrAppTokenFields) {
    const ready = enabled.filter((a) => {
      const rec = asRecord(a.account);
      const bot = typeof rec.botToken === "string" ? rec.botToken.trim() : "";
      const app = typeof rec.appToken === "string" ? rec.appToken.trim() : "";
      return Boolean(bot) && Boolean(app);
    });
    const partial = enabled.filter((a) => {
      const rec = asRecord(a.account);
      const bot = typeof rec.botToken === "string" ? rec.botToken.trim() : "";
      const app = typeof rec.appToken === "string" ? rec.appToken.trim() : "";
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

  const ready = enabled.filter((a) => {
    const rec = asRecord(a.account);
    return typeof rec.token === "string" ? Boolean(rec.token.trim()) : false;
  });
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
  cfg: MoltbotConfig,
  opts?: { showSecrets?: boolean },
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
    for (const accountId of resolvedAccountIds) {
      const account = plugin.config.resolveAccount(cfg, accountId);
      const enabled = resolveAccountEnabled(plugin, account, cfg);
      const configured = await resolveAccountConfigured(plugin, account, cfg);
      const snapshot = buildAccountSnapshot({
        plugin,
        cfg,
        accountId,
        account,
        enabled,
        configured,
      });
      accounts.push({ accountId, account, enabled, configured, snapshot });
    }

    const anyEnabled = accounts.some((a) => a.enabled);
    const enabledAccounts = accounts.filter((a) => a.enabled);
    const configuredAccounts = enabledAccounts.filter((a) => a.configured);
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
      if (!anyEnabled) return "off";
      if (missingPaths.length > 0) return "warn";
      if (issues.length > 0) return "warn";
      if (link.linked === false) return "setup";
      if (tokenSummary.state) return tokenSummary.state;
      if (link.linked === true) return "ok";
      if (configuredAccounts.length > 0) return "ok";
      return "setup";
    })();

    const detail = (() => {
      if (!anyEnabled) {
        if (!defaultEntry) return "disabled";
        return plugin.config.disabledReason?.(defaultEntry.account, cfg) ?? "disabled";
      }
      if (missingPaths.length > 0) return `missing file (${missingPaths[0]})`;
      if (issues.length > 0) return issues[0]?.message ?? "misconfigured";

      if (link.linked !== null) {
        const base = link.linked ? "linked" : "not linked";
        const extra: string[] = [];
        if (link.linked && link.selfE164) extra.push(link.selfE164);
        if (link.linked && link.authAgeMs != null && link.authAgeMs >= 0) {
          extra.push(`auth ${formatAge(link.authAgeMs)}`);
        }
        if (accounts.length > 1 || plugin.meta.forceAccountBinding) {
          extra.push(`accounts ${accounts.length || 1}`);
        }
        return extra.length > 0 ? `${base} · ${extra.join(" · ")}` : base;
      }

      if (tokenSummary.detail) return tokenSummary.detail;

      if (configuredAccounts.length > 0) {
        const head = "configured";
        if (accounts.length <= 1 && !plugin.meta.forceAccountBinding) return head;
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
            Status: entry.enabled !== false ? "OK" : "WARN",
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
