#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const WORKSPACE_DIRS_ENV = "OPENCLAW_OCM_WORKSPACE_DEPENDENCY_DIRS";
const REAL_NPM_ENV = "OPENCLAW_OCM_REAL_NPM_BIN";
const ALLOW_UNRELEASED_CHANGELOG_ENV = "OPENCLAW_PREPACK_ALLOW_UNRELEASED_CHANGELOG";

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
    [ALLOW_UNRELEASED_CHANGELOG_ENV]: "1",
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
  const plan = resolveWorkspaceInstallPlan(args, workspaceDirs);
  if (!plan) {
    const result = runNpm(npm, args, {
      env: resolveNpmEnvironment(args),
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
