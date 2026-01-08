import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  loadAuthProfileStore,
} from "../../agents/auth-profiles.js";
import { withProgress } from "../../cli/progress.js";
import {
  listDiscordAccountIds,
  resolveDiscordAccount,
} from "../../discord/accounts.js";
import {
  listIMessageAccountIds,
  resolveIMessageAccount,
} from "../../imessage/accounts.js";
import {
  formatUsageReportLines,
  loadProviderUsageSummary,
} from "../../infra/provider-usage.js";
import {
  type ChatProviderId,
  listChatProviders,
} from "../../providers/registry.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
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
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
import {
  listWhatsAppAccountIds,
  resolveWhatsAppAuthDir,
} from "../../web/accounts.js";
import { webAuthExists } from "../../web/session.js";
import { formatProviderAccountLabel, requireValidConfig } from "./shared.js";

export type ProvidersListOptions = {
  json?: boolean;
  usage?: boolean;
};

const colorValue = (value: string) => {
  if (value === "none") return theme.error(value);
  if (value === "env") return theme.accent(value);
  return theme.success(value);
};

function formatEnabled(value: boolean | undefined): string {
  return value === false ? theme.error("disabled") : theme.success("enabled");
}

function formatConfigured(value: boolean): string {
  return value ? theme.success("configured") : theme.warn("not configured");
}

function formatTokenSource(source?: string): string {
  const value = source || "none";
  return `token=${colorValue(value)}`;
}

function formatSource(label: string, source?: string): string {
  const value = source || "none";
  return `${label}=${colorValue(value)}`;
}

function formatLinked(value: boolean): string {
  return value ? theme.success("linked") : theme.warn("not linked");
}

async function loadUsageWithProgress(
  runtime: RuntimeEnv,
): Promise<Awaited<ReturnType<typeof loadProviderUsageSummary>> | null> {
  try {
    return await withProgress(
      { label: "Fetching usage snapshot…", indeterminate: true, enabled: true },
      async () => await loadProviderUsageSummary(),
    );
  } catch (err) {
    runtime.error(String(err));
    return null;
  }
}

export async function providersListCommand(
  opts: ProvidersListOptions,
  runtime: RuntimeEnv = defaultRuntime,
) {
  const cfg = await requireValidConfig(runtime);
  if (!cfg) return;
  const includeUsage = opts.usage !== false;

  const accountIdsByProvider: Record<ChatProviderId, string[]> = {
    whatsapp: listWhatsAppAccountIds(cfg),
    telegram: listTelegramAccountIds(cfg),
    discord: listDiscordAccountIds(cfg),
    slack: listSlackAccountIds(cfg),
    signal: listSignalAccountIds(cfg),
    imessage: listIMessageAccountIds(cfg),
  };

  const lineBuilders: Record<
    ChatProviderId,
    (accountId: string) => Promise<string>
  > = {
    telegram: async (accountId) => {
      const account = resolveTelegramAccount({ cfg, accountId });
      const label = formatProviderAccountLabel({
        provider: "telegram",
        accountId,
        name: account.name,
        providerStyle: theme.accent,
        accountStyle: theme.heading,
      });
      return `- ${label}: ${formatConfigured(Boolean(account.token))}, ${formatTokenSource(
        account.tokenSource,
      )}, ${formatEnabled(account.enabled)}`;
    },
    whatsapp: async (accountId) => {
      const { authDir } = resolveWhatsAppAuthDir({ cfg, accountId });
      const linked = await webAuthExists(authDir);
      const name = cfg.whatsapp?.accounts?.[accountId]?.name;
      const label = formatProviderAccountLabel({
        provider: "whatsapp",
        accountId,
        name,
        providerStyle: theme.accent,
        accountStyle: theme.heading,
      });
      return `- ${label}: ${formatLinked(linked)}, ${formatEnabled(
        cfg.whatsapp?.accounts?.[accountId]?.enabled ??
          cfg.web?.enabled ??
          true,
      )}`;
    },
    discord: async (accountId) => {
      const account = resolveDiscordAccount({ cfg, accountId });
      const label = formatProviderAccountLabel({
        provider: "discord",
        accountId,
        name: account.name,
        providerStyle: theme.accent,
        accountStyle: theme.heading,
      });
      return `- ${label}: ${formatConfigured(Boolean(account.token))}, ${formatTokenSource(
        account.tokenSource,
      )}, ${formatEnabled(account.enabled)}`;
    },
    slack: async (accountId) => {
      const account = resolveSlackAccount({ cfg, accountId });
      const configured = Boolean(account.botToken && account.appToken);
      const label = formatProviderAccountLabel({
        provider: "slack",
        accountId,
        name: account.name,
        providerStyle: theme.accent,
        accountStyle: theme.heading,
      });
      return `- ${label}: ${formatConfigured(configured)}, ${formatSource(
        "bot",
        account.botTokenSource,
      )}, ${formatSource("app", account.appTokenSource)}, ${formatEnabled(
        account.enabled,
      )}`;
    },
    signal: async (accountId) => {
      const account = resolveSignalAccount({ cfg, accountId });
      const label = formatProviderAccountLabel({
        provider: "signal",
        accountId,
        name: account.name,
        providerStyle: theme.accent,
        accountStyle: theme.heading,
      });
      return `- ${label}: ${formatConfigured(account.configured)}, base=${theme.muted(
        account.baseUrl,
      )}, ${formatEnabled(account.enabled)}`;
    },
    imessage: async (accountId) => {
      const account = resolveIMessageAccount({ cfg, accountId });
      const label = formatProviderAccountLabel({
        provider: "imessage",
        accountId,
        name: account.name,
        providerStyle: theme.accent,
        accountStyle: theme.heading,
      });
      return `- ${label}: ${formatEnabled(account.enabled)}`;
    },
  };

  const authStore = loadAuthProfileStore();
  const authProfiles = Object.entries(authStore.profiles).map(
    ([profileId, profile]) => ({
      id: profileId,
      provider: profile.provider,
      type: profile.type,
      isExternal:
        profileId === CLAUDE_CLI_PROFILE_ID ||
        profileId === CODEX_CLI_PROFILE_ID,
    }),
  );
  if (opts.json) {
    const usage = includeUsage ? await loadProviderUsageSummary() : undefined;
    const payload = {
      chat: {
        whatsapp: accountIdsByProvider.whatsapp,
        telegram: accountIdsByProvider.telegram,
        discord: accountIdsByProvider.discord,
        slack: accountIdsByProvider.slack,
        signal: accountIdsByProvider.signal,
        imessage: accountIdsByProvider.imessage,
      },
      auth: authProfiles,
      ...(usage ? { usage } : {}),
    };
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }

  const lines: string[] = [];
  lines.push(theme.heading("Chat providers:"));

  for (const meta of listChatProviders()) {
    const accounts = accountIdsByProvider[meta.id];
    if (!accounts || accounts.length === 0) continue;
    for (const accountId of accounts) {
      const line = await lineBuilders[meta.id](accountId);
      lines.push(line);
    }
  }

  lines.push("");
  lines.push(theme.heading("Auth providers (OAuth + API keys):"));
  if (authProfiles.length === 0) {
    lines.push(theme.muted("- none"));
  } else {
    for (const profile of authProfiles) {
      const external = profile.isExternal ? theme.muted(" (synced)") : "";
      lines.push(
        `- ${theme.accent(profile.id)} (${theme.success(profile.type)}${external})`,
      );
    }
  }

  runtime.log(lines.join("\n"));

  if (includeUsage) {
    runtime.log("");
    const usage = await loadUsageWithProgress(runtime);
    if (usage) {
      const usageLines = formatUsageReportLines(usage);
      if (usageLines.length > 0) {
        usageLines[0] = theme.accent(usageLines[0]);
        runtime.log(usageLines.join("\n"));
      }
    }
  }

  runtime.log("");
  runtime.log(
    `Docs: ${formatDocsLink("/gateway/configuration", "gateway/configuration")}`,
  );
}
