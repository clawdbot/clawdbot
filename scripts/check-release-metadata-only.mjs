#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { RELEASE_METADATA_PATHS } from "./changed-lanes.mjs";

const VERSION_ONLY_TEXT_PATHS = new Set([
  "apps/android/app/build.gradle.kts",
  "apps/ios/Config/Version.xcconfig",
  "apps/ios/version.json",
  "apps/macos/Sources/OpenClaw/Resources/Info.plist",
  "src/config/schema.base.generated.ts",
]);

function normalizePath(input) {
  return String(input ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/u, "");
}

function parseArgs(argv) {
  const args = { staged: false, base: "origin/main", head: "HEAD", paths: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--staged") {
      args.staged = true;
    } else if (arg === "--base") {
      args.base = argv[++index] ?? "";
    } else if (arg === "--head") {
      args.head = argv[++index] ?? "";
    } else {
      args.paths.push(normalizePath(arg));
    }
  }
  return args;
}

function git(args) {
  return execFileSync("git", args, {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });
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
  if (!args.staged && existsSync(filePath)) {
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

function main() {
  const args = parseArgs(process.argv.slice(2));
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

main();
