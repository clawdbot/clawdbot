#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const WORKSPACE_DIRS_ENV = "OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS";
const REAL_NPM_ENV = "OPENCLAW_OCM_REAL_NPM_BIN";
const INTERNAL_NPM_BIN_ENV = "OCM_INTERNAL_NPM_BIN";
const ALLOW_UNRELEASED_CHANGELOG_ENV = "OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG";
const RUNTIME_BUILD_PROFILE_ENV = "OPENCLAW_OCM_RUNTIME_BUILD_PROFILE";
const supportedRuntimeBuildProfiles = new Set(["sourcePerformance"]);
const fullGitCommitPattern = /^[0-9a-f]{40}$/iu;

export function parseWorkspaceDependencyDirs(
  raw = process.env[WORKSPACE_DIRS_ENV],
  cwd = process.cwd(),
) {
  return (raw ?? "")
    .split(delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => resolve(cwd, entry));
}

function optionValue(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

export function resolveWorkspaceInstallPlan(args, workspaceDirs, cwd = process.cwd()) {
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

export function buildInstallManifest(rootArchive, workspacePackages) {
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

function runNpm(npm, args, options = {}) {
  const result = spawnSync(npm, args, {
    env: process.env,
    ...options,
  });
  if (result.error) {
    throw result.error;
  }
  return result;
}

export function resolveNpmEnvironment(args, env = process.env) {
  if (args[0] !== "pack") {
    return env;
  }
  return {
    ...env,
    [INTERNAL_NPM_BIN_ENV]: fileURLToPath(import.meta.url),
    [ALLOW_UNRELEASED_CHANGELOG_ENV]: "1",
  };
}

export function resolveRuntimePackPlan(args, env = process.env) {
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
  env = process.env,
  now = () => new Date(),
  readGitCommit = () => {
    const result = spawnSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return result.status === 0 ? result.stdout.trim() : null;
  },
) {
  const explicitTimestamp = env.OPENCLAW_BUILD_TIMESTAMP?.trim();
  const explicitCommit = env.GIT_COMMIT?.trim() || env.GIT_SHA?.trim();
  const checkedOutCommit = explicitCommit ? null : readGitCommit()?.trim();
  const commit = explicitCommit || checkedOutCommit || env.GITHUB_SHA?.trim();
  if (commit && !fullGitCommitPattern.test(commit)) {
    throw new Error("runtime pack commit must be a full 40-character hexadecimal SHA");
  }
  return {
    ...env,
    OPENCLAW_BUILD_TIMESTAMP: explicitTimestamp || now().toISOString(),
    ...(commit ? { GIT_COMMIT: commit.toLowerCase() } : {}),
  };
}

function runTar(args) {
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

function runChecked(command, args, options = {}) {
  const result = runNpm(command, args, options);
  if (result.status !== 0) {
    throw new Error(`${command} failed with status ${result.status ?? 1}`);
  }
}

function supportsPreparedRuntimePack(env) {
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

function prepareRuntimePack(profile, env) {
  runChecked(process.execPath, ["scripts/build-all.mjs", profile], {
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

function restoreRuntimePack(env) {
  const script = `
    const mod = await import("./scripts/package-changelog.mjs");
    await mod.restorePackageChangelog();
  `;
  runChecked(process.execPath, ["--input-type=module", "--eval", script], {
    env,
    stdio: "inherit",
  });
}

function packWorkspaceDependencies(npm, workspaceDirs, outputDir) {
  return workspaceDirs.map((packageDir) => {
    const packageJson = JSON.parse(readFileSync(join(packageDir, "package.json"), "utf8"));
    if (typeof packageJson.name !== "string" || packageJson.name.trim() === "") {
      throw new Error(`workspace dependency has no package name: ${packageDir}`);
    }
    if (typeof packageJson.version !== "string" || packageJson.version.trim() === "") {
      throw new Error(`workspace dependency has no package version: ${packageDir}`);
    }
    const before = new Set(readdirSync(outputDir));
    const result = runNpm(npm, ["pack", packageDir, "--pack-destination", outputDir, "--silent"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "inherit"],
    });
    if (result.status !== 0) {
      throw new Error(`npm pack failed for ${packageJson.name} with status ${result.status ?? 1}`);
    }
    const tarballs = readdirSync(outputDir).filter(
      (entry) => entry.endsWith(".tgz") && !before.has(entry),
    );
    if (tarballs.length !== 1) {
      throw new Error(
        `expected npm pack to create one archive for ${packageJson.name}, found ${tarballs.length}`,
      );
    }
    return {
      name: packageJson.name,
      version: packageJson.version,
      tarball: join(outputDir, tarballs[0]),
    };
  });
}

export function rewriteWorkspaceDependencyVersions(packageJson, workspacePackages) {
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
        throw new Error(`root archive references unconfigured workspace dependency: ${name}`);
      }
      dependencies[name] = version;
      rewritten += 1;
    }
  }
  return rewritten;
}

function patchRootArchiveWorkspaceDependencies(rootArchive, workspacePackages, outputDir) {
  const unpackDir = join(outputDir, "root-archive");
  mkdirSync(unpackDir);
  runTar(["-xzf", rootArchive, "-C", unpackDir]);

  const packageJsonPath = join(unpackDir, "package", "package.json");
  const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  const rewritten = rewriteWorkspaceDependencyVersions(packageJson, workspacePackages);
  if (rewritten === 0) {
    return rootArchive;
  }

  writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  const patchedArchive = join(outputDir, "openclaw-root-patched.tgz");
  runTar(["-czf", patchedArchive, "-C", unpackDir, "package"]);
  return patchedArchive;
}

function main() {
  const args = process.argv.slice(2);
  const npm = process.env[REAL_NPM_ENV]?.trim() || "npm";
  const workspaceDirs = parseWorkspaceDependencyDirs();
  const npmEnv = resolveNpmEnvironment(args);
  const runtimePackPlan = resolveRuntimePackPlan(args);
  const runtimePackEnv = runtimePackPlan ? resolveRuntimePackEnvironment(npmEnv) : null;
  if (runtimePackPlan && runtimePackEnv && supportsPreparedRuntimePack(runtimePackEnv)) {
    // This adapter-only archive is installed into OCM and never published.
    // Standard npm pack still runs the full package build.
    try {
      prepareRuntimePack(runtimePackPlan.profile, runtimePackEnv);
      const result = runNpm(npm, runtimePackPlan.packArgs, {
        env: runtimePackEnv,
        stdio: "inherit",
      });
      return result.status ?? 1;
    } finally {
      restoreRuntimePack(runtimePackEnv);
    }
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
