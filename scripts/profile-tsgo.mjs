#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  acquireLocalHeavyCheckLockSync,
  applyLocalTsgoPolicy,
  shouldAcquireLocalHeavyCheckLockForTsgo,
} from "./lib/local-heavy-check-runtime.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
const artifactRoot = path.resolve(repoRoot, ".artifacts/tsgo-profile");
const tsgoPath = path.resolve(repoRoot, "node_modules", ".bin", "tsgo");

const GRAPH_DEFINITIONS = {
  core: {
    config: "tsconfig.core.json",
    description: "core production graph",
  },
  "core-test": {
    config: "test/tsconfig/tsconfig.core.test.json",
    description: "core colocated test graph",
  },
  "core-test-agents": {
    config: "test/tsconfig/tsconfig.core.test.agents.json",
    description: "diagnostic slice: core agent colocated tests",
  },
  "core-test-non-agents": {
    config: "test/tsconfig/tsconfig.core.test.non-agents.json",
    description: "diagnostic slice: core tests excluding agent test roots",
  },
  extensions: {
    config: "tsconfig.extensions.json",
    description: "bundled extension production graph",
  },
  "extensions-test": {
    config: "test/tsconfig/tsconfig.extensions.test.json",
    description: "bundled extension colocated test graph",
  },
};

function usage() {
  return [
    "Usage: pnpm tsgo:profile [graph...] [options]",
    "",
    "Graphs:",
    ...Object.entries(GRAPH_DEFINITIONS).map(
      ([name, graph]) => `  ${name.padEnd(16)} ${graph.description}`,
    ),
    "",
    "Options:",
    "  --all              Profile all graphs",
    "  --reuse            Reuse profile tsbuildinfo files instead of forcing fresh checks",
    "  --deep             Also write --generateTrace and --generateCpuProfile artifacts",
    "  --explain          Also write --explainFiles artifacts",
    "  --out=<dir>        Output directory (default: .artifacts/tsgo-profile)",
    "  --json             Print JSON report to stdout",
    "  --help             Show this help",
    "",
    "Default graphs: core-test extensions-test",
  ].join("\n");
}

function parseArgs(argv) {
  const graphNames = [];
  const options = {
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
    if (!GRAPH_DEFINITIONS[arg]) {
      throw new Error(`Unknown graph: ${arg}\n\n${usage()}`);
    }
    graphNames.push(arg);
  }

  const selectedGraphs = options.all
    ? Object.keys(GRAPH_DEFINITIONS)
    : graphNames.length > 0
      ? graphNames
      : ["core-test", "extensions-test"];

  return { options, selectedGraphs };
}

function ensureDirs(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "cache"), { recursive: true });
}

function removeIfFreshMode(filePath, reuse) {
  if (!reuse) {
    fs.rmSync(filePath, { force: true });
  }
}

function runTsgo(label, args, params = {}) {
  const { args: finalArgs, env } = applyLocalTsgoPolicy(args, process.env);
  const releaseLock = shouldAcquireLocalHeavyCheckLockForTsgo(finalArgs, env)
    ? acquireLocalHeavyCheckLockSync({
        cwd: repoRoot,
        env,
        toolName: "tsgo-profile",
      })
    : () => {};

  const startedAt = Date.now();
  try {
    const result = spawnSync(tsgoPath, finalArgs, {
      cwd: repoRoot,
      env,
      encoding: "utf8",
      maxBuffer: params.maxBuffer ?? 128 * 1024 * 1024,
      shell: process.platform === "win32",
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

function parseDiagnostics(output) {
  const diagnostics = {};
  for (const line of output.split(/\r?\n/u)) {
    const match = /^(.+?):\s+([0-9.]+)(K|s)?\s*$/u.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, rawKey, rawValue, unit] = match;
    const key = rawKey.trim().replaceAll(/\s+/gu, " ");
    const value = Number(rawValue);
    diagnostics[key] = unit === "K" ? value * 1024 : value;
  }
  return diagnostics;
}

function normalizeFilePath(filePath) {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const normalizedRoot = repoRoot.replaceAll("\\", "/");
  if (normalized.startsWith(`${normalizedRoot}/`)) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return normalized;
}

function packageNameFromNodeModule(parts, startIndex) {
  const first = parts[startIndex + 1];
  if (!first) {
    return "node_modules";
  }
  if (first.startsWith("@")) {
    return `${first}/${parts[startIndex + 2] ?? ""}`.replace(/\/$/u, "");
  }
  return first;
}

function classifyFile(relativePath) {
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
  if (first.startsWith("/") || /^[A-Za-z]:/u.test(first)) {
    return "(external)";
  }
  return first || "(unknown)";
}

function countBy(values, keyFn) {
  const counts = new Map();
  for (const value of values) {
    const key = keyFn(value);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([key, count]) => ({ key, count }))
    .toSorted((left, right) => right.count - left.count || left.key.localeCompare(right.key));
}

function summarizeFiles(stdout) {
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

function diffDiagnostics(check, noCheck) {
  const totalDelta = (check["Total time"] ?? 0) - (noCheck["Total time"] ?? 0);
  const checkTime = check["Check time"] ?? 0;
  return {
    checkTimeSeconds: checkTime,
    totalDeltaSeconds: totalDelta,
    typeShareOfTotal:
      check["Total time"] && checkTime ? Number((checkTime / check["Total time"]).toFixed(3)) : 0,
  };
}

function formatSeconds(value) {
  return `${value.toFixed(2)}s`;
}

function renderTextReport(report) {
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
      lines.push(`Deep artifacts: ${graph.deep.traceDir}, ${graph.deep.cpuProfile}`);
    }
    if (graph.explain) {
      lines.push(`Explain: ${graph.explain.artifact}`);
    }
    lines.push("");
  }

  lines.push(`JSON: ${report.paths.json}`);
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function profileGraph(name, options) {
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
  let deep;
  if (options.deep) {
    const traceDir = path.join(outDir, `${name}-trace`);
    const cpuProfile = path.join(outDir, `${name}.cpuprofile`);
    fs.rmSync(traceDir, { force: true, recursive: true });
    fs.rmSync(cpuProfile, { force: true });
    checkArgs.push("--generateTrace", traceDir, "--generateCpuProfile", cpuProfile);
    deep = {
      traceDir: path.relative(repoRoot, traceDir),
      cpuProfile: path.relative(repoRoot, cpuProfile),
    };
  }
  const check = runTsgo(`${name}:check`, checkArgs);
  let explain;
  if (options.explain) {
    const explainArtifact = path.join(outDir, `${name}.explain.txt`);
    const explainResult = runTsgo(`${name}:explainFiles`, [...baseArgs, "--explainFiles"], {
      maxBuffer: 256 * 1024 * 1024,
    });
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

async function main(argv) {
  const { options, selectedGraphs } = parseArgs(argv);
  ensureDirs(options.outDir);
  const report = {
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
