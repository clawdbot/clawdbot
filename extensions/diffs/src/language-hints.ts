// Diffs plugin module implements language hints behavior.
import { resolveLanguage } from "@pierre/diffs";
import type { FileContents, FileDiffMetadata, SupportedLanguages } from "@pierre/diffs";
import {
  bundledLanguagesBase,
  bundledLanguagesInfo,
  getBundledLanguageAliases,
} from "./shiki-curated-languages.js";
import type { DiffViewerPayload } from "./types.js";

export const BASE_DIFF_VIEWER_LANGUAGE_HINTS = [
  ...Object.keys(bundledLanguagesBase),
  "text",
  "ansi",
] as const satisfies readonly SupportedLanguages[];
export type DiffViewerBaseLanguage = (typeof BASE_DIFF_VIEWER_LANGUAGE_HINTS)[number];

const BASE_LANGUAGE_HINTS = new Set<SupportedLanguages>(BASE_DIFF_VIEWER_LANGUAGE_HINTS);
const BASE_LANGUAGE_ALIASES = new Map<string, SupportedLanguages>(
  bundledLanguagesInfo.flatMap((language) =>
    getBundledLanguageAliases(language).map((alias) => [alias, language.id as SupportedLanguages]),
  ),
);
type DiffPayloadFile = FileContents | FileDiffMetadata;

function normalizeOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : undefined;
}

export async function normalizeSupportedLanguageHint(
  value?: string,
  options: { languagePackAvailable?: boolean } = {},
): Promise<SupportedLanguages | undefined> {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  const baseAlias = BASE_LANGUAGE_ALIASES.get(normalized);
  if (baseAlias) {
    return baseAlias;
  }
  if (BASE_LANGUAGE_HINTS.has(normalized as SupportedLanguages)) {
    return normalized as SupportedLanguages;
  }
  if (!options.languagePackAvailable) {
    return undefined;
  }
  try {
    await resolveLanguage(normalized as Exclude<SupportedLanguages, "text" | "ansi">);
    return normalized as SupportedLanguages;
  } catch {
    return undefined;
  }
}

export async function filterSupportedLanguageHints(
  values: Iterable<string>,
  options: { languagePackAvailable?: boolean } = {},
): Promise<SupportedLanguages[]> {
  return normalizeSupportedLanguageHints(values, { fallbackToText: true, ...options });
}

async function normalizeSupportedLanguageHints(
  values: Iterable<string>,
  options: { fallbackToText: boolean; languagePackAvailable?: boolean },
): Promise<SupportedLanguages[]> {
  const supported = new Set<SupportedLanguages>();
  for (const value of values) {
    const normalized = await normalizeSupportedLanguageHint(value, options);
    if (!normalized) {
      continue;
    }
    supported.add(normalized);
  }
  if (options.fallbackToText && supported.size === 0) {
    supported.add("text");
  }
  return [...supported];
}

export function collectDiffPayloadLanguageHints(payload: {
  fileDiff?: FileDiffMetadata;
  oldFile?: FileContents;
  newFile?: FileContents;
}): SupportedLanguages[] {
  const langs = new Set<SupportedLanguages>();
  if (payload.fileDiff?.lang) {
    langs.add(payload.fileDiff.lang);
  }
  if (payload.oldFile?.lang) {
    langs.add(payload.oldFile.lang);
  }
  if (payload.newFile?.lang) {
    langs.add(payload.newFile.lang);
  }
  return [...langs];
}

async function normalizeDiffPayloadFileLanguage(
  file: DiffPayloadFile | undefined,
  options: { languagePackAvailable?: boolean },
): Promise<DiffPayloadFile | undefined> {
  if (!file) {
    return undefined;
  }
  if (typeof file.lang !== "string") {
    return file;
  }
  const normalized = await normalizeSupportedLanguageHint(file.lang, options);
  if (file.lang === normalized) {
    return file;
  }
  if (!normalized) {
    return {
      ...file,
      lang: "text",
    };
  }
  return {
    ...file,
    lang: normalized,
  };
}

export async function normalizeDiffViewerPayloadLanguages(
  payload: DiffViewerPayload,
  options: { languagePackAvailable?: boolean } = {},
): Promise<DiffViewerPayload> {
  const [fileDiff, oldFile, newFile, payloadLangs] = await Promise.all([
    normalizeDiffPayloadFileLanguage(payload.fileDiff, options) as Promise<
      FileDiffMetadata | undefined
    >,
    normalizeDiffPayloadFileLanguage(payload.oldFile, options) as Promise<FileContents | undefined>,
    normalizeDiffPayloadFileLanguage(payload.newFile, options) as Promise<FileContents | undefined>,
    normalizeSupportedLanguageHints(payload.langs, { fallbackToText: false, ...options }),
  ]);
  const langs = new Set<SupportedLanguages>(payloadLangs);
  for (const lang of collectDiffPayloadLanguageHints({ fileDiff, oldFile, newFile })) {
    langs.add(lang);
  }
  if (langs.size === 0) {
    langs.add("text");
  }
  return {
    ...payload,
    fileDiff,
    oldFile,
    newFile,
    langs: [...langs],
  };
}

export function isBaseDiffViewerLanguage(lang: string): boolean {
  return BASE_LANGUAGE_HINTS.has(lang as SupportedLanguages);
}
