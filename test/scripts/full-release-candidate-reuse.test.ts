import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import JSZip from "jszip";
import { afterEach, describe, expect, it } from "vitest";
import { downloadExactActionsArtifactArchive } from "../../scripts/lib/actions-artifact-archive.mjs";
import {
  candidateArtifactJsonFromBinding,
  loadSelectedFullReleaseCandidate,
  resolveCandidateBinding,
  selectTrustedFullReleaseCandidate,
  verifySealedFullReleaseCandidate,
} from "../../scripts/lib/full-release-candidate-reuse.mjs";
import {
  canonicalTestJson,
  fullReleaseCandidateBindingFixture,
  fullReleaseCandidateManifestFixture,
  fullReleaseCandidateRequestInput,
} from "../helpers/full-release-candidate.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const NOW = Date.parse("2026-08-28T12:00:00Z");
const EXPIRES_AT = "2026-09-04T12:00:00Z";
const REPOSITORY = "openclaw/openclaw";
const CONTRACT_SCRIPT = resolve("scripts/full-release-candidate-contract.mjs");
const SCRIPT = resolve("scripts/full-release-candidate-reuse.mjs");
const WORKFLOW_PATH = ".github/workflows/full-release-validation.yml";
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function archiveWithManifest(value: unknown): Promise<Buffer> {
  const zip = new JSZip();
  zip.file(
    "full-release-candidate.json",
    typeof value === "string" ? value : canonicalTestJson(value),
    { date: new Date("2026-08-28T00:00:00Z") },
  );
  return zip.generateAsync({
    compression: "STORE",
    platform: "UNIX",
    type: "nodebuffer",
  });
}

function workflowRun(runId = 77, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    conclusion: "failure",
    event: "workflow_dispatch",
    head_branch: "release-ci/tooling",
    head_repository: { full_name: REPOSITORY, id: 1 },
    head_sha: "b".repeat(40),
    id: runId,
    path: `${WORKFLOW_PATH}@refs/heads/release-ci/tooling`,
    repository: { full_name: REPOSITORY, id: 1 },
    run_attempt: 1,
    status: "completed",
    ...overrides,
  };
}

function workflowJobs(
  manifest = fullReleaseCandidateManifestFixture(),
  overrides: { runAttempt?: number; runId?: number } = {},
) {
  const runAttempt = overrides.runAttempt ?? Number(manifest.producer.runAttempt);
  const runId = overrides.runId ?? Number(manifest.producer.runId);
  return {
    jobs: [
      {
        conclusion: "success",
        head_sha: manifest.producer.workflowSha,
        id: Number(manifest.producer.jobId),
        name: manifest.producer.jobName,
        run_attempt: runAttempt,
        run_id: runId,
        status: "completed",
      },
      {
        conclusion: "success",
        head_sha: manifest.publisher.workflowSha,
        id: Number(manifest.publisher.jobId),
        name: manifest.publisher.jobName,
        run_attempt: runAttempt,
        run_id: runId,
        status: "completed",
      },
    ],
    total_count: 2,
  };
}

function artifactMetadata(
  archive: Buffer,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const manifest = fullReleaseCandidateManifestFixture();
  return {
    created_at: "2026-08-28T10:00:00Z",
    digest: `sha256:${sha256(archive)}`,
    expired: false,
    expires_at: EXPIRES_AT,
    id: 301,
    name: `full-release-candidate-v2-${manifest.requestSha256}`,
    size_in_bytes: archive.length,
    workflow_run: {
      head_repository_id: 1,
      head_sha: manifest.request.toolingSha,
      id: 77,
      repository_id: 1,
    },
    ...overrides,
  };
}

type CandidateManifestFixture = ReturnType<typeof fullReleaseCandidateManifestFixture>;
type CandidateArtifactFixture = CandidateManifestFixture["package"]["artifact"];
type CandidateConstituentSource = Pick<
  CandidateManifestFixture,
  "package" | "prepublishPluginRegistry" | "producer" | "sharedImage"
>;

function constituentArtifactMetadata(
  artifact: CandidateArtifactFixture,
  workflowSha: string,
): Record<string, unknown> {
  return {
    digest: `sha256:${artifact.digest}`,
    expired: false,
    expires_at: artifact.expiresAt,
    id: Number(artifact.id),
    name: artifact.name,
    workflow_run: {
      head_sha: workflowSha,
      id: Number(artifact.runId),
    },
  };
}

function constituentArtifactReader(manifest: CandidateConstituentSource) {
  const artifacts = [
    manifest.package.artifact,
    manifest.prepublishPluginRegistry.artifact,
    manifest.sharedImage.artifact,
  ];
  return async (artifactId: string) => {
    const artifact = artifacts.find((entry) => entry.id === artifactId);
    if (!artifact) {
      throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
    }
    return constituentArtifactMetadata(artifact, manifest.producer.workflowSha);
  };
}

async function fixture() {
  const manifest = fullReleaseCandidateManifestFixture();
  const archive = await archiveWithManifest(manifest);
  return {
    archive,
    manifest,
    metadata: artifactMetadata(archive),
  };
}

describe("trusted full release candidate selection", () => {
  it("treats malformed metadata and workflow provenance as misses before selection", async () => {
    const { archive, manifest, metadata } = await fixture();
    let runReads = 0;
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [
        { ...metadata, name: "wrong" },
        { ...metadata, digest: "" },
        { ...metadata, expired: true },
        { ...metadata, expires_at: "2026-08-28T11:59:59Z" },
        { ...metadata, expires_at: "2026-08-28T13:59:59Z" },
        {
          ...artifactMetadata(archive, { id: 302 }),
          workflow_run: {
            head_repository_id: 2,
            head_sha: manifest.request.toolingSha,
            id: 78,
            repository_id: 1,
          },
        },
        {
          ...artifactMetadata(archive, { id: 303 }),
          workflow_run: {
            head_repository_id: 1,
            head_sha: "9".repeat(40),
            id: 79,
            repository_id: 1,
          },
        },
      ],
      now: NOW,
      readWorkflowRun: async () => {
        runReads += 1;
        return workflowRun();
      },
      readWorkflowJobs: async () => {
        throw new Error("workflow jobs must not be read");
      },
      request: manifest.request,
    });
    expect(selected).toBeNull();
    expect(runReads).toBe(0);
  });

  it("orders candidates by newest creation time then descending numeric artifact ID", async () => {
    const { archive, manifest } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [
        artifactMetadata(archive, { id: 9 }),
        artifactMetadata(archive, { id: 10 }),
        artifactMetadata(archive, { created_at: "2026-08-28T09:00:00Z", id: 99 }),
      ],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(10);
  });

  it("accepts an active trusted parent after its publisher job succeeds", async () => {
    const { manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(77, { conclusion: null, status: "in_progress" }),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(301);
  });

  it("requires enough remaining lifetime for the longest release-validation drain", async () => {
    const { archive, manifest } = await fixture();
    const tooShort = artifactMetadata(archive, {
      expires_at: new Date(NOW + 13 * 60 * 60 * 1000).toISOString(),
    });
    const longEnough = artifactMetadata(archive, {
      expires_at: new Date(NOW + 15 * 60 * 60 * 1000).toISOString(),
      id: 302,
    });
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [tooShort, longEnough],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(302);
  });

  it("stops provenance reads when the discovery deadline is exhausted", async () => {
    const { manifest, metadata } = await fixture();
    let reads = 0;
    await expect(
      selectTrustedFullReleaseCandidate({
        artifacts: [metadata],
        deadlineMs: Date.now() - 1,
        now: NOW,
        readWorkflowRun: async () => {
          reads += 1;
          return workflowRun();
        },
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
      }),
    ).rejects.toThrow("candidate discovery exceeded its time budget");
    expect(reads).toBe(0);
  });

  it("skips an artifact whose trusted publisher job did not succeed", async () => {
    const { archive, manifest, metadata } = await fixture();
    const newest = artifactMetadata(archive, {
      created_at: "2026-08-28T11:00:00Z",
      id: 302,
      workflow_run: {
        head_repository_id: 1,
        head_sha: manifest.request.toolingSha,
        id: 78,
        repository_id: 1,
      },
    });
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata, newest],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async (runId) => {
        const jobs = workflowJobs(manifest, { runId });
        if (runId === 78) {
          jobs.jobs[1]!.conclusion = "failure";
        }
        return jobs;
      },
      request: manifest.request,
    });
    expect(selected?.artifact.id).toBe(301);
  });

  it("skips a trust miss but never falls back after selecting malformed evidence", async () => {
    const { manifest, metadata } = await fixture();
    const malformedArchive = await archiveWithManifest("{");
    const newest = artifactMetadata(malformedArchive, {
      created_at: "2026-08-28T11:00:00Z",
      id: 302,
      workflow_run: {
        head_repository_id: 1,
        head_sha: manifest.request.toolingSha,
        id: 78,
        repository_id: 1,
      },
    });
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata, newest],
      now: NOW,
      readWorkflowRun: async (runId) => workflowRun(runId),
      readWorkflowJobs: async (runId) => workflowJobs(manifest, { runId }),
      request: manifest.request,
    });
    const downloads: number[] = [];
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async ({ expected }) => {
          downloads.push((expected as { artifactId: number }).artifactId);
          return { archiveBytes: malformedArchive, artifactMetadata: newest };
        },
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async () => workflowRun(78),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("manifest input is invalid JSON");
    expect(downloads).toEqual([302]);
  });
});

describe("full release candidate discovery CLI", () => {
  it("preserves canonical request arrays when checking the expected digest", () => {
    const root = tempDirs.make("full-release-candidate-canonical-");
    const bin = join(root, "bin");
    const rawInputPath = join(root, "raw-request-input.json");
    const requestPath = join(root, "request.json");
    const outputPath = join(root, "github-output");
    const callLogPath = join(root, "gh-calls");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
printf '%s\n' "$*" >> "$FAKE_GH_CALL_LOG"
printf '%s\n' '{"artifacts":[]}'
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(
      rawInputPath,
      JSON.stringify(
        fullReleaseCandidateRequestInput({
          upgradeSurvivorBaselines: "openclaw@latest",
          upgradeSurvivorScenarios: "base",
        }),
      ),
    );
    const contractResult = spawnSync(
      process.execPath,
      [CONTRACT_SCRIPT, "request", "--input", rawInputPath, "--output", requestPath],
      { encoding: "utf8", timeout: 10_000 },
    );
    expect(contractResult.status, contractResult.stderr).toBe(0);
    const contract = JSON.parse(contractResult.stdout) as {
      requestJson: string;
      requestSha256: string;
    };
    const requestBeforeDiscovery = readFileSync(requestPath, "utf8");
    const request = JSON.parse(requestBeforeDiscovery) as {
      upgradeSurvivorBaselines: string[];
      upgradeSurvivorScenarios: string[];
    };
    expect(request.upgradeSurvivorBaselines).toEqual(["openclaw@latest"]);
    expect(request.upgradeSurvivorScenarios).toEqual(["base"]);

    const result = spawnSync(
      process.execPath,
      [
        SCRIPT,
        "discover",
        "--request-input",
        requestPath,
        "--expected-request-sha256",
        contract.requestSha256,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          FAKE_GH_CALL_LOG: callLogPath,
          GH_TOKEN: "test-token",
          GITHUB_OUTPUT: outputPath,
          PATH: `${bin}:${process.env.PATH}`,
        },
        timeout: 10_000,
      },
    );
    expect(result.status, result.stderr).toBe(0);
    const outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
    expect(outputs).toMatchObject({
      request_json: contract.requestJson,
      request_sha256: contract.requestSha256,
      reused: "false",
      state: "miss",
    });
    expect(readFileSync(requestPath, "utf8")).toBe(requestBeforeDiscovery);
    expect(readFileSync(callLogPath, "utf8").trim()).toBe(
      `api repos/${REPOSITORY}/actions/artifacts?name=full-release-candidate-v2-${contract.requestSha256}&per_page=100&page=1`,
    );
  });

  it("marks exhausted transient reads unavailable instead of permitting preparation", () => {
    const root = tempDirs.make("full-release-candidate-discovery-");
    const bin = join(root, "bin");
    const countPath = join(root, "gh-count");
    const inputPath = join(root, "request-input.json");
    const outputPath = join(root, "github-output");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
count=0
if [ -f "$FAKE_GH_COUNT" ]; then count="$(cat "$FAKE_GH_COUNT")"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_GH_COUNT"
echo "HTTP 502: transient candidate lookup failure" >&2
exit 1
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateManifestFixture().request));
    const result = spawnSync(process.execPath, [SCRIPT, "discover", "--request-input", inputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_COUNT: countPath,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(countPath, "utf8").trim()).toBe("2");
    expect(readFileSync(outputPath, "utf8")).toContain(
      "reuse_reason=candidate discovery unavailable after bounded retries",
    );
    expect(readFileSync(outputPath, "utf8")).toContain("state=unavailable");
    expect(readFileSync(outputPath, "utf8")).toContain("reused=false");
  });

  it("marks bounded artifact inventory exhaustion unavailable instead of permitting preparation", () => {
    const root = tempDirs.make("full-release-candidate-inventory-");
    const bin = join(root, "bin");
    const countPath = join(root, "gh-count");
    const inputPath = join(root, "request-input.json");
    const outputPath = join(root, "github-output");
    const payloadPath = join(root, "artifacts.json");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
count=0
if [ -f "$FAKE_GH_COUNT" ]; then count="$(cat "$FAKE_GH_COUNT")"; fi
count=$((count + 1))
printf '%s\\n' "$count" > "$FAKE_GH_COUNT"
cat "$FAKE_GH_PAYLOAD"
`,
    );
    chmodSync(ghPath, 0o755);
    writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateManifestFixture().request));
    writeFileSync(
      payloadPath,
      JSON.stringify({ artifacts: Array.from({ length: 100 }, () => ({})) }),
    );
    const result = spawnSync(process.execPath, [SCRIPT, "discover", "--request-input", inputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_COUNT: countPath,
        FAKE_GH_PAYLOAD: payloadPath,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(countPath, "utf8").trim()).toBe("10");
    expect(readFileSync(outputPath, "utf8")).toContain(
      "reuse_reason=candidate artifact inventory exceeded the bounded scan",
    );
    expect(readFileSync(outputPath, "utf8")).toContain("state=unavailable");
    expect(readFileSync(outputPath, "utf8")).toContain("reused=false");
  });

  it("marks bounded candidate evaluation unavailable when older candidates remain", async () => {
    const root = tempDirs.make("full-release-candidate-evaluation-");
    const bin = join(root, "bin");
    const responses = join(root, "responses");
    const callLogPath = join(root, "gh-calls");
    const inputPath = join(root, "request-input.json");
    const outputPath = join(root, "github-output");
    const artifactListingPath = join(root, "artifacts.json");
    mkdirSync(bin);
    mkdirSync(responses);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_CALL_LOG"
case "$*" in
  *"actions/artifacts?name="*) cat "$FAKE_GH_ARTIFACT_LISTING" ;;
  *"/jobs?filter=all"*)
    run_id="$(printf '%s' "$*" | sed -E 's#.*actions/runs/([0-9]+)/jobs.*#\\1#')"
    cat "$FAKE_GH_RESPONSES/jobs-$run_id.json"
    ;;
  *"actions/runs/"*)
    run_id="$(printf '%s' "$*" | sed -E 's#.*actions/runs/([0-9]+).*#\\1#')"
    cat "$FAKE_GH_RESPONSES/run-$run_id.json"
    ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 2
    ;;
esac
`,
    );
    chmodSync(ghPath, 0o755);
    const { archive, manifest } = await fixture();
    const artifacts = Array.from({ length: 6 }, (_, index) => {
      const runId = 80 + index;
      const jobs = workflowJobs(manifest, { runId });
      jobs.jobs[1]!.conclusion = runId === 85 ? "success" : "failure";
      writeFileSync(join(responses, `run-${runId}.json`), JSON.stringify(workflowRun(runId)));
      writeFileSync(join(responses, `jobs-${runId}.json`), JSON.stringify([jobs]));
      return artifactMetadata(archive, {
        created_at: new Date(NOW - index * 1000).toISOString(),
        id: 400 + index,
        workflow_run: {
          head_repository_id: 1,
          head_sha: manifest.request.toolingSha,
          id: runId,
          repository_id: 1,
        },
      });
    });
    writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateManifestFixture().request));
    writeFileSync(artifactListingPath, JSON.stringify({ artifacts }));
    const result = spawnSync(process.execPath, [SCRIPT, "discover", "--request-input", inputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_GH_ARTIFACT_LISTING: artifactListingPath,
        FAKE_GH_CALL_LOG: callLogPath,
        FAKE_GH_RESPONSES: responses,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain(
      "reuse_reason=candidate evaluation exceeded the bounded scan",
    );
    expect(readFileSync(outputPath, "utf8")).toContain("state=unavailable");
    expect(readFileSync(outputPath, "utf8")).not.toContain("state=miss");
    expect(readFileSync(outputPath, "utf8")).toContain("reused=false");
    const candidateCalls = readFileSync(callLogPath, "utf8")
      .trim()
      .split("\n")
      .filter((line) => line.includes("actions/runs/"));
    expect(candidateCalls).toEqual(
      [80, 81, 82, 83, 84].flatMap((runId) => [
        `api repos/${REPOSITORY}/actions/runs/${runId}`,
        `api --paginate --slurp repos/${REPOSITORY}/actions/runs/${runId}/jobs?filter=all&per_page=100`,
      ]),
    );
    expect(candidateCalls.join("\n")).not.toContain("actions/runs/85");
  });

  it("marks a selected candidate with a missing constituent unavailable", async () => {
    const root = tempDirs.make("full-release-candidate-selected-missing-");
    const bin = join(root, "bin");
    const inputPath = join(root, "request-input.json");
    const outputPath = join(root, "github-output");
    const archivePath = join(root, "candidate.zip");
    const artifactListingPath = join(root, "artifacts.json");
    const workflowRunPath = join(root, "workflow-run.json");
    const workflowJobsPath = join(root, "workflow-jobs.json");
    const artifactMetadataPath = join(root, "artifact-metadata.json");
    const fetchPreloadPath = join(root, "fetch-preload.mjs");
    mkdirSync(bin);
    const ghPath = join(bin, "gh");
    writeFileSync(
      ghPath,
      `#!/bin/sh
case "$*" in
  *"actions/artifacts?name="*) cat "$FAKE_GH_ARTIFACT_LISTING" ;;
  *"actions/runs/77/jobs?filter=all"*) cat "$FAKE_GH_WORKFLOW_JOBS" ;;
  *"actions/runs/77"*) cat "$FAKE_GH_WORKFLOW_RUN" ;;
  *"actions/artifacts/101"*)
    echo "HTTP 404: candidate constituent artifact missing" >&2
    exit 1
    ;;
  *)
    echo "unexpected gh invocation: $*" >&2
    exit 2
    ;;
esac
`,
    );
    chmodSync(ghPath, 0o755);
    const { archive, manifest, metadata } = await fixture();
    writeFileSync(inputPath, JSON.stringify(fullReleaseCandidateManifestFixture().request));
    writeFileSync(archivePath, archive);
    writeFileSync(artifactListingPath, JSON.stringify({ artifacts: [metadata] }));
    writeFileSync(workflowRunPath, JSON.stringify(workflowRun()));
    writeFileSync(workflowJobsPath, JSON.stringify([workflowJobs(manifest)]));
    writeFileSync(artifactMetadataPath, JSON.stringify(metadata));
    writeFileSync(
      fetchPreloadPath,
      `import { readFileSync } from "node:fs";
const archive = readFileSync(process.env.FAKE_ARTIFACT_ARCHIVE);
const metadata = JSON.parse(readFileSync(process.env.FAKE_ARTIFACT_METADATA, "utf8"));
globalThis.fetch = async (url) => {
  const value = String(url);
  if (value.endsWith("/actions/artifacts/301")) {
    return new Response(JSON.stringify(metadata), {
      headers: { "content-type": "application/json" },
      status: 200,
    });
  }
  if (value.endsWith("/actions/artifacts/301/zip")) {
    return new Response(archive, { status: 200 });
  }
  throw new Error(\`unexpected fetch: \${value}\`);
};
`,
    );
    const result = spawnSync(process.execPath, [SCRIPT, "discover", "--request-input", inputPath], {
      encoding: "utf8",
      env: {
        ...process.env,
        FAKE_ARTIFACT_ARCHIVE: archivePath,
        FAKE_ARTIFACT_METADATA: artifactMetadataPath,
        FAKE_GH_ARTIFACT_LISTING: artifactListingPath,
        FAKE_GH_WORKFLOW_JOBS: workflowJobsPath,
        FAKE_GH_WORKFLOW_RUN: workflowRunPath,
        GH_TOKEN: "test-token",
        GITHUB_OUTPUT: outputPath,
        NODE_OPTIONS: `--import=${pathToFileURL(fetchPreloadPath).href}`,
        PATH: `${bin}:${process.env.PATH}`,
      },
      timeout: 10_000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(readFileSync(outputPath, "utf8")).toContain(
      "reuse_reason=full release candidate package artifact is unavailable",
    );
    expect(readFileSync(outputPath, "utf8")).toContain("state=unavailable");
    expect(readFileSync(outputPath, "utf8")).not.toContain("state=miss");
    expect(readFileSync(outputPath, "utf8")).toContain("reused=false");
  });
});

describe("candidate archive deadline", () => {
  it("does not start artifact metadata reads after the absolute deadline", async () => {
    let reads = 0;
    await expect(
      downloadExactActionsArtifactArchive({
        deadlineMs: Date.now() - 1,
        expected: {
          artifactDigest: `sha256:${"a".repeat(64)}`,
          artifactExpiresAt: EXPIRES_AT,
          artifactId: 301,
          artifactName: `full-release-candidate-v2-${"b".repeat(64)}`,
          artifactSizeBytes: 1,
          repository: REPOSITORY,
          runId: 77,
          workflowSha: "b".repeat(40),
        },
        fetchImpl: async () => {
          reads += 1;
          return new Response();
        },
        token: "test-token",
      }),
    ).rejects.toThrow("deadline exceeded");
    expect(reads).toBe(0);
  });
});

describe("full release candidate loading", () => {
  it.each([WORKFLOW_PATH, ".github/workflows/full-release-artifacts.yml"])(
    "binds exact candidate artifacts from %s",
    async (path) => {
      const { archive, manifest, metadata } = await fixture();
      const selected = await selectTrustedFullReleaseCandidate({
        artifacts: [metadata],
        now: NOW,
        readWorkflowRun: async () => workflowRun(77, { run_attempt: 2, path }),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
      });
      const binding = await loadSelectedFullReleaseCandidate({
        downloadArchive: async ({ expected }) => {
          expect(expected).toMatchObject({
            artifactId: 301,
            artifactName: metadata.name,
            runId: 77,
            workflowSha: manifest.request.toolingSha,
          });
          return { archiveBytes: archive, artifactMetadata: metadata };
        },
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async (runId, runAttempt) => {
          expect([runId, runAttempt]).toEqual(["77", "1"]);
          return workflowRun(77, { run_attempt: 1, path });
        },
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      });
      expect(binding).toMatchObject({
        evidenceArtifact: {
          digest: sha256(archive),
          id: "301",
          runAttempt: "1",
          runId: "77",
        },
        producer: manifest.producer,
        publisher: manifest.publisher,
        request: manifest.request,
      });
    },
  );

  it("accepts an active producer run after the exact producer jobs complete", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(77, { conclusion: null, status: "in_progress" }),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async () => workflowRun(77, { conclusion: null, status: "in_progress" }),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).resolves.toMatchObject({ producer: manifest.producer });
  });

  it("stops candidate loading when the discovery deadline is exhausted", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    let downloads = 0;
    await expect(
      loadSelectedFullReleaseCandidate({
        deadlineMs: Date.now() - 1,
        downloadArchive: async () => {
          downloads += 1;
          return { archiveBytes: archive, artifactMetadata: metadata };
        },
        now: NOW,
        readArtifact: constituentArtifactReader(manifest),
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("candidate discovery exceeded its time budget");
    expect(downloads).toBe(0);
  });

  it("rejects unavailable, expired, or changed constituent artifacts before reuse", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const packageId = manifest.package.artifact.id;
    const cases = [
      {
        expected: "package artifact is unavailable",
        readArtifact: async (artifactId: string) => {
          if (artifactId === packageId) {
            throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
          }
          return constituentArtifactReader(manifest)(artifactId);
        },
      },
      {
        expected: "package artifact is expired or near expiry",
        readArtifact: async (artifactId: string) => {
          const value = await constituentArtifactReader(manifest)(artifactId);
          return artifactId === packageId ? { ...value, expired: true } : value;
        },
      },
      {
        expected: "package artifact identity changed",
        readArtifact: async (artifactId: string) => {
          const value = await constituentArtifactReader(manifest)(artifactId);
          return artifactId === packageId
            ? { ...value, digest: `sha256:${"9".repeat(64)}` }
            : value;
        },
      },
    ];
    for (const testCase of cases) {
      await expect(
        loadSelectedFullReleaseCandidate({
          downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
          now: NOW,
          readArtifact: testCase.readArtifact,
          readRunAttempt: async () => workflowRun(),
          readWorkflowJobs: async () => workflowJobs(manifest),
          request: manifest.request,
          selected: selected!,
          token: "test-token",
        }),
      ).rejects.toThrow(testCase.expected);
    }
  });

  it("rejects a manifest producer workflow that differs from the selected run", async () => {
    const { manifest } = await fixture();
    const changedManifest = structuredClone(manifest);
    changedManifest.producer.workflowPath = ".github/workflows/candidate-evidence-test.yml";
    const archive = await archiveWithManifest(changedManifest);
    const metadata = artifactMetadata(archive);
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: constituentArtifactReader(changedManifest),
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(changedManifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("producer or publisher workflow attempt is invalid");
  });

  it("rejects a manifest publisher workflow that differs from the selected run", async () => {
    const { manifest } = await fixture();
    const changedManifest = structuredClone(manifest);
    changedManifest.publisher.workflowPath = ".github/workflows/candidate-evidence-test.yml";
    const archive = await archiveWithManifest(changedManifest);
    const metadata = artifactMetadata(archive);
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    await expect(
      loadSelectedFullReleaseCandidate({
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: constituentArtifactReader(changedManifest),
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(changedManifest),
        request: manifest.request,
        selected: selected!,
        token: "test-token",
      }),
    ).rejects.toThrow("producer or publisher workflow attempt is invalid");
  });

  it("hard-fails an unavailable, changed, or expired selected artifact", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    for (const error of [
      new Error("GitHub Actions artifact metadata returned HTTP 404."),
      new Error("Actions artifact metadata does not match the exact artifact tuple."),
      new Error("full release candidate binding contains expired artifact evidence"),
    ]) {
      await expect(
        loadSelectedFullReleaseCandidate({
          downloadArchive: async () => {
            throw error;
          },
          now: NOW,
          readArtifact: constituentArtifactReader(manifest),
          readRunAttempt: async () => workflowRun(),
          readWorkflowJobs: async () => workflowJobs(manifest),
          request: manifest.request,
          selected: selected!,
          token: "test-token",
        }),
      ).rejects.toThrow(error.message);
    }
    expect(archive.length).toBeGreaterThan(0);
  });

  it.each([
    ["job id", (jobs) => void (jobs.jobs[1]!.id = 999)],
    ["job name", (jobs) => void (jobs.jobs[1]!.name = "different publisher")],
    ["job conclusion", (jobs) => void (jobs.jobs[1]!.conclusion = "failure")],
  ] satisfies Array<[string, (jobs: ReturnType<typeof workflowJobs>) => void]>)(
    "rejects evidence when the publisher %s differs from the sealed identity",
    async (_label, mutate) => {
      const { archive, manifest, metadata } = await fixture();
      const selected = await selectTrustedFullReleaseCandidate({
        artifacts: [metadata],
        now: NOW,
        readWorkflowRun: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(manifest),
        request: manifest.request,
      });
      const jobs = workflowJobs(manifest);
      mutate(jobs);
      await expect(
        loadSelectedFullReleaseCandidate({
          downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
          now: NOW,
          readArtifact: constituentArtifactReader(manifest),
          readRunAttempt: async () => workflowRun(),
          readWorkflowJobs: async () => jobs,
          request: manifest.request,
          selected: selected!,
          token: "test-token",
        }),
      ).rejects.toThrow("publisher job did not complete successfully");
    },
  );
});

describe("full release candidate binding authority", () => {
  it("normalizes fresh and reused evidence to the same downstream tuple", () => {
    const binding = fullReleaseCandidateBindingFixture();
    const fresh = resolveCandidateBinding({
      freshBinding: binding,
      now: NOW,
      request: binding.request,
      required: true,
    });
    const reused = resolveCandidateBinding({
      now: NOW,
      request: binding.request,
      required: true,
      reusedBinding: binding,
    });
    expect(fresh).toEqual(binding);
    expect(reused).toEqual(binding);
    expect(candidateArtifactJsonFromBinding(fresh)).toBe(candidateArtifactJsonFromBinding(reused));
  });

  it("rejects missing, ambiguous, expired, and wrong-request evidence", () => {
    const binding = fullReleaseCandidateBindingFixture();
    expect(() =>
      resolveCandidateBinding({ now: NOW, request: binding.request, required: true }),
    ).toThrow("exactly one");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: NOW,
        request: binding.request,
        required: true,
        reusedBinding: binding,
      }),
    ).toThrow("exactly one");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: Date.parse(EXPIRES_AT),
        request: binding.request,
        required: true,
      }),
    ).toThrow("expired or near-expiry");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: Date.parse(EXPIRES_AT) - 90 * 60 * 1000,
        request: binding.request,
        required: true,
      }),
    ).toThrow("expired or near-expiry");
    expect(() =>
      resolveCandidateBinding({
        freshBinding: binding,
        now: NOW,
        request: { ...binding.request, releaseProfile: "beta" },
        required: true,
      }),
    ).toThrow("does not match");
  });
});

describe("sealed full release candidate verification", () => {
  it("rechecks the exact evidence archive and producer tuple", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const binding = await loadSelectedFullReleaseCandidate({
      downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
      now: NOW,
      readArtifact: constituentArtifactReader(manifest),
      readRunAttempt: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
      selected: selected!,
      token: "test-token",
    });
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async ({ expected }) => {
          expect(expected).toMatchObject({
            artifactDigest: `sha256:${binding.evidenceArtifact.digest}`,
            artifactExpiresAt: binding.evidenceArtifact.expiresAt,
            artifactId: Number(binding.evidenceArtifact.id),
            artifactName: binding.evidenceArtifact.name,
            runId: Number(binding.evidenceArtifact.runId),
          });
          return { archiveBytes: archive, artifactMetadata: metadata };
        },
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async (runId, runAttempt) => {
          expect([runId, runAttempt]).toEqual(["77", "1"]);
          return workflowRun();
        },
        readWorkflowJobs: async () => workflowJobs(manifest),
        token: "test-token",
      }),
    ).resolves.toEqual(binding);

    const changedPublisherJobs = workflowJobs(manifest);
    changedPublisherJobs.jobs[1]!.id = 999;
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => changedPublisherJobs,
        token: "test-token",
      }),
    ).rejects.toThrow("publisher job did not complete successfully");
  });

  it("fails final verification when a sealed constituent artifact disappears", async () => {
    const { archive, manifest, metadata } = await fixture();
    const selected = await selectTrustedFullReleaseCandidate({
      artifacts: [metadata],
      now: NOW,
      readWorkflowRun: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
    });
    const binding = await loadSelectedFullReleaseCandidate({
      downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
      now: NOW,
      readArtifact: constituentArtifactReader(manifest),
      readRunAttempt: async () => workflowRun(),
      readWorkflowJobs: async () => workflowJobs(manifest),
      request: manifest.request,
      selected: selected!,
      token: "test-token",
    });
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async () => ({ archiveBytes: archive, artifactMetadata: metadata }),
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          if (artifactId === binding.package.artifact.id) {
            throw new Error("GitHub Actions artifact metadata returned HTTP 404.");
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(manifest),
        token: "test-token",
      }),
    ).rejects.toThrow("HTTP 404");
  });

  it("rejects an evidence artifact identity change before accepting the archive", async () => {
    const binding = fullReleaseCandidateBindingFixture();
    const metadata = {
      created_at: "2026-08-28T10:00:00Z",
      digest: `sha256:${binding.evidenceArtifact.digest}`,
      expired: false,
      expires_at: binding.evidenceArtifact.expiresAt,
      id: Number(binding.evidenceArtifact.id) + 1,
      name: binding.evidenceArtifact.name,
      size_in_bytes: 100,
      workflow_run: {
        head_repository_id: 1,
        head_sha: binding.producer.workflowSha,
        id: Number(binding.producer.runId),
        repository_id: 1,
      },
    };
    await expect(
      verifySealedFullReleaseCandidate({
        binding,
        consumerRunAttempt: 1,
        consumerRunId: 88,
        downloadArchive: async ({ expected }) => {
          expect(expected).toMatchObject({ artifactId: Number(binding.evidenceArtifact.id) });
          throw new Error("Actions artifact metadata does not match the exact artifact tuple.");
        },
        now: NOW,
        readArtifact: async (artifactId) => {
          if (artifactId === binding.evidenceArtifact.id) {
            return metadata;
          }
          return constituentArtifactReader(binding)(artifactId);
        },
        readRunAttempt: async () => workflowRun(),
        readWorkflowJobs: async () => workflowJobs(),
        token: "test-token",
      }),
    ).rejects.toThrow("does not match the exact artifact tuple");
  });
});
