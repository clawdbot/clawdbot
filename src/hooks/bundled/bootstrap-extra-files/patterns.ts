import { normalizeTrimmedStringList } from "@openclaw/normalization-core/string-normalization";

export type ExtraBootstrapPatternKey = "paths" | "patterns" | "files";

export function resolveExtraBootstrapPatternConfig(
  hookConfig: Record<string, unknown>,
): { key: ExtraBootstrapPatternKey; patterns: string[] } | undefined {
  for (const key of ["paths", "patterns", "files"] as const) {
    const patterns = normalizeTrimmedStringList(hookConfig[key]);
    if (patterns.length > 0) {
      return { key, patterns };
    }
  }
  return undefined;
}

/** Resolve legacy and current config keys for extra bootstrap file patterns. */
export function resolveExtraBootstrapPatterns(hookConfig: Record<string, unknown>): string[] {
  return resolveExtraBootstrapPatternConfig(hookConfig)?.patterns ?? [];
}
