// Inspects installed package metadata for update/install verification.
import { readRootJsonObjectSync } from "@openclaw/fs-safe/json";
import { compareOpenClawReleaseVersions } from "./npm-registry-spec.js";
import { compareValidSemver } from "./semver.js";

/** Compare two package versions, preferring OpenClaw release ordering over plain semver. */
export function comparePackageUpdateVersions(left: string, right: string): number {
  const releaseCmp = compareOpenClawReleaseVersions(left, right);
  if (releaseCmp !== null) {
    return releaseCmp;
  }
  return compareValidSemver(left, right) ?? 0;
}

/** Return whether an update replaced the installed version with an older one. */
export function isPackageVersionDowngrade(
  currentVersion: string | undefined,
  nextVersion: string | undefined,
): boolean {
  if (!currentVersion || !nextVersion) {
    return false;
  }
  return comparePackageUpdateVersions(nextVersion, currentVersion) < 0;
}

// Package update utilities inspect installed package metadata without trusting
// paths outside the provided package root.
/** Return expected integrity only for concrete semver package specs. */
export function expectedIntegrityForUpdate(
  spec: string | undefined,
  integrity: string | undefined,
): string | undefined {
  if (!integrity || !spec) {
    return undefined;
  }
  const value = spec.trim();
  if (!value) {
    return undefined;
  }
  const at = value.lastIndexOf("@");
  if (at <= 0 || at >= value.length - 1) {
    return undefined;
  }
  const version = value.slice(at + 1).trim();
  if (!/^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    return undefined;
  }
  return integrity;
}

export function readInstalledPackageManifest(dir: string): Record<string, unknown> | undefined {
  const result = readRootJsonObjectSync({
    rootDir: dir,
    relativePath: "package.json",
    boundaryLabel: "installed package directory",
  });
  return result.ok ? result.value : undefined;
}

/** Read the installed package version from a package root. */
export async function readInstalledPackageVersion(dir: string): Promise<string | undefined> {
  const manifest = readInstalledPackageManifest(dir);
  return typeof manifest?.version === "string" ? manifest.version : undefined;
}
