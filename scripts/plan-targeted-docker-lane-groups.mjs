// Plans grouped targeted Docker lane matrix entries without installed dependencies.
import { fileURLToPath } from "node:url";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import {
  parseUpgradeSurvivorBaselineSpecs,
  parseUpgradeSurvivorScenarios,
  supportsUpgradeSurvivorScenarioAtBaseline,
} from "./lib/upgrade-survivor-policy.mjs";

const BASELINE_SHARDED_LANES = new Set(["published-upgrade-survivor", "update-migration"]);
const SURVIVOR_SCENARIOS_PER_GROUP = 3;

function splitTokens(raw) {
  return [
    ...new Set(
      String(raw ?? "")
        .split(/[,\s]+/u)
        .map((token) => token.trim())
        .filter(Boolean),
    ),
  ];
}

function sanitizeLabel(value) {
  return (
    String(value)
      .replace(/^openclaw@/u, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "targeted"
  );
}

/**
 * Groups selected Docker lanes and expands sharded upgrade-survivor baselines.
 *
 * @param {{
 *   groupSize?: number | string;
 *   lanes?: string;
 *   upgradeSurvivorBaselines?: string;
 *   upgradeSurvivorScenarios?: string;
 * }} [options]
 * @returns {{
 *   docker_lanes: string;
 *   label: string;
 *   published_upgrade_survivor_baselines?: string;
 *   published_upgrade_survivor_scenarios?: string;
 *   timeout_minutes?: number;
 * }[]}
 */
export function planTargetedDockerLaneGroups({
  groupSize = 1,
  lanes,
  upgradeSurvivorBaselines = "",
  upgradeSurvivorScenarios = "",
} = {}) {
  const selectedLanes = splitTokens(lanes);
  if (selectedLanes.length === 0) {
    throw new Error("docker_lanes is required when planning targeted Docker lane groups.");
  }

  const parsedGroupSize = parsePositiveInt(groupSize, "groupSize");
  const baselineSpecs = parseUpgradeSurvivorBaselineSpecs(upgradeSurvivorBaselines);
  const hasExpandedSurvivorScenarios = splitTokens(upgradeSurvivorScenarios).length > 0;
  const survivorScenarios = selectedLanes.some((lane) => BASELINE_SHARDED_LANES.has(lane))
    ? parseUpgradeSurvivorScenarios(upgradeSurvivorScenarios)
    : [];
  const groups = [];
  let pendingLanes = [];

  const addGroup = (group) => {
    const groupLanes = splitTokens(group.docker_lanes);
    if (
      hasExpandedSurvivorScenarios &&
      groupLanes.some((lane) => BASELINE_SHARDED_LANES.has(lane))
    ) {
      group.timeout_minutes = 90;
    }
    groups.push(group);
  };

  const flushPending = () => {
    if (pendingLanes.length === 0) {
      return;
    }
    const first = sanitizeLabel(pendingLanes[0]);
    const last = sanitizeLabel(pendingLanes[pendingLanes.length - 1]);
    const label = pendingLanes.length === 1 ? first : `${first}--${last}`;
    addGroup({ docker_lanes: pendingLanes.join(" "), label });
    pendingLanes = [];
  };

  for (const lane of selectedLanes) {
    if (
      BASELINE_SHARDED_LANES.has(lane) &&
      survivorScenarios.length > SURVIVOR_SCENARIOS_PER_GROUP
    ) {
      flushPending();
      for (const baselineSpec of baselineSpecs.length > 0 ? baselineSpecs : [undefined]) {
        // Filter at the policy owner before partitioning so old baselines cannot
        // receive a shard containing only scenarios they never supported.
        const scenarios = survivorScenarios.filter((scenario) =>
          supportsUpgradeSurvivorScenarioAtBaseline(scenario, baselineSpec),
        );
        const label = [lane, baselineSpec].filter(Boolean).map(sanitizeLabel).join("-");
        for (let offset = 0; offset < scenarios.length; offset += SURVIVOR_SCENARIOS_PER_GROUP) {
          addGroup({
            docker_lanes: lane,
            label: `${label}-scenarios-${offset / SURVIVOR_SCENARIOS_PER_GROUP + 1}`,
            ...(baselineSpec ? { published_upgrade_survivor_baselines: baselineSpec } : {}),
            published_upgrade_survivor_scenarios: scenarios
              .slice(offset, offset + SURVIVOR_SCENARIOS_PER_GROUP)
              .join(" "),
          });
        }
      }
      continue;
    }
    if (BASELINE_SHARDED_LANES.has(lane) && baselineSpecs.length > 1) {
      flushPending();
      for (const baselineSpec of baselineSpecs) {
        addGroup({
          docker_lanes: lane,
          label: `${sanitizeLabel(lane)}-${sanitizeLabel(baselineSpec)}`,
          published_upgrade_survivor_baselines: baselineSpec,
        });
      }
      continue;
    }

    pendingLanes.push(lane);
    if (pendingLanes.length >= parsedGroupSize) {
      flushPending();
    }
  }

  flushPending();
  return groups;
}

const isMain = process.argv[1] ? fileURLToPath(import.meta.url) === process.argv[1] : false;

if (isMain) {
  process.stdout.write(
    JSON.stringify(
      planTargetedDockerLaneGroups({
        groupSize: process.env.GROUP_SIZE,
        lanes: process.env.LANES,
        upgradeSurvivorBaselines: process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS,
        upgradeSurvivorScenarios: process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS,
      }),
    ),
  );
}
