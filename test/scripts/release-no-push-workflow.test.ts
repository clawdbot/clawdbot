import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const FULL_RELEASE = ".github/workflows/full-release-validation.yml";
const RELEASE_CHECKS = ".github/workflows/openclaw-release-checks.yml";
const PACKAGE_ACCEPTANCE = ".github/workflows/package-acceptance.yml";
const PLUGIN_PRERELEASE = ".github/workflows/plugin-prerelease.yml";
const LIVE_E2E = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const PERFORMANCE = ".github/workflows/openclaw-performance.yml";
const LIVE_BUILD = "scripts/test-live-build-docker.sh";
const DOCKER_E2E_IMAGE_HELPER = "scripts/lib/docker-e2e-image.sh";

type WorkflowInput = {
  default?: boolean | number | string;
  options?: string[];
  type?: string;
};

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type WorkflowJob = {
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    workflow_call?: { inputs?: Record<string, WorkflowInput> };
    workflow_dispatch?: { inputs?: Record<string, WorkflowInput> };
  };
  permissions?: Record<string, string>;
};

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function job(workflow: Workflow, name: string): WorkflowJob {
  const value = workflow.jobs?.[name];
  if (!value) {
    throw new Error(`missing workflow job ${name}`);
  }
  return value;
}

function step(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const value = workflowJob.steps?.find((candidate) => candidate.name === name);
  if (!value) {
    throw new Error(`missing workflow step ${name}`);
  }
  return value;
}

function expectReadOnlyPackagePermission(workflowJob: WorkflowJob): void {
  expect(workflowJob.permissions?.packages).toBe("read");
}

describe("release validation no-push transport", () => {
  it("collects child failures by default and propagates explicit fail-fast", () => {
    const fullReleaseSource = readFileSync(FULL_RELEASE, "utf8");
    const fullRelease = readWorkflow(FULL_RELEASE);
    const releaseChecksSource = readFileSync(RELEASE_CHECKS, "utf8");
    const releaseChecks = readWorkflow(RELEASE_CHECKS);

    expect(fullRelease.on?.workflow_dispatch?.inputs?.fail_fast).toMatchObject({
      default: false,
      type: "boolean",
    });
    expect(fullReleaseSource.match(/if \[\[ "\$FAIL_FAST" != "true" \]\]; then/gu)).toHaveLength(4);
    expect(fullReleaseSource).toContain('-f fail_fast="$FAIL_FAST"');
    expect(releaseChecks.on?.workflow_dispatch?.inputs?.fail_fast).toMatchObject({
      default: false,
      type: "boolean",
    });
    expect(releaseChecksSource).toContain("FAIL_FAST: ${{ needs.resolve_target.outputs.fail_fast }}");
    expect(releaseChecksSource).toContain('if [[ "$FAIL_FAST" == "true" ]]');
  });

  it("does not persist Git credentials in validation checkouts", () => {
    for (const workflowPath of [PLUGIN_PRERELEASE, RELEASE_CHECKS]) {
      const workflow = readWorkflow(workflowPath);
      const checkoutSteps = Object.values(workflow.jobs ?? {}).flatMap(
        (workflowJob) =>
          workflowJob.steps?.filter((candidate) =>
            candidate.uses?.startsWith("actions/checkout@"),
          ) ?? [],
      );
      expect(checkoutSteps, workflowPath).not.toHaveLength(0);
      for (const checkout of checkoutSteps) {
        expect(checkout.with?.["persist-credentials"], `${workflowPath}:${checkout.name}`).toBe(
          false,
        );
      }
    }
  });

  it("runs evidence reuse from an immutable trusted-main workflow checkout", () => {
    const full = readWorkflow(FULL_RELEASE);
    expect(full.on?.workflow_dispatch?.inputs?.target_context_ref).toMatchObject({
      default: "",
      type: "string",
    });
    for (const jobName of ["resolve_target", "evidence_reuse"]) {
      const checkout = step(job(full, jobName), "Checkout trusted workflow helper");
      expect(checkout.with?.ref, jobName).toBe("${{ github.sha }}");
      expect(checkout.with?.ref, jobName).not.toBe("${{ github.ref_name }}");
      expect(checkout.with?.["persist-credentials"], jobName).toBe(false);
    }

    const evidenceReuse = job(full, "evidence_reuse");
    expect(step(evidenceReuse, "Checkout target SHA").with?.["persist-credentials"]).toBe(false);
    const dockerAssets = job(full, "docker_runtime_assets_preflight");
    expect(step(dockerAssets, "Checkout target SHA").with?.["persist-credentials"]).toBe(false);
    expect(evidenceReuse.if).toContain("github.ref == 'refs/heads/main'");
    expect(evidenceReuse.if).toContain("startsWith(github.ref, 'refs/heads/release-ci/')");
    expect(
      evidenceReuse.steps?.find(
        (candidate) => candidate.name === "Require trusted main workflow ref",
      ),
    ).toBeUndefined();
    expect(evidenceReuse.outputs?.evidence_policy).toBe(
      "${{ steps.find.outputs.evidence_policy }}",
    );

    for (const jobName of [
      "docker_runtime_assets_preflight",
      "normal_ci",
      "plugin_prerelease",
      "release_checks",
      "performance",
    ]) {
      const lane = job(full, jobName);
      expect(lane.needs, jobName).toContain("evidence_reuse");
      expect(lane.if, jobName).toContain("needs.evidence_reuse.outputs.reuse != 'true'");
    }

    const normalCiDispatch = step(job(full, "normal_ci"), "Dispatch and monitor CI");
    expect(normalCiDispatch.env?.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
    expect(normalCiDispatch.run).toContain('release_candidate_ref="$TARGET_CONTEXT_REF"');
    const releaseChecksDispatch = step(
      job(full, "release_checks"),
      "Dispatch and monitor release checks",
    );
    expect(releaseChecksDispatch.env?.TARGET_CONTEXT_REF).toBe("${{ inputs.target_context_ref }}");
    expect(releaseChecksDispatch.run).toContain(
      'release_checks_target_ref="${TARGET_CONTEXT_REF:-$TARGET_REF}"',
    );

    const summary = job(full, "summary");
    expect(summary.needs).toContain("evidence_reuse");
    expect(step(summary, "Verify child workflow results").env).toMatchObject({
      EVIDENCE_REUSE: "${{ needs.evidence_reuse.outputs.reuse }}",
      EVIDENCE_ROOT_RUN_ID: "${{ needs.evidence_reuse.outputs.evidence_root_run_id }}",
      EVIDENCE_RUN_URL: "${{ needs.evidence_reuse.outputs.evidence_run_url }}",
      EVIDENCE_SHA: "${{ needs.evidence_reuse.outputs.evidence_sha }}",
      EVIDENCE_POLICY: "${{ needs.evidence_reuse.outputs.evidence_policy }}",
      EVIDENCE_MANIFEST: "${{ needs.evidence_reuse.outputs.evidence_manifest }}",
    });
    const evidenceUpdate = step(summary, "Request release evidence update");
    expect(evidenceUpdate.env).toMatchObject({
      EVIDENCE_REUSE: "${{ needs.evidence_reuse.outputs.reuse }}",
      EVIDENCE_ROOT_RUN_ID: "${{ needs.evidence_reuse.outputs.evidence_root_run_id }}",
      EVIDENCE_POLICY: "${{ needs.evidence_reuse.outputs.evidence_policy }}",
    });
    expect(evidenceUpdate.run).toContain(
      '"$RELEASE_CHECKS_RESULT" == "skipped" && "$EVIDENCE_REUSE" != "true"',
    );
    expect(evidenceUpdate.run).toContain('--arg notes "$notes"');
    expect(evidenceUpdate.run).not.toContain('GITHUB_RUN_ID_VALUE="$EVIDENCE_ROOT_RUN_ID"');

    const manifest = step(summary, "Write release validation manifest");
    expect(manifest.env).toMatchObject({
      EVIDENCE_POLICY: "${{ needs.evidence_reuse.outputs.evidence_policy }}",
      TARGET_CONTEXT_REF: "${{ inputs.target_context_ref }}",
    });
    expect(manifest.run).toContain("policy: $evidencePolicy");
    expect(manifest.run).toContain("targetContextRef: $targetContextRef");

    const releaseChecks = readWorkflow(RELEASE_CHECKS);
    const releaseHelper = step(
      job(releaseChecks, "resolve_target"),
      "Checkout trusted workflow helper",
    );
    expect(releaseHelper.with?.ref).toBe("${{ github.sha }}");
    expect(releaseHelper.with?.ref).not.toBe("${{ github.ref_name }}");
    expect(releaseHelper.with?.["persist-credentials"]).toBe(false);
  });

  it("rejects every child whose workflow SHA differs from the parent workflow SHA", () => {
    const full = readWorkflow(FULL_RELEASE);
    for (const [jobName, stepName] of [
      ["normal_ci", "Dispatch and monitor CI"],
      ["plugin_prerelease", "Dispatch and monitor plugin prerelease"],
      ["release_checks", "Dispatch and monitor release checks"],
      ["npm_telegram", "Dispatch and monitor npm Telegram E2E"],
      ["performance", "Dispatch and monitor OpenClaw Performance"],
    ] as const) {
      const dispatch = step(job(full, jobName), stepName);
      expect(dispatch.env?.PARENT_WORKFLOW_SHA, jobName).toBe("${{ github.sha }}");
      expect(dispatch.run, jobName).toContain('"$child_head_sha" != "$PARENT_WORKFLOW_SHA"');
      expect(dispatch.run, jobName).toContain("expected parent workflow SHA");
    }

    const verify = step(job(full, "summary"), "Verify child workflow results");
    expect(verify.env?.PARENT_WORKFLOW_SHA).toBe("${{ github.sha }}");
    expect(verify.run).toContain('"$head_sha" != "$PARENT_WORKFLOW_SHA"');
    expect(verify.run).not.toContain('"$head_sha" != "$TARGET_SHA"');
  });

  it("publishes an attempt-qualified canonical manifest plus a temporary legacy alias", () => {
    const summary = job(readWorkflow(FULL_RELEASE), "summary");
    expect(step(summary, "Upload release validation manifest").with).toMatchObject({
      name: "full-release-validation-${{ github.run_id }}-${{ github.run_attempt }}",
    });
    expect(step(summary, "Upload legacy release validation manifest alias").with).toMatchObject({
      name: "full-release-validation-${{ github.run_id }}",
      overwrite: true,
    });
  });

  it("pins every Full Release Docker caller to artifact-only transport", () => {
    const fullText = readFileSync(FULL_RELEASE, "utf8");
    const release = readWorkflow(RELEASE_CHECKS);
    const packageAcceptance = readWorkflow(PACKAGE_ACCEPTANCE);
    const pluginPrerelease = readWorkflow(PLUGIN_PRERELEASE);

    expect(fullText).toContain("dispatch_and_wait plugin-prerelease.yml");
    expect(fullText).toContain("dispatch_and_wait openclaw-release-checks.yml");
    expect(fullText).toContain("gh workflow run openclaw-performance.yml");

    const preparePackage = job(release, "prepare_release_package");
    const live = job(release, "live_repo_e2e_release_checks");
    const docker = job(release, "docker_e2e_release_checks");
    const acceptance = job(release, "package_acceptance_release_checks");
    expectReadOnlyPackagePermission(preparePackage);
    expectReadOnlyPackagePermission(live);
    expectReadOnlyPackagePermission(docker);
    expectReadOnlyPackagePermission(acceptance);
    expect(step(preparePackage, "Resolve release package artifact").run).toContain(
      'if [[ "$source_sha" != "$PACKAGE_REF" ]]',
    );
    expect(live.with).toMatchObject({
      shared_image_artifact_namespace: "release-live",
      shared_image_policy: "no-push-artifact",
    });
    expect(docker.with).toMatchObject({
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
      shared_image_artifact_namespace: "release-docker",
      shared_image_policy: "no-push-artifact",
    });
    expect(acceptance.with).toMatchObject({
      artifact_digest: "${{ needs.prepare_release_package.outputs.artifact_digest }}",
      artifact_id: "${{ needs.prepare_release_package.outputs.artifact_id }}",
      artifact_name: "${{ needs.prepare_release_package.outputs.artifact_name }}",
      artifact_run_attempt: "${{ needs.prepare_release_package.outputs.artifact_run_attempt }}",
      artifact_run_id: "${{ needs.prepare_release_package.outputs.artifact_run_id }}",
      package_file_name: "${{ needs.prepare_release_package.outputs.package_file_name }}",
      package_source_sha: "${{ needs.prepare_release_package.outputs.source_sha }}",
      package_version: "${{ needs.prepare_release_package.outputs.package_version }}",
      shared_image_artifact_namespace: "release-package",
      shared_image_policy: "no-push-artifact",
    });

    const standardAcceptance = job(packageAcceptance, "docker_acceptance");
    const registryAcceptance = job(packageAcceptance, "docker_acceptance_registry");
    expect(packageAcceptance.permissions?.packages).toBe("read");
    expect(packageAcceptance.on?.workflow_dispatch?.inputs?.shared_image_policy).toMatchObject({
      default: "no-push-artifact",
      options: ["existing-only", "no-push-artifact"],
      type: "choice",
    });
    expect(packageAcceptance.on?.workflow_call?.inputs?.shared_image_policy).toMatchObject({
      default: "no-push-artifact",
      type: "string",
    });
    expect(standardAcceptance.with?.shared_image_policy).toBe("${{ inputs.shared_image_policy }}");
    expect(standardAcceptance.with?.shared_image_artifact_namespace).toBe(
      "${{ inputs.shared_image_artifact_namespace }}",
    );
    expect(standardAcceptance.with).toMatchObject({
      package_artifact_digest: "${{ needs.resolve_package.outputs.package_artifact_digest }}",
      package_artifact_id: "${{ needs.resolve_package.outputs.package_artifact_id }}",
      package_artifact_run_attempt:
        "${{ needs.resolve_package.outputs.package_artifact_run_attempt }}",
      package_artifact_run_id: "${{ needs.resolve_package.outputs.package_artifact_run_id }}",
      package_file_name: "${{ needs.resolve_package.outputs.package_file_name }}",
      package_sha256: "${{ needs.resolve_package.outputs.package_sha256 }}",
      package_source_sha: "${{ needs.resolve_package.outputs.package_source_sha }}",
      package_version: "${{ needs.resolve_package.outputs.package_version }}",
    });
    expect(standardAcceptance.if).toContain("shared_image_policy == 'no-push-artifact'");
    expectReadOnlyPackagePermission(standardAcceptance);
    expect(registryAcceptance.if).toContain("shared_image_policy == 'existing-only'");
    expectReadOnlyPackagePermission(registryAcceptance);

    const pluginDocker = job(pluginPrerelease, "plugin-prerelease-docker-suite");
    expectReadOnlyPackagePermission(pluginDocker);
    expect(pluginDocker.with).toMatchObject({
      shared_image_artifact_namespace: "plugin-prerelease",
      shared_image_policy: "no-push-artifact",
    });
    expect(
      new Set([
        live.with?.shared_image_artifact_namespace,
        docker.with?.shared_image_artifact_namespace,
        acceptance.with?.shared_image_artifact_namespace,
        pluginDocker.with?.shared_image_artifact_namespace,
      ]).size,
    ).toBe(4);
  });

  it("builds shared images locally, verifies artifacts, and cannot fall back to a registry", () => {
    const workflow = readWorkflow(LIVE_E2E);
    const dispatchPolicy = workflow.on?.workflow_dispatch?.inputs?.shared_image_policy;
    const callPolicy = workflow.on?.workflow_call?.inputs?.shared_image_policy;
    expect(dispatchPolicy).toMatchObject({
      default: "no-push-artifact",
      options: ["existing-only", "no-push-artifact"],
    });
    expect(callPolicy).toMatchObject({ default: "no-push-artifact", type: "string" });

    const validation = job(workflow, "validate_selected_ref");
    expect(validation.outputs?.workflow_repository).toBe(
      "${{ steps.workflow.outputs.workflow_repository }}",
    );
    expect(validation.outputs?.workflow_sha).toBe("${{ steps.workflow.outputs.workflow_sha }}");
    const workflowIdentity = step(validation, "Resolve job workflow identity");
    expect(workflowIdentity.env?.JOB_CONTEXT).toBe("${{ toJSON(job) }}");
    expect(workflowIdentity.run).toContain(
      "job.workflow_repository must be an owner/repository slug",
    );
    expect(workflowIdentity.run).toContain("job.workflow_sha must be a full lowercase commit SHA");
    const trustedCheckouts = Object.entries(workflow.jobs ?? {}).flatMap(([jobName, workflowJob]) =>
      (workflowJob.steps ?? [])
        .filter((candidate) => candidate.name?.startsWith("Checkout trusted "))
        .map((candidate) => ({ candidate, jobName })),
    );
    expect(trustedCheckouts).toHaveLength(12);
    for (const { candidate, jobName } of trustedCheckouts) {
      expect(candidate.with, jobName).toMatchObject({
        repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
        ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        "persist-credentials": false,
      });
    }

    const dockerProducer = job(workflow, "prepare_docker_e2e_image");
    const liveProducer = job(workflow, "prepare_live_test_image");
    expect(workflow.permissions?.actions).toBe("read");
    expect(workflow.permissions?.packages).toBe("read");
    expectReadOnlyPackagePermission(dockerProducer);
    expectReadOnlyPackagePermission(liveProducer);
    expect(workflow.jobs?.push_docker_e2e_images).toBeUndefined();
    expect(workflow.jobs?.push_live_test_image).toBeUndefined();
    expect(job(workflow, "docker_e2e_image_ready").permissions?.packages).toBeUndefined();
    expect(job(workflow, "live_test_image_ready").permissions?.packages).toBeUndefined();
    const packageWriters = Object.entries(workflow.jobs ?? {}).filter(
      ([, workflowJob]) => workflowJob.permissions?.packages === "write",
    );
    expect(packageWriters).toEqual([]);
    const validateSelectedRef = step(
      job(workflow, "validate_selected_ref"),
      "Validate selected ref",
    );
    const dispatchInputs = workflow.on?.workflow_dispatch?.inputs ?? {};
    for (const inputName of [
      "package_artifact_digest",
      "package_artifact_id",
      "package_artifact_name",
      "package_artifact_run_attempt",
      "package_artifact_run_id",
      "package_file_name",
      "package_sha256",
      "package_source_sha",
      "package_version",
    ]) {
      expect(dispatchInputs[inputName], inputName).toBeUndefined();
      expect(workflow.on?.workflow_call?.inputs?.[inputName], inputName).toBeDefined();
    }
    expect(validateSelectedRef.env?.PACKAGE_ARTIFACT_DIGEST).toBe(
      "${{ inputs.package_artifact_digest }}",
    );
    expect(validateSelectedRef.env?.PACKAGE_ARTIFACT_RUN_ATTEMPT).toBe(
      "${{ inputs.package_artifact_run_attempt }}",
    );
    expect(validateSelectedRef.env?.PACKAGE_ARTIFACT_RUN_ID).toBe(
      "${{ inputs.package_artifact_run_id }}",
    );
    expect(validateSelectedRef.env?.PACKAGE_ARTIFACT_ID).toBe("${{ inputs.package_artifact_id }}");
    expect(validateSelectedRef.env?.PACKAGE_FILE_NAME).toBe("${{ inputs.package_file_name }}");
    expect(validateSelectedRef.env?.PACKAGE_SOURCE_SHA).toBe("${{ inputs.package_source_sha }}");
    expect(validateSelectedRef.run).toContain(
      "Package artifact selection requires the complete immutable artifact and package identity tuple.",
    );
    expect(validateSelectedRef.run).toContain('"$PACKAGE_SOURCE_SHA" == "$selected_sha"');
    for (const name of [
      "prepare_docker_e2e_image",
      "prepare_live_test_image",
      "validate_live_models_docker",
      "validate_live_models_docker_targeted",
      "validate_live_docker_provider_suites",
    ]) {
      const checkoutSteps = job(workflow, name).steps?.filter((candidate) =>
        candidate.uses?.startsWith("actions/checkout@"),
      );
      expect(checkoutSteps, name).not.toHaveLength(0);
      for (const checkout of checkoutSteps ?? []) {
        expect(checkout.with?.["persist-credentials"], `${name}:${checkout.name}`).toBe(false);
      }
    }
    expect(dockerProducer.outputs?.image_artifact_name).toContain("image_artifact");
    expect(liveProducer.outputs?.image_artifact_name).toContain("image_artifact");
    for (const producer of [dockerProducer, liveProducer]) {
      expect(producer.outputs?.image_archive_sha256).toContain("archive_sha256");
      expect(producer.outputs?.image_artifact_id).toContain("artifact-id");
      expect(producer.outputs?.image_artifact_digest).toContain("artifact-digest");
      expect(producer.outputs?.image_artifact_run_id).toBe("${{ github.run_id }}");
      expect(producer.outputs?.image_artifact_run_attempt).toBe("${{ github.run_attempt }}");
    }
    expect(dockerProducer.outputs?.package_artifact_id).toContain("artifact-id");
    expect(dockerProducer.outputs?.package_artifact_digest).toContain("artifact-digest");
    expect(dockerProducer.outputs?.package_artifact_run_attempt).toContain("run_attempt");
    expect(dockerProducer.outputs?.package_artifact_run_id).toContain("run_id");
    expect(dockerProducer.outputs?.package_file_name).toContain("file_name");
    expect(dockerProducer.outputs?.package_source_sha).toContain("source_sha");

    const packageIdentity = step(dockerProducer, "Validate OpenClaw package artifact identity");
    expect(packageIdentity.env).toMatchObject({
      ARTIFACT_DIGEST: "${{ inputs.package_artifact_digest }}",
      ARTIFACT_ID: "${{ inputs.package_artifact_id }}",
      ARTIFACT_NAME: "${{ inputs.package_artifact_name }}",
      ARTIFACT_RUN_ATTEMPT: "${{ inputs.package_artifact_run_attempt }}",
      ARTIFACT_RUN_ID: "${{ inputs.package_artifact_run_id }}",
    });
    expect(packageIdentity.run).toContain('--arg digest "sha256:${ARTIFACT_DIGEST}"');
    expect(packageIdentity.run).toContain(
      "actions/runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}",
    );
    expect(packageIdentity.run).toContain("artifact_digest=$ARTIFACT_DIGEST");
    for (const [name, condition] of [
      [
        "Download current-run OpenClaw Docker E2E package",
        "inputs.package_artifact_run_id == github.run_id",
      ],
      [
        "Download previous-run OpenClaw Docker E2E package",
        "inputs.package_artifact_run_id != github.run_id",
      ],
    ] as const) {
      const packageDownload = step(dockerProducer, name);
      expect(packageDownload.if).toContain(condition);
      expect(packageDownload.with).toMatchObject({
        "artifact-ids": "${{ inputs.package_artifact_id }}",
        "github-token": "${{ github.token }}",
        "run-id": "${{ inputs.package_artifact_run_id }}",
      });
    }

    for (const name of [
      "Build bare Docker E2E image artifact",
      "Build functional Docker E2E image artifact",
    ]) {
      const build = step(dockerProducer, name);
      expect(build.if).toContain("shared_image_policy == 'no-push-artifact'");
      expect(build.run).toContain("--load");
      expect(build.run).toContain("--sbom=false");
      expect(build.run).toContain("--provenance=false");
      expect(build.run).not.toContain("--push");
    }
    const packDockerArtifact = step(dockerProducer, "Pack Docker E2E image artifact");
    expect(packDockerArtifact.env?.PACKAGE_SHA256).toBe("${{ steps.package.outputs.sha256 }}");
    expect(packDockerArtifact.run).toContain("shared-image-artifact.sh");
    expect(packDockerArtifact.run).toContain(
      "docker-e2e-shared-images-${SHARED_IMAGE_ARTIFACT_NAMESPACE}-${TARGET_SHA:0:12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
    );
    expect(packDockerArtifact.run).toContain(
      'OPENCLAW_SHARED_IMAGE_PACKAGE_SHA256="$PACKAGE_SHA256"',
    );
    expect(packDockerArtifact.run).toContain("archive_sha256=");
    const validatePackage = step(dockerProducer, "Validate OpenClaw Docker E2E package");
    expect(validatePackage.env).toMatchObject({
      EXPECTED_PACKAGE_FILE_NAME: "${{ inputs.package_file_name }}",
      EXPECTED_PACKAGE_SHA256: "${{ inputs.package_sha256 }}",
      EXPECTED_PACKAGE_SOURCE_SHA: "${{ inputs.package_source_sha }}",
      EXPECTED_PACKAGE_VERSION: "${{ inputs.package_version }}",
    });
    expect(validatePackage.run).toContain('"$SHARED_IMAGE_POLICY" == "no-push-artifact"');
    expect(validatePackage.run).toContain(
      "Resolved package identity differs from the declared immutable tuple.",
    );
    expect(validatePackage.run).toContain("package/dist/build-info.json");
    expect(validatePackage.run).toContain('[[ "$package_source_sha" == "$SELECTED_SHA" ]]');
    const targetedRun = step(
      job(workflow, "validate_docker_lanes"),
      "Run targeted Docker E2E lanes",
    );
    expect(targetedRun.env).toMatchObject({
      ARTIFACT_SUFFIX: "${{ steps.plan.outputs.artifact_suffix }}",
      INCLUDE_RELEASE_PATH_SUITES: "${{ inputs.include_release_path_suites }}",
    });
    expect(targetedRun.run).toContain('if [[ "$INCLUDE_RELEASE_PATH_SUITES" == "true" ]]');
    expect(targetedRun.run).not.toContain("${{ inputs.");
    for (const workflowJob of Object.values(workflow.jobs ?? {})) {
      for (const workflowStep of workflowJob.steps ?? []) {
        for (const inputName of ["shared_image_policy", "package_sha256", "package_version"]) {
          expect(workflowStep.run ?? "", `${workflowStep.name}:${inputName}`).not.toContain(
            `\${{ inputs.${inputName} }}`,
          );
        }
      }
    }
    expect(readFileSync(LIVE_E2E, "utf8")).not.toContain("fromJSON(toJSON(job)).workflow_");
    expect(readFileSync(LIVE_E2E, "utf8")).not.toContain("${{ github.workflow_sha }}");
    const artifactPackAndLoadSteps = Object.values(workflow.jobs ?? {}).flatMap((workflowJob) =>
      (workflowJob.steps ?? []).filter((candidate) => candidate.env?.WORKFLOW_SHA !== undefined),
    );
    expect(artifactPackAndLoadSteps).toHaveLength(8);
    for (const artifactStep of artifactPackAndLoadSteps) {
      expect(artifactStep.env?.WORKFLOW_SHA, artifactStep.name).toBe(
        "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
      );
    }
    expect(step(dockerProducer, "Upload Docker E2E image artifact")).toMatchObject({
      id: "upload_image_artifact",
      if: "inputs.shared_image_policy == 'no-push-artifact' && steps.plan.outputs.needs_e2e_image == '1'",
      with: { "if-no-files-found": "error" },
    });
    expect(step(liveProducer, "Pack live-test image artifact").run).toContain(
      "shared-image-artifact.sh",
    );
    expect(step(liveProducer, "Pack live-test image artifact").run).toContain(
      "live-test-shared-image-${SHARED_IMAGE_ARTIFACT_NAMESPACE}-${TARGET_SHA:0:12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
    );
    expect(step(liveProducer, "Upload live-test image artifact")).toMatchObject({
      id: "upload_image_artifact",
      if: "inputs.shared_image_policy == 'no-push-artifact'",
      with: { "if-no-files-found": "error" },
    });
    expect(step(liveProducer, "Build shared live-test image").with).toMatchObject({
      load: true,
      provenance: false,
      push: false,
      sbom: false,
    });
    const dockerLoginCondition = step(dockerProducer, "Log in to GHCR").if;
    expect(dockerLoginCondition).toContain("shared_image_policy == 'existing-only'");
    expect(dockerLoginCondition).not.toContain("allow-push");
    expect(step(liveProducer, "Log in to GHCR").if).toContain(
      "shared_image_policy != 'no-push-artifact'",
    );
    expect(step(dockerProducer, "Check existing shared Docker E2E images").if).toContain(
      "shared_image_policy == 'existing-only'",
    );
    expect(step(liveProducer, "Check existing shared live-test image").if).toContain(
      "shared_image_policy != 'no-push-artifact'",
    );

    const shellPushSteps = Object.entries(workflow.jobs ?? {}).flatMap(([jobName, workflowJob]) =>
      (workflowJob.steps ?? [])
        .filter((candidate) => candidate.run?.includes("--push"))
        .map((candidate) => ({ candidate, jobName })),
    );
    expect(shellPushSteps).toEqual([]);

    for (const name of [
      "validate_docker_e2e",
      "validate_docker_lanes",
      "validate_docker_openwebui",
    ]) {
      const consumer = job(workflow, name);
      expect(consumer.needs).toContain("docker_e2e_image_ready");
      expect(consumer.env?.OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE).toContain("no-push-artifact");
      expect(step(consumer, "Download OpenClaw Docker E2E package").with).toMatchObject({
        "artifact-ids": "${{ needs.prepare_docker_e2e_image.outputs.package_artifact_id }}",
        "github-token": "${{ github.token }}",
        "run-id": "${{ needs.prepare_docker_e2e_image.outputs.package_artifact_run_id }}",
      });
      const binding = step(consumer, "Validate Docker E2E image artifact binding");
      expect(binding.if).toContain("shared_image_policy == 'no-push-artifact'");
      expect(binding.env).toMatchObject({
        ARTIFACT_DIGEST: "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_digest }}",
        ARTIFACT_ID: "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_id }}",
        ARTIFACT_NAME: "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_name }}",
        ARTIFACT_RUN_ATTEMPT:
          "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_run_attempt }}",
        ARTIFACT_RUN_ID: "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_run_id }}",
        GH_TOKEN: "${{ github.token }}",
      });
      expect(binding.run).toContain('verify-upload "Docker E2E image"');
      expect(binding.run).toContain('"$ARTIFACT_ID" "$ARTIFACT_NAME" "$ARTIFACT_DIGEST"');
      expect(binding.run).toContain('"$ARTIFACT_RUN_ID" "$ARTIFACT_RUN_ATTEMPT"');
      const download = step(consumer, "Download Docker E2E image artifact");
      expect(download.if).toContain("shared_image_policy == 'no-push-artifact'");
      expect(download.with).toMatchObject({
        "artifact-ids": "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_id }}",
        "github-token": "${{ github.token }}",
        "run-id": "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_run_id }}",
      });
      expect(consumer.steps?.indexOf(binding) ?? -1).toBeLessThan(
        consumer.steps?.indexOf(download) ?? -1,
      );
      const loadArtifact = step(consumer, "Verify and load Docker E2E image artifact");
      expect(loadArtifact.env?.ARCHIVE_SHA256).toBe(
        "${{ needs.prepare_docker_e2e_image.outputs.image_archive_sha256 }}",
      );
      expect(loadArtifact.env?.PACKAGE_SHA256).toBe(
        "${{ needs.prepare_docker_e2e_image.outputs.package_sha256 }}",
      );
      expect(loadArtifact.env?.OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT).toBe(
        "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_run_attempt }}",
      );
      expect(loadArtifact.env?.OPENCLAW_SHARED_IMAGE_RUN_ID).toBe(
        "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_run_id }}",
      );
      expect(loadArtifact.run).toContain("shared-image-artifact.sh");
      expect(loadArtifact.run).toContain('OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256="$ARCHIVE_SHA256"');
      expect(loadArtifact.run).toContain('OPENCLAW_SHARED_IMAGE_PACKAGE_SHA256="$PACKAGE_SHA256"');
      expect(step(consumer, "Log in to GHCR for shared Docker E2E image").if).toContain(
        "shared_image_policy != 'no-push-artifact'",
      );
      for (const pullName of [
        "Pull shared bare Docker E2E image",
        "Pull shared functional Docker E2E image",
      ]) {
        expect(step(consumer, pullName).if).toContain("shared_image_policy != 'no-push-artifact'");
      }
    }

    for (const name of [
      "validate_live_models_docker",
      "validate_live_models_docker_targeted",
      "validate_live_docker_provider_suites",
    ]) {
      const consumer = job(workflow, name);
      expect(consumer.needs).toContain("live_test_image_ready");
      expect(consumer.env?.OPENCLAW_LIVE_REQUIRE_LOCAL_IMAGE).toContain("no-push-artifact");
      const binding = step(consumer, "Validate live-test image artifact binding");
      expect(binding.if).toContain("shared_image_policy == 'no-push-artifact'");
      expect(binding.env).toMatchObject({
        ARTIFACT_DIGEST: "${{ needs.prepare_live_test_image.outputs.image_artifact_digest }}",
        ARTIFACT_ID: "${{ needs.prepare_live_test_image.outputs.image_artifact_id }}",
        ARTIFACT_NAME: "${{ needs.prepare_live_test_image.outputs.image_artifact_name }}",
        ARTIFACT_RUN_ATTEMPT:
          "${{ needs.prepare_live_test_image.outputs.image_artifact_run_attempt }}",
        ARTIFACT_RUN_ID: "${{ needs.prepare_live_test_image.outputs.image_artifact_run_id }}",
        GH_TOKEN: "${{ github.token }}",
      });
      expect(binding.run).toContain('verify-upload "live-test image"');
      expect(binding.run).toContain('"$ARTIFACT_ID" "$ARTIFACT_NAME" "$ARTIFACT_DIGEST"');
      expect(binding.run).toContain('"$ARTIFACT_RUN_ID" "$ARTIFACT_RUN_ATTEMPT"');
      const download = step(consumer, "Download live-test image artifact");
      expect(download.if).toContain("shared_image_policy == 'no-push-artifact'");
      expect(download.with).toMatchObject({
        "artifact-ids": "${{ needs.prepare_live_test_image.outputs.image_artifact_id }}",
        "github-token": "${{ github.token }}",
        "run-id": "${{ needs.prepare_live_test_image.outputs.image_artifact_run_id }}",
      });
      expect(consumer.steps?.indexOf(binding) ?? -1).toBeLessThan(
        consumer.steps?.indexOf(download) ?? -1,
      );
      const loadArtifact = step(consumer, "Verify and load live-test image artifact");
      expect(loadArtifact.env?.ARCHIVE_SHA256).toBe(
        "${{ needs.prepare_live_test_image.outputs.image_archive_sha256 }}",
      );
      expect(loadArtifact.env?.OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT).toBe(
        "${{ needs.prepare_live_test_image.outputs.image_artifact_run_attempt }}",
      );
      expect(loadArtifact.env?.OPENCLAW_SHARED_IMAGE_RUN_ID).toBe(
        "${{ needs.prepare_live_test_image.outputs.image_artifact_run_id }}",
      );
      expect(loadArtifact.run).toContain("shared-image-artifact.sh");
      expect(loadArtifact.run).toContain('OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256="$ARCHIVE_SHA256"');
      expect(step(consumer, "Log in to GHCR").if).toContain(
        "shared_image_policy != 'no-push-artifact'",
      );
    }

    const liveBuild = readFileSync(LIVE_BUILD, "utf8");
    const requireLocalIndex = liveBuild.indexOf("OPENCLAW_LIVE_REQUIRE_LOCAL_IMAGE");
    const pullIndex = liveBuild.indexOf("Live-test image not found locally; pulling");
    expect(requireLocalIndex).toBeGreaterThanOrEqual(0);
    expect(pullIndex).toBeGreaterThan(requireLocalIndex);
    expect(liveBuild).toContain("Required local live-test image not found");
  });

  it("keeps performance evidence artifact-only when dispatched by Full Release", () => {
    const fullText = readFileSync(FULL_RELEASE, "utf8");
    const performance = readWorkflow(PERFORMANCE);
    const kova = job(performance, "kova");
    const dangerousSteps = ["Prepare clawgrit reports checkout", "Publish to clawgrit reports"];

    expect(performance.on?.workflow_dispatch?.inputs?.publish_reports).toMatchObject({
      default: false,
      type: "boolean",
    });
    expect(fullText).toContain("-f publish_reports=false");
    expect(fullText).toContain("Report publication: disabled (artifacts only)");
    expect(fullText).toContain('performanceReportPublication: "artifact-only"');
    const guard = job(performance, "artifact_only_guard");
    expect(guard.if).toContain("inputs.publish_reports != true");
    expect(step(guard, "Verify report publisher stayed disabled").env?.KOVA_RESULT).toBe(
      "${{ needs.kova.result }}",
    );
    for (const name of dangerousSteps) {
      expect(step(kova, name).if).toContain("inputs.publish_reports == true");
    }
    expect(JSON.stringify(guard)).not.toContain("git push");
  });

  it("fails a missing required local live image before any registry pull", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-live-local-image-"));
    const bin = join(root, "bin");
    const calls = join(root, "docker.log");
    try {
      mkdirSync(bin);
      writeFileSync(calls, "");
      const docker = join(bin, "docker");
      writeFileSync(
        docker,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  exit 1
fi
if [[ "$1" == "pull" ]]; then
  exit 0
fi
exit 2
`,
      );
      chmodSync(docker, 0o755);

      const result = spawnSync("bash", [resolve(LIVE_BUILD)], {
        encoding: "utf8",
        env: {
          ...process.env,
          DOCKER_COMMAND_TIMEOUT: "5s",
          FAKE_DOCKER_LOG: calls,
          OPENCLAW_LIVE_IMAGE: "openclaw-live-test:required-local",
          OPENCLAW_LIVE_REQUIRE_LOCAL_IMAGE: "1",
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Required local live-test image not found: openclaw-live-test:required-local",
      );
      expect(readFileSync(calls, "utf8")).toBe("image inspect openclaw-live-test:required-local\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails a missing required local Docker E2E image before pull or build fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-docker-e2e-local-image-"));
    const bin = join(root, "bin");
    const calls = join(root, "docker.log");
    try {
      mkdirSync(bin);
      writeFileSync(calls, "");
      const docker = join(bin, "docker");
      writeFileSync(
        docker,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  exit 1
fi
if [[ "$1" == "pull" ]]; then
  exit 0
fi
exit 2
`,
      );
      chmodSync(docker, 0o755);

      const result = spawnSync(
        "bash",
        [
          "-c",
          `source "$1"
docker_e2e_build_or_reuse "openclaw-e2e:required-local" "required local image test"`,
          "bash",
          resolve(DOCKER_E2E_IMAGE_HELPER),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_DOCKER_LOG: calls,
            OPENCLAW_DOCKER_BUILD_ON_MISSING: "1",
            OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
            OPENCLAW_SKIP_DOCKER_BUILD: "1",
            PATH: `${bin}:${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Required local Docker E2E image not found: openclaw-e2e:required-local",
      );
      expect(readFileSync(calls, "utf8")).toBe("image inspect openclaw-e2e:required-local\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
