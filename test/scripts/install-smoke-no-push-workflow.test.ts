import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const INSTALL_SMOKE = ".github/workflows/install-smoke.yml";
const INSTALL_SMOKE_REUSABLE = ".github/workflows/install-smoke-reusable.yml";
const RELEASE_CHECKS = ".github/workflows/openclaw-release-checks.yml";

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  "working-directory"?: string;
};

type WorkflowJob = {
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  strategy?: {
    "fail-fast"?: boolean;
    matrix?: {
      include?: Array<Record<string, unknown>>;
    };
  };
  steps?: WorkflowStep[];
  "timeout-minutes"?: number | string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<string, WorkflowJob>;
  on?: {
    schedule?: unknown;
    workflow_call?: { inputs?: Record<string, Record<string, unknown>> };
    workflow_dispatch?: { inputs?: Record<string, Record<string, unknown>> };
  };
  permissions?: Record<string, unknown>;
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

describe("install smoke no-push root image transport", () => {
  it("keeps schedule/manual orchestration read-only and delegates to the reusable core", () => {
    const workflow = readWorkflow(INSTALL_SMOKE);
    expect(workflow.on?.schedule).toBeDefined();
    expect(workflow.on?.workflow_dispatch?.inputs).toMatchObject({
      run_bun_global_install_smoke: { default: false, type: "boolean" },
      update_baseline_version: { default: "latest", type: "string" },
    });
    expect(workflow.on?.workflow_call).toBeUndefined();
    expect(workflow.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
    });

    const delegated = job(workflow, "install_smoke");
    expect(delegated.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
    });
    expect(delegated.uses).toBe("./.github/workflows/install-smoke-reusable.yml");
    expect(delegated.with).toMatchObject({
      allow_unreleased_changelog: true,
      ref: "${{ github.sha }}",
      run_bun_global_install_smoke:
        "${{ github.event_name == 'schedule' || inputs.run_bun_global_install_smoke }}",
      update_baseline_version: "${{ inputs.update_baseline_version || 'latest' }}",
    });
    expect(readFileSync(INSTALL_SMOKE, "utf8")).not.toContain("packages: write");
  });

  it("makes the reusable core artifact-only and rejects registry transport", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    expect(workflow.on?.schedule).toBeUndefined();
    expect(workflow.on?.workflow_dispatch).toBeUndefined();
    expect(workflow.on?.workflow_call?.inputs?.allow_unreleased_changelog).toMatchObject({
      default: false,
      type: "boolean",
    });
    expect(workflow.on?.workflow_call?.inputs?.root_image_transport).toBeUndefined();
    expect(workflow.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
    });

    const preflight = job(workflow, "preflight");
    expect(preflight.outputs?.workflow_repository).toBeUndefined();
    expect(preflight.outputs?.workflow_sha).toBeUndefined();
    const workflowIdentity = step(preflight, "Assert trusted workflow identity");
    expect(workflowIdentity.env).toEqual({
      EXPECTED_WORKFLOW_REPOSITORY: "${{ github.repository }}",
      JOB_CONTEXT: "${{ toJSON(job) }}",
    });
    expect(workflowIdentity.run).toContain(
      "job.workflow_repository must exactly match github.repository",
    );
    expect(workflowIdentity.run).toContain("job.workflow_sha must be a full lowercase commit SHA");
    expect(workflowIdentity.run).not.toContain("EXPECTED_WORKFLOW_SHA");

    const identityResult = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-c", workflowIdentity.run!],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          EXPECTED_WORKFLOW_REPOSITORY: "openclaw/openclaw",
          GITHUB_WORKFLOW_SHA: "a".repeat(40),
          JOB_CONTEXT: JSON.stringify({
            workflow_repository: "openclaw/openclaw",
            workflow_sha: "b".repeat(40),
          }),
        },
      },
    );
    expect(identityResult.status, identityResult.stderr).toBe(0);
    const workflowText = JSON.stringify(workflow);
    expect(workflowText).not.toContain("${{ github.workflow_sha }}");
    expect(workflowText).not.toContain("fromJSON(toJSON(job)).workflow_");
    const trustedJobs: string[] = [];
    for (const [jobName, workflowJob] of Object.entries(workflow.jobs)) {
      const trustedCheckouts =
        workflowJob.steps?.filter((candidate) => candidate.name?.startsWith("Checkout trusted")) ??
        [];
      if (trustedCheckouts.length === 0) {
        continue;
      }
      trustedJobs.push(jobName);
      const resolver = step(workflowJob, "Restore exact trusted workflow revision");
      expect(resolver.env, jobName).toMatchObject({
        EXPECTED_WORKFLOW_REPOSITORY: "${{ github.repository }}",
        JOB_CONTEXT: "${{ toJSON(job) }}",
      });
      expect(resolver.env?.HARNESS_PATH, jobName).toMatch(/^(\.|\.release-harness)$/u);
      expect(resolver.run, jobName).toContain(
        "job.workflow_sha must be a full lowercase commit SHA",
      );
      expect(resolver.run, jobName).toContain('"fetch"');
      expect(resolver.run, jobName).toContain(
        "`repository=${repository}\\nsha=${job.workflow_sha}\\n`",
      );
      const checkoutIndex = workflowJob.steps!.indexOf(trustedCheckouts[0]!);
      const resolverIndex = workflowJob.steps!.indexOf(resolver);
      expect(checkoutIndex, jobName).toBeLessThan(resolverIndex);
      for (const checkout of trustedCheckouts) {
        expect(checkout.with, jobName).toMatchObject({
          repository: "openclaw/openclaw",
          ref: "main",
          "fetch-depth": 1,
          "persist-credentials": false,
        });
      }
    }
    expect(trustedJobs.toSorted()).toEqual(
      [
        "bun_global_install_smoke",
        "installer_smoke_candidate_payload",
        "installer_smoke_nonroot",
        "installer_smoke_nonroot_image",
        "installer_smoke_update",
        "installer_smoke_update_image",
        "root_dockerfile_image",
        "root_dockerfile_smokes",
      ].toSorted(),
    );

    const candidateResolver = step(
      job(workflow, "installer_smoke_candidate_payload"),
      "Restore exact trusted workflow revision",
    );
    const runResolver = (workflowRepository: string, workflowSha: string) =>
      spawnSync("bash", ["--noprofile", "--norc", "-c", candidateResolver.run!], {
        encoding: "utf8",
        env: {
          ...process.env,
          EXPECTED_WORKFLOW_REPOSITORY: "openclaw/openclaw",
          GITHUB_WORKFLOW_SHA: "a".repeat(40),
          HARNESS_PATH: ".",
          JOB_CONTEXT: JSON.stringify({
            workflow_repository: workflowRepository,
            workflow_sha: workflowSha,
          }),
        },
      });
    const malformedSha = runResolver("openclaw/openclaw", "not-a-sha");
    expect(malformedSha.status).not.toBe(0);
    expect(malformedSha.stderr).toContain("job.workflow_sha must be a full lowercase commit SHA");
    const wrongRepository = runResolver("attacker/openclaw", "b".repeat(40));
    expect(wrongRepository.status).not.toBe(0);
    expect(wrongRepository.stderr).toContain(
      "job.workflow_repository must exactly match github.repository",
    );
    const manifest = step(preflight, "Build install-smoke CI manifest");
    expect(manifest.env).toEqual({
      OPENCLAW_CI_WORKFLOW_BUN_GLOBAL_INSTALL_SMOKE:
        "${{ inputs.run_bun_global_install_smoke || 'false' }}",
    });
    expect(manifest.run).toContain(
      'dockerfile_image="openclaw-dockerfile-smoke-local:${target_sha}"',
    );
    expect(manifest.run).toContain(
      'run_bun_global_install_smoke="$workflow_bun_global_install_smoke"',
    );
    expect(manifest.run).not.toContain("event_name");
    expect(manifest.run).not.toContain("workflow_call");

    const text = readFileSync(INSTALL_SMOKE_REUSABLE, "utf8");
    expect(text).not.toContain("packages: write");
    expect(text).not.toContain("docker/login-action@");
    expect(text).not.toContain("--push");
    expect(workflow.jobs.push_root_dockerfile_image).toBeUndefined();
  });

  it("builds one local target image and uploads provenance-bound bytes", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    const producer = job(workflow, "root_dockerfile_image");
    expect(producer.permissions).toEqual({
      contents: "read",
      packages: "read",
    });
    expect(producer.outputs).toMatchObject({
      archive_sha256: "${{ steps.image_artifact.outputs.archive_sha256 }}",
      artifact_digest: "${{ steps.image_artifact_upload.outputs.artifact-digest }}",
      artifact_id: "${{ steps.image_artifact_upload.outputs.artifact-id }}",
      artifact_name: "${{ steps.image_artifact.outputs.artifact_name }}",
      artifact_run_attempt: "${{ steps.image_artifact.outputs.run_attempt }}",
      artifact_run_id: "${{ steps.image_artifact.outputs.run_id }}",
      image_ref: "${{ steps.image.outputs.image_ref }}",
    });
    expect(producer.outputs?.image_exists).toBeUndefined();
    expect(producer.steps?.find((candidate) => candidate.name === "Checkout CLI")).toBeUndefined();
    const sourceArchive = step(producer, "Download exact candidate source archive");
    expect(sourceArchive.run).toContain(
      '"https://codeload.github.com/${TARGET_REPOSITORY}/tar.gz/${TARGET_SHA}"',
    );
    expect(sourceArchive.run).toContain('test -f "$candidate_dir/Dockerfile"');
    expect(step(producer, "Checkout trusted release harness").if).toBeUndefined();

    const localBuild = step(producer, "Build local root Dockerfile smoke image");
    expect(localBuild.if).toBeUndefined();
    expect(localBuild.run).toContain("--load");
    expect(localBuild.run).not.toContain("--push");
    expect(localBuild.run).toContain('-t "$IMAGE_REF"');
    expect(localBuild.run).toContain('-f "$CANDIDATE_DIR/Dockerfile"');

    const pack = step(producer, "Pack root Dockerfile image artifact");
    expect(pack.if).toBeUndefined();
    expect(pack.env).toMatchObject({
      IMAGE_REF: "${{ needs.preflight.outputs.dockerfile_image }}",
      TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
      WORKFLOW_SHA: "${{ steps.workflow.outputs.sha }}",
    });
    expect(pack.run).toContain(
      'artifact_name="install-smoke-root-image-${TARGET_SHA:0:12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"',
    );
    expect(pack.run).toContain(
      'pack "$artifact_dir" install-smoke-root "$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"',
    );

    const upload = step(producer, "Upload root Dockerfile image artifact");
    expect(upload.if).toBeUndefined();
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toMatchObject({
      "compression-level": 0,
      "if-no-files-found": "error",
      name: "${{ steps.image_artifact.outputs.artifact_name }}",
      path: "${{ steps.image_artifact.outputs.artifact_path }}",
    });

    const ready = job(workflow, "root_dockerfile_image_ready");
    expect(ready.needs).toEqual(["preflight", "root_dockerfile_image"]);
    const verify = step(ready, "Verify root Dockerfile image preparation");
    expect(verify.env).toEqual({
      PREPARE_RESULT: "${{ needs.root_dockerfile_image.result }}",
    });
    expect(verify.run).toContain('if [[ "$PREPARE_RESULT" != "success" ]]');
    expect(verify.run).not.toContain("PUSH_RESULT");
  });

  it("verifies and loads the immutable artifact in every consumer", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    for (const jobName of ["root_dockerfile_smokes"]) {
      const consumer = job(workflow, jobName);
      expect(consumer.needs, jobName).toContain("root_dockerfile_image_ready");
      expect(consumer.env?.OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE, jobName).toBe("1");
      expect(step(consumer, "Checkout trusted release harness").if, jobName).toBeUndefined();
      expect(
        consumer.steps?.find((candidate) => candidate.name === "Log in to GHCR"),
        jobName,
      ).toBeUndefined();
      expect(
        consumer.steps?.find((candidate) => candidate.name === "Pull root Dockerfile smoke image"),
        jobName,
      ).toBeUndefined();

      const binding = step(consumer, "Validate root Dockerfile image artifact binding");
      expect(binding.if, jobName).toBeUndefined();
      expect(binding.env, jobName).toMatchObject({
        ARCHIVE_SHA256: "${{ needs.root_dockerfile_image.outputs.archive_sha256 }}",
        ARTIFACT_DIGEST: "${{ needs.root_dockerfile_image.outputs.artifact_digest }}",
        ARTIFACT_ID: "${{ needs.root_dockerfile_image.outputs.artifact_id }}",
        ARTIFACT_NAME: "${{ needs.root_dockerfile_image.outputs.artifact_name }}",
        ARTIFACT_RUN_ATTEMPT: "${{ needs.root_dockerfile_image.outputs.artifact_run_attempt }}",
        ARTIFACT_RUN_ID: "${{ needs.root_dockerfile_image.outputs.artifact_run_id }}",
        GH_TOKEN: "${{ github.token }}",
        TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
      });
      expect(binding.run, jobName).toContain(
        'expected_artifact_name="install-smoke-root-image-${TARGET_SHA:0:12}-${ARTIFACT_RUN_ID}-${ARTIFACT_RUN_ATTEMPT}"',
      );
      expect(binding.run, jobName).toContain('[[ "$ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]]');
      expect(binding.run, jobName).toContain(
        "bash .release-harness/scripts/docker/shared-image-artifact.sh",
      );
      expect(binding.run, jobName).toContain('verify-upload "Root image"');
      expect(binding.run, jobName).toContain('"$ARTIFACT_RUN_ID" "$ARTIFACT_RUN_ATTEMPT"');
      expect(binding.run, jobName).not.toContain("gh api");
      expect(binding.run, jobName).not.toContain("artifact_json=");
      expect(binding.run, jobName).not.toContain("attempt_json=");
      expect(binding.run, jobName).not.toContain("<<<");

      const download = step(consumer, "Download root Dockerfile image artifact");
      expect(download.if, jobName).toBeUndefined();
      expect(download.with, jobName).toMatchObject({
        "artifact-ids": "${{ needs.root_dockerfile_image.outputs.artifact_id }}",
        "github-token": "${{ github.token }}",
        path: "${{ runner.temp }}/install-smoke-root-image",
        "run-id": "${{ needs.root_dockerfile_image.outputs.artifact_run_id }}",
      });

      const load = step(consumer, "Verify and load root Dockerfile image artifact");
      expect(load.if, jobName).toBeUndefined();
      expect(load.run, jobName).toContain(
        'load "${RUNNER_TEMP}/install-smoke-root-image" install-smoke-root',
      );
      expect(load.run, jobName).toContain('"$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"');

      const requireLocal = step(consumer, "Require local root Dockerfile image");
      expect(requireLocal.if, jobName).toBeUndefined();
      expect(requireLocal.run, jobName).toBe('docker image inspect "$IMAGE_REF" >/dev/null');
    }

    const text = readFileSync(INSTALL_SMOKE_REUSABLE, "utf8");
    expect(text.match(/verify-upload "Root image"/g)).toHaveLength(1);
    expect(text).not.toContain("gh api");
  });

  it("binds independent installer producer-consumer pairs to immutable artifact tuples", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    const pairs = [
      {
        artifactKind: "install-smoke-update",
        artifactPrefix: "install-smoke-update-image",
        buildName: "Build installer smoke image",
        consumerName: "installer_smoke_update",
        downloadName: "Download installer update image artifact",
        group: "update",
        loadName: "Verify and load installer update image artifact",
        packName: "Pack installer smoke image artifact",
        producerName: "installer_smoke_update_image",
        testName: "Run installer update docker tests",
        uploadName: "Upload installer smoke image artifact",
        validateName: "Validate installer update image artifact binding",
      },
      {
        artifactKind: "install-smoke-nonroot",
        artifactPrefix: "install-smoke-nonroot-image",
        buildName: "Build installer non-root image",
        consumerName: "installer_smoke_nonroot",
        downloadName: "Download installer non-root image artifact",
        group: "nonroot",
        loadName: "Verify and load installer non-root image artifact",
        packName: "Pack installer non-root image artifact",
        producerName: "installer_smoke_nonroot_image",
        testName: "Run installer non-root docker tests",
        uploadName: "Upload installer non-root image artifact",
        validateName: "Validate installer non-root image artifact binding",
      },
    ] as const;

    for (const pair of pairs) {
      const producer = job(workflow, pair.producerName);
      expect(producer.needs, pair.producerName).toEqual(["preflight"]);
      expect(producer["timeout-minutes"], pair.producerName).toBe(45);
      expect(producer.outputs, pair.producerName).toEqual({
        archive_sha256: "${{ steps.image_artifact.outputs.archive_sha256 }}",
        artifact_digest: "${{ steps.image_artifact_upload.outputs.artifact-digest }}",
        artifact_id: "${{ steps.image_artifact_upload.outputs.artifact-id }}",
        artifact_name: "${{ steps.image_artifact.outputs.artifact_name }}",
        artifact_run_attempt: "${{ steps.image_artifact.outputs.run_attempt }}",
        artifact_run_id: "${{ steps.image_artifact.outputs.run_id }}",
        target_sha: "${{ steps.image_artifact.outputs.target_sha }}",
        workflow_sha: "${{ steps.image_artifact.outputs.workflow_sha }}",
      });
      expect(step(producer, pair.buildName).run, pair.producerName).toContain("--load");

      const pack = step(producer, pair.packName);
      expect(pack.run, pair.producerName).toContain(
        `artifact_name="${pair.artifactPrefix}-\${TARGET_SHA}-\${GITHUB_RUN_ID}-\${GITHUB_RUN_ATTEMPT}"`,
      );
      expect(pack.run, pair.producerName).toContain(
        `pack "$artifact_dir" ${pair.artifactKind} "$TARGET_SHA" "$WORKFLOW_SHA" "$IMAGE_REF"`,
      );
      expect(pack.run, pair.producerName).toContain('echo "archive_sha256=$archive_sha256"');
      expect(pack.run, pair.producerName).toContain('echo "run_attempt=$GITHUB_RUN_ATTEMPT"');
      expect(pack.run, pair.producerName).toContain('echo "run_id=$GITHUB_RUN_ID"');
      expect(pack.run, pair.producerName).toContain('echo "target_sha=$TARGET_SHA"');
      expect(pack.run, pair.producerName).toContain('echo "workflow_sha=$WORKFLOW_SHA"');
      expect(step(producer, pair.uploadName).with, pair.producerName).toMatchObject({
        "compression-level": 0,
        "if-no-files-found": "error",
        name: "${{ steps.image_artifact.outputs.artifact_name }}",
      });

      const consumer = job(workflow, pair.consumerName);
      const expectedNeeds = ["preflight", "installer_smoke_candidate_payload", pair.producerName];
      expect(consumer.needs, pair.consumerName).toEqual(expectedNeeds);
      expect(consumer["timeout-minutes"], pair.consumerName).toBe(
        pair.group === "update" ? 120 : 60,
      );

      const binding = step(consumer, pair.validateName);
      expect(binding.env, pair.consumerName).toMatchObject({
        ARCHIVE_SHA256: `\${{ needs.${pair.producerName}.outputs.archive_sha256 }}`,
        ARTIFACT_DIGEST: `\${{ needs.${pair.producerName}.outputs.artifact_digest }}`,
        ARTIFACT_ID: `\${{ needs.${pair.producerName}.outputs.artifact_id }}`,
        ARTIFACT_NAME: `\${{ needs.${pair.producerName}.outputs.artifact_name }}`,
        ARTIFACT_RUN_ATTEMPT: `\${{ needs.${pair.producerName}.outputs.artifact_run_attempt }}`,
        ARTIFACT_RUN_ID: `\${{ needs.${pair.producerName}.outputs.artifact_run_id }}`,
        ARTIFACT_TARGET_SHA: `\${{ needs.${pair.producerName}.outputs.target_sha }}`,
        ARTIFACT_WORKFLOW_SHA: `\${{ needs.${pair.producerName}.outputs.workflow_sha }}`,
        TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
        WORKFLOW_SHA: "${{ steps.workflow.outputs.sha }}",
      });
      expect(binding.run, pair.consumerName).toContain('[[ "$ARTIFACT_ID" =~ ^[1-9][0-9]*$ ]]');
      expect(binding.run, pair.consumerName).toContain(
        '[[ "$ARTIFACT_DIGEST" =~ ^[a-f0-9]{64}$ ]]',
      );
      expect(binding.run, pair.consumerName).toContain('[[ "$ARCHIVE_SHA256" =~ ^[a-f0-9]{64}$ ]]');
      expect(binding.run, pair.consumerName).toContain(
        '[[ "$ARTIFACT_TARGET_SHA" == "$TARGET_SHA" ]]',
      );
      expect(binding.run, pair.consumerName).toContain(
        '[[ "$ARTIFACT_WORKFLOW_SHA" == "$WORKFLOW_SHA" ]]',
      );
      expect(binding.run, pair.consumerName).toContain(
        `expected_artifact_name="${pair.artifactPrefix}-\${TARGET_SHA}-\${ARTIFACT_RUN_ID}-\${ARTIFACT_RUN_ATTEMPT}"`,
      );
      expect(binding.run, pair.consumerName).toContain("verify-upload");

      const download = step(consumer, pair.downloadName);
      expect(download.with, pair.consumerName).toMatchObject({
        "artifact-ids": `\${{ needs.${pair.producerName}.outputs.artifact_id }}`,
        "github-token": "${{ github.token }}",
        "run-id": `\${{ needs.${pair.producerName}.outputs.artifact_run_id }}`,
      });
      expect(download.with?.name, pair.consumerName).toBeUndefined();

      const load = step(consumer, pair.loadName);
      expect(load.env, pair.consumerName).toMatchObject({
        OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256: `\${{ needs.${pair.producerName}.outputs.archive_sha256 }}`,
        OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT: `\${{ needs.${pair.producerName}.outputs.artifact_run_attempt }}`,
        OPENCLAW_SHARED_IMAGE_RUN_ID: `\${{ needs.${pair.producerName}.outputs.artifact_run_id }}`,
        TARGET_SHA: `\${{ needs.${pair.producerName}.outputs.target_sha }}`,
        WORKFLOW_SHA: `\${{ needs.${pair.producerName}.outputs.workflow_sha }}`,
      });
      expect(load.run, pair.consumerName).toContain(
        `load "\${RUNNER_TEMP}/${pair.artifactPrefix}" ${pair.artifactKind}`,
      );

      expect(
        consumer.steps?.some((candidate) =>
          candidate.uses?.includes("./.github/actions/setup-node-env"),
        ),
      ).toBe(false);
      expect(step(consumer, pair.testName).env).toMatchObject({
        OPENCLAW_INSTALL_SMOKE_FROZEN_PAYLOAD_DIR:
          "${{ runner.temp }}/install-smoke-candidate-payload",
        OPENCLAW_INSTALL_SMOKE_GROUP: pair.group,
      });
    }

    const bunConsumer = job(workflow, "bun_global_install_smoke");
    expect(bunConsumer.needs).toEqual(["preflight", "installer_smoke_candidate_payload"]);
    const bunBinding = step(bunConsumer, "Validate candidate payload artifact binding");
    expect(bunBinding.env).toMatchObject({
      ARTIFACT_DIGEST: "${{ needs.installer_smoke_candidate_payload.outputs.artifact_digest }}",
      ARTIFACT_ID: "${{ needs.installer_smoke_candidate_payload.outputs.artifact_id }}",
      ARTIFACT_RUN_ATTEMPT:
        "${{ needs.installer_smoke_candidate_payload.outputs.artifact_run_attempt }}",
      ARTIFACT_RUN_ID: "${{ needs.installer_smoke_candidate_payload.outputs.artifact_run_id }}",
      ARTIFACT_HARNESS_SHA: "${{ needs.installer_smoke_candidate_payload.outputs.harness_sha }}",
      ARTIFACT_TARGET_SHA: "${{ needs.installer_smoke_candidate_payload.outputs.target_sha }}",
      HARNESS_SHA: "${{ steps.workflow.outputs.sha }}",
      TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
    });
    expect(bunBinding.run).toContain('[[ "$ARTIFACT_HARNESS_SHA" == "$HARNESS_SHA" ]]');
    expect(bunBinding.run).toContain("verify-upload");
    expect(step(bunConsumer, "Download candidate payload artifact").with).toMatchObject({
      "artifact-ids": "${{ needs.installer_smoke_candidate_payload.outputs.artifact_id }}",
      "run-id": "${{ needs.installer_smoke_candidate_payload.outputs.artifact_run_id }}",
    });
    expect(step(bunConsumer, "Setup trusted release harness for Bun smoke")).toMatchObject({
      uses: "./.release-harness/.github/actions/setup-release-harness",
      with: { "node-version": "24.x" },
    });
    const bunVerify = step(bunConsumer, "Verify candidate payload contents");
    expect(bunVerify.env).toMatchObject({
      MANIFEST_SHA256: "${{ needs.installer_smoke_candidate_payload.outputs.manifest_sha256 }}",
      PACKAGE_VERSION: "${{ needs.installer_smoke_candidate_payload.outputs.package_version }}",
      PRODUCER_RUN_ATTEMPT:
        "${{ needs.installer_smoke_candidate_payload.outputs.artifact_run_attempt }}",
      PRODUCER_RUN_ID: "${{ needs.installer_smoke_candidate_payload.outputs.artifact_run_id }}",
      SOURCE_ARCHIVE_SHA256:
        "${{ needs.installer_smoke_candidate_payload.outputs.source_archive_sha256 }}",
    });
    expect(bunVerify.run).toContain("install-smoke-candidate-payload.mts verify");
    expect(bunVerify.run).toContain('--run-id "$PRODUCER_RUN_ID"');
    expect(bunVerify.run).toContain('--run-attempt "$PRODUCER_RUN_ATTEMPT"');
    expect(step(bunConsumer, "Install Bun for global smoke").run).toBe("npm install -g bun@1.4.0");
    expect(step(bunConsumer, "Run Bun global install candidate-payload smoke")).toMatchObject({
      "working-directory": ".release-harness",
      env: {
        OPENCLAW_BUN_GLOBAL_SMOKE_HOST_BUILD: "0",
        OPENCLAW_BUN_GLOBAL_SMOKE_PACKAGE_TGZ:
          "${{ runner.temp }}/install-smoke-candidate-payload/candidate.tgz",
      },
      run: "bash scripts/e2e/bun-global-install-smoke.sh",
    });
    expect(JSON.stringify(bunConsumer)).not.toContain("root_dockerfile_image");
    expect(JSON.stringify(bunConsumer)).not.toContain("OPENCLAW_BUN_GLOBAL_SMOKE_DIST_IMAGE");
    expect(JSON.stringify(bunConsumer)).not.toContain(
      "./.release-harness/.github/actions/setup-node-env",
    );
  });

  it("packages candidate code only in an isolated image and verifies the sealed payload", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    const producer = job(workflow, "installer_smoke_candidate_payload");
    expect(producer.needs).toEqual(["preflight"]);
    expect(producer["timeout-minutes"]).toBe(75);
    expect(producer.outputs).toMatchObject({
      artifact_digest: "${{ steps.payload_upload.outputs.artifact-digest }}",
      artifact_id: "${{ steps.payload_upload.outputs.artifact-id }}",
      harness_repository: "${{ steps.payload.outputs.harness_repository }}",
      harness_sha: "${{ steps.payload.outputs.harness_sha }}",
      manifest_sha256: "${{ steps.payload.outputs.manifest_sha256 }}",
      package_version: "${{ steps.payload.outputs.package_version }}",
      repository: "${{ steps.payload.outputs.repository }}",
      source_archive_sha256: "${{ steps.payload.outputs.source_archive_sha256 }}",
      target_sha: "${{ steps.payload.outputs.target_sha }}",
    });
    expect(step(producer, "Checkout trusted release harness").with).toMatchObject({
      repository: "openclaw/openclaw",
      ref: "main",
      "fetch-depth": 1,
      "persist-credentials": false,
    });
    expect(step(producer, "Require exact trusted installer harness").run).toContain(
      '[[ "$(git -C .release-harness rev-parse HEAD)" == "$EXPECTED_SHA" ]]',
    );
    const download = step(producer, "Download exact candidate source archive");
    expect(download.run).toContain(
      '"https://codeload.github.com/${TARGET_REPOSITORY}/tar.gz/${TARGET_SHA}"',
    );
    const packageStep = step(producer, "Package candidate only inside pinned harness");
    expect(packageStep.run).toContain("--user node");
    expect(packageStep.run).toContain("--cap-drop ALL");
    expect(packageStep.run).toContain("pnpm install --frozen-lockfile");
    expect(packageStep.run).not.toContain("github.token");
    const seal = step(producer, "Seal candidate payload in clean pinned harness");
    expect(seal.run).toContain("--network none");
    expect(seal.run).toContain('install -d -m 0750 "$payload_dir"');
    expect(seal.run).toContain('--user "$(id -u):$(id -g)"');
    expect(seal.run).not.toContain('chmod 0777 "$payload_dir"');
    expect(seal.run).toContain("install-smoke-candidate-payload.mts seal");
    expect(seal.run).toContain("--harness-sha");

    for (const consumerName of ["installer_smoke_update", "installer_smoke_nonroot"]) {
      const consumer = job(workflow, consumerName);
      expect(consumer.steps?.find((candidate) => candidate.name === "Checkout candidate CLI")).toBe(
        undefined,
      );
      const binding = step(consumer, "Validate candidate payload artifact binding");
      expect(binding.run).toContain('verify-upload "Candidate payload"');
      expect(binding.run).toContain(
        'expected_artifact_name="install-smoke-candidate-payload-${TARGET_SHA}-${ARTIFACT_RUN_ID}-${ARTIFACT_RUN_ATTEMPT}"',
      );
      const verify = step(consumer, "Verify candidate payload contents");
      expect(verify.env).toMatchObject({
        MANIFEST_SHA256: "${{ needs.installer_smoke_candidate_payload.outputs.manifest_sha256 }}",
        PACKAGE_VERSION: "${{ needs.installer_smoke_candidate_payload.outputs.package_version }}",
        SOURCE_ARCHIVE_SHA256:
          "${{ needs.installer_smoke_candidate_payload.outputs.source_archive_sha256 }}",
      });
      expect(verify.run).toContain("--manifest-sha256");
      expect(verify.run).toContain("--source-archive-sha256");
    }
  });

  it("drains every independent producer and consumer without sibling failure suppression", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    const update = job(workflow, "installer_smoke_update");
    const nonroot = job(workflow, "installer_smoke_nonroot");
    const aggregate = job(workflow, "installer_smoke");

    expect(update.needs).toEqual([
      "preflight",
      "installer_smoke_candidate_payload",
      "installer_smoke_update_image",
    ]);
    expect(update.needs).not.toContain("installer_smoke_nonroot_image");
    expect(nonroot.needs).toEqual([
      "preflight",
      "installer_smoke_candidate_payload",
      "installer_smoke_nonroot_image",
    ]);
    expect(nonroot.needs).not.toContain("root_dockerfile_image");
    expect(nonroot.needs).not.toContain("root_dockerfile_image_ready");
    expect(nonroot.needs).not.toContain("installer_smoke_update_image");

    expect(aggregate.if).toContain("always()");
    expect(aggregate.needs).toEqual([
      "preflight",
      "root_dockerfile_image",
      "root_dockerfile_image_ready",
      "installer_smoke_candidate_payload",
      "installer_smoke_update_image",
      "installer_smoke_update",
      "installer_smoke_nonroot_image",
      "installer_smoke_nonroot",
    ]);
    expect(aggregate["timeout-minutes"]).toBe(5);
    const verify = step(aggregate, "Verify installer smoke groups");
    expect(verify.env).toEqual({
      CANDIDATE_PAYLOAD_RESULT: "${{ needs.installer_smoke_candidate_payload.result }}",
      NONROOT_CONSUMER_RESULT: "${{ needs.installer_smoke_nonroot.result }}",
      NONROOT_PRODUCER_RESULT: "${{ needs.installer_smoke_nonroot_image.result }}",
      ROOT_IMAGE_READY_RESULT: "${{ needs.root_dockerfile_image_ready.result }}",
      ROOT_IMAGE_RESULT: "${{ needs.root_dockerfile_image.result }}",
      UPDATE_CONSUMER_RESULT: "${{ needs.installer_smoke_update.result }}",
      UPDATE_PRODUCER_RESULT: "${{ needs.installer_smoke_update_image.result }}",
    });
    for (const result of [
      "ROOT_IMAGE_RESULT",
      "ROOT_IMAGE_READY_RESULT",
      "CANDIDATE_PAYLOAD_RESULT",
      "UPDATE_PRODUCER_RESULT",
      "UPDATE_CONSUMER_RESULT",
      "NONROOT_PRODUCER_RESULT",
      "NONROOT_CONSUMER_RESULT",
    ]) {
      expect(verify.run).toContain(`"$${result}"`);
    }
  });

  it("selects the read-only reusable core from release checks", () => {
    const release = readWorkflow(RELEASE_CHECKS);
    const caller = job(release, "install_smoke_release_checks");
    expect(caller.uses).toBe("./.github/workflows/install-smoke-reusable.yml");
    expect(caller.permissions).toEqual({
      actions: "read",
      contents: "read",
      packages: "read",
    });
    expect(caller.with).toMatchObject({
      allow_unreleased_changelog:
        "${{ needs.resolve_target.outputs.allow_unreleased_changelog == 'true' }}",
      ref: "${{ needs.resolve_target.outputs.revision }}",
      run_bun_global_install_smoke: true,
    });
  });

  it("passes package changelog intent only to the candidate packager", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    expect(
      step(
        job(workflow, "installer_smoke_candidate_payload"),
        "Package candidate only inside pinned harness",
      ).env,
    ).toMatchObject({
      ALLOW_UNRELEASED_CHANGELOG: "${{ inputs.allow_unreleased_changelog }}",
    });
    expect(JSON.stringify(job(workflow, "bun_global_install_smoke"))).not.toContain(
      "OPENCLAW_BUN_GLOBAL_SMOKE_ALLOW_UNRELEASED_CHANGELOG",
    );
  });
});
