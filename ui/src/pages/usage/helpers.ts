// Control UI module implements usage helpers behavior.
import { normalizeLowercaseStringOrEmpty } from "../../lib/string-coerce.ts";

type UsageQueryTerm = {
  key?: string;
  value: string;
  raw: string;
};

type UsageQueryResult<TSession> = {
  sessions: TSession[];
  warnings: string[];
};

// Minimal shape required for query filtering. The usage view's real session type contains more fields.
type UsageSessionQueryTarget = {
  key: string;
  label?: string;
  sessionId?: string;
  agentId?: string;
  channel?: string;
  chatType?: string;
  modelProvider?: string;
  providerOverride?: string;
  origin?: { provider?: string };
  model?: string;
  contextWeight?: unknown;
  usage?: {
    totalTokens?: number;
    totalCost?: number;
    messageCounts?: { total?: number; errors?: number };
    toolUsage?: { totalCalls?: number; tools?: Array<{ name: string }> };
    modelUsage?: Array<{ provider?: string; model?: string }>;
  } | null;
};

export function toggleUsageRangeSelection<T>(
  selected: T[],
  value: T,
  orderedValues: T[],
  shiftKey: boolean,
  append: boolean,
): T[] {
  if (shiftKey && selected.length > 0) {
    for (const lastSelected of selected.slice(-1)) {
      const lastIndex = orderedValues.indexOf(lastSelected);
      const nextIndex = orderedValues.indexOf(value);
      if (lastIndex !== -1 && nextIndex !== -1) {
        const [start, end] =
          lastIndex < nextIndex ? [lastIndex, nextIndex] : [nextIndex, lastIndex];
        return [...new Set([...selected, ...orderedValues.slice(start, end + 1)])];
      }
    }
  }
  if (selected.includes(value)) {
    return selected.filter((entry) => entry !== value);
  }
  return append ? [...selected, value] : [value];
}

export function selectUsageSessionKeys(
  selected: string[],
  key: string,
  sessions: UsageSessionQueryTarget[],
  tokenMode: boolean,
  shiftKey: boolean,
): string[] {
  if (shiftKey && selected.length > 0) {
    const orderedKeys = [...sessions]
      .toSorted((left, right) => {
        const leftValue = tokenMode ? (left.usage?.totalTokens ?? 0) : (left.usage?.totalCost ?? 0);
        const rightValue = tokenMode
          ? (right.usage?.totalTokens ?? 0)
          : (right.usage?.totalCost ?? 0);
        return rightValue - leftValue;
      })
      .map((session) => session.key);
    const lastIndex = orderedKeys.indexOf(selected.at(-1) ?? "");
    const nextIndex = orderedKeys.indexOf(key);
    if (lastIndex !== -1 && nextIndex !== -1) {
      const [start, end] = lastIndex < nextIndex ? [lastIndex, nextIndex] : [nextIndex, lastIndex];
      return [...new Set([...selected, ...orderedKeys.slice(start, end + 1)])];
    }
  }
  return selected.length === 1 && selected[0] === key ? [] : [key];
}

const normalizeQueryText = (value: string): string => normalizeLowercaseStringOrEmpty(value);

const globToRegex = (pattern: string): RegExp => {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`, "i");
};

const parseQueryNumber = (value: string): number | null => {
  let raw = normalizeLowercaseStringOrEmpty(value);
  if (!raw) {
    return null;
  }
  if (raw.startsWith("$")) {
    raw = raw.slice(1);
  }
  let multiplier = 1;
  if (raw.endsWith("k")) {
    multiplier = 1_000;
    raw = raw.slice(0, -1);
  } else if (raw.endsWith("m")) {
    multiplier = 1_000_000;
    raw = raw.slice(0, -1);
  }
  if (!/^\d+(?:\.\d+)?$/.test(raw)) {
    return null;
  }
  const parsed = Number(raw);
  const normalized = parsed * multiplier;
  if (!Number.isFinite(normalized) || !Number.isSafeInteger(Math.round(normalized))) {
    return null;
  }
  return normalized;
};

export const extractQueryTerms = (query: string): UsageQueryTerm[] => {
  // Tokenize by whitespace, but allow quoted values with spaces.
  const rawTokens = query.match(/"[^"]+"|\S+/g) ?? [];
  return rawTokens.map((token) => {
    const cleaned = token.replace(/^"|"$/g, "");
    const idx = cleaned.indexOf(":");
    if (idx > 0) {
      const key = cleaned.slice(0, idx);
      const value = cleaned.slice(idx + 1);
      return { key, value, raw: cleaned };
    }
    return { value: cleaned, raw: cleaned };
  });
};

const getSessionText = (session: UsageSessionQueryTarget): string[] => {
  const items: Array<string | undefined> = [session.label, session.key, session.sessionId];
  return items
    .filter((item): item is string => Boolean(item))
    .map((item) => normalizeLowercaseStringOrEmpty(item));
};

const getSessionProviders = (session: UsageSessionQueryTarget): string[] => {
  const providers = new Set<string>();
  if (session.modelProvider) {
    providers.add(normalizeLowercaseStringOrEmpty(session.modelProvider));
  }
  if (session.providerOverride) {
    providers.add(normalizeLowercaseStringOrEmpty(session.providerOverride));
  }
  if (session.origin?.provider) {
    providers.add(normalizeLowercaseStringOrEmpty(session.origin.provider));
  }
  for (const entry of session.usage?.modelUsage ?? []) {
    if (entry.provider) {
      providers.add(normalizeLowercaseStringOrEmpty(entry.provider));
    }
  }
  return Array.from(providers);
};

const getSessionModels = (session: UsageSessionQueryTarget): string[] => {
  const models = new Set<string>();
  if (session.model) {
    models.add(normalizeLowercaseStringOrEmpty(session.model));
  }
  for (const entry of session.usage?.modelUsage ?? []) {
    if (entry.model) {
      models.add(normalizeLowercaseStringOrEmpty(entry.model));
    }
  }
  return Array.from(models);
};

const getSessionTools = (session: UsageSessionQueryTarget): string[] =>
  (session.usage?.toolUsage?.tools ?? []).map((tool) => normalizeLowercaseStringOrEmpty(tool.name));

type UsageQueryPredicate = (session: UsageSessionQueryTarget) => boolean;

const HAS_PREDICATES: Readonly<Record<string, UsageQueryPredicate>> = {
  tools: (session) => (session.usage?.toolUsage?.totalCalls ?? 0) > 0,
  errors: (session) => (session.usage?.messageCounts?.errors ?? 0) > 0,
  context: (session) => Boolean(session.contextWeight),
  usage: (session) => Boolean(session.usage),
  model: (session) => getSessionModels(session).length > 0,
  provider: (session) => getSessionProviders(session).length > 0,
};

type NumericQuerySpec = readonly [
  value: (session: UsageSessionQueryTarget) => number,
  matches: (value: number, threshold: number) => boolean,
];

const atLeast = (value: number, threshold: number): boolean => value >= threshold;
const atMost = (value: number, threshold: number): boolean => value <= threshold;
const NUMERIC_QUERY_SPECS: Readonly<Record<string, NumericQuerySpec>> = {
  mintokens: [(session) => session.usage?.totalTokens ?? 0, atLeast],
  maxtokens: [(session) => session.usage?.totalTokens ?? 0, atMost],
  mincost: [(session) => session.usage?.totalCost ?? 0, atLeast],
  maxcost: [(session) => session.usage?.totalCost ?? 0, atMost],
  minmessages: [(session) => session.usage?.messageCounts?.total ?? 0, atLeast],
  maxmessages: [(session) => session.usage?.messageCounts?.total ?? 0, atMost],
};

const QUERY_KEYS = new Set([
  "agent",
  "channel",
  "chat",
  "provider",
  "model",
  "tool",
  "label",
  "key",
  "session",
  "id",
  "has",
  ...Object.keys(NUMERIC_QUERY_SPECS),
]);

const matchesUsageQuery = (session: UsageSessionQueryTarget, term: UsageQueryTerm): boolean => {
  const value = normalizeQueryText(term.value ?? "");
  if (!value) {
    return true;
  }
  if (!term.key) {
    return getSessionText(session).some((text) => text.includes(value));
  }

  const key = normalizeQueryText(term.key);
  switch (key) {
    case "agent":
      return normalizeLowercaseStringOrEmpty(session.agentId).includes(value);
    case "channel":
      return normalizeLowercaseStringOrEmpty(session.channel).includes(value);
    case "chat":
      return normalizeLowercaseStringOrEmpty(session.chatType).includes(value);
    case "provider":
      return getSessionProviders(session).some((provider) => provider.includes(value));
    case "model":
      return getSessionModels(session).some((model) => model.includes(value));
    case "tool":
      return getSessionTools(session).some((tool) => tool.includes(value));
    case "label":
      return normalizeLowercaseStringOrEmpty(session.label).includes(value);
    case "key":
    case "session":
    case "id":
      if (value.includes("*") || value.includes("?")) {
        const regex = globToRegex(value);
        return (
          regex.test(session.key) || (session.sessionId ? regex.test(session.sessionId) : false)
        );
      }
      return (
        normalizeLowercaseStringOrEmpty(session.key).includes(value) ||
        normalizeLowercaseStringOrEmpty(session.sessionId).includes(value)
      );
    case "has": {
      const predicate = Object.hasOwn(HAS_PREDICATES, value) ? HAS_PREDICATES[value] : undefined;
      return predicate?.(session) ?? true;
    }
  }

  const numericSpec = Object.hasOwn(NUMERIC_QUERY_SPECS, key)
    ? NUMERIC_QUERY_SPECS[key]
    : undefined;
  if (!numericSpec) {
    return true;
  }
  const threshold = parseQueryNumber(value);
  const [getValue, matches] = numericSpec;
  return threshold === null || matches(getValue(session), threshold);
};

export const filterSessionsByQuery = <TSession extends UsageSessionQueryTarget>(
  sessions: TSession[],
  query: string,
): UsageQueryResult<TSession> => {
  const terms = extractQueryTerms(query);
  if (terms.length === 0) {
    return { sessions, warnings: [] };
  }

  const warnings: string[] = [];
  for (const term of terms) {
    if (!term.key) {
      continue;
    }
    const normalizedKey = normalizeQueryText(term.key);
    if (!QUERY_KEYS.has(normalizedKey)) {
      warnings.push(`Unknown filter: ${term.key}`);
      continue;
    }
    if (term.value === "") {
      warnings.push(`Missing value for ${term.key}`);
    }
    if (
      normalizedKey === "has" &&
      term.value &&
      !Object.hasOwn(HAS_PREDICATES, normalizeQueryText(term.value))
    ) {
      warnings.push(`Unknown has:${term.value}`);
    }
    if (
      Object.hasOwn(NUMERIC_QUERY_SPECS, normalizedKey) &&
      term.value &&
      parseQueryNumber(term.value) === null
    ) {
      warnings.push(`Invalid number for ${term.key}`);
    }
  }

  const filtered = sessions.filter((session) =>
    terms.every((term) => matchesUsageQuery(session, term)),
  );
  return { sessions: filtered, warnings };
};

export function parseToolSummary(content: string) {
  const lines = content.split("\n");
  const toolCounts = new Map<string, number>();
  const nonToolLines: string[] = [];
  for (const line of lines) {
    const match = /^\[Tool:\s*([^\]]+)\]/.exec(line.trim());
    const name = match?.[1];
    if (name) {
      toolCounts.set(name, (toolCounts.get(name) ?? 0) + 1);
      continue;
    }
    if (line.trim().startsWith("[Tool Result]")) {
      continue;
    }
    nonToolLines.push(line);
  }
  const sortedTools = Array.from(toolCounts.entries()).toSorted((a, b) => b[1] - a[1]);
  const totalCalls = sortedTools.reduce((sum, [, count]) => sum + count, 0);
  const summary =
    sortedTools.length > 0
      ? `Tools: ${sortedTools
          .map(([name, count]) => `${name}×${count}`)
          .join(", ")} (${totalCalls} calls)`
      : "";
  return {
    tools: sortedTools,
    summary,
    cleanContent: nonToolLines.join("\n").trim(),
  };
}
