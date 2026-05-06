import { describe, expect, it } from "vitest";
import {
  collectDockerAttestationErrors,
  imageRefForDigest,
  parsePlatform,
} from "../../scripts/verify-docker-attestations.mjs";

const imageDigest = "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const attestationDigest = "sha256:2222222222222222222222222222222222222222222222222222222222222222";

function createIndex() {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.index.v1+json",
    manifests: [
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: imageDigest,
        size: 482,
        platform: { architecture: "amd64", os: "linux" },
      },
      {
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        digest: attestationDigest,
        size: 1110,
        annotations: {
          "vnd.docker.reference.digest": imageDigest,
          "vnd.docker.reference.type": "attestation-manifest",
        },
        platform: { architecture: "unknown", os: "unknown" },
      },
    ],
  };
}

function createAttestation(
  predicates = ["https://spdx.dev/Document", "https://slsa.dev/provenance/v1"],
) {
  return {
    schemaVersion: 2,
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    artifactType: "application/vnd.docker.attestation.manifest.v1+json",
    layers: predicates.map((predicate) => ({
      mediaType: "application/vnd.in-toto+json",
      digest: imageDigest,
      size: 1,
      annotations: {
        "in-toto.io/predicate-type": predicate,
      },
    })),
  };
}

function createAttestationWithoutArtifactType() {
  const { artifactType: _artifactType, ...attestation } = createAttestation();
  return attestation;
}

describe("verify-docker-attestations", () => {
  it("resolves digest refs from tagged image refs", () => {
    expect(imageRefForDigest("ghcr.io/openclaw/openclaw:2026.4.26", imageDigest)).toBe(
      `ghcr.io/openclaw/openclaw@${imageDigest}`,
    );
    expect(imageRefForDigest("localhost:5000/openclaw:main", imageDigest)).toBe(
      `localhost:5000/openclaw@${imageDigest}`,
    );
  });

  it("accepts an image index with SBOM and provenance predicates", () => {
    const errors = collectDockerAttestationErrors({
      imageRef: "ghcr.io/openclaw/openclaw:test",
      index: createIndex(),
      requiredPlatforms: [parsePlatform("linux/amd64")],
      inspectAttestation: () => createAttestation(),
    });

    expect(errors).toEqual([]);
  });

  it("accepts OCI attestation manifests without artifactType", () => {
    const errors = collectDockerAttestationErrors({
      imageRef: "ghcr.io/openclaw/openclaw:test",
      index: createIndex(),
      requiredPlatforms: [parsePlatform("linux/amd64")],
      inspectAttestation: () => createAttestationWithoutArtifactType(),
    });

    expect(errors).toEqual([]);
  });

  it("reports missing attestation manifests", () => {
    const index = createIndex();
    index.manifests = index.manifests.slice(0, 1);

    const errors = collectDockerAttestationErrors({
      imageRef: "ghcr.io/openclaw/openclaw:test",
      index,
      requiredPlatforms: [parsePlatform("linux/amd64")],
      inspectAttestation: () => createAttestation(),
    });

    expect(errors).toEqual([
      "ghcr.io/openclaw/openclaw:test: missing attestation manifest for linux/amd64",
    ]);
  });

  it("reports missing SBOM or provenance predicates", () => {
    const errors = collectDockerAttestationErrors({
      imageRef: "ghcr.io/openclaw/openclaw:test",
      index: createIndex(),
      requiredPlatforms: [parsePlatform("linux/amd64")],
      inspectAttestation: () => createAttestation(["https://spdx.dev/Document"]),
    });

    expect(errors).toEqual([
      "ghcr.io/openclaw/openclaw:test: linux/amd64 missing predicate https://slsa.dev/provenance/v1",
    ]);
  });

  it("reports an unexpected attestation manifest shape", () => {
    const errors = collectDockerAttestationErrors({
      imageRef: "ghcr.io/openclaw/openclaw:test",
      index: createIndex(),
      requiredPlatforms: [parsePlatform("linux/amd64")],
      inspectAttestation: () => ({
        ...createAttestation(),
        artifactType: "application/vnd.example.invalid",
      }),
    });

    expect(errors).toEqual([
      `ghcr.io/openclaw/openclaw:test: linux/amd64 attestation ${attestationDigest} has unexpected manifest shape artifactType="application/vnd.example.invalid" mediaType="application/vnd.oci.image.manifest.v1+json"`,
    ]);
  });
});
