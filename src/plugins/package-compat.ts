// Checks package compatibility metadata for plugin manifests.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { prerelease as parseSemverPrerelease, satisfies as satisfiesSemver } from "semver";

function normalizePartialComparableVersion(version: string): {
  version: string;
  isPartial: boolean;
} {
  const trimmed = version.trim();
  return /^[vV]?[0-9]+\.[0-9]+$/.test(trimmed)
    ? { version: `${trimmed}.0`, isPartial: true }
    : { version: trimmed, isPartial: false };
}

function shouldPreservePluginApiPrereleaseFloor(target: string): boolean {
  return Boolean(parseSemverPrerelease(normalizePartialComparableVersion(target).version));
}

function normalizePluginApiVersionForComparator(version: string, target: string): string {
  const normalizedCorrection = normalizeOpenClawNumericCorrectionForPluginApi(version);
  if (normalizedCorrection) {
    return normalizedCorrection;
  }
  return shouldPreservePluginApiPrereleaseFloor(target)
    ? version
    : normalizeOpenClawReleaseSuffixForPluginApi(version);
}

function satisfiesComparator(version: string, token: string): boolean {
  const trimmed = token.trim();
  if (!trimmed) {
    return true;
  }
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(trimmed);
  if (!match) {
    return false;
  }
  const operator = match[1] ?? "";
  const target = match[2]?.trim();
  if (!target || /^[<>=^~]/.test(target)) {
    return false;
  }
  const comparableVersion = normalizePluginApiVersionForComparator(version, target);
  const normalizedTarget = normalizePartialComparableVersion(target);
  const comparator =
    normalizedTarget.isPartial && !operator
      ? `>=${normalizedTarget.version}`
      : `${operator}${normalizedTarget.version}`;
  return satisfiesSemver(comparableVersion, comparator, { includePrerelease: true });
}

function satisfiesSemverRange(version: string, range: string): boolean {
  if (range.includes("||")) {
    return false;
  }
  const tokens = normalizeStringEntries(range.trim().split(/\s+/));
  if (tokens.length === 0) {
    return false;
  }
  return tokens.every((token) => satisfiesComparator(version, token));
}

const OPENCLAW_RELEASE_SUFFIX_PATTERN =
  /^[vV]?(\d{4}\.[1-9]\d?\.[1-9]\d*)(?:-\d+|-(?:alpha|beta|rc)\.\d+)$/i;
const OPENCLAW_NUMERIC_CORRECTION_PATTERN = /^[vV]?(\d{4}\.[1-9]\d?\.[1-9]\d*)-\d+$/;

function normalizeOpenClawNumericCorrectionForPluginApi(
  pluginApiVersion: string,
): string | undefined {
  return OPENCLAW_NUMERIC_CORRECTION_PATTERN.exec(pluginApiVersion.trim())?.[1];
}

function normalizeOpenClawReleaseSuffixForPluginApi(pluginApiVersion: string): string {
  const match = OPENCLAW_RELEASE_SUFFIX_PATTERN.exec(pluginApiVersion.trim());
  return match?.[1] ?? pluginApiVersion;
}

/** Result of reading package.json openclaw.compat.pluginApi metadata. */
type PackagePluginApiRangeResult = { ok: true; range?: string } | { ok: false; error: string };

/** Resolves the plugin API compatibility range declared by package metadata. */
export function resolvePackagePluginApiRange(
  packageMetadata: unknown,
): PackagePluginApiRangeResult {
  if (packageMetadata === undefined || packageMetadata === null) {
    return { ok: true };
  }
  if (!isRecord(packageMetadata)) {
    return { ok: true };
  }
  if (!("compat" in packageMetadata)) {
    return { ok: true };
  }
  const compat = packageMetadata.compat;
  if (compat === undefined || compat === null) {
    return { ok: true };
  }
  if (!isRecord(compat)) {
    return { ok: false, error: "package.json openclaw.compat must be an object" };
  }
  if (!("pluginApi" in compat)) {
    return { ok: true };
  }
  const pluginApi = compat.pluginApi;
  if (typeof pluginApi !== "string") {
    return { ok: false, error: "package.json openclaw.compat.pluginApi must be a string" };
  }
  const range = pluginApi.trim();
  if (!range) {
    return { ok: false, error: "package.json openclaw.compat.pluginApi must not be empty" };
  }
  return { ok: true, range };
}

/** Checks whether a host plugin API version satisfies a package plugin API range. */
export function satisfiesPluginApiRange(
  pluginApiVersion: string,
  pluginApiRange?: string | null,
): boolean {
  if (!pluginApiRange) {
    return true;
  }
  return satisfiesSemverRange(pluginApiVersion, pluginApiRange);
}
