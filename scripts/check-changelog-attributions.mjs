#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const FORBIDDEN_CHANGELOG_THANKS_HANDLES = ["codex", "openclaw", "steipete"];

const HANDLE_PATTERN = FORBIDDEN_CHANGELOG_THANKS_HANDLES.join("|");
const FORBIDDEN_THANKS_PATTERN = new RegExp(
  `\\bThanks\\b[^\\n]*@(${HANDLE_PATTERN})(?=\\b|[^A-Za-z0-9-])`,
  "iu",
);

export function findForbiddenChangelogThanks(content) {
  return content
    .split(/\r?\n/u)
    .map((text, index) => {
      const match = text.match(FORBIDDEN_THANKS_PATTERN);
      return match ? { line: index + 1, handle: match[1].toLowerCase(), text } : null;
    })
    .filter(Boolean);
}

export async function main(argv = process.argv.slice(2)) {
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
    `Use a credited external GitHub username instead of ${FORBIDDEN_CHANGELOG_THANKS_HANDLES.map((handle) => `@${handle}`).join(", ")}.`,
  );
  process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
