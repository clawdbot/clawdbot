type WeightedTestShard = {
  checkName: string;
  includePatterns: string[];
  weight: number;
};

export function assignWeightedTestFiles(
  shards: WeightedTestShard[],
  files: readonly string[],
  resolveWeight: (file: string) => number,
) {
  if (shards.length === 0) {
    throw new Error("weighted test shards must not be empty");
  }

  const weightedFiles = files
    .map((file) => ({ file, weight: resolveWeight(file) }))
    .toSorted((left, right) => right.weight - left.weight || left.file.localeCompare(right.file));

  for (const { file, weight } of weightedFiles) {
    // Stable ties keep generated CI plans byte-identical across hosts and repeated runs.
    const target = shards.reduce((lightest, candidate) => {
      const delta =
        candidate.weight - lightest.weight || candidate.checkName.localeCompare(lightest.checkName);
      return delta < 0 ? candidate : lightest;
    });
    target.includePatterns.push(file);
    target.weight += weight;
  }
}
