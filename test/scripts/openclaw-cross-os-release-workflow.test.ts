// Openclaw Cross Os Release Workflow tests cover openclaw cross os release workflow script behavior.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const WORKFLOW_PATH = ".github/workflows/openclaw-cross-os-release-checks-reusable.yml";
const RELEASE_CHECKS_PATH = ".github/workflows/openclaw-release-checks.yml";
const WRAPPER_PATH = "scripts/github/run-openclaw-cross-os-release-checks.sh";
const SCRIPT_PATH = "scripts/openclaw-cross-os-release-checks.ts";
const HARNESS = "bash workflow/scripts/github/run-openclaw-cross-os-release-checks.sh";
const BASH_BIN = process.platform === "win32" ? "bash" : "/bin/bash";

type WorkflowStep = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type WorkflowJob = {
  outputs?: Record<string, unknown>;
  steps?: WorkflowStep[];
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: { inputs?: Record<string, Record<string, unknown>> };
    workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
  };
};

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function job(workflow: Workflow, name: string): WorkflowJob {
  const found = workflow.jobs[name];
  expect(found, name).toBeDefined();
  return found!;
}

function step(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const found = workflowJob.steps?.find((candidate) => candidate.name === name);
  expect(found, name).toBeDefined();
  return found!;
}

describe("cross-OS release checks workflow", () => {
  it("runs the TypeScript release harness through the Windows-safe wrapper", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain(HARNESS);
    expect(workflow).toContain("suite_filter:");
    expect(workflow).toContain('--suite-filter "${INPUT_SUITE_FILTER}"');
    expect(workflow).not.toContain("TSX_VERSION");
  });

  it("bounds npm baseline packing during prepare", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow).toContain("timeout --preserve-status 300s npm pack --ignore-scripts");
  });

  it("keeps release artifact tarball filenames local before upload paths use them", () => {
    const workflow = readFileSync(WORKFLOW_PATH, "utf8");

    expect(workflow.match(/function resolveTarballFileName/g)).toHaveLength(1);
    expect(workflow.match(/path\.win32\.basename\(fileName\)/g)).toHaveLength(2);
    expect(workflow).toContain("candidate_file_name");
    expect(workflow).toContain("Baseline npm pack filename");
    expect(workflow).toContain("fileName !== path.basename(fileName)");
    expect(workflow).toContain("fileName !== path.win32.basename(fileName)");
    expect(workflow).toContain("process.stdout.write(`file_name=${fileName}\\n`);");
  });

  it("binds the prepared release package to an immutable artifact and package tuple", () => {
    const release = readWorkflow(RELEASE_CHECKS_PATH);
    const producer = job(release, "prepare_release_package");
    expect(producer.outputs).toMatchObject({
      artifact_digest:
        "${{ steps.release_package_upload.outputs.artifact-digest || fromJSON(inputs.candidate_artifact_json || '{}').packageArtifactDigest }}",
      artifact_id:
        "${{ steps.release_package_upload.outputs.artifact-id || fromJSON(inputs.candidate_artifact_json || '{}').packageArtifactId }}",
      artifact_name:
        "${{ steps.artifact.outputs.name || fromJSON(inputs.candidate_artifact_json || '{}').packageArtifactName }}",
      artifact_run_attempt:
        "${{ steps.artifact.outputs.run_attempt || fromJSON(inputs.candidate_artifact_json || '{}').packageArtifactRunAttempt }}",
      artifact_run_id:
        "${{ steps.artifact.outputs.run_id || fromJSON(inputs.candidate_artifact_json || '{}').packageArtifactRunId }}",
      package_file_name:
        "${{ steps.artifact.outputs.file_name || fromJSON(inputs.candidate_artifact_json || '{}').packageFileName }}",
      package_sha256:
        "${{ steps.package.outputs.sha256 || fromJSON(inputs.candidate_artifact_json || '{}').packageSha256 }}",
      package_version:
        "${{ steps.package.outputs.package_version || fromJSON(inputs.candidate_artifact_json || '{}').packageVersion }}",
      source_sha:
        "${{ steps.package.outputs.source_sha || fromJSON(inputs.candidate_artifact_json || '{}').packageSourceSha }}",
    });
    expect(step(producer, "Checkout trusted workflow ref").with).toMatchObject({
      ref: "${{ github.sha }}",
      "persist-credentials": false,
    });

    const metadata = step(producer, "Set artifact metadata");
    expect(metadata.run).toContain(
      "name=release-package-under-test-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
    );
    expect(metadata.run).toContain("file_name=openclaw-current.tgz");
    expect(metadata.run).toContain("run_attempt=${GITHUB_RUN_ATTEMPT}");
    expect(metadata.run).toContain("run_id=${GITHUB_RUN_ID}");

    const upload = step(producer, "Upload release package artifact");
    expect(upload.id).toBe("release_package_upload");
    expect(upload.with).toMatchObject({
      name: "${{ steps.artifact.outputs.name }}",
      "if-no-files-found": "error",
    });

    const binding = step(producer, "Validate release package artifact binding");
    expect(binding.env).toMatchObject({
      ARTIFACT_DIGEST: "${{ steps.release_package_upload.outputs.artifact-digest }}",
      ARTIFACT_ID: "${{ steps.release_package_upload.outputs.artifact-id }}",
      ARTIFACT_RUN_ATTEMPT: "${{ steps.artifact.outputs.run_attempt }}",
      ARTIFACT_RUN_ID: "${{ steps.artifact.outputs.run_id }}",
      PACKAGE_SHA256: "${{ steps.package.outputs.sha256 }}",
      PACKAGE_SOURCE_SHA: "${{ steps.package.outputs.source_sha }}",
      PACKAGE_VERSION: "${{ steps.package.outputs.package_version }}",
    });
    expect(binding.run).toContain('[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]]');
    expect(binding.run).toContain('"$ARTIFACT_RUN_ID" == "$GITHUB_RUN_ID"');
    expect(binding.run).toContain('"$ARTIFACT_RUN_ATTEMPT" == "$GITHUB_RUN_ATTEMPT"');
    expect(binding.run).toContain('"$PACKAGE_SHA256" =~ ^[a-f0-9]{64}$');
    expect(binding.run).toContain('"$PACKAGE_SOURCE_SHA" =~ ^[a-f0-9]{40}$');

    const crossOs = job(release, "cross_os_release_checks");
    expect(crossOs.with).toMatchObject({
      candidate_artifact_digest: "${{ needs.prepare_release_package.outputs.artifact_digest }}",
      candidate_artifact_id: "${{ needs.prepare_release_package.outputs.artifact_id }}",
      candidate_artifact_name: "${{ needs.prepare_release_package.outputs.artifact_name }}",
      candidate_artifact_run_attempt:
        "${{ needs.prepare_release_package.outputs.artifact_run_attempt }}",
      candidate_artifact_run_id: "${{ needs.prepare_release_package.outputs.artifact_run_id }}",
      candidate_file_name: "${{ needs.prepare_release_package.outputs.package_file_name }}",
      candidate_sha256: "${{ needs.prepare_release_package.outputs.package_sha256 }}",
      candidate_source_sha: "${{ needs.prepare_release_package.outputs.source_sha }}",
      candidate_version: "${{ needs.prepare_release_package.outputs.package_version }}",
    });

    expect(job(release, "docker_e2e_release_checks").with).toMatchObject({
      package_artifact_digest: "${{ needs.prepare_release_package.outputs.artifact_digest }}",
      package_artifact_id: "${{ needs.prepare_release_package.outputs.artifact_id }}",
      package_artifact_name: "${{ needs.prepare_release_package.outputs.artifact_name }}",
      package_artifact_run_attempt:
        "${{ needs.prepare_release_package.outputs.artifact_run_attempt }}",
      package_artifact_run_id: "${{ needs.prepare_release_package.outputs.artifact_run_id }}",
      package_file_name: "${{ needs.prepare_release_package.outputs.package_file_name }}",
      package_sha256: "${{ needs.prepare_release_package.outputs.package_sha256 }}",
      package_source_sha: "${{ needs.prepare_release_package.outputs.source_sha }}",
      package_version: "${{ needs.prepare_release_package.outputs.package_version }}",
    });
    expect(job(release, "package_acceptance_release_checks").with).toMatchObject({
      artifact_digest: "${{ needs.prepare_release_package.outputs.artifact_digest }}",
      artifact_id: "${{ needs.prepare_release_package.outputs.artifact_id }}",
      artifact_name: "${{ needs.prepare_release_package.outputs.artifact_name }}",
      artifact_run_attempt: "${{ needs.prepare_release_package.outputs.artifact_run_attempt }}",
      artifact_run_id: "${{ needs.prepare_release_package.outputs.artifact_run_id }}",
      package_file_name: "${{ needs.prepare_release_package.outputs.package_file_name }}",
      package_source_sha: "${{ needs.prepare_release_package.outputs.source_sha }}",
      package_version: "${{ needs.prepare_release_package.outputs.package_version }}",
      workflow_ref: "${{ github.sha }}",
    });
  });

  it("downloads and re-exports exact candidate artifacts only by immutable id", () => {
    const workflow = readWorkflow(WORKFLOW_PATH);
    for (const inputName of [
      "candidate_artifact_digest",
      "candidate_artifact_id",
      "candidate_artifact_name",
      "candidate_artifact_run_attempt",
      "candidate_artifact_run_id",
      "candidate_file_name",
      "candidate_sha256",
      "candidate_source_sha",
      "candidate_version",
    ]) {
      expect(workflow.on?.workflow_dispatch?.inputs?.[inputName], inputName).toMatchObject({
        default: "",
        type: "string",
      });
      expect(workflow.on?.workflow_call?.inputs?.[inputName], inputName).toMatchObject({
        default: "",
        type: "string",
      });
    }

    const prepare = job(workflow, "prepare");
    expect(prepare.outputs).toMatchObject({
      baseline_artifact_digest: "${{ steps.upload_baseline.outputs.artifact-digest }}",
      baseline_artifact_id: "${{ steps.upload_baseline.outputs.artifact-id }}",
      baseline_artifact_run_attempt: "${{ github.run_attempt }}",
      baseline_artifact_run_id: "${{ github.run_id }}",
      baseline_sha256: "${{ steps.baseline_metadata.outputs.sha256 }}",
      candidate_artifact_digest: "${{ steps.upload_candidate.outputs.artifact-digest }}",
      candidate_artifact_id: "${{ steps.upload_candidate.outputs.artifact-id }}",
      candidate_artifact_run_attempt: "${{ github.run_attempt }}",
      candidate_artifact_run_id: "${{ github.run_id }}",
      candidate_sha256: "${{ steps.candidate_metadata.outputs.sha256 }}",
      candidate_version: "${{ steps.candidate_metadata.outputs.version }}",
      source_sha: "${{ steps.candidate_metadata.outputs.source_sha }}",
    });
    for (const [jobName, workflowJob] of Object.entries(workflow.jobs)) {
      for (const checkout of workflowJob.steps?.filter((candidate) =>
        candidate.uses?.startsWith("actions/checkout@"),
      ) ?? []) {
        expect(checkout.with?.["persist-credentials"], `${jobName}:${checkout.name}`).toBe(false);
      }
    }

    const inputBinding = step(prepare, "Validate provided candidate artifact binding");
    expect(inputBinding.env).toMatchObject({
      ARTIFACT_DIGEST: "${{ inputs.candidate_artifact_digest }}",
      ARTIFACT_ID: "${{ inputs.candidate_artifact_id }}",
      ARTIFACT_RUN_ATTEMPT: "${{ inputs.candidate_artifact_run_attempt }}",
      ARTIFACT_RUN_ID: "${{ inputs.candidate_artifact_run_id }}",
      CANDIDATE_SHA256: "${{ inputs.candidate_sha256 }}",
      CANDIDATE_SOURCE_SHA: "${{ inputs.candidate_source_sha }}",
      CANDIDATE_VERSION: "${{ inputs.candidate_version }}",
    });
    expect(inputBinding.run).toContain('! "$ARTIFACT_ID" =~ ^[1-9][0-9]*$');
    expect(inputBinding.run).toContain('! "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$');
    expect(inputBinding.run).toContain(
      '[[ "$ARTIFACT_NAME" == *"-${ARTIFACT_RUN_ID}-${ARTIFACT_RUN_ATTEMPT}" ]]',
    );
    expect(inputBinding.run).toContain('--arg digest "sha256:${ARTIFACT_DIGEST}"');
    expect(inputBinding.run).toContain(
      "actions/runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}",
    );
    expect(inputBinding.run).toContain('"$CANDIDATE_SOURCE_SHA" != "$INPUT_REF"');

    const inputDownload = step(prepare, "Download provided candidate artifact");
    expect(inputDownload.with).toMatchObject({
      "artifact-ids": "${{ inputs.candidate_artifact_id }}",
      "run-id": "${{ inputs.candidate_artifact_run_id }}",
    });
    expect(inputDownload.with?.name).toBeUndefined();
    expect(
      prepare.steps?.findIndex(
        (candidate) => candidate.name === "Validate provided candidate artifact binding",
      ),
    ).toBeLessThan(
      prepare.steps?.findIndex(
        (candidate) => candidate.name === "Download provided candidate artifact",
      ) ?? -1,
    );

    const resolve = step(prepare, "Resolve provided candidate package");
    expect(resolve.run).toContain("resolve-openclaw-package-candidate.mjs");
    expect(resolve.run).toContain("--source artifact");
    expect(resolve.run).toContain('--package-sha256 "$INPUT_CANDIDATE_SHA256"');
    expect(resolve.run).toContain('"$actual_sha256" == "$INPUT_CANDIDATE_SHA256"');
    expect(resolve.run).toContain('"$actual_source_sha" == "$INPUT_CANDIDATE_SOURCE_SHA"');
    expect(resolve.run).toContain('"$actual_version" == "$INPUT_CANDIDATE_VERSION"');

    const upload = step(prepare, "Upload candidate artifact");
    expect(upload.id).toBe("upload_candidate");
    expect(upload.with?.name).toBe(
      "openclaw-cross-os-release-checks-candidate-${{ github.run_id }}-${{ github.run_attempt }}",
    );
    const baselineUpload = step(prepare, "Upload baseline artifact");
    expect(baselineUpload.id).toBe("upload_baseline");
    expect(baselineUpload.with?.name).toBe(
      "openclaw-cross-os-release-checks-baseline-${{ github.run_id }}-${{ github.run_attempt }}",
    );

    const consumer = job(workflow, "cross_os_release_checks");
    const binding = step(consumer, "Validate prepared candidate artifact binding");
    expect(binding.env).toMatchObject({
      ARTIFACT_DIGEST: "${{ needs.prepare.outputs.candidate_artifact_digest }}",
      ARTIFACT_ID: "${{ needs.prepare.outputs.candidate_artifact_id }}",
      ARTIFACT_NAME:
        "${{ format('openclaw-cross-os-release-checks-candidate-{0}-{1}', needs.prepare.outputs.candidate_artifact_run_id, needs.prepare.outputs.candidate_artifact_run_attempt) }}",
      ARTIFACT_RUN_ATTEMPT: "${{ needs.prepare.outputs.candidate_artifact_run_attempt }}",
      ARTIFACT_RUN_ID: "${{ needs.prepare.outputs.candidate_artifact_run_id }}",
      BASELINE_ARTIFACT_DIGEST: "${{ needs.prepare.outputs.baseline_artifact_digest }}",
      BASELINE_ARTIFACT_ID: "${{ needs.prepare.outputs.baseline_artifact_id }}",
      BASELINE_ARTIFACT_NAME:
        "${{ format('openclaw-cross-os-release-checks-baseline-{0}-{1}', needs.prepare.outputs.baseline_artifact_run_id, needs.prepare.outputs.baseline_artifact_run_attempt) }}",
      BASELINE_ARTIFACT_RUN_ATTEMPT: "${{ needs.prepare.outputs.baseline_artifact_run_attempt }}",
      BASELINE_ARTIFACT_RUN_ID: "${{ needs.prepare.outputs.baseline_artifact_run_id }}",
      BASELINE_SHA256: "${{ needs.prepare.outputs.baseline_sha256 }}",
      CANDIDATE_SHA256: "${{ needs.prepare.outputs.candidate_sha256 }}",
      CANDIDATE_SOURCE_SHA: "${{ needs.prepare.outputs.source_sha }}",
      CANDIDATE_VERSION: "${{ needs.prepare.outputs.candidate_version }}",
      GH_TOKEN: "${{ github.token }}",
    });
    expect(binding.run).not.toContain('"$ARTIFACT_RUN_ATTEMPT" == "$GITHUB_RUN_ATTEMPT"');
    expect(binding.run).not.toContain('"$BASELINE_ARTIFACT_RUN_ATTEMPT" == "$GITHUB_RUN_ATTEMPT"');
    expect(binding.run).toContain("actions/artifacts/${tuple.id}");
    expect(binding.run).toContain("artifact.expired !== false");
    expect(binding.run).toContain("artifact.digest !== `sha256:${tuple.digest}`");
    expect(binding.run).toContain("String(artifact.workflow_run?.id) !== tuple.runId");
    expect(binding.run).toContain("actions/runs/${tuple.runId}/attempts/${tuple.runAttempt}");
    expect(binding.run).toContain("String(attempt.run_attempt) !== tuple.runAttempt");

    for (const name of ["Download candidate artifact", "Retry candidate artifact download"]) {
      const download = step(consumer, name);
      expect(download.with?.["artifact-ids"], name).toBe(
        "${{ needs.prepare.outputs.candidate_artifact_id }}",
      );
      expect(download.with?.["github-token"], name).toBe("${{ github.token }}");
      expect(download.with?.["run-id"], name).toBe(
        "${{ needs.prepare.outputs.candidate_artifact_run_id }}",
      );
      expect(download.with?.name, name).toBeUndefined();
    }
    for (const name of ["Download baseline artifact", "Retry baseline artifact download"]) {
      const download = step(consumer, name);
      expect(download.with?.["artifact-ids"], name).toBe(
        "${{ needs.prepare.outputs.baseline_artifact_id }}",
      );
      expect(download.with?.["github-token"], name).toBe("${{ github.token }}");
      expect(download.with?.["run-id"], name).toBe(
        "${{ needs.prepare.outputs.baseline_artifact_run_id }}",
      );
      expect(download.with?.name, name).toBeUndefined();
    }
    const verify = step(consumer, "Verify release-check inputs");
    expect(verify.env?.EXPECTED_CANDIDATE_SHA256).toBe(
      "${{ needs.prepare.outputs.candidate_sha256 }}",
    );
    expect(verify.run).toContain('"$actual_sha256" != "$EXPECTED_CANDIDATE_SHA256"');
    expect(verify.env?.EXPECTED_BASELINE_SHA256).toBe(
      "${{ needs.prepare.outputs.baseline_sha256 }}",
    );
    expect(verify.run).toContain('"$actual_baseline_sha256" != "$EXPECTED_BASELINE_SHA256"');
  });

  it("executes the release harness directly with Node", () => {
    const wrapper = readFileSync(WRAPPER_PATH, "utf8");
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };

    expect(wrapper).toContain('exec "${node_cmd}" "${script_path}" "$@"');
    expect(wrapper).not.toContain("npm");
    expect(wrapper).not.toContain("tsx");
    expect(wrapper).not.toContain("--import");
    expect(script).toMatch(/^#!\/usr\/bin\/env node$/mu);
    expect(script).not.toContain("--import tsx");
    expect(packageJson.scripts["test:windows:ci"]).toContain(
      "test/scripts/openclaw-cross-os-release-workflow.test.ts",
    );
    const result = spawnSync(
      BASH_BIN,
      [
        WRAPPER_PATH,
        "--resolve-matrix",
        "--ref",
        "test/native-node",
        "--mode",
        "fresh",
        "--suite-filter",
        "windows/packaged-fresh",
        "--windows-runner",
        "windows-2025",
      ],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: {
          ...process.env,
          OPENCLAW_RELEASE_CHECKS_SCRIPT: SCRIPT_PATH,
        },
      },
    );

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      include: [
        {
          os_id: "windows",
          display_name: "Windows",
          runner: "windows-2025",
          artifact_name: "windows",
          suite: "packaged-fresh",
          suite_label: "packaged fresh",
          lane: "fresh",
        },
      ],
    });
  });
});
