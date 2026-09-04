#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { isMissingManifestError } from "./lib/docker-manifest-error.mjs";
import { resolveDockerReleasePolicy } from "./lib/docker-release-policy.mjs";
import { compareReleaseVersions } from "./lib/release-version.mjs";
import { verifyDockerAttestations } from "./verify-docker-attestations.mjs";

const IMAGETOOLS_TIMEOUT_MS = 20 * 60_000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IMAGE_INDEX_MEDIA_TYPE = "application/vnd.oci.image.index.v1+json";
const IMAGE_MANIFEST_MEDIA_TYPES = new Set([
  "application/vnd.docker.distribution.manifest.v2+json",
  "application/vnd.oci.image.manifest.v1+json",
]);
const ARCHITECTURES = Object.freeze(["amd64", "arm64"]);
const VARIANTS = Object.freeze([
  { aliasKey: "default", suffix: "" },
  { aliasKey: "slim", suffix: "-slim" },
  { aliasKey: "browser", suffix: "-browser" },
]);

function resolveVariants(includeBrowser) {
  if (typeof includeBrowser !== "boolean") {
    throw new Error("includeBrowser must be a boolean.");
  }
  return includeBrowser ? VARIANTS : VARIANTS.filter(({ aliasKey }) => aliasKey !== "browser");
}

function requireImageName(value, label) {
  const normalized = value?.trim();
  if (!normalized || /\s|@/.test(normalized) || /:[^/]+$/.test(normalized)) {
    throw new Error(`${label} must be an untagged container image name.`);
  }
  return normalized;
}

/** Build the immutable tag-copy plan for one Docker release. */
export function createVercelContainerRegistryPublishPlan({
  includeBrowser,
  version,
  sourceImage,
  targetImage,
}) {
  const policy = resolveDockerReleasePolicy(version);
  const source = requireImageName(sourceImage, "Source image");
  const target = requireImageName(targetImage, "Target image");
  const variants = resolveVariants(includeBrowser);
  const copies = [];
  const readinessTags = [];
  for (const { suffix } of variants) {
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

function parseImmutableSourceRefs(values, includeBrowser) {
  if (!Array.isArray(values)) {
    throw new Error("sourceRefs must be an array of alias=immutable-ref entries.");
  }
  const variants = resolveVariants(includeBrowser);
  const expectedAliases = new Set(variants.map(({ aliasKey }) => aliasKey));
  const byAlias = new Map();
  let sourceImage;

  for (const value of values) {
    const separator = value.indexOf("=");
    const aliasKey = value.slice(0, separator).trim();
    const immutableRef = value.slice(separator + 1).trim();
    if (separator <= 0 || !expectedAliases.has(aliasKey)) {
      throw new Error(`Unexpected VCR source alias in ${JSON.stringify(value)}.`);
    }
    if (byAlias.has(aliasKey)) {
      throw new Error(`Duplicate VCR source alias: ${aliasKey}.`);
    }

    const atIndex = immutableRef.lastIndexOf("@");
    const image = requireImageName(immutableRef.slice(0, atIndex), `${aliasKey} source image`);
    const digest = requireDigest(immutableRef.slice(atIndex + 1), immutableRef);
    const normalizedRef = `${image}@${digest}`;
    if (sourceImage && sourceImage !== image) {
      throw new Error(`All immutable VCR source refs must use ${sourceImage}; got ${image}.`);
    }
    sourceImage = image;
    byAlias.set(aliasKey, normalizedRef);
  }

  for (const aliasKey of expectedAliases) {
    if (!byAlias.has(aliasKey)) {
      throw new Error(`Missing immutable VCR source ref for ${aliasKey}.`);
    }
  }
  if (!sourceImage) {
    throw new Error("At least one immutable VCR source ref is required.");
  }
  return { byAlias, sourceImage };
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

function inspectImageVersion(imageRef, execFileSyncImpl, { allowMissing = false } = {}) {
  const versions = new Map();
  for (const [index, architecture] of ARCHITECTURES.entries()) {
    const platform = `linux/${architecture}`;
    let raw;
    try {
      raw = runImagetools(
        ["inspect", imageRef, "--format", `{{json (index .Image "${platform}")}}`],
        execFileSyncImpl,
      );
    } catch (error) {
      if (allowMissing && index === 0 && isMissingManifestError(error, imageRef)) {
        return null;
      }
      throw error;
    }
    let version;
    try {
      version = JSON.parse(raw)?.config?.Labels?.["org.opencontainers.image.version"];
    } catch (error) {
      throw new Error(`Could not parse the ${platform} image config for ${imageRef}.`, {
        cause: error,
      });
    }
    if (typeof version !== "string" || version.trim().length === 0) {
      throw new Error(
        `${imageRef} does not have an org.opencontainers.image.version label for ${platform}.`,
      );
    }
    versions.set(platform, version.trim());
  }
  const uniqueVersions = new Set(versions.values());
  if (uniqueVersions.size !== 1) {
    const details = [...versions].map(([platform, version]) => `${platform}=${version}`).join(", ");
    throw new Error(`${imageRef} has inconsistent platform versions: ${details}.`);
  }
  return uniqueVersions.values().next().value;
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
  const immutableSources = parseImmutableSourceRefs(params.sourceRefs, params.includeBrowser);
  const plan = createVercelContainerRegistryPublishPlan({
    includeBrowser: params.includeBrowser,
    sourceImage: immutableSources.sourceImage,
    targetImage: params.targetImage,
    version: params.version,
  });
  const selectedVariants = resolveVariants(params.includeBrowser);

  // Docker release indexes also contain provenance attestation manifests with
  // unknown/unknown platforms. VCR stores those indexes but does not prepare
  // them for Sandbox, so publish a clean amd64+arm64 index from the exact image
  // manifest digests and keep the architecture tags as carbon-copy manifests.
  // Verify every immutable source here because recovery callers supply digests
  // directly; producer-side verification alone does not protect that boundary.
  verifyDockerAttestations({
    execFileSyncImpl,
    imageRefs: selectedVariants.map(({ aliasKey }) => immutableSources.byAlias.get(aliasKey)),
    log,
    requiredPlatforms: ARCHITECTURES.map((architecture) => ({ architecture, os: "linux" })),
  });
  const variants = selectedVariants.map(({ aliasKey, suffix }) => {
    const manifestTag = `${plan.version}${suffix}`;
    const manifestSourceRef = immutableSources.byAlias.get(aliasKey);
    const sourceVersion = inspectImageVersion(manifestSourceRef, execFileSyncImpl);
    if (sourceVersion !== plan.version) {
      throw new Error(
        `${manifestSourceRef} reports version ${sourceVersion}, expected ${plan.version}.`,
      );
    }
    const platformDigests = resolvePlatformDigests(
      manifestSourceRef,
      execFileSyncImpl,
      ARCHITECTURES,
    );
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
    const manifestDescriptor = inspectManifestDescriptor(manifestTargetRef, execFileSyncImpl);
    if (manifestDescriptor.mediaType !== IMAGE_INDEX_MEDIA_TYPE) {
      throw new Error(
        `${manifestTargetRef} must resolve to an OCI image index, got ${manifestDescriptor.mediaType}.`,
      );
    }
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

/** Promote moving aliases only after Sandbox proves the immutable image is ready. */
export function promoteVercelContainerRegistryAliases(params, options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const log = options.log ?? console.log;
  const policy = resolveDockerReleasePolicy(params.version);
  const targetImage = requireImageName(params.targetImage, "Target image");
  const publishedVariants = resolveVariants(params.includeBrowser).map(({ aliasKey, suffix }) => {
    const manifestTag = `${policy.version}${suffix}`;
    const manifestTargetRef = `${targetImage}:${manifestTag}`;
    const platformDigests = resolvePlatformDigests(
      manifestTargetRef,
      execFileSyncImpl,
      ARCHITECTURES,
    );
    verifyCleanIndex(manifestTargetRef, platformDigests, execFileSyncImpl);
    const manifestDescriptor = inspectManifestDescriptor(manifestTargetRef, execFileSyncImpl);
    if (manifestDescriptor.mediaType !== IMAGE_INDEX_MEDIA_TYPE) {
      throw new Error(
        `${manifestTargetRef} must resolve to an OCI image index, got ${manifestDescriptor.mediaType}.`,
      );
    }
    return { aliasKey, manifestDigest: manifestDescriptor.digest, manifestTag };
  });

  // VCR owns a separate release-wide concurrency group, so these read-then-write
  // alias updates cannot race a newer release without holding the Docker lock.
  const promotions = publishedVariants.flatMap(({ aliasKey, manifestDigest, manifestTag }) => {
    const targetRefs = policy.movingAliases[aliasKey].map((alias) => `${targetImage}:${alias}`);
    return targetRefs.length === 0 ? [] : [{ manifestDigest, manifestTag, targetRefs }];
  });

  // Preflight every clean source and existing alias before the first moving-tag
  // write so an out-of-order retry cannot partially roll a channel backward.
  for (const { manifestDigest, targetRefs } of promotions) {
    const sourceDigestRef = `${targetImage}@${manifestDigest}`;
    const sourceVersion = inspectImageVersion(sourceDigestRef, execFileSyncImpl);
    if (sourceVersion !== policy.version) {
      throw new Error(
        `${sourceDigestRef} reports version ${sourceVersion}, expected ${policy.version}.`,
      );
    }
    for (const targetRef of targetRefs) {
      const currentVersion = inspectImageVersion(targetRef, execFileSyncImpl, {
        allowMissing: true,
      });
      if (currentVersion === null) {
        continue;
      }
      const comparison = compareReleaseVersions(policy.version, currentVersion);
      if (comparison === null) {
        throw new Error(
          `Cannot compare candidate version ${policy.version} with ${targetRef} version ${currentVersion}.`,
        );
      }
      if (comparison < 0) {
        throw new Error(
          `Refusing to move ${targetRef} backward from ${currentVersion} to ${policy.version}.`,
        );
      }
    }
  }

  for (const { manifestDigest, manifestTag, targetRefs } of promotions) {
    const targetArgs = targetRefs.flatMap((targetRef) => ["--tag", targetRef]);
    const sourceDigestRef = `${targetImage}@${manifestDigest}`;
    runImagetools(
      ["create", "--prefer-index=false", ...targetArgs, sourceDigestRef],
      execFileSyncImpl,
      { inherit: true },
    );
    for (const targetRef of targetRefs) {
      const descriptor = inspectManifestDescriptor(targetRef, execFileSyncImpl);
      if (descriptor.mediaType !== IMAGE_INDEX_MEDIA_TYPE) {
        throw new Error(`${targetRef} must resolve to an OCI image index.`);
      }
      if (descriptor.digest !== manifestDigest) {
        throw new Error(
          `${targetRef} resolved to ${descriptor.digest}, expected ${manifestDigest}.`,
        );
      }
      log(`Verified ${targetRef} -> ${manifestTag} (${manifestDigest}).`);
    }
  }
  return {
    channel: policy.channel,
    targetImage,
    version: policy.version,
  };
}

function printHelp() {
  console.log(
    "Usage: node scripts/vercel-container-registry-publish.mjs --version YYYY.M.P --target-image REGISTRY/IMAGE [--include-browser] (--source-ref ALIAS=REGISTRY/IMAGE@sha256:DIGEST [...] | --promote-aliases)",
  );
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      help: { type: "boolean", short: "h" },
      "include-browser": { type: "boolean" },
      "promote-aliases": { type: "boolean" },
      "source-ref": { type: "string", multiple: true },
      "target-image": { type: "string" },
      version: { type: "string" },
    },
    strict: true,
  });
  if (values.help) {
    printHelp();
    return;
  }
  if (!values.version || !values["target-image"]) {
    throw new Error("--version and --target-image are required.");
  }
  if (values["promote-aliases"]) {
    if (values["source-ref"]) {
      throw new Error("--promote-aliases cannot be combined with --source-ref.");
    }
    const result = promoteVercelContainerRegistryAliases({
      includeBrowser: values["include-browser"] ?? false,
      targetImage: values["target-image"],
      version: values.version,
    });
    console.log(`Promoted ${result.channel} aliases for ${result.targetImage}:${result.version}.`);
    return;
  }
  if (!values["source-ref"]) {
    throw new Error("--source-ref is required when publishing immutable images.");
  }
  const plan = publishVercelContainerRegistryImages({
    includeBrowser: values["include-browser"] ?? false,
    sourceRefs: values["source-ref"],
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
