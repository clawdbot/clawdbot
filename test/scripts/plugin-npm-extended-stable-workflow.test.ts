import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { PLUGIN_NPM_RELEASE_AUTHORITY_PATHS } from "../../scripts/lib/plugin-publication-candidates.ts";

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
  "working-directory"?: string;
};
type Job = {
  name?: string;
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
    push?: { paths?: string[] };
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

function workflowPathPatternCovers(pattern: string, path: string): boolean {
  if (pattern.endsWith("/**")) {
    const directory = pattern.slice(0, -3);
    return path === directory || path.startsWith(`${directory}/`);
  }
  return path === pattern;
}

describe("plugin npm extended-stable workflow", () => {
  it("keeps push triggers aligned with npm publication authorities", () => {
    const triggerPaths = (workflow().on?.push?.paths ?? []).filter(
      (path) => path !== "extensions/**",
    );
    expect(
      triggerPaths.map((path) => (path.endsWith("/**") ? path.slice(0, -3) : path)).toSorted(),
    ).toEqual([...PLUGIN_NPM_RELEASE_AUTHORITY_PATHS].toSorted());
    expect(
      PLUGIN_NPM_RELEASE_AUTHORITY_PATHS.every((authorityPath) =>
        triggerPaths.some((pattern) => workflowPathPatternCovers(pattern, authorityPath)),
      ),
    ).toBe(true);
  });

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
    expect(inputs?.trusted_publisher_preflight).toEqual({
      description:
        "During preflight_only, verify npm trusted-publisher OIDC exchange instead of packing artifacts",
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
    for (const name of ["Preview publish command", "Preview npm pack contents"]) {
      expect(step(parsed.jobs?.preview_plugin_pack, name).env).toMatchObject({
        OPENCLAW_PLUGIN_NPM_PUBLISH_TAG: expectedOverride,
      });
    }
  });

  it("runs complete trusted packaging tooling against the frozen source checkout", () => {
    const parsed = workflow();
    const preflightCheckout = step(
      parsed.jobs?.preview_plugin_pack,
      "Checkout trusted packaging tooling",
    );
    expect(preflightCheckout.with).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: ".release-tooling",
      "sparse-checkout": "packages/normalization-core\nscripts\n",
    });
    const previewCommand = step(parsed.jobs?.preview_plugin_pack, "Preview publish command").run;
    expect(previewCommand).toContain(".release-tooling/scripts/plugin-npm-publish.sh");
    expect(previewCommand).toContain('--repo-root "$GITHUB_WORKSPACE"');
    expect(
      step(parsed.jobs?.preview_plugin_pack, "Prepare immutable npm preflight artifact").run,
    ).toContain(".release-tooling/scripts/plugin-npm-publish.sh");

    const publish = step(parsed.jobs?.publish_plugins_npm, "Publish with trusted publisher");
    expect(publish.env).toMatchObject({
      TARBALL_PATH: "${{ steps.publication_evidence.outputs.tarball_path }}",
      PUBLISH_TAG: "${{ steps.publication_evidence.outputs.publish_tag }}",
    });
    expect(publish.run).not.toContain("plugin-npm-publish.sh");
    expect(publish["working-directory"]).toBeUndefined();
  });

  it.each([
    { publishTag: "latest", identityExit: 0 },
    { publishTag: "beta", identityExit: 0 },
    { publishTag: "extended-stable", identityExit: 0 },
    { publishTag: "latest", identityExit: 17 },
  ])(
    "publishes the sealed artifact without a source install: $publishTag / identity $identityExit",
    ({ publishTag, identityExit }) => {
      const root = mkdtempSync(join(tmpdir(), "plugin-oidc-artifact-"));
      try {
        const bin = join(root, "bin");
        mkdirSync(bin);
        mkdirSync(join(root, "scripts"));
        writeFileSync(
          join(root, "scripts/plugin-npm-publish.sh"),
          '#!/bin/bash\necho "source rebuild requires an uninstalled candidate dependency tree" >&2\nexit 93\n',
        );
        const events = join(root, "events.jsonl");
        const tarball = join(root, "verified artifact.tgz");
        writeFileSync(tarball, "sealed preflight bytes");
        for (const command of ["node", "npm"]) {
          writeFileSync(
            join(bin, command),
            `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.EVENTS, JSON.stringify({ command: ${JSON.stringify(command)}, args, ...( ${JSON.stringify(command)} === "npm" ? { bytes: fs.readFileSync(args[1], "utf8"), token: Boolean(process.env.NPM_TOKEN || process.env.NODE_AUTH_TOKEN) } : {}) }) + "\\n");
process.exit(${JSON.stringify(command)} === "node" ? Number(process.env.IDENTITY_EXIT) : 0);
`,
            { mode: 0o755 },
          );
        }
        writeFileSync(join(bin, "timeout"), '#!/bin/bash\nshift 3\nexec "$@"\n', {
          mode: 0o755,
        });
        const publish = step(
          workflow().jobs?.publish_plugins_npm,
          "Publish with trusted publisher",
        );
        const result = spawnSync(
          "/bin/bash",
          [
            "-e",
            "-o",
            "pipefail",
            "-c",
            publish.run!.replaceAll("${{ matrix.plugin.packageDir }}", "extensions/fixture"),
          ],
          {
            cwd: root,
            encoding: "utf8",
            env: {
              PATH: `${bin}:/usr/bin:/bin`,
              ...publish.env,
              EVENTS: events,
              IDENTITY_EXIT: String(identityExit),
              TARBALL_PATH: tarball,
              PUBLISH_TAG: publishTag,
              NPM_TOKEN: "fixture-token-must-not-reach-npm",
              NODE_AUTH_TOKEN: "fixture-token-must-not-reach-npm",
            },
          },
        );
        expect(result.status, result.stderr).toBe(identityExit);
        const calls = readFileSync(events, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        expect(calls[0].command).toBe("node");
        expect(calls[0].args.slice(0, 2)).toEqual([
          "scripts/release-tooling-identity.mjs",
          "verify",
        ]);
        if (identityExit) {
          expect(calls).toHaveLength(1);
        } else {
          expect(calls).toHaveLength(2);
          expect(calls[1]).toEqual({
            command: "npm",
            args: [
              "publish",
              tarball,
              "--access",
              "public",
              "--ignore-scripts",
              "--provenance",
              "--tag",
              publishTag,
            ],
            bytes: "sealed preflight bytes",
            token: false,
          });
        }
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it("trusts only the canonical monthly branch at the exact checked-out SHA", () => {
    const trusted = step(
      workflow().jobs?.preview_plugins_npm,
      "Validate ref is on a trusted publish branch",
    );
    expect(trusted.run).toContain(
      'extended_branch = f"extended-stable/{version.group(1)}.{version.group(2)}.33"',
    );
    expect(trusted.run).toContain("exact 40-character source SHA");
    expect(trusted.run).toContain('os.environ["WORKFLOW_REF"] == f"refs/heads/{extended_branch}"');
    expect(trusted.run).toContain(
      'exact_ref_match(\n        "HEAD",\n        f"refs/remotes/origin/{extended_branch}"',
    );
  });

  it("binds preflight to an exact source SHA without release-publish approval", () => {
    const preview = workflow().jobs?.preview_plugins_npm;
    const previewSteps = preview?.steps ?? [];
    const trusted = step(preview, "Validate ref is on a trusted publish branch");
    expect(previewSteps.slice(0, 7).map((candidate) => candidate.name)).toEqual([
      "Prepare Git owner",
      "Checkout",
      "Checkout trusted planning tooling",
      "Resolve checked-out ref",
      "Verify trusted preflight tooling identity",
      "Validate ref is on a trusted publish branch",
      "Setup Node environment",
    ]);
    const trustedIndex = previewSteps.indexOf(trusted);
    expect(trustedIndex).toBe(5);
    for (const candidate of previewSteps.slice(0, trustedIndex)) {
      expect(candidate.uses?.startsWith("./"), candidate.name).not.toBe(true);
      expect(candidate.run ?? "", candidate.name).not.toMatch(/\b(?:bun|npm|pnpm)\b/u);
    }
    const toolingIdentity = step(preview, "Verify trusted preflight tooling identity");
    expect(toolingIdentity.env).toMatchObject({
      WORKFLOW_FULL_REF: "${{ github.ref }}",
      WORKFLOW_REF: "${{ github.ref_name }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(toolingIdentity.run).toContain(
      "node .release-tooling/scripts/release-tooling-identity.mjs verify",
    );
    expect(toolingIdentity.run).toContain('--workflow-ref "$WORKFLOW_REF"');
    expect(toolingIdentity.run).toContain('--workflow-full-ref "$WORKFLOW_FULL_REF"');
    expect(toolingIdentity.run).toContain('--workflow-sha "$WORKFLOW_SHA"');
    expect(step(preview, "Setup Node environment").uses).toBe("./.github/actions/setup-node-env");
    expect(trusted.env).toMatchObject({
      PREFLIGHT_ONLY:
        "${{ github.event_name == 'workflow_dispatch' && inputs.preflight_only || false }}",
      TRUSTED_PUBLISHER_PREFLIGHT:
        "${{ github.event_name == 'workflow_dispatch' && inputs.trusted_publisher_preflight || false }}",
      RELEASE_PUBLISH_RUN_ID:
        "${{ github.event_name == 'workflow_dispatch' && inputs.release_publish_run_id || '' }}",
      RELEASE_PUBLISH_RUN_ATTEMPT:
        "${{ github.event_name == 'workflow_dispatch' && inputs.release_publish_run_attempt || '' }}",
      SOURCE_REF: "${{ github.event_name == 'workflow_dispatch' && inputs.ref || github.sha }}",
      WORKFLOW_REF: "${{ github.ref }}",
      WORKFLOW_SHA: "${{ github.workflow_sha }}",
    });
    expect(trusted.run).toContain(
      'if os.environ["TRUSTED_PUBLISHER_PREFLIGHT"] == "true" and not preflight:',
    );
    expect(trusted.run).toContain("trusted_publisher_preflight requires preflight_only=true");
    expect(trusted.run).toContain('re.fullmatch(r"[0-9a-fA-F]{40}", source_ref)');
    expect(trusted.run).toContain(
      'exact_ref_match(\n        "HEAD",\n        f"{source_ref}^{{commit}}"',
    );
    expect(trusted.run).toContain(
      "Plugin npm preflight must not include a release publish parent run tuple.",
    );
    const preflightBranchRejection = trusted.run?.indexOf(
      "Plugin npm preflight target must be reachable from main or release/*.",
    );
    const tideclawBranch = trusted.run?.indexOf('r"refs/heads/tideclaw/alpha/');
    expect(preflightBranchRejection).toBeGreaterThan(-1);
    expect(tideclawBranch).toBeGreaterThan(preflightBranchRejection ?? Number.MAX_SAFE_INTEGER);
  });

  it("prepares and independently reads back immutable package evidence", () => {
    const parsed = workflow();
    const preview = parsed.jobs?.preview_plugin_pack;
    expect(preview?.if).toContain("inputs.preflight_only");
    expect(preview?.if).toContain("!inputs.trusted_publisher_preflight");
    expect(preview?.strategy?.matrix?.plugin).toContain("all_matrix");

    const prepare = step(preview, "Prepare immutable npm preflight artifact");
    expect(prepare.env?.ARTIFACT_NAME).toBe(
      "plugin-npm-package-source-${{ needs.preview_plugins_npm.outputs.ref_revision }}-${{ matrix.plugin.extensionId }}",
    );
    expect(prepare.if).toBeUndefined();
    expect(prepare.run).toContain("bash .release-tooling/scripts/plugin-npm-publish.sh");
    expect(prepare.run).toContain('--repo-root "$GITHUB_WORKSPACE"');
    expect(prepare.run).toContain('--pack "${PACKAGE_DIR}"');
    expect(prepare.run).toContain(
      'import { resolveNpmJsonEntries } from "./.release-tooling/scripts/lib/npm-json-output.mts";',
    );
    expect(prepare.run).toContain('raw[index] !== "[" && raw[index] !== "{"');
    expect(prepare.run).toContain("const entries = resolveNpmJsonEntries(candidate)");
    expect(prepare.run).toContain("npm can print bundled-dependency summaries");
    expect(prepare.run).toContain(
      "fs.writeFileSync(process.argv[3], `${JSON.stringify(pack, null, 2)}\\n`)",
    );
    expect(prepare.run).toContain('join(process.env.ARTIFACT_DIR, "preflight-manifest.json")');
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
    expect(prepare.run).toContain('typeof pluginManifest.id !== "string"');
    expect(prepare.run).not.toContain("pluginManifest.id !== process.env.EXTENSION_ID");
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
      overwrite: true,
      "retention-days": 30,
    });

    const verify = parsed.jobs?.verify_plugin_npm_preflight;
    expect(verify?.needs).toEqual(["preview_plugins_npm", "preview_plugin_pack"]);
    expect(verify?.if).toContain("!inputs.trusted_publisher_preflight");
    expect(verify?.strategy?.matrix?.plugin).toContain("all_matrix");
    expect(verify?.strategy?.matrix?.plugin).toContain("matrix");
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
    const sourceRead = step(verify, "Read exact npm preflight source package");
    expect(sourceRead.run).toContain("f\"{source_sha}:{os.environ['PACKAGE_DIR']}/package.json\"");
    expect(sourceRead.run).toContain("timeout=120");
    expect(sourceRead.run).toContain('errors="surrogateescape"');
    const readback = step(verify, "Validate npm preflight artifact readback");
    expect(readback.run).not.toMatch(/(?:^|\s)git (?:fetch|show)\b/mu);
    expect(readback.run).toContain("unique_by(.id)");
    expect(readback.run).not.toContain("unique_by(.name)");
    expect(readback.run).toContain("Expected exactly one live package artifact named");
    expect(readback.run).toContain('crypto.createHash("sha256")');
    expect(readback.run).toContain('crypto.createHash("sha512")');
    expect(readback.run).toContain('crypto.createHash("sha1")');
    expect(readback.run).toContain('echo "npm_integrity=${npm_integrity}"');
    expect(readback.run).toContain('echo "npm_shasum=${npm_shasum}"');
    expect(readback.run).toContain(
      "Packed plugin identity, package hashes, or install route changed",
    );
    expect(readback.run).toContain("manifest.package.pluginId !== pluginManifest.id");
    expect(readback.run).not.toContain("manifest.package.pluginId !== process.env.EXTENSION_ID");
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

    const evidence = step(verify, "Create immutable plugin npm publication evidence");
    expect(evidence.env?.PUBLISH_ROUTE).toBe("${{ steps.publication_route.outputs.route }}");
    expect(evidence.run).toContain("node scripts/plugin-publication-artifact.mjs create");
    expect(evidence.run).toContain("--publisher-policy-id plugin-npm-release-workflow");
    expect(evidence.run).toContain('--route "$PUBLISH_ROUTE"');
    expect(evidence.run).toContain('artifact_name="${ARTIFACT_NAME_PREFIX}-${PUBLISH_ROUTE}-');
    const evidenceUpload = step(verify, "Upload immutable plugin npm preflight evidence");
    expect(evidenceUpload.with?.name).toBe("${{ steps.preflight_evidence.outputs.artifact_name }}");
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
      expect(parsed.jobs?.[jobName]?.if, jobName).not.toContain("trusted_publisher_preflight");
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
      expect(serialized, jobName).not.toContain("plugin-npm-publish.sh --publish");
      expect(serialized, jobName).not.toMatch(/\bnpm publish\b/u);
      expect(serialized, jobName).not.toMatch(/\bnpm dist-tag\b/u);
      expect(serialized.replaceAll("clawHub: false", ""), jobName).not.toMatch(/\bclawhub\b/iu);
      expect(serialized, jobName).not.toMatch(/\b(?:android|macos|windows)\b/iu);
    }
  });

  it("runs one trusted-publisher exchange job directly after selected-package planning", () => {
    const parsed = workflow();
    expect(parsed.on?.push?.paths).not.toContain("scripts/npm-trusted-publisher-preflight.mjs");
    expect(readFileSync(workflowPath, "utf8")).toContain(
      "inputs.preflight_only && inputs.trusted_publisher_preflight && format('Plugin NPM Trusted Publisher Preflight",
    );
    expect(readFileSync(workflowPath, "utf8")).toContain("Plugin NPM Artifact Preflight");
    const oidc = parsed.jobs?.trusted_publisher_preflight;
    expect(oidc?.name).toBe("Trusted publisher OIDC exchange");
    expect(oidc?.needs).toBe("preview_plugins_npm");
    expect(oidc?.if).toContain("inputs.preflight_only");
    expect(oidc?.if).toContain("inputs.trusted_publisher_preflight");
    expect(oidc?.if).toContain("has_selection == 'true'");
    expect(oidc?.environment).toBe("npm-release");
    expect(oidc?.["runs-on"]).toBe("ubuntu-latest");
    expect(oidc?.permissions).toEqual({ contents: "read", "id-token": "write" });
    expect(oidc?.strategy).toBeUndefined();
    expect(step(oidc, "Checkout trusted OIDC preflight tooling").with).toMatchObject({
      "persist-credentials": false,
      ref: "${{ github.workflow_sha }}",
    });
    expect(step(oidc, "Setup trusted Node").with?.["node-version"]).toBe("${{ env.NODE_VERSION }}");
    const exchange = step(oidc, "Verify npm trusted-publisher exchange");
    expect(exchange.env?.PLUGIN_MATRIX).toBe("${{ needs.preview_plugins_npm.outputs.all_matrix }}");
    expect(exchange.run).toContain(
      'import { preflightNpmTrustedPublisher } from "./scripts/npm-trusted-publisher-preflight.mjs"',
    );
    expect(exchange.run).toContain("JSON.parse(process.env.PLUGIN_MATRIX)");
    expect(exchange.run).toContain("selection must be a non-empty array");
    expect(exchange.run).toContain("for (const entry of selection)");
    expect(exchange.run).toContain("await preflightNpmTrustedPublisher(entry?.packageName)");
    const serialized = JSON.stringify(oidc);
    expect(serialized).not.toContain("secrets.");
    expect(serialized).not.toContain("NPM_TOKEN");
    expect(serialized).not.toMatch(/\bnpm publish\b/u);
    expect(serialized).not.toMatch(/\bnpm dist-tag\b/u);
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

  it("owns external Git while retaining the npm publish deadline", () => {
    const source = readFileSync(workflowPath, "utf8");
    const npmPublishLines = source
      .split("\n")
      .filter((line) => line.includes('npm publish "$TARBALL_PATH"'));

    expect(source).not.toMatch(
      /timeout[^\n]*git|(?:^|\s)git (?:fetch|rev-parse|merge-base|for-each-ref|show)\b/mu,
    );
    expect(source.match(/timeout=120/gu)).toHaveLength(5);
    expect(npmPublishLines).toHaveLength(2);
    expect(
      npmPublishLines.every((line) => line.includes("timeout --signal=TERM --kill-after=10s 300s")),
    ).toBe(true);
  });

  it("publishes extended-stable with OIDC only and verifies every package tag", () => {
    const parsed = workflow();
    const publish = step(parsed.jobs?.publish_plugins_npm, "Publish with trusted publisher");
    expect(publish.run).toContain("unset NODE_AUTH_TOKEN NPM_TOKEN NODE_OPTIONS");
    expect(publish.run).toContain("NPM_CONFIG_USERCONFIG=/dev/null");
    expect(publish.env?.NODE_AUTH_TOKEN).toBeUndefined();
    expect(publish.env?.NPM_TOKEN).toBeUndefined();
    const bootstrapCheck = step(
      parsed.jobs?.publish_plugins_npm,
      "Check bootstrap npm package version",
    );
    expect(bootstrapCheck.if).toContain("npm-token-bootstrap");
    expect(bootstrapCheck.run).toContain("fetchNpmRegistryPackumentWithRetry");
    expect(bootstrapCheck.run).toContain("publishedDist.integrity !== expectedIntegrity");
    expect(bootstrapCheck.run).toContain("already_published=true");
    const bootstrap = step(parsed.jobs?.publish_plugins_npm, "Publish approved bootstrap tarball");
    expect(bootstrap.if).toContain("npm-token-bootstrap");
    expect(bootstrap.if).toContain(
      "steps.bootstrap_npm_package_version.outputs.already_published != 'true'",
    );
    expect(bootstrap.env?.NPM_TOKEN).toBe("${{ secrets.NPM_TOKEN }}");
    expect(bootstrap.env?.PACKAGE_NAME).toContain("publication_evidence.outputs.package_name");
    expect(bootstrap.run).not.toContain("@openclaw/meta-provider");
    expect(bootstrap.run).toContain("NPM_CONFIG_USERCONFIG");
    expect(bootstrap.run).toContain("unset NODE_AUTH_TOKEN NPM_TOKEN NODE_OPTIONS");
    expect(bootstrap.run).toContain('npm publish "$TARBALL_PATH"');
    expect(bootstrap.run).toContain("--ignore-scripts");
    expect(bootstrap.run).not.toContain("bash scripts/plugin-npm-publish.sh");

    const resolveEvidence = step(
      parsed.jobs?.publish_plugins_npm,
      "Resolve immutable npm publication artifact",
    );
    expect(resolveEvidence.run).toContain("producer_attempt");
    expect(resolveEvidence.run).toContain("last.producer_attempt");
    expect(resolveEvidence.run).toContain("--connect-timeout 10");
    expect(resolveEvidence.run).toContain("--max-time 120");
    expect(resolveEvidence.run).toContain("actions/artifacts/${artifact_id}/zip");
    expect(resolveEvidence.run).toContain("node scripts/release-tooling-identity.mjs verify");
    expect(resolveEvidence.run).toContain('--workflow-ref "$WORKFLOW_HEAD_BRANCH"');
    expect(resolveEvidence.run).toContain('--workflow-full-ref "$WORKFLOW_REF"');
    expect(resolveEvidence.run).toContain('--workflow-sha "$WORKFLOW_SHA"');
    expect(resolveEvidence.run).toContain('--release-publish-run-id "$RELEASE_PUBLISH_RUN_ID"');
    const sourceRead = step(
      parsed.jobs?.publish_plugins_npm,
      "Read exact npm publication source package",
    );
    expect(sourceRead.run).toContain("timeout=120");
    expect(sourceRead.run).toContain('errors="surrogateescape"');
    const consume = step(
      parsed.jobs?.publish_plugins_npm,
      "Consume immutable npm publication evidence",
    );
    expect(consume.run).toContain("node scripts/plugin-publication-artifact.mjs verify");
    expect(consume.run).toContain("--run-state-policy same-run-producer-success");
    expect(consume.run).toContain("producer_attempt");
    expect(consume.run).toContain(
      '--producer-job-name "Preflight plugin npm package (${PACKAGE_NAME})"',
    );
    expect(consume.run).toContain("--workflow-jobs-metadata");
    expect(consume.run).toContain("--source-package-json-sha256");
    expect(
      step(parsed.jobs?.publish_plugins_npm, "Checkout trusted publication tooling").with?.ref,
    ).toBe("${{ github.workflow_sha }}");
    expect(
      step(parsed.jobs?.preview_plugin_pack, "Checkout trusted packaging tooling").with,
    ).toMatchObject({
      ref: "${{ github.workflow_sha }}",
      path: ".release-tooling",
    });
    expect(
      step(parsed.jobs?.publish_plugins_npm, "Setup trusted publication dependencies").uses,
    ).toBe("./.github/actions/setup-node-env");
    expect(
      step(parsed.jobs?.publish_plugins_npm, "Setup trusted publication dependencies").if,
    ).toBeUndefined();
    expect(
      parsed.jobs?.publish_plugins_npm?.steps?.some(
        (entry) => entry.with?.path === ".publication-target",
      ),
    ).toBe(false);
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
