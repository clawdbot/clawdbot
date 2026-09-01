import type { TestSpecification } from "vitest/node";

export function selectWeightedShard(
  files: TestSpecification[],
  shard: { count: number; index: number },
  estimateWeight: (file: TestSpecification) => number,
): TestSpecification[] {
  const buckets = Array.from({ length: shard.count }, () => ({
    weight: 0,
    files: [] as TestSpecification[],
  }));
  // Discovery is the sole membership authority; stale measurements may affect
  // balance but can never add, omit, or duplicate a discovered specification.
  const weightedFiles = files
    .map((file) => ({ weight: estimateWeight(file), file }))
    .sort(
      (left, right) =>
        right.weight - left.weight || left.file.moduleId.localeCompare(right.file.moduleId),
    );
  for (const { weight, file } of weightedFiles) {
    const bucket = buckets.reduce((lightest, candidate) =>
      candidate.weight < lightest.weight ? candidate : lightest,
    );
    bucket.weight += weight;
    bucket.files.push(file);
  }
  return buckets[shard.index - 1]!.files;
}
