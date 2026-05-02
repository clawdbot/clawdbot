"use strict";

const path = require("node:path");
const fs = require("node:fs");

let monolithicSdk = null;
let diagnosticEventsModule = null;
const moduleLoaders = new Map();
const pluginSdkSubpathsCache = new Map();
const pluginSdkPackageNames = ["openclaw/plugin-sdk", "@openclaw/plugin-sdk"];
const pluginSdkSourceExtensions = [".ts", ".mts", ".js", ".mjs", ".cts", ".cjs"];
const isDistRootAlias = __filename.includes(
  `${path.sep}dist${path.sep}plugin-sdk${path.sep}root-alias.cjs`,
);
// Source plugin entry loading must stay on the source graph end-to-end. Mixing a
// source root alias with dist compat/runtime shims can split singleton deps
// (for example matrix-js-sdk) across two module graphs.
const shouldPreferSourceGraph =
  !isDistRootAlias &&
  (process.env.NODE_ENV !== "production" ||
    Boolean(process.env.VITEST) ||
    process.env.OPENCLAW_PLUGIN_SDK_SOURCE_IN_TESTS === "1");

function emptyPluginConfigSchema() {
  function error(message) {
    return { success: false, error: { issues: [{ path: [], message }] } };
  }

  return {
    safeParse(value) {
      if (value === undefined) {
        return { success: true, data: undefined };
      }
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return error("expected config object");
      }
      if (Object.keys(value).length > 0) {
        return error("config must be empty");
      }
      return { success: true, data: value };
    },
    jsonSchema: {
      type: "object",
      additionalProperties: false,
      properties: {},
    },
  };
}

function resolveCommandAuthorizedFromAuthorizers(params) {
  const { useAccessGroups, authorizers } = params;
  const mode = params.modeWhenAccessGroupsOff ?? "allow";
  if (!useAccessGroups) {
    if (mode === "allow") {
      return true;
    }
    if (mode === "deny") {
      return false;
    }
    const anyConfigured = authorizers.some((entry) => entry.configured);
    if (!anyConfigured) {
      return true;
    }
    return authorizers.some((entry) => entry.configured && entry.allowed);
  }
  return authorizers.some((entry) => entry.configured && entry.allowed);
}

function resolveControlCommandGate(params) {
  const commandAuthorized = resolveCommandAuthorizedFromAuthorizers({
    useAccessGroups: params.useAccessGroups,
    authorizers: params.authorizers,
    modeWhenAccessGroupsOff: params.modeWhenAccessGroupsOff,
  });
  const shouldBlock = params.allowTextCommands && params.hasControlCommand && !commandAuthorized;
  return { commandAuthorized, shouldBlock };
}

function onDiagnosticEvent(listener) {
  const diagnosticEvents = loadDiagnosticEventsModule();
  if (!diagnosticEvents || typeof diagnosticEvents.onDiagnosticEvent !== "function") {
    throw new Error("openclaw/plugin-sdk root alias could not resolve onDiagnosticEvent");
  }
  return diagnosticEvents.onDiagnosticEvent(listener);
}

function getPackageRoot() {
  return path.resolve(__dirname, "..", "..");
}

function findDistChunkByPrefix(prefix) {
  const distRoot = path.join(getPackageRoot(), "dist");
  try {
    const entries = fs
      .readdirSync(distRoot, { withFileTypes: true })
      .toSorted((left, right) => left.name.localeCompare(right.name));
    const match = entries.find(
      (entry) =>
        entry.isFile() && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith(".js"),
    );
    return match ? path.join(distRoot, match.name) : null;
  } catch {
    return null;
  }
}

function listPluginSdkExportedSubpaths() {
  const packageRoot = getPackageRoot();
  const cacheKey = `${packageRoot}::privateQa=${process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI === "1" ? "1" : "0"}`;
  if (pluginSdkSubpathsCache.has(cacheKey)) {
    return pluginSdkSubpathsCache.get(cacheKey);
  }

  let subpaths = [];
  try {
    const packageJsonPath = path.join(packageRoot, "package.json");
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
    subpaths = Object.keys(packageJson.exports ?? {})
      .filter((key) => key.startsWith("./plugin-sdk/"))
      .map((key) => key.slice("./plugin-sdk/".length))
      .filter((subpath) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath))
      .toSorted();
  } catch {
    subpaths = [];
  }

  pluginSdkSubpathsCache.set(cacheKey, subpaths);
  return subpaths;
}

function listPrivateLocalOnlyPluginSdkSubpaths() {
  if (process.env.OPENCLAW_ENABLE_PRIVATE_QA_CLI !== "1") {
    return [];
  }
  try {
    const raw = fs.readFileSync(
      path.join(getPackageRoot(), "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (subpath) => typeof subpath === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath),
    );
  } catch {
    return [];
  }
}

function listPluginSdkRootAliasSubpaths() {
  const exportedSubpaths = listPluginSdkExportedSubpaths();
  return [...new Set([...exportedSubpaths, ...listPrivateLocalOnlyPluginSdkSubpaths()])].toSorted(
    (left, right) => left.localeCompare(right),
  );
}

function buildPluginSdkAliasMap(useDist) {
  const packageRoot = getPackageRoot();
  const pluginSdkDir = path.join(packageRoot, useDist ? "dist" : "src", "plugin-sdk");
  const normalizeTarget = (target) =>
    process.platform === "win32" ? target.replace(/\\/g, "/") : target;
  const aliasMap = {};

  for (const subpath of listPluginSdkRootAliasSubpaths()) {
    if (useDist) {
      const candidate = path.join(pluginSdkDir, `${subpath}.js`);
      if (fs.existsSync(candidate)) {
        for (const packageName of pluginSdkPackageNames) {
          aliasMap[`${packageName}/${subpath}`] = normalizeTarget(candidate);
        }
      }
      continue;
    }
    for (const ext of pluginSdkSourceExtensions) {
      const candidate = path.join(pluginSdkDir, `${subpath}${ext}`);
      if (!fs.existsSync(candidate)) {
        continue;
      }
      for (const packageName of pluginSdkPackageNames) {
        aliasMap[`${packageName}/${subpath}`] = normalizeTarget(candidate);
      }
      break;
    }
  }

  // Keep the bare root alias last so subpath aliases win under resolvers that
  // perform prefix matching instead of exact-key lookup.
  for (const packageName of pluginSdkPackageNames) {
    aliasMap[packageName] = normalizeTarget(__filename);
  }

  return aliasMap;
}

function getModuleLoader(tryNative) {
  const effectiveTryNative = process.platform === "win32" ? false : tryNative;

  if (moduleLoaders.has(effectiveTryNative)) {
    return moduleLoaders.get(effectiveTryNative);
  }

  const { createJiti } = require("jiti");
  const moduleLoader = createJiti(__filename, {
    alias: buildPluginSdkAliasMap(effectiveTryNative),
    interopDefault: true,
    // Prefer Node's native sync ESM loader for built dist/plugin-sdk/*.js files
    // so local plugins do not create a second transpiled OpenClaw core graph.
    tryNative: effectiveTryNative,
    extensions: [".ts", ".tsx", ".mts", ".cts", ".mtsx", ".ctsx", ".js", ".mjs", ".cjs", ".json"],
  });
  moduleLoaders.set(effectiveTryNative, moduleLoader);
  return moduleLoader;
}

function loadMonolithicSdk() {
  if (monolithicSdk) {
    return monolithicSdk;
  }

  const distCandidate = path.resolve(__dirname, "..", "..", "dist", "plugin-sdk", "compat.js");
  if (!shouldPreferSourceGraph && fs.existsSync(distCandidate)) {
    try {
      monolithicSdk = getModuleLoader(true)(distCandidate);
      return monolithicSdk;
    } catch {
      // Fall through to source alias if dist is unavailable or stale.
    }
  }

  monolithicSdk = getModuleLoader(false)(
    path.join(getPackageRoot(), "src", "plugin-sdk", "compat.ts"),
  );
  return monolithicSdk;
}

function loadDiagnosticEventsModule() {
  if (diagnosticEventsModule) {
    return diagnosticEventsModule;
  }

  const directDistCandidate = path.resolve(
    __dirname,
    "..",
    "..",
    "dist",
    "infra",
    "diagnostic-events.js",
  );
  if (!shouldPreferSourceGraph) {
    const distCandidate =
      (fs.existsSync(directDistCandidate) && directDistCandidate) ||
      findDistChunkByPrefix("diagnostic-events");
    if (distCandidate) {
      try {
        diagnosticEventsModule = normalizeDiagnosticEventsModule(
          getModuleLoader(true)(distCandidate),
        );
        return diagnosticEventsModule;
      } catch {
        // Fall through to source path if dist is unavailable or stale.
      }
    }
  }

  diagnosticEventsModule = normalizeDiagnosticEventsModule(
    getModuleLoader(false)(path.join(getPackageRoot(), "src", "infra", "diagnostic-events.ts")),
  );
  return diagnosticEventsModule;
}

function normalizeDiagnosticEventsModule(mod) {
  if (!mod || typeof mod !== "object") {
    return mod;
  }
  if (typeof mod.onDiagnosticEvent === "function") {
    return mod;
  }
  if (typeof mod.r === "function") {
    return {
      ...mod,
      onDiagnosticEvent: mod.r,
    };
  }
  return mod;
}

function tryLoadMonolithicSdk() {
  try {
    return loadMonolithicSdk();
  } catch {
    return null;
  }
}

const fastExports = {
  emptyPluginConfigSchema,
  onDiagnosticEvent,
  resolveControlCommandGate,
};

const target = { ...fastExports };
let rootExports = null;

function shouldResolveMonolithic(prop) {
  if (typeof prop !== "string") {
    return false;
  }
  return prop !== "then";
}

function getMonolithicSdk() {
  const loaded = tryLoadMonolithicSdk();
  if (loaded && typeof loaded === "object") {
    return loaded;
  }
  return null;
}

function getExportValue(prop) {
  if (Reflect.has(target, prop)) {
    return Reflect.get(target, prop);
  }
  if (!shouldResolveMonolithic(prop)) {
    return undefined;
  }
  const monolithic = getMonolithicSdk();
  if (!monolithic) {
    return undefined;
  }
  return Reflect.get(monolithic, prop);
}

function getExportDescriptor(prop) {
  const ownDescriptor = Reflect.getOwnPropertyDescriptor(target, prop);
  if (ownDescriptor) {
    return ownDescriptor;
  }
  if (!shouldResolveMonolithic(prop)) {
    return undefined;
  }

  const monolithic = getMonolithicSdk();
  if (!monolithic) {
    return undefined;
  }

  const descriptor = Reflect.getOwnPropertyDescriptor(monolithic, prop);
  if (!descriptor) {
    return undefined;
  }

  // Proxy invariants require descriptors returned for dynamic properties to be configurable.
  return {
    ...descriptor,
    configurable: true,
  };
}

rootExports = new Proxy(target, {
  get(_target, prop, receiver) {
    if (Reflect.has(target, prop)) {
      return Reflect.get(target, prop, receiver);
    }
    return getExportValue(prop);
  },
  has(_target, prop) {
    if (Reflect.has(target, prop)) {
      return true;
    }
    if (!shouldResolveMonolithic(prop)) {
      return false;
    }
    const monolithic = getMonolithicSdk();
    return monolithic ? Reflect.has(monolithic, prop) : false;
  },
  ownKeys() {
    const keys = new Set(Reflect.ownKeys(target));
    if (monolithicSdk && typeof monolithicSdk === "object") {
      for (const key of Reflect.ownKeys(monolithicSdk)) {
        if (!keys.has(key)) {
          keys.add(key);
        }
      }
    }
    return [...keys];
  },
  getOwnPropertyDescriptor(_target, prop) {
    return getExportDescriptor(prop);
  },
});

Object.defineProperty(target, "__esModule", {
  configurable: true,
  enumerable: false,
  writable: false,
  value: true,
});
Object.defineProperty(target, "default", {
  configurable: true,
  enumerable: false,
  get() {
    return rootExports;
  },
});

module.exports = rootExports;
