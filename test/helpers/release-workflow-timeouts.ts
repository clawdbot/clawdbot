type ReleaseTimeoutProfile = "beta" | "stable" | "full";
type ReleaseWorkflowJob = { needs?: string | string[]; "timeout-minutes"?: number | string };
type ReleaseWorkflow = { jobs?: Record<string, ReleaseWorkflowJob> };

export function releaseWorkflowJobNeeds(job: ReleaseWorkflowJob): string[] {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}

export function releaseTimeoutForProfile(
  timeout: number | string | undefined,
  profile: ReleaseTimeoutProfile,
): number {
  if (typeof timeout === "number") {
    return timeout;
  }
  if (timeout === "${{ matrix.group.timeout_minutes || 60 }}") {
    return 60;
  }
  const match = timeout?.match(
    /^\$\{\{ inputs\.(?:release_profile|release_test_profile) == 'full' && ([0-9]+) \|\| ([0-9]+) \}\}$/u,
  );
  if (!match) {
    throw new Error(`Unsupported release timeout expression: ${String(timeout)}`);
  }
  return Number(profile === "full" ? match[1] : match[2]);
}

function requireWorkflowJob(workflow: ReleaseWorkflow, jobName: string): ReleaseWorkflowJob {
  const job = workflow.jobs?.[jobName];
  if (!job) {
    throw new Error(`Missing release workflow job: ${jobName}`);
  }
  return job;
}

function requireWorkflowNeeds(
  job: ReleaseWorkflowJob,
  required: readonly string[],
  exact = false,
): void {
  const needs = releaseWorkflowJobNeeds(job);
  if (
    !required.every((name) => needs.includes(name)) ||
    (exact && needs.length !== required.length)
  ) {
    throw new Error(`Invalid release dependency chain: ${needs.join(",")}`);
  }
}

export function pluginPrereleaseTimeoutComponents(params: {
  pluginPrerelease: ReleaseWorkflow;
  liveE2e: ReleaseWorkflow;
  profile: ReleaseTimeoutProfile;
}) {
  const jobs = {
    preflight: requireWorkflowJob(params.pluginPrerelease, "preflight"),
    dockerSuite: requireWorkflowJob(params.pluginPrerelease, "plugin-prerelease-docker-suite"),
    suite: requireWorkflowJob(params.pluginPrerelease, "plugin-prerelease-suite"),
    validateSelectedRef: requireWorkflowJob(params.liveE2e, "validate_selected_ref"),
    prepareImage: requireWorkflowJob(params.liveE2e, "prepare_docker_e2e_image"),
    dockerLanes: requireWorkflowJob(params.liveE2e, "validate_docker_lanes"),
  };
  requireWorkflowNeeds(jobs.dockerSuite, ["preflight"]);
  requireWorkflowNeeds(jobs.prepareImage, ["validate_selected_ref"], true);
  requireWorkflowNeeds(jobs.dockerLanes, ["prepare_docker_e2e_image"]);
  requireWorkflowNeeds(jobs.suite, ["plugin-npm-security-scan", "plugin-prerelease-docker-suite"]);
  const timeout = (job: ReleaseWorkflowJob) =>
    releaseTimeoutForProfile(job["timeout-minutes"], params.profile);
  return {
    preflight: timeout(jobs.preflight),
    validateSelectedRef: timeout(jobs.validateSelectedRef),
    prepareImage: timeout(jobs.prepareImage),
    dockerLanes: timeout(jobs.dockerLanes),
    suite: timeout(jobs.suite),
  };
}
