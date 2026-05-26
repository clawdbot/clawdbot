#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const isLinux = process.platform === "linux";
const isMac = process.platform === "darwin";

if (!isLinux && !isMac) {
  console.log(`[startup-memory] Skipping on unsupported platform: ${process.platform}`);
  process.exit(0);
}

const repoRoot = process.cwd();
const tmpHome = mkdtempSync(path.join(os.tmpdir(), "openclaw-startup-memory-"));
const tmpDir = process.env.TMPDIR || process.env.TEMP || process.env.TMP || os.tmpdir();
const rssHookPath = path.join(tmpHome, "measure-rss.mjs");
const MAX_RSS_MARKER = "__OPENCLAW_MAX_RSS_KB__=";

function parseArgs(argv) {
  const options = {
    jsonPath:
      process.env.OPENCLAW_STARTUP_MEMORY_JSON_PATH ||
      path.join(repoRoot, ".artifacts", "startup-memory", "startup-memory.json"),
    summaryPath:
      process.env.OPENCLAW_STARTUP_MEMORY_SUMMARY_PATH ||
      path.join(repoRoot, ".artifacts", "startup-memory", "summary.md"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--json requires a path");
      }
      options.jsonPath = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--summary") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--summary requires a path");
      }
      options.summaryPath = path.resolve(value);
      index += 1;
      continue;
    }
    if (arg === "--help") {
      console.log(
        "Usage: node scripts/check-cli-startup-memory.mjs [--json <path>] [--summary <path>]",
      );
      process.exit(0);
    }
    throw new Error(`Unknown option: ${arg}`);
  }
  return options;
}

writeFileSync(
  rssHookPath,
  [
    "process.on('exit', () => {",
    "  const usage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;",
    `  if (usage && typeof usage.maxRSS === 'number') console.error('${MAX_RSS_MARKER}' + String(usage.maxRSS));`,
    "});",
    "",
  ].join("\n"),
  "utf8",
);

const DEFAULT_LIMITS_MB = {
  help: 100,
  statusJson: 400,
  gatewayStatus: 500,
};

const cases = [
  {
    id: "help",
    label: "--help",
    args: ["openclaw.mjs", "--help"],
    limitMb: Number(process.env.OPENCLAW_STARTUP_MEMORY_HELP_MB ?? DEFAULT_LIMITS_MB.help),
  },
  {
    id: "statusJson",
    label: "status --json",
    args: ["openclaw.mjs", "status", "--json"],
    limitMb: Number(
      process.env.OPENCLAW_STARTUP_MEMORY_STATUS_JSON_MB ?? DEFAULT_LIMITS_MB.statusJson,
    ),
  },
  {
    id: "gatewayStatus",
    label: "gateway status",
    args: ["openclaw.mjs", "gateway", "status"],
    limitMb: Number(
      process.env.OPENCLAW_STARTUP_MEMORY_GATEWAY_STATUS_MB ?? DEFAULT_LIMITS_MB.gatewayStatus,
    ),
  },
];

function formatFixGuidance(testCase, details) {
  const command = `node ${testCase.args.join(" ")}`;
  const guidance = [
    "[startup-memory] Fix guidance",
    `Case: ${testCase.label}`,
    `Command: ${command}`,
    "Next steps:",
    `1. Run \`${command}\` locally on the built tree.`,
    "2. If this is an RSS overage, compare the startup import graph against the last passing commit and look for newly eager imports, bootstrap side effects, or plugin loading on the command path.",
    "3. If this is a non-zero exit, inspect the first transitive import/config error in stderr and fix that root cause before re-checking memory.",
    "LLM prompt:",
    `"OpenClaw startup-memory CI failed for '${testCase.label}'. Analyze this failure, identify the first runtime/import side effect that makes startup heavier or broken, and propose the smallest safe patch. Failure output:\n${details}"`,
  ];
  return `${guidance.join("\n")}\n`;
}

function formatFailure(testCase, message, details = "") {
  const trimmedDetails = details.trim();
  const sections = [message];
  if (trimmedDetails) {
    sections.push(trimmedDetails);
  }
  sections.push(formatFixGuidance(testCase, trimmedDetails || message));
  return sections.join("\n\n");
}

function parseMaxRssMb(stderr) {
  const matches = [...stderr.matchAll(new RegExp(`^${MAX_RSS_MARKER}(\\d+)\\s*$`, "gm"))];
  const lastMatch = matches.at(-1);
  if (!lastMatch) {
    return null;
  }
  return Number(lastMatch[1]) / 1024;
}

function formatMb(value) {
  return typeof value === "number" && Number.isFinite(value) ? `${value.toFixed(1)} MB` : "n/a";
}

function formatCaseCommand(testCase) {
  return `node ${testCase.args.join(" ")}`;
}

function buildBenchEnv() {
  const env = {
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, ".config"),
    XDG_DATA_HOME: path.join(tmpHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(tmpHome, ".cache"),
    PATH: process.env.PATH ?? "",
    TMPDIR: tmpDir,
    TEMP: tmpDir,
    TMP: tmpDir,
    LANG: process.env.LANG ?? "C.UTF-8",
    TERM: process.env.TERM ?? "dumb",
  };

  if (process.env.LC_ALL) {
    env.LC_ALL = process.env.LC_ALL;
  }
  if (process.env.CI) {
    env.CI = process.env.CI;
  }
  if (process.env.NODE_DISABLE_COMPILE_CACHE) {
    env.NODE_DISABLE_COMPILE_CACHE = process.env.NODE_DISABLE_COMPILE_CACHE;
  } else {
    // Keep the regression check focused on app/runtime startup, not Node's
    // one-shot compile cache overhead, which varies across runner builds.
    env.NODE_DISABLE_COMPILE_CACHE = "1";
  }
  // Keep the benchmark on a single process so RSS reflects the actual command
  // path rather than the warning-suppression respawn wrapper.
  env.OPENCLAW_NO_RESPAWN = "1";

  return env;
}

function runCase(testCase) {
  const env = buildBenchEnv();
  const result = spawnSync(process.execPath, ["--import", rssHookPath, ...testCase.args], {
    cwd: repoRoot,
    env,
    encoding: "utf8",
    maxBuffer: 20 * 1024 * 1024,
  });
  const stderr = result.stderr ?? "";
  const maxRssMb = parseMaxRssMb(stderr);
  const matrixBootstrapWarning = /matrix: crypto runtime bootstrap failed/i.test(stderr);
  const report = {
    id: testCase.id,
    label: testCase.label,
    command: formatCaseCommand(testCase),
    limitMb: testCase.limitMb,
    maxRssMb,
    status: "pass",
    exitCode: result.status,
    error: null,
  };

  if (result.status !== 0) {
    report.status = "fail";
    report.error = `${testCase.label} exited with ${String(result.status)}`;
    return Object.assign(report, {
      failureMessage: formatFailure(testCase, report.error, stderr.trim() || result.stdout || ""),
    });
  }
  if (maxRssMb == null) {
    report.status = "fail";
    report.error = `${testCase.label} did not report max RSS`;
    return Object.assign(report, {
      failureMessage: formatFailure(testCase, report.error, stderr),
    });
  }
  if (matrixBootstrapWarning) {
    report.status = "fail";
    report.error = `${testCase.label} triggered Matrix crypto bootstrap during startup`;
    return Object.assign(report, {
      failureMessage: formatFailure(testCase, report.error),
    });
  }
  if (maxRssMb > testCase.limitMb) {
    report.status = "fail";
    report.error = `${testCase.label} used ${maxRssMb.toFixed(1)} MB RSS (limit ${
      testCase.limitMb
    } MB)`;
    return Object.assign(report, {
      failureMessage: formatFailure(testCase, report.error),
    });
  }

  console.log(
    `[startup-memory] ${testCase.label}: ${maxRssMb.toFixed(1)} MB RSS (limit ${testCase.limitMb} MB)`,
  );
  return report;
}

function writeReport(options, results) {
  const failed = results.filter((result) => result.status !== "pass");
  const report = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    repoRoot,
    status: failed.length === 0 ? "pass" : "fail",
    results: results.map(({ failureMessage: _failureMessage, ...result }) => result),
  };
  const lines = [
    "# OpenClaw Startup Memory",
    "",
    `Generated: ${report.generatedAt}`,
    "",
    `Status: ${report.status}`,
    "",
    ...results.map(
      (result) =>
        `- ${result.label}: ${result.status} RSS ${formatMb(result.maxRssMb)} / ${formatMb(
          result.limitMb,
        )}`,
    ),
    "",
  ];
  if (failed.length > 0) {
    lines.push(
      "## Failures",
      "",
      ...failed.map((result) => `- ${result.label}: ${result.error ?? "unknown failure"}`),
      "",
    );
  }
  mkdirSync(path.dirname(options.jsonPath), { recursive: true });
  mkdirSync(path.dirname(options.summaryPath), { recursive: true });
  writeFileSync(options.jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(options.summaryPath, `${lines.join("\n")}\n`, "utf8");
}

const options = parseArgs(process.argv.slice(2));
const results = [];
try {
  for (const testCase of cases) {
    results.push(runCase(testCase));
  }
} finally {
  writeReport(options, results);
  rmSync(tmpHome, { recursive: true, force: true });
}

const failure = results.find((result) => result.status !== "pass");
if (failure?.failureMessage) {
  throw new Error(failure.failureMessage);
}
