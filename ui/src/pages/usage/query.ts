import { timestampMsToIsoString } from "@openclaw/normalization-core/number-coercion";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { extractQueryTerms } from "./helpers.ts";
import type { CostDailyEntry, UsageAggregates, UsageSessionEntry } from "./types.ts";

function neutralizeSpreadsheetFormulaCell(value: string): string {
  return /^[ \t\r\n]*[=+\-@\uFF0B\uFF0D\uFF1D\uFF20]/u.test(value) ? `'${value}` : value;
}

function csvEscape(value: string, neutralizeFormulas = true): string {
  const safeValue = neutralizeFormulas ? neutralizeSpreadsheetFormulaCell(value) : value;
  if (/[",\r\n]/.test(safeValue)) {
    return `"${safeValue.replaceAll('"', '""')}"`;
  }
  return safeValue;
}

function toCsvRow(values: Array<string | number | undefined | null>): string {
  return values
    .map((value) => {
      if (value === undefined || value === null) {
        return "";
      }
      return csvEscape(String(value), typeof value === "string");
    })
    .join(",");
}

const buildSessionsCsv = (sessions: UsageSessionEntry[]): string => {
  const rows = [
    toCsvRow([
      "key",
      "label",
      "agentId",
      "channel",
      "provider",
      "model",
      "updatedAt",
      "durationMs",
      "messages",
      "errors",
      "toolCalls",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "totalTokens",
      "totalCost",
    ]),
  ];

  for (const session of sessions) {
    const usage = session.usage;
    rows.push(
      toCsvRow([
        session.key,
        session.label ?? "",
        session.agentId ?? "",
        session.channel ?? "",
        session.modelProvider ?? session.providerOverride ?? "",
        session.model ?? session.modelOverride ?? "",
        timestampMsToIsoString(session.updatedAt) ?? "",
        usage?.durationMs ?? "",
        usage?.messageCounts?.total ?? "",
        usage?.messageCounts?.errors ?? "",
        usage?.messageCounts?.toolCalls ?? "",
        usage?.input ?? "",
        usage?.output ?? "",
        usage?.cacheRead ?? "",
        usage?.cacheWrite ?? "",
        usage?.totalTokens ?? "",
        usage?.totalCost ?? "",
      ]),
    );
  }

  return rows.join("\n");
};

const buildDailyCsv = (daily: CostDailyEntry[]): string => {
  const rows = [
    toCsvRow([
      "date",
      "inputTokens",
      "outputTokens",
      "cacheReadTokens",
      "cacheWriteTokens",
      "totalTokens",
      "inputCost",
      "outputCost",
      "cacheReadCost",
      "cacheWriteCost",
      "totalCost",
    ]),
  ];

  for (const day of daily) {
    rows.push(
      toCsvRow([
        day.date,
        day.input,
        day.output,
        day.cacheRead,
        day.cacheWrite,
        day.totalTokens,
        day.inputCost ?? "",
        day.outputCost ?? "",
        day.cacheReadCost ?? "",
        day.cacheWriteCost ?? "",
        day.totalCost,
      ]),
    );
  }

  return rows.join("\n");
};

type QuerySuggestion = {
  label: string;
  value: string;
};

type UsageFilterOptions = Record<"agent" | "channel" | "provider" | "model" | "tool", string[]>;

function appendFilterValues<T>(
  values: string[],
  entries: readonly T[],
  read: (entry: T) => string | undefined,
  limit = 12,
): void {
  for (const entry of entries) {
    if (values.length >= limit) {
      break;
    }
    const value = read(entry);
    if (value && !values.includes(value)) {
      values.push(value);
    }
  }
}

export function buildUsageFilterOptions(
  sessions: readonly UsageSessionEntry[],
  aggregates?: UsageAggregates | null,
): UsageFilterOptions {
  const options: UsageFilterOptions = { agent: [], channel: [], provider: [], model: [], tool: [] };
  appendFilterValues(options.agent, sessions, (session) => session.agentId, 6);
  appendFilterValues(options.channel, sessions, (session) => session.channel);
  appendFilterValues(options.provider, sessions, (session) => session.modelProvider);
  // Overrides follow every observed provider, preserving the menu's first-seen order.
  appendFilterValues(options.provider, sessions, (session) => session.providerOverride);
  appendFilterValues(options.provider, aggregates?.byProvider ?? [], (entry) => entry.provider);
  appendFilterValues(options.model, sessions, (session) => session.model);
  appendFilterValues(options.model, aggregates?.byModel ?? [], (entry) => entry.model);
  appendFilterValues(options.tool, aggregates?.tools.tools ?? [], (entry) => entry.name);
  return options;
}

const buildQuerySuggestions = (query: string, options: UsageFilterOptions): QuerySuggestion[] => {
  const trimmed = query.trim();
  if (!trimmed) {
    return [];
  }
  const tokens = extractQueryTerms(trimmed).map((term) => term.raw);
  const lastQueryWord = tokens.at(-1) ?? "";
  const [rawKey, rawValue] = lastQueryWord.includes(":")
    ? [
        lastQueryWord.slice(0, lastQueryWord.indexOf(":")),
        lastQueryWord.slice(lastQueryWord.indexOf(":") + 1),
      ]
    : ["", ""];

  const key = normalizeLowercaseStringOrEmpty(rawKey);
  const value = normalizeLowercaseStringOrEmpty(rawValue);

  if (!key) {
    return [
      { label: "agent:", value: "agent:" },
      { label: "channel:", value: "channel:" },
      { label: "provider:", value: "provider:" },
      { label: "model:", value: "model:" },
      { label: "tool:", value: "tool:" },
      { label: "has:errors", value: "has:errors" },
      { label: "has:tools", value: "has:tools" },
      { label: "minTokens:", value: "minTokens:" },
      { label: "maxCost:", value: "maxCost:" },
    ];
  }

  const suggestions: QuerySuggestion[] = [];
  const addValues = (prefix: string, values: string[]) => {
    for (const val of values.slice(0, 6)) {
      if (!value || normalizeLowercaseStringOrEmpty(val).includes(value)) {
        suggestions.push({ label: `${prefix}:${val}`, value: `${prefix}:${val}` });
      }
    }
  };

  switch (key) {
    case "agent":
      addValues("agent", options.agent);
      break;
    case "channel":
      addValues("channel", options.channel);
      break;
    case "provider":
      addValues("provider", options.provider);
      break;
    case "model":
      addValues("model", options.model);
      break;
    case "tool":
      addValues("tool", options.tool);
      break;
    case "has":
      ["errors", "tools", "context", "usage", "model", "provider"].forEach((entry) => {
        if (!value || entry.includes(value)) {
          suggestions.push({ label: `has:${entry}`, value: `has:${entry}` });
        }
      });
      break;
    default:
      break;
  }

  return suggestions;
};

const applySuggestionToQuery = (query: string, suggestion: string): string => {
  const trimmed = query.trim();
  if (!trimmed) {
    return `${suggestion} `;
  }
  const tokens = extractQueryTerms(trimmed).map((term) => term.raw);
  tokens[tokens.length - 1] = suggestion;
  return `${tokens.join(" ")} `;
};

const normalizeQueryText = (value: string): string => normalizeLowercaseStringOrEmpty(value);

const removeQueryToken = (query: string, token: string): string => {
  const tokens = extractQueryTerms(query).map((term) => term.raw);
  const next = tokens.filter((entry) => entry !== token);
  return next.length ? `${next.join(" ")} ` : "";
};

const setQueryTokensForKey = (query: string, key: string, values: string[]): string => {
  const normalizedKey = normalizeQueryText(key);
  const remaining = new Map(values.map((value) => [normalizeQueryText(value), value]));
  const tokens: string[] = [];
  // Retained values keep their authored spelling and quotes; serialize only new selections.
  for (const term of extractQueryTerms(query)) {
    if (
      normalizeQueryText(term.key ?? "") !== normalizedKey ||
      remaining.delete(normalizeQueryText(term.value))
    ) {
      tokens.push(term.raw);
    }
  }
  const next = [...tokens, ...Array.from(remaining.values(), (value) => `${key}:${value}`)];
  return next.length ? `${next.join(" ")} ` : "";
};

export {
  applySuggestionToQuery,
  buildDailyCsv,
  buildQuerySuggestions,
  buildSessionsCsv,
  normalizeQueryText,
  removeQueryToken,
  setQueryTokensForKey,
};
