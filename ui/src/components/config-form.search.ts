import type { ConfigUiHints } from "../api/types.ts";
import { normalizeLowercaseStringOrEmpty } from "../lib/string-coerce.ts";
import { hintForPath, humanize, schemaType, type JsonSchema } from "./config-form.shared.ts";

export type ConfigSearchCriteria = {
  text: string;
  tags: string[];
};

type ConfigFieldMeta = {
  label: string;
  help?: string;
  tags: string[];
};

type ConfigSearchTextMatcher = (value: string, query: string) => boolean;

export function hasConfigSearchCriteria(criteria: ConfigSearchCriteria | undefined): boolean {
  return Boolean(criteria && (criteria.text.length > 0 || criteria.tags.length > 0));
}

export function parseConfigSearchQuery(query: string): ConfigSearchCriteria {
  const tags: string[] = [];
  const seen = new Set<string>();
  const raw = query.trim();
  const stripped = raw.replace(/(^|\s)tag:([^\s]+)/gi, (_, leading: string, token: string) => {
    const normalized = normalizeLowercaseStringOrEmpty(token);
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      tags.push(normalized);
    }
    return leading;
  });
  return {
    text: normalizeLowercaseStringOrEmpty(stripped),
    tags,
  };
}

function normalizeTags(raw: unknown): string[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const seen = new Set<string>();
  const tags: string[] = [];
  for (const value of raw) {
    if (typeof value !== "string") {
      continue;
    }
    const tag = value.trim();
    if (!tag) {
      continue;
    }
    const key = normalizeLowercaseStringOrEmpty(tag);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    tags.push(tag);
  }
  return tags;
}

export function resolveConfigFieldMeta(
  path: Array<string | number>,
  schema: JsonSchema,
  hints: ConfigUiHints,
): ConfigFieldMeta {
  const hint = hintForPath(path, hints);
  const label = hint?.label ?? schema.title ?? humanize(String(path.at(-1)));
  const help = hint?.help ?? schema.description;
  const schemaTags = normalizeTags(schema["x-tags"] ?? schema.tags);
  const hintTags = normalizeTags(hint?.tags);
  return {
    label,
    help,
    tags: hintTags.length > 0 ? hintTags : schemaTags,
  };
}

function defaultTextMatcher(value: string, query: string): boolean {
  return normalizeLowercaseStringOrEmpty(value).includes(normalizeLowercaseStringOrEmpty(query));
}

function matchesText(
  text: string,
  candidates: Array<string | undefined>,
  textMatcher: ConfigSearchTextMatcher,
): boolean {
  if (!text) {
    return true;
  }
  return candidates.some((candidate) => candidate !== undefined && textMatcher(candidate, text));
}

function matchesTags(filterTags: string[], fieldTags: string[]): boolean {
  if (filterTags.length === 0) {
    return true;
  }
  const normalized = new Set(fieldTags.map((tag) => normalizeLowercaseStringOrEmpty(tag)));
  return filterTags.every((tag) => normalized.has(tag));
}

export function matchesNodeSelf(params: {
  schema: JsonSchema;
  path: Array<string | number>;
  hints: ConfigUiHints;
  criteria: ConfigSearchCriteria;
  textMatcher?: ConfigSearchTextMatcher;
}): boolean {
  const { schema, path, hints, criteria, textMatcher = defaultTextMatcher } = params;
  if (!hasConfigSearchCriteria(criteria)) {
    return true;
  }
  const { label, help, tags } = resolveConfigFieldMeta(path, schema, hints);
  if (!matchesTags(criteria.tags, tags)) {
    return false;
  }
  if (!criteria.text) {
    return true;
  }

  const pathLabel = path
    .filter((segment): segment is string => typeof segment === "string")
    .join(".");
  const enumText = schema.enum?.map((value) => String(value)).join(" ") ?? "";
  return matchesText(
    criteria.text,
    [label, help, schema.title, schema.description, pathLabel, enumText],
    textMatcher,
  );
}

export function matchesNodeSearch(params: {
  schema: JsonSchema;
  value: unknown;
  path: Array<string | number>;
  hints: ConfigUiHints;
  criteria: ConfigSearchCriteria;
  textMatcher?: ConfigSearchTextMatcher;
}): boolean {
  const { schema, value, path, hints, criteria, textMatcher = defaultTextMatcher } = params;
  if (!hasConfigSearchCriteria(criteria)) {
    return true;
  }
  if (matchesNodeSelf({ schema, path, hints, criteria, textMatcher })) {
    return true;
  }

  const type = schemaType(schema);
  if (type === "object") {
    const fallback = value ?? schema.default;
    const obj =
      fallback && typeof fallback === "object" && !Array.isArray(fallback)
        ? (fallback as Record<string, unknown>)
        : {};
    const properties = schema.properties ?? {};
    for (const [propertyKey, node] of Object.entries(properties)) {
      if (
        matchesNodeSearch({
          schema: node,
          value: obj[propertyKey],
          path: [...path, propertyKey],
          hints,
          criteria,
          textMatcher,
        })
      ) {
        return true;
      }
    }
    const additional = schema.additionalProperties;
    if (additional && typeof additional === "object") {
      const reserved = new Set(Object.keys(properties));
      const dynamicEntries = Object.entries(obj).filter(([entryKey]) => !reserved.has(entryKey));
      if (dynamicEntries.length === 0) {
        return matchesNodeSearch({
          schema: additional,
          value: undefined,
          path: [...path, "*"],
          hints,
          criteria,
          textMatcher,
        });
      }
      for (const [entryKey, entryValue] of dynamicEntries) {
        if (
          matchesNodeSearch({
            schema: additional,
            value: entryValue,
            path: [...path, entryKey],
            hints,
            criteria,
            textMatcher,
          })
        ) {
          return true;
        }
      }
    }
    return false;
  }

  if (type !== "array") {
    return false;
  }
  const itemsSchema = Array.isArray(schema.items) ? schema.items[0] : schema.items;
  if (!itemsSchema) {
    return false;
  }
  const values = Array.isArray(value) ? value : Array.isArray(schema.default) ? schema.default : [];
  if (values.length === 0) {
    return matchesNodeSearch({
      schema: itemsSchema,
      value: undefined,
      path: [...path, 0],
      hints,
      criteria,
      textMatcher,
    });
  }
  return values.some((entry, index) =>
    matchesNodeSearch({
      schema: itemsSchema,
      value: entry,
      path: [...path, index],
      hints,
      criteria,
      textMatcher,
    }),
  );
}

export function matchesConfigSectionSearch(params: {
  key: string;
  schema: JsonSchema;
  value: unknown;
  hints: ConfigUiHints;
  query: string;
  label?: string;
  description?: string;
  textMatcher?: ConfigSearchTextMatcher;
}): boolean {
  if (!params.query) {
    return true;
  }
  const criteria = parseConfigSearchQuery(params.query);
  const metadataMatches =
    criteria.tags.length === 0 &&
    criteria.text.length > 0 &&
    [params.key, params.label, params.description].some((candidate) =>
      candidate !== undefined
        ? (params.textMatcher ?? defaultTextMatcher)(candidate, criteria.text)
        : false,
    );
  return (
    metadataMatches ||
    matchesNodeSearch({
      schema: params.schema,
      value: params.value,
      path: [params.key],
      hints: params.hints,
      criteria,
      textMatcher: params.textMatcher,
    })
  );
}
