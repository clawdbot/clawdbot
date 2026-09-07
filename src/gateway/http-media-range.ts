// Pure helpers for HTTP Accept media-range parsing.
import { splitHttpHeaderValue } from "./http-header-value.js";

const HTTP_TOKEN_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u;
const HTTP_QVALUE_PATTERN = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/u;
const HTTP_OPTIONAL_WHITESPACE_PATTERN = /^[\t ]+|[\t ]+$/gu;

function trimHttpOptionalWhitespace(value: string): string {
  return value.replace(HTTP_OPTIONAL_WHITESPACE_PATTERN, "");
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
  const segments = splitHttpHeaderValue(value, ";", "quoted-string");
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

function matchesRepresentation(
  range: ParsedMediaType,
  representation: ParsedMediaType,
  allowWildcards: boolean,
): boolean {
  const exact = range.type === representation.type && range.subtype === representation.subtype;
  const wildcard =
    allowWildcards &&
    range.subtype === "*" &&
    (range.type === "*" || range.type === representation.type);
  if (!exact && !wildcard) {
    return false;
  }
  for (const [name, value] of range.parameters) {
    if (representation.parameters.get(name) !== value) {
      return false;
    }
  }
  return true;
}

/** Checks the quality of the most specific range matching the offered representation. */
export function acceptsMediaType(
  accept: string | undefined,
  expectedRepresentation: string,
  allowWildcards = true,
): boolean {
  if (!accept) {
    return false;
  }
  const representation = parseMediaType(expectedRepresentation, false);
  if (!representation) {
    return false;
  }

  const ranges = splitHttpHeaderValue(accept, ",", "quoted-string");
  if (!ranges) {
    return false;
  }
  let bestMediaSpecificity = -1;
  let bestParameterSpecificity = -1;
  let bestQuality = 0;
  for (const range of ranges) {
    const parsedRange = parseMediaType(range, true);
    if (!parsedRange || !matchesRepresentation(parsedRange, representation, allowWildcards)) {
      continue;
    }
    // Exact types outrank parameterized wildcards; parameters only break type ties.
    const mediaSpecificity = parsedRange.type === "*" ? 0 : parsedRange.subtype === "*" ? 1 : 2;
    const parameterSpecificity = parsedRange.parameters.size;
    const comparison =
      mediaSpecificity - bestMediaSpecificity || parameterSpecificity - bestParameterSpecificity;
    if (comparison > 0) {
      bestMediaSpecificity = mediaSpecificity;
      bestParameterSpecificity = parameterSpecificity;
      bestQuality = parsedRange.quality;
    } else if (comparison === 0) {
      bestQuality = Math.max(bestQuality, parsedRange.quality);
    }
  }
  return bestQuality > 0;
}

/** Wildcards cannot opt callers into long-lived streaming responses. */
export function hasExplicitAcceptableMediaRange(
  accept: string | undefined,
  expectedRepresentation: string,
): boolean {
  return acceptsMediaType(accept, expectedRepresentation, false);
}
