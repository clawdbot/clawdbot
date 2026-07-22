import type { LocalizationContext } from "./context.js";
import { OPENCLAW_LOCALE_REGISTRY_REVISION, type OpenClawLocale } from "./locale-registry.js";

export type MessageParam = string | number | boolean;

export type LocalizedMessage = {
  key: string;
  params?: Readonly<Record<string, MessageParam>>;
  fallback: string;
};

export type PluralCategory = "zero" | "one" | "two" | "few" | "many" | "other";

export type CatalogMessage =
  | string
  | {
      kind: "plural";
      param: string;
      cases: Partial<Record<PluralCategory, string>> & { other: string };
    }
  | {
      kind: "select";
      param: string;
      cases: Readonly<Record<string, string>> & { other: string };
    };

export type LocalizationCatalog = Readonly<Record<string, CatalogMessage>>;

export type CatalogSnapshot = {
  registryRevision: string;
  catalogRevision: string;
  catalogs: Readonly<Partial<Record<OpenClawLocale, LocalizationCatalog>>>;
};

export type CatalogValidationIssue = {
  code:
    | "invalid-key"
    | "missing-key"
    | "unknown-key"
    | "placeholder-mismatch"
    | "invalid-selector"
    | "forbidden-bidi-control";
  key: string;
  detail: string;
};

const MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/u;
const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/gu;
const FORBIDDEN_BIDI_CONTROL_PATTERN =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u206a-\u206f]/u;
const PLURAL_CATEGORIES = new Set<PluralCategory>(["zero", "one", "two", "few", "many", "other"]);
const PLURAL_RULES = new Map<OpenClawLocale, Intl.PluralRules>();

export function createCatalogSnapshot(params: {
  catalogRevision: string;
  catalogs: Partial<Record<OpenClawLocale, LocalizationCatalog>>;
  registryRevision?: string;
}): CatalogSnapshot {
  const catalogs = Object.fromEntries(
    Object.entries(params.catalogs).map(([locale, catalog]) => [
      locale,
      freezeCatalog(catalog ?? {}),
    ]),
  ) as Partial<Record<OpenClawLocale, LocalizationCatalog>>;

  return Object.freeze({
    registryRevision: params.registryRevision ?? OPENCLAW_LOCALE_REGISTRY_REVISION,
    catalogRevision: params.catalogRevision,
    catalogs: Object.freeze(catalogs),
  });
}

export function renderLocalizedMessage(
  snapshot: CatalogSnapshot,
  context: LocalizationContext,
  message: LocalizedMessage,
): string {
  const fallback = interpolateMessage(message.fallback, message.params);
  const locales = [context.locale, ...context.fallbackLocales];
  for (const locale of locales) {
    const entry = snapshot.catalogs[locale]?.[message.key];
    if (entry !== undefined) {
      return renderCatalogEntry(entry, locale, message.params, fallback);
    }
  }
  return fallback;
}

export function interpolateMessage(
  value: string,
  params?: Readonly<Record<string, MessageParam>>,
): string {
  if (!params) {
    return value;
  }
  return value.replace(PLACEHOLDER_PATTERN, (match, key: string) => {
    const param = params[key];
    return isMessageParam(param) ? String(param) : match;
  });
}

export function validateCatalog(params: {
  namespace: string;
  source: LocalizationCatalog;
  candidate: LocalizationCatalog;
}): readonly CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];

  for (const [key, sourceEntry] of Object.entries(params.source)) {
    if (!MESSAGE_KEY_PATTERN.test(key) || !key.startsWith(`${params.namespace}.`)) {
      issues.push({
        code: "invalid-key",
        key,
        detail: `Key must be namespaced under ${params.namespace}.`,
      });
    }

    const candidateEntry = params.candidate[key];
    if (candidateEntry === undefined) {
      issues.push({ code: "missing-key", key, detail: "Candidate catalog is missing the key." });
      continue;
    }

    validateEntry(key, sourceEntry, candidateEntry, issues);
  }

  for (const key of Object.keys(params.candidate)) {
    if (!(key in params.source)) {
      issues.push({
        code: "unknown-key",
        key,
        detail: "Candidate catalog contains a key that is absent from the source catalog.",
      });
    }
  }

  return Object.freeze(issues.map((issue) => Object.freeze(issue)));
}

function renderCatalogEntry(
  entry: CatalogMessage,
  locale: OpenClawLocale,
  params: Readonly<Record<string, MessageParam>> | undefined,
  fallback: string,
): string {
  if (typeof entry === "string") {
    return interpolateMessage(entry, params);
  }

  const selector = params?.[entry.param];
  if (entry.kind === "plural") {
    if (typeof selector !== "number" || !Number.isFinite(selector)) {
      return fallback;
    }
    const category = getPluralRules(locale).select(selector) as PluralCategory;
    const template = entry.cases[category] ?? entry.cases.other;
    return typeof template === "string" ? interpolateMessage(template, params) : fallback;
  }

  function getPluralRules(localeId: OpenClawLocale): Intl.PluralRules {
    const cached = PLURAL_RULES.get(localeId);
    if (cached) {
      return cached;
    }
    const rules = new Intl.PluralRules(localeId);
    PLURAL_RULES.set(localeId, rules);
    return rules;
  }

  if (typeof selector !== "string" && typeof selector !== "boolean") {
    return fallback;
  }
  const template = entry.cases[String(selector)] ?? entry.cases.other;
  return typeof template === "string" ? interpolateMessage(template, params) : fallback;
}

function freezeCatalog(catalog: LocalizationCatalog): LocalizationCatalog {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(catalog).map(([key, entry]) => [
        key,
        typeof entry === "string"
          ? entry
          : Object.freeze({ ...entry, cases: Object.freeze({ ...entry.cases }) }),
      ]),
    ),
  );
}

function validateEntry(
  key: string,
  source: CatalogMessage,
  candidate: CatalogMessage,
  issues: CatalogValidationIssue[],
): void {
  if (!hasValidSelectorShape(source) || !hasValidSelectorShape(candidate)) {
    issues.push({
      code: "invalid-selector",
      key,
      detail: "Plural and select entries require a string param and string other case.",
    });
    return;
  }

  const sourceCases = entryCases(source);
  const candidateCases = entryCases(candidate);
  if (sourceCases.kind !== candidateCases.kind || sourceCases.param !== candidateCases.param) {
    issues.push({
      code: "invalid-selector",
      key,
      detail: "Source and candidate selector kinds and parameters must match.",
    });
    return;
  }

  if (
    sourceCases.kind === "select" &&
    Object.keys(sourceCases.values).toSorted().join(",") !==
      Object.keys(candidateCases.values).toSorted().join(",")
  ) {
    issues.push({
      code: "invalid-selector",
      key,
      detail: "Source and candidate select entries must declare the same cases.",
    });
  }

  for (const category of Object.keys(candidateCases.values)) {
    if (candidateCases.kind === "plural" && !PLURAL_CATEGORIES.has(category as PluralCategory)) {
      issues.push({
        code: "invalid-selector",
        key,
        detail: `Unsupported plural category: ${category}.`,
      });
    }
  }

  const expectedPlaceholders = placeholderSignature(Object.values(sourceCases.values)[0] ?? "");
  for (const [caseName, value] of Object.entries(sourceCases.values)) {
    if (placeholderSignature(value) !== expectedPlaceholders) {
      issues.push({
        code: "placeholder-mismatch",
        key,
        detail: `Source case ${caseName} does not use the shared placeholder set.`,
      });
    }
  }
  for (const [caseName, value] of Object.entries(candidateCases.values)) {
    const candidatePlaceholders = placeholderSignature(value);
    if (candidatePlaceholders !== expectedPlaceholders) {
      issues.push({
        code: "placeholder-mismatch",
        key,
        detail: `Case ${caseName} expected placeholders ${
          expectedPlaceholders || "(none)"
        }; received ${candidatePlaceholders || "(none)"}.`,
      });
    }
  }

  for (const [catalogRole, values] of [
    ["Source", sourceCases.values],
    ["Candidate", candidateCases.values],
  ] as const) {
    if (Object.values(values).some((value) => FORBIDDEN_BIDI_CONTROL_PATTERN.test(value))) {
      issues.push({
        code: "forbidden-bidi-control",
        key,
        detail: `${catalogRole} catalog text contains a forbidden bidi control.`,
      });
    }
  }
}

function isMessageParam(value: unknown): value is MessageParam {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}

function entryCases(entry: CatalogMessage): {
  kind: "string" | "plural" | "select";
  param?: string;
  values: Readonly<Record<string, string>>;
} {
  if (typeof entry === "string") {
    return { kind: "string", values: { other: entry } };
  }
  return { kind: entry.kind, param: entry.param, values: entry.cases };
}

function hasValidSelectorShape(entry: CatalogMessage): boolean {
  if (typeof entry === "string") {
    return true;
  }
  return (
    typeof entry.param === "string" &&
    entry.param.length > 0 &&
    typeof entry.cases === "object" &&
    entry.cases !== null &&
    typeof entry.cases.other === "string" &&
    Object.values(entry.cases).every((value) => typeof value === "string")
  );
}

function placeholderSignature(value: string): string {
  return extractPlaceholders(value).join(",");
}

function extractPlaceholders(value: string): string[] {
  return [...value.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[1] ?? "").toSorted();
}
