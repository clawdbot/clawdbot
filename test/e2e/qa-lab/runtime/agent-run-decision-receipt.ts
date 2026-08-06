// QA Lab producer proves a denied approval receipt through a real Gateway and audit CLI.
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

const SCENARIO_ID = "agent-run-decision-receipt";
const SNAPSHOT_FILE = `${SCENARIO_ID}-summary.json`;

type ProducerOptions = { artifactBase: string; repoRoot: string };
type ProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

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

function findLocalRunId(gateway: Awaited<ReturnType<typeof startQaGatewayChild>>): string {
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
        "SELECT run_id, context_json FROM execution_identity_contexts ORDER BY created_at DESC, context_id DESC",
      )
      .all() as Array<{ run_id: string; context_json: string }>;
    const local = rows.find((row) => {
      const context = parseJson<{ ingress?: { kind?: string } }>(row.context_json, "run context");
      return context.ingress?.kind === "local-cli";
    });
    if (!local?.run_id) {
      throw new Error("local mock-provider turn did not record an execution identity context");
    }
    return local.run_id;
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

function requireDeniedApproval(result: AuditRunInspectResult) {
  const receipt = result.decisions.find(
    (candidate) => candidate.source.owner === "operator_approvals",
  );
  if (!receipt) {
    throw new Error("audit inspection omitted the authoritative approval receipt");
  }
  if (
    receipt.decision.outcome !== "denied" ||
    receipt.decision.reasonCode !== "operator_approval_denied_by_reviewer" ||
    receipt.enforcement.coverageState !== "enforced" ||
    !receipt.enforcement.policyRefs.includes("operator-approval:human-decision") ||
    !receipt.enforcement.contextFieldsUsed.includes("runId") ||
    receipt.enforcement.grantRefs.length !== 0 ||
    receipt.remediation[0]?.code !== "review_and_request_again"
  ) {
    throw new Error("approval receipt did not preserve denial, enforcement, and remediation");
  }
  return receipt;
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
      }),
    });
    await gateway.runCli([
      "agent",
      "--local",
      "--agent",
      "qa",
      "--session-id",
      `decision-${randomUUID()}`,
      "--message",
      "Reply exactly: DECISION-RECEIPT-CONTEXT",
      "--thinking",
      "off",
      "--timeout",
      "60",
      "--json",
    ]);
    const runId = findLocalRunId(gateway);
    const approvalId = `decision-receipt-${randomUUID()}`;
    const commandSentinel = `PRIVATE-COMMAND-${randomUUID()}`;
    const toolCallSentinel = `PRIVATE-TOOL-${randomUUID()}`;

    const accepted = (await gateway.call("exec.approval.request", {
      id: approvalId,
      command: `printf ${commandSentinel}`,
      commandArgv: ["printf", commandSentinel],
      host: "gateway",
      security: "allowlist",
      ask: "always",
      runId,
      toolCallId: toolCallSentinel,
      twoPhase: true,
      requireDeliveryRoute: false,
      timeoutMs: 60_000,
    })) as { id?: string; status?: string };
    if (accepted.id !== approvalId || accepted.status !== "accepted") {
      throw new Error("Gateway did not accept the two-phase approval request");
    }
    await gateway.call("exec.approval.resolve", { id: approvalId, decision: "deny" });
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
    const before = parseJson<AuditRunInspectResult>(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "pre-restart decision inspection",
    );
    const receipt = requireDeniedApproval(before);
    const serialized = JSON.stringify(before);
    if (serialized.includes(commandSentinel) || serialized.includes(toolCallSentinel)) {
      throw new Error("approval receipt leaked command or tool-call content");
    }
    assertNoGenericApprovalDuplicate(gateway);

    await gateway.restartAfterStateMutation(async () => {});
    const after = parseJson<AuditRunInspectResult>(
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
            sourceOwner: receipt.source.owner,
            remediationCode: receipt.remediation[0]?.code,
          },
          firstAnswerPreserved: true,
          genericDuplicateAbsent: true,
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
    .catch((error) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
