import { parseStrictPositiveInteger } from "openclaw/plugin-sdk/number-runtime";
import type { QaProviderMode } from "../../model-selection.js";
import { readQaScenarioPack } from "../../scenario-catalog.js";
import type { QaScorecardChannelDriver } from "../../scorecard-taxonomy.js";
import { selectQaFlowSuiteScenarios } from "../../suite-planning.js";

const MATRIX_QA_SHARD_INDEX_ENV = "OPENCLAW_QA_MATRIX_SHARD_INDEX";
const MATRIX_QA_SHARD_COUNT_ENV = "OPENCLAW_QA_MATRIX_SHARD_COUNT";

export type MatrixQaScenarioShard = {
  count: number;
  index: number;
};

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashScenarioId(id: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < id.length; index += 1) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function readMatrixQaScenarioShard(
  env: NodeJS.ProcessEnv = process.env,
): MatrixQaScenarioShard | undefined {
  const rawIndex = env[MATRIX_QA_SHARD_INDEX_ENV]?.trim();
  const rawCount = env[MATRIX_QA_SHARD_COUNT_ENV]?.trim();
  if (!rawIndex && !rawCount) {
    return undefined;
  }
  if (!rawIndex || !rawCount) {
    throw new Error(
      `${MATRIX_QA_SHARD_INDEX_ENV} and ${MATRIX_QA_SHARD_COUNT_ENV} must be set together.`,
    );
  }
  const index = parseStrictPositiveInteger(rawIndex);
  const count = parseStrictPositiveInteger(rawCount);
  if (!index || !count) {
    throw new Error(
      `${MATRIX_QA_SHARD_INDEX_ENV} and ${MATRIX_QA_SHARD_COUNT_ENV} must be positive integers.`,
    );
  }
  if (index > count) {
    throw new Error(`${MATRIX_QA_SHARD_INDEX_ENV} must be at most ${MATRIX_QA_SHARD_COUNT_ENV}.`);
  }
  return { count, index };
}

export function shardMatrixQaScenarioIds(
  scenarioIds: readonly string[],
  shard: MatrixQaScenarioShard,
): string[] {
  // Hash ordering makes shard membership independent of catalog/YAML order while
  // round-robin assignment keeps every shard within one scenario of the others.
  const orderedIds = [...new Set(scenarioIds)].toSorted((left, right) => {
    const hashDelta = hashScenarioId(left) - hashScenarioId(right);
    return hashDelta || compareStrings(left, right);
  });
  const selectedIds = orderedIds.filter((_, index) => index % shard.count === shard.index - 1);
  if (selectedIds.length === 0) {
    throw new Error(
      `Matrix QA shard ${shard.index}/${shard.count} resolved no scenarios from ${orderedIds.length} selected scenario(s).`,
    );
  }
  return selectedIds;
}

export function resolveMatrixQaScenarioIds(params: {
  channelDriver?: QaScorecardChannelDriver;
  primaryModel: string;
  providerMode: QaProviderMode;
  scenarioIds?: readonly string[];
  shard?: MatrixQaScenarioShard;
}): string[] {
  const scenarioIds = selectQaFlowSuiteScenarios({
    scenarios: readQaScenarioPack().scenarios,
    scenarioIds: params.scenarioIds ? [...params.scenarioIds] : undefined,
    providerMode: params.providerMode,
    primaryModel: params.primaryModel,
    channelDriver: params.channelDriver ?? "live",
    channel: "matrix",
  }).map((scenario) => scenario.id);
  if (scenarioIds.length === 0) {
    throw new Error("Matrix QA catalog selection resolved no scenarios.");
  }
  return params.shard ? shardMatrixQaScenarioIds(scenarioIds, params.shard) : scenarioIds;
}
