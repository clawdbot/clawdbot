// Candidate-package compatibility helpers for E2E acceptance scripts.
import { readFileSync } from "node:fs";
import { stripVTControlCharacters } from "node:util";
import { isDirectRunUrl } from "../../lib/direct-run.mjs";

export function legacyPackageAcceptanceCompat(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[-+].*)?/.exec(version || "");
  const [year, month, day] = match?.slice(1, 4).map(Number) ?? [];
  return (
    Boolean(match) && (year < 2026 || (year === 2026 && (month < 4 || (month === 4 && day <= 25))))
  );
}

// Candidates on either side of consent enforcement can share a package version.
// Only successful command help establishes support; callers own probe failures.
export function fixtureCapabilityConsentArgs(help) {
  return /^[\t ]*--accept-capabilities(?:[\t ]|$)/m.test(stripVTControlCharacters(help))
    ? ["--accept-capabilities"]
    : [];
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  console.log(
    process.argv[2] === "fixture-consent"
      ? fixtureCapabilityConsentArgs(readFileSync(0, "utf8")).join("\n")
      : legacyPackageAcceptanceCompat(process.argv[2])
        ? "1"
        : "0",
  );
}
