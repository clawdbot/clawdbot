#!/usr/bin/env node
// Prepares package-derived Docker E2E fixtures for git-style npm installs.
import fs from "node:fs";
import path from "node:path";
import { PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH } from "../../lib/package-lifecycle-marker.mjs";

const [command, rootArg] = process.argv.slice(2);

function usage() {
  console.error("usage: package-git-fixture.mjs prepare <fixture-root>");
  process.exit(2);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function withoutAiRuntimeDependency(value) {
  if (!Array.isArray(value)) {
    return value;
  }
  const next = value.filter((entry) => entry !== "@openclaw/ai");
  return next.length > 0 ? next : undefined;
}

function ensureDependencyIgnores(root) {
  const gitignorePath = path.join(root, ".gitignore");
  const existing = fs.existsSync(gitignorePath) ? fs.readFileSync(gitignorePath, "utf8") : "";
  const lines = new Set(existing.split(/\r?\n/u));
  const required = [
    "node_modules",
    "**/node_modules/",
    "pnpm-lock.yaml",
    // Runtime promotion stages destination siblings before its final clean check.
    "*.openclaw-update-*.tmp/",
    PACKAGE_LIFECYCLE_PENDING_RELATIVE_PATH,
  ];
  const missing = required.filter((entry) => !lines.has(entry));
  if (missing.length === 0) {
    return;
  }
  const prefix = existing.length === 0 || existing.endsWith("\n") ? existing : `${existing}\n`;
  fs.writeFileSync(gitignorePath, `${prefix}${missing.join("\n")}\n`);
}

function prepare(root) {
  ensureDependencyIgnores(root);
  // Preserve source-checkout identity through preflight clones and global links;
  // packaged postinstall cleanup would otherwise delete the fixture's build stamps.
  for (const directory of ["src", "extensions"]) {
    fs.mkdirSync(path.join(root, directory), { recursive: true });
    fs.writeFileSync(path.join(root, directory, ".gitkeep"), "");
  }
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = readJson(packageJsonPath);
  // npm still resolves omitted dev dependencies; this fixture runs the packed runtime.
  delete packageJson.devDependencies;
  packageJson.scripts = {
    ...packageJson.scripts,
    openclaw: "node openclaw.mjs",
  };
  delete packageJson.scripts.postinstall;
  const aiRuntimeSource = path.join(root, "node_modules", "@openclaw", "ai");
  const aiRuntimePackageJson = path.join(aiRuntimeSource, "package.json");
  if (!fs.existsSync(aiRuntimePackageJson)) {
    writeJson(packageJsonPath, packageJson);
    return;
  }

  const aiRuntimeTarget = path.join(root, ".openclaw-fixture", "packages", "ai");
  fs.rmSync(aiRuntimeTarget, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(aiRuntimeTarget), { recursive: true });
  fs.renameSync(aiRuntimeSource, aiRuntimeTarget);
  const relocatedAiRuntimePackageJson = path.join(aiRuntimeTarget, "package.json");
  const relocatedAiRuntimePackage = readJson(relocatedAiRuntimePackageJson);
  delete relocatedAiRuntimePackage.devDependencies;
  writeJson(relocatedAiRuntimePackageJson, relocatedAiRuntimePackage);

  packageJson.dependencies ??= {};
  packageJson.dependencies["@openclaw/ai"] = "file:.openclaw-fixture/packages/ai";
  packageJson.bundleDependencies = withoutAiRuntimeDependency(packageJson.bundleDependencies);
  packageJson.bundledDependencies = withoutAiRuntimeDependency(packageJson.bundledDependencies);
  if (packageJson.bundleDependencies === undefined) {
    delete packageJson.bundleDependencies;
  }
  if (packageJson.bundledDependencies === undefined) {
    delete packageJson.bundledDependencies;
  }
  writeJson(packageJsonPath, packageJson);
}

if (command !== "prepare" || !rootArg) {
  usage();
}

prepare(path.resolve(rootArg));
