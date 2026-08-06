#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveDockerReleasePolicy } from "./lib/docker-release-policy.mjs";

const REGCTL_TIMEOUT_MS = 20 * 60_000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ARCHITECTURES = Object.freeze(["amd64", "arm64"]);
const VARIANTS = Object.freeze([{ suffix: "" }, { suffix: "-slim" }, { suffix: "-browser" }]);

function requireImageName(value, label) {
  const normalized = value?.trim();
  if (!normalized || /\s|@/.test(normalized) || /:[^/]+$/.test(normalized)) {
    throw new Error(`${label} must be an untagged container image name.`);
  }
  return normalized;
}

/** Build the immutable tag-copy plan for one Docker release. */
export function createVercelContainerRegistryPublishPlan({ version, sourceImage, targetImage }) {
  const policy = resolveDockerReleasePolicy(version);
  const source = requireImageName(sourceImage, "Source image");
  const target = requireImageName(targetImage, "Target image");
  const copies = [];
  const readinessTags = [];
  for (const { suffix } of VARIANTS) {
    const manifestTag = `${policy.version}${suffix}`;
    readinessTags.push(manifestTag);
    copies.push({
      sourceRef: `${source}:${manifestTag}`,
      targetRef: `${target}:${manifestTag}`,
      targetTag: manifestTag,
    });
    for (const architecture of ARCHITECTURES) {
      const architectureTag = `${manifestTag}-${architecture}`;
      copies.push({
        sourceRef: `${source}:${architectureTag}`,
        targetRef: `${target}:${architectureTag}`,
        targetTag: architectureTag,
      });
    }
  }
  return {
    channel: policy.channel,
    copies,
    readinessTags,
    sourceImage: source,
    targetImage: target,
    version: policy.version,
  };
}

function runRegctl(args, execFileSyncImpl, { inherit = false } = {}) {
  return execFileSyncImpl("regctl", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 20 * 1024 * 1024,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: REGCTL_TIMEOUT_MS,
  });
}

function inspectDigest(imageRef, execFileSyncImpl) {
  const digest = String(runRegctl(["image", "digest", imageRef], execFileSyncImpl)).trim();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`${imageRef} did not resolve to a valid sha256 digest.`);
  }
  return digest;
}

/** Copy every immutable release tag and verify byte-identical manifests. */
export function publishVercelContainerRegistryImages(params, options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const log = options.log ?? console.log;
  const plan = createVercelContainerRegistryPublishPlan(params);

  // Resolve the whole source set before the first registry write so a missing
  // architecture or browser image cannot leave an incomplete VCR release.
  const resolved = plan.copies.map((copy) => ({
    ...copy,
    sourceDigest: inspectDigest(copy.sourceRef, execFileSyncImpl),
  }));

  for (const copy of resolved) {
    const sourceDigestRef = `${plan.sourceImage}@${copy.sourceDigest}`;
    runRegctl(
      ["image", "copy", "--force-recursive", sourceDigestRef, copy.targetRef],
      execFileSyncImpl,
      { inherit: true },
    );
    const targetDigest = inspectDigest(copy.targetRef, execFileSyncImpl);
    if (targetDigest !== copy.sourceDigest) {
      throw new Error(
        `${copy.targetRef} resolved to ${targetDigest}, expected ${copy.sourceDigest}.`,
      );
    }
    log(`Verified ${copy.targetRef} -> ${copy.sourceDigest}.`);
  }
  return plan;
}

function printHelp() {
  console.log(
    "Usage: node scripts/vercel-container-registry-publish.mjs --version YYYY.M.P --source-image REGISTRY/IMAGE --target-image REGISTRY/IMAGE",
  );
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      "source-image": { type: "string" },
      "target-image": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });
  if (values.help) {
    printHelp();
    return;
  }
  if (!values.version || !values["source-image"] || !values["target-image"]) {
    throw new Error("--version, --source-image, and --target-image are required.");
  }
  const plan = publishVercelContainerRegistryImages({
    sourceImage: values["source-image"],
    targetImage: values["target-image"],
    version: values.version,
  });
  console.log(
    `Published ${plan.copies.length} immutable ${plan.channel} tags to ${plan.targetImage}.`,
  );
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    main();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`vercel-container-registry-publish: ${message}`);
    process.exitCode = 1;
  }
}
