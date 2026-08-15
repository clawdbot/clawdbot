#!/usr/bin/env node

// Profiles selected tsgo graphs and writes diagnostics/trace artifacts for
// TypeScript graph size and performance investigations.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalTsgoPolicy,
  resolveRepoToolBinPath,
  shouldAcquireLocalHeavyCheckLockForTsgo,
} from "./lib/local-heavy-check-runtime.mts";
import { createManagedCommandInvocation } from "./lib/managed-child-process.mts";
import { resolveRepoRoot } from "./lib/repo-root.mjs";
import { TSGO_CORE_TEST_SHARDS, type TsgoCoreTestShard } from "./lib/tsgo-core-test-shards.mts";
const repoRoot = resolveRepoRoot(import.meta.url);
const artifactRoot = path.resolve(repoRoot, ".artifacts/tsgo-profile");
const tsgoPath = resolveRepoToolBinPath("tsgo", { cwd: repoRoot });

type GraphDefinition = { config: string; description: string };
type CoreTestGraphName = `core-test-${TsgoCoreTestShard["name"]}`;
const CORE_TEST_GRAPH_DEFINITIONS = Object.fromEntries(
  TSGO_CORE_TEST_SHARDS.map((shard) => [
    `core-test-${shard.name}`,
    {
      config: shard.config,
      description: `bounded core test shard: ${shard.name}`,
    },
  ]),
) as Record<CoreTestGraphName, GraphDefinition>;

const GRAPH_DEFINITIONS = {
  core: {
    config: "tsconfig.core.json",
    description: "core production graph",
  },
  ui: {
    config: "tsconfig.ui.json",
    description: "UI production graph",
  },
  ...CORE_TEST_GRAPH_DEFINITIONS,
  extensions: {
    config: "tsconfig.extensions.json",
    description: "bundled extension production graph",
  },
  "extensions-test": {
    config: "test/tsconfig/tsconfig.extensions.test.json",
    description: "bundled extension colocated test graph",
  },
} as const;

type GraphName = keyof typeof GRAPH_DEFINITIONS;
const DEFAULT_GRAPHS = [
  ...TSGO_CORE_TEST_SHARDS.map((shard) => `core-test-${shard.name}` as CoreTestGraphName),
  "extensions-test",
] satisfies GraphName[];
type ProfileOptions = {
  all: boolean;
  deep: boolean;
  explain: boolean;
  json: boolean;
  reuse: boolean;
  outDir: string;
};
type Diagnostics = Record<string, number>;
type ProfileGraphResult = ReturnType<typeof profileGraph>;
type ProfileReport = {
  generatedAt: string;
  options: { graphs: GraphName[]; deep: boolean; explain: boolean; reuse: boolean };
  graphs: ProfileGraphResult[];
  paths: { json?: string; text?: string };
};

function usage(): string {
  return [
    "Usage: pnpm tsgo:profile [graph...] [options]",
    "",
    "Graphs:",
    ...Object.entries(GRAPH_DEFINITIONS).map(
      ([name, graph]) => `  ${name.padEnd(26)} ${graph.description}`,
    ),
    "",
    "Options:",
    "  --all              Profile all graphs",
    "  --reuse            Reuse profile tsbuildinfo files instead of forcing fresh checks",
    "  --deep             Also write --generateTrace and --pprofDir artifacts",
    "  --explain          Also write list-only --explainFiles artifacts",
    "  --out=<dir>        Output directory (default: .artifacts/tsgo-profile)",
    "  --json             Print JSON report to stdout",
    "  --help             Show this help",
    "",
    "Default graphs: all bounded core-test shards and extensions-test",
  ].join("\n");
}

function parseArgs(argv: string[]): { options: ProfileOptions; selectedGraphs: GraphName[] } {
  const graphNames: GraphName[] = [];
  const options: ProfileOptions = {
    all: false,
    deep: false,
    explain: false,
    json: false,
    reuse: false,
    outDir: artifactRoot,
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    if (arg === "--all") {
      options.all = true;
      continue;
    }
    if (arg === "--deep") {
      options.deep = true;
      continue;
    }
    if (arg === "--explain") {
      options.explain = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--reuse") {
      options.reuse = true;
      continue;
    }
    if (arg.startsWith("--out=")) {
      options.outDir = path.resolve(repoRoot, arg.slice("--out=".length));
      continue;
    }
    if (!(arg in GRAPH_DEFINITIONS)) {
      throw new Error(`Unknown graph: ${arg}\n\n${usage()}`);
    }
    graphNames.push(arg as GraphName);
  }

  const selectedGraphs = options.all
    ? (Object.keys(GRAPH_DEFINITIONS) as GraphName[])
    : graphNames.length > 0
      ? graphNames
      : DEFAULT_GRAPHS;

  return { options, selectedGraphs };
}

function ensureDirs(outDir: string): void {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "cache"), { recursive: true });
}

function removeIfFreshMode(filePath: string, reuse: boolean): void {
  if (!reuse) {
    fs.rmSync(filePath, { force: true });
  }
}

function runTsgo(
  label: string,
  args: string[],
  params: { maxBuffer?: number } = {},
): { elapsedMs: number; stdout: string; stderr: string } {
  const { args: finalArgs, env } = applyLocalTsgoPolicy(args, process.env, {
    logicalCpuCount:
      typeof os.availableParallelism === "function" ? os.availableParallelism() : os.cpus().length,
    totalMemoryBytes: os.totalmem(),
  });
  const releaseLock = shouldAcquireLocalHeavyCheckLockForTsgo(finalArgs, env)
    ? acquireLocalHeavyCheckLockSync({
        cwd: repoRoot,
        env,
        toolName: "tsgo-profile",
      })
    : () => {};

  const startedAt = Date.now();
  try {
    const tsgo = createManagedCommandInvocation({
      args: finalArgs,
      bin: tsgoPath,
      env,
    });
    const result = spawnSync(tsgo.command, tsgo.args, {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: params.maxBuffer ?? 128 * 1024 * 1024,
      shell: tsgo.shell,
      windowsVerbatimArguments: tsgo.windowsVerbatimArguments,
    });
    const elapsedMs = Date.now() - startedAt;
    const stdout = result.stdout ?? "";
    const stderr = result.stderr ?? "";
    if (result.error) {
      throw result.error;
    }
    if ((result.status ?? 1) !== 0) {
      const output = [stdout, stderr].filter(Boolean).join("\n");
      throw new Error(`${label} failed with exit code ${result.status ?? 1}\n${output}`);
    }
    return { elapsedMs, stdout, stderr };
  } finally {
    releaseLock();
  }
}

function parseDiagnostics(output: string): Diagnostics {
  const diagnostics: Diagnostics = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(.+?):\s+([0-9.]+)(K|s)?\s*$/u.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, rawKey, rawValue, unit] = match;
    const key = rawKey!.trim().replaceAll(/\s+/gu, " ");
    const value = Number(rawValue);
    diagnostics[key] = unit === "K" ? value * 1024 : value;
  }
  return diagnostics;
}

function normalizeFilePath(filePath: string): string {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const normalizedRoot = repoRoot.replaceAll("\\", "/");
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

function packageNameFromNodeModule(parts: string[], startIndex: number): string {
  const first = parts[startIndex + 1];
  if (!first) {
    return "node_modules";
  }
  if (first.startsWith("@")) {
    return `${first}/${parts[startIndex + 2] ?? ""}`.replace(/\/$/u, "");
  }
  return first;
}

function classifyFile(relativePath: string): string {
  const parts = relativePath.split("/");
  const first = parts[0];
  if (relativePath.includes("/node_modules/") || first === "node_modules") {
    const nodeModulesIndex = parts.indexOf("node_modules");
    return `node_modules/${packageNameFromNodeModule(parts, nodeModulesIndex)}`;
  }
  if (first === "extensions") {
    return `extensions/${parts[1] ?? "(root)"}`;
  }
  if (first === "packages") {
    return `packages/${parts[1] ?? "(root)"}`;
  }
  if (first === "src") {
    return `src/${parts[1] ?? "(root)"}`;
  }
  if (first === "ui") {
    return `ui/${parts[1] ?? "(root)"}`;
  }
  if (first === "test") {
    return `test/${parts[1] ?? "(root)"}`;
  }
  if (first?.startsWith("/") || (first !== undefined && /^[A-Za-z]:/u.test(first))) {
    return "(external)";
  }
  return first || "(unknown)";
}

function countBy<T>(values: T[], keyFn: (value: T) => string) {
  const counts = new Map<string, number>();
  for (const value of values) {
    const key = keyFn(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .toSorted((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function summarizeFiles(stdout: string) {
  const files = stdout
    .split(/\r?\n/u)
    .map(normalizeFilePath)
    .filter(Boolean)
    .filter((line) => !line.startsWith("Files:"));

  const projectRelativeFiles = files.filter(
    (file) => !path.isAbsolute(file) && !/^[A-Za-z]:/u.test(file),
  );
  const testFiles = projectRelativeFiles.filter((file) => /\.test\.[cm]?[tj]sx?$/u.test(file));
  return {
    totalFiles: files.length,
    projectRelativeFiles: projectRelativeFiles.length,
    testFiles: testFiles.length,
    groups: countBy(projectRelativeFiles, classifyFile).slice(0, 40),
  };
}

function diffDiagnostics(check: Diagnostics, noCheck: Diagnostics) {
  const totalDelta = (check["Total time"] ?? 0) - (noCheck["Total time"] ?? 0);
  const checkTime = check["Check time"] ?? 0;
  return {
    checkTimeSeconds: checkTime,
    totalDeltaSeconds: totalDelta,
    typeShareOfTotal:
      check["Total time"] && checkTime ? Number((checkTime / check["Total time"]).toFixed(3)) : 0,
  };
}

function formatSeconds(value: number): string {
  return `${value.toFixed(2)}s`;
}

function renderTextReport(report: ProfileReport): string {
  const lines = [
    "# tsgo profile",
    "",
    `Generated: ${report.generatedAt}`,
    `Fresh profile caches: ${report.options.reuse ? "no" : "yes"}`,
    "",
  ];

  for (const graph of report.graphs) {
    const check = graph.check.diagnostics;
    const noCheck = graph.noCheck.diagnostics;
    lines.push(`## ${graph.name}`);
    lines.push(`Config: ${graph.config}`);
    lines.push(
      `Check: wall ${formatSeconds(graph.check.elapsedMs / 1000)}, compiler total ${formatSeconds(
        check["Total time"] ?? 0,
      )}, check ${formatSeconds(check["Check time"] ?? 0)}, memory ${Math.round(
        (check["Memory used"] ?? 0) / 1024 / 1024,
      )} MiB`,
    );
    lines.push(
      `NoCheck: wall ${formatSeconds(
        graph.noCheck.elapsedMs / 1000,
      )}, compiler total ${formatSeconds(noCheck["Total time"] ?? 0)}`,
    );
    lines.push(
      `Files: compiler ${check.Files ?? "?"}, listed ${graph.files.totalFiles}, project-relative ${graph.files.projectRelativeFiles}, tests ${graph.files.testFiles}`,
    );
    lines.push(`File list: ${graph.files.artifact}`);
    lines.push(
      `Type cost: check ${formatSeconds(graph.typeCost.checkTimeSeconds)}, total delta ${formatSeconds(
        graph.typeCost.totalDeltaSeconds,
      )}, share ${(graph.typeCost.typeShareOfTotal * 100).toFixed(1)}%`,
    );
    lines.push("Top file groups:");
    for (const group of graph.files.groups.slice(0, 15)) {
      lines.push(`- ${group.key}: ${group.count}`);
    }
    if (graph.deep) {
      lines.push(`Deep artifacts: ${graph.deep.traceDir}, ${graph.deep.profileDir}`);
    }
    if (graph.explain) {
      lines.push(`Explain: ${graph.explain.artifact}`);
    }
    lines.push("");
  }

  lines.push(`JSON: ${report.paths.json ?? ""}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function profileGraph(name: GraphName, options: ProfileOptions) {
  const graph = GRAPH_DEFINITIONS[name];
  const outDir = options.outDir;
  const graphCacheRoot = path.join(outDir, "cache");
  const checkBuildInfo = path.join(graphCacheRoot, `${name}-check.tsbuildinfo`);
  const noCheckBuildInfo = path.join(graphCacheRoot, `${name}-nocheck.tsbuildinfo`);
  const configPath = graph.config;

  removeIfFreshMode(checkBuildInfo, options.reuse);
  removeIfFreshMode(noCheckBuildInfo, options.reuse);

  const baseArgs = ["-p", configPath, "--pretty", "false"];
  const listFiles = runTsgo(`${name}:listFilesOnly`, [...baseArgs, "--listFilesOnly"], {
    maxBuffer: 256 * 1024 * 1024,
  });
  const filesArtifact = path.join(outDir, `${name}.files.txt`);
  fs.writeFileSync(filesArtifact, listFiles.stdout);
  const noCheck = runTsgo(`${name}:noCheck`, [
    ...baseArgs,
    "--noCheck",
    "--incremental",
    "--tsBuildInfoFile",
    noCheckBuildInfo,
    "--extendedDiagnostics",
  ]);

  const checkArgs = [
    ...baseArgs,
    "--incremental",
    "--tsBuildInfoFile",
    checkBuildInfo,
    "--extendedDiagnostics",
  ];
  let deep: { profileDir: string; traceDir: string } | undefined;
  if (options.deep) {
    const traceDir = path.join(outDir, `${name}-trace`);
    const profileDir = path.join(outDir, `${name}-pprof`);
    fs.rmSync(traceDir, { force: true, recursive: true });
    fs.rmSync(profileDir, { force: true, recursive: true });
    fs.mkdirSync(profileDir, { recursive: true });
    checkArgs.push("--generateTrace", traceDir, "--pprofDir", profileDir);
    deep = {
      traceDir: path.relative(repoRoot, traceDir),
      profileDir: path.relative(repoRoot, profileDir),
    };
  }
  const check = runTsgo(`${name}:check`, checkArgs);
  let explain: { artifact: string; elapsedMs: number } | undefined;
  if (options.explain) {
    const explainArtifact = path.join(outDir, `${name}.explain.txt`);
    const explainResult = runTsgo(
      `${name}:explainFiles`,
      [...baseArgs, "--listFilesOnly", "--explainFiles"],
      {
        maxBuffer: 256 * 1024 * 1024,
      },
    );
    fs.writeFileSync(explainArtifact, `${explainResult.stdout}${explainResult.stderr}`);
    explain = {
      artifact: path.relative(repoRoot, explainArtifact),
      elapsedMs: explainResult.elapsedMs,
    };
  }

  const checkDiagnostics = parseDiagnostics(`${check.stdout}\n${check.stderr}`);
  const noCheckDiagnostics = parseDiagnostics(`${noCheck.stdout}\n${noCheck.stderr}`);
  return {
    name,
    config: configPath,
    description: graph.description,
    files: {
      ...summarizeFiles(listFiles.stdout),
      artifact: path.relative(repoRoot, filesArtifact),
    },
    noCheck: {
      elapsedMs: noCheck.elapsedMs,
      diagnostics: noCheckDiagnostics,
    },
    check: {
      elapsedMs: check.elapsedMs,
      diagnostics: checkDiagnostics,
    },
    typeCost: diffDiagnostics(checkDiagnostics, noCheckDiagnostics),
    ...(deep ? { deep } : {}),
    ...(explain ? { explain } : {}),
  };
}

async function main(argv: string[]): Promise<void> {
  const { options, selectedGraphs } = parseArgs(argv);
  ensureDirs(options.outDir);
  const report: ProfileReport = {
    generatedAt: new Date().toISOString(),
    options: {
      graphs: selectedGraphs,
      deep: options.deep,
      explain: options.explain,
      reuse: options.reuse,
    },
    graphs: [],
    paths: {},
  };

  for (const graphName of selectedGraphs) {
    process.stderr.write(`[tsgo-profile] profiling ${graphName}\n`);
    report.graphs.push(profileGraph(graphName, options));
  }

  const timestamp = new Date()
    .toISOString()
    .replaceAll(":", "")
    .replaceAll(".", "")
    .replace("T", "-")
    .replace("Z", "");
  const jsonPath = path.join(options.outDir, `tsgo-profile-${timestamp}.json`);
  const textPath = path.join(options.outDir, `tsgo-profile-${timestamp}.md`);
  report.paths = {
    json: path.relative(repoRoot, jsonPath),
    text: path.relative(repoRoot, textPath),
  };

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(textPath, renderTextReport(report));
  fs.writeFileSync(
    path.join(options.outDir, "latest.json"),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  fs.writeFileSync(path.join(options.outDir, "latest.md"), renderTextReport(report));

  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderTextReport(report));
  }
}

try {
  await main(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
}
