#!/usr/bin/env node
// Validates the npm tarball Docker E2E lanes install.
// This is intentionally tarball-only: the check proves Docker lanes consume the
// prebuilt package artifact with dist inventory, not a source checkout.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "./lib/local-build-metadata-paths.mjs";
import {
  collectPackageDistImports,
  collectPackageDistImportErrors,
  expandPackageDistImportClosure,
} from "./lib/package-dist-imports.mjs";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "./lib/workspace-bootstrap-smoke.mjs";

function usage() {
  return "Usage: node scripts/check-openclaw-package-tarball.mjs [--require-bundled-workspace-deps] <openclaw.tgz>";
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv) {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  let requireBundledWorkspaceDeps = false;
  let tarball = "";
  for (const rawArg of args) {
    const arg = rawArg?.trim() ?? "";
    if (arg === "--help" || arg === "-h") {
      return { help: true, requireBundledWorkspaceDeps: false, tarball: "" };
    }
    if (arg === "--require-bundled-workspace-deps") {
      requireBundledWorkspaceDeps = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown OpenClaw package tarball check option: ${arg}`);
    }
    if (tarball) {
      throw new Error(`Unexpected OpenClaw package tarball check argument: ${arg}`);
    }
    tarball = arg;
  }
  if (!tarball) {
    throw new Error(usage());
  }
  return { help: false, requireBundledWorkspaceDeps, tarball };
}

let cliArgs;
try {
  cliArgs = parseArgs(process.argv.slice(2));
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
if (cliArgs.help) {
  console.log(usage());
  process.exit(0);
}

const { tarball } = cliArgs;
if (!fs.existsSync(tarball)) {
  fail(`OpenClaw package tarball does not exist: ${tarball}`);
}

const PACKAGE_DEPENDENCY_SECTIONS = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "devDependencies",
];
const REQUIRED_BUNDLED_WORKSPACE_DEPENDENCIES = ["@openclaw/ai"];
// Strict Docker artifacts bundle this private runtime rather than resolving it
// from npm. Keep the concrete load-bearing entries explicit instead of
// reimplementing Node's conditional package-exports resolver here.
const REQUIRED_BUNDLED_WORKSPACE_RUNTIME_ENTRIES = new Map([
  [
    "@openclaw/ai",
    [
      { specifier: "@openclaw/ai", entry: "dist/index.mjs" },
      { specifier: "@openclaw/ai/providers", entry: "dist/providers.mjs" },
      {
        specifier: "@openclaw/ai/internal/runtime",
        entry: "dist/internal/runtime.mjs",
      },
    ],
  ],
]);

function collectWorkspaceProtocolDependencyErrors(packageJson, label) {
  const errors = [];
  if (!packageJson || typeof packageJson !== "object") {
    return errors;
  }

  for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
    const dependencies = packageJson[section];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }

    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec === "string" && spec.startsWith("workspace:")) {
        errors.push(`${label} ${section}.${name} must not use workspace protocol ${spec}`);
      }
    }
  }

  return errors;
}

function listBundleDependencies(packageJson) {
  if (!packageJson || typeof packageJson !== "object") {
    return [];
  }
  if (packageJson.bundleDependencies === true) {
    return Object.keys(packageJson.dependencies ?? {});
  }
  const bundleDependencies = Array.isArray(packageJson.bundleDependencies)
    ? packageJson.bundleDependencies
    : packageJson.bundledDependencies;
  return Array.isArray(bundleDependencies)
    ? bundleDependencies.filter((name) => typeof name === "string")
    : [];
}

function resolveBundledPackageSpecifiers(packageRoot, specifiers) {
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `const resolutions = {};
for (const specifier of JSON.parse(process.argv[1])) {
  try {
    resolutions[specifier] = import.meta.resolve(specifier);
  } catch {
    resolutions[specifier] = "";
  }
}
process.stdout.write(JSON.stringify(resolutions));`,
      JSON.stringify(specifiers),
    ],
    { cwd: packageRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
  );
  if (result.status !== 0) {
    return null;
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    return null;
  }
}

function collectBundledPackageRuntimeErrors({ name, entries, files, packageRoot, readText }) {
  const errors = [];
  const packagePrefix = `node_modules/${name}/`;
  const manifestPath = `${packagePrefix}package.json`;
  let bundledPackageJson;
  try {
    bundledPackageJson = JSON.parse(readText(manifestPath));
  } catch (error) {
    errors.push(
      `unreadable bundled ${name} package.json: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return errors;
  }
  if (bundledPackageJson.name !== name) {
    errors.push(`bundled ${name} package.json must name ${name}`);
  }
  const runtimeEntries = REQUIRED_BUNDLED_WORKSPACE_RUNTIME_ENTRIES.get(name) ?? [];
  const resolutions = resolveBundledPackageSpecifiers(
    packageRoot,
    runtimeEntries.map(({ specifier }) => specifier),
  );
  if (!resolutions) {
    errors.push(`bundled ${name} runtime specifier resolution failed`);
  }
  for (const { entry, specifier } of runtimeEntries) {
    if (!entries.has(`${packagePrefix}${entry}`)) {
      errors.push(`bundled ${name} is missing required runtime entry ${entry}`);
    }
    const resolvedUrl = resolutions?.[specifier] ?? "";
    if (!resolvedUrl) {
      errors.push(`bundled ${name} runtime specifier ${specifier} is not resolvable`);
      continue;
    }
    const expectedUrl = pathToFileURL(path.join(packageRoot, packagePrefix, entry)).href;
    if (resolvedUrl !== expectedUrl) {
      errors.push(
        `bundled ${name} runtime specifier ${specifier} resolves to ${resolvedUrl} instead of ${expectedUrl}`,
      );
    }
  }
  const bundledFiles = files
    .filter((file) => file.startsWith(packagePrefix))
    .map((file) => file.slice(packagePrefix.length));
  errors.push(
    ...collectPackageDistImportErrors({
      files: bundledFiles,
      readText: (file) => readText(`${packagePrefix}${file}`),
    }).map((error) => `bundled ${name} ${error}`),
  );
  return errors;
}

function collectRequiredBundledWorkspaceDependencyErrors(
  packageJson,
  entrySet,
  files,
  packageRoot,
  readText,
) {
  const errors = [];
  if (!packageJson || typeof packageJson !== "object") {
    return errors;
  }

  const dependencies = packageJson.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    return errors;
  }

  const bundledDependencies = new Set(listBundleDependencies(packageJson));
  for (const name of REQUIRED_BUNDLED_WORKSPACE_DEPENDENCIES) {
    if (typeof dependencies[name] !== "string") {
      continue;
    }
    if (!bundledDependencies.has(name)) {
      errors.push(
        `package.json dependencies.${name} must be listed in bundleDependencies because it is private to the OpenClaw workspace`,
      );
    }
    if (!entrySet.has(`node_modules/${name}/package.json`)) {
      errors.push(`package.json dependencies.${name} must be bundled in node_modules/${name}`);
      continue;
    }
    errors.push(
      ...collectBundledPackageRuntimeErrors({
        name,
        entries: entrySet,
        files,
        packageRoot,
        readText,
      }),
    );
  }

  return errors;
}

const phaseTimingsEnabled = process.env.OPENCLAW_PACKAGE_TARBALL_CHECK_TIMINGS !== "0";
function runPhase(label, action) {
  const startedAt = performance.now();
  try {
    return action();
  } finally {
    if (phaseTimingsEnabled) {
      const durationMs = Math.round(performance.now() - startedAt);
      console.error(`check-openclaw-package-tarball: ${label} completed in ${durationMs}ms`);
    }
  }
}

const list = runPhase("tar list", () =>
  spawnSync("tar", ["-tf", tarball], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
if (list.status !== 0) {
  fail(`tar -tf failed for ${tarball}: ${list.stderr || list.status}`);
}

const extractDir = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-package-tarball-"));
try {
  const extract = runPhase("tar extract", () =>
    spawnSync("tar", ["-xf", tarball, "-C", extractDir], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }),
  );
  if (extract.status !== 0) {
    fs.rmSync(extractDir, { recursive: true, force: true });
    fail(`tar -xf failed for ${tarball}: ${extract.stderr || extract.status}`);
  }
} catch (error) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  throw error;
}

const entries = list.stdout
  .split(/\r?\n/u)
  .map((entry) => entry.trim())
  .filter(Boolean);
const normalized = entries.map((entry) => entry.replace(/^package\//u, ""));
const entrySet = new Set(normalized);
const errors = [];
const warnings = [];
const REQUIRED_TARBALL_ENTRIES = ["dist/control-ui/index.html", ...WORKSPACE_TEMPLATE_PACK_PATHS];
const REQUIRED_TARBALL_ENTRY_PREFIXES = ["dist/control-ui/assets/"];
const LEGACY_PACKAGE_ACCEPTANCE_COMPAT_MAX = { year: 2026, month: 4, day: 25 };
const LEGACY_LOCAL_BUILD_METADATA_COMPAT_MAX = { year: 2026, month: 4, day: 26 };
const LEGACY_SHRINKWRAP_COMPAT_MAX = { year: 2026, month: 5, day: 20 };
const FORBIDDEN_LOCAL_BUILD_METADATA_FILES = new Set(LOCAL_BUILD_METADATA_DIST_PATHS);

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

function isLegacyLocalBuildMetadataCompatVersion(version) {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_LOCAL_BUILD_METADATA_COMPAT_MAX) <= 0 : false;
}

function isLegacyShrinkwrapCompatVersion(version) {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_SHRINKWRAP_COMPAT_MAX) <= 0 : false;
}

function readTarEntry(entryPath) {
  const candidates = [
    path.join(extractDir, entryPath),
    path.join(extractDir, "package", entryPath),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, "utf8");
    }
  }
  return "";
}

const extractedPackageRoot = fs.realpathSync(
  fs.existsSync(path.join(extractDir, "package", "package.json"))
    ? path.join(extractDir, "package")
    : extractDir,
);

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
for (const requiredEntry of REQUIRED_TARBALL_ENTRIES) {
  if (!entrySet.has(requiredEntry)) {
    errors.push(`missing required tar entry ${requiredEntry}`);
  }
}
for (const requiredPrefix of REQUIRED_TARBALL_ENTRY_PREFIXES) {
  if (!normalized.some((entry) => entry.startsWith(requiredPrefix))) {
    errors.push(`missing required tar entries under ${requiredPrefix}`);
  }
}
let packageVersion = "";
if (entrySet.has("package.json")) {
  try {
    const packageJson = JSON.parse(readTarEntry("package.json"));
    packageVersion = typeof packageJson.version === "string" ? packageJson.version : "";
    errors.push(...collectWorkspaceProtocolDependencyErrors(packageJson, "package.json"));
    if (cliArgs.requireBundledWorkspaceDeps) {
      errors.push(
        ...collectRequiredBundledWorkspaceDependencyErrors(
          packageJson,
          entrySet,
          normalized,
          extractedPackageRoot,
          readTarEntry,
        ),
      );
    }
  } catch {
    packageVersion = "";
  }
}
if (entrySet.has("package-lock.json")) {
  errors.push("package tarball must ship npm-shrinkwrap.json, not package-lock.json");
}
if (!entrySet.has("npm-shrinkwrap.json")) {
  if (isLegacyShrinkwrapCompatVersion(packageVersion)) {
    warnings.push("legacy package omits npm-shrinkwrap.json");
  } else {
    errors.push("missing required tar entry npm-shrinkwrap.json");
  }
} else {
  try {
    const shrinkwrap = JSON.parse(readTarEntry("npm-shrinkwrap.json"));
    const rootPackage = shrinkwrap.packages?.[""];
    if (shrinkwrap.name !== "openclaw") {
      errors.push("npm-shrinkwrap.json root name must be openclaw");
    }
    if (shrinkwrap.version !== packageVersion) {
      errors.push(
        `npm-shrinkwrap.json version ${shrinkwrap.version ?? "<missing>"} does not match package.json version ${packageVersion || "<missing>"}`,
      );
    }
    if (!rootPackage || rootPackage.name !== "openclaw") {
      errors.push("npm-shrinkwrap.json packages root must name openclaw");
    }
    if (rootPackage?.version !== packageVersion) {
      errors.push(
        `npm-shrinkwrap.json packages root version ${rootPackage?.version ?? "<missing>"} does not match package.json version ${packageVersion || "<missing>"}`,
      );
    }
    if (rootPackage?.devDependencies) {
      errors.push("npm-shrinkwrap.json must not lock root devDependencies");
    }
    errors.push(
      ...collectWorkspaceProtocolDependencyErrors(rootPackage, "npm-shrinkwrap.json packages root"),
    );
    const devLockedPackages = Object.entries(shrinkwrap.packages ?? {})
      .filter(([, packageMetadata]) => packageMetadata?.dev === true)
      .map(([packagePath]) => packagePath);
    if (devLockedPackages.length > 0) {
      errors.push(
        `npm-shrinkwrap.json must not lock dev packages: ${devLockedPackages.slice(0, 5).join(", ")}`,
      );
    }
  } catch (error) {
    errors.push(
      `unreadable npm-shrinkwrap.json: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
for (const forbiddenEntry of FORBIDDEN_LOCAL_BUILD_METADATA_FILES) {
  if (entrySet.has(forbiddenEntry)) {
    if (isLegacyLocalBuildMetadataCompatVersion(packageVersion)) {
      warnings.push(`legacy package includes local build metadata tar entry ${forbiddenEntry}`);
      continue;
    }
    errors.push(`forbidden local build metadata tar entry ${forbiddenEntry}`);
  }
}
if (!entrySet.has("dist/postinstall-inventory.json")) {
  errors.push("missing dist/postinstall-inventory.json");
}
let packageDistImports = null;
if (entrySet.has("dist/postinstall-inventory.json")) {
  try {
    const allowLegacyPrivateQaInventoryOmissions =
      isLegacyPackageAcceptanceCompatVersion(packageVersion);
    const inventory = JSON.parse(readTarEntry("dist/postinstall-inventory.json"));
    if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
      errors.push("invalid dist/postinstall-inventory.json");
    } else {
      const normalizedInventory = inventory.map((entry) => entry.replace(/\\/gu, "/"));
      const normalizedInventorySet = new Set(normalizedInventory);
      packageDistImports = runPhase("dist import graph", () =>
        collectPackageDistImports({
          files: normalized,
          readText: readTarEntry,
        }),
      );
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
      const expandedInventory = expandPackageDistImportClosure({
        files: normalized,
        seedFiles: normalizedInventory,
        readText: readTarEntry,
        imports: packageDistImports,
      });
      for (const importedEntry of expandedInventory) {
        if (!normalizedInventorySet.has(importedEntry)) {
          errors.push(`inventory omits imported dist file ${importedEntry}`);
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

errors.push(
  ...collectPackageDistImportErrors({
    files: normalized,
    readText: readTarEntry,
    imports: packageDistImports ?? undefined,
  }),
);

if (errors.length > 0) {
  fs.rmSync(extractDir, { recursive: true, force: true });
  fail(`OpenClaw package tarball integrity failed:\n${errors.join("\n")}`);
}

for (const warning of warnings) {
  console.warn(`OpenClaw package tarball integrity warning: ${warning}`);
}
fs.rmSync(extractDir, { recursive: true, force: true });
console.log("OpenClaw package tarball integrity passed.");
