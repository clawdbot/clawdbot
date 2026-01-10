import { type ClawdbotConfig, loadConfig } from "../config/config.js";
import {
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "../discord/accounts.js";
import {
  listIMessageAccountIds,
  resolveIMessageAccount,
} from "../imessage/accounts.js";
import { resolveMSTeamsCredentials } from "../msteams/token.js";
import { DEFAULT_ACCOUNT_ID } from "../routing/session-key.js";
import {
  listSignalAccountIds,
  resolveSignalAccount,
} from "../signal/accounts.js";
import { listSlackAccountIds, resolveSlackAccount } from "../slack/accounts.js";
import {
  listTelegramAccountIds,
  resolveTelegramAccount,
} from "../telegram/accounts.js";
import { theme } from "../terminal/theme.js";
import { normalizeE164 } from "../utils.js";
import {
  listWhatsAppAccountIds,
  resolveWhatsAppAccount,
} from "../web/accounts.js";
import {
  getWebAuthAgeMs,
  readWebSelfId,
  webAuthExists,
} from "../web/session.js";

export type ProviderSummaryOptions = {
  colorize?: boolean;
  includeAllowFrom?: boolean;
};

const DEFAULT_OPTIONS: Required<ProviderSummaryOptions> = {
  colorize: false,
  includeAllowFrom: false,
};

export async function buildProviderSummary(
  cfg?: ClawdbotConfig,
  options?: ProviderSummaryOptions,
): Promise<string[]> {
  const effective = cfg ?? loadConfig();
  const lines: string[] = [];
  const resolved = { ...DEFAULT_OPTIONS, ...options };
  const tint = (value: string, color?: (input: string) => string) =>
    resolved.colorize && color ? color(value) : value;
  const formatAccountLabel = (params: { accountId: string; name?: string }) => {
    const base = params.accountId || DEFAULT_ACCOUNT_ID;
    if (params.name?.trim()) return `${base} (${params.name.trim()})`;
    return base;
  };
  const accountLine = (label: string, details: string[]) =>
    `  - ${label}${details.length ? ` (${details.join(", ")})` : ""}`;

  const webEnabled = effective.web?.enabled !== false;
  if (!webEnabled) {
    lines.push(tint("WhatsApp: disabled", theme.muted));
  } else {
    const webLinked = await webAuthExists();
    const authAgeMs = getWebAuthAgeMs();
    const authAge = authAgeMs === null ? "" : ` auth ${formatAge(authAgeMs)}`;
    const { e164 } = readWebSelfId();
    lines.push(
      webLinked
        ? tint(
            `WhatsApp: linked${e164 ? ` ${e164}` : ""}${authAge}`,
            theme.success,
          )
        : tint("WhatsApp: not linked", theme.error),
    );
    if (webLinked) {
      for (const accountId of listWhatsAppAccountIds(effective)) {
        const account = resolveWhatsAppAccount({ cfg: effective, accountId });
        const details: string[] = [];
        if (!account.enabled) details.push("disabled");
        if (account.selfChatMode) details.push("self-chat");
        const dmPolicy =
          account.dmPolicy ?? effective.whatsapp?.dmPolicy ?? "pairing";
        details.push(`dm:${dmPolicy}`);
        const allowFrom = (
          account.allowFrom ??
          effective.whatsapp?.allowFrom ??
          []
        )
          .map(normalizeE164)
          .filter(Boolean)
          .slice(0, 2);
        if (allowFrom.length > 0) {
          details.push(`allow:${allowFrom.join(",")}`);
        }
        lines.push(
          accountLine(
            formatAccountLabel({
              accountId: account.accountId,
              name: account.name,
            }),
            details,
          ),
        );
      }
    }
  }

  const telegramEnabled = effective.telegram?.enabled !== false;
  if (!telegramEnabled) {
    lines.push(tint("Telegram: disabled", theme.muted));
  } else {
    const accounts = listTelegramAccountIds(effective).map((accountId) =>
      resolveTelegramAccount({ cfg: effective, accountId }),
    );
    const configuredAccounts = accounts.filter((account) =>
      Boolean(account.token?.trim()),
    );
    const telegramConfigured = configuredAccounts.length > 0;
    lines.push(
      telegramConfigured
        ? tint("Telegram: configured", theme.success)
        : tint("Telegram: not configured", theme.muted),
    );
    if (telegramConfigured) {
      for (const account of configuredAccounts) {
        const details: string[] = [];
        if (!account.enabled) details.push("disabled");
        if (account.tokenSource && account.tokenSource !== "none") {
          details.push(`token:${account.tokenSource}`);
        }
        lines.push(
          accountLine(
            formatAccountLabel({
              accountId: account.accountId,
              name: account.name,
            }),
            details,
          ),
        );
      }
    }
  }

  const discordEnabled = effective.discord?.enabled !== false;
  if (!discordEnabled) {
    lines.push(tint("Discord: disabled", theme.muted));
  } else {
    const accounts = listDiscordAccountIds(effective).map((accountId) =>
      resolveDiscordAccount({ cfg: effective, accountId }),
    );
    const configuredAccounts = accounts.filter((account) =>
      Boolean(account.token?.trim()),
    );
    const discordConfigured = configuredAccounts.length > 0;
    lines.push(
      discordConfigured
        ? tint("Discord: configured", theme.success)
        : tint("Discord: not configured", theme.muted),
    );
    if (discordConfigured) {
      for (const account of configuredAccounts) {
        const details: string[] = [];
        if (!account.enabled) details.push("disabled");
        if (account.tokenSource && account.tokenSource !== "none") {
          details.push(`token:${account.tokenSource}`);
        }
        lines.push(
          accountLine(
            formatAccountLabel({
              accountId: account.accountId,
              name: account.name,
            }),
            details,
          ),
        );
      }
    }
  }

  const slackEnabled = effective.slack?.enabled !== false;
  if (!slackEnabled) {
    lines.push(tint("Slack: disabled", theme.muted));
  } else {
    const accounts = listSlackAccountIds(effective).map((accountId) =>
      resolveSlackAccount({ cfg: effective, accountId }),
    );
    const configuredAccounts = accounts.filter(
      (account) =>
        Boolean(account.botToken?.trim()) && Boolean(account.appToken?.trim()),
    );
    const slackConfigured = configuredAccounts.length > 0;
    lines.push(
      slackConfigured
        ? tint("Slack: configured", theme.success)
        : tint("Slack: not configured", theme.muted),
    );
    if (slackConfigured) {
      for (const account of configuredAccounts) {
        const details: string[] = [];
        if (!account.enabled) details.push("disabled");
        if (account.botTokenSource && account.botTokenSource !== "none") {
          details.push(`bot:${account.botTokenSource}`);
        }
        if (account.appTokenSource && account.appTokenSource !== "none") {
          details.push(`app:${account.appTokenSource}`);
        }
        lines.push(
          accountLine(
            formatAccountLabel({
              accountId: account.accountId,
              name: account.name,
            }),
            details,
          ),
        );
      }
    }
  }

  const signalEnabled = effective.signal?.enabled !== false;
  if (!signalEnabled) {
    lines.push(tint("Signal: disabled", theme.muted));
  } else {
    const accounts = listSignalAccountIds(effective).map((accountId) =>
      resolveSignalAccount({ cfg: effective, accountId }),
    );
    const configuredAccounts = accounts.filter((account) => account.configured);
    const signalConfigured = configuredAccounts.length > 0;
    lines.push(
      signalConfigured
        ? tint("Signal: configured", theme.success)
        : tint("Signal: not configured", theme.muted),
    );
    if (signalConfigured) {
      for (const account of configuredAccounts) {
        const details: string[] = [];
        if (!account.enabled) details.push("disabled");
        if (account.baseUrl) details.push(account.baseUrl);
        lines.push(
          accountLine(
            formatAccountLabel({
              accountId: account.accountId,
              name: account.name,
            }),
            details,
          ),
        );
      }
    }
  }

  const imessageEnabled = effective.imessage?.enabled !== false;
  if (!imessageEnabled) {
    lines.push(tint("iMessage: disabled", theme.muted));
  } else {
    const accounts = listIMessageAccountIds(effective).map((accountId) =>
      resolveIMessageAccount({ cfg: effective, accountId }),
    );
    const configuredAccounts = accounts.filter((account) =>
      Boolean(
        account.config.cliPath ||
          account.config.dbPath ||
          account.config.allowFrom ||
          account.config.service ||
          account.config.region,
      ),
    );
    const imessageConfigured = configuredAccounts.length > 0;
    lines.push(
      imessageConfigured
        ? tint("iMessage: configured", theme.success)
        : tint("iMessage: not configured", theme.muted),
    );
    if (imessageConfigured) {
      for (const account of configuredAccounts) {
        const details: string[] = [];
        if (!account.enabled) details.push("disabled");
        lines.push(
          accountLine(
            formatAccountLabel({
              accountId: account.accountId,
              name: account.name,
            }),
            details,
          ),
        );
      }
    }
  }

  if (resolved.includeAllowFrom) {
    const allowFrom = effective.whatsapp?.allowFrom?.length
      ? effective.whatsapp.allowFrom.map(normalizeE164).filter(Boolean)
      : [];
    if (allowFrom.length) {
      lines.push(tint(`AllowFrom: ${allowFrom.join(", ")}`, theme.muted));
    }
  }

  const msEnabled = effective.msteams?.enabled !== false;
  if (!msEnabled) {
    lines.push(tint("MS Teams: disabled", theme.muted));
  } else {
    const configured = Boolean(resolveMSTeamsCredentials(effective.msteams));
    lines.push(
      configured
        ? tint("MS Teams: configured", theme.success)
        : tint("MS Teams: not configured", theme.muted),
    );
    if (configured && resolved.includeAllowFrom) {
      const allowFrom = (effective.msteams?.allowFrom ?? [])
        .map((val) => val.trim())
        .filter(Boolean)
        .slice(0, 2);
      if (allowFrom.length > 0) {
        lines.push(accountLine("default", [`allow:${allowFrom.join(",")}`]));
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
