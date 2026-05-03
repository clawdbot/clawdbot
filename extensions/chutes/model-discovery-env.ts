export function isChutesModelDiscoveryTestEnvironment(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV === "test" || env.VITEST === "true";
}
