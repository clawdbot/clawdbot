import { IntlMessageFormat } from "intl-messageformat";
import type { LocalizationContext } from "./context.js";
import { OPENCLAW_LOCALE_REGISTRY_REVISION, type OpenClawLocale } from "./locale-registry.js";

export type MessageParam = string | number | boolean;

export type LocalizedMessage = {
  key: string;
  params?: Readonly<Record<string, MessageParam>>;
  fallback: string;
};

// ICU MessageFormat text constrained by validateCatalog to OpenClaw's bounded v1 profile.
export type CatalogMessage = string;

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

type IcuAstElement = {
  type: number;
  value?: string;
  options?: Readonly<Record<string, { value: readonly IcuAstElement[] }>>;
  pluralType?: string;
};

type ParsedMessage = {
  kind: "string" | "plural" | "select";
  param?: string;
  cases: Readonly<Record<string, readonly string[]>>;
  parameters: readonly string[];
};

const MESSAGE_KEY_PATTERN = /^[a-z][a-z0-9-]*(?:\.[A-Za-z0-9][A-Za-z0-9_-]*)+$/u;
const PLACEHOLDER_PATTERN = /\{([A-Za-z0-9_]+)\}/gu;
const FORBIDDEN_BIDI_CONTROL_PATTERN =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u206a-\u206f]/u;
const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);
const ICU_LITERAL = 0;
const ICU_ARGUMENT = 1;
const ICU_SELECT = 5;
const ICU_PLURAL = 6;
const FORMATTER_CACHE_LIMIT = 512;
const FORMATTER_CACHE = new Map<string, IntlMessageFormat>();

export function createCatalogSnapshot(params: {
  catalogRevision: string;
  catalogs: Partial<Record<OpenClawLocale, LocalizationCatalog>>;
  registryRevision?: string;
}): CatalogSnapshot {
  const catalogs = Object.fromEntries(
    Object.entries(params.catalogs).map(([locale, catalog]) => [
      locale,
      Object.freeze({ ...catalog }),
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
      return formatMessage(entry, locale, message.params) ?? fallback;
    }
  }
  return fallback;
}

export function interpolateMessage(
  value: string,
  params?: Readonly<Record<string, MessageParam>>,
): string {
  const formatted = formatMessage(value, "en", params);
  if (formatted !== undefined) {
    return formatted;
  }
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

function formatMessage(
  message: string,
  locale: string,
  params?: Readonly<Record<string, MessageParam>>,
): string | undefined {
  try {
    const cacheKey = `${locale}\u0000${message}`;
    let formatter = FORMATTER_CACHE.get(cacheKey);
    if (!formatter) {
      formatter = new IntlMessageFormat(message, locale, undefined, { ignoreTag: true });
      if (FORMATTER_CACHE.size >= FORMATTER_CACHE_LIMIT) {
        const oldestKey = FORMATTER_CACHE.keys().next().value;
        if (oldestKey !== undefined) {
          FORMATTER_CACHE.delete(oldestKey);
        }
      }
      FORMATTER_CACHE.set(cacheKey, formatter);
    }
    const result = formatter.format(params);
    return typeof result === "string" ? result : undefined;
  } catch {
    return undefined;
  }
}

function validateEntry(
  key: string,
  source: CatalogMessage,
  candidate: CatalogMessage,
  issues: CatalogValidationIssue[],
): void {
  const sourceParsed = parseBoundedMessage(source);
  const candidateParsed = parseBoundedMessage(candidate);
  if (typeof sourceParsed === "string" || typeof candidateParsed === "string") {
    let detail: string;
    if (typeof sourceParsed === "string") {
      detail = `Source message is outside the bounded ICU profile: ${sourceParsed}`;
    } else if (typeof candidateParsed === "string") {
      detail = `Candidate message is outside the bounded ICU profile: ${candidateParsed}`;
    } else {
      return;
    }
    issues.push({
      code: "invalid-selector",
      key,
      detail,
    });
    return;
  }

  if (sourceParsed.kind !== candidateParsed.kind || sourceParsed.param !== candidateParsed.param) {
    issues.push({
      code: "invalid-selector",
      key,
      detail: "Source and candidate selector kinds and parameters must match.",
    });
    return;
  }

  if (
    sourceParsed.kind === "select" &&
    Object.keys(sourceParsed.cases).toSorted().join(",") !==
      Object.keys(candidateParsed.cases).toSorted().join(",")
  ) {
    issues.push({
      code: "invalid-selector",
      key,
      detail: "Source and candidate select entries must declare the same cases.",
    });
  }

  for (const category of Object.keys(candidateParsed.cases)) {
    if (candidateParsed.kind === "plural" && !PLURAL_CATEGORIES.has(category)) {
      issues.push({
        code: "invalid-selector",
        key,
        detail: `Unsupported plural category: ${category}.`,
      });
    }
  }

  const expectedParameters = sourceParsed.parameters.join(",");
  if (candidateParsed.parameters.join(",") !== expectedParameters) {
    issues.push({
      code: "placeholder-mismatch",
      key,
      detail: `Expected parameters ${expectedParameters || "(none)"}; received ${
        candidateParsed.parameters.join(",") || "(none)"
      }.`,
    });
  }

  if (sourceParsed.kind !== "string") {
    const expectedCaseParameters = Object.values(sourceParsed.cases)[0]?.join(",") ?? "";
    for (const [caseName, value] of Object.entries(sourceParsed.cases)) {
      if (value.join(",") !== expectedCaseParameters) {
        issues.push({
          code: "placeholder-mismatch",
          key,
          detail: `Source case ${caseName} does not use the shared placeholder set.`,
        });
      }
    }
    for (const [caseName, value] of Object.entries(candidateParsed.cases)) {
      if (value.join(",") !== expectedCaseParameters) {
        issues.push({
          code: "placeholder-mismatch",
          key,
          detail: `Case ${caseName} expected placeholders ${
            expectedCaseParameters || "(none)"
          }; received ${value.join(",") || "(none)"}.`,
        });
      }
    }
  }

  for (const [catalogRole, value] of [
    ["Source", source],
    ["Candidate", candidate],
  ] as const) {
    if (FORBIDDEN_BIDI_CONTROL_PATTERN.test(value)) {
      issues.push({
        code: "forbidden-bidi-control",
        key,
        detail: `${catalogRole} catalog text contains a forbidden bidi control.`,
      });
    }
  }
}

function parseBoundedMessage(message: string): ParsedMessage | string {
  let ast: readonly IcuAstElement[];
  try {
    ast = new IntlMessageFormat(message, "en", undefined, {
      ignoreTag: true,
    }).getAst() as unknown as readonly IcuAstElement[];
  } catch (error) {
    return error instanceof Error ? error.message : "invalid ICU message";
  }

  const selectors = ast.filter(
    (element) => element.type === ICU_SELECT || element.type === ICU_PLURAL,
  );
  if (selectors.length > 1) {
    return "only one top-level plural or select is allowed";
  }
  if (ast.some((element) => !isSimpleElement(element) && !selectors.includes(element))) {
    return "number, date, time, pound, tag, and nested formatting are not supported";
  }

  const topLevelArguments = argumentNames(ast);
  const selector = selectors[0];
  if (!selector) {
    return {
      kind: "string",
      cases: { other: topLevelArguments },
      parameters: topLevelArguments,
    };
  }
  if (!selector.value || !selector.options?.other) {
    return "plural and select messages require a parameter and an other case";
  }
  if (selector.type === ICU_PLURAL && selector.pluralType !== "cardinal") {
    return "ordinal plurals are not supported";
  }

  const cases: Record<string, readonly string[]> = {};
  for (const [caseName, option] of Object.entries(selector.options)) {
    if (option.value.some((element) => !isSimpleElement(element))) {
      return "nested or rich formatting is not supported inside selector cases";
    }
    cases[caseName] = argumentNames(option.value);
  }
  const parameters = [...new Set([...topLevelArguments, selector.value])].toSorted();
  return {
    kind: selector.type === ICU_PLURAL ? "plural" : "select",
    param: selector.value,
    cases,
    parameters,
  };
}

function isSimpleElement(element: IcuAstElement): boolean {
  return element.type === ICU_LITERAL || element.type === ICU_ARGUMENT;
}

function argumentNames(elements: readonly IcuAstElement[]): readonly string[] {
  return elements
    .filter((element) => element.type === ICU_ARGUMENT && typeof element.value === "string")
    .map((element) => element.value as string)
    .toSorted();
}

function isMessageParam(value: unknown): value is MessageParam {
  return (
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
}
