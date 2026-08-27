#!/usr/bin/env node

// Enforces core tsgo project boundaries and sparse-checkout safety.
import { spawnSync } from "node:child_process";
import { resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { createManagedCommandInvocation } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  findTsgoCoreTestShardViolations,
  TSGO_CORE_TEST_MAX_ROOTS,
  TSGO_CORE_TEST_SHARDS,
} from "./lib/tsgo-core-test-shards.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
const tsgoPath = resolveRepoToolBinPath("tsgo", { cwd: repoRoot });
const canonicalCoreTestConfig = "test/tsconfig/tsconfig.core.test.json";

const coreGraphs = [
  { name: "core", config: "tsconfig.core.json" },
  { name: "ui", config: "tsconfig.ui.json" },
  ...TSGO_CORE_TEST_SHARDS.map((shard) => ({
    name: `core-test-${shard.name}`,
    config: shard.config,
  })),
];
function normalizeFilePath(filePath: string) {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const normalizedRoot = repoRoot.replaceAll("\\", "/");
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

function listGraphFiles(graph: (typeof coreGraphs)[number]) {
  const tsgo = createManagedCommandInvocation({
    args: ["-p", graph.config, "--pretty", "false", "--listFilesOnly"],
    bin: tsgoPath,
  });
  const result = spawnSync(tsgo.command, tsgo.args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: tsgo.shell,
    windowsVerbatimArguments: tsgo.windowsVerbatimArguments,
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${graph.name} file listing failed with exit code ${result.status}\n${output}`);
  }
  return (result.stdout ?? "").split(/\r?\n/u).map(normalizeFilePath).filter(Boolean);
}

function readGraphConfig(config: string): {
  compilerOptions?: { tsBuildInfoFile?: string };
  files?: string[];
} {
  const tsgo = createManagedCommandInvocation({
    args: ["-p", config, "--pretty", "false", "--showConfig"],
    bin: tsgoPath,
  });
  const result = spawnSync(tsgo.command, tsgo.args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: tsgo.shell,
    windowsVerbatimArguments: tsgo.windowsVerbatimArguments,
  });
  if (result.error) {
    throw result.error;
  }
  if ((result.status ?? 1) !== 0) {
    const output = [result.stdout, result.stderr].filter(Boolean).join("\n");
    throw new Error(`${config} config expansion failed with exit code ${result.status}\n${output}`);
  }
  return JSON.parse(result.stdout ?? "") as {
    compilerOptions?: { tsBuildInfoFile?: string };
    files?: string[];
  };
}

const testRootPattern = /\.test\.(?:ts|tsx)$/u;
const canonicalRoots = (readGraphConfig(canonicalCoreTestConfig).files ?? [])
  .map(normalizeFilePath)
  .filter((file) => testRootPattern.test(file));
const shardConfigs = TSGO_CORE_TEST_SHARDS.map((shard) => ({
  name: shard.name,
  config: shard.config,
  expanded: readGraphConfig(shard.config),
}));
const shardViolations = findTsgoCoreTestShardViolations({
  canonicalRoots,
  shards: shardConfigs.map((shard) => ({
    name: shard.name,
    roots: (shard.expanded.files ?? [])
      .map(normalizeFilePath)
      .filter((file) => testRootPattern.test(file)),
  })),
});

const buildInfoOwners = new Map<string, string[]>();
for (const shard of shardConfigs) {
  const buildInfo = shard.expanded.compilerOptions?.tsBuildInfoFile;
  if (!buildInfo) {
    shardViolations.push(`${shard.name}: missing compilerOptions.tsBuildInfoFile`);
    continue;
  }
  const owners = buildInfoOwners.get(buildInfo) ?? [];
  owners.push(shard.name);
  buildInfoOwners.set(buildInfo, owners);
}
for (const [buildInfo, owners] of buildInfoOwners) {
  if (owners.length > 1) {
    shardViolations.push(`shared tsBuildInfoFile (${owners.join(", ")}): ${buildInfo}`);
  }
}

if (shardViolations.length > 0) {
  console.error(
    `Core test shards must cover every canonical test root exactly once and stay at or below ${TSGO_CORE_TEST_MAX_ROOTS} roots:`,
  );
  for (const violation of shardViolations) {
    console.error(`- ${violation}`);
  }
  process.exit(1);
}

const violations: string[] = [];
for (const graph of coreGraphs) {
  const extensionFiles = listGraphFiles(graph).filter((file) => file.startsWith("extensions/"));
  for (const file of extensionFiles) {
    violations.push(`${graph.name}: ${file}`);
  }
}

if (violations.length > 0) {
  console.error("Core tsgo graphs must not include bundled extension files:");
  for (const violation of violations) {
    console.error(`- ${violation}`);
  }
  console.error(
    "Move extension-owned behavior behind plugin SDK contracts, public artifacts, or extension-local tests.",
  );
  process.exit(1);
}
