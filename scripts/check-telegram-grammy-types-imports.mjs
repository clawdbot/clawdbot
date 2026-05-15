#!/usr/bin/env node
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const telegramRoot = path.join(repoRoot, "extensions/telegram");
const importSpecifierPatterns = [
  /\bimport\s+(?:type\s+)?[\s\S]*?\bfrom\s*["']([^"']+)["']/gu,
  /\bexport\s+(?:type\s+)?[\s\S]*?\bfrom\s*["']([^"']+)["']/gu,
  /\bimport\s*["']([^"']+)["']/gu,
  /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  /\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu,
];

function isForbiddenTelegramTypeSpecifier(specifier) {
  return specifier === "@grammyjs/types" || specifier.startsWith("@grammyjs/types/");
}

function lineNumberForOffset(source, offset) {
  return source.slice(0, offset).split(/\r?\n/u).length;
}

function collectTypeScriptFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules") {
      continue;
    }
    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(entryPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

const violations = [];
for (const filePath of collectTypeScriptFiles(telegramRoot)) {
  const source = readFileSync(filePath, "utf8");
  for (const pattern of importSpecifierPatterns) {
    for (const match of source.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier && isForbiddenTelegramTypeSpecifier(specifier)) {
        violations.push(
          `${path.relative(repoRoot, filePath)}:${lineNumberForOffset(source, match.index ?? 0)}`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error(
    [
      "Telegram source must import Telegram Bot API types from grammy/types, not @grammyjs/types.",
      "This keeps grammY Context and message/update helper types on the same dependency copy.",
      "",
      ...violations,
    ].join("\n"),
  );
  process.exit(1);
}

console.log("No Telegram direct @grammyjs/types imports found.");
