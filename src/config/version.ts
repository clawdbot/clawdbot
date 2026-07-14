// Normalizes config version metadata and compatibility comparisons.
import { compare as compareSemver, parse as parseSemver } from "semver";
import { normalizeLegacyDotBetaVersion } from "../infra/semver.js";

type OpenClawVersion = {
  major: number;
  minor: number;
  patch: number;
  revision: number | null;
  prerelease: string[] | null;
};

/** Parses stable, prerelease, and legacy dot-beta OpenClaw versions. */
function parseOpenClawVersion(raw: string | null | undefined): OpenClawVersion | null {
  if (!raw) {
    return null;
  }
  const normalized = normalizeLegacyDotBetaVersion(raw.trim());
  const parsed = parseSemver(normalized);
  if (!parsed) {
    return null;
  }
  const revision =
    parsed.prerelease.length === 1 && typeof parsed.prerelease[0] === "number"
      ? parsed.prerelease[0]
      : null;
  return {
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    revision,
    prerelease:
      parsed.prerelease.length > 0 && revision == null
        ? parsed.prerelease.map((part) => String(part))
        : null,
  };
}

export function normalizeOpenClawVersionBase(raw: string | null | undefined): string | null {
  const parsed = parseOpenClawVersion(raw);
  if (!parsed) {
    return null;
  }
  return `${parsed.major}.${parsed.minor}.${parsed.patch}`;
}

function isSameOpenClawStableFamily(
  a: string | null | undefined,
  b: string | null | undefined,
): boolean {
  const parsedA = parseOpenClawVersion(a);
  const parsedB = parseOpenClawVersion(b);
  if (!parsedA || !parsedB) {
    return false;
  }
  if (parsedA.prerelease?.length || parsedB.prerelease?.length) {
    return false;
  }
  return (
    parsedA.major === parsedB.major &&
    parsedA.minor === parsedB.minor &&
    parsedA.patch === parsedB.patch
  );
}

export function compareOpenClawVersions(
  a: string | null | undefined,
  b: string | null | undefined,
): number | null {
  const parsedA = parseOpenClawVersion(a);
  const parsedB = parseOpenClawVersion(b);
  if (!parsedA || !parsedB) {
    return null;
  }
  const sameCore =
    parsedA.major === parsedB.major &&
    parsedA.minor === parsedB.minor &&
    parsedA.patch === parsedB.patch;
  // Numeric suffixes are shipped OpenClaw correction releases, ordered after the base stable.
  if (sameCore && (parsedA.revision != null || parsedB.revision != null)) {
    const rankA = releaseRank(parsedA);
    const rankB = releaseRank(parsedB);
    if (rankA !== rankB) {
      return rankA < rankB ? -1 : 1;
    }
    if (
      parsedA.revision != null &&
      parsedB.revision != null &&
      parsedA.revision !== parsedB.revision
    ) {
      return parsedA.revision < parsedB.revision ? -1 : 1;
    }
  }
  return compareSemver(formatComparableVersion(parsedA), formatComparableVersion(parsedB));
}

export function shouldWarnOnTouchedVersion(
  current: string | null | undefined,
  touched: string | null | undefined,
): boolean {
  const parsedCurrent = parseOpenClawVersion(current);
  const parsedTouched = parseOpenClawVersion(touched);
  if (
    parsedCurrent &&
    parsedTouched &&
    parsedCurrent.major === parsedTouched.major &&
    parsedCurrent.minor === parsedTouched.minor &&
    parsedCurrent.patch === parsedTouched.patch
  ) {
    if (!parsedTouched.prerelease?.length) {
      return false;
    }
  }
  if (isSameOpenClawStableFamily(current, touched)) {
    return false;
  }
  const cmp = compareOpenClawVersions(current, touched);
  return cmp !== null && cmp < 0;
}

function releaseRank(version: OpenClawVersion): number {
  if (version.prerelease?.length) {
    return 0;
  }
  if (version.revision != null) {
    return 2;
  }
  return 1;
}

function formatComparableVersion(version: OpenClawVersion): string {
  const base = `${version.major}.${version.minor}.${version.patch}`;
  if (version.revision != null) {
    return `${base}-${version.revision}`;
  }
  return version.prerelease?.length ? `${base}-${version.prerelease.join(".")}` : base;
}
