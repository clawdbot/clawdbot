import { compare, valid } from "semver";

export function compareValidSemver(left: string, right: string): number | null {
  const validLeft = valid(left);
  const validRight = valid(right);
  return validLeft && validRight ? compare(validLeft, validRight) : null;
}

/** Converts legacy OpenClaw `1.2.3.beta.N` tags into valid SemVer prereleases. */
export function normalizeLegacyDotBetaVersion(version: string): string {
  const trimmed = version.trim();
  const dotBetaMatch = /^([vV]?[0-9]+\.[0-9]+\.[0-9]+)\.beta(?:\.([0-9A-Za-z.-]+))?$/.exec(trimmed);
  if (!dotBetaMatch) {
    return trimmed;
  }
  const base = dotBetaMatch[1];
  const suffix = dotBetaMatch[2];
  return suffix ? `${base}-beta.${suffix}` : `${base}-beta`;
}
