// Pure curated-memory annotation parsing shared by runtime and doctor paths.
export const INVALID_PROJECT_ANNOTATION_KEY = "!invalid-project-annotation";

// Carrier syntax is line-scoped like recall metadata parsing. Never cross a
// newline from an unterminated marker into the next entry's valid annotation.
const MEMORY_ANNOTATION_CARRIER_RE = /<!--\s*(?:trigger|importance|project)\s*:[^\r\n]*?-->/giu;

export function stripMemoryAnnotationCarriers(text: string): string {
  let stripped = false;
  const withoutCarriers = text.replace(MEMORY_ANNOTATION_CARRIER_RE, () => {
    stripped = true;
    return "";
  });
  return stripped ? withoutCarriers.replace(/[ \t]+(?=\r?$)/gmu, "") : text;
}

export type CuratedProjectAnnotations = {
  annotated: boolean;
  valid: boolean;
  keys: string[];
  rawCount: number;
  validCount: number;
};

export function normalizeProjectAnnotationKey(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || /[\r\n<>]/u.test(trimmed)) {
    return null;
  }
  if (trimmed.startsWith("path:")) {
    return trimmed;
  }
  const separator = trimmed.indexOf("/");
  if (separator < 1) {
    return trimmed;
  }
  // Preserve remote path case so case-sensitive hosts fail closed. Providers
  // with case-insensitive slugs may miss boosts/digests across casing variants,
  // but folding paths could cross-inject memory between distinct repositories.
  return `${trimmed.slice(0, separator).toLowerCase()}${trimmed.slice(separator)}`;
}

export function extractProjectKeysFromCuratedEntry(text: string): CuratedProjectAnnotations {
  const keys = new Set<string>();
  const markerCount = [...text.matchAll(/<!--\s*project\s*:/giu)].length;
  let parsedCount = 0;
  let rawCount = 0;
  let validCount = 0;
  for (const match of text.matchAll(/<!--\s*project\s*:\s*([\s\S]*?)\s*-->/giu)) {
    parsedCount += 1;
    for (const rawKey of (match[1] ?? "").split(";")) {
      rawCount += 1;
      const key = normalizeProjectAnnotationKey(rawKey);
      if (key) {
        keys.add(key);
        validCount += 1;
      }
    }
  }
  const annotated = markerCount > 0;
  return {
    annotated,
    valid: !annotated || (parsedCount === markerCount && rawCount > 0 && rawCount === validCount),
    keys: [...keys],
    rawCount,
    validCount,
  };
}
