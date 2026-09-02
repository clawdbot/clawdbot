import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { validateBundledPackageDependencyAlignment } from "../../scripts/package-source-dependencies.mjs";
import {
  validatePackageSource,
  validatePackageSourceDir,
  validatePackageSourceRef,
} from "../../scripts/package-source-preflight.mjs";
import { writeRunSummary } from "../../scripts/test-docker-all.mts";

const changelog = `# Changelog

## Unreleased

- Package source preflight notes with enough detail.
`;

function rootManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "openclaw",
    version: "2026.8.1",
    dependencies: {
      "@openclaw/ai": "workspace:*",
      openai: "6.49.0",
    },
    ...overrides,
  });
}

function aiManifest(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    name: "@openclaw/ai",
    version: "2026.8.1",
    dependencies: {
      openai: "6.49.0",
    },
    ...overrides,
  });
}

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Workflow = {
  jobs: Record<
    string,
    {
      env?: Record<string, string>;
      outputs?: Record<string, unknown>;
      steps: WorkflowStep[];
      with?: Record<string, unknown>;
    }
  >;
};

function readWorkflow(file: string): Workflow {
  return parse(readFileSync(file, "utf8")) as Workflow;
}

function workflowStep(workflow: Workflow, job: string, name: string): WorkflowStep {
  const found = workflow.jobs[job]?.steps.find((step) => step.name === name);
  expect(found, `${job}: ${name}`).toBeDefined();
  return found!;
}

function runSourceRequirement(step: WorkflowStep, env: Record<string, string>) {
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-package-source-workflow-"));
  const outputPath = path.join(tempDir, "output");
  try {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", step.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...Object.fromEntries(Object.keys(step.env ?? {}).map((name) => [name, ""])),
        ...env,
        GITHUB_OUTPUT: outputPath,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return readFileSync(outputPath, "utf8").trim();
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function runLiveArtifactTupleValidation(packageEnv: Record<string, string>) {
  const workflow = readWorkflow(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml");
  const step = workflowStep(workflow, "validate_selected_ref", "Validate selected ref");
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-live-artifact-tuple-"));
  const fakeBin = path.join(tempDir, "bin");
  const outputPath = path.join(tempDir, "output");
  const summaryPath = path.join(tempDir, "summary");
  const selectedSha = "a".repeat(40);
  mkdirSync(fakeBin);
  writeFileSync(
    path.join(fakeBin, "git"),
    `#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == "rev-parse" && "$2" == "--verify" ]]; then
  printf '%s\\n' "$SELECTED_SHA"
  exit 0
fi
if [[ "$1" == "merge-base" && "$2" == "--is-ancestor" ]]; then
  exit 0
fi
exit 64
`,
    { mode: 0o755 },
  );
  const stepEnv = Object.fromEntries(Object.keys(step.env ?? {}).map((name) => [name, ""]));
  try {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", step.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...stepEnv,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
        INPUT_REF: "main",
        PATH: `${fakeBin}:${process.env.PATH}`,
        PROVIDED_BARE_IMAGE: "ghcr.io/openclaw/openclaw:test",
        SELECTED_SHA: selectedSha,
        SHARED_IMAGE_POLICY: "existing-only",
        ...packageEnv,
      },
    });
    const output =
      result.status === 0
        ? Object.fromEntries(
            readFileSync(outputPath, "utf8")
              .trim()
              .split("\n")
              .map((line) => {
                const separator = line.indexOf("=");
                return [line.slice(0, separator), line.slice(separator + 1)];
              }),
          )
        : {};
    return { output, result };
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function runLiveSourcePackageBuildAndValidation(packageEnv: Record<string, string>) {
  const workflow = readWorkflow(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml");
  const pack = workflowStep(
    workflow,
    "prepare_docker_e2e_image",
    "Pack OpenClaw package for Docker E2E",
  );
  const validate = workflowStep(
    workflow,
    "prepare_docker_e2e_image",
    "Validate OpenClaw Docker E2E package",
  );
  const artifactTuple = runLiveArtifactTupleValidation(packageEnv);
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-live-source-package-"));
  const fakeBin = path.join(tempDir, "bin");
  const callsPath = path.join(tempDir, "calls");
  const outputPath = path.join(tempDir, "output");
  const summaryPath = path.join(tempDir, "summary");
  const selectedSha = "a".repeat(40);
  mkdirSync(fakeBin);
  writeFileSync(
    path.join(fakeBin, "node"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$CALLS_PATH"
if [[ "$1" == "scripts/package-openclaw-for-docker.mjs" ]]; then
  shift
  output_dir=""
  output_name=""
  while (( "$#" )); do
    case "$1" in
      --output-dir) output_dir="$2"; shift 2 ;;
      --output-name) output_name="$2"; shift 2 ;;
      *) shift ;;
    esac
  done
  fixture="$(mktemp -d)"
  mkdir -p "$fixture/package/dist" "$output_dir"
  printf '%s\\n' '{"name":"openclaw","version":"2026.8.1"}' > "$fixture/package/package.json"
  printf '{"commit":"%s"}\\n' "$SELECTED_SHA" > "$fixture/package/dist/build-info.json"
  tar -czf "$output_dir/$output_name" -C "$fixture" package
  rm -rf "$fixture"
  exit 0
fi
exit 64
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(fakeBin, "timeout"),
    `#!/usr/bin/env bash
set -euo pipefail
shift 2
exec "$@"
`,
    { mode: 0o755 },
  );
  writeFileSync(
    path.join(fakeBin, "sha256sum"),
    `#!/usr/bin/env bash
set -euo pipefail
printf '%064d  %s\\n' 0 "$1"
`,
    { mode: 0o755 },
  );
  const commonEnv = {
    ...process.env,
    ALLOW_UNRELEASED_CHANGELOG: "false",
    CALLS_PATH: callsPath,
    GITHUB_OUTPUT: outputPath,
    GITHUB_STEP_SUMMARY: summaryPath,
    GITHUB_WORKSPACE: tempDir,
    PATH: `${fakeBin}:${process.env.PATH}`,
    SELECTED_SHA: selectedSha,
    SHARED_IMAGE_POLICY: "existing-only",
  };
  try {
    const buildResult = spawnSync("bash", ["--noprofile", "--norc", "-c", pack.run ?? ""], {
      cwd: tempDir,
      encoding: "utf8",
      env: commonEnv,
    });
    const artifactPresent = artifactTuple.output.package_artifact_present === "true";
    const validationResult = spawnSync(
      "bash",
      ["--noprofile", "--norc", "-c", validate.run ?? ""],
      {
        cwd: tempDir,
        encoding: "utf8",
        env: {
          ...commonEnv,
          EXPECTED_PACKAGE_FILE_NAME: artifactPresent ? packageEnv.PACKAGE_FILE_NAME : "",
          EXPECTED_PACKAGE_SHA256: artifactPresent ? packageEnv.PACKAGE_SHA256 : "",
          EXPECTED_PACKAGE_SOURCE_SHA: artifactPresent ? packageEnv.PACKAGE_SOURCE_SHA : "",
          EXPECTED_PACKAGE_VERSION: artifactPresent ? packageEnv.PACKAGE_VERSION : "",
        },
      },
    );
    const output =
      validationResult.status === 0
        ? Object.fromEntries(
            readFileSync(outputPath, "utf8")
              .trim()
              .split("\n")
              .map((line) => {
                const separator = line.indexOf("=");
                return [line.slice(0, separator), line.slice(separator + 1)];
              }),
          )
        : {};
    const calls = readFileSync(callsPath, "utf8").trim().split("\n");
    return { artifactTuple, buildResult, calls, output, validationResult, validate };
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

function runReleaseInputCapture(params: {
  candidateArtifactJson?: string;
  releasePackageSpec?: string;
}) {
  const workflow = readWorkflow(".github/workflows/openclaw-release-checks.yml");
  const step = workflowStep(workflow, "resolve_target", "Capture selected inputs");
  const tempDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-release-inputs-"));
  const outputPath = path.join(tempDir, "output");
  const stepEnv = Object.fromEntries(Object.keys(step.env ?? {}).map((name) => [name, ""]));
  try {
    const result = spawnSync("bash", ["--noprofile", "--norc", "-c", step.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        ...stepEnv,
        CANDIDATE_ARTIFACT_JSON_INPUT: params.candidateArtifactJson ?? "",
        GITHUB_OUTPUT: outputPath,
        RELEASE_ALLOW_UNRELEASED_CHANGELOG_INPUT: "false",
        RELEASE_CROSS_OS_SUITE_FILTER_INPUT: "",
        RELEASE_FAIL_FAST_INPUT: "false",
        RELEASE_FILTER_VALIDATOR: path.resolve("scripts/github/validate-release-suite-filters.sh"),
        RELEASE_LIVE_SUITE_FILTER_INPUT: "",
        RELEASE_MODE_INPUT: "both",
        RELEASE_PACKAGE_SPEC_INPUT: params.releasePackageSpec ?? "",
        RELEASE_PHASE_INPUT: "all",
        RELEASE_PROFILE_INPUT: "beta",
        RELEASE_PROVIDER_INPUT: "openai",
        RELEASE_QA_DISCORD_LIVE_CI_ENABLED: "false",
        RELEASE_QA_SLACK_LIVE_CI_ENABLED: "false",
        RELEASE_QA_WHATSAPP_LIVE_CI_ENABLED: "false",
        RELEASE_REF_INPUT: "main",
        RELEASE_RERUN_GROUP_INPUT: "package",
        RELEASE_RUN_MATURITY_SCORECARD_INPUT: "false",
        RELEASE_RUN_RELEASE_SOAK_INPUT: "false",
        RELEASE_SKIP_PACKAGE_TELEGRAM_E2E_INPUT: "false",
        TELEGRAM_WAIVER: "",
      },
    });
    expect(result.status, result.stderr).toBe(0);
    return Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => {
          const separator = line.indexOf("=");
          return [line.slice(0, separator), line.slice(separator + 1)];
        }),
    );
  } finally {
    rmSync(tempDir, { force: true, recursive: true });
  }
}

describe("package source preflight", () => {
  it.each(["2026.8.1", "2026.8.1-beta.4", "2026.9.1"])(
    "accepts aligned %s source manifests with Unreleased notes",
    (version) => {
      expect(
        validatePackageSource({
          aiManifestContent: aiManifest({ version }),
          allowUnreleasedChangelog: true,
          changelogContent: changelog,
          rootManifestContent: rootManifest({ version }),
        }),
      ).toBe(version);
    },
  );

  it("uses canonical package changelog validation", () => {
    expect(() =>
      validatePackageSource({
        aiManifestContent: aiManifest(),
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toThrow("CHANGELOG.md does not contain a release section for 2026.8.1.");
  });

  it("accepts complete oversized contribution records through the package renderer", () => {
    expect(
      validatePackageSource({
        aiManifestContent: aiManifest(),
        rootManifestContent: rootManifest(),
        changelogContent: `# Changelog\n\n## 2026.8.1\n\n- A complete release note with its original credit. Thanks @contributor.\n\n### Complete contribution record\n\n${"- **PR #123** Thanks @contributor.\n".repeat(20_000)}`,
      }),
    ).toBe("2026.8.1");
  });

  it("rejects source package version drift", () => {
    expect(() =>
      validatePackageSource({
        aiManifestContent: aiManifest({ version: "2026.8.2" }),
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toThrow("packages/ai/package.json version must match package.json");
  });

  it("rejects @openclaw/ai dependency drift before packing", () => {
    expect(() =>
      validatePackageSource({
        aiManifestContent: aiManifest({
          dependencies: {
            openai: "6.50.0",
          },
        }),
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toThrow(
      "package.json must declare openai@6.50.0 to bundle packages/ai/package.json without duplicate dependencies",
    );
  });

  it("shares exact, workspace, private, and value-type dependency semantics with packaging", () => {
    expect(
      validateBundledPackageDependencyAlignment({
        bundledDependencies: {
          exact: "1.2.3",
          private: "0.0.0-private",
          workspace: "4.5.6",
        },
        bundledPackageLabel: "packed @openclaw/ai",
        rootDependencies: {
          exact: "1.2.3",
          workspace: "workspace:4.5.6",
        },
      }),
    ).toEqual([
      ["exact", "1.2.3"],
      ["workspace", "4.5.6"],
    ]);

    expect(() =>
      validateBundledPackageDependencyAlignment({
        bundledDependencies: { invalid: 123 },
        bundledPackageLabel: "packed @openclaw/ai",
        rootDependencies: { invalid: "123" },
      }),
    ).toThrow("packed @openclaw/ai dependency invalid must declare a string version");
    expect(() =>
      validateBundledPackageDependencyAlignment({
        bundledDependencies: { invalid: "1.2.3" },
        bundledPackageLabel: "packed @openclaw/ai",
        rootDependencies: { invalid: 123 },
      }),
    ).toThrow("root package.json dependency invalid must declare a string version");
  });

  it("rejects real partial-json source manifest drift", () => {
    const root = JSON.parse(readFileSync("package.json", "utf8")) as {
      dependencies: Record<string, string>;
    };
    root.dependencies["partial-json"] = "0.1.8";
    expect(() =>
      validatePackageSource({
        aiManifestContent: readFileSync("packages/ai/package.json", "utf8"),
        allowUnreleasedChangelog: true,
        changelogContent: readFileSync("CHANGELOG.md", "utf8"),
        rootManifestContent: JSON.stringify(root),
      }),
    ).toThrow(
      "package.json must declare partial-json@0.1.7 to bundle packages/ai/package.json without duplicate dependencies",
    );
  });

  it("preserves historical sources from before the @openclaw/ai workspace split", () => {
    expect(
      validatePackageSource({
        aiManifestContent: null,
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest({ dependencies: {} }),
      }),
    ).toBe("2026.8.1");
  });

  it("validates the current source ref without modifying the checkout", () => {
    const committedManifest = JSON.parse(
      execFileSync("git", ["show", "HEAD:package.json"], { encoding: "utf8" }),
    ) as { version: string };
    const workingManifest = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(
      validatePackageSourceRef("HEAD", {
        allowUnreleasedChangelog: true,
      }),
    ).toBe(committedManifest.version);
    expect(
      validatePackageSourceDir(process.cwd(), {
        allowUnreleasedChangelog: true,
      }),
    ).toBe(workingManifest.version);
  });

  it("normalizes release-check package mode and guards the source resolver", () => {
    const workflow = readWorkflow(".github/workflows/openclaw-release-checks.yml");
    const steps = workflow.jobs.prepare_release_package!.steps;
    const preflightIndex = steps.findIndex(
      (step) => step.name === "Validate release package source metadata",
    );
    const setupIndex = steps.findIndex((step) => step.name === "Setup Node environment");
    const packageIndex = steps.findIndex(
      (step) => step.name === "Resolve release package artifact",
    );
    const preflight = steps[preflightIndex]!;
    const packageStep = steps[packageIndex]!;
    const setup = workflowStep(workflow, "prepare_release_package", "Setup Node environment");
    const upload = workflowStep(
      workflow,
      "prepare_release_package",
      "Upload release package artifact",
    );
    const artifactIdentity = workflowStep(
      workflow,
      "prepare_release_package",
      "Validate shared release candidate identity",
    );

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(setupIndex);
    expect(preflightIndex).toBeLessThan(packageIndex);
    expect(runReleaseInputCapture({ releasePackageSpec: " \t " })).toMatchObject({
      candidate_artifact_json: "",
      package_mode: "source",
      release_package_spec: "",
    });
    expect(runReleaseInputCapture({ releasePackageSpec: "openclaw@beta" })).toMatchObject({
      candidate_artifact_json: "",
      package_mode: "published",
      release_package_spec: "openclaw@beta",
    });
    expect(runReleaseInputCapture({ candidateArtifactJson: " \t " })).toMatchObject({
      candidate_artifact_json: "",
      package_mode: "source",
      release_package_spec: "",
    });
    expect(
      runReleaseInputCapture({ candidateArtifactJson: '{"packageArtifactId":"1"}' }),
    ).toMatchObject({
      candidate_artifact_json: '{"packageArtifactId":"1"}',
      package_mode: "artifact",
      release_package_spec: "",
    });
    expect(preflight.if).toBe("needs.resolve_target.outputs.package_mode == 'source'");
    expect(preflight.env?.PACKAGE_REF).toBe("${{ needs.resolve_target.outputs.revision }}");
    expect(preflight.run).toContain("node scripts/package-source-preflight.mjs");
    expect(packageStep.env?.PACKAGE_MODE).toBe("${{ needs.resolve_target.outputs.package_mode }}");
    expect(setup.if).toBe("needs.resolve_target.outputs.package_mode != 'artifact'");
    expect(packageStep.if).toBe("needs.resolve_target.outputs.package_mode != 'artifact'");
    expect(packageStep.run).toContain('if [[ "$PACKAGE_MODE" == "published" ]]');
    expect(upload.if).toBe("needs.resolve_target.outputs.package_mode != 'artifact'");
    expect(artifactIdentity.if).toBe("needs.resolve_target.outputs.package_mode == 'artifact'");
    expect(workflow.jobs.docker_e2e_release_checks?.with).toMatchObject({
      enable_prepublish_plugin_registry:
        "${{ needs.resolve_target.outputs.package_mode != 'published' }}",
    });
    expect(workflow.jobs.package_acceptance_release_checks?.with).toMatchObject({
      candidate_artifact_json:
        "${{ needs.resolve_target.outputs.package_acceptance_package_spec == '' && needs.resolve_target.outputs.candidate_artifact_json || '' }}",
      source:
        "${{ (needs.resolve_target.outputs.package_acceptance_package_spec != '' || needs.resolve_target.outputs.package_mode == 'published') && 'npm' || 'artifact' }}",
    });
    const workflowSource = readFileSync(".github/workflows/openclaw-release-checks.yml", "utf8");
    expect(workflowSource.match(/\$\{\{ inputs\.candidate_artifact_json \}\}/gu)).toHaveLength(1);
    expect(workflowSource.match(/\$\{\{ inputs\.release_package_spec \}\}/gu)).toHaveLength(1);
  });

  it("guards prepare-only source before harness setup and skips no-package lane setup", () => {
    const workflow = readWorkflow(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml");
    const steps = workflow.jobs.prepare_docker_e2e_image!.steps;
    const sourceRequirement = workflowStep(
      workflow,
      "prepare_docker_e2e_image",
      "Resolve source package requirement",
    );
    const prepareOnlyPreflight = workflowStep(
      workflow,
      "prepare_docker_e2e_image",
      "Validate prepare-only Docker E2E package source metadata",
    );
    const plannedPreflight = workflowStep(
      workflow,
      "prepare_docker_e2e_image",
      "Validate Docker E2E package source metadata",
    );
    const harnessSetup = workflowStep(
      workflow,
      "prepare_docker_e2e_image",
      "Setup trusted release harness",
    );
    const setup = workflowStep(workflow, "prepare_docker_e2e_image", "Setup Node environment");
    const pack = workflowStep(
      workflow,
      "prepare_docker_e2e_image",
      "Pack OpenClaw package for Docker E2E",
    );

    expect(
      runSourceRequirement(sourceRequirement, {
        PACKAGE_ARTIFACT_PRESENT: "false",
      }),
    ).toBe("required=true");
    expect(
      runSourceRequirement(sourceRequirement, {
        PACKAGE_ARTIFACT_PRESENT: "true",
      }),
    ).toBe("required=false");
    expect(
      runSourceRequirement(sourceRequirement, {
        PACKAGE_ARTIFACT_PRESENT: "false",
        PREPARED_NPM_BUNDLE_JSON: "{}",
      }),
    ).toBe("required=false");
    expect(steps.indexOf(prepareOnlyPreflight)).toBeLessThan(steps.indexOf(harnessSetup));
    expect(harnessSetup.uses).toBe("./.release-harness/.github/actions/setup-release-harness");
    expect(steps.indexOf(plannedPreflight)).toBeGreaterThan(
      steps.findIndex((step) => step.name === "Plan Docker E2E images"),
    );
    expect(steps.indexOf(plannedPreflight)).toBeLessThan(steps.indexOf(setup));
    expect(steps.indexOf(plannedPreflight)).toBeLessThan(steps.indexOf(pack));
    expect(prepareOnlyPreflight.run).toContain(
      "node .release-harness/scripts/package-source-preflight.mjs",
    );
    expect(prepareOnlyPreflight.if).toBe(
      "inputs.prepare_only && steps.package_source.outputs.required == 'true'",
    );
    expect(plannedPreflight.if).toBe(
      "(!inputs.prepare_only) && steps.plan.outputs.needs_package == '1' && steps.package_source.outputs.required == 'true'",
    );
    expect(setup.if).toContain(
      "steps.plan.outputs.needs_package == '1' && steps.package_source.outputs.required == 'true'",
    );
    expect(pack.if).toBe(
      "steps.plan.outputs.needs_package == '1' && steps.package_source.outputs.required == 'true'",
    );
  });

  it("treats tab and newline-only package artifact tuples as absent", () => {
    const whitespace = " \t\n ";
    const { output, result } = runLiveArtifactTupleValidation({
      PACKAGE_ARTIFACT_DIGEST: whitespace,
      PACKAGE_ARTIFACT_ID: whitespace,
      PACKAGE_ARTIFACT_NAME: whitespace,
      PACKAGE_ARTIFACT_RUN_ATTEMPT: whitespace,
      PACKAGE_ARTIFACT_RUN_ID: whitespace,
      PACKAGE_FILE_NAME: whitespace,
      PACKAGE_SHA256: whitespace,
      PACKAGE_SOURCE_SHA: whitespace,
      PACKAGE_VERSION: whitespace,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(output.package_artifact_present).toBe("false");
  });

  it("keeps a whitespace-only artifact tuple in source mode through Docker reports", async () => {
    const whitespace = " \t\n ";
    const result = runLiveSourcePackageBuildAndValidation({
      PACKAGE_ARTIFACT_DIGEST: whitespace,
      PACKAGE_ARTIFACT_ID: whitespace,
      PACKAGE_ARTIFACT_NAME: whitespace,
      PACKAGE_ARTIFACT_RUN_ATTEMPT: whitespace,
      PACKAGE_ARTIFACT_RUN_ID: whitespace,
      PACKAGE_FILE_NAME: whitespace,
      PACKAGE_SHA256: whitespace,
      PACKAGE_SOURCE_SHA: whitespace,
      PACKAGE_VERSION: whitespace,
    });

    expect(result.artifactTuple.result.status, result.artifactTuple.result.stderr).toBe(0);
    expect(result.artifactTuple.output.package_artifact_present).toBe("false");
    expect(result.validate.env).toMatchObject({
      EXPECTED_PACKAGE_FILE_NAME:
        "${{ needs.validate_selected_ref.outputs.package_artifact_present == 'true' && inputs.package_file_name || '' }}",
      EXPECTED_PACKAGE_SHA256:
        "${{ needs.validate_selected_ref.outputs.package_artifact_present == 'true' && inputs.package_sha256 || '' }}",
      EXPECTED_PACKAGE_SOURCE_SHA:
        "${{ needs.validate_selected_ref.outputs.package_artifact_present == 'true' && inputs.package_source_sha || '' }}",
      EXPECTED_PACKAGE_VERSION:
        "${{ needs.validate_selected_ref.outputs.package_artifact_present == 'true' && inputs.package_version || '' }}",
    });
    expect(result.buildResult.status, result.buildResult.stderr).toBe(0);
    expect(result.validationResult.status, result.validationResult.stderr).toBe(0);
    expect(result.calls).toEqual([
      expect.stringContaining("scripts/package-openclaw-for-docker.mjs"),
    ]);
    expect(result.output).toMatchObject({
      file_name: "openclaw-current.tgz",
      source_sha: "a".repeat(40),
      version: "2026.8.1",
    });

    const workflow = readWorkflow(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml");
    const prepared = workflow.jobs.prepare_docker_e2e_image!;
    expect(prepared.outputs).toMatchObject({
      package_artifact_id:
        "${{ steps.upload_package.outputs.artifact-id || (needs.validate_selected_ref.outputs.package_artifact_present == 'true' && inputs.package_artifact_id || '') }}",
      package_artifact_name:
        "${{ steps.upload_package.outputs.artifact-id && format('docker-e2e-package-{0}-{1}', github.run_id, github.run_attempt) || (needs.validate_selected_ref.outputs.package_artifact_present == 'true' && inputs.package_artifact_name || '') }}",
    });
    const reportArtifactName =
      "${{ needs.prepare_docker_e2e_image.outputs.package_artifact_name || 'docker-e2e-package' }}";
    for (const jobId of [
      "validate_docker_e2e",
      "validate_docker_lanes",
      "validate_docker_openwebui",
    ]) {
      expect(workflow.jobs[jobId]!.env?.OPENCLAW_DOCKER_E2E_PACKAGE_ARTIFACT_NAME).toBe(
        reportArtifactName,
      );
    }
    const candidateManifest = workflowStep(
      workflow,
      "prepare_docker_e2e_image",
      "Emit immutable release candidate tuple",
    );
    for (const name of [
      "PACKAGE_ARTIFACT_DIGEST",
      "PACKAGE_ARTIFACT_ID",
      "PACKAGE_ARTIFACT_NAME",
      "PACKAGE_ARTIFACT_RUN_ATTEMPT",
      "PACKAGE_ARTIFACT_RUN_ID",
    ]) {
      expect(candidateManifest.env?.[name]).toContain(
        "needs.validate_selected_ref.outputs.package_artifact_present == 'true'",
      );
    }

    const noPackageArtifactName =
      result.artifactTuple.output.package_artifact_present === "true" ? whitespace : "";
    expect(noPackageArtifactName).toBe("");
    const reportDir = mkdtempSync(path.join(os.tmpdir(), "openclaw-live-source-report-"));
    try {
      await writeRunSummary(
        reportDir,
        {
          failures: [{ name: "live-models", status: 1 }],
          lanes: [],
          status: "failed",
        },
        {
          OPENCLAW_DOCKER_E2E_PACKAGE_ARTIFACT_NAME: noPackageArtifactName || "docker-e2e-package",
          OPENCLAW_DOCKER_E2E_SELECTED_SHA: "a".repeat(40),
        },
      );
      const summary = JSON.parse(readFileSync(path.join(reportDir, "summary.json"), "utf8"));
      const failures = JSON.parse(readFileSync(path.join(reportDir, "failures.json"), "utf8"));
      expect(summary.packageArtifactName).toBe("docker-e2e-package");
      expect(failures.packageArtifactName).toBe("docker-e2e-package");
      expect(JSON.stringify({ failures, summary })).not.toContain(whitespace);
    } finally {
      rmSync(reportDir, { force: true, recursive: true });
    }
  });

  it("guards install-smoke candidate packaging before its dependency install", () => {
    const workflow = readWorkflow(".github/workflows/install-smoke-reusable.yml");
    const packageCandidate = workflowStep(
      workflow,
      "installer_smoke_candidate_payload",
      "Package candidate only inside pinned harness",
    );
    expect(packageCandidate.run).toContain('-v "$PWD/.release-harness:/harness:ro"');
    expect(packageCandidate.run).toContain(
      'node /harness/scripts/package-source-preflight.mjs "${preflight_args[@]}"',
    );
    expect(packageCandidate.run!.indexOf("package-source-preflight.mjs")).toBeLessThan(
      packageCandidate.run!.indexOf("pnpm install --frozen-lockfile"),
    );
  });

  it("guards npm source producers with trusted tooling before Node setup", () => {
    const workflow = readWorkflow(".github/workflows/openclaw-npm-preflight.yml");
    const steps = workflow.jobs.prepare_openclaw_npm!.steps;
    const checkout = workflowStep(
      workflow,
      "prepare_openclaw_npm",
      "Checkout trusted package source preflight",
    );
    const preflight = workflowStep(
      workflow,
      "prepare_openclaw_npm",
      "Validate npm package source metadata",
    );
    const setup = workflowStep(workflow, "prepare_openclaw_npm", "Setup Node environment");
    const build = workflowStep(workflow, "prepare_openclaw_npm", "Build");

    expect(checkout.with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: ".release-harness",
    });
    expect(preflight.run).toContain("node .release-harness/scripts/package-source-preflight.mjs");
    expect(preflight.run).toContain('if [[ "$RELEASE_REF" =~ ^[0-9a-fA-F]{40}$ ]]');
    expect(steps.indexOf(checkout)).toBeLessThan(steps.indexOf(preflight));
    expect(steps.indexOf(preflight)).toBeLessThan(steps.indexOf(setup));
    expect(steps.indexOf(preflight)).toBeLessThan(steps.indexOf(build));
  });
});
