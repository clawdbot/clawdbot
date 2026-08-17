// QA Lab producer proves persisted lineage through actual worker-hosted sessions_spawn turns.
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/src/evidence-summary.js";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/src/gateway-child.js";
import { startQaMockOpenAiServer } from "../../../../extensions/qa-lab/src/providers/mock-openai/server.js";
import type {
  AuditRunInspectResult,
  ExecutionIdentityContextV1,
} from "../../../../packages/gateway-protocol/src/index.js";
import { formatErrorMessage } from "../../../../src/infra/errors.js";
import { MODEL_REF } from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  type PairedNodeWorkerHost,
} from "./paired-node-worker-wire-fixture.js";
import { createQaScriptEvidenceWriter, type QaScriptEvidenceStatus } from "./script-evidence.js";

const SCENARIO_ID = "subagent-lineage-inspection";
const SUMMARY_FILE = `${SCENARIO_ID}-summary.json`;
const PROOF_TIMEOUT_MS = 15 * 60_000;

type Gateway = Awaited<ReturnType<typeof startQaGatewayChild>>;

type ProducerOptions = {
  artifactBase: string;
  repoRoot: string;
};

type PersistedContext = {
  context: ExecutionIdentityContextV1;
  contextJson: string;
  executionId: string;
  runId: string;
};

type SessionRef = {
  key: string;
  sessionId: string;
};

type WorkerTopology = {
  child: SessionRef;
  grandchild: SessionRef;
  privateValues: string[];
  root: SessionRef;
  runIds: [string, string, string];
};

type ProofResult = {
  artifacts?: Array<{ filePath: string; kind: string }>;
  details?: string;
  durationMs: number;
  status: QaScriptEvidenceStatus;
};

function parseOptions(argv: readonly string[]): ProducerOptions {
  let artifactBase: string | undefined;
  let repoRoot = process.cwd();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--output-dir") {
      artifactBase = argv[++index];
    } else if (arg === "--repo-root") {
      repoRoot = argv[++index] ?? repoRoot;
    } else if (arg !== "--") {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!artifactBase) {
    throw new Error("--output-dir is required");
  }
  return {
    artifactBase: path.resolve(repoRoot, artifactBase),
    repoRoot: path.resolve(repoRoot),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} was not an object`);
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} was not a non-empty string`);
  }
  return value;
}

function parseJson(raw: string, label: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    throw new Error(`${label} was not JSON: ${formatErrorMessage(error)}`, { cause: error });
  }
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function stateDatabasePath(stateDir: string) {
  return path.join(stateDir, "state", "openclaw.sqlite");
}

function executionIdentityTableExists(stateDir: string): boolean {
  const database = new DatabaseSync(stateDatabasePath(stateDir), { readOnly: true });
  try {
    return Boolean(
      database
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_identity_contexts'",
        )
        .get(),
    );
  } finally {
    database.close();
  }
}

function readPersistedContexts(stateDir: string): PersistedContext[] {
  const database = new DatabaseSync(stateDatabasePath(stateDir), { readOnly: true });
  try {
    const table = database
      .prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'execution_identity_contexts'",
      )
      .get();
    if (!table) {
      return [];
    }
    return (
      database
        .prepare(
          "SELECT run_id, execution_id, context_json FROM execution_identity_contexts ORDER BY created_at, context_id",
        )
        .all() as Array<{ context_json: string; execution_id: string; run_id: string }>
    ).map((row) => ({
      context: parseJson(
        row.context_json,
        "persisted identity context",
      ) as ExecutionIdentityContextV1,
      contextJson: row.context_json,
      executionId: row.execution_id,
      runId: row.run_id,
    }));
  } finally {
    database.close();
  }
}

function assertTurnClaimsReleased(stateDir: string, sessionIds: readonly string[]) {
  const database = new DatabaseSync(stateDatabasePath(stateDir), { readOnly: true });
  try {
    const rows = database
      .prepare(
        `SELECT session_id, turn_claim_owner, turn_claim_run_id, turn_claim_owner_epoch
         FROM worker_session_placements
         WHERE session_id IN (${sessionIds.map(() => "?").join(", ")})`,
      )
      .all(...sessionIds) as Array<{
      session_id: string;
      turn_claim_owner: string | null;
      turn_claim_owner_epoch: number | null;
      turn_claim_run_id: string | null;
    }>;
    if (
      rows.length !== sessionIds.length ||
      rows.some(
        (row) =>
          row.turn_claim_owner !== null ||
          row.turn_claim_run_id !== null ||
          row.turn_claim_owner_epoch !== null,
      )
    ) {
      throw new Error("settled worker topology retained an active turn claim");
    }
  } finally {
    database.close();
  }
}

async function waitForTopologySettled(stateDir: string, sessionIds: readonly string[]) {
  let settledSince: number | undefined;
  await waitUntil("settled worker topology", () => {
    const database = new DatabaseSync(stateDatabasePath(stateDir), { readOnly: true });
    try {
      const rows = database
        .prepare(
          `SELECT session_id, state, turn_claim_owner
           FROM worker_session_placements
           WHERE session_id IN (${sessionIds.map(() => "?").join(", ")})`,
        )
        .all(...sessionIds) as Array<{
        session_id: string;
        state: string;
        turn_claim_owner: string | null;
      }>;
      const pending = database
        .prepare(
          `SELECT COUNT(*) AS count
           FROM worker_workspace_pending_results
           WHERE session_id IN (${sessionIds.map(() => "?").join(", ")})`,
        )
        .get(...sessionIds) as { count: number };
      const settled =
        rows.length === sessionIds.length &&
        rows.every((row) => row.state === "active" && row.turn_claim_owner === null) &&
        pending.count === 0;
      if (!settled) {
        settledSince = undefined;
        return undefined;
      }
      settledSince ??= Date.now();
      return Date.now() - settledSince >= 10_000 ? true : undefined;
    } finally {
      database.close();
    }
  });
}

async function waitUntil<T>(
  label: string,
  read: () => T | undefined | Promise<T | undefined>,
  timeoutMs = PROOF_TIMEOUT_MS,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 100);
    });
  }
  throw new Error(`timed out waiting for ${label}`);
}

async function waitForLineageChain(stateDir: string, rootRunId: string) {
  return await waitUntil("worker and nested-worker lineage", () => {
    const rows = readPersistedContexts(stateDir);
    const root = rows.find((row) => row.runId === rootRunId && !row.context.lineage);
    const child = rows.find(
      (row) => row.context.lineage?.parentRunId === rootRunId && row.context.lineage.depth === 1,
    );
    const grandchild = child
      ? rows.find(
          (row) =>
            row.context.lineage?.parentRunId === child.runId && row.context.lineage.depth === 2,
        )
      : undefined;
    return root && child && grandchild ? { root, child, grandchild } : undefined;
  });
}

function assertLineageLink(params: {
  child: ExecutionIdentityContextV1;
  depth: number;
  parent: ExecutionIdentityContextV1;
}) {
  const { child, depth, parent } = params;
  const lineage = child.lineage;
  if (
    !lineage ||
    lineage.parentContextId !== parent.contextId ||
    lineage.parentExecutionId !== parent.executionId ||
    lineage.parentRunId !== parent.runId ||
    lineage.depth !== depth
  ) {
    throw new Error(`child identity did not preserve the exact depth-${depth} parent chain`);
  }
  if (
    !lineage.parentAgentPrincipal ||
    lineage.parentAgentPrincipal.kind !== "agent" ||
    lineage.parentAgentPrincipal.principalRef !== parent.agentPrincipal.principalRef ||
    !lineage.delegationRef ||
    child.coverageState !== "attribution-only" ||
    !child.applicableGrants.some((grant) => grant.state === "present") ||
    !child.assurance.some((entry) => entry.kind === "spawn-lineage") ||
    child.missingEvidence.length !== 0
  ) {
    throw new Error(`depth-${depth} lineage inputs or coverage were incomplete`);
  }
}

function requirePresentContext(result: AuditRunInspectResult, label: string) {
  if (result.identity.state !== "present") {
    throw new Error(`${label} identity was ${result.identity.state}`);
  }
  return result.identity.context;
}

async function inspectJson(gateway: Gateway, runId: string, label: string) {
  return parseJson(
    await gateway.runCli(["audit", "--run", runId, "--explain", "--json"]),
    label,
  ) as AuditRunInspectResult;
}

async function listSessions(gateway: Gateway): Promise<Record<string, unknown>[]> {
  const payload = requireRecord(
    await gateway.call("sessions.list", { agentId: "qa", limit: 100 }),
    "sessions.list",
  );
  return (Array.isArray(payload.sessions) ? payload.sessions : []).map((row, index) =>
    requireRecord(row, `sessions.list row ${index}`),
  );
}

function sessionRef(row: Record<string, unknown>, label: string): SessionRef {
  return {
    key: requireString(row.key, `${label} key`),
    sessionId: requireString(row.sessionId, `${label} session id`),
  };
}

async function waitForChildSession(gateway: Gateway, parent: SessionRef, label: string) {
  return await waitUntil(
    label,
    async () => {
      const rows = await listSessions(gateway);
      const child = rows.find(
        (row) => row.parentSessionKey === parent.key || row.spawnedBy === parent.key,
      );
      return child ? sessionRef(child, label) : undefined;
    },
    30_000,
  );
}

async function requireActivePlacement(gateway: Gateway, session: SessionRef) {
  return await waitUntil(`active placement for ${sha256(session.key)}`, async () => {
    const payload = requireRecord(
      await gateway.call("sessions.describe", { key: session.key }),
      "sessions.describe",
    );
    const described = requireRecord(payload.session, "described session");
    const placement = requireRecord(described.placement, "session placement");
    return placement.state === "active" ? placement : undefined;
  });
}

async function waitForSubagentTasks(gateway: Gateway, children: readonly SessionRef[]) {
  return await waitUntil(
    "worker lineage subagent tasks",
    async () => {
      const payload = requireRecord(
        await gateway.call("tasks.list", { agentId: "qa", limit: 100 }),
        "tasks.list",
      );
      const rows = (Array.isArray(payload.tasks) ? payload.tasks : []).map((row, index) =>
        requireRecord(row, `tasks.list row ${index}`),
      );
      const matched = children.map((child) =>
        rows.find((row) => row.childSessionKey === child.key),
      );
      const terminalFailure = matched.find(
        (row) => row && row.status !== "running" && row.status !== "completed",
      );
      if (terminalFailure) {
        throw new Error(
          `worker lineage subagent task failed with ${String(terminalFailure.status)}`,
        );
      }
      return matched.every((row) => row?.status === "completed")
        ? (matched as Record<string, unknown>[])
        : undefined;
    },
    30_000,
  );
}

async function assertModelIssuedSpawnCalls(mockBaseUrl: string, labels: readonly string[]) {
  await waitUntil("mock-provider sessions_spawn calls", async () => {
    const response = await fetch(`${mockBaseUrl}/debug/requests`);
    if (!response.ok) {
      throw new Error(`mock provider debug requests returned ${response.status}`);
    }
    const payload = (await response.json()) as unknown;
    if (!Array.isArray(payload)) {
      throw new Error("mock provider debug requests were not an array");
    }
    const observed = new Set(
      payload.flatMap((request) => {
        const row = requireRecord(request, "mock provider request");
        if (row.plannedToolName !== "sessions_spawn") {
          return [];
        }
        const args = requireRecord(row.plannedToolArgs, "sessions_spawn arguments");
        return typeof args.label === "string" ? [args.label] : [];
      }),
    );
    return labels.every((label) => observed.has(label)) ? true : undefined;
  });
}

async function startWorkerGateway(params: {
  executionIdentity: boolean;
  mockBaseUrl: string;
  options: ProducerOptions;
  workspaceDir: string;
}) {
  return await startPairedNodeWorkerGateway({
    providerBaseUrl: params.mockBaseUrl,
    executionIdentity: params.executionIdentity,
    repoRoot: params.options.repoRoot,
    useRepoCli: false,
    workspaceDir: params.workspaceDir,
  });
}

async function runNestedWorkerTopology(params: {
  gateway: Gateway;
  mockBaseUrl: string;
  nodeId: string;
  operator: GatewayClient;
  repo: string;
}) {
  const privateSessionRef = randomUUID();
  const childLabel = `i3-worker-${randomUUID()}`;
  const grandchildLabel = "qa-sidecar";
  const rootKey = `agent:qa:dashboard:i3-${privateSessionRef}`;
  const created = requireRecord(
    await params.operator.request("sessions.create", {
      key: rootKey,
      agentId: "qa",
      worktree: true,
      worktreeName: `i3-${privateSessionRef.slice(0, 8)}`,
      worktreeBaseRef: "main",
      cwd: params.repo,
    }),
    "sessions.create",
  );
  const root = {
    key: requireString(created.key, "created root key"),
    sessionId: requireString(created.sessionId, "created root session id"),
  };
  await params.operator.request("sessions.patch", {
    key: root.key,
    permissionMode: null,
  });
  await params.gateway.call(
    "sessions.dispatch",
    { key: root.key, deviceId: params.nodeId },
    { timeoutMs: PROOF_TIMEOUT_MS },
  );
  const rootPlacement = await requireActivePlacement(params.gateway, root);

  const childTask = "Nested worker lineage handoff: delegate one bounded QA task, then report.";
  const parentPrompt = `Use sessions_spawn for this QA check. task="${childTask}" label=${childLabel}.`;
  const started = requireRecord(
    await params.gateway.call(
      "chat.send",
      {
        sessionKey: root.key,
        message: parentPrompt,
        deliver: false,
        idempotencyKey: randomUUID(),
      },
      { timeoutMs: PROOF_TIMEOUT_MS },
    ),
    "chat.send",
  );
  const rootRunId = requireString(started.runId, "root run id");
  if (started.status !== "started") {
    throw new Error(`worker root did not start: ${String(started.status)}`);
  }
  const completed = requireRecord(
    await params.gateway.call(
      "agent.wait",
      { runId: rootRunId, timeoutMs: PROOF_TIMEOUT_MS },
      { timeoutMs: PROOF_TIMEOUT_MS },
    ),
    "root agent.wait",
  );
  if (completed.status !== "ok") {
    throw new Error(`worker root did not complete: ${String(completed.status)}`);
  }

  let child: SessionRef;
  try {
    child = await waitForChildSession(params.gateway, root, "worker child session");
  } catch (error) {
    throw new Error("worker child session was not created", { cause: error });
  }
  let grandchild: SessionRef;
  try {
    grandchild = await waitForChildSession(params.gateway, child, "nested worker child session");
  } catch (error) {
    throw new Error("nested worker child session was not created", { cause: error });
  }
  const tasks = await waitForSubagentTasks(params.gateway, [child, grandchild]);
  const childRunId = requireString(tasks[0]?.runId, "worker child run id");
  const grandchildRunId = requireString(tasks[1]?.runId, "nested worker child run id");
  const childPlacement = await requireActivePlacement(params.gateway, child);
  const grandchildPlacement = await requireActivePlacement(params.gateway, grandchild);
  await assertModelIssuedSpawnCalls(params.mockBaseUrl, [childLabel, grandchildLabel]);

  return {
    child,
    grandchild,
    privateValues: [
      privateSessionRef,
      childLabel,
      "Subagent handoff: delegate one bounded QA task, then report.",
      parentPrompt,
      params.nodeId,
      "fake",
      root.key,
      root.sessionId,
      child.key,
      child.sessionId,
      grandchild.key,
      grandchild.sessionId,
      requireString(rootPlacement.environmentId, "root environment id"),
      requireString(childPlacement.environmentId, "child environment id"),
      requireString(grandchildPlacement.environmentId, "grandchild environment id"),
    ],
    root,
    runIds: [rootRunId, childRunId, grandchildRunId],
  } satisfies WorkerTopology;
}

function assertPrivateValuesAbsent(
  surfaces: ReadonlyArray<{ label: string; value: unknown }>,
  privateValues: readonly string[],
) {
  for (const surface of surfaces) {
    const encoded =
      typeof surface.value === "string" ? surface.value : JSON.stringify(surface.value);
    for (const privateValue of privateValues) {
      if (privateValue && encoded.includes(privateValue)) {
        throw new Error(`${surface.label} leaked a private worker/session value`);
      }
    }
  }
}

function executionIdentityLogLines(logs: string): string {
  // Placement lifecycle logs legitimately identify their routing objects. This proof
  // isolates the I3 audit surface so unrelated worker operations cannot mask a leak.
  return logs
    .split("\n")
    .filter((line) => /audit|execution.?identity|lineage/iu.test(line))
    .join("\n");
}

async function inspectEnabledTopology(
  gateway: Gateway,
  topology: WorkerTopology,
  workerNode: PairedNodeWorkerHost,
) {
  const stateDir = requireString(
    gateway.runtimeEnv.OPENCLAW_STATE_DIR,
    "enabled Gateway state directory",
  );
  const chain = await waitForLineageChain(stateDir, topology.runIds[0]);
  if (chain.child.runId !== topology.runIds[1] || chain.grandchild.runId !== topology.runIds[2]) {
    throw new Error("persisted lineage did not match the worker task run chain");
  }
  assertLineageLink({ child: chain.child.context, depth: 1, parent: chain.root.context });
  assertLineageLink({ child: chain.grandchild.context, depth: 2, parent: chain.child.context });
  assertTurnClaimsReleased(stateDir, [
    topology.root.sessionId,
    topology.child.sessionId,
    topology.grandchild.sessionId,
  ]);

  const humanBefore = await Promise.all(
    topology.runIds.map((runId) => gateway.runCli(["audit", "--run", runId, "--explain"])),
  );
  for (const [index, text] of humanBefore.entries()) {
    if (!text.includes("Identity") || (index > 0 && !text.includes("Lineage"))) {
      throw new Error(`human audit inspection ${index} omitted identity lineage`);
    }
  }
  const jsonBefore = await Promise.all(
    topology.runIds.map((runId, index) => inspectJson(gateway, runId, `audit before ${index}`)),
  );
  const contextsBefore = jsonBefore.map((result, index) =>
    requirePresentContext(result, `pre-restart context ${index}`),
  );
  const persistedBytes = [chain.root, chain.child, chain.grandchild].map((row) => row.contextJson);
  if (contextsBefore.some((context, index) => JSON.stringify(context) !== persistedBytes[index])) {
    throw new Error("JSON CLI context bytes differed from persisted SQLite bytes");
  }

  await gateway.restartAfterStateMutation(async () => {});
  await waitUntil("paired node reconnect after Gateway restart", async () => {
    try {
      await workerNode.publishInventory();
      return true;
    } catch {
      return undefined;
    }
  });
  await Promise.all([
    requireActivePlacement(gateway, topology.root),
    requireActivePlacement(gateway, topology.child),
    requireActivePlacement(gateway, topology.grandchild),
  ]);
  const jsonAfter = await Promise.all(
    topology.runIds.map((runId, index) => inspectJson(gateway, runId, `audit after ${index}`)),
  );
  const humanAfter = await Promise.all(
    topology.runIds.map((runId) => gateway.runCli(["audit", "--run", runId, "--explain"])),
  );
  const persistedAfter = readPersistedContexts(stateDir);
  for (let index = 0; index < topology.runIds.length; index += 1) {
    const context = requirePresentContext(jsonAfter[index]!, `post-restart context ${index}`);
    const persisted = persistedAfter.find((row) => row.runId === topology.runIds[index]);
    if (
      !persisted ||
      JSON.stringify(context) !== persistedBytes[index] ||
      persisted.contextJson !== persistedBytes[index]
    ) {
      throw new Error(`identity context ${index} changed across Gateway restart`);
    }
  }
  assertPrivateValuesAbsent(
    [
      { label: "enabled audit SQLite", value: persistedBytes },
      { label: "enabled JSON CLI", value: [...jsonBefore, ...jsonAfter] },
      { label: "enabled human CLI", value: [...humanBefore, ...humanAfter] },
      {
        label: "enabled execution-identity Gateway logs",
        value: executionIdentityLogLines(gateway.logs()),
      },
    ],
    topology.privateValues,
  );
  return sha256(persistedBytes.join("\n"));
}

async function inspectDefaultOffTopology(
  gateway: Gateway,
  topology: WorkerTopology,
  workerNode: PairedNodeWorkerHost,
) {
  const stateDir = requireString(
    gateway.runtimeEnv.OPENCLAW_STATE_DIR,
    "default-off Gateway state directory",
  );
  if (executionIdentityTableExists(stateDir) || readPersistedContexts(stateDir).length !== 0) {
    throw new Error("default-off worker topology created execution identity storage");
  }
  const jsonBefore = await Promise.all(
    topology.runIds.map((runId, index) =>
      inspectJson(gateway, runId, `default-off before ${index}`),
    ),
  );
  const humanBefore = await Promise.all(
    topology.runIds.map((runId) => gateway.runCli(["audit", "--run", runId, "--explain"])),
  );
  if (
    jsonBefore.some((result) => result.identity.state === "present") ||
    humanBefore.some((text) => text.includes("  Context:") || text.includes("Parent context"))
  ) {
    throw new Error("default-off CLI exposed a positive execution identity projection");
  }

  await gateway.restartAfterStateMutation(async () => {});
  await waitUntil("default-off paired node reconnect after Gateway restart", async () => {
    try {
      await workerNode.publishInventory();
      return true;
    } catch {
      return undefined;
    }
  });
  await Promise.all([
    requireActivePlacement(gateway, topology.root),
    requireActivePlacement(gateway, topology.child),
    requireActivePlacement(gateway, topology.grandchild),
  ]);
  const jsonAfter = await Promise.all(
    topology.runIds.map((runId, index) =>
      inspectJson(gateway, runId, `default-off after ${index}`),
    ),
  );
  const humanAfter = await Promise.all(
    topology.runIds.map((runId) => gateway.runCli(["audit", "--run", runId, "--explain"])),
  );
  if (
    executionIdentityTableExists(stateDir) ||
    readPersistedContexts(stateDir).length !== 0 ||
    jsonAfter.some((result) => result.identity.state === "present") ||
    humanAfter.some((text) => text.includes("  Context:") || text.includes("Parent context"))
  ) {
    throw new Error("default-off identity absence changed across Gateway restart");
  }
  assertPrivateValuesAbsent(
    [
      { label: "default-off JSON CLI", value: [...jsonBefore, ...jsonAfter] },
      { label: "default-off human CLI", value: [...humanBefore, ...humanAfter] },
      {
        label: "default-off execution-identity Gateway logs",
        value: executionIdentityLogLines(gateway.logs()),
      },
    ],
    topology.privateValues,
  );
}

async function reclaimTopology(gateway: Gateway, topology: WorkerTopology) {
  let reclaimed = 0;
  for (const session of [topology.grandchild, topology.child, topology.root]) {
    const response = requireRecord(
      await gateway.call("sessions.reclaim", { key: session.key }, { timeoutMs: PROOF_TIMEOUT_MS }),
      "sessions.reclaim",
    );
    const placement = requireRecord(response.placement, "reclaimed placement");
    if (placement.state !== "reclaimed" && placement.state !== "local") {
      throw new Error(`session reclaim ended in ${String(placement.state)}`);
    }
    await gateway.call(
      "sessions.delete",
      { key: session.key, deleteTranscript: true, emitLifecycleHooks: false },
      { timeoutMs: PROOF_TIMEOUT_MS },
    );
    reclaimed += 1;
  }
  return reclaimed;
}

async function bestEffortReclaim(gateway: Gateway | undefined) {
  if (!gateway) {
    return;
  }
  const rows = await listSessions(gateway).catch(() => []);
  for (const row of rows.toReversed()) {
    const placement = row.placement;
    if (!placement || typeof placement !== "object" || Array.isArray(placement)) {
      continue;
    }
    const state = (placement as Record<string, unknown>).state;
    if (state === "active" || state === "draining" || state === "failed") {
      const key = typeof row.key === "string" ? row.key : undefined;
      if (key) {
        await gateway
          .call("sessions.reclaim", { key }, { timeoutMs: PROOF_TIMEOUT_MS })
          .catch(() => undefined);
      }
    }
  }
}

async function pathIsAbsent(target: string) {
  try {
    await fs.access(target);
    return false;
  } catch {
    return true;
  }
}

async function stopGatewayAndVerifyStateRemoved(gateway: Gateway) {
  const tempRoot = gateway.tempRoot;
  await gateway.stop();
  if (!(await pathIsAbsent(tempRoot))) {
    throw new Error("QA Gateway temp state survived deterministic cleanup");
  }
}

async function runProof(options: ProducerOptions): Promise<string> {
  // openclaw-temp-dir: standalone QA producer owns and removes this fixture root.
  const fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-i3-worker-lineage-"));
  let mock = await startQaMockOpenAiServer();
  const published = await createPublishedWireWorkspace(fixtureRoot);
  let gateway: Gateway | undefined;
  let operator: GatewayClient | undefined;
  let workerNode: PairedNodeWorkerHost | undefined;
  let proofError: unknown;
  let enabledDigest: string | undefined;
  let reclaimedPlacements = 0;
  try {
    gateway = await startWorkerGateway({
      executionIdentity: false,
      mockBaseUrl: mock.baseUrl,
      options,
      workspaceDir: published.source,
    });
    operator = await connectWireClient({ gateway, role: "operator", identity: null });
    workerNode = await createPairedNodeWorkerHost({
      gateway,
      operator,
      root: fixtureRoot,
      label: "default-off-node",
      capacity: 4,
      bundlePrewarm: true,
      bundleRetention: true,
      bundleStatus: true,
    });
    const defaultOffTopology = await runNestedWorkerTopology({
      gateway,
      mockBaseUrl: mock.baseUrl,
      nodeId: workerNode.identity.deviceId,
      operator,
      repo: published.source,
    });
    await workerNode.waitForWorkersIdle();
    await workerNode.waitForInvokes();
    await waitForTopologySettled(
      requireString(gateway.runtimeEnv.OPENCLAW_STATE_DIR, "default-off Gateway state directory"),
      [defaultOffTopology.root, defaultOffTopology.child, defaultOffTopology.grandchild].map(
        (session) => session.sessionId,
      ),
    );
    await inspectDefaultOffTopology(gateway, defaultOffTopology, workerNode);
    reclaimedPlacements += await reclaimTopology(gateway, defaultOffTopology);
    await workerNode.stop();
    workerNode = undefined;
    await operator.stopAndWait({ timeoutMs: 2_000 });
    operator = undefined;
    await stopGatewayAndVerifyStateRemoved(gateway);
    gateway = undefined;
    await mock.stop();
    mock = await startQaMockOpenAiServer();

    gateway = await startWorkerGateway({
      executionIdentity: true,
      mockBaseUrl: mock.baseUrl,
      options,
      workspaceDir: published.source,
    });
    operator = await connectWireClient({ gateway, role: "operator", identity: null });
    workerNode = await createPairedNodeWorkerHost({
      gateway,
      operator,
      root: fixtureRoot,
      capacity: 4,
      bundlePrewarm: true,
      bundleRetention: true,
      bundleStatus: true,
    });
    const enabledTopology = await runNestedWorkerTopology({
      gateway,
      mockBaseUrl: mock.baseUrl,
      nodeId: workerNode.identity.deviceId,
      operator,
      repo: published.source,
    });
    await workerNode.waitForWorkersIdle();
    await workerNode.waitForInvokes();
    await waitForTopologySettled(
      requireString(gateway.runtimeEnv.OPENCLAW_STATE_DIR, "enabled Gateway state directory"),
      [enabledTopology.root, enabledTopology.child, enabledTopology.grandchild].map(
        (session) => session.sessionId,
      ),
    );
    enabledDigest = await inspectEnabledTopology(gateway, enabledTopology, workerNode);
    reclaimedPlacements += await reclaimTopology(gateway, enabledTopology);
    await workerNode.stop();
    workerNode = undefined;
    await operator.stopAndWait({ timeoutMs: 2_000 });
    operator = undefined;
    await stopGatewayAndVerifyStateRemoved(gateway);
    gateway = undefined;
  } catch (error) {
    proofError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (gateway) {
    await bestEffortReclaim(gateway).catch((error: unknown) => cleanupErrors.push(error));
  }
  if (workerNode) {
    await workerNode.stop().catch((error: unknown) => cleanupErrors.push(error));
  }
  if (operator) {
    await operator
      .stopAndWait({ timeoutMs: 2_000 })
      .catch((error: unknown) => cleanupErrors.push(error));
  }
  if (gateway) {
    await gateway.stop().catch((error: unknown) => cleanupErrors.push(error));
  }
  await mock.stop().catch((error: unknown) => cleanupErrors.push(error));
  await closeWireServer(published.server).catch((error: unknown) => cleanupErrors.push(error));
  await fs
    .rm(fixtureRoot, { recursive: true, force: true })
    .catch((error: unknown) => cleanupErrors.push(error));
  if (!(await pathIsAbsent(fixtureRoot))) {
    cleanupErrors.push(new Error("worker lineage fixture root survived cleanup"));
  }
  if (proofError || cleanupErrors.length > 0) {
    const errors = [...(proofError ? [proofError] : []), ...cleanupErrors];
    throw errors.length === 1
      ? errors[0]
      : new AggregateError(errors, "worker lineage proof or cleanup failed", {
          cause: proofError,
        });
  }
  if (!enabledDigest || reclaimedPlacements !== 6) {
    throw new Error("worker lineage proof did not produce complete evidence");
  }

  await fs.mkdir(options.artifactBase, { recursive: true });
  await fs.writeFile(
    path.join(options.artifactBase, SUMMARY_FILE),
    `${JSON.stringify(
      {
        status: "pass",
        topology: {
          workerHostedActualSessionsSpawn: true,
          nestedWorkerActualSessionsSpawn: true,
          exactLineageChain: true,
          depths: [0, 1, 2],
        },
        persistence: {
          sqlite: true,
          gatewayRestarted: true,
          persistedBytesStable: true,
          jsonCliInspected: true,
          humanCliInspected: true,
          redactedChainSha256: enabledDigest,
        },
        privacy: {
          defaultOffAbsent: true,
          privacyRedactionPassed: true,
          rawIdentityValuesIncluded: false,
        },
        cleanup: {
          cleanupPassed: true,
          reclaimedPlacements,
          gatewayStateRemoved: true,
          nodeWorkerStopped: true,
          workspaceServerStopped: true,
          fixtureRootRemoved: true,
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  return `actual worker and nested-worker sessions_spawn lineage passed; redacted chain sha256=${enabledDigest}`;
}

async function produceProof(options: ProducerOptions): Promise<ProofResult> {
  const startedAt = Date.now();
  try {
    return {
      artifacts: [{ filePath: SUMMARY_FILE, kind: "summary" }],
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
    primaryModel: MODEL_REF,
    providerMode: "mock-openai",
    repoRoot: options.repoRoot,
    target: {
      id: SCENARIO_ID,
      title: "Subagent execution lineage inspection",
      sourcePath: `qa/scenarios/runtime/${SCENARIO_ID}.yaml`,
      docsRefs: ["docs/gateway/audit.md", "docs/tools/subagents.md", "docs/cli/audit.md"],
      codeRefs: [
        "src/gateway/worker-environments/worker-turn-launcher.ts",
        "src/gateway/worker-environments/worker-session-tool-executor.ts",
        "src/agents/tools/sessions-spawn-tool.ts",
        "src/gateway/agent-turn/agent-run-execution-lineage.ts",
        "src/audit/execution-identity-context-build.ts",
        "src/commands/audit.ts",
      ],
    },
  });
  const result = await produceProof(options);
  writer.appendLog(`${result.status}: ${result.details ?? "no details"}\n`);
  return await writer.write(result);
}

async function main(argv: readonly string[]) {
  const options = parseOptions(argv);
  const priorStateDir = process.env.OPENCLAW_STATE_DIR;
  const priorConfigPath = process.env.OPENCLAW_CONFIG_PATH;
  process.env.OPENCLAW_STATE_DIR = path.join(options.artifactBase, "script-state");
  process.env.OPENCLAW_CONFIG_PATH = path.join(options.artifactBase, "script-openclaw.json");
  try {
    const evidence = await runProducer(options);
    const status = evidence.entries[0]?.result.status;
    console.log(`Subagent lineage evidence: ${QA_EVIDENCE_FILENAME}`);
    console.log(`Subagent lineage status: ${status}`);
    return status === "pass" ? 0 : 1;
  } finally {
    if (priorStateDir === undefined) {
      delete process.env.OPENCLAW_STATE_DIR;
    } else {
      process.env.OPENCLAW_STATE_DIR = priorStateDir;
    }
    if (priorConfigPath === undefined) {
      delete process.env.OPENCLAW_CONFIG_PATH;
    } else {
      process.env.OPENCLAW_CONFIG_PATH = priorConfigPath;
    }
  }
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
