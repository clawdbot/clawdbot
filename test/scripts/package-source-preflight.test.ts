import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  jobs: Record<string, { steps: WorkflowStep[] }>;
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

describe("package source preflight", () => {
  it("accepts aligned source manifests and the explicitly allowed Unreleased section", () => {
    expect(
      validatePackageSource({
        aiManifestContent: aiManifest(),
        allowUnreleasedChangelog: true,
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toBe("2026.8.1");
  });

  it("uses canonical package changelog validation", () => {
    expect(() =>
      validatePackageSource({
        aiManifestContent: aiManifest(),
        changelogContent: changelog,
        rootManifestContent: rootManifest(),
      }),
    ).toThrow("CHANGELOG.md does not contain a release section for 2026.8.1.");
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
      "package.json must declare openai@6.50.0 to bundle @openclaw/ai without duplicate dependencies",
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
      "package.json must declare partial-json@0.1.7 to bundle @openclaw/ai without duplicate dependencies",
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
    expect(
      validatePackageSourceRef("HEAD", {
        allowUnreleasedChangelog: true,
      }),
    ).toBe("2026.8.1");
    expect(
      validatePackageSourceDir(process.cwd(), {
        allowUnreleasedChangelog: true,
      }),
    ).toBe("2026.8.1");
  });

  it("normalizes release-check source selection and guards the source resolver", () => {
    const workflow = readWorkflow(".github/workflows/openclaw-release-checks.yml");
    const steps = workflow.jobs.prepare_release_package!.steps;
    const sourceRequirement = workflowStep(
      workflow,
      "prepare_release_package",
      "Resolve source package requirement",
    );
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

    expect(preflightIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeLessThan(setupIndex);
    expect(preflightIndex).toBeLessThan(packageIndex);
    expect(
      runSourceRequirement(sourceRequirement, {
        CANDIDATE_ARTIFACT_JSON: "",
        RELEASE_PACKAGE_SPEC: " \t ",
      }),
    ).toBe("required=true");
    expect(
      runSourceRequirement(sourceRequirement, {
        CANDIDATE_ARTIFACT_JSON: "",
        RELEASE_PACKAGE_SPEC: "openclaw@beta",
      }),
    ).toBe("required=false");
    expect(preflight.if).toBe("steps.package_source.outputs.required == 'true'");
    expect(preflight.env?.PACKAGE_REF).toBe("${{ needs.resolve_target.outputs.revision }}");
    expect(preflight.run).toContain("node scripts/package-source-preflight.mjs");
    expect(packageStep.env?.SOURCE_PACKAGE_REQUIRED).toBe(
      "${{ steps.package_source.outputs.required }}",
    );
    expect(setup.if).toContain("steps.package_source.outputs.required == 'true'");
    expect(packageStep.if).toContain("steps.package_source.outputs.required == 'true'");
    expect(packageStep.run).toContain('if [[ "$SOURCE_PACKAGE_REQUIRED" != "true" ]]');
  });

  it("guards the default live/E2E candidate producer before setup and packing", () => {
    const workflow = readWorkflow(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml");
    const steps = workflow.jobs.prepare_docker_e2e_image!.steps;
    const sourceRequirement = workflowStep(
      workflow,
      "prepare_docker_e2e_image",
      "Resolve source package requirement",
    );
    const preflight = workflowStep(
      workflow,
      "prepare_docker_e2e_image",
      "Validate Docker E2E package source metadata",
    );
    const setup = workflowStep(workflow, "prepare_docker_e2e_image", "Setup Node environment");
    const pack = workflowStep(
      workflow,
      "prepare_docker_e2e_image",
      "Pack OpenClaw package for Docker E2E",
    );

    expect(
      runSourceRequirement(sourceRequirement, {
        NEEDS_PACKAGE: "1",
        PACKAGE_ARTIFACT_NAME: " ",
        PACKAGE_ARTIFACT_RUN_ID: "\t",
      }),
    ).toBe("required=true");
    expect(
      runSourceRequirement(sourceRequirement, {
        NEEDS_PACKAGE: "1",
        PACKAGE_ARTIFACT_NAME: "release-package-1",
        PACKAGE_ARTIFACT_RUN_ID: "123",
      }),
    ).toBe("required=false");
    expect(steps.indexOf(preflight)).toBeLessThan(steps.indexOf(setup));
    expect(steps.indexOf(preflight)).toBeLessThan(steps.indexOf(pack));
    expect(preflight.run).toContain("node .release-harness/scripts/package-source-preflight.mjs");
    expect(preflight.if).toBe("steps.package_source.outputs.required == 'true'");
    expect(setup.if).toContain("steps.package_source.outputs.required == 'true'");
    expect(pack.if).toBe("steps.package_source.outputs.required == 'true'");
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
    const workflow = readWorkflow(".github/workflows/openclaw-npm-release.yml");
    const steps = workflow.jobs.preflight_openclaw_npm!.steps;
    const checkout = workflowStep(
      workflow,
      "preflight_openclaw_npm",
      "Checkout trusted package source preflight",
    );
    const preflight = workflowStep(
      workflow,
      "preflight_openclaw_npm",
      "Validate npm package source metadata",
    );
    const setup = workflowStep(workflow, "preflight_openclaw_npm", "Setup Node environment");
    const build = workflowStep(workflow, "preflight_openclaw_npm", "Build");

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
