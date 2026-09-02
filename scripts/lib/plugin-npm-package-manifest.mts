// Augments plugin npm package manifests with generated runtime/package metadata.
import { spawnSync } from "node:child_process";
import type { SpawnSyncOptions } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import JSON5 from "json5";
import { parse as parseYaml } from "yaml";
import {
  generateNpmPackageLock,
  packageJsonForNpmLock,
  packageRuntimeDependencyField,
  readNpmLockOverrides,
  parsePnpmPackageKey,
  type NpmLocalPackageArtifact,
} from "../generate-npm-package-lock.mts";
import { resolveNpmRunner } from "../npm-runner.mts";
import type { NpmRunnerParams } from "../npm-runner.mts";
import {
  listPluginNpmRuntimeBuildOutputs,
  resolvePluginNpmRuntimeBuildPlan,
} from "./plugin-npm-runtime-build.mts";
import type { PluginNpmRuntimeBuildPlan, PluginPackageJson } from "./plugin-npm-runtime-build.mts";
import { pnpmLockfileDocuments } from "./pnpm-lockfile-documents.mjs";
import { isRecord } from "./record-shared.mjs";

const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA_PATH =
  "src/config/bundled-channel-config-metadata.generated.ts";

type JsonRecord = Record<string, unknown>;
type PluginPackageParams = Parameters<typeof resolvePluginNpmRuntimeBuildPlan>[0] & {
  bundleDependencies?: unknown;
  patchedDependencies?: WorkspacePatchedDependency[];
};
type GeneratedChannelConfig = {
  description?: string;
  label?: string;
  schema: JsonRecord;
  uiHints?: JsonRecord;
};
type GeneratedChannelConfigs = Record<string, GeneratedChannelConfig>;
type PluginPackageContext = Pick<
  PluginNpmRuntimeBuildPlan,
  "packageDir" | "packageJson" | "pluginDir"
> & { patchedDependencies?: WorkspacePatchedDependency[] };
type SpawnResult = Pick<ReturnType<typeof spawnSync>, "error" | "status">;
type PluginSpawnOptions = SpawnSyncOptions;
type PluginNpmCommandParams = Omit<NpmRunnerParams, "npmArgs">;
type PluginNpmCommand = {
  args: string[];
  command: string;
  env?: NodeJS.ProcessEnv;
  shell: boolean;
  windowsVerbatimArguments?: boolean;
};
type PackageLockOptions = NonNullable<Parameters<typeof generateNpmPackageLock>[1]>;
type GeneratePackageLock = (packageDir: string, options: PackageLockOptions) => string;

function readJsonFile(filePath: string): PluginPackageJson {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as PluginPackageJson;
}

function writeJsonFile(filePath: string, value: unknown) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function resolvePackageDir(repoRoot: string, packageDir: string) {
  return path.isAbsolute(packageDir) ? packageDir : path.resolve(repoRoot, packageDir);
}

function resolvePackageJsonPath(packageDir: string) {
  return path.join(packageDir, "package.json");
}

function packageRelativePathExists(packageDir: string, relativePath: string) {
  return fs.existsSync(path.join(packageDir, relativePath));
}

function normalizePackPath(value: string) {
  return value.trim().replaceAll("\\", "/").replace(/^\.\//u, "");
}

function escapeRegExp(value: string) {
  return value.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
}

function packFilePatternMatchesPath(pattern: string, relativePath: string) {
  const normalizedPattern = normalizePackPath(pattern).replace(/^!/u, "");
  const normalizedPath = normalizePackPath(relativePath);
  if (!normalizedPattern || !normalizedPath) {
    return false;
  }
  if (normalizedPattern === normalizedPath) {
    return true;
  }

  let source = "";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const char = normalizedPattern[index];
    const next = normalizedPattern[index + 1];
    const afterNext = normalizedPattern[index + 2];
    if (char === "*" && next === "*" && afterNext === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (char === "*") {
      source += "[^/]*";
      continue;
    }
    source += escapeRegExp(char ?? "");
  }
  return new RegExp(`^${source}$`, "u").test(normalizedPath);
}

function assertPackageFilesDoNotExcludeRequiredRuntimeArtifacts(plan: PluginNpmRuntimeBuildPlan) {
  const fileRules = Array.isArray(plan.packageJson.files)
    ? plan.packageJson.files.filter((entry) => typeof entry === "string")
    : [];
  const exclusions = fileRules.filter((entry) => normalizePackPath(entry).startsWith("!"));
  if (exclusions.length === 0) {
    return;
  }

  for (const requiredPath of listPluginNpmRuntimeBuildOutputs(plan)) {
    for (const exclusion of exclusions) {
      if (packFilePatternMatchesPath(exclusion, requiredPath)) {
        throw new Error(
          `package file rule '${exclusion}' excludes required package-local runtime file '${requiredPath}' for ${plan.pluginDir}. Remove the negation or publish would advertise a missing runtime entry.`,
        );
      }
    }
  }
}

function assertPluginNpmRuntimeBuildExists(plan: PluginNpmRuntimeBuildPlan) {
  const missing = listPluginNpmRuntimeBuildOutputs(plan).filter(
    (runtimePath) => !packageRelativePathExists(plan.packageDir, runtimePath.replace(/^\.\//u, "")),
  );
  if (missing.length > 0) {
    const packageName =
      typeof plan.packageJson.name === "string" ? plan.packageJson.name : plan.pluginDir;
    throw new Error(
      [
        `package-local plugin runtime is missing for ${plan.pluginDir}: ${missing.join(", ")}`,
        `Run node scripts/lib/plugin-npm-runtime-build.mjs ${path.relative(plan.repoRoot, plan.packageDir) || plan.packageDir} before publishing ${packageName}.`,
      ].join("\n"),
    );
  }
  assertPackageFilesDoNotExcludeRequiredRuntimeArtifacts(plan);
}

function resolvePackagedChannelStateMetadata(
  metadata: unknown,
  metadataKey: string,
  plan: PluginNpmRuntimeBuildPlan,
) {
  if (
    !metadata ||
    !isRecord(metadata) ||
    typeof metadata.specifier !== "string" ||
    !metadata.specifier.trim()
  ) {
    return metadata;
  }

  const normalizedSpecifier = normalizePackPath(metadata.specifier);
  const sourceEntry = normalizedSpecifier.replace(/\.(?:[cm]?[jt]s)$/u, "");
  const runtimeSpecifier = plan.runtimeBuildOutputs.find((runtimePath) => {
    const normalizedRuntimePath = normalizePackPath(runtimePath);
    return (
      normalizedRuntimePath === normalizedSpecifier ||
      normalizedRuntimePath.replace(/^dist\//u, "").replace(/\.(?:[cm]?js)$/u, "") === sourceEntry
    );
  });
  if (!runtimeSpecifier) {
    throw new Error(
      `channel ${metadataKey} specifier '${metadata.specifier}' has no package-local runtime output for ${plan.pluginDir}`,
    );
  }

  // Published plugins omit source files; installed channel probes must load
  // the exact ESM or CommonJS sidecar emitted by the package runtime build.
  return {
    ...metadata,
    specifier: runtimeSpecifier,
  };
}

function resolvePackagedChannelMetadata(plan: PluginNpmRuntimeBuildPlan) {
  const channel = plan.packageJson.openclaw?.channel;
  if (!isRecord(channel)) {
    return channel;
  }

  const packagedChannel: JsonRecord = { ...channel };
  for (const metadataKey of ["configuredState", "persistedAuthState"]) {
    if (Object.hasOwn(channel, metadataKey)) {
      packagedChannel[metadataKey] = resolvePackagedChannelStateMetadata(
        channel[metadataKey],
        metadataKey,
        plan,
      );
    }
  }
  return packagedChannel;
}

function hasPackageRuntimeDependencies(packageJson: PluginPackageJson) {
  return (
    Object.keys(packageJson.dependencies ?? {}).length > 0 ||
    Object.keys(packageJson.optionalDependencies ?? {}).length > 0
  );
}

function listPackageRuntimeDependencyNames(packageJson: PluginPackageJson) {
  return [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
  ].toSorted((left, right) => left.localeCompare(right));
}

function listConfiguredBundledDependencyNames(packageJson: PluginPackageJson) {
  const configured = packageJson.bundleDependencies ?? packageJson.bundledDependencies;
  if (Array.isArray(configured)) {
    return configured.filter((name) => typeof name === "string");
  }
  if (configured === true) {
    return listPackageRuntimeDependencyNames(packageJson);
  }
  return [];
}

/**
 * Resolve an npm command invocation for plugin package scripts.
 * @internal Directly tested script implementation detail.
 */
export function resolvePluginNpmCommand(
  args: string[],
  params: PluginNpmCommandParams = {},
): PluginNpmCommand {
  return resolveNpmRunner({
    comSpec: params.comSpec,
    env: params.env,
    execPath: params.execPath,
    existsSync: params.existsSync,
    npmArgs: args,
    platform: params.platform,
  });
}

function spawnNpmSync(args: string[], options: SpawnSyncOptions = {}) {
  const invocation = resolvePluginNpmCommand(args, { env: options.env ?? process.env });
  return spawnSync(invocation.command, invocation.args, {
    ...options,
    ...(invocation.env ? { env: invocation.env } : {}),
    ...(invocation.shell !== undefined ? { shell: invocation.shell } : {}),
    ...(invocation.windowsVerbatimArguments !== undefined
      ? { windowsVerbatimArguments: invocation.windowsVerbatimArguments }
      : {}),
  });
}

function spawnCommandSync(command: string, args: string[], options: SpawnSyncOptions): SpawnResult {
  if (command === "npm") {
    return spawnNpmSync(args, options);
  }
  return spawnSync(command, args, options);
}

/** @internal Directly tested release-script implementation detail. */
export function runPluginNpmCiWithRetry(
  args: string[],
  options: PluginSpawnOptions,
  params: {
    attempts?: number;
    timeoutMs?: number;
    spawn?: (args: string[], options: PluginSpawnOptions) => SpawnResult | undefined;
    cleanupAttempt?: () => void;
    pluginDir?: string;
  } = {},
) {
  const attempts = params.attempts ?? 3;
  const timeoutMs = params.timeoutMs ?? 180_000;
  const spawn = params.spawn ?? spawnNpmSync;
  const cleanupAttempt = params.cleanupAttempt ?? (() => {});
  const pluginDir = params.pluginDir ?? "plugin";

  let result: SpawnResult | undefined;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result = spawn(args, { ...options, timeout: timeoutMs });
    if (!result) {
      throw new Error(`npm ci returned no result for ${pluginDir}`);
    }
    if (!isRecord(result.error) || result.error.code !== "ETIMEDOUT") {
      return result;
    }

    // A timed-out npm process can leave a partial tree that makes the next
    // package attempt nondeterministic. Restore the staging invariant even
    // when the retry budget is exhausted.
    cleanupAttempt();
    if (attempt === attempts) {
      return result;
    }
    console.error(
      `[plugin-npm-publish] bundled dependency install timed out for ${pluginDir} ` +
        `(attempt ${attempt}/${attempts}); retrying`,
    );
  }
  throw new Error(`npm ci retry loop exhausted for ${pluginDir}`);
}

/** @internal Directly tested release-script implementation detail. */
export function generatePluginNpmPackageLockWithRetry(
  packageDir: string,
  options: PackageLockOptions = {},
  params: {
    attempts?: number;
    timeoutMs?: number;
    generate?: GeneratePackageLock;
    pluginDir?: string;
  } = {},
) {
  const attempts = params.attempts ?? 3;
  const timeoutMs = params.timeoutMs ?? 180_000;
  const generate = params.generate ?? generateNpmPackageLock;
  const pluginDir = params.pluginDir ?? "plugin";
  const env = {
    ...(options.env ?? process.env),
    OPENCLAW_NPM_LOCK_COMMAND_TIMEOUT_MS: String(timeoutMs),
  };

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return generate(packageDir, { ...options, env });
    } catch (error) {
      if (!isRecord(error) || error.code !== "ETIMEDOUT" || attempt === attempts) {
        throw error;
      }
      console.error(
        `[plugin-npm-publish] package-lock generation timed out for ${pluginDir} ` +
          `(attempt ${attempt}/${attempts}); retrying`,
      );
    }
  }
  throw new Error(`package-lock generation retry loop exhausted for ${pluginDir}`);
}

function resolveInstalledPackageDir(packageDir: string, packageName: string) {
  return path.join(packageDir, "node_modules", ...packageName.split("/"));
}

function readInstalledPackageJson(packageDir: string, packageName: string) {
  const packageJsonPath = path.join(
    resolveInstalledPackageDir(packageDir, packageName),
    "package.json",
  );
  if (!fs.existsSync(packageJsonPath)) {
    return undefined;
  }
  try {
    return {
      packageDir: path.dirname(packageJsonPath),
      packageJson: readJsonFile(packageJsonPath),
    };
  } catch {
    return undefined;
  }
}

function hasInstalledPackage(packageDir: string, packageName: string) {
  return fs.existsSync(
    path.join(resolveInstalledPackageDir(packageDir, packageName), "package.json"),
  );
}

function normalizeOptionalDependencySpec(
  packageDir: string,
  dependencyPackageDir: string,
  spec: unknown,
): string | undefined {
  if (typeof spec !== "string" || !spec.trim()) {
    return undefined;
  }
  const trimmed = spec.trim();
  if (!trimmed.startsWith("file:")) {
    return trimmed;
  }
  const fileTarget = trimmed.slice("file:".length);
  if (!fileTarget || path.isAbsolute(fileTarget)) {
    return trimmed;
  }
  const absoluteTarget = path.resolve(dependencyPackageDir, fileTarget);
  const packageRelativeTarget = path.relative(packageDir, absoluteTarget).replaceAll(path.sep, "/");
  return `file:${packageRelativeTarget.startsWith(".") ? packageRelativeTarget : `./${packageRelativeTarget}`}`;
}

function collectMissingOptionalBundledDependencySpecs(
  packageDir: string,
  packageJson: PluginPackageJson,
) {
  const queue = listConfiguredBundledDependencyNames(packageJson);
  const visited = new Set<string>();
  const missing = new Map<string, string>();

  while (queue.length > 0) {
    const packageName = queue.shift();
    if (!packageName || visited.has(packageName)) {
      continue;
    }
    visited.add(packageName);

    const installed = readInstalledPackageJson(packageDir, packageName);
    if (!installed) {
      continue;
    }
    const dependencyNames = [
      ...Object.keys(installed.packageJson.dependencies ?? {}),
      ...Object.keys(installed.packageJson.optionalDependencies ?? {}),
    ].toSorted((left, right) => left.localeCompare(right));
    queue.push(...dependencyNames);

    for (const [optionalName, optionalSpec] of Object.entries(
      installed.packageJson.optionalDependencies ?? {},
    ).toSorted(([left], [right]) => left.localeCompare(right))) {
      if (hasInstalledPackage(packageDir, optionalName)) {
        continue;
      }
      const normalizedSpec = normalizeOptionalDependencySpec(
        packageDir,
        installed.packageDir,
        optionalSpec,
      );
      if (normalizedSpec) {
        missing.set(optionalName, normalizedSpec);
      }
    }
  }

  return [...missing.entries()].map(([name, spec]) => `${name}@${spec}`);
}

function installMissingOptionalBundledDependencies(params: PluginPackageContext) {
  const portableOptionalInstallSpecs = new Map<string, string>();
  for (let pass = 0; pass < 3; pass += 1) {
    const installSpecs = collectMissingOptionalBundledDependencySpecs(
      params.packageDir,
      params.packageJson,
    );
    if (installSpecs.length === 0) {
      return;
    }
    for (const installSpec of installSpecs) {
      const at = installSpec.indexOf("@", installSpec.startsWith("@") ? 1 : 0);
      const packageName = at > 0 ? installSpec.slice(0, at) : installSpec;
      portableOptionalInstallSpecs.set(packageName, installSpec);
    }
    const cumulativeInstallSpecs = [...portableOptionalInstallSpecs.values()].toSorted(
      (left, right) => left.localeCompare(right),
    );
    console.error(
      `[plugin-npm-publish] installing portable optional bundled dependencies for ${params.pluginDir}: ${cumulativeInstallSpecs.join(", ")}`,
    );
    const result = spawnNpmSync(
      [
        "install",
        "--force",
        "--omit=dev",
        "--omit=peer",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        "--save=false",
        "--loglevel=error",
        ...cumulativeInstallSpecs,
      ],
      {
        cwd: params.packageDir,
        env: process.env,
        stdio: ["ignore", "ignore", "inherit"],
      },
    );
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(
        `package-local portable optional dependency install failed for ${params.pluginDir} with exit ${result.status ?? 1}`,
      );
    }
  }
  const remainingSpecs = collectMissingOptionalBundledDependencySpecs(
    params.packageDir,
    params.packageJson,
  );
  if (remainingSpecs.length > 0) {
    throw new Error(
      `package-local portable optional dependency install did not settle for ${params.pluginDir}: ${remainingSpecs.join(", ")}`,
    );
  }
}

type WorkspacePatchedDependency = { name: string; version: string; packageDir: string };

function readYamlRecord(file: string, lockfile = false) {
  const source = fs.readFileSync(file, "utf8");
  const value: unknown = parseYaml(lockfile ? pnpmLockfileDocuments(source).dependencies : source);
  return isRecord(value) ? value : {};
}

function collectWorkspacePatchedDependencies(
  repoRoot: string,
  packageDir: string,
  packageJson: PluginPackageJson,
) {
  const workspacePath = path.join(repoRoot, "pnpm-workspace.yaml");
  if (!fs.existsSync(workspacePath)) {
    return [];
  }
  const declared = readYamlRecord(workspacePath).patchedDependencies;
  if (!isRecord(declared)) {
    return [];
  }
  const names = new Set(listPackageRuntimeDependencyNames(packageJson));
  // check-package-patches owns the allowlist and permits only exact-version selectors.
  let selected = Object.entries(declared).flatMap(([selector, patchPath]) => {
    const parsed = parsePnpmPackageKey(selector);
    return parsed && names.has(parsed.name) ? [{ ...parsed, selector, patchPath }] : [];
  });
  if (selected.length === 0) {
    return [];
  }
  const lock = readYamlRecord(path.join(repoRoot, "pnpm-lock.yaml"), true);
  const importerKey = path.relative(repoRoot, packageDir).replaceAll(path.sep, "/");
  const importer = isRecord(lock.importers) ? lock.importers[importerKey] : undefined;
  selected = selected.filter(({ name, version }) => {
    const field = packageRuntimeDependencyField(packageJson, name);
    const resolved =
      isRecord(importer) && isRecord(importer[field]) ? importer[field][name] : undefined;
    if (
      !isRecord(resolved) ||
      typeof resolved.version !== "string" ||
      resolved.specifier !== packageJson[field]?.[name]
    ) {
      throw new Error(
        `patched runtime dependency is missing from the frozen pnpm importer: ${name}`,
      );
    }
    return resolved.version.split("(")[0] === version;
  });
  if (selected.length === 0) {
    return [];
  }
  const modules = readYamlRecord(path.join(repoRoot, "node_modules", ".modules.yaml"));
  const virtualStoreDir = modules.virtualStoreDir ?? ".pnpm";
  if (typeof virtualStoreDir !== "string") {
    throw new Error("frozen pnpm install has an invalid virtualStoreDir");
  }
  const installedLock = readYamlRecord(
    path.resolve(repoRoot, "node_modules", virtualStoreDir, "lock.yaml"),
    true,
  );
  const installedImporter = isRecord(installedLock.importers)
    ? installedLock.importers[importerKey]
    : undefined;
  const require = createRequire(path.join(packageDir, "package.json"));
  // A root declaration alone does not prove the installed bytes were patched.
  // Bind the patch hash, importer and actual hoisted package before packing it.
  return selected.map(({ name, version, selector, patchPath }) => {
    const patchHash =
      typeof patchPath === "string"
        ? createHash("sha256")
            .update(fs.readFileSync(path.resolve(repoRoot, patchPath)))
            .digest("hex")
        : "";
    const field = packageRuntimeDependencyField(packageJson, name);
    const resolved =
      isRecord(importer) && isRecord(importer[field]) ? importer[field][name] : undefined;
    const installed =
      isRecord(installedImporter) && isRecord(installedImporter[field])
        ? installedImporter[field][name]
        : undefined;
    if (
      !patchHash ||
      !isRecord(lock.patchedDependencies) ||
      lock.patchedDependencies[selector] !== patchHash ||
      !isRecord(installedLock.patchedDependencies) ||
      installedLock.patchedDependencies[selector] !== patchHash ||
      !isRecord(resolved) ||
      typeof resolved.version !== "string" ||
      !resolved.version.startsWith(`${version}(`) ||
      !resolved.version.includes(`(patch_hash=${patchHash})`) ||
      !isRecord(installed) ||
      installed.version !== resolved.version ||
      installed.specifier !== resolved.specifier
    ) {
      throw new Error(
        `patched runtime dependency requires a matching frozen pnpm install: ${selector}`,
      );
    }
    const candidate = require.resolve
      .paths(name)
      ?.map((dir) => path.join(dir, name))
      .find((dir) => fs.existsSync(path.join(dir, "package.json")));
    const locations = isRecord(modules.hoistedLocations)
      ? modules.hoistedLocations[`${name}@${resolved.version}`]
      : undefined;
    if (
      !candidate ||
      modules.nodeLinker !== "hoisted" ||
      !Array.isArray(locations) ||
      !locations.some(
        (location) =>
          typeof location === "string" &&
          fs.realpathSync(path.resolve(repoRoot, location)) === fs.realpathSync(candidate),
      )
    ) {
      throw new Error(`patched runtime dependency is not the frozen pnpm package: ${selector}`);
    }
    const installedPackage = readJsonFile(path.join(candidate, "package.json"));
    if (installedPackage.name !== name || installedPackage.version !== version) {
      throw new Error(`patched runtime dependency identity mismatch: ${selector}`);
    }
    return { name, version, packageDir: fs.realpathSync(candidate) };
  });
}

function packPatchedDependencies(packageDir: string, dependencies: WorkspacePatchedDependency[]) {
  if (dependencies.length === 0) {
    return { artifacts: [], cleanup: () => {} };
  }
  const outputDir = fs.mkdtempSync(path.join(packageDir, ".openclaw-patched-dependencies-"));
  const cleanup = () => fs.rmSync(outputDir, { recursive: true, force: true });
  try {
    const artifacts: NpmLocalPackageArtifact[] = dependencies.map(
      ({ name, version, packageDir: source }) => {
        const result = spawnNpmSync(
          [
            "pack",
            source,
            "--json",
            "--ignore-scripts",
            "--workspaces=false",
            "--pack-destination",
            outputDir,
          ],
          {
            cwd: packageDir,
            env: process.env,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "inherit"],
          },
        );
        if (result.error) {
          throw result.error;
        }
        if (result.status !== 0) {
          throw new Error(`packing patched runtime dependency failed: ${name}@${version}`);
        }
        const output = JSON.parse(String(result.stdout));
        const entries = Array.isArray(output) ? output : Object.values(output);
        const packed = entries.length === 1 ? entries[0] : undefined;
        if (
          !packed ||
          packed.name !== name ||
          packed.version !== version ||
          typeof packed.filename !== "string" ||
          path.basename(packed.filename) !== packed.filename
        ) {
          throw new Error(`packed runtime dependency identity mismatch: ${name}@${version}`);
        }
        const tarball = path.join(outputDir, packed.filename);
        const integrity = `sha512-${createHash("sha512").update(fs.readFileSync(tarball)).digest("base64")}`;
        if (packed.integrity !== integrity) {
          throw new Error(`packed runtime dependency integrity mismatch: ${name}@${version}`);
        }
        return {
          name,
          version,
          spec: `file:./${path.relative(packageDir, tarball).replaceAll(path.sep, "/")}`,
          integrity,
        };
      },
    );
    return { artifacts, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function packageOptsOutOfBundledRuntimeDependencies(packageJson: PluginPackageJson | undefined) {
  return packageJson?.openclaw?.release?.bundleRuntimeDependencies === false;
}

function shouldBundleDependencies(
  value: unknown,
  packageJson: PluginPackageJson | undefined,
  patchedDependencies: WorkspacePatchedDependency[] = [],
) {
  if (packageOptsOutOfBundledRuntimeDependencies(packageJson)) {
    if (patchedDependencies.length > 0) {
      throw new Error("patched runtime dependencies conflict with bundleRuntimeDependencies=false");
    }
    return false;
  }
  return patchedDependencies.length > 0 || value === true || value === "1" || value === "true";
}

function installPackageLocalBundledDependencies(params: PluginPackageContext) {
  const packageJson = params.packageJson;
  if (
    !hasPackageRuntimeDependencies(packageJson) ||
    listConfiguredBundledDependencyNames(packageJson).length === 0
  ) {
    return;
  }

  const packageLockPath = path.join(params.packageDir, "package-lock.json");
  if (fs.existsSync(packageLockPath)) {
    throw new Error(
      `package-local bundled dependency install refuses to replace existing package-lock.json for ${params.pluginDir}`,
    );
  }

  const nodeModulesPath = path.join(params.packageDir, "node_modules");
  if (fs.existsSync(nodeModulesPath)) {
    throw new Error(
      `package-local bundled dependency install refuses to replace existing node_modules for ${params.pluginDir}`,
    );
  }

  console.error(`[plugin-npm-publish] installing bundled dependencies for ${params.pluginDir}`);
  const packageJsonPath = resolvePackageJsonPath(params.packageDir);
  const packedPackageJsonText = fs.readFileSync(packageJsonPath, "utf8");
  const installPackageJsonBase = {
    ...params.packageJson,
  };
  delete installPackageJsonBase.peerDependencies;
  delete installPackageJsonBase.peerDependenciesMeta;
  const patched = packPatchedDependencies(params.packageDir, params.patchedDependencies ?? []);
  const installPackageJson = packageJsonForNpmLock(
    installPackageJsonBase,
    readNpmLockOverrides(),
    patched.artifacts,
  );
  const installPackageJsonText = `${JSON.stringify(installPackageJson, null, 2)}\n`;
  if (installPackageJsonText !== packedPackageJsonText) {
    // npm validates peer edges against the package lock during ci even when peers are omitted.
    // The peer metadata belongs in the packed plugin, not in this temporary dependency install.
    fs.writeFileSync(packageJsonPath, installPackageJsonText, "utf8");
  }
  try {
    fs.writeFileSync(
      packageLockPath,
      generatePluginNpmPackageLockWithRetry(
        params.packageDir,
        { installStrategy: "shallow", localPackageArtifacts: patched.artifacts },
        { pluginDir: params.pluginDir },
      ),
      "utf8",
    );
    const result = runPluginNpmCiWithRetry(
      [
        "ci",
        "--install-strategy=shallow",
        "--omit=dev",
        "--omit=peer",
        "--legacy-peer-deps",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--workspaces=false",
        "--loglevel=error",
      ],
      {
        cwd: params.packageDir,
        env: process.env,
        stdio: ["ignore", "ignore", "inherit"],
      },
      {
        cleanupAttempt: () => fs.rmSync(nodeModulesPath, { recursive: true, force: true }),
        pluginDir: params.pluginDir,
      },
    );
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      throw new Error(
        `package-local bundled dependency install failed for ${params.pluginDir} with exit ${result.status ?? 1}`,
      );
    }
    installMissingOptionalBundledDependencies(params);
    for (const { name, version } of params.patchedDependencies ?? []) {
      const installed = readInstalledPackageJson(params.packageDir, name)?.packageJson;
      if (installed?.name !== name || installed.version !== version) {
        throw new Error(`patched runtime dependency was not installed: ${name}@${version}`);
      }
    }
  } finally {
    fs.writeFileSync(packageJsonPath, packedPackageJsonText, "utf8");
    fs.rmSync(packageLockPath, { force: true });
    patched.cleanup();
  }
}

/**
 * Build the package.json that should be used while packaging a plugin for npm.
 * @internal Directly tested script implementation detail.
 */
export function resolveAugmentedPluginNpmPackageJson(params: PluginPackageParams) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDir = resolvePackageDir(repoRoot, params.packageDir);
  const packageJsonPath = resolvePackageJsonPath(packageDir);
  if (!fs.existsSync(packageJsonPath)) {
    return {
      packageJsonPath,
      packageDir,
      repoRoot,
      changed: false,
      packageJson: undefined,
      reason: "missing-package-json",
    };
  }

  const plan = resolvePluginNpmRuntimeBuildPlan({ repoRoot, packageDir });
  if (!plan) {
    return {
      packageJsonPath,
      packageDir,
      repoRoot,
      changed: false,
      packageJson: undefined,
      reason: "no-runtime-build",
    };
  }
  assertPluginNpmRuntimeBuildExists(plan);

  const packagedChannel = resolvePackagedChannelMetadata(plan);
  const packageJson: PluginPackageJson = {
    ...plan.packageJson,
    files: plan.packageFiles,
    peerDependencies: plan.packagePeerMetadata.peerDependencies,
    peerDependenciesMeta: plan.packagePeerMetadata.peerDependenciesMeta,
    openclaw: {
      ...plan.packageJson.openclaw,
      ...(packagedChannel ? { channel: packagedChannel } : {}),
      runtimeExtensions: plan.runtimeExtensions,
      ...(plan.runtimeSetupEntry
        ? {
            setupEntry: plan.runtimeSetupEntry,
            runtimeSetupEntry: plan.runtimeSetupEntry,
          }
        : {}),
    },
  };
  if (
    shouldBundleDependencies(
      params.bundleDependencies,
      plan.packageJson,
      params.patchedDependencies,
    )
  ) {
    packageJson.bundledDependencies = [
      ...new Set([
        ...listConfiguredBundledDependencyNames(packageJson),
        ...(shouldBundleDependencies(params.bundleDependencies, plan.packageJson)
          ? listPackageRuntimeDependencyNames(packageJson)
          : (params.patchedDependencies ?? []).map(({ name }) => name)),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
    delete packageJson.bundleDependencies;
    delete packageJson.devDependencies;
  }
  const changed = JSON.stringify(packageJson) !== JSON.stringify(plan.packageJson);
  return {
    packageJsonPath,
    packageDir,
    repoRoot,
    changed,
    packageJson,
    pluginDir: plan.pluginDir,
    bundleDependencies: shouldBundleDependencies(
      params.bundleDependencies,
      plan.packageJson,
      params.patchedDependencies,
    ),
    reason: changed ? "package-local-runtime" : "unchanged",
  };
}

/** Read generated bundled channel config metadata keyed by plugin id. */
export function readGeneratedBundledChannelConfigs(repoRoot: string) {
  const metadataPath = path.join(repoRoot, GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA_PATH);
  if (!fs.existsSync(metadataPath)) {
    return new Map<string, GeneratedChannelConfigs>();
  }
  const source = fs.readFileSync(metadataPath, "utf8");
  const entries = readGeneratedBundledChannelConfigEntries(source);
  if (!Array.isArray(entries)) {
    return new Map<string, GeneratedChannelConfigs>();
  }

  const byPlugin = new Map<string, GeneratedChannelConfigs>();
  for (const entry of entries) {
    if (
      !isRecord(entry) ||
      typeof entry.pluginId !== "string" ||
      typeof entry.channelId !== "string" ||
      !isRecord(entry.schema)
    ) {
      continue;
    }
    const pluginConfigs = byPlugin.get(entry.pluginId) ?? {};
    pluginConfigs[entry.channelId] = {
      schema: entry.schema,
      ...(typeof entry.label === "string" && entry.label ? { label: entry.label } : {}),
      ...(typeof entry.description === "string" && entry.description
        ? { description: entry.description }
        : {}),
      ...(isRecord(entry.uiHints) ? { uiHints: entry.uiHints } : {}),
    };
    byPlugin.set(entry.pluginId, pluginConfigs);
  }
  return byPlugin;
}

function readGeneratedBundledChannelConfigEntries(source: string): unknown {
  const legacyMatch = source.match(
    /export const GENERATED_BUNDLED_CHANNEL_CONFIG_METADATA = ([\s\S]*?) as const;/u,
  );
  if (legacyMatch?.[1]) {
    try {
      return JSON5.parse(legacyMatch[1]);
    } catch {
      return undefined;
    }
  }

  const compactMatch = source.match(
    /const RAW_BUNDLED_CHANNEL_CONFIG_METADATA = \[([\s\S]*?)\]\.join\(""\);/u,
  );
  if (!compactMatch?.[1]) {
    return undefined;
  }
  try {
    const chunks = JSON5.parse(`[${compactMatch[1]}]`);
    if (!Array.isArray(chunks) || chunks.some((chunk) => typeof chunk !== "string")) {
      return undefined;
    }
    return JSON.parse(chunks.join(""));
  } catch {
    return undefined;
  }
}

/** Merge generated channel config schemas into a plugin manifest without clobbering labels. */
export function mergeGeneratedChannelConfigs(
  manifest: JsonRecord,
  generatedChannelConfigs: GeneratedChannelConfigs | undefined,
) {
  if (!generatedChannelConfigs || Object.keys(generatedChannelConfigs).length === 0) {
    return manifest;
  }
  const existingChannelConfigs = isRecord(manifest.channelConfigs) ? manifest.channelConfigs : {};
  const channelConfigs: JsonRecord = { ...existingChannelConfigs };
  for (const [channelId, generated] of Object.entries(generatedChannelConfigs)) {
    const existing = isRecord(existingChannelConfigs[channelId])
      ? existingChannelConfigs[channelId]
      : {};
    const existingUiHints = isRecord(existing.uiHints) ? existing.uiHints : {};
    channelConfigs[channelId] = {
      ...generated,
      ...existing,
      schema: generated.schema,
      ...(generated.uiHints || Object.keys(existingUiHints).length > 0
        ? { uiHints: { ...generated.uiHints, ...existingUiHints } }
        : {}),
      ...(existing.label || generated.label ? { label: existing.label ?? generated.label } : {}),
      ...(existing.description || generated.description
        ? { description: existing.description ?? generated.description }
        : {}),
    };
  }
  return {
    ...manifest,
    channelConfigs,
  };
}

/**
 * Build the plugin manifest that should be used while packaging a plugin for npm.
 * @internal Directly tested script implementation detail.
 */
export function resolveAugmentedPluginNpmManifest(params: PluginPackageParams) {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDir = resolvePackageDir(repoRoot, params.packageDir);
  const manifestPath = path.join(packageDir, "openclaw.plugin.json");
  if (!fs.existsSync(manifestPath)) {
    return {
      manifestPath,
      pluginId: path.basename(packageDir),
      changed: false,
      manifest: undefined,
      reason: "missing-manifest",
    };
  }

  const manifest = readJsonFile(manifestPath);
  const pluginId =
    typeof manifest.id === "string" && manifest.id ? manifest.id : path.basename(packageDir);
  const generatedChannelConfigs = readGeneratedBundledChannelConfigs(repoRoot).get(pluginId);
  const augmentedManifest = mergeGeneratedChannelConfigs(manifest, generatedChannelConfigs);
  const changed = JSON.stringify(augmentedManifest) !== JSON.stringify(manifest);
  return {
    manifestPath,
    pluginId,
    changed,
    manifest: augmentedManifest,
    reason: changed ? "generated-channel-configs" : "unchanged",
  };
}

/**
 * Temporarily write augmented manifest/package metadata while a packaging callback runs.
 * @internal Directly tested script implementation detail.
 */
type ManifestOverlayContext = ReturnType<typeof resolveAugmentedPluginNpmManifest> & {
  applied: boolean;
  packageDir: string;
  packageJsonApplied: boolean;
  repoRoot: string;
};

export function withAugmentedPluginNpmManifestForPackage<T>(
  params: PluginPackageParams,
  callback: (context: ManifestOverlayContext) => T,
): T {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDir = resolvePackageDir(repoRoot, params.packageDir);
  const packageJsonPath = resolvePackageJsonPath(packageDir);
  const packageJson = fs.existsSync(packageJsonPath) ? readJsonFile(packageJsonPath) : undefined;
  const patchedDependencies = packageJson
    ? collectWorkspacePatchedDependencies(repoRoot, packageDir, packageJson)
    : [];
  const resolvedParams = { ...params, patchedDependencies };
  if (
    !packageJson ||
    !shouldBundleDependencies(params.bundleDependencies, packageJson, patchedDependencies) ||
    !hasPackageRuntimeDependencies(packageJson)
  ) {
    return withPluginNpmManifestOverlay(resolvedParams, callback);
  }

  // pnpm owns the source install. npm bundling needs a separate tree so its
  // production-only install and cleanup cannot replace source versions or links.
  const stagingRoot = fs.mkdtempSync(path.join(tmpdir(), "openclaw-plugin-npm-pack-"));
  const stagedPackageDir = path.join(stagingRoot, path.basename(packageDir));
  try {
    fs.cpSync(packageDir, stagedPackageDir, {
      recursive: true,
      filter: (source) => path.basename(source) !== "node_modules",
    });
    return withPluginNpmManifestOverlay(
      { ...resolvedParams, repoRoot, packageDir: stagedPackageDir },
      callback,
    );
  } finally {
    fs.rmSync(stagingRoot, { recursive: true, force: true });
  }
}

function withPluginNpmManifestOverlay<T>(
  params: PluginPackageParams,
  callback: (context: ManifestOverlayContext) => T,
): T {
  const repoRoot = path.resolve(params.repoRoot ?? ".");
  const packageDir = resolvePackageDir(repoRoot, params.packageDir);
  const packageJsonPath = resolvePackageJsonPath(packageDir);
  const packageJsonForBundlePolicy = fs.existsSync(packageJsonPath)
    ? readJsonFile(packageJsonPath)
    : undefined;
  const bundleDependencies = shouldBundleDependencies(
    params.bundleDependencies,
    packageJsonForBundlePolicy,
    params.patchedDependencies,
  );
  const resolvedManifest = resolveAugmentedPluginNpmManifest({
    repoRoot,
    packageDir,
  });
  const resolvedPackageJson = resolveAugmentedPluginNpmPackageJson({
    repoRoot,
    packageDir,
    bundleDependencies: params.bundleDependencies,
    patchedDependencies: params.patchedDependencies,
  });

  const originalManifest =
    resolvedManifest.changed && resolvedManifest.manifest
      ? fs.readFileSync(resolvedManifest.manifestPath, "utf8")
      : undefined;
  const originalPackageJson =
    resolvedPackageJson.changed && resolvedPackageJson.packageJson
      ? fs.readFileSync(resolvedPackageJson.packageJsonPath, "utf8")
      : undefined;
  if (resolvedManifest.changed && resolvedManifest.manifest) {
    console.error(
      `[plugin-npm-publish] overlaying generated channel config metadata for ${resolvedManifest.pluginId}`,
    );
    writeJsonFile(resolvedManifest.manifestPath, resolvedManifest.manifest);
  }
  if (resolvedPackageJson.changed && resolvedPackageJson.packageJson) {
    console.error(
      `[plugin-npm-publish] overlaying package-local runtime metadata for ${resolvedPackageJson.pluginDir}`,
    );
    writeJsonFile(resolvedPackageJson.packageJsonPath, resolvedPackageJson.packageJson);
  }
  try {
    if (bundleDependencies && resolvedPackageJson.packageJson) {
      installPackageLocalBundledDependencies({
        packageDir,
        packageJson: resolvedPackageJson.packageJson,
        pluginDir: resolvedPackageJson.pluginDir ?? path.basename(packageDir),
        patchedDependencies: params.patchedDependencies,
      });
    }
    return callback({
      ...resolvedManifest,
      packageDir,
      repoRoot,
      applied: resolvedManifest.changed && Boolean(resolvedManifest.manifest),
      packageJsonApplied: resolvedPackageJson.changed && Boolean(resolvedPackageJson.packageJson),
    });
  } finally {
    if (originalManifest !== undefined) {
      fs.writeFileSync(resolvedManifest.manifestPath, originalManifest, "utf8");
    }
    if (originalPackageJson !== undefined) {
      fs.writeFileSync(resolvedPackageJson.packageJsonPath, originalPackageJson, "utf8");
    }
  }
}

const RUN_USAGE =
  "usage: node scripts/lib/plugin-npm-package-manifest.mjs --run <package-dir> -- <command> [args...]";

function readRunPackageDir(argv: string[]) {
  const packageDir = argv[1];
  if (!packageDir || packageDir.startsWith("--")) {
    throw new Error(RUN_USAGE);
  }
  return packageDir;
}

/** @internal Directly tested script implementation detail. */
export function parseRunArgs(
  argv: string[],
):
  | { help: true; packageDir: string; command: string; args: string[] }
  | { packageDir: string; command: string; args: string[]; help?: undefined } {
  if (argv[0] === "--help" || argv[0] === "-h") {
    return { help: true, packageDir: "", command: "", args: [] };
  }
  if (argv[0] !== "--run") {
    throw new Error(RUN_USAGE);
  }
  const packageDir = readRunPackageDir(argv);
  const separatorIndex = argv.indexOf("--", 2);
  if (!packageDir || separatorIndex === -1 || separatorIndex === argv.length - 1) {
    throw new Error(RUN_USAGE);
  }
  if (separatorIndex !== 2) {
    throw new Error(`unexpected plugin npm package manifest run argument: ${argv[2]}`);
  }
  const command = argv[separatorIndex + 1];
  if (!command) {
    throw new Error(RUN_USAGE);
  }
  return {
    packageDir,
    command,
    args: argv.slice(separatorIndex + 2),
  };
}

function main(argv: string[] = process.argv.slice(2)) {
  const parsedArgs = parseRunArgs(argv);
  if (parsedArgs.help) {
    console.log(RUN_USAGE);
    return 0;
  }
  const { packageDir, command, args } = parsedArgs;
  return withAugmentedPluginNpmManifestForPackage(
    {
      packageDir,
      bundleDependencies: process.env.OPENCLAW_PLUGIN_NPM_BUNDLE_DEPENDENCIES,
    },
    ({ packageDir: cwd }) => {
      const commandArgs = [...args];
      if (command === "npm" && args[0] === "pack" && cwd !== path.resolve(packageDir)) {
        // Pack output outlives the temporary dependency tree. Preserve npm's
        // source-relative destination, including its default current directory.
        const destinationIndex = args.findLastIndex(
          (arg) => arg === "--pack-destination" || arg.startsWith("--pack-destination="),
        );
        const destinationArg = args[destinationIndex];
        if (destinationArg === undefined) {
          commandArgs.push("--pack-destination", path.resolve(packageDir));
        } else if (destinationArg === "--pack-destination") {
          const destination = args[destinationIndex + 1];
          if (destination && !destination.startsWith("-")) {
            commandArgs[destinationIndex + 1] = path.resolve(packageDir, destination);
          }
        } else {
          commandArgs[destinationIndex] = `--pack-destination=${path.resolve(
            packageDir,
            destinationArg.slice("--pack-destination=".length),
          )}`;
        }
      }
      const result = spawnCommandSync(command, commandArgs, {
        cwd,
        env: process.env,
        stdio: "inherit",
      });
      if (result.error) {
        throw result.error;
      }
      return result.status ?? 1;
    },
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    process.exitCode = main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
