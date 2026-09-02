import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
  validateQaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/api.js";
import { coerceErrorMessage as formatErrorMessage } from "../../../../scripts/lib/error-format.mts";
import { createQaScriptEvidenceWriter } from "./script-evidence.js";

const SCENARIO_ID = "managed-gateway-service-lifecycle";
const SOURCE_PATH = "test/e2e/qa-lab/runtime/managed-gateway-service-lifecycle-product-proof.ts";

type ProofPhase = {
  coverageIds: string[];
  name: string;
  passDetails?: string;
  testPaths: string[];
  vitestArgs?: string[];
};

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type ProofResult = {
  coverageIds: string[];
  name: string;
  status: "passed";
};

const phases: ProofPhase[] = [
  {
    name: "foreground-cli-runtime",
    coverageIds: ["cli.foreground-gateway-runs"],
    passDetails: "/healthz=live, /readyz=ready, health RPC=object, child/provider cleanup=passed",
    testPaths: ["extensions/qa-lab/src/managed-gateway-service-lifecycle.e2e.test.ts"],
    vitestArgs: ["run", "--config", "test/vitest/vitest.e2e.config.ts"],
  },
  {
    name: "foreground-cli-option-validation",
    coverageIds: ["cli.foreground-gateway-runs"],
    testPaths: ["src/cli/gateway-cli/run.option-collisions.test.ts"],
  },
  {
    name: "install-and-control",
    coverageIds: ["cli.service-install-and-control"],
    testPaths: [
      "src/cli/daemon-cli/install.integration.test.ts",
      "src/cli/daemon-cli/register-service-commands.test.ts",
      "src/daemon/launchd-system.test.ts",
      "src/daemon/systemd.test.ts",
      "src/daemon/systemd-system.test.ts",
      "src/daemon/systemd-unit.test.ts",
      "src/daemon/schtasks.install.test.ts",
      "src/daemon/schtasks.stop.test.ts",
    ],
  },
  {
    name: "drift-and-reinstall-recovery",
    coverageIds: ["cli.drift-and-reinstall-recovery"],
    testPaths: ["src/cli/daemon-cli/install.test.ts", "src/cli/daemon-cli/lifecycle.test.ts"],
  },
  {
    name: "post-operation-health",
    coverageIds: ["cli.service-health-checks"],
    testPaths: [
      "src/cli/daemon-cli/restart-health.test.ts",
      "src/cli/daemon-cli/restart-health-probe.test.ts",
      "src/cli/daemon-cli/restart-health-wait.test.ts",
      "src/cli/daemon-cli/status.test.ts",
    ],
  },
];

if (process.platform === "darwin") {
  phases.push({
    name: "native-launchd",
    coverageIds: ["cli.service-install-and-control", "cli.service-health-checks"],
    testPaths: ["src/daemon/launchd.integration.e2e.test.ts"],
    vitestArgs: ["run", "--config", "test/vitest/vitest.e2e.config.ts"],
  });
} else if (process.platform === "win32") {
  phases.push({
    name: "native-scheduled-task",
    coverageIds: ["cli.service-install-and-control", "cli.service-health-checks"],
    testPaths: ["src/daemon/schtasks.integration.e2e.test.ts"],
    vitestArgs: ["run", "--config", "test/vitest/vitest.e2e.config.ts"],
  });
}

function parseOptions(args: string[]): ProducerOptions {
  if (args.length !== 2 || args[0] !== "--artifact-base" || !args[1]) {
    throw new Error("usage: --artifact-base <output-directory>");
  }
  return {
    artifactBase: path.resolve(args[1]),
    repoRoot: process.cwd(),
  };
}

function runVitestPhase(phase: ProofPhase, log: (message: string) => void): ProofResult {
  log(`[managed-gateway-service] START ${phase.name} (${phase.coverageIds.join(", ")})`);
  const result = spawnSync(
    process.execPath,
    [
      "scripts/run-vitest.mjs",
      ...(phase.vitestArgs ?? []),
      ...phase.testPaths,
      "--reporter=verbose",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    },
  );
  if (result.error) {
    throw result.error;
  }
  if (result.signal) {
    throw new Error(
      `${phase.name} terminated by signal ${result.signal} for ${phase.coverageIds.join(", ")}`,
    );
  }
  if (result.status !== 0) {
    throw new Error(
      `${phase.name} failed with exit ${result.status ?? "unknown"} for ${phase.coverageIds.join(", ")}`,
    );
  }
  log(
    `[managed-gateway-service] PASS ${phase.name}${phase.passDetails ? ` (${phase.passDetails})` : ""}`,
  );
  return {
    coverageIds: phase.coverageIds,
    name: phase.name,
    status: "passed",
  };
}

async function assertFreshEvidence(params: {
  artifactBase: string;
  expectedStatus: "pass" | "fail";
  startedAt: number;
}): Promise<void> {
  const evidencePath = path.join(params.artifactBase, QA_EVIDENCE_FILENAME);
  const evidence = validateQaEvidenceSummaryJson(
    JSON.parse(await fs.readFile(evidencePath, "utf8")),
  );
  if (Date.parse(evidence.generatedAt) < params.startedAt) {
    throw new Error(`${QA_EVIDENCE_FILENAME} was not written by the current producer run`);
  }
  const entry = evidence.entries.find((candidate) => candidate.test.id === SCENARIO_ID);
  if (!entry || entry.result.status !== params.expectedStatus) {
    throw new Error(
      `${QA_EVIDENCE_FILENAME} does not record ${SCENARIO_ID} as ${params.expectedStatus}`,
    );
  }
}

function createEvidenceWriter(options: ProducerOptions) {
  return createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: "managed-gateway-service-lifecycle.log",
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      codeRefs: [
        SOURCE_PATH,
        "extensions/qa-lab/src/managed-gateway-service-lifecycle.e2e.test.ts",
        "src/cli/gateway-cli/run.option-collisions.test.ts",
        "src/cli/daemon-cli/install.integration.test.ts",
        "src/cli/daemon-cli/lifecycle.test.ts",
        "src/cli/daemon-cli/restart-health.test.ts",
        "src/daemon/launchd.integration.e2e.test.ts",
        "src/daemon/systemd.test.ts",
        "src/daemon/schtasks.integration.e2e.test.ts",
      ],
      docsRefs: [
        "docs/cli/gateway.md",
        "docs/install/updating.md",
        "docs/gateway/troubleshooting.md",
        "docs/reference/test.md",
      ],
      id: SCENARIO_ID,
      sourcePath: SOURCE_PATH,
      title: "Managed gateway service lifecycle",
    },
  });
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const startedAt = Date.now();
  const writer = createEvidenceWriter(options);
  const log = (message: string) => {
    console.log(message);
    writer.appendLog(`${message}\n`);
  };

  try {
    const results: ProofResult[] = [];
    for (const phase of phases) {
      results.push(runVitestPhase(phase, log));
    }
    log(
      JSON.stringify({
        kind: "managed-gateway-service-lifecycle-proof",
        platform: process.platform,
        phases: results,
      }),
    );
    const evidence = await writer.write({
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    });
    await assertFreshEvidence({
      artifactBase: options.artifactBase,
      expectedStatus: "pass",
      startedAt,
    });
    return evidence;
  } catch (error) {
    const details = formatErrorMessage(error);
    writer.appendLog(`fail: ${details}\n`);
    const evidence = await writer.write({
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    });
    await assertFreshEvidence({
      artifactBase: options.artifactBase,
      expectedStatus: "fail",
      startedAt,
    });
    return evidence;
  }
}

async function main(args: string[]): Promise<number> {
  const evidence = await runProducer(parseOptions(args));
  const status = evidence.entries[0]?.result.status;
  console.log(`Managed gateway service lifecycle evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Managed gateway service lifecycle status: ${status}`);
  return status === "pass" ? 0 : 1;
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

export const testing = {
  main,
};
