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
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { minimatch } from "minimatch";
import { addIgnoreRules, toPosixPath, type IgnoreMatcher } from "../../shared/ignore-rules.js";
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

interface ResourceAccumulator {
  extensions: Map<string, { metadata: PathMetadata; enabled: boolean }>;
  skills: Map<string, { metadata: PathMetadata; enabled: boolean }>;
  prompts: Map<string, { metadata: PathMetadata; enabled: boolean }>;
  themes: Map<string, { metadata: PathMetadata; enabled: boolean }>;
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

const RESOURCE_TYPES: ResourceType[] = ["extensions", "skills", "prompts", "themes"];

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

      const relPath = toPosixPath(relative(root, fullPath));
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

      const relPath = toPosixPath(relative(root, fullPath));
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

      const relPath = toPosixPath(relative(root, fullPath));
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

      const relPath = toPosixPath(relative(dir, fullPath));
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

      const relPath = toPosixPath(relative(dir, fullPath));
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

function resolveRealPathIfPossible(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

function isPathWithinRoot(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel));
}

function isRealPathWithinRoot(root: string, candidate: string): boolean {
  return isPathWithinRoot(
    resolveRealPathIfPossible(resolve(root)),
    resolveRealPathIfPossible(candidate),
  );
}

function getMatchCandidates(filePath: string, baseDir: string, includeNames: boolean): string[] {
  const name = basename(filePath);
  const candidates = [toPosixPath(relative(baseDir, filePath)), toPosixPath(filePath)];
  if (includeNames) {
    candidates.push(name);
  }
  if (name === "SKILL.md") {
    const parentDir = dirname(filePath);
    candidates.push(toPosixPath(relative(baseDir, parentDir)), toPosixPath(parentDir));
    if (includeNames) {
      candidates.push(basename(parentDir));
    }
  }
  return candidates;
}

function matchesAnyPattern(filePath: string, patterns: string[], baseDir: string): boolean {
  const candidates = getMatchCandidates(filePath, baseDir, true);
  return patterns.some((pattern) => minimatch.match(candidates, toPosixPath(pattern)).length > 0);
}

function normalizeExactPattern(pattern: string): string {
  const normalized =
    pattern.startsWith("./") || pattern.startsWith(".\\") ? pattern.slice(2) : pattern;
  return toPosixPath(normalized);
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

    for (const resourceType of RESOURCE_TYPES) {
      const target = this.getTargetMap(accumulator, resourceType);
      const globalEntries = globalSettings[resourceType] ?? [];
      const projectEntries = projectSettings[resourceType] ?? [];
      this.resolveLocalEntries(
        projectEntries,
        resourceType,
        target,
        {
          source: "local",
          scope: "project",
          origin: "top-level",
        },
        projectBaseDir,
      );
      this.resolveLocalEntries(
        globalEntries,
        resourceType,
        target,
        {
          source: "local",
          scope: "user",
          origin: "top-level",
        },
        globalBaseDir,
      );
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
      const filter = typeof pkg === "object" ? pkg : undefined;
      const parsed = this.parseSource(sourceStr);
      const metadata: PathMetadata = { source: sourceStr, scope, origin: "package" };

      if (parsed.type === "local") {
        const baseDir = this.getBaseDirForScope(scope);
        this.resolveLocalExtensionSource(parsed, accumulator, filter, metadata, baseDir);
        continue;
      }

      const handleMissing = async (): Promise<void> => {
        if (!onMissing) {
          return;
        }
        const action = await onMissing(sourceStr);
        if (action === "error") {
          throw new Error(`Missing source: ${sourceStr}`);
        }
      };

      if (parsed.type === "npm") {
        const installedPath = this.getNpmInstallPath(parsed, scope);
        const missingOrWrongVersion =
          !existsSync(installedPath) ||
          (parsed.pinned && !this.installedNpmMatchesPinnedVersion(parsed, installedPath));
        if (missingOrWrongVersion) {
          await handleMissing();
          continue;
        }
        metadata.baseDir = installedPath;
        this.collectPackageResources(installedPath, accumulator, filter, metadata);
        continue;
      }

      if (parsed.type === "git") {
        const installedPath = this.getGitInstallPath(parsed, scope);
        if (!existsSync(installedPath)) {
          await handleMissing();
          continue;
        }
        metadata.baseDir = installedPath;
        this.collectPackageResources(installedPath, accumulator, filter, metadata);
      }
    }
  }

  private resolveLocalExtensionSource(
    source: LocalSource,
    accumulator: ResourceAccumulator,
    filter: PackageFilter | undefined,
    metadata: PathMetadata,
    baseDir: string,
  ): void {
    const resolved = this.resolvePathFromBase(source.path, baseDir);
    if (!existsSync(resolved)) {
      return;
    }

    try {
      const stats = statSync(resolved);
      if (stats.isFile()) {
        metadata.baseDir = dirname(resolved);
        this.addResource(accumulator.extensions, resolved, metadata, true);
        return;
      }
      if (stats.isDirectory()) {
        metadata.baseDir = resolved;
        const resources = this.collectPackageResources(resolved, accumulator, filter, metadata);
        if (!resources) {
          this.addResource(accumulator.extensions, resolved, metadata, true);
        }
      }
    } catch {}
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
    if (filter) {
      for (const resourceType of RESOURCE_TYPES) {
        const patterns = filter[resourceType as keyof PackageFilter];
        const target = this.getTargetMap(accumulator, resourceType);
        if (patterns !== undefined) {
          this.applyPackageFilter(packageRoot, patterns, resourceType, target, metadata);
        } else {
          this.collectDefaultResources(packageRoot, resourceType, target, metadata);
        }
      }
      return true;
    }

    const manifest = this.readResourceManifest(packageRoot);
    if (manifest) {
      for (const resourceType of RESOURCE_TYPES) {
        const entries = manifest[resourceType as keyof ResourceManifest];
        this.addManifestEntries(
          entries,
          packageRoot,
          resourceType,
          this.getTargetMap(accumulator, resourceType),
          metadata,
        );
      }
      return true;
    }

    let hasAnyDir = false;
    for (const resourceType of RESOURCE_TYPES) {
      const dir = join(packageRoot, resourceType);
      if (existsSync(dir)) {
        // Collect all files from the directory (all enabled by default)
        const files = this.collectConventionResourceFiles(packageRoot, resourceType);
        for (const f of files) {
          this.addResource(this.getTargetMap(accumulator, resourceType), f, metadata, true);
        }
        hasAnyDir = true;
      }
    }
    return hasAnyDir;
  }

  private collectDefaultResources(
    packageRoot: string,
    resourceType: ResourceType,
    target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
    metadata: PathMetadata,
  ): void {
    const manifest = this.readResourceManifest(packageRoot);
    const entries = manifest?.[resourceType as keyof ResourceManifest];
    if (entries) {
      this.addManifestEntries(entries, packageRoot, resourceType, target, metadata);
      return;
    }
    const dir = join(packageRoot, resourceType);
    if (existsSync(dir)) {
      // Collect all files from the directory (all enabled by default)
      const files = this.collectConventionResourceFiles(packageRoot, resourceType);
      for (const f of files) {
        this.addResource(target, f, metadata, true);
      }
    }
  }

  private applyPackageFilter(
    packageRoot: string,
    userPatterns: string[],
    resourceType: ResourceType,
    target: Map<string, { metadata: PathMetadata; enabled: boolean }>,
    metadata: PathMetadata,
  ): void {
    const { allFiles } = this.collectManifestFiles(packageRoot, resourceType);

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

  /**
   * Collect all files from a package for a resource type, applying manifest patterns.
   * Returns { allFiles, enabledByManifest } where enabledByManifest is the set of files
   * that pass the manifest's own patterns.
   */
  private collectManifestFiles(
    packageRoot: string,
    resourceType: ResourceType,
  ): { allFiles: string[]; enabledByManifest: Set<string> } {
    const manifest = this.readResourceManifest(packageRoot);
    const entries = manifest?.[resourceType as keyof ResourceManifest];
    if (entries && entries.length > 0) {
      const allFiles = this.collectFilesFromManifestEntries(entries, packageRoot, resourceType);
      const manifestPatterns = entries.filter(isOverridePattern);
      const enabledByManifest =
        manifestPatterns.length > 0
          ? applyPatterns(allFiles, manifestPatterns, packageRoot)
          : new Set(allFiles);
      return { allFiles: Array.from(enabledByManifest), enabledByManifest };
    }

    const allFiles = this.collectConventionResourceFiles(packageRoot, resourceType);
    return { allFiles, enabledByManifest: new Set(allFiles) };
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

  private readResourceManifest(packageRoot: string): ResourceManifest | null {
    const packageJsonPath = join(packageRoot, "package.json");
    if (!existsSync(packageJsonPath)) {
      return null;
    }

    try {
      const content = readFileSync(packageJsonPath, "utf-8");
      const pkg = JSON.parse(content) as { openclaw?: ResourceManifest };
      return pkg.openclaw ?? null;
    } catch {
      return null;
    }
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
      if (!isPathWithinRoot(resolvedRoot, resolvedPath)) {
        return false;
      }
      return isPathWithinRoot(realRoot, resolveRealPathIfPossible(resolvedPath));
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
    const userMetadata: PathMetadata = {
      source: "auto",
      scope: "user",
      origin: "top-level",
      baseDir: globalBaseDir,
    };
    const projectMetadata: PathMetadata = {
      source: "auto",
      scope: "project",
      origin: "top-level",
      baseDir: projectBaseDir,
    };

    const userOverrides = {
      extensions: globalSettings.extensions ?? [],
      skills: globalSettings.skills ?? [],
      prompts: globalSettings.prompts ?? [],
      themes: globalSettings.themes ?? [],
    };
    const projectOverrides = {
      extensions: projectSettings.extensions ?? [],
      skills: projectSettings.skills ?? [],
      prompts: projectSettings.prompts ?? [],
      themes: projectSettings.themes ?? [],
    };

    const userDirs = {
      extensions: join(globalBaseDir, "extensions"),
      skills: join(globalBaseDir, "skills"),
      prompts: join(globalBaseDir, "prompts"),
      themes: join(globalBaseDir, "themes"),
    };
    const projectDirs = {
      extensions: join(projectBaseDir, "extensions"),
      skills: join(projectBaseDir, "skills"),
      prompts: join(projectBaseDir, "prompts"),
      themes: join(projectBaseDir, "themes"),
    };
    const userAgentsSkillsDir = join(getHomeDir(), ".agents", "skills");
    const projectAgentsSkillDirs = collectAncestorAgentsSkillDirs(this.cwd).filter(
      (dir) => resolve(dir) !== resolve(userAgentsSkillsDir),
    );

    const addResources = (
      resourceType: ResourceType,
      paths: string[],
      metadata: PathMetadata,
      overrides: string[],
      baseDir: string,
    ) => {
      const target = this.getTargetMap(accumulator, resourceType);
      for (const path of paths) {
        const enabled = isEnabledByOverrides(path, overrides, baseDir);
        this.addResource(target, path, metadata, enabled);
      }
    };

    // Project extensions from the embedded agent project directory.
    addResources(
      "extensions",
      collectAutoExtensionEntries(projectDirs.extensions),
      projectMetadata,
      projectOverrides.extensions,
      projectBaseDir,
    );

    // Project skills from the embedded agent project directory.
    addResources(
      "skills",
      collectAutoSkillEntries(projectDirs.skills, "openclaw"),
      projectMetadata,
      projectOverrides.skills,
      projectBaseDir,
    );

    // Project skills from .agents/ (each with its own baseDir)
    for (const agentsSkillsDir of projectAgentsSkillDirs) {
      const agentsBaseDir = dirname(agentsSkillsDir); // the .agents directory
      const agentsMetadata: PathMetadata = {
        ...projectMetadata,
        baseDir: agentsBaseDir,
      };
      addResources(
        "skills",
        collectAutoSkillEntries(agentsSkillsDir, "agents"),
        agentsMetadata,
        projectOverrides.skills,
        agentsBaseDir,
      );
    }

    addResources(
      "prompts",
      collectTopLevelAutoResourceEntries(projectDirs.prompts, "prompts"),
      projectMetadata,
      projectOverrides.prompts,
      projectBaseDir,
    );
    addResources(
      "themes",
      collectTopLevelAutoResourceEntries(projectDirs.themes, "themes"),
      projectMetadata,
      projectOverrides.themes,
      projectBaseDir,
    );

    // User extensions from ~/.openclaw/agent/
    addResources(
      "extensions",
      collectAutoExtensionEntries(userDirs.extensions),
      userMetadata,
      userOverrides.extensions,
      globalBaseDir,
    );

    // User skills from ~/.openclaw/agent/
    addResources(
      "skills",
      collectAutoSkillEntries(userDirs.skills, "openclaw"),
      userMetadata,
      userOverrides.skills,
      globalBaseDir,
    );

    // User skills from ~/.agents/ (with its own baseDir)
    const userAgentsBaseDir = dirname(userAgentsSkillsDir);
    const userAgentsMetadata: PathMetadata = {
      ...userMetadata,
      baseDir: userAgentsBaseDir,
    };
    addResources(
      "skills",
      collectAutoSkillEntries(userAgentsSkillsDir, "agents"),
      userAgentsMetadata,
      userOverrides.skills,
      userAgentsBaseDir,
    );

    addResources(
      "prompts",
      collectTopLevelAutoResourceEntries(userDirs.prompts, "prompts"),
      userMetadata,
      userOverrides.prompts,
      globalBaseDir,
    );
    addResources(
      "themes",
      collectTopLevelAutoResourceEntries(userDirs.themes, "themes"),
      userMetadata,
      userOverrides.themes,
      globalBaseDir,
    );
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

  private getTargetMap(
    accumulator: ResourceAccumulator,
    resourceType: ResourceType,
  ): Map<string, { metadata: PathMetadata; enabled: boolean }> {
    switch (resourceType) {
      case "extensions":
        return accumulator.extensions;
      case "skills":
        return accumulator.skills;
      case "prompts":
        return accumulator.prompts;
      case "themes":
        return accumulator.themes;
      default:
        throw new Error(`Unknown resource type: ${String(resourceType)}`);
    }
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
