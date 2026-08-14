#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

type ClawHubIdentity = {
  integrity: string;
  lockSha256: string;
  version: string;
};

const CLAWHUB_PACKAGE_DIR = ".github/release/clawhub-cli";
const MATERIALIZER_PATH = "scripts/materialize-clawhub-cli.sh";

function readJson(filePath: string): unknown {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function requireRecord(value: unknown, description: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${description} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, description: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${description} must be a non-empty string`);
  }
  return value;
}

export function readClawHubIdentity(rootDir: string): ClawHubIdentity {
  const packageDir = path.join(rootDir, CLAWHUB_PACKAGE_DIR);
  const packageJson = requireRecord(
    readJson(path.join(packageDir, "package.json")),
    "package.json",
  );
  const dependencies = requireRecord(packageJson.dependencies, "package.json dependencies");
  const declaredVersion = requireString(dependencies.clawhub, "declared clawhub version");

  const lockPath = path.join(packageDir, "package-lock.json");
  const lockBytes = readFileSync(lockPath);
  const lockJson = requireRecord(JSON.parse(lockBytes.toString("utf8")), "package-lock.json");
  const packages = requireRecord(lockJson.packages, "package-lock.json packages");
  const lockedPackage = requireRecord(packages["node_modules/clawhub"], "locked clawhub package");
  const lockedVersion = requireString(lockedPackage.version, "locked clawhub version");
  const integrity = requireString(lockedPackage.integrity, "locked clawhub integrity");

  if (declaredVersion !== lockedVersion) {
    throw new Error(
      `declared clawhub version ${declaredVersion} does not match lock version ${lockedVersion}`,
    );
  }
  if (!integrity.startsWith("sha512-")) {
    throw new Error(`locked clawhub integrity must use sha512: ${integrity}`);
  }

  return {
    integrity,
    lockSha256: createHash("sha256").update(lockBytes).digest("hex"),
    version: lockedVersion,
  };
}

function replaceExactlyOnce(source: string, pattern: RegExp, replacement: string): string {
  const matches = source.match(new RegExp(pattern.source, "gu")) ?? [];
  if (matches.length !== 1) {
    throw new Error(`expected exactly one materializer match for ${pattern.source}`);
  }
  return source.replace(pattern, replacement);
}

export function renderClawHubMaterializerPins(source: string, identity: ClawHubIdentity): string {
  let rendered = replaceExactlyOnce(
    source,
    /expected_lock_sha256="[^"]+"/u,
    `expected_lock_sha256="${identity.lockSha256}"`,
  );
  rendered = replaceExactlyOnce(
    rendered,
    /expected_clawhub_integrity="[^"]+"/u,
    `expected_clawhub_integrity="${identity.integrity}"`,
  );
  return replaceExactlyOnce(
    rendered,
    /\[\[ "\$\{clawhub_version\}" == "[^"]+" \]\]/u,
    `[[ "\${clawhub_version}" == "${identity.version}" ]]`,
  );
}

export function syncClawHubPins(rootDir: string, write: boolean): boolean {
  const materializerPath = path.join(rootDir, MATERIALIZER_PATH);
  const source = readFileSync(materializerPath, "utf8");
  const identity = readClawHubIdentity(rootDir);
  const rendered = renderClawHubMaterializerPins(source, identity);
  const changed = rendered !== source;

  if (write && changed) {
    const temporaryPath = `${materializerPath}.${process.pid}.tmp`;
    rmSync(temporaryPath, { force: true });
    try {
      const descriptor = openSync(temporaryPath, "w", statSync(materializerPath).mode);
      try {
        writeFileSync(descriptor, rendered);
        fsyncSync(descriptor);
      } finally {
        closeSync(descriptor);
      }
      renameSync(temporaryPath, materializerPath);
    } finally {
      rmSync(temporaryPath, { force: true });
    }
  }
  return changed;
}

function printUsage(): void {
  console.log("Usage: node --import tsx scripts/sync-clawhub-cli-pins.mts <--check|--write>");
}

function main(): void {
  const [arg] = process.argv.slice(2);
  if (arg === "--help" || arg === "-h") {
    printUsage();
    return;
  }
  if (arg !== "--check" && arg !== "--write") {
    printUsage();
    process.exitCode = 2;
    return;
  }

  const changed = syncClawHubPins(process.cwd(), arg === "--write");
  if (arg === "--check" && changed) {
    console.error("ClawHub CLI identity pins are stale. Run pnpm deps:clawhub-cli-pins:sync.");
    process.exitCode = 1;
    return;
  }
  console.log(changed ? "Updated ClawHub CLI identity pins." : "ClawHub CLI identity pins match.");
}

const isDirectRun =
  process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectRun) {
  main();
}
