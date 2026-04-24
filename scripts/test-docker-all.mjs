import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_E2E_IMAGE = "openclaw-docker-e2e:local";
const DEFAULT_PARALLELISM = 8;
const DEFAULT_TAIL_PARALLELISM = 8;
const DEFAULT_FAILURE_TAIL_LINES = 80;
const DEFAULT_LANE_TIMEOUT_MS = 120 * 60 * 1000;
const DEFAULT_LANE_START_STAGGER_MS = 2_000;

const lanes = [
  ["live-models", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-models"],
  ["live-gateway", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-gateway"],
  [
    "live-cli-backend-claude",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:claude",
  ],
  [
    "live-cli-backend-gemini",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:gemini",
  ],
  ["openwebui", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui"],
  ["onboard", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:onboard"],
  [
    "npm-onboard-channel-agent",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent",
  ],
  ["gateway-network", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:gateway-network"],
  ["mcp-channels", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-channels"],
  ["pi-bundle-mcp-tools", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:pi-bundle-mcp-tools"],
  ["cron-mcp-cleanup", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:cron-mcp-cleanup"],
  ["doctor-switch", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:doctor-switch"],
  ["plugins", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins"],
  ["plugin-update", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugin-update"],
  ["config-reload", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:config-reload"],
  ["bundled-channel-deps", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:bundled-channel-deps"],
  ["openai-image-auth", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-image-auth"],
  ["qr", "pnpm test:docker:qr"],
];

const exclusiveLanes = [
  [
    "openai-web-search-minimal",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-web-search-minimal",
  ],
  ["live-codex-harness", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-codex-harness"],
  ["live-codex-bind", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-codex-bind"],
  [
    "live-cli-backend-codex",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:codex",
  ],
  ["live-acp-bind", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind"],
];

const tailLanes = exclusiveLanes;

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
  return {
    ...process.env,
    ...extra,
  };
}

function runShellCommand({ command, env, label, logFile, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: ROOT_DIR,
      env,
      stdio: logFile ? ["ignore", "pipe", "pipe"] : "inherit",
    });
    activeChildren.add(child);
    let timedOut = false;
    let killTimer;
    const timeoutTimer =
      timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            if (stream) {
              stream.write(`\n==> [${label}] timeout after ${timeoutMs}ms; sending SIGTERM\n`);
            }
            child.kill("SIGTERM");
            killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
            killTimer.unref?.();
          }, timeoutMs)
        : undefined;
    timeoutTimer?.unref?.();

    let stream;
    if (logFile) {
      stream = fs.createWriteStream(logFile, { flags: "a" });
      stream.write(`==> [${label}] command: ${command}\n`);
      stream.write(`==> [${label}] started: ${utcStamp()}\n`);
      child.stdout.pipe(stream, { end: false });
      child.stderr.pipe(stream, { end: false });
    }

    child.on("close", (status, signal) => {
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      activeChildren.delete(child);
      const exitCode = typeof status === "number" ? status : signal ? 128 : 1;
      if (stream) {
        stream.write(`\n==> [${label}] finished: ${utcStamp()} status=${exitCode}\n`);
        stream.end();
      }
      resolve({ signal, status: exitCode, timedOut });
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

function laneEnv(name, baseEnv, logDir) {
  const env = {
    ...baseEnv,
  };
  if (!process.env.OPENCLAW_DOCKER_CLI_TOOLS_DIR) {
    env.OPENCLAW_DOCKER_CLI_TOOLS_DIR = path.join(logDir, `${name}-cli-tools`);
  }
  if (!process.env.OPENCLAW_DOCKER_CACHE_HOME_DIR) {
    env.OPENCLAW_DOCKER_CACHE_HOME_DIR = path.join(logDir, `${name}-cache`);
  }
  return env;
}

async function runLane(lane, baseEnv, logDir, timeoutMs) {
  const [name, command] = lane;
  const logFile = path.join(logDir, `${name}.log`);
  const env = laneEnv(name, baseEnv, logDir);
  await mkdir(env.OPENCLAW_DOCKER_CLI_TOOLS_DIR, { recursive: true });
  await mkdir(env.OPENCLAW_DOCKER_CACHE_HOME_DIR, { recursive: true });
  await fs.promises.writeFile(
    logFile,
    [
      `==> [${name}] cli tools dir: ${env.OPENCLAW_DOCKER_CLI_TOOLS_DIR}`,
      `==> [${name}] cache dir: ${env.OPENCLAW_DOCKER_CACHE_HOME_DIR}`,
      "",
    ].join("\n"),
  );
  console.log(`==> [${name}] start`);
  const startedAt = Date.now();
  const result = await runShellCommand({ command, env, label: name, logFile, timeoutMs });
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
    logFile,
    name,
    status: result.status,
    timedOut: result.timedOut,
  };
}

async function runLanePool(poolLanes, baseEnv, logDir, parallelism, options) {
  const failures = [];
  let nextIndex = 0;
  let lastLaneStartAt = 0;
  let laneStartQueue = Promise.resolve();

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

  async function worker() {
    while (nextIndex < poolLanes.length) {
      if (options.failFast && failures.length > 0) {
        return;
      }
      const lane = poolLanes[nextIndex++];
      await waitForLaneStartSlot();
      const result = await runLane(lane, baseEnv, logDir, options.timeoutMs);
      if (result.status !== 0) {
        failures.push(result);
        if (options.failFast) {
          return;
        }
      }
    }
  }

  const workerCount = Math.min(parallelism, poolLanes.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return failures;
}

async function tailFile(file, lines) {
  const content = await readFile(file, "utf8").catch(() => "");
  const tail = content.split(/\r?\n/).slice(-lines).join("\n");
  return tail.trimEnd();
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
function terminateActiveChildren(signal) {
  for (const child of activeChildren) {
    child.kill(signal);
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
  const failFast = parseBool(process.env.OPENCLAW_DOCKER_ALL_FAIL_FAST, true);
  const runId = process.env.OPENCLAW_DOCKER_ALL_RUN_ID || utcStampForPath();
  const logDir = path.resolve(
    process.env.OPENCLAW_DOCKER_ALL_LOG_DIR ||
      path.join(ROOT_DIR, ".artifacts/docker-tests", runId),
  );
  await mkdir(logDir, { recursive: true });

  const baseEnv = commandEnv({
    OPENCLAW_DOCKER_E2E_IMAGE: process.env.OPENCLAW_DOCKER_E2E_IMAGE || DEFAULT_E2E_IMAGE,
  });
  appendExtension(baseEnv, "matrix");
  appendExtension(baseEnv, "acpx");
  appendExtension(baseEnv, "codex");

  console.log(`==> Docker test logs: ${logDir}`);
  console.log(`==> Parallelism: ${parallelism}`);
  console.log(`==> Tail parallelism: ${tailParallelism}`);
  console.log(`==> Lane timeout: ${laneTimeoutMs}ms`);
  console.log(`==> Lane start stagger: ${laneStartStaggerMs}ms`);
  console.log(`==> Fail fast: ${failFast ? "yes" : "no"}`);
  console.log(`==> Live-test bundled plugin deps: ${baseEnv.OPENCLAW_DOCKER_BUILD_EXTENSIONS}`);

  await runForeground("Build shared live-test image once", "pnpm test:docker:live-build", baseEnv);
  await runForeground(
    `Build shared Docker E2E image once: ${baseEnv.OPENCLAW_DOCKER_E2E_IMAGE}`,
    "pnpm test:docker:e2e-build",
    baseEnv,
  );

  const options = { failFast, startStaggerMs: laneStartStaggerMs, timeoutMs: laneTimeoutMs };
  const failures = await runLanePool(lanes, baseEnv, logDir, parallelism, options);
  if (failFast && failures.length > 0) {
    await printFailureSummary(failures, tailLines);
    process.exit(1);
  }

  console.log("==> Running provider-sensitive Docker tail lanes");
  failures.push(...(await runLanePool(tailLanes, baseEnv, logDir, tailParallelism, options)));
  if (failures.length > 0) {
    await printFailureSummary(failures, tailLines);
    process.exit(1);
  }

  await runForeground(
    "Run cleanup smoke after parallel lanes",
    "pnpm test:docker:cleanup",
    baseEnv,
  );
  console.log("==> Docker test suite passed");
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
