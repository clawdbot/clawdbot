import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

function symlinkType() {
  return process.platform === "win32" ? "junction" : "dir";
}

function relativeSymlinkTarget(sourcePath, targetPath) {
  const relativeTarget = path.relative(path.dirname(targetPath), sourcePath);
  return relativeTarget || ".";
}

function shouldFallbackToCopy(error) {
  return (
    process.platform === "win32" &&
    (error?.code === "EPERM" || error?.code === "EINVAL" || error?.code === "UNKNOWN")
  );
}

function copyPathFallback(sourcePath, targetPath) {
  removePathIfExists(targetPath);
  const stat = fs.statSync(sourcePath);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  if (stat.isDirectory()) {
    fs.cpSync(sourcePath, targetPath, { recursive: true, dereference: true });
    return;
  }
  fs.copyFileSync(sourcePath, targetPath);
}

function ensureSymlink(targetValue, targetPath, type, fallbackSourcePath) {
  try {
    fs.symlinkSync(targetValue, targetPath, type);
    return;
  } catch (error) {
    if (fallbackSourcePath && shouldFallbackToCopy(error)) {
      copyPathFallback(fallbackSourcePath, targetPath);
      return;
    }
    if (error?.code !== "EEXIST") {
      throw error;
    }
  }

  try {
    if (fs.lstatSync(targetPath).isSymbolicLink() && fs.readlinkSync(targetPath) === targetValue) {
      return;
    }
  } catch {
    // Fall through and recreate the target when inspection fails.
  }

  removePathIfExists(targetPath);
  try {
    fs.symlinkSync(targetValue, targetPath, type);
  } catch (error) {
    if (fallbackSourcePath && shouldFallbackToCopy(error)) {
      copyPathFallback(fallbackSourcePath, targetPath);
      return;
    }
    throw error;
  }
}

function symlinkPath(sourcePath, targetPath, type) {
  ensureSymlink(relativeSymlinkTarget(sourcePath, targetPath), targetPath, type, sourcePath);
}

function writeJsonFile(targetPath, value) {
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function removeStaleOpenClawSelfReference(sourcePluginNodeModulesDir, repoRoot) {
  if (!fs.existsSync(sourcePluginNodeModulesDir)) {
    return;
  }

  const selfReferencePath = path.join(sourcePluginNodeModulesDir, "openclaw");
  try {
    const existing = fs.lstatSync(selfReferencePath);
    if (!existing.isSymbolicLink()) {
      return;
    }
    if (fs.realpathSync(selfReferencePath) === fs.realpathSync(repoRoot)) {
      removePathIfExists(selfReferencePath);
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

function ensureOpenClawExtensionAlias(params) {
  const pluginSdkDir = path.join(params.repoRoot, "dist", "plugin-sdk");
  if (!fs.existsSync(pluginSdkDir)) {
    return;
  }

  const aliasDir = path.join(params.distExtensionsRoot, "node_modules", "openclaw");
  const pluginSdkAliasPath = path.join(aliasDir, "plugin-sdk");
  fs.mkdirSync(aliasDir, { recursive: true });
  writeJsonFile(path.join(aliasDir, "package.json"), {
    name: "openclaw",
    type: "module",
    exports: {
      "./plugin-sdk": "./plugin-sdk/index.js",
      "./plugin-sdk/*": "./plugin-sdk/*.js",
    },
  });
  removePathIfExists(pluginSdkAliasPath);
  fs.mkdirSync(pluginSdkAliasPath, { recursive: true });
  for (const dirent of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
    if (!dirent.isFile() || path.extname(dirent.name) !== ".js") {
      continue;
    }
    writeRuntimeModuleWrapper(
      path.join(pluginSdkDir, dirent.name),
      path.join(pluginSdkAliasPath, dirent.name),
    );
  }
}

function shouldWrapRuntimeJsFile(sourcePath) {
  return path.extname(sourcePath) === ".js";
}

function shouldCopyRuntimeFile(sourcePath) {
  const relativePath = sourcePath.replace(/\\/g, "/");
  return (
    relativePath.endsWith("/package.json") ||
    relativePath.endsWith("/openclaw.plugin.json") ||
    relativePath.endsWith("/.codex-plugin/plugin.json") ||
    relativePath.endsWith("/.claude-plugin/plugin.json") ||
    relativePath.endsWith("/.cursor-plugin/plugin.json") ||
    relativePath.endsWith("/SKILL.md")
  );
}

function hasDefaultExport(sourcePath) {
  const text = fs.readFileSync(sourcePath, "utf8");
  return /\bexport\s+default\b/u.test(text) || /\bas\s+default\b/u.test(text);
}

function writeRuntimeModuleWrapper(sourcePath, targetPath) {
  const specifier = relativeSymlinkTarget(sourcePath, targetPath).replace(/\\/g, "/");
  const normalizedSpecifier = specifier.startsWith(".") ? specifier : `./${specifier}`;
  const defaultForwarder = hasDefaultExport(sourcePath)
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

function stagePluginRuntimeOverlay(sourceDir, targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const dirent of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (dirent.name === "node_modules") {
      continue;
    }

    const sourcePath = path.join(sourceDir, dirent.name);
    const targetPath = path.join(targetDir, dirent.name);

    if (dirent.isDirectory()) {
      stagePluginRuntimeOverlay(sourcePath, targetPath);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      ensureSymlink(fs.readlinkSync(sourcePath), targetPath, undefined, sourcePath);
      continue;
    }

    if (!dirent.isFile()) {
      continue;
    }

    if (shouldWrapRuntimeJsFile(sourcePath)) {
      writeRuntimeModuleWrapper(sourcePath, targetPath);
      continue;
    }

    if (shouldCopyRuntimeFile(sourcePath)) {
      fs.copyFileSync(sourcePath, targetPath);
      continue;
    }

    symlinkPath(sourcePath, targetPath);
  }
}

function linkPluginNodeModules(params) {
  const runtimeNodeModulesDir = path.join(params.runtimePluginDir, "node_modules");
  removePathIfExists(runtimeNodeModulesDir);
  if (!fs.existsSync(params.sourcePluginNodeModulesDir)) {
    return;
  }
  removeStaleOpenClawSelfReference(params.sourcePluginNodeModulesDir, params.repoRoot);
  ensureSymlink(
    params.sourcePluginNodeModulesDir,
    runtimeNodeModulesDir,
    symlinkType(),
    params.sourcePluginNodeModulesDir,
  );
}

export function stageBundledPluginRuntime(params = {}) {
  const repoRoot = params.cwd ?? params.repoRoot ?? process.cwd();
  const distRoot = path.join(repoRoot, "dist");
  const runtimeRoot = path.join(repoRoot, "dist-runtime");
  const distExtensionsRoot = path.join(distRoot, "extensions");
  const runtimeExtensionsRoot = path.join(runtimeRoot, "extensions");

  if (!fs.existsSync(distExtensionsRoot)) {
    removePathIfExists(runtimeRoot);
    return;
  }

  removePathIfExists(runtimeRoot);
  fs.mkdirSync(runtimeExtensionsRoot, { recursive: true });
  ensureOpenClawExtensionAlias({ repoRoot, distExtensionsRoot });

  for (const dirent of fs.readdirSync(distExtensionsRoot, { withFileTypes: true })) {
    if (!dirent.isDirectory() || dirent.name === "node_modules") {
      continue;
    }
    const distPluginDir = path.join(distExtensionsRoot, dirent.name);
    const runtimePluginDir = path.join(runtimeExtensionsRoot, dirent.name);
    const distPluginNodeModulesDir = path.join(distPluginDir, "node_modules");

    stagePluginRuntimeOverlay(distPluginDir, runtimePluginDir);
    linkPluginNodeModules({
      repoRoot,
      runtimePluginDir,
      sourcePluginNodeModulesDir: distPluginNodeModulesDir,
    });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntime();
}
