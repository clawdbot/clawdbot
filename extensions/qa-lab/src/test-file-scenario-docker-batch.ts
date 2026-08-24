import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { z } from "zod";
import type { QaSeedScenarioWithSource } from "./scenario-catalog.js";
import { shellQuote } from "./shell-quote.js";
import { runQaScenarioCommandLifecycle } from "./test-file-scenario-command-lifecycle.js";

const QA_DOCKER_E2E_LANE_SCRIPT = "test/e2e/qa-lab/runtime/docker-e2e-lane.ts";
const DOCKER_CANDIDATE_ENV_KEY =
  /^(?:OPENCLAW_DOCKER_E2E_SELECTED_SHA|OPENCLAW_CURRENT_PACKAGE_(?:TGZ|VERSION|SHA256)|OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_(?:DIR|CANDIDATE_VERSION|MANIFEST_SHA256))$/u;
const dockerRegistrySchema = z.strictObject({
  dir: z.string(),
  candidateVersion: z.string(),
  manifestSha256: z.string(),
});
const dockerPackageSchema = z.strictObject({
  path: z.string(),
  name: z.literal("openclaw"),
  version: z.string(),
  sha256: z.string(),
});
const dockerCandidateManifestSchema = z.strictObject({
  schema: z.literal("openclaw.qa-docker-candidate/v1"),
  schemaVersion: z.literal(1),
  sourceSha: z.string(),
  candidate: z
    .strictObject({
      package: dockerPackageSchema,
      registry: dockerRegistrySchema.nullable(),
    })
    .nullable(),
});

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

export async function prepareDockerE2eEnvironment(params: {
  env: NodeJS.ProcessEnv;
  outputDir: string;
  repoRoot: string;
  runCommand?: typeof runQaScenarioCommandLifecycle;
  scenarios: readonly QaSeedScenarioWithSource[];
}): Promise<Readonly<NodeJS.ProcessEnv> | undefined> {
  const laneNames = [
    ...new Set(params.scenarios.flatMap((scenario) => dockerE2eLaneName(scenario) ?? [])),
  ];
  if (laneNames.length === 0) {
    return undefined;
  }
  const prepDir = path.join(params.outputDir, "docker-candidate");
  const manifestPath = path.join(prepDir, "manifest.json");
  const env = { ...params.env };
  for (const key of Object.keys(env)) {
    if (
      key.startsWith("OPENCLAW_DOCKER_ALL_") ||
      DOCKER_CANDIDATE_ENV_KEY.test(key) ||
      key === "DOCKER_E2E_LANES"
    ) {
      delete env[key];
    }
  }
  await fs.mkdir(prepDir, { recursive: true });
  await fs.rm(manifestPath, { force: true });
  const result = await (params.runCommand ?? runQaScenarioCommandLifecycle)({
    command: process.execPath,
    args: ["scripts/test-docker-all.mjs", `--prepare-only=${manifestPath}`],
    cwd: params.repoRoot,
    env: {
      ...env,
      OPENCLAW_DOCKER_ALL_LANES: laneNames.join(","),
      OPENCLAW_DOCKER_ALL_LOG_DIR: prepDir,
      OPENCLAW_DOCKER_E2E_REPO_ROOT: params.repoRoot,
    },
  });
  if (result.exitCode !== 0) {
    throw new Error(
      result.failureMessage || result.stderr.trim() || "Docker candidate prep failed",
    );
  }
  const manifest = dockerCandidateManifestSchema.parse(
    JSON.parse(await fs.readFile(manifestPath, "utf8")),
  );
  env.OPENCLAW_DOCKER_E2E_REPO_ROOT = params.repoRoot;
  if (manifest.candidate === null) {
    return Object.freeze(env);
  }
  const { package: packageCandidate, registry } = manifest.candidate;
  return Object.freeze(
    Object.assign(env, {
      OPENCLAW_DOCKER_E2E_SELECTED_SHA: manifest.sourceSha,
      OPENCLAW_CURRENT_PACKAGE_TGZ: packageCandidate.path,
      OPENCLAW_CURRENT_PACKAGE_VERSION: packageCandidate.version,
      OPENCLAW_CURRENT_PACKAGE_SHA256: packageCandidate.sha256,
      ...(registry
        ? {
            OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_DIR: registry.dir,
            OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_CANDIDATE_VERSION: registry.candidateVersion,
            OPENCLAW_PREPUBLISH_PLUGIN_REGISTRY_MANIFEST_SHA256: registry.manifestSha256,
          }
        : {}),
    }),
  );
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
  runCommand: typeof runQaScenarioCommandLifecycle;
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
  let commandResult: Awaited<ReturnType<typeof runQaScenarioCommandLifecycle>>;
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
