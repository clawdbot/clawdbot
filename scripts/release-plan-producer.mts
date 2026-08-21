#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { builtinModules, createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectExtensionPackageJsonCandidates } from "./lib/plugin-publication-candidates.ts";
import {
  collectPublishablePluginPackagesFromCandidates,
  type PluginPackageJson,
} from "./lib/plugin-publication-collector.ts";
import { parseReleaseVersion } from "./lib/release-version.mjs";
import {
  canonicalReleasePlanJson,
  canonicalReleasePlanLockJson,
  createReleasePlanLock,
  parseReleasePlanLockJson,
  RELEASE_PLAN_SCHEMA,
  validateReleasePlan,
  type ReleasePlan,
  type ReleasePlanLock,
  type ReleasePlanPurpose,
} from "./release-plan-contract.mjs";
import { verifyReleaseToolingIdentity } from "./release-tooling-identity.mjs";
import {
  releaseValidationIntentForPurpose,
  resolveReleaseValidationIntent,
  type ReleaseValidationIntent,
  type ReleaseValidationProfile,
} from "./release-validation-intent.mjs";

export type ReleasePlanIntent =
  | "publish"
  | "diagnostic"
  | "postpublish-confidence"
  | "main-qualification";
export type MainQualificationValidationIntent = Extract<
  ReleaseValidationIntent,
  "main-daily" | "main-weekly"
>;

type ReleasePlanSourceBase = {
  repoRoot?: string;
  candidateSha: string;
  candidateRef: string;
  toolingSha: string;
  toolingFullRef: string;
  runGh?: (args: string[]) => string;
};

export type ReleasePlanSource =
  | (ReleasePlanSourceBase & {
      intent: "main-qualification";
      validationIntent: MainQualificationValidationIntent;
    })
  | (ReleasePlanSourceBase & {
      intent: Exclude<ReleasePlanIntent, "main-qualification">;
      validationIntent?: never;
    });

declare const verifiedReleasePlanLockBrand: unique symbol;
export type VerifiedReleasePlanLock = ReleasePlanLock & {
  readonly [verifiedReleasePlanLockBrand]: true;
};

type PackageManifest = PluginPackageJson;
type ParseYaml = (source: string) => unknown;

type CorePackagePolicy = {
  path: string;
  dependency?: string;
};

const REPOSITORY = "openclaw/openclaw";
const VALIDATION_WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const PUBLICATION_WORKFLOW_PATH = ".github/workflows/openclaw-release-publish.yml";
const NPM_PUBLICATION_WORKFLOW_PATH = ".github/workflows/openclaw-npm-release.yml";
const PRODUCER_PATH = "scripts/release-plan-producer.mts";
const EXECUTION_ROOT = fileURLToPath(new URL("..", import.meta.url));
const TOOLING_PACKAGE_JSON_PATH = "package.json";
const TOOLING_LOCKFILE_PATH = "pnpm-lock.yaml";
// These values bind runtime parsing to the reviewed yaml tarball. Loading before
// the root files and installed manifest pass this gate would reopen caller drift.
const YAML_PACKAGE_VERSION = "2.9.0";
const YAML_PACKAGE_INTEGRITY =
  "sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==";
const YAML_PACKAGE_TREE_SHA256 = "610ccacfe592d226ac1eb04842d1f591c5381f2a68b9f785643101d10db52c27";
const YAML_PACKAGE_MAX_FILES = 512;
const YAML_PACKAGE_MAX_ENTRIES = 1024;
const YAML_PACKAGE_MAX_BYTES = 4 * 1024 * 1024;
const BUILTIN_IMPORTS = new Set([
  ...builtinModules,
  ...builtinModules.map((specifier) => `node:${specifier}`),
]);
const SHA_PATTERN = /^[a-f0-9]{40}$/u;
const compareAscii = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function resolveCommit(repoRoot: string, revision: string, label: string): string {
  let resolved: string;
  try {
    resolved = git(repoRoot, ["rev-parse", "--verify", `${revision}^{commit}`]);
  } catch {
    throw new Error(`${label} does not resolve to a commit: ${revision}`);
  }
  if (!SHA_PATTERN.test(resolved)) {
    throw new Error(`${label} did not resolve to an exact lowercase commit SHA`);
  }
  return resolved;
}

function requireExactSha(value: string, label: string): string {
  if (!SHA_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact lowercase 40-character commit SHA`);
  }
  return value;
}

function requireQualifiedRef(value: string, label: string): string {
  if (!/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(value)) {
    throw new Error(`${label} must be a qualified branch or tag ref`);
  }
  return value;
}

function readGitBytes(repoRoot: string, commit: string, path: string): Buffer {
  try {
    return execFileSync("git", ["show", `${commit}:${path}`], {
      cwd: repoRoot,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    throw new Error(`${path} is missing from ${commit}`);
  }
}

function readGitText(repoRoot: string, commit: string, path: string): string {
  return readGitBytes(repoRoot, commit, path).toString("utf8");
}

function gitPathExists(repoRoot: string, commit: string, path: string): boolean {
  try {
    execFileSync("git", ["cat-file", "-e", `${commit}:${path}`], {
      cwd: repoRoot,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function collectLiteralImports(source: string): string[] {
  const imports = new Set<string>();
  for (const pattern of [
    /\bfrom\s+["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/gu,
  ]) {
    for (const match of source.matchAll(pattern)) {
      if (match[1]) {
        imports.add(match[1]);
      }
    }
  }
  return [...imports].toSorted(compareAscii);
}

function resolveToolingImportPath(
  repoRoot: string,
  toolingSha: string,
  sourcePath: string,
  specifier: string,
): string {
  const importedPath = posix.normalize(posix.join(posix.dirname(sourcePath), specifier));
  if (importedPath.startsWith("../") || importedPath === "..") {
    throw new Error(`tooling import escapes repository root: ${sourcePath} -> ${specifier}`);
  }
  const candidates = new Set([importedPath]);
  if (importedPath.endsWith(".js")) {
    candidates.add(`${importedPath.slice(0, -3)}.ts`);
  } else if (importedPath.endsWith(".mjs")) {
    candidates.add(`${importedPath.slice(0, -4)}.mts`);
  } else if (importedPath.endsWith(".cjs")) {
    candidates.add(`${importedPath.slice(0, -4)}.cts`);
  } else if (!posix.extname(importedPath)) {
    for (const suffix of [".ts", ".mts", ".mjs", "/index.ts"]) {
      candidates.add(`${importedPath}${suffix}`);
    }
  }
  const existing = [...candidates].filter((path) => gitPathExists(repoRoot, toolingSha, path));
  if (existing.length !== 1) {
    throw new Error(
      `tooling import must resolve to exactly one owned file: ${sourcePath} -> ${specifier}`,
    );
  }
  return existing[0]!;
}

function verifyToolingImportClosure(repoRoot: string, toolingSha: string) {
  const pending = [PRODUCER_PATH];
  const verified = new Set<string>();
  while (pending.length > 0) {
    const sourcePath = pending.pop();
    if (!sourcePath || verified.has(sourcePath)) {
      continue;
    }
    const toolingBytes = readGitBytes(repoRoot, toolingSha, sourcePath);
    const executionPath = resolve(EXECUTION_ROOT, sourcePath);
    const executionBytes = readFileSync(executionPath);
    if (!executionBytes.equals(toolingBytes)) {
      throw new Error(`tooling import closure differs from tooling SHA: ${sourcePath}`);
    }
    verified.add(sourcePath);
    const source = toolingBytes.toString("utf8");
    for (const specifier of collectLiteralImports(source)) {
      if (BUILTIN_IMPORTS.has(specifier)) {
        continue;
      }
      if (!specifier.startsWith(".")) {
        throw new Error(
          `tooling import closure contains an unowned bare import: ${sourcePath} -> ${specifier}`,
        );
      }
      pending.push(resolveToolingImportPath(repoRoot, toolingSha, sourcePath, specifier));
    }
  }
}

function readVerifiedToolingRootBytes(repoRoot: string, toolingSha: string, path: string): Buffer {
  const toolingBytes = readGitBytes(repoRoot, toolingSha, path);
  const executionBytes = readFileSync(resolve(EXECUTION_ROOT, path));
  if (!executionBytes.equals(toolingBytes)) {
    throw new Error(`tooling root file differs from tooling SHA: ${path}`);
  }
  return toolingBytes;
}

type LineRange = { start: number; end: number };

function findLockfileMapping(
  lines: string[],
  key: string,
  indent: number,
  scope: LineRange = { start: 0, end: lines.length },
): LineRange {
  const declaration = `${" ".repeat(indent)}${key}:`;
  const matches: number[] = [];
  for (let index = scope.start; index < scope.end; index += 1) {
    if (lines[index] === declaration) {
      matches.push(index);
    }
  }
  if (matches.length !== 1) {
    throw new Error(`pnpm lockfile must declare exactly one ${key} mapping`);
  }
  const start = matches[0]!;
  let end = scope.end;
  for (let index = start + 1; index < scope.end; index += 1) {
    const line = lines[index] ?? "";
    if (!line) {
      continue;
    }
    const nextIndent = line.length - line.trimStart().length;
    if (nextIndent <= indent) {
      end = index;
      break;
    }
  }
  return { start, end };
}

function verifyYamlLockfile(lockfileText: string) {
  const lines = lockfileText.split("\n");
  if (lines.filter((line) => line === "lockfileVersion: '9.0'").length !== 1) {
    throw new Error("pnpm lockfile must use lockfileVersion 9.0");
  }
  const importers = findLockfileMapping(lines, "importers", 0);
  const rootImporter = findLockfileMapping(lines, ".", 2, importers);
  const dependencies = findLockfileMapping(lines, "dependencies", 4, rootImporter);
  const yamlImporter = findLockfileMapping(lines, "yaml", 6, dependencies);
  const importerEntries = lines.slice(yamlImporter.start + 1, yamlImporter.end).filter(Boolean);
  if (
    importerEntries.length !== 2 ||
    importerEntries[0] !== `        specifier: ${YAML_PACKAGE_VERSION}` ||
    importerEntries[1] !== `        version: ${YAML_PACKAGE_VERSION}`
  ) {
    throw new Error(`pnpm root importer must pin yaml exactly to ${YAML_PACKAGE_VERSION}`);
  }

  const packages = findLockfileMapping(lines, "packages", 0);
  const yamlPackage = findLockfileMapping(lines, `yaml@${YAML_PACKAGE_VERSION}`, 2, packages);
  const resolution = `    resolution: {integrity: ${YAML_PACKAGE_INTEGRITY}}`;
  if (
    lines
      .slice(yamlPackage.start + 1, yamlPackage.end)
      .filter((line) => line.trimStart().startsWith("resolution:"))
      .join("\n") !== resolution
  ) {
    throw new Error(`pnpm lockfile must bind yaml@${YAML_PACKAGE_VERSION} to its exact integrity`);
  }

  const snapshots = findLockfileMapping(lines, "snapshots", 0);
  if (
    lines
      .slice(snapshots.start + 1, snapshots.end)
      .filter((line) => line === `  yaml@${YAML_PACKAGE_VERSION}: {}`).length !== 1
  ) {
    throw new Error(
      `pnpm lockfile yaml@${YAML_PACKAGE_VERSION} snapshot must have no dependencies`,
    );
  }
}

function assertYamlPackagePath(path: string) {
  if (
    !path ||
    !/^[\x20-\x7e]+$/u.test(path) ||
    path.includes("\\") ||
    posix.isAbsolute(path) ||
    path.split("/").some((component) => component === "." || component === "..")
  ) {
    throw new Error(`installed yaml package contains an unsafe path: ${JSON.stringify(path)}`);
  }
}

function verifyInstalledYamlPackageTree(packageRoot: string) {
  const rootStat = lstatSync(packageRoot);
  if (!rootStat.isDirectory()) {
    throw new Error("installed yaml package root must be a directory");
  }

  const records: string[] = [];
  let entryCount = 0;
  let fileCount = 0;
  let totalBytes = 0;
  const walk = (directory: string, relativeDirectory = "") => {
    for (const name of readdirSync(directory).toSorted(compareAscii)) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      assertYamlPackagePath(relativePath);
      entryCount += 1;
      if (entryCount > YAML_PACKAGE_MAX_ENTRIES) {
        throw new Error(
          `installed yaml package exceeds ${YAML_PACKAGE_MAX_ENTRIES} filesystem entries`,
        );
      }

      const absolutePath = join(directory, name);
      const stat = lstatSync(absolutePath);
      if (stat.isSymbolicLink()) {
        throw new Error(`installed yaml package must not contain symbolic links: ${relativePath}`);
      }
      if (stat.isDirectory()) {
        records.push(JSON.stringify(["directory", relativePath]));
        walk(absolutePath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`installed yaml package must contain only directories and files`);
      }
      if (stat.nlink !== 1) {
        throw new Error(`installed yaml package files must have one link: ${relativePath}`);
      }

      fileCount += 1;
      if (fileCount > YAML_PACKAGE_MAX_FILES) {
        throw new Error(`installed yaml package exceeds ${YAML_PACKAGE_MAX_FILES} files`);
      }
      totalBytes += stat.size;
      if (totalBytes > YAML_PACKAGE_MAX_BYTES) {
        throw new Error(`installed yaml package exceeds ${YAML_PACKAGE_MAX_BYTES} bytes`);
      }
      const bytes = readFileSync(absolutePath);
      if (bytes.byteLength !== stat.size) {
        throw new Error(`installed yaml package file changed while being read: ${relativePath}`);
      }
      records.push(
        JSON.stringify([
          "file",
          relativePath,
          bytes.byteLength,
          createHash("sha256").update(bytes).digest("hex"),
        ]),
      );
    }
  };
  walk(packageRoot);

  const manifest = `${records.toSorted(compareAscii).join("\n")}\n`;
  const digest = createHash("sha256").update(manifest, "ascii").digest("hex");
  if (digest !== YAML_PACKAGE_TREE_SHA256) {
    throw new Error(`installed yaml package tree must match yaml@${YAML_PACKAGE_VERSION}`);
  }
}

function loadVerifiedYamlParser(repoRoot: string, toolingSha: string): ParseYaml {
  const packageJsonBytes = readVerifiedToolingRootBytes(
    repoRoot,
    toolingSha,
    TOOLING_PACKAGE_JSON_PATH,
  );
  const lockfileBytes = readVerifiedToolingRootBytes(repoRoot, toolingSha, TOOLING_LOCKFILE_PATH);
  let packageJson: { dependencies?: Record<string, unknown> };
  try {
    packageJson = JSON.parse(packageJsonBytes.toString("utf8")) as {
      dependencies?: Record<string, unknown>;
    };
  } catch (error) {
    throw new Error("tooling package.json is invalid JSON", { cause: error });
  }
  if (packageJson.dependencies?.yaml !== YAML_PACKAGE_VERSION) {
    throw new Error(`tooling package.json must pin yaml exactly to ${YAML_PACKAGE_VERSION}`);
  }
  verifyYamlLockfile(lockfileBytes.toString("utf8"));

  const toolingRequire = createRequire(resolve(EXECUTION_ROOT, TOOLING_PACKAGE_JSON_PATH));
  const packageJsonPath = realpathSync(toolingRequire.resolve("yaml/package.json"));
  const packageRoot = realpathSync(dirname(packageJsonPath));
  const modulePath = realpathSync(toolingRequire.resolve("yaml"));
  const moduleRelativePath = relative(packageRoot, modulePath);
  if (
    moduleRelativePath === ".." ||
    moduleRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(moduleRelativePath)
  ) {
    throw new Error("resolved yaml module must be owned by its installed package");
  }
  const packageJsonRelativePath = relative(packageRoot, packageJsonPath);
  if (
    packageJsonRelativePath === ".." ||
    packageJsonRelativePath.startsWith(`..${sep}`) ||
    isAbsolute(packageJsonRelativePath)
  ) {
    throw new Error("resolved yaml package.json must be owned by its installed package");
  }
  verifyInstalledYamlPackageTree(packageRoot);

  const installedPackageJsonBytes = readFileSync(packageJsonPath);
  const installedPackageJson = JSON.parse(installedPackageJsonBytes.toString("utf8")) as {
    name?: unknown;
    version?: unknown;
  };
  if (
    installedPackageJson.name !== "yaml" ||
    installedPackageJson.version !== YAML_PACKAGE_VERSION
  ) {
    throw new Error(`installed yaml package must be exactly yaml@${YAML_PACKAGE_VERSION}`);
  }
  const yamlModule = toolingRequire(modulePath) as { parse?: unknown };
  if (typeof yamlModule.parse !== "function") {
    throw new Error(`installed yaml@${YAML_PACKAGE_VERSION} must export parse`);
  }
  return yamlModule.parse as ParseYaml;
}

function withCandidateSnapshot<T>(
  repoRoot: string,
  candidateSha: string,
  callback: (snapshotRoot: string) => T,
): T {
  const snapshotRoot = mkdtempSync(join(tmpdir(), "openclaw-release-candidate-"));
  try {
    const tree = execFileSync(
      "git",
      ["ls-tree", "-r", "-z", candidateSha, "--", "package.json", "extensions", "packages"],
      { cwd: repoRoot },
    ).toString("utf8");
    const inventoryPaths: string[] = [];
    for (const entry of tree.split("\0").filter(Boolean)) {
      const [metadata, path] = entry.split("\t");
      if (
        !path ||
        (path !== "package.json" &&
          !/^extensions\/[^/]+\/(?:package\.json|README\.md)$/u.test(path) &&
          !/^packages\/[^/]+\/package\.json$/u.test(path))
      ) {
        continue;
      }
      if (metadata?.startsWith("120000 ")) {
        throw new Error("candidate package inventory must not contain symbolic links");
      }
      inventoryPaths.push(path);
    }
    if (!inventoryPaths.includes("package.json")) {
      throw new Error("candidate package.json is missing");
    }
    const archivePath = join(snapshotRoot, "candidate.tar");
    execFileSync(
      "git",
      ["archive", "--format=tar", `--output=${archivePath}`, candidateSha, "--", ...inventoryPaths],
      { cwd: repoRoot },
    );
    execFileSync("tar", ["-xf", archivePath, "-C", snapshotRoot]);
    mkdirSync(join(snapshotRoot, "extensions"), { recursive: true });
    return callback(snapshotRoot);
  } finally {
    rmSync(snapshotRoot, { force: true, recursive: true });
  }
}

export function deriveReleasePlanPolicy(
  intent: ReleasePlanIntent,
  version: string,
  validationIntent?: MainQualificationValidationIntent,
): {
  intent: ReleaseValidationIntent;
  profile: ReleaseValidationProfile;
  publishable: boolean;
  purpose: ReleasePlanPurpose;
  soak: boolean;
  tag: string | null;
} {
  const parsed = parseReleaseVersion(version);
  if (parsed === null || parsed.version !== version) {
    throw new Error(`unsupported release version: ${version}`);
  }
  if (intent === "main-qualification") {
    const purpose = "main-qualification";
    return {
      ...resolveReleaseValidationIntent(
        releaseValidationIntentForPurpose(purpose, validationIntent),
      ),
      purpose,
      tag: null,
    };
  }
  if (validationIntent !== undefined) {
    throw new Error("validation intent is only valid for main-qualification");
  }
  if (intent === "diagnostic") {
    const purpose = "diagnostic";
    return {
      ...resolveReleaseValidationIntent(releaseValidationIntentForPurpose(purpose)),
      purpose,
      tag: null,
    };
  }
  if (intent === "postpublish-confidence") {
    const purpose = "postpublish-confidence";
    return {
      ...resolveReleaseValidationIntent(releaseValidationIntentForPurpose(purpose)),
      purpose,
      tag: `v${version}`,
    };
  }
  if (intent !== "publish") {
    throw new Error("unsupported release plan intent");
  }
  const purpose = parsed.channel === "stable" ? "stable-publish" : "beta-publish";
  return {
    ...resolveReleaseValidationIntent(releaseValidationIntentForPurpose(purpose)),
    purpose,
    tag: `v${version}`,
  };
}

function collectAllowedGroups(workflowText: string, parseYaml: ParseYaml): string[] {
  const workflow = parseYaml(workflowText) as {
    on?: { workflow_dispatch?: { inputs?: { rerun_group?: { options?: unknown } } } };
  };
  const options = workflow.on?.workflow_dispatch?.inputs?.rerun_group?.options;
  if (
    !Array.isArray(options) ||
    options.length === 0 ||
    options.some((entry) => typeof entry !== "string" || !entry)
  ) {
    throw new Error(`${VALIDATION_WORKFLOW_PATH} must declare rerun_group choice options`);
  }
  const groups = [...new Set(options)];
  if (groups.length !== options.length) {
    throw new Error(`${VALIDATION_WORKFLOW_PATH} rerun_group options must be unique`);
  }
  return groups.toSorted(compareAscii);
}

function readPackageManifest(path: string): PackageManifest {
  return JSON.parse(readFileSync(path, "utf8")) as PackageManifest;
}

function collectCorePackagePolicy(workflowText: string, parseYaml: ParseYaml): CorePackagePolicy[] {
  const workflow = parseYaml(workflowText) as {
    jobs?: Record<string, { steps?: Array<{ env?: { CORE_PACKAGE_DIRS?: unknown } }> }>;
  };
  const declarations = Object.values(workflow.jobs ?? {}).flatMap((job) =>
    (job.steps ?? [])
      .map((step) => step.env?.CORE_PACKAGE_DIRS)
      .filter((value): value is string => typeof value === "string"),
  );
  const [declaration] = declarations;
  if (declarations.length !== 1 || !declaration) {
    throw new Error(`${NPM_PUBLICATION_WORKFLOW_PATH} must declare one CORE_PACKAGE_DIRS owner`);
  }
  const paths = declaration.trim().split(/\s+/u).filter(Boolean);
  if (
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !/^packages\/[a-z0-9-]+$/u.test(path))
  ) {
    throw new Error(`${NPM_PUBLICATION_WORKFLOW_PATH} has invalid CORE_PACKAGE_DIRS`);
  }
  const dependencyGates = new Map<string, string>();
  for (const match of workflowText.matchAll(
    /\[\[ "\$package_dir" == "(packages\/[a-z0-9-]+)" \]\][^\n]*dependencies\?\.\["([^"]+)"\]/gu,
  )) {
    if (match[1] && match[2]) {
      dependencyGates.set(match[1], match[2]);
    }
  }
  for (const path of dependencyGates.keys()) {
    if (!paths.includes(path)) {
      throw new Error(`${NPM_PUBLICATION_WORKFLOW_PATH} gates an undeclared core package: ${path}`);
    }
  }
  return paths
    .map((path) => {
      const dependency = dependencyGates.get(path);
      return dependency ? { path, dependency } : { path };
    })
    .toSorted((left, right) => compareAscii(left.path, right.path));
}

function collectPackageInventory(
  snapshotRoot: string,
  rootManifest: PackageManifest,
  corePackages: CorePackagePolicy[],
) {
  const version = rootManifest.version;
  if (typeof version !== "string" || !version) {
    throw new Error("candidate package.json version is required");
  }
  const packages = new Map<
    string,
    { name: string; source: string; version: string; targets: Set<string> }
  >();
  const addPackage = (manifest: PackageManifest, targets: string[], source: string) => {
    if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
      throw new Error(`${source} must declare package name and version`);
    }
    const existing = packages.get(manifest.name);
    if (existing && existing.source !== source) {
      throw new Error(
        `package inventory source mismatch for ${manifest.name}: ${existing.source} and ${source}`,
      );
    }
    if (existing && existing.version !== manifest.version) {
      throw new Error(`package inventory version mismatch for ${manifest.name}`);
    }
    const entry = existing ?? {
      name: manifest.name,
      source,
      version: manifest.version,
      targets: new Set<string>(),
    };
    for (const target of targets) {
      entry.targets.add(target);
    }
    packages.set(manifest.name, entry);
  };
  addPackage({ name: "openclaw", version }, ["npm"], "package.json");
  const pluginCandidates = collectExtensionPackageJsonCandidates(snapshotRoot);
  for (const [target, plugins] of [
    ["clawhub", collectPublishablePluginPackagesFromCandidates(pluginCandidates, "clawhub")],
    ["npm", collectPublishablePluginPackagesFromCandidates(pluginCandidates, "npm")],
  ] as const) {
    for (const plugin of plugins) {
      addPackage(
        { name: plugin.packageName, version: plugin.version },
        [target],
        `${plugin.packageDir}/package.json`,
      );
    }
  }
  for (const policy of corePackages) {
    const manifestPath = join(snapshotRoot, policy.path, "package.json");
    if (!existsSync(manifestPath)) {
      if (policy.dependency && typeof rootManifest.dependencies?.[policy.dependency] === "string") {
        throw new Error(
          `publishable core package manifest is missing: ${policy.path}/package.json`,
        );
      }
      continue;
    }
    const manifest = readPackageManifest(manifestPath);
    if (policy.dependency && typeof rootManifest.dependencies?.[policy.dependency] !== "string") {
      continue;
    }
    if (!policy.dependency && manifest.openclaw?.release?.publishToNpm !== true) {
      continue;
    }
    if (manifest.version !== version) {
      throw new Error(`${policy.path} version must match openclaw ${version}`);
    }
    addPackage(manifest, ["npm"], `${policy.path}/package.json`);
  }
  return [...packages.values()]
    .map((entry) => ({
      name: entry.name,
      version: entry.version,
      targets: [...entry.targets].toSorted(compareAscii),
    }))
    .toSorted((left, right) => compareAscii(left.name, right.name));
}

function collectPlatformSources(workflowText: string, parseYaml: ParseYaml) {
  const platforms = new Map<string, string>();
  const addPlatform = (id: string, source: string) => {
    const existing = platforms.get(id);
    if (existing && existing !== source) {
      throw new Error(
        `${PUBLICATION_WORKFLOW_PATH} declares conflicting platform ${id}: ${existing} and ${source}`,
      );
    }
    platforms.set(id, source);
  };
  const promotionPattern = /promote_([a-z0-9_]+)_release_assets?\(\)\s*\{([\s\S]*?)^\s*\}/gmu;
  const dispatchPattern =
    /dispatch_workflow(?:_at_ref)?\s+(?:(?:"[^"]+"|'[^']+')\s+){0,2}([a-z0-9][a-z0-9-]+\.yml)/u;
  for (const match of workflowText.matchAll(promotionPattern)) {
    const id = match[1]?.replaceAll("_", "-");
    const workflowName = dispatchPattern.exec(match[2] ?? "")?.[1];
    if (!id || !workflowName) {
      throw new Error(`${PUBLICATION_WORKFLOW_PATH} has an invalid platform promotion function`);
    }
    addPlatform(id, `.github/workflows/${workflowName}`);
  }
  const workflow = parseYaml(workflowText) as {
    jobs?: Record<string, { uses?: unknown }>;
  };
  for (const [jobId, job] of Object.entries(workflow.jobs ?? {})) {
    if (!jobId.startsWith("publish_") || typeof job.uses !== "string") {
      continue;
    }
    const match = /^\.\/\.github\/workflows\/([a-z0-9][a-z0-9-]+\.yml)$/u.exec(job.uses);
    if (!match?.[1]) {
      throw new Error(`${PUBLICATION_WORKFLOW_PATH} has an invalid reusable publication workflow`);
    }
    addPlatform(
      jobId.slice("publish_".length).replaceAll("_", "-"),
      `.github/workflows/${match[1]}`,
    );
  }
  if (platforms.size === 0) {
    throw new Error(`${PUBLICATION_WORKFLOW_PATH} does not declare platform publication workflows`);
  }
  return [...platforms.entries()].toSorted(([left], [right]) => compareAscii(left, right));
}

function collectPlatformInventory(
  repoRoot: string,
  toolingSha: string,
  workflowText: string,
  parseYaml: ParseYaml,
) {
  return collectPlatformSources(workflowText, parseYaml).map(([id, source]) => {
    if (!gitPathExists(repoRoot, toolingSha, source)) {
      throw new Error(`release platform workflow does not exist at tooling SHA: ${source}`);
    }
    return { id, source };
  });
}

function readCandidateInventory(
  repoRoot: string,
  candidateSha: string,
  corePackages: CorePackagePolicy[],
) {
  return withCandidateSnapshot(repoRoot, candidateSha, (snapshotRoot) => {
    const rootPackage = readPackageManifest(join(snapshotRoot, "package.json"));
    if (typeof rootPackage.version !== "string" || !rootPackage.version) {
      throw new Error("candidate package.json version is required");
    }
    return {
      version: rootPackage.version,
      packages: collectPackageInventory(snapshotRoot, rootPackage, corePackages),
    };
  });
}

function resolveSource(params: ReleasePlanSource) {
  const repoRoot = resolve(params.repoRoot ?? ".");
  const candidateSha = requireExactSha(params.candidateSha, "candidate SHA");
  const toolingSha = requireExactSha(params.toolingSha, "tooling SHA");
  const toolingFullRef = requireQualifiedRef(params.toolingFullRef, "tooling full ref");
  if (resolveCommit(repoRoot, candidateSha, "candidate SHA") !== candidateSha) {
    throw new Error("candidate SHA does not resolve to itself");
  }
  const toolingRef = toolingFullRef.replace(/^refs\/(?:heads|tags)\//u, "");
  const verifiedTooling = verifyReleaseToolingIdentity({
    repository: REPOSITORY,
    workflowFullRef: toolingFullRef,
    workflowRef: toolingRef,
    workflowSha: toolingSha,
    ...(params.runGh ? { runGh: params.runGh } : {}),
  });
  if (
    params.intent !== "diagnostic" &&
    params.intent !== "main-qualification" &&
    verifiedTooling.route !== "protected-tag"
  ) {
    throw new Error(`${params.intent} tooling must use a release-publish tag bound to its SHA`);
  }
  return { candidateSha, repoRoot, toolingFullRef, toolingSha };
}

export function produceReleasePlan(params: ReleasePlanSource): ReleasePlan {
  const { candidateSha, repoRoot, toolingFullRef, toolingSha } = resolveSource(params);
  verifyToolingImportClosure(repoRoot, toolingSha);
  const parseYaml = loadVerifiedYamlParser(repoRoot, toolingSha);
  const validationWorkflow = readGitText(repoRoot, toolingSha, VALIDATION_WORKFLOW_PATH);
  const publicationWorkflow = readGitText(repoRoot, toolingSha, PUBLICATION_WORKFLOW_PATH);
  const npmPublicationWorkflow = readGitText(repoRoot, toolingSha, NPM_PUBLICATION_WORKFLOW_PATH);
  const candidate = readCandidateInventory(
    repoRoot,
    candidateSha,
    collectCorePackagePolicy(npmPublicationWorkflow, parseYaml),
  );
  const policy = deriveReleasePlanPolicy(params.intent, candidate.version, params.validationIntent);
  // ReleasePlan binds the candidate bytes. A branch used only to make the FRV
  // workflow reachable is dispatch state and must not become plan authority.
  const expectedCandidateRef =
    params.intent === "diagnostic" || params.intent === "main-qualification"
      ? candidateSha
      : `refs/tags/v${candidate.version}`;
  if (params.candidateRef !== expectedCandidateRef) {
    throw new Error(`${params.intent} candidate ref must be ${expectedCandidateRef}`);
  }
  if (
    params.intent === "postpublish-confidence" &&
    resolveCommit(repoRoot, params.candidateRef, "published candidate tag") !== candidateSha
  ) {
    throw new Error("published candidate tag does not resolve to the candidate SHA");
  }
  return validateReleasePlan({
    schema: RELEASE_PLAN_SCHEMA,
    release_id: candidate.version,
    version: candidate.version,
    tag: policy.tag,
    candidate_sha: candidateSha,
    target_context_ref: expectedCandidateRef,
    purpose: policy.purpose,
    tooling: {
      repository: REPOSITORY,
      workflow_path: VALIDATION_WORKFLOW_PATH,
      ref: toolingFullRef,
      sha: toolingSha,
    },
    validation: {
      intent: policy.intent,
      profile: policy.profile,
      soak: policy.soak,
      allowed_groups: collectAllowedGroups(validationWorkflow, parseYaml),
    },
    inventory: {
      packages: candidate.packages,
      platforms: collectPlatformInventory(repoRoot, toolingSha, publicationWorkflow, parseYaml),
    },
  });
}

export function verifyReleasePlanLock(
  lockJson: string,
  params: ReleasePlanSource,
): VerifiedReleasePlanLock {
  const expectedPlan = produceReleasePlan(params);
  const lock = parseReleasePlanLockJson(lockJson);
  if (canonicalReleasePlanJson(lock.plan) !== canonicalReleasePlanJson(expectedPlan)) {
    throw new Error("release plan does not match repository-derived authority");
  }
  return lock as VerifiedReleasePlanLock;
}

function requiredOption(args: string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value || value.startsWith("-")) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function main() {
  const args = process.argv.slice(2);
  const intent = requiredOption(args, "--intent") as ReleasePlanIntent;
  if (!["publish", "diagnostic", "postpublish-confidence", "main-qualification"].includes(intent)) {
    throw new Error(
      "--intent must be publish, diagnostic, postpublish-confidence, or main-qualification",
    );
  }
  const source = {
    candidateSha: requiredOption(args, "--candidate-sha"),
    candidateRef: requiredOption(args, "--candidate-ref"),
    toolingSha: requiredOption(args, "--tooling-sha"),
    toolingFullRef: requiredOption(args, "--tooling-full-ref"),
  };
  const plan = produceReleasePlan(
    intent === "main-qualification"
      ? {
          ...source,
          intent,
          validationIntent: requiredOption(
            args,
            "--validation-intent",
          ) as MainQualificationValidationIntent,
        }
      : { ...source, intent },
  );
  process.stdout.write(canonicalReleasePlanLockJson(createReleasePlanLock(plan)));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    console.error("[release-plan-producer] FAILED (exit 1)");
    process.exitCode = 1;
  }
}
