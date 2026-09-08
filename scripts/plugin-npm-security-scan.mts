import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  constrainPluginNpmSecurityScanReport,
  MAX_PUBLISHABLE_PLUGIN_PACKAGES,
  runPluginNpmSecurityScan,
  type PluginNpmSecurityScanReport,
} from "./lib/plugin-npm-security-scan.mts";

const MAX_EXPECTED_PACKAGES_JSON_BYTES = 256 * 1024;

type ParsedArgs = {
  artifactRoot: string;
  candidateSha: string;
  expectedPackages: unknown;
  outputPath: string;
  targetContextRef: string;
  toolingSha: string;
};

function parseArgs(argv: string[]): ParsedArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 2) {
    const name = argv[index];
    const value = argv[index + 1];
    if (!name?.startsWith("--") || value === undefined || values.has(name)) {
      throw new Error(`Invalid plugin npm security scan argument near ${name}.`);
    }
    values.set(name, value);
  }
  const artifactRoot = values.get("--artifact-root") ?? "";
  const candidateSha = values.get("--candidate-sha") ?? "";
  const expectedPackagesJson = values.get("--expected-packages-json") ?? "";
  const outputPath = values.get("--report") ?? "";
  const targetContextRef = values.get("--target-context-ref") ?? "";
  const toolingSha = values.get("--tooling-sha") ?? "";
  if (!artifactRoot) {
    throw new Error("--artifact-root is required.");
  }
  if (!/^[0-9a-f]{40}$/u.test(candidateSha)) {
    throw new Error("--candidate-sha must be a full lowercase commit SHA.");
  }
  if (!/^[0-9a-f]{40}$/u.test(toolingSha)) {
    throw new Error("--tooling-sha must be a full lowercase commit SHA.");
  }
  if (
    !expectedPackagesJson ||
    Buffer.byteLength(expectedPackagesJson, "utf8") > MAX_EXPECTED_PACKAGES_JSON_BYTES
  ) {
    throw new Error("--expected-packages-json is outside the byte limit.");
  }
  if (!outputPath) {
    throw new Error("--report is required.");
  }
  const expectedPackages = JSON.parse(expectedPackagesJson) as unknown;
  if (
    !Array.isArray(expectedPackages) ||
    expectedPackages.length > MAX_PUBLISHABLE_PLUGIN_PACKAGES
  ) {
    throw new Error("--expected-packages-json is not a bounded package inventory.");
  }
  return {
    artifactRoot: resolve(artifactRoot),
    candidateSha,
    expectedPackages,
    outputPath: resolve(outputPath),
    targetContextRef,
    toolingSha,
  };
}

async function writeReport(outputPath: string, report: PluginNpmSecurityScanReport): Promise<void> {
  const constrained = constrainPluginNpmSecurityScanReport(report);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(constrained)}\n`, "utf8");
}

function sanitizeErrorMessage(error: unknown, args: ParsedArgs | undefined): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [path, replacement] of [
    [args?.artifactRoot, "<artifacts>"],
    [args?.outputPath ? dirname(args.outputPath) : undefined, "<report-dir>"],
    [process.cwd(), "<tooling>"],
  ] as const) {
    if (path) {
      message = message.replaceAll(path, replacement);
    }
  }
  return message
    .replaceAll(/\/(?:private\/)?tmp\/openclaw-plugin-npm-scan-[^/\s:]+/gu, "<scanner-stage>")
    .replaceAll(/(^|[\s:(])\/[^ \t\n\r:,)\]}]+/gu, "$1<path>");
}

function failureReport(args: ParsedArgs, message: string): PluginNpmSecurityScanReport {
  return {
    candidateSha: args.candidateSha,
    errors: [message],
    layout: null,
    packages: [],
    scanScope: "supplemental-inert-package-input",
    schemaVersion: 1,
    status: "fail",
    summary: {
      findingCount: 0,
      packageCount: 0,
      reviewedCriticalFindingCount: 0,
      unexpectedCriticalFindingCount: 0,
    },
    toolingSha: args.toolingSha,
  };
}

async function main(argv = process.argv.slice(2)): Promise<number> {
  let args: ParsedArgs | undefined;
  try {
    args = parseArgs(argv);
    const report = await runPluginNpmSecurityScan({
      artifactRoot: args.artifactRoot,
      candidateSha: args.candidateSha,
      expectedPackages: args.expectedPackages,
      targetContextRef: args.targetContextRef,
      toolingDir: process.cwd(),
      toolingSha: args.toolingSha,
    });
    await writeReport(args.outputPath, report);
    console.log(
      `Plugin npm security scan ${report.status}: ${report.summary.packageCount} packages, layout=${report.layout ?? "unknown"}, candidate=${report.candidateSha}, tooling=${report.toolingSha}`,
    );
    for (const error of report.errors) {
      console.error(`- ${error}`);
    }
    return report.status === "pass" ? 0 : 1;
  } catch (error) {
    const message = sanitizeErrorMessage(error, args);
    console.error(`Plugin npm security scan failed: ${message}`);
    if (args) {
      await writeReport(args.outputPath, failureReport(args, message));
    }
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  process.exitCode = await main();
}
