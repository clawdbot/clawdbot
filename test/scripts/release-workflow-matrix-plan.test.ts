// Release Workflow Matrix Plan tests cover release workflow matrix plan script behavior.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from "node:fs";
import path from "node:path";
import { runInNewContext } from "node:vm";
import { expectDefined } from "@openclaw/normalization-core";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { collectBundledPluginBuildEntries } from "../../scripts/lib/bundled-plugin-build-entries.mjs";
import { createReleaseWorkflowMatrixPlan } from "../../scripts/plan-release-workflow-matrix.mjs";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);

function workflow(): WorkflowDocument {
  return parse(
    readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
  ) as WorkflowDocument;
}

const PROFILE_GATED_STATIC_MATRIX_ALLOWLIST = [
  "validate_live_provider_suites",
  "validate_live_docker_provider_suites",
  "validate_live_media_provider_suites",
];

type WorkflowStep = {
  "continue-on-error"?: boolean;
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  with?: Record<string, unknown>;
};

type MatrixEntry = {
  advisory?: boolean;
  chunk_id?: string;
  id?: string;
  label?: string;
  profiles?: string;
  providers?: string;
  suite_group?: string;
  suite_id?: string;
};

type WorkflowJob = {
  env: Record<string, string>;
  needs: string[];
  outputs: Record<string, string>;
  steps: WorkflowStep[];
  strategy: { matrix: { include: MatrixEntry[] } };
};

type WorkflowDocument = {
  env: Record<string, string>;
  jobs: Record<string, WorkflowJob>;
  on: {
    workflow_call: { inputs: Record<string, unknown> };
    workflow_dispatch: { inputs: Record<string, unknown> };
  };
};

function requiredJob(definition: WorkflowDocument, name: string): WorkflowJob {
  return expectDefined(definition.jobs[name], `release workflow job ${name}`);
}

// Direct dispatches build from the selected ref. Only trusted workflow callers
// may provide the complete immutable package artifact tuple.
const WORKFLOW_CALL_ONLY_INPUTS = new Set([
  "prepare_only",
  "emit_candidate_evidence",
  "release_soak",
  "package_artifact_name",
  "package_artifact_id",
  "package_artifact_digest",
  "package_artifact_run_id",
  "package_artifact_run_attempt",
  "package_file_name",
  "package_source_sha",
  "package_sha256",
  "package_version",
  "enable_prepublish_plugin_registry",
  "prepublish_plugin_registry_artifact_name",
  "prepublish_plugin_registry_artifact_id",
  "prepublish_plugin_registry_artifact_digest",
  "prepublish_plugin_registry_artifact_run_id",
  "prepublish_plugin_registry_artifact_run_attempt",
  "prepublish_plugin_registry_manifest_sha256",
  "shared_image_artifact_name",
  "shared_image_artifact_id",
  "shared_image_artifact_digest",
  "shared_image_artifact_run_id",
  "shared_image_artifact_run_attempt",
  "shared_image_archive_sha256",
]);

const PROFILE_EXPECTATIONS = [
  {
    profile: "minimum",
    dockerE2eChunks: ["package-update-openai", "package-update-core"],
    liveModelProviders: ["openai"],
  },
  {
    profile: "beta",
    dockerE2eChunks: ["package-update-openai", "package-update-core"],
    liveModelProviders: ["openai"],
  },
  {
    profile: "stable",
    dockerE2eChunks: [
      "core",
      "package-update-openai",
      "package-update-core",
      "plugins-runtime-plugins",
      "plugins-runtime-services",
      "plugins-runtime-install-a",
      "plugins-runtime-install-b",
      "plugins-runtime-install-c",
      "plugins-runtime-install-d",
      "plugins-runtime-install-e",
      "plugins-runtime-install-f",
      "plugins-runtime-install-g",
      "plugins-runtime-install-h",
    ],
    liveModelProviders: ["anthropic", "google", "minimax", "openai"],
  },
  {
    profile: "full",
    dockerE2eChunks: [
      "core",
      "package-update-openai",
      "package-update-core",
      "plugins-runtime-plugins",
      "plugins-runtime-services",
      "plugins-runtime-install-a",
      "plugins-runtime-install-b",
      "plugins-runtime-install-c",
      "plugins-runtime-install-d",
      "plugins-runtime-install-e",
      "plugins-runtime-install-f",
      "plugins-runtime-install-g",
      "plugins-runtime-install-h",
    ],
    liveModelProviders: [
      "anthropic",
      "google",
      "minimax",
      "moonshot",
      "openai",
      "opencode-go",
      "openrouter",
      "xai",
      "zai",
      "fireworks",
    ],
  },
];

function staticProfileMatrixJobs() {
  return Object.entries(workflow().jobs)
    .filter(([, job]) => {
      const entries = job.strategy?.matrix?.include;
      return Array.isArray(entries) && entries.some((entry: MatrixEntry) => "profiles" in entry);
    })
    .map(([jobName]) => jobName)
    .toSorted((left, right) => left.localeCompare(right));
}

describe("scripts/plan-release-workflow-matrix.mjs", () => {
  it.each([
    ["validate_docker_e2e", "Run Docker E2E chunk"],
    ["validate_docker_lanes", "Run targeted Docker E2E lanes"],
  ])("drains diagnostics after credential failure in %s", (jobName, runStepName) => {
    const job = requiredJob(workflow(), jobName);
    const credentials = expectDefined(
      job.steps.find((step) => step.name === "Validate Docker E2E credentials"),
      "credential validation step",
    );
    const run = expectDefined(
      job.steps.find((step) => step.name === runStepName),
      "Docker execution step",
    );
    // Credential validation must be reached only after every setup/binding step
    // succeeds; nothing fallible may intervene before diagnostic continuation.
    expect(job.steps.indexOf(run)).toBe(job.steps.indexOf(credentials) + 1);
    expect(credentials["continue-on-error"]).not.toBe(true);
    expect(credentials.if ?? "").not.toMatch(/\b(?:always|cancelled|failure|success)\s*\(/u);

    const preflight = expectDefined(credentials.run, "credential validation command");
    for (const key of [undefined, "synthetic-openai-key"]) {
      const result = spawnSync("bash", ["--noprofile", "--norc", "-c", preflight], {
        encoding: "utf8",
        env: {
          PATH: process.env.PATH,
          CREDENTIALS: "openai",
          ...(key ? { OPENAI_API_KEY: key } : {}),
        },
      });
      expect(result.status, result.stderr).toBe(key ? 0 : 1);
      if (!key) {
        expect(result.stderr).toContain("Missing credential for OpenAI");
      }
      expect(result.stdout + result.stderr).not.toContain("synthetic-openai-key");
    }

    for (const state of [
      { label: "success", success: true, cancelled: false, outcome: "success", selected: true },
      {
        label: "credential failure",
        success: false,
        cancelled: false,
        outcome: "failure",
        selected: true,
      },
      {
        label: "setup failure",
        success: false,
        cancelled: false,
        outcome: "skipped",
        selected: true,
      },
      { label: "cancelled", success: false, cancelled: true, outcome: "failure", selected: true },
      {
        label: "unselected profile",
        success: true,
        cancelled: false,
        outcome: "skipped",
        selected: false,
      },
    ]) {
      const evaluate = (step: WorkflowStep) => {
        const expression = (step.if ?? "success()").replace(/^\$\{\{\s*([\s\S]*?)\s*\}\}$/u, "$1");
        // GitHub implicitly adds success() unless a status function is present.
        const implicitSuccess = /\b(?:always|cancelled|failure|success)\s*\(/u.test(expression)
          ? true
          : state.success;
        return (
          implicitSuccess &&
          runInNewContext(expression, {
            always: () => true,
            cancelled: () => state.cancelled,
            failure: () => !state.success && !state.cancelled,
            success: () => state.success,
            contains: (value: string, item: string) => value.includes(item),
            inputs: { release_test_profile: "full" },
            matrix: { profiles: state.selected ? "stable full" : "beta" },
            steps: { [credentials.id ?? ""]: { outcome: state.outcome } },
          })
        );
      };
      const profileSelected = jobName === "validate_docker_lanes" || state.selected;
      expect(evaluate(credentials), `${state.label}: preflight`).toBe(
        state.success && profileSelected,
      );
      expect(evaluate(run), `${state.label}: diagnostics`).toBe(
        !state.cancelled && profileSelected && (state.success || state.outcome === "failure"),
      );
    }
  });

  it("builds provider owners used by every direct and Gateway Docker live lane", () => {
    const definition = workflow();
    const outputDir = tempDirs.make("openclaw-live-image-selection-");
    const outputPath = path.join(outputDir, "outputs");
    symlinkSync(path.resolve("scripts"), path.join(outputDir, "scripts"), "dir");
    mkdirSync(path.join(outputDir, ".release-target"));
    symlinkSync(
      path.resolve("extensions"),
      path.join(outputDir, ".release-target/extensions"),
      "dir",
    );
    const env = {
      PATH: process.env.PATH,
      GITHUB_REPOSITORY: "openclaw/openclaw",
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: path.join(outputDir, "summary"),
      SELECTED_SHA: "a".repeat(40),
      SHARED_IMAGE_POLICY: "no-push-artifact",
    };
    const planner = expectDefined(
      requiredJob(definition, "plan_release_workflow_matrices").steps.find(
        (entry) => entry.name === "Plan shared live image plugins",
      ),
      "live image planner step",
    );
    const planned = spawnSync("bash", ["-c", expectDefined(planner.run, "planner command")], {
      cwd: outputDir,
      encoding: "utf8",
      env,
    });
    expect(planned.status, planned.stderr).toBe(0);
    const selected = readFileSync(outputPath, "utf8").trim().split("=")[1];
    const step = expectDefined(
      requiredJob(definition, "prepare_live_test_image").steps.find(
        (entry) => entry.name === "Resolve shared live-test image tag",
      ),
      "live image selection step",
    );
    const result = spawnSync("bash", ["-c", expectDefined(step.run, "selection command")], {
      encoding: "utf8",
      env: {
        ...env,
        LIVE_IMAGE_EXTENSIONS: selected,
      },
    });
    expect(result.status, result.stderr).toBe(0);
    const outputs = Object.fromEntries(
      readFileSync(outputPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => line.split("=")),
    );
    expect(outputs.live_image?.split(":")[1]?.length).toBeLessThanOrEqual(128);
    const builtIds = new Set(
      collectBundledPluginBuildEntries({
        env: { OPENCLAW_INTERNAL_DOCKER_BUILD_PLUGIN_IDS: outputs.live_image_extensions },
      }).map((entry: { id: string }) => entry.id),
    );
    const plan = createReleaseWorkflowMatrixPlan({
      releaseProfile: "full",
      includeLiveSuites: true,
    });
    const providers = new Set(
      plan.liveModels.matrix.include.map((entry: MatrixEntry) => entry.providers),
    );
    for (const entry of requiredJob(definition, "validate_live_docker_provider_suites").strategy
      .matrix.include) {
      for (const match of JSON.stringify(entry).matchAll(
        /OPENCLAW_LIVE_GATEWAY_PROVIDERS=([^\s"]+)/gu,
      )) {
        for (const provider of expectDefined(match[1], "Gateway provider selection").split(",")) {
          providers.add(provider);
        }
      }
    }
    const manifests = readdirSync("extensions").flatMap((id) => {
      const manifestPath = path.join("extensions", id, "openclaw.plugin.json");
      return existsSync(manifestPath)
        ? [{ id, manifest: JSON.parse(readFileSync(manifestPath, "utf8")) }]
        : [];
    });
    for (const provider of providers) {
      const owners = manifests.filter(({ manifest }) => manifest.providers?.includes(provider));
      expect(
        owners.some(({ id }) => builtIds.has(id)),
        `compiled owner for ${provider}`,
      ).toBe(true);
    }
  });

  it("declares every job input for both workflow entry points", () => {
    const definition = workflow();
    const referencedInputs = new Set<string>();
    for (const match of JSON.stringify(definition.jobs).matchAll(/\binputs\.([a-zA-Z0-9_]+)/gu)) {
      if (match[1]) {
        referencedInputs.add(match[1]);
      }
    }

    expect(Object.keys(definition.on.workflow_call.inputs)).toEqual(
      expect.arrayContaining([...referencedInputs]),
    );
    expect(Object.keys(definition.on.workflow_dispatch.inputs)).toEqual(
      expect.arrayContaining(
        [...referencedInputs].filter((input) => !WORKFLOW_CALL_ONLY_INPUTS.has(input)),
      ),
    );
    for (const input of WORKFLOW_CALL_ONLY_INPUTS) {
      expect(definition.on.workflow_call.inputs).toHaveProperty(input);
      expect(definition.on.workflow_dispatch.inputs).not.toHaveProperty(input);
    }
    expect(definition.on.workflow_dispatch.inputs.live_advisory).toEqual(
      definition.on.workflow_call.inputs.live_advisory,
    );
    expect(definition.on.workflow_dispatch.inputs.live_advisory).toMatchObject({
      default: false,
      required: false,
      type: "boolean",
    });
    expect(definition.on.workflow_dispatch.inputs.allow_unreleased_changelog).toEqual(
      definition.on.workflow_call.inputs.allow_unreleased_changelog,
    );
    expect(definition.on.workflow_call.inputs.allow_unreleased_changelog).toMatchObject({
      default: false,
      required: false,
      type: "boolean",
    });
    expect(definition.env.OPENCLAW_DOCKER_E2E_ALLOW_UNRELEASED_CHANGELOG).toBe(
      "${{ inputs.allow_unreleased_changelog }}",
    );
    const packageStep = requiredJob(definition, "prepare_docker_e2e_image").steps.find(
      (step: WorkflowStep) => step.name === "Pack OpenClaw package for Docker E2E",
    );
    const requiredPackageStep = expectDefined(packageStep, "Docker E2E package step");
    expect(requiredPackageStep.env?.ALLOW_UNRELEASED_CHANGELOG).toBe(
      "${{ inputs.allow_unreleased_changelog }}",
    );
    expect(requiredPackageStep.run).toContain("package_args+=(--allow-unreleased-changelog)");
    expect(requiredPackageStep.run).toContain("grep -Fq");
  });

  it.each(PROFILE_EXPECTATIONS)(
    "keeps $profile release jobs to profile-enabled Docker E2E chunks and live model providers",
    ({ profile, dockerE2eChunks, liveModelProviders }) => {
      const plan = createReleaseWorkflowMatrixPlan({
        includeLiveSuites: true,
        includeReleasePathSuites: true,
        releaseProfile: profile,
      });

      expect(plan.dockerE2e.matrix.include.map((entry: MatrixEntry) => entry.chunk_id)).toEqual(
        dockerE2eChunks,
      );
      expect(plan.liveModels.matrix.include.map((entry: MatrixEntry) => entry.providers)).toEqual(
        liveModelProviders,
      );
    },
  );

  it("reports omitted lanes for release jobs excluded by the selected profile", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      releaseProfile: "beta",
    });

    expect(plan.dockerE2e.omitted.map((entry: MatrixEntry) => entry.id)).toContain("core");
    expect(plan.liveModels.omitted.map((entry: MatrixEntry) => entry.id)).toContain("anthropic");
  });

  it("keeps stable release jobs broad enough for stable-required lanes", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      releaseProfile: "stable",
    });

    expect(plan.dockerE2e.count).toBe(13);
    expect(plan.liveModels.matrix.include.map((entry: MatrixEntry) => entry.providers)).toEqual([
      "anthropic",
      "google",
      "minimax",
      "openai",
    ]);
    expect(plan.liveModels.omitted.map((entry: MatrixEntry) => entry.id)).toEqual([
      "moonshot",
      "opencode-go",
      "openrouter",
      "xai",
      "zai",
      "fireworks",
    ]);
  });

  it("limits MiniMax Docker live-model coverage to the stable M3 pair", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      releaseProfile: "stable",
    });

    expect(plan.liveModels.matrix.include).toContainEqual({
      provider_label: "MiniMax",
      providers: "minimax",
      models: "minimax/MiniMax-M3,minimax-portal/MiniMax-M3",
      max_models: "2",
      profiles: "stable full",
    });
  });

  it("keeps stable Anthropic Docker proof blocking and full proof advisory", () => {
    const jobs = workflow().jobs;
    const dockerLiveJob = expectDefined(
      jobs.validate_live_docker_provider_suites,
      "live Docker provider suites job",
    );
    const anthropicEntries = dockerLiveJob.strategy.matrix.include
      .filter((entry: MatrixEntry) => entry.suite_group === "live-gateway-anthropic-docker")
      .map((entry: MatrixEntry) => ({
        advisory: entry.advisory,
        label: entry.label,
        profiles: entry.profiles,
        suiteId: entry.suite_id,
      }));

    expect(anthropicEntries).toEqual([
      {
        advisory: undefined,
        label: "Docker live gateway Anthropic",
        profiles: "stable",
        suiteId: "live-gateway-anthropic-docker",
      },
      {
        advisory: true,
        label: "Docker live gateway Anthropic (full advisory)",
        profiles: "full",
        suiteId: "live-gateway-anthropic-docker-full",
      },
    ]);
    expect(dockerLiveJob.strategy.matrix.include).toContainEqual(
      expect.objectContaining({ suite_id: "live-gateway-anthropic-docker-full" }),
    );

    const conditionalSteps = dockerLiveJob.steps.filter((step: WorkflowStep) => step.if);
    expect(conditionalSteps.length).toBeGreaterThan(0);
    for (const step of conditionalSteps) {
      expect(step.if).toContain("inputs.live_suite_filter == matrix.suite_group");
    }
  });

  it("disables live model planning when focused recovery targets another live suite", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      liveSuiteFilter: "live-cache",
      releaseProfile: "full",
    });

    expect(plan.liveModels.count).toBe(0);
    expect(plan.liveModels.omitted).toHaveLength(10);
    expect(plan.liveModels.omitted[0]?.reason).toBe(
      "Docker live model matrix disabled by input selection",
    );
  });

  it("wires filtered matrices into the reusable live and E2E workflow", () => {
    const jobs = workflow().jobs;
    const planner = expectDefined(
      jobs.plan_release_workflow_matrices,
      "release matrix planner job",
    );
    const dockerE2e = expectDefined(jobs.validate_docker_e2e, "Docker E2E validation job");
    const liveModels = expectDefined(
      jobs.validate_live_models_docker,
      "live Docker models validation job",
    );

    expect(planner.outputs.docker_e2e_matrix).toBe("${{ steps.plan.outputs.docker_e2e_matrix }}");
    expect(planner.outputs.live_models_matrix).toBe("${{ steps.plan.outputs.live_models_matrix }}");
    expect(planner.outputs.live_image_extensions).toBe(
      "${{ steps.live_image.outputs.live_image_extensions }}",
    );
    const metadataCheckout = expectDefined(
      planner.steps.find((step) => step.name === "Checkout selected live plugin metadata"),
      "selected target metadata checkout",
    );
    expect(metadataCheckout.with?.ref).toBe(
      "${{ needs.validate_selected_ref.outputs.selected_sha }}",
    );
    const liveImage = requiredJob(workflow(), "prepare_live_test_image");
    expect(liveImage.needs).toContain("plan_release_workflow_matrices");
    expect(
      liveImage.steps.find((step) => step.name === "Resolve shared live-test image tag")?.env
        ?.LIVE_IMAGE_EXTENSIONS,
    ).toBe("${{ needs.plan_release_workflow_matrices.outputs.live_image_extensions }}");
    expect(dockerE2e.needs).toContain("plan_release_workflow_matrices");
    expect(liveModels.needs).toContain("plan_release_workflow_matrices");
    expect(dockerE2e.strategy.matrix).toBe(
      "${{ fromJson(needs.plan_release_workflow_matrices.outputs.docker_e2e_matrix) }}",
    );
    expect(liveModels.strategy.matrix).toBe(
      "${{ fromJson(needs.plan_release_workflow_matrices.outputs.live_models_matrix) }}",
    );
    expect(liveModels.env.OPENCLAW_LIVE_MODELS).toBe("${{ matrix.models || 'modern' }}");
    expect(liveModels.env.OPENCLAW_LIVE_MAX_MODELS).toBe("${{ matrix.max_models || '6' }}");
  });

  it("requires new release-profile matrices to use a planner or an explicit allowlist", () => {
    expect(staticProfileMatrixJobs()).toEqual(PROFILE_GATED_STATIC_MATRIX_ALLOWLIST.toSorted());
  });
});
