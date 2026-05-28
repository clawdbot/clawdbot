#!/usr/bin/env node

import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { formatErrorMessage } from "./lib/error-format.mjs";

const DEFAULT_CONCURRENCY = 6;
const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_COMBINED_TIMEOUT_MS = 180_000;
const DEFAULT_TOP = 10;
const RSS_MARKER = "__OPENCLAW_MAX_RSS_KB__=";

function printHelp() {
  console.log(`Usage: node scripts/profile-extension-memory.mjs [options]

Profiles peak RSS for built bundled plugin entrypoints.
Run pnpm build first if you want stats for the latest source changes.

Options:
  --extension, -e <id>     Limit profiling to one or more extension ids (repeatable)
  --concurrency <n>        Number of per-extension workers (default: ${DEFAULT_CONCURRENCY})
  --timeout-ms <ms>        Per-extension timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS})
  --combined-timeout-ms <ms>
                           Combined-import timeout in milliseconds (default: ${DEFAULT_COMBINED_TIMEOUT_MS})
  --top <n>                Show top N entries by delta from baseline (default: ${DEFAULT_TOP})
  --json <path>            Write full JSON report to this path
  --skip-combined          Skip the combined all-imports measurement
  --help                   Show this help

Examples:
  pnpm test:extensions:memory
  pnpm test:extensions:memory -- --extension discord
  pnpm test:extensions:memory -- --extension discord --extension telegram --skip-combined
`);
}

function parsePositiveInt(raw, flagName) {
  const text = String(raw ?? "").trim();
  if (!/^\d+$/u.test(text)) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  const parsed = Number(text);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${flagName} must be a positive integer`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    extensions: [],
    concurrency: DEFAULT_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    combinedTimeoutMs: DEFAULT_COMBINED_TIMEOUT_MS,
    top: DEFAULT_TOP,
    jsonPath: null,
    skipCombined: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--extension":
      case "-e": {
        const next = argv[index + 1];
        if (!next) {
          throw new Error(`${arg} requires a value`);
        }
        options.extensions.push(next);
        index += 1;
        break;
      }
      case "--concurrency":
        options.concurrency = parsePositiveInt(argv[index + 1], arg);
        index += 1;
        break;
      case "--timeout-ms":
        options.timeoutMs = parsePositiveInt(argv[index + 1], arg);
        index += 1;
        break;
      case "--combined-timeout-ms":
        options.combinedTimeoutMs = parsePositiveInt(argv[index + 1], arg);
        index += 1;
        break;
      case "--top":
        options.top = parsePositiveInt(argv[index + 1], arg);
        index += 1;
        break;
      case "--json": {
        const next = argv[index + 1];
        if (!next) {
          throw new Error(`${arg} requires a value`);
        }
        options.jsonPath = path.resolve(next);
        index += 1;
        break;
      }
      case "--skip-combined":
        options.skipCombined = true;
        break;
      case "--help":
      case "-h":
        printHelp();
        process.exit(0);
      default:
        throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return options;
}

function parseMaxRssMb(stderr) {
  const matches = [...stderr.matchAll(new RegExp(`^${RSS_MARKER}(\\d+)\\s*$`, "gm"))];
  const last = matches.at(-1);
  return last ? Number(last[1]) / 1024 : null;
}

function summarizeStderr(stderr, lines = 8) {
  return stderr.trim().split("\n").filter(Boolean).slice(0, lines).join("\n");
}

async function runCase({ repoRoot, env, hookPath, name, body, timeoutMs }) {
  return await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ["--import", hookPath, "--input-type=module", "--eval", body],
      {
        cwd: repoRoot,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({
        name,
        code,
        signal,
        timedOut,
        stdout,
        stderr,
        maxRssMb: parseMaxRssMb(stderr),
      });
    });
  });
}

function buildImportBody(entryFiles, label) {
  const imports = entryFiles
    .map((filePath) => `await import(${JSON.stringify(filePath)});`)
    .join("\n");
  return `${imports}\nconsole.log(${JSON.stringify(label)});\nprocess.exit(0);\n`;
}

function findExtensionEntries(repoRoot) {
  const extensionsDir = path.join(repoRoot, "dist", "extensions");
  if (!existsSync(extensionsDir)) {
    throw new Error("dist/extensions not found. Run pnpm build first.");
  }

  const entries = readdirSync(extensionsDir)
    .map((dir) => ({ dir, file: path.join(extensionsDir, dir, "index.js") }))
    .filter((entry) => existsSync(entry.file))
    .toSorted((a, b) => a.dir.localeCompare(b.dir));

  if (entries.length === 0) {
    throw new Error("No built bundled plugin entrypoints found in the dist plugin tree");
  }
  return entries;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = process.cwd();
  const allEntries = findExtensionEntries(repoRoot);
  const selectedEntries =
    options.extensions.length === 0
      ? allEntries
      : allEntries.filter((entry) => options.extensions.includes(entry.dir));

  const missing = options.extensions.filter((id) => !allEntries.some((entry) => entry.dir === id));
  if (missing.length > 0) {
    throw new Error(`Unknown built extension ids: ${missing.join(", ")}`);
  }
  if (selectedEntries.length === 0) {
    throw new Error("No extensions selected for profiling");
  }

  const tmpHome = mkdtempSync(path.join(os.tmpdir(), "openclaw-extension-memory-"));
  const hookPath = path.join(tmpHome, "measure-rss.mjs");
  const jsonPath = options.jsonPath ?? path.join(os.tmpdir(), "openclaw-extension-memory.json");

  writeFileSync(
    hookPath,
    [
      "process.on('exit', () => {",
      "  const usage = typeof process.resourceUsage === 'function' ? process.resourceUsage() : null;",
      `  if (usage && typeof usage.maxRSS === 'number') console.error('${RSS_MARKER}' + String(usage.maxRSS));`,
      "});",
      "",
    ].join("\n"),
    "utf8",
  );

  const env = {
    ...process.env,
    HOME: tmpHome,
    USERPROFILE: tmpHome,
    XDG_CONFIG_HOME: path.join(tmpHome, ".config"),
    XDG_DATA_HOME: path.join(tmpHome, ".local", "share"),
    XDG_CACHE_HOME: path.join(tmpHome, ".cache"),
    NODE_DISABLE_COMPILE_CACHE: "1",
    OPENCLAW_NO_RESPAWN: "1",
    TERM: process.env.TERM ?? "dumb",
    LANG: process.env.LANG ?? "C.UTF-8",
  };

  try {
    const baseline = await runCase({
      repoRoot,
      env,
      hookPath,
      name: "baseline",
      body: "process.exit(0)",
      timeoutMs: options.timeoutMs,
    });

    const combined = options.skipCombined
      ? null
      : await runCase({
          repoRoot,
          env,
          hookPath,
          name: "combined",
          body: buildImportBody(
            selectedEntries.map((entry) => entry.file),
            "IMPORTED_ALL",
          ),
          timeoutMs: options.combinedTimeoutMs,
        });

    const pending = [...selectedEntries];
    const results = [];

    async function worker() {
      while (pending.length > 0) {
        const next = pending.shift();
        if (next === undefined) {
          return;
        }
        const result = await runCase({
          repoRoot,
          env,
          hookPath,
          name: next.dir,
          body: buildImportBody([next.file], "IMPORTED"),
          timeoutMs: options.timeoutMs,
        });
        results.push({
          dir: next.dir,
          file: next.file,
          status: result.timedOut ? "timeout" : result.code === 0 ? "ok" : "fail",
          maxRssMb: result.maxRssMb,
          deltaFromBaselineMb:
            result.maxRssMb !== null && baseline.maxRssMb !== null
              ? result.maxRssMb - baseline.maxRssMb
              : null,
          stderrPreview: summarizeStderr(result.stderr),
        });

        const status = result.timedOut ? "timeout" : result.code === 0 ? "ok" : "fail";
        const rss = result.maxRssMb === null ? "n/a" : `${result.maxRssMb.toFixed(1)} MB`;
        console.log(`[extension-memory] ${next.dir}: ${status} ${rss}`);
      }
    }

    await Promise.all(
      Array.from({ length: Math.min(options.concurrency, selectedEntries.length) }, () => worker()),
    );

    results.sort((a, b) => a.dir.localeCompare(b.dir));
    const top = results
      .filter((entry) => entry.status === "ok" && typeof entry.deltaFromBaselineMb === "number")
      .toSorted((a, b) => (b.deltaFromBaselineMb ?? 0) - (a.deltaFromBaselineMb ?? 0))
      .slice(0, options.top);

    const report = {
      generatedAt: new Date().toISOString(),
      repoRoot,
      selectedExtensions: selectedEntries.map((entry) => entry.dir),
      baseline: {
        status: baseline.timedOut ? "timeout" : baseline.code === 0 ? "ok" : "fail",
        maxRssMb: baseline.maxRssMb,
      },
      combined:
        combined === null
          ? null
          : {
              status: combined.timedOut ? "timeout" : combined.code === 0 ? "ok" : "fail",
              maxRssMb: combined.maxRssMb,
              stderrPreview: summarizeStderr(combined.stderr, 12),
            },
      counts: {
        totalEntries: selectedEntries.length,
        ok: results.filter((entry) => entry.status === "ok").length,
        fail: results.filter((entry) => entry.status === "fail").length,
        timeout: results.filter((entry) => entry.status === "timeout").length,
      },
      options: {
        concurrency: options.concurrency,
        timeoutMs: options.timeoutMs,
        combinedTimeoutMs: options.combinedTimeoutMs,
        skipCombined: options.skipCombined,
      },
      topByDeltaMb: top,
      results,
    };

    writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

    console.log(`[extension-memory] report: ${jsonPath}`);
    console.log(
      JSON.stringify(
        {
          baselineMb: report.baseline.maxRssMb,
          combinedMb: report.combined?.maxRssMb ?? null,
          counts: report.counts,
          topByDeltaMb: report.topByDeltaMb,
        },
        null,
        2,
      ),
    );
  } finally {
    rmSync(tmpHome, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (error) {
  console.error(`[extension-memory] ${formatErrorMessage(error)}`);
  process.exit(1);
}
