import fs from "node:fs";
import path from "node:path";
import { afterEach } from "vitest";
import { cleanupTempDirs, makeTempDir } from "../helpers/temp-dir.js";

const tempDirs: string[] = [];

export function installIosFixtureCleanup(): void {
  afterEach(() => {
    cleanupTempDirs(tempDirs);
  });
}

export function writeIosFixture(params: {
  version: string;
  changelog: string;
  packageVersion?: string;
  releaseNotes?: string;
  versionXcconfig?: string;
  prefix?: string;
}): string {
  const rootDir = makeTempDir(tempDirs, params.prefix ?? "openclaw-ios-version-");
  fs.mkdirSync(path.join(rootDir, "apps", "ios", "Config"), { recursive: true });
  fs.mkdirSync(path.join(rootDir, "apps", "ios", "fastlane", "metadata", "en-US"), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(rootDir, "package.json"),
    `${JSON.stringify({ version: params.packageVersion ?? "2026.4.6" }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "apps", "ios", "version.json"),
    `${JSON.stringify({ version: params.version }, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(path.join(rootDir, "apps", "ios", "CHANGELOG.md"), params.changelog, "utf8");
  fs.writeFileSync(
    path.join(rootDir, "apps", "ios", "Config", "Version.xcconfig"),
    params.versionXcconfig ?? "",
    "utf8",
  );
  fs.writeFileSync(
    path.join(rootDir, "apps", "ios", "fastlane", "metadata", "en-US", "release_notes.txt"),
    params.releaseNotes ?? "",
    "utf8",
  );
  return rootDir;
}
