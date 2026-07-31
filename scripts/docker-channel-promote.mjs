#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";
import { parseArgs } from "node:util";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveDockerReleasePolicy } from "./lib/docker-release-policy.mjs";
import { compareReleaseVersions } from "./lib/release-version.mjs";
import { parsePlatform, verifyDockerAttestations } from "./verify-docker-attestations.mjs";

const DOCKER_TIMEOUT_MS = 120_000;
const REQUIRED_PLATFORMS = Object.freeze([
  parsePlatform("linux/amd64"),
  parsePlatform("linux/arm64"),
]);
const VARIANTS = Object.freeze([
  { aliasKey: "default", suffix: "" },
  { aliasKey: "slim", suffix: "-slim" },
  { aliasKey: "browser", suffix: "-browser" },
]);

/** Build the version-specific source to moving-alias promotion plan. */
export function createDockerChannelPromotionPlan({ version, images }) {
  if (images.length === 0) {
    throw new Error("At least one --image is required.");
  }
  const policy = resolveDockerReleasePolicy(version);
  const promotions = [];
  for (const image of images) {
    for (const { aliasKey, suffix } of VARIANTS) {
      const aliases = policy.movingAliases[aliasKey];
      if (aliases.length === 0) {
        continue;
      }
      promotions.push({
        image,
        sourceRef: `${image}:${version}${suffix}`,
        targetRefs: aliases.map((alias) => `${image}:${alias}`),
      });
    }
  }
  if (promotions.length === 0) {
    throw new Error(`Docker ${policy.channel} releases have no moving aliases to promote.`);
  }
  return { channel: policy.channel, promotions, version: policy.version };
}

function runDocker(args, execFileSyncImpl) {
  return execFileSyncImpl("docker", args, {
    encoding: "utf8",
    killSignal: "SIGKILL",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
    timeout: DOCKER_TIMEOUT_MS,
  });
}

function inspectManifestDigest(imageRef, execFileSyncImpl) {
  const raw = runDocker(
    ["buildx", "imagetools", "inspect", imageRef, "--format", "{{json .Manifest}}"],
    execFileSyncImpl,
  );
  let digest;
  try {
    digest = JSON.parse(raw).digest;
  } catch (error) {
    throw new Error(`Could not parse the manifest for ${imageRef}.`, { cause: error });
  }
  if (typeof digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`The manifest for ${imageRef} did not contain a valid sha256 digest.`);
  }
  return digest;
}

function formatCommandError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const output = [error.message];
  for (const field of ["stderr", "stdout"]) {
    const value = error[field];
    if (typeof value === "string") {
      output.push(value);
    } else if (Buffer.isBuffer(value)) {
      output.push(value.toString("utf8"));
    }
  }
  return output.join("\n");
}

function isMissingManifestError(error) {
  const message = formatCommandError(error);
  return /(?:manifest unknown|no such manifest|:\s*not found(?:\s|$))/i.test(message);
}

function formatPlatform(platform) {
  const suffix = platform.variant ? `/${platform.variant}` : "";
  return `${platform.os}/${platform.architecture}${suffix}`;
}

function inspectImageVersion(imageRef, execFileSyncImpl, { allowMissing = false } = {}) {
  const versions = new Map();
  for (const [index, platform] of REQUIRED_PLATFORMS.entries()) {
    const platformName = formatPlatform(platform);
    let raw;
    try {
      // In formatted multi-platform inspection, Buildx keys .Image by os/arch.
      // Read every promoted platform rather than trusting one config label.
      raw = runDocker(
        [
          "buildx",
          "imagetools",
          "inspect",
          imageRef,
          "--format",
          `{{json (index .Image "${platformName}")}}`,
        ],
        execFileSyncImpl,
      );
    } catch (error) {
      if (allowMissing && index === 0 && isMissingManifestError(error)) {
        return null;
      }
      throw error;
    }

    let version;
    try {
      version = JSON.parse(raw)?.config?.Labels?.["org.opencontainers.image.version"];
    } catch (error) {
      throw new Error(`Could not parse the ${platformName} image config for ${imageRef}.`, {
        cause: error,
      });
    }
    if (typeof version !== "string" || version.trim().length === 0) {
      throw new Error(
        `${imageRef} does not have an org.opencontainers.image.version label for ${platformName}.`,
      );
    }
    versions.set(platformName, version.trim());
  }
  const uniqueVersions = new Set(versions.values());
  if (uniqueVersions.size !== 1) {
    const details = [...versions].map(([platform, version]) => `${platform}=${version}`).join(", ");
    throw new Error(`${imageRef} has inconsistent platform versions: ${details}.`);
  }
  return uniqueVersions.values().next().value;
}

function verifySourceVersions(resolved, version, execFileSyncImpl) {
  for (const promotion of resolved) {
    const sourceVersion = inspectImageVersion(promotion.sourceDigestRef, execFileSyncImpl);
    if (sourceVersion !== version) {
      throw new Error(
        `${promotion.sourceDigestRef} reports version ${sourceVersion}, expected ${version}.`,
      );
    }
  }
}

function preventChannelRollback(resolved, version, execFileSyncImpl) {
  for (const promotion of resolved) {
    for (const targetRef of promotion.targetRefs) {
      const currentVersion = inspectImageVersion(targetRef, execFileSyncImpl, {
        allowMissing: true,
      });
      if (currentVersion === null) {
        continue;
      }
      const comparison = compareReleaseVersions(version, currentVersion);
      if (comparison === null) {
        throw new Error(
          `Cannot compare candidate version ${version} with ${targetRef} version ${currentVersion}.`,
        );
      }
      if (comparison < 0) {
        throw new Error(
          `Refusing to move ${targetRef} backward from ${currentVersion} to ${version}. ` +
            "An approved repair may rerun with --allow-rollback.",
        );
      }
    }
  }
}

/** Promote every planned alias and verify the registry result. */
export function promoteDockerChannel({ version, images }, options = {}) {
  const execFileSyncImpl = options.execFileSyncImpl ?? execFileSync;
  const log = options.log ?? console.log;
  const verifyAttestationsImpl = options.verifyAttestationsImpl ?? verifyDockerAttestations;
  const plan = createDockerChannelPromotionPlan({ version, images });

  // Resolve every version-specific source before the first alias write. A missing
  // release variant must not leave the channel partially promoted.
  const resolved = plan.promotions.map((promotion) => {
    const sourceDigest = inspectManifestDigest(promotion.sourceRef, execFileSyncImpl);
    return {
      ...promotion,
      sourceDigest,
      sourceDigestRef: `${promotion.image}@${sourceDigest}`,
    };
  });

  // Attestation checks and writes share these digest refs so a concurrent tag
  // rewrite cannot swap the content between verification and promotion.
  verifyAttestationsImpl({
    imageRefs: resolved.map((promotion) => promotion.sourceDigestRef),
    requiredPlatforms: REQUIRED_PLATFORMS,
    execFileSyncImpl,
    log,
  });
  verifySourceVersions(resolved, plan.version, execFileSyncImpl);
  if (!options.allowRollback) {
    preventChannelRollback(resolved, plan.version, execFileSyncImpl);
  }

  for (const promotion of resolved) {
    const targetArgs = promotion.targetRefs.flatMap((targetRef) => ["--tag", targetRef]);
    runDocker(
      [
        "buildx",
        "imagetools",
        "create",
        "--prefer-index=false",
        ...targetArgs,
        promotion.sourceDigestRef,
      ],
      execFileSyncImpl,
    );
    for (const targetRef of promotion.targetRefs) {
      const targetDigest = inspectManifestDigest(targetRef, execFileSyncImpl);
      if (targetDigest !== promotion.sourceDigest) {
        throw new Error(
          `${targetRef} resolved to ${targetDigest}, expected ${promotion.sourceDigest}.`,
        );
      }
      log(`Verified ${targetRef} -> ${promotion.sourceDigest}.`);
    }
  }
  return plan;
}

function printHelp() {
  console.log(
    "Usage: node scripts/docker-channel-promote.mjs --version YYYY.M.P --image REGISTRY/IMAGE [--image REGISTRY/IMAGE] [--allow-rollback]",
  );
}

function main() {
  const { values } = parseArgs({
    args: process.argv.slice(2),
    options: {
      "allow-rollback": { type: "boolean" },
      help: { type: "boolean", short: "h" },
      image: { type: "string", multiple: true },
      version: { type: "string" },
    },
    strict: true,
  });
  if (values.help) {
    printHelp();
    return;
  }
  const version = values.version?.trim();
  if (!version) {
    throw new Error("--version is required.");
  }
  const images = (values.image ?? []).map((image) => image.trim());
  if (images.length === 0 || images.some((image) => image.length === 0)) {
    throw new Error("At least one non-empty --image is required.");
  }
  const plan = promoteDockerChannel(
    { version, images },
    { allowRollback: values["allow-rollback"] },
  );
  console.log(`Promoted Docker ${plan.channel} aliases for ${plan.version}.`);
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(
      `docker-channel-promote: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  }
}
