import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFullReleaseCandidateBinding,
  buildFullReleaseCandidateManifest,
  buildFullReleaseCandidateRequest,
  candidateRequestSha256,
  canonicalFullReleaseCandidateManifestJson,
  canonicalFullReleaseCandidateRequestJson,
  fullReleaseCandidateManifestSha256,
  validateFullReleaseCandidateBinding,
  validateFullReleaseCandidateManifest,
  validateFullReleaseCandidateRequest,
} from "../../scripts/full-release-candidate-contract.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/full-release-candidate-contract.mjs");
const TARGET_SHA = "a".repeat(40);
const TOOLING_SHA = "b".repeat(40);
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function requestInput(overrides: Record<string, unknown> = {}) {
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

function artifact(name: string, overrides: Record<string, unknown> = {}) {
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

function manifest(overrides: Record<string, unknown> = {}) {
  const request = buildFullReleaseCandidateRequest(requestInput());
  return buildFullReleaseCandidateManifest({
    request,
    requestSha256: candidateRequestSha256(request),
    producer: {
      repository: "openclaw/openclaw",
      workflowPath: ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml",
      workflowSha: TOOLING_SHA,
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
      artifact: artifact("docker-e2e-package-77-1"),
      fileName: "openclaw-current.tgz",
      sourceSha: TARGET_SHA,
      packageSha256: "e".repeat(64),
      version: "2026.8.28-beta.1",
    },
    prepublishPluginRegistry: {
      artifact: artifact("docker-e2e-prepublish-plugin-registry-77-1", {
        id: "102",
        digest: "f".repeat(64),
      }),
      manifestSha256: "1".repeat(64),
      sourceSha: TARGET_SHA,
    },
    sharedImage: {
      artifact: artifact("docker-e2e-shared-images-full-release-aaaaaaaaaaaa-77-1", {
        id: "103",
        digest: "2".repeat(64),
      }),
      archiveSha256: "3".repeat(64),
      packageSha256: "e".repeat(64),
    },
    ...overrides,
  });
}

function runContract(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

describe("full release candidate contract", () => {
  it("canonicalizes equivalent request inputs and expands effective policy", () => {
    const request = buildFullReleaseCandidateRequest(requestInput());
    const reordered = Object.fromEntries(Object.entries(requestInput()).toReversed());
    const reorderedRequest = buildFullReleaseCandidateRequest(reordered);

    expect(request).toEqual(reorderedRequest);
    expect(request.upgradeSurvivorBaselines).toEqual(["openclaw@latest"]);
    expect(request.upgradeSurvivorScenarios).toContain("acpx-openclaw-tools-bridge");
    expect(request.upgradeSurvivorScenarios).not.toContain("prerelease-plugin-registry");
    expect(request.upgradeSurvivorScenarios).not.toContain("sqlite-volume");
    expect(canonicalFullReleaseCandidateRequestJson(request)).toBe(
      canonicalFullReleaseCandidateRequestJson(reorderedRequest),
    );
    expect(candidateRequestSha256(request)).toBe(candidateRequestSha256(reorderedRequest));
    expect(candidateRequestSha256(request)).toBe(
      "9431d1fddd030c460f27294665f526838c7df69c826e59e5c6cf045b4d6a90a0",
    );
  });

  it("canonicalizes equivalent baseline and scenario set ordering", () => {
    const request = buildFullReleaseCandidateRequest(
      requestInput({
        upgradeSurvivorBaselines: "beta latest",
        upgradeSurvivorScenarios: "base feishu-channel",
      }),
    );
    const reordered = buildFullReleaseCandidateRequest(
      requestInput({
        upgradeSurvivorBaselines: "latest,beta",
        upgradeSurvivorScenarios: "feishu-channel,base",
      }),
    );

    expect(request).toEqual(reordered);
    expect(candidateRequestSha256(request)).toBe(candidateRequestSha256(reordered));
  });

  it.each([
    ["repository", { repository: "openclaw/fork" }],
    ["target SHA", { targetSha: "4".repeat(40) }],
    ["tooling SHA", { toolingSha: "5".repeat(40) }],
    ["release profile", { releaseProfile: "beta" }],
    ["release soak", { releaseSoak: false }],
    ["survivor baseline", { upgradeSurvivorBaseline: "beta" }],
    ["survivor scenarios", { upgradeSurvivorScenarios: "base" }],
    ["frozen omissions", { allowFrozenTargetScenarioOmissions: true }],
    ["changelog policy", { allowUnreleasedChangelog: true }],
    ["shared image policy", { sharedImagePolicy: "existing-only" }],
  ])("changes the request digest when %s changes", (_label, overrides) => {
    const baseline = buildFullReleaseCandidateRequest(requestInput());
    const changed = buildFullReleaseCandidateRequest(requestInput(overrides));
    expect(candidateRequestSha256(changed)).not.toBe(candidateRequestSha256(baseline));
  });

  it("rejects malformed or noncanonical request policy", () => {
    const request = buildFullReleaseCandidateRequest(requestInput());
    expect(() => validateFullReleaseCandidateRequest({ ...request, ignored: true })).toThrow(
      "keys must be exactly",
    );
    expect(() =>
      validateFullReleaseCandidateRequest({
        ...request,
        upgradeSurvivorBaselines: ["latest"],
      }),
    ).toThrow("not normalized");
    expect(() =>
      validateFullReleaseCandidateRequest({
        ...request,
        upgradeSurvivorBaselines: ["openclaw@latest", "openclaw@beta"],
      }),
    ).toThrow("ascending ASCII order");
    expect(() =>
      validateFullReleaseCandidateRequest({
        ...request,
        upgradeSurvivorScenarios: ["feishu-channel", "base"],
      }),
    ).toThrow("not normalized");
    expect(() =>
      validateFullReleaseCandidateRequest({
        ...request,
        contractVersions: { ...request.contractVersions, sharedImage: 2 },
      }),
    ).toThrow("contract versions are invalid");
  });

  it("binds one canonical manifest to the request, plan, producer, and artifacts", () => {
    const value = manifest();
    const json = canonicalFullReleaseCandidateManifestJson(value);
    expect(json.endsWith("\n")).toBe(true);
    expect(validateFullReleaseCandidateManifest(JSON.parse(json))).toEqual(value);
    expect(fullReleaseCandidateManifestSha256(JSON.parse(json))).toBe(
      fullReleaseCandidateManifestSha256(value),
    );

    const binding = buildFullReleaseCandidateBinding({
      manifest: value,
      artifact: artifact(`full-release-candidate-v1-${value.requestSha256 as string}`, {
        id: "104",
        digest: "4".repeat(64),
      }),
    });
    expect(validateFullReleaseCandidateBinding(binding)).toEqual(binding);
    expect(binding.request).toEqual(value.request);
    expect(binding.manifestSha256).toBe(fullReleaseCandidateManifestSha256(value));
  });

  it("runs request, manifest, and binding commands through their subprocess boundary", () => {
    const root = tempDirs.make("full-release-candidate-cli-");
    const requestInputPath = join(root, "request-input.json");
    const requestOutputPath = join(root, "request.json");
    writeFileSync(requestInputPath, JSON.stringify(requestInput()));
    const requestResult = runContract([
      "request",
      "--input",
      requestInputPath,
      "--output",
      requestOutputPath,
    ]);
    expect(requestResult.status, requestResult.stderr).toBe(0);
    const requestValue = JSON.parse(readFileSync(requestOutputPath, "utf8"));
    expect(JSON.parse(requestResult.stdout)).toEqual({
      requestJson: canonicalFullReleaseCandidateRequestJson(requestValue).trimEnd(),
      requestSha256: candidateRequestSha256(requestValue),
    });

    const manifestInputPath = join(root, "manifest-input.json");
    const manifestOutputPath = join(root, "manifest.json");
    writeFileSync(manifestInputPath, JSON.stringify(manifest()));
    const manifestResult = runContract([
      "manifest",
      "--input",
      manifestInputPath,
      "--output",
      manifestOutputPath,
    ]);
    expect(manifestResult.status, manifestResult.stderr).toBe(0);
    const manifestValue = JSON.parse(readFileSync(manifestOutputPath, "utf8"));
    expect(JSON.parse(manifestResult.stdout)).toEqual({
      manifestSha256: fullReleaseCandidateManifestSha256(manifestValue),
      requestSha256: manifestValue.requestSha256,
    });

    const evidenceArtifact = artifact(
      `full-release-candidate-v1-${manifestValue.requestSha256 as string}`,
      {
        id: "104",
        digest: "4".repeat(64),
      },
    );
    const bindingResult = runContract([
      "binding",
      "--manifest",
      manifestOutputPath,
      "--artifact-name",
      evidenceArtifact.name as string,
      "--artifact-id",
      evidenceArtifact.id as string,
      "--artifact-digest",
      evidenceArtifact.digest as string,
      "--artifact-expires-at",
      evidenceArtifact.expiresAt as string,
      "--artifact-run-id",
      evidenceArtifact.runId as string,
      "--artifact-run-attempt",
      evidenceArtifact.runAttempt as string,
    ]);
    expect(bindingResult.status, bindingResult.stderr).toBe(0);
    expect(JSON.parse(bindingResult.stdout)).toEqual(
      buildFullReleaseCandidateBinding({
        artifact: evidenceArtifact,
        manifest: manifestValue,
      }),
    );
  });

  it("returns nonzero for invalid request, manifest, and binding CLI inputs", () => {
    const root = tempDirs.make("full-release-candidate-cli-failure-");
    const requestInputPath = join(root, "request-input.json");
    const invalidManifestPath = join(root, "invalid-manifest.json");
    const manifestOutputPath = join(root, "manifest.json");
    writeFileSync(requestInputPath, JSON.stringify(requestInput()));
    writeFileSync(invalidManifestPath, "{");
    writeFileSync(manifestOutputPath, canonicalFullReleaseCandidateManifestJson(manifest()));

    const missingRequestOutput = runContract(["request", "--input", requestInputPath]);
    expect(missingRequestOutput.status).toBe(1);
    expect(missingRequestOutput.stderr).toContain("missing --output");

    const invalidManifest = runContract([
      "manifest",
      "--input",
      invalidManifestPath,
      "--output",
      join(root, "unused.json"),
    ]);
    expect(invalidManifest.status).toBe(1);
    expect(invalidManifest.stderr).toContain("manifest input is invalid JSON");

    const mismatchedBinding = runContract([
      "binding",
      "--manifest",
      manifestOutputPath,
      "--artifact-name",
      "full-release-candidate-v1-deadbeef",
      "--artifact-id",
      "104",
      "--artifact-digest",
      "4".repeat(64),
      "--artifact-expires-at",
      "2026-09-04T12:00:00Z",
      "--artifact-run-id",
      "77",
      "--artifact-run-attempt",
      "1",
    ]);
    expect(mismatchedBinding.status).toBe(1);
    expect(mismatchedBinding.stderr).toContain("does not match its manifest");
  });

  it("fails closed on cross-request, cross-package, and cross-attempt evidence", () => {
    const value = manifest();
    expect(() =>
      validateFullReleaseCandidateManifest({
        ...value,
        requestSha256: "9".repeat(64),
      }),
    ).toThrow("does not match the request");
    expect(() =>
      validateFullReleaseCandidateManifest({
        ...value,
        sharedImage: { ...value.sharedImage, packageSha256: "8".repeat(64) },
      }),
    ).toThrow("does not match the package");
    expect(() =>
      validateFullReleaseCandidateManifest({
        ...value,
        package: {
          ...value.package,
          artifact: { ...value.package.artifact, runAttempt: "2" },
        },
      }),
    ).toThrow("was not produced by the declared attempt");
    expect(() =>
      validateFullReleaseCandidateManifest({
        ...value,
        producer: { ...value.producer, jobId: "prepare_docker_e2e_image" },
      }),
    ).toThrow("positive decimal string");
    expect(() =>
      buildFullReleaseCandidateBinding({
        manifest: value,
        artifact: artifact("full-release-candidate-v1-deadbeef", {
          id: "104",
          digest: "4".repeat(64),
        }),
      }),
    ).toThrow("does not match its manifest");
  });

  it("binds every serialized field to the manifest digest and caps binding size", () => {
    const value = manifest();
    const binding = buildFullReleaseCandidateBinding({
      manifest: value,
      artifact: artifact(`full-release-candidate-v1-${value.requestSha256 as string}`, {
        id: "104",
        digest: "4".repeat(64),
      }),
    });

    expect(() =>
      validateFullReleaseCandidateBinding({
        ...binding,
        producer: { ...binding.producer, jobName: "different producer job" },
      }),
    ).toThrow("manifestSha256 does not match its manifest fields");
    expect(() =>
      validateFullReleaseCandidateBinding({
        ...binding,
        evidenceArtifact: { ...binding.evidenceArtifact, id: "1".repeat(50_000) },
      }),
    ).toThrow("binding exceeds");
  });

  it("rejects a canonical manifest larger than 32 KiB", () => {
    const requiredPrepublishPluginPackages = Array.from(
      { length: 1_000 },
      (_, index) => `@openclaw/candidate-${String(index).padStart(4, "0")}-${"x".repeat(16)}`,
    );
    const value = manifest({
      preparation: {
        planSha256: "d".repeat(64),
        requiredPrepublishPluginPackages,
      },
    });
    expect(Buffer.byteLength(JSON.stringify(value))).toBeGreaterThan(32 * 1024);
    expect(() => canonicalFullReleaseCandidateManifestJson(value)).toThrow(
      "full release candidate manifest exceeds 32768 bytes",
    );
  });

  it("rejects unsorted or empty producer package evidence", () => {
    const value = manifest();
    expect(() =>
      validateFullReleaseCandidateManifest({
        ...value,
        preparation: {
          ...value.preparation,
          requiredPrepublishPluginPackages: ["openclaw", "@openclaw/codex"],
        },
      }),
    ).toThrow("ascending ASCII order");
    expect(() =>
      validateFullReleaseCandidateManifest({
        ...value,
        preparation: {
          ...value.preparation,
          requiredPrepublishPluginPackages: [],
        },
      }),
    ).toThrow("does not match the request");
  });
});
