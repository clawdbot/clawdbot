// Pure helpers for HTTP Accept media-range parsing.

const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HTTP_QVALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u;
const HTTP_OPTIONAL_WHITESPACE_PATTERN = /^[\t ]+|[\t ]+$/gu;

function trimHttpOptionalWhitespace(value: string): string {
  return value.replace(HTTP_OPTIONAL_WHITESPACE_PATTERN, "");
}

function splitOutsideQuotedStrings(value: string, delimiter: string): string[] | null {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (character === "\\") {
        escaped = true;
        continue;
      }
      if (character === '"') {
        quoted = false;
      }
      continue;
    }
    if (character === '"') {
      quoted = true;
      continue;
    }
    if (character === delimiter) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }

  if (quoted || escaped) {
    return null;
  }
  parts.push(value.slice(start));
  return parts;
}

function parseParameterValue(value: string): string | null {
  if (HTTP_TOKEN_PATTERN.test(value)) {
    return value;
  }
  if (value.length < 2 || value[0] !== '"' || value.at(-1) !== '"') {
    return null;
  }
  let parsed = "";
  let escaped = false;
  for (let index = 1; index < value.length - 1; index += 1) {
    const character = value[index];
    if (escaped) {
      parsed += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      return null;
    }
    parsed += character;
  }
  return escaped ? null : parsed;
}

function normalizeParameterValue(name: string, value: string): string {
  return name === "charset" ? value.toLowerCase() : value;
}

type ParsedMediaType = {
  type: string;
  subtype: string;
  parameters: Map<string, string>;
  quality: number;
};

function parseMediaType(value: string, allowQuality: boolean): ParsedMediaType | null {
  const segments = splitOutsideQuotedStrings(value, ";");
  if (!segments) {
    return null;
  }
  const mediaType = trimHttpOptionalWhitespace(segments.shift() ?? "").toLowerCase();
  const [type, subtype, ...extra] = mediaType.split("/");
  if (
    extra.length > 0 ||
    !type ||
    !subtype ||
    !HTTP_TOKEN_PATTERN.test(type) ||
    !HTTP_TOKEN_PATTERN.test(subtype)
  ) {
    return null;
  }

  let quality = 1;
  let qualitySeen = false;
  const parameters = new Map<string, string>();
  for (const rawParameter of segments) {
    const parameter = trimHttpOptionalWhitespace(rawParameter);
    // RFC 9110 permits a semicolon whose optional parameter is omitted.
    if (!parameter) {
      continue;
    }
    const separator = parameter.indexOf("=");
    const name = (separator < 0 ? parameter : parameter.slice(0, separator)).toLowerCase();
    if (!HTTP_TOKEN_PATTERN.test(name)) {
      return null;
    }
    if (separator <= 0) {
      return null;
    }
    // Parameter grammar has no whitespace around `=`; accepting it can route
    // a malformed negotiation request into a persistent SSE response.
    const rawValue = parameter.slice(separator + 1);
    if (!rawValue) {
      return null;
    }
    if (name === "q") {
      // RFC 9110 recognizes q as the weight regardless of parameter order;
      // every other parameter still participates in representation matching.
      if (!allowQuality || qualitySeen || !HTTP_QVALUE_PATTERN.test(rawValue)) {
        return null;
      }
      qualitySeen = true;
      quality = Number(rawValue);
      continue;
    }
    const parameterValue = parseParameterValue(rawValue);
    if (parameterValue === null || parameters.has(name)) {
      return null;
    }
    parameters.set(name, normalizeParameterValue(name, parameterValue));
  }
  return { type, subtype, parameters, quality };
}

type MediaRangeSpecificity = readonly [mediaType: number, parameters: number];

function parametersMatchRepresentation(
  range: ParsedMediaType,
  representation: ParsedMediaType,
): boolean {
  for (const [name, value] of range.parameters) {
    if (representation.parameters.get(name) !== value) {
      return false;
    }
  }
  return true;
}

function mediaRangeSpecificity(
  range: ParsedMediaType,
  representation: ParsedMediaType,
): MediaRangeSpecificity | null {
  let mediaType: number;
  if (range.type === "*" && range.subtype === "*") {
    mediaType = 0;
  } else if (range.type !== representation.type) {
    return null;
  } else if (range.subtype === "*") {
    mediaType = 1;
  } else if (range.subtype === representation.subtype) {
    mediaType = 2;
  } else {
    return null;
  }
  return parametersMatchRepresentation(range, representation)
    ? [mediaType, range.parameters.size]
    : null;
}

function compareSpecificity(left: MediaRangeSpecificity, right: MediaRangeSpecificity): number {
  // Type specificity wins before parameter count; otherwise a parameterized
  // wildcard could incorrectly override an exact representation match.
  return left[0] - right[0] || left[1] - right[1];
}

function hasPositiveQualityAtBestSpecificity(
  accept: string | undefined,
  getSpecificity: (range: ParsedMediaType) => MediaRangeSpecificity | null,
): boolean {
  if (!accept) {
    return false;
  }
  const ranges = splitOutsideQuotedStrings(accept, ",");
  if (!ranges) {
    return false;
  }

  let bestSpecificity: MediaRangeSpecificity | null = null;
  let bestQuality = 0;
  for (const range of ranges) {
    const parsedRange = parseMediaType(range, true);
    if (!parsedRange) {
      continue;
    }
    const specificity = getSpecificity(parsedRange);
    if (!specificity) {
      continue;
    }
    const comparison = bestSpecificity ? compareSpecificity(specificity, bestSpecificity) : 1;
    if (comparison > 0) {
      bestSpecificity = specificity;
      bestQuality = parsedRange.quality;
    } else if (comparison === 0) {
      bestQuality = Math.max(bestQuality, parsedRange.quality);
    }
  }
  return bestSpecificity !== null && bestQuality > 0;
}

/** Checks whether an Accept field permits an offered media type. */
export function acceptsMediaType(accept: string | undefined, offeredMediaType: string): boolean {
  const representation = parseMediaType(offeredMediaType, false);
  if (!representation) {
    return false;
  }
  return hasPositiveQualityAtBestSpecificity(accept, (range) =>
    mediaRangeSpecificity(range, representation),
  );
}

/**
 * Checks for an explicit, positive-quality media range in an Accept field.
 * Wildcards intentionally do not opt callers into long-lived streaming responses.
 */
export function hasExplicitAcceptableMediaRange(
  accept: string | undefined,
  expectedRepresentation: string,
): boolean {
  const representation = parseMediaType(expectedRepresentation, false);
  if (!representation) {
    return false;
  }
  return hasPositiveQualityAtBestSpecificity(accept, (range) => {
    const specificity = mediaRangeSpecificity(range, representation);
    return specificity?.[0] === 2 ? specificity : null;
  });
}
