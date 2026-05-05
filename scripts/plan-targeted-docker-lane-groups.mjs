import { fileURLToPath } from "node:url";

const BASELINE_SHARDED_LANES = new Set(["published-upgrade-survivor", "update-migration"]);

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

function parsePositiveInt(raw, fallback, label) {
  const parsed = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  if (parsed < 1) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function sanitizeLabel(value) {
  return (
    String(value)
      .replace(/^openclaw@/u, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "") || "targeted"
  );
}

export function planTargetedDockerLaneGroups({
  groupSize = 1,
  lanes,
  upgradeSurvivorBaselines = "",
} = {}) {
  const selectedLanes = splitTokens(lanes);
  if (selectedLanes.length === 0) {
    throw new Error("docker_lanes is required when planning targeted Docker lane groups.");
  }

  const parsedGroupSize = parsePositiveInt(groupSize, 1, "groupSize");
  const baselineSpecs = splitTokens(upgradeSurvivorBaselines);
  const groups = [];
  let pendingLanes = [];

  const flushPending = () => {
    if (pendingLanes.length === 0) {
      return;
    }
    const first = sanitizeLabel(pendingLanes[0]);
    const last = sanitizeLabel(pendingLanes[pendingLanes.length - 1]);
    const label = pendingLanes.length === 1 ? first : `${first}--${last}`;
    groups.push({ docker_lanes: pendingLanes.join(" "), label });
    pendingLanes = [];
  };

  for (const lane of selectedLanes) {
    if (BASELINE_SHARDED_LANES.has(lane) && baselineSpecs.length > 1) {
      flushPending();
      for (const baselineSpec of baselineSpecs) {
        groups.push({
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
      }),
    ),
  );
}
