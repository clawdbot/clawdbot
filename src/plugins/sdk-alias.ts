// Resolves plugin SDK aliases for public package imports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { formatErrorMessage } from "../infra/errors.js";
import { resolveRequiredHomeDir } from "../infra/home-dir.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolveOpenClawDevSourceRoot } from "./dev-source-root.js";
import {
  parsePluginCacheJson,
  pluginCacheExistsSync,
  pluginCacheRealpathSync,
  pluginCacheStatSync,
  readPluginCacheDirectory,
  readPluginCacheFile,
} from "./plugin-cache-files.js";
import {
  getPluginSdkHostFacts,
  type PluginRuntimeModuleResolution,
  type PluginSdkPackageJson,
  type WorkspacePackageAliasEntry,
} from "./plugin-cache-sdk.js";
import { getPluginCache } from "./plugin-cache.js";

type PluginSdkAliasCandidateKind = "dist" | "src";
export type PluginSdkResolutionPreference = "auto" | "dist" | "src";

type LoaderModuleResolveParams = {
  modulePath?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
};

export type { PluginRuntimeModuleResolution } from "./plugin-cache-sdk.js";

const STARTUP_ARGV1 = process.argv[1];

function sdkHost(packageRoot: string) {
  return getPluginSdkHostFacts(getPluginCache().sdk, path.resolve(packageRoot));
}

function sdkAliasFacts(aliasMap: Record<string, string>) {
  const cache = getPluginCache().sdk.aliasFacts;
  let facts = cache.get(aliasMap);
  if (!facts) {
    facts = {};
    cache.set(aliasMap, facts);
  }
  return facts;
}

function readSdkJsonFile(filePath: string): unknown {
  const file = readPluginCacheFile({
    rootDir: path.dirname(filePath),
    relativePath: path.basename(filePath),
    rejectHardlinks: false,
  });
  const parsed = file.ok ? parsePluginCacheJson(file) : undefined;
  return parsed?.ok ? parsed.value : null;
}

function sanitizeJitiCachePathSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

function resolveJitiFsCacheRoot(): string {
  const xdgCacheHome = process.env.XDG_CACHE_HOME?.trim();
  if (xdgCacheHome && path.isAbsolute(xdgCacheHome)) {
    return xdgCacheHome;
  }
  const homeDir = resolveRequiredHomeDir(process.env, os.homedir);
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA?.trim();
    return localAppData && path.isAbsolute(localAppData)
      ? localAppData
      : path.join(homeDir, "AppData", "Local");
  }
  return process.platform === "darwin"
    ? path.join(homeDir, "Library", "Caches")
    : path.join(homeDir, ".cache");
}

function readJitiBooleanEnv(name: string, defaultValue: boolean): boolean {
  if (!(name in process.env)) {
    return defaultValue;
  }
  try {
    return Boolean(JSON.parse(process.env[name] ?? ""));
  } catch {
    return defaultValue;
  }
}

function shouldUseJitiFsCache(): boolean {
  return readJitiBooleanEnv("JITI_FS_CACHE", readJitiBooleanEnv("JITI_CACHE", true));
}

function resolvePluginLoaderJitiNativeModules(): string[] {
  try {
    const configured: unknown = JSON.parse(process.env.JITI_NATIVE_MODULES ?? "[]");
    const nativeModules = Array.isArray(configured)
      ? configured.filter((entry): entry is string => typeof entry === "string")
      : [];
    return [...new Set([...nativeModules, "openclaw"])];
  } catch {
    return ["openclaw"];
  }
}

function normalizeJitiAliasTargetPath(targetPath: string): string {
  return process.platform === "win32" ? targetPath.replace(/\\/g, "/") : targetPath;
}

function resolveLoaderModulePath(params: LoaderModuleResolveParams = {}): string {
  return params.modulePath ?? fileURLToPath(params.moduleUrl ?? import.meta.url);
}

function readPluginSdkPackageJson(packageRoot: string): PluginSdkPackageJson | null {
  const facts = sdkHost(packageRoot);
  if (facts.packageJson !== undefined) {
    return facts.packageJson;
  }
  const parsed = readSdkJsonFile(path.join(packageRoot, "package.json"));
  facts.packageJson = isRecord(parsed)
    ? {
        ...(typeof parsed.name === "string" ? { name: parsed.name } : {}),
        ...(isRecord(parsed.exports) ? { exports: parsed.exports } : {}),
        ...(typeof parsed.bin === "string" || isRecord(parsed.bin) ? { bin: parsed.bin } : {}),
        ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
      }
    : null;
  return facts.packageJson;
}

function resolveJitiCacheModulePath(params: LoaderModuleResolveParams = {}): string {
  if (params.modulePath?.startsWith("file://")) {
    try {
      return fileURLToPath(params.modulePath);
    } catch {
      // Fall through to the shared module resolver for malformed test inputs.
    }
  }
  return resolveLoaderModulePath(params);
}

function resolvePluginLoaderJitiFsCacheDir(params: LoaderModuleResolveParams = {}): string {
  const modulePath = resolveJitiCacheModulePath(params);
  const packageRoot =
    resolveLoaderPackageRoot({ ...params, modulePath }) ?? path.dirname(modulePath);
  const packageJsonPath = path.join(packageRoot, "package.json");
  const version = sanitizeJitiCachePathSegment(
    readPluginSdkPackageJson(packageRoot)?.version ?? "unknown",
  );
  let installMarker = "no-package-json";
  const stat = pluginCacheStatSync(packageJsonPath);
  if (stat) {
    installMarker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
  }
  return path.join(
    resolveJitiFsCacheRoot(),
    "openclaw",
    "jiti",
    version,
    sanitizeJitiCachePathSegment(installMarker),
  );
}

function resolvePluginLoaderJitiFsCacheOption(
  params: LoaderModuleResolveParams = {},
): false | string {
  return shouldUseJitiFsCache() ? resolvePluginLoaderJitiFsCacheDir(params) : false;
}

function isSafePluginSdkSubpathSegment(subpath: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath);
}

function listPluginSdkSubpathsFromPackageJson(pkg: PluginSdkPackageJson): string[] {
  return Object.keys(pkg.exports ?? {})
    .filter((key) => key.startsWith("./plugin-sdk/"))
    .map((key) => key.slice("./plugin-sdk/".length))
    .filter((subpath) => isSafePluginSdkSubpathSegment(subpath))
    .toSorted();
}

function hasTrustedOpenClawRootIndicator(params: {
  packageRoot: string;
  packageJson: PluginSdkPackageJson;
}): boolean {
  const facts = sdkHost(params.packageRoot);
  if (facts.trustedRoot !== undefined) {
    return facts.trustedRoot;
  }
  const packageExports = params.packageJson.exports ?? {};
  const hasPluginSdkSubpathExport = Object.keys(packageExports).some((key) =>
    key.startsWith("./plugin-sdk/"),
  );
  if (!hasPluginSdkSubpathExport) {
    return (facts.trustedRoot = false);
  }
  const hasCliEntryExport = Object.hasOwn(packageExports, "./cli-entry");
  const hasOpenClawBin =
    (typeof params.packageJson.bin === "string" &&
      normalizeLowercaseStringOrEmpty(params.packageJson.bin).includes("openclaw")) ||
    (typeof params.packageJson.bin === "object" &&
      params.packageJson.bin !== null &&
      typeof params.packageJson.bin.openclaw === "string");
  return (facts.trustedRoot =
    hasCliEntryExport ||
    hasOpenClawBin ||
    pluginCacheExistsSync(path.join(params.packageRoot, "openclaw.mjs")));
}

function readPluginSdkSubpathsFromPackageRoot(packageRoot: string): string[] | null {
  const facts = sdkHost(packageRoot);
  if (facts.exportedSubpaths !== undefined) {
    return facts.exportedSubpaths;
  }
  const pkg = readPluginSdkPackageJson(packageRoot);
  if (!pkg) {
    return (facts.exportedSubpaths = null);
  }
  if (!hasTrustedOpenClawRootIndicator({ packageRoot, packageJson: pkg })) {
    return (facts.exportedSubpaths = null);
  }
  const subpaths = listPluginSdkSubpathsFromPackageJson(pkg);
  return (facts.exportedSubpaths = subpaths.length > 0 ? subpaths : null);
}

function resolveTrustedOpenClawRootFromArgvHint(params: {
  argv1?: string;
  cwd: string;
}): string | null {
  if (!params.argv1) {
    return null;
  }
  const packageRoot = resolveOpenClawPackageRootSync({
    cwd: params.cwd,
    argv1: params.argv1,
  });
  if (!packageRoot) {
    return null;
  }
  const packageJson = readPluginSdkPackageJson(packageRoot);
  if (!packageJson) {
    return null;
  }
  return hasTrustedOpenClawRootIndicator({ packageRoot, packageJson }) ? packageRoot : null;
}

function findNearestPluginSdkPackageRoot(startDir: string, maxDepth = 12): string | null {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < maxDepth; i += 1) {
    const subpaths = readPluginSdkSubpathsFromPackageRoot(cursor);
    if (subpaths) {
      return cursor;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

export function resolveLoaderPackageRoot(
  params: LoaderModuleResolveParams & { modulePath: string },
): string | null {
  const cwd = params.cwd ?? path.dirname(params.modulePath);
  const fromModulePath = resolveOpenClawPackageRootSync({ cwd });
  if (fromModulePath) {
    return fromModulePath;
  }
  const argv1 = params.argv1 ?? process.argv[1];
  const moduleUrl = params.moduleUrl ?? (params.modulePath ? undefined : import.meta.url);
  return resolveOpenClawPackageRootSync({
    cwd,
    ...(argv1 ? { argv1 } : {}),
    ...(moduleUrl ? { moduleUrl } : {}),
  });
}

function createPluginRuntimeModuleCandidateMap(packageRoot: string) {
  return {
    src: path.join(packageRoot, "src", "plugins", "runtime", "index.ts"),
    dist: path.join(packageRoot, "dist", "plugins", "runtime", "index.js"),
  } as const;
}

function appendPluginRuntimeModuleCandidates(
  candidates: string[],
  packageRoot: string,
  orderedKinds: readonly PluginSdkAliasCandidateKind[],
): void {
  const candidateMap = createPluginRuntimeModuleCandidateMap(packageRoot);
  for (const kind of orderedKinds) {
    candidates.push(candidateMap[kind]);
  }
}

function appendSiblingPluginRuntimeModuleCandidates(
  candidates: string[],
  runtimeDir: string,
  orderedKinds: readonly PluginSdkAliasCandidateKind[],
): void {
  const candidateMap = {
    src: path.join(runtimeDir, "index.ts"),
    dist: path.join(runtimeDir, "index.js"),
  } as const;
  for (const kind of orderedKinds) {
    candidates.push(candidateMap[kind]);
  }
}

function dedupeResolvedPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) {
      continue;
    }
    seen.add(resolved);
    deduped.push(resolved);
  }
  return deduped;
}

function listAncestorPluginRuntimeModuleCandidates(params: {
  starts: readonly (string | undefined)[];
  orderedKinds: readonly PluginSdkAliasCandidateKind[];
  maxDepth?: number;
}): string[] {
  const candidates: string[] = [];
  for (const start of params.starts) {
    if (!start) {
      continue;
    }
    let cursor = path.resolve(start);
    const maxDepth = params.maxDepth ?? 12;
    for (let i = 0; i < maxDepth; i += 1) {
      appendPluginRuntimeModuleCandidates(candidates, cursor, params.orderedKinds);
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        break;
      }
      cursor = parent;
    }
  }
  return dedupeResolvedPaths(candidates);
}

function listArgvRuntimeFallbackStartDirs(argv1: string | undefined): string[] {
  if (!argv1) {
    return [];
  }
  const normalized = path.resolve(argv1);
  const starts: string[] = [];
  const parts = normalized.split(path.sep);
  const binIndex = parts.lastIndexOf(".bin");
  if (binIndex > 0 && parts[binIndex - 1] === "node_modules") {
    const binName = path.basename(normalized);
    const nodeModulesDir = parts.slice(0, binIndex).join(path.sep);
    starts.push(path.join(nodeModulesDir, binName));
  }
  try {
    const resolved = pluginCacheRealpathSync(normalized);
    if (resolved && resolved !== normalized) {
      starts.push(path.dirname(resolved));
    }
  } catch {
    // Keep the unresolved argv path; startup shims may not exist in tests.
  }
  starts.push(path.dirname(normalized));
  return dedupeResolvedPaths(starts);
}

function resolveDevSourceRootParam(params: { devSourceRoot?: string | null }): string | null {
  return params.devSourceRoot !== undefined
    ? params.devSourceRoot
    : resolveOpenClawDevSourceRoot(process.env);
}

function resolveLoaderPluginSdkPackageRoot(
  params: LoaderModuleResolveParams & { modulePath: string },
): string | null {
  const devSourceRoot = resolveDevSourceRootParam(params);
  if (devSourceRoot) {
    return devSourceRoot;
  }
  const cwd = params.cwd ?? path.dirname(params.modulePath);
  const fromCwd = resolveOpenClawPackageRootSync({ cwd });
  const fromExplicitHints =
    resolveTrustedOpenClawRootFromArgvHint({ cwd, argv1: params.argv1 }) ??
    (params.moduleUrl
      ? resolveOpenClawPackageRootSync({
          cwd,
          moduleUrl: params.moduleUrl,
        })
      : null);
  return (
    fromCwd ??
    fromExplicitHints ??
    findNearestPluginSdkPackageRoot(path.dirname(params.modulePath)) ??
    (params.cwd ? findNearestPluginSdkPackageRoot(params.cwd) : null) ??
    findNearestPluginSdkPackageRoot(process.cwd())
  );
}

function resolvePluginSdkAliasCandidateOrder(params: {
  modulePath: string;
  isProduction: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): PluginSdkAliasCandidateKind[] {
  if (params.pluginSdkResolution === "dist") {
    return ["dist", "src"];
  }
  if (params.pluginSdkResolution === "src") {
    return ["src", "dist"];
  }
  const normalizedModulePath = params.modulePath.replace(/\\/g, "/");
  const isDistRuntime = normalizedModulePath.includes("/dist/");
  return isDistRuntime || params.isProduction ? ["dist", "src"] : ["src", "dist"];
}

const PLUGIN_SDK_PACKAGE_NAMES = ["openclaw/plugin-sdk", "@openclaw/plugin-sdk"] as const;
const CODEX_MCP_PROJECTION_PLUGIN_SDK_SUBPATH = "codex-mcp-projection";
const CODEX_SESSION_TRANSCRIPT_PLUGIN_SDK_SUBPATH = "codex-session-transcript-runtime";
const NATIVE_HOOK_RELAY_RUNTIME_PLUGIN_SDK_SUBPATH = "native-hook-relay-runtime";
const CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH = "ssrf-runtime-internal";
const PRIVATE_QA_ONLY_PLUGIN_SDK_SUBPATHS = new Set([
  "agent-runtime-test-contracts",
  "channel-contract-testing",
  "channel-ingress-test-runtime",
  "channel-target-testing",
  "channel-test-helpers",
  "plugin-test-api",
  "plugin-test-contracts",
  "plugin-state-test-runtime",
  "plugin-test-runtime",
  "provider-http-test-mocks",
  "provider-test-contracts",
  "qa-channel",
  "qa-channel-protocol",
  "qa-lab",
  "qa-runtime",
  "reply-payload-testing",
  "sqlite-runtime-testing",
  "test-env",
  "test-fixtures",
  "test-live",
  "test-live-auth",
  "test-media-generation",
  "test-media-understanding",
  "test-node-mocks",
]);
type PrivatePluginSdkSubpathOwner = {
  bundledPluginId: string;
  officialInstalledPackageName?: string;
  allowPrivateQaCli: boolean;
  subpaths: readonly string[];
};
const PRIVATE_PLUGIN_SDK_SUBPATH_OWNERS: readonly PrivatePluginSdkSubpathOwner[] = [
  {
    bundledPluginId: "codex",
    officialInstalledPackageName: "@openclaw/codex",
    allowPrivateQaCli: true,
    subpaths: [
      CODEX_MCP_PROJECTION_PLUGIN_SDK_SUBPATH,
      CODEX_SESSION_TRANSCRIPT_PLUGIN_SDK_SUBPATH,
      NATIVE_HOOK_RELAY_RUNTIME_PLUGIN_SDK_SUBPATH,
    ],
  },
  {
    bundledPluginId: "ollama",
    allowPrivateQaCli: false,
    subpaths: [CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH],
  },
  {
    bundledPluginId: "browser",
    allowPrivateQaCli: false,
    subpaths: [CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH],
  },
  {
    bundledPluginId: "llama-cpp",
    officialInstalledPackageName: "@openclaw/llama-cpp-provider",
    allowPrivateQaCli: false,
    subpaths: [CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH],
  },
];
const PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS = [
  ".ts",
  ".mts",
  ".js",
  ".mjs",
  ".cts",
  ".cjs",
] as const;
const BUNDLED_PLUGIN_PUBLIC_SURFACE_SOURCE_PATTERN = /^(?:api|runtime-api|test-api|.+-api)$/u;
const JS_STATIC_RELATIVE_DEPENDENCY_PATTERN =
  /(?:\bfrom\s*["']|\bimport\s*\(\s*["']|\brequire\s*\(\s*["'])(\.{1,2}\/[^"']+)["']/g;
// Jiti-loaded plugin code runs outside the Vitest/tsgo resolver, so every
// workspace package import reachable from plugin SDK barrels needs an explicit
// source/dist alias here to keep source checkouts and packaged builds aligned.
// Packaged installs omit workspace manifests; preserve the exact curated subpaths
// instead of expanding aliases from package exports.
const WORKSPACE_PACKAGE_ALIAS_SUBPATHS = [
  ["gateway-client", ["", "readiness", "timeouts", "websocket-data"]],
  [
    "gateway-protocol",
    [
      "",
      "client-info",
      "connect-error-details",
      "frame-guards",
      "schema",
      "startup-unavailable",
      "version",
    ],
  ],
  [
    "markdown-core",
    [
      "",
      "code-spans",
      "fences",
      "frontmatter",
      "ir",
      "render",
      "render-aware-chunking",
      "tables",
      "types",
    ],
  ],
  ["media-generation-core", ["", "capability-model-ref", "catalog", "model-ref", "normalization"]],
  ["retry", [""]],
  [
    "terminal-core",
    [
      "",
      "ansi",
      "decorative-emoji",
      "health-style",
      "links",
      "note",
      "osc-progress",
      "palette",
      "progress-line",
      "prompt-select-styled",
      "prompt-select-styled-params",
      "prompt-style",
      "restore",
      "safe-text",
      "stream-writer",
      "table",
      "terminal-link",
      "theme",
    ],
  ],
  ["net-policy", ["", "ip", "ipv4", "redact-sensitive-url", "url-protocol", "url-userinfo"]],
  [
    "model-catalog-core",
    [
      "",
      "configured-model-refs",
      "model-catalog-refs",
      "model-catalog-normalize",
      "model-catalog-types",
      "provider-id",
      "provider-model-id-normalization",
      "provider-model-id-normalize",
    ],
  ],
] as const;

const WORKSPACE_PACKAGE_ALIAS_ENTRIES: WorkspacePackageAliasEntry[] =
  WORKSPACE_PACKAGE_ALIAS_SUBPATHS.flatMap(([packageDir, subpaths]) =>
    subpaths.map(
      (subpath): WorkspacePackageAliasEntry => ({
        packageName: `@openclaw/${packageDir}`,
        packageDir,
        subpath,
        srcFile: `${subpath || "index"}.ts`,
        distFile: `${subpath || "index"}.mjs`,
      }),
    ),
  );
const ROOT_PACKAGED_WORKSPACE_PACKAGE_DIRS = new Set([
  "acp-core",
  "media-core",
  "normalization-core",
  "retry",
  "terminal-core",
]);

function normalizePackageExportSubpath(exportKey: string): string | null {
  if (exportKey === ".") {
    return "";
  }
  if (!exportKey.startsWith("./")) {
    return null;
  }
  const subpath = exportKey.slice(2);
  return subpath && !subpath.includes("..") ? subpath : null;
}

function resolvePackageExportImportPath(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  return typeof record.import === "string"
    ? record.import
    : typeof record.default === "string"
      ? record.default
      : null;
}

function listRootPackagedWorkspacePackageAliasEntries(params: {
  packageRoot: string;
  packageName: string;
  packageDir: string;
}): WorkspacePackageAliasEntry[] {
  const distRoot = path.join(params.packageRoot, "dist", params.packageDir);
  if (!pluginCacheExistsSync(distRoot)) {
    return [];
  }
  const entries: WorkspacePackageAliasEntry[] = [];
  const visit = (dir: string, prefix = "") => {
    for (const entry of readPluginCacheDirectory(dir)) {
      const relativePath = prefix ? path.join(prefix, entry.name) : entry.name;
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath, relativePath);
        continue;
      }
      if (!entry.isFile() || !relativePath.endsWith(".js")) {
        continue;
      }
      const normalizedRelativePath = relativePath.split(path.sep).join("/");
      const subpath =
        normalizedRelativePath === "index.js" ? "" : normalizedRelativePath.slice(0, -".js".length);
      if (subpath.includes("..")) {
        continue;
      }
      entries.push({
        packageName: params.packageName,
        packageDir: params.packageDir,
        subpath,
        srcFile: `${subpath || "index"}.ts`,
        distFile: relativePath,
      });
    }
  };
  visit(distRoot);
  return entries.toSorted((a, b) => a.subpath.localeCompare(b.subpath));
}

export function listWorkspacePackageExportAliasEntries(params: {
  packageRoot: string;
  packageName: string;
  packageDir: string;
}): WorkspacePackageAliasEntry[] {
  const cache = sdkHost(params.packageRoot).workspaceExports;
  const key = `${params.packageName}\0${params.packageDir}`;
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const packageJsonPath = path.join(
    params.packageRoot,
    "packages",
    params.packageDir,
    "package.json",
  );
  const packageJson = readPluginSdkPackageJson(path.dirname(packageJsonPath));
  const exports = packageJson?.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    const entries = listRootPackagedWorkspacePackageAliasEntries(params);
    cache.set(key, entries);
    return entries;
  }
  const entries: WorkspacePackageAliasEntry[] = [];
  for (const [exportKey, value] of Object.entries(exports)) {
    const subpath = normalizePackageExportSubpath(exportKey);
    const importPath = resolvePackageExportImportPath(value);
    if (subpath === null || !importPath?.startsWith("./dist/") || !importPath.endsWith(".mjs")) {
      continue;
    }
    const distFile = importPath.slice("./dist/".length);
    const srcFile = distFile.replace(/\.mjs$/u, ".ts");
    entries.push({
      packageName: params.packageName,
      packageDir: params.packageDir,
      subpath,
      srcFile,
      distFile,
    });
  }
  const result =
    entries.length > 0
      ? entries.toSorted((a, b) => a.subpath.localeCompare(b.subpath))
      : listRootPackagedWorkspacePackageAliasEntries(params);
  cache.set(key, result);
  return result;
}

function isUsableDistPluginSdkArtifact(candidate: string): boolean {
  const cache = getPluginCache().sdk.usableDistArtifacts;
  const cached = cache.get(candidate);
  if (cached !== undefined) {
    return cached;
  }
  const usable = checkDistPluginSdkArtifact(candidate);
  cache.set(candidate, usable);
  return usable;
}

function checkDistPluginSdkArtifact(candidate: string): boolean {
  if (!pluginCacheExistsSync(candidate)) {
    return false;
  }
  switch (normalizeLowercaseStringOrEmpty(path.extname(candidate))) {
    case ".js":
    case ".mjs":
    case ".cjs":
      break;
    default:
      return true;
  }
  try {
    const source = fs.readFileSync(candidate, "utf-8");
    for (const match of source.matchAll(JS_STATIC_RELATIVE_DEPENDENCY_PATTERN)) {
      const specifier = match[1];
      if (!specifier || pluginCacheExistsSync(path.resolve(path.dirname(candidate), specifier))) {
        continue;
      }
      return false;
    }
  } catch {
    return false;
  }
  return true;
}

function readPrivateLocalOnlyPluginSdkSubpaths(packageRoot: string): string[] {
  const facts = sdkHost(packageRoot);
  if (facts.privateSubpaths) {
    return facts.privateSubpaths;
  }
  const parsed = readSdkJsonFile(
    path.join(packageRoot, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
  );
  return (facts.privateSubpaths = [
    ...new Set([
      CODEX_MCP_PROJECTION_PLUGIN_SDK_SUBPATH,
      NATIVE_HOOK_RELAY_RUNTIME_PLUGIN_SDK_SUBPATH,
      CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH,
      ...(Array.isArray(parsed)
        ? parsed.filter(
            (subpath): subpath is string =>
              typeof subpath === "string" && isSafePluginSdkSubpathSegment(subpath),
          )
        : []),
    ]),
  ]);
}

function readBundledPluginPackageName(packageJsonPath: string): string | null {
  const parsed = readPluginSdkPackageJson(path.dirname(packageJsonPath));
  const name = typeof parsed?.name === "string" ? parsed.name.trim() : "";
  return name.startsWith("@openclaw/") ? name : null;
}

function isBundledPluginPublicSurfaceSourceBasename(params: {
  basename: string;
  includePrivateQa: boolean;
}): boolean {
  if (params.basename === "test-api") {
    return params.includePrivateQa;
  }
  return BUNDLED_PLUGIN_PUBLIC_SURFACE_SOURCE_PATTERN.test(params.basename);
}

function listBundledPluginPublicSurfaceSourceBasenames(params: {
  extensionSourceRoot: string;
  includePrivateQa: boolean;
}): string[] {
  try {
    return readPluginCacheDirectory(params.extensionSourceRoot)
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .flatMap((fileName) => {
        const ext = PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS.find((candidateExt) =>
          fileName.endsWith(candidateExt),
        );
        if (!ext) {
          return [];
        }
        const basename = fileName.slice(0, -ext.length);
        return isBundledPluginPublicSurfaceSourceBasename({
          basename,
          includePrivateQa: params.includePrivateQa,
        })
          ? [basename]
          : [];
      })
      .toSorted();
  } catch {
    return [];
  }
}

function resolveBundledPluginPublicSurfaceAliasTarget(params: {
  packageRoot: string;
  dirName: string;
  basename: string;
  orderedKinds: PluginSdkAliasCandidateKind[];
}): string | null {
  for (const kind of params.orderedKinds) {
    if (kind === "dist") {
      const candidate = path.join(
        params.packageRoot,
        "dist",
        "extensions",
        params.dirName,
        `${params.basename}.js`,
      );
      if (pluginCacheExistsSync(candidate)) {
        return candidate;
      }
      continue;
    }
    for (const ext of PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS) {
      const candidate = path.join(
        params.packageRoot,
        "extensions",
        params.dirName,
        `${params.basename}${ext}`,
      );
      if (pluginCacheExistsSync(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

function resolveBundledPluginPackagePublicSurfaceAliasMap(params: {
  modulePath: string;
  argv1?: string;
  moduleUrl?: string;
  pluginSdkResolution: PluginSdkResolutionPreference;
  devSourceRoot?: string | null;
}): Record<string, string> {
  const packageRoot = resolveLoaderPluginSdkPackageRoot(params);
  if (!packageRoot) {
    return {};
  }
  const orderedKinds = resolvePluginSdkAliasCandidateOrder({
    modulePath: params.modulePath,
    isProduction: process.env.NODE_ENV === "production",
    pluginSdkResolution: params.pluginSdkResolution,
  });
  const includePrivateQa = shouldIncludePrivateLocalOnlyPluginSdkSubpaths();
  const cachedBundledPluginPublicSurfaceAliasMaps = sdkHost(packageRoot).bundledAliasesByMode;
  const cacheKey = `${packageRoot}::${orderedKinds.join(",")}::privateQa=${includePrivateQa ? "1" : "0"}`;
  const cached = cachedBundledPluginPublicSurfaceAliasMaps.get(cacheKey);
  if (cached) {
    return cached;
  }
  const extensionsRoot = path.join(packageRoot, "extensions");
  let extensionDirs: fs.Dirent[];
  try {
    extensionDirs = readPluginCacheDirectory(extensionsRoot);
  } catch {
    cachedBundledPluginPublicSurfaceAliasMaps.set(cacheKey, {});
    return {};
  }
  const aliasMap: Record<string, string> = {};
  for (const entry of extensionDirs) {
    if (!entry.isDirectory()) {
      continue;
    }
    const dirName = entry.name;
    const packageName = readBundledPluginPackageName(
      path.join(extensionsRoot, dirName, "package.json"),
    );
    if (!packageName) {
      continue;
    }
    for (const basename of listBundledPluginPublicSurfaceSourceBasenames({
      extensionSourceRoot: path.join(extensionsRoot, dirName),
      includePrivateQa,
    })) {
      const target = resolveBundledPluginPublicSurfaceAliasTarget({
        packageRoot,
        dirName,
        basename,
        orderedKinds,
      });
      if (!target) {
        continue;
      }
      aliasMap[`${packageName}/${basename}.js`] = normalizeJitiAliasTargetPath(target);
    }
  }
  cachedBundledPluginPublicSurfaceAliasMaps.set(cacheKey, aliasMap);
  return aliasMap;
}

function resolveWorkspacePackageAliasMap(params: {
  modulePath: string;
  argv1?: string;
  moduleUrl?: string;
  pluginSdkResolution: PluginSdkResolutionPreference;
  devSourceRoot?: string | null;
}): Record<string, string> {
  const packageRoot = resolveLoaderPluginSdkPackageRoot(params);
  if (!packageRoot) {
    return {};
  }
  const orderedKinds = resolvePluginSdkAliasCandidateOrder({
    modulePath: params.modulePath,
    isProduction: process.env.NODE_ENV === "production",
    pluginSdkResolution: params.pluginSdkResolution,
  });
  // Raw modes with the same effective preference order resolve identical targets.
  // Key the process-stable cache by that target-affecting order, not the caller spelling.
  const cacheKey = `${packageRoot}::${orderedKinds.join(",")}`;
  const cachedWorkspacePackageAliasMaps = sdkHost(packageRoot).workspaceAliasesByMode;
  const cached = cachedWorkspacePackageAliasMaps.get(cacheKey);
  if (cached) {
    return cached;
  }
  const aliasMap: Record<string, string> = {};
  const workspacePackageAliasEntries = [
    ...WORKSPACE_PACKAGE_ALIAS_ENTRIES,
    ...["media-core", "normalization-core", "acp-core"].flatMap((packageDir) =>
      listWorkspacePackageExportAliasEntries({
        packageRoot,
        packageName: `@openclaw/${packageDir}`,
        packageDir,
      }),
    ),
  ];
  for (const entry of workspacePackageAliasEntries) {
    const alias = entry.subpath ? `${entry.packageName}/${entry.subpath}` : entry.packageName;
    for (const kind of orderedKinds) {
      const candidates =
        kind === "dist"
          ? [
              ...(ROOT_PACKAGED_WORKSPACE_PACKAGE_DIRS.has(entry.packageDir)
                ? [
                    path.join(
                      packageRoot,
                      "dist",
                      entry.packageDir,
                      entry.distFile.replace(/\.mjs$/u, ".js"),
                    ),
                  ]
                : []),
              path.join(packageRoot, "packages", entry.packageDir, "dist", entry.distFile),
            ]
          : [path.join(packageRoot, "packages", entry.packageDir, "src", entry.srcFile)];
      const candidate = candidates.find((candidatePath) => pluginCacheExistsSync(candidatePath));
      if (candidate) {
        aliasMap[alias] = normalizeJitiAliasTargetPath(candidate);
        break;
      }
    }
  }
  cachedWorkspacePackageAliasMaps.set(cacheKey, aliasMap);
  return aliasMap;
}

function shouldIncludePrivateLocalOnlyPluginSdkSubpaths() {
  return process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1";
}

function isBundledPluginModulePath(params: {
  packageRoot: string;
  modulePath: string;
  pluginId: string;
}) {
  const normalizedModulePath = path.resolve(params.modulePath);
  const roots = [
    path.join(params.packageRoot, "extensions", params.pluginId),
    path.join(params.packageRoot, "dist", "extensions", params.pluginId),
    path.join(params.packageRoot, "dist-runtime", "extensions", params.pluginId),
  ];
  return roots.some(
    (root) =>
      normalizedModulePath === root || normalizedModulePath.startsWith(`${root}${path.sep}`),
  );
}

function isAnyBundledPluginModulePath(params: { packageRoot: string; modulePath: string }) {
  const normalizedModulePath = path.resolve(params.modulePath);
  return ["extensions", path.join("dist", "extensions"), path.join("dist-runtime", "extensions")]
    .map((segment) => path.join(params.packageRoot, segment))
    .some((root) => normalizedModulePath.startsWith(`${root}${path.sep}`));
}

function isOfficialInstalledPluginPackageRoot(params: {
  packageRoot: string;
  packageName: string;
}) {
  const [scope, name] = params.packageName.split("/");
  if (!scope || !name) {
    return false;
  }
  const segments = path.resolve(params.packageRoot).split(path.sep).filter(Boolean);
  const last = segments.at(-1);
  const packageScope = segments.at(-2);
  const nodeModules = segments.at(-3);
  return last === name && packageScope === scope && nodeModules === "node_modules";
}

function isOfficialInstalledPluginModulePath(params: { modulePath: string; packageName: string }) {
  let cursor = path.dirname(path.resolve(params.modulePath));
  for (let depth = 0; depth < 12; depth += 1) {
    const packageJson = readPluginSdkPackageJson(cursor);
    if (packageJson) {
      return (
        packageJson.name === params.packageName &&
        isOfficialInstalledPluginPackageRoot({
          packageRoot: cursor,
          packageName: params.packageName,
        })
      );
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return false;
}

function isTrustedPrivatePluginSdkOwnerPath(params: {
  packageRoot: string;
  modulePath: string;
  owner: PrivatePluginSdkSubpathOwner;
}) {
  if (
    isBundledPluginModulePath({
      packageRoot: params.packageRoot,
      modulePath: params.modulePath,
      pluginId: params.owner.bundledPluginId,
    })
  ) {
    return true;
  }
  return params.owner.officialInstalledPackageName
    ? isOfficialInstalledPluginModulePath({
        modulePath: params.modulePath,
        packageName: params.owner.officialInstalledPackageName,
      })
    : false;
}

function findPrivatePluginSdkSubpathOwners(
  subpath: string,
): readonly PrivatePluginSdkSubpathOwner[] {
  return PRIVATE_PLUGIN_SDK_SUBPATH_OWNERS.filter((owner) => owner.subpaths.includes(subpath));
}

function listTrustedPrivatePluginSdkOwnerKeys(params: {
  packageRoot: string;
  modulePath: string;
}): string[] {
  return PRIVATE_PLUGIN_SDK_SUBPATH_OWNERS.filter((owner) =>
    isTrustedPrivatePluginSdkOwnerPath({ ...params, owner }),
  ).map((owner) => owner.bundledPluginId);
}

function resolvePrivatePluginSdkOwnerPackageRoot(params: {
  modulePath: string;
  argv1?: string;
  moduleUrl?: string;
  aliasPackageRoot: string;
}): string {
  return (
    resolveLoaderPackageRoot({
      modulePath: params.modulePath,
      argv1: params.argv1,
      moduleUrl: params.moduleUrl,
    }) ?? params.aliasPackageRoot
  );
}

function shouldIncludePrivateLocalOnlyPluginSdkSubpath(params: {
  packageRoot: string;
  modulePath: string;
  subpath: string;
}) {
  if (PRIVATE_QA_ONLY_PLUGIN_SDK_SUBPATHS.has(params.subpath)) {
    return shouldIncludePrivateLocalOnlyPluginSdkSubpaths();
  }
  const owners = findPrivatePluginSdkSubpathOwners(params.subpath);
  if (owners.length === 0) {
    // Public demotions remain loadable by bundled plugins, but never by arbitrary installed
    // plugins. Explicit owner records below impose tighter boundaries for sensitive helpers.
    return isAnyBundledPluginModulePath(params) || shouldIncludePrivateLocalOnlyPluginSdkSubpaths();
  }
  return owners.some(
    (owner) =>
      isTrustedPrivatePluginSdkOwnerPath({ ...params, owner }) ||
      (owner.allowPrivateQaCli && shouldIncludePrivateLocalOnlyPluginSdkSubpaths()),
  );
}

function hasPluginSdkSubpathArtifact(packageRoot: string, subpath: string) {
  const distPath = path.join(packageRoot, "dist", "plugin-sdk", `${subpath}.js`);
  if (isUsableDistPluginSdkArtifact(distPath)) {
    return true;
  }
  return PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS.some((ext) =>
    pluginCacheExistsSync(path.join(packageRoot, "src", "plugin-sdk", `${subpath}${ext}`)),
  );
}

function listDistPluginSdkArtifactSubpaths(packageRoot: string): Set<string> {
  try {
    const distPluginSdkDir = path.join(packageRoot, "dist", "plugin-sdk");
    return new Set(
      readPluginCacheDirectory(distPluginSdkDir)
        .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
        .map((entry) => entry.name.slice(0, -".js".length))
        .filter((subpath) => isSafePluginSdkSubpathSegment(subpath)),
    );
  } catch {
    return new Set();
  }
}

function listPrivateLocalOnlyPluginSdkSubpaths(params: {
  packageRoot: string;
  ownerPackageRoot: string;
  modulePath: string;
}): string[] {
  return readPrivateLocalOnlyPluginSdkSubpaths(params.packageRoot).filter(
    (subpath) =>
      shouldIncludePrivateLocalOnlyPluginSdkSubpath({
        packageRoot: params.ownerPackageRoot,
        modulePath: params.modulePath,
        subpath,
      }) && hasPluginSdkSubpathArtifact(params.packageRoot, subpath),
  );
}

function listPluginSdkExportedSubpaths(
  params: {
    modulePath?: string;
    argv1?: string;
    moduleUrl?: string;
    devSourceRoot?: string | null;
    pluginSdkResolution?: PluginSdkResolutionPreference;
  } = {},
): string[] {
  const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
  const packageRoot = resolveLoaderPluginSdkPackageRoot({
    modulePath,
    argv1: params.argv1,
    moduleUrl: params.moduleUrl,
    devSourceRoot: params.devSourceRoot,
  });
  if (!packageRoot) {
    return [];
  }
  const ownerPackageRoot = resolvePrivatePluginSdkOwnerPackageRoot({
    modulePath,
    argv1: params.argv1,
    moduleUrl: params.moduleUrl,
    aliasPackageRoot: packageRoot,
  });
  const trustedPrivateOwners = listTrustedPrivatePluginSdkOwnerKeys({
    packageRoot: ownerPackageRoot,
    modulePath,
  });
  // Generic bundled helpers and named private owners have distinct authority.
  // Sharing their key lets installed plugins borrow a bundled plugin's aliases.
  const bundled = isAnyBundledPluginModulePath({ packageRoot: ownerPackageRoot, modulePath });
  const cacheKey = `bundled=${bundled}::privateQa=${shouldIncludePrivateLocalOnlyPluginSdkSubpaths() ? "1" : "0"}::privateOwners=${trustedPrivateOwners.join(",")}`;
  const cachedPluginSdkExportedSubpaths = sdkHost(packageRoot).subpathsByOwner;
  const cached = cachedPluginSdkExportedSubpaths.get(cacheKey);
  if (cached) {
    return cached;
  }
  const subpaths = [
    ...new Set([
      ...(readPluginSdkSubpathsFromPackageRoot(packageRoot) ?? []),
      ...listPrivateLocalOnlyPluginSdkSubpaths({ packageRoot, ownerPackageRoot, modulePath }),
    ]),
  ].toSorted();
  cachedPluginSdkExportedSubpaths.set(cacheKey, subpaths);
  return subpaths;
}

function resolvePluginSdkScopedAliasMap(
  params: {
    modulePath?: string;
    argv1?: string;
    moduleUrl?: string;
    devSourceRoot?: string | null;
    pluginSdkResolution?: PluginSdkResolutionPreference;
  } = {},
): Record<string, string> {
  const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
  const packageRoot = resolveLoaderPluginSdkPackageRoot({
    modulePath,
    argv1: params.argv1,
    moduleUrl: params.moduleUrl,
    devSourceRoot: params.devSourceRoot,
  });
  if (!packageRoot) {
    return {};
  }
  const ownerPackageRoot = resolvePrivatePluginSdkOwnerPackageRoot({
    modulePath,
    argv1: params.argv1,
    moduleUrl: params.moduleUrl,
    aliasPackageRoot: packageRoot,
  });
  const orderedKinds = resolvePluginSdkAliasCandidateOrder({
    modulePath,
    isProduction: process.env.NODE_ENV === "production",
    pluginSdkResolution: params.pluginSdkResolution,
  });
  const trustedPrivateOwners = listTrustedPrivatePluginSdkOwnerKeys({
    packageRoot: ownerPackageRoot,
    modulePath,
  });
  const bundled = isAnyBundledPluginModulePath({ packageRoot: ownerPackageRoot, modulePath });
  const cacheKey = `${orderedKinds.join(",")}::bundled=${bundled}::privateQa=${shouldIncludePrivateLocalOnlyPluginSdkSubpaths() ? "1" : "0"}::privateOwners=${trustedPrivateOwners.join(",")}`;
  const cachedPluginSdkScopedAliasMaps = sdkHost(packageRoot).aliasesByOwner;
  const cached = cachedPluginSdkScopedAliasMaps.get(cacheKey);
  if (cached) {
    return cached;
  }
  const aliasMap: Record<string, string> = {};
  const distPluginSdkArtifacts = orderedKinds.includes("dist")
    ? listDistPluginSdkArtifactSubpaths(packageRoot)
    : new Set<string>();
  for (const subpath of listPluginSdkExportedSubpaths({
    modulePath,
    argv1: params.argv1,
    moduleUrl: params.moduleUrl,
    devSourceRoot: params.devSourceRoot,
    pluginSdkResolution: params.pluginSdkResolution,
  })) {
    for (const kind of orderedKinds) {
      if (kind === "dist") {
        if (!distPluginSdkArtifacts.has(subpath)) {
          continue;
        }
        const candidate = path.join(packageRoot, "dist", "plugin-sdk", `${subpath}.js`);
        if (isUsableDistPluginSdkArtifact(candidate)) {
          for (const packageName of PLUGIN_SDK_PACKAGE_NAMES) {
            aliasMap[`${packageName}/${subpath}`] = candidate;
          }
          break;
        }
        continue;
      }
      for (const ext of PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS) {
        const candidate = path.join(packageRoot, "src", "plugin-sdk", `${subpath}${ext}`);
        if (!pluginCacheExistsSync(candidate)) {
          continue;
        }
        for (const packageName of PLUGIN_SDK_PACKAGE_NAMES) {
          aliasMap[`${packageName}/${subpath}`] = candidate;
        }
        break;
      }
      if (Object.hasOwn(aliasMap, `openclaw/plugin-sdk/${subpath}`)) {
        break;
      }
    }
  }
  cachedPluginSdkScopedAliasMaps.set(cacheKey, aliasMap);
  return aliasMap;
}

const JITI_NORMALIZED_ALIAS_SYMBOL = Symbol.for("pathe:normalizedAlias");
const JITI_ALIAS_ROOT_SENTINELS = new Set<string | undefined>(["/", "\\", undefined]);
const JITI_CONCRETE_ALIAS_TARGET_PATTERN = /^(?:[A-Za-z]:[/\\]|[/\\])/;

function normalizeAliasTargets(aliasMap: Record<string, string>): Record<string, string> {
  if (process.platform !== "win32") {
    return aliasMap;
  }
  const facts = sdkAliasFacts(aliasMap);
  const cached = facts.normalizedTargets;
  if (cached) {
    return cached;
  }
  const normalized = Object.fromEntries(
    Object.entries(aliasMap).map(([key, value]) => [key, normalizeJitiAliasTargetPath(value)]),
  );
  facts.normalizedTargets = normalized;
  return normalized;
}

function mergeAliasMaps(
  bundled: Record<string, string>,
  workspace: Record<string, string>,
  pluginSdk: Record<string, string>,
): Record<string, string> {
  const mergedAliasMapsByComponent = getPluginCache().sdk.mergedAliases;
  let byWorkspace = mergedAliasMapsByComponent.get(bundled);
  if (!byWorkspace) {
    byWorkspace = new WeakMap();
    mergedAliasMapsByComponent.set(bundled, byWorkspace);
  }
  let byPluginSdk = byWorkspace.get(workspace);
  if (!byPluginSdk) {
    byPluginSdk = new WeakMap();
    byWorkspace.set(workspace, byPluginSdk);
  }
  const cached = byPluginSdk.get(pluginSdk);
  if (cached) {
    return cached;
  }
  const merged = { ...bundled, ...workspace, ...pluginSdk };
  byPluginSdk.set(pluginSdk, merged);
  return merged;
}

function hasJitiNormalizedAliasMarker(aliasMap: Record<string, string>) {
  return Boolean((aliasMap as Record<symbol, unknown>)[JITI_NORMALIZED_ALIAS_SYMBOL]);
}

function createJitiAliasContentCacheKey(aliasMap: Record<string, string>) {
  return Object.entries(aliasMap)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${key}\0${value}`)
    .join("\0");
}

function isConcreteJitiAliasTarget(target: string | undefined): boolean {
  return typeof target === "string" && JITI_CONCRETE_ALIAS_TARGET_PATTERN.test(target);
}

function resolveJitiAliasTarget(
  aliasKey: string,
  aliasKeys: string[],
  aliasMap: Record<string, string>,
) {
  let target = aliasMap[aliasKey];
  const seenTargets = new Set<string>();
  const seenAliasKeys = new Set<string>();
  while (target && !isConcreteJitiAliasTarget(target) && !seenTargets.has(target)) {
    seenTargets.add(target);
    let nextTarget: string | undefined;
    for (const candidateKey of aliasKeys) {
      if (
        candidateKey === aliasKey ||
        aliasKey.startsWith(candidateKey) ||
        !target.startsWith(candidateKey) ||
        !JITI_ALIAS_ROOT_SENTINELS.has(target[candidateKey.length])
      ) {
        continue;
      }
      if (seenAliasKeys.has(candidateKey)) {
        return target;
      }
      seenAliasKeys.add(candidateKey);
      nextTarget = aliasMap[candidateKey] + target.slice(candidateKey.length);
      break;
    }
    if (!nextTarget || nextTarget === target) {
      break;
    }
    target = nextTarget;
  }
  return target;
}

function normalizePluginLoaderAliasMapForJiti(
  aliasMap: Record<string, string>,
): Record<string, string> {
  if (hasJitiNormalizedAliasMarker(aliasMap)) {
    return aliasMap;
  }
  const facts = sdkAliasFacts(aliasMap);
  const cachedByInput = facts.normalizedJiti;
  if (cachedByInput) {
    return cachedByInput;
  }
  const cacheKey = createJitiAliasContentCacheKey(aliasMap);
  const normalizedJitiAliasMapCache = getPluginCache().sdk.normalizedJitiAliases;
  const cached = normalizedJitiAliasMapCache.get(cacheKey);
  if (cached) {
    facts.normalizedJiti = cached;
    return cached;
  }
  const aliasDepth = new Map<string, number>();
  const getAliasDepth = (key: string) => {
    const cachedDepth = aliasDepth.get(key);
    if (cachedDepth !== undefined) {
      return cachedDepth;
    }
    const depth = key.split("/").length;
    aliasDepth.set(key, depth);
    return depth;
  };
  const normalizedAliasMap = Object.fromEntries(
    Object.entries(aliasMap).toSorted(
      ([left], [right]) => getAliasDepth(right) - getAliasDepth(left),
    ),
  );
  const aliasKeys = Object.keys(normalizedAliasMap);
  for (const aliasKey of aliasKeys) {
    const target = normalizedAliasMap[aliasKey];
    if (!target || isConcreteJitiAliasTarget(target)) {
      continue;
    }
    const resolvedTarget = resolveJitiAliasTarget(aliasKey, aliasKeys, normalizedAliasMap);
    if (resolvedTarget) {
      normalizedAliasMap[aliasKey] = resolvedTarget;
    }
  }
  Object.defineProperty(normalizedAliasMap, JITI_NORMALIZED_ALIAS_SYMBOL, {
    value: true,
    enumerable: false,
  });
  normalizedJitiAliasMapCache.set(cacheKey, normalizedAliasMap);
  facts.normalizedJiti = normalizedAliasMap;
  return normalizedAliasMap;
}

function buildPluginLoaderAliasMapCacheKey(params: {
  modulePath: string;
  argv1?: string;
  moduleUrl?: string;
  pluginSdkResolution: PluginSdkResolutionPreference;
  devSourceRoot?: string | null;
}) {
  const devSourceRoot = resolveDevSourceRootParam(params);
  return [
    params.modulePath,
    params.argv1 ?? "",
    params.moduleUrl ?? "",
    params.pluginSdkResolution,
    process.cwd(),
    devSourceRoot ?? "",
    process.env.NODE_ENV === "production" ? "production" : "non-production",
    shouldIncludePrivateLocalOnlyPluginSdkSubpaths() ? "private-qa" : "public",
  ].join("\0");
}

function buildPluginLoaderModuleConfigCacheKey(params: {
  modulePath: string;
  argv1?: string;
  moduleUrl: string;
  devSourceRoot?: string | null;
  preferBuiltDist?: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}) {
  return [
    buildPluginLoaderAliasMapCacheKey({
      modulePath: params.modulePath,
      argv1: params.argv1,
      moduleUrl: params.moduleUrl,
      pluginSdkResolution: params.pluginSdkResolution ?? "auto",
      devSourceRoot: params.devSourceRoot,
    }),
    params.preferBuiltDist === true ? "prefer-built-dist" : "default-dist",
  ].join("\0");
}

export function buildPluginLoaderAliasMap(
  modulePath: string,
  argv1: string | undefined = STARTUP_ARGV1,
  moduleUrl?: string,
  pluginSdkResolution: PluginSdkResolutionPreference = "auto",
  devSourceRoot?: string | null,
): Record<string, string> {
  const cacheKey = buildPluginLoaderAliasMapCacheKey({
    modulePath,
    argv1,
    moduleUrl,
    pluginSdkResolution,
    devSourceRoot,
  });
  const contexts = getPluginCache().sdk.contexts;
  const cached = contexts.get(cacheKey)?.aliasMap;
  if (cached) {
    return cached;
  }

  const bundledAliases = resolveBundledPluginPackagePublicSurfaceAliasMap({
    modulePath,
    argv1,
    moduleUrl,
    pluginSdkResolution,
    devSourceRoot,
  });
  const workspaceAliases = resolveWorkspacePackageAliasMap({
    modulePath,
    argv1,
    moduleUrl,
    pluginSdkResolution,
    devSourceRoot,
  });
  const pluginSdkAliases = normalizeAliasTargets(
    resolvePluginSdkScopedAliasMap({
      modulePath,
      argv1,
      moduleUrl,
      pluginSdkResolution,
      devSourceRoot,
    }),
  );
  // Different plugin entrypoints commonly resolve the same process-stable SDK surface.
  // Reuse one merged map so plugin count does not multiply identical alias objects.
  const result = mergeAliasMaps(bundledAliases, workspaceAliases, pluginSdkAliases);
  contexts.set(cacheKey, { ...contexts.get(cacheKey), aliasMap: result });
  return result;
}

export function resolvePluginRuntimeModulePathWithDiagnostics(
  params: LoaderModuleResolveParams = {},
): PluginRuntimeModuleResolution {
  const cache = getPluginCache().sdk.runtimeModules;
  const key = JSON.stringify([
    params.modulePath,
    params.argv1 ?? process.argv[1],
    params.cwd,
    params.moduleUrl,
    resolveDevSourceRootParam(params),
    params.pluginSdkResolution,
    process.cwd(),
    process.env.NODE_ENV,
  ]);
  const cached = cache.get(key);
  if (cached) {
    return cached;
  }
  const result = resolvePluginRuntimeModuleCandidates(params);
  cache.set(key, result);
  return result;
}

function resolvePluginRuntimeModuleCandidates(
  params: LoaderModuleResolveParams,
): PluginRuntimeModuleResolution {
  let modulePath: string | undefined;
  let packageRoot: string | null = null;
  const candidates: string[] = [];
  try {
    modulePath = resolveLoaderModulePath(params);
    const orderedKinds = resolvePluginSdkAliasCandidateOrder({
      modulePath,
      isProduction: process.env.NODE_ENV === "production",
      pluginSdkResolution: params.pluginSdkResolution,
    });
    packageRoot =
      resolveDevSourceRootParam(params) ?? resolveLoaderPackageRoot({ ...params, modulePath });
    if (packageRoot) {
      appendPluginRuntimeModuleCandidates(candidates, packageRoot, orderedKinds);
    } else {
      const argv1 = params.argv1 ?? process.argv[1];
      candidates.push(
        ...listAncestorPluginRuntimeModuleCandidates({
          starts: listArgvRuntimeFallbackStartDirs(argv1),
          orderedKinds,
        }),
      );
      appendSiblingPluginRuntimeModuleCandidates(
        candidates,
        path.join(path.dirname(modulePath), "runtime"),
        orderedKinds,
      );
    }
    const dedupedCandidates = dedupeResolvedPaths(candidates);
    for (const candidate of dedupedCandidates) {
      if (pluginCacheExistsSync(candidate)) {
        return {
          modulePath,
          packageRoot,
          candidates: dedupedCandidates,
          resolvedPath: candidate,
        };
      }
    }
  } catch (error) {
    return {
      modulePath,
      packageRoot,
      candidates: dedupeResolvedPaths(candidates),
      resolvedPath: null,
      error: formatErrorMessage(error),
    };
  }
  return {
    modulePath,
    packageRoot,
    candidates: dedupeResolvedPaths(candidates),
    resolvedPath: null,
  };
}

export function buildPluginLoaderJitiOptions(
  aliasMap: Record<string, string>,
  params: LoaderModuleResolveParams = {},
) {
  const hasAliases = Object.keys(aliasMap).length > 0;
  const jitiAliasMap = hasAliases ? normalizePluginLoaderAliasMapForJiti(aliasMap) : aliasMap;
  return {
    interopDefault: true,
    fsCache: resolvePluginLoaderJitiFsCacheOption(params),
    // Prefer Node's native sync ESM loader for built dist/*.js modules so
    // bundled plugins and plugin-sdk subpaths stay on the canonical module graph.
    tryNative: true,
    // When jiti must transform a plugin entry, keep OpenClaw's own package
    // chunks on the native module graph instead of re-evaluating them in jiti.
    nativeModules: resolvePluginLoaderJitiNativeModules(),
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
    ...(hasAliases
      ? {
          alias: jitiAliasMap,
        }
      : {}),
  };
}

function supportsNativeModuleRuntime(): boolean {
  const versions = process.versions as { bun?: string };
  return typeof versions.bun !== "string";
}

function isBundledPluginDistModulePath(modulePath: string): boolean {
  return modulePath.replace(/\\/g, "/").includes("/dist/extensions/");
}

function shouldPreferNativeModuleLoad(modulePath: string): boolean {
  if (!supportsNativeModuleRuntime()) {
    return false;
  }
  switch (normalizeLowercaseStringOrEmpty(path.extname(modulePath))) {
    case ".js":
    case ".mjs":
    case ".cjs":
    case ".json":
      return true;
    default:
      return false;
  }
}

function resolvePluginLoaderTryNative(
  modulePath: string,
  options?: {
    preferBuiltDist?: boolean;
  },
): boolean {
  if (isBundledPluginDistModulePath(modulePath)) {
    return shouldPreferNativeModuleLoad(modulePath);
  }
  return (
    shouldPreferNativeModuleLoad(modulePath) ||
    (supportsNativeModuleRuntime() &&
      options?.preferBuiltDist === true &&
      modulePath.includes(`${path.sep}dist${path.sep}`))
  );
}

export function createPluginLoaderModuleCacheKey(params: {
  tryNative: boolean;
  aliasMap: Record<string, string>;
}): string {
  const facts = sdkAliasFacts(params.aliasMap);
  const aliasMapKey = (facts.moduleKey ??= createJitiAliasContentCacheKey(params.aliasMap));
  return `${params.tryNative ? "native" : "transform"}\0${aliasMapKey}`;
}

export function resolvePluginLoaderModuleConfig(params: {
  modulePath: string;
  argv1?: string;
  moduleUrl: string;
  devSourceRoot?: string | null;
  preferBuiltDist?: boolean;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): {
  tryNative: boolean;
  aliasMap: Record<string, string>;
  cacheKey: string;
} {
  const configCacheKey = buildPluginLoaderModuleConfigCacheKey(params);
  const contexts = getPluginCache().sdk.contexts;
  const cached = contexts.get(configCacheKey)?.moduleConfig;
  if (cached) {
    return cached;
  }

  const tryNative = resolvePluginLoaderTryNative(
    params.modulePath,
    params.preferBuiltDist ? { preferBuiltDist: true } : {},
  );
  const aliasMap = buildPluginLoaderAliasMap(
    params.modulePath,
    params.argv1,
    params.moduleUrl,
    params.pluginSdkResolution,
    params.devSourceRoot,
  );
  const result = {
    tryNative,
    aliasMap,
    cacheKey: createPluginLoaderModuleCacheKey({
      tryNative,
      aliasMap,
    }),
  };
  contexts.set(configCacheKey, { ...contexts.get(configCacheKey), moduleConfig: result });
  return result;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
