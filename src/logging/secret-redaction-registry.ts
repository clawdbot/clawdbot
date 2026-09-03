import { pruneMapToMaxSize } from "../infra/map-size.js";
import { escapeRegExp } from "../shared/regexp.js";

const MIN_SECRET_VALUE_LENGTH = 6;
const MAX_SECRET_VALUES = 512;

const registeredValues = new Map<string, true>();
let compiledMatcher: { prefixes: RegExp; buckets: Map<string, string[]> } | undefined;
let firstChars: Set<string> | undefined;

function invalidateMatcher(): void {
  firstChars = undefined;
  compiledMatcher = undefined;
}

function registerOneSecretValue(value: string): void {
  if (registeredValues.delete(value)) {
    registeredValues.set(value, true);
    return;
  }
  registeredValues.set(value, true);
  pruneMapToMaxSize(registeredValues, MAX_SECRET_VALUES);
  invalidateMatcher();
}

/** Registers one resolved secret for exact-value log redaction. */
export function registerSecretValueForRedaction(value: string): void {
  if (value.length < MIN_SECRET_VALUE_LENGTH) {
    return;
  }
  // URL egress percent-encodes injected values; redact that surface form too.
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registerOneSecretValue(encoded);
  }
  // Captured structured payloads are serialized before persistence, so retain
  // the JSON string-content form for credentials with escaped characters.
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  if (jsonEscaped !== value) {
    registerOneSecretValue(jsonEscaped);
  }
  // Keep the raw value newest so bounded-registry eviction cannot drop the
  // active credential while retaining only a transformed representation.
  registerOneSecretValue(value);
}

/** Returns whether a value has SecretRef provenance in the process registry. */
export function isSecretValueRegisteredForRedaction(value: string): boolean {
  return registeredValues.has(value);
}

export function hasRegisteredSecretValuesForRedaction(): boolean {
  return registeredValues.size > 0;
}

/** Replaces registered exact values while preserving the caller's mask convention. */
export function redactRegisteredSecretValues(
  text: string,
  mask: (value: string) => string,
): string {
  if (!text || registeredValues.size === 0) {
    return text;
  }
  let couldMatch = false;
  // Registration can add several surface forms; prepare their probe once on first use.
  firstChars ??= new Set([...registeredValues.keys()].map((value) => value.charAt(0)));
  for (const firstChar of firstChars) {
    if (text.includes(firstChar)) {
      couldMatch = true;
      break;
    }
  }
  if (!couldMatch) {
    return text;
  }
  if (!compiledMatcher) {
    const buckets = new Map<string, string[]>();
    for (const value of [...registeredValues.keys()].toSorted(
      (left, right) => right.length - left.length,
    )) {
      const prefix = value.slice(0, MIN_SECRET_VALUE_LENGTH);
      const bucket = buckets.get(prefix);
      if (bucket) {
        bucket.push(value);
      } else {
        buckets.set(prefix, [value]);
      }
    }
    // Supported store values can exceed the regex engine's literal span limit.
    // Compile fixed-width prefixes; verify complete values against the text.
    compiledMatcher = {
      prefixes: new RegExp([...buckets.keys()].map(escapeRegExp).join("|"), "g"),
      buckets,
    };
  }
  const { prefixes, buckets } = compiledMatcher;
  const matches: { index: number; value: string }[] = [];
  prefixes.lastIndex = 0;
  for (let match = prefixes.exec(text); match; match = prefixes.exec(text)) {
    const index = match.index;
    const value = buckets.get(match[0])?.find((candidate) => text.startsWith(candidate, index));
    if (value !== undefined) {
      matches.push({ index, value });
    }
    // A rejected prefix may overlap a real match beginning one code unit later.
    prefixes.lastIndex = index + (value?.length ?? 1);
  }
  // Global replacement fixes its matches before callbacks. Nested registration
  // must affect the next/nested call, never the remainder of this one.
  let result = "";
  let cursor = 0;
  for (const match of matches) {
    result += `${text.slice(cursor, match.index)}${mask(match.value)}`;
    cursor = match.index + match.value.length;
  }
  return result + text.slice(cursor);
}

function resetSecretRedactionRegistryForTest(): void {
  registeredValues.clear();
  invalidateMatcher();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.secretRedactionRegistryTestApi")
  ] = { resetSecretRedactionRegistryForTest };
}
