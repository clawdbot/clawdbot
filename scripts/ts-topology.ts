#!/usr/bin/env node
// Ts Topology script supports OpenClaw repository automation.
import path from "node:path";
import { pathToFileURL } from "node:url";
import { expectDefined } from "../packages/normalization-core/src/expect.js";
import { formatErrorMessage } from "../src/infra/errors.ts";
import { parsePositiveInt } from "./lib/numeric-options.mjs";
import { analyzeTopology } from "./lib/ts-topology/analyze.js";
import { renderTextReport } from "./lib/ts-topology/reports.js";
import {
  createFilesystemPublicSurfaceScope,
  createPluginSdkScope,
} from "./lib/ts-topology/scope.js";
import type { TopologyReportName, TopologyScope } from "./lib/ts-topology/types.js";

const VALID_REPORTS = new Set<TopologyReportName>([
  "public-surface-usage",
  "owner-map",
  "single-owner-shared",
  "unused-public-surface",
  "consumer-topology",
]);

type IoLike = {
  stdout: { write: (chunk: string) => void };
  stderr: { write: (chunk: string) => void };
};

type CliOptions = {
  repoRoot: string;
  scopeId: string;
  report: TopologyReportName;
  json: boolean;
  includeTests: boolean;
  limit: number;
  tsconfigName?: string;
  customEntrypointRoot?: string;
  customImportPrefix?: string;
};

function usage() {
  return [
    "Usage: ts-topology [analyze] [options]",
    "",
    "Options:",
    "  --scope=<plugin-sdk|custom>         Built-in or custom scope",
    "  --entrypoint-root=<path>            Required for --scope=custom",
    "  --import-prefix=<specifier>         Required for --scope=custom",
    "  --report=<name>                     public-surface-usage | owner-map | single-owner-shared | unused-public-surface | consumer-topology",
    "  --json                              Emit JSON",
    "  --limit=<n>                         Limit ranked/text output (default: 25)",
    "  --exclude-tests                     Ignore test consumers",
    "  --repo-root=<path>                  Override repo root",
    "  --tsconfig=<name>                   Override tsconfig filename",
  ].join("\n");
}

function parseArgs(argv: string[]): CliOptions {
  const args = [...argv];
  if (args[0] === "analyze") {
    args.shift();
  }
  const options: CliOptions = {
    repoRoot: process.cwd(),
    scopeId: "plugin-sdk",
    report: "public-surface-usage",
    json: false,
    includeTests: true,
    limit: 25,
  };

  for (const arg of args) {
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--exclude-tests") {
      options.includeTests = false;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      throw new Error(usage());
    }
    const [flag, value] = arg.split("=", 2);
    switch (flag) {
      case "--scope":
        options.scopeId = value ?? options.scopeId;
        break;
      case "--report":
        options.report = (value as TopologyReportName | undefined) ?? options.report;
        break;
      case "--limit":
        options.limit = parsePositiveInt(expectDefined(value, "--limit value"), "--limit");
        break;
      case "--repo-root":
        options.repoRoot = path.resolve(value ?? options.repoRoot);
        break;
      case "--entrypoint-root":
        options.customEntrypointRoot = value;
        break;
      case "--import-prefix":
        options.customImportPrefix = value;
        break;
      case "--tsconfig":
        options.tsconfigName = value;
        break;
      default:
        throw new Error(`Unknown argument: ${arg}\n\n${usage()}`);
    }
  }
  return options;
}

function resolveScope(options: CliOptions): TopologyScope {
  if (options.scopeId === "plugin-sdk") {
    return createPluginSdkScope(options.repoRoot);
  }
  if (options.scopeId === "custom") {
    if (!options.customEntrypointRoot || !options.customImportPrefix) {
      throw new Error("--scope=custom requires --entrypoint-root and --import-prefix");
    }
    return createFilesystemPublicSurfaceScope(options.repoRoot, {
      id: "custom",
      entrypointRoot: options.customEntrypointRoot,
      importPrefix: options.customImportPrefix,
    });
  }
  throw new Error(`Unsupported scope: ${options.scopeId}`);
}

function assertValidReport(report: string): asserts report is TopologyReportName {
  if (!VALID_REPORTS.has(report as TopologyReportName)) {
    throw new Error(
      `Unsupported report: ${report}\nValid reports: ${[...VALID_REPORTS].join(", ")}`,
    );
  }
}

export async function main(argv: string[], io: IoLike = process): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    io.stderr.write(`${formatErrorMessage(error)}\n`);
    return 1;
  }

  try {
    assertValidReport(options.report);
    const scope = resolveScope(options);
    const envelope = analyzeTopology({
      repoRoot: options.repoRoot,
      scope,
      report: options.report,
      includeTests: options.includeTests,
      limit: options.limit,
      tsconfigName: options.tsconfigName,
    });
    if (options.json) {
      io.stdout.write(`${JSON.stringify(envelope, null, 2)}\n`);
      return 0;
    }
    io.stdout.write(`${renderTextReport(envelope, options.limit)}\n`);
    return 0;
  } catch (error) {
    io.stderr.write(`${formatErrorMessage(error)}\n`);
    return 1;
  }
}

const entrypointPath = process.argv[1];
if (entrypointPath && import.meta.url === pathToFileURL(entrypointPath).href) {
  const exitCode = await main(process.argv.slice(2));
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
