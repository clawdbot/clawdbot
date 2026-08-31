#!/usr/bin/env -S node --import tsx

import { spawnSync, type SpawnSyncOptions } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolveBuildIdentityEnvironment } from "./lib/build-identity.mts";

const WORKSPACE_DIRS_ENV = "OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS";
const REAL_NPM_ENV = "OPENCLAW_OCM_REAL_NPM_BIN";
const INTERNAL_NPM_BIN_ENV = "OCM_INTERNAL_NPM_BIN";
const ALLOW_UNRELEASED_CHANGELOG_ENV = "OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG";
const RUNTIME_BUILD_PROFILE_ENV = "OPENCLAW_OCM_RUNTIME_BUILD_PROFILE";
const supportedRuntimeBuildProfiles = new Set(["sourcePerformance"]);

type WorkspacePackage = { name: string; version: string; tarball: string };
type WorkspacePackageSource = Omit<WorkspacePackage, "tarball"> & { dir: string };

export function parseWorkspaceDependencyDirs(
  raw: string | undefined = process.env[WORKSPACE_DIRS_ENV],
  cwd: string = process.cwd(),
) {
  return (raw ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(cwd, entry));
}

function optionValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function resolveWorkspaceInstallPlan(
  args: string[],
  workspaceDirs: string[],
  cwd: string = process.cwd(),
) {
  if (args[0] !== "install" || workspaceDirs.length === 0) {
    return null;
  }
  const prefixDir = optionValue(args, "--prefix");
  const rootArchive = args.at(-1);
  if (!prefixDir || !rootArchive?.endsWith(".tgz")) {
    throw new Error("OCM workspace dependency install requires --prefix and a root .tgz archive");
  }
  return {
    installArgs: args.slice(0, -1),
    prefixDir: resolve(cwd, prefixDir),
    rootArchive: resolve(cwd, rootArchive),
  };
}

export function buildInstallManifest(
  rootArchive: string,
  workspacePackages: Pick<WorkspacePackage, "name" | "tarball">[],
) {
  return {
    private: true,
    dependencies: {
      openclaw: pathToFileURL(rootArchive).href,
      ...Object.fromEntries(
        workspacePackages.map(({ name, tarball }) => [name, pathToFileURL(tarball).href]),
      ),
    },
  };
}

function runNpm(npm: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = spawnSync(npm, args, {
    env: process.env,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

export function resolveNpmEnvironment(args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (args[0] !== "pack") {
    return env;
  }
  return {
    ...env,
    [INTERNAL_NPM_BIN_ENV]: fileURLToPath(import.meta.url),
    [ALLOW_UNRELEASED_CHANGELOG_ENV]: "1",
  };
}

export function resolveRuntimePackPlan(args: string[], env: NodeJS.ProcessEnv = process.env) {
  if (args[0] !== "pack") {
    return null;
  }
  const profile = env[RUNTIME_BUILD_PROFILE_ENV]?.trim();
  if (!profile) {
    return null;
  }
  if (!supportedRuntimeBuildProfiles.has(profile)) {
    throw new Error(`invalid ${RUNTIME_BUILD_PROFILE_ENV}: ${profile}`);
  }
  return {
    profile,
    packArgs: args.includes("--ignore-scripts") ? args : [...args, "--ignore-scripts"],
  };
}

export function resolveRuntimePackEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  now: () => Date = () => new Date(),
  readGitCommit: () => string | null = () => {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout.trim() : null;
  },
) {
  return resolveBuildIdentityEnvironment({
    commitLabel: "runtime pack commit",
    env,
    now,
    readGitCommit,
  });
}

function runTar(args: string[]) {
  const result = spawnSync("tar", args, {
    env: process.env,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`tar failed with status ${result.status ?? 1}`);
  }
}

function runChecked(command: string, args: string[], options: SpawnSyncOptions = {}) {
  const result = runNpm(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status ?? 1}`);
  }
}

function supportsPreparedRuntimePack(env: NodeJS.ProcessEnv) {
  const script = `
    const mod = await import("./scripts/openclaw-prepack.ts");
    process.exit(typeof mod.preparePrepackArtifacts === "function" ? 0 : 1);
  `;
  const result = runNpm(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "--eval", script],
    {
      env,
      stdio: "ignore",
    },
  );
  return result.status === 0;
}

function prepareRuntimePack(profile: string, env: NodeJS.ProcessEnv) {
  runChecked(process.execPath, ["--import", "tsx", "scripts/build-all.mts", profile], {
    env,
    stdio: "inherit",
  });
  runChecked(process.execPath, ["scripts/ui.js", "build"], {
    env,
    stdio: "inherit",
  });
  const script = `
    const mod = await import("./scripts/openclaw-prepack.ts");
    await mod.preparePrepackArtifacts();
  `;
  runChecked(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", script], {
    env,
    stdio: "inherit",
  });
}

export function restoreRuntimePack(env: NodeJS.ProcessEnv, cwd: string = process.cwd()) {
  const script = `
    const { existsSync } = await import("node:fs");
    if (existsSync("./scripts/openclaw-postpack.mjs")) {
      const mod = await import("./scripts/openclaw-postpack.mjs");
      await mod.restorePrepackArtifacts();
    } else {
      // Historical source refs predate the composite lifecycle and only mutate CHANGELOG.md.
      const mod = await import("./scripts/package-changelog.mjs");
      await mod.restorePackageChangelog();
    }
  `;
  runChecked(process.execPath, ["--input-type=module", "--eval", script], {
    cwd,
    env,
    stdio: "inherit",
  });
}

export function runPreparedRuntimePack<T>(
  prepare: () => void,
  pack: () => T,
  restore: () => void,
): T {
  prepare();
  try {
    return pack();
  } finally {
    restore();
  }
}

function packWorkspaceDependencies(
  npm: string,
  workspaceDirs: string[],
  outputDir: string,
): WorkspacePackage[] {
  const sources: WorkspacePackageSource[] = workspaceDirs.map((packageDir) => {
    const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    if (typeof packageJson.name !== "string" || packageJson.name.trim() === "") {
      throw new Error(`workspace dependency has no package name: ${packageDir}`);
    }
    if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
      throw new Error(`workspace dependency has no package version: ${packageDir}`);
    }
    return {
      dir: packageDir,
      name: packageJson.name,
      version: packageJson.version,
    };
  });
  const workspacePackages = sources.map(({ dir, name, version }) => {
    const before = new Set(readdirSync(outputDir));
    const result = runNpm(npm, ["pack", dir, "--pack-destination", outputDir, "--silent"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (result.status !== 0) {
      throw new Error(`npm pack failed for ${name} with status ${result.status ?? 1}`);
    }
    const tarballs = readdirSync(outputDir).filter(
      (entry) => entry.endsWith(".tgz") && !before.has(entry),
    );
    if (tarballs.length !== 1) {
      throw new Error(
        `expected npm pack to create one archive for ${name}, found ${tarballs.length}`,
      );
    }
    return {
      name,
      version,
      tarball: join(outputDir, tarballs[0]!),
    };
  });
  return workspacePackages.map((workspacePackage, index) => {
    return {
      name: workspacePackage.name,
      version: workspacePackage.version,
      tarball: patchPackageArchiveWorkspaceDependencies(
        workspacePackage.tarball,
        workspacePackages,
        outputDir,
        `workspace-${index}`,
      ),
    };
  });
}

export function rewriteWorkspaceDependencyVersions(
  packageJson: Record<string, unknown>,
  workspacePackages: WorkspacePackage[],
) {
  const workspaceVersions = new Map(workspacePackages.map(({ name, version }) => [name, version]));
  let rewritten = 0;
  for (const section of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "devDependencies",
  ]) {
    const dependencies = packageJson[section];
    if (!dependencies || typeof dependencies !== "object" || Array.isArray(dependencies)) {
      continue;
    }
    for (const [name, spec] of Object.entries(dependencies)) {
      if (typeof spec !== "string" || !spec.startsWith("workspace:")) {
        continue;
      }
      const version = workspaceVersions.get(name);
      if (!version) {
        throw new Error(`package archive references unconfigured workspace dependency: ${name}`);
      }
      Reflect.set(dependencies, name, version);
      rewritten += 1;
    }
  }
  return rewritten;
}

function patchPackageArchiveWorkspaceDependencies(
  archive: string,
  workspacePackages: WorkspacePackage[],
  outputDir: string,
  outputStem: string,
): string {
  const unpackDir = join(outputDir, `${outputStem}-archive`);
  mkdirSync(unpackDir);
  runTar(["-xzf", archive, "-C", unpackDir]);

  const packageJsonPath = join(unpackDir, "package", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const rewritten = rewriteWorkspaceDependencyVersions(packageJson, workspacePackages);
  if (rewritten === 0) {
    return archive;
  }

  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const patchedArchive = join(outputDir, `${outputStem}-patched.tgz`);
  runTar(["-czf", patchedArchive, "-C", unpackDir, "package"]);
  return patchedArchive;
}

function patchRootArchiveWorkspaceDependencies(
  rootArchive: string,
  workspacePackages: WorkspacePackage[],
  outputDir: string,
): string {
  return patchPackageArchiveWorkspaceDependencies(
    rootArchive,
    workspacePackages,
    outputDir,
    "openclaw-root",
  );
}

function main(): number {
  const args = process.argv.slice(2);
  const npm = process.env[REAL_NPM_ENV]?.trim() || "npm";
  const workspaceDirs = parseWorkspaceDependencyDirs();
  const npmEnv = resolveNpmEnvironment(args);
  const runtimePackPlan = resolveRuntimePackPlan(args);
  const runtimePackEnv = runtimePackPlan ? resolveRuntimePackEnvironment(npmEnv) : null;
  if (runtimePackPlan && runtimePackEnv && supportsPreparedRuntimePack(runtimePackEnv)) {
    // This adapter-only archive is installed into OCM and never published.
    // Standard npm pack still runs the full package build.
    return runPreparedRuntimePack(
      () => prepareRuntimePack(runtimePackPlan.profile, runtimePackEnv),
      () => {
        const result = runNpm(npm, runtimePackPlan.packArgs, {
          env: runtimePackEnv,
          stdio: "inherit",
        });
        return result.status ?? 1;
      },
      () => restoreRuntimePack(runtimePackEnv),
    );
  }
  const plan = resolveWorkspaceInstallPlan(args, workspaceDirs);
  if (!plan) {
    const result = runNpm(npm, args, {
      env: npmEnv,
      stdio: "inherit",
    });
    return result.status ?? 1;
  }

  const packDir = mkdtempSync(join(tmpdir(), "openclaw-ocm-workspace-deps-"));
  try {
    const workspacePackages = packWorkspaceDependencies(npm, workspaceDirs, packDir);
    const rootArchive = patchRootArchiveWorkspaceDependencies(
      plan.rootArchive,
      workspacePackages,
      packDir,
    );
    mkdirSync(plan.prefixDir, { recursive: true });
    writeFileSync(
      join(plan.prefixDir, "package.json"),
      `${JSON.stringify(buildInstallManifest(rootArchive, workspacePackages), null, 2)}\n`,
    );
    const result = runNpm(npm, plan.installArgs, { stdio: "inherit" });
    return result.status ?? 1;
  } finally {
    rmSync(packDir, { force: true, recursive: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = main();
}
