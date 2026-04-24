import fs from "node:fs";
import path from "node:path";
import {
  ensureBundledPluginRuntimeDeps,
  resolveBundledRuntimeDependencyInstallRoot,
} from "./bundled-runtime-deps.js";

const bundledRuntimeDepsRetainSpecsByInstallRoot = new Map<string, readonly string[]>();

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
  const env = params.env ?? process.env;
  const installRoot = resolveBundledRuntimeDependencyInstallRoot(params.pluginRoot, { env });
  const retainSpecs = bundledRuntimeDepsRetainSpecsByInstallRoot.get(installRoot) ?? [];
  const depsInstallResult = ensureBundledPluginRuntimeDeps({
    pluginId: params.pluginId,
    pluginRoot: params.pluginRoot,
    env,
    retainSpecs,
  });
  if (depsInstallResult.installedSpecs.length > 0) {
    bundledRuntimeDepsRetainSpecsByInstallRoot.set(
      installRoot,
      [...new Set([...retainSpecs, ...depsInstallResult.retainSpecs])].toSorted((left, right) =>
        left.localeCompare(right),
      ),
    );
    params.logInstalled?.(depsInstallResult.installedSpecs);
  }
  if (path.resolve(installRoot) === path.resolve(params.pluginRoot)) {
    return { pluginRoot: params.pluginRoot, modulePath: params.modulePath };
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
  const mirrorParent = prepareBundledPluginRuntimeDistMirror({
    installRoot: params.installRoot,
    pluginRoot: params.pluginRoot,
  });
  const mirrorRoot = path.join(mirrorParent, params.pluginId);
  fs.mkdirSync(params.installRoot, { recursive: true });
  try {
    fs.chmodSync(params.installRoot, 0o755);
  } catch {
    // Best-effort only: staged roots may live on filesystems that reject chmod.
  }
  fs.mkdirSync(mirrorParent, { recursive: true });
  try {
    fs.chmodSync(mirrorParent, 0o755);
  } catch {
    // Best-effort only: the access check below will surface non-writable dirs.
  }
  fs.accessSync(mirrorParent, fs.constants.W_OK);
  const tempDir = fs.mkdtempSync(path.join(mirrorParent, `.plugin-${params.pluginId}-`));
  const stagedRoot = path.join(tempDir, "plugin");
  try {
    copyBundledPluginRuntimeRoot(params.pluginRoot, stagedRoot);
    fs.rmSync(mirrorRoot, { recursive: true, force: true });
    fs.renameSync(stagedRoot, mirrorRoot);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  return mirrorRoot;
}

function prepareBundledPluginRuntimeDistMirror(params: {
  installRoot: string;
  pluginRoot: string;
}): string {
  const sourceExtensionsRoot = path.dirname(params.pluginRoot);
  const sourceDistRoot = path.dirname(sourceExtensionsRoot);
  const mirrorDistRoot = path.join(params.installRoot, "dist");
  const mirrorExtensionsRoot = path.join(mirrorDistRoot, "extensions");
  fs.mkdirSync(mirrorExtensionsRoot, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(sourceDistRoot, { withFileTypes: true })) {
    if (entry.name === "extensions") {
      continue;
    }
    const sourcePath = path.join(sourceDistRoot, entry.name);
    const targetPath = path.join(mirrorDistRoot, entry.name);
    if (fs.existsSync(targetPath)) {
      continue;
    }
    try {
      fs.symlinkSync(sourcePath, targetPath, entry.isDirectory() ? "junction" : "file");
    } catch {
      if (entry.isDirectory()) {
        copyBundledPluginRuntimeRoot(sourcePath, targetPath);
      } else if (entry.isFile()) {
        fs.copyFileSync(sourcePath, targetPath);
      }
    }
  }
  ensureOpenClawPluginSdkAlias(mirrorDistRoot);
  return mirrorExtensionsRoot;
}

function copyBundledPluginRuntimeRoot(sourceRoot: string, targetRoot: string): void {
  fs.mkdirSync(targetRoot, { recursive: true, mode: 0o755 });
  for (const entry of fs.readdirSync(sourceRoot, { withFileTypes: true })) {
    if (entry.name === "node_modules") {
      continue;
    }
    const sourcePath = path.join(sourceRoot, entry.name);
    const targetPath = path.join(targetRoot, entry.name);
    if (entry.isDirectory()) {
      copyBundledPluginRuntimeRoot(sourcePath, targetPath);
      continue;
    }
    if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(sourcePath), targetPath);
      continue;
    }
    if (!entry.isFile()) {
      continue;
    }
    fs.copyFileSync(sourcePath, targetPath);
    try {
      const sourceMode = fs.statSync(sourcePath).mode;
      fs.chmodSync(targetPath, sourceMode | 0o600);
    } catch {
      // Readable copied files are enough for plugin loading.
    }
  }
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
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(
    targetPath,
    [
      `export * from ${JSON.stringify(normalizedSpecifier)};`,
      ...defaultForwarder,
      "export { defaultExport as default };",
      "",
    ].join("\n"),
    "utf8",
  );
}

function ensureOpenClawPluginSdkAlias(distRoot: string): void {
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
  fs.rmSync(pluginSdkAliasDir, { recursive: true, force: true });
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
