// Thin ESM wrapper so native dynamic import() resolves in source-checkout mode
// while packaged dist builds resolve a distinct runtime entry that cannot loop
// back into this wrapper through the stable root runtime alias.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const PLUGIN_ID = "matrix";
const PLUGIN_ENTRY_RUNTIME_BASENAME = "plugin-entry.handlers.runtime";
const NATIVE_RUNTIME_EXTENSIONS = [".js", ".mjs", ".cjs"];

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

function resolveBundledPluginRuntimeModulePath(moduleUrl, params) {
  const modulePath = fileURLToPath(moduleUrl);
  const moduleDir = path.dirname(modulePath);
  const localCandidates = [
    path.join(moduleDir, "..", params.runtimeBasename),
    path.join(moduleDir, "extensions", params.pluginId, params.runtimeBasename),
  ];

  for (const candidate of localCandidates) {
    const resolved = resolveExistingFile(candidate, NATIVE_RUNTIME_EXTENSIONS);
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
      const resolved = resolveExistingFile(candidate, NATIVE_RUNTIME_EXTENSIONS);
      if (resolved) {
        return resolved;
      }
    }
  }

  throw new Error(
    `Cannot resolve ${params.pluginId} plugin runtime module ${params.runtimeBasename} from ${modulePath}`,
  );
}

async function loadRuntimeModule(modulePath) {
  return import(pathToFileURL(modulePath).href);
}

const mod = await loadRuntimeModule(
  resolveBundledPluginRuntimeModulePath(import.meta.url, {
    pluginId: PLUGIN_ID,
    runtimeBasename: PLUGIN_ENTRY_RUNTIME_BASENAME,
  }),
);
export const ensureMatrixCryptoRuntime = mod.ensureMatrixCryptoRuntime;
export const handleVerifyRecoveryKey = mod.handleVerifyRecoveryKey;
export const handleVerificationBootstrap = mod.handleVerificationBootstrap;
export const handleVerificationStatus = mod.handleVerificationStatus;
