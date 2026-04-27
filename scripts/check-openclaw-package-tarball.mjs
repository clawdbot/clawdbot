#!/usr/bin/env node
// Validates the npm tarball Docker E2E lanes install.
// This is intentionally tarball-only: the check proves Docker lanes consume the
// prebuilt package artifact with dist inventory, not a source checkout.
import { spawnSync } from "node:child_process";
import fs from "node:fs";

function usage() {
  return "Usage: node scripts/check-openclaw-package-tarball.mjs <openclaw.tgz>";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

const tarball = process.argv[2];
if (!tarball || process.argv.length > 3) {
  fail(usage());
}
if (!fs.existsSync(tarball)) {
  fail(`OpenClaw package tarball does not exist: ${tarball}`);
}

const list = spawnSync("tar", ["-tf", tarball], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});
if (list.status !== 0) {
  fail(`tar -tf failed for ${tarball}: ${list.stderr || list.status}`);
}

const entries = list.stdout
  .split(/\r?\n/u)
  .map((entry) => entry.trim())
  .filter(Boolean);
const normalized = entries.map((entry) => entry.replace(/^package\//u, ""));
const entrySet = new Set(normalized);
const errors = [];
const warnings = [];
const LEGACY_PACKAGE_ACCEPTANCE_COMPAT_MAX = { year: 2026, month: 4, day: 25 };

const LEGACY_OMITTED_PRIVATE_QA_INVENTORY_PREFIXES = [
  "dist/extensions/qa-channel/",
  "dist/extensions/qa-lab/",
  "dist/extensions/qa-matrix/",
  "dist/plugin-sdk/extensions/qa-channel/",
  "dist/plugin-sdk/extensions/qa-lab/",
];
const LEGACY_OMITTED_PRIVATE_QA_INVENTORY_FILES = new Set([
  "dist/plugin-sdk/qa-channel.d.ts",
  "dist/plugin-sdk/qa-channel.js",
  "dist/plugin-sdk/qa-channel-protocol.d.ts",
  "dist/plugin-sdk/qa-channel-protocol.js",
  "dist/plugin-sdk/qa-lab.d.ts",
  "dist/plugin-sdk/qa-lab.js",
  "dist/plugin-sdk/qa-runtime.d.ts",
  "dist/plugin-sdk/qa-runtime.js",
  "dist/plugin-sdk/src/plugin-sdk/qa-channel.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-channel-protocol.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-lab.d.ts",
  "dist/plugin-sdk/src/plugin-sdk/qa-runtime.d.ts",
]);

function isLegacyOmittedPrivateQaInventoryEntry(relativePath) {
  return (
    LEGACY_OMITTED_PRIVATE_QA_INVENTORY_FILES.has(relativePath) ||
    LEGACY_OMITTED_PRIVATE_QA_INVENTORY_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

function parseCalver(version) {
  const match = /^(\d{4})\.(\d{1,2})\.(\d{1,2})(?:[-+].*)?$/u.exec(version);
  if (!match) {
    return null;
  }
  return {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
}

function compareCalver(left, right) {
  for (const key of ["year", "month", "day"]) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

function isLegacyPackageAcceptanceCompatVersion(version) {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_PACKAGE_ACCEPTANCE_COMPAT_MAX) <= 0 : false;
}

function readTarEntry(entryPath) {
  const candidates = [entryPath, `package/${entryPath}`];
  for (const candidate of candidates) {
    const result = spawnSync("tar", ["-xOf", tarball, candidate], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.status === 0) {
      return result.stdout;
    }
  }
  return "";
}

for (const entry of normalized) {
  if (entry.startsWith("/") || entry.split("/").includes("..")) {
    errors.push(`unsafe tar entry: ${entry}`);
  }
}

if (!entrySet.has("package.json")) {
  errors.push("missing package.json");
}
if (!normalized.some((entry) => entry.startsWith("dist/"))) {
  errors.push("missing dist/ entries");
}
if (!entrySet.has("dist/postinstall-inventory.json")) {
  errors.push("missing dist/postinstall-inventory.json");
}
if (entrySet.has("dist/postinstall-inventory.json")) {
  try {
    const packageJson = JSON.parse(readTarEntry("package.json"));
    const packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
    const allowLegacyPrivateQaInventoryOmissions =
      isLegacyPackageAcceptanceCompatVersion(packageVersion);
    const inventory = JSON.parse(readTarEntry("dist/postinstall-inventory.json"));
    if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
      errors.push("invalid dist/postinstall-inventory.json");
    } else {
      for (const inventoryEntry of inventory) {
        const normalizedEntry = inventoryEntry.replace(/\\/gu, "/");
        if (!entrySet.has(normalizedEntry)) {
          if (
            allowLegacyPrivateQaInventoryOmissions &&
            isLegacyOmittedPrivateQaInventoryEntry(normalizedEntry)
          ) {
            warnings.push(
              `legacy inventory references omitted private QA tar entry ${normalizedEntry}`,
            );
            continue;
          }
          errors.push(`inventory references missing tar entry ${normalizedEntry}`);
        }
      }
    }
  } catch (error) {
    errors.push(
      `unreadable dist/postinstall-inventory.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

if (errors.length > 0) {
  fail(`OpenClaw package tarball integrity failed:\n${errors.join("\n")}`);
}

for (const warning of warnings) {
  console.warn(`OpenClaw package tarball integrity warning: ${warning}`);
}
console.log("OpenClaw package tarball integrity passed.");
