#!/usr/bin/env node
// Flags committed private-key material from tracked files only. Dependency-free
// by design: the CI security-fast job runs it before any install and after
// checkout credentials are dropped, so it needs no network and executes no
// third-party hook code. Marker set mirrors pre-commit-hooks v6.0.0
// detect_private_key.py (byte substrings, not regexes) so local prek runs and
// CI agree on what counts as a key. Self-contained by contract: pull-request
// CI extracts the base-ref copy with `git show` and runs it from outside the
// candidate tree, so a relative import here would break that trusted path.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TOOL_NAME = "detect-private-keys";

// Assembled at load time so this file never contains a literal marker: any
// byte-substring scanner (this one, or the upstream hook that scans PRs) would
// otherwise flag its own table, and a path carve-out for the scanner would
// then be needed in every scanner config.
const KEY = "PRIVATE KEY";
export const PRIVATE_KEY_MARKERS: readonly string[] = [
  `BEGIN RSA ${KEY}`,
  `BEGIN DSA ${KEY}`,
  `BEGIN EC ${KEY}`,
  `BEGIN OPENSSH ${KEY}`,
  `BEGIN ${KEY}`,
  ["PuTTY-User-Key-File-", "2"].join(""),
  `BEGIN SSH2 ENCRYPTED ${KEY}`,
  `BEGIN PGP ${KEY} BLOCK`,
  `BEGIN ENCRYPTED ${KEY}`,
  ["BEGIN OpenVPN Static key V", "1"].join(""),
];

// Colocated test fixtures and the iOS Fastfile's marker-bearing string. The
// list lives here, not in a config the scanner reads, so CI can run a
// base-ref copy of this file and get the base-ref policy with it.
export const PRIVATE_KEY_SCAN_EXCLUDE = /(^|\/)(apps\/ios\/fastlane\/Fastfile$|.*\.test\.ts$)/;

const REGULAR_FILE_MODES = new Set(["100644", "100755"]);

export function findPrivateKeyMarker(content: Buffer): string | undefined {
  return PRIVATE_KEY_MARKERS.find((marker) => content.includes(marker));
}

// Regular tracked files only: symlinks would double-scan or dangle, gitlinks
// are directories. Matches pre-commit's `types: [text]` scope closely enough
// that the current tree passes without a binary sniffer.
export function listTrackedRegularFiles(cwd: string): string[] {
  const result = spawnSync("git", ["ls-files", "-z", "--stage"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`git ls-files exited ${result.status}: ${result.stderr.trim()}`);
  }
  const files: string[] = [];
  for (const entry of result.stdout.split("\0")) {
    if (!entry) {
      continue;
    }
    const tabIndex = entry.indexOf("\t");
    const mode = entry.slice(0, entry.indexOf(" "));
    if (REGULAR_FILE_MODES.has(mode)) {
      files.push(entry.slice(tabIndex + 1));
    }
  }
  return files;
}

export type PrivateKeyFinding = { file: string; marker: string };

export function scanFilesForPrivateKeys(
  files: readonly string[],
  cwd: string,
): PrivateKeyFinding[] {
  const findings: PrivateKeyFinding[] = [];
  for (const file of files) {
    if (PRIVATE_KEY_SCAN_EXCLUDE.test(file)) {
      continue;
    }
    const marker = findPrivateKeyMarker(fs.readFileSync(path.resolve(cwd, file)));
    if (marker) {
      findings.push({ file, marker });
    }
  }
  return findings;
}

function main(argv: readonly string[]): number {
  const cwd = process.cwd();
  // Explicit paths come from pre-commit's staged-file batches; no args scans
  // every tracked regular file (CI and `--all-files`).
  const files = argv.length > 0 ? argv : listTrackedRegularFiles(cwd);
  const findings = scanFilesForPrivateKeys(files, cwd);
  if (findings.length === 0) {
    console.log(`[${TOOL_NAME}] scanned ${files.length} files; no private keys found.`);
    return 0;
  }
  for (const finding of findings) {
    console.error(`Private key found: ${finding.file} (${finding.marker})`);
  }
  console.error("Remove or rotate the key material; test fixtures belong in *.test.ts files.");
  return 1;
}

function isDirectRun(): boolean {
  if (!process.argv[1]) {
    return false;
  }
  const normalize = (value: string) =>
    process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
  return normalize(process.argv[1]) === normalize(fileURLToPath(import.meta.url));
}

if (isDirectRun()) {
  let exitCode: number;
  try {
    exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error);
    exitCode = 1;
  }
  if (exitCode !== 0) {
    console.error(`[${TOOL_NAME}] FAILED (exit ${exitCode})`);
  }
  process.exitCode = exitCode;
}
