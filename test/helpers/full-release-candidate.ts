import { createHash } from "node:crypto";
import { buildFullReleaseCandidateRequest } from "../../scripts/full-release-candidate-contract.mjs";

const TARGET_SHA = "a".repeat(40);
const TOOLING_SHA = "b".repeat(40);

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}

export function canonicalTestJson(value: unknown): string {
  return `${JSON.stringify(canonicalize(value))}\n`;
}

export function canonicalTestSha256(value: unknown): string {
  return createHash("sha256").update(canonicalTestJson(value)).digest("hex");
}

export function fullReleaseCandidateRequestInput(overrides: Record<string, unknown> = {}) {
  return {
    repository: "openclaw/openclaw",
    targetSha: TARGET_SHA,
    toolingSha: TOOLING_SHA,
    releaseProfile: "stable",
    releaseSoak: true,
    upgradeSurvivorBaseline: "latest",
    upgradeSurvivorBaselines: "",
    upgradeSurvivorScenarios: "reported-issues",
    allowFrozenTargetScenarioOmissions: false,
    allowUnreleasedChangelog: false,
    sharedImagePolicy: "no-push-artifact",
    ...overrides,
  };
}

export function fullReleaseCandidateArtifact(
  name: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    name,
    id: "101",
    digest: "c".repeat(64),
    expiresAt: "2026-09-04T12:00:00Z",
    runId: "77",
    runAttempt: "1",
    ...overrides,
  };
}

export function fullReleaseCandidateManifestFixture(
  requestOverrides: Record<string, unknown> = {},
) {
  const request = buildFullReleaseCandidateRequest(
    fullReleaseCandidateRequestInput(requestOverrides),
  );
  return {
    schema: "openclaw.full-release-candidate/v1" as const,
    request,
    requestSha256: canonicalTestSha256(request),
    producer: {
      repository: request.repository,
      workflowPath: ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
      workflowSha: request.toolingSha,
      runId: "77",
      runAttempt: "1",
      jobId: "201",
      jobName: "Prepare shared release candidate / Prepare shared Docker E2E image",
    },
    preparation: {
      planSha256: "d".repeat(64),
      requiredPrepublishPluginPackages: ["@openclaw/codex"],
    },
    package: {
      artifact: fullReleaseCandidateArtifact("docker-e2e-package-77-1"),
      fileName: "openclaw-current.tgz",
      sourceSha: request.targetSha,
      packageSha256: "e".repeat(64),
      version: "2026.8.28-beta.1",
    },
    prepublishPluginRegistry: {
      artifact: fullReleaseCandidateArtifact("docker-e2e-prepublish-plugin-registry-77-1", {
        id: "102",
        digest: "f".repeat(64),
      }),
      manifestSha256: "1".repeat(64),
      sourceSha: request.targetSha,
    },
    sharedImage: {
      artifact: fullReleaseCandidateArtifact(
        "docker-e2e-shared-images-full-release-aaaaaaaaaaaa-77-1",
        {
          id: "103",
          digest: "2".repeat(64),
        },
      ),
      archiveSha256: "3".repeat(64),
      packageSha256: "e".repeat(64),
    },
  };
}

export function fullReleaseCandidateBindingFixture(requestOverrides: Record<string, unknown> = {}) {
  const manifest = fullReleaseCandidateManifestFixture(requestOverrides);
  const { schema: _schema, ...manifestFields } = manifest;
  return {
    schema: "openclaw.full-release-candidate-binding/v1" as const,
    ...manifestFields,
    evidenceArtifact: fullReleaseCandidateArtifact(
      `full-release-candidate-v1-${manifest.requestSha256}`,
      {
        id: "104",
        digest: "4".repeat(64),
      },
    ),
    manifestSha256: canonicalTestSha256(manifest),
  };
}
