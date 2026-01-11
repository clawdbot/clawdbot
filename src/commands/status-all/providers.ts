import crypto from "node:crypto";
import fs from "node:fs";
import type { ClawdbotConfig } from "../../config/config.js";
import {
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "../../discord/accounts.js";
import {
  listIMessageAccountIds,
  resolveIMessageAccount,
} from "../../imessage/accounts.js";
import { resolveMSTeamsCredentials } from "../../msteams/token.js";
import {
  listSignalAccountIds,
  resolveSignalAccount,
} from "../../signal/accounts.js";
import {
  listSlackAccountIds,
  resolveSlackAccount,
} from "../../slack/accounts.js";
import {
  listTelegramAccountIds,
  resolveTelegramAccount,
} from "../../telegram/accounts.js";
import { normalizeE164 } from "../../utils.js";
import {
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
} from "../../web/accounts.js";
import {
  getWebAuthAgeMs,
  readWebSelfId,
  webAuthExists,
} from "../../web/session.js";
import { formatAge } from "./format.js";

export type ProviderRow = {
  provider: string;
  enabled: boolean;
  state: "ok" | "setup" | "warn" | "off";
  detail: string;
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

function formatTokenHint(
  token: string,
  opts: { showSecrets: boolean },
): string {
  const t = token.trim();
  if (!t) return "empty";
  if (!opts.showSecrets)
    return `sha256:${sha256HexPrefix(t)} · len ${t.length}`;
  const head = t.slice(0, 4);
  const tail = t.slice(-4);
  if (t.length <= 10) return `${t} · len ${t.length}`;
  return `${head}…${tail} · len ${t.length}`;
}

export async function buildProvidersTable(
  cfg: ClawdbotConfig,
  opts?: { showSecrets?: boolean },
): Promise<{
  rows: ProviderRow[];
  details: Array<{
    title: string;
    columns: string[];
    rows: Array<Record<string, string>>;
  }>;
}> {
  const showSecrets = opts?.showSecrets === true;
  const rows: ProviderRow[] = [];
  const details: Array<{
    title: string;
    columns: string[];
    rows: Array<Record<string, string>>;
  }> = [];

  // WhatsApp
  const waEnabled = cfg.web?.enabled !== false;
  const waLinked = waEnabled ? await webAuthExists().catch(() => false) : false;
  const waAuthAgeMs = waLinked ? getWebAuthAgeMs() : null;
  const waSelf = waLinked ? readWebSelfId().e164 : undefined;
  const waAccounts = waLinked
    ? listWhatsAppAccountIds(cfg).map((accountId) =>
        resolveWhatsAppAccount({ cfg, accountId }),
      )
    : [];
  rows.push({
    provider: "WhatsApp",
    enabled: waEnabled,
    state: !waEnabled ? "off" : waLinked ? "ok" : "setup",
    detail: waEnabled
      ? waLinked
        ? `linked${waSelf ? ` ${waSelf}` : ""}${waAuthAgeMs ? ` · auth ${formatAge(waAuthAgeMs)}` : ""} · accounts ${waAccounts.length || 1}`
        : "not linked (run clawdbot login)"
      : "disabled",
  });
  if (waLinked) {
    const waRows =
      waAccounts.length > 0 ? waAccounts : [resolveWhatsAppAccount({ cfg })];
    details.push({
      title: "WhatsApp accounts",
      columns: ["Account", "Status", "Notes"],
      rows: waRows.map((account) => {
        const allowFrom = (account.allowFrom ?? cfg.whatsapp?.allowFrom ?? [])
          .map(normalizeE164)
          .filter(Boolean)
          .slice(0, 3);
        const dmPolicy =
          account.dmPolicy ?? cfg.whatsapp?.dmPolicy ?? "pairing";
        const notes: string[] = [];
        if (!account.enabled) notes.push("disabled");
        if (account.selfChatMode) notes.push("self-chat");
        notes.push(`dm:${dmPolicy}`);
        if (allowFrom.length) notes.push(`allow:${allowFrom.join(",")}`);
        return {
          Account: account.name?.trim()
            ? `${account.accountId} (${account.name.trim()})`
            : account.accountId,
          Status: account.enabled ? "OK" : "OFF",
          Notes: notes.join(" · "),
        };
      }),
    });
  }

  // Telegram
  const tgEnabled = cfg.telegram?.enabled !== false;
  const tgAccounts = listTelegramAccountIds(cfg).map((accountId) =>
    resolveTelegramAccount({ cfg, accountId }),
  );
  const tgEnabledAccounts = tgAccounts.filter((a) => a.enabled);
  const tgTokenAccounts = tgEnabledAccounts.filter((a) => a.token?.trim());
  const tgSources = summarizeSources(tgTokenAccounts.map((a) => a.tokenSource));
  const tgSampleToken = tgTokenAccounts[0]?.token?.trim() || "";
  const tgTokenHint = tgSampleToken
    ? formatTokenHint(tgSampleToken, { showSecrets })
    : "";
  const tgMissingFiles: string[] = [];
  const tgGlobalTokenFileExists = existsSyncMaybe(cfg.telegram?.tokenFile);
  if (
    tgEnabled &&
    cfg.telegram?.tokenFile?.trim() &&
    tgGlobalTokenFileExists === false
  ) {
    tgMissingFiles.push("telegram.tokenFile");
  }
  for (const accountId of listTelegramAccountIds(cfg)) {
    const tokenFile =
      cfg.telegram?.accounts?.[accountId]?.tokenFile?.trim() || "";
    const ok = existsSyncMaybe(tokenFile);
    if (tgEnabled && tokenFile && ok === false) {
      tgMissingFiles.push(`telegram.accounts.${accountId}.tokenFile`);
    }
  }
  const tgMisconfigured = tgMissingFiles.length > 0;
  rows.push({
    provider: "Telegram",
    enabled: tgEnabled,
    state: !tgEnabled
      ? "off"
      : tgMisconfigured
        ? "warn"
        : tgTokenAccounts.length > 0
          ? "ok"
          : "setup",
    detail: tgEnabled
      ? tgMisconfigured
        ? `token file missing (${tgMissingFiles[0]})`
        : tgTokenAccounts.length > 0
          ? `bot token ${tgSources.label}${tgTokenHint ? ` (${tgTokenHint})` : ""} · accounts ${tgTokenAccounts.length}/${tgEnabledAccounts.length || 1}`
          : "no bot token (TELEGRAM_BOT_TOKEN / telegram.botToken)"
      : "disabled",
  });

  // Discord
  const dcEnabled = cfg.discord?.enabled !== false;
  const dcAccounts = listDiscordAccountIds(cfg).map((accountId) =>
    resolveDiscordAccount({ cfg, accountId }),
  );
  const dcEnabledAccounts = dcAccounts.filter((a) => a.enabled);
  const dcTokenAccounts = dcEnabledAccounts.filter((a) => a.token?.trim());
  const dcSources = summarizeSources(dcTokenAccounts.map((a) => a.tokenSource));
  const dcSampleToken = dcTokenAccounts[0]?.token?.trim() || "";
  const dcTokenHint = dcSampleToken
    ? formatTokenHint(dcSampleToken, { showSecrets })
    : "";
  rows.push({
    provider: "Discord",
    enabled: dcEnabled,
    state: !dcEnabled ? "off" : dcTokenAccounts.length > 0 ? "ok" : "setup",
    detail: dcEnabled
      ? dcTokenAccounts.length > 0
        ? `bot token ${dcSources.label}${dcTokenHint ? ` (${dcTokenHint})` : ""} · accounts ${dcTokenAccounts.length}/${dcEnabledAccounts.length || 1}`
        : "no bot token (DISCORD_BOT_TOKEN / discord.token)"
      : "disabled",
  });

  // Slack
  const slEnabled = cfg.slack?.enabled !== false;
  const slAccounts = listSlackAccountIds(cfg).map((accountId) =>
    resolveSlackAccount({ cfg, accountId }),
  );
  const slEnabledAccounts = slAccounts.filter((a) => a.enabled);
  const slReady = slEnabledAccounts.filter(
    (a) => Boolean(a.botToken?.trim()) && Boolean(a.appToken?.trim()),
  );
  const slPartial = slEnabledAccounts.filter(
    (a) =>
      (a.botToken?.trim() && !a.appToken?.trim()) ||
      (!a.botToken?.trim() && a.appToken?.trim()),
  );
  const slHasAnyToken = slEnabledAccounts.some(
    (a) => Boolean(a.botToken?.trim()) || Boolean(a.appToken?.trim()),
  );
  const slBotSources = summarizeSources(
    slReady.map((a) => a.botTokenSource ?? "none"),
  );
  const slAppSources = summarizeSources(
    slReady.map((a) => a.appTokenSource ?? "none"),
  );
  const slSample = slReady[0] ?? null;
  const slBotHint =
    slSample?.botToken?.trim() && slSample.botTokenSource !== "none"
      ? formatTokenHint(slSample.botToken, { showSecrets })
      : "";
  const slAppHint =
    slSample?.appToken?.trim() && slSample.appTokenSource !== "none"
      ? formatTokenHint(slSample.appToken, { showSecrets })
      : "";
  rows.push({
    provider: "Slack",
    enabled: slEnabled,
    state: !slEnabled
      ? "off"
      : slPartial.length > 0
        ? "warn"
        : slReady.length > 0
          ? "ok"
          : "setup",
    detail: slEnabled
      ? slPartial.length > 0
        ? `partial tokens (need bot+app) · accounts ${slPartial.length}`
        : slReady.length > 0
          ? `tokens ok (bot ${slBotSources.label}${slBotHint ? ` ${slBotHint}` : ""}, app ${slAppSources.label}${slAppHint ? ` ${slAppHint}` : ""}) · accounts ${slReady.length}/${slEnabledAccounts.length || 1}`
          : slHasAnyToken
            ? "tokens incomplete (need bot+app)"
            : "no tokens (SLACK_BOT_TOKEN + SLACK_APP_TOKEN)"
      : "disabled",
  });

  // Signal
  const siEnabled = cfg.signal?.enabled !== false;
  const siAccounts = listSignalAccountIds(cfg).map((accountId) =>
    resolveSignalAccount({ cfg, accountId }),
  );
  const siEnabledAccounts = siAccounts.filter((a) => a.enabled);
  const siConfiguredAccounts = siEnabledAccounts.filter((a) => a.configured);
  rows.push({
    provider: "Signal",
    enabled: siEnabled,
    state: !siEnabled
      ? "off"
      : siConfiguredAccounts.length > 0
        ? "ok"
        : "setup",
    detail: siEnabled
      ? siConfiguredAccounts.length > 0
        ? `configured · accounts ${siConfiguredAccounts.length}/${siEnabledAccounts.length || 1}`
        : "default config (no overrides)"
      : "disabled",
  });

  // iMessage
  const imEnabled = cfg.imessage?.enabled !== false;
  const imAccounts = listIMessageAccountIds(cfg).map((accountId) =>
    resolveIMessageAccount({ cfg, accountId }),
  );
  const imEnabledAccounts = imAccounts.filter((a) => a.enabled);
  const imConfiguredAccounts = imEnabledAccounts.filter((a) => a.configured);
  rows.push({
    provider: "iMessage",
    enabled: imEnabled,
    state: !imEnabled
      ? "off"
      : imConfiguredAccounts.length > 0
        ? "ok"
        : "setup",
    detail: imEnabled
      ? imConfiguredAccounts.length > 0
        ? `configured · accounts ${imConfiguredAccounts.length}/${imEnabledAccounts.length || 1}`
        : "default config (no overrides)"
      : "disabled",
  });

  // MS Teams
  const msEnabled = cfg.msteams?.enabled !== false;
  const msCreds = resolveMSTeamsCredentials(cfg.msteams);
  const msAppId =
    cfg.msteams?.appId?.trim() || process.env.MSTEAMS_APP_ID?.trim();
  const msAppPassword =
    cfg.msteams?.appPassword?.trim() ||
    process.env.MSTEAMS_APP_PASSWORD?.trim();
  const msTenantId =
    cfg.msteams?.tenantId?.trim() || process.env.MSTEAMS_TENANT_ID?.trim();
  const msMissing = [
    !msAppId ? "appId" : null,
    !msAppPassword ? "appPassword" : null,
    !msTenantId ? "tenantId" : null,
  ].filter(Boolean) as string[];
  const msAnyPresent = Boolean(msAppId || msAppPassword || msTenantId);
  const msPasswordHint = msAppPassword
    ? formatTokenHint(msAppPassword, { showSecrets })
    : "";
  rows.push({
    provider: "MS Teams",
    enabled: msEnabled,
    state: !msEnabled
      ? "off"
      : msCreds
        ? "ok"
        : msAnyPresent
          ? "warn"
          : "setup",
    detail: msEnabled
      ? msCreds
        ? `credentials set${msPasswordHint ? ` (password ${msPasswordHint})` : ""}`
        : msAnyPresent
          ? `credentials incomplete (missing ${msMissing.join(", ")})`
          : "no credentials (MSTEAMS_APP_ID / _PASSWORD / _TENANT_ID)"
      : "disabled",
  });

  return {
    rows,
    details,
  };
}
