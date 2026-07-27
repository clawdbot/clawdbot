import { readQaScenarioPack } from "../../scenario-catalog.js";

const MATRIX_QA_CHANNEL_ID = "matrix";

type QaScenarioShard = {
  index: number;
  total: number;
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

function parseQaScenarioShard(value: string): QaScenarioShard {
  const match = /^(\d+)\/(\d+)$/.exec(value.trim());
  const index = Number.parseInt(match?.[1] ?? "", 10);
  const total = Number.parseInt(match?.[2] ?? "", 10);
  if (
    !match ||
    !Number.isSafeInteger(index) ||
    !Number.isSafeInteger(total) ||
    index < 1 ||
    total < 1 ||
    index > total
  ) {
    throw new Error(
      `Invalid Matrix QA shard "${value}". Expected <index>/<total> with 1 <= index <= total.`,
    );
  }
  return { index, total };
}

function shardMatrixQaScenarioIds(scenarioIds: readonly string[], shardValue: string): string[] {
  const shard = parseQaScenarioShard(shardValue);
  // Hash ordering makes shard membership independent of catalog/YAML order while
  // round-robin assignment keeps every shard within one scenario of the others.
  const orderedIds = [...new Set(scenarioIds)].toSorted((left, right) => {
    const hashDelta = hashScenarioId(left) - hashScenarioId(right);
    return hashDelta || compareStrings(left, right);
  });
  const selectedIds = orderedIds.filter((_, index) => index % shard.total === shard.index - 1);
  if (selectedIds.length === 0) {
    throw new Error(
      `Matrix QA shard ${shardValue} resolved no scenarios from ${orderedIds.length} selected scenario(s).`,
    );
  }
  return selectedIds;
}

function listMatrixQaScenarioIds(): string[] {
  return readQaScenarioPack()
    .scenarios.filter(
      (scenario) =>
        scenario.execution.kind === "flow" &&
        (scenario.execution.channel === MATRIX_QA_CHANNEL_ID ||
          scenario.execution.channels?.includes(MATRIX_QA_CHANNEL_ID)),
    )
    .map((scenario) => scenario.id)
    .toSorted(compareStrings);
}

export function resolveMatrixQaScenarioIds(params: {
  scenarioIds?: readonly string[];
  shard?: string;
}): string[] {
  const scenarioIds = params.scenarioIds?.length
    ? [...new Set(params.scenarioIds)]
    : listMatrixQaScenarioIds();
  if (scenarioIds.length === 0) {
    throw new Error("Matrix QA catalog selection resolved no scenarios.");
  }
  return params.shard ? shardMatrixQaScenarioIds(scenarioIds, params.shard) : scenarioIds;
}
