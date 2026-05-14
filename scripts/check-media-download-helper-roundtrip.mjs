#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const WINDOW_LINES = 80;
const READ_HELPER_RE = /\b(?:readRemoteMediaBuffer|fetchRemoteMedia)\s*\(/;
const SAVE_BUFFER_RE = /(?:\.|\b)saveMediaBuffer\s*\(/;

function listTrackedExtensionSources() {
  return execFileSync("git", ["ls-files", "extensions/**/*.ts"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
    .split("\n")
    .filter(Boolean)
    .filter((file) => file.includes("/src/"))
    .filter((file) => !isTestOrFixture(file));
}

function isTestOrFixture(file) {
  return (
    file.endsWith(".test.ts") ||
    file.endsWith(".e2e.test.ts") ||
    file.endsWith(".test-harness.ts") ||
    file.endsWith(".test-utils.ts") ||
    file.endsWith("/test-runtime.ts") ||
    file.endsWith("/test-helpers.ts") ||
    file.includes("/test-support/") ||
    file.includes("/fixtures/")
  );
}

const findings = [];

for (const file of listTrackedExtensionSources()) {
  const lines = readFileSync(file, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    if (!READ_HELPER_RE.test(lines[index])) {
      continue;
    }
    const end = Math.min(lines.length, index + WINDOW_LINES);
    for (let nextIndex = index; nextIndex < end; nextIndex += 1) {
      if (!SAVE_BUFFER_RE.test(lines[nextIndex])) {
        continue;
      }
      findings.push({
        file,
        line: index + 1,
        saveLine: nextIndex + 1,
      });
      break;
    }
  }
}

if (findings.length > 0) {
  console.error("Avoid remote-media buffer/store round trips in plugin production code.");
  console.error(
    "Use saveRemoteMedia(...) for URL-to-store or saveResponseMedia(...) for fetched Response objects.",
  );
  for (const finding of findings) {
    console.error(`- ${finding.file}:${finding.line} -> saveMediaBuffer at ${finding.saveLine}`);
  }
  process.exitCode = 1;
}
