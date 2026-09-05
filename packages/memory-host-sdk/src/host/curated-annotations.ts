// Pure curated-memory annotation parsing shared by runtime and doctor paths.
export const INVALID_PROJECT_ANNOTATION_KEY = "!invalid-project-annotation";

function* scanMemoryAnnotations(text: string, marker: RegExp, lineScoped = false) {
  let closing = -1;
  let newline = -1;
  const lineBreak = /[\r\n]/gu;
  for (let match = marker.exec(text); match; match = marker.exec(text)) {
    const valueStart = marker.lastIndex;
    // Failed carriers can contain later openers. Reuse forward-only delimiter
    // positions so those openers never rescan the same unterminated suffix.
    if (closing < valueStart) {
      closing = text.indexOf("-->", valueStart);
      if (closing < 0) {
        return;
      }
    }
    if (lineScoped) {
      if (newline < valueStart) {
        lineBreak.lastIndex = valueStart;
        newline = lineBreak.exec(text)?.index ?? text.length;
      }
      if (newline < closing) {
        continue;
      }
    }
    yield {
      start: match.index,
      end: closing + 3,
      kind: match[1]?.toLowerCase(),
      value: text.slice(valueStart, closing).trim(),
    };
    marker.lastIndex = closing + 3;
  }
}

export function stripMemoryAnnotationCarriers(text: string): string {
  const parts: string[] = [];
  let cursor = 0;
  // Only the body is line-scoped; preserve the existing whitespace-prefix grammar.
  for (const annotation of scanMemoryAnnotations(
    text,
    /<!--\s*(trigger|importance|project)\s*:/giu,
    true,
  )) {
    parts.push(text.slice(cursor, annotation.start));
    cursor = annotation.end;
  }
  if (cursor === 0) {
    return text;
  }
  parts.push(text.slice(cursor));
  return parts.join("").replace(/[ \t]+/gu, (space, offset, source: string) => {
    const end = offset + space.length;
    return end === source.length || /[\r\n\u2028\u2029]/u.test(source.charAt(end)) ? "" : space;
  });
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
  // Projects are scanned independently: a project marker inside another
  // annotation still scopes the entry, and nested project markers stay invalid.
  for (const annotation of scanMemoryAnnotations(text, /<!--\s*(project)\s*:/giu)) {
    parsedCount += 1;
    for (const rawKey of annotation.value.split(";")) {
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

export function extractCuratedEntryRecallMetadata(params: {
  sourceLines: string[];
  curatedRoot: boolean;
  projectScopeEligible: boolean;
}): { importance: number | null; triggers: string | null; projectKey: string | null } {
  const phrases = new Set<string>();
  let importance: number | null = null;
  const projectAnnotations = params.projectScopeEligible
    ? extractProjectKeysFromCuratedEntry(params.sourceLines.join("\n"))
    : { annotated: false, valid: true, keys: [] };
  for (const line of params.curatedRoot ? params.sourceLines : []) {
    // The original suffix may span intervening text or ordinary comments.
    // Its only additional constraint is a closing marker at the end of the line.
    if (!line.trimEnd().endsWith("-->")) {
      continue;
    }
    for (const { kind, value } of scanMemoryAnnotations(
      line,
      /<!--\s*(trigger|importance|project)\s*:/giu,
    )) {
      if (kind === "trigger") {
        for (const phrase of value.split(/[,;]/u).map((entry) => entry.trim())) {
          if (phrase) {
            phrases.add(phrase);
          }
        }
      } else if (kind === "importance" && /^\d+$/u.test(value)) {
        const parsed = Number.parseInt(value, 10);
        if (parsed >= 1 && parsed <= 10) {
          importance = Math.max(importance ?? parsed, parsed);
        }
      }
    }
  }
  // Missing annotations retain neutral ranking and never become trigger candidates.
  return {
    importance,
    triggers: phrases.size > 0 ? [...phrases].join("; ") : null,
    // Invalid project metadata must not turn a scoped entry into global memory.
    projectKey:
      projectAnnotations.annotated && !projectAnnotations.valid
        ? INVALID_PROJECT_ANNOTATION_KEY
        : projectAnnotations.keys.length > 0
          ? projectAnnotations.keys.join("; ")
          : null,
  };
}
