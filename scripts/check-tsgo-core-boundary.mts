#!/usr/bin/env node

// Enforces core tsgo project boundaries and sparse-checkout safety.
import path from "node:path";
import { isDirectRunUrl } from "./lib/direct-run.mjs";
import { resolveRepoToolBinPath } from "./lib/local-check-runtime.mts";
import { runManagedCommand, signalExitCode } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import {
  findTsgoCoreTestShardViolations,
  TSGO_CORE_TEST_MAX_ROOTS,
  TSGO_CORE_GRAPHS,
  TSGO_CORE_TEST_SHARDS,
} from "./lib/tsgo-core-test-shards.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
const tsgoPath = resolveRepoToolBinPath("tsgo", { cwd: repoRoot });
const canonicalCoreTestConfig = "test/tsconfig/tsconfig.core.test.json";

function normalizeFilePath(filePath: string) {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const normalizedRoot = repoRoot.replaceAll("\\", "/");
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

export class CoreTsgoBoundaryInterruptedError extends Error {
  readonly exitCode: number;

  constructor(signal: NodeJS.Signals) {
    super(`Core tsgo graph boundary interrupted by ${signal}`);
    this.exitCode = signalExitCode(signal);
  }
}

async function runTsgoQuery(config: string, query: string, label: string): Promise<string> {
  const outputs: Buffer[][] = [[], []];
  const overflow = new AbortController();
  let outputBytes = 0;
  let receivedSignal: NodeJS.Signals | undefined;
  let code: number;
  try {
    code = await runManagedCommand({
      bin: tsgoPath,
      args: ["-p", config, "--pretty", "false", query],
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "pipe"],
      signal: overflow.signal,
      requireProcessTreeExit: process.platform !== "win32",
      onSignal(signal) {
        receivedSignal = signal;
      },
      onReady(child) {
        for (const [index, stream] of [child.stdout!, child.stderr!].entries()) {
          stream.on("data", (chunk: Buffer) => {
            if (overflow.signal.aborted) {
              return;
            }
            outputBytes += chunk.byteLength;
            // Inventory must be complete; preserve spawnSync's bound and fail rather than truncate.
            if (outputBytes > 256 * 1024 * 1024) {
              overflow.abort();
              return;
            }
            outputs[index]!.push(chunk);
          });
        }
      },
    });
  } catch (error) {
    if (overflow.signal.aborted) {
      throw new Error(`${label} output exceeded 256 MiB`, { cause: error });
    }
    throw error;
  }
  if (receivedSignal) {
    throw new CoreTsgoBoundaryInterruptedError(receivedSignal);
  }
  const [stdout, stderr] = outputs.map((chunks) => Buffer.concat(chunks).toString("utf8"));
  if (code !== 0) {
    throw new Error(
      `${label} failed with exit code ${code}\n${[stdout, stderr].filter(Boolean).join("\n")}`,
    );
  }
  return stdout!;
}

async function readGraphConfig(config: string): Promise<{
  compilerOptions?: { tsBuildInfoFile?: string };
  files?: string[];
}> {
  return JSON.parse(await runTsgoQuery(config, "--showConfig", `${config} config expansion`)) as {
    compilerOptions?: { tsBuildInfoFile?: string };
    files?: string[];
  };
}

export type CoreTsgoGraph = {
  name: string;
  config: string;
  roots: readonly string[];
  files: readonly string[];
};

/** Validates all boundaries and returns this invocation's compiler-resolved inputs. */
export async function checkCoreTsgoGraphBoundary(): Promise<CoreTsgoGraph[]> {
  const testRootPattern = /\.test\.(?:ts|tsx)$/u;
  const canonicalRoots = ((await readGraphConfig(canonicalCoreTestConfig)).files ?? [])
    .map(normalizeFilePath)
    .filter((file) => testRootPattern.test(file));
  const shardConfigs = [];
  for (const shard of TSGO_CORE_TEST_SHARDS) {
    shardConfigs.push({ ...shard, expanded: await readGraphConfig(shard.config) });
  }
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
    throw new Error("Core test graph ownership validation failed");
  }

  const violations: string[] = [];
  const graphs: CoreTsgoGraph[] = [];
  for (const graph of TSGO_CORE_GRAPHS) {
    const files = (
      await runTsgoQuery(graph.config, "--listFilesOnly", `${graph.name} file listing`)
    )
      .split(/\r?\n/u)
      .map(normalizeFilePath)
      .filter(Boolean);
    graphs.push({
      ...graph,
      files,
      roots: (shardConfigs.find((shard) => shard.config === graph.config)?.expanded.files ?? [])
        .map((file) => normalizeFilePath(path.resolve(repoRoot, path.dirname(graph.config), file)))
        .filter((file) => testRootPattern.test(file)),
    });
    const extensionFiles = files.filter((file) => file.startsWith("extensions/"));
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
    throw new Error("Core tsgo graphs include bundled extension files");
  }
  return graphs;
}

if (isDirectRunUrl(process.argv[1], import.meta.url)) {
  try {
    await checkCoreTsgoGraphBoundary();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = error instanceof CoreTsgoBoundaryInterruptedError ? error.exitCode : 1;
  }
}
