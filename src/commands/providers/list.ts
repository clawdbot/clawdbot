import {
  CLAUDE_CLI_PROFILE_ID,
  CODEX_CLI_PROFILE_ID,
  loadAuthProfileStore,
} from "../../agents/auth-profiles.js";
import { withProgress } from "../../cli/progress.js";
import {
  formatUsageReportLines,
  loadProviderUsageSummary,
} from "../../infra/provider-usage.js";
import { listProviderPlugins } from "../../providers/plugins/index.js";
import { buildProviderAccountSnapshot } from "../../providers/plugins/status.js";
import type {
  ProviderAccountSnapshot,
  ProviderPlugin,
} from "../../providers/plugins/types.js";
import { defaultRuntime, type RuntimeEnv } from "../../runtime.js";
import { formatDocsLink } from "../../terminal/links.js";
import { theme } from "../../terminal/theme.js";
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

function shouldShowConfigured(provider: ProviderPlugin): boolean {
  return provider.id !== "whatsapp" && provider.id !== "imessage";
}

function formatAccountLine(params: {
  provider: ProviderPlugin;
  snapshot: ProviderAccountSnapshot;
}): string {
  const { provider, snapshot } = params;
  const label = formatProviderAccountLabel({
    provider: provider.id,
    accountId: snapshot.accountId,
    name: snapshot.name,
    providerStyle: theme.accent,
    accountStyle: theme.heading,
  });
  const bits: string[] = [];
  if (snapshot.linked !== undefined) {
    bits.push(formatLinked(snapshot.linked));
  }
  if (
    shouldShowConfigured(provider) &&
    typeof snapshot.configured === "boolean"
  ) {
    bits.push(formatConfigured(snapshot.configured));
  }
  if (snapshot.tokenSource) {
    bits.push(formatTokenSource(snapshot.tokenSource));
  }
  if (snapshot.botTokenSource) {
    bits.push(formatSource("bot", snapshot.botTokenSource));
  }
  if (snapshot.appTokenSource) {
    bits.push(formatSource("app", snapshot.appTokenSource));
  }
  if (snapshot.baseUrl) {
    bits.push(`base=${theme.muted(snapshot.baseUrl)}`);
  }
  if (typeof snapshot.enabled === "boolean") {
    bits.push(formatEnabled(snapshot.enabled));
  }
  return `- ${label}: ${bits.join(", ")}`;
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

  const plugins = listProviderPlugins();

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
    const chat: Record<string, string[]> = {};
    for (const plugin of plugins) {
      chat[plugin.id] = plugin.config.listAccountIds(cfg);
    }
    const payload = { chat, auth: authProfiles, ...(usage ? { usage } : {}) };
    runtime.log(JSON.stringify(payload, null, 2));
    return;
  }

  const lines: string[] = [];
  lines.push(theme.heading("Chat providers:"));

  for (const plugin of plugins) {
    const accounts = plugin.config.listAccountIds(cfg);
    if (!accounts || accounts.length === 0) continue;
    for (const accountId of accounts) {
      const snapshot = await buildProviderAccountSnapshot({
        plugin,
        cfg,
        accountId,
      });
      lines.push(
        formatAccountLine({
          provider: plugin,
          snapshot,
        }),
      );
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
