// Produces QA evidence for the destructive package-backed update.run Docker lane.
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SOURCE_PATH = "test/e2e/qa-lab/runtime/update-run-package-self-upgrade.ts";
const SCENARIO_ID = "update-run-package-self-upgrade";
const ALLOW_ENV = "OPENCLAW_QA_ALLOW_UPDATE_RUN_SELF";

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type UpdateRunSelfUpgradeSummary = {
  installedVersion?: string;
  source?: { version?: string };
  target?: { resolvedVersion?: string; tag?: string };
  restartSentinel?: { message?: string; status?: string };
};

function formatErrorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function parseUpdateRunSelfUpgradeOptions(args: string[]): ProducerOptions {
  let artifactBase: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (option !== "--artifact-base") {
      throw new Error(`unknown argument: ${option}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error("--artifact-base requires a value");
    }
    artifactBase = value;
    index += 1;
  }
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return { artifactBase: path.resolve(artifactBase), repoRoot: process.cwd() };
}

export function resolveUpdateRunSelfUpgradePermission(
  env: NodeJS.ProcessEnv = process.env,
): { allowed: true } | { allowed: false; reason: string } {
  if (env[ALLOW_ENV] === "1") {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason: `blocked destructive package self-upgrade; set ${ALLOW_ENV}=1 to run`,
  };
}

export function formatUpdateRunSelfUpgradeDetails(summary: UpdateRunSelfUpgradeSummary) {
  return [
    `source=${summary.source?.version ?? "unknown"}`,
    `target=${summary.target?.tag ?? "unknown"}:${summary.target?.resolvedVersion ?? "unknown"}`,
    `installed=${summary.installedVersion ?? "unknown"}`,
    `sentinel=${summary.restartSentinel?.status ?? "unknown"}:${summary.restartSentinel?.message ?? "missing"}`,
  ].join("; ");
}

async function runDockerLane(options: ProducerOptions, appendLog: (chunk: unknown) => void) {
  const dockerRunDir = path.join(options.artifactBase, "docker-run");
  const laneArtifactDir = path.join(options.artifactBase, "lane");
  await fs.mkdir(dockerRunDir, { recursive: true });
  await fs.mkdir(laneArtifactDir, { recursive: true });
  return await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      const child = spawn(process.execPath, ["scripts/test-docker-all.mjs"], {
        cwd: options.repoRoot,
        env: {
          ...process.env,
          [ALLOW_ENV]: "1",
          OPENCLAW_DOCKER_ALL_BUILD: "1",
          OPENCLAW_DOCKER_ALL_DRY_RUN: "0",
          OPENCLAW_DOCKER_ALL_LANES: SCENARIO_ID,
          OPENCLAW_DOCKER_ALL_LOG_DIR: dockerRunDir,
          OPENCLAW_DOCKER_ALL_PARALLELISM: "1",
          OPENCLAW_DOCKER_ALL_PREFLIGHT: "1",
          OPENCLAW_DOCKER_ALL_TIMINGS_FILE: path.join(dockerRunDir, "lane-timings.json"),
          OPENCLAW_UPDATE_RUN_SELF_UPGRADE_ARTIFACT_DIR: laneArtifactDir,
        },
        stdio: ["ignore", "pipe", "pipe"],
      });
      child.on("error", reject);
      child.stdout.on("data", (chunk: Buffer) => {
        process.stdout.write(chunk);
        appendLog(chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        process.stderr.write(chunk);
        appendLog(chunk);
      });
      child.on("exit", (code, signal) => resolve({ code, signal }));
    },
  );
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "update-run-package-self-upgrade.log",
    primaryModel: "gateway/update.run",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      codeRefs: [
        SOURCE_PATH,
        "scripts/e2e/update-run-package-self-upgrade-docker.sh",
        "scripts/e2e/lib/upgrade-survivor/update-run-package-self-upgrade.sh",
        "scripts/e2e/lib/upgrade-survivor/assertions.mjs",
        "scripts/lib/docker-e2e-scenarios.mjs",
        "src/gateway/server-methods/update.ts",
      ],
      docsRefs: [
        "docs/cli/update.md",
        "docs/install/updating.md",
        "docs/gateway/protocol.md",
        "docs/help/testing-updates-plugins.md",
      ],
      id: SCENARIO_ID,
      primaryCoverageIds: ["runtime.update-run"],
      secondaryCoverageIds: ["runtime.gateway-restart", "runtime.package-update"],
      sourcePath: SOURCE_PATH,
      title: "Gateway update.run package self-upgrade",
    },
  });
  const startedAt = Date.now();
  const permission = resolveUpdateRunSelfUpgradePermission();
  if (!permission.allowed) {
    writer.appendLog(`${permission.reason}\n`);
    return await writer.write({
      details: permission.reason,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "blocked",
    });
  }

  try {
    const result = await runDockerLane(options, (chunk) => writer.appendLog(chunk));
    if (result.code !== 0 || result.signal) {
      throw new Error(
        `Docker lane ${SCENARIO_ID} failed: code=${String(result.code)} signal=${String(result.signal)}`,
      );
    }
    const laneDir = path.join(options.artifactBase, "lane");
    const summary = JSON.parse(
      await fs.readFile(path.join(laneDir, "summary.json"), "utf8"),
    ) as UpdateRunSelfUpgradeSummary;
    return await writer.write({
      artifacts: [
        { kind: "summary", filePath: path.join("lane", "summary.json") },
        { kind: "rpc", filePath: path.join("lane", "update-rpc.json") },
        { kind: "sentinel", filePath: path.join("lane", "update-status.json") },
        {
          kind: "summary",
          filePath: path.join("lane", "qa-channel-install-record.json"),
        },
        { kind: "summary", filePath: path.join("lane", "source-plugin-index.json") },
        { kind: "summary", filePath: path.join("lane", "source-plugin-inspect.json") },
        { kind: "summary", filePath: path.join("lane", "target-plugin-index.json") },
        { kind: "log", filePath: path.join("lane", "historical-qa-channel-build.log") },
        {
          kind: "summary",
          filePath: path.join("lane", "qa-channel-fixture-provenance.json"),
        },
        { kind: "log", filePath: path.join("lane", "systemctl-shim.log") },
        { kind: "log", filePath: path.join("lane", "systemctl-shim-setup.log") },
        { kind: "log", filePath: path.join("lane", "supervisor-monitor.log") },
        { kind: "log", filePath: path.join("lane", "systemctl-shim-gateway.log") },
        { kind: "summary", filePath: path.join("lane", "openclaw-gateway.service") },
        { kind: "health", filePath: path.join("lane", "healthz.json") },
        { kind: "health", filePath: path.join("lane", "readyz.json") },
        { kind: "health", filePath: path.join("lane", "gateway-status.json") },
        { kind: "channel-status", filePath: path.join("lane", "channels-status.json") },
        { kind: "summary", filePath: path.join("docker-run", "summary.json") },
      ],
      details: formatUpdateRunSelfUpgradeDetails(summary),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`\nfail: ${details}\n`);
    return await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
  }
}

async function main(argv: string[]) {
  const evidence = await runProducer(parseUpdateRunSelfUpgradeOptions(argv));
  const status = evidence.entries[0]?.result.status;
  console.log(`Update run package self-upgrade evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Update run package self-upgrade status: ${status}`);
  return status === "pass" || status === "blocked" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
