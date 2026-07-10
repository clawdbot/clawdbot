#!/usr/bin/env node

import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const MAX_GITHUB_RELEASE_NOTES_CHARACTERS = 125_000;
export const GITHUB_RELEASE_VERIFICATION_RESERVE_CHARACTERS = 5_000;
export const MAX_GITHUB_RELEASE_SOURCE_NOTES_CHARACTERS =
  MAX_GITHUB_RELEASE_NOTES_CHARACTERS - GITHUB_RELEASE_VERIFICATION_RESERVE_CHARACTERS;
export const MAX_GITHUB_RELEASE_NOTES_UTF8_BYTES = 125_000;
export const GITHUB_RELEASE_VERIFICATION_RESERVE_UTF8_BYTES = 5_000;
export const MAX_GITHUB_RELEASE_SOURCE_NOTES_UTF8_BYTES =
  MAX_GITHUB_RELEASE_NOTES_UTF8_BYTES - GITHUB_RELEASE_VERIFICATION_RESERVE_UTF8_BYTES;

function fail(message) {
  throw new Error(message);
}

function releaseNotesHeadings(releaseTag) {
  const version = releaseTag.replace(/^v/, "");
  const betaBase = version.match(/^(\d{4}\.[1-9]\d*\.[1-9]\d*)-beta\.[1-9]\d*$/)?.[1];
  if (betaBase) {
    return [betaBase];
  }
  const correctionBase = version.match(/^(\d{4}\.[1-9]\d*\.[1-9]\d*)-[1-9]\d*$/)?.[1];
  if (correctionBase) {
    return [version, correctionBase];
  }
  if (/^\d{4}\.[1-9]\d*\.[1-9]\d*-alpha\.[1-9]\d*$/.test(version)) {
    return [version, "Unreleased"];
  }
  return [version];
}

function releaseSection(changelog, version) {
  const lines = changelog.split(/\r?\n/);
  const start = lines.indexOf(`## ${version}`);
  if (start < 0) {
    return undefined;
  }
  const next = lines.findIndex((line, index) => index > start && line.startsWith("## "));
  const end = next < 0 ? lines.length : next;
  return lines.slice(start, end).join("\n").trimEnd();
}

export function prepareGitHubReleaseNotes(changelog, releaseTag) {
  const headings = releaseNotesHeadings(releaseTag);
  const heading = headings.find((candidate) => releaseSection(changelog, candidate));
  const notes = heading ? releaseSection(changelog, heading) : undefined;
  if (!notes) {
    fail(`CHANGELOG.md does not contain release notes for ${headings.join(" or ")}.`);
  }
  const bodyStart = notes.indexOf("\n");
  if (bodyStart < 0 || !notes.slice(bodyStart + 1).trim()) {
    fail(`CHANGELOG.md release section for ${heading} does not contain release-note content.`);
  }
  const body = `${notes}\n`;
  if (body.length > MAX_GITHUB_RELEASE_SOURCE_NOTES_CHARACTERS) {
    fail(
      `GitHub release notes are ${body.length} characters; the complete source section exceeds the ${MAX_GITHUB_RELEASE_SOURCE_NOTES_CHARACTERS}-character source budget required to reserve ${GITHUB_RELEASE_VERIFICATION_RESERVE_CHARACTERS} characters for release verification.`,
    );
  }
  const bodyBytes = Buffer.byteLength(body, "utf8");
  if (bodyBytes > MAX_GITHUB_RELEASE_SOURCE_NOTES_UTF8_BYTES) {
    fail(
      `GitHub release notes are ${bodyBytes} UTF-8 bytes; the complete source section exceeds the ${MAX_GITHUB_RELEASE_SOURCE_NOTES_UTF8_BYTES}-byte source safety budget required to reserve ${GITHUB_RELEASE_VERIFICATION_RESERVE_UTF8_BYTES} bytes for release verification.`,
    );
  }
  return body;
}

export function appendGitHubReleaseVerification(notes, verificationSection) {
  const proof = verificationSection.trim();
  if (!proof.startsWith("### Release verification\n")) {
    fail("Release verification proof must start with the canonical heading.");
  }
  const proofSuffix = `\n\n${proof}\n`;
  if (proofSuffix.length > GITHUB_RELEASE_VERIFICATION_RESERVE_CHARACTERS) {
    fail(
      `Release verification proof is ${proofSuffix.length} characters; it exceeds the reserved ${GITHUB_RELEASE_VERIFICATION_RESERVE_CHARACTERS}-character budget.`,
    );
  }
  const proofBytes = Buffer.byteLength(proofSuffix, "utf8");
  if (proofBytes > GITHUB_RELEASE_VERIFICATION_RESERVE_UTF8_BYTES) {
    fail(
      `Release verification proof is ${proofBytes} UTF-8 bytes; it exceeds the reserved ${GITHUB_RELEASE_VERIFICATION_RESERVE_UTF8_BYTES}-byte safety budget.`,
    );
  }
  const withoutOldProof = notes
    .trimEnd()
    .replace(/\n?### Release verification\n[\s\S]*?(?=\n### |\n## |$)/, "")
    .trimEnd();
  const withProof = `${withoutOldProof}${proofSuffix}`;
  if (withProof.length > MAX_GITHUB_RELEASE_NOTES_CHARACTERS) {
    fail(
      `GitHub release notes with verification are ${withProof.length} characters; they exceed GitHub's ${MAX_GITHUB_RELEASE_NOTES_CHARACTERS}-character release-body limit.`,
    );
  }
  const withProofBytes = Buffer.byteLength(withProof, "utf8");
  if (withProofBytes > MAX_GITHUB_RELEASE_NOTES_UTF8_BYTES) {
    fail(
      `GitHub release notes with verification are ${withProofBytes} UTF-8 bytes; they exceed the ${MAX_GITHUB_RELEASE_NOTES_UTF8_BYTES}-byte release-body safety limit.`,
    );
  }
  return withProof;
}

function parseArgs(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!["--changelog", "--output", "--release-tag"].includes(name) || !value) {
      fail(
        "Usage: prepare-github-release-notes.mjs --changelog <path> --release-tag <tag> --output <path>",
      );
    }
    options[name.slice(2)] = value;
  }
  for (const name of ["changelog", "output", "release-tag"]) {
    if (!options[name]) {
      fail(`--${name} is required`);
    }
  }
  return options;
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const notes = prepareGitHubReleaseNotes(
    readFileSync(options.changelog, "utf8"),
    options["release-tag"],
  );
  writeFileSync(options.output, notes);
  process.stdout.write(
    `Prepared ${Buffer.byteLength(notes, "utf8")} bytes of GitHub release notes.\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
