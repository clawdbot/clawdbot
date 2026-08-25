import type {
  ProviderFetchUsageSnapshotContext,
  ProviderResolveUsageAuthContext,
  ProviderResolvedUsageAuth,
} from "openclaw/plugin-sdk/plugin-entry";
import {
  CLAUDE_CLI_PROFILE_ID,
  validateAnthropicSetupToken,
} from "openclaw/plugin-sdk/provider-auth";
import {
  addProviderUsageModel,
  asProviderUsageObject,
  buildUsageHttpErrorSnapshot,
  buildProviderUsageHistorySnapshot,
  cleanProviderUsageCredential,
  createProviderUsageDailyAccumulator,
  decodeProviderUsageAdminToken,
  encodeProviderUsageAdminToken,
  fetchProviderUsagePages,
  fetchClaudeUsage,
  parseProviderUsageNonNegativeInteger,
  parseProviderUsageNumber,
  resolveProviderUsageDailyPeriod,
  resolveProviderUsageDisplayName,
  type ProviderUsageSnapshot,
} from "openclaw/plugin-sdk/provider-usage";

const ANTHROPIC_COST_URL = "https://api.anthropic.com/v1/organizations/cost_report";
const ANTHROPIC_MESSAGES_USAGE_URL =
  "https://api.anthropic.com/v1/organizations/usage_report/messages";
const ANTHROPIC_ADMIN_TOKEN_PREFIX = "openclaw:anthropic-admin:v1:";
const ANTHROPIC_USAGE_RESPONSE_MAX_BYTES = 4 * 1024 * 1024;
const ANTHROPIC_USAGE_HISTORY_DAYS = 30;

function normalizeAdminKey(raw: string | undefined): string | undefined {
  const cleaned = cleanProviderUsageCredential(raw);
  if (!cleaned) {
    return undefined;
  }
  const withoutBearer = cleaned.toLowerCase().startsWith("bearer ")
    ? cleaned.slice("bearer ".length).trim()
    : cleaned;
  return withoutBearer.toLowerCase().startsWith("sk-ant-admin") ? withoutBearer : undefined;
}

function encodeAdminToken(token: string): string {
  return encodeProviderUsageAdminToken(ANTHROPIC_ADMIN_TOKEN_PREFIX, token);
}

function decodeAdminToken(raw: string): string | undefined {
  return decodeProviderUsageAdminToken(ANTHROPIC_ADMIN_TOKEN_PREFIX, raw);
}

function utcDay(value: string): string | undefined {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 10) : undefined;
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
  return await fetchProviderUsagePages({
    responseLabel: "Anthropic usage",
    responseMaxBytes: ANTHROPIC_USAGE_RESPONSE_MAX_BYTES,
    timeoutMs: params.timeoutMs,
    fetchFn: params.fetchFn,
    buildRequest: (page) => {
      const url = new URL(params.baseUrl);
      url.searchParams.set("starting_at", params.startingAt);
      url.searchParams.set("ending_at", params.endingAt);
      url.searchParams.set("bucket_width", "1d");
      url.searchParams.set("limit", String(params.periodDays));
      url.searchParams.set("group_by[]", params.groupBy);
      if (page) {
        url.searchParams.set("page", page);
      }
      return {
        url,
        headers: {
          Accept: "application/json",
          "anthropic-version": "2023-06-01",
          "x-api-key": params.apiKey,
        },
      };
    },
  });
}

function aggregateHistory(params: {
  costs: unknown[];
  messages: unknown[];
  periodDays: number;
}): ProviderUsageSnapshot {
  const daily = new Map<string, ReturnType<typeof createProviderUsageDailyAccumulator>>();
  const getDaily = (startingAt: string) => {
    const date = utcDay(startingAt);
    if (!date) {
      return undefined;
    }
    const current = daily.get(date) ?? createProviderUsageDailyAccumulator(date);
    daily.set(date, current);
    return current;
  };

  for (const rawBucket of params.costs) {
    const bucket = asProviderUsageObject(rawBucket);
    const startingAt = typeof bucket?.starting_at === "string" ? bucket.starting_at : undefined;
    if (!startingAt || !Array.isArray(bucket?.results)) {
      continue;
    }
    const accumulator = getDaily(startingAt);
    if (!accumulator) {
      continue;
    }
    for (const rawResult of bucket.results) {
      const result = asProviderUsageObject(rawResult);
      const amount = (parseProviderUsageNumber(result?.amount) ?? 0) / 100;
      const category = resolveProviderUsageDisplayName(
        result?.description ?? result?.cost_type,
        "Claude API",
      );
      accumulator.amount += amount;
      accumulator.categories.set(category, (accumulator.categories.get(category) ?? 0) + amount);
    }
  }

  for (const rawBucket of params.messages) {
    const bucket = asProviderUsageObject(rawBucket);
    const startingAt = typeof bucket?.starting_at === "string" ? bucket.starting_at : undefined;
    if (!startingAt || !Array.isArray(bucket?.results)) {
      continue;
    }
    const accumulator = getDaily(startingAt);
    if (!accumulator) {
      continue;
    }
    for (const rawResult of bucket.results) {
      const result = asProviderUsageObject(rawResult);
      if (!result) {
        continue;
      }
      const cacheCreation = asProviderUsageObject(result.cache_creation);
      const inputTokens = parseProviderUsageNonNegativeInteger(result.uncached_input_tokens);
      const cacheWriteTokens =
        parseProviderUsageNonNegativeInteger(cacheCreation?.ephemeral_1h_input_tokens) +
        parseProviderUsageNonNegativeInteger(cacheCreation?.ephemeral_5m_input_tokens);
      const cacheReadTokens = parseProviderUsageNonNegativeInteger(result.cache_read_input_tokens);
      const outputTokens = parseProviderUsageNonNegativeInteger(result.output_tokens);
      const totalTokens = inputTokens + cacheWriteTokens + cacheReadTokens + outputTokens;
      accumulator.inputTokens += inputTokens;
      accumulator.cacheWriteTokens += cacheWriteTokens;
      accumulator.cacheReadTokens += cacheReadTokens;
      accumulator.outputTokens += outputTokens;
      accumulator.totalTokens += totalTokens;
      addProviderUsageModel(
        accumulator,
        resolveProviderUsageDisplayName(result.model, "Claude API"),
        {
          inputTokens,
          cacheReadTokens,
          cacheWriteTokens,
          outputTokens,
          totalTokens,
        },
      );
    }
  }

  return buildProviderUsageHistorySnapshot({
    provider: "anthropic",
    displayName: "Anthropic",
    plan: "Admin API",
    periodDays: params.periodDays,
    unit: "USD",
    daily: daily.values(),
    formatSummary: ({ totalTokens }) => `${totalTokens.toLocaleString("en-US")} tokens`,
  });
}

async function fetchAnthropicAdminUsage(params: {
  apiKey: string;
  timeoutMs: number;
  fetchFn: typeof fetch;
  now?: number;
  periodDays?: number;
}): Promise<ProviderUsageSnapshot> {
  const period = resolveProviderUsageDailyPeriod({
    now: params.now ?? Date.now(),
    periodDays: params.periodDays,
    defaultPeriodDays: ANTHROPIC_USAGE_HISTORY_DAYS,
  });
  const common = {
    apiKey: params.apiKey,
    startingAt: new Date(period.startMs).toISOString(),
    endingAt: new Date(period.endMs).toISOString(),
    periodDays: period.periodDays,
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
  return aggregateHistory({
    costs: costs.data,
    messages: messages.data,
    periodDays: period.periodDays,
  });
}

export async function resolveAnthropicUsageAuth(
  ctx: ProviderResolveUsageAuthContext,
): Promise<ProviderResolvedUsageAuth> {
  const explicitAdminKey =
    cleanProviderUsageCredential(ctx.env.ANTHROPIC_ADMIN_KEY) ??
    cleanProviderUsageCredential(ctx.env.ANTHROPIC_ADMIN_API_KEY);
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

  const oauthToken = await ctx.resolveOAuthToken({
    excludeProfileIds: [CLAUDE_CLI_PROFILE_ID],
  });
  if (oauthToken) {
    return oauthToken;
  }

  const apiKey = ctx.resolveApiKeyFromConfigAndStore();
  const adminKey = normalizeAdminKey(apiKey);
  if (adminKey) {
    return { token: encodeAdminToken(adminKey) };
  }
  if (apiKey && validateAnthropicSetupToken(apiKey) === undefined) {
    return { token: apiKey };
  }

  // Claude owns its native refresh-token family. Do not resolve a copied
  // claude-cli profile here: generic OAuth refresh invalidates Claude's login.
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

function resolveClaudePlanLabel(ctx: ProviderFetchUsageSnapshotContext): string | undefined {
  return formatClaudePlanLabel(ctx.subscriptionType, ctx.rateLimitTier);
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
  // Identity comes from the selected credential, so ambient config cannot mislabel an account.
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
