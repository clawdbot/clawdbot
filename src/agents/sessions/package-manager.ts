/**
 * Session package/resource manager.
 *
 * Resolves extension, skill, prompt, and theme sources from npm, git, local paths, and project manifests.
 */
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  globSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import { isDefaultStateDir } from "../../config/paths.js";
import { isPathInside } from "../../infra/path-guards.js";
import {
  addIgnoreRules,
  normalizeNativePathSeparators,
  type IgnoreMatcher,
} from "../../shared/ignore-rules.js";
import { CONFIG_DIR_NAME } from "../config.js";
import { type GitSource, parseGitUrl } from "../utils/git.js";
import { canonicalizePath, isLocalPath } from "../utils/paths.js";
import type { PackageSource, SettingsManager } from "./settings-manager.js";

export interface PathMetadata {
  source: string;
  scope: SourceScope;
  origin: "package" | "top-level";
  baseDir?: string;
}

export interface ResolvedResource {
  path: string;
  enabled: boolean;
  metadata: PathMetadata;
}

export interface ResolvedPaths {
  extensions: ResolvedResource[];
  skills: ResolvedResource[];
  prompts: ResolvedResource[];
  themes: ResolvedResource[];
}

export type MissingSourceAction = "skip" | "error";

export interface PackageManager {
  resolve(onMissing?: (source: string) => Promise<MissingSourceAction>): Promise<ResolvedPaths>;
  resolveExtensionSources(
    sources: string[],
    options?: { local?: boolean; temporary?: boolean },
  ): Promise<ResolvedPaths>;
}

interface PackageManagerOptions {
  cwd: string;
  agentDir: string;
  settingsManager: SettingsManager;
}

type SourceScope = "user" | "project" | "temporary";

type NpmSource = {
  type: "npm";
  spec: string;
  name: string;
  pinned: boolean;
};

type LocalSource = {
  type: "local";
  path: string;
};

type ParsedSource = NpmSource | GitSource | LocalSource;

interface ResourceManifest {
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

/**
 * Compute a numeric precedence rank for a resource based on its metadata.
 * Lower rank = higher precedence. Used to sort resolved resources so that
 * name-collision resolution ("first wins") produces the correct outcome.
 *
 * Precedence (highest to lowest):
 *   0  project + settings entry (source: "local", scope: "project")
 *   1  project + auto-discovered (source: "auto", scope: "project")
 *   2  user + settings entry (source: "local", scope: "user")
 *   3  user + auto-discovered (source: "auto", scope: "user")
 *   4  package resource (origin: "package")
 */
function resourcePrecedenceRank(m: PathMetadata): number {
  if (m.origin === "package") {
    return 4;
  }
  const scopeBase = m.scope === "project" ? 0 : 2;
  return scopeBase + (m.source === "local" ? 0 : 1);
}

interface PackageFilter {
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

type ResourceType = "extensions" | "skills" | "prompts" | "themes";
type TopLevelAutoResourceType = Extract<ResourceType, "prompts" | "themes">;
type ResourceState = { metadata: PathMetadata; enabled: boolean };
type ResourceAccumulator = Record<ResourceType, Map<string, ResourceState>>;

const RESOURCE_TYPES = ["extensions", "skills", "prompts", "themes"] as const;

type ResolvedPackageTarget =
  | { kind: "missing" }
  | { kind: "file" | "directory"; path: string; baseDir: string };

const FILE_PATTERNS: Record<ResourceType, RegExp> = {
  extensions: /\.(ts|js)$/,
  skills: /\.md$/,
  prompts: /\.md$/,
  themes: /\.json$/,
};

function getHomeDir(): string {
  return process.env.HOME || homedir();
}

function getAgentResourceTempDir(agentDir: string): string {
  const tempDir = join(agentDir, "tmp", "resources");
  // Temporary packages can contain executable code, so other local users must not modify them.
  mkdirSync(tempDir, { recursive: true, mode: 0o700 });
  chmodSync(tempDir, 0o700);
  return tempDir;
}

function isPattern(s: string): boolean {
  return (
    s.startsWith("!") ||
    s.startsWith("+") ||
    s.startsWith("-") ||
    s.includes("*") ||
    s.includes("?")
  );
}

function isOverridePattern(s: string): boolean {
  return s.startsWith("!") || s.startsWith("+") || s.startsWith("-");
}

function hasGlobPattern(s: string): boolean {
  return s.includes("*") || s.includes("?");
}

function splitPatterns(entries: string[]): { plain: string[]; patterns: string[] } {
  const plain: string[] = [];
  const patterns: string[] = [];
  for (const entry of entries) {
    if (isPattern(entry)) {
      patterns.push(entry);
    } else {
      plain.push(entry);
    }
  }
  return { plain, patterns };
}

function collectFiles(
  dir: string,
  filePattern: RegExp,
  skipNodeModules = true,
  ignoreMatcher?: IgnoreMatcher,
  rootDir?: string,
): string[] {
  const files: string[] = [];
  if (!existsSync(dir)) {
    return files;
  }

  const root = rootDir ?? dir;
  const ig = ignoreMatcher
    ? addIgnoreRules(dir, root, ignoreMatcher, { ignoreCase: true })
    : addIgnoreRules(dir, root);

  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (skipNodeModules && entry.name === "node_modules") {
        continue;
      }

      const fullPath = join(dir, entry.name);
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDir = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      const relPath = normalizeNativePathSeparators(relative(root, fullPath));
      const ignorePath = isDir ? `${relPath}/` : relPath;
      if (ig.ignores(ignorePath)) {
        continue;
      }

      if (isDir) {
        files.push(...collectFiles(fullPath, filePattern, skipNodeModules, ig, root));
      } else if (isFile && filePattern.test(entry.name)) {
        files.push(fullPath);
      }
    }
  } catch {
    // Ignore errors
  }

  return files;
}

type SkillDiscoveryMode = "openclaw" | "agents";

function collectSkillEntries(
  dir: string,
  mode: SkillDiscoveryMode,
  ignoreMatcher?: IgnoreMatcher,
  rootDir?: string,
): string[] {
  const entries: string[] = [];
  if (!existsSync(dir)) {
    return entries;
  }

  const root = rootDir ?? dir;
  const ig = ignoreMatcher
    ? addIgnoreRules(dir, root, ignoreMatcher, { ignoreCase: true })
    : addIgnoreRules(dir, root);

  try {
    const dirEntries = readdirSync(dir, { withFileTypes: true });

    for (const entry of dirEntries) {
      if (entry.name !== "SKILL.md") {
        continue;
      }

      const fullPath = join(dir, entry.name);
      if (!isRealPathWithinRoot(root, fullPath)) {
        continue;
      }
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue;
        }
      }

      const relPath = normalizeNativePathSeparators(relative(root, fullPath));
      if (isFile && !ig.ignores(relPath)) {
        entries.push(fullPath);
        return entries;
      }
    }

    for (const entry of dirEntries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name === "node_modules") {
        continue;
      }

      const fullPath = join(dir, entry.name);
      if (!isRealPathWithinRoot(root, fullPath)) {
        continue;
      }
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDir = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      const relPath = normalizeNativePathSeparators(relative(root, fullPath));
      if (
        mode === "openclaw" &&
        dir === root &&
        isFile &&
        entry.name.endsWith(".md") &&
        !ig.ignores(relPath)
      ) {
        entries.push(fullPath);
        continue;
      }

      if (!isDir) {
        continue;
      }
      if (ig.ignores(`${relPath}/`)) {
        continue;
      }

      entries.push(...collectSkillEntries(fullPath, mode, ig, root));
    }
  } catch {
    // Ignore errors
  }

  return entries;
}

function collectAutoSkillEntries(dir: string, mode: SkillDiscoveryMode): string[] {
  return collectSkillEntries(dir, mode);
}

function findGitRepoRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  while (true) {
    if (existsSync(join(dir, ".git"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return null;
    }
    dir = parent;
  }
}

function collectAncestorAgentsSkillDirs(startDir: string): string[] {
  const skillDirs: string[] = [];
  const resolvedStartDir = resolve(startDir);
  const gitRepoRoot = findGitRepoRoot(resolvedStartDir);

  let dir = resolvedStartDir;
  while (true) {
    skillDirs.push(join(dir, ".agents", "skills"));
    if (gitRepoRoot && dir === gitRepoRoot) {
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }

  return skillDirs;
}

function collectTopLevelAutoResourceEntries(
  dir: string,
  resourceType: TopLevelAutoResourceType,
): string[] {
  const entries: string[] = [];
  if (!existsSync(dir)) {
    return entries;
  }

  const ig = addIgnoreRules(dir, dir);

  try {
    const dirEntries = readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name === "node_modules") {
        continue;
      }

      const fullPath = join(dir, entry.name);
      if (!isRealPathWithinRoot(dir, fullPath)) {
        continue;
      }
      let isFile = entry.isFile();
      if (entry.isSymbolicLink()) {
        try {
          isFile = statSync(fullPath).isFile();
        } catch {
          continue;
        }
      }

      const relPath = normalizeNativePathSeparators(relative(dir, fullPath));
      if (ig.ignores(relPath)) {
        continue;
      }

      if (isFile && FILE_PATTERNS[resourceType].test(entry.name)) {
        entries.push(fullPath);
      }
    }
  } catch {
    // Ignore errors
  }

  return entries;
}

function readResourceManifestFile(packageJsonPath: string): ResourceManifest | null {
  try {
    const content = readFileSync(packageJsonPath, "utf-8");
    const pkg = JSON.parse(content) as { openclaw?: ResourceManifest };
    return pkg.openclaw ?? null;
  } catch {
    return null;
  }
}

function resolveExtensionEntries(dir: string, rootDir = dir): string[] | null {
  const packageJsonPath = join(dir, "package.json");
  if (existsSync(packageJsonPath)) {
    const manifest = readResourceManifestFile(packageJsonPath);
    if (manifest?.extensions?.length) {
      const entries: string[] = [];
      for (const extPath of manifest.extensions) {
        const resolvedExtPath = resolve(dir, extPath);
        if (existsSync(resolvedExtPath) && isRealPathWithinRoot(rootDir, resolvedExtPath)) {
          entries.push(resolvedExtPath);
        }
      }
      if (entries.length > 0) {
        return entries;
      }
    }
  }

  const indexTs = join(dir, "index.ts");
  const indexJs = join(dir, "index.js");
  if (existsSync(indexTs) && isRealPathWithinRoot(rootDir, indexTs)) {
    return [indexTs];
  }
  if (existsSync(indexJs) && isRealPathWithinRoot(rootDir, indexJs)) {
    return [indexJs];
  }

  return null;
}

function collectAutoExtensionEntries(dir: string): string[] {
  const entries: string[] = [];
  if (!existsSync(dir)) {
    return entries;
  }

  // First check if this directory itself has explicit extension entries (package.json or index)
  const rootEntries = resolveExtensionEntries(dir);
  if (rootEntries) {
    return rootEntries;
  }

  // Otherwise, discover extensions from directory contents
  const ig = addIgnoreRules(dir, dir);

  try {
    const dirEntries = readdirSync(dir, { withFileTypes: true });
    for (const entry of dirEntries) {
      if (entry.name.startsWith(".")) {
        continue;
      }
      if (entry.name === "node_modules") {
        continue;
      }

      const fullPath = join(dir, entry.name);
      if (!isRealPathWithinRoot(dir, fullPath)) {
        continue;
      }
      let isDir = entry.isDirectory();
      let isFile = entry.isFile();

      if (entry.isSymbolicLink()) {
        try {
          const stats = statSync(fullPath);
          isDir = stats.isDirectory();
          isFile = stats.isFile();
        } catch {
          continue;
        }
      }

      const relPath = normalizeNativePathSeparators(relative(dir, fullPath));
      const ignorePath = isDir ? `${relPath}/` : relPath;
      if (ig.ignores(ignorePath)) {
        continue;
      }

      if (isFile && (entry.name.endsWith(".ts") || entry.name.endsWith(".js"))) {
        entries.push(fullPath);
      } else if (isDir) {
        const resolvedEntries = resolveExtensionEntries(fullPath, dir);
        if (resolvedEntries) {
          entries.push(...resolvedEntries);
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return entries;
}

/**
 * Collect resource files from a directory based on resource type.
 * Extensions use smart discovery (index.ts in subdirs), others use recursive collection.
 */
function collectResourceFiles(dir: string, resourceType: ResourceType): string[] {
  if (resourceType === "skills") {
    return collectSkillEntries(dir, "openclaw");
  }
  if (resourceType === "extensions") {
    return collectAutoExtensionEntries(dir);
  }
  return collectFiles(dir, FILE_PATTERNS[resourceType]);
}

const AUTO_RESOURCE_COLLECTORS = {
  extensions: collectAutoExtensionEntries,
  skills: (dir: string) => collectAutoSkillEntries(dir, "openclaw"),
  prompts: (dir: string) => collectTopLevelAutoResourceEntries(dir, "prompts"),
  themes: (dir: string) => collectTopLevelAutoResourceEntries(dir, "themes"),
} satisfies Record<ResourceType, (dir: string) => string[]>;

function resolveRealPathIfPossible(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isRealPathWithinRoot(root: string, candidate: string): boolean {
  return isPathInside(
    resolveRealPathIfPossible(resolve(root)),
    resolveRealPathIfPossible(candidate),
  );
}

function getMatchCandidates(filePath: string, baseDir: string, includeNames: boolean): string[] {
  const name = basename(filePath);
  const candidates = [
    normalizeNativePathSeparators(relative(baseDir, filePath)),
    normalizeNativePathSeparators(filePath),
  ];
  if (includeNames) {
    candidates.push(name);
  }
  if (name === "SKILL.md") {
    const parentDir = dirname(filePath);
    candidates.push(
      normalizeNativePathSeparators(relative(baseDir, parentDir)),
      normalizeNativePathSeparators(parentDir),
    );
    if (includeNames) {
      candidates.push(basename(parentDir));
    }
  }
  return candidates;
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
  const candidates = getMatchCandidates(filePath, baseDir, true);
  return patterns.some(
    (pattern) => minimatch.match(candidates, normalizeNativePathSeparators(pattern)).length > 0,
  );
}

function normalizeExactPattern(pattern: string): string {
  const normalized =
    pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
  return normalizeNativePathSeparators(normalized);
}

function matchesAnyExactPattern(filePath: string, patterns: string[], baseDir: string): boolean {
  const candidates = new Set(getMatchCandidates(filePath, baseDir, false));
  return patterns.some((pattern) => candidates.has(normalizeExactPattern(pattern)));
}

function isEnabledByOverrides(filePath: string, patterns: string[], baseDir: string): boolean {
  return applyPatterns([filePath], patterns.filter(isOverridePattern), baseDir).has(filePath);
}

/**
 * Apply patterns to paths and return a Set of enabled paths.
 * Pattern types:
 * - Plain patterns: include matching paths
 * - `!pattern`: exclude matching paths
 * - `+path`: force-include exact path (overrides exclusions)
 * - `-path`: force-exclude exact path (overrides force-includes)
 */
function applyPatterns(allPaths: string[], patterns: string[], baseDir: string): Set<string> {
  const includes: string[] = [];
  const excludes: string[] = [];
  const forceIncludes: string[] = [];
  const forceExcludes: string[] = [];

  for (const p of patterns) {
    if (p.startsWith("+")) {
      forceIncludes.push(p.slice(1));
    } else if (p.startsWith("-")) {
      forceExcludes.push(p.slice(1));
    } else if (p.startsWith("!")) {
      excludes.push(p.slice(1));
    } else {
      includes.push(p);
    }
  }

  // Step 1: Apply includes (or all if no includes)
  let result: string[];
  if (includes.length === 0) {
    result = [...allPaths];
  } else {
    result = allPaths.filter((filePath) => matchesAnyPattern(filePath, includes, baseDir));
  }

  // Step 2: Apply excludes
  if (excludes.length > 0) {
    result = result.filter((filePath) => !matchesAnyPattern(filePath, excludes, baseDir));
  }

  // Step 3: Force-include (add back from allPaths, overriding exclusions)
  if (forceIncludes.length > 0) {
    for (const filePath of allPaths) {
      if (!result.includes(filePath) && matchesAnyExactPattern(filePath, forceIncludes, baseDir)) {
        result.push(filePath);
      }
    }
  }

  // Step 4: Force-exclude (remove even if included or force-included)
  if (forceExcludes.length > 0) {
    result = result.filter((filePath) => !matchesAnyExactPattern(filePath, forceExcludes, baseDir));
  }

  return new Set(result);
}

function getPackageFilter(pkg: PackageSource): PackageFilter | undefined {
  if (typeof pkg === "string") {
    return undefined;
  }
  return RESOURCE_TYPES.some((resourceType) => pkg[resourceType] !== undefined) ? pkg : undefined;
}

export class DefaultPackageManager implements PackageManager {
  private cwd: string;
  private agentDir: string;
  private settingsManager: SettingsManager;

  constructor(options: PackageManagerOptions) {
    this.cwd = options.cwd;
    this.agentDir = options.agentDir;
    this.settingsManager = options.settingsManager;
  }

  async resolve(
    onMissing?: (source: string) => Promise<MissingSourceAction>,
  ): Promise<ResolvedPaths> {
    const accumulator = this.createAccumulator();
    const globalSettings = this.settingsManager.getGlobalSettings();
    const projectSettings = this.settingsManager.getProjectSettings();

    // Collect all packages with scope (project first so cwd resources win collisions)
    const allPackages: Array<{ pkg: PackageSource; scope: SourceScope }> = [];
    for (const pkg of projectSettings.packages ?? []) {
      allPackages.push({ pkg, scope: "project" });
    }
    for (const pkg of globalSettings.packages ?? []) {
      allPackages.push({ pkg, scope: "user" });
    }

    // Dedupe: project scope wins over global for same package identity
    const packageSources = this.dedupePackages(allPackages);
    await this.resolvePackageSources(packageSources, accumulator, onMissing);

    const globalBaseDir = this.agentDir;
    const projectBaseDir = join(this.cwd, CONFIG_DIR_NAME);

    const localScopes = [
      { scope: "project", settings: projectSettings, baseDir: projectBaseDir },
      { scope: "user", settings: globalSettings, baseDir: globalBaseDir },
    ] as const;
    for (const resourceType of RESOURCE_TYPES) {
      for (const { scope, settings, baseDir } of localScopes) {
        this.resolveLocalEntries(
          settings[resourceType] ?? [],
          resourceType,
          accumulator[resourceType],
          { source: "local", scope, origin: "top-level" },
          baseDir,
        );
      }
    }

    this.addAutoDiscoveredResources(
      accumulator,
      globalSettings,
      projectSettings,
      globalBaseDir,
      projectBaseDir,
    );

    return this.toResolvedPaths(accumulator);
  }

  async resolveExtensionSources(
    sources: string[],
    options?: { local?: boolean; temporary?: boolean },
  ): Promise<ResolvedPaths> {
    const accumulator = this.createAccumulator();
    const scope: SourceScope = options?.temporary
      ? "temporary"
      : options?.local
        ? "project"
        : "user";
    const packageSources = sources.map((source) => ({ pkg: source as PackageSource, scope }));
    await this.resolvePackageSources(packageSources, accumulator);
    return this.toResolvedPaths(accumulator);
  }

  private async resolvePackageSources(
    sources: Array<{ pkg: PackageSource; scope: SourceScope }>,
    accumulator: ResourceAccumulator,
    onMissing?: (source: string) => Promise<MissingSourceAction>,
  ): Promise<void> {
    for (const { pkg, scope } of sources) {
      const sourceStr = typeof pkg === "string" ? pkg : pkg.source;
      const filter = getPackageFilter(pkg);
      const parsed = this.parseSource(sourceStr);
      const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };
      const target = this.resolvePackageTarget(parsed, scope);
      if (!target) {
        continue;
      }
      if (target.kind === "missing") {
        if (onMissing && (await onMissing(sourceStr)) === "error") {
          throw new Error(`Missing source: ${sourceStr}`);
        }
        continue;
      }

      metadata.baseDir = target.baseDir;
      if (target.kind === "file") {
        this.addResource(
          accumulator.extensions,
          target.path,
          metadata,
          this.isExtensionEnabled(target.path, filter?.extensions, target.baseDir),
        );
        continue;
      }

      const hasPackageLayout = this.collectPackageResources(
        target.path,
        accumulator,
        filter,
        metadata,
      );
      if (parsed.type === "local" && !hasPackageLayout) {
        this.addResource(
          accumulator.extensions,
          target.path,
          metadata,
          this.isExtensionEnabled(target.path, filter?.extensions, target.baseDir),
        );
      }
    }
  }

  private resolvePackageTarget(
    source: ParsedSource,
    scope: SourceScope,
  ): ResolvedPackageTarget | undefined {
    if (source.type === "npm") {
      const path = this.getNpmInstallPath(source, scope);
      return !existsSync(path) ||
        (source.pinned && !this.installedNpmMatchesPinnedVersion(source, path))
        ? { kind: "missing" }
        : { kind: "directory", path, baseDir: path };
    }
    if (source.type === "git") {
      const path = this.getGitInstallPath(source, scope);
      return existsSync(path) ? { kind: "directory", path, baseDir: path } : { kind: "missing" };
    }

    const path = this.resolvePathFromBase(source.path, this.getBaseDirForScope(scope));
    if (!existsSync(path)) {
      return { kind: "missing" };
    }
    try {
      const stats = statSync(path);
      if (stats.isFile()) {
        return { kind: "file", path, baseDir: dirname(path) };
      }
      if (stats.isDirectory()) {
        return { kind: "directory", path, baseDir: path };
      }
    } catch {}
    return undefined;
  }

  private isExtensionEnabled(
    path: string,
    patterns: string[] | undefined,
    baseDir: string,
  ): boolean {
    if (patterns === undefined) {
      return true;
    }
    return patterns.length > 0 && applyPatterns([path], patterns, baseDir).has(path);
  }

  private parseSource(source: string): ParsedSource {
    if (source.startsWith("npm:")) {
      const spec = source.slice("npm:".length).trim();
      const { name, version } = this.parseNpmSpec(spec);
      return {
        type: "npm",
        spec,
        name,
        pinned: Boolean(version),
      };
    }

    if (isLocalPath(source)) {
      return { type: "local", path: source };
    }

    // Try parsing as git URL
    const gitParsed = parseGitUrl(source);
    if (gitParsed) {
      return gitParsed;
    }

    return { type: "local", path: source };
  }

  private installedNpmMatchesPinnedVersion(source: NpmSource, installedPath: string): boolean {
    const installedVersion = this.getInstalledNpmVersion(installedPath);
    if (!installedVersion) {
      return false;
    }

    const { version: pinnedVersion } = this.parseNpmSpec(source.spec);
    if (!pinnedVersion) {
      return true;
    }

    return installedVersion === pinnedVersion;
  }

  private getInstalledNpmVersion(installedPath: string): string | undefined {
    const packageJsonPath = join(installedPath, "package.json");
    if (!existsSync(packageJsonPath)) {
      return undefined;
    }
    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content) as { version?: string };
      return pkg.version;
    } catch {
      return undefined;
    }
  }

  /**
   * Get a unique identity for a package, ignoring version/ref.
   * Used to detect when the same package is in both global and project settings.
   * For git packages, uses normalized host/path to ensure SSH and HTTPS URLs
   * for the same repository are treated as identical.
   */
  private getPackageIdentity(source: string, scope?: SourceScope): string {
    const parsed = this.parseSource(source);
    if (parsed.type === "npm") {
      return `npm:${parsed.name}`;
    }
    if (parsed.type === "git") {
      // Use host/path for identity to normalize SSH and HTTPS
      return `git:${parsed.host}/${parsed.path}`;
    }
    if (scope) {
      const baseDir = this.getBaseDirForScope(scope);
      return `local:${this.resolvePathFromBase(parsed.path, baseDir)}`;
    }
    return `local:${this.resolvePath(parsed.path)}`;
  }

  /**
   * Dedupe packages: if same package identity appears in both global and project,
   * keep only the project one (project wins).
   */
  private dedupePackages(
    packages: Array<{ pkg: PackageSource; scope: SourceScope }>,
  ): Array<{ pkg: PackageSource; scope: SourceScope }> {
    const seen = new Map<string, { pkg: PackageSource; scope: SourceScope }>();

    for (const entry of packages) {
      const sourceStr = typeof entry.pkg === "string" ? entry.pkg : entry.pkg.source;
      const identity = this.getPackageIdentity(sourceStr, entry.scope);

      const existing = seen.get(identity);
      if (!existing) {
        seen.set(identity, entry);
      } else if (entry.scope === "project" && existing.scope === "user") {
        // Project wins over user
        seen.set(identity, entry);
      }
      // If existing is project and new is global, keep existing (project)
      // If both are same scope, keep first one
    }

    return Array.from(seen.values());
  }

  private parseNpmSpec(spec: string): { name: string; version?: string } {
    const match = spec.match(/^(@?[^@]+(?:\/[^@]+)?)(?:@(.+))?$/);
    if (!match) {
      return { name: spec };
    }
    const name = match[1] ?? spec;
    const version = match[2];
    return { name, version };
  }

  private getNpmInstallPath(source: NpmSource, scope: SourceScope): string {
    if (scope === "temporary") {
      return join(this.getTemporaryDir("npm"), "node_modules", source.name);
    }
    if (scope === "project") {
      return join(this.cwd, CONFIG_DIR_NAME, "npm", "node_modules", source.name);
    }
    return join(this.agentDir, "npm", "node_modules", source.name);
  }

  private getGitInstallPath(source: GitSource, scope: SourceScope): string {
    if (scope === "temporary") {
      return this.getTemporaryDir(`git-${source.host}`, source.path);
    }
    if (scope === "project") {
      return join(this.cwd, CONFIG_DIR_NAME, "git", source.host, source.path);
    }
    return join(this.agentDir, "git", source.host, source.path);
  }

  private getTemporaryDir(prefix: string, suffix?: string): string {
    const hash = createHash("sha256")
      .update(`${prefix}-${suffix ?? ""}`)
      .digest("hex")
      .slice(0, 8);
    return join(getAgentResourceTempDir(this.agentDir), prefix, hash, suffix ?? "");
  }

  private getBaseDirForScope(scope: SourceScope): string {
    if (scope === "project") {
      return join(this.cwd, CONFIG_DIR_NAME);
    }
    if (scope === "user") {
      return this.agentDir;
    }
    return this.cwd;
  }

  private resolvePath(input: string): string {
    const trimmed = input.trim();
    if (trimmed === "~") {
      return getHomeDir();
    }
    if (trimmed.startsWith("~/")) {
      return join(getHomeDir(), trimmed.slice(2));
    }
    if (trimmed.startsWith("~")) {
      return join(getHomeDir(), trimmed.slice(1));
    }
    return resolve(this.cwd, trimmed);
  }

  private resolvePathFromBase(input: string, baseDir: string): string {
    const trimmed = input.trim();
    if (trimmed === "~") {
      return getHomeDir();
    }
    if (trimmed.startsWith("~/")) {
      return join(getHomeDir(), trimmed.slice(2));
    }
    if (trimmed.startsWith("~")) {
      return join(getHomeDir(), trimmed.slice(1));
    }
    return resolve(baseDir, trimmed);
  }

  private collectPackageResources(
    packageRoot: string,
    accumulator: ResourceAccumulator,
    filter: PackageFilter | undefined,
    metadata: PathMetadata,
  ): boolean {
    const manifest = readResourceManifestFile(join(packageRoot, "package.json"));
    const hasPackageLayout =
      manifest !== null || RESOURCE_TYPES.some((type) => existsSync(join(packageRoot, type)));
    for (const resourceType of RESOURCE_TYPES) {
      const patterns = filter?.[resourceType];
      const target = accumulator[resourceType];
      if (patterns !== undefined) {
        this.applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
        continue;
      }
      const entries = manifest?.[resourceType];
      if (manifest !== null && (!filter || entries !== undefined)) {
        this.addManifestEntries(entries, packageRoot, resourceType, target, metadata);
        continue;
      }
      const dir = join(packageRoot, resourceType);
      if (existsSync(dir)) {
        for (const path of this.collectConventionResourceFiles(packageRoot, resourceType)) {
          this.addResource(target, path, metadata, true);
        }
      }
    }
    return hasPackageLayout;
  }

  private applyPackageFilter(
    packageRoot: string,
    userPatterns: string[],
    resourceType: ResourceType,
    target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
    metadata: PathMetadata,
  ): void {
    const allFiles = this.collectManifestFiles(packageRoot, resourceType);

    if (userPatterns.length === 0) {
      // Empty array explicitly disables all resources of this type
      for (const f of allFiles) {
        this.addResource(target, f, metadata, false);
      }
      return;
    }

    // Apply user patterns
    const enabledByUser = applyPatterns(allFiles, userPatterns, packageRoot);

    for (const f of allFiles) {
      const enabled = enabledByUser.has(f);
      this.addResource(target, f, metadata, enabled);
    }
  }

  private collectManifestFiles(packageRoot: string, resourceType: ResourceType): string[] {
    const manifest = readResourceManifestFile(join(packageRoot, "package.json"));
    const entries = manifest?.[resourceType];
    if (entries && entries.length > 0) {
      const allFiles = this.collectFilesFromManifestEntries(entries, packageRoot, resourceType);
      const manifestPatterns = entries.filter(isOverridePattern);
      return Array.from(
        manifestPatterns.length > 0
          ? applyPatterns(allFiles, manifestPatterns, packageRoot)
          : new Set(allFiles),
      );
    }

    return this.collectConventionResourceFiles(packageRoot, resourceType);
  }

  private collectConventionResourceFiles(
    packageRoot: string,
    resourceType: ResourceType,
  ): string[] {
    const conventionDir = join(packageRoot, resourceType);
    if (!existsSync(conventionDir)) {
      return [];
    }
    return this.filterManifestResourcePaths(
      collectResourceFiles(conventionDir, resourceType),
      packageRoot,
    );
  }

  private addManifestEntries(
    entries: string[] | undefined,
    root: string,
    resourceType: ResourceType,
    target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
    metadata: PathMetadata,
  ): void {
    if (!entries) {
      return;
    }

    const allFiles = this.collectFilesFromManifestEntries(entries, root, resourceType);
    const patterns = entries.filter(isOverridePattern);
    const enabledPaths = applyPatterns(allFiles, patterns, root);

    for (const f of allFiles) {
      if (enabledPaths.has(f)) {
        this.addResource(target, f, metadata, true);
      }
    }
  }

  private collectFilesFromManifestEntries(
    entries: string[],
    root: string,
    resourceType: ResourceType,
  ): string[] {
    const sourceEntries = entries.filter((entry) => !isOverridePattern(entry));
    const resolved = sourceEntries.flatMap((entry) => {
      if (!hasGlobPattern(entry)) {
        return [resolve(root, entry)];
      }

      // The supported Node floor has stable fs globbing; its defaults exclude
      // hidden paths and retain directories, matching package manifests.
      return globSync(entry, { cwd: root }).map((match) => resolve(root, match));
    });
    return this.collectFilesFromPaths(
      this.filterManifestResourcePaths(resolved, root),
      resourceType,
    );
  }

  private filterManifestResourcePaths(paths: string[], root: string): string[] {
    const resolvedRoot = resolve(root);
    const realRoot = resolveRealPathIfPossible(resolvedRoot);
    return paths.filter((path) => {
      const resolvedPath = resolve(path);
      if (!isPathInside(resolvedRoot, resolvedPath)) {
        return false;
      }
      return isPathInside(realRoot, resolveRealPathIfPossible(resolvedPath));
    });
  }

  private resolveLocalEntries(
    entries: string[],
    resourceType: ResourceType,
    target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
    metadata: PathMetadata,
    baseDir: string,
  ): void {
    if (entries.length === 0) {
      return;
    }

    // Collect all files from plain entries (non-pattern entries)
    const { plain, patterns } = splitPatterns(entries);
    const resolvedPlain = plain.map((p) => this.resolvePathFromBase(p, baseDir));
    const allFiles = this.collectFilesFromPaths(resolvedPlain, resourceType);

    // Determine which files are enabled based on patterns
    const enabledPaths = applyPatterns(allFiles, patterns, baseDir);

    // Add all files with their enabled state
    for (const f of allFiles) {
      this.addResource(target, f, metadata, enabledPaths.has(f));
    }
  }

  private addAutoDiscoveredResources(
    accumulator: ResourceAccumulator,
    globalSettings: ReturnType<SettingsManager["getGlobalSettings"]>,
    projectSettings: ReturnType<SettingsManager["getProjectSettings"]>,
    globalBaseDir: string,
    projectBaseDir: string,
  ): void {
    const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
    const projectAgentsSkillDirs = collectAncestorAgentsSkillDirs(this.cwd).filter(
      (dir) => resolve(dir) !== resolve(userAgentsSkillsDir),
    );
    const addScopeResources = (options: {
      scope: Extract<SourceScope, "project" | "user">;
      settings: ReturnType<SettingsManager["getGlobalSettings"]>;
      baseDir: string;
      agentsSkillDirs: string[];
    }): void => {
      const metadata: PathMetadata = {
        source: "auto",
        scope: options.scope,
        origin: "top-level",
        baseDir: options.baseDir,
      };
      const addResources = (
        resourceType: ResourceType,
        paths: string[],
        resourceMetadata = metadata,
        patternBaseDir = options.baseDir,
      ): void => {
        for (const path of paths) {
          this.addResource(
            accumulator[resourceType],
            path,
            resourceMetadata,
            isEnabledByOverrides(path, options.settings[resourceType] ?? [], patternBaseDir),
          );
        }
      };

      for (const resourceType of RESOURCE_TYPES) {
        addResources(
          resourceType,
          AUTO_RESOURCE_COLLECTORS[resourceType](join(options.baseDir, resourceType)),
        );
        if (resourceType !== "skills") {
          continue;
        }
        // .agents roots use different traversal and pattern bases; flattening them
        // into the ordinary skill directory would weaken containment and overrides.
        for (const skillsDir of options.agentsSkillDirs) {
          const agentsBaseDir = dirname(skillsDir);
          addResources(
            "skills",
            collectAutoSkillEntries(skillsDir, "agents"),
            { ...metadata, baseDir: agentsBaseDir },
            agentsBaseDir,
          );
        }
      }
    };

    addScopeResources({
      scope: "project",
      settings: projectSettings,
      baseDir: projectBaseDir,
      agentsSkillDirs: projectAgentsSkillDirs,
    });
    addScopeResources({
      scope: "user",
      settings: globalSettings,
      baseDir: globalBaseDir,
      // Home-scoped personal skills belong only to the default install.
      agentsSkillDirs: isDefaultStateDir() ? [userAgentsSkillsDir] : [],
    });
  }

  private collectFilesFromPaths(paths: string[], resourceType: ResourceType): string[] {
    const files: string[] = [];
    for (const p of paths) {
      if (!existsSync(p)) {
        continue;
      }

      try {
        const stats = statSync(p);
        if (stats.isFile()) {
          files.push(p);
        } else if (stats.isDirectory()) {
          files.push(...collectResourceFiles(p, resourceType));
        }
      } catch {
        // Ignore errors
      }
    }
    return files;
  }

  private addResource(
    map: Map<string, { metadata: PathMetadata; enabled: boolean }>,
    path: string,
    metadata: PathMetadata,
    enabled: boolean,
  ): void {
    if (!path) {
      return;
    }
    if (!map.has(path)) {
      map.set(path, { metadata, enabled });
    }
  }

  private createAccumulator(): ResourceAccumulator {
    return {
      extensions: new Map(),
      skills: new Map(),
      prompts: new Map(),
      themes: new Map(),
    };
  }

  private toResolvedPaths(accumulator: ResourceAccumulator): ResolvedPaths {
    const mapToResolved = (
      entries: Map<string, { metadata: PathMetadata; enabled: boolean }>,
    ): ResolvedResource[] => {
      const resolved = Array.from(entries.entries()).map(([path, { metadata, enabled }]) => ({
        path,
        enabled,
        metadata,
      }));
      resolved.sort(
        (a, b) => resourcePrecedenceRank(a.metadata) - resourcePrecedenceRank(b.metadata),
      );

      const seen = new Set<string>();
      return resolved.filter((entry) => {
        const canonicalPath = canonicalizePath(entry.path);
        if (seen.has(canonicalPath)) {
          return false;
        }
        seen.add(canonicalPath);
        return true;
      });
    };

    return {
      extensions: mapToResolved(accumulator.extensions),
      skills: mapToResolved(accumulator.skills),
      prompts: mapToResolved(accumulator.prompts),
      themes: mapToResolved(accumulator.themes),
    };
  }
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
