import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import {
  artifactDownloadArgs,
  expectedChildDispatches,
  expectedSelectedChildDispatches,
  githubRestArgs,
  manifestChildEntries,
  parseReleaseCiSummaryArgs,
  readManifestArtifactArchive,
  releaseCiWatchFingerprint,
  requiredChildKeysForRerunGroup,
  resolveManifestChildOriginAttempt,
  runReleaseCiGh,
  selectExactChildRun,
  selectExactChildRunFromPages,
  selectManifestArtifact,
  selectManifestParentJob,
  selectedChildKeys,
  validateEvidenceReuseChain,
  validateManifestArtifactCompatibility,
  validateManifestArtifactIdentity,
  validateManifestChildRun,
  validateParentManifest,
  validateParentRunBinding,
  validatePerformanceArtifactOnlyJobs,
  validateReleaseRunEvidence,
  validateTrustedProducerIdentity,
  watchReleaseCiRun,
} from "../../scripts/release-ci-summary.mjs";

const SCRIPT = "scripts/release-ci-summary.mjs";
const MANIFEST_ARTIFACT_ENTRY = "full-release-validation-manifest.json";
const hasUnzip = spawnSync("unzip", ["-v"], { stdio: "ignore" }).status === 0;

describe("GitHub API commands", () => {
  it("delegates authentication to gh for REST and artifact requests", () => {
    expect(githubRestArgs("actions/runs/123", "owner/repo")).toEqual([
      "api",
      "repos/owner/repo/actions/runs/123",
    ]);
    expect(artifactDownloadArgs(456, "owner/repo")).toEqual([
      "api",
      "repos/owner/repo/actions/artifacts/456/zip",
    ]);
  });
});

describe("runReleaseCiGh", () => {
  it("bounds each GitHub lookup with a timeout and SIGKILL", () => {
    const execFileSyncImpl = vi.fn(() => "result");

    expect(
      runReleaseCiGh(["api", "repos/openclaw/openclaw/actions/runs/1"], { execFileSyncImpl }),
    ).toBe("result");
    expect(execFileSyncImpl).toHaveBeenCalledOnce();
    expect(execFileSyncImpl).toHaveBeenCalledWith(
      expect.any(String),
      ["api", "repos/openclaw/openclaw/actions/runs/1"],
      expect.objectContaining({
        encoding: "utf8",
        killSignal: "SIGKILL",
        timeout: 60_000,
      }),
    );
  });

  it("propagates GitHub lookup timeouts", () => {
    const timeoutError = Object.assign(new Error("spawnSync gh ETIMEDOUT"), {
      code: "ETIMEDOUT",
    });
    expect(() =>
      runReleaseCiGh(["api", "rate_limit"], {
        execFileSyncImpl: () => {
          throw timeoutError;
        },
      }),
    ).toThrow(timeoutError);
  });
});

function crc32(input: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of input) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function u16(value: number): Buffer {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16LE(value);
  return buffer;
}

function u32(value: number): Buffer {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
}

function makeStoredZip(files: Record<string, string>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const [name, contents] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name, "utf8");
    const contentsBuffer = Buffer.from(contents, "utf8");
    const checksum = crc32(contentsBuffer);
    const localHeader = Buffer.concat([
      u32(0x04034b50),
      u16(20),
      u16(0),
      u16(0),
      u16(0),
      u16(0),
      u32(checksum),
      u32(contentsBuffer.length),
      u32(contentsBuffer.length),
      u16(nameBuffer.length),
      u16(0),
      nameBuffer,
    ]);
    localParts.push(localHeader, contentsBuffer);
    centralParts.push(
      Buffer.concat([
        u32(0x02014b50),
        u16(20),
        u16(20),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32(checksum),
        u32(contentsBuffer.length),
        u32(contentsBuffer.length),
        u16(nameBuffer.length),
        u16(0),
        u16(0),
        u16(0),
        u16(0),
        u32((0o100644 << 16) >>> 0),
        u32(offset),
        nameBuffer,
      ]),
    );
    offset += localHeader.length + contentsBuffer.length;
  }

  const localData = Buffer.concat(localParts);
  const centralDirectory = Buffer.concat(centralParts);
  return Buffer.concat([
    localData,
    centralDirectory,
    u32(0x06054b50),
    u16(0),
    u16(0),
    u16(Object.keys(files).length),
    u16(Object.keys(files).length),
    u32(centralDirectory.length),
    u32(localData.length),
    u16(0),
  ]);
}

function artifactDigest(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function rawManifest({
  evidenceReuse,
  rerunGroup = "all",
  runId = "29090000000",
  targetSha = "a".repeat(40),
  version = 2,
  workflowFullRef,
  workflowRefType,
  workflowSha,
}: {
  evidenceReuse?: unknown;
  rerunGroup?: string;
  runId?: string;
  targetSha?: string;
  version?: 2 | 3;
  workflowFullRef?: string;
  workflowRefType?: "branch" | "tag";
  workflowSha?: string;
}): {
  childRuns: Record<string, string | { blocking: boolean; conclusion: string; runId: string }>;
  controls: Record<string, unknown>;
  evidenceReuse?: unknown;
  releaseProfile: string;
  rerunGroup: string;
  runAttempt: string;
  runId: string;
  runReleaseSoak: string;
  targetRef?: string;
  targetSha: string;
  validationInputs: Record<string, string>;
  version: 2 | 3;
  workflowFullRef?: string;
  workflowName: string;
  workflowRef: string;
  workflowRefType?: "branch" | "tag";
  workflowSha?: string;
} {
  return {
    childRuns: {
      normalCi: "101",
      npmTelegram: "",
      pluginPrerelease: "202",
      productPerformance: { blocking: true, conclusion: "success", runId: "303" },
      releaseChecks: "404",
    },
    controls: {
      performanceBlocking: true,
      performanceReportPublication: "artifact-only",
      stableSoakRequired: false,
    },
    evidenceReuse,
    releaseProfile: "beta",
    rerunGroup,
    runAttempt: "2",
    runId,
    runReleaseSoak: "false",
    targetSha,
    validationInputs: {
      codexPluginSpec: "",
      crossOsSuiteFilter: "",
      liveSuiteFilter: "",
      mode: "direct",
      packageAcceptancePackageSpec: "",
      provider: "openai",
      releasePackageSpec: "",
      targetContextRef: "",
    },
    version,
    workflowName: "Full Release Validation",
    workflowRef: "main",
    ...(workflowSha ? { workflowSha } : {}),
    ...(version === 3
      ? {
          workflowFullRef: workflowFullRef ?? "refs/heads/main",
          workflowRefType: workflowRefType ?? "branch",
        }
      : {}),
  };
}

function trustedMainPackageFixture({
  manifestVersion = 2,
  parentPath = ".github/workflows/full-release-validation.yml",
  targetSha = "8".repeat(40),
  workflowFullRef,
  workflowRef = "main",
  workflowRefType,
  workflowSha = "0".repeat(40),
}: {
  manifestVersion?: 2 | 3;
  parentPath?: string;
  targetSha?: string;
  workflowFullRef?: string;
  workflowRef?: string;
  workflowRefType?: "branch" | "tag";
  workflowSha?: string;
} = {}) {
  const runId = "29071366025";
  const childRunId = "29071382629";
  const manifest = rawManifest({
    rerunGroup: "package",
    runId,
    targetSha,
    version: manifestVersion,
    workflowFullRef,
    workflowRefType,
    workflowSha,
  });
  manifest.childRuns = {
    normalCi: "",
    npmTelegram: "",
    pluginPrerelease: "",
    productPerformance: { blocking: true, conclusion: "", runId: "" },
    releaseChecks: childRunId,
  };
  manifest.releaseProfile = "full";
  manifest.runAttempt = "1";
  manifest.runReleaseSoak = "true";
  manifest.workflowRef = workflowRef;

  const parentRun = {
    conclusion: "success",
    event: "workflow_dispatch",
    head_branch: workflowRef,
    head_sha: workflowSha,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${runId}`,
    id: Number(runId),
    path: parentPath,
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: 1,
    status: "completed",
  };
  const parentView = {
    attempt: 1,
    conclusion: "success",
    headBranch: workflowRef,
    headSha: workflowSha,
    jobs: [],
    status: "completed",
    url: parentRun.html_url,
  };
  const child = expectedChildDispatches(runId, 1, workflowRef).find(
    (entry) => entry.manifestKey === "releaseChecks",
  );
  if (!child) {
    throw new Error("missing release checks child fixture");
  }
  const parentJob = {
    completed_at: "2026-07-10T01:10:00Z",
    conclusion: "success",
    id: 86293408710,
    name: child.parentJobName,
    run_attempt: 1,
    started_at: "2026-07-10T01:00:00Z",
    status: "completed",
    steps: [],
  };
  const childRun = {
    actor: { login: "github-actions[bot]" },
    conclusion: "success",
    display_title: child.displayTitle,
    event: "workflow_dispatch",
    head_branch: workflowRef,
    head_sha: workflowSha,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${childRunId}`,
    id: Number(childRunId),
    path: ".github/workflows/openclaw-release-checks.yml",
    repository: { full_name: "openclaw/openclaw" },
    run_attempt: 1,
    status: "completed",
    triggering_actor: { login: "github-actions[bot]" },
  };
  const artifact = {
    digest: `sha256:${"9".repeat(64)}`,
    expired: false,
    id: 8220114429,
    name: `full-release-validation-${runId}-1`,
    size_in_bytes: 507,
    workflow_run: {
      head_branch: workflowRef,
      head_sha: workflowSha,
      id: Number(runId),
    },
  };
  const client = {
    compareCommits(base: string, head: string) {
      expect(base).toBe(workflowSha);
      return {
        merge_base_commit: { sha: workflowSha },
        status: base === head ? "identical" : "ahead",
      };
    },
    getJobLog(jobId: number) {
      expect(jobId).toBe(parentJob.id);
      return [
        `TARGET_SHA: ${targetSha}`,
        `Dispatched openclaw-release-checks.yml: ${childRun.html_url}`,
      ].join("\n");
    },
    getParentJobs(requestedRunId: string) {
      expect(requestedRunId).toBe(runId);
      return [parentJob];
    },
    getRun(requestedRunId: string) {
      if (requestedRunId === runId) {
        return parentRun;
      }
      if (requestedRunId === childRunId) {
        return childRun;
      }
      throw new Error(`unexpected run: ${requestedRunId}`);
    },
    getRunView(requestedRunId: string) {
      expect(requestedRunId).toBe(runId);
      return parentView;
    },
    loadManifest(requestedRunId: string, requestedRunAttempt: number) {
      expect(requestedRunId).toBe(runId);
      expect(requestedRunAttempt).toBe(1);
      return { artifact, manifest };
    },
  };

  return { artifact, childRun, client, manifest, parentRun, runId, targetSha, workflowSha };
}

describe("release CI summary child correlation", () => {
  it("parses the reusable strict validation CLI without changing positional summary mode", () => {
    expect(
      parseReleaseCiSummaryArgs([
        "--validate-run",
        "29071366025",
        "--repo",
        "openclaw/openclaw",
        "--manifest",
        "/tmp/manifest.json",
        "--json",
      ]),
    ).toEqual({
      json: true,
      intervalMs: 30_000,
      manifestPath: "/tmp/manifest.json",
      repository: "openclaw/openclaw",
      runId: "29071366025",
      trustedWorkflowRef: "main",
      validate: true,
      verifierSourceFile: undefined,
      verifierSourceSha: undefined,
      watch: false,
    });
    expect(parseReleaseCiSummaryArgs(["29071366025"])).toMatchObject({
      repository: "openclaw/openclaw",
      runId: "29071366025",
      trustedWorkflowRef: "main",
      validate: false,
    });
    expect(parseReleaseCiSummaryArgs(["29071366025", "--watch", "--interval", "15"])).toMatchObject(
      {
        intervalMs: 15_000,
        watch: true,
      },
    );
    expect(() => parseReleaseCiSummaryArgs(["29071366025", "--interval", "0"])).toThrow(
      "positive number of seconds",
    );
    expect(() => parseReleaseCiSummaryArgs(["--validate-run", "29071366025", "--watch"])).toThrow(
      "--watch cannot be combined",
    );
    expect(() => parseReleaseCiSummaryArgs(["--manifest", "/tmp/manifest.json"])).toThrow(
      "--manifest requires --validate-run",
    );
    expect(() =>
      parseReleaseCiSummaryArgs([
        "--validate-run",
        "29071366025",
        "--verifier-source-file",
        "/tmp/verifier.mjs",
      ]),
    ).toThrow("--verifier-source-file requires --verifier-source-sha");
    expect(
      parseReleaseCiSummaryArgs([
        "--validate-run",
        "29071366025",
        "--verifier-source-sha",
        "a".repeat(40),
        "--verifier-source-file",
        "/tmp/verifier.mjs",
      ]),
    ).toMatchObject({
      verifierSourceFile: "/tmp/verifier.mjs",
      verifierSourceSha: "a".repeat(40),
    });
  });

  it("changes the watch fingerprint only for visible run transitions", () => {
    const parent = {
      attempt: 1,
      conclusion: "",
      jobs: [{ name: "Run normal full CI", status: "in_progress", conclusion: "" }],
      status: "in_progress",
      url: "ignored",
    };
    expect(releaseCiWatchFingerprint({ ...parent, url: "changed" })).toBe(
      releaseCiWatchFingerprint(parent),
    );
    expect(
      releaseCiWatchFingerprint({
        ...parent,
        jobs: [{ ...parent.jobs[0], conclusion: "success", status: "completed" }],
      }),
    ).not.toBe(releaseCiWatchFingerprint(parent));
  });

  it("summarizes only transitions while watching a release run", async () => {
    const states = [
      { attempt: 1, conclusion: "", jobs: [], status: "queued" },
      { attempt: 1, conclusion: "", jobs: [], status: "queued" },
      {
        attempt: 1,
        conclusion: "success",
        jobs: [{ name: "Run normal full CI", status: "completed", conclusion: "success" }],
        status: "completed",
      },
    ];
    let index = 0;
    let summaries = 0;
    let sleeps = 0;

    await watchReleaseCiRun(
      parseReleaseCiSummaryArgs(["29071366025", "--watch", "--interval", "1"]),
      {
        fetchParent: () => states[index++],
        sleep: async () => {
          sleeps += 1;
        },
        summarize: () => {
          summaries += 1;
        },
      },
    );

    expect(summaries).toBe(2);
    expect(sleeps).toBe(2);
  });

  it("selects one immutable manifest artifact bound to the exact parent run", () => {
    const { artifact, runId } = trustedMainPackageFixture();
    const legacyArtifact = {
      ...artifact,
      id: artifact.id + 1,
      name: `full-release-validation-${runId}`,
    };
    expect(selectManifestArtifact([artifact], runId, 1)).toBe(artifact);
    expect(selectManifestArtifact([legacyArtifact, artifact], runId, 1)).toBe(artifact);
    expect(selectManifestArtifact([legacyArtifact], runId, 1)).toBe(legacyArtifact);
    expect(validateManifestArtifactCompatibility(legacyArtifact, { version: 2 }, runId, 1)).toBe(
      legacyArtifact,
    );
    expect(
      selectManifestArtifact(
        [{ ...artifact, workflow_run: { ...artifact.workflow_run, id: 1 } }],
        runId,
        1,
      ),
    ).toBeUndefined();
    expect(() =>
      selectManifestArtifact([artifact, { ...artifact, id: artifact.id + 1 }], runId, 1),
    ).toThrow("multiple release validation manifest artifacts");
    expect(() =>
      selectManifestArtifact(
        [legacyArtifact, { ...legacyArtifact, id: legacyArtifact.id + 1 }],
        runId,
        1,
      ),
    ).toThrow("multiple legacy release validation manifest artifacts");
    expect(() => selectManifestArtifact([legacyArtifact], runId, 2)).toThrow(
      "legacy release validation manifest requires run attempt 1",
    );
    expect(() =>
      validateManifestArtifactCompatibility(legacyArtifact, { version: 3 }, runId, 1),
    ).toThrow("legacy release validation manifest artifact is not compatible");
    expect(selectManifestArtifact([artifact], runId, 2)).toBeUndefined();
    expect(() => selectManifestArtifact([{ ...artifact, digest: undefined }], runId, 1)).toThrow(
      "manifest artifact digest is invalid",
    );
    expect(() =>
      validateManifestArtifactIdentity(
        { ...artifact, digest: `sha256:${"8".repeat(64)}` },
        {
          artifactDigest: artifact.digest,
          artifactId: artifact.id,
          runAttempt: 1,
          runId,
        },
      ),
    ).toThrow("manifest artifact identity mismatch");
    expect(() =>
      validateManifestArtifactIdentity(
        { ...artifact, id: artifact.id + 1 },
        {
          artifactDigest: artifact.digest,
          artifactId: artifact.id,
          runAttempt: 1,
          runId,
        },
      ),
    ).toThrow("manifest artifact identity mismatch");

    const source = readFileSync(SCRIPT, "utf8");
    expect(source).toContain("actions/artifacts/${artifactId}/zip");
    expect(source).not.toContain('"--name",');
    expect(source).not.toContain("gh run download");
    expect(source).toContain(
      "downloadParentManifestEvidence(runId, runAttempt, normalizedRepository, manifestPath)",
    );
  });

  it.skipIf(!hasUnzip)(
    "hashes and safely streams one bounded manifest entry from the exact artifact ZIP",
    () => {
      const root = mkdtempSync(join(tmpdir(), "release-manifest-artifact-"));
      try {
        const archivePath = join(root, "manifest.zip");
        const manifest = { runAttempt: 1, runId: "29071366025" };
        const archive = makeStoredZip({
          [MANIFEST_ARTIFACT_ENTRY]: JSON.stringify(manifest),
        });
        writeFileSync(archivePath, archive);
        expect(readManifestArtifactArchive(archivePath, artifactDigest(archive))).toEqual(manifest);
        expect(() => readManifestArtifactArchive(archivePath, `sha256:${"0".repeat(64)}`)).toThrow(
          "artifact digest mismatch",
        );

        const extraEntryArchive = makeStoredZip({
          [MANIFEST_ARTIFACT_ENTRY]: JSON.stringify(manifest),
          "unexpected.json": "{}",
        });
        writeFileSync(archivePath, extraEntryArchive);
        expect(() =>
          readManifestArtifactArchive(archivePath, artifactDigest(extraEntryArchive)),
        ).toThrow(`must contain only ${MANIFEST_ARTIFACT_ENTRY}`);

        const oversizedManifestArchive = makeStoredZip({
          [MANIFEST_ARTIFACT_ENTRY]: "x".repeat(128 * 1024 + 1),
        });
        writeFileSync(archivePath, oversizedManifestArchive);
        expect(() =>
          readManifestArtifactArchive(archivePath, artifactDigest(oversizedManifestArchive)),
        ).toThrow("artifact entry size is invalid");

        const oversizedArchive = Buffer.alloc(256 * 1024 + 1);
        writeFileSync(archivePath, oversizedArchive);
        expect(() =>
          readManifestArtifactArchive(archivePath, artifactDigest(oversizedArchive)),
        ).toThrow("artifact compressed size is invalid");

        const source = readFileSync(SCRIPT, "utf8");
        expect(source).toContain('execFileSync("unzip", ["-p", archivePath');
        expect(source).not.toContain('execFileSync("unzip", ["-q", archivePath, "-d"');
      } finally {
        rmSync(root, { force: true, recursive: true });
      }
    },
  );

  it("bridges only attempt-one manifest v2 artifacts with the legacy stable name", () => {
    const legacyV2 = trustedMainPackageFixture();
    legacyV2.artifact.name = `full-release-validation-${legacyV2.runId}`;
    expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: legacyV2.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        legacyV2.client,
      ).root.artifact.name,
    ).toBe(legacyV2.artifact.name);

    const legacyV3 = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowSha: "a".repeat(40),
    });
    legacyV3.artifact.name = `full-release-validation-${legacyV3.runId}`;
    expect(() =>
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: legacyV3.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        legacyV3.client,
      ),
    ).toThrow("legacy release validation manifest artifact is not compatible");
  });

  it("normalizes a pre-tooling trusted-main producer separately from the current verifier", () => {
    const fixture = trustedMainPackageFixture({
      targetSha: "8".repeat(40),
      workflowSha: "0".repeat(40),
    });
    const verifierSourceSha = "c".repeat(40);
    const evidence = validateReleaseRunEvidence(
      {
        repository: "openclaw/openclaw",
        runId: fixture.runId,
        verifierSourceContent: readFileSync(SCRIPT),
        verifierSourceSha,
      },
      fixture.client,
    );

    expect(evidence).toMatchObject({
      directRoot: true,
      evidenceReuse: null,
      releaseProfile: "full",
      repository: "openclaw/openclaw",
      rerunGroup: "package",
      runReleaseSoak: true,
      schema: "openclaw.release-validation-evidence/v3",
      producerOnTrustedMainLineage: true,
      trustedWorkflowFullRef: "refs/heads/main",
      trustedWorkflowRef: "main",
      valid: true,
      verifier: {
        schemaVersion: 3,
        sourceSha: verifierSourceSha,
      },
    });
    expect(evidence.root).toMatchObject({
      manifestVersion: 2,
      runAttempt: 1,
      runId: fixture.runId,
      targetSha: fixture.targetSha,
      producerOnTrustedMainLineage: true,
      workflowFullRef: "refs/heads/main",
      workflowPath: ".github/workflows/full-release-validation.yml",
      workflowQualifiedPath: ".github/workflows/full-release-validation.yml@refs/heads/main",
      workflowRef: "main",
      workflowRefProof: "legacy-v2-main-ancestry",
      workflowRefType: "branch",
      workflowSha: fixture.workflowSha,
    });
    expect(evidence.root.workflowSha).not.toBe(evidence.root.targetSha);
    expect(evidence.verifier.sourceSha).not.toBe(evidence.root.workflowSha);
    expect(evidence.children).toEqual([
      expect.objectContaining({
        conclusion: "success",
        dispatchNonce: `full-release-validation-${fixture.runId}-1-release-checks`,
        headBranch: "main",
        role: "releaseChecks",
        runAttempt: 1,
        runId: String(fixture.childRun.id),
        sourceParentAttempt: 1,
        workflowSha: fixture.workflowSha,
      }),
    ]);
    expect(evidence.root.artifact).toEqual({
      digest: fixture.artifact.digest,
      id: String(fixture.artifact.id),
      name: fixture.artifact.name,
      runAttempt: 1,
      sizeInBytes: fixture.artifact.size_in_bytes,
    });
  });

  it("accepts a trusted-main producer when the candidate is the same main commit", () => {
    const sharedSha = "a".repeat(40);
    const fixture = trustedMainPackageFixture({
      targetSha: sharedSha,
      workflowSha: sharedSha,
    });
    expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ).root,
    ).toMatchObject({
      targetSha: sharedSha,
      workflowRef: "main",
      workflowSha: sharedSha,
    });
  });

  it("binds v3 producer evidence to the exact trusted branch ref", () => {
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowSha: "a".repeat(40),
    });
    const evidence = validateReleaseRunEvidence(
      {
        repository: "openclaw/openclaw",
        runId: fixture.runId,
        verifierSourceContent: readFileSync(SCRIPT),
        verifierSourceSha: "c".repeat(40),
      },
      fixture.client,
    );
    expect(evidence.root).toMatchObject({
      producerOnTrustedMainLineage: true,
      workflowFullRef: "refs/heads/main",
      workflowRefProof: "manifest-v3-branch",
      workflowRefType: "branch",
      workflowRunPath: ".github/workflows/full-release-validation.yml",
    });
  });

  it("accepts a Unicode trusted workflow ref", () => {
    const workflowRef = "release/unicode-\u{1f4a5}";
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowSha: "a".repeat(40),
    });
    const evidence = validateReleaseRunEvidence(
      {
        repository: "openclaw/openclaw",
        runId: fixture.runId,
        trustedWorkflowRef: workflowRef,
        verifierSourceContent: readFileSync(SCRIPT),
        verifierSourceSha: "c".repeat(40),
      },
      fixture.client,
    );

    expect(evidence.root).toMatchObject({
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
    });
  });

  it("rejects a v3 producer dispatched from a tag named main", () => {
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowFullRef: "refs/tags/main",
      workflowRefType: "tag",
      workflowSha: "a".repeat(40),
    });
    expect(() =>
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).toThrow("producer workflow full ref is not trusted");
  });

  it("rejects a legacy producer outside the trusted main verifier lineage", () => {
    const fixture = trustedMainPackageFixture({ workflowSha: "a".repeat(40) });
    fixture.client.compareCommits = () => ({
      merge_base_commit: { sha: "d".repeat(40) },
      status: "diverged",
    });
    expect(() =>
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).toThrow("producer is not on the trusted main verifier lineage");
  });

  it("rejects a candidate branch producer even when its SHA differs from the target", () => {
    const fixture = trustedMainPackageFixture({
      targetSha: "8".repeat(40),
      workflowRef: "release/2026.7.1",
      workflowSha: "7".repeat(40),
    });
    expect(() =>
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          trustedWorkflowRef: "main",
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).toThrow("producer must run from trusted workflow ref: main");
  });

  it("accepts canonical SHA-pinned v3 evidence on the trusted main lineage", () => {
    const workflowSha = "7".repeat(40);
    const workflowRef = `release-ci/${workflowSha.slice(0, 12)}-1783705000000`;
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      targetSha: "8".repeat(40),
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowSha,
    });
    fixture.manifest.targetRef = fixture.targetSha;

    expect(
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ).root,
    ).toMatchObject({
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowRefProof: "manifest-v3-sha-pinned-main-ancestry",
      workflowSha,
    });
  });

  it.each(["main", "refs/heads/main"])(
    "accepts a REST workflow path qualified with %s",
    (qualifiedRef) => {
      const fixture = trustedMainPackageFixture({
        manifestVersion: 3,
        parentPath: `.github/workflows/full-release-validation.yml@${qualifiedRef}`,
        workflowSha: "7".repeat(40),
      });

      expect(
        validateReleaseRunEvidence(
          {
            repository: "openclaw/openclaw",
            runId: fixture.runId,
            verifierSourceContent: readFileSync(SCRIPT),
            verifierSourceSha: "c".repeat(40),
          },
          fixture.client,
        ).root,
      ).toMatchObject({ workflowFullRef: "refs/heads/main" });
    },
  );

  it("accepts SHA-pinned producer identity with exact-target evidence reuse", () => {
    const workflowSha = "7".repeat(40);
    const workflowRef = `release-ci/${workflowSha.slice(0, 12)}-1783705000000`;
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowSha,
    });
    fixture.manifest.targetRef = fixture.targetSha;
    fixture.manifest.evidenceReuse = {
      changedPaths: [],
      evidenceSha: fixture.targetSha,
      policy: "exact-target-full-validation-v1",
      runId: "29071366024",
      selectedRunId: "29071366024",
    };

    expect(
      validateTrustedProducerIdentity(
        {
          manifest: fixture.manifest,
          parentRun: fixture.parentRun,
        },
        fixture.client,
        { sourceSha: "c".repeat(40) },
        "main",
      ),
    ).toMatchObject({
      producerOnTrustedMainLineage: true,
      workflowRefProof: "manifest-v3-sha-pinned-main-ancestry",
    });
  });

  it("rejects a SHA-pinned evidenceReuse field even when false", () => {
    const workflowSha = "7".repeat(40);
    const workflowRef = `release-ci/${workflowSha.slice(0, 12)}-1783705000000`;
    const fixture = trustedMainPackageFixture({
      manifestVersion: 3,
      workflowFullRef: `refs/heads/${workflowRef}`,
      workflowRef,
      workflowSha,
    });
    fixture.manifest.targetRef = fixture.targetSha;
    fixture.manifest.evidenceReuse = false;

    expect(() =>
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: readFileSync(SCRIPT),
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).toThrow("evidence reuse is invalid");
  });

  it("rejects dirty verifier bytes and a forged verifier source SHA", () => {
    const fixture = trustedMainPackageFixture();
    expect(() =>
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceContent: "different verifier bytes",
          verifierSourceSha: "c".repeat(40),
        },
        fixture.client,
      ),
    ).toThrow("verifier script differs from its source SHA");
    expect(() =>
      validateReleaseRunEvidence(
        {
          repository: "openclaw/openclaw",
          runId: fixture.runId,
          verifierSourceSha: "f".repeat(40),
        },
        fixture.client,
      ),
    ).toThrow("verifier source blob is unavailable");
  });

  it("binds verifier bytes from the repository root even outside the caller cwd", () => {
    const repositoryRoot = mkdtempSync(join(tmpdir(), "release-verifier-repo-"));
    const outsideCwd = mkdtempSync(join(tmpdir(), "release-verifier-cwd-"));
    try {
      const scriptPath = join(repositoryRoot, SCRIPT);
      mkdirSync(dirname(scriptPath), { recursive: true });
      writeFileSync(scriptPath, readFileSync(SCRIPT));
      execFileSync("git", ["init", "-q"], { cwd: repositoryRoot });
      execFileSync("git", ["add", SCRIPT], { cwd: repositoryRoot });
      execFileSync(
        "git",
        [
          "-c",
          "user.name=Release Test",
          "-c",
          "user.email=release-test@example.invalid",
          "-c",
          "commit.gpgSign=false",
          "commit",
          "-qm",
          "test verifier",
        ],
        { cwd: repositoryRoot },
      );
      const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: repositoryRoot,
        encoding: "utf8",
      }).trim();

      const moduleUrl = pathToFileURL(resolve(SCRIPT)).href;
      const output = execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "--eval",
          `import { resolveVerifierIdentity } from ${JSON.stringify(moduleUrl)};
           process.stdout.write(JSON.stringify(resolveVerifierIdentity(
             process.env.SOURCE_SHA,
             undefined,
             process.env.REPOSITORY_ROOT,
           )));`,
        ],
        {
          cwd: outsideCwd,
          encoding: "utf8",
          env: {
            ...process.env,
            REPOSITORY_ROOT: repositoryRoot,
            SOURCE_SHA: sourceSha,
          },
        },
      );
      expect(JSON.parse(output)).toMatchObject({
        script: SCRIPT,
        sourceSha,
      });
    } finally {
      rmSync(repositoryRoot, { force: true, recursive: true });
      rmSync(outsideCwd, { force: true, recursive: true });
    }
  });

  it("binds the parent to the exact Full Release Validation REST run", () => {
    const parentView = {
      attempt: 2,
      headBranch: "main",
      headSha: "a".repeat(40),
    };
    const parentRest = {
      event: "workflow_dispatch",
      head_branch: parentView.headBranch,
      head_sha: parentView.headSha,
      id: 29090000000,
      path: ".github/workflows/full-release-validation.yml@refs/heads/main",
      run_attempt: parentView.attempt,
    };

    expect(validateParentRunBinding(parentView, parentRest, "29090000000")).toBe(parentRest);
    expect(() =>
      validateParentRunBinding(
        parentView,
        { ...parentRest, path: ".github/workflows/openclaw-release-checks.yml" },
        "29090000000",
      ),
    ).toThrow("full release parent run binding mismatch");
  });

  it("derives every child title from the exact parent run and attempt", () => {
    expect(expectedChildDispatches("29090000000", 3, "release/2026.7.1")).toEqual([
      {
        displayTitle: "CI full-release-validation-29090000000-3-ci",
        headBranch: "release/2026.7.1",
        manifestKey: "normalCi",
        name: "CI",
        parentJobName: "Run normal full CI",
        suffix: "-ci",
        trustedRef: "parent",
        workflow: "ci.yml",
      },
      {
        displayTitle:
          "OpenClaw Release Checks full-release-validation-29090000000-3-release-checks",
        headBranch: "release/2026.7.1",
        manifestKey: "releaseChecks",
        name: "OpenClaw Release Checks",
        parentJobName: "Run release/live/Docker/QA validation",
        suffix: "-release-checks",
        trustedRef: "parent",
        workflow: "openclaw-release-checks.yml",
      },
      {
        displayTitle: "Plugin Prerelease full-release-validation-29090000000-3-plugin-prerelease",
        headBranch: "release/2026.7.1",
        manifestKey: "pluginPrerelease",
        name: "Plugin Prerelease",
        parentJobName: "Run plugin prerelease validation",
        suffix: "-plugin-prerelease",
        trustedRef: "parent",
        workflow: "plugin-prerelease.yml",
      },
      {
        displayTitle: "NPM Telegram Beta E2E full-release-validation-29090000000-3-npm-telegram",
        headBranch: "release/2026.7.1",
        manifestKey: "npmTelegram",
        name: "NPM Telegram Beta E2E",
        parentJobName: "Run package Telegram E2E",
        suffix: "-npm-telegram",
        trustedRef: "parent",
        workflow: "npm-telegram-beta-e2e.yml",
      },
      {
        displayTitle: "OpenClaw Performance full-release-validation-29090000000-3",
        headBranch: "release/2026.7.1",
        manifestKey: "productPerformance",
        name: "OpenClaw Performance",
        parentJobName: "Run product performance evidence",
        suffix: "",
        trustedRef: "parent",
        workflow: "openclaw-performance.yml",
      },
    ]);
  });

  it("ignores same-SHA and nearby-name runs without the exact parent dispatch binding", () => {
    const expected = "OpenClaw Performance full-release-validation-29090000000-3";
    const exact = {
      display_title: expected,
      event: "workflow_dispatch",
      head_branch: "main",
      head_sha: "a".repeat(40),
      id: 303,
    };
    expect(
      selectExactChildRun(
        [
          {
            display_title: "OpenClaw Performance",
            event: "workflow_dispatch",
            head_branch: "main",
            head_sha: exact.head_sha,
            id: 101,
          },
          { ...exact, event: "push", id: 202 },
          exact,
        ],
        expected,
        "main",
      ),
    ).toBe(exact);
  });

  it("fails closed on duplicate exact dispatch bindings and ignores branch collisions", () => {
    const expected = "CI full-release-validation-29090000000-3-ci";
    const exact = {
      display_title: expected,
      event: "workflow_dispatch",
      head_branch: "main",
      id: 1,
    };
    expect(
      selectExactChildRun(
        [{ ...exact, head_branch: "release/2026.7.1", id: 0 }, exact],
        expected,
        "main",
      ),
    ).toBe(exact);
    expect(() => selectExactChildRun([exact, { ...exact, id: 2 }], expected, "main")).toThrow(
      "multiple child runs have exact dispatch title and branch",
    );

    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toContain("created_at >= since");
    expect(source).not.toContain("head_sha === parent.headSha");
    expect(source).not.toContain("created:");
    expect(source).toContain("workflow-sha:");
    expect(source).toContain("candidate-sha:");
    expect(source).not.toContain("console.log(`sha:");
    expect(source).toContain("actions/workflows/${child.workflow}/runs");
  });

  it("returns one exact child after a full bounded pagination scan", () => {
    const expected = "OpenClaw Performance full-release-validation-29090000000-3";
    const exact = {
      display_title: expected,
      event: "workflow_dispatch",
      head_branch: "main",
      id: 999,
    };
    const pages = Array.from({ length: 10 }, (_, pageIndex) =>
      Array.from({ length: 100 }, (_unused, runIndex) => ({
        display_title: `decoy-${pageIndex}-${runIndex}`,
        event: "workflow_dispatch",
        head_branch: "main",
        id: pageIndex * 100 + runIndex,
      })),
    );
    expectDefined(pages[9], "last child run page")[99] = exact;

    expect(selectExactChildRunFromPages(pages, expected, "main")).toBe(exact);
    expectDefined(pages[0], "first child run page")[0] = { ...exact, id: 1001 };
    expect(() => selectExactChildRunFromPages(pages, expected, "main")).toThrow(
      "multiple child runs have exact dispatch title and branch",
    );
  });

  it("validates candidate identity and selected child completeness from the parent manifest", () => {
    const manifest = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    expect(manifest.targetSha).toBe("a".repeat(40));
    expect(manifest.rerunGroup).toBe("all");
    const children = expectedChildDispatches(manifest.runId, manifest.runAttempt, "main");
    const selected = requiredChildKeysForRerunGroup(manifest.rerunGroup);
    expect(manifestChildEntries(manifest, children, selected).map((entry) => entry.runId)).toEqual([
      "101",
      "404",
      "202",
      "303",
    ]);

    const missing = {
      ...manifest,
      childRunIds: { ...manifest.childRunIds, normalCi: "" },
    };
    expect(() => manifestChildEntries(missing, children, selected)).toThrow(
      "selected child is missing from manifest: CI",
    );
  });

  it("keeps historical non-reuse v2 manifests readable without validation inputs", () => {
    const legacy = rawManifest({});
    delete (legacy as { validationInputs?: unknown }).validationInputs;
    const manifest = validateParentManifest(legacy, {
      runAttempt: 2,
      runId: "29090000000",
    });

    expect(manifest.validationInputs).toBeUndefined();
    expect(manifest.rerunGroup).toBe("all");
  });

  it("binds v3 manifests to their immutable producer workflow SHA", () => {
    const workflowSha = "b".repeat(40);
    const manifest = validateParentManifest(rawManifest({ version: 3, workflowSha }), {
      runAttempt: 2,
      runId: "29090000000",
      workflowRef: "main",
      workflowSha,
    });
    expect(manifest).toMatchObject({
      version: 3,
      workflowSha,
    });
    expect(() =>
      validateParentManifest(rawManifest({ version: 3, workflowSha }), {
        runAttempt: 2,
        runId: "29090000000",
        workflowSha: "c".repeat(40),
      }),
    ).toThrow("release validation manifest workflow SHA mismatch");
  });

  it("requires v3 manifests to record artifact-only performance publication", () => {
    const workflowSha = "b".repeat(40);
    const missing = rawManifest({ version: 3, workflowSha });
    delete (
      missing.controls as {
        performanceReportPublication?: string;
      }
    ).performanceReportPublication;
    expect(() =>
      validateParentManifest(missing, {
        runAttempt: 2,
        runId: "29090000000",
        workflowSha,
      }),
    ).toThrow("release validation manifest performance report publication mode is invalid");

    const publishing = rawManifest({ version: 3, workflowSha });
    publishing.controls.performanceReportPublication = "publish";
    expect(() =>
      validateParentManifest(publishing, {
        runAttempt: 2,
        runId: "29090000000",
        workflowSha,
      }),
    ).toThrow("release validation manifest performance report publication mode is invalid");
  });

  it("requires a successful artifact-only performance guard for the current attempt", () => {
    const guard = {
      conclusion: "success",
      name: "Verify artifact-only report mode",
      run_attempt: 2,
      status: "completed",
    };
    const skippedPublisher = {
      conclusion: "skipped",
      name: "Publish mock provider report",
      run_attempt: 2,
      status: "completed",
    };
    expect(
      validatePerformanceArtifactOnlyJobs(
        [{ ...guard, conclusion: "failure", run_attempt: 1 }, guard, skippedPublisher],
        2,
      ),
    ).toBe(guard);
    expect(() => validatePerformanceArtifactOnlyJobs([skippedPublisher], 2)).toThrow(
      "performance artifact-only guard is missing or unsuccessful",
    );
    expect(() =>
      validatePerformanceArtifactOnlyJobs([{ ...guard, conclusion: "failure" }], 2),
    ).toThrow("performance artifact-only guard is missing or unsuccessful");
    expect(() =>
      validatePerformanceArtifactOnlyJobs(
        [guard, { ...skippedPublisher, conclusion: "success" }],
        2,
      ),
    ).toThrow("performance report publisher was not skipped");
  });

  it("requires the child mapped by rerunGroup and scans only selected in-progress workflows", () => {
    const focused = validateParentManifest(
      {
        ...rawManifest({ rerunGroup: "npm-telegram" }),
        childRuns: {
          normalCi: "",
          npmTelegram: "",
          pluginPrerelease: "",
          productPerformance: { runId: "" },
          releaseChecks: "",
        },
      },
      { runAttempt: 2, runId: "29090000000" },
    );
    const selected = requiredChildKeysForRerunGroup(focused.rerunGroup);
    const children = expectedSelectedChildDispatches(
      focused.runId,
      focused.runAttempt,
      focused.workflowRef,
      selected,
    );
    expect(children.map((child) => child.manifestKey)).toEqual(["npmTelegram"]);
    expect(() => manifestChildEntries(focused, children, selected)).toThrow(
      "selected child is missing from manifest: NPM Telegram Beta E2E",
    );

    const inProgress = selectedChildKeys([
      { conclusion: "skipped", name: "Run normal full CI" },
      { conclusion: "skipped", name: "Run plugin prerelease validation" },
      { conclusion: undefined, name: "Run product performance evidence" },
      { conclusion: "skipped", name: "Run release/live/Docker/QA validation" },
    ]);
    expect(
      expectedSelectedChildDispatches("29090000000", 2, "main", inProgress).map(
        (child) => child.manifestKey,
      ),
    ).toEqual(["productPerformance"]);
  });

  it("authorizes only exact-target reuse through the selected root manifest", () => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    const current = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: root.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: root.targetSha,
      }),
      { runAttempt: 2, runId: "29090000001" },
    );

    expect(validateEvidenceReuseChain(current, root, root)).toBe(root.targetSha);
    expect(current.targetSha).toBe(root.targetSha);
  });

  it("accepts a verified changelog-only release delta", () => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    const changedPaths = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: ["CHANGELOG.md"],
          evidenceSha: root.targetSha,
          policy: "changelog-only-release-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: "b".repeat(40),
      }),
      { runAttempt: 2, runId: "29090000001" },
    );
    expect(
      validateEvidenceReuseChain(changedPaths, root, root, (base: string, head: string) => ({
        files: [{ filename: "CHANGELOG.md", status: "modified" }],
        merge_base_commit: { sha: base },
        status: head === changedPaths.targetSha ? "ahead" : "diverged",
      })),
    ).toBe(root.targetSha);
  });

  it("rejects unverified changed paths and cross-SHA exact-target reuse", () => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    const changedPaths = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: ["CHANGELOG.md"],
          evidenceSha: root.targetSha,
          policy: "changelog-only-release-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: "b".repeat(40),
      }),
      { runAttempt: 2, runId: "29090000001" },
    );
    expect(() =>
      validateEvidenceReuseChain(changedPaths, root, root, (base: string) => ({
        files: [{ filename: "src/index.ts" }],
        merge_base_commit: { sha: base },
        status: "ahead",
      })),
    ).toThrow("failed commit comparison");

    expect(() =>
      validateEvidenceReuseChain(changedPaths, root, root, (base: string) => ({
        files: [
          {
            filename: "CHANGELOG.md",
            previous_filename: "src/index.ts",
            status: "renamed",
          },
        ],
        merge_base_commit: { sha: base },
        status: "ahead",
      })),
    ).toThrow("failed commit comparison");

    const changedTarget = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: root.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: "b".repeat(40),
      }),
      { runAttempt: 2, runId: "29090000001" },
    );
    expect(() => validateEvidenceReuseChain(changedTarget, root, root)).toThrow(
      "exact-target release evidence reuse requires no changed paths",
    );
  });

  it("rejects exact-target reuse without matching root policy and authorization", () => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    const current = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: root.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: root.targetSha,
      }),
      { runAttempt: 2, runId: "29090000001" },
    );
    const mismatchedRoot = {
      ...root,
      validationInputs: { ...root.validationInputs, provider: "anthropic" },
    };

    expect(() => validateEvidenceReuseChain(current, mismatchedRoot, mismatchedRoot)).toThrow(
      "evidence reuse current manifest policy differs from the chain root",
    );
    expect(() =>
      validateEvidenceReuseChain({ ...current, evidenceReuse: undefined }, root, root),
    ).toThrow("does not authorize evidence reuse");
  });

  it("rejects any selected manifest that itself reuses evidence", () => {
    const root = validateParentManifest(rawManifest({}), {
      runAttempt: 2,
      runId: "29090000000",
    });
    const intermediate = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: root.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: root.runId,
          selectedRunId: root.runId,
        },
        runId: "29090000001",
        targetSha: root.targetSha,
      }),
      { runAttempt: 2, runId: "29090000001" },
    );
    const current = validateParentManifest(
      rawManifest({
        evidenceReuse: {
          changedPaths: [],
          evidenceSha: intermediate.targetSha,
          policy: "exact-target-full-validation-v1",
          runId: root.runId,
          selectedRunId: intermediate.runId,
        },
        runId: "29090000002",
        targetSha: intermediate.targetSha,
      }),
      { runAttempt: 2, runId: "29090000002" },
    );

    expect(() => validateEvidenceReuseChain(current, intermediate, root)).toThrow(
      "evidence reuse must select a root execution manifest",
    );
  });

  it("binds each manifest workflow ref to the fetched parent branch", () => {
    expect(() =>
      validateParentManifest(rawManifest({}), {
        runAttempt: 2,
        runId: "29090000000",
        workflowRef: "release/2026.7.1",
      }),
    ).toThrow("release validation manifest workflow ref mismatch");
  });

  it("validates manifest child workflow, dispatch tuple, branch, and attempt", () => {
    const child = expectDefined(
      expectedChildDispatches("29090000000", 3, "main")[0],
      "expected CI child dispatch",
    );
    const parentManifest = {
      runAttempt: 3,
      runId: "29090000000",
      targetSha: "a".repeat(40),
      workflowSha: "b".repeat(40),
    };
    const parentJobs = [
      {
        completed_at: "2026-07-10T01:10:00Z",
        conclusion: "success",
        id: 901,
        name: child.parentJobName,
        run_attempt: 3,
        started_at: "2026-07-10T01:00:00Z",
        status: "completed",
        steps: [],
      },
    ];
    const parentLog = [
      `TARGET_SHA: ${parentManifest.targetSha}`,
      "Dispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/101",
    ].join("\n");
    const run = {
      actor: { login: "github-actions[bot]" },
      display_title: child.displayTitle,
      event: "workflow_dispatch",
      head_branch: child.headBranch,
      head_sha: parentManifest.workflowSha,
      id: 101,
      path: ".github/workflows/ci.yml@refs/heads/main",
      run_attempt: 1,
      triggering_actor: { login: "github-actions[bot]" },
    };
    expect(validateManifestChildRun(run, child, "101", parentManifest, parentJobs, parentLog)).toBe(
      run,
    );
    expect(() =>
      validateManifestChildRun(
        { ...run, head_branch: "release/2026.7.1" },
        child,
        "101",
        parentManifest,
        parentJobs,
        parentLog,
      ),
    ).toThrow("manifest child dispatch tuple mismatch");
    expect(() =>
      validateParentManifest(rawManifest({}), { runAttempt: 3, runId: "29090000000" }),
    ).toThrow("release validation manifest run attempt mismatch");
  });

  it("accepts strongly bound legacy and correlated children across parent attempts", () => {
    const parentManifest = {
      runAttempt: 2,
      runId: "28717729503",
      targetSha: "a".repeat(40),
      workflowSha: "b".repeat(40),
    };
    const children = expectedChildDispatches(
      parentManifest.runId,
      parentManifest.runAttempt,
      "main",
    );
    const fixtures = new Map([
      ["normalCi", { originAttempt: 2, runId: 28718903263, title: "CI" }],
      ["pluginPrerelease", { originAttempt: 1, runId: 28717802268, title: "Plugin Prerelease" }],
      [
        "productPerformance",
        {
          originAttempt: 1,
          runId: 28717802171,
          title: "OpenClaw Performance full-release-validation-28717729503-1",
        },
      ],
      ["releaseChecks", { originAttempt: 1, runId: 28717802397, title: "OpenClaw Release Checks" }],
    ]);
    const fingerprint = {
      completed_at: "2026-07-04T20:29:21Z",
      conclusion: "success",
      started_at: "2026-07-04T19:53:02Z",
      status: "completed",
      steps: [
        {
          completed_at: "2026-07-04T20:29:20Z",
          conclusion: "success",
          name: "Dispatch and monitor child",
          number: 1,
          started_at: "2026-07-04T19:53:03Z",
          status: "completed",
        },
      ],
    };

    for (const child of children.filter((entry) => fixtures.has(entry.manifestKey))) {
      const fixture = fixtures.get(child.manifestKey);
      if (!fixture) {
        throw new Error(`missing fixture for ${child.manifestKey}`);
      }
      const { originAttempt, runId, title } = fixture;
      const parentJobs = [
        ...(originAttempt === 1
          ? [
              {
                ...fingerprint,
                id: 900,
                name: child.parentJobName,
                run_attempt: 1,
              },
            ]
          : []),
        {
          ...fingerprint,
          id: 901,
          name: child.parentJobName,
          run_attempt: 2,
        },
      ];
      const run = {
        actor: { login: "github-actions[bot]" },
        display_title: title,
        event: "workflow_dispatch",
        head_branch: child.headBranch,
        head_sha: parentManifest.workflowSha,
        id: runId,
        path: `.github/workflows/${child.workflow}@refs/heads/${child.headBranch}`,
        run_attempt: 1,
        triggering_actor: { login: "github-actions[bot]" },
      };
      const parentLog = [
        `TARGET_SHA: ${parentManifest.targetSha}`,
        ...(child.manifestKey === "productPerformance" ? ["-f publish_reports=false"] : []),
        `Dispatched ${child.workflow}: https://github.com/openclaw/openclaw/actions/runs/${runId}`,
      ].join("\n");
      expect(resolveManifestChildOriginAttempt(run, child, parentManifest, parentJobs)).toBe(
        originAttempt,
      );
      expect(
        validateManifestChildRun(run, child, String(runId), parentManifest, parentJobs, parentLog),
      ).toBe(run);
      if (child.manifestKey === "productPerformance") {
        expect(() =>
          validateManifestChildRun(
            run,
            child,
            String(runId),
            parentManifest,
            parentJobs,
            parentLog.replace("-f publish_reports=false\n", ""),
          ),
        ).toThrow("manifest performance child is not dispatched in artifact-only mode");
      }
    }

    const ci = children.find((child) => child.manifestKey === "normalCi");
    if (!ci) {
      throw new Error("missing CI child fixture");
    }
    const wrongParent = {
      display_title: `CI full-release-validation-28717729504-1-ci`,
      event: "workflow_dispatch",
      head_branch: "main",
      id: 101,
      path: ".github/workflows/ci.yml@refs/heads/main",
    };
    const ciJobs = [
      {
        ...fingerprint,
        id: 901,
        name: ci.parentJobName,
        run_attempt: 2,
      },
    ];
    const ciLog = [
      `TARGET_SHA: ${parentManifest.targetSha}`,
      "Dispatched ci.yml: https://github.com/openclaw/openclaw/actions/runs/101",
    ].join("\n");
    expect(() =>
      validateManifestChildRun(wrongParent, ci, "101", parentManifest, ciJobs, ciLog),
    ).toThrow("manifest child dispatch tuple mismatch");
    expect(() =>
      validateManifestChildRun(
        {
          ...wrongParent,
          display_title: `CI full-release-validation-${parentManifest.runId}-3-ci`,
        },
        ci,
        "101",
        parentManifest,
        ciJobs,
        ciLog,
      ),
    ).toThrow("manifest child dispatch tuple mismatch");
    expect(
      resolveManifestChildOriginAttempt({ display_title: "CI nearby" }, ci, parentManifest, ciJobs),
    ).toBeUndefined();
  });

  it("rejects carried parent jobs whose selected-attempt execution fingerprint changed", () => {
    const child = expectedChildDispatches("28717729503", 2, "main").find(
      (entry) => entry.manifestKey === "pluginPrerelease",
    );
    if (!child) {
      throw new Error("missing plugin prerelease fixture");
    }
    const parentManifest = { runAttempt: 2, runId: "28717729503" };
    const parentJobs = [
      {
        completed_at: "2026-07-04T20:29:21Z",
        conclusion: "success",
        id: 900,
        name: child.parentJobName,
        run_attempt: 1,
        started_at: "2026-07-04T19:53:02Z",
        status: "completed",
        steps: [],
      },
      {
        completed_at: "2026-07-04T20:30:21Z",
        conclusion: "success",
        id: 901,
        name: child.parentJobName,
        run_attempt: 2,
        started_at: "2026-07-04T19:53:02Z",
        status: "completed",
        steps: [],
      },
    ];

    expect(() => selectManifestParentJob(parentJobs, child, parentManifest, 1)).toThrow(
      "manifest parent job carry-forward fingerprint mismatch",
    );
  });
});
