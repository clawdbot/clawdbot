// Builds balanced Vitest shard plans for plugin contract tests.
import { listTrackedTestFiles } from "./list-test-files.mts";

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
  const groups: Record<string, string[]> = Object.fromEntries(
    suffixes.map((suffix) => [`checks-fast-contracts-plugins-${suffix}`, []]),
  );
  const groupKeys = suffixes.map((suffix) => `checks-fast-contracts-plugins-${suffix}`);
  const weights: Record<string, number> = Object.fromEntries(groupKeys.map((key) => [key, 0]));

  const pushBalanced = (file: string) => {
    const target = groupKeys.toSorted(
      (a, b) => (weights[a] ?? 0) - (weights[b] ?? 0) || a.localeCompare(b),
    )[0];
    if (!target || !groups[target] || weights[target] === undefined) {
      throw new Error("plugin contract shard groups must not be empty");
    }
    groups[target].push(file);
    weights[target] += resolveContractFileWeight(file);
  };

  const byDescendingWeight = (left: string, right: string) => {
    const delta = resolveContractFileWeight(right) - resolveContractFileWeight(left);
    return delta === 0 ? left.localeCompare(right) : delta;
  };

  for (const file of listContractTestFiles().toSorted(byDescendingWeight)) {
    pushBalanced(file);
  }

  return Object.entries(groups)
    .map(([checkName, includePatterns]) => ({
      checkName,
      includePatterns,
      runtime: "node",
      task: "contracts-plugins",
    }))
    .filter((shard) => shard.includePatterns.length > 0);
}
