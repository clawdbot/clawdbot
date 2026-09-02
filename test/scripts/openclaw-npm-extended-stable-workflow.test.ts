import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/openclaw-npm-release.yml";
const preflightWorkflowPath = ".github/workflows/openclaw-npm-preflight.yml";

type Step = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};
type Job = {
  environment?: string;
  "runs-on"?: string;
  steps?: Step[];
  uses?: string;
  with?: Record<string, unknown>;
};
type Workflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: {
        bypass_extended_stable_guard?: { default?: boolean; type?: string };
        npm_dist_tag?: { options?: string[] };
        plugin_sdk_api_acknowledgement?: {
          default?: string;
          required?: boolean;
          type?: string;
        };
        plugin_npm_run_id?: { required?: boolean; type?: string };
        release_candidate_branch?: { default?: string; required?: boolean; type?: string };
        use_github_hosted_runners?: {
          default?: boolean;
          description?: string;
          required?: boolean;
          type?: string;
        };
      };
    };
  };
  jobs?: Record<string, Job>;
};

function workflow(path = workflowPath): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function step(job: Job | undefined, name: string): Step {
  const found = job?.steps?.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return found;
}

function runControlUiArtifactStep(options: { artifactPresent: boolean }) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-npm-preflight-ui-"));
  const binDir = join(root, "bin");
  const artifactPath = join(root, "dist", "control-ui", "index.html");
  const invocationPath = join(root, "pnpm-invocation.txt");
  mkdirSync(join(root, "scripts"), { recursive: true });
  mkdirSync(binDir);
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      version: "2026.6.35",
      scripts: {
        build: "node scripts/build-all.mjs",
        "ui:build": "node scripts/ui.js build",
      },
    }),
  );
  writeFileSync(join(root, "scripts", "build-all.mjs"), "");
  if (options.artifactPresent) {
    mkdirSync(join(root, "dist", "control-ui"), { recursive: true });
    writeFileSync(artifactPath, "<!doctype html>\n");
  }
  const fakePnpm = join(binDir, "pnpm");
  writeFileSync(
    fakePnpm,
    `#!/usr/bin/env bash
set -euo pipefail
[[ "$*" == "ui:build" ]]
printf '%s\\n' "$*" > "${invocationPath}"
mkdir -p "${join(root, "dist", "control-ui")}"
printf '<!doctype html>\\n' > "${artifactPath}"
`,
  );
  chmodSync(fakePnpm, 0o755);

  const ensureControlUi = step(
    workflow(preflightWorkflowPath).jobs?.prepare_openclaw_npm,
    "Ensure Control UI release artifact",
  );
  const result = spawnSync("bash", ["--noprofile", "--norc", "-c", ensureControlUi.run ?? ""], {
    cwd: root,
    encoding: "utf8",
    env: {
      ...process.env,
      OPENCLAW_CONTROL_UI_RELEASE_BUILD: "1",
      PATH: `${binDir}:${process.env.PATH ?? ""}`,
    },
  });
  const invocation = existsSync(invocationPath)
    ? readFileSync(invocationPath, "utf8").trim()
    : null;
  const artifactExists = existsSync(artifactPath);
  const targetHasTsxLoader = existsSync(join(root, "scripts", "tsx.mjs"));
  rmSync(root, { force: true, recursive: true });
  return { artifactExists, invocation, result, targetHasTsxLoader };
}

describe("minimal npm extended-stable workflow", () => {
  it("bounds every git fetch operation", () => {
    const source = [workflowPath, preflightWorkflowPath]
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");
    const gitFetchLines = source
      .split("\n")
      .filter((line) => /\bgit(?: -C (?:"[^"]+"|\S+))? fetch\b/u.test(line));
    expect(gitFetchLines.length).toBeGreaterThan(0);
    expect(
      gitFetchLines.every((line) => line.includes("timeout --signal=TERM --kill-after=10s 120s")),
    ).toBe(true);
  });

  it("adds extended-stable without adding policy or verifier contracts", () => {
    const raw = readFileSync(workflowPath, "utf8");
    const parsed = workflow();
    expect(parsed.on?.workflow_dispatch?.inputs?.npm_dist_tag?.options).toEqual([
      "alpha",
      "beta",
      "latest",
      "extended-stable",
    ]);
    for (const forbidden of [
      "release-policy",
      "policyMode",
      "release-operation-verifier",
      "external_contract_revision",
      "stable-lines.json",
    ]) {
      expect(raw).not.toContain(forbidden);
    }
  });

  it("allows an explicit default-off GitHub-hosted preflight runner", () => {
    const parsed = workflow();
    expect(parsed.on?.workflow_dispatch?.inputs?.use_github_hosted_runners).toEqual({
      default: false,
      description: "Use GitHub-hosted Ubuntu for npm preflight",
      required: false,
      type: "boolean",
    });
    expect(parsed.jobs?.preflight_openclaw_npm?.uses).toBe(`./${preflightWorkflowPath}`);
    expect(parsed.jobs?.preflight_openclaw_npm?.with?.use_github_hosted_runners).toBe(
      "${{ inputs.use_github_hosted_runners }}",
    );
    for (const job of Object.values(workflow(preflightWorkflowPath).jobs ?? {})) {
      expect(job["runs-on"]).toBe(
        "${{ inputs.use_github_hosted_runners && 'ubuntu-24.04' || 'blacksmith-32vcpu-ubuntu-2404' }}",
      );
    }
  });

  it("binds intentional Plugin SDK release changes to the reported digest", () => {
    const parsed = workflow();
    const input = parsed.on?.workflow_dispatch?.inputs?.plugin_sdk_api_acknowledgement;
    const qualification = workflow(preflightWorkflowPath).jobs?.check_sdk_npm;
    const preflightDiff = step(qualification, "Verify Plugin SDK API changes");
    const publishProvenance = step(
      parsed.jobs?.publish_openclaw_npm,
      "Verify prepared tarball provenance",
    );
    const downloadPreflight = step(
      parsed.jobs?.publish_openclaw_npm,
      "Download prepared npm tarball",
    );
    const verifyPreflightRun = step(
      parsed.jobs?.publish_openclaw_npm,
      "Verify preflight run metadata",
    );
    const trustedToolingCheckout = step(qualification, "Checkout trusted Plugin SDK API tooling");
    const publishProvenanceRun = publishProvenance.run;
    if (!publishProvenanceRun) {
      throw new Error("Verify prepared tarball provenance is missing its run script");
    }

    expect(input).toEqual({
      default: "",
      description:
        "8-character digest from the Plugin SDK API diff report when the release changes the SDK",
      required: false,
      type: "string",
    });
    expect(preflightDiff.env?.PLUGIN_SDK_API_ACKNOWLEDGEMENT).toBeUndefined();
    expect(publishProvenance.env?.PLUGIN_SDK_API_ACKNOWLEDGEMENT).toBe(
      "${{ inputs.plugin_sdk_api_acknowledgement }}",
    );
    expect(preflightDiff.run).toContain("['view', 'openclaw', 'dist-tags', '--json']");
    expect(preflightDiff.run).toContain("resolveNpmPreflightSdkSelectors");
    expect(preflightDiff.run).toContain('--bases-json "$bases_json"');
    expect(preflightDiff.run).not.toContain("--require-acknowledgement");
    expect(preflightDiff.run).not.toContain("--acknowledge");
    expect(preflightDiff.run).toContain(
      '--evidence "${GITHUB_WORKSPACE}/.artifacts/npm-sdk-proof/plugin-sdk-api-release-evidence.json"',
    );
    expect(trustedToolingCheckout.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(preflightDiff.run).toContain('git -C "$tooling_dir" status --porcelain');
    expect(preflightDiff.run).not.toContain('pkg.scripts?.["plugin-sdk:api:diff"]');
    expect(preflightDiff.run).toContain('pnpm --dir "$tooling_dir" run plugin-sdk:api:diff');
    expect(publishProvenanceRun).toContain("plugin-sdk-api-release-evidence.mjs");
    expect(publishProvenanceRun).toContain('--acknowledge "$PLUGIN_SDK_API_ACKNOWLEDGEMENT"');
    expect(publishProvenanceRun).toContain('--npm-dist-tag "$RELEASE_NPM_DIST_TAG"');
    expect(publishProvenanceRun).toContain('npm view "openclaw@${RELEASE_NPM_DIST_TAG}" version');
    expect(publishProvenanceRun).toContain(
      'git -C trusted-workflow rev-parse --verify "refs/tags/${current_selector_ref}^{commit}"',
    );
    expect(publishProvenanceRun).not.toContain("git fetch");
    expect(publishProvenanceRun).toContain('--current-selector-ref "$current_selector_ref"');
    expect(publishProvenanceRun).toContain('--current-selector-sha "$current_selector_sha"');
    expect(publishProvenanceRun).toContain('--workflow-sha "$PREFLIGHT_WORKFLOW_SHA"');
    expect(downloadPreflight.run).toContain(
      '"plugin-sdk-api-release-diff-${PREFLIGHT_RUN_ID}-${PREFLIGHT_RUN_ATTEMPT}"',
    );
    expect(publishProvenanceRun).toContain(
      "Prepared Plugin SDK API evidence does not match its immutable artifact",
    );
    expect(
      publishProvenanceRun.indexOf(
        "Prepared Plugin SDK API evidence does not match its immutable artifact",
      ),
    ).toBeLessThan(
      publishProvenanceRun.indexOf('npm view "openclaw@${RELEASE_NPM_DIST_TAG}" version'),
    );
    expect(verifyPreflightRun.run).toContain(
      '"$preflight_head_branch" == "$EXPECTED_EXTENDED_STABLE_BRANCH"',
    );
    expect(verifyPreflightRun.run).toContain('"$extended_stable_preflight" != "true"');
    expect(readFileSync("scripts/npm-prepared-bundle.mjs", "utf8")).toContain("pluginSdkApi,");
  });

  it("reuses the prepared tarball and guards source, preparation, and publication", () => {
    const parsed = workflow();
    const raw = readFileSync(preflightWorkflowPath, "utf8");
    expect(raw).toContain("openclaw-npm-preflight-${{ inputs.tag }}");
    const preflight = workflow(preflightWorkflowPath);
    for (const job of [preflight.jobs?.check_openclaw_npm, preflight.jobs?.prepare_openclaw_npm]) {
      const request = step(job, "Validate npm release request");
      expect(request.run).toContain("openclaw-npm-extended-stable-release.mjs validate-request");
      expect(request.env?.PREFLIGHT_ONLY).toBe("${{ inputs.preflight_only }}");
    }
    expect(
      step(parsed.jobs?.validate_publish_request, "Validate npm release request").run,
    ).toContain("openclaw-npm-extended-stable-release.mjs validate-request");
    expect(step(parsed.jobs?.publish_openclaw_npm, "Recheck npm release request").run).toContain(
      "openclaw-npm-extended-stable-release.mjs validate-request",
    );
    expect(
      parsed.jobs?.validate_publish_request?.steps?.map((candidate) => candidate.name),
    ).not.toContain("Setup Node environment");
  });

  it("threads an explicit, default-off extended-stable bypass through every policy gate", () => {
    const parsed = workflow();
    const input = parsed.on?.workflow_dispatch?.inputs?.bypass_extended_stable_guard;
    expect(input).toMatchObject({ default: false, type: "boolean" });

    const policySteps = [
      step(
        workflow(preflightWorkflowPath).jobs?.check_openclaw_npm,
        "Validate npm release request",
      ),
      step(
        workflow(preflightWorkflowPath).jobs?.prepare_openclaw_npm,
        "Validate npm release request",
      ),
      step(parsed.jobs?.validate_publish_request, "Validate npm release request"),
      step(parsed.jobs?.publish_openclaw_npm, "Recheck npm release request"),
      step(parsed.jobs?.publish_openclaw_npm, "Publish"),
    ];
    for (const policyStep of policySteps) {
      expect(policyStep.env?.BYPASS_EXTENDED_STABLE_GUARD).toBe(
        "${{ inputs.bypass_extended_stable_guard }}",
      );
    }
    const trustedRef = step(
      parsed.jobs?.validate_publish_request,
      "Require trusted workflow ref for publish",
    );
    expect(trustedRef.env?.BYPASS_EXTENDED_STABLE_GUARD).toBeUndefined();
    expect(trustedRef.run).not.toContain("BYPASS_EXTENDED_STABLE_GUARD");
    expect(trustedRef.run).toContain('"${WORKFLOW_REF}" == refs/heads/extended-stable/*');

    const summary = step(
      parsed.jobs?.publish_openclaw_npm,
      "Summarize extended-stable npm publication",
    );
    expect(summary.env?.BYPASS_EXTENDED_STABLE_GUARD).toBe(
      "${{ inputs.bypass_extended_stable_guard }}",
    );
    expect(summary.run).toContain("Extended-stable guard bypass: ${BYPASS_EXTENDED_STABLE_GUARD}");
  });

  it("lets main promote only the canonical immutable extended-stable candidate", () => {
    const parsed = workflow();
    const releaseDocs = readFileSync("docs/reference/RELEASING.md", "utf8");
    const input = parsed.on?.workflow_dispatch?.inputs?.release_candidate_branch;
    expect(input).toMatchObject({ default: "", required: false, type: "string" });

    const validate = step(parsed.jobs?.validate_publish_request, "Validate npm release request");
    expect(validate.env?.NPM_WORKFLOW_REF).toBe(
      "${{ inputs.release_candidate_branch != '' && format('refs/heads/{0}', inputs.release_candidate_branch) || github.ref }}",
    );
    const checkout = step(parsed.jobs?.validate_publish_request, "Checkout");
    expect(checkout.with?.ref).toBe(
      "${{ inputs.release_candidate_branch != '' && format('refs/tags/{0}', inputs.tag) || github.sha }}",
    );

    const trustedRef = step(
      parsed.jobs?.validate_publish_request,
      "Require trusted workflow ref for publish",
    );
    expect(trustedRef.env?.RELEASE_CANDIDATE_BRANCH).toBe("${{ inputs.release_candidate_branch }}");
    expect(trustedRef.run).toContain('release_candidate_branch="${RELEASE_CANDIDATE_BRANCH:-}"');
    expect(trustedRef.run).toContain('"${WORKFLOW_REF}" != "refs/heads/main"');
    expect(trustedRef.run).toContain(
      'expected_candidate_branch="extended-stable/${BASH_REMATCH[1]}.${BASH_REMATCH[2]}.33"',
    );

    const recheck = step(parsed.jobs?.publish_openclaw_npm, "Recheck npm release request");
    expect(recheck.env?.NPM_WORKFLOW_REF).toBe(validate.env?.NPM_WORKFLOW_REF);
    expect(releaseDocs).toContain("--ref main");
    expect(releaseDocs).toContain("-f release_candidate_branch=extended-stable/YYYY.M.33");
    expect(releaseDocs).toContain("canonical candidate branch directly");
    expect(releaseDocs).toContain("workflow SHA is reachable from current `main`");
    expect(releaseDocs).toContain("trusted main-pinned harness");
  });

  it("accepts arbitrary SHA preflight targets and exercises every publishable plugin package", () => {
    const parsed = workflow(preflightWorkflowPath);
    const preflight = parsed.jobs?.check_contents_npm;
    const metadata = step(parsed.jobs?.check_dependencies_npm, "Validate release metadata");
    const pack = step(
      parsed.jobs?.prepare_openclaw_npm,
      "Pack and seal publishable npm package set",
    );
    expect(metadata.run).toContain('RELEASE_BRANCH_REF="${RELEASE_SHA}"');
    expect(metadata.run).not.toContain("Validation-only SHA mode only supports");
    expect(pack.run).toContain("npm-prepared-bundle.mjs prepare");
    expect(pack.run).toContain('--release-ref "$RELEASE_REF"');
    expect(
      step(parsed.jobs?.prepare_openclaw_npm, "Validate npm package source metadata").run,
    ).toContain("--allow-unreleased-changelog");

    const plugins = step(preflight, "Exercise all extended-stable plugin npm packages");
    expect(step(preflight, "Verify final npm package bytes and lifecycle").env).toMatchObject({
      OPENCLAW_RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR:
        "${{ steps.prepared_bundle.outputs.core_tarball_dir }}",
    });
    expect(plugins.if).toBe("${{ inputs.npm_dist_tag == 'extended-stable' }}");
    expect(plugins.env).toMatchObject({
      OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: "extended-stable",
    });
    expect(plugins.run).toContain("--selection-mode all-publishable");
    expect(plugins.run).toContain("--npm-dist-tag extended-stable");
    expect(plugins.run).toContain("scripts/check-plugin-npm-runtime-builds.mts");
    expect(plugins.run).toContain("scripts/plugin-npm-publish.sh --pack");
    expect(plugins.run).toContain("OPENCLAW_PLUGIN_NPM_PACK_OUTPUT_DIR");
    expect(plugins.run).not.toContain("--publish");
    expect(step(preflight, "Upload extended-stable plugin npm packages")).toBeDefined();
  });

  it("restores same-SHA preflight build outputs and keeps validation steps running", () => {
    const parsed = workflow(preflightWorkflowPath);
    const preflight = parsed.jobs?.prepare_openclaw_npm;
    const stepNames = preflight?.steps?.map((candidate) => candidate.name) ?? [];

    const cleanup = step(preflight, "Clean preflight build outputs before cache restore");
    const restore = step(preflight, "Restore preflight build outputs");
    expect(stepNames.indexOf(cleanup.name)).toBeLessThan(stepNames.indexOf(restore.name));
    expect(cleanup.run).toContain("rm -rf -- dist dist-runtime packages/*/dist");
    expect(cleanup.run).toContain("-path '*/src/host/*'");
    expect(cleanup.run).toContain("-name '.bundle.hash'");
    expect(cleanup.run).toContain("-name '*.bundle.js'");
    expect(restore.uses).toContain("actions/cache/restore@");
    expect(restore.with?.path).toContain("dist/");
    expect(restore.with?.path).toContain("dist-runtime/");
    expect(restore.with?.path).toContain("packages/*/dist/");
    expect(restore.with?.path).toContain("extensions/*/src/host/**/.bundle.hash");
    expect(restore.with?.path).toContain("extensions/*/src/host/**/*.bundle.js");
    expect(restore.with?.key).toBe(
      "${{ runner.os }}-npm-preflight-dist-v1-${{ steps.preflight_cache_key.outputs.sha }}-${{ hashFiles('pnpm-lock.yaml') }}",
    );

    // Only the build producers skip on a cache hit; every validation step
    // still runs against the restored artifacts.
    const build = step(preflight, "Build");
    const buildControlUi = step(preflight, "Ensure Control UI release artifact");
    expect(build.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(build.env?.OPENCLAW_CONTROL_UI_RELEASE_BUILD).toBe("1");
    expect(buildControlUi.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(buildControlUi.env?.OPENCLAW_CONTROL_UI_RELEASE_BUILD).toBe("1");
    expect(
      step(parsed.jobs?.check_openclaw_npm, "Check source, test types, and architecture").if,
    ).toBeUndefined();
    const verifyReleaseContents = step(
      parsed.jobs?.check_contents_npm,
      "Verify final npm package bytes and lifecycle",
    );
    expect(verifyReleaseContents.if).toBeUndefined();
    expect(verifyReleaseContents.run).toContain('--tarball "$PREPARED_TARBALL_PATH"');

    const save = step(preflight, "Save preflight build outputs");
    const setup = step(preflight, "Setup Node environment");
    expect(setup.with?.["cache-mode"]).toBe("read-write");
    expect(save.uses).toContain("actions/cache/save@");
    expect(save.if).toContain("steps.setup-node-env.outputs.cache-mode == 'read-write'");
    expect(save.with?.key).toBe("${{ steps.dist_build_cache.outputs.cache-primary-key }}");
  });

  it("accepts the historical full-build artifact without a target tsx loader", () => {
    const { artifactExists, invocation, result, targetHasTsxLoader } = runControlUiArtifactStep({
      artifactPresent: true,
    });
    expect(targetHasTsxLoader).toBe(false);
    expect(result.status, result.stderr).toBe(0);
    expect(invocation).toBeNull();
    expect(artifactExists).toBe(true);
  });

  it("builds a missing Control UI release artifact through the target package script", () => {
    const { artifactExists, invocation, result, targetHasTsxLoader } = runControlUiArtifactStep({
      artifactPresent: false,
    });
    expect(targetHasTsxLoader).toBe(false);
    expect(result.status, result.stderr).toBe(0);
    expect(invocation).toBe("ui:build");
    expect(artifactExists).toBe(true);
  });

  it("uses the trusted Full Validation evidence verifier", () => {
    const parsed = workflow();
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw).toContain(
      "--json databaseId,attempt,workflowName,headBranch,headSha,event,status,conclusion,url",
    );
    const verifier = step(
      parsed.jobs?.publish_openclaw_npm,
      "Checkout trusted validation verifier",
    );
    expect(verifier.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(verifier.with?.path).toBe("trusted-workflow");

    const fullValidation = step(
      parsed.jobs?.publish_openclaw_npm,
      "Verify full release validation evidence",
    );
    expect(fullValidation.env?.EXPECTED_WORKFLOW_BRANCH).toBe(
      "${{ inputs.release_candidate_branch || github.ref_name }}",
    );
    expect(fullValidation.env?.FULL_RELEASE_VALIDATION_RUN_ATTEMPT).toBe(
      "${{ inputs.full_release_validation_run_attempt }}",
    );
    expect(fullValidation.run).toContain(
      "actions/runs/${FULL_RELEASE_VALIDATION_RUN_ID}/attempts/${FULL_RELEASE_VALIDATION_RUN_ATTEMPT}",
    );
    expect(fullValidation.run).toContain("--filter=blob:none");
    expect(fullValidation.run).toContain(
      "trusted-workflow/scripts/validate-full-release-validation-evidence.mjs",
    );
    expect(raw.match(/openclaw-npm-extended-stable-release\.mjs verify-run/g)).toHaveLength(2);
    expect(raw).not.toContain("openclaw-npm-extended-stable-release.mjs verify-manifest");
  });

  it("requires and authenticates the plugin npm run before an extended-stable core publish", () => {
    const parsed = workflow();
    expect(parsed.on?.workflow_dispatch?.inputs?.plugin_npm_run_id).toMatchObject({
      required: false,
      type: "string",
    });
    const required = step(
      parsed.jobs?.validate_publish_request,
      "Require preflight artifact promotion on real publish",
    );
    expect(required.env?.PLUGIN_NPM_RUN_ID).toBe("${{ inputs.plugin_npm_run_id }}");
    expect(required.run).toContain("Extended-stable publish requires plugin_npm_run_id");

    const verify = step(
      parsed.jobs?.publish_openclaw_npm,
      "Verify plugin npm release run metadata",
    );
    expect(verify.env?.RUN_KIND).toBe("plugin");
    expect(verify.run).toContain(
      "--json workflowName,displayTitle,headBranch,headSha,event,status,conclusion,url",
    );
    expect(verify.run).toContain("openclaw-npm-extended-stable-release.mjs verify-run");
  });

  it("captures selector fail closed, publishes extended-stable, retries, and summarizes", () => {
    const parsed = workflow();
    const publish = parsed.jobs?.publish_openclaw_npm;
    const capture = step(publish, "Capture previous extended-stable selector");
    const readback = step(publish, "Verify extended-stable registry readback");
    const summary = step(publish, "Summarize extended-stable npm publication");
    expect(capture.run).toContain("openclaw-npm-extended-stable-release.mjs capture-selector");
    expect(step(publish, "Publish").run).toContain("openclaw-npm-publish.sh");
    expect(readback.run).toContain("openclaw-npm-extended-stable-release.mjs verify-readback");
    expect(summary.if).toContain("always()");
    expect(summary.run).toContain("openclaw-npm-extended-stable-release.mjs repair-command");
    expect(summary.run).toContain('EXPECTED_VERSION="$RELEASE_TAG"');
    expect(summary.env?.EXTENDED_STABLE_BRANCH).toBe(
      "${{ inputs.release_candidate_branch || github.ref_name }}",
    );
    expect(summary.env?.RELEASE_SHA).toBeUndefined();
    expect(summary.run).toContain('release_sha="$(git rev-parse HEAD)"');
    expect(publish?.environment).toBe("npm-release");
  });

  it("publishes only the tarball path verified from the preflight manifest", () => {
    const publish = workflow().jobs?.publish_openclaw_npm;
    const provenance = step(publish, "Verify prepared tarball provenance");
    const publishStep = step(publish, "Publish");
    expect(provenance.run).toContain(
      'ARTIFACT_TARBALL_PATH="preflight-tarball/$ARTIFACT_TARBALL_NAME"',
    );
    expect(provenance.run).toContain('has("corePackageTarballs")');
    expect(provenance.run).toContain("CORE_PACKAGE_TARBALL_COUNT=0");
    expect(provenance.run).toContain('echo "tarball_path=$ARTIFACT_TARBALL_PATH"');
    expect(publishStep.env?.PUBLISH_TARBALL_PATH).toBe(
      "${{ steps.preflight_provenance.outputs.tarball_path }}",
    );
    expect(publish?.steps?.map((candidate) => candidate.name)).not.toContain(
      "Resolve publish tarball",
    );
    expect(readFileSync(workflowPath, "utf8")).not.toContain(
      "find preflight-tarball -type f -name '*.tgz'",
    );
  });

  it("publishes gateway packages in manifest order before the root package", () => {
    const parsed = workflow();
    const preflightPack = step(
      workflow(preflightWorkflowPath).jobs?.prepare_openclaw_npm,
      "Pack and seal publishable npm package set",
    );
    const publish = step(parsed.jobs?.publish_openclaw_npm, "Publish");
    expect(preflightPack.run).toContain("npm-prepared-bundle.mjs prepare");
    const policy = JSON.parse(
      readFileSync("scripts/lib/npm-core-release-packages.json", "utf8"),
    ) as { path: string }[];
    expect(policy.map((entry) => entry.path)).toEqual([
      "packages/ai",
      "packages/gateway-protocol",
      "packages/gateway-client",
    ]);
    expect(publish.run).toContain("(.corePackageTarballs // [])[]");
    expect(publish.run).toContain(
      'bash scripts/openclaw-npm-publish.sh --publish "${publish_target}"',
    );
  });
});
