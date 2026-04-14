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
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
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
const BAILEYS_MEDIA_ONCE_IMPORT_RE = /import\s+\{\s*once\s*\}\s+from\s+['"]events['"]/u;
const BAILEYS_MEDIA_ASYNC_CONTEXT_RE =
  /async\s+function\s+encryptedStream|encryptedStream\s*=\s*async/u;

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, "utf8"));
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
    if (currentText.includes(BAILEYS_MEDIA_HOTFIX_REPLACEMENT)) {
      return { applied: false, reason: "already_patched" };
    }
    if (!currentText.includes(BAILEYS_MEDIA_HOTFIX_NEEDLE)) {
      return { applied: false, reason: "unexpected_content" };
    }
    if (!BAILEYS_MEDIA_ONCE_IMPORT_RE.test(currentText)) {
      return { applied: false, reason: "missing_once_import", targetPath };
    }
    if (!BAILEYS_MEDIA_ASYNC_CONTEXT_RE.test(currentText)) {
      return { applied: false, reason: "not_async_context", targetPath };
    }

    const patchedText = currentText.replace(
      BAILEYS_MEDIA_HOTFIX_NEEDLE,
      BAILEYS_MEDIA_HOTFIX_REPLACEMENT,
    );
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
    log.log("[postinstall] patched @whiskeysockets/baileys encryptedStream flush ordering");
    return;
  }
  if (baileysResult.reason !== "missing" && baileysResult.reason !== "already_patched") {
    log.warn(
      `[postinstall] could not patch @whiskeysockets/baileys encryptedStream: ${baileysResult.reason}`,
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
  const extensionsDir = params.extensionsDir ?? DEFAULT_EXTENSIONS_DIR;
  const packageRoot = params.packageRoot ?? DEFAULT_PACKAGE_ROOT;
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
