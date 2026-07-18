#!/usr/bin/env node
// Validates release metadata-only changed scopes for CI routing.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { RELEASE_METADATA_PATHS } from "./changed-lanes.mjs";

const DEFAULT_GIT_TIMEOUT_MS = 60_000;
const MAX_GIT_TIMEOUT_MS = 10 * 60_000;
const GIT_TIMEOUT_ENV = "OPENCLAW_RELEASE_METADATA_GIT_TIMEOUT_MS";

const VERSION_ONLY_TEXT_PATHS = new Set([
  "apps/android/Config/Version.properties",
  "apps/android/version.json",
  "apps/macos/Sources/OpenClaw/Resources/Info.plist",
]);

function normalizePath(input) {
  return String(input ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

function readRefOptionValue(argv, index, optionName) {
  const value = argv[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new Error(`Expected ${optionName} <ref>.`);
  }
  return value;
}

function resolveGitTimeoutMs(env = process.env) {
  const raw = env[GIT_TIMEOUT_ENV]?.trim();
  if (!raw) {
    return DEFAULT_GIT_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_GIT_TIMEOUT_MS;
  }
  return Math.min(Math.trunc(parsed), MAX_GIT_TIMEOUT_MS);
}

export function parseArgs(argv) {
  const separatorIndex = argv.indexOf("--");
  const flagArgv = separatorIndex === -1 ? argv : argv.slice(0, separatorIndex);
  const explicitPaths =
    separatorIndex === -1 ? [] : argv.slice(separatorIndex + 1).map(normalizePath);
  const args = { staged: false, base: "origin/main", head: "HEAD", paths: [] };
  for (let index = 0; index < flagArgv.length; index += 1) {
    const arg = flagArgv[index];
    if (arg === "--staged") {
      args.staged = true;
    } else if (arg === "--base") {
      args.base = readRefOptionValue(flagArgv, index, arg);
      index += 1;
    } else if (arg === "--head") {
      args.head = readRefOptionValue(flagArgv, index, arg);
      index += 1;
    } else if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      args.paths.push(normalizePath(arg));
    }
  }
  args.paths.push(...explicitPaths);
  return args;
}

function formatGitArgs(args) {
  return args.join(" ");
}

function git(args) {
  const timeout = resolveGitTimeoutMs();
  try {
    return execFileSync("git", args, {
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout,
    });
  } catch (error) {
    if (error?.signal === "SIGTERM" || error?.code === "ETIMEDOUT") {
      throw new Error(
        `release metadata guard: git ${formatGitArgs(args)} timed out after ${timeout}ms.`,
        { cause: error },
      );
    }
    throw error;
  }
}

function listChangedPaths(args) {
  if (args.paths.length > 0) {
    return [...new Set(args.paths.filter(Boolean))].toSorted((left, right) =>
      left.localeCompare(right),
    );
  }
  const diffArgs = args.staged
    ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    : ["diff", "--name-only", "--diff-filter=ACMR", `${args.base}...${args.head}`];
  return git(diffArgs)
    .split("\n")
    .map(normalizePath)
    .filter(Boolean)
    .toSorted((left, right) => left.localeCompare(right));
}

function readBlob(ref, filePath) {
  if (ref === "WORKTREE") {
    return readFileSync(filePath, "utf8");
  }
  return git(["show", `${ref}:${filePath}`]);
}

function refsFor(args) {
  return args.staged ? { before: "HEAD", after: "" } : { before: args.base, after: args.head };
}

function readBeforeAfter(args, filePath) {
  const refs = refsFor(args);
  const before = readBlob(refs.before, filePath);
  let after = readBlob(refs.after, filePath);
  // The worktree overlay covers uncommitted edits; an explicit --head SHA is
  // a request for SHA-exact comparison and must not read the checkout.
  if (!args.staged && args.head === "HEAD" && existsSync(filePath)) {
    const worktree = readBlob("WORKTREE", filePath);
    if (worktree !== after) {
      after = worktree;
    }
  }
  return {
    before,
    after,
  };
}

function stripPackageVersion(raw) {
  const parsed = JSON.parse(raw);
  delete parsed.version;
  return stableJson(parsed);
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(",")}]`;
  }
  if (value && typeof value === "object") {
    return `{${Object.keys(value)
      .toSorted((left, right) => left.localeCompare(right))
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizeVersionText(raw) {
  return raw
    .replace(/\b20\d{2}\.\d{1,2}\.\d{1,2}(?:-beta\.\d+|-\d+)?\b/gu, "<OPENCLAW_VERSION>")
    .replace(/\b20\d{6}(?:\d{2})?\b/gu, "<OPENCLAW_BUILD>");
}

function fail(message) {
  console.error(`[release-metadata] ${message}`);
  process.exitCode = 1;
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const paths = listChangedPaths(args);

  for (const filePath of paths) {
    if (!RELEASE_METADATA_PATHS.has(filePath)) {
      fail(`${filePath}: not a release metadata path; run the normal changed gate`);
    }
  }

  if (paths.includes("package.json")) {
    const { before, after } = readBeforeAfter(args, "package.json");
    if (stripPackageVersion(before) !== stripPackageVersion(after)) {
      fail("package.json changed outside the top-level version field");
    }
  }

  for (const filePath of paths) {
    if (!VERSION_ONLY_TEXT_PATHS.has(filePath)) {
      continue;
    }
    const { before, after } = readBeforeAfter(args, filePath);
    if (normalizeVersionText(before) !== normalizeVersionText(after)) {
      fail(`${filePath}: changed outside recognized version/build literals`);
    }
  }

  if (process.exitCode) {
    process.exit(process.exitCode);
  }
  console.error(`[release-metadata] ok (${paths.length} files)`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
