type QaExecutionShard = {
  index: number;
  count: number;
};

function compareStrings(left: string, right: string) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function hashQaExecutionKey(value: string) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function resolveQaExecutionShard(
  value: string | undefined,
  label = "QA execution",
): QaExecutionShard | undefined {
  const normalized = value?.trim();
  if (!normalized) {
    return undefined;
  }
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(normalized);
  const index = Number(match?.[1]);
  const count = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(index) || !Number.isSafeInteger(count) || index > count) {
    throw new Error(`${label} shard must use <index>/<count> with 1 <= index <= count.`);
  }
  return { index, count };
}

export function selectQaExecutionShardScenarioIds(
  scenarioIds: readonly string[],
  shard: QaExecutionShard,
) {
  // Hash ordering decouples execution placement from catalog order. Round-robin
  // assignment keeps balanced workers without becoming another membership owner.
  const orderedIds = [...new Set(scenarioIds)].toSorted((left, right) => {
    const hashDelta = hashQaExecutionKey(left) - hashQaExecutionKey(right);
    return hashDelta || compareStrings(left, right);
  });
  const selectedIds = orderedIds.filter((_, index) => index % shard.count === shard.index - 1);
  if (selectedIds.length === 0) {
    throw new Error(
      `QA execution shard ${shard.index}/${shard.count} resolved no scenarios from ${orderedIds.length} semantically selected scenario(s).`,
    );
  }
  return selectedIds;
}
