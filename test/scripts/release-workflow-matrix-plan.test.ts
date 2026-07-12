// Release Workflow Matrix Plan tests cover release workflow matrix plan script behavior.
import { readFileSync } from "node:fs";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { createReleaseWorkflowMatrixPlan } from "../../scripts/plan-release-workflow-matrix.mjs";

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
  env?: Record<string, string>;
  if?: string;
  name?: string;
  run?: string;
};

type MatrixEntry = {
  advisory?: boolean;
  chunk_id?: string;
  id?: string;
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
  "package_artifact_name",
  "package_artifact_id",
  "package_artifact_digest",
  "package_artifact_run_id",
  "package_artifact_run_attempt",
  "package_file_name",
  "package_source_sha",
  "package_sha256",
  "package_version",
]);

const PROFILE_EXPECTATIONS = [
  {
    profile: "minimum",
    dockerE2eChunks: ["package-update-openai", "package-update-anthropic", "package-update-core"],
    liveModelProviders: ["openai"],
  },
  {
    profile: "beta",
    dockerE2eChunks: ["package-update-openai", "package-update-anthropic", "package-update-core"],
    liveModelProviders: ["openai"],
  },
  {
    profile: "stable",
    dockerE2eChunks: [
      "core",
      "package-update-openai",
      "package-update-anthropic",
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
      "package-update-anthropic",
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

    expect(plan.dockerE2e.count).toBe(14);
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

  it("limits MiniMax Docker live-model coverage to the stable M2.7 pair", () => {
    const plan = createReleaseWorkflowMatrixPlan({
      includeLiveSuites: true,
      includeReleasePathSuites: true,
      releaseProfile: "stable",
    });

    expect(plan.liveModels.matrix.include).toContainEqual({
      provider_label: "MiniMax",
      providers: "minimax",
      models: "minimax/MiniMax-M2.7,minimax-portal/MiniMax-M2.7",
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
        profiles: entry.profiles,
        suiteId: entry.suite_id,
      }));

    expect(anthropicEntries).toEqual([
      {
        advisory: undefined,
        profiles: "stable",
        suiteId: "live-gateway-anthropic-docker",
      },
      {
        advisory: true,
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
