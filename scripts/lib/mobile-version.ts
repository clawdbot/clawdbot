import { readFileSync } from "node:fs";
import path from "node:path";
import { parseReleaseVersion } from "./release-version.mjs";

const MOBILE_VERSION_FILE = "apps/mobile/version.json";

export type MobileVersionManifest = {
  version: string;
};

export function normalizeMobileVersion(rawVersion: string): string {
  const trimmed = rawVersion.trim();
  const parsed = parseReleaseVersion(trimmed);
  if (!parsed || parsed.version !== parsed.baseVersion) {
    throw new Error(
      `Invalid mobile gateway version '${rawVersion}'. Expected a stable release version like 2026.8.1.`,
    );
  }
  return parsed.baseVersion;
}

export function mobileVersionPath(rootDir = path.resolve(".")): string {
  return path.join(rootDir, MOBILE_VERSION_FILE);
}

export function renderMobileVersionManifest(version: string): string {
  return `${JSON.stringify({ version: normalizeMobileVersion(version) }, null, 2)}\n`;
}

export function readMobileVersionManifest(rootDir = path.resolve(".")): MobileVersionManifest {
  const filePath = mobileVersionPath(rootDir);
  const parsed: unknown = JSON.parse(readFileSync(filePath, "utf8"));
  const version =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as { version?: unknown }).version
      : undefined;
  if (typeof version !== "string") {
    throw new Error(`Missing mobile gateway version in ${filePath}.`);
  }
  return { version: normalizeMobileVersion(version) };
}
