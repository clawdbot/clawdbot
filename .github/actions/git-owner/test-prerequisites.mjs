import { existsSync } from "node:fs";
import { matchesGlob } from "node:path";
import prerequisites from "./test-prerequisites.json" with { type: "json" };

// The trusted workflow owns immutable history; selected targets only decide
// which readers run. Do not make credential-free test workers fetch it later.
export function resolveTestGitCommits(shard) {
  const plans = shard.groups ?? [shard];
  return Object.values(prerequisites)
    .filter(
      ({ file, configs }) =>
        existsSync(file) &&
        plans.some((plan) => {
          const patterns = plan.targets ?? plan.includePatterns;
          return patterns
            ? patterns.some((pattern) => matchesGlob(file, pattern))
            : plan.configs?.some((config) => configs.includes(config));
        }),
    )
    .map(({ commit }) => commit);
}
