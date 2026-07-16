// Thin ESM wrapper so native dynamic import() resolves in source-checkout mode
// while packaged dist builds resolve a distinct runtime entry that cannot loop
// back into this wrapper through the stable root runtime alias.
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { createJiti } = require("jiti");

const PLUGIN_ID = "matrix";
const OPENCLAW_PLUGIN_SDK_PACKAGE_NAMES = [
  ["openclaw", "plugin-sdk"].join("/"),
  ["@openclaw", "plugin-sdk"].join("/"),
];
const PLUGIN_SDK_EXPORT_PREFIX = "./plugin-sdk/";
const PLUGIN_SDK_SOURCE_EXTENSIONS = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"];
const PLUGIN_ENTRY_RUNTIME_BASENAME = "plugin-entry.handlers.runtime";
const JITI_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".mtsx",
  ".ctsx",
  ".js",
  ".mjs",
  ".cjs",
  ".json",
];

function readPackageJson(packageRoot) {
  try {
    return JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function normalizeLowercaseStringOrEmpty(value) {
  return typeof value === "string" ? value.toLowerCase() : "";
}

function hasTrustedOpenClawRootIndicator(packageRoot, packageJson) {
  const packageExports = packageJson?.exports ?? {};
  if (!Object.prototype.hasOwnProperty.call(packageExports, "./plugin-sdk")) {
    return false;
  }
  const hasCliEntryExport = Object.prototype.hasOwnProperty.call(packageExports, "./cli-entry");
  const hasOpenClawBin =
    (typeof packageJson?.bin === "string" &&
      normalizeLowercaseStringOrEmpty(packageJson.bin).includes("openclaw")) ||
    (typeof packageJson?.bin === "object" &&
      packageJson.bin !== null &&
      typeof packageJson.bin.openclaw === "string");
  const hasOpenClawEntrypoint = fs.existsSync(path.join(packageRoot, "openclaw.mjs"));
  return hasCliEntryExport || hasOpenClawBin || hasOpenClawEntrypoint;
}

function findOpenClawPackageRoot(startDir) {
  let cursor = path.resolve(startDir);
  for (let i = 0; i < 12; i += 1) {
    const pkg = readPackageJson(cursor);
    if (pkg?.name === "openclaw" && hasTrustedOpenClawRootIndicator(cursor, pkg)) {
      return { packageRoot: cursor, packageJson: pkg };
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }
  return null;
}

function resolveExistingFile(basePath, extensions) {
  for (const ext of extensions) {
    const candidate = `${basePath}${ext}`;
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function buildPluginSdkAliasMap(moduleUrl) {
  const location = findOpenClawPackageRoot(path.dirname(fileURLToPath(moduleUrl)));
  if (!location) {
    return {};
  }

  const { packageRoot, packageJson } = location;
  const sourcePluginSdkDir = path.join(packageRoot, "src", "plugin-sdk");
  const distPluginSdkDir = path.join(packageRoot, "dist", "plugin-sdk");
  const aliasMap = {};
  const rootAlias =
    resolveExistingFile(path.join(sourcePluginSdkDir, "root-alias"), [".cjs"]) ??
    resolveExistingFile(path.join(distPluginSdkDir, "root-alias"), [".cjs"]);
  if (rootAlias) {
    for (const packageName of OPENCLAW_PLUGIN_SDK_PACKAGE_NAMES) {
      aliasMap[packageName] = rootAlias;
    }
  }

  for (const exportKey of Object.keys(packageJson.exports ?? {}).toSorted()) {
    if (!exportKey.startsWith(PLUGIN_SDK_EXPORT_PREFIX)) {
      continue;
    }
    const subpath = exportKey.slice(PLUGIN_SDK_EXPORT_PREFIX.length);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath)) {
      continue;
    }
    const resolvedPath =
      resolveExistingFile(path.join(sourcePluginSdkDir, subpath), PLUGIN_SDK_SOURCE_EXTENSIONS) ??
      resolveExistingFile(path.join(distPluginSdkDir, subpath), [".js"]);
    if (resolvedPath) {
      for (const packageName of OPENCLAW_PLUGIN_SDK_PACKAGE_NAMES) {
        aliasMap[`${packageName}/${subpath}`] = resolvedPath;
      }
    }
  }

  const extensionApi =
    resolveExistingFile(
      path.join(packageRoot, "src", "extensionAPI"),
      PLUGIN_SDK_SOURCE_EXTENSIONS,
    ) ?? resolveExistingFile(path.join(packageRoot, "dist", "extensionAPI"), [".js"]);
  if (extensionApi) {
    aliasMap["openclaw/extension-api"] = extensionApi;
  }

  return aliasMap;
}

function resolveBundledPluginRuntimeModulePath(moduleUrl, params) {
  const modulePath = fileURLToPath(moduleUrl);
  const moduleDir = path.dirname(modulePath);
  const localCandidates = [
    path.join(moduleDir, "..", params.runtimeBasename),
    path.join(moduleDir, "extensions", params.pluginId, params.runtimeBasename),
  ];

  for (const candidate of localCandidates) {
    const resolved = resolveExistingFile(candidate, PLUGIN_SDK_SOURCE_EXTENSIONS);
    if (resolved) {
      return resolved;
    }
  }

  const location = findOpenClawPackageRoot(moduleDir);
  if (location) {
    const { packageRoot } = location;
    const packageCandidates = [
      path.join(packageRoot, "extensions", params.pluginId, params.runtimeBasename),
      path.join(packageRoot, "dist", "extensions", params.pluginId, params.runtimeBasename),
    ];

    for (const candidate of packageCandidates) {
      const resolved = resolveExistingFile(candidate, PLUGIN_SDK_SOURCE_EXTENSIONS);
      if (resolved) {
        return resolved;
      }
    }
  }

  throw new Error(
    `Cannot resolve ${params.pluginId} plugin runtime module ${params.runtimeBasename} from ${modulePath}`,
  );
}

const jiti = createJiti(import.meta.url, {
  alias: buildPluginSdkAliasMap(import.meta.url),
  interopDefault: true,
  tryNative: false,
  extensions: JITI_EXTENSIONS,
});

const mod = jiti(
  resolveBundledPluginRuntimeModulePath(import.meta.url, {
    pluginId: PLUGIN_ID,
    runtimeBasename: PLUGIN_ENTRY_RUNTIME_BASENAME,
  }),
);
export const ensureMatrixCryptoRuntime = mod.ensureMatrixCryptoRuntime;
export const handleVerifyRecoveryKey = mod.handleVerifyRecoveryKey;
export const handleVerificationBootstrap = mod.handleVerificationBootstrap;
export const handleVerificationStatus = mod.handleVerificationStatus;
