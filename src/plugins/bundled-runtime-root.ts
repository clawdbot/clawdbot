import fs from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import {
  ensureBundledPluginRuntimeDeps,
  resolveBundledRuntimeDependencyInstallRootPlan,
  resolveBundledRuntimeDependencyPackageRoot,
  registerBundledRuntimeDependencyNodePath,
  withBundledRuntimeDepsFilesystemLock,
  type BundledRuntimeDepsInstallParams,
} from "./bundled-runtime-deps.js";
import {
  markBundledRuntimeDistMirrorPrepared,
  shouldReusePreparedBundledRuntimeDistMirror,
} from "./bundled-runtime-dist-mirror-cache.js";
import {
  materializeBundledRuntimeMirrorFile,
  precomputeBundledRuntimeMirrorMetadata,
  refreshBundledPluginRuntimeMirrorRoot,
  type PrecomputedBundledRuntimeMirrorMetadata,
} from "./bundled-runtime-mirror.js";

const BUNDLED_RUNTIME_MIRROR_LOCK_DIR = ".openclaw-runtime-mirror.lock";

export type PreparedBundledPluginRuntimeLoadRoot = {
  pluginRoot: string;
  modulePath: string;
  setupModulePath?: string;
};

export function isBuiltBundledPluginRuntimeRoot(pluginRoot: string): boolean {
  const extensionsDir = path.dirname(pluginRoot);
  const buildDir = path.dirname(extensionsDir);
  return (
    path.basename(extensionsDir) === "extensions" &&
    (path.basename(buildDir) === "dist" || path.basename(buildDir) === "dist-runtime")
  );
}

export function prepareBundledPluginRuntimeRoot(params: {
  pluginId: string;
  pluginRoot: string;
  modulePath: string;
  env?: NodeJS.ProcessEnv;
  logInstalled?: (installedSpecs: readonly string[]) => void;
}): { pluginRoot: string; modulePath: string } {
  return prepareBundledPluginRuntimeLoadRoot(params);
}

export function prepareBundledPluginRuntimeLoadRoot(params: {
  pluginId: string;
  pluginRoot: string;
  modulePath: string;
  setupModulePath?: string;
  env?: NodeJS.ProcessEnv;
  config?: OpenClawConfig;
  installDeps?: (params: BundledRuntimeDepsInstallParams) => void;
  registerRuntimeAliasRoot?: (rootDir: string) => void;
  logInstalled?: (installedSpecs: readonly string[]) => void;
}): PreparedBundledPluginRuntimeLoadRoot {
  const env = params.env ?? process.env;
  const installRootPlan = resolveBundledRuntimeDependencyInstallRootPlan(params.pluginRoot, {
    env,
  });
  const installRoot = installRootPlan.installRoot;
  const depsInstallResult = ensureBundledPluginRuntimeDeps({
    pluginId: params.pluginId,
    pluginRoot: params.pluginRoot,
    env,
    config: params.config,
    installDeps: params.installDeps,
  });
  if (depsInstallResult.installedSpecs.length > 0) {
    params.logInstalled?.(depsInstallResult.installedSpecs);
  }
  if (path.resolve(installRoot) === path.resolve(params.pluginRoot)) {
    ensureOpenClawPluginSdkAlias(path.dirname(path.dirname(params.pluginRoot)));
    return {
      pluginRoot: params.pluginRoot,
      modulePath: params.modulePath,
      ...(params.setupModulePath ? { setupModulePath: params.setupModulePath } : {}),
    };
  }
  const packageRoot = resolveBundledRuntimeDependencyPackageRoot(params.pluginRoot);
  if (packageRoot) {
    registerBundledRuntimeDependencyNodePath(packageRoot);
    params.registerRuntimeAliasRoot?.(packageRoot);
  }
  for (const searchRoot of installRootPlan.searchRoots) {
    registerBundledRuntimeDependencyNodePath(searchRoot);
    params.registerRuntimeAliasRoot?.(searchRoot);
  }
  const mirrorRoot = mirrorBundledPluginRuntimeRoot({
    pluginId: params.pluginId,
    pluginRoot: params.pluginRoot,
    installRoot,
  });
  return {
    pluginRoot: mirrorRoot,
    modulePath: remapBundledPluginRuntimePath({
      source: params.modulePath,
      pluginRoot: params.pluginRoot,
      mirroredRoot: mirrorRoot,
    }),
    ...(params.setupModulePath
      ? {
          setupModulePath: remapBundledPluginRuntimePath({
            source: params.setupModulePath,
            pluginRoot: params.pluginRoot,
            mirroredRoot: mirrorRoot,
          }),
        }
      : {}),
  };
}

function remapBundledPluginRuntimePath(params: {
  source: string;
  pluginRoot: string;
  mirroredRoot: string;
}): string {
  const relativePath = path.relative(params.pluginRoot, params.source);
  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    return params.source;
  }
  return path.join(params.mirroredRoot, relativePath);
}

function mirrorBundledPluginRuntimeRoot(params: {
  pluginId: string;
  pluginRoot: string;
  installRoot: string;
}): string {
  const sourceDistRoot = path.dirname(path.dirname(params.pluginRoot));
  const mirrorParent = path.join(params.installRoot, path.basename(sourceDistRoot), "extensions");
  const mirrorRoot = path.join(mirrorParent, params.pluginId);
  const precomputedPluginRootMetadata =
    path.resolve(mirrorRoot) === path.resolve(params.pluginRoot)
      ? undefined
      : precomputeBundledRuntimeMirrorMetadata({ sourceRoot: params.pluginRoot });
  const precomputedCanonicalPluginRootMetadata =
    precomputeCanonicalBundledRuntimeDistPluginMetadata({
      pluginRoot: params.pluginRoot,
      sourceDistRoot,
    });

  return withBundledRuntimeDepsFilesystemLock(
    params.installRoot,
    BUNDLED_RUNTIME_MIRROR_LOCK_DIR,
    () => {
      const preparedMirrorParent = prepareBundledPluginRuntimeDistMirror({
        installRoot: params.installRoot,
        pluginRoot: params.pluginRoot,
        precomputedCanonicalPluginRootMetadata,
      });
      const preparedMirrorRoot = path.join(preparedMirrorParent, params.pluginId);
      fs.mkdirSync(params.installRoot, { recursive: true });
      try {
        fs.chmodSync(params.installRoot, 0o755);
      } catch {
        // Best-effort only: staged roots may live on filesystems that reject chmod.
      }
      fs.mkdirSync(preparedMirrorParent, { recursive: true });
      try {
        fs.chmodSync(preparedMirrorParent, 0o755);
      } catch {
        // Best-effort only: the access check below will surface non-writable dirs.
      }
      fs.accessSync(preparedMirrorParent, fs.constants.W_OK);
      if (path.resolve(preparedMirrorRoot) === path.resolve(params.pluginRoot)) {
        return preparedMirrorRoot;
      }
      refreshBundledPluginRuntimeMirrorRoot({
        pluginId: params.pluginId,
        sourceRoot: params.pluginRoot,
        targetRoot: preparedMirrorRoot,
        tempDirParent: preparedMirrorParent,
        precomputedSourceMetadata: precomputedPluginRootMetadata,
      });
      return preparedMirrorRoot;
    },
  );
}

function prepareBundledPluginRuntimeDistMirror(params: {
  installRoot: string;
  pluginRoot: string;
  precomputedCanonicalPluginRootMetadata?: PrecomputedBundledRuntimeMirrorMetadata;
}): string {
  const sourceExtensionsRoot = path.dirname(params.pluginRoot);
  const sourceDistRoot = path.dirname(sourceExtensionsRoot);
  const sourceDistRootName = path.basename(sourceDistRoot);
  const mirrorDistRoot = path.join(params.installRoot, sourceDistRootName);
  const mirrorExtensionsRoot = path.join(mirrorDistRoot, "extensions");
  ensureBundledRuntimeMirrorDirectory(mirrorDistRoot);
  fs.mkdirSync(mirrorExtensionsRoot, { recursive: true, mode: 0o755 });
  ensureBundledRuntimeDistPackageJson(mirrorDistRoot);
  if (!shouldReusePreparedBundledRuntimeDistMirror({ sourceDistRoot, mirrorDistRoot })) {
    mirrorBundledRuntimeDistRootEntries({
      sourceDistRoot,
      mirrorDistRoot,
    });
    markBundledRuntimeDistMirrorPrepared({ sourceDistRoot, mirrorDistRoot });
  }
  if (sourceDistRootName === "dist-runtime") {
    mirrorCanonicalBundledRuntimeDistRoot({
      installRoot: params.installRoot,
      pluginRoot: params.pluginRoot,
      sourceRuntimeDistRoot: sourceDistRoot,
      precomputedSourceMetadata: params.precomputedCanonicalPluginRootMetadata,
    });
  }
  ensureOpenClawPluginSdkAlias(mirrorDistRoot);
  return mirrorExtensionsRoot;
}

function ensureBundledRuntimeMirrorDirectory(targetRoot: string): void {
  try {
    const stat = fs.lstatSync(targetRoot);
    if (stat.isDirectory() && !stat.isSymbolicLink()) {
      return;
    }
    fs.rmSync(targetRoot, { recursive: true, force: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o755 });
}

function isPathInsideDirectory(childPath: string, parentPath: string): boolean {
  const relative = path.relative(path.resolve(parentPath), path.resolve(childPath));
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function mirrorBundledRuntimeDistRootEntries(params: {
  sourceDistRoot: string;
  mirrorDistRoot: string;
}): void {
  const mirrorRootDirectories =
    path.basename(params.sourceDistRoot) === "dist" ||
    path.basename(params.sourceDistRoot) === "dist-runtime";
  for (const entry of fs.readdirSync(params.sourceDistRoot, { withFileTypes: true })) {
    if (entry.name === "extensions") {
      continue;
    }
    const sourcePath = path.join(params.sourceDistRoot, entry.name);
    const targetPath = path.join(params.mirrorDistRoot, entry.name);
    if (path.resolve(sourcePath) === path.resolve(targetPath)) {
      continue;
    }
    if (entry.isDirectory() && isPathInsideDirectory(targetPath, sourcePath)) {
      continue;
    }
    const sourceStat = fs.statSync(sourcePath);
    if (sourceStat.isDirectory()) {
      if (!mirrorRootDirectories) {
        continue;
      }
      refreshBundledPluginRuntimeMirrorRoot({
        pluginId: `openclaw-dist:${entry.name}`,
        sourceRoot: sourcePath,
        targetRoot: targetPath,
        tempDirParent: params.mirrorDistRoot,
      });
      continue;
    }
    if (sourceStat.isFile()) {
      materializeBundledRuntimeMirrorFile(sourcePath, targetPath);
      continue;
    }
  }
}

function mirrorCanonicalBundledRuntimeDistRoot(params: {
  installRoot: string;
  pluginRoot: string;
  sourceRuntimeDistRoot: string;
  precomputedSourceMetadata?: PrecomputedBundledRuntimeMirrorMetadata;
}): void {
  const sourceCanonicalDistRoot = path.join(path.dirname(params.sourceRuntimeDistRoot), "dist");
  if (!fs.existsSync(sourceCanonicalDistRoot)) {
    return;
  }
  const targetCanonicalDistRoot = path.join(params.installRoot, "dist");
  ensureBundledRuntimeMirrorDirectory(targetCanonicalDistRoot);
  fs.mkdirSync(path.join(targetCanonicalDistRoot, "extensions"), { recursive: true, mode: 0o755 });
  ensureBundledRuntimeDistPackageJson(targetCanonicalDistRoot);
  if (
    !shouldReusePreparedBundledRuntimeDistMirror({
      sourceDistRoot: sourceCanonicalDistRoot,
      mirrorDistRoot: targetCanonicalDistRoot,
    })
  ) {
    mirrorBundledRuntimeDistRootEntries({
      sourceDistRoot: sourceCanonicalDistRoot,
      mirrorDistRoot: targetCanonicalDistRoot,
    });
    markBundledRuntimeDistMirrorPrepared({
      sourceDistRoot: sourceCanonicalDistRoot,
      mirrorDistRoot: targetCanonicalDistRoot,
    });
  }
  ensureOpenClawPluginSdkAlias(targetCanonicalDistRoot);

  const pluginId = path.basename(params.pluginRoot);
  const sourceCanonicalPluginRoot = path.join(sourceCanonicalDistRoot, "extensions", pluginId);
  if (!fs.existsSync(sourceCanonicalPluginRoot)) {
    return;
  }
  const targetCanonicalPluginRoot = path.join(targetCanonicalDistRoot, "extensions", pluginId);
  refreshBundledPluginRuntimeMirrorRoot({
    pluginId,
    sourceRoot: sourceCanonicalPluginRoot,
    targetRoot: targetCanonicalPluginRoot,
    tempDirParent: path.dirname(targetCanonicalPluginRoot),
    precomputedSourceMetadata: params.precomputedSourceMetadata,
  });
}

function precomputeCanonicalBundledRuntimeDistPluginMetadata(params: {
  pluginRoot: string;
  sourceDistRoot: string;
}): PrecomputedBundledRuntimeMirrorMetadata | undefined {
  if (path.basename(params.sourceDistRoot) !== "dist-runtime") {
    return undefined;
  }
  const pluginId = path.basename(params.pluginRoot);
  const sourceCanonicalPluginRoot = path.join(
    path.dirname(params.sourceDistRoot),
    "dist",
    "extensions",
    pluginId,
  );
  if (!fs.existsSync(sourceCanonicalPluginRoot)) {
    return undefined;
  }
  return precomputeBundledRuntimeMirrorMetadata({ sourceRoot: sourceCanonicalPluginRoot });
}

function ensureBundledRuntimeDistPackageJson(mirrorDistRoot: string): void {
  const packageJsonPath = path.join(mirrorDistRoot, "package.json");
  if (fs.existsSync(packageJsonPath)) {
    return;
  }
  writeRuntimeJsonFile(packageJsonPath, { type: "module" });
}

function writeRuntimeJsonFile(targetPath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function hasRuntimeDefaultExport(sourcePath: string): boolean {
  const text = fs.readFileSync(sourcePath, "utf8");
  return /\bexport\s+default\b/u.test(text) || /\bas\s+default\b/u.test(text);
}

function writeRuntimeModuleWrapper(sourcePath: string, targetPath: string): void {
  const specifier = path.relative(path.dirname(targetPath), sourcePath).replaceAll(path.sep, "/");
  const normalizedSpecifier = specifier.startsWith(".") ? specifier : `./${specifier}`;
  const defaultForwarder = hasRuntimeDefaultExport(sourcePath)
    ? [
        `import defaultModule from ${JSON.stringify(normalizedSpecifier)};`,
        `let defaultExport = defaultModule;`,
        `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
        `  defaultExport = defaultExport.default;`,
        `}`,
      ]
    : [
        `import * as module from ${JSON.stringify(normalizedSpecifier)};`,
        `let defaultExport = "default" in module ? module.default : module;`,
        `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
        `  defaultExport = defaultExport.default;`,
        `}`,
      ];
  const content = [
    `export * from ${JSON.stringify(normalizedSpecifier)};`,
    ...defaultForwarder,
    "export { defaultExport as default };",
    "",
  ].join("\n");
  try {
    if (fs.readFileSync(targetPath, "utf8") === content) {
      return;
    }
  } catch {
    // Missing or unreadable wrapper; rewrite below.
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, content, "utf8");
}

export function ensureOpenClawPluginSdkAlias(distRoot: string): void {
  const pluginSdkDir = path.join(distRoot, "plugin-sdk");
  if (!fs.existsSync(pluginSdkDir)) {
    return;
  }

  const aliasDir = path.join(distRoot, "extensions", "node_modules", "openclaw");
  const pluginSdkAliasDir = path.join(aliasDir, "plugin-sdk");
  writeRuntimeJsonFile(path.join(aliasDir, "package.json"), {
    name: "openclaw",
    type: "module",
    exports: {
      "./plugin-sdk": "./plugin-sdk/index.js",
      "./plugin-sdk/*": "./plugin-sdk/*.js",
    },
  });
  try {
    if (fs.existsSync(pluginSdkAliasDir) && !fs.lstatSync(pluginSdkAliasDir).isDirectory()) {
      fs.rmSync(pluginSdkAliasDir, { recursive: true, force: true });
    }
  } catch {
    // Another process may be creating the alias at the same time; mkdir/write
    // below will either converge or surface the real filesystem error.
  }
  fs.mkdirSync(pluginSdkAliasDir, { recursive: true });
  for (const entry of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
    if (!entry.isFile() || path.extname(entry.name) !== ".js") {
      continue;
    }
    writeRuntimeModuleWrapper(
      path.join(pluginSdkDir, entry.name),
      path.join(pluginSdkAliasDir, entry.name),
    );
  }
}
