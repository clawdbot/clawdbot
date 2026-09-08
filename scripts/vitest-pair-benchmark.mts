#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  assertSingleWorkflowAttempt,
  loadBenchmarkManifest,
  runVitestPairBenchmark,
  withTerminalManifest,
} from "./lib/vitest-pair-benchmark.mts";

function parseArgs(argv: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined) {
      throw new Error(`invalid argument near ${name ?? "<end>"}`);
    }
    values.set(name.slice(2), value);
  }
  const required = (name: string) => {
    const value = values.get(name);
    if (!value) {
      throw new Error(`--${name} is required`);
    }
    return value;
  };
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return {
    baselineDir: required("baseline"),
    baselineSha: required("baseline-sha"),
    candidateDir: required("candidate"),
    candidateSha: required("candidate-sha"),
    manifestPath:
      values.get("manifest") ?? path.join(scriptDir, "vitest-pair-benchmark-lanes.json"),
    outputDir: required("output"),
    pnpmBin: required("pnpm-bin"),
    runAttempt: required("run-attempt"),
    scratchDir: required("scratch"),
  };
}

const options = parseArgs(process.argv.slice(2));
await withTerminalManifest(options.outputDir, async () => {
  assertSingleWorkflowAttempt(options.runAttempt);
  await runVitestPairBenchmark({
    baselineDir: options.baselineDir,
    baselineSha: options.baselineSha,
    candidateDir: options.candidateDir,
    candidateSha: options.candidateSha,
    manifest: loadBenchmarkManifest(options.manifestPath),
    outputDir: options.outputDir,
    pnpmBin: options.pnpmBin,
    scratchDir: options.scratchDir,
  });
});
