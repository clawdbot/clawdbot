// Builds balanced Vitest shard plans for channel plugin contract tests.
import { relative } from "node:path";
import { listTrackedTestFiles } from "./list-test-files.mts";

function listContractTestFiles(rootDir = "src/channels/plugins/contracts") {
  return listTrackedTestFiles(rootDir);
}

const CONTRACT_FILE_WEIGHTS = new Map([
  ["channel-import-guardrails.test.ts", 18],
  ["outbound-payload.contract.test.ts", 18],
  // Loads every bundled channel plugin surface in one file.
  ["plugin-shape.contract.test.ts", 48],
  ["plugins-core.catalog.paths.contract.test.ts", 28],
  ["plugins-core.catalog.entries.contract.test.ts", 16],
  ["session-binding.registry-backed.contract.test.ts", 40],
]);

function resolveContractFileWeight(file: string) {
  const name = file.replaceAll("\\", "/").split("/").pop() ?? "";
  if (name.startsWith("plugin.registry-backed-shard-")) {
    return 48;
  }
  if (name.startsWith("surfaces-only.registry-backed-shard-")) {
    return 40;
  }
  if (name.startsWith("directory.registry-backed-shard-")) {
    return 36;
  }
  if (name.startsWith("threading.registry-backed-shard-")) {
    return 18;
  }
  return CONTRACT_FILE_WEIGHTS.get(name) ?? 8;
}

/** Create balanced channel contract test shards for CI check planning. */
export function createChannelContractTestShards() {
  const rootDir = "src/channels/plugins/contracts";
  const suffixes = ["a", "b"];
  const groups = suffixes.map((suffix) => ({
    checkName: `checks-fast-contracts-channels-${suffix}`,
    includePatterns: new Array<string>(),
    weight: 0,
  }));
  const pushBalanced = (file: string) => {
    const target = groups.toSorted(
      (a, b) => a.weight - b.weight || a.checkName.localeCompare(b.checkName),
    )[0];
    if (!target) {
      throw new Error("channel contract shard groups must not be empty");
    }
    target.includePatterns.push(file);
    target.weight += resolveContractFileWeight(file);
  };

  const coreFiles = new Array<string>();
  const registryFiles = new Array<string>();
  for (const file of listContractTestFiles(rootDir)) {
    const name = relative(rootDir, file).replaceAll("\\", "/");
    (name.startsWith("plugins-core.") || name.startsWith("plugin.")
      ? coreFiles
      : registryFiles
    ).push(file);
  }

  const byDescendingWeight = (left: string, right: string) => {
    const delta = resolveContractFileWeight(right) - resolveContractFileWeight(left);
    return delta === 0 ? left.localeCompare(right) : delta;
  };
  for (const file of registryFiles.toSorted(byDescendingWeight)) {
    pushBalanced(file);
  }
  for (const file of coreFiles.toSorted(byDescendingWeight)) {
    pushBalanced(file);
  }

  return groups.map(({ checkName, includePatterns }) => ({
    checkName,
    includePatterns,
    task: "contracts-channels",
    runtime: "node",
  }));
}
