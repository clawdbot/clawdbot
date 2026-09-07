#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const LEGACY_UPDATE_COMPAT_CHUNKS = [
  "shared-DTaQo6Hi.js",
  "shared-Y6bNiw2w.js",
  "shared-DFJEouXv.js",
];
export const FUTURE_FIXTURE_VERSION = "2026.9.99-first-hop.0";

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function resolveFixturePaths(packageRoot) {
  const root = path.resolve(packageRoot);
  const packageJson = path.join(root, "package.json");
  const buildInfo = path.join(root, "dist", "build-info.json");
  const inventory = path.join(root, "dist", "postinstall-inventory.json");
  for (const filePath of [packageJson, buildInfo, inventory]) {
    if (!fs.statSync(filePath).isFile()) {
      throw new Error(`missing package fixture input: ${filePath}`);
    }
  }
  return { root, packageJson, buildInfo, inventory };
}

export function removeLegacyUpdateCompatChunks(packageRoot) {
  const paths = resolveFixturePaths(packageRoot);
  const inventory = readJson(paths.inventory);
  if (!Array.isArray(inventory) || inventory.some((entry) => typeof entry !== "string")) {
    throw new Error("package fixture inventory is not a string array");
  }

  const removed = [];
  for (const name of LEGACY_UPDATE_COMPAT_CHUNKS) {
    const relativePath = `dist/${name}`;
    const filePath = path.join(paths.root, relativePath);
    if (!fs.existsSync(filePath) || !inventory.includes(relativePath)) {
      throw new Error(`package fixture is missing compatibility input: ${relativePath}`);
    }
    fs.rmSync(filePath);
    removed.push(relativePath);
  }
  writeJson(
    paths.inventory,
    inventory.filter((entry) => !removed.includes(entry)),
  );
}

function futureFixtureVersion(sequence) {
  if (!Number.isSafeInteger(sequence) || sequence < 0 || sequence > 9) {
    throw new Error("future fixture sequence must be an integer from 0 to 9");
  }
  return FUTURE_FIXTURE_VERSION.replace(/0$/, String(sequence));
}

export function markFutureUpdateFixture(packageRoot, sequence = 0) {
  const version = futureFixtureVersion(sequence);
  removeLegacyUpdateCompatChunks(packageRoot);
  const paths = resolveFixturePaths(packageRoot);
  const packageJson = readJson(paths.packageJson);
  const buildInfo = readJson(paths.buildInfo);
  packageJson.version = version;
  buildInfo.version = version;
  // The unchanged compiled UI still carries the prepared artifact's opaque build ID.
  writeJson(paths.packageJson, packageJson);
  writeJson(paths.buildInfo, buildInfo);
}

function packTransformedFixture(candidateTarball, outputTarball, transform) {
  const source = path.resolve(candidateTarball);
  const output = path.resolve(outputTarball);
  if (source === output || fs.existsSync(output)) {
    throw new Error("future fixture output must be a new tarball path");
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "openclaw-future-update-"));
  try {
    execFileSync("tar", ["-xzf", source, "-C", root]);
    const packageRoot = path.join(root, "package");
    const sourceVersion = readJson(path.join(packageRoot, "package.json")).version;
    transform(packageRoot);
    execFileSync("tar", ["-czf", output, "-C", root, "package"], {
      env: { ...process.env, COPYFILE_DISABLE: "1" },
    });
    return {
      sourceVersion,
      targetVersion: readJson(path.join(packageRoot, "package.json")).version,
      sourceSha256: createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
      targetSha256: createHash("sha256").update(fs.readFileSync(output)).digest("hex"),
    };
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

export function packFutureUpdateFixture(candidateTarball, outputTarball, sequence = 0) {
  return {
    method: "candidate-same-schema-self-update-fixture",
    ...packTransformedFixture(candidateTarball, outputTarball, (root) => {
      markFutureUpdateFixture(root, sequence);
    }),
  };
}

function packFutureRuntimeFixture(candidateTarball, outputTarball, sequence = 0) {
  const version = futureFixtureVersion(sequence);
  return {
    method: "candidate-same-schema-runtime-fixture",
    name: "@openclaw/codex",
    ...packTransformedFixture(candidateTarball, outputTarball, (root) => {
      const manifestPath = path.join(root, "package.json");
      const manifest = readJson(manifestPath);
      if (manifest.name !== "@openclaw/codex") {
        throw new Error("future runtime fixture requires the @openclaw/codex package");
      }
      if (
        typeof manifest.version !== "string" ||
        !/^\d{4}\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[a-z0-9]+(?:[.-][a-z0-9]+)*)?$/iu.test(
          manifest.version,
        ) ||
        manifest.openclaw?.build?.openclawVersion !== manifest.version
      ) {
        throw new Error("runtime package version and OpenClaw build cohort must match");
      }
      manifest.version = version;
      manifest.openclaw.build.openclawVersion = version;
      writeJson(manifestPath, manifest);
    }),
  };
}

function main() {
  const [mode, packageRoot, outputTarball, sequence] = process.argv.slice(2);
  if (
    (mode === "future-tarball" || mode === "future-runtime-tarball") &&
    packageRoot &&
    outputTarball
  ) {
    const pack = mode === "future-tarball" ? packFutureUpdateFixture : packFutureRuntimeFixture;
    process.stdout.write(
      `${JSON.stringify(pack(packageRoot, outputTarball, sequence === undefined ? 0 : Number(sequence)), null, 2)}\n`,
    );
    return;
  }
  if (!packageRoot || (mode !== "negative" && mode !== "future")) {
    throw new Error(
      "usage: update-first-hop-package-fixtures.mjs <negative|future> <package-root> OR <future-tarball|future-runtime-tarball> <source.tgz> <new-output.tgz> [sequence0–9]",
    );
  }
  if (mode === "negative") {
    removeLegacyUpdateCompatChunks(packageRoot);
  } else {
    markFutureUpdateFixture(packageRoot);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main();
}
