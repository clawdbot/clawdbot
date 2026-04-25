import { spawn } from "node:child_process";
import fs from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_E2E_IMAGE = "openclaw-docker-e2e:local";
const DEFAULT_PARALLELISM = 10;
const DEFAULT_TAIL_PARALLELISM = 10;
const DEFAULT_FAILURE_TAIL_LINES = 80;
const DEFAULT_LANE_TIMEOUT_MS = 120 * 60 * 1000;
const DEFAULT_LANE_START_STAGGER_MS = 2_000;
const DEFAULT_STATUS_INTERVAL_MS = 30_000;
const DEFAULT_PREFLIGHT_RUN_TIMEOUT_MS = 60_000;
const DEFAULT_TIMINGS_FILE = path.join(ROOT_DIR, ".artifacts/docker-tests/lane-timings.json");
const LIVE_PROFILE_TIMEOUT_MS = 20 * 60 * 1000;
const LIVE_CLI_TIMEOUT_MS = 20 * 60 * 1000;
const LIVE_ACP_TIMEOUT_MS = 20 * 60 * 1000;
const OPENWEBUI_TIMEOUT_MS = 20 * 60 * 1000;
const BUNDLED_UPDATE_TIMEOUT_MS = 20 * 60 * 1000;
const DEFAULT_RESOURCE_LIMITS = {
  docker: DEFAULT_PARALLELISM,
  live: 6,
  npm: 8,
  service: 7,
};

const bundledChannelLaneCommand =
  "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps";

function lane(name, command, options = {}) {
  return {
    command,
    estimateSeconds: options.estimateSeconds,
    name,
    resources: options.resources ?? [],
    timeoutMs: options.timeoutMs,
    weight: options.weight ?? 1,
  };
}

function liveLane(name, command, options = {}) {
  return lane(name, command, {
    ...options,
    resources: ["live", ...(options.resources ?? [])],
    weight: options.weight ?? 3,
  });
}

function npmLane(name, command, options = {}) {
  return lane(name, command, {
    ...options,
    resources: ["npm", ...(options.resources ?? [])],
    weight: options.weight ?? 2,
  });
}

function serviceLane(name, command, options = {}) {
  return lane(name, command, {
    ...options,
    resources: ["service", ...(options.resources ?? [])],
    weight: options.weight ?? 2,
  });
}

const bundledScenarioLanes = [
  npmLane(
    "bundled-channel-telegram",
    `OPENCLAW_BUNDLED_CHANNELS=telegram ${bundledChannelLaneCommand}`,
  ),
  npmLane(
    "bundled-channel-discord",
    `OPENCLAW_BUNDLED_CHANNELS=discord ${bundledChannelLaneCommand}`,
  ),
  npmLane("bundled-channel-slack", `OPENCLAW_BUNDLED_CHANNELS=slack ${bundledChannelLaneCommand}`),
  npmLane(
    "bundled-channel-feishu",
    `OPENCLAW_BUNDLED_CHANNELS=feishu ${bundledChannelLaneCommand}`,
  ),
  npmLane(
    "bundled-channel-memory-lancedb",
    `OPENCLAW_BUNDLED_CHANNELS=memory-lancedb ${bundledChannelLaneCommand}`,
  ),
  npmLane(
    "bundled-channel-update-telegram",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS=telegram OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
    { timeoutMs: BUNDLED_UPDATE_TIMEOUT_MS },
  ),
  npmLane(
    "bundled-channel-update-discord",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS=discord OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
    { timeoutMs: BUNDLED_UPDATE_TIMEOUT_MS },
  ),
  npmLane(
    "bundled-channel-update-slack",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS=slack OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
    { timeoutMs: BUNDLED_UPDATE_TIMEOUT_MS },
  ),
  npmLane(
    "bundled-channel-update-feishu",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS=feishu OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
    { timeoutMs: BUNDLED_UPDATE_TIMEOUT_MS },
  ),
  npmLane(
    "bundled-channel-update-memory-lancedb",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS=memory-lancedb OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
    { timeoutMs: BUNDLED_UPDATE_TIMEOUT_MS },
  ),
  npmLane(
    "bundled-channel-update-acpx",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_UPDATE_TARGETS=acpx OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
    { timeoutMs: BUNDLED_UPDATE_TIMEOUT_MS },
  ),
  npmLane(
    "bundled-channel-root-owned",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
  ),
  npmLane(
    "bundled-channel-setup-entry",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
  ),
  npmLane(
    "bundled-channel-load-failure",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=1 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=0 pnpm test:docker:bundled-channel-deps",
  ),
  npmLane(
    "bundled-channel-disabled-config",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 OPENCLAW_BUNDLED_CHANNEL_SCENARIOS=0 OPENCLAW_BUNDLED_CHANNEL_UPDATE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_ROOT_OWNED_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_SETUP_ENTRY_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_LOAD_FAILURE_SCENARIO=0 OPENCLAW_BUNDLED_CHANNEL_DISABLED_CONFIG_SCENARIO=1 pnpm test:docker:bundled-channel-deps",
  ),
];

const lanes = [
  liveLane("live-models", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-models", {
    timeoutMs: LIVE_PROFILE_TIMEOUT_MS,
    weight: 4,
  }),
  liveLane("live-gateway", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-gateway", {
    timeoutMs: LIVE_PROFILE_TIMEOUT_MS,
    weight: 4,
  }),
  liveLane(
    "live-cli-backend-claude",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:claude",
    { resources: ["npm"], timeoutMs: LIVE_CLI_TIMEOUT_MS, weight: 3 },
  ),
  liveLane(
    "live-cli-backend-gemini",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:gemini",
    { resources: ["npm"], timeoutMs: LIVE_CLI_TIMEOUT_MS, weight: 3 },
  ),
  serviceLane("openwebui", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openwebui", {
    timeoutMs: OPENWEBUI_TIMEOUT_MS,
    weight: 5,
  }),
  serviceLane("onboard", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:onboard", {
    weight: 2,
  }),
  npmLane(
    "npm-onboard-channel-agent",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:npm-onboard-channel-agent",
    { resources: ["service"], weight: 3 },
  ),
  serviceLane("gateway-network", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:gateway-network"),
  serviceLane(
    "agents-delete-shared-workspace",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:agents-delete-shared-workspace",
  ),
  serviceLane("mcp-channels", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:mcp-channels", {
    resources: ["npm"],
    weight: 3,
  }),
  lane("pi-bundle-mcp-tools", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:pi-bundle-mcp-tools"),
  lane("crestodian-rescue", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:crestodian-rescue"),
  serviceLane(
    "cron-mcp-cleanup",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:cron-mcp-cleanup",
    { resources: ["npm"], weight: 3 },
  ),
  npmLane("doctor-switch", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:doctor-switch", {
    weight: 3,
  }),
  lane("plugins", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugins", {
    resources: ["npm", "service"],
    weight: 6,
  }),
  npmLane("plugin-update", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:plugin-update"),
  serviceLane("config-reload", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:config-reload"),
  ...bundledScenarioLanes,
  lane("openai-image-auth", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-image-auth"),
  lane(
    "crestodian-first-run",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:crestodian-first-run",
  ),
  lane("qr", "pnpm test:docker:qr"),
];

const exclusiveLanes = [
  serviceLane(
    "openai-web-search-minimal",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:openai-web-search-minimal",
    { timeoutMs: 8 * 60 * 1000 },
  ),
  liveLane(
    "live-codex-harness",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-codex-harness",
    { resources: ["npm"], timeoutMs: LIVE_ACP_TIMEOUT_MS, weight: 3 },
  ),
  liveLane("live-codex-bind", "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-codex-bind", {
    resources: ["npm"],
    timeoutMs: LIVE_ACP_TIMEOUT_MS,
    weight: 3,
  }),
  liveLane(
    "live-cli-backend-codex",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-cli-backend:codex",
    { resources: ["npm"], timeoutMs: LIVE_CLI_TIMEOUT_MS, weight: 3 },
  ),
  liveLane(
    "live-acp-bind-claude",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:claude",
    { resources: ["npm"], timeoutMs: LIVE_ACP_TIMEOUT_MS, weight: 3 },
  ),
  liveLane(
    "live-acp-bind-codex",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:codex",
    { resources: ["npm"], timeoutMs: LIVE_ACP_TIMEOUT_MS, weight: 3 },
  ),
  liveLane(
    "live-acp-bind-gemini",
    "OPENCLAW_SKIP_DOCKER_BUILD=1 pnpm test:docker:live-acp-bind:gemini",
    { resources: ["npm"], timeoutMs: LIVE_ACP_TIMEOUT_MS, weight: 3 },
  ),
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

function parseResourceLimit(env, resource, parallelism, fallback) {
  const envName = `OPENCLAW_DOCKER_ALL_${resource.toUpperCase()}_LIMIT`;
  return parsePositiveInt(env[envName], Math.min(parallelism, fallback), envName);
}

function parseSchedulerOptions(env, parallelism) {
  const weightLimit = parsePositiveInt(
    env.OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT,
    parallelism,
    "OPENCLAW_DOCKER_ALL_WEIGHT_LIMIT",
  );
  return {
    resourceLimits: {
      docker: parseResourceLimit(env, "docker", parallelism, parallelism),
      live: parseResourceLimit(env, "live", parallelism, DEFAULT_RESOURCE_LIMITS.live),
      npm: parseResourceLimit(env, "npm", parallelism, DEFAULT_RESOURCE_LIMITS.npm),
      service: parseResourceLimit(env, "service", parallelism, DEFAULT_RESOURCE_LIMITS.service),
    },
    weightLimit,
  };
}

function laneWeight(poolLane) {
  return Math.max(1, poolLane.weight ?? 1);
}

function laneResources(poolLane) {
  return ["docker", ...(poolLane.resources ?? [])];
}

function laneSummary(poolLane) {
  const resources = laneResources(poolLane).join(",");
  const timeout = poolLane.timeoutMs ? ` timeout=${Math.round(poolLane.timeoutMs / 1000)}s` : "";
  return `${poolLane.name}(w=${laneWeight(poolLane)} r=${resources}${timeout})`;
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
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

function runShellCommand({ command, env, label, logFile, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
      cwd: ROOT_DIR,
      detached: process.platform !== "win32",
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
            terminateChild(child, "SIGTERM");
            killTimer = setTimeout(() => terminateChild(child, "SIGKILL"), 10_000);
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

function runShellCaptureCommand({ command, env, label, timeoutMs }) {
  return new Promise((resolve) => {
    const child = spawn("bash", ["-lc", command], {
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
  const results = await Promise.allSettled(
    entries.map(async ([label, command]) => {
      await runForeground(label, command, env);
    }),
  );
  const failures = results
    .map((result, index) => ({ result, entry: entries[index] }))
    .filter(({ result }) => result.status === "rejected");
  if (failures.length > 0) {
    throw new Error(
      failures
        .map(
          ({ result, entry }) => `${entry[0]}: ${result.reason?.message ?? String(result.reason)}`,
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

async function prepareBundledChannelPackage(baseEnv, logDir) {
  if (baseEnv.OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ) {
    console.log(`==> Bundled channel package: ${baseEnv.OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ}`);
    return;
  }

  const packDir = path.join(logDir, "bundled-channel-package");
  await mkdir(packDir, { recursive: true });
  const packScript = [
    "set -euo pipefail",
    "node --import tsx --input-type=module -e \"const { writePackageDistInventory } = await import('./src/infra/package-dist-inventory.ts'); await writePackageDistInventory(process.cwd());\"",
    "npm pack --silent --ignore-scripts --pack-destination /tmp/openclaw-pack >/tmp/openclaw-pack.out",
    "cat /tmp/openclaw-pack.out",
  ].join("\n");
  await runForeground(
    "Pack bundled channel package once from Docker E2E image",
    [
      "docker run --rm",
      "-e COREPACK_ENABLE_DOWNLOAD_PROMPT=0",
      `-v ${shellQuote(packDir)}:/tmp/openclaw-pack`,
      shellQuote(baseEnv.OPENCLAW_DOCKER_E2E_IMAGE),
      "bash -lc",
      shellQuote(packScript),
    ].join(" "),
    baseEnv,
  );

  const packed = (await fs.promises.readdir(packDir))
    .filter((entry) => /^openclaw-.*\.tgz$/.test(entry))
    .toSorted()
    .at(-1);
  if (!packed) {
    throw new Error(`missing packed OpenClaw tarball in ${packDir}`);
  }
  baseEnv.OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ = path.join(packDir, packed);
  baseEnv.OPENCLAW_BUNDLED_CHANNEL_HOST_BUILD = "0";
  baseEnv.OPENCLAW_NPM_ONBOARD_PACKAGE_TGZ = baseEnv.OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ;
  baseEnv.OPENCLAW_NPM_ONBOARD_HOST_BUILD = "0";
  console.log(`==> Bundled channel package: ${baseEnv.OPENCLAW_BUNDLED_CHANNEL_PACKAGE_TGZ}`);
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

async function runLane(lane, baseEnv, logDir, fallbackTimeoutMs) {
  const { command, name } = lane;
  const timeoutMs = lane.timeoutMs ?? fallbackTimeoutMs;
  const logFile = path.join(logDir, `${name}.log`);
  const env = laneEnv(name, baseEnv, logDir);
  await mkdir(env.OPENCLAW_DOCKER_CLI_TOOLS_DIR, { recursive: true });
  await mkdir(env.OPENCLAW_DOCKER_CACHE_HOME_DIR, { recursive: true });
  await fs.promises.writeFile(
    logFile,
    [
      `==> [${name}] cli tools dir: ${env.OPENCLAW_DOCKER_CLI_TOOLS_DIR}`,
      `==> [${name}] cache dir: ${env.OPENCLAW_DOCKER_CACHE_HOME_DIR}`,
      `==> [${name}] timeout: ${timeoutMs}ms`,
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
    elapsedSeconds,
    status: result.status,
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
    const weight = laneWeight(candidate);
    if (active.count >= parallelism || active.weight + weight > options.weightLimit) {
      return false;
    }
    for (const resource of laneResources(candidate)) {
      const limit = options.resourceLimits[resource] ?? options.weightLimit;
      const current = active.resources.get(resource) ?? 0;
      if (current + weight > limit) {
        return false;
      }
    }
    return true;
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
        throw new Error(`No Docker lanes fit scheduler limits: ${blocked}`);
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
  const timingsFile = path.resolve(
    process.env.OPENCLAW_DOCKER_ALL_TIMINGS_FILE || DEFAULT_TIMINGS_FILE,
  );
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

  const timingStore = await loadTimingStore(timingsFile, timingsEnabled);
  const orderedLanes = orderLanes(lanes, timingStore);
  const orderedTailLanes = orderLanes(tailLanes, timingStore);

  console.log(`==> Docker test logs: ${logDir}`);
  console.log(`==> Parallelism: ${parallelism}`);
  console.log(`==> Tail parallelism: ${tailParallelism}`);
  console.log(`==> Lane timeout: ${laneTimeoutMs}ms`);
  console.log(`==> Lane start stagger: ${laneStartStaggerMs}ms`);
  console.log(`==> Status interval: ${statusIntervalMs}ms`);
  console.log(`==> Fail fast: ${failFast ? "yes" : "no"}`);
  console.log(`==> Dry run: ${dryRun ? "yes" : "no"}`);
  console.log(
    `==> Docker preflight: ${preflightEnabled ? "yes" : "no"}${
      preflightCleanup ? " cleanup=yes" : " cleanup=no"
    }`,
  );
  console.log(`==> Docker lane timings: ${timingStore.enabled ? timingsFile : "disabled"}`);
  console.log(`==> Live-test bundled plugin deps: ${baseEnv.OPENCLAW_DOCKER_BUILD_EXTENSIONS}`);
  const schedulerOptions = parseSchedulerOptions(process.env, parallelism);
  const tailSchedulerOptions = parseSchedulerOptions(process.env, tailParallelism);
  console.log(
    `==> Scheduler: weight=${schedulerOptions.weightLimit} docker=${schedulerOptions.resourceLimits.docker} live=${schedulerOptions.resourceLimits.live} npm=${schedulerOptions.resourceLimits.npm} service=${schedulerOptions.resourceLimits.service}`,
  );
  console.log(
    `==> Tail scheduler: weight=${tailSchedulerOptions.weightLimit} docker=${tailSchedulerOptions.resourceLimits.docker} live=${tailSchedulerOptions.resourceLimits.live} npm=${tailSchedulerOptions.resourceLimits.npm} service=${tailSchedulerOptions.resourceLimits.service}`,
  );
  printLaneManifest("Main", orderedLanes, timingStore);
  printLaneManifest("Tail", orderedTailLanes, timingStore);
  if (dryRun) {
    console.log("==> Dry run complete");
    return;
  }

  await runDockerPreflight(baseEnv, {
    cleanup: preflightCleanup,
    enabled: preflightEnabled,
    runTimeoutMs: preflightRunTimeoutMs,
  });

  await runForegroundGroup(
    [
      ["Build shared live-test image once", "pnpm test:docker:live-build"],
      [
        `Build shared Docker E2E image once: ${baseEnv.OPENCLAW_DOCKER_E2E_IMAGE}`,
        "pnpm test:docker:e2e-build",
      ],
    ],
    baseEnv,
  );
  await prepareBundledChannelPackage(baseEnv, logDir);

  const options = {
    ...schedulerOptions,
    failFast,
    poolLabel: "main",
    startStaggerMs: laneStartStaggerMs,
    statusIntervalMs,
    timeoutMs: laneTimeoutMs,
  };
  const mainResult = await runLanePool(orderedLanes, baseEnv, logDir, parallelism, options);
  const failures = [...mainResult.failures];
  const allResults = [...mainResult.results];
  await writeTimingStore(timingStore, mainResult.results);
  if (failFast && failures.length > 0) {
    await printFailureSummary(failures, tailLines);
    process.exit(1);
  }

  console.log("==> Running provider-sensitive Docker tail lanes");
  const tailResult = await runLanePool(orderedTailLanes, baseEnv, logDir, tailParallelism, {
    ...options,
    ...tailSchedulerOptions,
    poolLabel: "tail",
  });
  failures.push(...tailResult.failures);
  allResults.push(...tailResult.results);
  await writeTimingStore(timingStore, tailResult.results);
  if (failures.length > 0) {
    await printFailureSummary(failures, tailLines);
    process.exit(1);
  }

  await runForeground(
    "Run cleanup smoke after parallel lanes",
    "pnpm test:docker:cleanup",
    baseEnv,
  );
  await writeTimingStore(timingStore, allResults);
  console.log("==> Docker test suite passed");
}

await main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
