// QA Lab producer proves exact-run identity inspection through a real local turn and Gateway.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket, type ClientOptions } from "ws";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/src/evidence-summary.js";
import {
  createQaGatewayChild,
  type QaGatewayChild,
} from "../../../../extensions/qa-lab/src/gateway-child.js";
import { startQaMockOpenAiServer } from "../../../../extensions/qa-lab/src/providers/mock-openai/server.js";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
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
const FRAME_TIMEOUT_MS = 20_000;

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

async function assertUntrustedProxyHeadersRejected(
  url: string,
  headers: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { headers } satisfies ClientOptions);
    const timeout = setTimeout(() => {
      socket.terminate();
      reject(new Error("timed out waiting for spoofed proxy-header rejection"));
    }, FRAME_TIMEOUT_MS);
    socket.once("open", () => {
      clearTimeout(timeout);
      socket.terminate();
      reject(new Error("Gateway accepted proxy-shaped headers from an untrusted peer"));
    });
    socket.once("unexpected-response", (_request, response) => {
      clearTimeout(timeout);
      response.resume();
      if (response.statusCode === 403) {
        resolve();
      } else {
        reject(new Error(`spoofed proxy headers returned HTTP ${response.statusCode}`));
      }
    });
    socket.once("error", () => undefined);
  });
}

async function updateExecutionIdentityConfig(
  configPath: string,
  values: { enabled?: boolean; executionIdentity: boolean },
) {
  const raw = await fs.readFile(configPath, "utf8");
  const config = parseJson(raw || "{}", "QA Gateway config") as Record<string, unknown>;
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

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} was not JSON: ${formatErrorMessage(error)}`, { cause: error });
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
  if (result.run.runId !== runId) {
    throw new Error(`audit JSON projection selected the wrong run: ${runId}`);
  }
  if (
    result.coverage.state !== "unknown" ||
    !result.coverage.missingEvidence.includes("decision.display_provenance") ||
    !result.decisionDisplays.some((receipt) => receipt.provenance.state === "unverified")
  ) {
    throw new Error(`audit JSON projection overstated generic decision coverage: ${runId}`);
  }
  if (
    context.ingress.kind !== "local-cli" ||
    context.ingress.state !== "present" ||
    context.ingress.boundary !== "agent-command.local"
  ) {
    throw new Error("local agent run did not retain authoritative local-CLI ingress");
  }
  const admission = result.decisionDisplays.find(
    (receipt) =>
      receipt.provenance.state === "verified" && receipt.provenance.producer === "run-admission",
  );
  if (
    !admission ||
    admission.decision.outcome !== "not-applicable" ||
    admission.decision.reasonCode !== "run_admission_identity_not_evaluated"
  ) {
    throw new Error("audit JSON projection omitted the truthful admission receipt");
  }
}

function assertProfilelessGatewayIdentityProjection(result: AuditRunInspectResult) {
  const context = requireIdentityContext(result);
  if (
    context.ingress.kind !== "gateway-client" ||
    context.ingress.state !== "present" ||
    context.ingress.boundary !== "gateway.ws.authenticated-connect"
  ) {
    throw new Error("Gateway run did not retain its authenticated connection ingress");
  }
  if (
    context.invoker.state !== "absent" ||
    context.coverageState !== "unattributed" ||
    context.representedSubject !== undefined
  ) {
    throw new Error(
      `Gateway identity projection fabricated or lost a subject: ${JSON.stringify(context)}`,
    );
  }
  if (context.assurance.some((item) => item.kind === "durable-profile")) {
    throw new Error("profileless Gateway run fabricated durable profile assurance");
  }
}

function findLocalRunId(gateway: QaGatewayChild) {
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
      const context = parseJson(row.context_json, "persisted local context") as {
        ingress?: { kind?: string };
      };
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

function inspectExecutionIdentityStorage(gateway: QaGatewayChild) {
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

function inspectPersistedSessionCreator(gateway: QaGatewayChild, sessionKey: string) {
  const stateDir = gateway.runtimeEnv.OPENCLAW_STATE_DIR;
  const agentId = sessionKey.split(":")[1];
  if (!stateDir || !agentId) {
    throw new Error("QA Gateway did not expose the session creator database owner");
  }
  const database = new DatabaseSync(
    path.join(stateDir, "agents", agentId, "agent", "openclaw-agent.sqlite"),
    { readOnly: true },
  );
  try {
    const row = database
      .prepare(
        "SELECT created_actor_type, created_actor_id, entry_json FROM session_nodes WHERE session_key = ?",
      )
      .get(sessionKey) as
      | { created_actor_id: string | null; created_actor_type: string | null; entry_json: string }
      | undefined;
    if (!row) {
      throw new Error(`persisted session creator row is missing: ${sessionKey}`);
    }
    const entry = parseJson(row.entry_json, `persisted session ${sessionKey}`);
    const actor = isRecord(entry) && isRecord(entry.createdActor) ? entry.createdActor : undefined;
    return {
      id: row.created_actor_id,
      labelPersisted: actor ? Object.hasOwn(actor, "label") : false,
      type: row.created_actor_type,
    };
  } finally {
    database.close();
  }
}

async function runLocalTurn(gateway: QaGatewayChild, message: string) {
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

function findRunExecutions(gateway: QaGatewayChild, runId: string) {
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

function assertPersistedContextBytes(
  gateway: QaGatewayChild,
  runId: string,
  expectedContext: string,
): void {
  const rows = findRunExecutions(gateway, runId);
  if (rows.length !== 1 || rows[0]?.context_json !== expectedContext) {
    throw new Error(`RPC context bytes differ from persisted bytes: ${runId}`);
  }
}

async function runRepeatedIngressTurns(
  gateway: QaGatewayChild,
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
  const gatewayOwner = createQaGatewayChild();
  let gateway: QaGatewayChild | undefined;
  try {
    gateway = await gatewayOwner.start({
      repoRoot: options.repoRoot,
      useRepoCli: true,
      providerBaseUrl: `${mock.baseUrl}/v1`,
      providerMode: "mock-openai",
      transportBaseUrl: "http://127.0.0.1",
      controlUiEnabled: false,
      mutateConfig: (cfg) => ({
        ...cfg,
        gateway: {
          ...cfg.gateway,
          auth: { ...cfg.gateway?.auth, allowTailscale: true },
        },
      }),
    });
    await gateway.restartAfterStateMutation(async () => {
      await runLocalTurn(gateway!, "Reply exactly: IDENTITY-DISABLED-FRESH");
    });
    if (inspectExecutionIdentityStorage(gateway).tablePresent) {
      throw new Error("fresh-install default unexpectedly created execution identity storage");
    }
    await gateway.restartAfterStateMutation(async () => {
      await runLocalTurn(gateway!, "Reply exactly: IDENTITY-DISABLED-UPGRADE");
    });
    if (inspectExecutionIdentityStorage(gateway).tablePresent) {
      throw new Error("existing-install restart unexpectedly created execution identity storage");
    }
    await gateway.restartAfterStateMutation(async ({ configPath }) => {
      await updateExecutionIdentityConfig(configPath, { executionIdentity: true });
      await runLocalTurn(gateway!, "Reply exactly: IDENTITY-INSPECTION-OK");
    });
    const runId = findLocalRunId(gateway);
    const beforeText = await gateway.runCli(["audit", "--run", runId, "--explain"]);
    assertTextProjection(beforeText);
    const before = parseJson(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "pre-restart audit inspection",
    ) as AuditRunInspectResult;
    assertJsonProjection(before, runId);
    const beforeContext = normalizedContextJson(before);
    assertPersistedContextBytes(gateway, runId, beforeContext);

    const profilelessSessionKey = `agent:qa:i1-profileless-${randomUUID()}`;
    const profilelessStarted = (await gateway.call("agent", {
      sessionKey: profilelessSessionKey,
      message: "Reply exactly: I1-PROFILELESS",
      deliver: false,
      idempotencyKey: randomUUID(),
    })) as { runId?: unknown; status?: unknown };
    if (profilelessStarted.status !== "accepted" || typeof profilelessStarted.runId !== "string") {
      throw new Error(
        `profileless Gateway run did not start: ${JSON.stringify(profilelessStarted)}`,
      );
    }
    const profilelessTerminal = (await gateway.call("agent.wait", {
      runId: profilelessStarted.runId,
      timeoutMs: 60_000,
    })) as { status?: unknown };
    if (profilelessTerminal.status !== "ok") {
      throw new Error(
        `profileless Gateway run did not finish: ${JSON.stringify(profilelessTerminal)}`,
      );
    }
    const profilelessRunId = profilelessStarted.runId;

    await assertUntrustedProxyHeadersRejected(gateway.wsUrl, {
      "tailscale-user-login": "operator@example.com",
      "tailscale-user-name": "Operator",
      "x-forwarded-for": "100.64.0.11",
      "x-forwarded-host": "gateway.qa.test",
      "x-forwarded-proto": "https",
    });

    const profilelessText = await gateway.runCli(["audit", "--run", profilelessRunId, "--explain"]);
    assertTextProjection(profilelessText);
    if (
      !profilelessText.includes("Invoker [absent]") ||
      !profilelessText.includes("Represented subject [absent]") ||
      profilelessText.includes("Operator")
    ) {
      throw new Error("profileless text inspection fabricated an operator subject");
    }
    const profilelessBefore = parseJson(
      await gateway.runCli(["audit", "--run", profilelessRunId, "--explain", "--json"]),
      "profileless Gateway inspection",
    ) as AuditRunInspectResult;
    assertProfilelessGatewayIdentityProjection(profilelessBefore);
    const profilelessContext = normalizedContextJson(profilelessBefore);
    assertPersistedContextBytes(gateway, profilelessRunId, profilelessContext);

    const listed = (await gateway.call("sessions.list", {})) as {
      sessions?: Array<{
        key?: string;
        createdActor?: { id?: string; label?: string; type?: string };
      }>;
    };
    const profilelessSession = listed.sessions?.find(
      (session) => session.key === profilelessSessionKey,
    );
    if (profilelessSession?.createdActor !== undefined) {
      throw new Error("profileless Gateway session fabricated a human creator");
    }
    const profilelessCreator = inspectPersistedSessionCreator(gateway, profilelessSessionKey);
    if (
      profilelessCreator.type !== null ||
      profilelessCreator.id !== null ||
      profilelessCreator.labelPersisted
    ) {
      throw new Error("profileless Gateway session persisted a fabricated creator");
    }

    const repeatedRunId = `identity-repeated-${randomUUID()}`;
    let repeatedRows: ReturnType<typeof findRunExecutions> = [];
    const repeatedBeforeRestart = new Map<string, string>();
    await runRepeatedIngressTurns(gateway, options.repoRoot, repeatedRunId);
    repeatedRows = findRunExecutions(gateway, repeatedRunId);
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
    const discovery = parseJson(
      await gateway.runCli(["audit", "--run", repeatedRunId, "--explain", "--json"]),
      "repeated-run discovery",
    ) as AuditRunInspectResult;
    if (discovery.identity.state !== "ambiguous" || discovery.identity.candidates.length !== 2) {
      throw new Error("repeated same-session run was not reported as two ambiguous executions");
    }
    for (const row of repeatedRows) {
      const text = await gateway.runCli(["audit", "--execution", row.execution_id, "--explain"]);
      assertTextProjection(text);
      const exact = parseJson(
        await gateway.runCli(["audit", "--execution", row.execution_id, "--explain", "--json"]),
        `execution ${row.execution_id}`,
      ) as AuditRunInspectResult;
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
    const after = parseJson(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "post-restart audit inspection",
    ) as AuditRunInspectResult;
    assertJsonProjection(after, runId);
    const afterContext = normalizedContextJson(after);
    if (afterContext !== beforeContext) {
      throw new Error("normalized execution identity context bytes changed across Gateway restart");
    }
    const profilelessAfter = parseJson(
      await gateway.runCli(["audit", "--run", profilelessRunId, "--explain", "--json"]),
      `post-restart Gateway run ${profilelessRunId}`,
    ) as AuditRunInspectResult;
    assertProfilelessGatewayIdentityProjection(profilelessAfter);
    if (normalizedContextJson(profilelessAfter) !== profilelessContext) {
      throw new Error(`Gateway execution changed across restart: ${profilelessRunId}`);
    }
    for (const [executionId, expectedContext] of repeatedBeforeRestart) {
      const afterExact = parseJson(
        await gateway.runCli(["audit", "--execution", executionId, "--explain", "--json"]),
        `post-restart execution ${executionId}`,
      ) as AuditRunInspectResult;
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
      await runLocalTurn(gateway!, "Reply exactly: IDENTITY-DISABLED-GLOBAL");
    });
    if (inspectExecutionIdentityStorage(gateway).rowCount !== retainedBeforeGlobalDisable) {
      throw new Error("global audit disable unexpectedly retained a new execution context");
    }
    const afterGlobalDisable = parseJson(
      await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
      "global-disabled retained inspection",
    ) as AuditRunInspectResult;
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
          gatewayRuns: {
            profileless: {
              runId: profilelessRunId,
              contextSha256: sha256(profilelessContext),
            },
            spoofedProxyHeadersRejected: true,
          },
          repeatedRunId,
          repeatedExecutions: repeatedRows.map((row) => ({
            executionId: row.execution_id,
            contextId: row.context_id,
          })),
          coverage: before.coverage,
          decision: before.decisionDisplays[0]?.decision,
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
    const repeatedDetails = `repeated run=${repeatedRunId} executions=${repeatedRows.map((row) => row.execution_id).join(",")}; exact selection passed`;
    return `local run=${runId}; profileless Gateway run=${profilelessRunId}; spoofed proxy headers rejected; ${repeatedDetails}; Gateway pid=${gateway.pid ?? "unknown"}; text+JSON and persisted bytes passed before/after replacement; normalized context sha256=${sha256(beforeContext)}`;
  } finally {
    await stopQaGatewayFixture(gatewayOwner).catch(() => undefined);
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
    .catch((error: unknown) => {
      console.error(formatErrorMessage(error));
      process.exitCode = 1;
    });
}
