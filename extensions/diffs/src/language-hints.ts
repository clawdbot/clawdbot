import { resolveLanguage } from "@pierre/diffs";
import type { FileContents, FileDiffMetadata, SupportedLanguages } from "@pierre/diffs";
import { normalizeOptionalString } from "openclaw/plugin-sdk/text-runtime";
import type { DiffViewerPayload } from "./types.js";

const PASSTHROUGH_LANGUAGE_HINTS = new Set<SupportedLanguages>(["ansi", "text"]);
type DiffPayloadFile = FileContents | FileDiffMetadata;

export async function normalizeSupportedLanguageHint(
  value?: string,
): Promise<SupportedLanguages | undefined> {
  const normalized = normalizeOptionalString(value);
  if (!normalized) {
    return undefined;
  }
  if (PASSTHROUGH_LANGUAGE_HINTS.has(normalized as SupportedLanguages)) {
    return normalized as SupportedLanguages;
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
): Promise<SupportedLanguages[]> {
  return normalizeSupportedLanguageHints(values, { fallbackToText: true });
}

async function normalizeSupportedLanguageHints(
  values: Iterable<string>,
  options: { fallbackToText: boolean },
): Promise<SupportedLanguages[]> {
  const supported = new Set<SupportedLanguages>();
  for (const value of values) {
    const normalized = await normalizeSupportedLanguageHint(value);
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
): Promise<DiffPayloadFile | undefined> {
  if (!file) {
    return undefined;
  }
  if (typeof file.lang !== "string") {
    return file;
  }
  const normalized = await normalizeSupportedLanguageHint(file.lang);
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
): Promise<DiffViewerPayload> {
  const [fileDiff, oldFile, newFile, payloadLangs] = await Promise.all([
    normalizeDiffPayloadFileLanguage(payload.fileDiff) as Promise<FileDiffMetadata | undefined>,
    normalizeDiffPayloadFileLanguage(payload.oldFile) as Promise<FileContents | undefined>,
    normalizeDiffPayloadFileLanguage(payload.newFile) as Promise<FileContents | undefined>,
    normalizeSupportedLanguageHints(payload.langs, { fallbackToText: false }),
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
