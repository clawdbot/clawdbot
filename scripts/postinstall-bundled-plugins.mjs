#!/usr/bin/env node
// Runs after install to restore bundled extension runtime deps.
// Installed builds can lazy-load bundled plugin code through root dist chunks,
// so runtime dependencies declared in dist/extensions/*/package.json must also
// resolve from the package root node_modules. Source checkouts resolve bundled
// plugin deps from the workspace root, so stale plugin-local node_modules must
// not linger under extensions/* and shadow the root graph.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
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
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveNpmRunner } from "./npm-runner.mjs";

export const BUNDLED_PLUGIN_INSTALL_TARGETS = [];

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_EXTENSIONS_DIR = join(__dirname, "..", "dist", "extensions");
const DEFAULT_PACKAGE_ROOT = join(__dirname, "..");
const DISABLE_POSTINSTALL_ENV = "OPENCLAW_DISABLE_BUNDLED_PLUGIN_POSTINSTALL";
const DIST_INVENTORY_PATH = "dist/postinstall-inventory.json";
const LEGACY_UPDATE_COMPAT_SIDECARS = [
  {
    path: "dist/extensions/qa-channel/runtime-api.js",
    removedPrefix: "dist/extensions/qa-channel/",
    content:
      "// Compatibility stub for older OpenClaw updaters. The QA channel implementation is not packaged.\nexport {};\n",
  },
  {
    path: "dist/extensions/qa-lab/runtime-api.js",
    removedPrefix: "dist/extensions/qa-lab/",
    content:
      "// Compatibility stub for older OpenClaw updaters. The QA lab implementation is not packaged.\nexport {};\n",
  },
];
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

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
}

function normalizeRelativePath(filePath) {
  return filePath.replace(/\\/g, "/");
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

export function pruneInstalledPackageDist(params = {}) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const removeFile = params.unlinkSync ?? unlinkSync;
  const log = params.log ?? console;
  const distRoot = resolveInstalledDistRoot(params);
  if (distRoot === null) {
    return [];
  }
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
  return removed;
}

export function restoreLegacyUpdaterCompatSidecars(params = {}) {
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const writeFile = params.writeFileSync ?? writeFileSync;
  const makeDirectory = params.mkdirSync ?? mkdirSync;
  const log = params.log ?? console;
  const restored = [];

  for (const sidecar of LEGACY_UPDATE_COMPAT_SIDECARS) {
    // Older npm updater builds verify these exact sidecars after npm has
    // already replaced the package, so generate them independently of prune
    // results.
    const sidecarPath = join(packageRoot, sidecar.path);
    makeDirectory(dirname(sidecarPath), { recursive: true });
    writeFile(sidecarPath, sidecar.content, "utf8");
    restored.push(sidecar.path);
  }

  if (restored.length > 0) {
    log.log(`[postinstall] restored legacy updater compat sidecars: ${restored.join(", ")}`);
  }
  return restored;
}

function dependencySentinelPath(depName) {
  return join("node_modules", ...depName.split("/"), "package.json");
}

const KNOWN_NATIVE_PLATFORMS = new Set([
  "aix",
  "android",
  "darwin",
  "freebsd",
  "linux",
  "openbsd",
  "sunos",
  "win32",
]);
const KNOWN_NATIVE_ARCHES = new Set(["arm", "arm64", "ia32", "ppc64", "riscv64", "s390x", "x64"]);

function packageNameTokens(name) {
  return name
    .toLowerCase()
    .split(/[/@._-]+/u)
    .filter(Boolean);
}

function optionalDependencyTargetsRuntime(name, params = {}) {
  const platform = params.platform ?? process.platform;
  const arch = params.arch ?? process.arch;
  const tokens = new Set(packageNameTokens(name));
  const hasNativePlatformToken = [...tokens].some((token) => KNOWN_NATIVE_PLATFORMS.has(token));
  const hasNativeArchToken = [...tokens].some((token) => KNOWN_NATIVE_ARCHES.has(token));
  return hasNativePlatformToken && hasNativeArchToken && tokens.has(platform) && tokens.has(arch);
}

function runtimeDepNeedsInstall(params) {
  const packageJsonPath = join(params.packageRoot, params.dep.sentinelPath);
  if (!params.existsSync(packageJsonPath)) {
    return true;
  }

  try {
    const packageJson = params.readJson(packageJsonPath);
    return Object.keys(packageJson.optionalDependencies ?? {}).some(
      (childName) =>
        optionalDependencyTargetsRuntime(childName, {
          arch: params.arch,
          platform: params.platform,
        }) && !params.existsSync(join(params.packageRoot, dependencySentinelPath(childName))),
    );
  } catch {
    return true;
  }
}

function collectRuntimeDeps(packageJson) {
  return {
    ...packageJson.dependencies,
    ...packageJson.optionalDependencies,
  };
}

export function discoverBundledPluginRuntimeDeps(params = {}) {
  const extensionsDir = params.extensionsDir ?? DEFAULT_EXTENSIONS_DIR;
  const pathExists = params.existsSync ?? existsSync;
  const readDir = params.readdirSync ?? readdirSync;
  const readJsonFile = params.readJson ?? readJson;
  const deps = new Map(
    BUNDLED_PLUGIN_INSTALL_TARGETS.map((target) => [
      target.name,
      {
        name: target.name,
        version: target.version,
        sentinelPath: dependencySentinelPath(target.name),
        pluginIds: [...(target.pluginIds ?? [])],
      },
    ]),
  );

  if (!pathExists(extensionsDir)) {
    return [...deps.values()].toSorted((a, b) => a.name.localeCompare(b.name));
  }

  for (const entry of readDir(extensionsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const pluginId = entry.name;
    const packageJsonPath = join(extensionsDir, pluginId, "package.json");
    if (!pathExists(packageJsonPath)) {
      continue;
    }
    try {
      const packageJson = readJsonFile(packageJsonPath);
      for (const [name, version] of Object.entries(collectRuntimeDeps(packageJson))) {
        const existing = deps.get(name);
        if (existing) {
          if (existing.version !== version) {
            continue;
          }
          if (!existing.pluginIds.includes(pluginId)) {
            existing.pluginIds.push(pluginId);
          }
          continue;
        }
        deps.set(name, {
          name,
          version,
          sentinelPath: dependencySentinelPath(name),
          pluginIds: [pluginId],
        });
      }
    } catch {
      // Ignore malformed plugin manifests; runtime will surface those separately.
    }
  }

  return [...deps.values()]
    .map((dep) => ({
      ...dep,
      pluginIds: [...dep.pluginIds].toSorted((a, b) => a.localeCompare(b)),
    }))
    .toSorted((a, b) => a.name.localeCompare(b.name));
}

export function createNestedNpmInstallEnv(env = process.env) {
  const nextEnv = { ...env };
  delete nextEnv.npm_config_global;
  delete nextEnv.npm_config_location;
  delete nextEnv.npm_config_prefix;
  return nextEnv;
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

export function isSourceCheckoutRoot(params) {
  const pathExists = params.existsSync ?? existsSync;
  return (
    pathExists(join(params.packageRoot, ".git")) &&
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

export function runBundledPluginPostinstall(params = {}) {
  const env = params.env ?? process.env;
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
  const extensionsDir = params.extensionsDir ?? join(packageRoot, "dist", "extensions");
  const spawn = params.spawnSync ?? spawnSync;
  const pathExists = params.existsSync ?? existsSync;
  const log = params.log ?? console;
  if (env?.[DISABLE_POSTINSTALL_ENV]?.trim()) {
    return;
  }
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
  const prunedDistFiles = pruneInstalledPackageDist({
    packageRoot,
    existsSync: pathExists,
    readFileSync: params.readFileSync,
    readdirSync: params.readdirSync,
    rmSync: params.rmSync,
    log,
  });
  restoreLegacyUpdaterCompatSidecars({
    packageRoot,
    removedFiles: prunedDistFiles,
    mkdirSync: params.mkdirSync,
    writeFileSync: params.writeFileSync,
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
  const runtimeDeps =
    params.runtimeDeps ??
    discoverBundledPluginRuntimeDeps({ extensionsDir, existsSync: pathExists });
  const missingSpecs = runtimeDeps
    .filter((dep) =>
      runtimeDepNeedsInstall({
        dep,
        existsSync: pathExists,
        packageRoot,
        arch: params.arch,
        platform: params.platform,
        readJson: params.readJson ?? readJson,
      }),
    )
    .map((dep) => `${dep.name}@${dep.version}`);

  if (missingSpecs.length === 0) {
    applyBundledPluginRuntimeHotfixes({
      packageRoot,
      existsSync: pathExists,
      readFileSync: params.readFileSync,
      writeFileSync: params.writeFileSync,
      log,
    });
    return;
  }

  try {
    const nestedEnv = createNestedNpmInstallEnv(env);
    const npmRunner =
      params.npmRunner ??
      resolveNpmRunner({
        env: nestedEnv,
        execPath: params.execPath,
        existsSync: pathExists,
        platform: params.platform,
        comSpec: params.comSpec,
        npmArgs: [
          "install",
          "--omit=dev",
          "--no-save",
          "--package-lock=false",
          "--legacy-peer-deps",
          ...missingSpecs,
        ],
      });
    const result = spawn(npmRunner.command, npmRunner.args, {
      cwd: packageRoot,
      encoding: "utf8",
      env: npmRunner.env ?? nestedEnv,
      stdio: "pipe",
      shell: npmRunner.shell,
      windowsVerbatimArguments: npmRunner.windowsVerbatimArguments,
    });
    if (result.status !== 0) {
      const output = [result.stderr, result.stdout].filter(Boolean).join("\n").trim();
      throw new Error(output || "npm install failed");
    }
    log.log(`[postinstall] installed bundled plugin deps: ${missingSpecs.join(", ")}`);
  } catch (e) {
    // Non-fatal: gateway will surface the missing dep via doctor.
    log.warn(`[postinstall] could not install bundled plugin deps: ${String(e)}`);
  }

  applyBundledPluginRuntimeHotfixes({
    packageRoot,
    existsSync: pathExists,
    readFileSync: params.readFileSync,
    writeFileSync: params.writeFileSync,
    log,
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runBundledPluginPostinstall();
}
