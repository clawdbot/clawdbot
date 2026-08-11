import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { FormatError, IntlMessageFormat } from "intl-messageformat";
import type { LocalizationContext } from "./context.js";
import {
  SUPPORTED_LOCALES,
  LOCALE_REGISTRY_REVISION,
  type OpenClawLocale,
} from "./locale-registry.js";

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
  namespaces: readonly string[];
  sourceLocale: OpenClawLocale;
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
    | "forbidden-bidi-control"
    | "missing-source-catalog"
    | "invalid-locale"
    | "catalog-too-large"
    | "message-too-large";
  key: string;
  detail: string;
};

export type CatalogActivationError = {
  code: "invalid-catalog";
  catalogRevision: string;
  issues: readonly CatalogValidationIssue[];
};

export type CatalogSnapshotInput = {
  namespace: string | readonly string[];
  catalogRevision: string;
  catalogs: Partial<Record<OpenClawLocale, LocalizationCatalog>>;
  sourceLocale?: OpenClawLocale;
  registryRevision?: string;
};

export type CatalogStore = {
  readonly snapshot: CatalogSnapshot;
  activate(params: {
    catalogRevision: string;
    catalogs: Partial<Record<OpenClawLocale, LocalizationCatalog>>;
    registryRevision?: string;
  }): Result<CatalogSnapshot, CatalogActivationError>;
};

export type LocalizedMessageValidationIssue = {
  code:
    | "invalid-key"
    | "invalid-fallback"
    | "missing-parameter"
    | "unknown-parameter"
    | "invalid-parameter";
  key: string;
  parameter?: string;
};

export type LocalizationRenderFinding = {
  code: "missing-catalog" | "missing-key" | "invalid-parameter" | "format-error";
  key: string;
  locale: OpenClawLocale;
  catalogRevision: string;
};

export type LocalizationRenderResult = {
  value: string;
  findings: readonly LocalizationRenderFinding[];
};

export type LiteralIsolationError = {
  code: "forbidden-bidi-control";
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
const PARAMETER_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/u;
const FORBIDDEN_BIDI_CONTROL_PATTERN =
  /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u206a-\u206f]/u;
const PLURAL_CATEGORIES = new Set(["zero", "one", "two", "few", "many", "other"]);
const ICU_LITERAL = 0;
const ICU_ARGUMENT = 1;
const ICU_SELECT = 5;
const ICU_PLURAL = 6;
const FORMATTER_CACHE_LIMIT = 512;
const FORMATTER_CACHE = new Map<string, IntlMessageFormat>();
export const LOCALIZATION_CATALOG_LIMITS = Object.freeze({
  locales: SUPPORTED_LOCALES.length,
  entries: 50_000,
  characters: 16_000_000,
  keyLength: 256,
  messageLength: 16_384,
});
const FIRST_STRONG_ISOLATE = "\u2068";
const POP_DIRECTIONAL_ISOLATE = "\u2069";

export function createCatalogSnapshot(
  params: CatalogSnapshotInput,
): Result<CatalogSnapshot, CatalogActivationError> {
  const sourceLocale = params.sourceLocale ?? "en";
  const issues = validateSnapshotCatalogs(params.namespace, sourceLocale, params.catalogs);
  if (issues.length > 0) {
    return err({
      code: "invalid-catalog",
      catalogRevision: params.catalogRevision,
      issues,
    });
  }

  const catalogs = Object.fromEntries(
    Object.entries(params.catalogs).map(([locale, catalog]) => [
      locale,
      Object.freeze({ ...catalog }),
    ]),
  ) as Partial<Record<OpenClawLocale, LocalizationCatalog>>;

  return ok(
    Object.freeze({
      namespaces: Object.freeze(normalizeNamespaces(params.namespace)),
      sourceLocale,
      registryRevision: params.registryRevision ?? LOCALE_REGISTRY_REVISION,
      catalogRevision: params.catalogRevision,
      catalogs: Object.freeze(catalogs),
    }),
  );
}

export function createCatalogStore(
  params: CatalogSnapshotInput,
): Result<CatalogStore, CatalogActivationError> {
  const initial = createCatalogSnapshot(params);
  if (!initial.ok) {
    return initial;
  }

  let active = initial.value;
  return ok(
    Object.freeze({
      get snapshot() {
        return active;
      },
      activate(next) {
        const candidate = createCatalogSnapshot({
          namespace: params.namespace,
          sourceLocale: params.sourceLocale,
          catalogRevision: next.catalogRevision,
          catalogs: next.catalogs,
          registryRevision: next.registryRevision,
        });
        if (candidate.ok) {
          active = candidate.value;
        }
        return candidate;
      },
    }),
  );
}

export function renderLocalizedMessage(
  snapshot: CatalogSnapshot,
  context: LocalizationContext,
  message: LocalizedMessage,
): LocalizationRenderResult {
  const validationIssues = validateLocalizedMessage(snapshot, message);
  if (validationIssues.length > 0) {
    return renderResult(message.fallback, [
      finding("invalid-parameter", snapshot, context, message),
    ]);
  }

  const fallbackResult = formatMessage(message.fallback, "en", message.params);
  if (!fallbackResult.ok) {
    return renderResult(message.fallback, [finding("format-error", snapshot, context, message)]);
  }

  const findings: LocalizationRenderFinding[] = [];
  const locales = [context.locale, ...context.fallbackLocales];
  for (const [index, locale] of locales.entries()) {
    const catalog = snapshot.catalogs[locale];
    if (!catalog) {
      findings.push(finding("missing-catalog", snapshot, context, message, locale));
      continue;
    }
    const entry = catalog[message.key];
    if (entry === undefined) {
      findings.push(finding("missing-key", snapshot, context, message, locale));
      continue;
    }
    const formatted = formatMessage(entry, locale, message.params);
    if (formatted.ok) {
      return renderResult(formatted.value, index === 0 ? [] : findings);
    }
    findings.push(finding("format-error", snapshot, context, message, locale));
    break;
  }
  return renderResult(fallbackResult.value, findings);
}

export function interpolateMessage(
  value: string,
  params?: Readonly<Record<string, MessageParam>>,
): string {
  const parsed = parseBoundedMessage(value);
  if (typeof parsed === "string" || validateParameters(parsed, params, "fallback").length > 0) {
    return value;
  }
  const formatted = formatMessage(value, "en", params);
  return formatted.ok ? formatted.value : value;
}

export function validateLocalizedMessage(
  snapshot: CatalogSnapshot,
  message: LocalizedMessage,
): readonly LocalizedMessageValidationIssue[] {
  if (!MESSAGE_KEY_PATTERN.test(message.key)) {
    return Object.freeze([{ code: "invalid-key", key: message.key }]);
  }

  const fallback = parseBoundedMessage(message.fallback);
  if (typeof fallback === "string") {
    return Object.freeze([{ code: "invalid-fallback", key: message.key }]);
  }

  const sourceEntry = snapshot.catalogs[snapshot.sourceLocale]?.[message.key];
  const source = sourceEntry === undefined ? fallback : parseBoundedMessage(sourceEntry);
  if (typeof source === "string" || !sameMessageContract(source, fallback)) {
    return Object.freeze([{ code: "invalid-fallback", key: message.key }]);
  }

  return Object.freeze(validateParameters(source, message.params, message.key));
}

export function validateCatalog(params: {
  namespace: string | readonly string[];
  source: LocalizationCatalog;
  candidate: LocalizationCatalog;
}): readonly CatalogValidationIssue[] {
  const issues: CatalogValidationIssue[] = [];

  for (const [key, sourceEntry] of Object.entries(params.source)) {
    const namespaces = normalizeNamespaces(params.namespace);
    if (!MESSAGE_KEY_PATTERN.test(key) || !namespaces.some((name) => key.startsWith(`${name}.`))) {
      issues.push({
        code: "invalid-key",
        key,
        detail: `Key must be namespaced under ${namespaces.join(" or ")}.`,
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

  return freezeIssues(issues);
}

export function isolateLocalizationLiteral(value: string): Result<string, LiteralIsolationError> {
  if (FORBIDDEN_BIDI_CONTROL_PATTERN.test(value)) {
    return err({ code: "forbidden-bidi-control" });
  }
  return ok(`${FIRST_STRONG_ISOLATE}${value}${POP_DIRECTIONAL_ISOLATE}`);
}

function validateSnapshotCatalogs(
  namespace: string | readonly string[],
  sourceLocale: OpenClawLocale,
  catalogs: Partial<Record<OpenClawLocale, LocalizationCatalog>>,
): readonly CatalogValidationIssue[] {
  const namespaces = normalizeNamespaces(namespace);
  const boundsIssue = validateSnapshotBounds(namespaces, catalogs);
  if (boundsIssue) {
    return freezeIssues([boundsIssue]);
  }
  const source = catalogs[sourceLocale];
  if (!source) {
    return freezeIssues([
      {
        code: "missing-source-catalog",
        key: `${namespaces.join("|")}.*`,
        detail: `Snapshot is missing its ${sourceLocale} source catalog.`,
      },
    ]);
  }

  const issues: CatalogValidationIssue[] = [];
  for (const locale of Object.keys(catalogs)) {
    if (!SUPPORTED_LOCALES.includes(locale as OpenClawLocale)) {
      issues.push({
        code: "invalid-locale",
        key: `${namespaces.join("|")}.*`,
        detail: `Snapshot declares unsupported locale ${locale}.`,
      });
    }
  }
  for (const candidate of Object.values(catalogs)) {
    if (candidate) {
      issues.push(...validateCatalog({ namespace: namespaces, source, candidate }));
    }
  }
  return freezeIssues(issues);
}

function validateSnapshotBounds(
  namespaces: readonly string[],
  catalogs: Partial<Record<OpenClawLocale, LocalizationCatalog>>,
): CatalogValidationIssue | undefined {
  let locales = 0;
  let entries = 0;
  let characters = 0;
  const snapshotKey = `${namespaces.join("|")}.*`;

  for (const locale in catalogs) {
    if (!Object.hasOwn(catalogs, locale)) {
      continue;
    }
    locales += 1;
    if (locales > LOCALIZATION_CATALOG_LIMITS.locales) {
      return {
        code: "catalog-too-large",
        key: snapshotKey,
        detail: `Snapshot exceeds ${LOCALIZATION_CATALOG_LIMITS.locales} locale catalogs.`,
      };
    }
    const catalog = (catalogs as Readonly<Record<string, LocalizationCatalog | undefined>>)[locale];
    if (!catalog) {
      continue;
    }
    for (const key in catalog) {
      if (!Object.hasOwn(catalog, key)) {
        continue;
      }
      const message = catalog[key];
      entries += 1;
      if (entries > LOCALIZATION_CATALOG_LIMITS.entries) {
        return {
          code: "catalog-too-large",
          key: snapshotKey,
          detail: `Snapshot exceeds ${LOCALIZATION_CATALOG_LIMITS.entries} catalog entries.`,
        };
      }
      if (key.length > LOCALIZATION_CATALOG_LIMITS.keyLength) {
        return {
          code: "invalid-key",
          key,
          detail: `Key exceeds ${LOCALIZATION_CATALOG_LIMITS.keyLength} characters.`,
        };
      }
      if (
        typeof message !== "string" ||
        message.length > LOCALIZATION_CATALOG_LIMITS.messageLength
      ) {
        return {
          code: "message-too-large",
          key,
          detail: `Message must be a string no longer than ${LOCALIZATION_CATALOG_LIMITS.messageLength} characters.`,
        };
      }
      characters += key.length + message.length;
      if (characters > LOCALIZATION_CATALOG_LIMITS.characters) {
        return {
          code: "catalog-too-large",
          key: snapshotKey,
          detail: `Snapshot exceeds ${LOCALIZATION_CATALOG_LIMITS.characters} catalog characters.`,
        };
      }
    }
  }
  return undefined;
}

function validateParameters(
  parsed: ParsedMessage,
  params: Readonly<Record<string, MessageParam>> | undefined,
  key: string,
): LocalizedMessageValidationIssue[] {
  const issues: LocalizedMessageValidationIssue[] = [];
  const values = params ?? {};
  const provided = Object.keys(values);
  if (provided.length > 16) {
    issues.push({ code: "invalid-parameter", key });
  }

  for (const name of parsed.parameters) {
    if (!(name in values)) {
      issues.push({ code: "missing-parameter", key, parameter: name });
    }
  }
  for (const name of provided) {
    if (!PARAMETER_NAME_PATTERN.test(name) || !parsed.parameters.includes(name)) {
      issues.push({ code: "unknown-parameter", key, parameter: name });
      continue;
    }
    const value = values[name];
    if (!isMessageParam(value)) {
      issues.push({ code: "invalid-parameter", key, parameter: name });
      continue;
    }
    if (name === parsed.param && parsed.kind === "plural" && typeof value !== "number") {
      issues.push({ code: "invalid-parameter", key, parameter: name });
    }
    if (
      name === parsed.param &&
      parsed.kind === "select" &&
      typeof value !== "string" &&
      typeof value !== "boolean"
    ) {
      issues.push({ code: "invalid-parameter", key, parameter: name });
    }
  }
  return issues;
}

function formatMessage(
  message: string,
  locale: string,
  params?: Readonly<Record<string, MessageParam>>,
): Result<string, FormatError> {
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
    const result = formatter.format(normalizeMessageParams(params));
    if (typeof result !== "string") {
      throw new TypeError("Localization rendering produced a non-string result.");
    }
    return ok(result);
  } catch (error) {
    if (error instanceof FormatError) {
      return err(error);
    }
    throw error;
  }
}

function normalizeMessageParams(
  params?: Readonly<Record<string, MessageParam>>,
): Readonly<Record<string, string | number>> | undefined {
  if (!params) {
    return undefined;
  }
  return Object.fromEntries(
    Object.entries(params).map(([key, value]) => [
      key,
      typeof value === "boolean" ? String(value) : value,
    ]),
  );
}

function validateEntry(
  key: string,
  source: CatalogMessage,
  candidate: CatalogMessage,
  issues: CatalogValidationIssue[],
): void {
  const sourceParsed = parseBoundedMessage(source);
  const candidateParsed = parseBoundedMessage(candidate);
  if (typeof sourceParsed === "string") {
    issues.push({
      code: "invalid-selector",
      key,
      detail: `Source message is outside the bounded ICU profile: ${sourceParsed}`,
    });
    return;
  }
  if (typeof candidateParsed === "string") {
    issues.push({
      code: "invalid-selector",
      key,
      detail: `Candidate message is outside the bounded ICU profile: ${candidateParsed}`,
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

  if (candidateParsed.parameters.join(",") !== sourceParsed.parameters.join(",")) {
    issues.push({
      code: "placeholder-mismatch",
      key,
      detail: `Expected parameters ${sourceParsed.parameters.join(",") || "(none)"}; received ${
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
  const caseParameters = Object.values(cases).flat();
  const parameters = [
    ...new Set([...topLevelArguments, ...caseParameters, selector.value]),
  ].toSorted();
  return {
    kind: selector.type === ICU_PLURAL ? "plural" : "select",
    param: selector.value,
    cases,
    parameters,
  };
}

function sameMessageContract(left: ParsedMessage, right: ParsedMessage): boolean {
  return left.parameters.join(",") === right.parameters.join(",");
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

function finding(
  code: LocalizationRenderFinding["code"],
  snapshot: CatalogSnapshot,
  context: LocalizationContext,
  message: LocalizedMessage,
  locale: OpenClawLocale = context.locale,
): LocalizationRenderFinding {
  return Object.freeze({
    code,
    key: message.key,
    locale,
    catalogRevision: snapshot.catalogRevision,
  });
}

function renderResult(
  value: string,
  findings: readonly LocalizationRenderFinding[],
): LocalizationRenderResult {
  return Object.freeze({
    value,
    findings: Object.freeze([...findings]),
  });
}

function normalizeNamespaces(namespace: string | readonly string[]): string[] {
  const namespaces = typeof namespace === "string" ? [namespace] : [...namespace];
  if (namespaces.length === 0 || namespaces.some((value) => !/^[a-z][a-z0-9-]*$/u.test(value))) {
    throw new TypeError("Catalog snapshots require at least one valid namespace.");
  }
  return [...new Set(namespaces)].toSorted();
}

function freezeIssues(issues: CatalogValidationIssue[]): readonly CatalogValidationIssue[] {
  return Object.freeze(issues.map((issue) => Object.freeze(issue)));
}
