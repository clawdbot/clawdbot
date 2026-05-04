#!/usr/bin/env node
// Cheap guard for Docker E2E test boundaries.
// Docker E2E must test packaged npm tarballs and package-installed images, not
// the source checkout copied or mounted as the app under test.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { laneResources, laneWeight } from "./lib/docker-e2e-plan.mjs";
import { allReleasePathLanes, mainLanes, tailLanes } from "./lib/docker-e2e-scenarios.mjs";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const errors = [];
const packageJson = JSON.parse(readText("package.json"));
const packageScripts = new Set(Object.keys(packageJson.scripts ?? {}));
// These lanes prove package-installed surfaces against live auth, so they
// intentionally need both live credentials and a package-backed image.
const livePackageBackedLanes = new Set(["live-codex-npm-plugin", "openwebui"]);

function readText(relativePath) {
  return fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8");
}

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(path.join(ROOT_DIR, dir), { withFileTypes: true })) {
    const relativePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(relativePath, out);
    } else {
      out.push(relativePath);
    }
  }
  return out;
}

for (const relativePath of walk("scripts/e2e")) {
  if (!/\.(?:sh|ts|mjs|js)$/u.test(relativePath)) {
    continue;
  }
  const text = readText(relativePath);
  if (/from\s+["']\.\.\/\.\.\/src\//u.test(text) || /import\(["']\.\.\/\.\.\/src\//u.test(text)) {
    errors.push(`${relativePath}: Docker E2E harness must import built dist, not ../../src`);
  }
  if (/-v\s+["']?\$ROOT_DIR:\/app(?::|["'\s]|$)/u.test(text)) {
    errors.push(`${relativePath}: do not mount the repo root as /app in Docker E2E`);
  }
}

const dockerfile = readText("scripts/e2e/Dockerfile");
if (/^\s*(?:COPY|ADD)\s+\.\s+\/app(?:\s|$)/imu.test(dockerfile)) {
  errors.push("scripts/e2e/Dockerfile: do not copy the source checkout into /app");
}

function validateUniqueLanes(label, lanes) {
  const seen = new Set();
  for (const lane of lanes) {
    if (seen.has(lane.name)) {
      errors.push(`${label}: duplicate Docker E2E lane '${lane.name}'`);
    }
    seen.add(lane.name);
  }
}

function validateLane(label, lane) {
  const resources = laneResources(lane);
  if (!lane.name || typeof lane.name !== "string") {
    errors.push(`${label}: Docker E2E lane is missing a string name`);
  }
  if (!lane.command || typeof lane.command !== "string") {
    errors.push(`${label}: Docker E2E lane '${lane.name}' is missing a string command`);
    return;
  }
  if (lane.e2eImageKind && lane.e2eImageKind !== "bare" && lane.e2eImageKind !== "functional") {
    errors.push(
      `${label}: Docker E2E lane '${lane.name}' has invalid image kind '${lane.e2eImageKind}'`,
    );
  }
  if (lane.live && lane.e2eImageKind && !livePackageBackedLanes.has(lane.name)) {
    errors.push(`${label}: live Docker E2E lane '${lane.name}' must not require a package image`);
  }
  if (!lane.live && !lane.e2eImageKind) {
    errors.push(`${label}: package Docker E2E lane '${lane.name}' must declare an e2e image kind`);
  }
  if (laneWeight(lane) < 1) {
    errors.push(`${label}: Docker E2E lane '${lane.name}' must have positive weight`);
  }
  if (!resources.includes("docker")) {
    errors.push(`${label}: Docker E2E lane '${lane.name}' must include the docker resource`);
  }

  for (const match of lane.command.matchAll(/\bpnpm\s+([^\s]+)/gu)) {
    const script = match[1];
    if (!packageScripts.has(script)) {
      errors.push(
        `${label}: Docker E2E lane '${lane.name}' references missing package script '${script}'`,
      );
    }
  }
}

const releasePathLanes = allReleasePathLanes({ includeOpenWebUI: true });
for (const [label, lanes] of [
  ["release-path", releasePathLanes],
  ["main", mainLanes],
  ["tail", tailLanes],
]) {
  validateUniqueLanes(label, lanes);
  for (const lane of lanes) {
    validateLane(label, lane);
  }
}

if (errors.length > 0) {
  console.error(errors.join("\n"));
  process.exit(1);
}

console.log("Docker E2E package boundary/catalog guard passed.");
