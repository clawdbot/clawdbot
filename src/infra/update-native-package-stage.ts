import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { resolveBunGlobalInstallOwner } from "./detect-package-manager.js";
import { hasErrnoCode } from "./errors.js";
import { isPathInside } from "./path-guards.js";
import { mergePathPrepend } from "./path-prepend.js";
import {
  resolvePnpmGlobalDirFromGlobalRoot,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";

export type NativePackageStage = {
  prefix: string;
  projectRoot: string;
  liveProjectRoot: string;
  binDir: string;
  liveBinDir: string;
  globalRoot: string;
  env: NodeJS.ProcessEnv;
  assertUnchanged: () => Promise<void>;
};

type Relocation = {
  sourceRoot: string;
  destinationRoot: string;
  sourceAliases?: string[];
};

export class NativePackageRollbackError extends Error {
  readonly reason = "rollback-project-changed";
}

async function nativeProjectFingerprint(
  root: string,
  excludePackage?: string,
): Promise<Map<string, string>> {
  const fingerprint = new Map<string, string>();
  const record = (file: string, value: string) => {
    fingerprint.set(path.relative(root, file), createHash("sha256").update(value).digest("hex"));
  };
  const manifests = new Set([
    "package.json",
    "pnpm-lock.yaml",
    "pnpm-workspace.yaml",
    "bun.lock",
    "bun.lockb",
    ".npmrc",
    ".pnpmfile.cjs",
    "bunfig.toml",
  ]);
  async function visit(directory: string, depth: number): Promise<void> {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries.toSorted((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      if (entry.name === "node_modules") {
        if (excludePackage) {
          await packages(file);
        }
      } else if (entry.isSymbolicLink()) {
        record(file, await fs.readlink(file));
      } else if (entry.isFile() && manifests.has(entry.name)) {
        record(file, await fs.readFile(file, "base64"));
      } else if (
        entry.isDirectory() &&
        (depth === 1 || (depth === 0 && /^v?\d+$/u.test(entry.name)))
      ) {
        await visit(file, depth + 1);
      }
    }
  }
  async function packages(directory: string, scope = ""): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const name = `${scope}${entry.name}`;
      if (entry.name.startsWith(".") || name === excludePackage) {
        continue;
      }
      const file = path.join(directory, entry.name);
      if (!scope && entry.name.startsWith("@") && entry.isDirectory()) {
        await packages(file, `${entry.name}/`);
      } else if (entry.isSymbolicLink()) {
        record(file, await fs.readlink(file));
      } else {
        const manifest = await fs
          .readFile(path.join(file, "package.json"), "base64")
          .catch((error: unknown) => {
            if (hasErrnoCode(error, "ENOENT") || hasErrnoCode(error, "ENOTDIR")) {
              return "";
            }
            throw error;
          });
        record(file, manifest);
      }
    }
  }
  // Owner manifests, pnpm group metadata and active links track manager mutations.
  // Rollback also tracks direct sibling entries, never payloads or shared stores.
  await visit(root, 0);
  return fingerprint;
}

function relocatePath(value: string, relocation: Relocation): string {
  const root = [relocation.sourceRoot, ...(relocation.sourceAliases ?? [])].find((candidate) =>
    isPathInside(candidate, value),
  );
  return root ? path.join(relocation.destinationRoot, path.relative(root, value)) : value;
}

async function relocateSymlink(
  file: string,
  sourceFile: string,
  destinationFile: string,
  relocation: Relocation,
): Promise<void> {
  const link = await fs.readlink(file);
  const target = relocatePath(path.resolve(path.dirname(sourceFile), link), relocation);
  const replacement = path.isAbsolute(link)
    ? target
    : path.relative(path.dirname(destinationFile), target);
  if (replacement === link) {
    return;
  }
  const type =
    process.platform === "win32" && (await fs.stat(file)).isDirectory() ? "junction" : "file";
  await fs.unlink(file);
  await fs.symlink(replacement, file, type);
}

async function relocateLauncher(
  file: string,
  sourceFile: string,
  destinationFile: string,
  relocation: Relocation,
): Promise<void> {
  const original = await fs.readFile(file, "utf8");
  // pnpm cmd-shim uses these directory-relative references on sh, cmd and PowerShell.
  // Resolve them before changing the directory; absolute store/runtime paths stay external.
  let content = original.replace(
    /(\$(?:basedir|basedir_win)[/\\]|%~dp0\\)([^"\r\n]+)/gu,
    (match, prefix: string, relative: string) => {
      if (/[$%]/u.test(relative)) {
        return match;
      }
      const sourceTarget = path.resolve(
        path.dirname(sourceFile),
        relative.replaceAll("\\", path.sep),
      );
      const target = relocatePath(sourceTarget, relocation);
      if (target === sourceTarget) {
        // Bin-local runtime lookups belong to the destination bin, not the copied project.
        return match;
      }
      const replacement = path.relative(path.dirname(destinationFile), target);
      return `${prefix}${prefix.startsWith("%") ? replacement.replaceAll("/", "\\") : replacement.replaceAll("\\", "/")}`;
    },
  );
  for (const sourceRoot of [relocation.sourceRoot, ...(relocation.sourceAliases ?? [])]) {
    // NODE_PATH and the shim's target comment can carry absolute project paths.
    content = content.replaceAll(
      `${sourceRoot}${path.sep}`,
      `${relocation.destinationRoot}${path.sep}`,
    );
    if (path.sep === "\\") {
      content = content.replaceAll(
        `${sourceRoot.replaceAll("\\", "/")}/`,
        `${relocation.destinationRoot.replaceAll("\\", "/")}/`,
      );
    }
  }
  if (content !== original) {
    await fs.writeFile(file, content);
  }
}

async function relocateModulesManifest(file: string, relocation: Relocation): Promise<void> {
  const original = await fs.readFile(file, "utf8");
  const manifest: unknown = parseYaml(original);
  if (!isRecord(manifest)) {
    return;
  }
  let changed = false;
  // pnpm persists absolute virtualStoreDir on Windows and storeDir on every platform.
  // Only owned paths move; a shared external content store retains its identity.
  for (const key of ["virtualStoreDir", "storeDir"]) {
    const value = manifest[key];
    if (typeof value === "string" && path.isAbsolute(value)) {
      const replacement = relocatePath(value, relocation);
      if (replacement !== value) {
        manifest[key] = replacement;
        changed = true;
      }
    }
  }
  if (changed) {
    const content = original.trimStart().startsWith("{")
      ? `${JSON.stringify(manifest, null, 2)}\n`
      : stringifyYaml(manifest);
    await fs.writeFile(file, content);
  }
}

async function relocateProjectTree(root: string, relocation: Relocation): Promise<void> {
  async function visit(directory: string): Promise<void> {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      const relative = path.relative(root, file);
      const sourceFile = path.join(relocation.sourceRoot, relative);
      const destinationFile = path.join(relocation.destinationRoot, relative);
      if (entry.isSymbolicLink()) {
        await relocateSymlink(file, sourceFile, destinationFile, relocation);
      } else if (entry.isDirectory()) {
        await visit(file);
      } else if (entry.isFile()) {
        if (entry.name === ".modules.yaml") {
          await relocateModulesManifest(file, relocation);
        } else if (path.basename(directory) === ".bin" && !entry.name.endsWith(".exe")) {
          await relocateLauncher(file, sourceFile, destinationFile, relocation);
        }
      }
    }
  }
  // Traverse the copied tree only; following a package/store symlink would mutate live data.
  await visit(root);
}

/** Stage a native global project without changing its live package, metadata, or launchers. */
export async function prepareNativePackageStage(params: {
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  env?: NodeJS.ProcessEnv;
  globalBinDir?: string | null;
}): Promise<NativePackageStage | null> {
  const { installTarget } = params;
  if (installTarget.manager === "npm" || !installTarget.globalRoot) {
    return null;
  }
  if (installTarget.manager === "bun" && process.platform === "win32") {
    throw new Error("Bun Windows binary launchers cannot be relocated by the staged updater.");
  }
  const env = { ...(params.env ?? process.env) };
  const bunOwner =
    installTarget.manager === "bun"
      ? resolveBunGlobalInstallOwner(installTarget.packageRoot, env)
      : null;
  const ownerRoot =
    installTarget.manager === "pnpm"
      ? resolvePnpmGlobalDirFromGlobalRoot(installTarget.globalRoot)
      : bunOwner?.globalProjectRoot;
  const liveBinDir = params.globalBinDir?.trim();
  if (!ownerRoot || !liveBinDir) {
    throw new Error(
      `Unable to resolve the native ${installTarget.manager} project and bin directories before staging.`,
    );
  }
  const liveProjectRoot = await fs.realpath(ownerRoot);
  const fingerprint = await nativeProjectFingerprint(liveProjectRoot);
  // pnpm cleans unreferenced children of its global layout. Keep both the stage and
  // retained project backup outside that layout so validation cannot race its cleaner.
  const prefix = await fs.mkdtemp(
    path.join(
      path.dirname(liveProjectRoot),
      `.${path.basename(params.packageName)}-update-native-`,
    ),
  );
  // A sibling project preserves the depth of relative file:/link: dependency specs.
  // Its separate bin directory is disposable even after activation moves the project.
  const projectRoot = prefix;
  let binDir: string | undefined;
  try {
    binDir = await fs.mkdtemp(`${prefix}.bin-`);
    await fs.cp(liveProjectRoot, projectRoot, { recursive: true, verbatimSymlinks: true });
    await fs.chmod(projectRoot, (await fs.stat(liveProjectRoot)).mode);
    await relocateProjectTree(projectRoot, {
      sourceRoot: liveProjectRoot,
      destinationRoot: projectRoot,
      sourceAliases: [ownerRoot],
    });
    if (installTarget.manager === "pnpm") {
      for (const configPrefix of ["pnpm_config", "PNPM_CONFIG", "npm_config", "NPM_CONFIG"]) {
        const uppercase = configPrefix === configPrefix.toUpperCase();
        env[`${configPrefix}_${uppercase ? "GLOBAL_DIR" : "global_dir"}`] = projectRoot;
        env[`${configPrefix}_${uppercase ? "GLOBAL_BIN_DIR" : "global_bin_dir"}`] = binDir;
      }
    } else {
      env.BUN_INSTALL_GLOBAL_DIR = projectRoot;
      env.BUN_INSTALL_BIN = binDir;
      if (bunOwner?.bunInstall) {
        env.BUN_INSTALL = bunOwner.bunInstall;
      }
    }
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = mergePathPrepend(env[pathKey], [binDir]);
    return {
      prefix,
      projectRoot,
      liveProjectRoot,
      binDir,
      liveBinDir: path.resolve(liveBinDir),
      globalRoot: path.join(projectRoot, path.relative(ownerRoot, installTarget.globalRoot)),
      env,
      assertUnchanged: async () => {
        if (!isDeepStrictEqual(await nativeProjectFingerprint(liveProjectRoot), fingerprint)) {
          throw new Error(
            "The native global installation changed before activation; retry the update.",
          );
        }
      },
    };
  } catch (error) {
    await fs.rm(prefix, { recursive: true, force: true });
    if (binDir) {
      await fs.rm(binDir, { recursive: true, force: true });
    }
    throw error;
  }
}

/** Prepare copied paths for the live location after candidate validation, before service stop. */
export async function finalizeNativePackageStage(
  stage: NativePackageStage,
  packageName: string,
): Promise<() => Promise<void>> {
  await stage.assertUnchanged();
  const relocation = { sourceRoot: stage.projectRoot, destinationRoot: stage.liveProjectRoot };
  await relocateProjectTree(stage.projectRoot, relocation);
  for (const entry of await fs.readdir(stage.binDir, { withFileTypes: true })) {
    const file = path.join(stage.binDir, entry.name);
    const destinationFile = path.join(stage.liveBinDir, entry.name);
    if (entry.isSymbolicLink()) {
      await relocateSymlink(file, file, destinationFile, relocation);
    } else if (entry.isFile()) {
      await relocateLauncher(file, file, destinationFile, relocation);
    }
  }
  // Candidate installation rewrites shared locks and pnpm group links. Capture their
  // finalized staged form, excluding the package payload that verification may repair.
  const fingerprint = await nativeProjectFingerprint(stage.projectRoot, packageName);
  return async () => {
    const current = await nativeProjectFingerprint(stage.liveProjectRoot, packageName);
    const changed = [...new Set([...fingerprint.keys(), ...current.keys()])].filter(
      (name) => fingerprint.get(name) !== current.get(name),
    );
    if (changed.length) {
      const names = [...new Set(changed.map((name) => path.basename(name)))].toSorted();
      const summary = names
        .slice(0, 20)
        .map((name) => name.slice(0, 80))
        .join(", ");
      throw new NativePackageRollbackError(
        `Global project changed since staging: ${summary}${names.length > 20 ? ", …" : ""}`,
      );
    }
  };
}
