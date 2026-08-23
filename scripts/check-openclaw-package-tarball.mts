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
import { gte as semverGte, valid as validSemver } from "semver";
import { LOCAL_BUILD_METADATA_DIST_PATHS } from "./lib/local-build-metadata-paths.mts";
import {
  collectPackageDistImports,
  collectPackageDistImportErrors,
  expandPackageDistImportClosure,
} from "./lib/package-dist-imports.mjs";
import { WORKSPACE_TEMPLATE_PACK_PATHS } from "./lib/workspace-bootstrap-smoke.mts";

type PackageManifest = Record<string, unknown> & {
  scripts?: { postinstall?: unknown };
  version?: unknown;
};

type Calver = { day: number; month: number; year: number };

type ShrinkwrapPackage = {
  dev?: unknown;
  devDependencies?: unknown;
  name?: unknown;
  version?: unknown;
};

type ShrinkwrapManifest = {
  name?: unknown;
  packages?: Record<string, ShrinkwrapPackage>;
  version?: unknown;
};

function usage(): string {
  return "Usage: node scripts/check-openclaw-package-tarball.mjs [--require-bundled-workspace-deps] <openclaw.tgz>";
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function parseArgs(argv: string[]) {
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

let cliArgs: ReturnType<typeof parseArgs>;
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
] as const;
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
        specifier: "@openclaw/ai/transports",
        entry: "dist/transports.mjs",
        whenExported: "./transports",
      },
      {
        specifier: "@openclaw/ai/internal/runtime",
        entry: "dist/internal/runtime.mjs",
      },
    ],
  ],
]);

function collectWorkspaceProtocolDependencyErrors(packageJson: unknown, label: string): string[] {
  const errors: string[] = [];
  if (!packageJson || typeof packageJson !== "object") {
    return errors;
  }
  const packageRecord = packageJson as Record<string, unknown>;

  for (const section of PACKAGE_DEPENDENCY_SECTIONS) {
    const dependencies = packageRecord[section];
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

function listBundleDependencies(packageJson: unknown): string[] {
  if (!packageJson || typeof packageJson !== "object") {
    return [];
  }
  const packageRecord = packageJson as Record<string, unknown>;
  if (packageRecord.bundleDependencies === true) {
    return Object.keys((packageRecord.dependencies ?? {}) as object);
  }
  const bundleDependencies = Array.isArray(packageRecord.bundleDependencies)
    ? packageRecord.bundleDependencies
    : packageRecord.bundledDependencies;
  return Array.isArray(bundleDependencies)
    ? bundleDependencies.filter((name): name is string => typeof name === "string")
    : [];
}

function resolveBundledPackageSpecifiers(
  packageRoot: string,
  specifiers: string[],
): Record<string, string> | null {
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
    return JSON.parse(result.stdout) as Record<string, string>;
  } catch {
    return null;
  }
}

function collectBundledPackageRuntimeErrors({
  name,
  entries,
  files,
  packageRoot,
  readText,
}: {
  entries: ReadonlySet<string>;
  files: string[];
  name: string;
  packageRoot: string;
  readText: (relativePath: string) => string;
}): string[] {
  const errors: string[] = [];
  const packagePrefix = `node_modules/${name}/`;
  const manifestPath = `${packagePrefix}package.json`;
  let bundledPackageJson: Record<string, unknown>;
  try {
    bundledPackageJson = JSON.parse(readText(manifestPath)) as Record<string, unknown>;
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
  const packageExports =
    bundledPackageJson.exports &&
    typeof bundledPackageJson.exports === "object" &&
    !Array.isArray(bundledPackageJson.exports)
      ? (bundledPackageJson.exports as Record<string, unknown>)
      : {};
  // Trusted current-main harnesses validate frozen release targets. Require
  // post-cut runtime subpaths only when the candidate manifest owns them.
  const runtimeEntries = (REQUIRED_BUNDLED_WORKSPACE_RUNTIME_ENTRIES.get(name) ?? []).filter(
    ({ whenExported }) => !whenExported || Object.hasOwn(packageExports, whenExported),
  );
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
      readText: (file: string) => readText(`${packagePrefix}${file}`),
    }).map((error) => `bundled ${name} ${error}`),
  );
  return errors;
}

function collectRequiredBundledWorkspaceDependencyErrors(
  packageJson: unknown,
  entrySet: ReadonlySet<string>,
  files: string[],
  packageRoot: string,
  readText: (relativePath: string) => string,
): string[] {
  const errors: string[] = [];
  if (!packageJson || typeof packageJson !== "object") {
    return errors;
  }
  const packageRecord = packageJson as Record<string, unknown>;

  const dependencies = packageRecord.dependencies;
  if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
    return errors;
  }
  const dependencyRecord = dependencies as Record<string, unknown>;

  const bundledDependencies = new Set(listBundleDependencies(packageJson));
  for (const name of REQUIRED_BUNDLED_WORKSPACE_DEPENDENCIES) {
    if (typeof dependencyRecord[name] !== "string") {
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
// Self-contained artifacts can exceed Node's 1 MiB spawnSync output default.
const TAR_LIST_MAX_BUFFER_BYTES = 64 * 1024 * 1024;
function runPhase<Result>(label: string, action: () => Result): Result {
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
    maxBuffer: TAR_LIST_MAX_BUFFER_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  }),
);
if (list.status !== 0) {
  fail(`tar -tf failed for ${tarball}: ${list.stderr || list.error?.message || list.status}`);
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
const errors: string[] = [];
const warnings: string[] = [];
const CODE_MODE_WORKER_PATH = "dist/agents/code-mode.worker.js";
const FIRST_CODE_MODE_WORKER_VERSION = "2026.5.14-beta.2";
const REQUIRED_TARBALL_ENTRIES = ["dist/control-ui/index.html", ...WORKSPACE_TEMPLATE_PACK_PATHS];
const PACKAGE_INSTALL_GUARD_RELATIVE_PATH = "dist/openclaw-install-guard";
const REQUIRED_TARBALL_ENTRY_PREFIXES = ["dist/control-ui/assets/"];
const LEGACY_PACKAGE_ACCEPTANCE_COMPAT_MAX = { year: 2026, month: 4, day: 25 };
const LEGACY_LOCAL_BUILD_METADATA_COMPAT_MAX = { year: 2026, month: 4, day: 26 };
const LEGACY_SHRINKWRAP_OMISSION_COMPAT_MAX = { year: 2026, month: 5, day: 20 };
// 2026.7.2-beta.4 is the last published artifact known to ship shrinkwrap.
// The whole 2026.7.2 train is transitional; later trains must be lockless.
const NPM_SHRINKWRAP_TRANSITION_TRAIN = { year: 2026, month: 7, day: 2 };
// 2026.7.1 shipped before the guard existed. Historical inspection may still check it.
const LEGACY_INSTALL_GUARD_COMPAT_MAX = { year: 2026, month: 7, day: 1 };
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

function isLegacyOmittedPrivateQaInventoryEntry(relativePath: string): boolean {
  return (
    LEGACY_OMITTED_PRIVATE_QA_INVENTORY_FILES.has(relativePath) ||
    LEGACY_OMITTED_PRIVATE_QA_INVENTORY_PREFIXES.some((prefix) => relativePath.startsWith(prefix))
  );
}

function parseCalver(version: string): Calver | null {
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

function compareCalver(left: Calver, right: Calver): number {
  for (const key of ["year", "month", "day"] as const) {
    if (left[key] !== right[key]) {
      return left[key] - right[key];
    }
  }
  return 0;
}

function isLegacyPackageAcceptanceCompatVersion(version: string): boolean {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_PACKAGE_ACCEPTANCE_COMPAT_MAX) <= 0 : false;
}

function isLegacyLocalBuildMetadataCompatVersion(version: string): boolean {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_LOCAL_BUILD_METADATA_COMPAT_MAX) <= 0 : false;
}

function isLegacyInstallGuardCompatVersion(version: string): boolean {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_INSTALL_GUARD_COMPAT_MAX) <= 0 : false;
}

function isLegacyShrinkwrapOmissionCompatVersion(version: string): boolean {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, LEGACY_SHRINKWRAP_OMISSION_COMPAT_MAX) <= 0 : false;
}

function compareNpmShrinkwrapTransitionTrain(version: string): number | null {
  const parsed = parseCalver(version);
  return parsed ? compareCalver(parsed, NPM_SHRINKWRAP_TRANSITION_TRAIN) : null;
}

function readTarEntry(entryPath: string): string {
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
let packageJson: PackageManifest | null = null;
if (entrySet.has("package.json")) {
  try {
    packageJson = JSON.parse(readTarEntry("package.json")) as PackageManifest;
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
const validPackageVersion = validSemver(packageVersion);
const requiresCodeModeWorker =
  validPackageVersion !== null && semverGte(validPackageVersion, FIRST_CODE_MODE_WORKER_VERSION);
if (requiresCodeModeWorker && !entrySet.has(CODE_MODE_WORKER_PATH)) {
  errors.push(`missing required tar entry ${CODE_MODE_WORKER_PATH}`);
}
if (entrySet.has("package-lock.json")) {
  errors.push("package tarball must not contain package-lock.json");
}
const shrinkwrapTransitionComparison = compareNpmShrinkwrapTransitionTrain(packageVersion);
const hasShrinkwrap = entrySet.has("npm-shrinkwrap.json");
let shouldValidateShrinkwrap = false;
if (shrinkwrapTransitionComparison !== null && shrinkwrapTransitionComparison > 0) {
  if (hasShrinkwrap) {
    errors.push("package tarball must not contain npm-shrinkwrap.json");
  }
} else if (shrinkwrapTransitionComparison === 0) {
  if (hasShrinkwrap) {
    warnings.push(
      "2026.7.2 transition package contains npm-shrinkwrap.json from the published beta train",
    );
    shouldValidateShrinkwrap = true;
  }
} else if (!hasShrinkwrap) {
  if (isLegacyShrinkwrapOmissionCompatVersion(packageVersion)) {
    warnings.push("legacy package omits npm-shrinkwrap.json");
  } else {
    errors.push("legacy package is missing required tar entry npm-shrinkwrap.json");
  }
} else {
  shouldValidateShrinkwrap = true;
}
if (shouldValidateShrinkwrap) {
  try {
    const shrinkwrap = JSON.parse(readTarEntry("npm-shrinkwrap.json")) as ShrinkwrapManifest;
    const rootPackage = shrinkwrap.packages?.[""];
    if (shrinkwrap.name !== "openclaw") {
      errors.push("npm-shrinkwrap.json root name must be openclaw");
    }
    if (shrinkwrap.version !== packageVersion) {
      const shrinkwrapVersion =
        typeof shrinkwrap.version === "string" ? shrinkwrap.version : "<missing>";
      errors.push(
        `npm-shrinkwrap.json version ${shrinkwrapVersion} does not match package.json version ${packageVersion || "<missing>"}`,
      );
    }
    if (!rootPackage || rootPackage.name !== "openclaw") {
      errors.push("npm-shrinkwrap.json packages root must name openclaw");
    }
    if (rootPackage?.version !== packageVersion) {
      const rootPackageVersion =
        typeof rootPackage?.version === "string" ? rootPackage.version : "<missing>";
      errors.push(
        `npm-shrinkwrap.json packages root version ${rootPackageVersion} does not match package.json version ${packageVersion || "<missing>"}`,
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
if (!entrySet.has(PACKAGE_INSTALL_GUARD_RELATIVE_PATH)) {
  if (isLegacyInstallGuardCompatVersion(packageVersion)) {
    warnings.push("legacy package omits the preinstall completion guard");
  } else {
    errors.push(`missing required tar entry ${PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`);
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
let packageDistImports: ReturnType<typeof collectPackageDistImports> | null = null;
if (entrySet.has("dist/postinstall-inventory.json")) {
  try {
    const allowLegacyPrivateQaInventoryOmissions =
      isLegacyPackageAcceptanceCompatVersion(packageVersion);
    const inventory = JSON.parse(readTarEntry("dist/postinstall-inventory.json"));
    if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
      errors.push("invalid dist/postinstall-inventory.json");
    } else {
      const inventoryEntries = inventory as string[];
      const normalizedInventory = inventoryEntries.map((entry) => entry.replace(/\\/gu, "/"));
      const normalizedInventorySet = new Set(normalizedInventory);
      if (requiresCodeModeWorker && !normalizedInventorySet.has(CODE_MODE_WORKER_PATH)) {
        errors.push(`postinstall inventory omits ${CODE_MODE_WORKER_PATH}`);
      }
      if (normalizedInventorySet.has(PACKAGE_INSTALL_GUARD_RELATIVE_PATH)) {
        errors.push(
          `package dist inventory must omit install guard ${PACKAGE_INSTALL_GUARD_RELATIVE_PATH}`,
        );
      }
      if (typeof packageJson?.scripts?.postinstall === "string") {
        // Postinstall prunes every uninventoried dist file, including dashboard
        // assets that cannot be recovered from the JavaScript import graph.
        const requiredControlUiInventoryEntries = new Set([
          ...REQUIRED_TARBALL_ENTRIES.filter((entry) => entry.startsWith("dist/")),
          ...normalized.filter(
            (entry) =>
              REQUIRED_TARBALL_ENTRY_PREFIXES.some((prefix) => entry.startsWith(prefix)) &&
              fs.statSync(path.join(extractedPackageRoot, entry)).isFile(),
          ),
        ]);
        for (const requiredEntry of requiredControlUiInventoryEntries) {
          if (!normalizedInventorySet.has(requiredEntry)) {
            errors.push(`postinstall inventory omits Control UI file ${requiredEntry}`);
          }
        }
      }
      packageDistImports = runPhase("dist import graph", () =>
        collectPackageDistImports({
          files: normalized,
          readText: readTarEntry,
        }),
      );
      for (const inventoryEntry of inventoryEntries) {
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
