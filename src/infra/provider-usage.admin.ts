import { readProviderJsonObjectResponse } from "../agents/provider-http-errors.js";
import type {
  ProviderUsageCostDaily,
  ProviderUsageModelBreakdown,
  ProviderUsageSnapshot,
  UsageProviderId,
} from "./provider-usage.types.js";

const DAY_MS = 86_400_000;
const MAX_USAGE_PAGES = 100;

type ProviderUsagePageRequest = {
  url: URL;
  headers: HeadersInit;
};

type ProviderUsageDailyAccumulator = ProviderUsageCostDaily & {
  categories: Map<string, number>;
  models: Map<string, ProviderUsageModelBreakdown>;
};

export function cleanProviderUsageCredential(raw: string | undefined): string | undefined {
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

export function encodeProviderUsageAdminToken(prefix: string, token: string): string {
  return `${prefix}${JSON.stringify({ token })}`;
}

export function decodeProviderUsageAdminToken(prefix: string, raw: string): string | undefined {
  if (!raw.startsWith(prefix)) {
    return undefined;
  }
  try {
    const token = asProviderUsageObject(JSON.parse(raw.slice(prefix.length)) as unknown)?.token;
    return typeof token === "string" && token.trim() ? token.trim() : undefined;
  } catch {
    return undefined;
  }
}

export function asProviderUsageObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function parseProviderUsageNumber(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function parseProviderUsageNonNegativeNumber(value: unknown): number | undefined {
  const parsed = parseProviderUsageNumber(value);
  return parsed !== undefined && parsed >= 0 ? parsed : undefined;
}

export function parseProviderUsageNonNegativeInteger(value: unknown): number {
  const parsed = parseProviderUsageNumber(value);
  return parsed === undefined ? 0 : Math.max(0, Math.trunc(parsed));
}

export function resolveProviderUsageDisplayName(value: unknown, fallback: string): string {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

export function resolveProviderUsageDailyPeriod(params: {
  now: number;
  periodDays?: number;
  defaultPeriodDays: number;
}): { periodDays: number; startMs: number; endMs: number } {
  const periodDays = Math.max(
    1,
    Math.min(31, Math.trunc(params.periodDays ?? params.defaultPeriodDays)),
  );
  const current = new Date(params.now);
  const todayStart = Date.UTC(
    current.getUTCFullYear(),
    current.getUTCMonth(),
    current.getUTCDate(),
  );
  return {
    periodDays,
    startMs: todayStart - (periodDays - 1) * DAY_MS,
    endMs: todayStart + DAY_MS,
  };
}

export async function fetchProviderUsagePages(params: {
  responseLabel: string;
  responseMaxBytes: number;
  timeoutMs: number;
  fetchFn: typeof fetch;
  buildRequest: (page: string | undefined) => ProviderUsagePageRequest;
}): Promise<{ ok: true; data: unknown[] } | { ok: false; status?: number }> {
  const data: unknown[] = [];
  const seenPages = new Set<string>();
  let page: string | undefined;

  for (let pageCount = 1; pageCount <= MAX_USAGE_PAGES; pageCount += 1) {
    const request = params.buildRequest(page);
    let response: Response;
    try {
      response = await params.fetchFn(request.url, {
        headers: request.headers,
        signal: AbortSignal.timeout(params.timeoutMs),
      });
    } catch {
      return { ok: false };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, status: response.status };
    }

    let payload: Record<string, unknown>;
    try {
      payload = await readProviderJsonObjectResponse(response, params.responseLabel, {
        maxBytes: params.responseMaxBytes,
        chunkTimeoutMs: params.timeoutMs,
        onIdleTimeout: ({ chunkTimeoutMs }) =>
          new Error(`${params.responseLabel} response stalled for ${chunkTimeoutMs}ms`),
      });
    } catch {
      return { ok: false };
    }
    if (!Array.isArray(payload.data)) {
      return { ok: false };
    }
    data.push(...payload.data);
    if (payload.has_more !== true) {
      return { ok: true, data };
    }
    const nextPage =
      typeof payload.next_page === "string" && payload.next_page.trim()
        ? payload.next_page.trim()
        : undefined;
    if (!nextPage || seenPages.has(nextPage)) {
      return { ok: false };
    }
    seenPages.add(nextPage);
    page = nextPage;
  }

  return { ok: false };
}

export function createProviderUsageDailyAccumulator(
  date: string,
  includeRequests = false,
): ProviderUsageDailyAccumulator {
  return {
    date,
    amount: 0,
    ...(includeRequests ? { requests: 0 } : {}),
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    categories: new Map(),
    models: new Map(),
  };
}

function mergeModelUsage(
  models: Map<string, ProviderUsageModelBreakdown>,
  name: string,
  usage: Omit<ProviderUsageModelBreakdown, "name">,
): void {
  const current = models.get(name) ?? {
    name,
    ...(usage.requests === undefined ? {} : { requests: 0 }),
    inputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  };
  if (usage.requests !== undefined) {
    current.requests = (current.requests ?? 0) + usage.requests;
  }
  current.inputTokens += usage.inputTokens;
  current.cacheReadTokens += usage.cacheReadTokens;
  current.cacheWriteTokens += usage.cacheWriteTokens;
  current.outputTokens += usage.outputTokens;
  current.totalTokens += usage.totalTokens;
  models.set(name, current);
}

export function addProviderUsageModel(
  accumulator: ProviderUsageDailyAccumulator,
  name: string,
  usage: Omit<ProviderUsageModelBreakdown, "name">,
): void {
  mergeModelUsage(accumulator.models, name, usage);
}

export function buildProviderUsageHistorySnapshot(params: {
  provider: UsageProviderId;
  displayName: string;
  plan: string;
  periodDays: number;
  unit: string;
  scope?: string;
  daily: Iterable<ProviderUsageDailyAccumulator>;
  formatSummary: (totals: { requests: number; totalTokens: number }) => string;
}): ProviderUsageSnapshot {
  const categories = new Map<string, number>();
  const models = new Map<string, ProviderUsageModelBreakdown>();
  const daily = [...params.daily]
    .toSorted((a, b) => a.date.localeCompare(b.date))
    .map((entry) => {
      for (const [name, amount] of entry.categories) {
        categories.set(name, (categories.get(name) ?? 0) + amount);
      }
      for (const model of entry.models.values()) {
        mergeModelUsage(models, model.name, model);
      }
      const { categories: _categories, models: _models, ...day } = entry;
      return day;
    });
  const amount = daily.reduce((total, day) => total + day.amount, 0);
  const requests = daily.reduce((total, day) => total + (day.requests ?? 0), 0);
  const totalTokens = daily.reduce((total, day) => total + day.totalTokens, 0);

  return {
    provider: params.provider,
    displayName: params.displayName,
    windows: [],
    plan: params.plan,
    billing: [
      {
        type: "spend",
        label: `${params.periodDays}-day API spend`,
        amount,
        unit: params.unit,
        period: `${params.periodDays}d`,
      },
    ],
    costHistory: {
      unit: params.unit,
      periodDays: params.periodDays,
      ...(params.scope ? { scope: params.scope } : {}),
      daily,
      models: [...models.values()].toSorted(
        (a, b) => b.totalTokens - a.totalTokens || a.name.localeCompare(b.name),
      ),
      categories: [...categories.entries()]
        .map(([name, categoryAmount]) => ({ name, amount: categoryAmount }))
        .toSorted((a, b) => b.amount - a.amount || a.name.localeCompare(b.name)),
    },
    summary: params.formatSummary({ requests, totalTokens }),
  };
}
