#!/usr/bin/env -S pnpm tsx
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

export function parseArgs(argv: string[]): Options {
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
  if (options.skipParallels && options.skipTelegram) {
    throw new Error("--skip-parallels and --skip-telegram cannot be used together");
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

const CAPTURE_MAX_BUFFER_BYTES = 32 * 1024 * 1024;

function run(command: string, args: string[], input?: { capture?: boolean }): string {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: CAPTURE_MAX_BUFFER_BYTES,
    stdio: input?.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const reason = result.status ?? result.signal ?? result.error?.message ?? "unknown";
    const stderr = result.stderr ? `\n${result.stderr}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with ${reason}${stderr}`);
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
  created_at?: string;
  databaseId?: number | string;
  id?: number | string;
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
      const id = normalizeRunId(entry.databaseId ?? entry.id);
      return id !== undefined && !params.beforeIds.has(id);
    })
    .toSorted((a, b) =>
      (b.createdAt ?? b.created_at ?? "").localeCompare(a.createdAt ?? a.created_at ?? ""),
    )
    .map((entry) => normalizeRunId(entry.databaseId ?? entry.id))
    .find((id): id is string => id !== undefined);
}

function listWorkflowDispatchRuns(repo: string, workflow: string): WorkflowRunListEntry[] {
  const encodedWorkflow = encodeURIComponent(workflow);
  const response = ghJson(
    repo,
    `actions/workflows/${encodedWorkflow}/runs?event=workflow_dispatch&per_page=50`,
  ) as { workflow_runs?: WorkflowRunListEntry[] };
  return response.workflow_runs ?? [];
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
      .map((entry) => normalizeRunId(entry.databaseId ?? entry.id))
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

export function mergeTelegramProofIntoReleaseBody(body: string, telegramLine: string): string {
  if (body.includes(telegramLine)) {
    return body;
  }

  const marker = "### Release verification";
  const telegramProofPattern = /^- npm Telegram beta E2E: .*$/mu;
  if (telegramProofPattern.test(body)) {
    return body.replace(telegramProofPattern, telegramLine);
  }
  if (!body.includes(marker)) {
    return `${body.trimEnd()}\n\n${marker}\n\n${telegramLine}\n`;
  }

  const markerIndex = body.indexOf(marker);
  const afterMarkerIndex = markerIndex + marker.length;
  const nextHeading = /\n#{1,6} /u.exec(body.slice(afterMarkerIndex));
  const insertionIndex = nextHeading === null ? -1 : afterMarkerIndex + nextHeading.index;
  if (insertionIndex === -1) {
    return `${body.trimEnd()}\n${telegramLine}\n`;
  }
  return `${body.slice(0, insertionIndex).trimEnd()}\n${telegramLine}\n${body.slice(insertionIndex)}`;
}

function appendTelegramProofToRelease(repo: string, version: string, runId: string): void {
  const tag = `v${version}`;
  const release = ghJson(repo, `releases/tags/${encodeURIComponent(tag)}`) as {
    body?: string;
    html_url?: string;
  };
  const body = release.body ?? "";
  const telegramLine = `- npm Telegram beta E2E: https://github.com/${repo}/actions/runs/${runId}`;
  const notesFile = path.join(
    "/tmp",
    `openclaw-${version.replace(/[^a-zA-Z0-9.-]/g, "-")}-release-notes-${process.pid}.md`,
  );
  const nextBody = mergeTelegramProofIntoReleaseBody(body, telegramLine);
  if (nextBody === body) {
    return;
  }
  writeFileSync(notesFile, nextBody);
  run("gh", ["release", "edit", tag, "--repo", repo, "--notes-file", notesFile]);
  console.log(
    `Updated release proof: ${release.html_url ?? `https://github.com/${repo}/releases/tag/${tag}`}`,
  );
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const version = resolveBetaVersion(options.beta);
  const packageSpec = `openclaw@${version}`;
  console.log(`Resolved beta target: ${packageSpec}`);

  let telegramRunId: string | undefined;
  if (!options.skipTelegram) {
    telegramRunId = await dispatchTelegram(options, packageSpec);
    console.log(
      `Dispatched Telegram workflow: https://github.com/${options.repo}/actions/runs/${telegramRunId}`,
    );
  }

  if (!options.skipParallels) {
    runParallels(options.beta, options.model);
  }

  if (telegramRunId) {
    await pollRun(options.repo, telegramRunId);
    const artifactDir = downloadTelegramArtifact(options.repo, telegramRunId);
    const report = findFile(artifactDir, "telegram-qa-report.md");
    if (report && existsSync(report)) {
      console.log(`\nTelegram report: ${report}\n`);
      console.log(readFileSync(report, "utf8"));
    }
    appendTelegramProofToRelease(options.repo, version, telegramRunId);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
