import type {
  ProviderFetchUsageSnapshotContext,
  ProviderResolveUsageAuthContext,
  ProviderResolvedUsageAuth,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  readClaudeCliCredentialsCached,
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";
import { readProviderJsonObjectResponse } from "openclaw/plugin-sdk/provider-http";
import {
  buildUsageHttpErrorSnapshot,
  fetchClaudeUsage,
  type ProviderUsageCostDaily,
  type ProviderUsageModelBreakdown,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";
import { CLAUDE_CLI_BACKEND_ID } from "./cli-constants.js";

const ANTHROPIC_COST_URL = "https://api.anthropic.com/v1/organizations/cost_report";
const ANTHROPIC_MESSAGES_USAGE_URL =
  "https://api.anthropic.com/v1/organizations/usage_report/messages";
const ANTHROPIC_ADMIN_TOKEN_PREFIX = "openclaw:anthropic-admin:v1:";
const ANTHROPIC_USAGE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const ANTHROPIC_USAGE_HISTORY_DAYS = 30;
const MAX_PAGES = 100;

type AnthropicUsagePage = {
  data: unknown[];
  hasMore: boolean;
  nextPage?: string;
};

type DailyAccumulator = ProviderUsageCostDaily & {
  categories: Map<string, number>;
  models: Map<string, ProviderUsageModelBreakdown>;
};

function cleanCredential(raw: string | undefined): string | undefined {
  const trimmed = raw?.replaceAll(/[\r\n]/g, "").trim();
  if (!trimmed) {
    return undefined;
  }
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"));
  const cleaned = quoted ? trimmed.slice(1, -1).trim() : trimmed;
  return cleaned || undefined;
}

function normalizeAdminKey(raw: string | undefined): string | undefined {
  const cleaned = cleanCredential(raw);
  if (!cleaned) {
    return undefined;
  }
  const withoutBearer = cleaned.toLowerCase().startsWith("bearer ")
    ? cleaned.slice("bearer ".length).trim()
    : cleaned;
  return withoutBearer.toLowerCase().startsWith("sk-ant-admin") ? withoutBearer : undefined;
}

function encodeAdminToken(token: string): string {
  return `${ANTHROPIC_ADMIN_TOKEN_PREFIX}${JSON.stringify({ token })}`;
}

function decodeAdminToken(raw: string): string | undefined {
  if (!raw.startsWith(ANTHROPIC_ADMIN_TOKEN_PREFIX)) {
    return undefined;
  }
  try {
    const value = JSON.parse(raw.slice(ANTHROPIC_ADMIN_TOKEN_PREFIX.length)) as unknown;
    const token = objectRecord(value)?.token;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function nonNegativeInteger(value: unknown): number {
  const parsed = finiteNumber(value);
  return parsed === undefined ? 0 : Math.max(0, Math.trunc(parsed));
}

function displayName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function utcDay(value: string): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
}

function emptyDaily(date: string): DailyAccumulator {
  return {
    date,
    amount: 0,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    categories: new Map(),
    models: new Map(),
  };
}

function resolveDailyRange(now: number, periodDays: number) {
  const current = new Date(now);
  const todayStart = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
  );
  return {
    startingAt: new Date(todayStart - (periodDays - 1) * 86_400_000).toISOString(),
    endingAt: new Date(todayStart + 86_400_000).toISOString(),
  };
}

async function readPage(response: Response, timeoutMs: number): Promise<AnthropicUsagePage> {
  const payload = await readProviderJsonObjectResponse(response, "Anthropic usage", {
    maxBytes: ANTHROPIC_USAGE_RESPONSE_MAX_BYTES,
    chunkTimeoutMs: timeoutMs,
    onIdleTimeout: ({ chunkTimeoutMs }) =>
      new Error(`Anthropic usage response stalled for ${chunkTimeoutMs}ms`),
  });
  if (!Array.isArray(payload.data)) {
    throw new Error("Anthropic usage response is not an object with data");
  }
  const nextPage =
    typeof payload.next_page === "string" && payload.next_page.trim()
      ? payload.next_page.trim()
      : undefined;
  return {
    data: payload.data,
    hasMore: payload.has_more === true,
    ...(nextPage ? { nextPage } : {}),
  };
}

async function fetchPages(params: {
  baseUrl: string;
  groupBy: "description" | "model";
  apiKey: string;
  startingAt: string;
  endingAt: string;
  periodDays: number;
  timeoutMs: number;
  fetchFn: typeof fetch;
}): Promise<{ ok: true; data: unknown[] } | { ok: false; status?: number }> {
  const data: unknown[] = [];
  const seenPages = new Set<string>();
  let page: string | undefined;

  for (let pageCount = 1; pageCount <= MAX_PAGES; pageCount += 1) {
    const url = new URL(params.baseUrl);
    url.searchParams.set("starting_at", params.startingAt);
    url.searchParams.set("ending_at", params.endingAt);
    url.searchParams.set("bucket_width", "1d");
    url.searchParams.set("limit", String(params.periodDays));
    url.searchParams.set("group_by[]", params.groupBy);
    if (page) {
      url.searchParams.set("page", page);
    }

    let response: Response;
    try {
      response = await params.fetchFn(url, {
        headers: {
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": params.apiKey,
        },
        signal: AbortSignal.timeout(params.timeoutMs),
      });
    } catch {
      return { ok: false };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, status: response.status };
    }

    let parsed: AnthropicUsagePage;
    try {
      parsed = await readPage(response, params.timeoutMs);
    } catch {
      return { ok: false };
    }
    data.push(...parsed.data);
    if (!parsed.hasMore) {
      return { ok: true, data };
    }
    if (!parsed.nextPage || seenPages.has(parsed.nextPage)) {
      return { ok: false };
    }
    seenPages.add(parsed.nextPage);
    page = parsed.nextPage;
  }

  return { ok: false };
}

function addModelUsage(
  accumulator: DailyAccumulator,
  name: string,
  usage: Omit<ProviderUsageModelBreakdown, "name">,
) {
  const current = accumulator.models.get(name) ?? {
    name,
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  current.inputTokens += usage.inputTokens;
  current.cacheReadTokens += usage.cacheReadTokens;
  current.cacheWriteTokens += usage.cacheWriteTokens;
  current.outputTokens += usage.outputTokens;
  current.totalTokens += usage.totalTokens;
  accumulator.models.set(name, current);
}

function aggregateHistory(params: {
  costs: unknown[];
  messages: unknown[];
  periodDays: number;
}): ProviderUsageSnapshot {
  const daily = new Map<string, DailyAccumulator>();
  const getDaily = (startingAt: string) => {
    const date = utcDay(startingAt);
    if (!date) {
      return undefined;
    }
    const current = daily.get(date) ?? emptyDaily(date);
    daily.set(date, current);
    return current;
  };

  for (const rawBucket of params.costs) {
    const bucket = objectRecord(rawBucket);
    const startingAt = typeof bucket?.starting_at === "string" ? bucket.starting_at : undefined;
    if (!startingAt || !Array.isArray(bucket?.results)) {
      continue;
    }
    const accumulator = getDaily(startingAt);
    if (!accumulator) {
      continue;
    }
    for (const rawResult of bucket.results) {
      const result = objectRecord(rawResult);
      const amount = (finiteNumber(result?.amount) ?? 0) / 100;
      const category = displayName(result?.description ?? result?.cost_type, "Claude API");
      accumulator.amount += amount;
      accumulator.categories.set(category, (accumulator.categories.get(category) ?? 0) + amount);
    }
  }

  for (const rawBucket of params.messages) {
    const bucket = objectRecord(rawBucket);
    const startingAt = typeof bucket?.starting_at === "string" ? bucket.starting_at : undefined;
    if (!startingAt || !Array.isArray(bucket?.results)) {
      continue;
    }
    const accumulator = getDaily(startingAt);
    if (!accumulator) {
      continue;
    }
    for (const rawResult of bucket.results) {
      const result = objectRecord(rawResult);
      if (!result) {
        continue;
      }
      const cacheCreation = objectRecord(result.cache_creation);
      const inputTokens = nonNegativeInteger(result.uncached_input_tokens);
      const cacheWriteTokens =
        nonNegativeInteger(cacheCreation?.ephemeral_1h_input_tokens) +
        nonNegativeInteger(cacheCreation?.ephemeral_5m_input_tokens);
      const cacheReadTokens = nonNegativeInteger(result.cache_read_input_tokens);
      const outputTokens = nonNegativeInteger(result.output_tokens);
      const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
      accumulator.inputTokens += inputTokens;
      accumulator.cacheWriteTokens += cacheWriteTokens;
      accumulator.cacheReadTokens += cacheReadTokens;
      accumulator.outputTokens += outputTokens;
      accumulator.totalTokens += totalTokens;
      addModelUsage(accumulator, displayName(result.model, "Claude API"), {
        inputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        outputTokens,
        totalTokens,
      });
    }
  }

  const categories = new Map<string, number>();
  const models = new Map<string, ProviderUsageModelBreakdown>();
  const historyDaily = [...daily.values()]
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map((entry) => {
      for (const [name, amount] of entry.categories) {
        categories.set(name, (categories.get(name) ?? 0) + amount);
      }
      for (const model of entry.models.values()) {
        const current = models.get(model.name) ?? {
          name: model.name,
          inputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
        };
        current.inputTokens += model.inputTokens;
        current.cacheReadTokens += model.cacheReadTokens;
        current.cacheWriteTokens += model.cacheWriteTokens;
        current.outputTokens += model.outputTokens;
        current.totalTokens += model.totalTokens;
        models.set(model.name, current);
      }
      const { categories: _categories, models: _models, ...day } = entry;
      return day;
    });
  const amount = historyDaily.reduce((total, day) => total + day.amount, 0);
  const totalTokens = historyDaily.reduce((total, day) => total + day.totalTokens, 0);

  return {
    provider: "anthropic",
    displayName: "Anthropic",
    windows: [],
    plan: "Admin API",
    billing: [
      {
        type: "spend",
        label: `${params.periodDays}-day API spend`,
        amount,
        unit: "USD",
        period: `${params.periodDays}d`,
      },
    ],
    costHistory: {
      unit: "USD",
      periodDays: params.periodDays,
      daily: historyDaily,
      models: [...models.values()].toSorted(
        (a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name),
      ),
      categories: [...categories.entries()]
        .map(([name, categoryAmount]) => ({ name, amount: categoryAmount }))
        .toSorted((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)),
    },
    summary: `${totalTokens.toLocaleString("en-US")} tokens`,
  };
}

async function fetchAnthropicAdminUsage(params: {
  apiKey: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
  now?: number;
  periodDays?: number;
}): Promise<ProviderUsageSnapshot> {
  const periodDays = Math.max(
    1,
    Math.min(31, Math.trunc(params.periodDays ?? ANTHROPIC_USAGE_HISTORY_DAYS)),
  );
  const range = resolveDailyRange(params.now ?? Date.now(), periodDays);
  const common = {
    apiKey: params.apiKey,
    ...range,
    periodDays,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
  };
  const [costs, messages] = await Promise.all([
    fetchPages({ ...common, baseUrl: ANTHROPIC_COST_URL, groupBy: "description" }),
    fetchPages({ ...common, baseUrl: ANTHROPIC_MESSAGES_USAGE_URL, groupBy: "model" }),
  ]);
  if (!costs.ok || !messages.ok) {
    const failedStatus = !costs.ok ? costs.status : !messages.ok ? messages.status : undefined;
    if (failedStatus === 401 || failedStatus === 403) {
      return {
        provider: "anthropic",
        displayName: "Anthropic",
        windows: [],
        error: "Admin API key required",
      };
    }
    return failedStatus
      ? buildUsageHttpErrorSnapshot({ provider: "anthropic", status: failedStatus })
      : {
          provider: "anthropic",
          displayName: "Anthropic",
          windows: [],
          error: "Usage unavailable",
        };
  }
  return aggregateHistory({ costs: costs.data, messages: messages.data, periodDays });
}

export async function resolveAnthropicUsageAuth(
  ctx: ProviderResolveUsageAuthContext,
): Promise<ProviderResolvedUsageAuth> {
  const explicitAdminKey =
    cleanCredential(ctx.env.ANTHROPIC_ADMIN_KEY) ??
    cleanCredential(ctx.env.ANTHROPIC_ADMIN_API_KEY);
  if (explicitAdminKey) {
    return { token: encodeAdminToken(explicitAdminKey) };
  }

  const storedCandidates = (await ctx.resolveApiKeyCandidatesFromConfigAndStore?.()) ?? [];
  const storedAdminKey = storedCandidates
    .map(normalizeAdminKey)
    .find((candidate): candidate is string => Boolean(candidate));
  if (storedAdminKey) {
    return { token: encodeAdminToken(storedAdminKey) };
  }

  const oauthToken = await ctx.resolveOAuthToken();
  if (oauthToken) {
    return oauthToken;
  }

  // Claude CLI-only setups have their keychain login synced under the
  // claude-cli profile, not anthropic; without this fallback those setups
  // never surface subscription usage windows. Usage snapshots are keyed per
  // provider, so when a native anthropic OAuth account and a different Claude
  // Code account coexist, the native account wins and both auth rows display
  // its quota. Per-profile usage attribution is tracked in #102807.
  const claudeCliToken = await ctx.resolveOAuthToken({ provider: CLAUDE_CLI_BACKEND_ID });
  if (claudeCliToken) {
    return claudeCliToken;
  }

  const apiKey = ctx.resolveApiKeyFromConfigAndStore();
  const adminKey = normalizeAdminKey(apiKey);
  if (adminKey) {
    return { token: encodeAdminToken(adminKey) };
  }
  if (apiKey && validateAnthropicSetupToken(apiKey) === undefined) {
    return { token: apiKey };
  }
  return { handled: true };
}

/** Formats keychain plan metadata like ("max", "default_max_20x") as "Max (20x)". */
function formatClaudePlanLabel(
  subscriptionType?: string,
  rateLimitTier?: string,
): string | undefined {
  const base = subscriptionType?.trim();
  if (!base) {
    return undefined;
  }
  const label = base.charAt(0).toUpperCase() + base.slice(1);
  const tier = rateLimitTier?.trim().match(/_(\d+x)$/i)?.[1];
  return tier ? `${label} (${tier})` : label;
}

// Best-effort plan label. Preferred source is plan metadata on the resolved
// auth profile (captured when the external CLI login was synced — the only
// prompt-free source on keychain-backed macOS installs). Fallback reads the
// Claude CLI credential file without keychain prompts for file-based logins.
// When multiple Claude accounts are in play the CLI login may differ from the
// profile that fetched usage; a mislabeled plan chip is acceptable, a second
// network call is not.
function resolveClaudePlanLabel(ctx: ProviderFetchUsageSnapshotContext): string | undefined {
  const fromAuth = formatClaudePlanLabel(ctx.subscriptionType, ctx.rateLimitTier);
  if (fromAuth) {
    return fromAuth;
  }
  const credential = readClaudeCliCredentialsCached({
    allowKeychainPrompt: false,
    ttlMs: 5 * 60_000,
  });
  if (!credential || credential.type !== "oauth") {
    return undefined;
  }
  return formatClaudePlanLabel(credential.subscriptionType, credential.rateLimitTier);
}

export async function fetchAnthropicUsage(
  ctx: ProviderFetchUsageSnapshotContext,
): Promise<ProviderUsageSnapshot> {
  const adminKey = decodeAdminToken(ctx.token);
  if (adminKey) {
    return await fetchAnthropicAdminUsage({
      apiKey: adminKey,
      timeoutMs: ctx.timeoutMs,
      fetchFn: ctx.fetchFn,
    });
  }
  const snapshot = await fetchClaudeUsage(ctx.token, ctx.timeoutMs, ctx.fetchFn);
  if (snapshot.error) {
    return snapshot;
  }
  // Identity is captured on the credential (profile store or the CLI-sync
  // read), so a fetch-time ambient config read can never mislabel an account.
  const accountEmail = ctx.email;
  // Plan labels stay window-gated: a windowless response has no plan quota to
  // label, while the account identity is still worth surfacing.
  const plan =
    snapshot.plan ?? (snapshot.windows.length > 0 ? resolveClaudePlanLabel(ctx) : undefined);
  return {
    ...snapshot,
    ...(plan ? { plan } : {}),
    ...(accountEmail ? { accountEmail } : {}),
  };
}
