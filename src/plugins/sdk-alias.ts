// Resolves plugin SDK aliases for public package imports.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { tryReadJsonSync } from "../infra/json-files.js";
import { resolveOpenClawPackageRootSync } from "../infra/openclaw-root.js";
import { resolveOpenClawDevSourceRoot } from "./dev-source-root.js";
import { PluginLruCache } from "./plugin-cache-primitives.js";

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

export type PluginRuntimeModuleResolution = {
  modulePath?: string;
  packageRoot: string | null;
  candidates: string[];
  resolvedPath: string | null;
  error?: string;
};

type PluginSdkPackageJson = {
  exports?: Record<string, unknown>;
  bin?: string | Record<string, unknown>;
  version?: string;
};

type WorkspacePackageAliasEntry = {
  packageName: string;
  packageDir: string;
  subpath: string;
  srcFile: string;
  distFile: string;
};

const STARTUP_ARGV1 = process.argv[1];
const pluginSdkPackageJsonByRoot = new Map<string, PluginSdkPackageJson | null>();

function sanitizeJitiCachePathSegment(value: string): string {
  const normalized = value.replace(/[^A-Za-z0-9._-]+/g, "_").replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized : "unknown";
}

function resolveJitiFsCacheTmpDir(): string {
  let tmpDir = os.tmpdir();
  if (process.env.TMPDIR && tmpDir === process.cwd() && !process.env.JITI_RESPECT_TMPDIR_ENV) {
    const originalTmpDir = process.env.TMPDIR;
    delete process.env.TMPDIR;
    try {
      tmpDir = os.tmpdir();
    } finally {
      process.env.TMPDIR = originalTmpDir;
    }
  }
  return tmpDir;
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
  const cacheKey = path.resolve(packageRoot);
  if (pluginSdkPackageJsonByRoot.has(cacheKey)) {
    return pluginSdkPackageJsonByRoot.get(cacheKey) ?? null;
  }
  const parsed = tryReadJsonSync<PluginSdkPackageJson>(path.join(packageRoot, "package.json"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    pluginSdkPackageJsonByRoot.set(cacheKey, null);
    return null;
  }
  pluginSdkPackageJsonByRoot.set(cacheKey, parsed);
  return parsed;
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
  try {
    const stat = fs.statSync(packageJsonPath);
    installMarker = `${Math.trunc(stat.mtimeMs)}-${stat.size}`;
  } catch {
    // Package installs should have package.json; keep cache setup best-effort.
  }
  return path.join(
    resolveJitiFsCacheTmpDir(),
    "jiti",
    "openclaw",
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
  const packageExports = params.packageJson.exports ?? {};
  const hasPluginSdkRootExport = Object.hasOwn(packageExports, "./plugin-sdk");
  if (!hasPluginSdkRootExport) {
    return false;
  }
  const hasCliEntryExport = Object.hasOwn(packageExports, "./cli-entry");
  const hasOpenClawBin =
    (typeof params.packageJson.bin === "string" &&
      normalizeLowercaseStringOrEmpty(params.packageJson.bin).includes("openclaw")) ||
    (typeof params.packageJson.bin === "object" &&
      params.packageJson.bin !== null &&
      typeof params.packageJson.bin.openclaw === "string");
  const hasOpenClawEntrypoint = fs.existsSync(path.join(params.packageRoot, "openclaw.mjs"));
  return hasCliEntryExport || hasOpenClawBin || hasOpenClawEntrypoint;
}

function readPluginSdkSubpathsFromPackageRoot(packageRoot: string): string[] | null {
  const pkg = readPluginSdkPackageJson(packageRoot);
  if (!pkg) {
    return null;
  }
  if (!hasTrustedOpenClawRootIndicator({ packageRoot, packageJson: pkg })) {
    return null;
  }
  const subpaths = listPluginSdkSubpathsFromPackageJson(pkg);
  return subpaths.length > 0 ? subpaths : null;
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
    const resolved = fs.realpathSync(normalized);
    if (resolved !== normalized) {
      starts.push(path.dirname(resolved));
    }
  } catch {
    // Keep the unresolved argv path; startup shims may not exist in tests.
  }
  starts.push(path.dirname(normalized));
  return dedupeResolvedPaths(starts);
}

function formatResolutionError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

function listPluginSdkAliasCandidates(params: {
  srcFile: string;
  distFile: string;
  modulePath: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}) {
  const orderedKinds = resolvePluginSdkAliasCandidateOrder({
    modulePath: params.modulePath,
    isProduction: process.env.NODE_ENV === "production",
    pluginSdkResolution: params.pluginSdkResolution,
  });
  const packageRoot = resolveLoaderPluginSdkPackageRoot(params);
  if (packageRoot) {
    const candidateMap = {
      src: path.join(packageRoot, "src", "plugin-sdk", params.srcFile),
      dist: path.join(packageRoot, "dist", "plugin-sdk", params.distFile),
    } as const;
    return orderedKinds.map((kind) => candidateMap[kind]);
  }
  let cursor = path.dirname(params.modulePath);
  const candidates: string[] = [];
  for (let i = 0; i < 6; i += 1) {
    const candidateMap = {
      src: path.join(cursor, "src", "plugin-sdk", params.srcFile),
      dist: path.join(cursor, "dist", "plugin-sdk", params.distFile),
    } as const;
    for (const kind of orderedKinds) {
      candidates.push(candidateMap[kind]);
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return candidates;
}

function resolvePluginSdkAliasFile(params: {
  srcFile: string;
  distFile: string;
  modulePath?: string;
  argv1?: string;
  cwd?: string;
  moduleUrl?: string;
  devSourceRoot?: string | null;
  pluginSdkResolution?: PluginSdkResolutionPreference;
}): string | null {
  try {
    const modulePath = resolveLoaderModulePath(params);
    for (const candidate of listPluginSdkAliasCandidates({
      srcFile: params.srcFile,
      distFile: params.distFile,
      modulePath,
      argv1: params.argv1,
      cwd: params.cwd,
      moduleUrl: params.moduleUrl,
      devSourceRoot: params.devSourceRoot,
      pluginSdkResolution: params.pluginSdkResolution,
    })) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch {
    // ignore
  }
  return null;
}

const MAX_PLUGIN_LOADER_ALIAS_CACHE_ENTRIES = 512;
const cachedPluginSdkExportedSubpaths = new PluginLruCache<string[]>(
  MAX_PLUGIN_LOADER_ALIAS_CACHE_ENTRIES,
);
const cachedPluginSdkScopedAliasMaps = new PluginLruCache<Record<string, string>>(
  MAX_PLUGIN_LOADER_ALIAS_CACHE_ENTRIES,
);
const cachedBundledPluginPublicSurfaceAliasMaps = new PluginLruCache<Record<string, string>>(
  MAX_PLUGIN_LOADER_ALIAS_CACHE_ENTRIES,
);
const PLUGIN_SDK_PACKAGE_NAMES = ["openclaw/plugin-sdk", "@openclaw/plugin-sdk"] as const;
const CODEX_NATIVE_TASK_RUNTIME_PLUGIN_SDK_SUBPATH = "codex-native-task-runtime";
const CODEX_MCP_PROJECTION_PLUGIN_SDK_SUBPATH = "codex-mcp-projection";
const OLLAMA_CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH = "ssrf-runtime-internal";
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
      CODEX_NATIVE_TASK_RUNTIME_PLUGIN_SDK_SUBPATH,
      CODEX_MCP_PROJECTION_PLUGIN_SDK_SUBPATH,
    ],
  },
  {
    bundledPluginId: "ollama",
    allowPrivateQaCli: false,
    subpaths: [OLLAMA_CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH],
  },
  {
    bundledPluginId: "browser",
    allowPrivateQaCli: false,
    subpaths: [OLLAMA_CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH],
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
const WORKSPACE_PACKAGE_ALIAS_ENTRIES: WorkspacePackageAliasEntry[] = [
  {
    packageName: "@openclaw/gateway-client",
    packageDir: "gateway-client",
    subpath: "",
    srcFile: "index.ts",
    distFile: "index.mjs",
  },
  {
    packageName: "@openclaw/gateway-client",
    packageDir: "gateway-client",
    subpath: "readiness",
    srcFile: "readiness.ts",
    distFile: "readiness.mjs",
  },
  {
    packageName: "@openclaw/gateway-client",
    packageDir: "gateway-client",
    subpath: "timeouts",
    srcFile: "timeouts.ts",
    distFile: "timeouts.mjs",
  },
  {
    packageName: "@openclaw/gateway-protocol",
    packageDir: "gateway-protocol",
    subpath: "",
    srcFile: "index.ts",
    distFile: "index.mjs",
  },
  {
    packageName: "@openclaw/gateway-protocol",
    packageDir: "gateway-protocol",
    subpath: "client-info",
    srcFile: "client-info.ts",
    distFile: "client-info.mjs",
  },
  {
    packageName: "@openclaw/gateway-protocol",
    packageDir: "gateway-protocol",
    subpath: "connect-error-details",
    srcFile: "connect-error-details.ts",
    distFile: "connect-error-details.mjs",
  },
  {
    packageName: "@openclaw/gateway-protocol",
    packageDir: "gateway-protocol",
    subpath: "frame-guards",
    srcFile: "frame-guards.ts",
    distFile: "frame-guards.mjs",
  },
  {
    packageName: "@openclaw/gateway-protocol",
    packageDir: "gateway-protocol",
    subpath: "schema",
    srcFile: "schema.ts",
    distFile: "schema.mjs",
  },
  {
    packageName: "@openclaw/gateway-protocol",
    packageDir: "gateway-protocol",
    subpath: "startup-unavailable",
    srcFile: "startup-unavailable.ts",
    distFile: "startup-unavailable.mjs",
  },
  {
    packageName: "@openclaw/gateway-protocol",
    packageDir: "gateway-protocol",
    subpath: "version",
    srcFile: "version.ts",
    distFile: "version.mjs",
  },
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpath: "",
    srcFile: "index.ts",
    distFile: "index.mjs",
  },
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpath: "code-spans",
    srcFile: "code-spans.ts",
    distFile: "code-spans.mjs",
  },
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpath: "fences",
    srcFile: "fences.ts",
    distFile: "fences.mjs",
  },
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpath: "frontmatter",
    srcFile: "frontmatter.ts",
    distFile: "frontmatter.mjs",
  },
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpath: "ir",
    srcFile: "ir.ts",
    distFile: "ir.mjs",
  },
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpath: "render",
    srcFile: "render.ts",
    distFile: "render.mjs",
  },
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpath: "render-aware-chunking",
    srcFile: "render-aware-chunking.ts",
    distFile: "render-aware-chunking.mjs",
  },
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpath: "tables",
    srcFile: "tables.ts",
    distFile: "tables.mjs",
  },
  {
    packageName: "@openclaw/markdown-core",
    packageDir: "markdown-core",
    subpath: "types",
    srcFile: "types.ts",
    distFile: "types.mjs",
  },
  {
    packageName: "@openclaw/media-generation-core",
    packageDir: "media-generation-core",
    subpath: "",
    srcFile: "index.ts",
    distFile: "index.mjs",
  },
  {
    packageName: "@openclaw/media-generation-core",
    packageDir: "media-generation-core",
    subpath: "capability-model-ref",
    srcFile: "capability-model-ref.ts",
    distFile: "capability-model-ref.mjs",
  },
  {
    packageName: "@openclaw/media-generation-core",
    packageDir: "media-generation-core",
    subpath: "catalog",
    srcFile: "catalog.ts",
    distFile: "catalog.mjs",
  },
  {
    packageName: "@openclaw/media-generation-core",
    packageDir: "media-generation-core",
    subpath: "model-ref",
    srcFile: "model-ref.ts",
    distFile: "model-ref.mjs",
  },
  {
    packageName: "@openclaw/media-generation-core",
    packageDir: "media-generation-core",
    subpath: "normalization",
    srcFile: "normalization.ts",
    distFile: "normalization.mjs",
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpath: "",
    srcFile: "index.ts",
    distFile: "index.mjs",
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpath: "base64",
    srcFile: "base64.ts",
    distFile: "base64.mjs",
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpath: "constants",
    srcFile: "constants.ts",
    distFile: "constants.mjs",
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpath: "content-length",
    srcFile: "content-length.ts",
    distFile: "content-length.mjs",
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpath: "file-name",
    srcFile: "file-name.ts",
    distFile: "file-name.mjs",
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpath: "inbound-path-policy",
    srcFile: "inbound-path-policy.ts",
    distFile: "inbound-path-policy.mjs",
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpath: "inline-image-data-url",
    srcFile: "inline-image-data-url.ts",
    distFile: "inline-image-data-url.mjs",
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpath: "media-source-url",
    srcFile: "media-source-url.ts",
    distFile: "media-source-url.mjs",
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpath: "mime",
    srcFile: "mime.ts",
    distFile: "mime.mjs",
  },
  {
    packageName: "@openclaw/media-core",
    packageDir: "media-core",
    subpath: "read-byte-stream-with-limit",
    srcFile: "read-byte-stream-with-limit.ts",
    distFile: "read-byte-stream-with-limit.mjs",
  },
  {
    packageName: "@openclaw/retry",
    packageDir: "retry",
    subpath: "",
    srcFile: "index.ts",
    distFile: "index.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "",
    srcFile: "index.ts",
    distFile: "index.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "ansi",
    srcFile: "ansi.ts",
    distFile: "ansi.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "decorative-emoji",
    srcFile: "decorative-emoji.ts",
    distFile: "decorative-emoji.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "health-style",
    srcFile: "health-style.ts",
    distFile: "health-style.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "links",
    srcFile: "links.ts",
    distFile: "links.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "note",
    srcFile: "note.ts",
    distFile: "note.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "osc-progress",
    srcFile: "osc-progress.ts",
    distFile: "osc-progress.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "palette",
    srcFile: "palette.ts",
    distFile: "palette.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "progress-line",
    srcFile: "progress-line.ts",
    distFile: "progress-line.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "prompt-select-styled",
    srcFile: "prompt-select-styled.ts",
    distFile: "prompt-select-styled.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "prompt-select-styled-params",
    srcFile: "prompt-select-styled-params.ts",
    distFile: "prompt-select-styled-params.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "prompt-style",
    srcFile: "prompt-style.ts",
    distFile: "prompt-style.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "restore",
    srcFile: "restore.ts",
    distFile: "restore.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "safe-text",
    srcFile: "safe-text.ts",
    distFile: "safe-text.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "stream-writer",
    srcFile: "stream-writer.ts",
    distFile: "stream-writer.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "table",
    srcFile: "table.ts",
    distFile: "table.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "terminal-link",
    srcFile: "terminal-link.ts",
    distFile: "terminal-link.mjs",
  },
  {
    packageName: "@openclaw/terminal-core",
    packageDir: "terminal-core",
    subpath: "theme",
    srcFile: "theme.ts",
    distFile: "theme.mjs",
  },
  {
    packageName: "@openclaw/net-policy",
    packageDir: "net-policy",
    subpath: "",
    srcFile: "index.ts",
    distFile: "index.mjs",
  },
  {
    packageName: "@openclaw/net-policy",
    packageDir: "net-policy",
    subpath: "ip",
    srcFile: "ip.ts",
    distFile: "ip.mjs",
  },
  {
    packageName: "@openclaw/net-policy",
    packageDir: "net-policy",
    subpath: "ipv4",
    srcFile: "ipv4.ts",
    distFile: "ipv4.mjs",
  },
  {
    packageName: "@openclaw/net-policy",
    packageDir: "net-policy",
    subpath: "redact-sensitive-url",
    srcFile: "redact-sensitive-url.ts",
    distFile: "redact-sensitive-url.mjs",
  },
  {
    packageName: "@openclaw/net-policy",
    packageDir: "net-policy",
    subpath: "url-protocol",
    srcFile: "url-protocol.ts",
    distFile: "url-protocol.mjs",
  },
  {
    packageName: "@openclaw/net-policy",
    packageDir: "net-policy",
    subpath: "url-userinfo",
    srcFile: "url-userinfo.ts",
    distFile: "url-userinfo.mjs",
  },
  {
    packageName: "@openclaw/model-catalog-core",
    packageDir: "model-catalog-core",
    subpath: "",
    srcFile: "index.ts",
    distFile: "index.mjs",
  },
  {
    packageName: "@openclaw/model-catalog-core",
    packageDir: "model-catalog-core",
    subpath: "configured-model-refs",
    srcFile: "configured-model-refs.ts",
    distFile: "configured-model-refs.mjs",
  },
  {
    packageName: "@openclaw/model-catalog-core",
    packageDir: "model-catalog-core",
    subpath: "model-catalog-refs",
    srcFile: "model-catalog-refs.ts",
    distFile: "model-catalog-refs.mjs",
  },
  {
    packageName: "@openclaw/model-catalog-core",
    packageDir: "model-catalog-core",
    subpath: "model-catalog-normalize",
    srcFile: "model-catalog-normalize.ts",
    distFile: "model-catalog-normalize.mjs",
  },
  {
    packageName: "@openclaw/model-catalog-core",
    packageDir: "model-catalog-core",
    subpath: "model-catalog-types",
    srcFile: "model-catalog-types.ts",
    distFile: "model-catalog-types.mjs",
  },
  {
    packageName: "@openclaw/model-catalog-core",
    packageDir: "model-catalog-core",
    subpath: "provider-id",
    srcFile: "provider-id.ts",
    distFile: "provider-id.mjs",
  },
  {
    packageName: "@openclaw/model-catalog-core",
    packageDir: "model-catalog-core",
    subpath: "provider-model-id-normalization",
    srcFile: "provider-model-id-normalization.ts",
    distFile: "provider-model-id-normalization.mjs",
  },
  {
    packageName: "@openclaw/model-catalog-core",
    packageDir: "model-catalog-core",
    subpath: "provider-model-id-normalize",
    srcFile: "provider-model-id-normalize.ts",
    distFile: "provider-model-id-normalize.mjs",
  },
] as const;
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
  if (!fs.existsSync(distRoot)) {
    return [];
  }
  const entries: WorkspacePackageAliasEntry[] = [];
  const visit = (dir: string, prefix = "") => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
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
  const packageJsonPath = path.join(
    params.packageRoot,
    "packages",
    params.packageDir,
    "package.json",
  );
  const fallbackPackageRoot = resolveOpenClawPackageRootSync({ cwd: process.cwd() });
  const packageJson =
    tryReadJsonSync<PluginSdkPackageJson>(packageJsonPath) ??
    (fallbackPackageRoot
      ? tryReadJsonSync<PluginSdkPackageJson>(
          path.join(fallbackPackageRoot, "packages", params.packageDir, "package.json"),
        )
      : null);
  const exports = packageJson?.exports;
  if (!exports || typeof exports !== "object" || Array.isArray(exports)) {
    return listRootPackagedWorkspacePackageAliasEntries(params);
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
  return entries.length > 0
    ? entries.toSorted((a, b) => a.subpath.localeCompare(b.subpath))
    : listRootPackagedWorkspacePackageAliasEntries(params);
}

function isUsableDistPluginSdkArtifact(candidate: string): boolean {
  if (!fs.existsSync(candidate)) {
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
      if (!specifier || fs.existsSync(path.resolve(path.dirname(candidate), specifier))) {
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
  const parsed = tryReadJsonSync(
    path.join(packageRoot, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
  );
  return [
    ...new Set([
      CODEX_NATIVE_TASK_RUNTIME_PLUGIN_SDK_SUBPATH,
      CODEX_MCP_PROJECTION_PLUGIN_SDK_SUBPATH,
      OLLAMA_CONFIGURED_LOCAL_ORIGIN_RUNTIME_PLUGIN_SDK_SUBPATH,
      ...(Array.isArray(parsed)
        ? parsed.filter((subpath): subpath is string => isSafePluginSdkSubpathSegment(subpath))
        : []),
    ]),
  ];
}

function readBundledPluginPackageName(packageJsonPath: string): string | null {
  const parsed = tryReadJsonSync<{ name?: unknown }>(packageJsonPath);
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
    return fs
      .readdirSync(params.extensionSourceRoot, { withFileTypes: true })
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
      if (fs.existsSync(candidate)) {
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
      if (fs.existsSync(candidate)) {
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
  const cacheKey = `${packageRoot}::${orderedKinds.join(",")}::privateQa=${includePrivateQa ? "1" : "0"}`;
  const cached = cachedBundledPluginPublicSurfaceAliasMaps.get(cacheKey);
  if (cached) {
    return cached;
  }
  const extensionsRoot = path.join(packageRoot, "extensions");
  let extensionDirs: fs.Dirent[];
  try {
    extensionDirs = fs.readdirSync(extensionsRoot, { withFileTypes: true });
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
  const aliasMap: Record<string, string> = {};
  const workspacePackageAliasEntries = [
    ...WORKSPACE_PACKAGE_ALIAS_ENTRIES,
    ...["normalization-core", "acp-core"].flatMap((packageDir) =>
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
      const candidate = candidates.find((candidatePath) => fs.existsSync(candidatePath));
      if (candidate) {
        aliasMap[alias] = normalizeJitiAliasTargetPath(candidate);
        break;
      }
    }
  }
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
    const packageJson = tryReadJsonSync<{ name?: unknown }>(path.join(cursor, "package.json"));
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
  const owners = findPrivatePluginSdkSubpathOwners(params.subpath);
  if (owners.length === 0) {
    return shouldIncludePrivateLocalOnlyPluginSdkSubpaths();
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
    fs.existsSync(path.join(packageRoot, "src", "plugin-sdk", `${subpath}${ext}`)),
  );
}

function listDistPluginSdkArtifactSubpaths(packageRoot: string): Set<string> {
  try {
    const distPluginSdkDir = path.join(packageRoot, "dist", "plugin-sdk");
    return new Set(
      fs
        .readdirSync(distPluginSdkDir, { withFileTypes: true })
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
  const cacheKey = `${packageRoot}::privateQa=${shouldIncludePrivateLocalOnlyPluginSdkSubpaths() ? "1" : "0"}::privateOwners=${trustedPrivateOwners.join(",")}`;
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
  const cacheKey = `${packageRoot}::${orderedKinds.join(",")}::privateQa=${shouldIncludePrivateLocalOnlyPluginSdkSubpaths() ? "1" : "0"}::privateOwners=${trustedPrivateOwners.join(",")}`;
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
        if (!fs.existsSync(candidate)) {
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

function resolveExtensionApiAlias(params: LoaderModuleResolveParams = {}): string | null {
  try {
    const modulePath = resolveLoaderModulePath(params);
    const packageRoot =
      resolveDevSourceRootParam(params) ?? resolveLoaderPackageRoot({ ...params, modulePath });
    if (!packageRoot) {
      return null;
    }

    const orderedKinds = resolvePluginSdkAliasCandidateOrder({
      modulePath,
      isProduction: process.env.NODE_ENV === "production",
      pluginSdkResolution: params.pluginSdkResolution,
    });
    for (const kind of orderedKinds) {
      if (kind === "dist") {
        const candidate = path.join(packageRoot, "dist", "extensionAPI.js");
        if (fs.existsSync(candidate)) {
          return candidate;
        }
        continue;
      }
      for (const ext of PLUGIN_SDK_SOURCE_CANDIDATE_EXTENSIONS) {
        const candidate = path.join(packageRoot, "src", `extensionAPI${ext}`);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  } catch {
    // ignore
  }
  return null;
}

const JITI_NORMALIZED_ALIAS_SYMBOL = Symbol.for("pathe:normalizedAlias");
const JITI_ALIAS_ROOT_SENTINELS = new Set<string | undefined>(["/", "\\", undefined]);
const JITI_CONCRETE_ALIAS_TARGET_PATTERN = /^(?:[A-Za-z]:[/\\]|[/\\])/;

// Memoize loader alias/config by effective resolution context so repeated
// loader setup avoids rebuilding the same filesystem-derived map and cache key.
// Include cwd/env inputs because the fallback root and private QA alias
// surfaces depend on them.
const aliasMapCache = new PluginLruCache<Record<string, string>>(
  MAX_PLUGIN_LOADER_ALIAS_CACHE_ENTRIES,
);
const normalizedJitiAliasMapCache = new PluginLruCache<Record<string, string>>(
  MAX_PLUGIN_LOADER_ALIAS_CACHE_ENTRIES,
);
const normalizedJitiAliasMapByInput = new WeakMap<Record<string, string>, Record<string, string>>();
const pluginLoaderModuleCacheKeyByAliasMap = new WeakMap<Record<string, string>, string>();
const pluginLoaderModuleConfigCache = new PluginLruCache<{
  tryNative: boolean;
  aliasMap: Record<string, string>;
  cacheKey: string;
}>(MAX_PLUGIN_LOADER_ALIAS_CACHE_ENTRIES);

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
  const cachedByInput = normalizedJitiAliasMapByInput.get(aliasMap);
  if (cachedByInput) {
    return cachedByInput;
  }
  const cacheKey = createJitiAliasContentCacheKey(aliasMap);
  const cached = normalizedJitiAliasMapCache.get(cacheKey);
  if (cached) {
    normalizedJitiAliasMapByInput.set(aliasMap, cached);
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
  normalizedJitiAliasMapByInput.set(aliasMap, normalizedAliasMap);
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
  const cached = aliasMapCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const pluginSdkAlias = resolvePluginSdkAliasFile({
    srcFile: "root-alias.cjs",
    distFile: "root-alias.cjs",
    modulePath,
    argv1,
    moduleUrl,
    pluginSdkResolution,
    devSourceRoot,
  });
  const extensionApiAlias = resolveExtensionApiAlias({
    modulePath,
    pluginSdkResolution,
    devSourceRoot,
  });
  const result: Record<string, string> = {
    ...(extensionApiAlias
      ? { "openclaw/extension-api": normalizeJitiAliasTargetPath(extensionApiAlias) }
      : {}),
    ...resolveBundledPluginPackagePublicSurfaceAliasMap({
      modulePath,
      argv1,
      moduleUrl,
      pluginSdkResolution,
      devSourceRoot,
    }),
    ...resolveWorkspacePackageAliasMap({
      modulePath,
      argv1,
      moduleUrl,
      pluginSdkResolution,
      devSourceRoot,
    }),
    ...(pluginSdkAlias
      ? Object.fromEntries(
          PLUGIN_SDK_PACKAGE_NAMES.map((packageName) => [
            packageName,
            normalizeJitiAliasTargetPath(pluginSdkAlias),
          ]),
        )
      : {}),
    ...Object.fromEntries(
      Object.entries(
        resolvePluginSdkScopedAliasMap({
          modulePath,
          argv1,
          moduleUrl,
          pluginSdkResolution,
          devSourceRoot,
        }),
      ).map(([key, value]) => [key, normalizeJitiAliasTargetPath(value)]),
    ),
  };
  aliasMapCache.set(cacheKey, result);
  return result;
}

export function resolvePluginRuntimeModulePathWithDiagnostics(
  params: LoaderModuleResolveParams = {},
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
      if (fs.existsSync(candidate)) {
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
      error: formatResolutionError(error),
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

export function shouldPreferNativeModuleLoad(modulePath: string): boolean {
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

export function resolvePluginLoaderTryNative(
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
  const aliasMapKey =
    pluginLoaderModuleCacheKeyByAliasMap.get(params.aliasMap) ??
    createJitiAliasContentCacheKey(params.aliasMap);
  pluginLoaderModuleCacheKeyByAliasMap.set(params.aliasMap, aliasMapKey);
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
  const cached = pluginLoaderModuleConfigCache.get(configCacheKey);
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
  pluginLoaderModuleConfigCache.set(configCacheKey, result);
  return result;
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
