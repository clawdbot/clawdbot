/**
 * Environment helper for Chutes model discovery behavior in tests.
 */
/** Returns whether dynamic Chutes model discovery should use test behavior. */
export function isChutesModelDiscoveryTestEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV === "test" || env.VITEST === "true";
}
