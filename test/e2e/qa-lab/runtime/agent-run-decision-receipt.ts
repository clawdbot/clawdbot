// QA Lab producer proves a denied approval receipt through a real Gateway and audit CLI.
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
import {
  GatewayClient,
  startGatewayClientWhenEventLoopReady,
} from "../../../../src/plugin-sdk/gateway-runtime.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.js";

const SCENARIO_ID = "agent-run-decision-receipt";
const SNAPSHOT_FILE = `${SCENARIO_ID}-summary.json`;

type ProducerOptions = { artifactBase: string; repoRoot: string };
type ProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};
type PendingApproval = { id: string; request?: { command?: string } };

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

function parseJson(raw: string, label: string): AuditRunInspectResult {
  try {
    return JSON.parse(raw) as AuditRunInspectResult;
  } catch (error) {
    throw new Error(`${label} was not JSON: ${formatErrorMessage(error)}`, { cause: error });
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function findApprovalRunId(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  approvalId: string,
): string {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare(
        `SELECT approval.source_run_id, binding.source_context_id, binding.source_execution_id
         FROM operator_approvals AS approval
         JOIN operator_approval_execution_identities AS binding
           ON binding.approval_id = approval.approval_id
         WHERE approval.approval_id = ?`,
      )
      .get(approvalId) as
      | {
          source_run_id?: string;
          source_context_id?: string;
          source_execution_id?: string;
        }
      | undefined;
    if (!row?.source_run_id || !row.source_context_id || !row.source_execution_id) {
      throw new Error("trusted approval omitted its exact execution identity binding");
    }
    return row.source_run_id;
  } finally {
    database.close();
  }
}

function assertNoGenericApprovalDuplicate(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
): void {
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
      .get("execution_decision_facts");
    if (table) {
      const count = database
        .prepare("SELECT COUNT(*) AS count FROM execution_decision_facts")
        .get() as { count: number };
      if (count.count !== 0) {
        throw new Error("operator approval was duplicated into execution_decision_facts");
      }
    }
  } finally {
    database.close();
  }
}

function readApprovalToolCallRef(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  approvalId: string,
): string {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  if (!stateDir) {
    throw new Error("QA Gateway did not expose its isolated state directory");
  }
  const database = new DatabaseSync(path.join(stateDir, "state", "openclaw.sqlite"), {
    readOnly: true,
  });
  try {
    const row = database
      .prepare("SELECT source_tool_call_id FROM operator_approvals WHERE approval_id = ?")
      .get(approvalId) as { source_tool_call_id?: string } | undefined;
    if (!row?.source_tool_call_id) {
      throw new Error("trusted approval omitted its source tool-call reference");
    }
    return row.source_tool_call_id;
  } finally {
    database.close();
  }
}

function requireDeniedApproval(result: AuditRunInspectResult) {
  const receipt = result.decisionDisplays.find(
    (
      candidate,
    ): candidate is typeof candidate & {
      provenance: { state: "verified"; producer: "operator-approval" };
    } =>
      candidate.provenance.state === "verified" &&
      candidate.provenance.producer === "operator-approval",
  );
  if (!receipt) {
    throw new Error("audit inspection omitted the authoritative approval receipt");
  }
  if (
    receipt.decision.outcome !== "denied" ||
    receipt.decision.reasonCode !== "operator_approval_denied_by_reviewer" ||
    receipt.enforcement.coverageState !== "enforced" ||
    receipt.enforcement.policyCount !== 2 ||
    receipt.enforcement.contextFieldsUsed.join(",") !== "contextId,executionId,runId" ||
    receipt.enforcement.grantCount !== 0 ||
    receipt.remediation[0]?.code !== "review_and_request_again"
  ) {
    throw new Error("approval receipt did not preserve denial, enforcement, and remediation");
  }
  return receipt;
}

async function waitForPendingApproval(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  agentFailure: () => string | undefined,
): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const pending = (await gateway.call("exec.approval.list", {})) as PendingApproval[];
    const match = pending[0];
    if (match) {
      return match.id;
    }
    const failure = agentFailure();
    if (failure) {
      throw new Error(`trusted agent run ended before approval: ${failure}`);
    }
    await delay(25);
  }
  throw new Error("trusted agent exec approval did not become pending");
}

async function startApprovalRoute(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
): Promise<GatewayClient> {
  let resolveConnected!: () => void;
  let rejectConnected!: (error: Error) => void;
  const connected = new Promise<void>((resolve, reject) => {
    resolveConnected = resolve;
    rejectConnected = reject;
  });
  const client = new GatewayClient({
    url: gateway.wsUrl,
    token: gateway.token,
    clientName: "gateway-client",
    clientDisplayName: "decision receipt approval route",
    deviceIdentity: null,
    mode: "backend",
    caps: ["exec-approvals"],
    scopes: ["operator.admin"],
    onHelloOk: resolveConnected,
    onConnectError: rejectConnected,
    onClose: (code, reason) => rejectConnected(new Error(`gateway closed (${code}): ${reason}`)),
  });
  const readiness = await startGatewayClientWhenEventLoopReady(client, { timeoutMs: 20_000 });
  if (!readiness.ready) {
    client.stop();
    throw new Error("approval route client did not reach event-loop readiness");
  }
  await Promise.race([
    connected,
    delay(20_000).then(() => {
      throw new Error("approval route client did not connect");
    }),
  ]);
  return client;
}

async function runProof(options: ProducerOptions): Promise<string> {
  const mock = await startQaMockOpenAiServer();
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  let approvalRoute: GatewayClient | undefined;
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
        tools: {
          ...config.tools,
          exec: { ...config.tools?.exec, host: "gateway", security: "full", ask: "always" },
        },
      }),
    });
    approvalRoute = await startApprovalRoute(gateway);
    const commandSentinel = `PRIVATE-COMMAND-${randomUUID()}`;
    let agentFailure: string | undefined;
    const agentRun = gateway
      .runCli([
        "agent",
        "--agent",
        "qa",
        "--session-id",
        `decision-${randomUUID()}`,
        "--message",
        `Tool progress QA check: call the exec tool exactly once with this exact command before answering: \`printf ${commandSentinel}\`. After that exec command completes or fails, reply exactly \`DECISION-RECEIPT-DONE\`.`,
        "--thinking",
        "off",
        "--timeout",
        "60",
        "--json",
      ])
      .catch((error: unknown) => {
        agentFailure = formatErrorMessage(error);
      });
    const approvalId = await waitForPendingApproval(gateway, () => agentFailure);
    await gateway.call("exec.approval.resolve", { id: approvalId, decision: "deny" });
    const agentOutput = await agentRun;
    if (agentFailure) {
      throw new Error(`trusted agent run failed after approval resolution: ${agentFailure}`);
    }
    if (typeof agentOutput !== "string" || !agentOutput.includes("DECISION-RECEIPT-DONE")) {
      throw new Error("trusted agent run omitted its post-approval completion marker");
    }
    const runId = findApprovalRunId(gateway, approvalId);
    let conflictingRetryRejected = false;
    try {
      await gateway.call("exec.approval.resolve", { id: approvalId, decision: "allow-once" });
    } catch (error) {
      conflictingRetryRejected = formatErrorMessage(error).includes("already resolved");
    }
    if (!conflictingRetryRejected) {
      throw new Error("conflicting approval retry did not preserve the denied first answer");
    }

    const beforeText = await gateway.runCli(["audit", "--run", runId, "--explain"]);
    if (
      !beforeText.includes("operator_approval_denied_by_reviewer") ||
      !beforeText.includes("authoritative owner-native SQLite record; retained 30 days") ||
      !beforeText.includes("Review the denial")
    ) {
      throw new Error("audit text omitted approval reason, durability, or remediation");
    }
    const before = parseJson(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "pre-restart decision inspection",
    );
    const receipt = requireDeniedApproval(before);
    const firstPage = parseJson(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--limit", "1", "--json"]),
      "first decision page",
    );
    if (firstPage.nextDecisionCursor?.startsWith("a:") !== true) {
      throw new Error("first decision page omitted its opaque approval cursor");
    }
    const legacyResume = parseJson(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--cursor", "001", "--json"]),
      "legacy numeric decision continuation",
    );
    requireDeniedApproval(legacyResume);
    const opaqueResume = parseJson(
      await gateway.runCli([
        "audit",
        "--run",
        runId,
        "--explain",
        "--cursor",
        firstPage.nextDecisionCursor,
        "--json",
      ]),
      "opaque decision continuation",
    );
    requireDeniedApproval(opaqueResume);
    const serialized = JSON.stringify(before);
    const toolCallRef = readApprovalToolCallRef(gateway, approvalId);
    if (serialized.includes(commandSentinel) || serialized.includes(toolCallRef)) {
      throw new Error("approval receipt leaked command or tool-call content");
    }
    assertNoGenericApprovalDuplicate(gateway);

    await gateway.restartAfterStateMutation(async () => {});
    const after = parseJson(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "post-restart decision inspection",
    );
    requireDeniedApproval(after);
    if (JSON.stringify(after) !== serialized) {
      throw new Error("approval decision inspection changed across Gateway replacement");
    }
    assertNoGenericApprovalDuplicate(gateway);

    const snapshotPath = path.join(options.artifactBase, SNAPSHOT_FILE);
    await fs.mkdir(options.artifactBase, { recursive: true });
    await fs.writeFile(
      snapshotPath,
      `${JSON.stringify(
        {
          runId,
          coverage: after.coverage,
          approval: {
            outcome: receipt.decision.outcome,
            reasonCode: receipt.decision.reasonCode,
            coverageState: receipt.enforcement.coverageState,
            provenanceProducer: receipt.provenance.producer,
            remediationCode: receipt.remediation[0]?.code,
          },
          firstAnswerPreserved: true,
          agentCompletionObserved: true,
          genericDuplicateAbsent: true,
          numericDecisionContinuation: true,
          opaqueDecisionContinuation: true,
          byteEquivalentAfterRestart: true,
          redaction: { command: true, toolCall: true },
          resultSha256: sha256(serialized),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    return `run=${runId}; denied approval projected before/after Gateway replacement; result sha256=${sha256(serialized)}`;
  } finally {
    await approvalRoute?.stopAndWait().catch(() => approvalRoute?.stop());
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
      title: "Agent-run decision receipt",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/audit.md", "docs/cli/audit.md"],
      codeRefs: [
        "src/gateway/operator-approval-store.ts",
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
  console.log(`Agent-run decision evidence: ${QA_EVIDENCE_FILENAME}`);
  console.log(`Agent-run decision status: ${status}`);
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
