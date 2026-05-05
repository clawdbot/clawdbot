import { describe, expect, it } from "vitest";
import { planTargetedDockerLaneGroups } from "../../scripts/plan-targeted-docker-lane-groups.mjs";

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
});
