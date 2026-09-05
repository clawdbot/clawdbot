// Owns the placeholder values that mean "a JS undefined/null reached the config
// writer" rather than a real Gateway secret. Writers reject these at the prompt
// boundary, but configs written before that guard existed still carry them, so
// doctor and the security audit need the same canonical list to detect them.
const GATEWAY_TOKEN_SENTINEL_VALUES = new Set(["undefined", "null"]);

/**
 * True when a Gateway token literal is a stringified nullish sentinel
 * (`"undefined"` / `"null"`). Such a value is accepted as a bearer token by any
 * naive truthiness check while being trivially guessable.
 */
export function isStringifiedNullishToken(value: unknown): boolean {
  return typeof value === "string" && GATEWAY_TOKEN_SENTINEL_VALUES.has(value.trim());
}
