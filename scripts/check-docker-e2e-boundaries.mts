#!/usr/bin/env node
// Cheap guard for Docker E2E test boundaries.
// Docker E2E must test packaged npm tarballs and package-installed images, not
// the source checkout copied or mounted as the app under test.
import fs from "node:fs";
import path from "node:path";
import packageJson from "../package.json" with { type: "json" };
import { laneResources, laneWeight } from "./lib/docker-e2e-plan.mts";
import {
  allReleasePathLanes,
  mainLanes,
  publicInstallerLanes,
  tailLanes,
} from "./lib/docker-e2e-scenarios.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
const ROOT_DIR = resolveRepoRoot(import.meta.url);
const errors: string[] = [];
const packageScripts = new Set(Object.keys(packageJson.scripts ?? {}));
// These lanes prove package-installed surfaces against live auth, so they
// intentionally need both live credentials and a package-backed image.
const livePackageBackedLanes = new Set([
  "install-e2e-anthropic",
  "install-e2e-openai",
  "live-codex-npm-plugin",
  "live-mcp-code-mode-gateway",
  "live-plugin-tool",
  "npm-telegram-live",
  "openai-chat-tools",
  "openwebui",
]);
// These lanes intentionally build a focused source-checkout image instead of
// consuming the shared package E2E images.
const sourceCheckoutImageLanes = new Set([
  "docker-selected-plugins",
  "plugin-binding-command-escape",
]);

function readText(relativePath: string) {
  return fs.readFileSync(path.join(ROOT_DIR, relativePath), "utf8");
}

function walk(dir: string, out: string[] = []) {
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

function findRelativeModuleSpecifiers(text: string) {
  const specifiers = new Set<string>();
  for (const pattern of [
    /(?:\bfrom\s*|\bimport\s*\()\s*["']([^"']+)["']/gu,
    /\bimport\s*["']([^"']+)["']/gu,
  ]) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier?.startsWith(".")) {
        specifiers.add(specifier);
      }
    }
  }
  return [...specifiers];
}

function isPathWithin(parent: string, candidate: string) {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && !relative.startsWith(`..${path.sep}`) && relative !== "..")
  );
}

for (const relativePath of walk("scripts/e2e")) {
  if (!/\.(?:sh|ts|mjs|js)$/u.test(relativePath)) {
    continue;
  }
  const text = readText(relativePath);
  const sourceImport = findRelativeModuleSpecifiers(text).find((specifier) => {
    const resolved = path.resolve(ROOT_DIR, path.dirname(relativePath), specifier);
    return isPathWithin(path.join(ROOT_DIR, "src"), resolved);
  });
  if (sourceImport) {
    errors.push(
      `${relativePath}: Docker E2E harness must import package exports, not ${sourceImport}`,
    );
  }
  if (/-v\s+["']?\$ROOT_DIR:\/app(?::|["'\s]|$)/u.test(text)) {
    errors.push(`${relativePath}: do not mount the repo root as /app in Docker E2E`);
  }
}

const dockerfile = readText("scripts/e2e/Dockerfile");
if (/^\s*(?:COPY|ADD)\s+\.\s+\/app(?:\s|$)/imu.test(dockerfile)) {
  errors.push("scripts/e2e/Dockerfile: do not copy the source checkout into /app");
}

function validateUniqueLanes(label: string, lanes: readonly (typeof mainLanes)[number][]) {
  const seen = new Set<string>();
  for (const lane of lanes) {
    if (seen.has(lane.name)) {
      errors.push(`${label}: duplicate Docker E2E lane '${lane.name}'`);
    }
    seen.add(lane.name);
  }
}

function validateLane(label: string, lane: (typeof mainLanes)[number]) {
  const resources = laneResources(lane);
  const sourceCheckoutImageLane = sourceCheckoutImageLanes.has(lane.name);
  if (!lane.name || typeof lane.name !== "string") {
    errors.push(`${label}: Docker E2E lane is missing a string name`);
  }
  if (!lane.command || typeof lane.command !== "string") {
    errors.push(`${label}: Docker E2E lane '${lane.name}' is missing a string command`);
    return;
  }
  if (lane.e2eImageKind && lane.e2eImageKind !== "bare" && lane.e2eImageKind !== "functional") {
    const invalidImageKind =
      typeof lane.e2eImageKind === "string"
        ? lane.e2eImageKind
        : (JSON.stringify(lane.e2eImageKind) ?? "<invalid>");
    errors.push(
      `${label}: Docker E2E lane '${lane.name}' has invalid image kind '${invalidImageKind}'`,
    );
  }
  if (lane.live && lane.e2eImageKind && !livePackageBackedLanes.has(lane.name)) {
    errors.push(`${label}: live Docker E2E lane '${lane.name}' must not require a package image`);
  }
  if (!lane.live && !lane.e2eImageKind && !sourceCheckoutImageLane) {
    errors.push(`${label}: package Docker E2E lane '${lane.name}' must declare an e2e image kind`);
  }
  if (sourceCheckoutImageLane && !/\bOPENCLAW_SKIP_DOCKER_BUILD=0\b/u.test(lane.command)) {
    errors.push(
      `${label}: source-checkout Docker E2E lane '${lane.name}' must force a local image build`,
    );
  }
  if (laneWeight(lane) < 1) {
    errors.push(`${label}: Docker E2E lane '${lane.name}' must have positive weight`);
  }
  if (!resources.includes("docker")) {
    errors.push(`${label}: Docker E2E lane '${lane.name}' must include the docker resource`);
  }

  for (const match of lane.command.matchAll(/\bpnpm\s+([^\s]+)/gu)) {
    const script = match[1];
    if (script && !packageScripts.has(script)) {
      errors.push(
        `${label}: Docker E2E lane '${lane.name}' references missing package script '${script}'`,
      );
    }
  }
}

const releasePathLanes = allReleasePathLanes({ includeOpenWebUI: true });
for (const [label, lanes] of [
  ["release-path", releasePathLanes],
  ["public-installer", publicInstallerLanes],
  ["main", mainLanes],
  ["tail", tailLanes],
] as const) {
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
