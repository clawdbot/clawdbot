// QA Lab producer proves exact-run identity inspection through a real local turn and Gateway.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/src/evidence-summary.js";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/src/gateway-child.js";
import { startQaMockOpenAiServer } from "../../../../extensions/qa-lab/src/providers/mock-openai/server.js";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.js";

const SCENARIO_ID = "agent-run-identity-inspection";
const SNAPSHOT_FILE = `${SCENARIO_ID}-summary.json`;
const TEXT_SECTIONS = [
  "Identity",
  "Authority",
  "Lineage",
  "Decisions",
  "Missing evidence",
  "Next steps",
] as const;
const IDENTITY_FIELDS = [
  "Trust domain",
  "Invoker",
  "Ingress",
  "Agent principal",
  "Agent definition",
  "Runtime instance",
  "Represented subject",
  "Sponsor",
  "Applicable grants",
  "Assurance",
] as const;

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type ProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

async function updateExecutionIdentityConfig(
  configPath: string,
  values: { enabled?: boolean; executionIdentity: boolean },
) {
  const raw = await fs.readFile(configPath, "utf8");
  const config = parseJson<Record<string, unknown>>(raw || "{}", "QA Gateway config");
  const logging =
    config.logging && typeof config.logging === "object"
      ? (config.logging as Record<string, unknown>)
      : {};
  const audit =
    logging.audit && typeof logging.audit === "object"
      ? (logging.audit as Record<string, unknown>)
      : {};
  config.logging = { ...logging, audit: { ...audit, ...values } };
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function parseOptions(argv: readonly string[]): ProducerOptions {
  const readValue = (name: string) => {
    const index = argv.indexOf(name);
    return index >= 0 ? argv[index + 1] : undefined;
  };
  const artifactBase = readValue("--artifact-base");
  if (!artifactBase) {
    throw new Error("--artifact-base is required");
  }
  return {
    artifactBase: path.resolve(artifactBase),
    repoRoot: path.resolve(readValue("--repo-root") ?? process.cwd()),
  };
}

function parseJson<T>(raw: string, label: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${label} was not JSON: ${formatErrorMessage(error)}`);
  }
}

function requireIdentityContext(result: AuditRunInspectResult) {
  if (result.identity.state !== "present") {
    throw new Error(
      `identity inspection was ${result.identity.state}: ${result.identity.reasonCode}`,
    );
  }
  return result.identity.context;
}

function normalizedContextJson(result: AuditRunInspectResult) {
  return JSON.stringify(requireIdentityContext(result));
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function assertTextProjection(text: string) {
  for (const label of [...TEXT_SECTIONS, ...IDENTITY_FIELDS]) {
    if (!text.includes(label)) {
      throw new Error(`audit text projection omitted ${label}`);
    }
  }
  if (!text.includes("run_admission_identity_not_evaluated") || !text.includes("not-applicable")) {
    throw new Error("audit text projection overstated or omitted the admission decision");
  }
}

function assertJsonProjection(result: AuditRunInspectResult, runId: string) {
  const context = requireIdentityContext(result);
  if (result.run.runId !== runId || result.coverage.state !== context.coverageState) {
    throw new Error(`audit JSON projection did not preserve exact-run coverage: ${runId}`);
  }
  if (
    context.ingress.kind !== "local-cli" ||
    context.ingress.state !== "present" ||
    context.ingress.boundary !== "agent-command.local"
  ) {
    throw new Error("local agent run did not retain authoritative local-CLI ingress");
  }
  const admission = result.decisions.find(
    (receipt) => receipt.action.family === "run" && receipt.action.operation === "admission",
  );
  if (
    !admission ||
    admission.decision.outcome !== "not-applicable" ||
    admission.decision.reasonCode !== "run_admission_identity_not_evaluated"
  ) {
    throw new Error("audit JSON projection omitted the truthful admission receipt");
  }
}

function findLocalRunId(gateway: Awaited<ReturnType<typeof startQaGatewayChild>>) {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const rows = database
      .prepare(
        "SELECT run_id, context_json FROM execution_identity_contexts ORDER BY created_at, context_id",
      )
      .all() as Array<{ run_id: string; context_json: string }>;
    const localRows = rows.filter((row) => {
      const context = parseJson<{ ingress?: { kind?: string } }>(
        row.context_json,
        "persisted local context",
      );
      return context.ingress?.kind === "local-cli";
    });
    if (localRows.length !== 1 || !localRows[0]?.run_id) {
      throw new Error(
        `local run recorded ${String(localRows.length)} local-CLI execution identity contexts`,
      );
    }
    return localRows[0].run_id;
  } finally {
    database.close();
  }
}

function inspectExecutionIdentityStorage(gateway: Awaited<ReturnType<typeof startQaGatewayChild>>) {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const table = database
      .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name = ?")
      .get("execution_identity_contexts");
    if (!table) {
      return { rowCount: 0, tablePresent: false };
    }
    const row = database
      .prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts")
      .get() as { count: number };
    return { rowCount: row.count, tablePresent: true };
  } finally {
    database.close();
  }
}

async function runLocalTurn(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  message: string,
) {
  await gateway.runCli([
    "agent",
    "--local",
    "--agent",
    "qa",
    "--session-id",
    `identity-${randomUUID()}`,
    "--message",
    message,
    "--thinking",
    "off",
    "--timeout",
    "60",
    "--json",
  ]);
}

function findRunExecutions(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  runId: string,
) {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    return database
      .prepare(
        "SELECT execution_id, context_id, created_at, context_json FROM execution_identity_contexts WHERE run_id = ? ORDER BY created_at, execution_id",
      )
      .all(runId) as Array<{
      execution_id: string;
      context_id: string;
      created_at: number;
      context_json: string;
    }>;
  } finally {
    database.close();
  }
}

async function runRepeatedIngressTurns(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  repoRoot: string,
  sessionId: string,
): Promise<void> {
  const script = path.join(
    repoRoot,
    "test/e2e/qa-lab/runtime/agent-run-identity-repeated-turn-child.ts",
  );
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", script, sessionId], {
      cwd: repoRoot,
      env: { ...process.env, ...gateway.runtimeEnv },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const collect = (chunk: Buffer) => {
      if (output.length < 8_192) {
        output += chunk.toString("utf8").slice(0, 8_192 - output.length);
      }
    };
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    const timer = setTimeout(() => child.kill("SIGTERM"), 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve();
      } else {
        reject(
          new Error(
            `repeated ingress child failed code=${String(code)} signal=${String(signal)}: ${output}`,
          ),
        );
      }
    });
  });
}

async function runProof(options: ProducerOptions): Promise<string> {
  const mock = await startQaMockOpenAiServer();
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  try {
    gateway = await startQaGatewayChild({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
    });
    await runLocalTurn(gateway, "Reply exactly: IDENTITY-DISABLED-FRESH");
    if (inspectExecutionIdentityStorage(gateway).tablePresent) {
      throw new Error("fresh-install default unexpectedly created execution identity storage");
    }
    await gateway.restartAfterStateMutation(async () => {});
    await runLocalTurn(gateway, "Reply exactly: IDENTITY-DISABLED-UPGRADE");
    if (inspectExecutionIdentityStorage(gateway).tablePresent) {
      throw new Error("existing-install restart unexpectedly created execution identity storage");
    }
    await gateway.restartAfterStateMutation(async ({ configPath }) => {
      await updateExecutionIdentityConfig(configPath, { executionIdentity: true });
    });
    await runLocalTurn(gateway, "Reply exactly: IDENTITY-INSPECTION-OK");
    const runId = findLocalRunId(gateway);
    const beforeText = await gateway.runCli(["audit", "--run", runId, "--explain"]);
    assertTextProjection(beforeText);
    const before = parseJson<AuditRunInspectResult>(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "pre-restart audit inspection",
    );
    assertJsonProjection(before, runId);
    const beforeContext = normalizedContextJson(before);

    const repeatedRunId = `identity-repeated-${randomUUID()}`;
    await runRepeatedIngressTurns(gateway, options.repoRoot, repeatedRunId);
    const repeatedRows = findRunExecutions(gateway, repeatedRunId);
    if (
      repeatedRows.length !== 2 ||
      new Set(repeatedRows.map((row) => row.execution_id)).size !== 2 ||
      new Set(repeatedRows.map((row) => row.context_id)).size !== 2
    ) {
      throw new Error(
        `repeated same-session run recorded ${String(repeatedRows.length)} non-distinct executions`,
      );
    }
    const discoveryText = await gateway.runCli(["audit", "--run", repeatedRunId, "--explain"]);
    if (
      !discoveryText.includes("execution_selection_required") ||
      !discoveryText.includes("--execution <id> --explain")
    ) {
      throw new Error("ambiguous run discovery omitted exact-execution selection guidance");
    }
    const discovery = parseJson<AuditRunInspectResult>(
      await gateway.runCli(["audit", "--run", repeatedRunId, "--explain", "--json"]),
      "repeated-run discovery",
    );
    if (discovery.identity.state !== "ambiguous" || discovery.identity.candidates.length !== 2) {
      throw new Error("repeated same-session run was not reported as two ambiguous executions");
    }
    const repeatedBeforeRestart = new Map<string, string>();
    for (const row of repeatedRows) {
      const text = await gateway.runCli(["audit", "--execution", row.execution_id, "--explain"]);
      assertTextProjection(text);
      const exact = parseJson<AuditRunInspectResult>(
        await gateway.runCli(["audit", "--execution", row.execution_id, "--explain", "--json"]),
        `execution ${row.execution_id}`,
      );
      const context = requireIdentityContext(exact);
      if (
        exact.run.executionId !== row.execution_id ||
        context.executionId !== row.execution_id ||
        context.contextId !== row.context_id ||
        context.runId !== repeatedRunId ||
        context.ingress.kind !== "api" ||
        context.ingress.state !== "unknown"
      ) {
        throw new Error(`exact execution inspection selected the wrong turn: ${row.execution_id}`);
      }
      const exactContextJson = normalizedContextJson(exact);
      if (exactContextJson !== row.context_json) {
        throw new Error(`RPC context bytes differ from persisted bytes: ${row.execution_id}`);
      }
      repeatedBeforeRestart.set(row.execution_id, exactContextJson);
    }

    await gateway.restartAfterStateMutation(async () => {});

    const afterText = await gateway.runCli(["audit", "--run", runId, "--explain"]);
    assertTextProjection(afterText);
    const after = parseJson<AuditRunInspectResult>(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "post-restart audit inspection",
    );
    assertJsonProjection(after, runId);
    const afterContext = normalizedContextJson(after);
    if (afterContext !== beforeContext) {
      throw new Error("normalized execution identity context bytes changed across Gateway restart");
    }
    for (const [executionId, expectedContext] of repeatedBeforeRestart) {
      const afterExact = parseJson<AuditRunInspectResult>(
        await gateway.runCli(["audit", "--execution", executionId, "--explain", "--json"]),
        `post-restart execution ${executionId}`,
      );
      if (normalizedContextJson(afterExact) !== expectedContext) {
        throw new Error(`repeated execution changed across Gateway restart: ${executionId}`);
      }
    }
    const retainedBeforeGlobalDisable = inspectExecutionIdentityStorage(gateway).rowCount;
    await gateway.restartAfterStateMutation(async ({ configPath }) => {
      await updateExecutionIdentityConfig(configPath, {
        enabled: false,
        executionIdentity: true,
      });
    });
    await runLocalTurn(gateway, "Reply exactly: IDENTITY-DISABLED-GLOBAL");
    if (inspectExecutionIdentityStorage(gateway).rowCount !== retainedBeforeGlobalDisable) {
      throw new Error("global audit disable unexpectedly retained a new execution context");
    }
    const afterGlobalDisable = parseJson<AuditRunInspectResult>(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "global-disabled retained inspection",
    );
    if (normalizedContextJson(afterGlobalDisable) !== beforeContext) {
      throw new Error("global audit disable hid or changed retained identity evidence");
    }

    const snapshotPath = path.join(options.artifactBase, SNAPSHOT_FILE);
    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.writeFile(
      snapshotPath,
      `${JSON.stringify(
        {
          runId,
          repeatedRunId,
          repeatedExecutions: repeatedRows.map((row) => ({
            executionId: row.execution_id,
            contextId: row.context_id,
          })),
          coverage: before.coverage,
          decision: before.decisions[0]?.decision,
          contextSha256: sha256(beforeContext),
          byteEquivalentAfterRestart: true,
          byteEquivalentPersistedReadback: true,
          optIn: {
            explicitEnablement: true,
            freshInstallDisabled: true,
            freshInstallTableAbsent: true,
            globalAuditDisabled: true,
            upgradeStyleExistingInstallDisabled: true,
            upgradeStyleTableAbsent: true,
          },
          textSections: TEXT_SECTIONS,
          identityFields: IDENTITY_FIELDS,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return `local run=${runId}; repeated run=${repeatedRunId} executions=${repeatedRows.map((row) => row.execution_id).join(",")}; Gateway pid=${gateway.pid ?? "unknown"}; text+JSON exact selection passed before/after replacement; normalized context sha256=${sha256(beforeContext)}`;
  } finally {
    await gateway?.stop().catch(() => undefined);
    await mock.stop();
  }
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    const details = await runProof(options);
    return {
      artifacts: [{ filePath: SNAPSHOT_FILE, kind: "summary" }],
      details,
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "pass",
    };
  } catch (error) {
    return {
      details: formatErrorMessage(error),
      durationMs: Math.max(1, Date.now() - startedAt),
      status: "fail",
    };
  }
}

async function runProducer(options: ProducerOptions): Promise<QaEvidenceSummaryJson> {
  const writer = createQaScriptEvidenceWriter({
    artifactBase: options.artifactBase,
    logFileName: `${SCENARIO_ID}.log`,
    primaryModel: "mock-openai/gpt-5.6-luna",
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Agent-run execution identity inspection",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/audit.md", "docs/cli/audit.md"],
      codeRefs: [
        "src/agents/agent-command.ts",
        "src/agents/agent-command-execution-identity.ts",
        "src/audit/execution-identity-admission.ts",
        "src/audit/audit-event-writer.ts",
        "src/audit/execution-identity-context.ts",
        "src/gateway/server-methods/audit.ts",
        "src/commands/audit.ts",
      ],
    },
  });
  const result = await produceProof(options);
  writer.appendLog(`${result.status}: ${result.details ?? "no details"}\n`);
  return await writer.write(result);
}

async function main(argv: readonly string[]) {
  const evidence = await runProducer(parseOptions(argv));
  const status = evidence.entries[0]?.result.status;
  console.log(`Agent-run identity evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Agent-run identity status: ${status}`);
  return status === "pass" ? 0 : 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2))
    .then((exitCode) => {
      process.exitCode = exitCode;
    })
    .catch((error) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
