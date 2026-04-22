#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(new URL("..", import.meta.url).pathname);

const CHANNEL_EXTENSION_IDS = new Set([
  "discord",
  "imessage",
  "irc",
  "line",
  "matrix",
  "mattermost",
  "nextcloud-talk",
  "signal",
  "slack",
  "telegram",
  "whatsapp",
]);

const HELPER_BASENAME_PATTERNS = [
  /^action-runtime\.ts$/,
  /^actions(?:\..*)?\.ts$/,
  /^active-listener\.ts$/,
  /^access-control\.ts$/,
  /^channel\.ts$/,
  /^client(?:[-.].*)?\.ts$/,
  /^recipient-resolution\.ts$/,
  /^rich-menu\.ts$/,
  /^send(?:[-.].*)?\.ts$/,
  /^sent-message-cache\.ts$/,
  /^thread-bindings\.ts$/,
];

const FORBIDDEN_PATTERNS = [/\bloadConfig\s*\(/, /\.config\.loadConfig\s*\(/];

function* walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === "dist") {
      continue;
    }
    const absolute = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(absolute);
      continue;
    }
    yield absolute;
  }
}

function isCandidate(relativePath) {
  const parts = relativePath.split(path.sep);
  if (parts[0] !== "extensions" || parts[2] !== "src") {
    return false;
  }
  if (!CHANNEL_EXTENSION_IDS.has(parts[1])) {
    return false;
  }
  if (
    relativePath.endsWith(".test.ts") ||
    relativePath.endsWith(".test-harness.ts") ||
    relativePath.endsWith(".d.ts")
  ) {
    return false;
  }
  if (parts.includes("monitor") || parts.includes("cli")) {
    return false;
  }
  if (parts.includes("actions")) {
    return true;
  }
  const basename = path.basename(relativePath);
  return HELPER_BASENAME_PATTERNS.some((pattern) => pattern.test(basename));
}

function main() {
  const violations = [];
  for (const absolute of walk(path.join(repoRoot, "extensions"))) {
    const relativePath = path.relative(repoRoot, absolute);
    if (!isCandidate(relativePath)) {
      continue;
    }
    const lines = fs.readFileSync(absolute, "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      if (FORBIDDEN_PATTERNS.some((pattern) => pattern.test(line))) {
        violations.push(`${relativePath}:${index + 1}: ${line.trim()}`);
      }
    });
  }
  if (violations.length === 0) {
    return;
  }
  console.error(
    [
      "Runtime channel send/action/client/pairing helpers must not call loadConfig().",
      "Load and resolve config at the command/gateway/monitor boundary, then pass cfg through.",
      "",
      ...violations,
    ].join("\n"),
  );
  process.exitCode = 1;
}

main();
