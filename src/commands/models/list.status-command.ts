import path from "node:path";
import { resolveMoltbotAgentDir } from "../../agents/agent-paths.js";
import {
  buildAuthHealthSummary,
  DEFAULT_OAUTH_WARN_MS,
  formatRemainingShort,
} from "../../agents/auth-health.js";
import {
  ensureAuthProfileStore,
  resolveAuthStorePathForDisplay,
  resolveProfileUnusableUntilForDisplay,
} from "../../agents/auth-profiles.js";
import { resolveEnvApiKey } from "../../agents/model-auth.js";
import {
  buildModelAliasIndex,
  parseModelRef,
  resolveConfiguredModelRef,
  resolveModelRefFromString,
} from "../../agents/model-selection.js";
import { CONFIG_PATH, loadConfig } from "../../config/config.js";
import { getShellEnvAppliedKeys, shouldEnableShellEnvFallback } from "../../infra/shell-env.js";
import { withProgressTotals } from "../../cli/progress.js";
import {
  formatUsageWindowSummary,
  loadProviderUsageSummary,
  resolveUsageProviderId,
  type UsageProviderId,
} from "../../infra/provider-usage.js";
import type { RuntimeEnv } from "../../runtime.js";
import { colorize, theme } from "../../terminal/theme.js";
import { renderTable } from "../../terminal/table.js";
import { formatCliCommand } from "../../cli/command-format.js";
import { shortenHomePath } from "../../utils.js";
import { resolveProviderAuthOverview } from "./list.auth-overview.js";
import { isRich } from "./list.format.js";
import {
  describeProbeSummary,
  formatProbeLatency,
  runAuthProbes,
  sortProbeResults,
  type AuthProbeSummary,
} from "./list.probe.js";
import { DEFAULT_MODEL, DEFAULT_PROVIDER, ensureFlagCompatibility } from "./shared.js";

export async function modelsStatusCommand(
  opts: {
    json?: boolean;
    plain?: boolean;
    check?: boolean;
    probe?: boolean;
    probeProvider?: string;
    probeProfile?: string | string[];
    probeTimeout?: string;
    probeConcurrency?: string;
    probeMaxTokens?: string;
  },
  runtime: RuntimeEnv,
) {
  ensureFlagCompatibility(opts);
  if (opts.plain && opts.probe) {
    throw new Error("--probe cannot be used with --plain output.");
  }
  const cfg = loadConfig();
  const resolved = resolveConfiguredModelRef({
    cfg,
    defaultProvider: DEFAULT_PROVIDER,
    defaultModel: DEFAULT_MODEL,
  });

  const modelConfig = cfg.agents?.defaults?.model as
    | { primary?: string; fallbacks?: string[] }
    | string
    | undefined;
  const imageConfig = cfg.agents?.defaults?.imageModel as
    | { primary?: string; fallbacks?: string[] }
    | string
    | undefined;
  const rawModel =
    typeof modelConfig === "string" ? modelConfig.trim() : (modelConfig?.primary?.trim() ?? "");
  const resolvedLabel = `${resolved.provider}/${resolved.model}`;
  const defaultLabel = rawModel || resolvedLabel;
  const fallbacks = typeof modelConfig === "object" ? (modelConfig?.fallbacks ?? []) : [];
  const imageModel =
    typeof imageConfig === "string" ? imageConfig.trim() : (imageConfig?.primary?.trim() ?? "");
  const imageFallbacks = typeof imageConfig === "object" ? (imageConfig?.fallbacks ?? []) : [];
  const aliases = Object.entries(cfg.agents?.defaults?.models ?? {}).reduce<Record<string, string>>(
    (acc, [key, entry]) => {
      const alias = entry?.alias?.trim();
      if (alias) acc[alias] = key;
      return acc;
    },
    {},
  );
  const allowed = Object.keys(cfg.agents?.defaults?.models ?? {});

  const agentDir = resolveMoltbotAgentDir();
  const store = ensureAuthProfileStore();
  const modelsPath = path.join(agentDir, "models.json");

  const providersFromStore = new Set(
    Object.values(store.profiles)
      .map((profile) => profile.provider)
      .filter((p): p is string => Boolean(p)),
  );
  const providersFromConfig = new Set(
    Object.keys(cfg.models?.providers ?? {})
      .map((p) => p.trim())
      .filter(Boolean),
  );
  const providersFromModels = new Set<string>();
  const providersInUse = new Set<string>();
  for (const raw of [defaultLabel, ...fallbacks, imageModel, ...imageFallbacks, ...allowed]) {
    const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
    if (parsed?.provider) providersFromModels.add(parsed.provider);
  }
  for (const raw of [defaultLabel, ...fallbacks, imageModel, ...imageFallbacks]) {
    const parsed = parseModelRef(String(raw ?? ""), DEFAULT_PROVIDER);
    if (parsed?.provider) providersInUse.add(parsed.provider);
  }

  const providersFromEnv = new Set<string>();
  // Keep in sync with resolveEnvApiKey() mappings (we want visibility even when
  // a provider isn't currently selected in config/models).
  const envProbeProviders = [
    "anthropic",
    "github-copilot",
    "google-vertex",
    "openai",
    "google",
    "groq",
    "cerebras",
    "xai",
    "openrouter",
    "zai",
    "mistral",
    "synthetic",
  ];
  for (const provider of envProbeProviders) {
    if (resolveEnvApiKey(provider)) providersFromEnv.add(provider);
  }

  const providers = Array.from(
    new Set([
      ...providersFromStore,
      ...providersFromConfig,
      ...providersFromModels,
      ...providersFromEnv,
    ]),
  )
    .map((p) => p.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));

  const applied = getShellEnvAppliedKeys();
  const shellFallbackEnabled =
    shouldEnableShellEnvFallback(process.env) || cfg.env?.shellEnv?.enabled === true;

  const providerAuth = providers
    .map((provider) => resolveProviderAuthOverview({ provider, cfg, store, modelsPath }))
    .filter((entry) => {
      const hasAny = entry.profiles.count > 0 || Boolean(entry.env) || Boolean(entry.modelsJson);
      return hasAny;
    });
  const providerAuthMap = new Map(providerAuth.map((entry) => [entry.provider, entry]));
  const missingProvidersInUse = Array.from(providersInUse)
    .filter((provider) => !providerAuthMap.has(provider))
    .sort((a, b) => a.localeCompare(b));

  const probeProfileIds = (() => {
    if (!opts.probeProfile) return [];
    const raw = Array.isArray(opts.probeProfile) ? opts.probeProfile : [opts.probeProfile];
    return raw
      .flatMap((value) => String(value ?? "").split(","))
      .map((value) => value.trim())
      .filter(Boolean);
  })();
  const probeTimeoutMs = opts.probeTimeout ? Number(opts.probeTimeout) : 8000;
  if (!Number.isFinite(probeTimeoutMs) || probeTimeoutMs <= 0) {
    throw new Error("--probe-timeout must be a positive number (ms).");
  }
  const probeConcurrency = opts.probeConcurrency ? Number(opts.probeConcurrency) : 2;
  if (!Number.isFinite(probeConcurrency) || probeConcurrency <= 0) {
    throw new Error("--probe-concurrency must be > 0.");
  }
  const probeMaxTokens = opts.probeMaxTokens ? Number(opts.probeMaxTokens) : 8;
  if (!Number.isFinite(probeMaxTokens) || probeMaxTokens <= 0) {
    throw new Error("--probe-max-tokens must be > 0.");
  }

  const aliasIndex = buildModelAliasIndex({ cfg, defaultProvider: DEFAULT_PROVIDER });
  const rawCandidates = [
    rawModel || resolvedLabel,
    ...fallbacks,
    imageModel,
    ...imageFallbacks,
    ...allowed,
  ].filter(Boolean);
  const resolvedCandidates = rawCandidates
    .map(
      (raw) =>
        resolveModelRefFromString({
          raw: String(raw ?? ""),
          defaultProvider: DEFAULT_PROVIDER,
          aliasIndex,
        })?.ref,
    )
    .filter((ref): ref is { provider: string; model: string } => Boolean(ref));
  const modelCandidates = resolvedCandidates.map((ref) => `${ref.provider}/${ref.model}`);

  let probeSummary: AuthProbeSummary | undefined;
  if (opts.probe) {
    probeSummary = await withProgressTotals(
      { label: "Probing auth profiles…", total: 1 },
      async (update) => {
        return await runAuthProbes({
          cfg,
          providers,
          modelCandidates,
          options: {
            provider: opts.probeProvider,
            profileIds: probeProfileIds,
            timeoutMs: probeTimeoutMs,
            concurrency: probeConcurrency,
            maxTokens: probeMaxTokens,
          },
          onProgress: update,
        });
      },
    );
  }

  const providersWithOauth = providerAuth
    .filter(
      (entry) =>
        entry.profiles.oauth > 0 || entry.profiles.token > 0 || entry.env?.value === "OAuth (env)",
    )
    .map((entry) => {
      const count =
        entry.profiles.oauth + entry.profiles.token + (entry.env?.value === "OAuth (env)" ? 1 : 0);
      return `${entry.provider} (${count})`;
    });

  const authHealth = buildAuthHealthSummary({
    store,
    cfg,
    warnAfterMs: DEFAULT_OAUTH_WARN_MS,
    providers,
  });
  const oauthProfiles = authHealth.profiles.filter(
    (profile) => profile.type === "oauth" || profile.type === "token",
  );

  const unusableProfiles = (() => {
    const now = Date.now();
    const out: Array<{
      profileId: string;
      provider?: string;
      kind: "cooldown" | "disabled";
      reason?: string;
      until: number;
      remainingMs: number;
    }> = [];
    for (const profileId of Object.keys(store.usageStats ?? {})) {
      const unusableUntil = resolveProfileUnusableUntilForDisplay(store, profileId);
      if (!unusableUntil || now >= unusableUntil) continue;
      const stats = store.usageStats?.[profileId];
      const kind =
        typeof stats?.disabledUntil === "number" && now < stats.disabledUntil
          ? "disabled"
          : "cooldown";
      out.push({
        profileId,
        provider: store.profiles[profileId]?.provider,
        kind,
        reason: stats?.disabledReason,
        until: unusableUntil,
        remainingMs: unusableUntil - now,
      });
    }
    return out.sort((a, b) => a.remainingMs - b.remainingMs);
  })();

  const checkStatus = (() => {
    const hasExpiredOrMissing =
      oauthProfiles.some((profile) => ["expired", "missing"].includes(profile.status)) ||
      missingProvidersInUse.length > 0;
    const hasExpiring = oauthProfiles.some((profile) => profile.status === "expiring");
    if (hasExpiredOrMissing) return 1;
    if (hasExpiring) return 2;
    return 0;
  })();

  if (opts.json) {
    runtime.log(
      JSON.stringify(
        {
          configPath: CONFIG_PATH,
          agentDir,
          defaultModel: defaultLabel,
          resolvedDefault: resolvedLabel,
          fallbacks,
          imageModel: imageModel || null,
          imageFallbacks,
          aliases,
          allowed,
          auth: {
            storePath: resolveAuthStorePathForDisplay(),
            shellEnvFallback: {
              enabled: shellFallbackEnabled,
              appliedKeys: applied,
            },
            providersWithOAuth: providersWithOauth,
            missingProvidersInUse,
            providers: providerAuth,
            unusableProfiles,
            oauth: {
              warnAfterMs: authHealth.warnAfterMs,
              profiles: authHealth.profiles,
              providers: authHealth.providers,
            },
            probes: probeSummary,
          },
        },
        null,
        2,
      ),
    );
    if (opts.check) runtime.exit(checkStatus);
    return;
  }

  if (opts.plain) {
    runtime.log(resolvedLabel);
    if (opts.check) runtime.exit(checkStatus);
    return;
  }

  const rich = isRich(opts);
  const label = (value: string) => colorize(rich, theme.accent, value.padEnd(14));
  const displayDefault =
    rawModel && rawModel !== resolvedLabel ? `${resolvedLabel} (from ${rawModel})` : resolvedLabel;

  runtime.log(
    `${label("Config")}${colorize(rich, theme.muted, ":")} ${colorize(rich, theme.info, shortenHomePath(CONFIG_PATH))}`,
  );
  runtime.log(
    `${label("Agent dir")}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      theme.info,
      shortenHomePath(agentDir),
    )}`,
  );
  runtime.log(
    `${label("Default")}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      theme.success,
      displayDefault,
    )}`,
  );
  runtime.log(
    `${label(`Fallbacks (${fallbacks.length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      fallbacks.length ? theme.warn : theme.muted,
      fallbacks.length ? fallbacks.join(", ") : "-",
    )}`,
  );
  runtime.log(
    `${label("Image model")}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      imageModel ? theme.accentBright : theme.muted,
      imageModel || "-",
    )}`,
  );
  runtime.log(
    `${label(`Image fallbacks (${imageFallbacks.length || 0})`)}${colorize(
      rich,
      theme.muted,
      ":",
    )} ${colorize(
      rich,
      imageFallbacks.length ? theme.accentBright : theme.muted,
      imageFallbacks.length ? imageFallbacks.join(", ") : "-",
    )}`,
  );
  runtime.log(
    `${label(`Aliases (${Object.keys(aliases).length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      Object.keys(aliases).length ? theme.accent : theme.muted,
      Object.keys(aliases).length
        ? Object.entries(aliases)
            .map(([alias, target]) =>
              rich
                ? `${theme.accentDim(alias)} ${theme.muted("->")} ${theme.info(target)}`
                : `${alias} -> ${target}`,
            )
            .join(", ")
        : "-",
    )}`,
  );
  runtime.log(
    `${label(`Configured models (${allowed.length || 0})`)}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      allowed.length ? theme.info : theme.muted,
      allowed.length ? allowed.join(", ") : "all",
    )}`,
  );

  runtime.log("");
  runtime.log(colorize(rich, theme.heading, "Auth overview"));
  runtime.log(
    `${label("Auth store")}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      theme.info,
      shortenHomePath(resolveAuthStorePathForDisplay()),
    )}`,
  );
  runtime.log(
    `${label("Shell env")}${colorize(rich, theme.muted, ":")} ${colorize(
      rich,
      shellFallbackEnabled ? theme.success : theme.muted,
      shellFallbackEnabled ? "on" : "off",
    )}${applied.length ? colorize(rich, theme.muted, ` (applied: ${applied.join(", ")})`) : ""}`,
  );
  runtime.log(
    `${label(`Providers w/ OAuth/tokens (${providersWithOauth.length || 0})`)}${colorize(
      rich,
      theme.muted,
      ":",
    )} ${colorize(
      rich,
      providersWithOauth.length ? theme.info : theme.muted,
      providersWithOauth.length ? providersWithOauth.join(", ") : "-",
    )}`,
  );

  const formatKey = (key: string) => colorize(rich, theme.warn, key);
  const formatKeyValue = (key: string, value: string) =>
    `${formatKey(key)}=${colorize(rich, theme.info, value)}`;
  const formatSeparator = () => colorize(rich, theme.muted, " | ");

  for (const entry of providerAuth) {
    const separator = formatSeparator();
    const bits: string[] = [];
    bits.push(
      formatKeyValue(
        "effective",
        `${colorize(rich, theme.accentBright, entry.effective.kind)}:${colorize(
          rich,
          theme.muted,
          entry.effective.detail,
        )}`,
      ),
    );
    if (entry.profiles.count > 0) {
      bits.push(
        formatKeyValue(
          "profiles",
          `${entry.profiles.count} (oauth=${entry.profiles.oauth}, token=${entry.profiles.token}, api_key=${entry.profiles.apiKey})`,
        ),
      );
      if (entry.profiles.labels.length > 0) {
        bits.push(colorize(rich, theme.info, entry.profiles.labels.join(", ")));
      }
    }
    if (entry.env) {
      bits.push(
        formatKeyValue(
          "env",
          `${entry.env.value}${separator}${formatKeyValue("source", entry.env.source)}`,
        ),
      );
    }
    if (entry.modelsJson) {
      bits.push(
        formatKeyValue(
          "models.json",
          `${entry.modelsJson.value}${separator}${formatKeyValue("source", entry.modelsJson.source)}`,
        ),
      );
    }
    runtime.log(`- ${theme.heading(entry.provider)} ${bits.join(separator)}`);
  }

  if (missingProvidersInUse.length > 0) {
    runtime.log("");
    runtime.log(colorize(rich, theme.heading, "Missing auth"));
    for (const provider of missingProvidersInUse) {
      const hint =
        provider === "anthropic"
          ? `Run \`claude setup-token\`, then \`${formatCliCommand("moltbot models auth setup-token")}\` or \`${formatCliCommand("moltbot configure")}\`.`
          : `Run \`${formatCliCommand("moltbot configure")}\` or set an API key env var.`;
      runtime.log(`- ${theme.heading(provider)} ${hint}`);
    }
  }

  runtime.log("");
  runtime.log(colorize(rich, theme.heading, "OAuth/token status"));
  if (oauthProfiles.length === 0) {
    runtime.log(colorize(rich, theme.muted, "- none"));
  } else {
    const usageByProvider = new Map<string, string>();
    const usageProviders = Array.from(
      new Set(
        oauthProfiles
          .map((profile) => resolveUsageProviderId(profile.provider))
          .filter((provider): provider is UsageProviderId => Boolean(provider)),
      ),
    );
    if (usageProviders.length > 0) {
      try {
        const usageSummary = await loadProviderUsageSummary({
          providers: usageProviders,
          agentDir,
          timeoutMs: 3500,
        });
        for (const snapshot of usageSummary.providers) {
          const formatted = formatUsageWindowSummary(snapshot, {
            now: Date.now(),
            maxWindows: 2,
            includeResets: true,
          });
          if (formatted) {
            usageByProvider.set(snapshot.provider, formatted);
          }
        }
      } catch {
        // ignore usage failures
      }
    }

    const formatStatus = (status: string) => {
      if (status === "ok") return colorize(rich, theme.success, "ok");
      if (status === "static") return colorize(rich, theme.muted, "static");
      if (status === "expiring") return colorize(rich, theme.warn, "expiring");
      if (status === "missing") return colorize(rich, theme.warn, "unknown");
      return colorize(rich, theme.error, "expired");
    };

    const profilesByProvider = new Map<string, typeof oauthProfiles>();
    for (const profile of oauthProfiles) {
      const current = profilesByProvider.get(profile.provider);
      if (current) current.push(profile);
      else profilesByProvider.set(profile.provider, [profile]);
    }

    for (const [provider, profiles] of profilesByProvider) {
      const usageKey = resolveUsageProviderId(provider);
      const usage = usageKey ? usageByProvider.get(usageKey) : undefined;
      const usageSuffix = usage ? colorize(rich, theme.muted, ` usage: ${usage}`) : "";
      runtime.log(`- ${colorize(rich, theme.heading, provider)}${usageSuffix}`);
      for (const profile of profiles) {
        const labelText = profile.label || profile.profileId;
        const label = colorize(rich, theme.accent, labelText);
        const status = formatStatus(profile.status);
        const expiry =
          profile.status === "static"
            ? ""
            : profile.expiresAt
              ? ` expires in ${formatRemainingShort(profile.remainingMs)}`
              : " expires unknown";
        runtime.log(`  - ${label} ${status}${expiry}`);
      }
    }
  }

  if (probeSummary) {
    runtime.log("");
    runtime.log(colorize(rich, theme.heading, "Auth probes"));
    if (probeSummary.results.length === 0) {
      runtime.log(colorize(rich, theme.muted, "- none"));
    } else {
      const tableWidth = Math.max(60, (process.stdout.columns ?? 120) - 1);
      const sorted = sortProbeResults(probeSummary.results);
      const statusColor = (status: string) => {
        if (status === "ok") return theme.success;
        if (status === "rate_limit") return theme.warn;
        if (status === "timeout" || status === "billing") return theme.warn;
        if (status === "auth" || status === "format") return theme.error;
        if (status === "no_model") return theme.muted;
        return theme.muted;
      };
      const rows = sorted.map((result) => {
        const status = colorize(rich, statusColor(result.status), result.status);
        const latency = formatProbeLatency(result.latencyMs);
        const modelLabel = result.model ?? `${result.provider}/-`;
        const modeLabel = result.mode ? ` ${colorize(rich, theme.muted, `(${result.mode})`)}` : "";
        const profile = `${colorize(rich, theme.accent, result.label)}${modeLabel}`;
        const detail = result.error?.trim();
        const detailLabel = detail ? `\n${colorize(rich, theme.muted, `↳ ${detail}`)}` : "";
        const statusLabel = `${status}${colorize(rich, theme.muted, ` · ${latency}`)}${detailLabel}`;
        return {
          Model: colorize(rich, theme.heading, modelLabel),
          Profile: profile,
          Status: statusLabel,
        };
      });
      runtime.log(
        renderTable({
          width: tableWidth,
          columns: [
            { key: "Model", header: "Model", minWidth: 18 },
            { key: "Profile", header: "Profile", minWidth: 24 },
            { key: "Status", header: "Status", minWidth: 12 },
          ],
          rows,
        }).trimEnd(),
      );
      runtime.log(colorize(rich, theme.muted, describeProbeSummary(probeSummary)));
    }
  }

  if (opts.check) runtime.exit(checkStatus);
}
