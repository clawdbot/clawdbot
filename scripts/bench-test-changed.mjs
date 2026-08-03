// Benchmarks `pnpm test:changed` planning/runtime behavior across repeated runs.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseFlagArgs, stringFlag } from "./lib/arg-utils.mjs";
import { formatMs } from "./lib/vitest-report-cli-utils.mjs";

function parsePositiveInteger(raw, label) {
  const value = raw?.trim();
  if (!value) {
    throw new Error(`${label} requires a value`);
  }
  if (!/^\d+$/u.test(value)) {
    throw new Error(`${label} must be a positive integer`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a safe positive integer`);
  }
  return parsed;
}

function positiveIntegerFlag(flag, key) {
  return {
    consume(argv, index) {
      if (argv[index] !== flag) {
        return null;
      }
      const rawValue = argv[index + 1];
      if (!rawValue || rawValue.startsWith("--")) {
        throw new Error(`${flag} requires a value`);
      }
      return {
        flag,
        nextIndex: index + 1,
        repeatable: false,
        apply(target) {
          target[key] = parsePositiveInteger(rawValue, flag);
        },
      };
    },
  };
}

export function parseArgs(argv) {
  const args = parseFlagArgs(
    argv,
    {
      cwd: process.cwd(),
      ref: "origin/main",
      rss: process.platform === "darwin",
      mode: "ref",
    },
    [
      stringFlag("--cwd", "cwd"),
      stringFlag("--ref", "ref"),
      positiveIntegerFlag("--max-workers", "maxWorkers"),
    ],
    {
      onUnhandledArg(arg, target) {
        if (arg === "--no-rss") {
          target.rss = false;
          return "handled";
        }
        if (arg === "--worktree") {
          target.mode = "worktree";
          return "handled";
        }
        return undefined;
      },
    },
  );
  return {
    cwd: path.resolve(args.cwd),
    mode: args.mode,
    ref: args.ref,
    rss: args.rss,
    ...(typeof args.maxWorkers === "number" ? { maxWorkers: args.maxWorkers } : {}),
  };
}

function quoteArg(arg) {
  return /[^A-Za-z0-9_./:-]/.test(arg) ? JSON.stringify(arg) : arg;
}

function runGitList(args, cwd) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(" ")} failed`);
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function listChangedPaths(opts) {
  if (opts.mode === "worktree") {
    return [
      ...new Set([
        ...runGitList(["diff", "--name-only", "--relative", "HEAD", "--"], opts.cwd),
        ...runGitList(["ls-files", "--others", "--exclude-standard"], opts.cwd),
      ]),
    ].toSorted((left, right) => left.localeCompare(right));
  }
  return runGitList(["diff", "--name-only", `${opts.ref}...HEAD`], opts.cwd);
}

export function parseMaxRssBytes(output) {
  const match = output.match(
    /(?:^|\n)[^\S\r\n]*(\d+)[^\S\r\n]+maximum resident set size[^\S\r\n]*(?:\r?\n|$)/u,
  );
  if (!match) {
    return null;
  }
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

export function formatRss(valueBytes) {
  if (valueBytes === null) {
    return "n/a";
  }
  return `${(valueBytes / 1024 / 1024).toFixed(1)}MB`;
}

export function resolveBenchRssResult({ label, output, rss, status }) {
  if (!rss) {
    return { maxRssBytes: null, output, status };
  }
  const maxRssBytes = parseMaxRssBytes(output);
  if (status === 0 && maxRssBytes === null) {
    return {
      maxRssBytes,
      output: `${output}${output.endsWith("\n") ? "" : "\n"}[bench-test-changed] ${label} missing maximum resident set size from /usr/bin/time -l output\n`,
      status: 1,
    };
  }
  return { maxRssBytes, output, status };
}

function runBenchCommand(params) {
  const env = { ...process.env };
  if (typeof params.maxWorkers === "number") {
    env.OPENCLAW_VITEST_MAX_WORKERS = String(params.maxWorkers);
  }
  const startedAt = process.hrtime.bigint();
  const commandArgs = params.rss ? ["-l", ...params.command] : params.command;
  const result = spawnSync(
    params.rss ? "/usr/bin/time" : commandArgs[0],
    params.rss ? commandArgs : commandArgs.slice(1),
    {
      cwd: params.cwd,
      env,
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 32,
    },
  );
  const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  const normalized = resolveBenchRssResult({
    label: params.label,
    output,
    rss: params.rss,
    status: result.status ?? 1,
  });
  return {
    elapsedMs,
    maxRssBytes: normalized.maxRssBytes,
    status: normalized.status,
    output: normalized.output,
  };
}

function printRunSummary(label, result) {
  console.log(
    `${label.padEnd(8, " ")} wall=${formatMs(result.elapsedMs).padStart(9, " ")} rss=${formatRss(
      result.maxRssBytes,
    ).padStart(9, " ")}`,
  );
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  const changedPaths = listChangedPaths(opts);
  if (changedPaths.length === 0) {
    console.log(
      opts.mode === "worktree"
        ? "[bench-test-changed] no changed paths in worktree"
        : `[bench-test-changed] no changed paths for ${opts.ref}...HEAD`,
    );
    process.exit(0);
  }

  console.log(
    opts.mode === "worktree"
      ? "[bench-test-changed] mode=worktree"
      : `[bench-test-changed] ref=${opts.ref}`,
  );
  console.log("[bench-test-changed] changed paths:");
  for (const changedPath of changedPaths) {
    console.log(`- ${changedPath}`);
  }

  const routedCommand =
    opts.mode === "worktree"
      ? [process.execPath, "scripts/test-projects.mjs", ...changedPaths]
      : [process.execPath, "scripts/test-projects.mjs", "--changed", opts.ref];
  const rootCommand = [
    process.execPath,
    "scripts/run-vitest.mjs",
    "run",
    "--config",
    "vitest.config.ts",
    ...changedPaths,
  ];

  console.log(`[bench-test-changed] routed: ${routedCommand.map(quoteArg).join(" ")}`);
  const routed = runBenchCommand({
    command: routedCommand,
    cwd: opts.cwd,
    label: "routed",
    rss: opts.rss,
    ...(typeof opts.maxWorkers === "number" ? { maxWorkers: opts.maxWorkers } : {}),
  });
  if (routed.status !== 0) {
    process.stderr.write(routed.output);
    process.exit(routed.status);
  }

  console.log(`[bench-test-changed] root:   ${rootCommand.map(quoteArg).join(" ")}`);
  const root = runBenchCommand({
    command: rootCommand,
    cwd: opts.cwd,
    label: "root",
    rss: opts.rss,
    ...(typeof opts.maxWorkers === "number" ? { maxWorkers: opts.maxWorkers } : {}),
  });
  if (root.status !== 0) {
    process.stderr.write(root.output);
    process.exit(root.status);
  }

  printRunSummary("routed", routed);
  printRunSummary("root", root);
  console.log(
    `[bench-test-changed] delta wall=${formatMs(root.elapsedMs - routed.elapsedMs)} rss=${
      routed.maxRssBytes !== null && root.maxRssBytes !== null
        ? formatRss(root.maxRssBytes - routed.maxRssBytes)
        : "n/a"
    }`,
  );
}

const isMain =
  typeof process.argv[1] === "string" &&
  process.argv[1].length > 0 &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;

if (isMain) {
  main();
}
