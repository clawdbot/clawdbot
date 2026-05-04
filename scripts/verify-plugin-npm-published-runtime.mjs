#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";

function normalizeStringList(value) {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((entry) => (typeof entry === "string" ? entry.trim() : "")).filter(Boolean);
}

function normalizePackagePath(value) {
  return value
    .replace(/\\/g, "/")
    .replace(/^package\//u, "")
    .replace(/^\.\//u, "");
}

function isTypeScriptPackageEntry(entryPath) {
  return [".ts", ".mts", ".cts"].includes(path.extname(entryPath).toLowerCase());
}

function listBuiltRuntimeEntryCandidates(entryPath) {
  if (!isTypeScriptPackageEntry(entryPath)) {
    return [];
  }
  const normalized = entryPath.replace(/\\/g, "/");
  const withoutExtension = normalized.replace(/\.[^.]+$/u, "");
  const normalizedRelative = normalized.replace(/^\.\//u, "");
  const distWithoutExtension = normalizedRelative.startsWith("src/")
    ? `./dist/${normalizedRelative.slice("src/".length).replace(/\.[^.]+$/u, "")}`
    : `./dist/${withoutExtension.replace(/^\.\//u, "")}`;
  const withJavaScriptExtensions = (basePath) => [
    `${basePath}.js`,
    `${basePath}.mjs`,
    `${basePath}.cjs`,
  ];
  return [
    ...new Set([
      ...withJavaScriptExtensions(distWithoutExtension),
      ...withJavaScriptExtensions(withoutExtension),
    ]),
  ].filter((candidate) => candidate !== normalized);
}

function formatPackageLabel(packageJson, fallbackSpec) {
  const packageName = typeof packageJson.name === "string" ? packageJson.name.trim() : "";
  const packageVersion = typeof packageJson.version === "string" ? packageJson.version.trim() : "";
  if (packageName && packageVersion) {
    return `${packageName}@${packageVersion}`;
  }
  return packageName || fallbackSpec || "<package>";
}

export function collectPluginNpmPublishedRuntimeErrors(params) {
  const packageJson = params.packageJson ?? {};
  const packageFiles = new Set([...params.files].map(normalizePackagePath));
  const packageLabel = formatPackageLabel(packageJson, params.spec);
  const extensions = normalizeStringList(packageJson.openclaw?.extensions);
  const runtimeExtensions = normalizeStringList(packageJson.openclaw?.runtimeExtensions);
  const errors = [];

  if (extensions.length === 0) {
    return errors;
  }

  if (runtimeExtensions.length > 0 && runtimeExtensions.length !== extensions.length) {
    errors.push(
      `${packageLabel} package.json openclaw.runtimeExtensions length (${runtimeExtensions.length}) must match openclaw.extensions length (${extensions.length})`,
    );
    return errors;
  }

  for (const [index, entry] of extensions.entries()) {
    const runtimeEntry = runtimeExtensions[index];
    if (runtimeEntry) {
      if (!packageFiles.has(normalizePackagePath(runtimeEntry))) {
        errors.push(`${packageLabel} runtime extension entry not found: ${runtimeEntry}`);
      }
      continue;
    }

    if (!isTypeScriptPackageEntry(entry)) {
      continue;
    }

    const candidates = listBuiltRuntimeEntryCandidates(entry);
    if (candidates.some((candidate) => packageFiles.has(normalizePackagePath(candidate)))) {
      continue;
    }

    errors.push(
      `${packageLabel} requires compiled runtime output for TypeScript entry ${entry}: expected ${candidates.join(", ")}`,
    );
  }

  return errors;
}

function npmPack(spec, destinationDir) {
  const output = execFileSync(
    "npm",
    ["pack", spec, "--json", "--ignore-scripts", "--pack-destination", destinationDir],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const rows = JSON.parse(output);
  const filename = rows?.[0]?.filename;
  if (typeof filename !== "string" || !filename) {
    throw new Error(`npm pack ${spec} did not report a tarball filename`);
  }
  return path.isAbsolute(filename) ? filename : path.join(destinationDir, filename);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function packPublishedPackage(spec, destinationDir) {
  const attempts = Number.parseInt(process.env.OPENCLAW_PLUGIN_NPM_VERIFY_ATTEMPTS ?? "6", 10);
  const delayMs = Number.parseInt(process.env.OPENCLAW_PLUGIN_NPM_VERIFY_DELAY_MS ?? "5000", 10);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return npmPack(spec, destinationDir);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

function listFiles(rootDir, prefix = "") {
  const files = [];
  for (const entry of fs.readdirSync(path.join(rootDir, prefix), { withFileTypes: true })) {
    const relativePath = path.join(prefix, entry.name).replace(/\\/g, "/");
    if (entry.isDirectory()) {
      files.push(...listFiles(rootDir, relativePath));
    } else if (entry.isFile()) {
      files.push(relativePath);
    }
  }
  return files;
}

function readPackedPackage(tarballPath, extractDir) {
  tar.x({ file: tarballPath, cwd: extractDir, sync: true });
  const packageDir = path.join(extractDir, "package");
  const packageJson = JSON.parse(fs.readFileSync(path.join(packageDir, "package.json"), "utf8"));
  return {
    packageJson,
    files: listFiles(packageDir),
  };
}

export async function verifyPublishedPluginRuntime(spec) {
  const workingDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-plugin-npm-runtime."));
  try {
    const tarballPath = await packPublishedPackage(spec, workingDir);
    const extractDir = path.join(workingDir, "extract");
    fs.mkdirSync(extractDir, { recursive: true });
    const packedPackage = readPackedPackage(tarballPath, extractDir);
    const errors = collectPluginNpmPublishedRuntimeErrors({
      ...packedPackage,
      spec,
    });
    if (errors.length > 0) {
      throw new Error(errors.join("\n"));
    }
    return {
      packageName: packedPackage.packageJson.name,
      version: packedPackage.packageJson.version,
      fileCount: packedPackage.files.length,
    };
  } finally {
    fs.rmSync(workingDir, { force: true, recursive: true });
  }
}

async function main(argv) {
  const spec = argv[0]?.trim();
  if (!spec) {
    throw new Error("Usage: node scripts/verify-plugin-npm-published-runtime.mjs <package-spec>");
  }
  const result = await verifyPublishedPluginRuntime(spec);
  console.log(
    `plugin-npm-published-runtime-check: ${result.packageName}@${result.version} OK (${result.fileCount} files)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(
      `plugin-npm-published-runtime-check: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
