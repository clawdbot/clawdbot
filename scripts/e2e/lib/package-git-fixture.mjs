#!/usr/bin/env node
// Prepares package-derived Docker E2E fixtures for git-style npm installs.
import fs from "node:fs";
import path from "node:path";

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

function prepare(root) {
  const packageJsonPath = path.join(root, "package.json");
  const packageJson = readJson(packageJsonPath);
  const aiRuntimeSource = path.join(root, "node_modules", "@openclaw", "ai");
  const aiRuntimePackageJson = path.join(aiRuntimeSource, "package.json");
  if (!fs.existsSync(aiRuntimePackageJson)) {
    return;
  }

  const aiRuntimeTarget = path.join(root, ".openclaw-fixture", "packages", "ai");
  fs.rmSync(aiRuntimeTarget, { force: true, recursive: true });
  fs.mkdirSync(path.dirname(aiRuntimeTarget), { recursive: true });
  fs.renameSync(aiRuntimeSource, aiRuntimeTarget);

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

  // The shipped shrinkwrap points at the published package graph. This fixture is
  // intentionally local-git shaped, so let npm resolve the staged file dependency.
  fs.rmSync(path.join(root, "npm-shrinkwrap.json"), { force: true });
}

if (command !== "prepare" || !rootArg) {
  usage();
}

prepare(path.resolve(rootArg));
