export function isHuggingfaceModelDiscoveryTestEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.VITEST === "true" || env.NODE_ENV === "test";
}
