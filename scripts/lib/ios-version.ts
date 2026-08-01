// Ios Version script supports OpenClaw repository automation.
import { readFileSync } from "node:fs";
import path from "node:path";
import { parseReleaseVersion } from "./release-version.mjs";

const IOS_CHANGELOG_FILE = "apps/ios/CHANGELOG.md";
export const MAX_IOS_APP_STORE_REVISION = 9;

type ResolvedIosVersion = {
  appStoreRevision: number | null;
  appStoreVersion: string | null;
  canonicalVersion: string;
  gatewayVersion: string;
  marketingVersion: string;
  buildVersion: string;
  changelogPath: string;
  versionSource: "explicit" | "package";
  versionSourcePath: string | null;
};

type SyncIosVersioningMode = "check" | "write";

function parsePinnedReleaseVersion(rawVersion: string): string | null {
  const parsed = parseReleaseVersion(rawVersion.trim());
  if (!parsed || parsed.version !== parsed.baseVersion) {
    return null;
  }
  return parsed.baseVersion;
}

export function normalizePinnedIosVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim();
  if (!trimmed) {
    throw new Error("Missing iOS release version.");
  }

  const pinnedVersion = parsePinnedReleaseVersion(trimmed);
  if (!pinnedVersion) {
    throw new Error(`Invalid iOS version '${rawVersion}'. Expected release version like 2026.6.5.`);
  }

  return pinnedVersion;
}

export function normalizeIosAppStoreRevision(rawRevision: string | number): number {
  const normalized = String(rawRevision).trim();
  if (!/^(?:0|[1-9]\d*)$/u.test(normalized)) {
    throw new Error(
      `Invalid iOS App Store revision '${rawRevision}'. Expected an integer from 0 to ${MAX_IOS_APP_STORE_REVISION}.`,
    );
  }

  const revision = Number(normalized);
  if (!Number.isSafeInteger(revision) || revision > MAX_IOS_APP_STORE_REVISION) {
    throw new Error(
      `Invalid iOS App Store revision '${rawRevision}'. Expected an integer from 0 to ${MAX_IOS_APP_STORE_REVISION}.`,
    );
  }
  return revision;
}

export function encodeIosAppStoreVersion(
  gatewayVersion: string,
  appStoreRevision: string | number,
): string {
  const canonicalVersion = normalizePinnedIosVersion(gatewayVersion);
  const parsed = parseReleaseVersion(canonicalVersion);
  if (!parsed) {
    throw new Error(`Unable to encode invalid gateway version '${gatewayVersion}'.`);
  }

  const revision = normalizeIosAppStoreRevision(appStoreRevision);
  // Append one revision digit without padding. Keeping the revision to one
  // digit preserves App Store ordering when the gateway patch increments.
  const encodedPatch = Number(`${parsed.patch}${revision}`);
  if (!Number.isSafeInteger(encodedPatch)) {
    throw new Error(`Encoded iOS App Store version is too large for '${gatewayVersion}'.`);
  }
  return `${parsed.year}.${parsed.month}.${encodedPatch}`;
}

export function normalizeGatewayVersionToPinnedIosVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim().replace(/^v/u, "");
  if (!trimmed) {
    throw new Error("Missing root package.json version.");
  }

  const parsed = parseReleaseVersion(trimmed);
  if (!parsed) {
    throw new Error(
      `Invalid gateway version '${rawVersion}'. Expected YYYY.M.PATCH, YYYY.M.PATCH-alpha.N, YYYY.M.PATCH-beta.N, or YYYY.M.PATCH-N.`,
    );
  }

  return parsed.baseVersion;
}

function rootPackageJsonPath(rootDir = path.resolve(".")): string {
  return path.join(rootDir, "package.json");
}

function readRootPackageVersion(rootDir = path.resolve(".")): string {
  const packageJsonPath = rootPackageJsonPath(rootDir);
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
  if (!version) {
    throw new Error(`Missing package.json version in ${packageJsonPath}.`);
  }
  return version;
}

export function resolveGatewayVersionForIosRelease(rootDir = path.resolve(".")): {
  packageVersion: string;
  pinnedIosVersion: string;
} {
  const packageVersion = readRootPackageVersion(rootDir);
  return {
    packageVersion,
    pinnedIosVersion: normalizeGatewayVersionToPinnedIosVersion(packageVersion),
  };
}

export function resolveIosVersion(
  rootDir = path.resolve("."),
  options?: { appStoreRevision?: string | number | null; releaseVersion?: string | null },
): ResolvedIosVersion {
  const changelogPath = path.join(rootDir, IOS_CHANGELOG_FILE);
  const explicitReleaseVersion = options?.releaseVersion?.trim() ?? "";
  const canonicalVersion = explicitReleaseVersion
    ? normalizePinnedIosVersion(explicitReleaseVersion)
    : resolveGatewayVersionForIosRelease(rootDir).pinnedIosVersion;
  const rawAppStoreRevision = options?.appStoreRevision;
  const appStoreRevision =
    rawAppStoreRevision === null || rawAppStoreRevision === undefined
      ? null
      : normalizeIosAppStoreRevision(rawAppStoreRevision);
  const appStoreVersion =
    appStoreRevision === null ? null : encodeIosAppStoreVersion(canonicalVersion, appStoreRevision);

  return {
    appStoreRevision,
    appStoreVersion,
    canonicalVersion,
    gatewayVersion: canonicalVersion,
    marketingVersion: appStoreVersion ?? canonicalVersion,
    buildVersion: "1",
    changelogPath,
    versionSource: explicitReleaseVersion ? "explicit" : "package",
    versionSourcePath: explicitReleaseVersion ? null : rootPackageJsonPath(rootDir),
  };
}

function matchChangelogHeading(line: string, heading: string): boolean {
  const normalized = line.trim();
  return normalized === `## ${heading}` || normalized.startsWith(`## ${heading} - `);
}

export function extractChangelogSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/);
  const startIndex = lines.findIndex((line) => matchChangelogHeading(line, heading));
  if (startIndex === -1) {
    return null;
  }

  let endIndex = lines.length;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("## ")) {
      endIndex = index;
      break;
    }
  }

  const body = lines
    .slice(startIndex + 1, endIndex)
    .join("\n")
    .trim();
  return body || null;
}

export function renderIosReleaseNotes(
  version: ResolvedIosVersion,
  changelogContent: string,
): string {
  const candidateHeadings =
    version.appStoreRevision === null
      ? [version.canonicalVersion, "Unreleased"]
      : [version.marketingVersion];

  for (const heading of candidateHeadings) {
    const body = extractChangelogSection(changelogContent, heading);
    if (body) {
      const gatewayPrefix =
        version.appStoreRevision === null ? "" : `Gateway version: ${version.gatewayVersion}\n\n`;
      return `${gatewayPrefix}${body}\n`;
    }
  }

  throw new Error(
    `Unable to find iOS changelog notes for ${version.marketingVersion}. Add a matching section to ${IOS_CHANGELOG_FILE}.`,
  );
}

export function syncIosVersioning(params?: {
  appStoreRevision?: string | number | null;
  mode?: SyncIosVersioningMode;
  releaseVersion?: string | null;
  rootDir?: string;
}): {
  updatedPaths: string[];
} {
  const rootDir = path.resolve(params?.rootDir ?? ".");
  const releaseVersion = params?.releaseVersion;
  const version = resolveIosVersion(rootDir, {
    appStoreRevision: params?.appStoreRevision,
    releaseVersion,
  });
  const changelogContent = readFileSync(version.changelogPath, "utf8");
  renderIosReleaseNotes(version, changelogContent);

  return { updatedPaths: [] };
}

export function renderIosReleaseNotesForVersion(params?: {
  appStoreRevision?: string | number | null;
  releaseVersion?: string | null;
  rootDir?: string;
}): string {
  const rootDir = path.resolve(params?.rootDir ?? ".");
  const version = resolveIosVersion(rootDir, {
    appStoreRevision: params?.appStoreRevision,
    releaseVersion: params?.releaseVersion,
  });
  const changelogContent = readFileSync(version.changelogPath, "utf8");
  return renderIosReleaseNotes(version, changelogContent);
}
