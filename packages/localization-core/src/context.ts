import {
  OPENCLAW_LOCALES,
  getLocaleRegistration,
  matchExactOpenClawLocale,
  matchInferredOpenClawLocale,
  type OpenClawLocale,
} from "./locale-registry.js";

export type LocalizationAudience = "user" | "operator";

export type LocalizationSource =
  | "explicit-user"
  | "explicit-recipient"
  | "request"
  | "surface-preference"
  | "operator-default"
  | "platform"
  | "english-default";

export type LocalizationContext = {
  locale: OpenClawLocale;
  fallbackLocales: readonly OpenClawLocale[];
  source: LocalizationSource;
  audience: LocalizationAudience;
};

export type LocaleResolutionFinding = {
  source: LocalizationSource;
  value: string;
  reason: "invalid" | "unsupported-by-surface";
};

export type LocaleResolutionResult = {
  context: LocalizationContext;
  findings: readonly LocaleResolutionFinding[];
};

export function createLocalizationContext(params: {
  locale: OpenClawLocale;
  source: LocalizationSource;
  audience: LocalizationAudience;
  supportedLocales?: readonly OpenClawLocale[];
}): LocalizationContext {
  const supportedLocales = params.supportedLocales ?? OPENCLAW_LOCALES;
  const fallbacks = getLocaleRegistration(params.locale).fallback.filter((locale) =>
    supportedLocales.includes(locale),
  );
  return Object.freeze({
    locale: params.locale,
    fallbackLocales: Object.freeze([...fallbacks]),
    source: params.source,
    audience: params.audience,
  });
}

export function resolveLocalizationContext(params: {
  audience: LocalizationAudience;
  explicitUser?: string | null;
  explicitRecipient?: string | null;
  request?: string | null;
  surfacePreference?: string | null;
  operatorDefault?: string | null;
  platform?: readonly (string | null | undefined)[];
  supportedLocales?: readonly OpenClawLocale[];
}): LocaleResolutionResult {
  const supportedLocales = params.supportedLocales ?? OPENCLAW_LOCALES;
  const findings: LocaleResolutionFinding[] = [];
  const strictCandidates: ReadonlyArray<[LocalizationSource, string | null | undefined]> = [
    ["explicit-user", params.explicitUser],
    ["explicit-recipient", params.explicitRecipient],
    ["request", params.request],
    ["surface-preference", params.surfacePreference],
    ["operator-default", params.operatorDefault],
  ];

  for (const [source, value] of strictCandidates) {
    if (!value?.trim()) {
      continue;
    }
    const locale = matchExactOpenClawLocale(value, supportedLocales);
    if (locale) {
      return resolution(locale, source, params.audience, supportedLocales, findings);
    }
    findings.push(rejection(source, value, supportedLocales));
  }

  for (const value of params.platform ?? []) {
    if (!value?.trim()) {
      continue;
    }
    const locale = matchInferredOpenClawLocale(value, supportedLocales);
    if (locale) {
      return resolution(locale, "platform", params.audience, supportedLocales, findings);
    }
    findings.push(rejection("platform", value, supportedLocales));
  }

  return resolution("en", "english-default", params.audience, supportedLocales, findings);
}

export function resolveProcessLocalizationContext(
  env: Readonly<Record<string, string | undefined>>,
  options: {
    audience: LocalizationAudience;
    supportedLocales?: readonly OpenClawLocale[];
    platform?: readonly (string | null | undefined)[];
  },
): LocaleResolutionResult {
  const supportedLocales = options.supportedLocales ?? OPENCLAW_LOCALES;
  const explicit = env.OPENCLAW_LOCALE;
  if (explicit?.trim()) {
    const locale = matchExactOpenClawLocale(explicit, supportedLocales);
    if (locale) {
      return resolution(locale, "explicit-user", options.audience, supportedLocales, []);
    }
    return resolution("en", "english-default", options.audience, supportedLocales, [
      rejection("explicit-user", explicit, supportedLocales),
    ]);
  }

  const processLocale = [env.LC_ALL, env.LC_MESSAGES, env.LANG].find((value) => value?.trim());
  if (processLocale) {
    const locale =
      isPosixEnglishLocale(processLocale) && supportedLocales.includes("en")
        ? "en"
        : matchInferredOpenClawLocale(processLocale, supportedLocales);
    if (locale) {
      return resolution(locale, "platform", options.audience, supportedLocales, []);
    }
    return resolution("en", "english-default", options.audience, supportedLocales, [
      rejection("platform", processLocale, supportedLocales),
    ]);
  }

  return resolveLocalizationContext({
    audience: options.audience,
    platform: options.platform ?? readRuntimePlatformLocales(),
    supportedLocales,
  });
}

function isPosixEnglishLocale(value: string): boolean {
  const token = value.trim().split(".")[0]?.split("@")[0]?.toUpperCase();
  return token === "C" || token === "POSIX";
}

function readRuntimePlatformLocales(): readonly string[] {
  const navigatorLocales =
    typeof globalThis.navigator === "object"
      ? [
          ...(Array.isArray(globalThis.navigator.languages) ? globalThis.navigator.languages : []),
          globalThis.navigator.language,
        ]
      : [];
  const intlLocale =
    typeof Intl === "object" && typeof Intl.DateTimeFormat === "function"
      ? Intl.DateTimeFormat().resolvedOptions().locale
      : undefined;
  return [...navigatorLocales, intlLocale].filter(
    (locale): locale is string => typeof locale === "string" && locale.length > 0,
  );
}

function resolution(
  locale: OpenClawLocale,
  source: LocalizationSource,
  audience: LocalizationAudience,
  supportedLocales: readonly OpenClawLocale[],
  findings: readonly LocaleResolutionFinding[],
): LocaleResolutionResult {
  return Object.freeze({
    context: createLocalizationContext({ locale, source, audience, supportedLocales }),
    findings: Object.freeze([...findings]),
  });
}

function rejection(
  source: LocalizationSource,
  value: string,
  supportedLocales: readonly OpenClawLocale[],
): LocaleResolutionFinding {
  const recognized = matchExactOpenClawLocale(value);
  return Object.freeze({
    source,
    value,
    reason:
      recognized && !supportedLocales.includes(recognized) ? "unsupported-by-surface" : "invalid",
  });
}
