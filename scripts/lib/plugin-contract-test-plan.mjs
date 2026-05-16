import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function listContractTestFiles(rootDir = "src/plugins/contracts") {
  const result = spawnSync("git", ["ls-files", "--", rootDir], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0) {
    return result.stdout
      .split("\n")
      .map((line) => line.trim().replaceAll("\\", "/"))
      .filter((line) => line.endsWith(".test.ts"))
      .toSorted((a, b) => a.localeCompare(b));
  }

  if (!existsSync(rootDir)) {
    return [];
  }

  const files = [];
  const visit = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".test.ts")) {
        files.push(path.replaceAll("\\", "/"));
      }
    }
  };

  visit(rootDir);
  return files.toSorted((a, b) => a.localeCompare(b));
}

const CONTRACT_FILE_WEIGHTS = new Map([
  ["plugin-sdk-subpaths.test.ts", 80],
  ["plugin-sdk-root-alias.test.ts", 90],
  ["tts.contract.test.ts", 70],
  ["boundary-invariants.test.ts", 36],
  ["extension-package-project-boundaries.test.ts", 34],
  ["plugin-sdk-index.test.ts", 32],
  ["plugin-sdk-index.bundle.test.ts", 32],
  ["plugin-sdk-package-contract-guardrails.test.ts", 46],
  ["providers.contract.test.ts", 30],
  ["registry.contract.test.ts", 30],
  ["core-extension-facade-boundary.test.ts", 28],
  ["loader.contract.test.ts", 28],
  ["runtime-import-side-effects.contract.test.ts", 24],
  ["extension-runtime-dependencies.contract.test.ts", 22],
]);

function resolveContractFileWeight(file) {
  const name = file.replaceAll("\\", "/").split("/").pop();
  if (name.startsWith("plugin-registration.")) {
    return 14;
  }
  if (name.startsWith("wizard.")) {
    return 12;
  }
  return CONTRACT_FILE_WEIGHTS.get(name) ?? 10;
}

export function createPluginContractTestShards() {
  const suffixes = ["a", "b", "c", "d"];
  const groups = Object.fromEntries(
    suffixes.map((suffix) => [`checks-fast-contracts-plugins-${suffix}`, []]),
  );
  const groupKeys = suffixes.map((suffix) => `checks-fast-contracts-plugins-${suffix}`);
  const weights = Object.fromEntries(groupKeys.map((key) => [key, 0]));

  const pushBalanced = (file) => {
    const target = groupKeys.toSorted((a, b) => weights[a] - weights[b] || a.localeCompare(b))[0];
    groups[target].push(file);
    weights[target] += resolveContractFileWeight(file);
  };

  const byDescendingWeight = (left, right) => {
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
