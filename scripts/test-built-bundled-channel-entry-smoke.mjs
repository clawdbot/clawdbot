import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parsePackageRootArg } from "./lib/package-root-args.mjs";
import { installProcessWarningFilter } from "./process-warning-filter.mjs";

installProcessWarningFilter();

process.env.OPENCLAW_DISABLE_BUNDLED_ENTRY_SOURCE_FALLBACK ??= "1";

const { packageRoot } = parsePackageRootArg(
  process.argv.slice(2),
  "OPENCLAW_BUNDLED_CHANNEL_SMOKE_ROOT",
);
const distExtensionsRoot = path.join(packageRoot, "dist", "extensions");
const installedLayoutEnv = "OPENCLAW_BUNDLED_CHANNEL_SMOKE_INSTALLED_LAYOUT";

function packageRootLooksInstalled(root) {
  return root.replaceAll("\\", "/").endsWith("/node_modules/openclaw");
}

function smokeInInstalledLayoutIfNeeded() {
  if (process.env[installedLayoutEnv] === "1" || packageRootLooksInstalled(packageRoot)) {
    return;
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-channel-entry-smoke-"));
  const nodeModulesRoot = path.join(tempRoot, "node_modules");
  const installedPackageRoot = path.join(nodeModulesRoot, "openclaw");
  fs.mkdirSync(nodeModulesRoot, { recursive: true });
  fs.symlinkSync(packageRoot, installedPackageRoot, "dir");

  try {
    const result = spawnSync(
      process.execPath,
      [
        "--preserve-symlinks",
        fileURLToPath(import.meta.url),
        "--package-root",
        installedPackageRoot,
      ],
      {
        env: { ...process.env, [installedLayoutEnv]: "1" },
        stdio: "inherit",
      },
    );
    process.exit(result.status ?? 1);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

smokeInInstalledLayoutIfNeeded();

async function importBuiltModule(absolutePath) {
  return import(pathToFileURL(absolutePath).href);
}

function readJson(pathname) {
  return JSON.parse(fs.readFileSync(pathname, "utf8"));
}

function extensionEntryToDistFilename(entry) {
  return entry.replace(/^\.\//u, "").replace(/\.[^.]+$/u, ".js");
}

function collectBundledChannelEntryFiles() {
  const files = [];
  for (const dirent of fs.readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const extensionRoot = path.join(distExtensionsRoot, dirent.name);
    const packageJsonPath = path.join(extensionRoot, "package.json");
    if (!fs.existsSync(packageJsonPath)) {
      continue;
    }
    const packageJson = readJson(packageJsonPath);
    if (!packageJson.openclaw?.channel) {
      continue;
    }

    const extensionEntries =
      Array.isArray(packageJson.openclaw.extensions) && packageJson.openclaw.extensions.length > 0
        ? packageJson.openclaw.extensions
        : ["./index.ts"];
    for (const entry of extensionEntries) {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        continue;
      }
      files.push({
        id: dirent.name,
        kind: "channel",
        path: path.join(extensionRoot, extensionEntryToDistFilename(entry)),
      });
    }

    const setupEntry = packageJson.openclaw.setupEntry;
    if (typeof setupEntry === "string" && setupEntry.trim().length > 0) {
      files.push({
        id: dirent.name,
        kind: "setup",
        path: path.join(extensionRoot, extensionEntryToDistFilename(setupEntry)),
      });
    }

    const channelEntryPath = path.join(extensionRoot, "channel-entry.js");
    if (fs.existsSync(channelEntryPath)) {
      files.push({
        id: dirent.name,
        kind: "channel",
        path: channelEntryPath,
      });
    }
  }

  return files.toSorted((left, right) =>
    `${left.id}:${left.kind}:${left.path}`.localeCompare(`${right.id}:${right.kind}:${right.path}`),
  );
}

function assertSecretContractShape(secrets, context) {
  assert.ok(secrets && typeof secrets === "object", `${context}: missing secrets contract`);
  assert.equal(
    typeof secrets.collectRuntimeConfigAssignments,
    "function",
    `${context}: collectRuntimeConfigAssignments must be a function`,
  );
  assert.ok(
    Array.isArray(secrets.secretTargetRegistryEntries),
    `${context}: secretTargetRegistryEntries must be an array`,
  );
}

function assertEntryFileExists(entry) {
  assert.ok(
    fs.existsSync(entry.path),
    `${entry.id} ${entry.kind} entry missing from packed dist: ${entry.path}`,
  );
}

async function smokeChannelEntry(entryFile) {
  assertEntryFileExists(entryFile);
  const entry = (await importBuiltModule(entryFile.path)).default;
  assert.equal(entry.kind, "bundled-channel-entry", `${entryFile.id} channel entry kind mismatch`);
  assert.equal(
    typeof entry.loadChannelPlugin,
    "function",
    `${entryFile.id} channel entry missing loadChannelPlugin`,
  );
  const plugin = entry.loadChannelPlugin();
  assert.equal(plugin?.id, entryFile.id, `${entryFile.id} channel plugin failed to load`);
  if (entry.loadChannelSecrets) {
    assertSecretContractShape(
      entry.loadChannelSecrets(),
      `${entryFile.id} channel entry packaged secrets`,
    );
  }
}

async function smokeSetupEntry(entryFile) {
  assertEntryFileExists(entryFile);
  const entry = (await importBuiltModule(entryFile.path)).default;
  if (entry?.kind !== "bundled-channel-setup-entry") {
    return false;
  }
  assert.equal(
    entry.kind,
    "bundled-channel-setup-entry",
    `${entryFile.id} setup entry kind mismatch`,
  );
  assert.equal(
    typeof entry.loadSetupPlugin,
    "function",
    `${entryFile.id} setup entry missing loadSetupPlugin`,
  );
  const plugin = entry.loadSetupPlugin();
  assert.equal(plugin?.id, entryFile.id, `${entryFile.id} setup plugin failed to load`);
  if (entry.loadSetupSecrets) {
    assertSecretContractShape(
      entry.loadSetupSecrets(),
      `${entryFile.id} setup entry packaged secrets`,
    );
  }
  return true;
}

const entryFiles = collectBundledChannelEntryFiles();
let channelCount = 0;
let setupCount = 0;
let legacySetupCount = 0;

for (const entryFile of entryFiles) {
  if (entryFile.kind === "channel") {
    await smokeChannelEntry(entryFile);
    channelCount += 1;
    continue;
  }
  if (await smokeSetupEntry(entryFile)) {
    setupCount += 1;
  } else {
    legacySetupCount += 1;
  }
}

assert.ok(channelCount > 0, "no bundled channel entries found");
process.stdout.write(
  `[build-smoke] bundled channel entry smoke passed packageRoot=${packageRoot} channel=${channelCount} setup=${setupCount} legacySetup=${legacySetupCount}\n`,
);
