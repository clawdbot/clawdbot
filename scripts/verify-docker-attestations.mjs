#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import process from "node:process";

const ATTESTATION_REFERENCE_TYPE = "attestation-manifest";
const EXPECTED_ATTESTATION_ARTIFACT_TYPE = "application/vnd.docker.attestation.manifest.v1+json";
const REQUIRED_PREDICATES = ["https://spdx.dev/Document", "https://slsa.dev/provenance/v1"];

export function imageRefForDigest(imageRef, digest) {
  const atIndex = imageRef.indexOf("@");
  if (atIndex >= 0) {
    return `${imageRef.slice(0, atIndex)}@${digest}`;
  }
  const lastSlash = imageRef.lastIndexOf("/");
  const tagIndex = imageRef.indexOf(":", lastSlash + 1);
  const base = tagIndex >= 0 ? imageRef.slice(0, tagIndex) : imageRef;
  return `${base}@${digest}`;
}

export function parsePlatform(value) {
  const [os, architecture, variant] = value.split("/");
  if (!os || !architecture || value.split("/").length > 3) {
    throw new Error(`Invalid platform ${JSON.stringify(value)}. Expected os/architecture.`);
  }
  return { architecture, os, variant };
}

function formatPlatform(platform) {
  return platform.variant
    ? `${platform.os}/${platform.architecture}/${platform.variant}`
    : `${platform.os}/${platform.architecture}`;
}

function platformMatches(actual, expected) {
  return (
    actual?.os === expected.os &&
    actual?.architecture === expected.architecture &&
    (expected.variant ? actual?.variant === expected.variant : true)
  );
}

function parseJson(raw, label) {
  try {
    return JSON.parse(raw);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to parse ${label}: ${reason}`, { cause: error });
  }
}

export function collectDockerAttestationErrors(params) {
  const {
    imageRef,
    index,
    inspectAttestation,
    requiredPlatforms,
    requiredPredicates = REQUIRED_PREDICATES,
  } = params;
  const errors = [];
  const manifests = Array.isArray(index?.manifests) ? index.manifests : [];
  if (manifests.length === 0) {
    return [`${imageRef}: expected an image index with manifest descriptors`];
  }

  for (const platform of requiredPlatforms) {
    const platformLabel = formatPlatform(platform);
    const imageManifest = manifests.find((entry) => platformMatches(entry.platform, platform));
    if (!imageManifest?.digest) {
      errors.push(`${imageRef}: missing image manifest for ${platformLabel}`);
      continue;
    }

    const attestationDescriptors = manifests.filter(
      (entry) =>
        entry?.annotations?.["vnd.docker.reference.type"] === ATTESTATION_REFERENCE_TYPE &&
        entry?.annotations?.["vnd.docker.reference.digest"] === imageManifest.digest &&
        typeof entry.digest === "string" &&
        entry.digest.length > 0,
    );
    if (attestationDescriptors.length === 0) {
      errors.push(`${imageRef}: missing attestation manifest for ${platformLabel}`);
      continue;
    }

    const predicates = new Set();
    for (const descriptor of attestationDescriptors) {
      const attestation = inspectAttestation(descriptor.digest);
      if (
        attestation?.artifactType !== undefined &&
        attestation.artifactType !== EXPECTED_ATTESTATION_ARTIFACT_TYPE
      ) {
        errors.push(
          `${imageRef}: ${platformLabel} attestation ${descriptor.digest} has unexpected artifactType ${JSON.stringify(
            attestation?.artifactType,
          )}`,
        );
      }
      for (const layer of attestation?.layers ?? []) {
        const predicate = layer?.annotations?.["in-toto.io/predicate-type"];
        if (typeof predicate === "string") {
          predicates.add(predicate);
        }
      }
    }

    for (const predicate of requiredPredicates) {
      if (!predicates.has(predicate)) {
        errors.push(`${imageRef}: ${platformLabel} missing predicate ${predicate}`);
      }
    }
  }

  return errors;
}

function inspectRaw(imageRef) {
  return execFileSync("docker", ["buildx", "imagetools", "inspect", "--raw", imageRef], {
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function parseArgs(argv) {
  const imageRefs = [];
  const requiredPlatforms = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--platform") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--platform requires a value");
      }
      requiredPlatforms.push(parsePlatform(value));
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      return { help: true, imageRefs, requiredPlatforms };
    }
    if (arg?.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    imageRefs.push(arg);
  }
  return { help: false, imageRefs, requiredPlatforms };
}

function printHelp() {
  console.log(
    `Usage: node scripts/verify-docker-attestations.mjs --platform linux/amd64 --platform linux/arm64 IMAGE...`,
  );
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.help) {
    printHelp();
    return;
  }
  if (parsed.imageRefs.length === 0) {
    throw new Error("At least one image reference is required.");
  }
  if (parsed.requiredPlatforms.length === 0) {
    throw new Error("At least one --platform is required.");
  }

  const allErrors = [];
  for (const imageRef of parsed.imageRefs) {
    const index = parseJson(inspectRaw(imageRef), `${imageRef} index`);
    const errors = collectDockerAttestationErrors({
      imageRef,
      index,
      requiredPlatforms: parsed.requiredPlatforms,
      inspectAttestation(digest) {
        return parseJson(
          inspectRaw(imageRefForDigest(imageRef, digest)),
          `${imageRef} attestation ${digest}`,
        );
      },
    });
    if (errors.length === 0) {
      console.log(
        `Verified Docker attestations for ${imageRef}: ${parsed.requiredPlatforms
          .map(formatPlatform)
          .join(", ")}`,
      );
    }
    allErrors.push(...errors);
  }

  if (allErrors.length > 0) {
    for (const error of allErrors) {
      console.error(`[docker-attestations] ${error}`);
    }
    process.exit(1);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
