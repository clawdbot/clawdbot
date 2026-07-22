export type LocaleDirection = "ltr" | "rtl";

export type LocaleRegistration = {
  id: OpenClawLocale;
  aliases: readonly string[];
  fallback: readonly OpenClawLocale[];
  direction: LocaleDirection;
  englishName: string;
  inferredLanguageDefault?: boolean;
};

export const OPENCLAW_LOCALES = [
  "en",
  "zh-CN",
  "zh-TW",
  "pt-BR",
  "de",
  "es",
  "ja-JP",
  "ko",
  "fr",
  "hi",
  "ar",
  "it",
  "tr",
  "uk",
  "id",
  "pl",
  "th",
  "vi",
  "nl",
  "fa",
  "ru",
  "sv",
] as const;

export type OpenClawLocale = (typeof OPENCLAW_LOCALES)[number];

export const OPENCLAW_LOCALE_REGISTRY_REVISION =
  "sha256:f1fc485ce67ea02b74c69e63e648da3fddc51e276d507a2eeb21d49a18898207";

export const OPENCLAW_LOCALE_REGISTRY: readonly LocaleRegistration[] = [
  locale("en", "English", { aliases: ["en-US"], inferredLanguageDefault: true }),
  locale("zh-CN", "Chinese (Simplified)", {
    aliases: ["zh", "zh-Hans", "zh-SG"],
    inferredLanguageDefault: true,
  }),
  locale("zh-TW", "Chinese (Traditional)", { aliases: ["zh-Hant", "zh-HK", "zh-MO"] }),
  // Preserve the Control UI's shipped `pt-*` inference behavior. This explicit
  // registry rule is intentionally cross-region; it must not emerge implicitly.
  locale("pt-BR", "Portuguese (Brazil)", { inferredLanguageDefault: true }),
  locale("de", "German"),
  locale("es", "Spanish"),
  locale("ja-JP", "Japanese", { inferredLanguageDefault: true }),
  locale("ko", "Korean"),
  locale("fr", "French"),
  locale("hi", "Hindi"),
  locale("ar", "Arabic", { direction: "rtl" }),
  locale("it", "Italian"),
  locale("tr", "Turkish"),
  locale("uk", "Ukrainian"),
  locale("id", "Indonesian"),
  locale("pl", "Polish"),
  locale("th", "Thai"),
  locale("vi", "Vietnamese"),
  locale("nl", "Dutch"),
  locale("fa", "Persian", { direction: "rtl" }),
  locale("ru", "Russian"),
  locale("sv", "Swedish"),
] as const;

type LocaleOptions = {
  aliases?: readonly string[];
  direction?: LocaleDirection;
  inferredLanguageDefault?: boolean;
};

function locale(
  id: OpenClawLocale,
  englishName: string,
  options: LocaleOptions = {},
): LocaleRegistration {
  const fallback: readonly OpenClawLocale[] = id === "en" ? [] : ["en"];
  return Object.freeze({
    id,
    aliases: Object.freeze([...(options.aliases ?? [])]),
    fallback: Object.freeze(fallback),
    direction: options.direction ?? "ltr",
    englishName,
    ...(options.inferredLanguageDefault ? { inferredLanguageDefault: true } : {}),
  });
}

const REGISTRATION_BY_ID = new Map(
  OPENCLAW_LOCALE_REGISTRY.map((registration) => [registration.id, registration]),
);
const EXACT_LOCALE_LOOKUP = new Map<string, OpenClawLocale>();
const INFERRED_LANGUAGE_DEFAULTS = new Map<string, OpenClawLocale>();

for (const registration of OPENCLAW_LOCALE_REGISTRY) {
  for (const token of [registration.id, ...registration.aliases]) {
    const normalized = normalizeLocaleToken(token);
    if (!normalized) {
      throw new Error(`Invalid locale token in registry: ${token}`);
    }
    const lookupKey = normalized.toLowerCase();
    const existing = EXACT_LOCALE_LOOKUP.get(lookupKey);
    if (existing && existing !== registration.id) {
      throw new Error(`Duplicate locale token in registry: ${token}`);
    }
    EXACT_LOCALE_LOOKUP.set(lookupKey, registration.id);
  }

  if (registration.inferredLanguageDefault) {
    const language = registration.id.split("-")[0]?.toLowerCase();
    if (!language || INFERRED_LANGUAGE_DEFAULTS.has(language)) {
      throw new Error(`Duplicate inferred language default: ${language ?? registration.id}`);
    }
    INFERRED_LANGUAGE_DEFAULTS.set(language, registration.id);
  }
}

export function normalizeLocaleToken(raw: string | null | undefined): string | null {
  const withoutSuffix = (raw ?? "").trim().split(".")[0]?.split("@")[0]?.replaceAll("_", "-");
  if (!withoutSuffix) {
    return null;
  }

  const extensionIndex = withoutSuffix.search(/-(?:u|x)-/iu);
  const token = extensionIndex >= 0 ? withoutSuffix.slice(0, extensionIndex) : withoutSuffix;
  if (!token) {
    return null;
  }

  try {
    return Intl.getCanonicalLocales(token)[0] ?? null;
  } catch {
    return null;
  }
}

export function matchExactOpenClawLocale(
  raw: string | null | undefined,
  supportedLocales: readonly OpenClawLocale[] = OPENCLAW_LOCALES,
): OpenClawLocale | null {
  const normalized = normalizeLocaleToken(raw);
  if (!normalized) {
    return null;
  }
  const localeId = EXACT_LOCALE_LOOKUP.get(normalized.toLowerCase());
  if (localeId && supportedLocales.includes(localeId)) {
    return localeId;
  }

  const lower = normalized.toLowerCase();
  if (lower.startsWith("zh-hant-") && supportedLocales.includes("zh-TW")) {
    return "zh-TW";
  }
  if (lower.startsWith("zh-hans-") && supportedLocales.includes("zh-CN")) {
    return "zh-CN";
  }
  return null;
}

export function matchInferredOpenClawLocale(
  raw: string | null | undefined,
  supportedLocales: readonly OpenClawLocale[] = OPENCLAW_LOCALES,
): OpenClawLocale | null {
  const normalized = normalizeLocaleToken(raw);
  if (!normalized) {
    return null;
  }

  const exact = matchExactOpenClawLocale(normalized, supportedLocales);
  if (exact) {
    return exact;
  }

  const lower = normalized.toLowerCase();
  if (lower === "zh-hk" || lower === "zh-mo" || lower.startsWith("zh-hant-")) {
    return supportedLocales.includes("zh-TW") ? "zh-TW" : null;
  }
  if (
    lower === "zh" ||
    lower === "zh-sg" ||
    lower.startsWith("zh-hans-") ||
    lower.startsWith("zh-cn-")
  ) {
    return supportedLocales.includes("zh-CN") ? "zh-CN" : null;
  }

  const segments = normalized.split("-");
  while (segments.length > 1) {
    segments.pop();
    const truncated = matchExactOpenClawLocale(segments.join("-"), supportedLocales);
    if (truncated) {
      return truncated;
    }
  }

  const language = segments[0]?.toLowerCase();
  const inferredDefault = language ? INFERRED_LANGUAGE_DEFAULTS.get(language) : undefined;
  return inferredDefault && supportedLocales.includes(inferredDefault) ? inferredDefault : null;
}

export function getLocaleRegistration(localeId: OpenClawLocale): LocaleRegistration {
  const registration = REGISTRATION_BY_ID.get(localeId);
  if (!registration) {
    throw new Error(`Unknown OpenClaw locale: ${localeId}`);
  }
  return registration;
}

export function getLocaleDirection(localeId: OpenClawLocale): LocaleDirection {
  return getLocaleRegistration(localeId).direction;
}
