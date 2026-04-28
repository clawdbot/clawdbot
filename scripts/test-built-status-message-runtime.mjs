import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parsePackageRootArg } from "./lib/package-root-args.mjs";

const STATUS_MESSAGE_RUNTIME_RE = /^status-message\.runtime(?:-[A-Za-z0-9_-]+)?\.js$/u;

const { packageRoot } = parsePackageRootArg(
  process.argv.slice(2),
  "OPENCLAW_STATUS_MESSAGE_RUNTIME_ROOT",
);

function findBuiltStatusMessageRuntimePath(distDir) {
  const candidates = fs
    .readdirSync(distDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && STATUS_MESSAGE_RUNTIME_RE.test(entry.name))
    .map((entry) => entry.name)
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
