/**
 * Classifies deny entries in a harness's native app tool namespace, such as
 * `mcp__codex_apps__<app>_*`, that the harness enforces against its own app
 * projection instead of isolating the native tool surface.
 */
import { expandToolGroups, normalizeToolPolicyName } from "../tool-policy.js";

/**
 * True for `<prefix><literal>*` where `<literal>` holds no further wildcard.
 * `<literal>` may be empty (deny every native app).
 */
export function isHarnessNativeAppDenyPattern(
  normalizedName: string,
  normalizedPrefix: string,
): boolean {
  if (!normalizedName.startsWith(normalizedPrefix) || !normalizedName.endsWith("*")) {
    return false;
  }
  return !normalizedName.slice(normalizedPrefix.length, -1).includes("*");
}

export function normalizeHarnessNativeAppDenyPrefix(
  prefix: string | undefined,
): string | undefined {
  const normalized = prefix?.trim().toLowerCase();
  return normalized || undefined;
}

/** Sorted unique native-app deny patterns present in any of the given policies. */
export function collectHarnessDeniedNativeAppPatterns(
  policies: ReadonlyArray<{ allow?: string[]; deny?: string[] } | undefined>,
  normalizedPrefix: string | undefined,
): string[] {
  if (!normalizedPrefix) {
    return [];
  }
  const patterns = new Set<string>();
  for (const policy of policies) {
    for (const deniedName of expandToolGroups(policy?.deny ?? [])) {
      const normalized = normalizeToolPolicyName(deniedName);
      if (isHarnessNativeAppDenyPattern(normalized, normalizedPrefix)) {
        patterns.add(normalized);
      }
    }
  }
  return [...patterns].toSorted();
}
