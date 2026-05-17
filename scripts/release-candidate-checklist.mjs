#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_REPO = "openclaw/openclaw";
const DEFAULT_PROVIDER = "openai";
const DEFAULT_MODE = "both";
const DEFAULT_RELEASE_PROFILE = "beta";
const DEFAULT_NPM_DIST_TAG = "beta";
const DEFAULT_PLUGIN_SCOPE = "all-publishable";
const DEFAULT_TELEGRAM_PROVIDER_MODE = "mock-openai";

function usage() {
  return `Usage: pnpm release:candidate -- --tag vYYYY.M.D-beta.N [options]

Dispatches or consumes release validation runs, validates the prepared npm tarball,
builds plugin publish plans, writes a green evidence bundle, then prints the exact
OpenClaw Release Publish command only after everything is green.

Options:
  --tag <tag>                         Release tag to validate.
  --workflow-ref <ref>                Workflow branch/ref. Default: current branch.
  --repo <owner/repo>                 GitHub repo. Default: ${DEFAULT_REPO}
  --full-release-run <id>             Reuse successful Full Release Validation run.
  --npm-preflight-run <id>            Reuse successful OpenClaw NPM Release preflight run.
  --skip-dispatch                     Require both run ids; do not dispatch workflows.
  --skip-local-generated-check        Do not run local generated release baseline checks before dispatch.
  --skip-parallels                   Do not run local Parallels fresh/update beta smoke.
  --skip-telegram                    Do not run NPM Telegram E2E against the prepared tarball.
  --telegram-provider-mode <mode>     mock-openai|live-frontier. Default: ${DEFAULT_TELEGRAM_PROVIDER_MODE}
  --provider <provider>               Full validation provider. Default: ${DEFAULT_PROVIDER}
  --mode <fresh|upgrade|both>         Full validation cross-OS mode. Default: ${DEFAULT_MODE}
  --release-profile <beta|stable|full> Default: ${DEFAULT_RELEASE_PROFILE}
  --npm-dist-tag <alpha|beta|latest>  Default: ${DEFAULT_NPM_DIST_TAG}
  --plugin-publish-scope <scope>      selected|all-publishable. Default: ${DEFAULT_PLUGIN_SCOPE}
  --plugins <names>                   Required when plugin scope is selected.
  --output-dir <dir>                  Evidence output dir. Default: .artifacts/release-candidate/<tag>
`;
}

function requireValue(argv, index, flag) {
  const value = argv[index];
  if (!value || value.startsWith("-")) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

export function parseArgs(argv) {
  const options = {
    repo: DEFAULT_REPO,
    provider: DEFAULT_PROVIDER,
    mode: DEFAULT_MODE,
    releaseProfile: DEFAULT_RELEASE_PROFILE,
    npmDistTag: DEFAULT_NPM_DIST_TAG,
    pluginPublishScope: DEFAULT_PLUGIN_SCOPE,
    plugins: "",
    skipDispatch: false,
    skipLocalGeneratedCheck: false,
    skipParallels: false,
    skipTelegram: false,
    telegramProviderMode: DEFAULT_TELEGRAM_PROVIDER_MODE,
    tag: "",
    workflowRef: "",
    fullReleaseRunId: "",
    npmPreflightRunId: "",
    outputDir: "",
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    switch (arg) {
      case "--":
        break;
      case "--tag":
        options.tag = requireValue(argv, ++index, arg);
        break;
      case "--workflow-ref":
        options.workflowRef = requireValue(argv, ++index, arg);
        break;
      case "--repo":
        options.repo = requireValue(argv, ++index, arg);
        break;
      case "--full-release-run":
        options.fullReleaseRunId = requireValue(argv, ++index, arg);
        break;
      case "--npm-preflight-run":
        options.npmPreflightRunId = requireValue(argv, ++index, arg);
        break;
      case "--skip-dispatch":
        options.skipDispatch = true;
        break;
      case "--skip-local-generated-check":
        options.skipLocalGeneratedCheck = true;
        break;
      case "--skip-parallels":
        options.skipParallels = true;
        break;
      case "--skip-telegram":
        options.skipTelegram = true;
        break;
      case "--telegram-provider-mode":
        options.telegramProviderMode = requireValue(argv, ++index, arg);
        break;
      case "--provider":
        options.provider = requireValue(argv, ++index, arg);
        break;
      case "--mode":
        options.mode = requireValue(argv, ++index, arg);
        break;
      case "--release-profile":
        options.releaseProfile = requireValue(argv, ++index, arg);
        break;
      case "--npm-dist-tag":
        options.npmDistTag = requireValue(argv, ++index, arg);
        break;
      case "--plugin-publish-scope":
        options.pluginPublishScope = requireValue(argv, ++index, arg);
        break;
      case "--plugins":
        options.plugins = requireValue(argv, ++index, arg);
        break;
      case "--output-dir":
        options.outputDir = requireValue(argv, ++index, arg);
        break;
      case "-h":
      case "--help":
        process.stdout.write(usage());
        process.exit(0);
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!options.tag) {
    throw new Error("--tag is required");
  }
  if (options.skipDispatch && (!options.fullReleaseRunId || !options.npmPreflightRunId)) {
    throw new Error("--skip-dispatch requires --full-release-run and --npm-preflight-run");
  }
  if (options.pluginPublishScope === "selected" && !options.plugins.trim()) {
    throw new Error("--plugin-publish-scope selected requires --plugins");
  }
  if (options.pluginPublishScope === "all-publishable" && options.plugins.trim()) {
    throw new Error("--plugins is only valid with --plugin-publish-scope selected");
  }
  if (!["mock-openai", "live-frontier"].includes(options.telegramProviderMode)) {
    throw new Error("--telegram-provider-mode must be mock-openai or live-frontier");
  }
  return options;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? result.signal}\n${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `${label} is invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function currentBranch() {
  return run("git", ["branch", "--show-current"], { capture: true }).trim();
}

function gitRevParse(ref) {
  return run("git", ["rev-parse", ref], { capture: true }).trim();
}

function workflowRuns(repo, workflowFile) {
  return JSON.parse(
    run(
      "gh",
      [
        "api",
        `repos/${repo}/actions/workflows/${workflowFile}/runs?event=workflow_dispatch&per_page=100`,
        "--jq",
        ".workflow_runs | map({databaseId:.id, workflowName:.name, event:.event, createdAt:.created_at})",
      ],
      { capture: true },
    ),
  );
}

function runArtifacts(repo, runId) {
  return JSON.parse(
    run(
      "gh",
      [
        "api",
        `repos/${repo}/actions/runs/${runId}/artifacts?per_page=100`,
        "--jq",
        ".artifacts | map({name:.name, expired:.expired})",
      ],
      { capture: true },
    ),
  );
}

export function resolveArtifactName(artifacts, preferredName, prefix) {
  const available = artifacts
    .filter((artifact) => artifact.expired !== true)
    .map((artifact) => artifact.name);
  if (available.includes(preferredName)) {
    return preferredName;
  }
  const candidates = available.filter((name) => name.startsWith(prefix));
  if (candidates.length === 1) {
    console.warn(`artifact ${preferredName} not found; using ${candidates[0]} from the same run`);
    return candidates[0];
  }
  const candidateList =
    available.length > 0 ? available.map((name) => `- ${name}`).join("\n") : "- <none>";
  throw new Error(
    `artifact ${preferredName} not found in run. Expected ${preferredName} or exactly one ${prefix}* fallback.\nAvailable artifacts:\n${candidateList}`,
  );
}

function resolveRunArtifactName(repo, runId, preferredName, prefix) {
  return resolveArtifactName(runArtifacts(repo, runId), preferredName, prefix);
}

function beforeRunIds(repo, workflowFile) {
  return new Set(workflowRuns(repo, workflowFile).map((run) => String(run.databaseId)));
}

function runAndEcho(command, args) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.stdout) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed with ${result.status ?? result.signal}\n${
        result.stderr ?? ""
      }`,
    );
  }
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function runLocalGeneratedCheckIfNeeded(options) {
  if (options.skipLocalGeneratedCheck) {
    return { status: "skipped", reason: "operator skipped --skip-local-generated-check" };
  }
  run("pnpm", ["release:generated:check"]);
  return { status: "passed", command: "pnpm release:generated:check" };
}

export function parseRunIdFromDispatchOutput(output) {
  return output.match(/actions\/runs\/([0-9]+)/u)?.[1] ?? "";
}

async function wait(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function findNewRunId(repo, workflowFile, workflowName, beforeIds) {
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const match = workflowRuns(repo, workflowFile)
      .filter(
        (run) =>
          run.workflowName === workflowName &&
          run.event === "workflow_dispatch" &&
          !beforeIds.has(String(run.databaseId)),
      )
      .toSorted((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")))[0];
    if (match?.databaseId) {
      return String(match.databaseId);
    }
    await wait(5_000);
  }
  throw new Error(`could not find dispatched ${workflowName} run`);
}

function dispatchWorkflow(repo, workflowFile, workflowRef, fields) {
  const args = ["workflow", "run", workflowFile, "--repo", repo, "--ref", workflowRef];
  for (const [key, value] of Object.entries(fields)) {
    args.push("-f", `${key}=${String(value)}`);
  }
  return parseRunIdFromDispatchOutput(runAndEcho("gh", args));
}

function runInfo(repo, runId) {
  return JSON.parse(
    run(
      "gh",
      [
        "run",
        "view",
        runId,
        "--repo",
        repo,
        "--json",
        "databaseId,workflowName,headBranch,headSha,event,status,conclusion,url,jobs",
      ],
      { capture: true },
    ),
  );
}

function pendingDeployments(repo, runId) {
  try {
    return JSON.parse(
      run("gh", ["api", "-X", "GET", `repos/${repo}/actions/runs/${runId}/pending_deployments`], {
        capture: true,
      }),
    );
  } catch {
    return [];
  }
}

function summarizePendingDeployments(repo, runId, deployments) {
  if (!Array.isArray(deployments) || deployments.length === 0) {
    return "";
  }
  return deployments
    .map((deployment) => {
      const environment = deployment.environment ?? {};
      return [
        `- pending approval: env=${environment.name ?? "<unknown>"} canApprove=${String(deployment.current_user_can_approve ?? "<unknown>")}`,
        `  approve: gh api -X POST repos/${repo}/actions/runs/${runId}/pending_deployments -F 'environment_ids[]=${environment.id ?? "<id>"}' -f state=approved -f comment='Approve release gate'`,
      ].join("\n");
    })
    .join("\n");
}

function summarizeFailedRun(info) {
  const failedJobs = (info.jobs ?? []).filter(
    (job) => job.conclusion && job.conclusion !== "success" && job.conclusion !== "skipped",
  );
  return [
    `${info.workflowName} ${info.databaseId} ended ${info.status}/${info.conclusion}: ${info.url}`,
    ...failedJobs.map((job) => `- ${job.name}: ${job.conclusion} ${job.url ?? ""}`),
  ].join("\n");
}

async function waitForSuccessfulRun(repo, runId, expected) {
  let lastState = "";
  for (;;) {
    const info = runInfo(repo, runId);
    const state = `${info.status}:${info.conclusion ?? ""}`;
    if (state !== lastState) {
      console.log(
        `${info.workflowName} ${runId}: ${info.status}${info.conclusion ? `/${info.conclusion}` : ""} ${info.url}`,
      );
      const pending = summarizePendingDeployments(repo, runId, pendingDeployments(repo, runId));
      if (pending) {
        console.log(pending);
      }
      lastState = state;
    }
    if (info.status === "completed") {
      if (info.conclusion !== "success") {
        throw new Error(summarizeFailedRun(info));
      }
      if (info.workflowName !== expected.workflowName) {
        throw new Error(
          `run ${runId} workflow mismatch: expected ${expected.workflowName}, got ${info.workflowName}`,
        );
      }
      if (info.headBranch !== expected.workflowRef) {
        throw new Error(
          `run ${runId} branch mismatch: expected ${expected.workflowRef}, got ${info.headBranch}`,
        );
      }
      return info;
    }
    await wait(30_000);
  }
}

function downloadArtifact(repo, runId, name, dir) {
  rmSync(dir, { force: true, recursive: true });
  mkdirSync(dir, { recursive: true });
  run("gh", ["run", "download", runId, "--repo", repo, "--name", name, "--dir", dir]);
}

function downloadResolvedArtifact(repo, runId, preferredName, prefix, dir) {
  const name = resolveRunArtifactName(repo, runId, preferredName, prefix);
  downloadArtifact(repo, runId, name, dir);
  return name;
}

function sha256(path) {
  return run("shasum", ["-a", "256", path], { capture: true }).trim().split(/\s+/u)[0] ?? "";
}

function pluginPlanArgs(options) {
  const args = ["--selection-mode", options.pluginPublishScope];
  if (options.pluginPublishScope === "selected") {
    args.push("--plugins", options.plugins);
  }
  return args;
}

function collectPluginPlan(script, options) {
  return JSON.parse(
    run("node", ["--import", "tsx", script, ...pluginPlanArgs(options)], { capture: true }),
  );
}

async function collectPluginPlanWithRetry(script, options) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return collectPluginPlan(script, options);
    } catch (error) {
      lastError = error;
      if (attempt === 3) {
        break;
      }
      console.warn(
        `${script} failed on attempt ${attempt}; retrying: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await wait(5_000 * attempt);
    }
  }
  throw lastError;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/gu, "'\\''")}'`;
}

export function buildPublishCommand(options) {
  const fields = [
    ["tag", options.tag],
    ["preflight_run_id", options.npmPreflightRunId],
    ["full_release_validation_run_id", options.fullReleaseRunId],
    ["npm_dist_tag", options.npmDistTag],
    ["plugin_publish_scope", options.pluginPublishScope],
    ["publish_openclaw_npm", "true"],
    ["release_profile", options.releaseProfile],
    ["wait_for_clawhub", "false"],
  ];
  if (options.npmTelegramRunId) {
    fields.push(["npm_telegram_run_id", options.npmTelegramRunId]);
  }
  if (options.plugins.trim()) {
    fields.push(["plugins", options.plugins]);
  }
  return [
    "gh",
    "workflow",
    "run",
    "openclaw-release-publish.yml",
    "--repo",
    options.repo,
    "--ref",
    options.workflowRef,
    ...fields.flatMap(([key, value]) => ["-f", `${key}=${value}`]),
  ]
    .map(shellQuote)
    .join(" ");
}

function validatePreflightManifest(manifest, params) {
  if (manifest.releaseTag !== params.tag) {
    throw new Error(
      `npm preflight tag mismatch: expected ${params.tag}, got ${manifest.releaseTag}`,
    );
  }
  if (manifest.releaseSha !== params.targetSha) {
    throw new Error(
      `npm preflight SHA mismatch: expected ${params.targetSha}, got ${manifest.releaseSha}`,
    );
  }
  if (manifest.npmDistTag !== params.npmDistTag) {
    throw new Error(
      `npm preflight dist-tag mismatch: expected ${params.npmDistTag}, got ${manifest.npmDistTag}`,
    );
  }
  if (!manifest.tarballName || !manifest.tarballSha256) {
    throw new Error("npm preflight manifest missing tarball metadata");
  }
}

function validateFullManifest(manifest, params) {
  if (manifest.workflowName !== "Full Release Validation") {
    throw new Error(`full validation workflow mismatch: ${manifest.workflowName}`);
  }
  if (manifest.targetSha !== params.targetSha) {
    throw new Error(
      `full validation SHA mismatch: expected ${params.targetSha}, got ${manifest.targetSha}`,
    );
  }
  if (manifest.releaseProfile !== params.releaseProfile) {
    throw new Error(
      `full validation profile mismatch: expected ${params.releaseProfile}, got ${manifest.releaseProfile}`,
    );
  }
  if (manifest.rerunGroup !== "all") {
    throw new Error(`full validation must use rerun_group=all, got ${manifest.rerunGroup}`);
  }
}

async function runParallelsIfNeeded(options) {
  if (options.skipParallels) {
    return { status: "skipped", reason: "operator skipped --skip-parallels" };
  }
  const version = options.tag.replace(/^v/u, "");
  run("pnpm", [
    "release:beta-smoke",
    "--",
    "--beta",
    version,
    "--ref",
    options.workflowRef,
    "--skip-telegram",
  ]);
  return {
    status: "passed",
    command: `pnpm release:beta-smoke -- --beta ${version} --ref ${options.workflowRef} --skip-telegram`,
  };
}

async function runTelegramIfNeeded(options, artifactName) {
  if (options.skipTelegram) {
    return { status: "skipped" };
  }
  const workflowFile = "npm-telegram-beta-e2e.yml";
  const before = beforeRunIds(options.repo, workflowFile);
  const dispatchedRunId = dispatchWorkflow(options.repo, workflowFile, options.workflowRef, {
    package_spec: `openclaw@${options.tag.replace(/^v/u, "")}`,
    package_label: options.tag,
    package_artifact_name: artifactName,
    package_artifact_run_id: options.npmPreflightRunId,
    harness_ref: options.workflowRef,
    provider_mode: options.telegramProviderMode,
  });
  const runId =
    dispatchedRunId ||
    (await findNewRunId(options.repo, workflowFile, "NPM Telegram Beta E2E", before));
  const run = await waitForSuccessfulRun(options.repo, runId, {
    workflowName: "NPM Telegram Beta E2E",
    workflowRef: options.workflowRef,
  });
  return {
    status: "passed",
    runId,
    url: run.url,
    artifactName,
    providerMode: options.telegramProviderMode,
  };
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  options.workflowRef ||= currentBranch();
  options.outputDir ||= join(".artifacts", "release-candidate", options.tag);
  const targetSha = gitRevParse(`${options.tag}^{}`);
  const localGeneratedCheck = runLocalGeneratedCheckIfNeeded(options);

  if (!options.fullReleaseRunId && !options.skipDispatch) {
    const workflowFile = "full-release-validation.yml";
    const before = beforeRunIds(options.repo, workflowFile);
    const dispatchedRunId = dispatchWorkflow(options.repo, workflowFile, options.workflowRef, {
      ref: options.tag,
      provider: options.provider,
      mode: options.mode,
      release_profile: options.releaseProfile,
      run_release_soak: options.releaseProfile === "full" ? "true" : "false",
      rerun_group: "all",
    });
    options.fullReleaseRunId =
      dispatchedRunId ||
      (await findNewRunId(options.repo, workflowFile, "Full Release Validation", before));
  }

  if (!options.npmPreflightRunId && !options.skipDispatch) {
    const workflowFile = "openclaw-npm-release.yml";
    const before = beforeRunIds(options.repo, workflowFile);
    const dispatchedRunId = dispatchWorkflow(options.repo, workflowFile, options.workflowRef, {
      tag: options.tag,
      preflight_only: "true",
      npm_dist_tag: options.npmDistTag,
    });
    options.npmPreflightRunId =
      dispatchedRunId ||
      (await findNewRunId(options.repo, workflowFile, "OpenClaw NPM Release", before));
  }

  const fullRun = await waitForSuccessfulRun(options.repo, options.fullReleaseRunId, {
    workflowName: "Full Release Validation",
    workflowRef: options.workflowRef,
  });
  const npmRun = await waitForSuccessfulRun(options.repo, options.npmPreflightRunId, {
    workflowName: "OpenClaw NPM Release",
    workflowRef: options.workflowRef,
  });
  if (fullRun.headSha !== targetSha || npmRun.headSha !== targetSha) {
    throw new Error(
      `run SHA mismatch: tag=${targetSha} full=${fullRun.headSha} npm=${npmRun.headSha}`,
    );
  }

  const npmDir = join(options.outputDir, "npm-preflight");
  const fullDir = join(options.outputDir, "full-release-validation");
  const npmArtifactName = downloadResolvedArtifact(
    options.repo,
    options.npmPreflightRunId,
    `openclaw-npm-preflight-${options.tag}`,
    "openclaw-npm-preflight-",
    npmDir,
  );
  const fullArtifactName = downloadResolvedArtifact(
    options.repo,
    options.fullReleaseRunId,
    `full-release-validation-${options.fullReleaseRunId}`,
    "full-release-validation-",
    fullDir,
  );

  const npmManifest = readJson(join(npmDir, "preflight-manifest.json"), "npm preflight manifest");
  const fullManifest = readJson(
    join(fullDir, "full-release-validation-manifest.json"),
    "full validation manifest",
  );
  validatePreflightManifest(npmManifest, {
    tag: options.tag,
    targetSha,
    npmDistTag: options.npmDistTag,
  });
  validateFullManifest(fullManifest, {
    targetSha,
    releaseProfile: options.releaseProfile,
  });
  const tarballPath = join(npmDir, npmManifest.tarballName);
  if (!existsSync(tarballPath)) {
    throw new Error(`prepared tarball missing: ${tarballPath}`);
  }
  const actualTarballSha = sha256(tarballPath);
  if (actualTarballSha !== npmManifest.tarballSha256) {
    throw new Error(
      `prepared tarball digest mismatch: expected ${npmManifest.tarballSha256}, got ${actualTarballSha}`,
    );
  }

  const parallels = await runParallelsIfNeeded(options);
  const npmTelegram = await runTelegramIfNeeded(options, npmArtifactName);
  options.npmTelegramRunId = npmTelegram.runId ?? "";
  const pluginNpmPlan = await collectPluginPlanWithRetry(
    "scripts/plugin-npm-release-plan.ts",
    options,
  );
  const pluginClawHubPlan = await collectPluginPlanWithRetry(
    "scripts/plugin-clawhub-release-plan.ts",
    options,
  );
  const publishCommand = buildPublishCommand(options);
  const evidence = {
    version: 1,
    tag: options.tag,
    targetSha,
    workflowRef: options.workflowRef,
    npmDistTag: options.npmDistTag,
    fullReleaseValidationRunId: options.fullReleaseRunId,
    npmPreflightRunId: options.npmPreflightRunId,
    fullReleaseValidationUrl: fullRun.url,
    npmPreflightUrl: npmRun.url,
    artifacts: {
      npmPreflight: npmArtifactName,
      fullReleaseValidation: fullArtifactName,
    },
    localGeneratedCheck,
    tarball: {
      name: basename(tarballPath),
      sha256: actualTarballSha,
      path: tarballPath,
    },
    parallels,
    npmTelegram,
    pluginNpmPlan,
    pluginClawHubPlan,
    publishCommand,
  };
  mkdirSync(options.outputDir, { recursive: true });
  const evidencePath = join(options.outputDir, "release-candidate-evidence.json");
  const evidenceMarkdownPath = join(options.outputDir, "release-candidate-evidence.md");
  writeFileSync(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
  writeFileSync(
    evidenceMarkdownPath,
    [
      `# ${options.tag} release candidate evidence`,
      "",
      `- target SHA: ${targetSha}`,
      `- full release validation: ${options.fullReleaseRunId} ${fullRun.url}`,
      `- npm preflight: ${options.npmPreflightRunId} ${npmRun.url}`,
      `- npm preflight artifact: ${npmArtifactName}`,
      `- full release artifact: ${fullArtifactName}`,
      `- local generated release checks: ${localGeneratedCheck.status}${
        localGeneratedCheck.reason ? ` (${localGeneratedCheck.reason})` : ""
      }`,
      `- tarball: ${basename(tarballPath)}`,
      `- tarball sha256: ${actualTarballSha}`,
      `- npm dist-tag: ${options.npmDistTag}`,
      `- plugin npm plan: ${pluginNpmPlan.packages?.length ?? 0} packages`,
      `- ClawHub plan: ${pluginClawHubPlan.packages?.length ?? 0} packages`,
      `- Parallels: ${parallels.status}${parallels.reason ? ` (${parallels.reason})` : ""}`,
      `- NPM Telegram E2E: ${npmTelegram.status}${
        npmTelegram.runId ? ` ${npmTelegram.runId} ${npmTelegram.url}` : ""
      }`,
      "",
      "Publish command:",
      "",
      "```bash",
      publishCommand,
      "```",
      "",
    ].join("\n"),
  );

  console.log(`release candidate evidence: ${evidencePath}`);
  console.log(`release candidate summary: ${evidenceMarkdownPath}`);
  console.log("publish command:");
  console.log(publishCommand);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
