import fs from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { sha256Hex } from "./crypto-digest.js";
import { resolveBunGlobalInstallOwner } from "./detect-package-manager.js";
import { hasErrnoCode } from "./errors.js";
import { mergePathPrepend } from "./path-prepend.js";
import {
  resolvePnpmGlobalDirFromGlobalRoot,
  type ResolvedGlobalInstallTarget,
} from "./update-global.js";
import { resolvePnpmCandidateEnv } from "./update-package-manager.js";
import {
  relocateRuntimeLauncher,
  relocateRuntimeSymlink,
  relocateRuntimeTree,
  type RuntimeRelocation,
} from "./update-runtime-relocation.js";

export type NativePackageStage = {
  projectRoot: string;
  liveProjectRoot: string;
  binDir: string;
  liveBinDir: string;
  globalRoot: string;
  env: NodeJS.ProcessEnv;
  configArgs: string[];
  assertUnchanged: () => Promise<void>;
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
    fingerprint.set(path.relative(root, file), sha256Hex(value));
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

/** Stage a native global project without changing its live package, metadata, or launchers. */
export async function prepareNativePackageStage(params: {
  installTarget: ResolvedGlobalInstallTarget;
  packageName: string;
  installSpec: string;
  env?: NodeJS.ProcessEnv;
  globalBinDir?: string | null;
}): Promise<NativePackageStage | null> {
  const { installTarget } = params;
  if (installTarget.manager === "npm" || !installTarget.globalRoot) {
    return null;
  }
  if (installTarget.manager === "bun" && process.platform === "win32") {
    throw new Error(
      "Bun Windows binary launchers cannot be relocated by the staged updater. " +
        `Run \`bun add -g --trust ${params.installSpec}\` manually, then \`openclaw gateway restart\`; verify with \`openclaw update status\`.`,
    );
  }
  const env =
    installTarget.manager === "pnpm"
      ? resolvePnpmCandidateEnv(params.env ?? process.env, ".pnpm")
      : { ...(params.env ?? process.env) };
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
  const projectRoot = await fs.mkdtemp(
    path.join(
      path.dirname(liveProjectRoot),
      `.${path.basename(params.packageName)}-update-native-`,
    ),
  );
  // A sibling project preserves the depth of relative file:/link: dependency specs.
  // Its separate bin directory is disposable even after activation moves the project.
  let binDir: string | undefined;
  try {
    binDir = await fs.mkdtemp(`${projectRoot}.bin-`);
    await fs.cp(liveProjectRoot, projectRoot, { recursive: true, verbatimSymlinks: true });
    await fs.chmod(projectRoot, (await fs.stat(liveProjectRoot)).mode);
    const relocations: RuntimeRelocation[] = [
      {
        sourceRoot: liveProjectRoot,
        destinationRoot: projectRoot,
        sourceAliases: [ownerRoot],
      },
    ];
    if (
      installTarget.manager === "pnpm" &&
      path.basename(installTarget.globalRoot) === "node_modules"
    ) {
      // pnpm 10 reuses its global project; pruning must not follow a copied store
      // symlink into the serving generation. pnpm 11 creates a fresh package group.
      const privateStore = path.join(
        projectRoot,
        path.relative(ownerRoot, path.dirname(installTarget.globalRoot)),
        ".pnpm",
      );
      const store = await fs.lstat(privateStore).catch((error: unknown) => {
        if (hasErrnoCode(error, "ENOENT")) {
          return undefined;
        }
        throw error;
      });
      if (store?.isSymbolicLink()) {
        const sourceRoot = await fs.realpath(privateStore);
        await fs.unlink(privateStore);
        await fs.cp(sourceRoot, privateStore, { recursive: true, verbatimSymlinks: true });
        relocations.unshift({ sourceRoot, destinationRoot: privateStore });
      }
    }
    await relocateRuntimeTree(projectRoot, liveProjectRoot, projectRoot, relocations);
    // pnpm 11 derives its destinations before reading environment config. Explicit
    // CLI config selects the copied project and bin in both pnpm 10 and pnpm 11.
    const configArgs =
      installTarget.manager === "pnpm"
        ? [`--config.global-dir=${projectRoot}`, `--config.global-bin-dir=${binDir}`]
        : [];
    if (installTarget.manager === "bun") {
      env.BUN_INSTALL_GLOBAL_DIR = projectRoot;
      env.BUN_INSTALL_BIN = binDir;
      if (bunOwner?.bunInstall) {
        env.BUN_INSTALL = bunOwner.bunInstall;
      }
    }
    const pathKey = Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "PATH";
    env[pathKey] = mergePathPrepend(env[pathKey], [binDir]);
    return {
      projectRoot,
      liveProjectRoot,
      binDir,
      liveBinDir: path.resolve(liveBinDir),
      globalRoot: path.join(projectRoot, path.relative(ownerRoot, installTarget.globalRoot)),
      env,
      configArgs,
      assertUnchanged: async () => {
        if (!isDeepStrictEqual(await nativeProjectFingerprint(liveProjectRoot), fingerprint)) {
          throw new Error(
            "The native global installation changed before activation; retry the update.",
          );
        }
      },
    };
  } catch (error) {
    await fs.rm(projectRoot, { recursive: true, force: true });
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
  const relocations = [{ sourceRoot: stage.projectRoot, destinationRoot: stage.liveProjectRoot }];
  await relocateRuntimeTree(
    stage.projectRoot,
    stage.projectRoot,
    stage.liveProjectRoot,
    relocations,
  );
  for (const entry of await fs.readdir(stage.binDir, { withFileTypes: true })) {
    const file = path.join(stage.binDir, entry.name);
    const destinationFile = path.join(stage.liveBinDir, entry.name);
    if (entry.isSymbolicLink()) {
      await relocateRuntimeSymlink(file, file, destinationFile, relocations);
    } else if (entry.isFile()) {
      await relocateRuntimeLauncher(file, file, destinationFile, relocations);
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
