#!/usr/bin/env node
// Runs after install to keep packaged dist safe and compatible.
// Keep packaged dist safe and compatible. Plugin package dependencies are
// installed only by explicit plugin install/update flows, never postinstall.
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve as pathResolve,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_PACKAGE_ROOT = join(__dirname, "..");
const DISABLE_POSTINSTALL_ENV = "OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL";
const DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV = "OPENCLAW_DISABLE_PLUGIN_REGISTRY_MIGRATION";
const DIST_INVENTORY_PATH = "dist/postinstall-inventory.json";
const LEGACY_PLUGIN_RUNTIME_DEPS_DIR = "plugin-runtime-deps";
const BAILEYS_MEDIA_FILE = join(
  "node_modules",
  "@whiskeysockets",
  "baileys",
  "lib",
  "Utils",
  "messages-media.js",
);
const BAILEYS_MEDIA_HOTFIX_NEEDLE = [
  "        encFileWriteStream.write(mac);",
  "        encFileWriteStream.end();",
  "        originalFileStream?.end?.();",
  "        stream.destroy();",
  "        logger?.debug('encrypted data successfully');",
].join("\n");
const BAILEYS_MEDIA_HOTFIX_REPLACEMENT = [
  "        encFileWriteStream.write(mac);",
  "        const encFinishPromise = once(encFileWriteStream, 'finish');",
  "        const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve();",
  "        encFileWriteStream.end();",
  "        originalFileStream?.end?.();",
  "        stream.destroy();",
  "        await Promise.all([encFinishPromise, originalFinishPromise]);",
  "        logger?.debug('encrypted data successfully');",
].join("\n");
const BAILEYS_MEDIA_HOTFIX_SEQUENTIAL_REPLACEMENT = [
  "        encFileWriteStream.write(mac);",
  "        const encFinishPromise = once(encFileWriteStream, 'finish');",
  "        const originalFinishPromise = originalFileStream ? once(originalFileStream, 'finish') : Promise.resolve();",
  "        encFileWriteStream.end();",
  "        originalFileStream?.end?.();",
  "        stream.destroy();",
  "        await encFinishPromise;",
  "        await originalFinishPromise;",
  "        logger?.debug('encrypted data successfully');",
].join("\n");
const BAILEYS_MEDIA_HOTFIX_FINISH_PROMISES_RE =
  /const\s+encFinishPromise\s*=\s*once\(encFileWriteStream,\s*'finish'\);\s*\n[\s\S]*const\s+originalFinishPromise\s*=\s*originalFileStream\s*\?\s*once\(originalFileStream,\s*'finish'\)\s*:\s*Promise\.resolve\(\);/u;
const BAILEYS_MEDIA_HOTFIX_PROMISE_ALL_RE =
  /await\s+Promise\.all\(\[\s*encFinishPromise\s*,\s*originalFinishPromise\s*\]\);/u;
const BAILEYS_MEDIA_HOTFIX_SEQUENTIAL_AWAITS_RE =
  /await\s+encFinishPromise;\s*(?:\/\/[^\n]*\n|\s)*await\s+originalFinishPromise;/u;
const BAILEYS_MEDIA_DISPATCHER_NEEDLE = [
  "                const response = await fetch(url, {",
  "                    dispatcher: fetchAgent,",
  "                    method: 'POST',",
].join("\n");
const BAILEYS_MEDIA_DISPATCHER_REPLACEMENT = [
  "                const response = await fetch(url, {",
  "                    method: 'POST',",
].join("\n");
const BAILEYS_MEDIA_DISPATCHER_HEADER_NEEDLE = [
  "                        'Content-Type': 'application/octet-stream',",
  "                        Origin: DEFAULT_ORIGIN",
  "                    },",
].join("\n");
const BAILEYS_MEDIA_DISPATCHER_HEADER_REPLACEMENT = [
  "                        'Content-Type': 'application/octet-stream',",
  "                        Origin: DEFAULT_ORIGIN",
  "                    },",
  "                    // Baileys passes a generic agent here in some runtimes. Undici's",
  "                    // `dispatcher` only works with Dispatcher-compatible implementations,",
  "                    // so only wire it through when the object actually implements",
  "                    // `dispatch`.",
  "                    ...(typeof fetchAgent?.dispatch === 'function' ? { dispatcher: fetchAgent } : {}),",
].join("\n");
const BAILEYS_MEDIA_ONCE_IMPORT_RE = /import\s+\{\s*once\s*\}\s+from\s+['"]events['"]/u;
const BAILEYS_MEDIA_ASYNC_CONTEXT_RE =
  /async\s+function\s+encryptedStream|encryptedStream\s*=\s*async/u;
const NODE_COMPILE_CACHE_VERSION_DIR_RE = /^v\d+\.\d+\.\d+-/u;

function hasEnvFlag(env, key) {
  const value = env?.[key]?.trim().toLowerCase();
  return Boolean(value && value !== "0" && value !== "false" && value !== "no");
}

function normalizeRelativePath(filePath) {
  return filePath.replace(/\\/g, "/");
}

function resolvePostinstallOsHomeDir(env, getHomedir = homedir) {
  return env?.HOME?.trim() || env?.USERPROFILE?.trim() || getHomedir();
}

function resolvePostinstallTildePath(input, homeDir) {
  if (input === "~") {
    return homeDir;
  }
  if (input.startsWith("~/") || input.startsWith("~\\")) {
    return join(homeDir, input.slice(2));
  }
  return input;
}

function resolvePostinstallOpenClawHomeDir(env, getHomedir = homedir) {
  const osHome = resolvePostinstallOsHomeDir(env, getHomedir);
  const override = env?.OPENCLAW_HOME?.trim();
  return override ? pathResolve(resolvePostinstallTildePath(override, osHome)) : osHome;
}

function resolvePostinstallUserPath(input, openClawHome) {
  return pathResolve(resolvePostinstallTildePath(input, openClawHome));
}

function readInstalledDistInventory(params = {}) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pathExists = params.existsSync ?? existsSync;
  const readFile = params.readFileSync ?? readFileSync;
  const inventoryPath = join(packageRoot, DIST_INVENTORY_PATH);
  if (!pathExists(inventoryPath)) {
    throw new Error(`missing dist inventory: ${DIST_INVENTORY_PATH}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(readFile(inventoryPath, "utf8"));
  } catch {
    throw new Error(`invalid dist inventory: ${DIST_INVENTORY_PATH}`);
  }
  if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
    throw new Error(`invalid dist inventory: ${DIST_INVENTORY_PATH}`);
  }
  return new Set(parsed.map(normalizeRelativePath));
}

function isRecoverableInstalledDistInventoryError(error) {
  return error instanceof Error && /^(missing|invalid) dist inventory: /u.test(error.message);
}

function resolveInstalledDistRoot(params = {}) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pathExists = params.existsSync ?? existsSync;
  const pathLstat = params.lstatSync ?? lstatSync;
  const resolveRealPath = params.realpathSync ?? realpathSync;
  const distDir = join(packageRoot, "dist");
  if (!pathExists(distDir)) {
    return null;
  }
  const distStats = pathLstat(distDir);
  if (!distStats.isDirectory() || distStats.isSymbolicLink()) {
    throw new Error("unsafe dist root: dist must be a real directory");
  }
  const packageRootReal = resolveRealPath(packageRoot);
  const distDirReal = resolveRealPath(distDir);
  const relativeDistPath = relative(packageRootReal, distDirReal);
  if (relativeDistPath !== "dist") {
    throw new Error("unsafe dist root: dist escaped package root");
  }
  return { distDir, distDirReal, packageRootReal };
}

function assertSafeInstalledDistPath(relativePath, params) {
  const resolveRealPath = params.realpathSync ?? realpathSync;
  const candidatePath = join(params.packageRoot, relativePath);
  const candidateRealPath = resolveRealPath(candidatePath);
  const relativeCandidatePath = relative(params.distDirReal, candidateRealPath);
  if (relativeCandidatePath.startsWith("..") || isAbsolute(relativeCandidatePath)) {
    throw new Error(`unsafe dist path: ${relativePath}`);
  }
  return candidatePath;
}

function listInstalledDistFiles(params = {}) {
  const readDir = params.readdirSync ?? readdirSync;
  const distRoot = resolveInstalledDistRoot(params);
  if (distRoot === null) {
    return [];
  }
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pending = [distRoot.distDir];
  const files = [];
  while (pending.length > 0) {
    const currentDir = pending.pop();
    if (!currentDir) {
      continue;
    }
    for (const entry of readDir(currentDir, { withFileTypes: true })) {
      const entryPath = join(currentDir, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(
          `unsafe dist entry: ${normalizeRelativePath(relative(packageRoot, entryPath))}`,
        );
      }
      if (entry.isDirectory()) {
        pending.push(entryPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }
      const relativePath = normalizeRelativePath(relative(packageRoot, entryPath));
      if (relativePath === DIST_INVENTORY_PATH) {
        continue;
      }
      files.push(relativePath);
    }
  }
  return files.toSorted((left, right) => left.localeCompare(right));
}

function pruneEmptyDistDirectories(params = {}) {
  const readDir = params.readdirSync ?? readdirSync;
  const removeDirectory = params.rmdirSync ?? rmdirSync;
  const distRoot = resolveInstalledDistRoot(params);
  if (distRoot === null) {
    return;
  }
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pathLstat = params.lstatSync ?? lstatSync;

  function prune(currentDir) {
    for (const entry of readDir(currentDir, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) {
        throw new Error(
          `unsafe dist entry: ${normalizeRelativePath(relative(packageRoot, join(currentDir, entry.name)))}`,
        );
      }
      if (!entry.isDirectory()) {
        continue;
      }
      prune(join(currentDir, entry.name));
    }
    if (currentDir === distRoot.distDir) {
      return;
    }
    const currentStats = pathLstat(currentDir);
    if (!currentStats.isDirectory() || currentStats.isSymbolicLink()) {
      throw new Error(
        `unsafe dist directory: ${normalizeRelativePath(relative(packageRoot, currentDir))}`,
      );
    }
    if (readDir(currentDir).length === 0) {
      removeDirectory(
        assertSafeInstalledDistPath(normalizeRelativePath(relative(packageRoot, currentDir)), {
          packageRoot,
          distDirReal: distRoot.distDirReal,
          realpathSync: params.realpathSync,
        }),
      );
    }
  }

  prune(distRoot.distDir);
}

function isLegacyInstalledPluginDependencyDirName(name) {
  return name === "node_modules" || /^\.openclaw-install-stage(?:-[^/]+)?$/iu.test(name);
}

function pruneLegacyInstalledPluginDependencyDirs(params) {
  const readDir = params.readdirSync ?? readdirSync;
  const removePath = params.rmSync ?? rmSync;
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const extensionsDir = join(packageRoot, "dist", "extensions");
  const removed = [];
  let pluginEntries;
  try {
    pluginEntries = readDir(extensionsDir, { withFileTypes: true });
  } catch {
    return removed;
  }

  for (const pluginEntry of pluginEntries) {
    if (!pluginEntry.isDirectory() || pluginEntry.isSymbolicLink()) {
      continue;
    }
    const pluginDir = join(extensionsDir, pluginEntry.name);
    let pluginChildren;
    try {
      pluginChildren = readDir(pluginDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const childEntry of pluginChildren) {
      if (!isLegacyInstalledPluginDependencyDirName(childEntry.name)) {
        continue;
      }
      const safePluginDir = assertSafeInstalledDistPath(
        normalizeRelativePath(relative(packageRoot, pluginDir)),
        {
          packageRoot,
          distDirReal: params.distDirReal,
          realpathSync: params.realpathSync,
        },
      );
      const relativePath = normalizeRelativePath(
        relative(packageRoot, join(pluginDir, childEntry.name)),
      );
      removePath(join(safePluginDir, childEntry.name), { recursive: true, force: true });
      removed.push(relativePath);
    }
  }

  return removed;
}

function splitPostinstallPathList(value) {
  return value
    ? value
        .split(pathDelimiter)
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

const pathDelimiter = process.platform === "win32" ? ";" : ":";

export function collectLegacyPluginRuntimeDepsStateRoots(params = {}) {
  const env = params.env ?? process.env;
  const getHomedir = params.homedir ?? homedir;
  const openClawHome = resolvePostinstallOpenClawHomeDir(env, getHomedir);
  const stateRoots = [];
  const addStateRoot = (root) => {
    if (root) {
      stateRoots.push(join(root, LEGACY_PLUGIN_RUNTIME_DEPS_DIR));
    }
  };

  const stateOverride = env?.OPENCLAW_STATE_DIR?.trim();
  if (stateOverride) {
    addStateRoot(resolvePostinstallUserPath(stateOverride, openClawHome));
  }
  const configPath = env?.OPENCLAW_CONFIG_PATH?.trim();
  if (configPath) {
    addStateRoot(dirname(resolvePostinstallUserPath(configPath, openClawHome)));
  }
  addStateRoot(join(openClawHome, ".openclaw"));
  addStateRoot(join(openClawHome, ".clawdbot"));

  for (const entry of splitPostinstallPathList(env?.STATE_DIRECTORY)) {
    addStateRoot(resolvePostinstallUserPath(entry, openClawHome));
  }

  return [...new Set(stateRoots.map((root) => pathResolve(root)))].toSorted((left, right) =>
    left.localeCompare(right),
  );
}

export function pruneLegacyPluginRuntimeDepsState(params = {}) {
  const pathExists = params.existsSync ?? existsSync;
  const removePath = params.rmSync ?? rmSync;
  const log = params.log ?? console;
  const removed = [];

  for (const root of collectLegacyPluginRuntimeDepsStateRoots(params)) {
    if (!pathExists(root)) {
      continue;
    }
    try {
      removePath(root, { recursive: true, force: true, maxRetries: 2, retryDelay: 100 });
      removed.push(root);
    } catch (error) {
      log.warn?.(
        `[postinstall] could not prune legacy plugin runtime deps ${root}: ${String(error)}`,
      );
    }
  }

  if (removed.length > 0) {
    log.log?.(`[postinstall] pruned legacy plugin runtime deps: ${removed.join(", ")}`);
  }

  return removed;
}

const JS_DIST_FILE_RE = /^dist\/.*\.(?:cjs|js|mjs)$/u;

function stripSpecifierSuffix(value) {
  return value.replace(/[?#].*$/u, "");
}

function resolveDistImportPath(importerPath, specifier) {
  if (!specifier.startsWith(".")) {
    return null;
  }
  const stripped = stripSpecifierSuffix(specifier);
  if (!stripped) {
    return null;
  }
  return posix.normalize(posix.join(posix.dirname(importerPath), stripped));
}

function findStatementStart(source, index) {
  return (
    Math.max(
      source.lastIndexOf(";", index),
      source.lastIndexOf("{", index),
      source.lastIndexOf("}", index),
      source.lastIndexOf("\n", index),
      source.lastIndexOf("\r", index),
    ) + 1
  );
}

function isImportSpecifierContext(source, index) {
  const dynamicPrefix = source.slice(Math.max(0, index - 32), index);
  if (/\bimport\s*\(\s*$/u.test(dynamicPrefix)) {
    return true;
  }
  const statementPrefix = source.slice(findStatementStart(source, index), index).trimStart();
  return (
    /^(?:import|export)\b[\s\S]*\bfrom\s*$/u.test(statementPrefix) ||
    /^import\s*$/u.test(statementPrefix)
  );
}

function collectImportSpecifiers(source) {
  const specifiers = [];
  let inBlockComment = false;
  let inLineComment = false;
  for (let index = 0; index < source.length; index += 1) {
    if (inBlockComment) {
      if (source[index] === "*" && source[index + 1] === "/") {
        inBlockComment = false;
        index += 1;
      }
      continue;
    }
    if (inLineComment) {
      if (source[index] === "\n" || source[index] === "\r") {
        inLineComment = false;
      }
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "*") {
      inBlockComment = true;
      index += 1;
      continue;
    }
    if (source[index] === "/" && source[index + 1] === "/") {
      inLineComment = true;
      index += 1;
      continue;
    }

    const quote = source[index];
    if (quote !== '"' && quote !== "'") {
      continue;
    }

    let cursor = index + 1;
    let value = "";
    while (cursor < source.length) {
      const char = source[cursor];
      if (char === "\\") {
        value += source.slice(cursor, cursor + 2);
        cursor += 2;
        continue;
      }
      if (char === quote) {
        break;
      }
      value += char;
      cursor += 1;
    }
    if (cursor >= source.length) {
      break;
    }

    if (value.startsWith(".") && isImportSpecifierContext(source, index)) {
      specifiers.push(value);
    }
    index = cursor;
  }
  return specifiers;
}

function expandInstalledDistImportClosure(params) {
  const files = [...new Set(params.files)];
  const fileSet = new Set(files);
  const expectedSet = new Set(params.seedFiles);
  let changed = true;

  while (changed) {
    changed = false;
    for (const importerPath of [...expectedSet]
      .filter((file) => fileSet.has(file))
      .toSorted((left, right) => left.localeCompare(right))) {
      if (!JS_DIST_FILE_RE.test(importerPath) || importerPath.includes("/node_modules/")) {
        continue;
      }
      let source;
      try {
        source = params.readText(importerPath);
      } catch (error) {
        if (error?.code === "ENOENT") {
          continue;
        }
        throw error;
      }
      for (const specifier of collectImportSpecifiers(source)) {
        const importedPath = resolveDistImportPath(importerPath, specifier);
        if (!importedPath || !fileSet.has(importedPath) || expectedSet.has(importedPath)) {
          continue;
        }
        expectedSet.add(importedPath);
        changed = true;
      }
    }
  }

  return [...expectedSet].toSorted((left, right) => left.localeCompare(right));
}

export function pruneInstalledPackageDist(params = {}) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const removeFile = params.unlinkSync ?? unlinkSync;
  const log = params.log ?? console;
  const distRoot = resolveInstalledDistRoot(params);
  if (distRoot === null) {
    return [];
  }
  const removedLegacyDependencyDirs = pruneLegacyInstalledPluginDependencyDirs({
    packageRoot,
    distDirReal: distRoot.distDirReal,
    realpathSync: params.realpathSync,
    readdirSync: params.readdirSync,
    rmSync: params.rmSync,
  });
  let expectedFiles = params.expectedFiles ?? null;
  if (expectedFiles === null) {
    try {
      expectedFiles = readInstalledDistInventory(params);
    } catch (error) {
      if (!isRecoverableInstalledDistInventoryError(error)) {
        throw error;
      }
      log.warn?.(`[postinstall] skipping dist prune: ${error.message}`);
      return [];
    }
  }
  const installedFiles = listInstalledDistFiles(params);
  const readFile = params.readFileSync ?? readFileSync;
  expectedFiles = new Set(
    expandInstalledDistImportClosure({
      files: installedFiles,
      seedFiles: [...expectedFiles],
      readText(relativePath) {
        return readFile(join(packageRoot, relativePath), "utf8");
      },
    }),
  );
  const removed = [];

  for (const relativePath of installedFiles) {
    if (expectedFiles.has(relativePath)) {
      continue;
    }
    removeFile(
      assertSafeInstalledDistPath(relativePath, {
        packageRoot,
        distDirReal: distRoot.distDirReal,
        realpathSync: params.realpathSync,
      }),
    );
    removed.push(relativePath);
  }

  pruneEmptyDistDirectories(params);

  if (removed.length > 0) {
    log.log(`[postinstall] pruned stale dist files: ${removed.join(", ")}`);
  }
  if (removedLegacyDependencyDirs.length > 0) {
    log.log(
      `[postinstall] pruned legacy plugin dependency dirs: ${removedLegacyDependencyDirs.join(", ")}`,
    );
  }
  return removed;
}

export function applyBaileysEncryptedStreamFinishHotfix(params = {}) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pathExists = params.existsSync ?? existsSync;
  const pathLstat = params.lstatSync ?? lstatSync;
  const readFile = params.readFileSync ?? readFileSync;
  const resolveRealPath = params.realpathSync ?? realpathSync;
  const chmodFile = params.chmodSync ?? chmodSync;
  const openFile = params.openSync ?? openSync;
  const closeFile = params.closeSync ?? closeSync;
  const renameFile = params.renameSync ?? renameSync;
  const removePath = params.rmSync ?? rmSync;
  const createTempPath =
    params.createTempPath ??
    ((unsafeTargetPath) =>
      join(
        dirname(unsafeTargetPath),
        `.${basename(unsafeTargetPath)}.openclaw-hotfix-${randomUUID()}`,
      ));
  const writeFile =
    params.writeFileSync ?? ((filePath, value) => writeFileSync(filePath, value, "utf8"));
  const targetPath = join(packageRoot, BAILEYS_MEDIA_FILE);
  const nodeModulesRoot = join(packageRoot, "node_modules");

  function validateTargetPath() {
    if (!pathExists(targetPath)) {
      return { ok: false, reason: "missing" };
    }

    const targetStats = pathLstat(targetPath);
    if (!targetStats.isFile() || targetStats.isSymbolicLink()) {
      return { ok: false, reason: "unsafe_target", targetPath };
    }

    const nodeModulesRootReal = resolveRealPath(nodeModulesRoot);
    const targetPathReal = resolveRealPath(targetPath);
    const relativeTargetPath = relative(nodeModulesRootReal, targetPathReal);
    if (relativeTargetPath.startsWith("..") || isAbsolute(relativeTargetPath)) {
      return { ok: false, reason: "path_escape", targetPath };
    }

    return { ok: true, targetPathReal, mode: targetStats.mode & 0o777 };
  }

  try {
    const initialTargetValidation = validateTargetPath();
    if (!initialTargetValidation.ok) {
      return { applied: false, reason: initialTargetValidation.reason, targetPath };
    }

    const currentText = readFile(targetPath, "utf8");
    let patchedText = currentText;
    let applied = false;

    const encryptedStreamAlreadyPatched =
      patchedText.includes(BAILEYS_MEDIA_HOTFIX_REPLACEMENT) ||
      patchedText.includes(BAILEYS_MEDIA_HOTFIX_SEQUENTIAL_REPLACEMENT) ||
      (BAILEYS_MEDIA_HOTFIX_FINISH_PROMISES_RE.test(patchedText) &&
        (BAILEYS_MEDIA_HOTFIX_PROMISE_ALL_RE.test(patchedText) ||
          BAILEYS_MEDIA_HOTFIX_SEQUENTIAL_AWAITS_RE.test(patchedText)));
    const encryptedStreamPatchable = patchedText.includes(BAILEYS_MEDIA_HOTFIX_NEEDLE);

    let encryptedStreamResolved = encryptedStreamAlreadyPatched;
    if (!encryptedStreamResolved && encryptedStreamPatchable) {
      if (!BAILEYS_MEDIA_ONCE_IMPORT_RE.test(patchedText)) {
        return { applied: false, reason: "missing_once_import", targetPath };
      }
      if (!BAILEYS_MEDIA_ASYNC_CONTEXT_RE.test(patchedText)) {
        return { applied: false, reason: "not_async_context", targetPath };
      }
      patchedText = patchedText.replace(
        BAILEYS_MEDIA_HOTFIX_NEEDLE,
        BAILEYS_MEDIA_HOTFIX_REPLACEMENT,
      );
      applied = true;
      encryptedStreamResolved = true;
    }

    const dispatcherAlreadyPatched = patchedText.includes(
      "...(typeof fetchAgent?.dispatch === 'function' ? { dispatcher: fetchAgent } : {}),",
    );
    const dispatcherPatchable =
      patchedText.includes(BAILEYS_MEDIA_DISPATCHER_NEEDLE) &&
      patchedText.includes(BAILEYS_MEDIA_DISPATCHER_HEADER_NEEDLE);
    let dispatcherResolved = dispatcherAlreadyPatched;

    if (!dispatcherResolved && dispatcherPatchable) {
      patchedText = patchedText
        .replace(BAILEYS_MEDIA_DISPATCHER_NEEDLE, BAILEYS_MEDIA_DISPATCHER_REPLACEMENT)
        .replace(
          BAILEYS_MEDIA_DISPATCHER_HEADER_NEEDLE,
          BAILEYS_MEDIA_DISPATCHER_HEADER_REPLACEMENT,
        );
      applied = true;
      dispatcherResolved = true;
    }

    if (!dispatcherResolved) {
      return { applied: false, reason: "unexpected_content", targetPath };
    }

    if (!applied) {
      return { applied: false, reason: "already_patched" };
    }
    const tempPath = createTempPath(targetPath);
    const tempFd = openFile(tempPath, "wx", initialTargetValidation.mode);
    let tempFdClosed = false;
    try {
      writeFile(tempFd, patchedText, "utf8");
      closeFile(tempFd);
      tempFdClosed = true;
      const finalTargetValidation = validateTargetPath();
      if (!finalTargetValidation.ok) {
        return { applied: false, reason: finalTargetValidation.reason, targetPath };
      }
      renameFile(tempPath, targetPath);
      chmodFile(targetPath, initialTargetValidation.mode);
    } finally {
      if (!tempFdClosed) {
        try {
          closeFile(tempFd);
        } catch {
          // ignore failed-open cleanup
        }
      }
      removePath(tempPath, { force: true });
    }
    return { applied: true, reason: "patched", targetPath };
  } catch (error) {
    return {
      applied: false,
      reason: "error",
      targetPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function applyBundledPluginRuntimeHotfixes(params = {}) {
  const log = params.log ?? console;
  const baileysResult = applyBaileysEncryptedStreamFinishHotfix(params);
  if (baileysResult.applied) {
    log.log("[postinstall] patched @whiskeysockets/baileys runtime hotfixes");
    return;
  }
  if (baileysResult.reason !== "missing" && baileysResult.reason !== "already_patched") {
    log.warn(
      `[postinstall] could not patch @whiskeysockets/baileys runtime hotfixes: ${baileysResult.reason}`,
    );
  }
}

function resolveDistModuleUrl(packageRoot, distPath) {
  return pathToFileURL(join(packageRoot, distPath)).href;
}

async function importInstalledDistModule(params, distPath) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const pathExists = params.existsSync ?? existsSync;
  const modulePath = join(packageRoot, distPath);
  if (!pathExists(modulePath)) {
    return null;
  }
  const importModule = params.importModule ?? ((specifier) => import(specifier));
  return await importModule(resolveDistModuleUrl(packageRoot, distPath));
}

export async function runPluginRegistryPostinstallMigration(params = {}) {
  const log = params.log ?? console;
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const env = params.env ?? process.env;

  if (hasEnvFlag(env, DISABLE_PLUGIN_REGISTRY_MIGRATION_ENV)) {
    return { status: "disabled", migrated: false, reason: "disabled-env" };
  }

  try {
    const migrationModule = await importInstalledDistModule(
      params,
      "dist/commands/doctor/shared/plugin-registry-migration.js",
    );
    if (!migrationModule) {
      return { status: "skipped", reason: "missing-dist-entry" };
    }
    if (typeof migrationModule.migratePluginRegistryForInstall !== "function") {
      return { status: "skipped", reason: "missing-dist-contract" };
    }

    const result = await migrationModule.migratePluginRegistryForInstall({
      env,
      packageRoot,
    });
    for (const warning of result.preflight?.deprecationWarnings ?? []) {
      log.warn(`[postinstall] ${warning}`);
    }
    if (result.migrated) {
      log.log(
        `[postinstall] migrated plugin registry: ${result.current.plugins.length} plugin(s) indexed`,
      );
    }
    return result;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`[postinstall] could not migrate plugin registry: ${message}`);
    return { status: "failed", error: message };
  }
}

export function isSourceCheckoutRoot(params) {
  const pathExists = params.existsSync ?? existsSync;
  const hasPostinstallInventory = pathExists(join(params.packageRoot, DIST_INVENTORY_PATH));
  return (
    (pathExists(join(params.packageRoot, ".git")) ||
      (pathExists(join(params.packageRoot, "pnpm-workspace.yaml")) && !hasPostinstallInventory)) &&
    pathExists(join(params.packageRoot, "src")) &&
    pathExists(join(params.packageRoot, "extensions"))
  );
}

export function pruneBundledPluginSourceNodeModules(params = {}) {
  const extensionsDir = params.extensionsDir ?? join(DEFAULT_PACKAGE_ROOT, "extensions");
  const pathExists = params.existsSync ?? existsSync;
  const readDir = params.readdirSync ?? readdirSync;
  const removePath = params.rmSync ?? rmSync;

  if (!pathExists(extensionsDir)) {
    return;
  }

  for (const entry of readDir(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }

    const pluginDir = join(extensionsDir, entry.name);
    if (!pathExists(join(pluginDir, "package.json"))) {
      continue;
    }

    removePath(join(pluginDir, "node_modules"), { recursive: true, force: true });
  }
}

function shouldRunBundledPluginPostinstall(params) {
  if (params.env?.[DISABLE_POSTINSTALL_ENV]?.trim()) {
    return false;
  }
  if (!params.existsSync(params.extensionsDir)) {
    return false;
  }
  return true;
}

export function pruneOpenClawCompileCache(params = {}) {
  const env = params.env ?? process.env;
  const pathExists = params.existsSync ?? existsSync;
  const readDir = params.readdirSync ?? readdirSync;
  const remove = params.rmSync ?? rmSync;
  const log = params.log ?? console;
  const baseDirs = [
    env.NODE_DISABLE_COMPILE_CACHE ? "" : env.NODE_COMPILE_CACHE,
    join(tmpdir(), "node-compile-cache"),
  ].filter((value, index, values) => value && values.indexOf(value) === index);

  for (const baseDir of baseDirs) {
    if (!pathExists(baseDir)) {
      continue;
    }
    try {
      for (const entry of readDir(baseDir, { withFileTypes: true })) {
        if (!entry.isDirectory() || !NODE_COMPILE_CACHE_VERSION_DIR_RE.test(entry.name)) {
          continue;
        }
        try {
          remove(join(baseDir, entry.name), {
            recursive: true,
            force: true,
            maxRetries: 2,
            retryDelay: 100,
          });
        } catch (error) {
          log.warn?.(`[postinstall] could not prune OpenClaw compile cache: ${String(error)}`);
        }
      }
    } catch (error) {
      log.warn?.(`[postinstall] could not prune OpenClaw compile cache: ${String(error)}`);
    }
  }
}

export function runBundledPluginPostinstall(params = {}) {
  const env = params.env ?? process.env;
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const extensionsDir = params.extensionsDir ?? join(packageRoot, "dist", "extensions");
  const pathExists = params.existsSync ?? existsSync;
  const log = params.log ?? console;
  if (env?.[DISABLE_POSTINSTALL_ENV]?.trim()) {
    return;
  }
  pruneOpenClawCompileCache({
    env,
    existsSync: pathExists,
    rmSync: params.rmSync,
    log,
  });
  if (isSourceCheckoutRoot({ packageRoot, existsSync: pathExists })) {
    try {
      pruneBundledPluginSourceNodeModules({
        extensionsDir: join(packageRoot, "extensions"),
        existsSync: pathExists,
        readdirSync: params.readdirSync,
        rmSync: params.rmSync,
      });
    } catch (e) {
      log.warn(`[postinstall] could not prune bundled plugin source node_modules: ${String(e)}`);
    }
    applyBundledPluginRuntimeHotfixes({
      packageRoot,
      existsSync: pathExists,
      readFileSync: params.readFileSync,
      writeFileSync: params.writeFileSync,
      log,
    });
    return;
  }
  pruneLegacyPluginRuntimeDepsState({
    env,
    existsSync: pathExists,
    rmSync: params.rmSync,
    log,
    homedir: params.homedir,
  });
  pruneInstalledPackageDist({
    packageRoot,
    existsSync: pathExists,
    readFileSync: params.readFileSync,
    readdirSync: params.readdirSync,
    rmSync: params.rmSync,
    log,
  });
  if (
    !shouldRunBundledPluginPostinstall({
      env,
      extensionsDir,
      packageRoot,
      existsSync: pathExists,
    })
  ) {
    return;
  }
  applyBundledPluginRuntimeHotfixes({
    packageRoot,
    existsSync: pathExists,
    readFileSync: params.readFileSync,
    writeFileSync: params.writeFileSync,
    log,
  });
}

export function isDirectPostinstallInvocation(params = {}) {
  const entryPath = params.entryPath ?? process.argv[1];
  if (!entryPath) {
    return false;
  }
  const modulePath = params.modulePath ?? fileURLToPath(import.meta.url);
  const resolveRealPath = params.realpathSync ?? realpathSync;
  try {
    return resolveRealPath(entryPath) === resolveRealPath(modulePath);
  } catch {
    return pathToFileURL(entryPath).href === pathToFileURL(modulePath).href;
  }
}

if (isDirectPostinstallInvocation()) {
  runBundledPluginPostinstall();
  await runPluginRegistryPostinstallMigration();
}
