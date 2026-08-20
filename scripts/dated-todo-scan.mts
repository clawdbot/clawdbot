#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, resolve } from "node:path";

const DEFAULT_OUTPUT = ".artifacts/dated-todo-candidates.json";
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_CANDIDATES = 5_000;
const TEXT_EXTENSIONS = new Set([
  ".bash",
  ".cjs",
  ".css",
  ".cts",
  ".go",
  ".html",
  ".java",
  ".js",
  ".json",
  ".jsx",
  ".kt",
  ".kts",
  ".md",
  ".mdx",
  ".mjs",
  ".mts",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".scss",
  ".sh",
  ".swift",
  ".toml",
  ".ts",
  ".tsx",
  ".xml",
  ".yaml",
  ".yml",
  ".zsh",
]);
const EXCLUDED_SEGMENTS = new Set([
  ".artifacts",
  ".generated",
  ".git",
  ".i18n",
  ".next",
  "__fixtures__",
  "build",
  "coverage",
  "dist",
  "dist-runtime",
  "fixtures",
  "generated",
  "i18n",
  "locales",
  "node_modules",
  "test-fixtures",
  "translations",
  "vendor",
]);
const EXCLUDED_BASENAMES = new Set([
  "bun.lock",
  "bun.lockb",
  "CHANGELOG.md",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
]);
const TODO_PATTERN =
  /\b(?:TODO|FIXME|HACK|removeAfter|remove\s+after|delete\s+after|until|deadline|expires?|expiry|expiration|deprecated|deprecation|window|re-?enable|temporary)\b/iu;
const DATE_PATTERN =
  /(?:\b20\d{2}-\d{2}-\d{2}(?=\b|T)|\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(?:\d{1,2}(?:st|nd|rd|th)?(?:,\s*|\s+))?20\d{2}\b)/iu;
const ISO_DATE_PREFILTER = String.raw`20[0-9]{2}-[0-9]{2}-[0-9]{2}`;
const MONTH_DATE_PREFILTER = String.raw`(Jan(uary)?|Feb(ruary)?|Mar(ch)?|Apr(il)?|May|Jun(e)?|Jul(y)?|Aug(ust)?|Sep(t(ember)?)?|Oct(ober)?|Nov(ember)?|Dec(ember)?)\s+([0-9]{1,2}(st|nd|rd|th)?(,\s*|\s+))?20[0-9]{2}`;
const GIT_MONTH_DATE_PREFILTER = MONTH_DATE_PREFILTER.replaceAll(String.raw`\s`, "[[:space:]]");

type ScanOptions = { root: string; output: string; compatReport?: string };
type LoadedFile = { file: string; lines: string[] };
type Candidate = {
  file: string;
  line: number;
  text: string;
  source: "scan" | "compat-registry";
};
type CompatRecord = {
  code?: unknown;
  removeAfter?: unknown;
  replacement?: unknown;
  status?: unknown;
};
type CompatReport = { compat?: { records?: CompatRecord[] } };

function parseArgs(argv: string[]): ScanOptions {
  const options: ScanOptions = {
    root: process.cwd(),
    output: DEFAULT_OUTPUT,
    compatReport: undefined,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(
        "Usage: node --import tsx scripts/dated-todo-scan.mts [--root <dir>] [--output <path>] [--compat-report <path>]\n",
      );
      process.exit(0);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (arg === "--root") {
      options.root = value;
    } else if (arg === "--output") {
      options.output = value;
    } else if (arg === "--compat-report") {
      options.compatReport = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
    index += 1;
  }
  options.root = resolve(options.root);
  options.output = resolve(options.root, options.output);
  if (options.compatReport) {
    options.compatReport = resolve(options.root, options.compatReport);
  }
  return options;
}

function run(command: string, args: string[], cwd: string, maxBuffer = 32 * 1024 * 1024): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    maxBuffer,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Failed to run ${command}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed (${result.status ?? "unknown"}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout;
}

function runGitGrep(root: string, paths: string[]): string {
  const result = spawnSync(
    "git",
    [
      "grep",
      "-l",
      "-I",
      "-i",
      "-E",
      "-e",
      ISO_DATE_PREFILTER,
      "-e",
      GIT_MONTH_DATE_PREFILTER,
      "--",
      ...paths,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error) {
    throw new Error(`Failed to run git grep: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`git grep failed (${result.status ?? "unknown"}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function runDatePrefilter(root: string, paths: string[]): string {
  const result = spawnSync(
    "rg",
    [
      "-l",
      "-i",
      "--hidden",
      "--no-ignore",
      "--no-messages",
      "-e",
      ISO_DATE_PREFILTER,
      "-e",
      MONTH_DATE_PREFILTER,
      "--glob",
      "!.git/**",
      "--glob",
      "!.i18n/**",
      "--glob",
      "!node_modules/**",
      "--glob",
      "!dist/**",
      "--glob",
      "!dist-runtime/**",
      ...[...EXCLUDED_SEGMENTS].flatMap((segment) => ["--glob", `!**/${segment}/**`]),
      ...paths,
    ],
    {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 32 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.error && "code" in result.error && result.error.code === "ENOENT") {
    return runGitGrep(root, paths);
  }
  if (result.error) {
    throw new Error(`Failed to run rg: ${result.error.message}`);
  }
  if (result.status !== 0 && result.status !== 1) {
    throw new Error(`rg failed (${result.status ?? "unknown"}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

function isScannablePath(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const name = basename(normalized);
  return (
    TEXT_EXTENSIONS.has(extname(name).toLowerCase()) &&
    !EXCLUDED_BASENAMES.has(name) &&
    !parts.some((part) => EXCLUDED_SEGMENTS.has(part)) &&
    !/(?:^|[.-])generated(?:[.-]|$)/iu.test(name) &&
    !/(?:^|[.-])api-baseline(?:[.-]|$)/iu.test(name)
  );
}

function compactText(lines: string[]): string {
  return [...new Set(lines.map((line) => line.trim()).filter(Boolean))]
    .join(" | ")
    .replaceAll(/\s+/gu, " ")
    .slice(0, 500);
}

function loadFiles(root: string, files: string[]): LoadedFile[] {
  return files
    .filter(Boolean)
    .filter(isScannablePath)
    .toSorted()
    .flatMap((file) => {
      const absolutePath = resolve(root, file);
      if (statSync(absolutePath).size > MAX_FILE_BYTES) {
        return [];
      }
      return [
        {
          file: file.replaceAll("\\", "/"),
          lines: readFileSync(absolutePath, "utf8").split(/\r?\n/u),
        },
      ];
    });
}

function loadPrefilteredFiles(root: string): LoadedFile[] {
  const tracked = new Set(
    run("git", ["ls-files", "--cached", "-z"], root)
      .split("\0")
      .filter((file) => file && isScannablePath(file)),
  );
  const files = runDatePrefilter(root, ["."])
    .split("\n")
    .map((file) => file.replace(/^\.\//u, ""))
    .filter((file) => tracked.has(file));
  return loadFiles(root, files);
}

function loadCompatFiles(root: string): LoadedFile[] {
  const output = run("git", ["ls-files", "--cached", "-z", "--", "src/plugins/compat"], root);
  return loadFiles(root, output.split("\0"));
}

function collectScanCandidates(files: LoadedFile[]): Candidate[] {
  const candidates: Candidate[] = [];
  for (const { file, lines } of files) {
    for (let index = 0; index < lines.length; index += 1) {
      if (!TODO_PATTERN.test(lines[index] ?? "")) {
        continue;
      }
      const nearbyDates: string[] = [];
      for (
        let nearby = Math.max(0, index - 1);
        nearby <= Math.min(lines.length - 1, index + 1);
        nearby += 1
      ) {
        if (DATE_PATTERN.test(lines[nearby] ?? "")) {
          nearbyDates.push(lines[nearby] ?? "");
        }
      }
      if (nearbyDates.length === 0) {
        continue;
      }
      candidates.push({
        file,
        line: index + 1,
        text: compactText([lines[index] ?? "", ...nearbyDates]),
        source: "scan",
      });
    }
  }
  return candidates;
}

function readCompatReport(options: ScanOptions): CompatReport {
  if (options.compatReport) {
    return JSON.parse(readFileSync(options.compatReport, "utf8")) as CompatReport;
  }
  const reportScript = resolve(options.root, "scripts/plugin-boundary-report.ts");
  const output = run(
    process.execPath,
    ["--import", "tsx", reportScript, "--json"],
    options.root,
    16 * 1024 * 1024,
  );
  return JSON.parse(output) as CompatReport;
}

function findCompatLocation(code: string, files: LoadedFile[]): { file: string; line: number } {
  const escapedCode = code.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const codeField = new RegExp(`\\bcode\\s*:\\s*["']${escapedCode}["']`, "u");
  for (const { file, lines } of files) {
    const index = lines.findIndex((line) => codeField.test(line));
    if (index >= 0) {
      return { file, line: index + 1 };
    }
  }
  return { file: "src/plugins/compat/registry.ts", line: 1 };
}

function collectCompatCandidates(report: CompatReport, files: LoadedFile[]): Candidate[] {
  const records = report?.compat?.records;
  if (!Array.isArray(records)) {
    throw new Error("Plugin boundary report is missing compat.records");
  }
  const locationFiles = [...files].toSorted((left, right) => {
    const leftCompat = left.file.startsWith("src/plugins/compat/") ? 0 : 1;
    const rightCompat = right.file.startsWith("src/plugins/compat/") ? 0 : 1;
    return leftCompat - rightCompat || left.file.localeCompare(right.file);
  });
  return records
    .filter(
      (record) =>
        record?.status === "deprecated" &&
        typeof record.code === "string" &&
        typeof record.removeAfter === "string",
    )
    .map((record) => {
      const code = record.code as string;
      const removeAfter = record.removeAfter as string;
      const location = findCompatLocation(code, locationFiles);
      return {
        file: location.file,
        line: location.line,
        text: compactText([
          `${code}: removeAfter ${removeAfter}`,
          typeof record.replacement === "string" ? `replacement ${record.replacement}` : "",
        ]),
        source: "compat-registry",
      };
    });
}

function sortAndDeduplicate(candidates: Candidate[]): Candidate[] {
  const unique = new Map<string, Candidate>();
  for (const candidate of candidates) {
    unique.set(
      `${candidate.source}\0${candidate.file}\0${candidate.line}\0${candidate.text}`,
      candidate,
    );
  }
  return [...unique.values()].toSorted(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.source.localeCompare(right.source) ||
      left.text.localeCompare(right.text),
  );
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const scanCandidates = collectScanCandidates(loadPrefilteredFiles(options.root));
  const compatCandidates = collectCompatCandidates(
    readCompatReport(options),
    loadCompatFiles(options.root),
  );
  const candidates = sortAndDeduplicate([...scanCandidates, ...compatCandidates]);
  if (candidates.length > MAX_CANDIDATES) {
    throw new Error(
      `Dated TODO prefilter produced ${candidates.length} candidates, above the ${MAX_CANDIDATES} safety cap`,
    );
  }
  mkdirSync(dirname(options.output), { recursive: true });
  writeFileSync(options.output, `${JSON.stringify(candidates, null, 2)}\n`);
  process.stdout.write(
    `dated-todo-scan: wrote ${candidates.length} candidates (${scanCandidates.length} scan, ${compatCandidates.length} compat-registry) to ${options.output}\n`,
  );
}

try {
  main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`dated-todo-scan: ${message}\n`);
  process.exitCode = 1;
}
