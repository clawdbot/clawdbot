// Control UI module implements usage helpers behavior.
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatUiError } from "../../lib/format-error.ts";

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
  hasContextWeight?: boolean;
  usage?: {
    totalTokens?: number;
    totalCost?: number;
    messageCounts?: { total?: number; errors?: number };
    toolUsage?: { totalCalls?: number; tools?: Array<{ name: string }> };
    modelUsage?: Array<{ provider?: string; model?: string }>;
  } | null;
};

export function currentLocalDate(): string {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function toUsageErrorMessage(error: unknown): string {
  return formatUiError(error, "request failed");
}

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
  orderedKeys: string[],
  shiftKey: boolean,
): string[] {
  if (shiftKey && selected.length > 0) {
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
  const rawTokens = query.match(/(?:[^\s"]|"[^"]*")+/g) ?? [];
  return rawTokens.map((token) => {
    const cleaned = token.replace(/^"(.*)"$/u, "$1");
    const idx = cleaned.indexOf(":");
    if (idx > 0) {
      const key = cleaned.slice(0, idx);
      const value = cleaned.slice(idx + 1).replace(/^"(.*)"$/u, "$1");
      return { key, value, raw: cleaned };
    }
    return { value: cleaned, raw: token };
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
  context: (session) => session.hasContextWeight === true,
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
const MULTI_VALUE_QUERY_KEYS = new Set(["channel", "provider", "model", "tool"]);

const matchesEverySession: UsageQueryPredicate = () => true;

const prepareUsageQuery = (
  term: UsageQueryTerm,
  key: string,
  warnings: string[],
): UsageQueryPredicate => {
  if (term.key && !QUERY_KEYS.has(key)) {
    warnings.push(`Unknown filter: ${term.key}`);
    return matchesEverySession;
  }
  if (term.key && term.value === "") {
    warnings.push(`Missing value for ${term.key}`);
  }

  const value = normalizeQueryText(term.value ?? "");
  const numericSpec = Object.hasOwn(NUMERIC_QUERY_SPECS, key)
    ? NUMERIC_QUERY_SPECS[key]
    : undefined;
  const threshold = numericSpec && term.value ? parseQueryNumber(term.value) : null;
  if (numericSpec && term.value && threshold === null) {
    warnings.push(`Invalid number for ${term.key}`);
  }
  if (key === "has") {
    const predicate = Object.hasOwn(HAS_PREDICATES, value) ? HAS_PREDICATES[value] : undefined;
    if (term.value && !predicate) {
      warnings.push(`Unknown has:${term.value}`);
    }
    return predicate ?? matchesEverySession;
  }
  if (!value) {
    return matchesEverySession;
  }
  if (!term.key) {
    return (session) => getSessionText(session).some((text) => text.includes(value));
  }

  switch (key) {
    case "agent":
      return (session) => normalizeLowercaseStringOrEmpty(session.agentId).includes(value);
    case "channel":
      return (session) => normalizeLowercaseStringOrEmpty(session.channel).includes(value);
    case "chat":
      return (session) => normalizeLowercaseStringOrEmpty(session.chatType).includes(value);
    case "provider":
      return (session) => getSessionProviders(session).some((provider) => provider.includes(value));
    case "model":
      return (session) => getSessionModels(session).some((model) => model.includes(value));
    case "tool":
      return (session) => getSessionTools(session).some((tool) => tool.includes(value));
    case "label":
      return (session) => normalizeLowercaseStringOrEmpty(session.label).includes(value);
    case "key":
    case "session":
    case "id":
      if (value.includes("*") || value.includes("?")) {
        let regex: RegExp | undefined;
        return (session) => {
          // Preserve lazy construction after earlier predicates, then reuse this call's matcher.
          regex ??= globToRegex(value);
          return (
            regex.test(session.key) || (session.sessionId ? regex.test(session.sessionId) : false)
          );
        };
      }
      return (session) =>
        normalizeLowercaseStringOrEmpty(session.key).includes(value) ||
        normalizeLowercaseStringOrEmpty(session.sessionId).includes(value);
  }

  if (!numericSpec || threshold === null) {
    return matchesEverySession;
  }
  const [getValue, matches] = numericSpec;
  return (session) => matches(getValue(session), threshold);
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
  const categoricalTerms = new Map<string, UsageQueryPredicate[]>();
  const predicates = terms.map((term) => {
    const key = normalizeQueryText(term.key ?? "");
    const predicate = prepareUsageQuery(term, key, warnings);
    if (!MULTI_VALUE_QUERY_KEYS.has(key)) {
      return predicate;
    }
    const alternatives = categoricalTerms.get(key) ?? [];
    if (term.value) {
      alternatives.push(predicate);
    }
    categoricalTerms.set(key, alternatives);
    // Every original term still revisits its completed OR group, including empty terms.
    return (session: UsageSessionQueryTarget) =>
      alternatives.length === 0 || alternatives.some((match) => match(session));
  });

  const filtered = sessions.filter((session) => predicates.every((match) => match(session)));
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
