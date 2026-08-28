import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildFullReleaseCandidateRequest,
  validateFullReleaseCandidateBinding,
  validateFullReleaseCandidateRequest,
} from "../../scripts/full-release-candidate-contract.mjs";
import {
  canonicalTestJson,
  canonicalTestSha256,
  fullReleaseCandidateArtifact,
  fullReleaseCandidateBindingFixture,
  fullReleaseCandidateManifestFixture,
  fullReleaseCandidateRequestInput,
} from "../helpers/full-release-candidate.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const SCRIPT = resolve("scripts/full-release-candidate-contract.mjs");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function manifest(overrides: Record<string, unknown> = {}) {
  return {
    ...fullReleaseCandidateManifestFixture(),
    ...overrides,
  };
}

function runContract(args: string[]) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 10_000,
  });
}

function runManifestContract(value: unknown) {
  const root = tempDirs.make("full-release-candidate-manifest-");
  const input = join(root, "input.json");
  const output = join(root, "output.json");
  writeFileSync(input, JSON.stringify(value));
  return runContract(["manifest", "--input", input, "--output", output]);
}

type CandidateBindingFixture = ReturnType<typeof fullReleaseCandidateBindingFixture>;

function replaceBindingRequest(
  binding: CandidateBindingFixture,
  overrides: Record<string, unknown>,
) {
  const request = buildFullReleaseCandidateRequest(fullReleaseCandidateRequestInput(overrides));
  binding.request = request;
  binding.requestSha256 = canonicalTestSha256(request);
  binding.evidenceArtifact.name = `full-release-candidate-v1-${binding.requestSha256}`;
}

describe("full release candidate contract", () => {
  it("canonicalizes equivalent request inputs and expands effective policy", () => {
    const request = buildFullReleaseCandidateRequest(fullReleaseCandidateRequestInput());
    const reordered = Object.fromEntries(
      Object.entries(fullReleaseCandidateRequestInput()).toReversed(),
    );
    const reorderedRequest = buildFullReleaseCandidateRequest(reordered);

    expect(request).toEqual(reorderedRequest);
    expect(request.upgradeSurvivorBaselines).toEqual(["openclaw@latest"]);
    expect(request.upgradeSurvivorScenarios).toContain("acpx-openclaw-tools-bridge");
    expect(request.upgradeSurvivorScenarios).not.toContain("prerelease-plugin-registry");
    expect(request.upgradeSurvivorScenarios).not.toContain("sqlite-volume");
    expect(canonicalTestJson(request)).toBe(canonicalTestJson(reorderedRequest));
    expect(canonicalTestSha256(request)).toBe(canonicalTestSha256(reorderedRequest));
    expect(canonicalTestSha256(request)).toBe(
      "9431d1fddd030c460f27294665f526838c7df69c826e59e5c6cf045b4d6a90a0",
    );
  });

  it("canonicalizes equivalent baseline and scenario set ordering", () => {
    const request = buildFullReleaseCandidateRequest(
      fullReleaseCandidateRequestInput({
        upgradeSurvivorBaselines: "beta latest",
        upgradeSurvivorScenarios: "base feishu-channel",
      }),
    );
    const reordered = buildFullReleaseCandidateRequest(
      fullReleaseCandidateRequestInput({
        upgradeSurvivorBaselines: "latest,beta",
        upgradeSurvivorScenarios: "feishu-channel,base",
      }),
    );

    expect(request).toEqual(reordered);
    expect(canonicalTestSha256(request)).toBe(canonicalTestSha256(reordered));
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
    const baseline = buildFullReleaseCandidateRequest(fullReleaseCandidateRequestInput());
    const changed = buildFullReleaseCandidateRequest(fullReleaseCandidateRequestInput(overrides));
    expect(canonicalTestSha256(changed)).not.toBe(canonicalTestSha256(baseline));
  });

  it("rejects malformed or noncanonical request policy", () => {
    const request = buildFullReleaseCandidateRequest(fullReleaseCandidateRequestInput());
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

  it("validates one canonical binding across the request, plan, producer, and artifacts", () => {
    const value = manifest();
    const binding = fullReleaseCandidateBindingFixture();
    expect(validateFullReleaseCandidateBinding(binding)).toEqual(binding);
    expect(binding.request).toEqual(value.request);
    expect(binding.manifestSha256).toBe(canonicalTestSha256(value));
  });

  it("runs request, manifest, and binding commands through their subprocess boundary", () => {
    const root = tempDirs.make("full-release-candidate-cli-");
    const requestInputPath = join(root, "request-input.json");
    const requestOutputPath = join(root, "request.json");
    writeFileSync(requestInputPath, JSON.stringify(fullReleaseCandidateRequestInput()));
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
      requestJson: canonicalTestJson(requestValue).trimEnd(),
      requestSha256: "9431d1fddd030c460f27294665f526838c7df69c826e59e5c6cf045b4d6a90a0",
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
      manifestSha256: canonicalTestSha256(manifestValue),
      requestSha256: manifestValue.requestSha256,
    });

    const evidenceArtifact = fullReleaseCandidateArtifact(
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
    const binding = JSON.parse(bindingResult.stdout);
    expect(validateFullReleaseCandidateBinding(binding)).toEqual(binding);
    expect(binding).toEqual(fullReleaseCandidateBindingFixture());
  });

  it("returns nonzero for invalid request, manifest, and binding CLI inputs", () => {
    const root = tempDirs.make("full-release-candidate-cli-failure-");
    const requestInputPath = join(root, "request-input.json");
    const invalidManifestPath = join(root, "invalid-manifest.json");
    const manifestOutputPath = join(root, "manifest.json");
    writeFileSync(requestInputPath, JSON.stringify(fullReleaseCandidateRequestInput()));
    writeFileSync(invalidManifestPath, "{");
    writeFileSync(manifestOutputPath, canonicalTestJson(manifest()));

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
    expect(
      runManifestContract({
        ...value,
        requestSha256: "9".repeat(64),
      }).stderr,
    ).toContain("does not match the request");
    expect(
      runManifestContract({
        ...value,
        sharedImage: { ...value.sharedImage, packageSha256: "8".repeat(64) },
      }).stderr,
    ).toContain("does not match the package");
    expect(
      runManifestContract({
        ...value,
        package: {
          ...value.package,
          artifact: { ...value.package.artifact, runAttempt: "2" },
        },
      }).stderr,
    ).toContain("was not produced by the declared attempt");
    expect(
      runManifestContract({
        ...value,
        producer: { ...value.producer, jobId: "prepare_docker_e2e_image" },
      }).stderr,
    ).toContain("positive decimal string");
  });

  it.each([
    ["producer job id", (binding) => void (binding.producer.jobId = "202")],
    ["producer job name", (binding) => void (binding.producer.jobName = "different producer job")],
    [
      "producer workflow path",
      (binding) =>
        void (binding.producer.workflowPath = ".github/workflows/candidate-evidence-test.yml"),
    ],
    [
      "producer run id tuple",
      (binding) => {
        binding.producer.runId = "78";
        binding.package.artifact.runId = "78";
        binding.prepublishPluginRegistry.artifact.runId = "78";
        binding.sharedImage.artifact.runId = "78";
        binding.evidenceArtifact.runId = "78";
      },
    ],
    [
      "producer run attempt tuple",
      (binding) => {
        binding.producer.runAttempt = "2";
        binding.package.artifact.runAttempt = "2";
        binding.prepublishPluginRegistry.artifact.runAttempt = "2";
        binding.sharedImage.artifact.runAttempt = "2";
        binding.evidenceArtifact.runAttempt = "2";
      },
    ],
    [
      "repository identity tuple",
      (binding) => {
        replaceBindingRequest(binding, { repository: "openclaw/other" });
        binding.producer.repository = binding.request.repository;
      },
    ],
    [
      "tooling identity tuple",
      (binding) => {
        replaceBindingRequest(binding, { toolingSha: "8".repeat(40) });
        binding.producer.workflowSha = binding.request.toolingSha;
      },
    ],
    [
      "target source identity tuple",
      (binding) => {
        replaceBindingRequest(binding, { targetSha: "9".repeat(40) });
        binding.package.sourceSha = binding.request.targetSha;
        binding.prepublishPluginRegistry.sourceSha = binding.request.targetSha;
      },
    ],
    [
      "request policy tuple",
      (binding) => {
        replaceBindingRequest(binding, { releaseSoak: false });
      },
    ],
    ["preparation plan", (binding) => void (binding.preparation.planSha256 = "5".repeat(64))],
    [
      "required prerelease packages",
      (binding) =>
        void (binding.preparation.requiredPrepublishPluginPackages = [
          "@openclaw/codex",
          "@openclaw/discord",
        ]),
    ],
    ["package artifact id", (binding) => void (binding.package.artifact.id = "105")],
    [
      "package artifact digest",
      (binding) => void (binding.package.artifact.digest = "5".repeat(64)),
    ],
    [
      "package artifact expiry",
      (binding) => void (binding.package.artifact.expiresAt = "2026-09-05T12:00:00Z"),
    ],
    ["package artifact name", (binding) => void (binding.package.artifact.name = "other-package")],
    ["package file name", (binding) => void (binding.package.fileName = "other.tgz")],
    [
      "package and shared image digest tuple",
      (binding) => {
        binding.package.packageSha256 = "8".repeat(64);
        binding.sharedImage.packageSha256 = "8".repeat(64);
      },
    ],
    ["package version", (binding) => void (binding.package.version = "2026.8.28-beta.2")],
    [
      "registry artifact id",
      (binding) => void (binding.prepublishPluginRegistry.artifact.id = "106"),
    ],
    [
      "registry artifact digest",
      (binding) => void (binding.prepublishPluginRegistry.artifact.digest = "6".repeat(64)),
    ],
    [
      "registry artifact expiry",
      (binding) =>
        void (binding.prepublishPluginRegistry.artifact.expiresAt = "2026-09-05T12:00:00Z"),
    ],
    [
      "registry artifact name",
      (binding) => void (binding.prepublishPluginRegistry.artifact.name = "other-registry"),
    ],
    [
      "registry manifest",
      (binding) => void (binding.prepublishPluginRegistry.manifestSha256 = "6".repeat(64)),
    ],
    ["shared image artifact id", (binding) => void (binding.sharedImage.artifact.id = "107")],
    [
      "shared image artifact digest",
      (binding) => void (binding.sharedImage.artifact.digest = "7".repeat(64)),
    ],
    [
      "shared image artifact expiry",
      (binding) => void (binding.sharedImage.artifact.expiresAt = "2026-09-05T12:00:00Z"),
    ],
    [
      "shared image artifact name",
      (binding) => void (binding.sharedImage.artifact.name = "other-shared-image"),
    ],
    [
      "shared image archive",
      (binding) => void (binding.sharedImage.archiveSha256 = "7".repeat(64)),
    ],
  ] satisfies Array<[string, (binding: CandidateBindingFixture) => void]>)(
    "binds the %s to the manifest digest",
    (_label, mutate) => {
      const binding = structuredClone(fullReleaseCandidateBindingFixture());
      mutate(binding);
      expect(() => validateFullReleaseCandidateBinding(binding)).toThrow(
        "manifestSha256 does not match its manifest fields",
      );
    },
  );

  it("caps binding size independently of manifest digest coverage", () => {
    const binding = fullReleaseCandidateBindingFixture();
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
    expect(runManifestContract(value).stderr).toContain(
      "full release candidate manifest exceeds 32768 bytes",
    );
  });

  it("rejects unsorted or empty producer package evidence", () => {
    const value = manifest();
    expect(
      runManifestContract({
        ...value,
        preparation: {
          ...value.preparation,
          requiredPrepublishPluginPackages: ["openclaw", "@openclaw/codex"],
        },
      }).stderr,
    ).toContain("ascending ASCII order");
    expect(
      runManifestContract({
        ...value,
        preparation: {
          ...value.preparation,
          requiredPrepublishPluginPackages: [],
        },
      }).stderr,
    ).toContain("does not match the request");
  });
});
