import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  CLAUDE_CLI_PROFILE_ID,
  ensureAuthProfileStore,
  listProfilesForProvider,
  resolveApiKeyForProfile,
  resolveAuthProfileOrder,
} from "../agents/auth-profiles.js";
import {
  getCustomProviderApiKey,
  resolveEnvApiKey,
} from "../agents/model-auth.js";
import { normalizeProviderId } from "../agents/model-selection.js";
import { loadConfig } from "../config/config.js";

export type UsageWindow = {
  label: string;
  usedPercent: number;
  resetAt?: number;
};

export type ProviderUsageSnapshot = {
  provider: UsageProviderId;
  displayName: string;
  windows: UsageWindow[];
  plan?: string;
  error?: string;
};

export type UsageSummary = {
  updatedAt: number;
  providers: ProviderUsageSnapshot[];
};

export type UsageProviderId =
  | "anthropic"
  | "github-copilot"
  | "google-gemini-cli"
  | "google-antigravity"
  | "openai-codex"
  | "zai";

type ClaudeUsageResponse = {
  five_hour?: { utilization?: number; resets_at?: string };
  seven_day?: { utilization?: number; resets_at?: string };
  seven_day_sonnet?: { utilization?: number };
  seven_day_opus?: { utilization?: number };
};

type ClaudeWebOrganizationsResponse = Array<{
  uuid?: string;
  name?: string;
}>;

type ClaudeWebUsageResponse = ClaudeUsageResponse;

type CopilotUsageResponse = {
  quota_snapshots?: {
    premium_interactions?: { percent_remaining?: number | null };
    chat?: { percent_remaining?: number | null };
  };
  copilot_plan?: string;
};

type GeminiUsageResponse = {
  buckets?: Array<{ modelId?: string; remainingFraction?: number }>;
};

type CodexUsageResponse = {
  rate_limit?: {
    primary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
    secondary_window?: {
      limit_window_seconds?: number;
      used_percent?: number;
      reset_at?: number;
    };
  };
  plan_type?: string;
  credits?: { balance?: number | string | null };
};

type ZaiUsageResponse = {
  success?: boolean;
  code?: number;
  msg?: string;
  data?: {
    planName?: string;
    plan?: string;
    limits?: Array<{
      type?: string;
      percentage?: number;
      unit?: number;
      number?: number;
      nextResetTime?: string;
    }>;
  };
};

type ProviderAuth = {
  provider: UsageProviderId;
  token: string;
  accountId?: string;
};

type UsageSummaryOptions = {
  now?: number;
  timeoutMs?: number;
  providers?: UsageProviderId[];
  auth?: ProviderAuth[];
  agentDir?: string;
  fetch?: typeof fetch;
};

const DEFAULT_TIMEOUT_MS = 5000;

const PROVIDER_LABELS: Record<UsageProviderId, string> = {
  anthropic: "Claude",
  "github-copilot": "Copilot",
  "google-gemini-cli": "Gemini",
  "google-antigravity": "Antigravity",
  "openai-codex": "Codex",
  zai: "z.ai",
};

const usageProviders: UsageProviderId[] = [
  "anthropic",
  "github-copilot",
  "google-gemini-cli",
  "google-antigravity",
  "openai-codex",
  "zai",
];

export function resolveUsageProviderId(
  provider?: string | null,
): UsageProviderId | undefined {
  if (!provider) return undefined;
  const normalized = normalizeProviderId(provider);
  return usageProviders.includes(normalized as UsageProviderId)
    ? (normalized as UsageProviderId)
    : undefined;
}

const ignoredErrors = new Set([
  "No credentials",
  "No token",
  "No API key",
  "Not logged in",
  "No auth",
]);

const clampPercent = (value: number) =>
  Math.max(0, Math.min(100, Number.isFinite(value) ? value : 0));

const withTimeout = async <T>(
  work: Promise<T>,
  ms: number,
  fallback: T,
): Promise<T> => {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<T>((resolve) => {
        timeout = setTimeout(() => resolve(fallback), ms);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
};

function formatResetRemaining(targetMs?: number, now?: number): string | null {
  if (!targetMs) return null;
  const base = now ?? Date.now();
  const diffMs = targetMs - base;
  if (diffMs <= 0) return "now";

  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}m`;

  const hours = Math.floor(diffMins / 60);
  const mins = diffMins % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;

  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ${hours % 24}h`;

  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
  }).format(new Date(targetMs));
}

function resolveClaudeWebSessionKey(): string | undefined {
  const direct =
    process.env.CLAUDE_AI_SESSION_KEY?.trim() ??
    process.env.CLAUDE_WEB_SESSION_KEY?.trim();
  if (direct?.startsWith("sk-ant-")) return direct;

  const cookieHeader = process.env.CLAUDE_WEB_COOKIE?.trim();
  if (!cookieHeader) return undefined;
  const stripped = cookieHeader.replace(/^cookie:\\s*/i, "");
  const match = stripped.match(/(?:^|;\\s*)sessionKey=([^;\\s]+)/i);
  const value = match?.[1]?.trim();
  return value?.startsWith("sk-ant-") ? value : undefined;
}

function pickPrimaryWindow(windows: UsageWindow[]): UsageWindow | undefined {
  if (windows.length === 0) return undefined;
  return windows.reduce((best, next) =>
    next.usedPercent > best.usedPercent ? next : best,
  );
}

function formatWindowShort(window: UsageWindow, now?: number): string {
  const remaining = clampPercent(100 - window.usedPercent);
  const reset = formatResetRemaining(window.resetAt, now);
  const resetSuffix = reset ? ` ⏱${reset}` : "";
  return `${remaining.toFixed(0)}% left (${window.label}${resetSuffix})`;
}

export function formatUsageSummaryLine(
  summary: UsageSummary,
  opts?: { now?: number; maxProviders?: number },
): string | null {
  const providers = summary.providers
    .filter((entry) => entry.windows.length > 0 && !entry.error)
    .slice(0, opts?.maxProviders ?? summary.providers.length);
  if (providers.length === 0) return null;

  const parts = providers
    .map((entry) => {
      const window = pickPrimaryWindow(entry.windows);
      if (!window) return null;
      return `${entry.displayName} ${formatWindowShort(window, opts?.now)}`;
    })
    .filter(Boolean) as string[];

  if (parts.length === 0) return null;
  return `📊 Usage: ${parts.join(" · ")}`;
}

export function formatUsageReportLines(
  summary: UsageSummary,
  opts?: { now?: number },
): string[] {
  if (summary.providers.length === 0) {
    return ["Usage: no provider usage available."];
  }

  const lines: string[] = ["Usage:"];
  for (const entry of summary.providers) {
    const planSuffix = entry.plan ? ` (${entry.plan})` : "";
    if (entry.error) {
      lines.push(`  ${entry.displayName}${planSuffix}: ${entry.error}`);
      continue;
    }
    if (entry.windows.length === 0) {
      lines.push(`  ${entry.displayName}${planSuffix}: no data`);
      continue;
    }
    lines.push(`  ${entry.displayName}${planSuffix}`);
    for (const window of entry.windows) {
      const remaining = clampPercent(100 - window.usedPercent);
      const reset = formatResetRemaining(window.resetAt, opts?.now);
      const resetSuffix = reset ? ` · resets ${reset}` : "";
      lines.push(
        `    ${window.label}: ${remaining.toFixed(0)}% left${resetSuffix}`,
      );
    }
  }
  return lines;
}

function parseGoogleToken(apiKey: string): { token: string } | null {
  if (!apiKey) return null;
  try {
    const parsed = JSON.parse(apiKey) as { token?: unknown };
    if (parsed && typeof parsed.token === "string") {
      return { token: parsed.token };
    }
  } catch {
    // ignore
  }
  return null;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function fetchClaudeUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.anthropic.com/api/oauth/usage",
    {
      headers: {
        Authorization: `Bearer ${token}`,
        "User-Agent": "clawdbot",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    let message: string | undefined;
    try {
      const data = (await res.json()) as {
        error?: { message?: unknown } | null;
      };
      const raw = data?.error?.message;
      if (typeof raw === "string" && raw.trim()) message = raw.trim();
    } catch {
      // ignore parse errors
    }

    // Claude CLI setup-token yields tokens that can be used for inference
    // but may not include user:profile scope required by the OAuth usage endpoint.
    // When a claude.ai browser sessionKey is available, fall back to the web API.
    if (
      res.status === 403 &&
      message?.includes("scope requirement user:profile")
    ) {
      const sessionKey = resolveClaudeWebSessionKey();
      if (sessionKey) {
        const web = await fetchClaudeWebUsage(sessionKey, timeoutMs, fetchFn);
        if (web) return web;
      }
    }

    const suffix = message ? `: ${message}` : "";
    return {
      provider: "anthropic",
      displayName: PROVIDER_LABELS.anthropic,
      windows: [],
      error: `HTTP ${res.status}${suffix}`,
    };
  }

  const data = (await res.json()) as ClaudeUsageResponse;
  const windows: UsageWindow[] = [];

  if (data.five_hour?.utilization !== undefined) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(data.five_hour.utilization),
      resetAt: data.five_hour.resets_at
        ? new Date(data.five_hour.resets_at).getTime()
        : undefined,
    });
  }

  if (data.seven_day?.utilization !== undefined) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(data.seven_day.utilization),
      resetAt: data.seven_day.resets_at
        ? new Date(data.seven_day.resets_at).getTime()
        : undefined,
    });
  }

  const modelWindow = data.seven_day_sonnet || data.seven_day_opus;
  if (modelWindow?.utilization !== undefined) {
    windows.push({
      label: data.seven_day_sonnet ? "Sonnet" : "Opus",
      usedPercent: clampPercent(modelWindow.utilization),
    });
  }

  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
  };
}

async function fetchClaudeWebUsage(
  sessionKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot | null> {
  const headers: Record<string, string> = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: "application/json",
  };

  const orgRes = await fetchJson(
    "https://claude.ai/api/organizations",
    { headers },
    timeoutMs,
    fetchFn,
  );
  if (!orgRes.ok) return null;

  const orgs = (await orgRes.json()) as ClaudeWebOrganizationsResponse;
  const orgId = orgs?.[0]?.uuid?.trim();
  if (!orgId) return null;

  const usageRes = await fetchJson(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { headers },
    timeoutMs,
    fetchFn,
  );
  if (!usageRes.ok) return null;

  const data = (await usageRes.json()) as ClaudeWebUsageResponse;
  const windows: UsageWindow[] = [];

  if (data.five_hour?.utilization !== undefined) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(data.five_hour.utilization),
      resetAt: data.five_hour.resets_at
        ? new Date(data.five_hour.resets_at).getTime()
        : undefined,
    });
  }

  if (data.seven_day?.utilization !== undefined) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(data.seven_day.utilization),
      resetAt: data.seven_day.resets_at
        ? new Date(data.seven_day.resets_at).getTime()
        : undefined,
    });
  }

  const modelWindow = data.seven_day_sonnet || data.seven_day_opus;
  if (modelWindow?.utilization !== undefined) {
    windows.push({
      label: data.seven_day_sonnet ? "Sonnet" : "Opus",
      usedPercent: clampPercent(modelWindow.utilization),
    });
  }

  if (windows.length === 0) return null;
  return {
    provider: "anthropic",
    displayName: PROVIDER_LABELS.anthropic,
    windows,
  };
}

async function fetchCopilotUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.github.com/copilot_internal/user",
    {
      headers: {
        Authorization: `token ${token}`,
        "Editor-Version": "vscode/1.96.2",
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "X-Github-Api-Version": "2025-04-01",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return {
      provider: "github-copilot",
      displayName: PROVIDER_LABELS["github-copilot"],
      windows: [],
      error: `HTTP ${res.status}`,
    };
  }

  const data = (await res.json()) as CopilotUsageResponse;
  const windows: UsageWindow[] = [];

  if (data.quota_snapshots?.premium_interactions) {
    const remaining =
      data.quota_snapshots.premium_interactions.percent_remaining;
    windows.push({
      label: "Premium",
      usedPercent: clampPercent(100 - (remaining ?? 0)),
    });
  }

  if (data.quota_snapshots?.chat) {
    const remaining = data.quota_snapshots.chat.percent_remaining;
    windows.push({
      label: "Chat",
      usedPercent: clampPercent(100 - (remaining ?? 0)),
    });
  }

  return {
    provider: "github-copilot",
    displayName: PROVIDER_LABELS["github-copilot"],
    windows,
    plan: data.copilot_plan,
  };
}

async function fetchGeminiUsage(
  token: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
  provider: UsageProviderId,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota",
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: "{}",
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return {
      provider,
      displayName: PROVIDER_LABELS[provider],
      windows: [],
      error: `HTTP ${res.status}`,
    };
  }

  const data = (await res.json()) as GeminiUsageResponse;
  const quotas: Record<string, number> = {};

  for (const bucket of data.buckets || []) {
    const model = bucket.modelId || "unknown";
    const frac = bucket.remainingFraction ?? 1;
    if (!quotas[model] || frac < quotas[model]) quotas[model] = frac;
  }

  const windows: UsageWindow[] = [];
  let proMin = 1;
  let flashMin = 1;
  let hasPro = false;
  let hasFlash = false;

  for (const [model, frac] of Object.entries(quotas)) {
    const lower = model.toLowerCase();
    if (lower.includes("pro")) {
      hasPro = true;
      if (frac < proMin) proMin = frac;
    }
    if (lower.includes("flash")) {
      hasFlash = true;
      if (frac < flashMin) flashMin = frac;
    }
  }

  if (hasPro) {
    windows.push({
      label: "Pro",
      usedPercent: clampPercent((1 - proMin) * 100),
    });
  }
  if (hasFlash) {
    windows.push({
      label: "Flash",
      usedPercent: clampPercent((1 - flashMin) * 100),
    });
  }

  return { provider, displayName: PROVIDER_LABELS[provider], windows };
}

async function fetchCodexUsage(
  token: string,
  accountId: string | undefined,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "User-Agent": "CodexBar",
    Accept: "application/json",
  };
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;

  const res = await fetchJson(
    "https://chatgpt.com/backend-api/wham/usage",
    { method: "GET", headers },
    timeoutMs,
    fetchFn,
  );

  if (res.status === 401 || res.status === 403) {
    return {
      provider: "openai-codex",
      displayName: PROVIDER_LABELS["openai-codex"],
      windows: [],
      error: "Token expired",
    };
  }

  if (!res.ok) {
    return {
      provider: "openai-codex",
      displayName: PROVIDER_LABELS["openai-codex"],
      windows: [],
      error: `HTTP ${res.status}`,
    };
  }

  const data = (await res.json()) as CodexUsageResponse;
  const windows: UsageWindow[] = [];

  if (data.rate_limit?.primary_window) {
    const pw = data.rate_limit.primary_window;
    const windowHours = Math.round((pw.limit_window_seconds || 10800) / 3600);
    windows.push({
      label: `${windowHours}h`,
      usedPercent: clampPercent(pw.used_percent || 0),
      resetAt: pw.reset_at ? pw.reset_at * 1000 : undefined,
    });
  }

  if (data.rate_limit?.secondary_window) {
    const sw = data.rate_limit.secondary_window;
    const windowHours = Math.round((sw.limit_window_seconds || 86400) / 3600);
    const label = windowHours >= 24 ? "Day" : `${windowHours}h`;
    windows.push({
      label,
      usedPercent: clampPercent(sw.used_percent || 0),
      resetAt: sw.reset_at ? sw.reset_at * 1000 : undefined,
    });
  }

  let plan = data.plan_type;
  if (data.credits?.balance !== undefined && data.credits.balance !== null) {
    const balance =
      typeof data.credits.balance === "number"
        ? data.credits.balance
        : parseFloat(data.credits.balance) || 0;
    plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
  }

  return {
    provider: "openai-codex",
    displayName: PROVIDER_LABELS["openai-codex"],
    windows,
    plan,
  };
}

async function fetchZaiUsage(
  apiKey: string,
  timeoutMs: number,
  fetchFn: typeof fetch,
): Promise<ProviderUsageSnapshot> {
  const res = await fetchJson(
    "https://api.z.ai/api/monitor/usage/quota/limit",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
    },
    timeoutMs,
    fetchFn,
  );

  if (!res.ok) {
    return {
      provider: "zai",
      displayName: PROVIDER_LABELS.zai,
      windows: [],
      error: `HTTP ${res.status}`,
    };
  }

  const data = (await res.json()) as ZaiUsageResponse;
  if (!data.success || data.code !== 200) {
    return {
      provider: "zai",
      displayName: PROVIDER_LABELS.zai,
      windows: [],
      error: data.msg || "API error",
    };
  }

  const windows: UsageWindow[] = [];
  const limits = data.data?.limits || [];

  for (const limit of limits) {
    const percent = clampPercent(limit.percentage || 0);
    const nextReset = limit.nextResetTime
      ? new Date(limit.nextResetTime).getTime()
      : undefined;
    let windowLabel = "Limit";
    if (limit.unit === 1) windowLabel = `${limit.number}d`;
    else if (limit.unit === 3) windowLabel = `${limit.number}h`;
    else if (limit.unit === 5) windowLabel = `${limit.number}m`;

    if (limit.type === "TOKENS_LIMIT") {
      windows.push({
        label: `Tokens (${windowLabel})`,
        usedPercent: percent,
        resetAt: nextReset,
      });
    } else if (limit.type === "TIME_LIMIT") {
      windows.push({
        label: "Monthly",
        usedPercent: percent,
        resetAt: nextReset,
      });
    }
  }

  const planName = data.data?.planName || data.data?.plan || undefined;
  return {
    provider: "zai",
    displayName: PROVIDER_LABELS.zai,
    windows,
    plan: planName,
  };
}

function resolveZaiApiKey(): string | undefined {
  const envDirect =
    process.env.ZAI_API_KEY?.trim() || process.env.Z_AI_API_KEY?.trim();
  if (envDirect) return envDirect;

  const envResolved = resolveEnvApiKey("zai");
  if (envResolved?.apiKey) return envResolved.apiKey;

  const cfg = loadConfig();
  const key =
    getCustomProviderApiKey(cfg, "zai") || getCustomProviderApiKey(cfg, "z-ai");
  if (key) return key;

  const store = ensureAuthProfileStore();
  const apiProfile = [
    ...listProfilesForProvider(store, "zai"),
    ...listProfilesForProvider(store, "z-ai"),
  ].find((id) => store.profiles[id]?.type === "api_key");
  if (apiProfile) {
    const cred = store.profiles[apiProfile];
    if (cred?.type === "api_key" && cred.key?.trim()) {
      return cred.key.trim();
    }
  }

  try {
    const authPath = path.join(os.homedir(), ".pi", "agent", "auth.json");
    if (!fs.existsSync(authPath)) return undefined;
    const data = JSON.parse(fs.readFileSync(authPath, "utf-8")) as Record<
      string,
      { access?: string }
    >;
    return data["z-ai"]?.access || data.zai?.access;
  } catch {
    return undefined;
  }
}

async function resolveOAuthToken(params: {
  provider: UsageProviderId;
  agentDir?: string;
}): Promise<ProviderAuth | null> {
  const cfg = loadConfig();
  const store = ensureAuthProfileStore(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const order = resolveAuthProfileOrder({
    cfg,
    store,
    provider: params.provider,
  });

  // Claude CLI creds are the only Anthropic tokens that reliably include the
  // `user:profile` scope required for the OAuth usage endpoint.
  const candidates =
    params.provider === "anthropic" ? [CLAUDE_CLI_PROFILE_ID, ...order] : order;
  const deduped: string[] = [];
  for (const entry of candidates) {
    if (!deduped.includes(entry)) deduped.push(entry);
  }

  for (const profileId of deduped) {
    const cred = store.profiles[profileId];
    if (!cred || (cred.type !== "oauth" && cred.type !== "token")) continue;
    try {
      const resolved = await resolveApiKeyForProfile({
        // Usage snapshots should work even if config profile metadata is stale.
        // (e.g. config says api_key but the store has a token profile.)
        cfg: undefined,
        store,
        profileId,
        agentDir: params.agentDir,
      });
      if (!resolved?.apiKey) continue;
      let token = resolved.apiKey;
      if (
        params.provider === "google-gemini-cli" ||
        params.provider === "google-antigravity"
      ) {
        const parsed = parseGoogleToken(resolved.apiKey);
        token = parsed?.token ?? resolved.apiKey;
      }
      return {
        provider: params.provider,
        token,
        accountId:
          cred.type === "oauth" && "accountId" in cred
            ? (cred as { accountId?: string }).accountId
            : undefined,
      };
    } catch {}
  }

  return null;
}

function resolveOAuthProviders(agentDir?: string): UsageProviderId[] {
  const store = ensureAuthProfileStore(agentDir, {
    allowKeychainPrompt: false,
  });
  const cfg = loadConfig();
  const providers = usageProviders.filter((provider) => provider !== "zai");
  const isOAuthLikeCredential = (id: string) => {
    const cred = store.profiles[id];
    return cred?.type === "oauth" || cred?.type === "token";
  };
  return providers.filter((provider) => {
    const profiles = listProfilesForProvider(store, provider).filter(
      isOAuthLikeCredential,
    );
    if (profiles.length > 0) return true;
    const normalized = normalizeProviderId(provider);
    const configuredProfiles = Object.entries(cfg.auth?.profiles ?? {})
      .filter(
        ([, profile]) => normalizeProviderId(profile.provider) === normalized,
      )
      .map(([id]) => id)
      .filter(isOAuthLikeCredential);
    return configuredProfiles.length > 0;
  });
}

async function resolveProviderAuths(
  opts: UsageSummaryOptions,
): Promise<ProviderAuth[]> {
  if (opts.auth) return opts.auth;

  const targetProviders = opts.providers ?? usageProviders;
  const oauthProviders = resolveOAuthProviders(opts.agentDir);
  const auths: ProviderAuth[] = [];

  for (const provider of targetProviders) {
    if (provider === "zai") {
      const apiKey = resolveZaiApiKey();
      if (apiKey) auths.push({ provider, token: apiKey });
      continue;
    }

    if (!oauthProviders.includes(provider)) continue;
    const auth = await resolveOAuthToken({ provider, agentDir: opts.agentDir });
    if (auth) auths.push(auth);
  }

  return auths;
}

export async function loadProviderUsageSummary(
  opts: UsageSummaryOptions = {},
): Promise<UsageSummary> {
  const now = opts.now ?? Date.now();
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchFn = opts.fetch ?? fetch;

  const auths = await resolveProviderAuths(opts);
  if (auths.length === 0) {
    return { updatedAt: now, providers: [] };
  }

  const tasks = auths.map((auth) =>
    withTimeout(
      (async (): Promise<ProviderUsageSnapshot> => {
        switch (auth.provider) {
          case "anthropic":
            return await fetchClaudeUsage(auth.token, timeoutMs, fetchFn);
          case "github-copilot":
            return await fetchCopilotUsage(auth.token, timeoutMs, fetchFn);
          case "google-gemini-cli":
          case "google-antigravity":
            return await fetchGeminiUsage(
              auth.token,
              timeoutMs,
              fetchFn,
              auth.provider,
            );
          case "openai-codex":
            return await fetchCodexUsage(
              auth.token,
              auth.accountId,
              timeoutMs,
              fetchFn,
            );
          case "zai":
            return await fetchZaiUsage(auth.token, timeoutMs, fetchFn);
          default:
            return {
              provider: auth.provider,
              displayName: PROVIDER_LABELS[auth.provider],
              windows: [],
              error: "Unsupported provider",
            };
        }
      })(),
      timeoutMs + 1000,
      {
        provider: auth.provider,
        displayName: PROVIDER_LABELS[auth.provider],
        windows: [],
        error: "Timeout",
      },
    ),
  );

  const snapshots = await Promise.all(tasks);
  const providers = snapshots.filter((entry) => {
    if (entry.windows.length > 0) return true;
    if (!entry.error) return true;
    return !ignoredErrors.has(entry.error);
  });

  return { updatedAt: now, providers };
}
