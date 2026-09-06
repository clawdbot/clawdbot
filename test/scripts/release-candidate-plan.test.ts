import { execFileSync } from "node:child_process";
import { readFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import { resolveDockerE2ePlan } from "../../scripts/lib/docker-e2e-plan.mts";
import { createPluginPrereleaseTestPlan } from "../../scripts/lib/plugin-prerelease-test-plan.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const workflow = parse(
  readFileSync(".github/workflows/openclaw-live-and-e2e-checks-reusable.yml", "utf8"),
) as { jobs: Record<string, { steps: { name?: string; run?: string }[] }> };
const step = workflow.jobs.prepare_docker_e2e_image?.steps.find(
  (entry) => entry.name === "Plan Docker E2E images",
);
if (!step?.run) {
  throw new Error("Missing shared candidate planning step");
}
const planningScript = step.run;

type Plan = ReturnType<typeof resolveDockerE2ePlan>["plan"];

function runPlanningStep(
  releaseProfile: "beta" | "stable" | "full",
  mode: "prepare" | "release" | "targeted",
) {
  const root = tempDirs.make("openclaw-candidate-plan-");
  const output = join(root, "github-output");
  symlinkSync(resolve("."), join(root, ".release-harness"), "dir");
  execFileSync("bash", ["--noprofile", "--norc", "-c", planningScript], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      TSX_TSCONFIG_PATH: resolve("tsconfig.json"),
      INCLUDE_OPENWEBUI: "false",
      INCLUDE_RELEASE_PATH_SUITES: String(mode === "release"),
      LANES: mode === "targeted" ? "npm-onboard-channel-agent" : "",
      PREPARE_ONLY: String(mode === "prepare"),
      RELEASE_TEST_PROFILE: releaseProfile,
      OPENCLAW_DOCKER_ALL_TIMINGS: "0",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC: "",
      OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS: "",
      OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS: mode === "targeted" ? "" : "reported-issues",
    },
  });
  return {
    plan: JSON.parse(readFileSync(join(root, ".artifacts/docker-tests/plan.json"), "utf8")) as Plan,
    output: readFileSync(output, "utf8"),
  };
}

describe("shared release candidate preparation", () => {
  it.each(["beta", "stable", "full"] as const)(
    "prepares every plugin child's package under the %s profile",
    (releaseProfile) => {
      const { plan, output } = runPlanningStep(releaseProfile, "prepare");
      const release = runPlanningStep(releaseProfile, "release").plan;
      const child = resolveDockerE2ePlan({
        includeOpenWebUI: false,
        liveMode: "all",
        liveRetries: 1,
        orderLanes: (lanes) => lanes,
        planReleaseAll: false,
        profile: "all",
        releaseChunk: "",
        releaseProfile,
        selectedLaneNames: createPluginPrereleaseTestPlan().dockerLanes,
      }).plan;
      const missing = [
        ...child.requiredPrepublishPluginPackages,
        ...release.requiredPrepublishPluginPackages,
      ].filter((name) => !plan.requiredPrepublishPluginPackages.includes(name));
      expect(missing).toEqual([]);
      expect(output).toContain(
        `required_prepublish_plugin_packages=${JSON.stringify(plan.requiredPrepublishPluginPackages)}`,
      );
      expect(plan.needs.bareImage).toBe(true);
      expect(plan.needs.functionalImage).toBe(true);
      expect(release.lanes.map((lane) => lane.name)).not.toContain(
        "npm-onboard-slack-candidate-channel-agent",
      );
    },
  );

  it("keeps targeted execution limited to the selected lane and its packages", () => {
    const { plan } = runPlanningStep("full", "targeted");
    expect(plan.lanes.map((lane) => lane.name)).toEqual(["npm-onboard-channel-agent"]);
    expect(plan.requiredPrepublishPluginPackages).toEqual(["@openclaw/codex"]);
  });
});
