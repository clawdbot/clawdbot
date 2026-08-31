import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const FULL_RELEASE = ".github/workflows/full-release-validation.yml";
const RELEASE_CHECKS = ".github/workflows/openclaw-release-checks.yml";
const PACKAGE_ACCEPTANCE = ".github/workflows/package-acceptance.yml";
const PLUGIN_PRERELEASE = ".github/workflows/plugin-prerelease.yml";
const LIVE_E2E = ".github/workflows/openclaw-live-and-e2e-checks-reusable.yml";
const INSTALL_SMOKE = ".github/workflows/install-smoke.yml";
const SHARED_IMAGE_PUBLISHER = ".github/workflows/openclaw-shared-image-publish-reusable.yml";
const SCHEDULED_LIVE = ".github/workflows/openclaw-scheduled-live-checks.yml";
const DOCKER_RELEASE = ".github/workflows/docker-release.yml";
const UPDATE_MIGRATION = ".github/workflows/update-migration.yml";
const PERFORMANCE = ".github/workflows/openclaw-performance.yml";
const LIVE_BUILD = "scripts/test-live-build-docker.sh";
const DOCKER_E2E_IMAGE_HELPER = "scripts/lib/docker-e2e-image.sh";
const RELEASE_FILTER_VALIDATOR = resolve("scripts/github/validate-release-suite-filters.sh");
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

type WorkflowInput = {
  default?: boolean | number | string;
  options?: string[];
  required?: boolean;
  type?: string;
};

type WorkflowStep = {
  env?: Record<string, string>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type WorkflowJob = {
  "continue-on-error"?: boolean | string;
  env?: Record<string, string>;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: PermissionMap;
  secrets?: Record<string, string> | "inherit";
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, boolean | number | string>;
};

type Workflow = {
  jobs?: Record<string, WorkflowJob>;
  on?: {
    push?: unknown;
    workflow_call?: {
      inputs?: Record<string, WorkflowInput>;
      outputs?: Record<string, { description?: string; value?: string }>;
      secrets?: Record<string, { required?: boolean }>;
    };
    workflow_dispatch?: { inputs?: Record<string, WorkflowInput> };
  };
  permissions?: PermissionMap;
};

type PermissionLevel = "none" | "read" | "write";
type PermissionMap = "read-all" | "write-all" | Record<string, PermissionLevel>;

const PERMISSION_RANK: Record<PermissionLevel, number> = { none: 0, read: 1, write: 2 };

function permissionAt(
  permissions: PermissionMap | undefined,
  scope: string,
  inherited: PermissionLevel,
): PermissionLevel {
  if (permissions === undefined) {
    return inherited;
  }
  if (permissions === "read-all") {
    return "read";
  }
  if (permissions === "write-all") {
    return "write";
  }
  return permissions[scope] ?? "none";
}

function permissionScopes(...permissions: Array<PermissionMap | undefined>): string[] {
  const scopes = new Set(["actions", "contents", "packages", "pull-requests"]);
  for (const value of permissions) {
    if (value && typeof value === "object") {
      for (const scope of Object.keys(value)) {
        scopes.add(scope);
      }
    }
  }
  return [...scopes].toSorted();
}

function reusablePermissionViolations(
  callerPath: string,
  callerJobName: string,
  seen = new Set<string>(),
): string[] {
  const caller = readWorkflow(callerPath);
  const callerJob = job(caller, callerJobName);
  if (!callerJob.uses?.startsWith("./.github/workflows/")) {
    throw new Error(`${callerPath}:${callerJobName} is not a local reusable-workflow call`);
  }
  const ceiling = callerJob.permissions ?? caller.permissions;
  return workflowPermissionViolations(
    callerJob.uses.slice(2),
    Object.fromEntries(
      permissionScopes(ceiling).map((scope) => [scope, permissionAt(ceiling, scope, "none")]),
    ),
    `${callerPath}:${callerJobName}`,
    seen,
  );
}

function workflowPermissionViolations(
  workflowPath: string,
  ceiling: Record<string, PermissionLevel>,
  chain: string,
  seen: Set<string>,
): string[] {
  const visitKey = `${chain}->${workflowPath}`;
  if (seen.has(visitKey)) {
    return [];
  }
  seen.add(visitKey);
  const workflow = readWorkflow(workflowPath);
  const violations: string[] = [];
  for (const [jobName, workflowJob] of Object.entries(workflow.jobs ?? {})) {
    const requested = workflowJob.permissions ?? workflow.permissions;
    const scopes = permissionScopes(requested, ceiling);
    const effective: Record<string, PermissionLevel> = {};
    for (const scope of scopes) {
      const cap = ceiling[scope] ?? "none";
      const level = permissionAt(requested, scope, cap);
      effective[scope] = level;
      if (PERMISSION_RANK[level] > PERMISSION_RANK[cap]) {
        violations.push(
          `${chain} -> ${workflowPath}:${jobName} requests ${scope}:${level} above caller ${scope}:${cap}`,
        );
      }
    }
    if (workflowJob.uses?.startsWith("./.github/workflows/")) {
      violations.push(
        ...workflowPermissionViolations(
          workflowJob.uses.slice(2),
          effective,
          `${chain} -> ${workflowPath}:${jobName}`,
          seen,
        ),
      );
    }
  }
  return violations;
}

function readWorkflow(path: string): Workflow {
  return parse(readFileSync(path, "utf8")) as Workflow;
}

function job(workflow: Workflow, name: string): WorkflowJob {
  const value = workflow.jobs?.[name];
  if (!value) {
    throw new Error(`missing workflow job ${name}`);
  }
  return value;
}

function step(workflowJob: WorkflowJob, name: string): WorkflowStep {
  const value = workflowJob.steps?.find((candidate) => candidate.name === name);
  if (!value) {
    throw new Error(`missing workflow step ${name}`);
  }
  return value;
}

function expectReadOnlyPackagePermission(workflowJob: WorkflowJob): void {
  expect(permissionAt(workflowJob.permissions, "packages", "none")).toBe("read");
}

function executeReleaseGroupCapture(
  group: string,
  runReleaseSoak = false,
  liveSuiteFilter = "",
  crossOsSuiteFilter = "",
  phase = "all",
  candidateArtifactJson = "",
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-release-groups-"));
  const output = join(root, "github-output");
  writeFileSync(output, "");
  try {
    const capture = step(
      job(readWorkflow(RELEASE_CHECKS), "resolve_target"),
      "Capture selected inputs",
    );
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", capture.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        CANDIDATE_ARTIFACT_JSON_INPUT: candidateArtifactJson,
        GITHUB_OUTPUT: output,
        RELEASE_ALLOW_UNRELEASED_CHANGELOG_INPUT: "false",
        RELEASE_CODEX_PLUGIN_SPEC_INPUT: "",
        RELEASE_CROSS_OS_SUITE_FILTER_INPUT: crossOsSuiteFilter,
        RELEASE_FAIL_FAST_INPUT: "false",
        RELEASE_FILTER_VALIDATOR,
        RELEASE_LIVE_SUITE_FILTER_INPUT: liveSuiteFilter,
        RELEASE_MODE_INPUT: "both",
        RELEASE_PHASE_INPUT: phase,
        RELEASE_PACKAGE_ACCEPTANCE_PACKAGE_SPEC_INPUT: "",
        RELEASE_PACKAGE_SPEC_INPUT: "",
        RELEASE_PROFILE_INPUT: "beta",
        RELEASE_PROVIDER_INPUT: "openai",
        RELEASE_QA_DISCORD_LIVE_CI_ENABLED: "false",
        RELEASE_QA_SLACK_LIVE_CI_ENABLED: "false",
        RELEASE_QA_WHATSAPP_LIVE_CI_ENABLED: "false",
        RELEASE_REF_INPUT: "main",
        RELEASE_RERUN_GROUP_INPUT: group,
        RELEASE_RUN_MATURITY_SCORECARD_INPUT: "false",
        RELEASE_RUN_RELEASE_SOAK_INPUT: String(runReleaseSoak),
        RELEASE_SKIP_PACKAGE_TELEGRAM_E2E_INPUT: "false",
        TELEGRAM_WAIVER: "",
      },
    });
    const outputText = readFileSync(output, "utf8").trim();
    const outputs = outputText
      ? Object.fromEntries(
          outputText.split("\n").map((line) => {
            const separator = line.indexOf("=");
            return [line.slice(0, separator), line.slice(separator + 1)];
          }),
        )
      : {};
    return { outputs, result };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

function runReleaseGroupCapture(
  group: string,
  runReleaseSoak = false,
  liveSuiteFilter = "",
  crossOsSuiteFilter = "",
  phase = "all",
  candidateArtifactJson = "",
): Record<string, string> {
  const execution = executeReleaseGroupCapture(
    group,
    runReleaseSoak,
    liveSuiteFilter,
    crossOsSuiteFilter,
    phase,
    candidateArtifactJson,
  );
  expect(execution.result.status, `${group}: ${execution.result.stderr}`).toBe(0);
  return execution.outputs;
}

function executeParentFilterValidation(
  group: string,
  liveSuiteFilter = "",
  crossOsSuiteFilter = "",
) {
  const root = mkdtempSync(join(tmpdir(), "openclaw-parent-filter-normalization-"));
  const output = join(root, "github-output");
  writeFileSync(output, "");
  try {
    const normalize = step(
      job(readWorkflow(FULL_RELEASE), "resolve_target"),
      "Validate suite filters",
    );
    const result = spawnSync("bash", ["-euo", "pipefail", "-c", normalize.run ?? ""], {
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_OUTPUT: output,
        RAW_CROSS_OS_SUITE_FILTER: crossOsSuiteFilter,
        RAW_LIVE_SUITE_FILTER: liveSuiteFilter,
        RELEASE_FILTER_VALIDATOR,
        RERUN_GROUP: group,
      },
    });
    return { output: readFileSync(output, "utf8"), result };
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
}

describe("release validation no-push transport", () => {
  it("routes release retries through explicit concrete groups and resource gates", () => {
    const full = readWorkflow(FULL_RELEASE);
    const release = readWorkflow(RELEASE_CHECKS);
    const umbrellaGroups = full.on?.workflow_dispatch?.inputs?.rerun_group?.options ?? [];
    const releaseGroups = release.on?.workflow_dispatch?.inputs?.rerun_group?.options ?? [];
    const releasePhases = release.on?.workflow_dispatch?.inputs?.phase?.options ?? [];
    const independentDispatch = step(
      job(full, "release_checks_independent"),
      "Dispatch release checks independent phase",
    );
    const candidateDispatch = step(
      job(full, "release_checks_candidate"),
      "Dispatch release checks candidate phase",
    );
    const capture = step(job(release, "resolve_target"), "Capture selected inputs");
    const parentFilters = step(job(full, "resolve_target"), "Validate suite filters");
    const candidateRequest = step(
      job(full, "resolve_target"),
      "Build canonical release candidate request",
    );

    expect(umbrellaGroups).toEqual([
      "all",
      "ci",
      "plugin-prerelease",
      "install-smoke",
      "cross-os",
      "live-e2e",
      "package",
      "qa-parity",
      "qa-live",
      "npm-telegram",
      "performance",
    ]);
    expect(umbrellaGroups).not.toContain("release-checks");
    expect(umbrellaGroups).not.toContain("qa");
    expect(releaseGroups).not.toContain("release-checks");
    expect(releaseGroups).toContain("qa");
    expect(releasePhases).toEqual(["all", "independent", "candidate"]);
    expect(parentFilters.env?.RELEASE_FILTER_VALIDATOR).toBe(
      "workflow/scripts/github/validate-release-suite-filters.sh",
    );
    expect(capture.env?.RELEASE_FILTER_VALIDATOR).toBe(
      "workflow/scripts/github/validate-release-suite-filters.sh",
    );
    for (const [dispatch, phase] of [
      [independentDispatch, "independent"],
      [candidateDispatch, "candidate"],
    ] as const) {
      expect(dispatch.env?.PHASE).toBe(phase);
      expect(dispatch.run).toContain('-f rerun_group="$RERUN_GROUP"');
      expect(dispatch.run).toContain('-f phase="$PHASE"');
      expect(dispatch.run).not.toContain("child_rerun_group");
    }
    expect(candidateRequest.run).toContain(
      '[[ "$RERUN_GROUP" =~ ^(all|plugin-prerelease)$ ]] && plugin_required=true',
    );
    expect(candidateRequest.run).toContain('[[ "$RERUN_GROUP" =~ ^(all|cross-os)$ &&');
    expect(candidateRequest.run).toContain('elif [[ "$RERUN_GROUP" =~ ^(all|package)$ &&');
    expect(candidateRequest.run).toContain('elif [[ "$RERUN_GROUP" == "live-e2e" &&');
    const candidateAcquisition = job(full, "candidate_acquisition");
    expect(candidateAcquisition.if).toContain(
      "needs.resolve_target.outputs.candidate_required == 'true'",
    );
    expect(candidateAcquisition.uses).toBe("./.github/workflows/full-release-candidate.yml");
    expect(capture.run).toContain(
      "release_check_groups=(install-smoke cross-os package qa-parity)",
    );
    expect(capture.run).toContain("release_check_groups=(qa-parity qa-live)");
    expect(capture.run).toContain("release_check_groups_json=");
    expect(capture.run).toContain("package_required=false");
    expect(capture.run).toContain("docker_required=false");
    expect(job(release, "prepare_release_package").if).toBe(
      "needs.resolve_target.outputs.package_required == 'true'",
    );
    expect(job(release, "docker_e2e_release_checks").if).toBe(
      "needs.resolve_target.outputs.docker_required == 'true'",
    );
    expect(job(release, "install_smoke_release_checks").if).toBe(
      "needs.resolve_target.outputs.install_smoke_scheduled == 'true'",
    );
    expect(job(release, "qa_lab_parity_lane_release_checks").if).toBe(
      "needs.resolve_target.outputs.qa_parity_scheduled == 'true'",
    );
    expect(job(release, "qa_live_release_checks").if).toContain(
      "needs.resolve_target.outputs.qa_live_scheduled == 'true'",
    );
  });

  it.each([
    {
      group: "install-smoke",
      groups: ["install-smoke"],
      packageRequired: "false",
      dockerRequired: "false",
    },
    {
      group: "qa",
      groups: ["qa-parity", "qa-live"],
      packageRequired: "false",
      dockerRequired: "false",
    },
    {
      group: "qa-parity",
      groups: ["qa-parity"],
      packageRequired: "false",
      dockerRequired: "false",
    },
    {
      group: "qa-live",
      groups: ["qa-live"],
      packageRequired: "false",
      dockerRequired: "false",
    },
    {
      group: "cross-os",
      groups: ["cross-os"],
      packageRequired: "true",
      dockerRequired: "false",
    },
    {
      group: "package",
      groups: ["package"],
      packageRequired: "true",
      dockerRequired: "false",
    },
    {
      group: "live-e2e",
      groups: ["live-e2e"],
      packageRequired: "true",
      dockerRequired: "true",
    },
  ])(
    "maps $group to explicit release resources",
    ({ group, groups, packageRequired, dockerRequired }) => {
      const outputs = runReleaseGroupCapture(group);
      expect(JSON.parse(outputs.release_check_groups_json ?? "null")).toEqual(groups);
      expect(outputs.package_required).toBe(packageRequired);
      expect(outputs.docker_required).toBe(dockerRequired);
    },
  );

  it("expands all only to the profile-selected concrete groups", () => {
    const beta = runReleaseGroupCapture("all");
    const soak = runReleaseGroupCapture("all", true);

    expect(JSON.parse(beta.release_check_groups_json ?? "null")).toEqual([
      "install-smoke",
      "cross-os",
      "package",
      "qa-parity",
    ]);
    expect(beta.docker_required).toBe("false");
    expect(JSON.parse(soak.release_check_groups_json ?? "null")).toEqual([
      "install-smoke",
      "cross-os",
      "package",
      "qa-parity",
      "live-e2e",
      "qa-live",
    ]);
    expect(soak.docker_required).toBe("true");
  });

  it.each([
    {
      phase: "independent",
      candidateArtifactJson: "",
      installSmokeScheduled: "true",
      crossOsScheduled: "false",
      packageAcceptanceScheduled: "false",
      qaParityScheduled: "true",
      packageRequired: "false",
    },
    {
      phase: "candidate",
      candidateArtifactJson: "{}",
      installSmokeScheduled: "false",
      crossOsScheduled: "true",
      packageAcceptanceScheduled: "true",
      qaParityScheduled: "false",
      packageRequired: "true",
    },
  ])(
    "restricts phase=$phase to its owned release checks",
    ({
      phase,
      candidateArtifactJson,
      installSmokeScheduled,
      crossOsScheduled,
      packageAcceptanceScheduled,
      qaParityScheduled,
      packageRequired,
    }) => {
      const outputs = runReleaseGroupCapture("all", false, "", "", phase, candidateArtifactJson);

      expect(outputs.phase).toBe(phase);
      expect(outputs.install_smoke_scheduled).toBe(installSmokeScheduled);
      expect(outputs.cross_os_scheduled).toBe(crossOsScheduled);
      expect(outputs.package_acceptance_scheduled).toBe(packageAcceptanceScheduled);
      expect(outputs.qa_parity_scheduled).toBe(qaParityScheduled);
      expect(outputs.package_required).toBe(packageRequired);
    },
  );

  it("skips package and Docker prep for a focused repo live-E2E retry", () => {
    const outputs = runReleaseGroupCapture("live-e2e", false, " Repo-E2E,\trepo-smoke ");

    expect(JSON.parse(outputs.release_check_groups_json ?? "null")).toEqual(["live-e2e"]);
    expect(outputs.live_e2e_scheduled).toBe("true");
    expect(outputs.live_suite_filter).toBe("repo-e2e,repo-smoke");
    expect(outputs.repo_live_suite_filter).toBe("repo-e2e,repo-smoke");
    expect(outputs.package_required).toBe("false");
    expect(outputs.docker_required).toBe("false");
  });

  it.each(["\t", "   ", ",,,", " \t, , "])(
    "rejects raw nonempty live filter %j before install-smoke scheduling",
    (filter) => {
      const parent = executeParentFilterValidation("install-smoke", filter);
      const child = executeReleaseGroupCapture("install-smoke", false, filter);

      expect(parent.result.status).not.toBe(0);
      expect(parent.result.stderr).toContain(
        "live_suite_filter must contain at least one suite selector",
      );
      expect(child.result.status).not.toBe(0);
      expect(child.result.stderr).toContain(
        "live_suite_filter must contain at least one suite selector",
      );
      expect(child.outputs.install_smoke_scheduled).toBeUndefined();
    },
  );

  it.each([
    "all",
    "ci",
    "plugin-prerelease",
    "install-smoke",
    "cross-os",
    "live-e2e",
    "package",
    "qa-parity",
    "npm-telegram",
    "performance",
  ])("parent rejects a QA selector with rerun_group=%s before scheduling", (group) => {
    const { output, result } = executeParentFilterValidation(group, "qa-live-matrix");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "QA live_suite_filter selectors require rerun_group=qa or qa-live",
    );
    expect(output).toBe("");
  });

  it.each([
    "all",
    "ci",
    "plugin-prerelease",
    "install-smoke",
    "cross-os",
    "package",
    "qa-parity",
    "qa-live",
    "npm-telegram",
    "performance",
  ])("parent rejects a repo-live selector with rerun_group=%s before scheduling", (group) => {
    const { output, result } = executeParentFilterValidation(group, "repo-e2e");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "Repo live_suite_filter selectors require rerun_group=live-e2e",
    );
    expect(output).toBe("");
  });

  it.each([
    "all",
    "ci",
    "plugin-prerelease",
    "install-smoke",
    "live-e2e",
    "package",
    "qa-parity",
    "qa-live",
    "npm-telegram",
    "performance",
  ])("parent rejects a cross-OS selector with rerun_group=%s before scheduling", (group) => {
    const { output, result } = executeParentFilterValidation(group, "", "windows/packaged-upgrade");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("cross_os_suite_filter requires rerun_group=cross-os");
    expect(output).toBe("");
  });

  it.each([
    ["qa-live", "qa-live-matrix", ""],
    ["live-e2e", " Repo-E2E,\trepo-smoke ", ""],
    ["cross-os", "", " Windows/Packaged-Upgrade "],
  ])(
    "parent accepts rerun_group=%s with its owned selector",
    (group, liveSuiteFilter, crossOsSuiteFilter) => {
      const { output, result } = executeParentFilterValidation(
        group,
        liveSuiteFilter,
        crossOsSuiteFilter,
      );

      expect(result.status, result.stderr).toBe(0);
      expect(output).not.toBe("");
    },
  );

  it.each(["qa", "release-checks", "bogus", ""])(
    "parent rejects unsupported controller rerun_group=%j before scheduling",
    (group) => {
      const { output, result } = executeParentFilterValidation(group);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`controller rerun_group is invalid: ${group}.`);
      expect(output).toBe("");
    },
  );

  it.each(["\t", "   ", ",,,", " \t, , "])(
    "rejects raw nonempty live filter %j before live-E2E can widen or require prep",
    (filter) => {
      const { outputs, result } = executeReleaseGroupCapture("live-e2e", false, filter);

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("live_suite_filter must contain at least one suite selector");
      expect(outputs.live_e2e_scheduled).toBeUndefined();
      expect(outputs.package_required).toBeUndefined();
      expect(outputs.docker_required).toBeUndefined();
    },
  );

  it.each(["\t", "   ", ",,,", " \t, , "])(
    "rejects raw nonempty cross-OS filter %j before cross-OS scheduling",
    (filter) => {
      const parent = executeParentFilterValidation("cross-os", "", filter);
      const child = executeReleaseGroupCapture("cross-os", false, "", filter);

      expect(parent.result.status).not.toBe(0);
      expect(parent.result.stderr).toContain(
        "cross_os_suite_filter must contain at least one suite selector",
      );
      expect(child.result.status).not.toBe(0);
      expect(child.result.stderr).toContain(
        "cross_os_suite_filter must contain at least one suite selector",
      );
      expect(child.outputs.cross_os_scheduled).toBeUndefined();
    },
  );

  it("fails before a QA selector can collapse into an unfiltered live-E2E run", () => {
    const { outputs, result } = executeReleaseGroupCapture("live-e2e", false, "qa-live-matrix");

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain(
      "QA live_suite_filter selectors require rerun_group=qa or qa-live",
    );
    expect(outputs.repo_live_suite_filter).toBeUndefined();
    expect(outputs.live_e2e_scheduled).toBeUndefined();
  });

  it.each(["all", "install-smoke", "cross-os", "live-e2e", "package", "qa-parity"])(
    "rejects a QA selector with rerun_group=%s",
    (group) => {
      const { result } = executeReleaseGroupCapture(group, false, "qa-live-matrix");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "QA live_suite_filter selectors require rerun_group=qa or qa-live",
      );
    },
  );

  it.each(["all", "install-smoke", "cross-os", "package", "qa", "qa-parity", "qa-live"])(
    "rejects a repo-live selector with rerun_group=%s",
    (group) => {
      const { result } = executeReleaseGroupCapture(group, false, "repo-e2e");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(
        "Repo live_suite_filter selectors require rerun_group=live-e2e",
      );
    },
  );

  it.each(["all", "install-smoke", "live-e2e", "package", "qa", "qa-parity", "qa-live"])(
    "rejects a cross-OS selector with rerun_group=%s",
    (group) => {
      const { result } = executeReleaseGroupCapture(group, false, "", "windows/packaged-upgrade");

      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("cross_os_suite_filter requires rerun_group=cross-os");
    },
  );

  it.each([
    ["qa", "qa-live-matrix"],
    ["qa-live", "qa-live-matrix"],
    ["live-e2e", "repo-e2e"],
  ])("accepts rerun_group=%s with selector %s", (group, filter) => {
    const outputs = runReleaseGroupCapture(group, false, filter);
    expect(outputs.rerun_group).toBe(group);
  });

  it("accepts a cross-OS selector only for the cross-OS group", () => {
    const outputs = runReleaseGroupCapture("cross-os", false, "", "windows/packaged-upgrade");
    expect(outputs.cross_os_suite_filter).toBe("windows/packaged-upgrade");
  });

  it("builds planned live images locally without entering pull fallback", () => {
    const workflow = readWorkflow(LIVE_E2E);
    for (const jobName of [
      "validate_docker_e2e",
      "validate_docker_lanes",
      "validate_docker_openwebui",
    ]) {
      const workflowJob = workflow.jobs?.[jobName];
      const runStep = workflowJob?.steps?.find((candidate) =>
        candidate.run?.includes("test-live-build-docker.sh"),
      );

      expect(runStep?.run, jobName).toContain("OPENCLAW_SKIP_DOCKER_BUILD=0");
      expect(runStep?.run, jobName).not.toContain("OPENCLAW_DOCKER_BUILD_ON_MISSING=1");
    }
  });

  it.each([
    {
      producerName: "prepare_docker_e2e_image",
      readyName: "docker_e2e_image_ready",
      packStep: "Pack Docker E2E image artifact",
      artifactDirectory: "docker-e2e-shared-images",
      image: "openclaw-docker-e2e-bare:test",
      consumers: ["validate_docker_e2e", "validate_docker_lanes", "validate_docker_openwebui"],
    },
    {
      producerName: "prepare_live_test_image",
      readyName: "live_test_image_ready",
      packStep: "Pack live-test image artifact",
      artifactDirectory: "live-test-shared-image",
      image: "openclaw-live-test:test",
      consumers: [
        "validate_live_models_docker",
        "validate_live_models_docker_targeted",
        "validate_live_docker_provider_suites",
      ],
    },
  ])("$producerName owns failed image preparation without another runner", (fixture) => {
    const workflow = readWorkflow(LIVE_E2E);
    const producer = job(workflow, fixture.producerName);
    const pack = step(producer, fixture.packStep);
    const root = tempDirs.make("release-image-producer-failure-");
    const bin = join(root, "bin");
    const calls = join(root, "docker.log");
    const output = join(root, "github-output");
    mkdirSync(bin);
    symlinkSync(resolve("."), join(root, ".release-harness"), "dir");
    writeFileSync(
      join(bin, "docker"),
      '#!/usr/bin/env bash\nprintf "%s\\n" "$*" >> "$DOCKER_CALLS"\nprintf "invalid-config-digest\\n"\n',
    );
    chmodSync(join(bin, "docker"), 0o755);

    // Run the checked-in pack step and artifact owner; only an invalid external Docker image ID is injected.
    const result = spawnSync("bash", ["-c", pack.run ?? ""], {
      cwd: root,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH ?? ""}`,
        DOCKER_CALLS: calls,
        GITHUB_OUTPUT: output,
        GITHUB_RUN_ID: "123",
        GITHUB_RUN_ATTEMPT: "1",
        RUNNER_TEMP: root,
        BARE_IMAGE: fixture.image,
        FUNCTIONAL_IMAGE: "openclaw-docker-e2e-functional:test",
        LIVE_IMAGE: fixture.image,
        NEEDS_BARE_IMAGE: "1",
        NEEDS_FUNCTIONAL_IMAGE: "1",
        PACKAGE_SHA256: "c".repeat(64),
        SHARED_IMAGE_ARTIFACT_NAMESPACE: "test",
        TARGET_SHA: "a".repeat(40),
        WORKFLOW_SHA: "b".repeat(40),
      },
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`image has an invalid config digest: ${fixture.image}`);
    expect(readFileSync(calls, "utf8")).toBe(`image inspect --format {{.Id}} ${fixture.image}\n`);
    expect(existsSync(output)).toBe(false);
    expect(existsSync(join(root, fixture.artifactDirectory))).toBe(false);
    expect(producer["continue-on-error"]).toBeUndefined();
    expect(workflow.jobs?.[fixture.readyName]).toBeUndefined();
    for (const consumerName of fixture.consumers) {
      const consumer = job(workflow, consumerName);
      expect(consumer.needs, consumerName).toContain(fixture.producerName);
      expect(consumer.needs, consumerName).not.toContain(fixture.readyName);
      // Preserve GitHub's implicit success gate instead of admitting failed or cancelled prerequisites.
      expect(consumer.if, consumerName).not.toMatch(/\b(?:always|failure|cancelled|success)\s*\(/u);
    }
  });

  it("keeps every local reusable-workflow permission request within its caller ceiling", () => {
    const readOnlyCalls = [
      [FULL_RELEASE, "candidate_acquisition"],
      [PLUGIN_PRERELEASE, "plugin-prerelease-docker-suite"],
      [RELEASE_CHECKS, "live_repo_e2e_release_checks"],
      [RELEASE_CHECKS, "docker_e2e_release_checks"],
      [RELEASE_CHECKS, "package_acceptance_release_checks"],
      [RELEASE_CHECKS, "install_smoke_release_checks"],
      [PACKAGE_ACCEPTANCE, "docker_acceptance"],
      [PACKAGE_ACCEPTANCE, "docker_acceptance_registry"],
      [INSTALL_SMOKE, "install_smoke"],
      [SCHEDULED_LIVE, "live_and_openwebui_checks"],
      [UPDATE_MIGRATION, "update_migration"],
    ] as const;
    for (const [workflowPath, jobName] of readOnlyCalls) {
      const callerWorkflow = readWorkflow(workflowPath);
      const caller = job(callerWorkflow, jobName);
      const callerPermissions = caller.permissions ?? callerWorkflow.permissions;
      expect(
        permissionAt(callerPermissions, "packages", "none"),
        `${workflowPath}:${jobName}`,
      ).toBe("read");
      expect(
        reusablePermissionViolations(workflowPath, jobName),
        `${workflowPath}:${jobName}`,
      ).toEqual([]);
    }
  });

  it("models conditional reusable jobs as permission requests before scheduling", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-permission-graph-"));
    const fixture = join(root, "callee.yml");
    try {
      writeFileSync(
        fixture,
        `permissions:\n  packages: read\njobs:\n  safe:\n    runs-on: ubuntu-latest\n  skippedWriter:\n    if: false\n    runs-on: ubuntu-latest\n    permissions:\n      packages: write\n`,
      );
      const violations = workflowPermissionViolations(
        fixture,
        { actions: "none", contents: "none", packages: "read", "pull-requests": "none" },
        "fixture:caller",
        new Set(),
      );
      expect(violations).toEqual([
        `fixture:caller -> ${fixture}:skippedWriter requests packages:write above caller packages:read`,
      ]);
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("does not persist Git credentials in validation checkouts", () => {
    for (const workflowPath of [PLUGIN_PRERELEASE, RELEASE_CHECKS]) {
      const workflow = readWorkflow(workflowPath);
      const checkoutSteps = Object.values(workflow.jobs ?? {}).flatMap(
        (workflowJob) =>
          workflowJob.steps?.filter((candidate) =>
            candidate.uses?.startsWith("actions/checkout@"),
          ) ?? [],
      );
      expect(checkoutSteps, workflowPath).not.toHaveLength(0);
      for (const checkout of checkoutSteps) {
        expect(checkout.with?.["persist-credentials"], `${workflowPath}:${checkout.name}`).toBe(
          false,
        );
      }
    }
  });

  it("runs evidence reuse from an immutable trusted-main workflow checkout", () => {
    const full = readWorkflow(FULL_RELEASE);
    for (const jobName of ["resolve_target", "evidence_reuse"]) {
      const checkout = step(job(full, jobName), "Checkout trusted workflow helper");
      expect(checkout.with?.ref, jobName).toBe("${{ github.sha }}");
      expect(checkout.with?.ref, jobName).not.toBe("${{ github.ref_name }}");
      expect(checkout.with?.["persist-credentials"], jobName).toBe(false);
    }

    const evidenceReuse = job(full, "evidence_reuse");
    expect(step(evidenceReuse, "Checkout target SHA").with?.["persist-credentials"]).toBe(false);
    const dockerAssets = job(full, "docker_runtime_assets_preflight");
    expect(step(dockerAssets, "Checkout target SHA").with?.["persist-credentials"]).toBe(false);
    expect(evidenceReuse.if).toContain("github.ref == 'refs/heads/main'");
    expect(evidenceReuse.if).toContain("startsWith(github.ref, 'refs/heads/release-ci/')");
    expect(
      evidenceReuse.steps?.find(
        (candidate) => candidate.name === "Require trusted main workflow ref",
      ),
    ).toBeUndefined();

    const releaseChecks = readWorkflow(RELEASE_CHECKS);
    const releaseHelper = step(
      job(releaseChecks, "resolve_target"),
      "Checkout trusted workflow helper",
    );
    expect(releaseHelper.with?.ref).toBe("${{ github.sha }}");
    expect(releaseHelper.with?.ref).not.toBe("${{ github.ref_name }}");
    expect(releaseHelper.with?.["persist-credentials"]).toBe(false);
  });

  it("records exact adopted child identity without monitoring or cancellation", () => {
    const full = readWorkflow(FULL_RELEASE);
    for (const [jobName, stepName] of [
      ["normal_ci", "Dispatch CI"],
      ["plugin_prerelease_independent", "Dispatch plugin prerelease independent phase"],
      ["plugin_prerelease_candidate", "Dispatch plugin prerelease candidate phase"],
      ["release_checks_independent", "Dispatch release checks independent phase"],
      ["release_checks_candidate", "Dispatch release checks candidate phase"],
      ["npm_telegram", "Dispatch npm Telegram E2E"],
      ["performance", "Dispatch OpenClaw Performance"],
    ] as const) {
      const dispatch = step(job(full, jobName), stepName);
      const dispatchRun = dispatch.run ?? "";
      expect(dispatch.env?.PARENT_WORKFLOW_SHA, jobName).toBe("${{ github.sha }}");
      expect(dispatchRun, jobName).toContain(
        'if [[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]; then',
      );
      expect(dispatchRun.match(/\.head_sha == \$head_sha/gu), jobName).toBeNull();
      expect(dispatchRun, jobName).toContain('run_json="$(validate_child_run "$run_id")"');
      expect(dispatchRun, jobName).not.toContain("trap cancel_child");
      expect(dispatchRun, jobName).not.toContain("cancel_child_on_failure");
      expect(dispatchRun, jobName).not.toContain("exit_on_parent_signal");
      expect(dispatchRun, jobName).not.toContain("disable_child_cleanup");
      expect(dispatchRun, jobName).not.toContain("poll_count=0");
      expect(dispatchRun, jobName).not.toContain("cancel_child");
      expect(
        dispatchRun.indexOf('run_json="$(validate_child_run "$run_id")"'),
        jobName,
      ).toBeLessThan(dispatchRun.indexOf('echo "run_id=${run_id}" >> "$GITHUB_OUTPUT"'));
      expect(
        dispatchRun.indexOf('run_json="$(validate_child_run "$run_id")"'),
        jobName,
      ).toBeLessThan(dispatchRun.indexOf('if [[ "$child_head_sha" != "$PARENT_WORKFLOW_SHA" ]]'));
    }
  });

  it("keeps the Release SHA wrapper as the durable evidence identity", () => {
    const full = readWorkflow(FULL_RELEASE);
    const verify = step(job(full, "summary"), "Verify exact release state artifacts");
    const dispatch = step(job(full, "summary"), "Request release evidence update");

    expect(verify.run).toBe("node scripts/full-release-validation-state.mjs verify");
    expect(dispatch.run).not.toContain('GITHUB_RUN_ID_VALUE="$EVIDENCE_ROOT_RUN_ID"');
    expect(dispatch.run).toContain("reused green product evidence from chain-root run");
    expect(dispatch.run).toContain("--connect-timeout 10");
    expect(dispatch.run).toContain("--max-time 30");
    expect(dispatch.run).toContain("https://api.github.com/repos/openclaw/releases/dispatches");
  });

  it("publishes an attempt-qualified canonical manifest plus a temporary legacy alias", () => {
    const summary = job(readWorkflow(FULL_RELEASE), "summary");
    expect(step(summary, "Upload release validation manifest").with).toMatchObject({
      name: "full-release-validation-${{ github.run_id }}-${{ github.run_attempt }}",
    });
    expect(step(summary, "Upload legacy release validation manifest alias").with).toMatchObject({
      name: "full-release-validation-${{ github.run_id }}",
      overwrite: true,
    });
  });

  it("pins every Full Release Docker caller to artifact-only transport", () => {
    const fullText = readFileSync(FULL_RELEASE, "utf8");
    const release = readWorkflow(RELEASE_CHECKS);
    const packageAcceptance = readWorkflow(PACKAGE_ACCEPTANCE);
    const pluginPrerelease = readWorkflow(PLUGIN_PRERELEASE);

    expect(fullText).toContain("dispatch_child plugin-prerelease.yml");
    expect(fullText).toContain("dispatch_child openclaw-release-checks.yml");
    expect(fullText).toContain("dispatch_child openclaw-performance.yml");
    expect(fullText).toContain('gh workflow run "$workflow" --ref "$CHILD_WORKFLOW_REF" "$@"');

    const preparePackage = job(release, "prepare_release_package");
    const live = job(release, "live_repo_e2e_release_checks");
    const docker = job(release, "docker_e2e_release_checks");
    const acceptance = job(release, "package_acceptance_release_checks");
    expectReadOnlyPackagePermission(preparePackage);
    expectReadOnlyPackagePermission(live);
    expectReadOnlyPackagePermission(docker);
    expectReadOnlyPackagePermission(acceptance);
    expect(step(preparePackage, "Resolve release package artifact").run).toContain(
      'if [[ "$source_sha" != "$PACKAGE_REF" ]]',
    );
    expect(live.with).toMatchObject({
      allow_unreleased_changelog:
        "${{ needs.resolve_target.outputs.allow_unreleased_changelog == 'true' }}",
      shared_image_artifact_namespace: "release-live",
      shared_image_policy: "no-push-artifact",
    });
    expect(docker.with).toMatchObject({
      allow_unreleased_changelog:
        "${{ needs.resolve_target.outputs.allow_unreleased_changelog == 'true' }}",
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
      shared_image_artifact_namespace: "release-docker",
      shared_image_policy: "no-push-artifact",
    });
    expect(acceptance.with).toMatchObject({
      artifact_digest: "${{ needs.prepare_release_package.outputs.artifact_digest }}",
      artifact_id: "${{ needs.prepare_release_package.outputs.artifact_id }}",
      artifact_name: "${{ needs.prepare_release_package.outputs.artifact_name }}",
      artifact_run_attempt: "${{ needs.prepare_release_package.outputs.artifact_run_attempt }}",
      artifact_run_id: "${{ needs.prepare_release_package.outputs.artifact_run_id }}",
      package_file_name: "${{ needs.prepare_release_package.outputs.package_file_name }}",
      package_source_sha: "${{ needs.prepare_release_package.outputs.source_sha }}",
      package_version: "${{ needs.prepare_release_package.outputs.package_version }}",
      shared_image_artifact_namespace: "release-package",
      shared_image_policy: "no-push-artifact",
    });

    const standardAcceptance = job(packageAcceptance, "docker_acceptance");
    const registryAcceptance = job(packageAcceptance, "docker_acceptance_registry");
    expect(permissionAt(packageAcceptance.permissions, "packages", "none")).toBe("read");
    expect(packageAcceptance.on?.workflow_dispatch?.inputs?.shared_image_policy).toMatchObject({
      default: "no-push-artifact",
      options: ["existing-only", "no-push-artifact"],
      type: "choice",
    });
    expect(packageAcceptance.on?.workflow_call?.inputs?.shared_image_policy).toMatchObject({
      default: "no-push-artifact",
      type: "string",
    });
    expect(standardAcceptance.with?.shared_image_policy).toBe("${{ inputs.shared_image_policy }}");
    expect(standardAcceptance.with?.shared_image_artifact_namespace).toBe(
      "${{ inputs.shared_image_artifact_namespace }}",
    );
    expect(standardAcceptance.with).toMatchObject({
      package_artifact_digest: "${{ needs.resolve_package.outputs.package_artifact_digest }}",
      package_artifact_id: "${{ needs.resolve_package.outputs.package_artifact_id }}",
      package_artifact_run_attempt:
        "${{ needs.resolve_package.outputs.package_artifact_run_attempt }}",
      package_artifact_run_id: "${{ needs.resolve_package.outputs.package_artifact_run_id }}",
      package_file_name: "${{ needs.resolve_package.outputs.package_file_name }}",
      package_sha256: "${{ needs.resolve_package.outputs.package_sha256 }}",
      package_source_sha: "${{ needs.resolve_package.outputs.package_source_sha }}",
      package_version: "${{ needs.resolve_package.outputs.package_version }}",
    });
    expect(standardAcceptance.with).not.toHaveProperty("allow_unreleased_changelog");
    expect(registryAcceptance.with).not.toHaveProperty("allow_unreleased_changelog");
    expect(standardAcceptance.if).toContain("shared_image_policy == 'no-push-artifact'");
    expectReadOnlyPackagePermission(standardAcceptance);
    expect(registryAcceptance.if).toContain("shared_image_policy == 'existing-only'");
    expectReadOnlyPackagePermission(registryAcceptance);

    const pluginDocker = job(pluginPrerelease, "plugin-prerelease-docker-suite");
    expectReadOnlyPackagePermission(pluginDocker);
    expect(pluginDocker.with).toMatchObject({
      shared_image_artifact_namespace: "plugin-prerelease",
      shared_image_policy: "no-push-artifact",
    });
    expect(
      new Set([
        live.with?.shared_image_artifact_namespace,
        docker.with?.shared_image_artifact_namespace,
        acceptance.with?.shared_image_artifact_namespace,
        pluginDocker.with?.shared_image_artifact_namespace,
      ]).size,
    ).toBe(4);
  });

  it("builds shared images locally, verifies artifacts, and cannot fall back to a registry", () => {
    const workflow = readWorkflow(LIVE_E2E);
    const dispatchPolicy = workflow.on?.workflow_dispatch?.inputs?.shared_image_policy;
    const callPolicy = workflow.on?.workflow_call?.inputs?.shared_image_policy;
    expect(dispatchPolicy).toMatchObject({
      default: "no-push-artifact",
      options: ["existing-only", "no-push-artifact"],
    });
    expect(callPolicy).toMatchObject({ default: "no-push-artifact", type: "string" });

    const validation = job(workflow, "validate_selected_ref");
    expect(validation.outputs?.workflow_repository).toBe(
      "${{ steps.workflow.outputs.workflow_repository }}",
    );
    expect(validation.outputs?.workflow_sha).toBe("${{ steps.workflow.outputs.workflow_sha }}");
    const workflowIdentity = step(validation, "Resolve job workflow identity");
    expect(workflowIdentity.env?.JOB_CONTEXT).toBe("${{ toJSON(job) }}");
    expect(workflowIdentity.run).toContain(
      "job.workflow_repository must be an owner/repository slug",
    );
    expect(workflowIdentity.run).toContain("job.workflow_sha must be a full lowercase commit SHA");
    const trustedCheckouts = Object.entries(workflow.jobs ?? {}).flatMap(([jobName, workflowJob]) =>
      (workflowJob.steps ?? [])
        .filter((candidate) => candidate.name?.startsWith("Checkout trusted "))
        .map((candidate) => ({ candidate, jobName })),
    );
    expect(trustedCheckouts).toHaveLength(13);
    const binderCheckout = trustedCheckouts.find(
      ({ jobName }) => jobName === "bind_full_release_candidate_evidence",
    );
    expect(binderCheckout?.candidate.with).toMatchObject({
      repository: "openclaw/openclaw",
      ref: "main",
      "persist-credentials": false,
    });
    const exactRevisionCheckouts = trustedCheckouts.filter(
      ({ jobName }) => jobName !== "bind_full_release_candidate_evidence",
    );
    expect(exactRevisionCheckouts).toHaveLength(12);
    for (const { candidate, jobName } of exactRevisionCheckouts) {
      expect(candidate.with, jobName).toMatchObject({
        repository: "${{ needs.validate_selected_ref.outputs.workflow_repository }}",
        ref: "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
        "persist-credentials": false,
      });
    }

    const dockerProducer = job(workflow, "prepare_docker_e2e_image");
    const liveProducer = job(workflow, "prepare_live_test_image");
    const liveProducerSteps = liveProducer.steps ?? [];
    const liveBuildIndex = liveProducerSteps.findIndex(
      (candidate) => candidate.name === "Build shared live-test image",
    );
    const trustedHarnessIndex = liveProducerSteps.findIndex(
      (candidate) => candidate.name === "Checkout trusted release harness",
    );
    const livePackIndex = liveProducerSteps.findIndex(
      (candidate) => candidate.name === "Pack live-test image artifact",
    );
    expect(liveBuildIndex).toBeGreaterThanOrEqual(0);
    expect(trustedHarnessIndex).toBeGreaterThan(liveBuildIndex);
    expect(livePackIndex).toBeGreaterThan(trustedHarnessIndex);
    expect(permissionAt(workflow.permissions, "actions", "none")).toBe("read");
    expect(permissionAt(workflow.permissions, "packages", "none")).toBe("read");
    expectReadOnlyPackagePermission(dockerProducer);
    expectReadOnlyPackagePermission(liveProducer);
    expect(workflow.jobs?.push_docker_e2e_images).toBeUndefined();
    expect(workflow.jobs?.push_live_test_image).toBeUndefined();
    const packageWriters = Object.entries(workflow.jobs ?? {}).filter(
      ([, workflowJob]) => permissionAt(workflowJob.permissions, "packages", "none") === "write",
    );
    expect(packageWriters).toEqual([]);
    expect(workflow.on?.workflow_call?.outputs?.publication_manifest).toBeUndefined();
    expect(workflow.jobs?.collect_shared_image_publication).toBeUndefined();
    const validateSelectedRef = step(
      job(workflow, "validate_selected_ref"),
      "Validate selected ref",
    );
    const dispatchInputs = workflow.on?.workflow_dispatch?.inputs ?? {};
    for (const inputName of [
      "package_artifact_digest",
      "package_artifact_id",
      "package_artifact_name",
      "package_artifact_run_attempt",
      "package_artifact_run_id",
      "package_file_name",
      "package_sha256",
      "package_source_sha",
      "package_version",
    ]) {
      expect(dispatchInputs[inputName], inputName).toBeUndefined();
      expect(workflow.on?.workflow_call?.inputs?.[inputName], inputName).toBeDefined();
    }
    expect(validateSelectedRef.env?.PACKAGE_ARTIFACT_DIGEST).toBe(
      "${{ inputs.package_artifact_digest }}",
    );
    expect(validateSelectedRef.env?.PACKAGE_ARTIFACT_RUN_ATTEMPT).toBe(
      "${{ inputs.package_artifact_run_attempt }}",
    );
    expect(validateSelectedRef.env?.PACKAGE_ARTIFACT_RUN_ID).toBe(
      "${{ inputs.package_artifact_run_id }}",
    );
    expect(validateSelectedRef.env?.PACKAGE_ARTIFACT_ID).toBe("${{ inputs.package_artifact_id }}");
    expect(validateSelectedRef.env?.PACKAGE_FILE_NAME).toBe("${{ inputs.package_file_name }}");
    expect(validateSelectedRef.env?.PACKAGE_SOURCE_SHA).toBe("${{ inputs.package_source_sha }}");
    expect(validateSelectedRef.run).toContain(
      "Package artifact selection requires the complete immutable artifact and package identity tuple.",
    );
    expect(validateSelectedRef.run).toContain('"$PACKAGE_SOURCE_SHA" == "$selected_sha"');
    for (const name of [
      "prepare_docker_e2e_image",
      "prepare_live_test_image",
      "validate_live_models_docker",
      "validate_live_models_docker_targeted",
      "validate_live_docker_provider_suites",
    ]) {
      const checkoutSteps = job(workflow, name).steps?.filter((candidate) =>
        candidate.uses?.startsWith("actions/checkout@"),
      );
      expect(checkoutSteps, name).not.toHaveLength(0);
      for (const checkout of checkoutSteps ?? []) {
        expect(checkout.with?.["persist-credentials"], `${name}:${checkout.name}`).toBe(false);
      }
    }
    expect(dockerProducer.outputs?.image_artifact_name).toContain("image_artifact");
    expect(liveProducer.outputs?.image_artifact_name).toContain("image_artifact");
    for (const producer of [dockerProducer, liveProducer]) {
      expect(producer.outputs?.image_archive_sha256).toContain("archive_sha256");
      expect(producer.outputs?.image_artifact_id).toContain("artifact-id");
      expect(producer.outputs?.image_artifact_digest).toContain("artifact-digest");
    }
    expect(dockerProducer.outputs?.image_artifact_run_id).toContain("github.run_id");
    expect(dockerProducer.outputs?.image_artifact_run_id).toContain(
      "inputs.shared_image_artifact_run_id",
    );
    expect(dockerProducer.outputs?.image_artifact_run_attempt).toContain("github.run_attempt");
    expect(dockerProducer.outputs?.image_artifact_run_attempt).toContain(
      "inputs.shared_image_artifact_run_attempt",
    );
    expect(liveProducer.outputs?.image_artifact_run_id).toBe("${{ github.run_id }}");
    expect(liveProducer.outputs?.image_artifact_run_attempt).toBe("${{ github.run_attempt }}");
    expect(dockerProducer.outputs?.package_artifact_id).toContain("artifact-id");
    expect(dockerProducer.outputs?.package_artifact_digest).toContain("artifact-digest");
    expect(dockerProducer.outputs?.package_artifact_run_attempt).toContain("run_attempt");
    expect(dockerProducer.outputs?.package_artifact_run_id).toContain("run_id");
    expect(dockerProducer.outputs?.package_file_name).toContain("file_name");
    expect(dockerProducer.outputs?.package_source_sha).toContain("source_sha");

    const packageIdentity = step(dockerProducer, "Validate OpenClaw package artifact identity");
    expect(packageIdentity.env).toMatchObject({
      ARTIFACT_DIGEST: "${{ inputs.package_artifact_digest }}",
      ARTIFACT_ID: "${{ inputs.package_artifact_id }}",
      ARTIFACT_NAME: "${{ inputs.package_artifact_name }}",
      ARTIFACT_RUN_ATTEMPT: "${{ inputs.package_artifact_run_attempt }}",
      ARTIFACT_RUN_ID: "${{ inputs.package_artifact_run_id }}",
    });
    expect(packageIdentity.run).toContain('--arg digest "sha256:${ARTIFACT_DIGEST}"');
    expect(packageIdentity.run).toContain(
      "actions/runs/${ARTIFACT_RUN_ID}/attempts/${ARTIFACT_RUN_ATTEMPT}",
    );
    expect(packageIdentity.run).toContain("artifact_digest=$ARTIFACT_DIGEST");
    for (const [name, condition] of [
      [
        "Download current-run OpenClaw Docker E2E package",
        "inputs.package_artifact_run_id == github.run_id",
      ],
      [
        "Download previous-run OpenClaw Docker E2E package",
        "inputs.package_artifact_run_id != github.run_id",
      ],
    ] as const) {
      const packageDownload = step(dockerProducer, name);
      expect(packageDownload.if).toContain(condition);
      expect(packageDownload.with).toMatchObject({
        "artifact-ids": "${{ inputs.package_artifact_id }}",
        "github-token": "${{ github.token }}",
        "run-id": "${{ inputs.package_artifact_run_id }}",
      });
    }

    for (const name of [
      "Build bare Docker E2E image artifact",
      "Build functional Docker E2E image artifact",
    ]) {
      const build = step(dockerProducer, name);
      expect(build.if).toContain("shared_image_policy == 'no-push-artifact'");
      expect(build.run).not.toContain("--push");
      expect(build.run).not.toContain("--sbom=true");
      expect(build.run).not.toContain("--provenance=mode=max");
    }
    const bareBuild = step(dockerProducer, "Build bare Docker E2E image artifact");
    expect(bareBuild.run).toContain("docker build");
    expect(bareBuild.run).toContain("--target bare");
    expect(bareBuild.run).toContain('--tag "$IMAGE_REF"');
    const functionalBuild = step(dockerProducer, "Build functional Docker E2E image artifact");
    expect(functionalBuild.run).toContain("docker build");
    expect(functionalBuild.run).toContain("--target functional");
    expect(functionalBuild.run).toContain(
      "--build-context openclaw_package=.artifacts/docker-e2e-package",
    );
    expect(functionalBuild.run).toContain('--tag "$IMAGE_REF"');
    const packDockerArtifact = step(dockerProducer, "Pack Docker E2E image artifact");
    expect(packDockerArtifact.env?.PACKAGE_SHA256).toBe("${{ steps.package.outputs.sha256 }}");
    expect(packDockerArtifact.run).toContain("shared-image-artifact.sh");
    expect(packDockerArtifact.run).toContain(
      "docker-e2e-shared-images-${SHARED_IMAGE_ARTIFACT_NAMESPACE}-${TARGET_SHA:0:12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
    );
    expect(packDockerArtifact.run).toContain(
      'OPENCLAW_SHARED_IMAGE_PACKAGE_SHA256="$PACKAGE_SHA256"',
    );
    expect(packDockerArtifact.run).toContain("archive_sha256=");
    const validatePackage = step(dockerProducer, "Validate OpenClaw Docker E2E package");
    expect(step(dockerProducer, "Setup trusted release harness")).toMatchObject({
      uses: "./.release-harness/.github/actions/setup-release-harness",
      with: { "node-version": "${{ env.NODE_VERSION }}" },
    });
    expect(step(dockerProducer, "Setup trusted release harness").if).toBeUndefined();
    expect(validatePackage.env).toMatchObject({
      EXPECTED_PACKAGE_FILE_NAME:
        "${{ needs.validate_selected_ref.outputs.package_artifact_present == 'true' && inputs.package_file_name || '' }}",
      EXPECTED_PACKAGE_SHA256:
        "${{ needs.validate_selected_ref.outputs.package_artifact_present == 'true' && inputs.package_sha256 || '' }}",
      EXPECTED_PACKAGE_SOURCE_SHA:
        "${{ needs.validate_selected_ref.outputs.package_artifact_present == 'true' && inputs.package_source_sha || '' }}",
      EXPECTED_PACKAGE_VERSION:
        "${{ needs.validate_selected_ref.outputs.package_artifact_present == 'true' && inputs.package_version || '' }}",
    });
    expect(validatePackage.run).toContain('"$SHARED_IMAGE_POLICY" == "no-push-artifact"');
    expect(validatePackage.run).toContain(
      "Resolved package identity differs from the declared immutable tuple.",
    );
    expect(validatePackage.run).toContain("package/dist/build-info.json");
    expect(validatePackage.run).toContain('[[ "$package_source_sha" == "$SELECTED_SHA" ]]');
    expect(validatePackage.run).toContain("scripts/check-openclaw-package-tarball.mjs");
    expect(validatePackage.run).toContain(
      "cd .release-harness && pnpm exec node scripts/check-openclaw-package-tarball.mjs",
    );
    expect(validatePackage.run).toContain('"$GITHUB_WORKSPACE/$target"');
    expect(validatePackage.run).not.toContain("pnpm --dir .release-harness");
    const targetedRun = step(
      job(workflow, "validate_docker_lanes"),
      "Run targeted Docker E2E lanes",
    );
    expect(targetedRun.env).toMatchObject({
      ARTIFACT_SUFFIX: "${{ steps.plan.outputs.artifact_suffix }}",
      INCLUDE_RELEASE_PATH_SUITES: "${{ inputs.include_release_path_suites }}",
    });
    expect(targetedRun.run).toContain('if [[ "$INCLUDE_RELEASE_PATH_SUITES" == "true" ]]');
    expect(targetedRun.run).not.toContain("${{ inputs.");
    for (const workflowJob of Object.values(workflow.jobs ?? {})) {
      for (const workflowStep of workflowJob.steps ?? []) {
        for (const inputName of ["shared_image_policy", "package_sha256", "package_version"]) {
          expect(workflowStep.run ?? "", `${workflowStep.name}:${inputName}`).not.toContain(
            `\${{ inputs.${inputName} }}`,
          );
        }
      }
    }
    expect(readFileSync(LIVE_E2E, "utf8")).not.toContain("fromJSON(toJSON(job)).workflow_");
    expect(readFileSync(LIVE_E2E, "utf8")).not.toContain("${{ github.workflow_sha }}");
    const artifactPackAndLoadSteps = Object.values(workflow.jobs ?? {}).flatMap((workflowJob) =>
      (workflowJob.steps ?? []).filter((candidate) => candidate.env?.WORKFLOW_SHA !== undefined),
    );
    expect(artifactPackAndLoadSteps).toHaveLength(8);
    for (const artifactStep of artifactPackAndLoadSteps) {
      expect(artifactStep.env?.WORKFLOW_SHA, artifactStep.name).toBe(
        "${{ needs.validate_selected_ref.outputs.workflow_sha }}",
      );
    }
    expect(step(dockerProducer, "Upload Docker E2E image artifact")).toMatchObject({
      id: "upload_image_artifact",
      if: "inputs.shared_image_policy == 'no-push-artifact' && steps.plan.outputs.needs_e2e_image == '1' && inputs.shared_image_artifact_id == ''",
      with: { "if-no-files-found": "error" },
    });
    expect(step(liveProducer, "Pack live-test image artifact").run).toContain(
      "shared-image-artifact.sh",
    );
    expect(step(liveProducer, "Pack live-test image artifact").run).toContain(
      "live-test-shared-image-${SHARED_IMAGE_ARTIFACT_NAMESPACE}-${TARGET_SHA:0:12}-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
    );
    expect(step(liveProducer, "Upload live-test image artifact")).toMatchObject({
      id: "upload_image_artifact",
      if: "inputs.shared_image_policy == 'no-push-artifact'",
      with: { "if-no-files-found": "error" },
    });
    expect(step(liveProducer, "Build shared live-test image").with).toMatchObject({
      load: true,
      provenance: false,
      push: false,
      sbom: false,
    });
    const dockerLoginCondition = step(dockerProducer, "Log in to GHCR").if;
    expect(dockerLoginCondition).toContain("shared_image_policy == 'existing-only'");
    expect(dockerLoginCondition).not.toContain("allow-push");
    expect(step(liveProducer, "Log in to GHCR").if).toContain(
      "shared_image_policy != 'no-push-artifact'",
    );
    expect(step(dockerProducer, "Check existing shared Docker E2E images").if).toContain(
      "shared_image_policy == 'existing-only'",
    );
    expect(step(liveProducer, "Check existing shared live-test image").if).toContain(
      "shared_image_policy != 'no-push-artifact'",
    );

    const shellPushSteps = Object.entries(workflow.jobs ?? {}).flatMap(([jobName, workflowJob]) =>
      (workflowJob.steps ?? [])
        .filter((candidate) => candidate.run?.includes("--push"))
        .map((candidate) => ({ candidate, jobName })),
    );
    expect(shellPushSteps).toEqual([]);

    for (const name of [
      "validate_docker_e2e",
      "validate_docker_lanes",
      "validate_docker_openwebui",
    ]) {
      const consumer = job(workflow, name);
      expect(consumer.needs).toContain("prepare_docker_e2e_image");
      expect(consumer.env?.OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE).toContain("no-push-artifact");
      expect(step(consumer, "Download OpenClaw Docker E2E package").with).toMatchObject({
        "artifact-ids": "${{ needs.prepare_docker_e2e_image.outputs.package_artifact_id }}",
        "github-token": "${{ github.token }}",
        "run-id": "${{ needs.prepare_docker_e2e_image.outputs.package_artifact_run_id }}",
      });
      const binding = step(consumer, "Validate Docker E2E image artifact binding");
      expect(binding.if).toContain("shared_image_policy == 'no-push-artifact'");
      expect(binding.env).toMatchObject({
        ARTIFACT_DIGEST: "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_digest }}",
        ARTIFACT_ID: "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_id }}",
        ARTIFACT_NAME: "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_name }}",
        ARTIFACT_RUN_ATTEMPT:
          "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_run_attempt }}",
        ARTIFACT_RUN_ID: "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_run_id }}",
        GH_TOKEN: "${{ github.token }}",
      });
      expect(binding.run).toContain('verify-upload "Docker E2E image"');
      expect(binding.run).toContain('"$ARTIFACT_ID" "$ARTIFACT_NAME" "$ARTIFACT_DIGEST"');
      expect(binding.run).toContain('"$ARTIFACT_RUN_ID" "$ARTIFACT_RUN_ATTEMPT"');
      const download = step(consumer, "Download Docker E2E image artifact");
      expect(download.if).toContain("shared_image_policy == 'no-push-artifact'");
      expect(download.with).toMatchObject({
        "artifact-ids": "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_id }}",
        "github-token": "${{ github.token }}",
        "run-id": "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_run_id }}",
      });
      expect(consumer.steps?.indexOf(binding) ?? -1).toBeLessThan(
        consumer.steps?.indexOf(download) ?? -1,
      );
      const loadArtifact = step(consumer, "Verify and load Docker E2E image artifact");
      expect(loadArtifact.env?.ARCHIVE_SHA256).toBe(
        "${{ needs.prepare_docker_e2e_image.outputs.image_archive_sha256 }}",
      );
      expect(loadArtifact.env?.PACKAGE_SHA256).toBe(
        "${{ needs.prepare_docker_e2e_image.outputs.package_sha256 }}",
      );
      expect(loadArtifact.env?.OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT).toBe(
        "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_run_attempt }}",
      );
      expect(loadArtifact.env?.OPENCLAW_SHARED_IMAGE_RUN_ID).toBe(
        "${{ needs.prepare_docker_e2e_image.outputs.image_artifact_run_id }}",
      );
      expect(loadArtifact.run).toContain("shared-image-artifact.sh");
      expect(loadArtifact.run).toContain('OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256="$ARCHIVE_SHA256"');
      expect(loadArtifact.run).toContain('OPENCLAW_SHARED_IMAGE_PACKAGE_SHA256="$PACKAGE_SHA256"');
      expect(step(consumer, "Log in to GHCR for shared Docker E2E image").if).toContain(
        "shared_image_policy != 'no-push-artifact'",
      );
      for (const pullName of [
        "Pull shared bare Docker E2E image",
        "Pull shared functional Docker E2E image",
      ]) {
        expect(step(consumer, pullName).if).toContain("shared_image_policy != 'no-push-artifact'");
      }
    }

    for (const name of [
      "validate_live_models_docker",
      "validate_live_models_docker_targeted",
      "validate_live_docker_provider_suites",
    ]) {
      const consumer = job(workflow, name);
      expect(consumer.needs).toContain("prepare_live_test_image");
      expect(consumer.env?.OPENCLAW_LIVE_REQUIRE_LOCAL_IMAGE).toContain("no-push-artifact");
      const binding = step(consumer, "Validate live-test image artifact binding");
      expect(binding.if).toContain("shared_image_policy == 'no-push-artifact'");
      expect(binding.env).toMatchObject({
        ARTIFACT_DIGEST: "${{ needs.prepare_live_test_image.outputs.image_artifact_digest }}",
        ARTIFACT_ID: "${{ needs.prepare_live_test_image.outputs.image_artifact_id }}",
        ARTIFACT_NAME: "${{ needs.prepare_live_test_image.outputs.image_artifact_name }}",
        ARTIFACT_RUN_ATTEMPT:
          "${{ needs.prepare_live_test_image.outputs.image_artifact_run_attempt }}",
        ARTIFACT_RUN_ID: "${{ needs.prepare_live_test_image.outputs.image_artifact_run_id }}",
        GH_TOKEN: "${{ github.token }}",
      });
      expect(binding.run).toContain('verify-upload "live-test image"');
      expect(binding.run).toContain('"$ARTIFACT_ID" "$ARTIFACT_NAME" "$ARTIFACT_DIGEST"');
      expect(binding.run).toContain('"$ARTIFACT_RUN_ID" "$ARTIFACT_RUN_ATTEMPT"');
      const download = step(consumer, "Download live-test image artifact");
      expect(download.if).toContain("shared_image_policy == 'no-push-artifact'");
      expect(download.with).toMatchObject({
        "artifact-ids": "${{ needs.prepare_live_test_image.outputs.image_artifact_id }}",
        "github-token": "${{ github.token }}",
        "run-id": "${{ needs.prepare_live_test_image.outputs.image_artifact_run_id }}",
      });
      expect(consumer.steps?.indexOf(binding) ?? -1).toBeLessThan(
        consumer.steps?.indexOf(download) ?? -1,
      );
      const loadArtifact = step(consumer, "Verify and load live-test image artifact");
      expect(loadArtifact.env?.ARCHIVE_SHA256).toBe(
        "${{ needs.prepare_live_test_image.outputs.image_archive_sha256 }}",
      );
      expect(loadArtifact.env?.OPENCLAW_SHARED_IMAGE_RUN_ATTEMPT).toBe(
        "${{ needs.prepare_live_test_image.outputs.image_artifact_run_attempt }}",
      );
      expect(loadArtifact.env?.OPENCLAW_SHARED_IMAGE_RUN_ID).toBe(
        "${{ needs.prepare_live_test_image.outputs.image_artifact_run_id }}",
      );
      expect(loadArtifact.run).toContain("shared-image-artifact.sh");
      expect(loadArtifact.run).toContain('OPENCLAW_SHARED_IMAGE_ARCHIVE_SHA256="$ARCHIVE_SHA256"');
      expect(step(consumer, "Log in to GHCR").if).toContain(
        "shared_image_policy != 'no-push-artifact'",
      );
    }

    const liveBuild = readFileSync(LIVE_BUILD, "utf8");
    const requireLocalIndex = liveBuild.indexOf("OPENCLAW_LIVE_REQUIRE_LOCAL_IMAGE");
    const pullIndex = liveBuild.indexOf("Live-test image not found locally; pulling");
    expect(requireLocalIndex).toBeGreaterThanOrEqual(0);
    expect(pullIndex).toBeGreaterThan(requireLocalIndex);
    expect(liveBuild).toContain("Required local live-test image not found");
  });

  it("keeps Docker-save validation artifacts unreachable from package writers", () => {
    const liveWorkflow = readWorkflow(LIVE_E2E);
    const scheduled = readWorkflow(SCHEDULED_LIVE);
    expect(existsSync(SHARED_IMAGE_PUBLISHER)).toBe(false);
    expect(liveWorkflow.on?.workflow_call?.outputs?.publication_manifest).toBeUndefined();
    expect(liveWorkflow.jobs?.collect_shared_image_publication).toBeUndefined();
    expect(scheduled.jobs?.publish_shared_images).toBeUndefined();

    const scheduledWriters = Object.entries(scheduled.jobs ?? {})
      .filter(
        ([, workflowJob]) => permissionAt(workflowJob.permissions, "packages", "none") === "write",
      )
      .map(([name]) => name);
    expect(scheduledWriters).toEqual([]);

    const publisherCallers = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .filter((name) =>
        readFileSync(join(".github/workflows", name), "utf8").includes(
          "openclaw-shared-image-publish-reusable.yml",
        ),
      );
    expect(publisherCallers).toEqual([]);
    expect(JSON.stringify(liveWorkflow.jobs)).not.toContain("docker image push");
    expect(JSON.stringify(scheduled.jobs)).not.toContain("docker image push");

    const scheduledValidation = job(scheduled, "live_and_openwebui_checks");
    expect(permissionAt(scheduled.permissions, "packages", "none")).toBe("read");
    expectReadOnlyPackagePermission(scheduledValidation);
    expect(scheduledValidation.with).toMatchObject({
      allow_unreleased_changelog: true,
      shared_image_artifact_namespace: "scheduled-live",
      shared_image_policy: "no-push-artifact",
    });

    const dockerRelease = readWorkflow(DOCKER_RELEASE);
    const attestedBuilds = Object.values(dockerRelease.jobs ?? {}).flatMap((workflowJob) =>
      (workflowJob.steps ?? []).filter(
        (candidate) =>
          candidate.uses?.startsWith("docker/build-push-action@") && candidate.with?.push === true,
      ),
    );
    expect(attestedBuilds).toHaveLength(4);
    for (const build of attestedBuilds) {
      expect(build.with).toMatchObject({
        provenance: "mode=max",
        push: true,
        sbom: true,
      });
    }
  });

  it("keeps performance evidence artifact-only when dispatched by Full Release", () => {
    const fullText = readFileSync(FULL_RELEASE, "utf8");
    const performance = readWorkflow(PERFORMANCE);
    const publisher = job(performance, "publish");
    const dangerousSteps = [
      "Prepare clawgrit report commit",
      "Create clawgrit reports app token",
      "Publish to clawgrit reports",
    ];

    expect(performance.on?.workflow_dispatch?.inputs?.publish_reports).toMatchObject({
      default: true,
      type: "boolean",
    });
    expect(fullText).toContain("-f publish_reports=false");
    expect(fullText).toContain("Report publication: disabled (artifacts only)");
    expect(fullText).toContain('performanceReportPublication: "artifact-only"');
    expect(publisher.if).toContain("inputs.publish_reports == true");
    const guard = job(performance, "artifact_only_guard");
    expect(guard.if).toContain("inputs.publish_reports != true");
    expect(step(guard, "Verify report publisher stayed disabled").run).toContain(
      '[[ "$PUBLISH_RESULT" != "skipped" ]]',
    );
    for (const name of dangerousSteps) {
      expect(step(publisher, name)).toBeDefined();
    }

    for (const [name, workflowJob] of Object.entries(performance.jobs ?? {})) {
      if (name === "publish") {
        continue;
      }
      const text = JSON.stringify(workflowJob);
      expect(text).not.toContain("CLAWGRIT_REPORTS_APP_TOKEN");
      expect(text).not.toContain("create-github-app-token");
      expect(text).not.toContain("git push");
    }
  });

  it("routes Docker publication through release publish after immutable npm evidence", () => {
    const dockerRelease = readWorkflow(DOCKER_RELEASE);
    const releasePublishPath = ".github/workflows/openclaw-release-publish.yml";
    const releasePublish = readWorkflow(releasePublishPath);
    const dockerCall = job(releasePublish, "publish_docker");

    expect(dockerRelease.on?.push).toBeUndefined();
    expect(dockerRelease.on?.workflow_dispatch).toBeUndefined();
    expect(dockerRelease.on?.workflow_call?.inputs).toMatchObject({
      tag: { required: true, type: "string" },
      release_sha: { required: true, type: "string" },
    });
    expect(dockerRelease.on?.workflow_call?.secrets).toEqual({
      DOCKERHUB_USERNAME: { required: true },
      DOCKERHUB_TOKEN: { required: true },
    });

    const callers = readdirSync(".github/workflows")
      .filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
      .filter((name) =>
        readFileSync(join(".github/workflows", name), "utf8").includes(
          "uses: ./.github/workflows/docker-release.yml",
        ),
      )
      .toSorted();
    // docker-image-refresh.yml is the sanctioned second caller: it rebuilds
    // already-published releases behind the same docker-release environment
    // approval; its own guard test covers those safety properties.
    expect(callers).toEqual(["docker-image-refresh.yml", "openclaw-release-publish.yml"]);

    expect(dockerCall.needs).toEqual([
      "resolve_release_target",
      "publish",
      "verify_core_npm_registry",
    ]);
    expect(dockerCall.if).toContain("needs.publish.result == 'success'");
    expect(dockerCall.if).toContain("needs.verify_core_npm_registry.result == 'success'");
    expect(dockerCall.with).toEqual({
      tag: "${{ inputs.tag }}",
      release_sha: "${{ needs.resolve_release_target.outputs.sha }}",
      focused_release_evidence_run_id:
        "${{ inputs.release_evidence_mode == 'authorized-beta-focused-v1' && inputs.focused_release_evidence_run_id || '' }}",
      focused_release_evidence_run_attempt:
        "${{ needs.resolve_release_target.outputs.focused_release_evidence_run_attempt }}",
      focused_release_evidence_workflow_full_ref:
        "${{ needs.resolve_release_target.outputs.focused_release_evidence_workflow_full_ref }}",
      focused_release_evidence_workflow_sha:
        "${{ needs.resolve_release_target.outputs.focused_release_evidence_workflow_sha }}",
    });
    expect(dockerCall.secrets).toEqual({
      DOCKERHUB_USERNAME: "${{ secrets.DOCKERHUB_USERNAME }}",
      DOCKERHUB_TOKEN: "${{ secrets.DOCKERHUB_TOKEN }}",
    });
    expect(
      step(
        job(releasePublish, "resolve_release_target"),
        "Validate OpenClaw npm preflight manifest",
      ).run,
    ).toContain("Preflight manifest SHA mismatch");
    expect(
      step(
        job(releasePublish, "resolve_release_target"),
        "Validate full release validation manifest",
      ).run,
    ).toContain("Full release validation target SHA mismatch");
    expect(readFileSync(releasePublishPath, "utf8")).toContain(
      "kept draft until Docker publication succeeds",
    );
    expect(job(releasePublish, "finalize_github_release").needs).toEqual([
      "publish",
      "publish_docker",
    ]);

    const identity = step(
      job(dockerRelease, "validate_release_identity"),
      "Verify tag, SHA, and package identity agree",
    );
    expect(identity.run).toContain('git rev-parse "refs/tags/${RELEASE_TAG}^{commit}"');
    expect(identity.run).toContain('"${tag_sha}" != "${RELEASE_SHA}"');
    expect(identity.run).toContain('"v${package_version}" != "${RELEASE_TAG}"');
    expect(identity.run).toContain("^v${package_version}-[1-9][0-9]*$");
  });

  it("fails a missing required local live image before any registry pull", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-live-local-image-"));
    const bin = join(root, "bin");
    const calls = join(root, "docker.log");
    try {
      mkdirSync(bin);
      writeFileSync(calls, "");
      const docker = join(bin, "docker");
      writeFileSync(
        docker,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  exit 1
fi
if [[ "$1" == "pull" ]]; then
  exit 0
fi
exit 2
`,
      );
      chmodSync(docker, 0o755);

      const result = spawnSync("bash", [resolve(LIVE_BUILD)], {
        encoding: "utf8",
        env: {
          ...process.env,
          DOCKER_COMMAND_TIMEOUT: "5s",
          FAKE_DOCKER_LOG: calls,
          OPENCLAW_LIVE_IMAGE: "openclaw-live-test:required-local",
          OPENCLAW_LIVE_REQUIRE_LOCAL_IMAGE: "1",
          OPENCLAW_SKIP_DOCKER_BUILD: "1",
          PATH: `${bin}:${process.env.PATH ?? ""}`,
        },
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Required local live-test image not found: openclaw-live-test:required-local",
      );
      expect(readFileSync(calls, "utf8")).toBe("image inspect openclaw-live-test:required-local\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("fails a missing required local Docker E2E image before pull or build fallback", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-docker-e2e-local-image-"));
    const bin = join(root, "bin");
    const calls = join(root, "docker.log");
    try {
      mkdirSync(bin);
      writeFileSync(calls, "");
      const docker = join(bin, "docker");
      writeFileSync(
        docker,
        `#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$*" >> "$FAKE_DOCKER_LOG"
if [[ "$1" == "image" && "$2" == "inspect" ]]; then
  exit 1
fi
if [[ "$1" == "pull" ]]; then
  exit 0
fi
exit 2
`,
      );
      chmodSync(docker, 0o755);

      const result = spawnSync(
        "bash",
        [
          "-c",
          `source "$1"
docker_e2e_build_or_reuse "openclaw-e2e:required-local" "required local image test"`,
          "bash",
          resolve(DOCKER_E2E_IMAGE_HELPER),
        ],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            FAKE_DOCKER_LOG: calls,
            OPENCLAW_DOCKER_BUILD_ON_MISSING: "1",
            OPENCLAW_DOCKER_E2E_REQUIRE_LOCAL_IMAGE: "1",
            OPENCLAW_SKIP_DOCKER_BUILD: "1",
            PATH: `${bin}:${process.env.PATH ?? ""}`,
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        "Required local Docker E2E image not found: openclaw-e2e:required-local",
      );
      expect(readFileSync(calls, "utf8")).toBe("image inspect openclaw-e2e:required-local\n");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });
});
