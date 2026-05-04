#!/usr/bin/env -S pnpm tsx
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

interface Options {
  beta: string;
  model: string;
  providerMode: string;
  ref: string;
  repo: string;
  skipParallels: boolean;
  skipTelegram: boolean;
}

function usage(): string {
  return `Usage: pnpm release:beta-smoke -- --beta beta4 [options]

Options:
  --beta <beta|betaN|version>  Beta target. Default: beta
  --model <provider/model>     Parallels agent-turn model. Default: openai/gpt-5.4
  --provider-mode <mode>       Telegram workflow provider mode. Default: mock-openai
  --ref <ref>                  GitHub workflow dispatch ref. Default: main
  --repo <owner/repo>          GitHub repo. Default: openclaw/openclaw
  --skip-parallels             Only run Telegram workflow
  --skip-telegram              Only run Parallels beta validation
  -h, --help                   Show help
`;
}

function parseArgs(argv: string[]): Options {
  const options: Options = {
    beta: "beta",
    model: "openai/gpt-5.4",
    providerMode: "mock-openai",
    ref: "main",
    repo: "openclaw/openclaw",
    skipParallels: false,
    skipTelegram: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case "--":
        break;
      case "--beta":
        options.beta = requireValue(argv, ++i, arg);
        break;
      case "--model":
        options.model = requireValue(argv, ++i, arg);
        break;
      case "--provider-mode":
        options.providerMode = requireValue(argv, ++i, arg);
        break;
      case "--ref":
        options.ref = requireValue(argv, ++i, arg);
        break;
      case "--repo":
        options.repo = requireValue(argv, ++i, arg);
        break;
      case "--skip-parallels":
        options.skipParallels = true;
        break;
      case "--skip-telegram":
        options.skipTelegram = true;
        break;
      case "-h":
      case "--help":
        process.stdout.write(usage());
        process.exit(0);
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  return options;
}

function requireValue(argv: string[], index: number, flag: string): string {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function run(command: string, args: string[], input?: { capture?: boolean }): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: input?.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const stderr = result.stderr ? `\n${result.stderr}` : "";
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? "signal"}${stderr}`,
    );
  }
  return result.stdout ?? "";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

const TELEGRAM_BETA_WORKFLOW_FILE = "npm-telegram-beta-e2e.yml";

function resolveBetaVersion(beta: string): string {
  const value = beta.trim().replace(/^openclaw@/, "");
  if (/^\d{4}\.\d+\.\d+-beta\.\d+$/u.test(value)) {
    return value;
  }
  if (value === "beta") {
    return run("npm", ["view", "openclaw@beta", "version"], { capture: true }).trim();
  }
  const betaMatch = /^(?:beta)?(\d+)$/u.exec(value);
  if (!betaMatch) {
    return run("npm", ["view", `openclaw@${value}`, "version"], { capture: true }).trim();
  }
  const suffix = `-beta.${betaMatch[1]}`;
  const versions = JSON.parse(
    run("npm", ["view", "openclaw", "versions", "--json"], { capture: true }),
  ) as string[];
  const match = versions
    .filter((version) => version.endsWith(suffix))
    .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))
    .at(-1);
  if (!match) {
    throw new Error(`no openclaw registry version found for ${beta}`);
  }
  return match;
}

function timeoutCommand(): string {
  return run("bash", ["-lc", "command -v gtimeout || command -v timeout"], {
    capture: true,
  }).trim();
}

function runParallels(beta: string, model: string): void {
  const timeoutBin = timeoutCommand();
  const forwarded = [
    "pnpm",
    "test:parallels:npm-update",
    "--",
    "--beta-validation",
    beta,
    "--model",
    model,
    "--json",
  ];
  const command = [
    'set -a; source "$HOME/.profile" >/dev/null 2>&1 || true; set +a;',
    "exec",
    shellQuote(timeoutBin),
    "--foreground",
    "150m",
    ...forwarded.map(shellQuote),
  ].join(" ");
  run("bash", ["-lc", command]);
}

function ghJson(repo: string, pathSuffix: string): unknown {
  return JSON.parse(run("gh", ["api", `repos/${repo}/${pathSuffix}`], { capture: true }));
}

export function parseWorkflowRunIdFromOutput(output: string): string | undefined {
  return /\/actions\/runs\/(\d+)/u.exec(output)?.[1];
}

type WorkflowRunListEntry = {
  createdAt?: string;
  databaseId?: number | string;
};

function normalizeRunId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  return undefined;
}

export function selectNewestDispatchedRunId(params: {
  beforeIds: ReadonlySet<string>;
  runs: readonly WorkflowRunListEntry[];
}): string | undefined {
  return params.runs
    .filter((entry) => {
      const id = normalizeRunId(entry.databaseId);
      return id !== undefined && !params.beforeIds.has(id);
    })
    .toSorted((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))
    .map((entry) => normalizeRunId(entry.databaseId))
    .find((id): id is string => id !== undefined);
}

function listWorkflowDispatchRuns(repo: string, workflow: string): WorkflowRunListEntry[] {
  return JSON.parse(
    run(
      "gh",
      [
        "run",
        "list",
        "--repo",
        repo,
        "--workflow",
        workflow,
        "--event",
        "workflow_dispatch",
        "--limit",
        "50",
        "--json",
        "databaseId,createdAt",
      ],
      { capture: true },
    ),
  ) as WorkflowRunListEntry[];
}

async function findDispatchedWorkflowRunId(params: {
  beforeIds: ReadonlySet<string>;
  repo: string;
  workflow: string;
}): Promise<string> {
  for (let attempt = 0; attempt < 60; attempt++) {
    const runId = selectNewestDispatchedRunId({
      beforeIds: params.beforeIds,
      runs: listWorkflowDispatchRuns(params.repo, params.workflow),
    });
    if (runId) {
      return runId;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  throw new Error(`could not find dispatched run for ${params.workflow}`);
}

async function dispatchTelegram(options: Options, packageSpec: string): Promise<string> {
  const beforeIds = new Set(
    listWorkflowDispatchRuns(options.repo, TELEGRAM_BETA_WORKFLOW_FILE)
      .map((entry) => normalizeRunId(entry.databaseId))
      .filter((id): id is string => id !== undefined),
  );
  const output = run(
    "gh",
    [
      "workflow",
      "run",
      TELEGRAM_BETA_WORKFLOW_FILE,
      "--repo",
      options.repo,
      "--ref",
      options.ref,
      "-f",
      `package_spec=${packageSpec}`,
      "-f",
      `package_label=${packageSpec}`,
      "-f",
      `provider_mode=${options.providerMode}`,
    ],
    { capture: true },
  );
  const runId = parseWorkflowRunIdFromOutput(output);
  if (runId) {
    return runId;
  }
  return await findDispatchedWorkflowRunId({
    beforeIds,
    repo: options.repo,
    workflow: TELEGRAM_BETA_WORKFLOW_FILE,
  });
}

async function pollRun(repo: string, runId: string): Promise<void> {
  for (;;) {
    const info = ghJson(repo, `actions/runs/${runId}`) as {
      conclusion: string | null;
      html_url: string;
      status: string;
      updated_at: string;
    };
    console.log(
      `Telegram workflow ${runId}: ${info.status}${info.conclusion ? `/${info.conclusion}` : ""} updated=${info.updated_at}`,
    );
    if (info.status === "completed") {
      if (info.conclusion !== "success") {
        throw new Error(
          `Telegram workflow failed: ${info.conclusion ?? "unknown"} ${info.html_url}`,
        );
      }
      console.log(info.html_url);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 30_000));
  }
}

function downloadTelegramArtifact(repo: string, runId: string): string {
  const artifacts = (
    ghJson(repo, `actions/runs/${runId}/artifacts`) as {
      artifacts: Array<{ expired: boolean; name: string }>;
    }
  ).artifacts;
  const artifact = artifacts.find(
    (entry) => !entry.expired && entry.name.startsWith(`npm-telegram-beta-e2e-${runId}-`),
  );
  if (!artifact) {
    throw new Error(`no npm Telegram artifact found for run ${runId}`);
  }
  const outputDir = path.join(".artifacts", "qa-e2e", artifact.name);
  mkdirSync(outputDir, { recursive: true });
  run("gh", [
    "run",
    "download",
    runId,
    "--repo",
    repo,
    "--name",
    artifact.name,
    "--dir",
    outputDir,
  ]);
  return outputDir;
}

function findFile(root: string, basename: string): string {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const filePath = path.join(root, entry.name);
    if (entry.isFile() && entry.name === basename) {
      return filePath;
    }
    if (entry.isDirectory()) {
      const nested = findFile(filePath, basename);
      if (nested) {
        return nested;
      }
    }
  }
  return "";
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const version = resolveBetaVersion(options.beta);
  const packageSpec = `openclaw@${version}`;
  console.log(`Resolved beta target: ${packageSpec}`);

  if (!options.skipParallels) {
    runParallels(options.beta, options.model);
  }

  if (!options.skipTelegram) {
    const runId = await dispatchTelegram(options, packageSpec);
    await pollRun(options.repo, runId);
    const artifactDir = downloadTelegramArtifact(options.repo, runId);
    const report = findFile(artifactDir, "telegram-qa-report.md");
    if (report && existsSync(report)) {
      console.log(`\nTelegram report: ${report}\n`);
      console.log(readFileSync(report, "utf8"));
    }
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
