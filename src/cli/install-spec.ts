// Install spec classifier used before package resolution or local path expansion.
import path from "node:path";

/** Detect specs that should be interpreted as local file/path installs. */
export function looksLikeLocalInstallSpec(spec: string, knownSuffixes: readonly string[]): boolean {
  return (
    spec.startsWith(".") ||
    spec.startsWith("~") ||
    path.isAbsolute(spec) ||
    knownSuffixes.some((suffix) => spec.endsWith(suffix))
  );
}
