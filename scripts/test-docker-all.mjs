// Docker E2E aggregate scheduler.
// Builds shared Docker images, prepares one OpenClaw npm tarball, assigns lanes
// to bare/functional images, and runs lanes through weighted resource pools.
import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DEFAULT_E2E_BARE_IMAGE,
  DEFAULT_E2E_FUNCTIONAL_IMAGE,
  DEFAULT_E2E_IMAGE,
  DEFAULT_LIVE_RETRIES,
  DEFAULT_PARALLELISM,
  DEFAULT_PROFILE,
  DEFAULT_RESOURCE_LIMITS,
  DEFAULT_TAIL_PARALLELISM,
  RELEASE_PATH_PROFILE,
  findLaneByName,
  laneResources,
  laneSummary,
  laneWeight,
  lanesNeedE2eImageKind,
  lanesNeedOpenClawPackage,
  parseLaneSelection,
  parseLiveMode,
  parseProfile,
  resolveDockerE2ePlan,
} from "./lib/docker-e2e-plan.mjs";

const SCRIPT_ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ROOT_DIR = path.resolve(process.env.OPENCLAW_DOCKER_E2E_REPO_ROOT || SCRIPT_ROOT_DIR);
const DEFAULT_FAILURE_TAIL_LINES = 80;
const DEFAULT_LANE_TIMEOUT_MS = 120 * 60 * 1000;
const DEFAULT_LANE_START_STAGGER_MS = 2_000;
const DEFAULT_STATUS_INTERVAL_MS = 30_000;
const DEFAULT_PREFLIGHT_RUN_TIMEOUT_MS = 60_000;
const DEFAULT_TIMINGS_FILE = path.join(ROOT_DIR, ".artifacts/docker-tests/lane-timings.json");
const DEFAULT_GITHUB_WORKFLOW = "openclaw-live-and-e2e-checks-reusable.yml";
const IS_MAIN = process.argv[1]
  ? path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
  : false;
const cliArgs = new Set(IS_MAIN ? process.argv.slice(2) : []);
if (IS_MAIN) {
  for (const arg of cliArgs) {
    if (arg !== "--plan-json") {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
}

function parsePositiveInt(raw, fallback, label) {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`${label} must be a positive integer. Got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parseNonNegativeInt(raw, fallback, label) {
  if (!raw) {
    return fallback;
  }
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer. Got: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function parseBool(raw, fallback) {
  if (raw === undefined || raw === "") {
    return fallback;
  }
  return !/^(?:0|false|no)$/i.test(raw);
}

function resourceLimitsSummary(resourceLimits) {
  return Object.entries(resourceLimits)
    .map(([resource, limit]) => `${resource}=${String(limit)}`)
    .join(" ");
}

function resourceLimitEnvName(resource) {
  return `OPENCLAW_DOCKER_ALL_${resource.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_LIMIT`;
}

export function describeDockerSchedulerLimits(parallelism, options) {
  return `parallelism=${parallelism} weightLimit=${options.weightLimit} resources=${resourceLimitsSummary(
    options.resourceLimits,
  )}`;
}

function parseResourceLimit(env, resource, parallelism, fallback) {
  const envName = resourceLimitEnvName(resource);
  return parsePositiveInt(env[envName], Math.min(parallelism, fallback), envName);
}

function parseSchedulerOptions(env, parallelism) {
  const weightLimit = parsePositiveInt(
    env.OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT,
    parallelism,
    "OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT",
  );
  const resourceLimits = {};
  for (const [resource, fallback] of Object.entries(DEFAULT_RESOURCE_LIMITS)) {
    resourceLimits[resource] = parseResourceLimit(env, resource, parallelism, fallback);
  }
  return {
    resourceLimits,
    weightLimit,
  };
}

export function canStartSchedulerLane(candidate, active, parallelism, options) {
  const weight = laneWeight(candidate);
  if (active.count >= parallelism) {
    return false;
  }

  const exceedsWeightLimit = active.weight + weight > options.weightLimit;
  const exceedsResourceLimit = laneResources(candidate).some((resource) => {
    const limit = options.resourceLimits[resource] ?? options.weightLimit;
    const current = active.resources.get(resource) ?? 0;
    return current + weight > limit;
  });

  if (!exceedsWeightLimit && !exceedsResourceLimit) {
    return true;
  }

  return active.count === 0;
}

function timingSeconds(timingStore, poolLane) {
  const fromStore = timingStore?.lanes?.[poolLane.name]?.durationSeconds;
  if (typeof fromStore === "number" && Number.isFinite(fromStore) && fromStore > 0) {
    return fromStore;
  }
  return poolLane.estimateSeconds ?? 0;
}

function orderLanes(poolLanes, timingStore) {
  return poolLanes
    .map((poolLane, index) => ({ index, poolLane, seconds: timingSeconds(timingStore, poolLane) }))
    .toSorted((a, b) => b.seconds - a.seconds || a.index - b.index)
    .map(({ poolLane }) => poolLane);
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function utcStampForPath() {
  return new Date().toISOString().replaceAll("-", "").replaceAll(":", "").replace(/\..*$/, "Z");
}

function utcStamp() {
  return new Date().toISOString().replace(/\..*$/, "Z");
}

function appendExtension(env, extension) {
  const current = env.OPENCLAW_DOCKER_BUILD_EXTENSIONS ?? env.OPENCLAW_EXTENSIONS ?? "";
  const tokens = current.split(/\s+/).filter(Boolean);
  if (!tokens.includes(extension)) {
    tokens.push(extension);
  }
  env.OPENCLAW_DOCKER_BUILD_EXTENSIONS = tokens.join(" ");
}

function commandEnv(extra = {}) {
  const env = {
    ...process.env,
    ...extra,
  };
  const pathEntries = [
    env.PATH,
    env.PNPM_HOME,
    env.npm_execpath ? path.dirname(env.npm_execpath) : undefined,
    path.dirname(process.execPath),
  ]
    .flatMap((entry) => (entry ? String(entry).split(path.delimiter) : []))
    .filter(Boolean);
  env.PATH = [...new Set(pathEntries)].join(path.delimiter);
  return env;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function githubWorkflowRerunCommand(laneNames, ref) {
  const fields = [
    "gh workflow run",
    shellQuote(process.env.OPENCLAW_DOCKER_E2E_WORKFLOW || DEFAULT_GITHUB_WORKFLOW),
    "-f",
    `ref=${shellQuote(ref)}`,
    "-f",
    "include_repo_e2e=false",
    "-f",
    "include_release_path_suites=false",
    "-f",
    "include_openwebui=false",
    "-f",
    `docker_lanes=${shellQuote(laneNames.join(" "))}`,
    "-f",
    "include_live_suites=false",
    "-f",
    "live_models_only=false",
  ];
  if (process.env.GITHUB_RUN_ID) {
    fields.push("-f", `package_artifact_run_id=${shellQuote(process.env.GITHUB_RUN_ID)}`);
    fields.push(
      "-f",
      `package_artifact_name=${shellQuote(
        process.env.OPENCLAW_DOCKER_E2E_PACKAGE_ARTIFACT_NAME || "docker-e2e-package",
      )}`,
    );
  }
  if (process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC) {
    fields.push(
      "-f",
      `published_upgrade_survivor_baseline=${shellQuote(process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC)}`,
    );
  }
  if (process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS) {
    fields.push(
      "-f",
      `published_upgrade_survivor_baselines=${shellQuote(process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS)}`,
    );
  }
  if (process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS) {
    fields.push(
      "-f",
      `published_upgrade_survivor_scenarios=${shellQuote(process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS)}`,
    );
  }
  if (process.env.OPENCLAW_DOCKER_E2E_BARE_IMAGE) {
    fields.push(
      "-f",
      `docker_e2e_bare_image=${shellQuote(process.env.OPENCLAW_DOCKER_E2E_BARE_IMAGE)}`,
    );
  }
  if (process.env.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE) {
    fields.push(
      "-f",
      `docker_e2e_functional_image=${shellQuote(process.env.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE)}`,
    );
  }
  return fields.join(" ");
}

function buildLaneRerunCommand(name, baseEnv) {
  const poolLane = findLaneByName(name);
  const build = name.startsWith("live-") ? "1" : "0";
  const image = poolLane ? e2eImageForLane(poolLane, baseEnv) : baseEnv.OPENCLAW_DOCKER_E2E_IMAGE;
  const env = [
    ["OPENCLAW_DOCKER_ALL_LANES", name],
    ["OPENCLAW_DOCKER_ALL_BUILD", build],
    ["OPENCLAW_DOCKER_ALL_PREFLIGHT", "0"],
    ["OPENCLAW_SKIP_DOCKER_BUILD", "1"],
    ["OPENCLAW_DOCKER_E2E_IMAGE", image || DEFAULT_E2E_IMAGE],
    ["OPENCLAW_DOCKER_E2E_BARE_IMAGE", baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE],
    ["OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE", baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE],
    ["OPENCLAW_CURRENT_PACKAGE_TGZ", baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ],
    ["OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC", baseEnv.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPEC],
    ["OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS", baseEnv.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS],
    ["OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS", baseEnv.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS],
  ];
  if (baseEnv.OPENCLAW_DOCKER_ALL_PNPM_COMMAND) {
    env.push(["OPENCLAW_DOCKER_ALL_PNPM_COMMAND", baseEnv.OPENCLAW_DOCKER_ALL_PNPM_COMMAND]);
  }
  return `${env
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
    .join(" ")} pnpm test:docker:all`;
}

function withResolvedPnpmCommand(command, env) {
  const pnpmCommand = env.OPENCLAW_DOCKER_ALL_PNPM_COMMAND?.trim();
  if (!pnpmCommand) {
    return command;
  }
  return command.replace(/(^|\s)pnpm(?=\s)/g, `$1${shellQuote(pnpmCommand)}`);
}

function liveDockerHarnessScriptCommand(script) {
  return `bash -c 'harness="\${OPENCLAW_DOCKER_E2E_TRUSTED_HARNESS_DIR:-}"; if [ -z "$harness" ]; then if [ -d .release-harness/scripts ]; then harness=.release-harness; else harness=.; fi; fi; OPENCLAW_LIVE_DOCKER_REPO_ROOT="\${OPENCLAW_DOCKER_E2E_REPO_ROOT:-$PWD}" bash "$harness/scripts/${script}"'`;
}

async function loadTimingStore(file, enabled) {
  if (!enabled) {
    return { enabled: false, file, lanes: {}, version: 1 };
  }
  const raw = await readFile(file, "utf8").catch(() => "");
  if (!raw.trim()) {
    return { enabled: true, file, lanes: {}, version: 1 };
  }
  try {
    const parsed = JSON.parse(raw);
    return {
      enabled: true,
      file,
      lanes: parsed && typeof parsed.lanes === "object" && parsed.lanes ? parsed.lanes : {},
      version: 1,
    };
  } catch (error) {
    console.warn(
      `WARN: ignoring unreadable Docker lane timings ${file}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
    return { enabled: true, file, lanes: {}, version: 1 };
  }
}

async function writeTimingStore(timingStore, results) {
  if (!timingStore.enabled || results.length === 0) {
    return;
  }
  const next = {
    lanes: { ...timingStore.lanes },
    updatedAt: new Date().toISOString(),
    version: 1,
  };
  for (const result of results) {
    if (!result || typeof result.elapsedSeconds !== "number") {
      continue;
    }
    next.lanes[result.name] = {
      durationSeconds: result.elapsedSeconds,
      status: result.status,
      timedOut: result.timedOut,
      updatedAt: new Date().toISOString(),
    };
  }
  await mkdir(path.dirname(timingStore.file), { recursive: true });
  await fs.promises.writeFile(timingStore.file, `${JSON.stringify(next, null, 2)}\n`);
  timingStore.lanes = next.lanes;
  console.log(`==> Docker lane timings: ${timingStore.file}`);
}

async function writeRunSummary(logDir, summary) {
  const file = path.join(logDir, "summary.json");
  const payload = {
    ...summary,
    packageArtifactName: process.env.OPENCLAW_DOCKER_E2E_PACKAGE_ARTIFACT_NAME || undefined,
    finishedAt: new Date().toISOString(),
    github: {
      ref: process.env.GITHUB_REF_NAME || undefined,
      repository: process.env.GITHUB_REPOSITORY || undefined,
      runId: process.env.GITHUB_RUN_ID || undefined,
      runUrl:
        process.env.GITHUB_SERVER_URL && process.env.GITHUB_REPOSITORY && process.env.GITHUB_RUN_ID
          ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`
          : undefined,
      selectedSha: process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA || undefined,
      sha: process.env.GITHUB_SHA || undefined,
      workflow: process.env.GITHUB_WORKFLOW || undefined,
    },
    version: 1,
  };
  await fs.promises.writeFile(file, `${JSON.stringify(payload, null, 2)}\n`);
  await writeFailureIndex(logDir, payload);
  console.log(`==> Docker run summary: ${file}`);
}

async function writeFailureIndex(logDir, summary) {
  const ref =
    summary.github?.selectedSha ||
    process.env.OPENCLAW_DOCKER_E2E_SELECTED_SHA ||
    summary.github?.sha ||
    summary.github?.ref ||
    process.env.GITHUB_SHA ||
    "HEAD";
  const failures = Array.isArray(summary.failures)
    ? summary.failures
    : (summary.lanes ?? []).filter((lane) => lane.status !== 0);
  const lanes = failures.map((failure) => ({
    ghWorkflowCommand: githubWorkflowRerunCommand([failure.name], ref),
    image: failure.image,
    imageKind: failure.imageKind,
    lane: failure.name,
    logFile: failure.logFile,
    name: failure.name,
    noOutputTimedOut: failure.noOutputTimedOut,
    rerunCommand: failure.rerunCommand,
    status: failure.status,
    timedOut: failure.timedOut,
  }));
  const failureIndex = {
    combinedGhWorkflowCommand:
      lanes.length > 0
        ? githubWorkflowRerunCommand(
            lanes.map((lane) => lane.lane),
            ref,
          )
        : undefined,
    generatedAt: new Date().toISOString(),
    lanes,
    note: "Targeted GitHub reruns reuse this run's package artifact and shared Docker images when the generated command includes package_artifact_run_id and docker_e2e_*_image inputs.",
    images: summary.images,
    packageArtifactName: process.env.OPENCLAW_DOCKER_E2E_PACKAGE_ARTIFACT_NAME || undefined,
    ref,
    runUrl: summary.github?.runUrl,
    status: summary.status,
    version: 1,
    workflow: process.env.OPENCLAW_DOCKER_E2E_WORKFLOW || DEFAULT_GITHUB_WORKFLOW,
  };
  await fs.promises.writeFile(
    path.join(logDir, "failures.json"),
    `${JSON.stringify(failureIndex, null, 2)}\n`,
  );
}

function phaseElapsedSeconds(startedAtMs) {
  return Math.round((Date.now() - startedAtMs) / 1000);
}

async function runPhase(phases, name, details, fn) {
  const startedAtMs = Date.now();
  const phase = {
    ...details,
    name,
    startedAt: new Date(startedAtMs).toISOString(),
  };
  try {
    const result = await fn();
    phase.status = "passed";
    return result;
  } catch (error) {
    phase.status = "failed";
    phase.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    phase.elapsedSeconds = phaseElapsedSeconds(startedAtMs);
    phase.finishedAt = new Date().toISOString();
    phases.push(phase);
    console.log(`==> Phase ${phase.status}: ${name} ${phase.elapsedSeconds}s`);
  }
}

function printLaneManifest(label, poolLanes, timingStore) {
  console.log(`==> ${label} lanes (${poolLanes.length})`);
  for (const [index, poolLane] of poolLanes.entries()) {
    const seconds = timingSeconds(timingStore, poolLane);
    const estimate = seconds > 0 ? ` last=${Math.round(seconds)}s` : "";
    console.log(`  ${index + 1}. ${laneSummary(poolLane)}${estimate}`);
  }
}

function dockerPreflightContainerNames(raw) {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim().split(/\s+/, 1)[0])
    .filter((name) =>
      /^(?:openclaw-(?:gateway-e2e|openwebui|openwebui-gateway|config-reload-e2e)-)/.test(name),
    );
}

function runShellCommand({ command, env, label, logFile, timeoutMs, noOutputTimeoutMs }) {
  return new Promise((resolve) => {
    const pipeOutput = Boolean(logFile || noOutputTimeoutMs > 0);
    const child = spawn("bash", ["-c", command], {
      cwd: ROOT_DIR,
      detached: process.platform !== "win32",
      env,
      stdio: pipeOutput ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    activeChildren.add(child);
    let timedOut = false;
    let noOutputTimedOut = false;
    let killTimer;
    let stream;
    let noOutputTimer;
    const terminateForTimeout = (message, options = {}) => {
      if (timedOut) {
        return;
      }
      timedOut = true;
      noOutputTimedOut = options.noOutput === true;
      if (stream) {
        stream.write(`\n==> [${label}] ${message}; sending SIGTERM\n`);
      } else {
        console.error(`==> [${label}] ${message}; sending SIGTERM`);
      }
      terminateChild(child, "SIGTERM");
      killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), 10_000);
      killTimer.unref?.();
    };
    const resetNoOutputTimer = () => {
      if (!noOutputTimeoutMs || noOutputTimeoutMs <= 0 || timedOut) {
        return;
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      noOutputTimer = setTimeout(() => {
        terminateForTimeout(`no output for ${noOutputTimeoutMs}ms`, { noOutput: true });
      }, noOutputTimeoutMs);
      noOutputTimer.unref?.();
    };
    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            terminateForTimeout(`timeout after ${timeoutMs}ms`);
          }, timeoutMs)
        : undefined;
    timeoutTimer?.unref?.();

    if (logFile) {
      stream = fs.createWriteStream(logFile, { flags: "a" });
      stream.write(`==> [${label}] command: ${command}\n`);
      stream.write(`==> [${label}] started: ${utcStamp()}\n`);
    }
    if (pipeOutput) {
      const writeOutput = (target, chunk) => {
        resetNoOutputTimer();
        if (stream) {
          stream.write(chunk);
        } else {
          target.write(chunk);
        }
      };
      child.stdout.on("data", (chunk) => writeOutput(process.stdout, chunk));
      child.stderr.on("data", (chunk) => writeOutput(process.stderr, chunk));
      resetNoOutputTimer();
    }

    child.on("close", (status, signal) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (noOutputTimer) {
        clearTimeout(noOutputTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      activeChildren.delete(child);
      const exitCode = typeof status === "number" ? status : signal ? 128 : 1;
      if (stream) {
        stream.write(
          `\n==> [${label}] finished: ${utcStamp()} status=${exitCode}${
            noOutputTimedOut ? " noOutputTimedOut=true" : ""
          }\n`,
        );
        stream.end();
      }
      resolve({ signal, status: exitCode, timedOut, noOutputTimedOut });
    });
  });
}

function runShellCaptureCommand({ command, env, label, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-c", command], {
      cwd: ROOT_DIR,
      detached: process.platform !== "win32",
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChildren.add(child);
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            terminateChild(child, "SIGTERM");
            setTimeout(() => terminateChild(child, "SIGKILL"), 10_000).unref?.();
          }, timeoutMs)
        : undefined;
    timeoutTimer?.unref?.();
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (status, signal) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      activeChildren.delete(child);
      const exitCode = typeof status === "number" ? status : signal ? 128 : 1;
      resolve({ label, signal, status: exitCode, stderr, stdout, timedOut });
    });
  });
}

async function runForeground(label, command, env) {
  console.log(`==> ${label}`);
  const result = await runShellCommand({ command, env, label });
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status}`);
  }
}

async function runForegroundGroup(entries, env) {
  const failures = [];
  for (const entry of entries) {
    try {
      const label = entry.label ?? entry[0];
      const command = entry.command ?? entry[1];
      const entryEnv = { ...env, ...entry.env };
      const phases = entry.phases;
      const details = entry.phaseDetails ?? {};
      if (phases) {
        await runPhase(phases, `build:${label}`, details, async () => {
          await runForeground(label, command, entryEnv);
        });
      } else {
        await runForeground(label, command, entryEnv);
      }
    } catch (error) {
      failures.push({ entry, error });
    }
  }
  if (failures.length > 0) {
    throw new Error(
      failures
        .map(
          ({ entry, error }) =>
            `${entry.label ?? entry[0]}: ${error instanceof Error ? error.message : String(error)}`,
        )
        .join("\n"),
    );
  }
}

async function runDockerPreflight(baseEnv, options) {
  if (!options.enabled) {
    console.log("==> Docker preflight: skipped");
    return;
  }
  console.log("==> Docker preflight");
  const version = await runShellCaptureCommand({
    command: "docker version --format '{{.Server.Version}}'",
    env: baseEnv,
    label: "docker-version",
    timeoutMs: 20_000,
  });
  if (version.status !== 0) {
    throw new Error(
      `Docker preflight failed: docker version status=${version.status}\n${version.stderr}${version.stdout}`,
    );
  }
  console.log(`==> Docker server: ${version.stdout.trim()}`);

  if (options.cleanup) {
    const stale = await runShellCaptureCommand({
      command:
        "docker ps -a --filter status=created --filter status=exited --filter status=dead --format '{{.Names}} {{.Status}}'",
      env: baseEnv,
      label: "docker-stale-list",
      timeoutMs: 20_000,
    });
    if (stale.status === 0) {
      const names = dockerPreflightContainerNames(stale.stdout);
      if (names.length > 0) {
        console.log(`==> Docker preflight cleanup: ${names.join(", ")}`);
        const cleanup = await runShellCommand({
          command: `docker rm -f ${names.map(shellQuote).join(" ")}`,
          env: baseEnv,
          label: "docker-stale-cleanup",
          timeoutMs: 90_000,
        });
        if (cleanup.status !== 0) {
          throw new Error(`Docker preflight cleanup failed with status ${cleanup.status}`);
        }
      }
    }
  }

  const startedAt = Date.now();
  const run = await runShellCommand({
    command: "docker run --rm alpine:3.20 true",
    env: baseEnv,
    label: "docker-run-smoke",
    timeoutMs: options.runTimeoutMs,
  });
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (run.status !== 0) {
    throw new Error(
      `Docker preflight failed: docker run alpine:3.20 true status=${run.status} elapsed=${elapsedSeconds}s`,
    );
  }
  console.log(`==> Docker preflight run: ${elapsedSeconds}s`);
}

async function prepareOpenClawPackage(baseEnv, logDir) {
  const existing = baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ;
  if (existing) {
    const packageTgz = path.resolve(existing);
    baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ = packageTgz;
    baseEnv.OPENCLAW_BUNDLED_CHANNEL_HOST_BUILD = "0";
    baseEnv.OPENCLAW_NPM_ONBOARD_HOST_BUILD = "0";
    console.log(`==> OpenClaw package: ${packageTgz}`);
    return;
  }

  const packDir = path.join(logDir, "openclaw-package");
  await mkdir(packDir, { recursive: true });
  const packageTgz = path.join(packDir, "openclaw-current.tgz");
  await runForeground(
    "Prepare OpenClaw package once",
    `node scripts/package-openclaw-for-docker.mjs --output-dir ${shellQuote(packDir)} --output-name openclaw-current.tgz`,
    baseEnv,
  );
  await fs.promises.access(packageTgz);
  baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ = packageTgz;
  baseEnv.OPENCLAW_BUNDLED_CHANNEL_HOST_BUILD = "0";
  baseEnv.OPENCLAW_NPM_ONBOARD_HOST_BUILD = "0";
  console.log(`==> OpenClaw package: ${baseEnv.OPENCLAW_CURRENT_PACKAGE_TGZ}`);
}

function e2eImageForLane(poolLane, baseEnv) {
  if (poolLane.e2eImageKind === "bare") {
    return baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE;
  }
  if (poolLane.e2eImageKind === "functional") {
    return baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE;
  }
  return undefined;
}

function laneEnv(poolLane, baseEnv, logDir, cacheKey) {
  const env = {
    ...baseEnv,
  };
  const name = poolLane.name;
  env.OPENCLAW_DOCKER_ALL_LANE_NAME = name;
  const image = e2eImageForLane(poolLane, baseEnv);
  if (image) {
    env.OPENCLAW_DOCKER_E2E_IMAGE = image;
  }
  if (poolLane.e2eImageKind) {
    env.OPENCLAW_DOCKER_E2E_IMAGE_KIND = poolLane.e2eImageKind;
  }
  const cacheName = cacheKey || name;
  if (!process.env.OPENCLAW_DOCKER_CLI_TOOLS_DIR) {
    env.OPENCLAW_DOCKER_CLI_TOOLS_DIR = path.join(logDir, `${cacheName}-cli-tools`);
  }
  if (!process.env.OPENCLAW_DOCKER_CACHE_HOME_DIR) {
    env.OPENCLAW_DOCKER_CACHE_HOME_DIR = path.join(logDir, `${cacheName}-cache`);
  }
  return env;
}

async function runLane(lane, baseEnv, logDir, fallbackTimeoutMs) {
  const { name } = lane;
  const timeoutMs = lane.timeoutMs ?? fallbackTimeoutMs;
  const noOutputTimeoutMs = lane.noOutputTimeoutMs;
  const logFile = path.join(logDir, `${name}.log`);
  const env = laneEnv(lane, baseEnv, logDir, lane.cacheKey);
  const command = withResolvedPnpmCommand(lane.command, env);
  await mkdir(env.OPENCLAW_DOCKER_CLI_TOOLS_DIR, { recursive: true });
  await mkdir(env.OPENCLAW_DOCKER_CACHE_HOME_DIR, { recursive: true });
  await fs.promises.writeFile(
    logFile,
    [
      `==> [${name}] cli tools dir: ${env.OPENCLAW_DOCKER_CLI_TOOLS_DIR}`,
      `==> [${name}] cache dir: ${env.OPENCLAW_DOCKER_CACHE_HOME_DIR}`,
      `==> [${name}] timeout: ${timeoutMs}ms`,
      `==> [${name}] no output timeout: ${noOutputTimeoutMs ?? 0}ms`,
      `==> [${name}] retries: ${lane.retries ?? 0}`,
      `==> [${name}] e2e image kind: ${lane.e2eImageKind ?? "none"}`,
      `==> [${name}] e2e image: ${env.OPENCLAW_DOCKER_E2E_IMAGE ?? ""}`,
      "",
    ].join("\n"),
  );
  console.log(`==> [${name}] start`);
  const startedAt = Date.now();
  const startedAtIso = new Date(startedAt).toISOString();
  let result;
  const attempts = [];
  const maxAttempts = 1 + Math.max(0, lane.retries ?? 0);
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const attemptStartedAt = Date.now();
    if (attempt > 1) {
      await fs.promises.appendFile(logFile, `\n==> [${name}] retry attempt ${attempt}\n`);
      console.log(`==> [${name}] retry ${attempt}/${maxAttempts}`);
    }
    result = await runShellCommand({
      command,
      env,
      label: name,
      logFile,
      timeoutMs,
      noOutputTimeoutMs,
    });
    attempts.push({
      attempt,
      elapsedSeconds: phaseElapsedSeconds(attemptStartedAt),
      finishedAt: new Date().toISOString(),
      noOutputTimedOut: result.noOutputTimedOut,
      startedAt: new Date(attemptStartedAt).toISOString(),
      status: result.status,
      timedOut: result.timedOut,
    });
    if (result.status === 0 || attempt >= maxAttempts) {
      break;
    }
    const retryable =
      result.timedOut || (await laneLogMatchesRetryPattern(logFile, lane.retryPatterns));
    if (!retryable) {
      break;
    }
  }
  const elapsedSeconds = Math.round((Date.now() - startedAt) / 1000);
  if (result.status === 0) {
    console.log(`==> [${name}] pass ${elapsedSeconds}s`);
  } else {
    const timeoutLabel = result.timedOut ? " timeout" : "";
    console.error(
      `==> [${name}] fail${timeoutLabel} status=${result.status} ${elapsedSeconds}s log=${logFile}`,
    );
  }
  return {
    command,
    attempts,
    finishedAt: new Date().toISOString(),
    image: env.OPENCLAW_DOCKER_E2E_IMAGE,
    imageKind: lane.e2eImageKind,
    logFile,
    name,
    elapsedSeconds,
    rerunCommand: buildLaneRerunCommand(name, baseEnv),
    startedAt: startedAtIso,
    status: result.status,
    noOutputTimedOut: result.noOutputTimedOut,
    timedOut: result.timedOut,
  };
}

async function runLanePool(poolLanes, baseEnv, logDir, parallelism, options) {
  const failures = [];
  const results = [];
  const pending = [...poolLanes];
  const running = new Set();
  const active = {
    count: 0,
    resources: new Map(),
    weight: 0,
  };
  const activeLanes = new Map();
  let lastLaneStartAt = 0;
  let laneStartQueue = Promise.resolve();
  const statusTimer =
    options.statusIntervalMs > 0
      ? setInterval(() => {
          const runningSummary = [...activeLanes.values()]
            .map((entry) => `${entry.name}:${Math.round((Date.now() - entry.startedAt) / 1000)}s`)
            .join(", ");
          const resources = [...active.resources.entries()]
            .map(([resource, value]) => `${resource}=${value}`)
            .join(" ");
          console.log(
            `==> [${options.poolLabel}] active=${active.count} pending=${pending.length} ${resources}${
              runningSummary ? ` lanes=${runningSummary}` : ""
            }`,
          );
        }, options.statusIntervalMs)
      : undefined;
  statusTimer?.unref?.();

  async function waitForLaneStartSlot() {
    if (options.startStaggerMs <= 0) {
      return;
    }
    const previous = laneStartQueue;
    let releaseQueue;
    laneStartQueue = new Promise((resolve) => {
      releaseQueue = resolve;
    });
    await previous;
    const waitMs = Math.max(0, lastLaneStartAt + options.startStaggerMs - Date.now());
    if (waitMs > 0) {
      await sleep(waitMs);
    }
    lastLaneStartAt = Date.now();
    releaseQueue();
  }

  function canStartLane(candidate) {
    return canStartSchedulerLane(candidate, active, parallelism, options);
  }

  function reserve(candidate) {
    const weight = laneWeight(candidate);
    active.count += 1;
    active.weight += weight;
    for (const resource of laneResources(candidate)) {
      active.resources.set(resource, (active.resources.get(resource) ?? 0) + weight);
    }
  }

  function release(candidate) {
    const weight = laneWeight(candidate);
    active.count -= 1;
    active.weight -= weight;
    for (const resource of laneResources(candidate)) {
      const next = (active.resources.get(resource) ?? 0) - weight;
      if (next > 0) {
        active.resources.set(resource, next);
      } else {
        active.resources.delete(resource);
      }
    }
  }

  async function startLane(poolLane) {
    await waitForLaneStartSlot();
    reserve(poolLane);
    activeLanes.set(poolLane.name, { name: poolLane.name, startedAt: Date.now() });
    let promise;
    promise = runLane(poolLane, baseEnv, logDir, options.timeoutMs)
      .then((result) => ({ lane: poolLane, promise, result }))
      .finally(() => {
        activeLanes.delete(poolLane.name);
        release(poolLane);
      });
    running.add(promise);
  }

  try {
    while (pending.length > 0 || running.size > 0) {
      let started = false;
      if (!options.failFast || failures.length === 0) {
        for (let index = 0; index < pending.length; ) {
          const candidate = pending[index];
          if (!canStartLane(candidate)) {
            index += 1;
            continue;
          }
          pending.splice(index, 1);
          await startLane(candidate);
          started = true;
        }
      }

      if (started) {
        continue;
      }
      if (running.size === 0) {
        const blocked = pending.map(laneSummary).join(", ");
        throw new Error(
          `No Docker lanes fit scheduler limits (${describeDockerSchedulerLimits(
            parallelism,
            options,
          )}): ${blocked}. Tune OPENCLAW_DOCKER_ALL_PARALLELISM, OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT, or OPENCLAW_DOCKER_ALL_<RESOURCE>_LIMIT.`,
        );
      }

      const { promise, result } = await Promise.race(running);
      running.delete(promise);
      results.push(result);
      if (result.status !== 0) {
        failures.push(result);
      }
      if (options.failFast && failures.length > 0) {
        const remainingResults = await Promise.all(running);
        running.clear();
        for (const remaining of remainingResults) {
          results.push(remaining.result);
          if (remaining.result.status !== 0) {
            failures.push(remaining.result);
          }
        }
        break;
      }
    }
  } finally {
    if (statusTimer) {
      clearInterval(statusTimer);
    }
  }

  return { failures, results };
}

async function tailFile(file, lines) {
  const content = await readFile(file, "utf8").catch(() => "");
  const tail = content.split(/\r?\n/).slice(-lines).join("\n");
  return tail.trimEnd();
}

async function laneLogMatchesRetryPattern(logFile, patterns) {
  if (!patterns || patterns.length === 0) {
    return false;
  }
  const tail = await tailFile(logFile, 160);
  return patterns.some((pattern) => pattern.test(tail));
}

async function printFailureSummary(failures, tailLines) {
  console.error(`ERROR: ${failures.length} Docker lane(s) failed.`);
  for (const failure of failures) {
    console.error(`---- ${failure.name} failed (status=${failure.status}): ${failure.logFile}`);
    const tail = await tailFile(failure.logFile, tailLines);
    if (tail) {
      console.error(tail);
    }
  }
}

const activeChildren = new Set();
function terminateChild(child, signal) {
  if (process.platform !== "win32" && child.pid) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to killing the direct child below.
    }
  }
  child.kill(signal);
}

function terminateActiveChildren(signal) {
  for (const child of activeChildren) {
    terminateChild(child, signal);
  }
}

process.on("SIGINT", () => {
  terminateActiveChildren("SIGINT");
  process.exit(130);
});
process.on("SIGTERM", () => {
  terminateActiveChildren("SIGTERM");
  process.exit(143);
});

async function main() {
  const runStartedAt = new Date().toISOString();
  const phases = [];
  const parallelism = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_PARALLELISM,
    DEFAULT_PARALLELISM,
    "OPENCLAW_DOCKER_ALL_PARALLELISM",
  );
  const tailParallelism = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM,
    Math.min(parallelism, DEFAULT_TAIL_PARALLELISM),
    "OPENCLAW_DOCKER_ALL_TAIL_PARALLELISM",
  );
  const tailLines = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_FAILURE_TAIL_LINES,
    DEFAULT_FAILURE_TAIL_LINES,
    "OPENCLAW_DOCKER_ALL_FAILURE_TAIL_LINES",
  );
  const laneTimeoutMs = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS,
    DEFAULT_LANE_TIMEOUT_MS,
    "OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS",
  );
  const laneStartStaggerMs = parseNonNegativeInt(
    process.env.OPENCLAW_DOCKER_ALL_START_STAGGER_MS,
    DEFAULT_LANE_START_STAGGER_MS,
    "OPENCLAW_DOCKER_ALL_START_STAGGER_MS",
  );
  const statusIntervalMs = parseNonNegativeInt(
    process.env.OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS,
    DEFAULT_STATUS_INTERVAL_MS,
    "OPENCLAW_DOCKER_ALL_STATUS_INTERVAL_MS",
  );
  const preflightRunTimeoutMs = parsePositiveInt(
    process.env.OPENCLAW_DOCKER_ALL_PREFLIGHT_RUN_TIMEOUT_MS,
    DEFAULT_PREFLIGHT_RUN_TIMEOUT_MS,
    "OPENCLAW_DOCKER_ALL_PREFLIGHT_RUN_TIMEOUT_MS",
  );
  const failFast = parseBool(process.env.OPENCLAW_DOCKER_ALL_FAIL_FAST, true);
  const dryRun = parseBool(process.env.OPENCLAW_DOCKER_ALL_DRY_RUN, false);
  const preflightEnabled = parseBool(process.env.OPENCLAW_DOCKER_ALL_PREFLIGHT, true);
  const preflightCleanup = parseBool(process.env.OPENCLAW_DOCKER_ALL_PREFLIGHT_CLEANUP, true);
  const timingsEnabled = parseBool(process.env.OPENCLAW_DOCKER_ALL_TIMINGS, true);
  const buildEnabled = parseBool(process.env.OPENCLAW_DOCKER_ALL_BUILD, true);
  const planJson =
    cliArgs.has("--plan-json") || parseBool(process.env.OPENCLAW_DOCKER_ALL_PLAN_JSON, false);
  const planReleaseAll = parseBool(process.env.OPENCLAW_DOCKER_ALL_PLAN_RELEASE_ALL, false);
  const profile = parseProfile(process.env.OPENCLAW_DOCKER_ALL_PROFILE);
  const releaseChunk = process.env.OPENCLAW_DOCKER_ALL_CHUNK || process.env.DOCKER_E2E_CHUNK || "";
  const includeOpenWebUI = parseBool(
    process.env.OPENCLAW_DOCKER_ALL_INCLUDE_OPENWEBUI ?? process.env.INCLUDE_OPENWEBUI,
    true,
  );
  const selectedLaneNamesRaw =
    process.env.OPENCLAW_DOCKER_ALL_LANES || process.env.DOCKER_E2E_LANES || "";
  const selectedLaneNames = parseLaneSelection(selectedLaneNamesRaw);
  if (selectedLaneNamesRaw && selectedLaneNames.length === 0) {
    throw new Error("OPENCLAW_DOCKER_ALL_LANES must include at least one lane name");
  }
  const liveMode = parseLiveMode(process.env.OPENCLAW_DOCKER_ALL_LIVE_MODE);
  const liveRetries = parseNonNegativeInt(
    process.env.OPENCLAW_DOCKER_ALL_LIVE_RETRIES,
    DEFAULT_LIVE_RETRIES,
    "OPENCLAW_DOCKER_ALL_LIVE_RETRIES",
  );
  const timingsFile = path.resolve(
    process.env.OPENCLAW_DOCKER_ALL_TIMINGS_FILE || DEFAULT_TIMINGS_FILE,
  );
  const runId = process.env.OPENCLAW_DOCKER_ALL_RUN_ID || utcStampForPath();
  const logDir = path.resolve(
    process.env.OPENCLAW_DOCKER_ALL_LOG_DIR ||
      path.join(ROOT_DIR, ".artifacts/docker-tests", runId),
  );

  const baseEnv = commandEnv({
    OPENCLAW_DOCKER_E2E_BARE_IMAGE:
      process.env.OPENCLAW_DOCKER_E2E_BARE_IMAGE ||
      process.env.OPENCLAW_DOCKER_E2E_IMAGE ||
      DEFAULT_E2E_BARE_IMAGE,
    OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE:
      process.env.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE ||
      process.env.OPENCLAW_DOCKER_E2E_IMAGE ||
      DEFAULT_E2E_FUNCTIONAL_IMAGE,
  });
  baseEnv.OPENCLAW_DOCKER_E2E_IMAGE =
    process.env.OPENCLAW_DOCKER_E2E_IMAGE || baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE;
  appendExtension(baseEnv, "matrix");
  appendExtension(baseEnv, "acpx");
  appendExtension(baseEnv, "codex");

  const timingStore = await loadTimingStore(timingsFile, timingsEnabled);
  const { orderedLanes, orderedTailLanes, plan, scheduledLanes } = resolveDockerE2ePlan({
    includeOpenWebUI,
    liveMode,
    liveRetries,
    orderLanes,
    planReleaseAll: planJson && planReleaseAll,
    profile,
    releaseChunk,
    selectedLaneNames,
    timingStore,
    upgradeSurvivorBaselines: process.env.OPENCLAW_UPGRADE_SURVIVOR_BASELINE_SPECS,
    upgradeSurvivorScenarios: process.env.OPENCLAW_UPGRADE_SURVIVOR_SCENARIOS,
  });

  if (planJson) {
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\n`);
    return;
  }

  await mkdir(logDir, { recursive: true });
  console.log(`==> Docker test logs: ${logDir}`);
  console.log(`==> Profile: ${profile}${releaseChunk ? ` chunk=${releaseChunk}` : ""}`);
  console.log(`==> Parallelism: ${parallelism}`);
  console.log(`==> Tail parallelism: ${tailParallelism}`);
  console.log(`==> Lane timeout: ${laneTimeoutMs}ms`);
  console.log(`==> Live mode: ${liveMode}`);
  console.log(`==> Live retries: ${liveRetries}`);
  console.log(`==> Lane start stagger: ${laneStartStaggerMs}ms`);
  console.log(`==> Status interval: ${statusIntervalMs}ms`);
  console.log(`==> Fail fast: ${failFast ? "yes" : "no"}`);
  console.log(`==> Dry run: ${dryRun ? "yes" : "no"}`);
  console.log(
    `==> Docker preflight: ${preflightEnabled ? "yes" : "no"}${
      preflightCleanup ? " cleanup=yes" : " cleanup=no"
    }`,
  );
  console.log(`==> Build shared Docker images: ${buildEnabled ? "yes" : "no"}`);
  console.log(`==> Docker E2E bare image: ${baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE}`);
  console.log(`==> Docker E2E functional image: ${baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE}`);
  if (profile === RELEASE_PATH_PROFILE) {
    console.log(`==> Include Open WebUI: ${includeOpenWebUI ? "yes" : "no"}`);
  }
  if (selectedLaneNames.length > 0) {
    console.log(`==> Selected lanes: ${selectedLaneNames.join(", ")}`);
  }
  console.log(`==> Docker lane timings: ${timingStore.enabled ? timingsFile : "disabled"}`);
  console.log(`==> Live-test bundled plugins: ${baseEnv.OPENCLAW_DOCKER_BUILD_EXTENSIONS}`);
  const schedulerOptions = parseSchedulerOptions(process.env, parallelism);
  const tailSchedulerOptions = parseSchedulerOptions(process.env, tailParallelism);
  console.log(
    `==> Scheduler: weight=${schedulerOptions.weightLimit} ${resourceLimitsSummary(schedulerOptions.resourceLimits)}`,
  );
  console.log(
    `==> Tail scheduler: weight=${tailSchedulerOptions.weightLimit} ${resourceLimitsSummary(tailSchedulerOptions.resourceLimits)}`,
  );
  printLaneManifest("Main", orderedLanes, timingStore);
  printLaneManifest("Tail", orderedTailLanes, timingStore);
  if (dryRun) {
    console.log("==> Dry run complete");
    return;
  }

  await runPhase(
    phases,
    "docker-preflight",
    { cleanup: preflightCleanup, enabled: preflightEnabled },
    async () => {
      await runDockerPreflight(baseEnv, {
        cleanup: preflightCleanup,
        enabled: preflightEnabled,
        runTimeoutMs: preflightRunTimeoutMs,
      });
    },
  );
  if (lanesNeedOpenClawPackage(scheduledLanes)) {
    await runPhase(phases, "prepare-openclaw-package", {}, async () => {
      await prepareOpenClawPackage(baseEnv, logDir);
    });
  } else {
    console.log("==> OpenClaw package: not needed for selected lanes");
  }

  if (buildEnabled) {
    const buildEntries = [];
    if (scheduledLanes.some((poolLane) => poolLane.live)) {
      buildEntries.push({
        command: liveDockerHarnessScriptCommand("test-live-build-docker.sh"),
        label: "shared live-test image once",
        phaseDetails: { imageKind: "live" },
        phases,
      });
    }
    if (lanesNeedE2eImageKind(scheduledLanes, "bare")) {
      buildEntries.push({
        command: "pnpm test:docker:e2e-build",
        env: {
          OPENCLAW_DOCKER_E2E_IMAGE: baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE,
          OPENCLAW_DOCKER_E2E_TARGET: "bare",
        },
        label: `shared bare Docker E2E image once: ${baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE}`,
        phaseDetails: { image: baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE, imageKind: "bare" },
        phases,
      });
    }
    if (lanesNeedE2eImageKind(scheduledLanes, "functional")) {
      buildEntries.push({
        command: "pnpm test:docker:e2e-build",
        env: {
          OPENCLAW_DOCKER_E2E_IMAGE: baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE,
          OPENCLAW_DOCKER_E2E_TARGET: "functional",
        },
        label: `shared functional Docker E2E image once: ${baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE}`,
        phaseDetails: {
          image: baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE,
          imageKind: "functional",
        },
        phases,
      });
    }
    await runForegroundGroup(buildEntries, baseEnv);
  } else {
    console.log(`==> Shared Docker image builds: skipped`);
  }

  const options = {
    ...schedulerOptions,
    failFast,
    poolLabel: "main",
    startStaggerMs: laneStartStaggerMs,
    statusIntervalMs,
    timeoutMs: laneTimeoutMs,
  };
  const mainResult = await runPhase(phases, "main-lane-pool", { lanes: orderedLanes.length }, () =>
    runLanePool(orderedLanes, baseEnv, logDir, parallelism, options),
  );
  const failures = [...mainResult.failures];
  const allResults = [...mainResult.results];
  await writeTimingStore(timingStore, mainResult.results);
  if (failFast && failures.length > 0) {
    await writeRunSummary(logDir, {
      chunk: releaseChunk || undefined,
      failures,
      image: baseEnv.OPENCLAW_DOCKER_E2E_IMAGE,
      images: {
        bare: baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE,
        functional: baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE,
      },
      lanes: allResults,
      phases,
      profile,
      selectedLanes: selectedLaneNames.length > 0 ? selectedLaneNames : undefined,
      startedAt: runStartedAt,
      status: "failed",
    });
    await printFailureSummary(failures, tailLines);
    process.exit(1);
  }

  if (orderedTailLanes.length > 0) {
    console.log("==> Running provider-sensitive Docker tail lanes");
    const tailResult = await runPhase(
      phases,
      "tail-lane-pool",
      { lanes: orderedTailLanes.length },
      () =>
        runLanePool(orderedTailLanes, baseEnv, logDir, tailParallelism, {
          ...options,
          ...tailSchedulerOptions,
          poolLabel: "tail",
        }),
    );
    failures.push(...tailResult.failures);
    allResults.push(...tailResult.results);
    await writeTimingStore(timingStore, tailResult.results);
  } else {
    console.log("==> Provider-sensitive Docker tail lanes: none");
  }
  if (failures.length > 0) {
    await writeRunSummary(logDir, {
      chunk: releaseChunk || undefined,
      failures,
      image: baseEnv.OPENCLAW_DOCKER_E2E_IMAGE,
      images: {
        bare: baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE,
        functional: baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE,
      },
      lanes: allResults,
      phases,
      profile,
      selectedLanes: selectedLaneNames.length > 0 ? selectedLaneNames : undefined,
      startedAt: runStartedAt,
      status: "failed",
    });
    await printFailureSummary(failures, tailLines);
    process.exit(1);
  }

  if (profile === DEFAULT_PROFILE && selectedLaneNames.length === 0) {
    await runPhase(phases, "cleanup-smoke", {}, async () => {
      await runForeground(
        "Run cleanup smoke after parallel lanes",
        "pnpm test:docker:cleanup",
        baseEnv,
      );
    });
  } else {
    console.log("==> Cleanup smoke after parallel lanes: skipped for selected/release lanes");
  }
  await writeTimingStore(timingStore, allResults);
  await writeRunSummary(logDir, {
    chunk: releaseChunk || undefined,
    failures,
    image: baseEnv.OPENCLAW_DOCKER_E2E_IMAGE,
    images: {
      bare: baseEnv.OPENCLAW_DOCKER_E2E_BARE_IMAGE,
      functional: baseEnv.OPENCLAW_DOCKER_E2E_FUNCTIONAL_IMAGE,
    },
    lanes: allResults,
    phases,
    profile,
    selectedLanes: selectedLaneNames.length > 0 ? selectedLaneNames : undefined,
    startedAt: runStartedAt,
    status: "passed",
  });
  console.log("==> Docker test suite passed");
}

if (IS_MAIN) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
