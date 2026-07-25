// Stages bundled plugin runtime overlays into dist-runtime with SDK aliases and
// Windows-safe symlink fallbacks.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { removePathIfExists } from "./runtime-postbuild-shared.mjs";

function relativeSymlinkTarget(sourcePath, targetPath) {
  const relativeTarget = path.relative(path.dirname(targetPath), sourcePath);
  return relativeTarget || ".";
}

function shouldFallbackToCopy(error) {
  return (
    process.platform === "win32" &&
    (error?.code === "EACCES" ||
      error?.code === "EINVAL" ||
      error?.code === "ENOSYS" ||
      error?.code === "EPERM" ||
      error?.code === "UNKNOWN")
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

const PRIVATE_LOCAL_ONLY_PLUGIN_SDK_DIST_FILE_NAME_FALLBACK = [
  "codex-mcp-projection.js",
  "codex-native-task-runtime.js",
  "qa-channel.js",
  "qa-channel-protocol.js",
  "qa-lab.js",
  "qa-runtime.js",
  "ssrf-runtime-internal.js",
];

function tryReadJsonFile(targetPath) {
  try {
    return JSON.parse(fs.readFileSync(targetPath, "utf8"));
  } catch {
    return undefined;
  }
}

function isSafePluginSdkSubpathSegment(subpath) {
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(subpath);
}

function readPrivateLocalOnlyPluginSdkDistFileNames(repoRoot) {
  const privateFileNames = new Set(PRIVATE_LOCAL_ONLY_PLUGIN_SDK_DIST_FILE_NAME_FALLBACK);
  const subpaths = tryReadJsonFile(
    path.join(repoRoot, "scripts", "lib", "plugin-sdk-private-local-only-subpaths.json"),
  );
  if (!Array.isArray(subpaths)) {
    return privateFileNames;
  }
  for (const subpath of subpaths) {
    if (typeof subpath === "string" && isSafePluginSdkSubpathSegment(subpath)) {
      privateFileNames.add(`${subpath}.js`);
    }
  }
  return privateFileNames;
}

function collectLegacyPublicPluginSdkDistFileNames(params) {
  const privateFileNames = readPrivateLocalOnlyPluginSdkDistFileNames(params.repoRoot);
  const fileNames = new Set();
  for (const dirent of fs.readdirSync(params.pluginSdkDir, { withFileTypes: true })) {
    if (!dirent.isFile() || path.extname(dirent.name) !== ".js") {
      continue;
    }
    if (privateFileNames.has(dirent.name)) {
      continue;
    }
    fileNames.add(dirent.name);
  }
  return fileNames.size > 0 ? fileNames : undefined;
}

function readPublicPluginSdkDistFileNames(params) {
  const packageJson = tryReadJsonFile(path.join(params.repoRoot, "package.json"));
  if (!packageJson || typeof packageJson !== "object" || Array.isArray(packageJson)) {
    return collectLegacyPublicPluginSdkDistFileNames(params);
  }
  const packageExports = packageJson.exports;
  if (!packageExports || typeof packageExports !== "object" || Array.isArray(packageExports)) {
    return collectLegacyPublicPluginSdkDistFileNames(params);
  }

  const fileNames = new Set();
  for (const exportKey of Object.keys(packageExports)) {
    if (!exportKey.startsWith("./plugin-sdk/")) {
      continue;
    }
    const subpath = exportKey.slice("./plugin-sdk/".length);
    if (isSafePluginSdkSubpathSegment(subpath)) {
      fileNames.add(`${subpath}.js`);
    }
  }

  return fileNames.size > 0 ? fileNames : collectLegacyPublicPluginSdkDistFileNames(params);
}

function buildRuntimePluginSdkPackageExports(publicDistFileNames) {
  if (!publicDistFileNames) {
    return {};
  }

  const sortedFileNames = [...publicDistFileNames].toSorted((left, right) =>
    left.localeCompare(right),
  );
  return Object.fromEntries(
    sortedFileNames.map((fileName) => {
      const subpath = fileName.slice(0, -".js".length);
      return [`./plugin-sdk/${subpath}`, `./plugin-sdk/${fileName}`];
    }),
  );
}

function ensureOpenClawExtensionAlias(params) {
  const pluginSdkDir = path.join(params.repoRoot, "dist", "plugin-sdk");
  if (!fs.existsSync(pluginSdkDir)) {
    return;
  }

  const publicDistFileNames = readPublicPluginSdkDistFileNames({
    repoRoot: params.repoRoot,
    pluginSdkDir,
  });
  const aliasDir = path.join(params.distExtensionsRoot, "node_modules", "openclaw");
  const pluginSdkAliasPath = path.join(aliasDir, "plugin-sdk");
  fs.mkdirSync(aliasDir, { recursive: true });
  writeJsonFile(path.join(aliasDir, "package.json"), {
    name: "openclaw",
    type: "module",
    exports: buildRuntimePluginSdkPackageExports(publicDistFileNames),
  });
  removePathIfExists(pluginSdkAliasPath);
  fs.mkdirSync(pluginSdkAliasPath, { recursive: true });
  for (const dirent of fs.readdirSync(pluginSdkDir, { withFileTypes: true })) {
    if (!dirent.isFile() || path.extname(dirent.name) !== ".js") {
      continue;
    }
    if (publicDistFileNames && !publicDistFileNames.has(dirent.name)) {
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

function isBundledSkillRuntimePath(relativePath) {
  return relativePath === "skills" || relativePath.startsWith("skills/");
}

function isRawBrowserExtensionAssetPath(relativePath) {
  return relativePath === "chrome-extension" || relativePath.endsWith("/chrome-extension");
}

function isPathOrNestedPath(relativePath, nestedPath) {
  return relativePath === nestedPath || relativePath.endsWith(`/${nestedPath}`);
}

function shouldCopyRuntimeFile(relativePath) {
  return (
    isBundledSkillRuntimePath(relativePath) ||
    isPathOrNestedPath(relativePath, "package.json") ||
    isPathOrNestedPath(relativePath, "openclaw.plugin.json") ||
    isPathOrNestedPath(relativePath, ".codex-plugin/plugin.json") ||
    isPathOrNestedPath(relativePath, ".claude-plugin/plugin.json") ||
    isPathOrNestedPath(relativePath, ".cursor-plugin/plugin.json") ||
    isPathOrNestedPath(relativePath, "SKILL.md")
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

function stagePluginRuntimeOverlay(sourceDir, targetDir, relativeDir = "") {
  fs.mkdirSync(targetDir, { recursive: true });

  for (const dirent of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    if (dirent.name === "node_modules") {
      continue;
    }

    const sourcePath = path.join(sourceDir, dirent.name);
    const targetPath = path.join(targetDir, dirent.name);
    const relativePath = path.join(relativeDir, dirent.name).replace(/\\/g, "/");

    if (dirent.isDirectory()) {
      // Unpacked browser extensions are executable static payloads, not Node
      // modules. Preserve the staged tree byte-for-byte so Chrome can load it.
      if (isRawBrowserExtensionAssetPath(relativePath)) {
        copyPathFallback(sourcePath, targetPath);
        continue;
      }
      stagePluginRuntimeOverlay(sourcePath, targetPath, relativePath);
      continue;
    }

    if (dirent.isSymbolicLink()) {
      if (isBundledSkillRuntimePath(relativePath)) {
        copyPathFallback(sourcePath, targetPath);
        continue;
      }
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

    if (shouldCopyRuntimeFile(relativePath)) {
      fs.copyFileSync(sourcePath, targetPath);
      continue;
    }

    symlinkPath(sourcePath, targetPath);
  }
}

/**
 * Stages runtime plugin entries and aliases used by packaged bundled plugins.
 */
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

    stagePluginRuntimeOverlay(distPluginDir, runtimePluginDir);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  stageBundledPluginRuntime();
}
