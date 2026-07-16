// Heartbeat active-hours evidence runs the real bounded scheduler and reload path.
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { OpenClawConfig } from "../../../../src/config/types.openclaw.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { isWithinActiveHours } from "../../../../src/infra/heartbeat-active-hours.js";
import { startHeartbeatRunner } from "../../../../src/infra/heartbeat-runner.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const DEFAULT_TIMEOUT_MS = 5_000;
const HEARTBEAT_INTERVAL = "100ms";

type HeartbeatRuntimeOptions = {
  artifactBase: string;
  repoRoot: string;
  timeoutMs: number;
};

type SchedulerObservation = {
  at: string;
  outcome: "active-fire" | "quiet-hours-skip";
};

function parseOptions(argv: string[], repoRoot = process.cwd()): HeartbeatRuntimeOptions {
  let artifactBase = path.join(repoRoot, ".artifacts", "qa-e2e", "heartbeat-active-hours");
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      artifactBase = path.resolve(repoRoot, argv[++index] ?? "");
      continue;
    }
    if (arg === "--timeout-ms") {
      timeoutMs = Number(argv[++index]);
      continue;
    }
    if (arg === "--") {
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error("--timeout-ms must be a positive number");
  }
  return { artifactBase, repoRoot, timeoutMs };
}

function heartbeatConfig(quietHours: boolean): OpenClawConfig {
  return {
    agents: {
      defaults: {
        heartbeat: {
          activeHours: quietHours
            ? { start: "00:00", end: "00:00", timezone: "UTC" }
            : { start: "00:00", end: "24:00", timezone: "UTC" },
          every: HEARTBEAT_INTERVAL,
          target: "none",
        },
      },
    },
  };
}

async function waitForObservation(
  observations: SchedulerObservation[],
  outcome: SchedulerObservation["outcome"],
  afterCount: number,
  timeoutMs: number,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (observations.slice(afterCount).some((entry) => entry.outcome === outcome)) {
      return;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 20);
    });
  }
  throw new Error(`heartbeat scheduler did not observe ${outcome} within ${timeoutMs}ms`);
}

function createWriter(options: HeartbeatRuntimeOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "heartbeat-active-hours.log",
    primaryModel: "heartbeat/scheduler",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: "heartbeat-active-hours",
      title: "Heartbeat active-hours scheduler",
      sourcePath: "test/e2e/qa-lab/runtime/heartbeat-active-hours-runtime.ts",
      primaryCoverageIds: ["automation.active-hours"],
      docsRefs: ["docs/gateway/heartbeat.md"],
      codeRefs: [
        "test/e2e/qa-lab/runtime/heartbeat-active-hours-runtime.ts",
        "src/infra/heartbeat-runner.ts",
        "src/infra/heartbeat-active-hours.ts",
      ],
    },
  });
}

export async function runHeartbeatActiveHoursRuntime(options: HeartbeatRuntimeOptions) {
  await fs.mkdir(options.artifactBase, { recursive: true });
  const writer = createWriter(options);
  const startedAt = Date.now();
  const observations: SchedulerObservation[] = [];
  let currentConfig = heartbeatConfig(false);
  const runner = startHeartbeatRunner({
    cfg: currentConfig,
    readCurrentConfig: () => currentConfig,
    runOnce: async ({ cfg, heartbeat }) => {
      const active = isWithinActiveHours(cfg!, heartbeat);
      const outcome = active ? "active-fire" : "quiet-hours-skip";
      observations.push({ at: new Date().toISOString(), outcome });
      writer.appendLog(`heartbeat-active-hours: ${outcome}\n`);
      return active
        ? { status: "ran", durationMs: 1 }
        : { status: "skipped", reason: "quiet-hours" };
    },
    stableSchedulerSeed: "qa-heartbeat-active-hours",
  });
  try {
    await waitForObservation(observations, "active-fire", 0, options.timeoutMs);
    const beforeQuiet = observations.length;
    currentConfig = heartbeatConfig(true);
    runner.updateConfig(currentConfig);
    await waitForObservation(observations, "quiet-hours-skip", beforeQuiet, options.timeoutMs);
    const beforeReload = observations.length;
    currentConfig = heartbeatConfig(false);
    runner.updateConfig(currentConfig);
    await waitForObservation(observations, "active-fire", beforeReload, options.timeoutMs);

    const summaryPath = path.join(options.artifactBase, "heartbeat-active-hours-summary.json");
    await fs.writeFile(summaryPath, `${JSON.stringify({ observations }, null, 2)}\n`, "utf8");
    return await writer.write({
      artifacts: [{ kind: "summary", filePath: summaryPath }],
      details: "Observed active fire, quiet-hours skip, and active-hours reload fire",
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`heartbeat-active-hours: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  } finally {
    runner.stop();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  runHeartbeatActiveHoursRuntime(parseOptions(process.argv.slice(2)))
    .then((evidence) => {
      const status = evidence.entries[0]?.result.status;
      process.stdout.write(`heartbeat-active-hours: ${status}\n`);
      process.exitCode = status === "pass" ? 0 : 1;
    })
    .catch((error: unknown) => {
      process.stderr.write(`heartbeat-active-hours: ${formatErrorMessage(error)}\n`);
      process.exitCode = 1;
    });
}
