// Android Version script supports OpenClaw repository automation.
import { readFileSync } from "node:fs";
import path from "node:path";
import { decodeIosAppStoreVersion } from "./ios-release-plan.ts";
import { encodeIosAppStoreVersion } from "./ios-version.ts";
import { readMobileVersionManifest } from "./mobile-version.ts";
import { parseReleaseVersion } from "./release-version.mjs";

const ANDROID_VERSION_FILE = "apps/android/version.json";
const ANDROID_CHANGELOG_FILE = "apps/android/CHANGELOG.md";
const ANDROID_VERSION_PROPERTIES_FILE = "apps/android/Config/Version.properties";
const ANDROID_RELEASE_NOTES_FILE = "apps/android/fastlane/metadata/android/en-US/release_notes.txt";
const IOS_CHANGELOG_FILE = "apps/ios/CHANGELOG.md";
const ANDROID_VERSION_CODE_MAX = 2_100_000_000;

type AndroidVersionManifest = {
  version: string;
  versionCode: number;
};

type ResolvedAndroidVersion = {
  canonicalVersion: string;
  iosChangelogPath: string;
  legacyChangelogPath: string;
  releaseNotesPath: string;
  versionCode: number;
  versionFilePath: string;
  versionPropertiesPath: string;
};

function normalizeTrailingNewline(value: string): string {
  return value.endsWith("\n") ? value : `${value}\n`;
}

function parsePinnedReleaseVersion(rawVersion: string): string | null {
  const parsed = parseReleaseVersion(rawVersion.trim());
  if (!parsed || parsed.version !== parsed.baseVersion) {
    return null;
  }
  return parsed.baseVersion;
}

export function normalizePinnedAndroidVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim();
  if (!trimmed) {
    throw new Error(`Missing Android version in ${ANDROID_VERSION_FILE}.`);
  }

  const pinnedVersion = parsePinnedReleaseVersion(trimmed);
  if (!pinnedVersion) {
    throw new Error(
      `Invalid Android version '${rawVersion}'. Expected pinned release version like 2026.6.5.`,
    );
  }

  return pinnedVersion;
}

export function canonicalAndroidVersionCode(version: string): number {
  const canonicalVersion = normalizePinnedAndroidVersion(version);
  const [year, rawMonth, rawPatch] = canonicalVersion.split(".");
  const month = rawMonth?.padStart(2, "0");
  const patch = rawPatch?.padStart(2, "0");
  const versionCode = Number(`${year}${month}${patch}01`);
  if (
    !Number.isSafeInteger(versionCode) ||
    versionCode <= 0 ||
    versionCode > ANDROID_VERSION_CODE_MAX
  ) {
    throw new Error(`Unable to derive Android versionCode from ${canonicalVersion}.`);
  }
  return versionCode;
}

export function normalizeAndroidVersionCode(rawVersionCode: number, version: string): number {
  if (
    !Number.isInteger(rawVersionCode) ||
    rawVersionCode <= 0 ||
    rawVersionCode > ANDROID_VERSION_CODE_MAX
  ) {
    throw new Error(
      `Invalid Android versionCode '${rawVersionCode}'. Expected a positive integer no greater than 2100000000.`,
    );
  }

  const prefix = canonicalAndroidVersionCode(version).toString().slice(0, -2);
  const raw = rawVersionCode.toString();
  const suffix = Number.parseInt(raw.slice(prefix.length), 10);
  if (
    !raw.startsWith(prefix) ||
    raw.length !== prefix.length + 2 ||
    !Number.isInteger(suffix) ||
    suffix < 1 ||
    suffix > 99
  ) {
    throw new Error(
      `Invalid Android versionCode '${rawVersionCode}'. Expected ${prefix}01 through ${prefix}99 for version ${version}.`,
    );
  }

  return rawVersionCode;
}

export function resolveGatewayVersionForAndroidRelease(rootDir = path.resolve(".")): {
  gatewayVersion: string;
  pinnedAndroidVersion: string;
  versionCode: number;
} {
  const gatewayVersion = readMobileVersionManifest(rootDir).version;
  const pinnedAndroidVersion = normalizePinnedAndroidVersion(gatewayVersion);
  return {
    gatewayVersion,
    pinnedAndroidVersion,
    versionCode: canonicalAndroidVersionCode(pinnedAndroidVersion),
  };
}

function readAndroidVersionManifest(rootDir = path.resolve(".")): AndroidVersionManifest {
  const versionFilePath = path.join(rootDir, ANDROID_VERSION_FILE);
  return JSON.parse(readFileSync(versionFilePath, "utf8")) as AndroidVersionManifest;
}

export function renderAndroidVersionManifest(version: string, versionCode: number): string {
  const normalizedVersion = normalizePinnedAndroidVersion(version);
  const normalizedVersionCode = normalizeAndroidVersionCode(versionCode, normalizedVersion);
  return `${JSON.stringify(
    { version: normalizedVersion, versionCode: normalizedVersionCode },
    null,
    2,
  )}\n`;
}

export function resolveAndroidVersion(rootDir = path.resolve(".")): ResolvedAndroidVersion {
  const versionFilePath = path.join(rootDir, ANDROID_VERSION_FILE);
  const iosChangelogPath = path.join(rootDir, IOS_CHANGELOG_FILE);
  const legacyChangelogPath = path.join(rootDir, ANDROID_CHANGELOG_FILE);
  const versionPropertiesPath = path.join(rootDir, ANDROID_VERSION_PROPERTIES_FILE);
  const releaseNotesPath = path.join(rootDir, ANDROID_RELEASE_NOTES_FILE);
  const manifest = readAndroidVersionManifest(rootDir);
  const canonicalVersion = normalizePinnedAndroidVersion(manifest.version ?? "");
  const versionCode = normalizeAndroidVersionCode(manifest.versionCode, canonicalVersion);

  return {
    canonicalVersion,
    iosChangelogPath,
    legacyChangelogPath,
    releaseNotesPath,
    versionCode,
    versionFilePath,
    versionPropertiesPath,
  };
}

export function renderAndroidVersionProperties(
  version: Pick<ResolvedAndroidVersion, "canonicalVersion" | "versionCode">,
): string {
  return `# Shared Android version defaults.\n# Source of truth: apps/android/version.json\n# Generated by scripts/mobile-release-version.ts.\n\nOPENCLAW_ANDROID_VERSION_NAME=${version.canonicalVersion}\nOPENCLAW_ANDROID_VERSION_CODE=${version.versionCode}\n`;
}

function renderLegacyAndroidVersionProperties(
  version: Pick<ResolvedAndroidVersion, "canonicalVersion" | "versionCode">,
): string {
  return `# Shared Android version defaults.\n# Source of truth: apps/android/version.json\n# Generated by scripts/android-sync-versioning.ts.\n\nOPENCLAW_ANDROID_VERSION_NAME=${version.canonicalVersion}\nOPENCLAW_ANDROID_VERSION_CODE=${version.versionCode}\n`;
}

function matchChangelogHeading(line: string, heading: string): boolean {
  const normalized = line.trim();
  return normalized === `## ${heading}` || normalized.startsWith(`## ${heading} - `);
}

export function extractChangelogSection(content: string, heading: string): string | null {
  const lines = content.split(/\r?\n/u);
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

export function renderAndroidReleaseNotes(
  version: Pick<ResolvedAndroidVersion, "canonicalVersion">,
  changelogContent: string,
  options?: { candidateHeadings?: string[]; sourcePath?: string },
): string {
  const candidateHeadings = options?.candidateHeadings ?? [version.canonicalVersion, "Unreleased"];

  for (const heading of candidateHeadings) {
    const body = extractChangelogSection(changelogContent, heading);
    if (body) {
      return `${body}\n`;
    }
  }

  throw new Error(
    `Unable to find Android changelog notes for ${version.canonicalVersion}. Add a matching section to ${options?.sourcePath ?? ANDROID_CHANGELOG_FILE}.`,
  );
}

function matchingIosReleaseHeadings(gatewayVersion: string, changelogContent: string): string[] {
  return changelogContent
    .split(/\r?\n/u)
    .flatMap((line) => {
      const match = /^##\s+(\S+)/u.exec(line);
      if (!match?.[1] || match[1] === "Unreleased") {
        return [];
      }
      const decoded = decodeIosAppStoreVersion(gatewayVersion, match[1]);
      return decoded ? [{ heading: match[1], revision: decoded.revision }] : [];
    })
    .toSorted((left, right) => right.revision - left.revision)
    .map(({ heading }) => heading);
}

function checkFile(params: { path: string; expectedContents: string[]; label: string }): void {
  const currentContent = readFileSync(params.path, "utf8");
  if (
    params.expectedContents.some(
      (expectedContent) => currentContent === normalizeTrailingNewline(expectedContent),
    )
  ) {
    return;
  }
  throw new Error(`${params.label} is stale: ${path.relative(process.cwd(), params.path)}`);
}

export function checkAndroidVersioning(params?: {
  appStoreRevision?: string | number;
  requireMobileRelease?: boolean;
  rootDir?: string;
}): {
  checkedPaths: string[];
} {
  const rootDir = path.resolve(params?.rootDir ?? ".");
  const version = resolveAndroidVersion(rootDir);
  const mobileVersion = readMobileVersionManifest(rootDir).version;
  const nextVersionProperties =
    version.canonicalVersion === mobileVersion
      ? renderAndroidVersionProperties(version)
      : renderLegacyAndroidVersionProperties(version);
  checkFile({
    path: version.versionPropertiesPath,
    expectedContents: [nextVersionProperties],
    label: "Android version properties",
  });

  let expectedReleaseNotes: string[];
  if (version.canonicalVersion === mobileVersion) {
    const iosChangelog = readFileSync(version.iosChangelogPath, "utf8");
    const candidateHeadings =
      params?.appStoreRevision === undefined
        ? [...matchingIosReleaseHeadings(version.canonicalVersion, iosChangelog), "Unreleased"]
        : [encodeIosAppStoreVersion(version.canonicalVersion, params.appStoreRevision)];
    expectedReleaseNotes = candidateHeadings.flatMap((heading) => {
      const notes = extractChangelogSection(iosChangelog, heading);
      return notes ? [`${notes}\n`] : [];
    });
    if (expectedReleaseNotes.length === 0) {
      throw new Error(
        `Unable to find mobile release notes for ${version.canonicalVersion} in ${IOS_CHANGELOG_FILE}.`,
      );
    }
  } else {
    // The checked-in Android pin predates the shared mobile cutter. Keep that
    // historical state verifiable, while release callers reject the mismatch.
    if (params?.requireMobileRelease) {
      throw new Error(
        `Android version ${version.canonicalVersion} does not match mobile gateway ${mobileVersion}. Run the shared mobile cutter before an Android release.`,
      );
    }
    expectedReleaseNotes = [
      renderAndroidReleaseNotes(version, readFileSync(version.legacyChangelogPath, "utf8"), {
        candidateHeadings: [version.canonicalVersion],
        sourcePath: ANDROID_CHANGELOG_FILE,
      }),
    ];
  }

  checkFile({
    path: version.releaseNotesPath,
    expectedContents: expectedReleaseNotes,
    label: "Android release notes",
  });

  return {
    checkedPaths: [version.versionPropertiesPath, version.releaseNotesPath],
  };
}
