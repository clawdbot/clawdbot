#!/usr/bin/env node
// Verifies published plugin npm packages include built runtime entries and
// metadata expected by OpenClaw.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as tar from "tar";
import { sleep } from "./lib/sleep.mjs";

const DEFAULT_NPM_COMMAND_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_NPM_COMMAND_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

function readPackageStringList(packageLabel, fieldName, value) {
  if (!Array.isArray(value)) {
    return { entries: [], errors: [] };
  }
  const entries = [];
  const errors = [];
  for (const [index, entry] of value.entries()) {
    const normalized = typeof entry === "string" ? entry.trim() : "";
    if (!normalized) {
      errors.push(`${packageLabel} package.json ${fieldName}[${index}] must be a non-empty string`);
      continue;
    }
    entries.push(normalized);
  }
  return { entries, errors };
}

function readOptionalPackageString(packageLabel, fieldName, value) {
  if (value === undefined || value === null) {
    return { entry: "", errors: [] };
  }
  const entry = typeof value === "string" ? value.trim() : "";
  if (!entry) {
    return {
      entry: "",
      errors: [`${packageLabel} package.json ${fieldName} must be a non-empty string`],
    };
  }
  return { entry, errors: [] };
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

function hasPackedFile(packageFiles, entryPath) {
  return packageFiles.has(normalizePackagePath(entryPath));
}

function missingCompiledRuntimeError(packageLabel, entry, candidates) {
  return `${packageLabel} requires compiled runtime output for TypeScript entry ${entry}: expected ${candidates.join(", ")}`;
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
  const errors = [];
  const extensionsResult = readPackageStringList(
    packageLabel,
    "openclaw.extensions",
    packageJson.openclaw?.extensions,
  );
  const runtimeExtensionsResult = readPackageStringList(
    packageLabel,
    "openclaw.runtimeExtensions",
    packageJson.openclaw?.runtimeExtensions,
  );
  const setupEntryResult = readOptionalPackageString(
    packageLabel,
    "openclaw.setupEntry",
    packageJson.openclaw?.setupEntry,
  );
  const runtimeSetupEntryResult = readOptionalPackageString(
    packageLabel,
    "openclaw.runtimeSetupEntry",
    packageJson.openclaw?.runtimeSetupEntry,
  );
  errors.push(
    ...extensionsResult.errors,
    ...runtimeExtensionsResult.errors,
    ...setupEntryResult.errors,
    ...runtimeSetupEntryResult.errors,
  );
  if (errors.length > 0) {
    return errors;
  }
  if (!hasPackedFile(packageFiles, "openclaw.plugin.json")) {
    errors.push(`${packageLabel} plugin npm package must include openclaw.plugin.json`);
    return errors;
  }
  const extensions = extensionsResult.entries;
  const runtimeExtensions = runtimeExtensionsResult.entries;
  const setupEntry = setupEntryResult.entry;
  const runtimeSetupEntry = runtimeSetupEntryResult.entry;

  if (runtimeExtensions.length > 0 && runtimeExtensions.length !== extensions.length) {
    errors.push(
      `${packageLabel} package.json openclaw.runtimeExtensions length (${runtimeExtensions.length}) must match openclaw.extensions length (${extensions.length})`,
    );
    return errors;
  }

  for (const [index, entry] of extensions.entries()) {
    const runtimeEntry = runtimeExtensions[index];
    if (runtimeEntry) {
      if (!hasPackedFile(packageFiles, runtimeEntry)) {
        errors.push(`${packageLabel} runtime extension entry not found: ${runtimeEntry}`);
      }
      continue;
    }

    if (!isTypeScriptPackageEntry(entry)) {
      continue;
    }

    const candidates = listBuiltRuntimeEntryCandidates(entry);
    if (candidates.some((candidate) => hasPackedFile(packageFiles, candidate))) {
      continue;
    }

    errors.push(missingCompiledRuntimeError(packageLabel, entry, candidates));
  }

  if (runtimeSetupEntry && !setupEntry) {
    errors.push(
      `${packageLabel} package.json openclaw.runtimeSetupEntry requires openclaw.setupEntry`,
    );
    return errors;
  }

  if (setupEntry) {
    if (runtimeSetupEntry) {
      if (!hasPackedFile(packageFiles, runtimeSetupEntry)) {
        errors.push(`${packageLabel} runtime setup entry not found: ${runtimeSetupEntry}`);
      }
      return errors;
    }

    const candidates = listBuiltRuntimeEntryCandidates(setupEntry);
    if (candidates.length > 0) {
      if (candidates.some((candidate) => hasPackedFile(packageFiles, candidate))) {
        return errors;
      }
      errors.push(missingCompiledRuntimeError(packageLabel, setupEntry, candidates));
      return errors;
    }

    if (!hasPackedFile(packageFiles, setupEntry)) {
      errors.push(`${packageLabel} setup entry not found: ${setupEntry}`);
    }
  }

  return errors;
}

export function resolveNpmPackFilename(output) {
  const filename = output
    .split(/\r?\n/u)
    .findLast((line) => line.trim().length > 0)
    ?.trim();
  if (
    typeof filename !== "string" ||
    !filename.endsWith(".tgz") ||
    filename.includes("\0") ||
    filename !== path.basename(filename) ||
    filename !== path.win32.basename(filename)
  ) {
    throw new Error(`npm pack did not report a tarball filename`);
  }
  return filename;
}

export function readPositiveIntEnv(name, fallback, env = process.env) {
  const text = String(env[name] ?? fallback).trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  const value = Number(text);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`invalid ${name}: ${text}`);
  }
  return value;
}

export function readPluginNpmCommandOptions(env = process.env) {
  return {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: readPositiveIntEnv(
      "OPENCLAW_PLUGIN_NPM_COMMAND_MAX_BUFFER_BYTES",
      DEFAULT_NPM_COMMAND_MAX_BUFFER_BYTES,
      env,
    ),
    stdio: ["ignore", "pipe", "pipe"],
    timeout: readPositiveIntEnv(
      "OPENCLAW_PLUGIN_NPM_COMMAND_TIMEOUT_MS",
      DEFAULT_NPM_COMMAND_TIMEOUT_MS,
      env,
    ),
  };
}

export function runPluginNpmCommand(args, params = {}) {
  const execFileSyncImpl = params.execFileSyncImpl ?? execFileSync;
  return execFileSyncImpl("npm", args, readPluginNpmCommandOptions(params.env));
}

function npmPack(spec, destinationDir) {
  const output = runPluginNpmCommand([
    "pack",
    spec,
    "--ignore-scripts",
    "--pack-destination",
    destinationDir,
  ]);
  const filename = resolveNpmPackFilename(output);
  return path.isAbsolute(filename) ? filename : path.join(destinationDir, filename);
}

export function parseNpmReadmeMetadata(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "";
  }
  return typeof parsed === "string" ? parsed.trim() : "";
}

function npmViewReadme(spec) {
  return runPluginNpmCommand(["view", spec, "readme", "--json", "--prefer-online"]);
}

async function packPublishedPackage(spec, destinationDir) {
  const attempts = readPositiveIntEnv("OPENCLAW_PLUGIN_NPM_VERIFY_ATTEMPTS", 90);
  const delayMs = readPositiveIntEnv("OPENCLAW_PLUGIN_NPM_VERIFY_DELAY_MS", 10000);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return npmPack(spec, destinationDir);
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        console.error(
          `npm pack ${spec} not visible yet (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms...`,
        );
        await sleep(delayMs);
      }
    }
  }
  throw lastError;
}

async function verifyPublishedPackageReadme(spec) {
  const attempts = readPositiveIntEnv("OPENCLAW_PLUGIN_NPM_README_VERIFY_ATTEMPTS", 6);
  const delayMs = readPositiveIntEnv("OPENCLAW_PLUGIN_NPM_README_VERIFY_DELAY_MS", 10000);
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      const readme = parseNpmReadmeMetadata(npmViewReadme(spec));
      if (readme) {
        return readme;
      }
      lastError = new Error(`npm view ${spec} readme returned empty metadata`);
    } catch (error) {
      lastError = error;
    }
    if (attempt < attempts) {
      console.error(
        `npm readme metadata for ${spec} not ready (attempt ${attempt}/${attempts}); retrying in ${delayMs}ms...`,
      );
      await sleep(delayMs);
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
  const files = listFiles(packageDir);
  return {
    packageJson,
    files,
    readme: readPackedPackageReadme(packageDir, files),
  };
}

export function findPackedPackageReadmePath(files) {
  return files.find((file) => /^readme(?:\.(?:md|markdown|txt|rst))?$/iu.test(file)) ?? "";
}

function readPackedPackageReadme(packageDir, files) {
  const readmePath = findPackedPackageReadmePath(files);
  if (!readmePath) {
    return "";
  }
  return fs.readFileSync(path.join(packageDir, readmePath), "utf8").trim();
}

export function usage() {
  return "Usage: node scripts/verify-plugin-npm-published-runtime.mjs <package-spec>";
}

export function parseVerifyPublishedPluginRuntimeArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const first = args[0]?.trim();
  if (first === "--help" || first === "-h") {
    return { help: true, spec: "" };
  }
  if (!first) {
    throw new Error(usage());
  }
  if (first.startsWith("-")) {
    throw new Error(`Unknown plugin npm verifier option: ${first}`);
  }
  if (args.length > 1) {
    throw new Error(`Unexpected plugin npm verifier argument: ${args[1]}`);
  }
  return { help: false, spec: first };
}

async function verifyPublishedPluginRuntime(spec) {
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
    let readme;
    try {
      readme = await verifyPublishedPackageReadme(spec);
    } catch (error) {
      if (!packedPackage.readme) {
        throw error;
      }
      console.error(
        `npm readme metadata for ${spec} was unavailable; verified README from published tarball instead.`,
      );
      readme = packedPackage.readme;
    }
    return {
      packageName: packedPackage.packageJson.name,
      version: packedPackage.packageJson.version,
      fileCount: packedPackage.files.length,
      readmeLength: readme.length,
    };
  } finally {
    fs.rmSync(workingDir, { force: true, recursive: true });
  }
}

async function main(argv) {
  const args = parseVerifyPublishedPluginRuntimeArgs(argv);
  if (args.help) {
    console.log(usage());
    return;
  }
  const result = await verifyPublishedPluginRuntime(args.spec);
  console.log(
    `plugin-npm-published-runtime-check: ${result.packageName}@${result.version} OK (${result.fileCount} files, ${result.readmeLength} readme chars)`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch(
    /** @param {unknown} error */ (error) => {
      console.error(
        `plugin-npm-published-runtime-check: ${error instanceof Error ? error.message : String(error)}`,
      );
      process.exitCode = 1;
    },
  );
}
