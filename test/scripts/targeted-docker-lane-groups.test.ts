// Targeted Docker Lane Groups tests cover targeted docker lane groups script behavior.
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseLaneSelection, resolveDockerE2ePlan } from "../../scripts/lib/docker-e2e-plan.mts";
import { planTargetedDockerLaneGroups } from "../../scripts/plan-targeted-docker-lane-groups.mjs";
import { withTempDir } from "../../src/test-utils/temp-dir.js";

function expandedPlan(
  lanes: string,
  upgradeSurvivorBaselines: string,
  upgradeSurvivorScenarios: string,
  upgradeSurvivorTargetRoot?: string,
) {
  return resolveDockerE2ePlan({
    allowFrozenTargetScenarioOmissions: true,
    includeOpenWebUI: false,
    liveMode: "all",
    liveRetries: 1,
    orderLanes: (entries) => entries,
    planReleaseAll: false,
    profile: "all",
    releaseChunk: "",
    selectedLaneNames: parseLaneSelection(lanes),
    upgradeSurvivorBaselines,
    upgradeSurvivorScenarios,
    upgradeSurvivorTargetRoot,
  });
}

describe("scripts/plan-targeted-docker-lane-groups", () => {
  it("keeps normal targeted lanes grouped by the configured group size", () => {
    expect(
      planTargetedDockerLaneGroups({
        groupSize: 2,
        lanes: "doctor-switch update-channel-switch plugin-update",
      }),
    ).toEqual([
      {
        docker_lanes: "doctor-switch update-channel-switch",
        label: "doctor-switch--update-channel-switch",
      },
      { docker_lanes: "plugin-update", label: "plugin-update" },
    ]);
  });

  it("shards published upgrade survivor by baseline while preserving surrounding lanes", () => {
    expect(
      planTargetedDockerLaneGroups({
        groupSize: 2,
        lanes:
          "doctor-switch update-channel-switch published-upgrade-survivor plugins-offline plugin-update",
        upgradeSurvivorBaselines:
          "openclaw@2026.5.3-1 openclaw@2026.5.3 openclaw@2026.5.2 openclaw@2026.4.23",
      }),
    ).toEqual([
      {
        docker_lanes: "doctor-switch update-channel-switch",
        label: "doctor-switch--update-channel-switch",
      },
      {
        docker_lanes: "published-upgrade-survivor",
        label: "published-upgrade-survivor-2026.5.3-1",
        published_upgrade_survivor_baselines: "openclaw@2026.5.3-1",
      },
      {
        docker_lanes: "published-upgrade-survivor",
        label: "published-upgrade-survivor-2026.5.3",
        published_upgrade_survivor_baselines: "openclaw@2026.5.3",
      },
      {
        docker_lanes: "published-upgrade-survivor",
        label: "published-upgrade-survivor-2026.5.2",
        published_upgrade_survivor_baselines: "openclaw@2026.5.2",
      },
      {
        docker_lanes: "published-upgrade-survivor",
        label: "published-upgrade-survivor-2026.4.23",
        published_upgrade_survivor_baselines: "openclaw@2026.4.23",
      },
      { docker_lanes: "plugins-offline plugin-update", label: "plugins-offline--plugin-update" },
    ]);
  });

  it("leaves a single baseline on the normal logical lane", () => {
    expect(
      planTargetedDockerLaneGroups({
        lanes: "published-upgrade-survivor",
        upgradeSurvivorBaselines: "openclaw@2026.5.2",
      }),
    ).toEqual([
      { docker_lanes: "published-upgrade-survivor", label: "published-upgrade-survivor" },
    ]);
  });

  it("extends only groups containing expanded survivor lanes", () => {
    expect(
      planTargetedDockerLaneGroups({
        groupSize: 2,
        lanes:
          "doctor-switch published-upgrade-survivor plugins-offline update-migration plugin-update",
        upgradeSurvivorScenarios: "base plugin-deps-cleanup",
      }),
    ).toEqual([
      {
        docker_lanes: "doctor-switch published-upgrade-survivor",
        label: "doctor-switch--published-upgrade-survivor",
        timeout_minutes: 90,
      },
      {
        docker_lanes: "plugins-offline update-migration",
        label: "plugins-offline--update-migration",
        timeout_minutes: 90,
      },
      { docker_lanes: "plugin-update", label: "plugin-update" },
    ]);
  });

  it.each([
    {
      label: "release baselines",
      baselines: "2026.7.1-2 2026.7.1-1 2026.6.34 2026.6.33 2026.5.2 2026.4.23 2026.4.15",
      scenarios: "reported-issues",
    },
    {
      label: "deduped baseline and scenario spellings",
      baselines: "2026.4.15 openclaw@2026.4.15 2026.4.23",
      scenarios: "reported-issues base feishu-channel",
    },
    {
      label: "an old single baseline with unsupported scenarios at the end",
      baselines: "2026.4.15",
      scenarios:
        "base feishu-channel tilde-log-path acpx-openclaw-tools-bridge plugin-deps-cleanup",
    },
    { label: "the default baseline", baselines: "", scenarios: "far-reaching" },
  ])("preserves each expanded lane exactly once for $label", ({ baselines, scenarios }) => {
    const lanes = "doctor-switch published-upgrade-survivor update-migration plugin-update";
    const groups = planTargetedDockerLaneGroups({
      groupSize: 2,
      lanes,
      upgradeSurvivorBaselines: baselines,
      upgradeSurvivorScenarios: scenarios,
    });
    const expanded = groups.map((group) => ({
      group,
      plan: expandedPlan(
        group.docker_lanes,
        group.published_upgrade_survivor_baselines ?? baselines,
        group.published_upgrade_survivor_scenarios ?? scenarios,
      ),
    }));
    const actual = expanded.flatMap(({ plan }) => plan.scheduledLanes);
    const expected = expandedPlan(lanes, baselines, scenarios).scheduledLanes;
    expect(actual).toEqual(expected);
    expect(new Set(actual.map((lane) => lane.name)).size).toBe(actual.length);
    expect(new Set(groups.map((group) => group.label)).size).toBe(groups.length);
    for (const { group, plan } of expanded) {
      expect(plan.scheduledLanes.length).toBeGreaterThan(0);
      if (
        group.docker_lanes
          .split(" ")
          .some((lane) => ["published-upgrade-survivor", "update-migration"].includes(lane))
      ) {
        expect(group.published_upgrade_survivor_scenarios).toBeTruthy();
        expect(group.published_upgrade_survivor_scenarios?.split(" ").length).toBeLessThanOrEqual(
          3,
        );
        expect(plan.scheduledLanes.length).toBeLessThanOrEqual(3);
        expect(group.timeout_minutes).toBe(90);
      }
    }
  });

  it("preserves frozen-target omissions across scenario shards", async () => {
    await withTempDir("openclaw-survivor-shards-", async (targetRoot) => {
      const harnessDir = join(targetRoot, "scripts/e2e/lib/upgrade-survivor");
      await mkdir(harnessDir, { recursive: true });
      await writeFile(
        join(harnessDir, "assertions.mjs"),
        'console.log(JSON.stringify(["base", "feishu-channel"]));',
      );
      const baselines = "2026.4.15 2026.4.23";
      const scenarios = "reported-issues";
      const lanes = "published-upgrade-survivor";
      const groups = planTargetedDockerLaneGroups({
        lanes,
        upgradeSurvivorBaselines: baselines,
        upgradeSurvivorScenarios: scenarios,
      });
      const expanded = groups.map((group) =>
        expandedPlan(
          group.docker_lanes,
          group.published_upgrade_survivor_baselines ?? baselines,
          group.published_upgrade_survivor_scenarios ?? scenarios,
          targetRoot,
        ),
      );
      const expected = expandedPlan(lanes, baselines, scenarios, targetRoot);
      expect(expanded.flatMap((plan) => plan.scheduledLanes)).toEqual(expected.scheduledLanes);
      expect(expanded.flatMap((plan) => plan.omittedUnsupportedLaneNames)).toEqual(
        expected.omittedUnsupportedLaneNames,
      );
      for (const plan of expanded) {
        expect(
          plan.scheduledLanes.length + plan.omittedUnsupportedLaneNames.length,
        ).toBeGreaterThan(0);
      }
    });
  });

  it("rejects malformed group size values", () => {
    expect(() =>
      planTargetedDockerLaneGroups({
        groupSize: "2x",
        lanes: "doctor-switch update-channel-switch",
      }),
    ).toThrow("groupSize must be a positive integer");
    expect(() =>
      planTargetedDockerLaneGroups({
        groupSize: 0,
        lanes: "doctor-switch update-channel-switch",
      }),
    ).toThrow("groupSize must be a positive integer");
  });
});
