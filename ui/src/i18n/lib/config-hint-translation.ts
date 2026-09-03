import { fnv1aUtf16 } from "../../lib/fnv1a.ts";

export type ConfigHintTranslationField = "label" | "help";

function encodeConfigHintPath(hintPath: string): string {
  return encodeURIComponent(hintPath).replaceAll(".", "%2E");
}

function configHintTranslationDigest(sourceText: string): string {
  const normalizedSource = sourceText.trim().split(/\s+/).join(" ");
  return `v1-${fnv1aUtf16(normalizedSource).toString(36)}-${normalizedSource.length.toString(36)}`;
}

export function configHintTranslationKey(
  hintPath: string,
  field: ConfigHintTranslationField,
  sourceText: string,
): string {
  return `configHints.${encodeConfigHintPath(hintPath)}.${field}.${configHintTranslationDigest(sourceText)}`;
}
