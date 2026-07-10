import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const workflowPath = ".github/workflows/plugin-npm-release.yml";
const metaPackagePath = "extensions/meta/package.json";
const metaManifestPath = "extensions/meta/openclaw.plugin.json";

type Step = {
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, string | number>;
};
type Job = {
  environment?: string;
  if?: string;
  needs?: string[] | string;
  permissions?: Record<string, string>;
  "runs-on"?: string;
  steps?: Step[];
  strategy?: { matrix?: { plugin?: string } };
};
type WorkflowInput = {
  default?: boolean | string;
  description?: string;
  options?: string[];
  required?: boolean;
  type?: string;
};
type Workflow = {
  on?: {
    workflow_dispatch?: {
      inputs?: Record<string, WorkflowInput>;
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

describe("plugin npm extended-stable workflow", () => {
  it("exposes only the default behavior and closed extended-stable override", () => {
    expect(readFileSync(workflowPath, "utf8")).toContain(
      "Plugin NPM Release [{0}] {1}', inputs.npm_dist_tag, inputs.ref",
    );
    const input = workflow().on?.workflow_dispatch?.inputs?.npm_dist_tag;
    expect(input).toEqual({
      description: "Optional npm dist-tag override",
      required: true,
      default: "default",
      type: "choice",
      options: ["default", "extended-stable"],
    });
  });

  it("exposes a closed preflight-only mode", () => {
    const inputs = workflow().on?.workflow_dispatch?.inputs;
    expect(inputs?.preflight_only).toEqual({
      description: "Prepare and verify immutable plugin npm artifacts without publishing",
      required: true,
      default: false,
      type: "boolean",
    });
    expect(inputs?.ref?.description).toBe(
      "Exact commit SHA; preflight accepts main/release ancestry, while publish mode also supports canonical extended-stable or matching Tideclaw alpha branches",
    );
  });

  it("uses one override for check, plan, preview, pack, and publish", () => {
    const parsed = workflow();
    const raw = readFileSync(workflowPath, "utf8");
    expect(raw.match(/--npm-dist-tag "\$\{NPM_DIST_TAG\}"/gu)).toHaveLength(2);
    const expectedOverride =
      "${{ inputs.npm_dist_tag == 'extended-stable' && inputs.npm_dist_tag || '' }}";
    for (const name of ["Preview publish command", "Preview npm pack contents", "Publish"]) {
      expect(
        step(
          parsed.jobs?.[name === "Publish" ? "publish_plugins_npm" : "preview_plugin_pack"],
          name,
        ).env,
      ).toMatchObject({ OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: expectedOverride });
    }
  });

  it("trusts only the canonical monthly branch at the exact checked-out SHA", () => {
    const trusted = step(
      workflow().jobs?.preview_plugins_npm,
      "Validate ref is on a trusted publish branch",
    );
    expect(trusted.run).toContain("extended-stable/${release_year}.${release_month}.33");
    expect(trusted.run).toContain("exact 40-character source SHA");
    expect(trusted.run).toContain(
      '[[ "${WORKFLOW_REF}" == "refs/heads/${extended_stable_branch}" ]]',
    );
    expect(trusted.run).toContain(
      '[[ "$(git rev-parse HEAD)" == "$(git rev-parse "refs/remotes/origin/${extended_stable_branch}")" ]]',
    );
  });

  it("binds preflight to an exact source SHA without release-publish approval", () => {
    const preview = workflow().jobs?.preview_plugins_npm;
    const previewSteps = preview?.steps ?? [];
    const trusted = step(preview, "Validate ref is on a trusted publish branch");
    expect(previewSteps.slice(0, 4).map((candidate) => candidate.name)).toEqual([
      "Checkout",
      "Resolve checked-out ref",
      "Validate ref is on a trusted publish branch",
      "Setup Node environment",
    ]);
    const trustedIndex = previewSteps.indexOf(trusted);
    expect(trustedIndex).toBe(2);
    for (const candidate of previewSteps.slice(0, trustedIndex)) {
      expect(candidate.uses?.startsWith("./"), candidate.name).not.toBe(true);
      expect(candidate.run ?? "", candidate.name).not.toMatch(/\b(?:bun|npm|pnpm)\b/u);
    }
    expect(step(preview, "Setup Node environment").uses).toBe("./.github/actions/setup-node-env");
    expect(trusted.env).toMatchObject({
      PREFLIGHT_ONLY:
        "${{ github.event_name == 'workflow_dispatch' && inputs.preflight_only || false }}",
      RELEASE_PUBLISH_RUN_ID:
        "${{ github.event_name == 'workflow_dispatch' && inputs.release_publish_run_id || '' }}",
      SOURCE_REF: "${{ github.event_name == 'workflow_dispatch' && inputs.ref || github.sha }}",
      WORKFLOW_REF: "${{ github.ref }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(trusted.run).toContain('[[ "${WORKFLOW_REF}" != "refs/heads/main" ]]');
    expect(trusted.run).toContain('git merge-base --is-ancestor "${WORKFLOW_SHA}" origin/main');
    expect(trusted.run).toContain('[[ ! "${SOURCE_REF}" =~ ^[0-9a-fA-F]{40}$ ]]');
    expect(trusted.run).toContain(
      '[[ "$(git rev-parse HEAD)" != "$(git rev-parse "${SOURCE_REF}^{commit}")" ]]',
    );
    expect(trusted.run).toContain("preflight must not include release_publish_run_id");
    const preflightBranchRejection = trusted.run?.indexOf(
      "Plugin npm preflight target must be reachable from main or release/*.",
    );
    const tideclawBranch = trusted.run?.indexOf(
      'if [[ "${WORKFLOW_REF}" =~ ^refs/heads/tideclaw/alpha/',
    );
    expect(preflightBranchRejection).toBeGreaterThan(-1);
    expect(tideclawBranch).toBeGreaterThan(preflightBranchRejection ?? Number.MAX_SAFE_INTEGER);
  });

  it("prepares and independently reads back immutable package evidence", () => {
    const parsed = workflow();
    const preview = parsed.jobs?.preview_plugin_pack;
    expect(preview?.if).toContain("inputs.preflight_only");
    expect(preview?.strategy?.matrix?.plugin).toContain("all_matrix");

    const prepare = step(preview, "Prepare immutable npm preflight artifact");
    expect(prepare.env?.ARTIFACT_NAME).toBe(
      "plugin-npm-package-source-${{ needs.preview_plugins_npm.outputs.ref_revision }}-${{ matrix.plugin.extensionId }}",
    );
    expect(prepare.run).toContain('bash scripts/plugin-npm-publish.sh --pack "${PACKAGE_DIR}"');
    expect(prepare.run).toContain('path.join(process.env.ARTIFACT_DIR, "preflight-manifest.json")');
    expect(prepare.run).toContain('kind: "openclaw-plugin-npm-preflight"');
    expect(prepare.run).toContain('mode: "preflight-only"');
    expect(prepare.run).toContain("source_package_json_sha256=");
    expect(prepare.run).toContain("packed_package_json_sha256=");
    expect(prepare.run).toContain(
      "sourcePackageJsonSha256: process.env.SOURCE_PACKAGE_JSON_SHA256",
    );
    expect(prepare.run).toContain("packageJsonSha256: process.env.PACKED_PACKAGE_JSON_SHA256");
    expect(prepare.run).toContain("npmIntegrity: actualIntegrity");
    expect(prepare.run).toContain("npmShasum: actualShasum");
    expect(prepare.run).toContain(
      'trustPolicy: "workflow-main-and-target-main-or-release-ancestor"',
    );
    expect(prepare.run).toContain("npmPublish: false");
    expect(prepare.run).toContain("environmentApproval: false");
    expect(prepare.run).toContain("oidcWrite: false");

    const upload = step(preview, "Upload immutable npm preflight artifact");
    expect(upload.uses).toBe("actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a");
    expect(upload.with).toMatchObject({
      "compression-level": 0,
      "if-no-files-found": "error",
      "retention-days": 30,
    });

    const verify = parsed.jobs?.verify_plugin_npm_preflight;
    expect(verify?.needs).toEqual(["preview_plugins_npm", "preview_plugin_pack"]);
    expect(verify?.strategy?.matrix?.plugin).toContain("all_matrix");
    expect(verify?.name).toBe("Preflight plugin npm package (${{ matrix.plugin.packageName }})");
    const trustedCheckout = step(verify, "Checkout trusted npm preflight tooling");
    expect(trustedCheckout.with?.ref).toBe("${{ github.workflow_sha }}");
    const download = step(verify, "Download immutable npm preflight artifact");
    expect(download.uses).toBe(
      "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
    );
    expect(download.with?.name).toBe(
      "plugin-npm-package-source-${{ needs.preview_plugins_npm.outputs.ref_revision }}-${{ matrix.plugin.extensionId }}",
    );
    const readback = step(verify, "Validate npm preflight artifact readback");
    expect(readback.run).toContain('git show "${SOURCE_SHA}:${PACKAGE_DIR}/package.json"');
    expect(readback.run).toContain("Expected exactly one live package artifact named");
    expect(readback.run).toContain('crypto.createHash("sha256")');
    expect(readback.run).toContain('crypto.createHash("sha512")');
    expect(readback.run).toContain('crypto.createHash("sha1")');
    expect(readback.run).toContain('echo "npm_integrity=${npm_integrity}"');
    expect(readback.run).toContain('echo "npm_shasum=${npm_shasum}"');
    expect(readback.run).toContain(
      "Packed plugin identity, package hashes, or install route changed",
    );
    expect(readback.run).toContain(
      'trustPolicy: "workflow-main-and-target-main-or-release-ancestor"',
    );
    expect(readback.run).not.toContain("target-main-release-or-tideclaw");

    const route = step(verify, "Verify npm publication route readiness");
    expect(route.env).toMatchObject({
      EXPECTED_NPM_INTEGRITY: "${{ steps.publication_artifact.outputs.npm_integrity }}",
      EXPECTED_NPM_SHASUM: "${{ steps.publication_artifact.outputs.npm_shasum }}",
    });
    expect(route.run).toContain("encodeURIComponent(packageName)");
    expect(route.run).toContain("fetchNpmRegistryPackumentWithRetry");
    expect(route.run).toContain("resolvePublishedNpmVersionRoute");
    expect(route.run).toContain('distTags: packument["dist-tags"] ?? {}');
    expect(route.run).toContain("const requestAttempts = 3");
    expect(route.run).toContain("const requestTimeoutMs = 20_000");
    expect(route.run).toContain("attempts: requestAttempts");
    expect(route.run).toContain("timeoutMs: requestTimeoutMs");
    expect(route.run).not.toContain("response.json()");
    expect(route.run).toContain("packument.versions?.[packageVersion]?.dist");
    expect(route.run).toContain("targetDist?.integrity !== expectedIntegrity");
    expect(route.run).toContain("targetDist?.shasum !== expectedShasum");
    expect(route.run).toContain("npm registry tarball identity does not match");
    expect(route.run).toContain('observations.push("npm-token-bootstrap")');
    expect(route.run).toContain('observations.push("npm-oidc")');

    const evidence = step(verify, "Record validation-only result");
    expect(evidence.env?.PUBLISH_ROUTE).toBe("${{ steps.publication_route.outputs.route }}");
    expect(evidence.run).toContain('schema: "openclaw.plugin-npm-package-evidence/v2"');
    expect(evidence.run).toContain("schemaVersion: 2");
    expect(evidence.run).toContain("packageJsonSha256: process.env.PACKED_PACKAGE_JSON_SHA256");
    expect(evidence.run).toContain(
      "sourcePackageJsonSha256: process.env.SOURCE_PACKAGE_JSON_SHA256",
    );
    expect(evidence.run).toContain("id: Number(process.env.PUBLICATION_ARTIFACT_ID)");
    expect(evidence.run).toContain("tarballSha256: process.env.TARBALL_SHA256");
    expect(evidence.run).toContain("tag-repair");
    const evidenceUpload = step(verify, "Upload immutable plugin npm preflight evidence");
    expect(evidenceUpload.with?.name).toBe(
      "plugin-npm-package-${{ matrix.plugin.extensionId }}-${{ matrix.plugin.version }}",
    );
    expect(evidenceUpload.with?.path).toBe(
      "${{ steps.preflight_evidence.outputs.artifact_path }}/*",
    );
  });

  it("makes every publication capability unreachable in preflight mode", () => {
    const parsed = workflow();
    for (const jobName of [
      "validate_release_publish_approval",
      "publish_plugins_npm",
      "verify_plugins_npm",
    ]) {
      expect(parsed.jobs?.[jobName]?.if, jobName).toContain("!inputs.preflight_only");
    }

    for (const jobName of [
      "preview_plugins_npm",
      "preview_plugin_pack",
      "verify_plugin_npm_preflight",
    ]) {
      const job = parsed.jobs?.[jobName];
      expect(job?.environment, jobName).toBeUndefined();
      expect(job?.permissions?.["id-token"], jobName).not.toBe("write");
      const serialized = JSON.stringify(job);
      expect(serialized, jobName).not.toContain("secrets.");
      expect(serialized, jobName).not.toContain("--publish");
      expect(serialized, jobName).not.toMatch(/\bnpm publish\b/u);
      expect(serialized, jobName).not.toMatch(/\bnpm dist-tag\b/u);
      expect(serialized.replaceAll("clawHub: false", ""), jobName).not.toMatch(/\bclawhub\b/iu);
      expect(serialized, jobName).not.toMatch(/\b(?:android|macos|windows)\b/iu);
    }
  });

  it("attests the canonical Meta provider package and install route", () => {
    const packageJson = JSON.parse(readFileSync(metaPackagePath, "utf8")) as {
      name?: string;
      openclaw?: {
        install?: { npmSpec?: string };
        release?: { publishToClawHub?: boolean; publishToNpm?: boolean };
      };
    };
    const pluginManifest = JSON.parse(readFileSync(metaManifestPath, "utf8")) as { id?: string };
    expect(packageJson.name).toBe("@openclaw/meta-provider");
    expect(packageJson.openclaw?.install?.npmSpec).toBe("@openclaw/meta-provider");
    expect(packageJson.openclaw?.release).toEqual({
      publishToClawHub: true,
      publishToNpm: true,
    });
    expect(pluginManifest.id).toBe("meta");
  });

  it("publishes extended-stable with OIDC only and verifies every package tag", () => {
    const parsed = workflow();
    const publish = step(parsed.jobs?.publish_plugins_npm, "Publish");
    const tokenExpression =
      "${{ inputs.npm_dist_tag != 'extended-stable' && secrets.NPM_TOKEN || '' }}";
    expect(publish.env).toMatchObject({
      NODE_AUTH_TOKEN: tokenExpression,
      NPM_TOKEN: tokenExpression,
      OPENCLAW_NPM_PUBLISH_AUTH_MODE: "trusted-publisher",
    });
    expect(parsed.jobs?.reconcile_plugins_npm).toBeUndefined();
    expect(readFileSync(workflowPath, "utf8")).not.toContain(
      'npm dist-tag add "${PACKAGE_NAME}@${PACKAGE_VERSION}" extended-stable',
    );

    const verify = parsed.jobs?.verify_plugins_npm;
    expect(verify?.needs).toEqual(["preview_plugins_npm", "publish_plugins_npm"]);
    expect(verify?.if).toContain("always()");
    expect(verify?.if).toContain("has_candidates == 'false'");
    expect(verify?.strategy?.matrix?.plugin).toContain("all_matrix");
    const readback = step(verify, "Verify complete plugin registry readback");
    expect(readback.run).toContain('npm view "${PACKAGE_NAME}@${PACKAGE_VERSION}" version');
    expect(readback.run).toContain('npm view "${PACKAGE_NAME}@extended-stable" version');
    expect(readback.run).toContain("OIDC-only source workflow does not mutate tags");
  });
});
