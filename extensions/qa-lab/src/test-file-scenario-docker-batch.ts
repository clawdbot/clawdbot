import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { shellQuote } from "./shell-quote.js";
import type {
  QaScenarioCommandExecution,
  QaScenarioCommandResult,
} from "./test-file-scenario-command-lifecycle.js";

const QA_DOCKER_E2E_LANE_SCRIPT = "test/e2e/qa-lab/runtime/docker-e2e-lane.ts";

type QaDockerScenario = QaSeedScenarioWithSource & {
  execution: Extract<QaSeedScenarioWithSource["execution"], { kind: "script" }>;
};

type QaDockerBatchResult = {
  durationMs: number;
  failureMessage?: string;
  logPath: string;
  scenario: QaDockerScenario;
  status: "fail" | "pass";
};

export function dockerE2eLaneName(scenario: QaSeedScenarioWithSource) {
  const args = scenario.execution.kind === "script" ? scenario.execution.args : undefined;
  if (
    scenario.execution.kind !== "script" ||
    scenario.execution.path !== QA_DOCKER_E2E_LANE_SCRIPT ||
    args?.length !== 2 ||
    args[0] !== "--lane"
  ) {
    return undefined;
  }
  const laneName = args[1]?.trim();
  return laneName || undefined;
}

export function isDockerE2eScenario(
  scenario: QaSeedScenarioWithSource,
): scenario is QaDockerScenario {
  return dockerE2eLaneName(scenario) !== undefined;
}

function laneMatches(
  selectedLane: string,
  resultLane: string | undefined,
  resolvedLaneNames: readonly string[],
) {
  // The scheduler summary records aliases as their resolved lanes. Prefix matching is
  // safe only when the selected name itself disappeared during that resolution.
  return (
    resultLane === selectedLane ||
    (!resolvedLaneNames.includes(selectedLane) &&
      resultLane !== undefined &&
      resolvedLaneNames.includes(resultLane) &&
      resultLane.startsWith(`${selectedLane}-`))
  );
}

export async function runDockerE2eBatch(params: {
  commandTimeoutMs: number;
  env: NodeJS.ProcessEnv;
  outputDir: string;
  repoRoot: string;
  runCommand: (command: QaScenarioCommandExecution) => Promise<QaScenarioCommandResult>;
  scenarios: readonly QaDockerScenario[];
}): Promise<QaDockerBatchResult[]> {
  const selected = params.scenarios.map((scenario) => ({
    lane: dockerE2eLaneName(scenario)!,
    scenario,
  }));
  const laneNames = [...new Set(selected.map(({ lane }) => lane))];
  const batchId = `${params.commandTimeoutMs}ms`;
  const dockerOutputDir = path.join(params.outputDir, `docker-e2e-${batchId}`);
  const logPath = path.join(params.outputDir, `docker-e2e-batch-${batchId}.log`);
  await fs.mkdir(dockerOutputDir, { recursive: true });
  const summaryPath = path.join(dockerOutputDir, "summary.json");
  await fs.rm(summaryPath, { force: true });
  let commandResult: QaScenarioCommandResult;
  try {
    commandResult = await params.runCommand({
      command: process.execPath,
      args: ["scripts/test-docker-all.mjs"],
      cwd: params.repoRoot,
      env: {
        ...params.env,
        OPENCLAW_DOCKER_ALL_BUILD: "1",
        OPENCLAW_DOCKER_ALL_FAIL_FAST: "0",
        OPENCLAW_DOCKER_ALL_LANES: laneNames.join(","),
        OPENCLAW_DOCKER_ALL_LANE_TIMEOUT_MS: String(params.commandTimeoutMs),
        OPENCLAW_DOCKER_ALL_LOG_DIR: dockerOutputDir,
        OPENCLAW_DOCKER_ALL_PROFILE: "all",
        OPENCLAW_DOCKER_ALL_TIMINGS_FILE: path.join(dockerOutputDir, "lane-timings.json"),
      },
      // The scheduler owns each resolved lane deadline. Parent signals and the
      // enclosing QA workflow bound the aggregate run without alias-count guesses.
    });
  } catch (error) {
    commandResult = {
      exitCode: 1,
      failureMessage: formatErrorMessage(error),
      stderr: `${formatErrorMessage(error)}\n`,
      stdout: "",
    };
  }
  await fs.writeFile(
    logPath,
    `$ ${shellQuote(process.execPath)} scripts/test-docker-all.mjs\n${commandResult.stdout}${commandResult.stderr}`,
    "utf8",
  );

  let summary:
    | {
        failures?: Array<{ name?: string }>;
        lanes?: Array<{ elapsedSeconds?: number; name?: string; status?: number }>;
        selectedLanes?: string[];
      }
    | undefined;
  try {
    summary = JSON.parse(await fs.readFile(summaryPath, "utf8"));
  } catch {
    // The command-level failure below owns missing or incomplete scheduler output.
  }
  const lanes = summary?.lanes ?? [];
  const failures = summary?.failures ?? [];
  const resolvedLaneNames = summary?.selectedLanes ?? [];
  const unexplainedFailure =
    commandResult.exitCode !== 0 &&
    (failures.length === 0 ||
      failures.some(
        (failure) =>
          !laneNames.some((laneName) => laneMatches(laneName, failure.name, resolvedLaneNames)),
      ));
  return selected.map(({ lane, scenario }) => {
    const matchingLanes = lanes.filter((result) =>
      laneMatches(lane, result.name, resolvedLaneNames),
    );
    const failedLane = matchingLanes.find((result) => result.status !== 0);
    const failureMessage = unexplainedFailure
      ? commandResult.failureMessage || "Docker E2E scheduler failed before reporting lane results"
      : failedLane
        ? `${failedLane.name ?? lane} exited with ${String(failedLane.status ?? 1)}`
        : matchingLanes.length === 0
          ? `Docker E2E scheduler returned no result for ${lane}`
          : undefined;
    const result: QaDockerBatchResult = {
      durationMs: Math.max(
        1,
        ...matchingLanes.map((entry) => Math.max(0, entry.elapsedSeconds ?? 0) * 1000),
      ),
      logPath,
      scenario,
      status: failureMessage ? "fail" : "pass",
    };
    if (failureMessage) {
      result.failureMessage = failureMessage;
    }
    return result;
  });
}
