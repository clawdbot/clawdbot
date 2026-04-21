import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

function listContractTestFiles(rootDir = "src/channels/plugins/contracts") {
  if (!existsSync(rootDir)) {
    return [];
  }

  return readdirSync(rootDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".test.ts"))
    .map((entry) => join(rootDir, entry.name).replaceAll("\\", "/"))
    .toSorted((a, b) => a.localeCompare(b));
}

const CONTRACT_FILE_WEIGHTS = new Map([
  ["channel-import-guardrails.test.ts", 18],
  ["outbound-payload.contract.test.ts", 18],
  ["plugins-core.catalog.paths.contract.test.ts", 28],
  ["plugins-core.catalog.entries.contract.test.ts", 16],
  ["session-binding.registry-backed.contract.test.ts", 16],
]);

function resolveContractFileWeight(file) {
  const name = file.replaceAll("\\", "/").split("/").pop();
  if (name.startsWith("plugin.registry-backed-shard-")) {
    return 40;
  }
  if (name.startsWith("surfaces-only.registry-backed-shard-")) {
    return 40;
  }
  if (name.startsWith("directory.registry-backed-shard-")) {
    return 24;
  }
  if (name.startsWith("threading.registry-backed-shard-")) {
    return 18;
  }
  return CONTRACT_FILE_WEIGHTS.get(name) ?? 8;
}

export function createChannelContractTestShards() {
  const rootDir = "src/channels/plugins/contracts";
  const suffixes = ["a", "b", "c", "d", "e", "f", "g", "h"];
  const groups = Object.fromEntries(
    ["registry", "core"].flatMap((family) =>
      suffixes.map((suffix) => [`checks-fast-contracts-channels-${family}-${suffix}`, []]),
    ),
  );
  const groupKeys = {
    core: suffixes.map((suffix) => `checks-fast-contracts-channels-core-${suffix}`),
    registry: suffixes.map((suffix) => `checks-fast-contracts-channels-registry-${suffix}`),
  };
  const weights = Object.fromEntries(Object.keys(groups).map((key) => [key, 0]));
  const pushBalanced = (keys, file) => {
    const target = keys.toSorted((a, b) => weights[a] - weights[b] || a.localeCompare(b))[0];
    groups[target].push(file);
    weights[target] += resolveContractFileWeight(file);
  };

  const coreFiles = [];
  const registryFiles = [];
  for (const file of listContractTestFiles(rootDir)) {
    const name = relative(rootDir, file).replaceAll("\\", "/");
    (name.startsWith("plugins-core.") || name.startsWith("plugin.")
      ? coreFiles
      : registryFiles
    ).push(file);
  }

  const byDescendingWeight = (left, right) => {
    const delta = resolveContractFileWeight(right) - resolveContractFileWeight(left);
    return delta === 0 ? left.localeCompare(right) : delta;
  };
  for (const file of registryFiles.toSorted(byDescendingWeight)) {
    pushBalanced(groupKeys.registry, file);
  }
  for (const file of coreFiles.toSorted(byDescendingWeight)) {
    pushBalanced(groupKeys.core, file);
  }

  return Object.entries(groups).map(([checkName, includePatterns]) => ({
    checkName,
    includePatterns,
    task: "contracts-channels",
    runtime: "node",
  }));
}
