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
  "working-directory"?: string;
};

type WorkflowJob = {
  if?: string;
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

  it("pins only Windows packaged-fresh checks to the known-good Node release", () => {
    const workflow = readWorkflow(WORKFLOW_PATH);
    const prepare = job(workflow, "prepare");
    const consumer = job(workflow, "cross_os_release_checks");
    const windowsPackagedFreshNodeVersion =
      "${{ matrix.os_id == 'windows' && matrix.suite == 'packaged-fresh' && '24.15.0' || env.NODE_VERSION }}";

    expect(step(prepare, "Setup Node.js").with?.["node-version"]).toBe("${{ env.NODE_VERSION }}");
    expect(step(prepare, "Setup pnpm").with?.["node-version"]).toBe("${{ env.NODE_VERSION }}");
    expect(step(consumer, "Setup Node.js").with?.["node-version"]).toBe(
      windowsPackagedFreshNodeVersion,
    );
    expect(step(consumer, "Setup pnpm").with?.["node-version"]).toBe(
      windowsPackagedFreshNodeVersion,
    );
  });

  it("retries only an interrupted Windows dashboard probe", () => {
    const workflow = readWorkflow(WORKFLOW_PATH);
    const consumer = job(workflow, "cross_os_release_checks");
    const run = step(consumer, "Run cross-OS release checks").run;

    expect(run).toContain("run_cross_os_release_checks() {");
    expect(run).toContain("if run_cross_os_release_checks; then");
    expect(run).toContain('"${OPENCLAW_RELEASE_CHECK_OS}" != "windows"');
    expect(run).toContain('"$status" -ne 127');
    expect(run).toContain('dashboard_log="${OUTPUT_DIR}/logs/${MODE}-dashboard.log"');
    expect(run).toContain('-f "${OUTPUT_DIR}/summary.json"');
    expect(run).toContain("attempt=.*url=http://127.0.0.1:");
    expect(run).toContain("retrying Windows release checks after the outer process exited 127");
    expect(run).toContain("run_cross_os_release_checks\n");
  });

  it("bounds npm baseline packing during prepare", () => {
    const workflow = readWorkflow(WORKFLOW_PATH);
    const baseline = step(job(workflow, "prepare"), "Resolve baseline package spec");
    const baselineMetadata = step(job(workflow, "prepare"), "Capture baseline metadata");

    expect(workflow.on?.workflow_dispatch?.inputs?.target_context_ref).toMatchObject({
      default: "",
      required: false,
    });
    expect(workflow.on?.workflow_call?.inputs?.target_context_ref).toMatchObject({
      default: "",
      required: false,
    });
    expect(baseline.env).toMatchObject({
      CANDIDATE_JSON: "${{ runner.temp }}/openclaw-cross-os-release-checks/prepare/candidate.json",
      INPUT_PREVIOUS_VERSION: "${{ inputs.previous_version }}",
      INPUT_TARGET_CONTEXT_REF: "${{ inputs.target_context_ref }}",
    });
    expect(baseline.run).toContain('"$INPUT_TARGET_CONTEXT_REF" == "extended-stable/"*');
    expect(baseline.run).toContain("npm view openclaw versions --json");
    expect(baseline.run).toContain("scripts/lib/release-upgrade-baseline.mts");
    expect(baseline.run).toContain('--target-context-ref "$INPUT_TARGET_CONTEXT_REF"');
    expect(baseline.run).toContain('--previous-version "$INPUT_PREVIOUS_VERSION"');
    expect(baseline.run).toContain('BASELINE_VERSION="$(npm view openclaw@latest version)"');
    expect(readFileSync(WORKFLOW_PATH, "utf8")).toContain(
      "timeout --preserve-status 300s npm pack --ignore-scripts",
    );
    expect(baselineMetadata["working-directory"]).toBe("workflow");
    expect(baselineMetadata.run).toContain(
      'import { resolveNpmJsonEntries } from "./scripts/lib/npm-json-output.mts";',
    );
    expect(baselineMetadata.run).toContain("const entry = resolveNpmJsonEntries(payload).at(-1);");
  });

  it("installs trusted workflow dependencies for artifact resolution and upgrade metadata", () => {
    const prepare = job(readWorkflow(WORKFLOW_PATH), "prepare");
    const install = step(prepare, "Install workflow validation dependencies");

    expect(install).toMatchObject({
      if: "inputs.candidate_artifact_name != '' || inputs.mode != 'fresh'",
      "working-directory": "workflow",
      run: "pnpm install --frozen-lockfile --prefer-offline --ignore-scripts",
    });
    expect(step(prepare, "Build candidate artifact once").if).toBe(
      "inputs.candidate_artifact_name == ''",
    );
    expect(step(prepare, "Capture baseline metadata").if).toBe("${{ inputs.mode != 'fresh' }}");

    const installIndex =
      prepare.steps?.findIndex(
        (candidate) => candidate.name === "Install workflow validation dependencies",
      ) ?? -1;
    for (const dependentStep of [
      "Resolve provided candidate package",
      "Capture baseline metadata",
    ]) {
      expect(installIndex, dependentStep).toBeLessThan(
        prepare.steps?.findIndex((candidate) => candidate.name === dependentStep) ?? -1,
      );
    }
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
        "${{ steps.release_package_upload.outputs.artifact-digest || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').packageArtifactDigest }}",
      artifact_id:
        "${{ steps.release_package_upload.outputs.artifact-id || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').packageArtifactId }}",
      artifact_name:
        "${{ steps.artifact.outputs.name || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').packageArtifactName }}",
      artifact_run_attempt:
        "${{ steps.artifact.outputs.run_attempt || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').packageArtifactRunAttempt }}",
      artifact_run_id:
        "${{ steps.artifact.outputs.run_id || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').packageArtifactRunId }}",
      package_file_name:
        "${{ steps.artifact.outputs.file_name || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').packageFileName }}",
      package_sha256:
        "${{ steps.package.outputs.sha256 || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').packageSha256 }}",
      package_version:
        "${{ steps.package.outputs.package_version || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').packageVersion }}",
      prepublish_plugin_registry_json: "${{ steps.registry_identity.outputs.json }}",
      source_sha:
        "${{ steps.package.outputs.source_sha || fromJSON(needs.resolve_target.outputs.candidate_artifact_json || '{}').packageSourceSha }}",
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
    const resolve = step(producer, "Resolve release package artifact");
    expect(resolve.run).toContain("--resolve-provider-required-companion-packages");
    expect(resolve.run).toContain(".requiredPrepublishPluginPackages");
    expect(resolve.run).toContain("'$provider + $docker | unique | sort'");
    expect(resolve.run).toContain("--plugin-registry-output-dir");
    expect(resolve.run).toContain("--required-plugin-packages-json");
    expect(resolve.run).toContain(
      'source_args=(--source npm --package-spec "$RELEASE_PACKAGE_SPEC" --package-ref "$PACKAGE_REF")',
    );

    const registryUpload = step(producer, "Upload shared prerelease plugin registry artifact");
    expect(registryUpload.with?.name).toBe(
      "docker-e2e-prepublish-plugin-registry-${{ github.run_id }}-${{ github.run_attempt }}",
    );

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
    expect(binding.run).toContain('verify-upload "Release package"');
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
      prepublish_plugin_registry_json:
        "${{ needs.prepare_release_package.outputs.prepublish_plugin_registry_json }}",
      target_context_ref: "${{ inputs.target_context_ref }}",
    });
    expect(crossOs.with?.required_companion_packages_json).toBeUndefined();

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
      prepublish_plugin_registry_artifact_id:
        "${{ fromJSON(needs.prepare_release_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactId || '' }}",
      prepublish_plugin_registry_manifest_sha256:
        "${{ fromJSON(needs.prepare_release_package.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryManifestSha256 || '' }}",
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

  it("builds companion registries only for scheduled cross-OS or Docker consumers", () => {
    const workflow = readWorkflow(RELEASE_CHECKS_PATH);
    const resolveTarget = job(workflow, "resolve_target");
    expect(resolveTarget.outputs).toMatchObject({
      cross_os_scheduled: "${{ steps.inputs.outputs.cross_os_scheduled }}",
      docker_required: "${{ steps.inputs.outputs.docker_required }}",
      package_required: "${{ steps.inputs.outputs.package_required }}",
    });
    const capture = step(resolveTarget, "Capture selected inputs");
    expect(capture.run).toContain("cross_os_scheduled=false");
    expect(capture.run).toContain("docker_required=false");
    expect(capture.run).toContain("package_required=false");
    expect(capture.run).toContain("group_selected cross-os && cross_os_scheduled=true");
    expect(capture.run).toContain(
      '"$live_e2e_scheduled" == "true" && -z "$repo_live_suite_filter"',
    );

    const producer = job(workflow, "prepare_release_package");
    expect(producer.if).toBe("needs.resolve_target.outputs.package_required == 'true'");
    const resolvePackage = step(producer, "Resolve release package artifact");
    expect(resolvePackage.run).toContain('if [[ "$CROSS_OS_SCHEDULED" == "true" ]]');
    expect(resolvePackage.run).toContain(
      'if [[ "$DOCKER_REQUIRED" == "true" && "$PACKAGE_MODE" == "source" ]]',
    );
    expect(resolvePackage.run).toContain("registry_args=()");
    expect(resolvePackage.run).toContain("if [[ \"$required_packages\" != '[]' ]]");
    expect(job(workflow, "cross_os_release_checks").if).toBe(
      "needs.resolve_target.outputs.cross_os_scheduled == 'true'",
    );
    expect(job(workflow, "docker_e2e_release_checks").if).toBe(
      "needs.resolve_target.outputs.docker_required == 'true'",
    );
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
    expect(workflow.on?.workflow_dispatch?.inputs?.prepublish_plugin_registry_json).toMatchObject({
      default: "",
      type: "string",
    });
    expect(workflow.on?.workflow_call?.inputs?.prepublish_plugin_registry_json).toMatchObject({
      default: "",
      type: "string",
    });
    for (const inputName of [
      "prepublish_plugin_registry_artifact_digest",
      "prepublish_plugin_registry_artifact_id",
      "prepublish_plugin_registry_artifact_name",
      "prepublish_plugin_registry_artifact_run_attempt",
      "prepublish_plugin_registry_artifact_run_id",
      "prepublish_plugin_registry_manifest_sha256",
    ]) {
      expect(workflow.on?.workflow_dispatch?.inputs?.[inputName], inputName).toBeUndefined();
      expect(workflow.on?.workflow_call?.inputs?.[inputName], inputName).toBeUndefined();
    }
    expect(workflow.on?.workflow_call?.inputs?.required_companion_packages_json).toBeUndefined();

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
      prepublish_plugin_registry_json: "${{ steps.registry_identity.outputs.json }}",
      required_companion_packages_json: "${{ steps.provider_requirements.outputs.json }}",
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
    expect(inputBinding.run).toContain('verify-upload "Candidate"');
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
    expect(resolve.run).toContain("resolve-openclaw-package-candidate.mts");
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
    const registryUpload = step(prepare, "Upload source-built prerelease companion registry");
    expect(registryUpload.if).toBe(
      "inputs.candidate_artifact_name == '' && steps.provider_requirements.outputs.json != '[]'",
    );
    const sourceRegistry = step(prepare, "Pack source-built prerelease companion registry");
    expect(sourceRegistry.run).toContain("prepublish-plugin-registry-artifact.mjs create");
    expect(sourceRegistry.run).toContain("--repo-root source");
    expect(sourceRegistry.run).toContain('--required-packages-json "$REQUIRED_PACKAGES_JSON"');

    const preparedUploadVerification = step(prepare, "Verify prepared artifact uploads");
    expect(preparedUploadVerification.run).toContain('verify-upload "Candidate"');
    expect(preparedUploadVerification.run).toContain('verify-upload "Baseline"');
    expect(preparedUploadVerification.run).toContain('verify-upload "Prerelease plugin registry"');
    const consumer = job(workflow, "cross_os_release_checks");
    expect(consumer.steps?.map((candidate) => candidate.name)).not.toContain(
      "Validate prepared candidate artifact binding",
    );

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

  it("passes and consumes the immutable prerelease companion registry generically", () => {
    const workflow = readWorkflow(WORKFLOW_PATH);
    const prepare = job(workflow, "prepare");
    const sourceCheckout = step(prepare, "Checkout public source ref");
    expect(sourceCheckout.if).toBe("inputs.candidate_artifact_name == ''");
    expect(sourceCheckout.with?.ref).toBe("${{ inputs.ref }}");
    expect(prepare.steps?.map((candidate) => candidate.name)).not.toEqual(
      expect.arrayContaining([
        "Install companion plugin build dependencies",
        "Pack exact Codex companion plugin",
        "Resolve exact Codex companion plugin",
        "Upload generated prerelease plugin registry artifact",
      ]),
    );

    const consumer = job(workflow, "cross_os_release_checks");
    const download = step(consumer, "Download prerelease plugin registry artifact");
    expect(download.with).toMatchObject({
      "artifact-ids":
        "${{ fromJSON(needs.prepare.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactId || '' }}",
      "run-id":
        "${{ fromJSON(needs.prepare.outputs.prepublish_plugin_registry_json || '{}').prepublishPluginRegistryArtifactRunId || '' }}",
    });

    const run = step(consumer, "Run cross-OS release checks");
    expect(run.env).toMatchObject({
      PLUGIN_REGISTRY_JSON: "${{ needs.prepare.outputs.prepublish_plugin_registry_json }}",
      REQUIRED_COMPANION_PACKAGES_JSON:
        "${{ needs.prepare.outputs.required_companion_packages_json }}",
    });
    expect(run.run).toContain('--plugin-registry-dir "$PLUGIN_REGISTRY_DIR"');
    expect(run.run).toContain(
      '"$(jq -r \'.prepublishPluginRegistryManifestSha256\' <<< "$PLUGIN_REGISTRY_JSON")"',
    );
    expect(run.run).not.toContain("--required-companion-packages-json");
    expect(run.run).not.toContain("OPENCLAW_PLUGIN_INSTALL_OVERRIDES");
    expect(JSON.stringify(workflow)).not.toContain("@openclaw/codex");
  });

  it("owns provider companion requirements and fails closed for direct candidates", () => {
    const workflow = readWorkflow(WORKFLOW_PATH);
    const prepare = job(workflow, "prepare");
    const requirements = step(prepare, "Resolve provider-owned companion requirements");
    expect(requirements.run).toContain("--resolve-provider-required-companion-packages");
    expect(requirements.run).toContain('--provider "$PROVIDER"');

    const contract = step(prepare, "Normalize companion registry contract");
    expect(contract.run).toContain("(keys | sort) == ([");
    expect(contract.run).toContain('all(.[]; type == "string")');
    expect(contract.run).toContain(
      "Prerelease companion registry must be one closed immutable JSON tuple.",
    );
    expect(contract.run).toContain(
      "The selected provider requires a complete immutable companion registry tuple.",
    );
    expect(contract.run).toContain(
      "Source-built candidates produce their own companion registry and reject a second tuple.",
    );
    expect(step(prepare, "Verify provided prerelease plugin registry upload").run).toContain(
      'verify-upload "Prerelease plugin registry"',
    );
    const workflowSource = readFileSync(WORKFLOW_PATH, "utf8");
    const optionalJsonParses =
      workflowSource.match(/fromJSON\([^)]+ \|\| '\{\}'\)\.[A-Za-z]+ \|\| ''/gu) ?? [];
    expect(optionalJsonParses).toHaveLength(9);
    expect(workflowSource).not.toContain("fromJSON(steps.provided_registry.outputs.json).");
    expect(workflowSource).not.toContain(
      "fromJSON(needs.prepare.outputs.prepublish_plugin_registry_json).",
    );
  });

  it.each([
    ["openai", ["@openclaw/codex"]],
    ["anthropic", []],
    ["minimax", []],
  ])("resolves provider-owned companions for %s", (provider, expected) => {
    const result = spawnSync(
      BASH_BIN,
      [WRAPPER_PATH, "--resolve-provider-required-companion-packages", "--provider", provider],
      {
        cwd: process.cwd(),
        encoding: "utf8",
        env: { ...process.env, OPENCLAW_RELEASE_CHECKS_SCRIPT: SCRIPT_PATH },
      },
    );
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual(expected);
  });

  it("executes the release harness directly with Node", () => {
    const wrapper = readFileSync(WRAPPER_PATH, "utf8");
    const script = readFileSync(SCRIPT_PATH, "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    const windowsCiCoverage = [
      packageJson.scripts["test:windows:ci:1"],
      packageJson.scripts["test:windows:ci:2"],
    ].join(" ");

    expect(wrapper).toContain('exec "${node_cmd}" "${script_path}" "$@"');
    expect(wrapper).not.toContain("npm");
    expect(wrapper).not.toContain("tsx");
    expect(wrapper).not.toContain("--import");
    expect(script).toMatch(/^#!\/usr\/bin\/env node$/mu);
    expect(script).not.toContain("--import tsx");
    expect(windowsCiCoverage).toContain("test/scripts/openclaw-cross-os-release-workflow.test.ts");
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
