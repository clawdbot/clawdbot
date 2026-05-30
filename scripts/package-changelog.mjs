#!/usr/bin/env node

import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const CHANGELOG_PATH = "CHANGELOG.md";
const PACKAGE_JSON_PATH = "package.json";
const BACKUP_PATH = path.join(".artifacts", "package-changelog", "CHANGELOG.md.prepack-backup");
const MAX_PACKAGED_CHANGELOG_BYTES = 500 * 1024;
const MIN_RELEASE_SECTION_BODY_BYTES = 32;
const UNRELEASED_HEADING = "Unreleased";
const RELEASE_HEADING_PATTERN =
  /^##\s+([0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*(?:(?:-(?:alpha|beta)\.[1-9][0-9]*)|(?:-[1-9][0-9]*))?)(?:\s+.*)?$/u;
const RELEASE_VERSION_PATTERN =
  /^([0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*)(?:(?:-(?:alpha|beta)\.[1-9][0-9]*)|(?:-[1-9][0-9]*))?$/u;
const PRERELEASE_VERSION_PATTERN =
  /^([0-9]{4}\.[1-9][0-9]*\.[1-9][0-9]*)-(?:alpha|beta)\.[1-9][0-9]*$/u;

export function resolvePackageChangelogVersions(packageVersion) {
  const match = RELEASE_VERSION_PATTERN.exec(packageVersion);
  if (!match) {
    throw new Error(
      `Unsupported OpenClaw package version for changelog packaging: ${packageVersion}`,
    );
  }
  if (PRERELEASE_VERSION_PATTERN.test(packageVersion)) {
    return [packageVersion, match[1], UNRELEASED_HEADING];
  }
  return [packageVersion];
}

function splitLines(content) {
  return content.replace(/^\uFEFF/u, "").split(/\r?\n/u);
}

function parseLevelTwoHeading(line) {
  const releaseMatch = RELEASE_HEADING_PATTERN.exec(line);
  if (releaseMatch) {
    return releaseMatch[1];
  }
  return /^##\s+Unreleased(?:\s+.*)?$/u.test(line) ? UNRELEASED_HEADING : null;
}

function findLevelTwoHeadings(lines) {
  return lines.flatMap((line, index) => {
    const version = parseLevelTwoHeading(line);
    return version ? [{ index, version }] : [];
  });
}

function extractPreamble(lines, firstHeadingIndex) {
  return lines.slice(0, firstHeadingIndex).join("\n").trimEnd();
}

export function extractCurrentPackageChangelog(content, packageVersion) {
  const targetVersions = resolvePackageChangelogVersions(packageVersion);
  const lines = splitLines(content);
  const headings = findLevelTwoHeadings(lines);
  const heading = targetVersions
    .map((version) => headings.find((entry) => entry.version === version))
    .find((entry) => entry !== undefined);
  if (!heading) {
    throw new Error(
      `CHANGELOG.md does not contain a release section for ${targetVersions.join(" or ")}.`,
    );
  }
  const nextHeading = headings.find((entry) => entry.index > heading.index);
  const firstLevelTwoHeadingIndex = lines.findIndex((line) => line.startsWith("## "));
  const preamble = extractPreamble(lines, firstLevelTwoHeadingIndex);
  const releaseSection = lines
    .slice(heading.index, nextHeading?.index ?? lines.length)
    .join("\n")
    .trimEnd();
  const releaseBody = releaseSection.split(/\r?\n/u).slice(1).join("\n").trim();
  const releaseBodyBytes = Buffer.byteLength(releaseBody, "utf8");
  if (releaseBodyBytes < MIN_RELEASE_SECTION_BODY_BYTES) {
    throw new Error(
      `Packaged changelog section for ${heading.version} is only ${releaseBodyBytes} body bytes, which is below the ${MIN_RELEASE_SECTION_BODY_BYTES} byte safety minimum.`,
    );
  }
  const packaged = `${preamble}\n\n${releaseSection}\n`;
  const packagedBytes = Buffer.byteLength(packaged, "utf8");
  if (packagedBytes > MAX_PACKAGED_CHANGELOG_BYTES) {
    throw new Error(
      `Packaged changelog is ${packagedBytes} bytes, which exceeds the ${MAX_PACKAGED_CHANGELOG_BYTES} byte safety limit.`,
    );
  }
  return packaged;
}

async function readPackageVersion(cwd) {
  const packageJsonPath = path.join(cwd, PACKAGE_JSON_PATH);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
  if (typeof packageJson.version !== "string") {
    throw new Error("package.json version must be a string.");
  }
  return packageJson.version;
}

export async function restorePackageChangelog(cwd = process.cwd()) {
  const backupPath = path.join(cwd, BACKUP_PATH);
  if (!existsSync(backupPath)) {
    return false;
  }
  const changelogPath = path.join(cwd, CHANGELOG_PATH);
  const [backup, current] = await Promise.all([
    readFile(backupPath, "utf8"),
    readFile(changelogPath, "utf8"),
  ]);
  if (current !== backup) {
    const packageVersion = await readPackageVersion(cwd);
    let expectedPackaged;
    try {
      expectedPackaged = extractCurrentPackageChangelog(backup, packageVersion);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `Refusing to restore stale packaged changelog backup from ${BACKUP_PATH}: ${message}`,
        { cause: error },
      );
    }
    if (current !== expectedPackaged) {
      throw new Error(
        `Refusing to restore packaged changelog backup from ${BACKUP_PATH} because CHANGELOG.md has changed since the backup was written.`,
      );
    }
  }
  await writeFile(changelogPath, backup, "utf8");
  await rm(backupPath, { force: true });
  return true;
}

export async function preparePackageChangelog(cwd = process.cwd()) {
  await restorePackageChangelog(cwd);
  const changelogPath = path.join(cwd, CHANGELOG_PATH);
  const backupPath = path.join(cwd, BACKUP_PATH);
  const original = await readFile(changelogPath, "utf8");
  const packageVersion = await readPackageVersion(cwd);
  const packaged = extractCurrentPackageChangelog(original, packageVersion);
  if (packaged === original) {
    return false;
  }
  await mkdir(path.dirname(backupPath), { recursive: true });
  await writeFile(backupPath, original, "utf8");
  await writeFile(changelogPath, packaged, "utf8");
  return true;
}

async function main(argv = process.argv.slice(2)) {
  const command = argv[0];
  if (command === "prepare") {
    const changed = await preparePackageChangelog();
    console.error(
      changed
        ? "package-changelog: wrote current release notes for package tarball."
        : "package-changelog: source changelog already matches package notes.",
    );
    return;
  }
  if (command === "restore") {
    const restored = await restorePackageChangelog();
    console.error(
      restored
        ? "package-changelog: restored source CHANGELOG.md."
        : "package-changelog: no packaged changelog backup to restore.",
    );
    return;
  }
  console.error("Usage: node scripts/package-changelog.mjs <prepare|restore>");
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
