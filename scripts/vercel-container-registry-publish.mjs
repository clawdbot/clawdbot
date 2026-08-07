#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveDockerReleasePolicy } from "./lib/docker-release-policy.mjs";

const IMAGETOOLS_TIMEOUT_MS = 20 * 60_000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IMAGE_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const IMAGE_MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
]);
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

function runImagetools(args, execFileSyncImpl, { inherit = false } = {}) {
  return execFileSyncImpl("docker", ["buildx", "imagetools", ...args], {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 20 * 1024 * 1024,
    stdio: inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    timeout: IMAGETOOLS_TIMEOUT_MS,
  });
}

function requireDigest(value, imageRef) {
  const digest = String(value ?? "").trim();
  if (!DIGEST_PATTERN.test(digest)) {
    throw new Error(`${imageRef} did not resolve to a valid sha256 digest.`);
  }
  return digest;
}

function inspectRawManifest(imageRef, execFileSyncImpl) {
  const raw = String(runImagetools(["inspect", imageRef, "--raw"], execFileSyncImpl));
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`${imageRef} did not return valid manifest JSON.`);
  }
}

function inspectManifestDescriptor(imageRef, execFileSyncImpl) {
  const raw = String(
    runImagetools(["inspect", imageRef, "--format", "{{json .Manifest}}"], execFileSyncImpl),
  );
  try {
    const descriptor = JSON.parse(raw);
    return {
      digest: requireDigest(descriptor.digest, imageRef),
      mediaType: descriptor.mediaType,
    };
  } catch (error) {
    if (error instanceof Error && error.message.includes("sha256 digest")) {
      throw error;
    }
    throw new Error(`${imageRef} did not return a valid manifest descriptor.`, { cause: error });
  }
}

function resolvePlatformDigests(imageRef, execFileSyncImpl, architectures) {
  const manifest = inspectRawManifest(imageRef, execFileSyncImpl);
  if (manifest.mediaType !== IMAGE_INDEX_MEDIA_TYPE || !Array.isArray(manifest.manifests)) {
    throw new Error(`${imageRef} must resolve to an OCI image index.`);
  }
  return Object.fromEntries(
    architectures.map((architecture) => {
      const matches = manifest.manifests.filter(
        (entry) =>
          entry?.platform?.os === "linux" &&
          entry.platform.architecture === architecture &&
          IMAGE_MANIFEST_MEDIA_TYPES.has(entry.mediaType),
      );
      if (matches.length !== 1) {
        throw new Error(
          `${imageRef} must contain exactly one linux/${architecture} image manifest; found ${matches.length}.`,
        );
      }
      return [architecture, requireDigest(matches[0].digest, imageRef)];
    }),
  );
}

function verifyCleanIndex(imageRef, expectedDigests, execFileSyncImpl) {
  const manifest = inspectRawManifest(imageRef, execFileSyncImpl);
  if (manifest.mediaType !== IMAGE_INDEX_MEDIA_TYPE || !Array.isArray(manifest.manifests)) {
    throw new Error(`${imageRef} must resolve to a clean OCI image index.`);
  }
  if (manifest.manifests.length !== ARCHITECTURES.length) {
    throw new Error(
      `${imageRef} must contain exactly ${ARCHITECTURES.length} platform manifests; found ${manifest.manifests.length}.`,
    );
  }
  for (const architecture of ARCHITECTURES) {
    const matches = manifest.manifests.filter(
      (entry) => entry?.platform?.os === "linux" && entry.platform.architecture === architecture,
    );
    if (matches.length !== 1) {
      throw new Error(
        `${imageRef} must contain exactly one linux/${architecture} manifest; found ${matches.length}.`,
      );
    }
    const digest = requireDigest(matches[0].digest, imageRef);
    if (digest !== expectedDigests[architecture]) {
      throw new Error(
        `${imageRef} linux/${architecture} resolved to ${digest}, expected ${expectedDigests[architecture]}.`,
      );
    }
  }
}

/** Publish every immutable release tag with byte-identical platform manifests. */
export function publishVercelContainerRegistryImages(params, options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const log = options.log ?? console.log;
  const plan = createVercelContainerRegistryPublishPlan(params);

  // Docker release indexes also contain provenance attestation manifests with
  // unknown/unknown platforms. VCR stores those indexes but does not prepare
  // them for Sandbox, so publish a clean amd64+arm64 index from the exact image
  // manifest digests and keep the architecture tags as carbon-copy manifests.
  const variants = VARIANTS.map(({ suffix }) => {
    const manifestTag = `${plan.version}${suffix}`;
    const manifestSourceRef = `${plan.sourceImage}:${manifestTag}`;
    const platformDigests = resolvePlatformDigests(
      manifestSourceRef,
      execFileSyncImpl,
      ARCHITECTURES,
    );
    for (const architecture of ARCHITECTURES) {
      const architectureSourceRef = `${plan.sourceImage}:${manifestTag}-${architecture}`;
      const architectureDigests = resolvePlatformDigests(architectureSourceRef, execFileSyncImpl, [
        architecture,
      ]);
      if (architectureDigests[architecture] !== platformDigests[architecture]) {
        throw new Error(
          `${architectureSourceRef} resolved to ${architectureDigests[architecture]}, expected ${platformDigests[architecture]} from ${manifestSourceRef}.`,
        );
      }
    }
    return { manifestTag, platformDigests };
  });

  for (const { manifestTag, platformDigests } of variants) {
    const manifestTargetRef = `${plan.targetImage}:${manifestTag}`;
    const platformSourceRefs = ARCHITECTURES.map(
      (architecture) => `${plan.sourceImage}@${platformDigests[architecture]}`,
    );
    runImagetools(
      ["create", "--progress", "plain", "--tag", manifestTargetRef, ...platformSourceRefs],
      execFileSyncImpl,
      { inherit: true },
    );
    verifyCleanIndex(manifestTargetRef, platformDigests, execFileSyncImpl);
    log(`Verified ${manifestTargetRef} as a clean linux/amd64+linux/arm64 index.`);

    for (const architecture of ARCHITECTURES) {
      const targetRef = `${plan.targetImage}:${manifestTag}-${architecture}`;
      const sourceDigest = platformDigests[architecture];
      runImagetools(
        [
          "create",
          "--progress",
          "plain",
          "--prefer-index=false",
          "--tag",
          targetRef,
          `${plan.sourceImage}@${sourceDigest}`,
        ],
        execFileSyncImpl,
        { inherit: true },
      );
      const descriptor = inspectManifestDescriptor(targetRef, execFileSyncImpl);
      if (!IMAGE_MANIFEST_MEDIA_TYPES.has(descriptor.mediaType)) {
        throw new Error(
          `${targetRef} must resolve to an image manifest, got ${descriptor.mediaType}.`,
        );
      }
      if (descriptor.digest !== sourceDigest) {
        throw new Error(`${targetRef} resolved to ${descriptor.digest}, expected ${sourceDigest}.`);
      }
      log(`Verified ${targetRef} -> ${sourceDigest}.`);
    }
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
