// QA Lab producer proves cron/task owner receipts through a real mock Gateway.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
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

const SCENARIO_ID = "autonomous-task-lifecycle-receipts";
const SNAPSHOT_FILE = `${SCENARIO_ID}-summary.json`;
const HOOK_TOKEN = "qa-autonomous-hook-token";

type ProducerOptions = { artifactBase: string; repoRoot: string };
type ProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};
type ExactOwnerRow = {
  context_id: string;
  execution_id: string;
  run_id: string;
  status: string;
};
type OwnerDisplayProducer = "cron-lifecycle" | "task-lifecycle" | "flow-lifecycle";

function hasSqliteColumns(db: DatabaseSync, table: string, columns: readonly string[]): boolean {
  const exists = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(table);
  if (!exists) {
    return false;
  }
  const present = new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
  return columns.every((column) => present.has(column));
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

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function stateDatabasePath(gateway: Awaited<ReturnType<typeof startQaGatewayChild>>): string {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  return path.join(stateDir, "state", "openclaw.sqlite");
}

function countExecutionContexts(gateway: Awaited<ReturnType<typeof startQaGatewayChild>>): number {
  const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
  try {
    if (!hasSqliteColumns(db, "execution_identity_contexts", ["context_id"])) {
      return 0;
    }
    const row = db.prepare("SELECT COUNT(*) AS count FROM execution_identity_contexts").get() as {
      count: number;
    };
    return row.count;
  } finally {
    db.close();
  }
}

function readCronOwnerRows(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  jobId: string,
): { cron: ExactOwnerRow; task: ExactOwnerRow } | undefined {
  const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
  try {
    if (
      !hasSqliteColumns(db, "execution_identity_contexts", ["context_id", "execution_id"]) ||
      !hasSqliteColumns(db, "execution_owner_lifecycle_bindings", [
        "owner_kind",
        "owner_id",
        "context_id",
        "execution_id",
      ]) ||
      !hasSqliteColumns(db, "task_runs", ["task_id"])
    ) {
      return undefined;
    }
    const cron = db
      .prepare(
        `SELECT binding.context_id, binding.execution_id, context.run_id, receipt.status
         FROM cron_run_receipts AS receipt
         JOIN execution_owner_lifecycle_bindings AS binding
           ON binding.owner_kind = 'cron' AND binding.owner_id = receipt.receipt_id
         JOIN execution_identity_contexts AS context
           ON context.context_id = binding.context_id
          AND context.execution_id = binding.execution_id
         WHERE receipt.job_id = ? AND receipt.status != 'running'
         ORDER BY receipt.started_at_ms DESC LIMIT 1`,
      )
      .get(jobId) as ExactOwnerRow | undefined;
    const task = db
      .prepare(
        `SELECT binding.context_id, binding.execution_id, context.run_id, task.status
         FROM task_runs AS task
         JOIN execution_owner_lifecycle_bindings AS binding
           ON binding.owner_kind = 'task' AND binding.owner_id = task.task_id
         JOIN execution_identity_contexts AS context
           ON context.context_id = binding.context_id
          AND context.execution_id = binding.execution_id
         WHERE task.runtime = 'cron' AND task.source_id = ? AND task.ended_at IS NOT NULL
         ORDER BY task.created_at DESC LIMIT 1`,
      )
      .get(jobId) as ExactOwnerRow | undefined;
    return cron && task ? { cron, task } : undefined;
  } finally {
    db.close();
  }
}

function readCronOwnerBindingDiagnostic(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  jobId: string,
): unknown {
  const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
  try {
    return {
      cron: db
        .prepare(
          `SELECT binding.context_id, binding.execution_id, receipt.status
           FROM cron_run_receipts AS receipt
           JOIN execution_owner_lifecycle_bindings AS binding
             ON binding.owner_kind = 'cron' AND binding.owner_id = receipt.receipt_id
           WHERE receipt.job_id = ?
           ORDER BY receipt.started_at_ms DESC LIMIT 1`,
        )
        .get(jobId),
      task: db
        .prepare(
          `SELECT binding.context_id, binding.execution_id, task.status
           FROM task_runs AS task
           JOIN execution_owner_lifecycle_bindings AS binding
             ON binding.owner_kind = 'task' AND binding.owner_id = task.task_id
           WHERE task.runtime = 'cron' AND task.source_id = ?
           ORDER BY task.created_at DESC LIMIT 1`,
        )
        .get(jobId),
    };
  } finally {
    db.close();
  }
}

function readCliOwnerRows(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  runId: string,
): { task: ExactOwnerRow } | undefined {
  const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
  try {
    if (
      !hasSqliteColumns(db, "execution_identity_contexts", ["context_id", "execution_id"]) ||
      !hasSqliteColumns(db, "execution_owner_lifecycle_bindings", [
        "owner_kind",
        "owner_id",
        "context_id",
        "execution_id",
      ]) ||
      !hasSqliteColumns(db, "task_runs", ["task_id"])
    ) {
      return undefined;
    }
    const task = db
      .prepare(
        `SELECT binding.context_id, binding.execution_id, context.run_id, task.status
         FROM task_runs AS task
         JOIN execution_owner_lifecycle_bindings AS binding
           ON binding.owner_kind = 'task' AND binding.owner_id = task.task_id
         JOIN execution_identity_contexts AS context
           ON context.context_id = binding.context_id
          AND context.execution_id = binding.execution_id
         WHERE task.runtime = 'cli' AND task.run_id = ? AND task.ended_at IS NOT NULL
         LIMIT 1`,
      )
      .get(runId) as ExactOwnerRow | undefined;
    return task ? { task } : undefined;
  } finally {
    db.close();
  }
}

async function waitFor<T>(label: string, read: () => T | undefined): Promise<T> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) {
      return value;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for ${label}`);
}

function requireOwnerDisplay(result: AuditRunInspectResult, producer: OwnerDisplayProducer) {
  const receipt = result.decisionDisplays.find(
    (candidate) =>
      candidate.provenance.state === "verified" && candidate.provenance.producer === producer,
  );
  if (
    !receipt ||
    receipt.enforcement.coverageState !== "attribution-only" ||
    receipt.decision.outcome !== "not-applicable"
  ) {
    throw new Error(`inspection omitted exact attribution-only ${producer} display`);
  }
  return receipt;
}

async function inspectExecution(params: {
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>;
  executionId: string;
  producers: OwnerDisplayProducer[];
  privateSentinels: string[];
}) {
  const jsonRaw = await params.gateway.runCli([
    "audit",
    "--execution",
    params.executionId,
    "--explain",
    "--json",
  ]);
  const json = parseJson<AuditRunInspectResult>(jsonRaw, "owner lifecycle inspection");
  for (const producer of params.producers) {
    requireOwnerDisplay(json, producer);
  }
  for (const sentinel of params.privateSentinels) {
    if (jsonRaw.includes(sentinel)) {
      throw new Error(`owner receipt leaked private sentinel ${sentinel}`);
    }
  }
  const human = await params.gateway.runCli([
    "audit",
    "--execution",
    params.executionId,
    "--explain",
  ]);
  for (const producer of params.producers) {
    if (!human.includes(`Display producer: ${producer}`)) {
      throw new Error(`human inspection omitted ${producer}`);
    }
  }
  return { json, jsonRaw, human };
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
      mutateConfig: (config) => ({
        ...config,
        logging: {
          ...config.logging,
          audit: { ...config.logging?.audit, enabled: true, executionIdentity: true },
        },
        hooks: {
          enabled: true,
          token: HOOK_TOKEN,
          mappings: [
            {
              id: "qa-suppressed-source",
              match: { path: "suppressed" },
              action: "agent",
              messageTemplate: "PRIVATE-SUPPRESSED-{{payload.value}}",
              transform: { module: "suppress.mjs" },
            },
          ],
        },
      }),
    });
    const transformDir = path.join(path.dirname(gateway.configPath), "hooks", "transforms");
    await fs.mkdir(transformDir, { recursive: true });
    await fs.writeFile(
      path.join(transformDir, "suppress.mjs"),
      "export default function suppress() { return null; }\n",
      "utf8",
    );

    const contextsBeforeSuppression = countExecutionContexts(gateway);
    const suppression = await fetch(`${gateway.baseUrl}/hooks/suppressed`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${HOOK_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ value: randomUUID() }),
    });
    if (suppression.status !== 204) {
      throw new Error(`mapped suppression returned HTTP ${suppression.status}`);
    }
    await delay(100);
    if (countExecutionContexts(gateway) !== contextsBeforeSuppression) {
      throw new Error("pre-admission mapping suppression allocated execution identity");
    }

    const cronSentinel = `PRIVATE-CRON-${randomUUID()}`;
    const cronJob = (await gateway.call("cron.add", {
      name: "QA autonomous receipt",
      enabled: true,
      schedule: { kind: "at", at: new Date(Date.now() + 3_600_000).toISOString() },
      sessionTarget: "isolated",
      wakeMode: "next-heartbeat",
      payload: { kind: "agentTurn", message: `${cronSentinel}: reply CRON-DONE` },
      delivery: { mode: "none" },
    })) as { id: string };
    await gateway.call("cron.run", { id: cronJob.id, mode: "force" });
    let cronRows: { cron: ExactOwnerRow; task: ExactOwnerRow };
    try {
      cronRows = await waitFor("terminal cron/task exact bindings", () =>
        readCronOwnerRows(gateway!, cronJob.id),
      );
    } catch (error) {
      throw new Error(
        `${formatErrorMessage(error)}; owner rows=${JSON.stringify(readCronOwnerBindingDiagnostic(gateway, cronJob.id))}; gateway logs=${gateway.logs()}`,
        { cause: error },
      );
    }
    if (
      cronRows.cron.context_id !== cronRows.task.context_id ||
      cronRows.cron.execution_id !== cronRows.task.execution_id
    ) {
      throw new Error("cron receipt/task rows did not retain one exact admitted execution");
    }
    const cronInspection = await inspectExecution({
      gateway,
      executionId: cronRows.cron.execution_id,
      producers: ["cron-lifecycle", "task-lifecycle"],
      privateSentinels: [cronSentinel],
    });
    const cronCursorPage = parseJson<AuditRunInspectResult>(
      await gateway.runCli([
        "audit",
        "--execution",
        cronRows.cron.execution_id,
        "--explain",
        "--cursor",
        "c:0:0",
        "--limit",
        "1",
        "--json",
      ]),
      "cron cursor page",
    );
    requireOwnerDisplay(cronCursorPage, "cron-lifecycle");

    const taskSentinel = `PRIVATE-TASK-${randomUUID()}`;
    const cliRunId = `qa-cli-${randomUUID()}`;
    const accepted = (await gateway.call(
      "agent",
      {
        sessionKey: "agent:qa:main",
        message: `${taskSentinel}: reply TASK-DONE`,
        deliver: false,
        idempotencyKey: cliRunId,
      },
      { expectFinal: false },
    )) as { runId: string; status: string };
    await gateway.call(
      "agent.wait",
      { runId: accepted.runId, timeoutMs: 30_000 },
      { timeoutMs: 35_000 },
    );
    const cliRows = await waitFor("terminal CLI task exact binding", () =>
      readCliOwnerRows(gateway!, accepted.runId),
    );
    const taskInspection = await inspectExecution({
      gateway,
      executionId: cliRows.task.execution_id,
      producers: ["task-lifecycle"],
      privateSentinels: [taskSentinel],
    });

    const beforeRestart = JSON.stringify({
      cron: cronInspection.json,
      task: taskInspection.json,
    });
    await gateway.restartAfterStateMutation(async () => {});
    const cronAfter = await inspectExecution({
      gateway,
      executionId: cronRows.cron.execution_id,
      producers: ["cron-lifecycle", "task-lifecycle"],
      privateSentinels: [cronSentinel],
    });
    const taskAfter = await inspectExecution({
      gateway,
      executionId: cliRows.task.execution_id,
      producers: ["task-lifecycle"],
      privateSentinels: [taskSentinel],
    });
    const afterRestart = JSON.stringify({ cron: cronAfter.json, task: taskAfter.json });
    if (afterRestart !== beforeRestart) {
      throw new Error("owner lifecycle JSON changed across Gateway replacement");
    }

    const db = new DatabaseSync(stateDatabasePath(gateway), { readOnly: true });
    let genericCount = 0;
    try {
      if (hasSqliteColumns(db, "execution_decision_facts", ["receipt_id"])) {
        genericCount = (
          db.prepare("SELECT COUNT(*) AS count FROM execution_decision_facts").get() as {
            count: number;
          }
        ).count;
      }
    } finally {
      db.close();
    }
    if (genericCount !== 0) {
      throw new Error("owner lifecycle rows were duplicated into execution_decision_facts");
    }

    const snapshotPath = path.join(options.artifactBase, SNAPSHOT_FILE);
    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.writeFile(
      snapshotPath,
      `${JSON.stringify(
        {
          suppression: { httpStatus: 204, identityAllocation: 0 },
          cron: {
            contextId: cronRows.cron.context_id,
            executionId: cronRows.cron.execution_id,
            statuses: [cronRows.cron.status, cronRows.task.status],
            displayProducers: ["cron-lifecycle", "task-lifecycle"],
          },
          task: {
            contextId: cliRows.task.context_id,
            executionId: cliRows.task.execution_id,
            statuses: [cliRows.task.status],
            displayProducers: ["task-lifecycle"],
          },
          cursorCompatibility: { cronPrefixAccepted: true },
          genericDuplicateAbsent: true,
          byteEquivalentAfterRestart: true,
          privacy: { cronPromptAbsent: true, taskPromptAbsent: true },
          resultSha256: sha256(afterRestart),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return `cron=${cronRows.cron.execution_id}; task=${cliRows.task.execution_id}; suppression=204; restart sha256=${sha256(afterRestart)}`;
  } finally {
    await gateway?.stop().catch(() => undefined);
    await mock.stop();
  }
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    return {
      artifacts: [{ filePath: SNAPSHOT_FILE, kind: "summary" }],
      details: await runProof(options),
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
      title: "Autonomous task lifecycle receipts",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/audit.md", "docs/automation/tasks.md"],
      codeRefs: [
        "src/audit/execution-decision-receipts.ts",
        "src/cron/store/run-receipt-store.ts",
        "src/tasks/task-registry.store.sqlite.ts",
        "src/tasks/task-flow-registry.store.sqlite.ts",
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
  console.log(`Autonomous task lifecycle evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Autonomous task lifecycle status: ${status}`);
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
