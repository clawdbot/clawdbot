#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_CHANGELOG_THANKS_HANDLES = [
  "codex",
  "openclaw",
  "steipete",
  "clawsweeper",
  "openclaw-clawsweeper",
  "clawsweeper[bot]",
  "openclaw-clawsweeper[bot]",
];
export const FORBIDDEN_CHANGELOG_THANKS_HANDLE_PREFIXES = ["app/"];
export const FORBIDDEN_CHANGELOG_THANKS_HANDLE_SUFFIXES = ["[bot]"];
export const CHANGELOG_THANKS_REQUIRE_HUMAN_CREDIT_HANDLES = [
  "clawsweeper",
  "openclaw-clawsweeper",
  "clawsweeper[bot]",
  "openclaw-clawsweeper[bot]",
];
export const CHANGELOG_THANKS_REQUIRE_HUMAN_CREDIT_HANDLE_PREFIXES = ["app/"];
export const CHANGELOG_THANKS_REQUIRE_HUMAN_CREDIT_HANDLE_SUFFIXES = ["[bot]"];

const THANKS_PATTERN = /\bThanks\b/iu;
const THANKED_HANDLE_PATTERN = /@([-_/A-Za-z0-9]+(?:\[bot\])?)/giu;

export function isForbiddenChangelogThanksHandle(handle, options = {}) {
  const { strictBotHandle = false } = options;
  const normalized = handle.toLowerCase();
  if (normalized === "" || normalized === "null") {
    // Empty/null input is not a GitHub handle, but the shell query path may pass it through.
    return true;
  }
  if (
    FORBIDDEN_CHANGELOG_THANKS_HANDLES.includes(normalized) ||
    FORBIDDEN_CHANGELOG_THANKS_HANDLE_PREFIXES.some((prefix) => normalized.startsWith(prefix)) ||
    FORBIDDEN_CHANGELOG_THANKS_HANDLE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  ) {
    return true;
  }
  if (strictBotHandle) {
    // PR-author checks should not reject a real human whose login merely contains a bot keyword.
    return false;
  }
  return false;
}

export function requiresExplicitHumanChangelogThanks(handle) {
  const normalized = handle.toLowerCase();
  if (normalized === "" || normalized === "null") {
    return false;
  }
  return (
    CHANGELOG_THANKS_REQUIRE_HUMAN_CREDIT_HANDLES.includes(normalized) ||
    CHANGELOG_THANKS_REQUIRE_HUMAN_CREDIT_HANDLE_PREFIXES.some((prefix) =>
      normalized.startsWith(prefix),
    ) ||
    CHANGELOG_THANKS_REQUIRE_HUMAN_CREDIT_HANDLE_SUFFIXES.some((suffix) =>
      normalized.endsWith(suffix),
    )
  );
}

export function findForbiddenChangelogThanks(content) {
  return content
    .split(/\r?\n/u)
    .map((text, index) => {
      if (!THANKS_PATTERN.test(text)) {
        return null;
      }
      // A single changelog line may thank multiple handles; scan all of them.
      for (const match of text.matchAll(THANKED_HANDLE_PATTERN)) {
        if (isForbiddenChangelogThanksHandle(match[1])) {
          return { line: index + 1, handle: match[1].toLowerCase(), text };
        }
      }
      return null;
    })
    .filter(Boolean);
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] === "--is-forbidden-handle") {
    process.exitCode = isForbiddenChangelogThanksHandle(argv[1] ?? "", {
      strictBotHandle: true,
    })
      ? 0
      : 1;
    return;
  }

  if (argv[0] === "--requires-explicit-human-thanks") {
    process.exitCode = requiresExplicitHumanChangelogThanks(argv[1] ?? "") ? 0 : 1;
    return;
  }

  const changelogPath = argv[0] ?? "CHANGELOG.md";
  const absolutePath = path.resolve(process.cwd(), changelogPath);
  const content = fs.readFileSync(absolutePath, "utf8");
  const violations = findForbiddenChangelogThanks(content);
  if (violations.length === 0) {
    return;
  }

  console.error("Forbidden changelog thanks attribution:");
  for (const violation of violations) {
    const relativePath = path.relative(process.cwd(), absolutePath) || changelogPath;
    console.error(`- ${relativePath}:${violation.line} uses Thanks @${violation.handle}`);
  }
  console.error(
    `Use a credited external GitHub username instead of ${FORBIDDEN_CHANGELOG_THANKS_HANDLES.map(
      (handle) => `@${handle}`,
    ).join(", ")}.`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
