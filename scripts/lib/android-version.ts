// Android Version script supports OpenClaw repository automation.
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseReleaseVersion } from "./release-version.mjs";

const ANDROID_VERSION_FILE = "apps/android/version.json";
const ANDROID_CHANGELOG_FILE = "apps/android/CHANGELOG.md";
const ANDROID_VERSION_PROPERTIES_FILE = "apps/android/Config/Version.properties";
const ANDROID_RELEASE_NOTES_FILE = "apps/android/fastlane/metadata/android/en-US/release_notes.txt";
const ANDROID_VERSION_CODE_MAX = 2_100_000_000;

type AndroidVersionManifest = {
  version: string;
  versionCode: number;
};

type ResolvedAndroidVersion = {
  canonicalVersion: string;
  changelogPath: string;
  releaseNotesPath: string;
  versionCode: number;
  versionFilePath: string;
  versionPropertiesPath: string;
};

type SyncAndroidVersioningMode = "check" | "write";

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

export function normalizeGatewayVersionToPinnedAndroidVersion(rawVersion: string): string {
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

function readRootPackageVersion(rootDir = path.resolve(".")): string {
  const packageJsonPath = path.join(rootDir, "package.json");
  const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { version?: unknown };
  const version = typeof parsed.version === "string" ? parsed.version.trim() : "";
  if (!version) {
    throw new Error(`Missing package.json version in ${packageJsonPath}.`);
  }
  return version;
}

export function resolveGatewayVersionForAndroidRelease(rootDir = path.resolve(".")): {
  packageVersion: string;
  pinnedAndroidVersion: string;
  versionCode: number;
} {
  const packageVersion = readRootPackageVersion(rootDir);
  const pinnedAndroidVersion = normalizeGatewayVersionToPinnedAndroidVersion(packageVersion);
  return {
    packageVersion,
    pinnedAndroidVersion,
    versionCode: canonicalAndroidVersionCode(pinnedAndroidVersion),
  };
}

function readAndroidVersionManifest(rootDir = path.resolve(".")): AndroidVersionManifest {
  const versionFilePath = path.join(rootDir, ANDROID_VERSION_FILE);
  return JSON.parse(readFileSync(versionFilePath, "utf8")) as AndroidVersionManifest;
}

export function writeAndroidVersionManifest(
  version: string,
  versionCode: number | null,
  rootDir = path.resolve("."),
): string {
  const versionFilePath = path.join(rootDir, ANDROID_VERSION_FILE);
  const normalizedVersion = normalizePinnedAndroidVersion(version);
  const normalizedVersionCode = normalizeAndroidVersionCode(
    versionCode ?? canonicalAndroidVersionCode(normalizedVersion),
    normalizedVersion,
  );
  const nextContent = `${JSON.stringify(
    { version: normalizedVersion, versionCode: normalizedVersionCode },
    null,
    2,
  )}\n`;
  writeFileSync(versionFilePath, nextContent, "utf8");
  return versionFilePath;
}

export function resolveAndroidVersion(rootDir = path.resolve(".")): ResolvedAndroidVersion {
  const versionFilePath = path.join(rootDir, ANDROID_VERSION_FILE);
  const changelogPath = path.join(rootDir, ANDROID_CHANGELOG_FILE);
  const versionPropertiesPath = path.join(rootDir, ANDROID_VERSION_PROPERTIES_FILE);
  const releaseNotesPath = path.join(rootDir, ANDROID_RELEASE_NOTES_FILE);
  const manifest = readAndroidVersionManifest(rootDir);
  const canonicalVersion = normalizePinnedAndroidVersion(manifest.version ?? "");
  const versionCode = normalizeAndroidVersionCode(manifest.versionCode, canonicalVersion);

  return {
    canonicalVersion,
    changelogPath,
    releaseNotesPath,
    versionCode,
    versionFilePath,
    versionPropertiesPath,
  };
}

export function renderAndroidVersionProperties(
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
): string {
  const candidateHeadings = [version.canonicalVersion, "Unreleased"];

  for (const heading of candidateHeadings) {
    const body = extractChangelogSection(changelogContent, heading);
    if (body) {
      return `${body}\n`;
    }
  }

  throw new Error(
    `Unable to find Android changelog notes for ${version.canonicalVersion}. Add a matching section to ${ANDROID_CHANGELOG_FILE}.`,
  );
}

function syncFile(params: {
  mode: SyncAndroidVersioningMode;
  path: string;
  nextContent: string;
  label: string;
}): boolean {
  const nextContent = normalizeTrailingNewline(params.nextContent);
  const currentContent = readFileSync(params.path, "utf8");
  if (currentContent === nextContent) {
    return false;
  }

  if (params.mode === "check") {
    throw new Error(`${params.label} is stale: ${path.relative(process.cwd(), params.path)}`);
  }

  writeFileSync(params.path, nextContent, "utf8");
  return true;
}

export function syncAndroidVersioning(params?: {
  mode?: SyncAndroidVersioningMode;
  rootDir?: string;
}): {
  updatedPaths: string[];
} {
  const mode = params?.mode ?? "write";
  const rootDir = path.resolve(params?.rootDir ?? ".");
  const version = resolveAndroidVersion(rootDir);
  const changelogContent = readFileSync(version.changelogPath, "utf8");
  const nextVersionProperties = renderAndroidVersionProperties(version);
  const nextReleaseNotes = renderAndroidReleaseNotes(version, changelogContent);
  const updatedPaths: string[] = [];

  if (
    syncFile({
      mode,
      path: version.versionPropertiesPath,
      nextContent: nextVersionProperties,
      label: "Android version properties",
    })
  ) {
    updatedPaths.push(version.versionPropertiesPath);
  }

  if (
    syncFile({
      mode,
      path: version.releaseNotesPath,
      nextContent: nextReleaseNotes,
      label: "Android release notes",
    })
  ) {
    updatedPaths.push(version.releaseNotesPath);
  }

  return { updatedPaths };
}
