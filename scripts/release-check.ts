#!/usr/bin/env bun

import { execSync } from "node:child_process";

type PackFile = { path: string };
type PackResult = { files?: PackFile[] };

const requiredPaths = ["dist/discord/send.js", "dist/hooks/gmail.js"];
const forbiddenPrefixes = ["dist/Clawdbot.app/"];

function runPackDry(): PackResult[] {
  const raw = execSync("npm pack --dry-run --json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return JSON.parse(raw) as PackResult[];
}

function main() {
  const results = runPackDry();
  const files = results.flatMap((entry) => entry.files ?? []);
  const paths = new Set(files.map((file) => file.path));

  const missing = requiredPaths.filter((path) => !paths.has(path));
  const forbidden = [...paths].filter((path) =>
    forbiddenPrefixes.some((prefix) => path.startsWith(prefix)),
  );

  if (missing.length > 0 || forbidden.length > 0) {
    if (missing.length > 0) {
      console.error("release-check: missing files in npm pack:");
      for (const path of missing) {
        console.error(`  - ${path}`);
      }
    }
    if (forbidden.length > 0) {
      console.error("release-check: forbidden files in npm pack:");
      for (const path of forbidden) {
        console.error(`  - ${path}`);
      }
    }
    process.exit(1);
  }

  console.log("release-check: npm pack contents look OK.");
}

main();
