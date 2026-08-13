import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/openclaw-npm-release.yml";

type Step = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string>;
};
type Job = { environment?: string; steps?: Step[] };
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
      };
    };
  };
  jobs?: Record<string, Job>;
};

function workflow(): Workflow {
  return parse(readFileSync(workflowPath, "utf8")) as Workflow;
}

function step(job: Job | undefined, name: string): Step {
  const found = job?.steps?.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return found;
}

describe("minimal npm extended-stable workflow", () => {
  it("bounds every git fetch operation", () => {
    const source = readFileSync(workflowPath, "utf8");
    const gitFetchLines = source
      .split("\n")
      .filter((line) => /\bgit(?: -C "[^"]+")? fetch\b/u.test(line));
    expect(gitFetchLines).toHaveLength(9);
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

  it("binds intentional Plugin SDK release changes to the reported digest", () => {
    const parsed = workflow();
    const input = parsed.on?.workflow_dispatch?.inputs?.plugin_sdk_api_acknowledgement;
    const preflightDiff = step(
      parsed.jobs?.preflight_openclaw_npm,
      "Verify Plugin SDK API changes",
    );
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
    const trustedToolingCheckout = step(
      parsed.jobs?.preflight_openclaw_npm,
      "Checkout trusted Plugin SDK API tooling",
    );

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
    expect(preflightDiff.run).toContain('npm view "openclaw@${RELEASE_NPM_DIST_TAG}" version');
    expect(preflightDiff.run).not.toContain("--require-acknowledgement");
    expect(preflightDiff.run).not.toContain("--acknowledge");
    expect(preflightDiff.run).toContain(
      '--evidence "${GITHUB_WORKSPACE}/.artifacts/plugin-sdk-api-release-evidence.json"',
    );
    expect(trustedToolingCheckout.with?.ref).toBe("${{ github.workflow_sha }}");
    expect(preflightDiff.run).toContain('git -C "$tooling_dir" status --porcelain');
    expect(preflightDiff.run).not.toContain('pkg.scripts?.["plugin-sdk:api:diff"]');
    expect(preflightDiff.run).toContain('pnpm --dir "$tooling_dir" run plugin-sdk:api:diff');
    expect(publishProvenance.run).toContain("plugin-sdk-api-release-evidence.mjs");
    expect(publishProvenance.run).toContain('--acknowledge "$PLUGIN_SDK_API_ACKNOWLEDGEMENT"');
    expect(publishProvenance.run).toContain('npm view "openclaw@${RELEASE_NPM_DIST_TAG}" version');
    expect(publishProvenance.run).toContain('--current-selector-ref "$current_selector_ref"');
    expect(publishProvenance.run).toContain('--current-selector-sha "$current_selector_sha"');
    expect(publishProvenance.run).toContain('--workflow-sha "$PREFLIGHT_WORKFLOW_SHA"');
    expect(downloadPreflight.run).toContain(
      '"plugin-sdk-api-release-diff-${PREFLIGHT_RUN_ID}-${PREFLIGHT_RUN_ATTEMPT}"',
    );
    expect(publishProvenance.run).toContain(
      "Prepared Plugin SDK API evidence does not match its immutable artifact",
    );
    expect(verifyPreflightRun.run).toContain(
      '"$preflight_head_branch" == "$EXPECTED_EXTENDED_STABLE_BRANCH"',
    );
    expect(verifyPreflightRun.run).toContain('"$extended_stable_preflight" != "true"');
    expect(readFileSync(workflowPath, "utf8")).toContain("pluginSdkApi,");
  });

  it("reuses the v1 preflight tarball and guards all three extended-stable gates", () => {
    const parsed = workflow();
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw).toContain("version: 1");
    expect(raw).toContain("openclaw-npm-preflight-${{ inputs.tag }}");
    expect(raw.match(/openclaw-npm-extended-stable-release\.mjs validate-request/g)).toHaveLength(
      3,
    );
    expect(step(parsed.jobs?.preflight_openclaw_npm, "Validate npm release request").run).toContain(
      "openclaw-npm-extended-stable-release.mjs validate-request",
    );
    expect(
      step(parsed.jobs?.preflight_openclaw_npm, "Validate npm release request").env?.PREFLIGHT_ONLY,
    ).toBe("${{ inputs.preflight_only }}");
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
      step(parsed.jobs?.preflight_openclaw_npm, "Validate npm release request"),
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
    const parsed = workflow();
    const preflight = parsed.jobs?.preflight_openclaw_npm;
    const metadata = step(preflight, "Validate release metadata");
    expect(metadata.run).toContain('RELEASE_BRANCH_REF="${RELEASE_SHA}"');
    expect(metadata.run).not.toContain("Validation-only SHA mode only supports");

    const plugins = step(preflight, "Exercise all extended-stable plugin npm packages");
    expect(step(preflight, "Verify release contents").env).toMatchObject({
      OPENCLAW_RELEASE_CHECK_LOCAL_PACKAGE_TARBALL_DIR:
        "${{ steps.core_package_tarballs.outputs.dir }}",
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
    const parsed = workflow();
    const preflight = parsed.jobs?.preflight_openclaw_npm;
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
    const buildControlUi = step(preflight, "Build Control UI");
    expect(build.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(build.env?.OPENCLAW_CONTROL_UI_RELEASE_BUILD).toBe("1");
    expect(buildControlUi.if).toBe("steps.dist_build_cache.outputs.cache-hit != 'true'");
    expect(buildControlUi.env?.OPENCLAW_CONTROL_UI_RELEASE_BUILD).toBe("1");
    expect(step(preflight, "Check").if).toBeUndefined();
    expect(step(preflight, "Verify release contents").if).toBeUndefined();
    expect(step(preflight, "Verify prepared npm tarball install").if).toBeUndefined();

    const save = step(preflight, "Save preflight build outputs");
    expect(save.uses).toContain("actions/cache/save@");
    expect(save.with?.key).toBe("${{ steps.dist_build_cache.outputs.cache-primary-key }}");
  });

  it("uses the trusted Full Validation evidence verifier", () => {
    const parsed = workflow();
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw).toContain("--json workflowName,headBranch,headSha,event,conclusion,url");
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
      parsed.jobs?.preflight_openclaw_npm,
      "Pack publishable core packages",
    );
    const publish = step(parsed.jobs?.publish_openclaw_npm, "Publish");
    expect(preflightPack.env?.CORE_PACKAGE_DIRS).toBe(
      "packages/ai packages/gateway-protocol packages/gateway-client",
    );
    expect(readFileSync(workflowPath, "utf8")).toContain('packageName: "@openclaw/gateway-client"');
    expect(publish.run).toContain("(.corePackageTarballs // [])[]");
    expect(publish.run).toContain(
      'bash scripts/openclaw-npm-publish.sh --publish "${publish_target}"',
    );
  });
});
