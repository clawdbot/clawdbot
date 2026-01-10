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
  configured: boolean;
  detail: string;
};

export async function buildProvidersTable(cfg: ClawdbotConfig): Promise<{
  rows: ProviderRow[];
  details: Array<{
    title: string;
    columns: string[];
    rows: Array<Record<string, string>>;
  }>;
}> {
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
    configured: waLinked,
    detail: waEnabled
      ? waLinked
        ? `linked${waSelf ? ` ${waSelf}` : ""}${waAuthAgeMs ? ` · auth ${formatAge(waAuthAgeMs)}` : ""} · accounts ${waAccounts.length || 1}`
        : "not linked"
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
          Status: account.enabled ? "OK" : "WARN",
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
  const tgConfigured = tgAccounts.some((a) => Boolean(a.token?.trim()));
  rows.push({
    provider: "Telegram",
    enabled: tgEnabled,
    configured: tgEnabled && tgConfigured,
    detail: tgEnabled
      ? tgConfigured
        ? `accounts ${tgAccounts.filter((a) => a.token?.trim()).length}`
        : "not configured"
      : "disabled",
  });

  // Discord
  const dcEnabled = cfg.discord?.enabled !== false;
  const dcAccounts = listDiscordAccountIds(cfg).map((accountId) =>
    resolveDiscordAccount({ cfg, accountId }),
  );
  const dcConfigured = dcAccounts.some((a) => Boolean(a.token?.trim()));
  rows.push({
    provider: "Discord",
    enabled: dcEnabled,
    configured: dcEnabled && dcConfigured,
    detail: dcEnabled
      ? dcConfigured
        ? `accounts ${dcAccounts.filter((a) => a.token?.trim()).length}`
        : "not configured"
      : "disabled",
  });

  // Slack
  const slEnabled = cfg.slack?.enabled !== false;
  const slAccounts = listSlackAccountIds(cfg).map((accountId) =>
    resolveSlackAccount({ cfg, accountId }),
  );
  const slConfigured = slAccounts.some(
    (a) => Boolean(a.botToken?.trim()) && Boolean(a.appToken?.trim()),
  );
  rows.push({
    provider: "Slack",
    enabled: slEnabled,
    configured: slEnabled && slConfigured,
    detail: slEnabled
      ? slConfigured
        ? `accounts ${slAccounts.filter((a) => a.botToken?.trim() && a.appToken?.trim()).length}`
        : "not configured"
      : "disabled",
  });

  // Signal
  const siEnabled = cfg.signal?.enabled !== false;
  const siAccounts = listSignalAccountIds(cfg).map((accountId) =>
    resolveSignalAccount({ cfg, accountId }),
  );
  const siConfigured = siAccounts.some((a) => a.configured);
  rows.push({
    provider: "Signal",
    enabled: siEnabled,
    configured: siEnabled && siConfigured,
    detail: siEnabled
      ? siConfigured
        ? `accounts ${siAccounts.filter((a) => a.configured).length}`
        : "not configured"
      : "disabled",
  });

  // iMessage
  const imEnabled = cfg.imessage?.enabled !== false;
  const imAccounts = listIMessageAccountIds(cfg).map((accountId) =>
    resolveIMessageAccount({ cfg, accountId }),
  );
  const imConfigured = imAccounts.some((a) => a.configured);
  rows.push({
    provider: "iMessage",
    enabled: imEnabled,
    configured: imEnabled && imConfigured,
    detail: imEnabled
      ? imConfigured
        ? `accounts ${imAccounts.length}`
        : "not configured"
      : "disabled",
  });

  // MS Teams
  const msEnabled = cfg.msteams?.enabled !== false;
  const msConfigured = Boolean(resolveMSTeamsCredentials(cfg.msteams));
  rows.push({
    provider: "MS Teams",
    enabled: msEnabled,
    configured: msEnabled && msConfigured,
    detail: msEnabled
      ? msConfigured
        ? "credentials present"
        : "not configured"
      : "disabled",
  });

  return {
    rows,
    details,
  };
}
