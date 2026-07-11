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
};

type WorkflowJob = {
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, unknown>;
  steps?: WorkflowStep[];
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
    expect(preflight.outputs?.workflow_repository).toBe(
      "${{ steps.workflow.outputs.workflow_repository }}",
    );
    expect(preflight.outputs?.workflow_sha).toBe("${{ steps.workflow.outputs.workflow_sha }}");
    const workflowIdentity = step(preflight, "Resolve job workflow identity");
    expect(workflowIdentity.env?.JOB_CONTEXT).toBe("${{ toJSON(job) }}");
    expect(workflowIdentity.run).toContain(
      "job.workflow_repository must be an owner/repository slug",
    );
    expect(workflowIdentity.run).toContain("job.workflow_sha must be a full lowercase commit SHA");
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
    expect(step(producer, "Checkout CLI").with).toMatchObject({
      ref: "${{ needs.preflight.outputs.target_sha }}",
      "persist-credentials": false,
    });
    expect(step(producer, "Checkout trusted image artifact helper").if).toBeUndefined();

    const localBuild = step(producer, "Build local root Dockerfile smoke image");
    expect(localBuild.if).toBeUndefined();
    expect(localBuild.run).toContain("--load");
    expect(localBuild.run).not.toContain("--push");
    expect(localBuild.run).toContain('-t "$IMAGE_REF"');

    const pack = step(producer, "Pack root Dockerfile image artifact");
    expect(pack.if).toBeUndefined();
    expect(pack.env).toMatchObject({
      IMAGE_REF: "${{ needs.preflight.outputs.dockerfile_image }}",
      TARGET_SHA: "${{ needs.preflight.outputs.target_sha }}",
      WORKFLOW_SHA: "${{ needs.preflight.outputs.workflow_sha }}",
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
    for (const jobName of [
      "root_dockerfile_smokes",
      "installer_smoke",
      "bun_global_install_smoke",
    ]) {
      const consumer = job(workflow, jobName);
      expect(consumer.needs, jobName).toContain("root_dockerfile_image_ready");
      expect(consumer.env?.OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE, jobName).toBe("1");
      expect(step(consumer, "Checkout trusted image artifact helper").if, jobName).toBeUndefined();
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
      expect(binding.run, jobName).toContain(
        "repos/${GITHUB_REPOSITORY}/actions/artifacts/${ARTIFACT_ID}",
      );
      expect(binding.run, jobName).toContain(
        "repos/${GITHUB_REPOSITORY}/actions/runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}",
      );

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
      ref: "${{ needs.resolve_target.outputs.revision }}",
      run_bun_global_install_smoke: true,
    });
    expect(caller.with).not.toHaveProperty("allow_unreleased_changelog");
  });

  it("passes package changelog intent only to current-tree smoke scripts", () => {
    const workflow = readWorkflow(INSTALL_SMOKE_REUSABLE);
    expect(step(job(workflow, "installer_smoke"), "Run installer docker tests").env).toMatchObject({
      OPENCLAW_INSTALL_SMOKE_ALLOW_UNRELEASED_CHANGELOG: "${{ inputs.allow_unreleased_changelog }}",
    });
    expect(
      step(job(workflow, "bun_global_install_smoke"), "Run Bun global install image-provider smoke")
        .env,
    ).toMatchObject({
      OPENCLAW_BUN_GLOBAL_SMOKE_ALLOW_UNRELEASED_CHANGELOG:
        "${{ inputs.allow_unreleased_changelog }}",
    });
  });
});
