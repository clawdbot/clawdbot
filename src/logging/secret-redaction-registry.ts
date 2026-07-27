import { escapeRegExp } from "../shared/regexp.js";

const MIN_SECRET_VALUE_LENGTH = 6;
const MAX_SECRET_VALUES = 512;

const durableValues = new Map<string, true>();
const registeredValues = new Map<string, true>();
let compiledMatcher: RegExp | undefined;
let firstChars = new Set<string>();

function rebuildProbe(): void {
  firstChars = new Set(
    [...durableValues.keys(), ...registeredValues.keys()].map((value) => value.charAt(0)),
  );
  compiledMatcher = undefined;
}

function insertWithBoundedEviction(values: Map<string, true>, value: string): void {
  if (values.delete(value)) {
    values.set(value, true);
    return;
  }
  values.set(value, true);
  if (values.size > MAX_SECRET_VALUES) {
    const oldest = values.keys().next().value;
    if (oldest !== undefined) {
      values.delete(oldest);
    }
  }
  rebuildProbe();
}

function registerOneSecretValue(value: string, durable: boolean): void {
  if (durable) {
    registeredValues.delete(value);
    insertWithBoundedEviction(durableValues, value);
    return;
  }
  if (durableValues.has(value)) {
    return;
  }
  insertWithBoundedEviction(registeredValues, value);
}

function registerSecretValueForms(value: string, durable: boolean): void {
  if (value.length < MIN_SECRET_VALUE_LENGTH) {
    return;
  }
  // URL egress percent-encodes injected values; redact that surface form too.
  const encoded = encodeURIComponent(value);
  if (encoded !== value) {
    registerOneSecretValue(encoded, durable);
  }
  // Captured structured payloads are serialized before persistence, so retain
  // the JSON string-content form for credentials with escaped characters.
  const jsonEscaped = JSON.stringify(value).slice(1, -1);
  if (jsonEscaped !== value) {
    registerOneSecretValue(jsonEscaped, durable);
  }
  // Keep the raw value newest so bounded-registry eviction cannot drop the
  // active credential while retaining only a transformed representation.
  registerOneSecretValue(value, durable);
}

/** Registers one resolved secret for exact-value log redaction. */
export function registerSecretValueForRedaction(value: string): void {
  registerSecretValueForms(value, false);
}

export function registerDurableSecretValueForRedaction(value: string): void {
  registerSecretValueForms(value, true);
}

/** Returns whether a value has SecretRef provenance in the process registry. */
export function isSecretValueRegisteredForRedaction(value: string): boolean {
  return durableValues.has(value) || registeredValues.has(value);
}

export function hasRegisteredSecretValuesForRedaction(): boolean {
  return durableValues.size > 0 || registeredValues.size > 0;
}

/** Replaces registered exact values while preserving the caller's mask convention. */
export function redactRegisteredSecretValues(
  text: string,
  mask: (value: string) => string,
): string {
  if (!text || !hasRegisteredSecretValuesForRedaction()) {
    return text;
  }
  let couldMatch = false;
  for (const firstChar of firstChars) {
    if (text.includes(firstChar)) {
      couldMatch = true;
      break;
    }
  }
  if (!couldMatch) {
    return text;
  }
  compiledMatcher ??= new RegExp(
    [...durableValues.keys(), ...registeredValues.keys()]
      .toSorted((left, right) => right.length - left.length)
      .map(escapeRegExp)
      .join("|"),
    "g",
  );
  return text.replace(compiledMatcher, (value) => mask(value));
}

function resetSecretRedactionRegistryForTest(): void {
  durableValues.clear();
  registeredValues.clear();
  rebuildProbe();
}

if (process.env.VITEST || process.env.NODE_ENV === "test") {
  (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.secretRedactionRegistryTestApi")
  ] = { resetSecretRedactionRegistryForTest };
}
