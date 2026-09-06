// Builds balanced Vitest shard plans for plugin contract tests.
import { listTrackedTestFiles } from "./list-test-files.mts";
import { assignWeightedTestFiles } from "./weighted-test-shards.mts";

function listContractTestFiles(rootDir = "src/plugins/contracts") {
  return listTrackedTestFiles(rootDir);
}

const CONTRACT_FILE_WEIGHTS = new Map([
  ["plugin-sdk-subpaths.test.ts", 80],
  ["tts.contract.test.ts", 70],
  ["boundary-invariants.test.ts", 36],
  ["extension-package-project-boundaries.test.ts", 34],
  ["plugin-sdk-package-contract-guardrails.test.ts", 46],
  ["providers.contract.test.ts", 30],
  ["registry.contract.test.ts", 30],
  ["core-extension-facade-boundary.test.ts", 28],
  ["loader.contract.test.ts", 28],
  ["runtime-import-side-effects.contract.test.ts", 24],
  ["extension-runtime-dependencies.contract.test.ts", 22],
]);

function resolveContractFileWeight(file: string) {
  const name = file.replaceAll("\\", "/").split("/").pop() ?? "";
  if (name.startsWith("plugin-registration.")) {
    return 14;
  }
  if (name.startsWith("wizard.")) {
    return 12;
  }
  return CONTRACT_FILE_WEIGHTS.get(name) ?? 10;
}

/** Create balanced plugin contract test shards for CI check planning. */
export function createPluginContractTestShards() {
  const suffixes = ["a", "b"];
  const groups = suffixes.map((suffix) => ({
    checkName: `checks-fast-contracts-plugins-${suffix}`,
    includePatterns: new Array<string>(),
    weight: 0,
  }));

  assignWeightedTestFiles(groups, listContractTestFiles(), resolveContractFileWeight);

  return groups
    .map(({ checkName, includePatterns }) => ({
      checkName,
      includePatterns,
      runtime: "node",
      task: "contracts-plugins",
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}
