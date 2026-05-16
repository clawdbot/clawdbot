import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parsePackageRootArg } from "./lib/package-root-args.mjs";

const STATUS_MESSAGE_RUNTIME_RE = /^status-message\.runtime(?:-[A-Za-z0-9_-]+)?\.js$/u;

export function findBuiltStatusMessageRuntimePath(distDir) {
  const candidates = listBuiltStatusMessageRuntimeFiles(distDir)
    .toSorted((left, right) => {
      const leftHasHash = left !== "status-message.runtime.js";
      const rightHasHash = right !== "status-message.runtime.js";
      if (leftHasHash !== rightHasHash) {
        return leftHasHash ? -1 : 1;
      }
      return left.localeCompare(right);
    });

  assert.ok(candidates.length > 0, `missing built status-message runtime bundle under ${distDir}`);

  return path.join(distDir, candidates[0]);
}

function listBuiltStatusMessageRuntimeFiles(distDir) {
  const externalFiles = listFindBuiltStatusMessageRuntimeFiles(distDir);
  if (externalFiles) {
    return externalFiles;
  }
  return fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && STATUS_MESSAGE_RUNTIME_RE.test(entry.name))
    .map((entry) => entry.name);
}

function listFindBuiltStatusMessageRuntimeFiles(distDir) {
  const result = spawnSync(
    "find",
    [distDir, "-maxdepth", "1", "-type", "f", "-name", "status-message.runtime*.js"],
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  if (result.status !== 0) {
    return null;
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((file) => path.basename(file))
    .filter((file) => STATUS_MESSAGE_RUNTIME_RE.test(file));
}

async function main() {
  const { packageRoot } = parsePackageRootArg(
    process.argv.slice(2),
    "OPENCLAW_STATUS_MESSAGE_RUNTIME_ROOT",
  );
  const runtimePath = findBuiltStatusMessageRuntimePath(path.join(packageRoot, "dist"));
  const runtimeModule = await import(pathToFileURL(runtimePath).href);

  assert.equal(
    typeof runtimeModule.loadStatusMessageRuntimeModule,
    "function",
    `built status-message runtime did not export loadStatusMessageRuntimeModule: ${runtimePath}`,
  );

  const statusModule = await runtimeModule.loadStatusMessageRuntimeModule();
  assert.equal(
    typeof statusModule.buildStatusMessage,
    "function",
    "status-message runtime did not load buildStatusMessage",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
