// QA Lab producer proves exact-run identity inspection through a real local turn and Gateway.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as sleep } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { WebSocket, type ClientOptions, type RawData } from "ws";
import {
  QA_EVIDENCE_FILENAME,
  type QaEvidenceSummaryJson,
} from "../../../../extensions/qa-lab/src/evidence-summary.js";
import { startQaGatewayChild } from "../../../../extensions/qa-lab/src/gateway-child.js";
import { startQaMockOpenAiServer } from "../../../../extensions/qa-lab/src/providers/mock-openai/server.js";
import { buildDeviceAuthPayloadV3 } from "../../../../packages/gateway-client/src/device-auth.js";
import {
  GATEWAY_CLIENT_IDS,
  GATEWAY_CLIENT_MODES,
} from "../../../../packages/gateway-protocol/src/client-info.js";
import type { AuditRunInspectResult } from "../../../../packages/gateway-protocol/src/index.js";
import {
  MIN_CLIENT_PROTOCOL_VERSION,
  PROTOCOL_VERSION,
} from "../../../../packages/gateway-protocol/src/index.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
  type DeviceIdentity,
} from "../../../../src/infra/device-identity.js";
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
const FRAME_TIMEOUT_MS = 20_000;
const GATEWAY_SCOPES = [
  "operator.admin",
  "operator.pairing",
  "operator.read",
  "operator.write",
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

type RawGatewayClient = {
  frames: unknown[];
  socket: WebSocket;
};

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) {
    return Buffer.concat(data.map((chunk) => Buffer.from(chunk))).toString("utf8");
  }
  return Buffer.isBuffer(data) ? data.toString("utf8") : Buffer.from(data).toString("utf8");
}

async function openRawGatewayClient(
  url: string,
  headers?: Record<string, string>,
): Promise<RawGatewayClient> {
  const socket = new WebSocket(url, headers ? ({ headers } satisfies ClientOptions) : undefined);
  const frames: unknown[] = [];
  socket.on("message", (data) => frames.push(parseJson(rawDataText(data), "Gateway frame")));
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return { frames, socket };
}

async function waitForFrame(
  client: RawGatewayClient,
  predicate: (frame: unknown) => boolean,
  startIndex = 0,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const frame = client.frames.slice(startIndex).find(predicate);
    if (isRecord(frame)) {
      return frame;
    }
    await sleep(20);
  }
  throw new Error(`timed out waiting for Gateway frame: ${JSON.stringify(client.frames)}`);
}

function responseFor(id: string) {
  return (frame: unknown) => isRecord(frame) && frame.type === "res" && frame.id === id;
}

async function closeRawGatewayClient(client: RawGatewayClient): Promise<void> {
  if (client.socket.readyState === WebSocket.CLOSED) {
    return;
  }
  await new Promise<void>((resolve) => {
    client.socket.once("close", () => resolve());
    client.socket.close();
    setTimeout(resolve, 1_000).unref();
  });
}

async function connectRawDevice(params: {
  device: DeviceIdentity;
  headers?: Record<string, string>;
  token?: string;
  wsUrl: string;
}): Promise<{ client: RawGatewayClient; connected: boolean }> {
  const client = await openRawGatewayClient(params.wsUrl, params.headers);
  const challenge = await waitForFrame(
    client,
    (frame) => isRecord(frame) && frame.type === "event" && frame.event === "connect.challenge",
  );
  const challengePayload = challenge.payload;
  if (!isRecord(challengePayload) || typeof challengePayload.nonce !== "string") {
    throw new Error("Gateway connect challenge omitted its nonce");
  }
  const clientInfo = {
    id: GATEWAY_CLIENT_IDS.GATEWAY_CLIENT,
    mode: GATEWAY_CLIENT_MODES.BACKEND,
    platform: "linux",
    version: "qa-local-user-ingress",
  } as const;
  const signedAt = Date.now();
  const devicePayload = buildDeviceAuthPayloadV3({
    deviceId: params.device.deviceId,
    clientId: clientInfo.id,
    clientMode: clientInfo.mode,
    role: "operator",
    scopes: [...GATEWAY_SCOPES],
    signedAtMs: signedAt,
    token: params.token,
    nonce: challengePayload.nonce,
    platform: clientInfo.platform,
  });
  const requestId = `connect-${randomUUID()}`;
  const startIndex = client.frames.length;
  client.socket.send(
    JSON.stringify({
      type: "req",
      id: requestId,
      method: "connect",
      params: {
        minProtocol: MIN_CLIENT_PROTOCOL_VERSION,
        maxProtocol: PROTOCOL_VERSION,
        client: clientInfo,
        role: "operator",
        scopes: [...GATEWAY_SCOPES],
        caps: [],
        ...(params.token ? { auth: { token: params.token } } : {}),
        device: {
          id: params.device.deviceId,
          publicKey: publicKeyRawBase64UrlFromPem(params.device.publicKeyPem),
          signature: signDevicePayload(params.device.privateKeyPem, devicePayload),
          signedAt,
          nonce: challengePayload.nonce,
        },
      },
    }),
  );
  const response = await waitForFrame(client, responseFor(requestId), startIndex);
  return { client, connected: response.ok === true };
}

async function rawGatewayRequest<T>(
  client: RawGatewayClient,
  method: string,
  params: unknown,
): Promise<T> {
  const requestId = `request-${randomUUID()}`;
  const startIndex = client.frames.length;
  client.socket.send(JSON.stringify({ type: "req", id: requestId, method, params }));
  const response = await waitForFrame(client, responseFor(requestId), startIndex);
  if (response.ok !== true) {
    throw new Error(`${method} failed: ${JSON.stringify(response.error)}`);
  }
  return response.payload as T;
}

async function approveDeviceIfNeeded(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  deviceId: string,
): Promise<void> {
  const deadline = Date.now() + FRAME_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const pairings = (await gateway.call("device.pair.list", {})) as {
      pending?: Array<{ deviceId?: string; requestId?: string }>;
    };
    const pending = pairings.pending?.find((candidate) => candidate.deviceId === deviceId);
    if (pending?.requestId) {
      await gateway.call("device.pair.approve", { requestId: pending.requestId });
      return;
    }
    await sleep(50);
  }
  throw new Error(`device pairing request was not visible for ${deviceId}`);
}

async function createFakeTailscaleBinary(): Promise<{
  binaryDir: string;
  cleanup: () => Promise<void>;
}> {
  const binaryDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-i1-tailscale-"));
  try {
    const binaryPath = path.join(binaryDir, "tailscale");
    await fs.writeFile(
      binaryPath,
      `#!/bin/sh
if [ "$1" = "--version" ]; then
  echo "qa-tailscale 1.0"
  exit 0
fi
echo '{"UserProfile":{"LoginName":"operator@example.com","DisplayName":"Operator"}}'
`,
      { encoding: "utf8", mode: 0o755 },
    );
    return {
      binaryDir,
      cleanup: async () => await fs.rm(binaryDir, { force: true, recursive: true }),
    };
  } catch (error) {
    await fs.rm(binaryDir, { force: true, recursive: true });
    throw error;
  }
}

async function runGatewayTurn(
  client: RawGatewayClient,
  message: string,
  sessionKey: string,
): Promise<string> {
  const started = await rawGatewayRequest<{ runId?: unknown; status?: unknown }>(client, "agent", {
    sessionKey,
    message,
    deliver: false,
    idempotencyKey: randomUUID(),
  });
  if (started.status !== "accepted" || typeof started.runId !== "string") {
    throw new Error(`profiled Gateway run did not start: ${JSON.stringify(started)}`);
  }
  const terminal = await rawGatewayRequest<{ status?: unknown }>(client, "agent.wait", {
    runId: started.runId,
    timeoutMs: 60_000,
  });
  if (terminal.status !== "ok") {
    throw new Error(`profiled Gateway run did not finish: ${JSON.stringify(terminal)}`);
  }
  return started.runId;
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

function assertGatewayIdentityProjection(
  result: AuditRunInspectResult,
  expected: { coverage: "attribution-only" | "unattributed"; invoker: "absent" | "present" },
) {
  const context = requireIdentityContext(result);
  if (
    context.ingress.kind !== "gateway-client" ||
    context.ingress.state !== "present" ||
    context.ingress.boundary !== "gateway.ws.authenticated-connect"
  ) {
    throw new Error("Gateway run did not retain its authenticated connection ingress");
  }
  if (
    context.invoker.state !== expected.invoker ||
    context.coverageState !== expected.coverage ||
    context.representedSubject !== undefined
  ) {
    throw new Error(
      `Gateway identity projection fabricated or lost a subject: ${JSON.stringify(context)}`,
    );
  }
  if (expected.invoker === "present") {
    if (
      context.invoker.principal?.kind !== "person" ||
      context.invoker.principal.displayLabel !== "Operator" ||
      !context.assurance.some((item) => item.kind === "durable-profile") ||
      !context.assurance.some((item) => item.kind === "tailscale-whois")
    ) {
      throw new Error("profiled Gateway run omitted its durable Tailscale attribution");
    }
  } else if (context.assurance.some((item) => item.kind === "durable-profile")) {
    throw new Error("profileless Gateway run fabricated durable profile assurance");
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

function inspectPersistedSessionCreator(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  sessionKey: string,
) {
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

function assertPersistedContextBytes(
  gateway: Awaited<ReturnType<typeof startQaGatewayChild>>,
  runId: string,
  expectedContext: string,
): void {
  const rows = findRunExecutions(gateway, runId);
  if (rows.length !== 1 || rows[0]?.context_json !== expectedContext) {
    throw new Error(`RPC context bytes differ from persisted bytes: ${runId}`);
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
  let fakeTailscale: Awaited<ReturnType<typeof createFakeTailscaleBinary>> | undefined;
  let gateway: Awaited<ReturnType<typeof startQaGatewayChild>> | undefined;
  try {
    fakeTailscale = await createFakeTailscaleBinary();
    gateway = await startQaGatewayChild({
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
      runtimeEnvPatch: {
        PATH: `${fakeTailscale.binaryDir}${path.delimiter}${process.env.PATH ?? ""}`,
      },
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

    const device = loadOrCreateDeviceIdentity({
      path: path.join(gateway.tempRoot, "i1-profiled-device.sqlite"),
    });
    const tailscaleHeaders = {
      "tailscale-user-login": "operator@example.com",
      "tailscale-user-name": "Operator",
      "x-forwarded-for": "100.64.0.11",
      "x-forwarded-host": "gateway.qa.test",
      "x-forwarded-proto": "https",
    };
    let profiled = await connectRawDevice({
      device,
      headers: tailscaleHeaders,
      wsUrl: gateway.wsUrl,
    });
    if (!profiled.connected) {
      await approveDeviceIfNeeded(gateway, device.deviceId);
      await closeRawGatewayClient(profiled.client);
      profiled = await connectRawDevice({
        device,
        headers: tailscaleHeaders,
        wsUrl: gateway.wsUrl,
      });
    }
    if (!profiled.connected) {
      throw new Error(
        `Tailscale-profiled Gateway client failed: ${JSON.stringify(profiled.client.frames)}`,
      );
    }
    const profiledSessionKey = `agent:qa:i1-profiled-${randomUUID()}`;
    const profiledRunId = await runGatewayTurn(
      profiled.client,
      "Reply exactly: I1-PROFILED",
      profiledSessionKey,
    );
    await closeRawGatewayClient(profiled.client);

    const profilelessText = await gateway.runCli(["audit", "--run", profilelessRunId, "--explain"]);
    const profiledText = await gateway.runCli(["audit", "--run", profiledRunId, "--explain"]);
    assertTextProjection(profilelessText);
    assertTextProjection(profiledText);
    if (
      !profilelessText.includes("Invoker [absent]") ||
      !profilelessText.includes("Represented subject [absent]") ||
      profilelessText.includes("Operator")
    ) {
      throw new Error("profileless text inspection fabricated an operator subject");
    }
    if (
      !profiledText.includes("Invoker [present]") ||
      !profiledText.includes("Represented subject [absent]")
    ) {
      throw new Error(
        `profiled text inspection omitted durable operator attribution: ${profiledText}`,
      );
    }
    const profilelessBefore = parseJson(
      await gateway.runCli(["audit", "--run", profilelessRunId, "--explain", "--json"]),
      "profileless Gateway inspection",
    ) as AuditRunInspectResult;
    const profiledBefore = parseJson(
      await gateway.runCli(["audit", "--run", profiledRunId, "--explain", "--json"]),
      "profiled Gateway inspection",
    ) as AuditRunInspectResult;
    assertGatewayIdentityProjection(profilelessBefore, {
      coverage: "unattributed",
      invoker: "absent",
    });
    assertGatewayIdentityProjection(profiledBefore, {
      coverage: "attribution-only",
      invoker: "present",
    });
    const profilelessContext = normalizedContextJson(profilelessBefore);
    const profiledContext = normalizedContextJson(profiledBefore);
    assertPersistedContextBytes(gateway, profilelessRunId, profilelessContext);
    assertPersistedContextBytes(gateway, profiledRunId, profiledContext);

    const listed = (await gateway.call("sessions.list", {})) as {
      sessions?: Array<{
        key?: string;
        createdActor?: { id?: string; label?: string; type?: string };
      }>;
    };
    const profilelessSession = listed.sessions?.find(
      (session) => session.key === profilelessSessionKey,
    );
    const profiledSession = listed.sessions?.find((session) => session.key === profiledSessionKey);
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
    if (
      profiledSession?.createdActor?.type !== "human" ||
      !profiledSession.createdActor.id ||
      profiledSession.createdActor.label !== "Operator"
    ) {
      throw new Error("profiled Gateway session lost its current profile display projection");
    }
    const profiledCreator = inspectPersistedSessionCreator(gateway, profiledSessionKey);
    if (
      profiledCreator.type !== "human" ||
      profiledCreator.id !== profiledSession.createdActor.id ||
      profiledCreator.labelPersisted
    ) {
      throw new Error("profiled Gateway session did not persist only its authenticated profile id");
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
    for (const [gatewayRunId, expectedContext, expectedIdentity] of [
      [profilelessRunId, profilelessContext, { coverage: "unattributed", invoker: "absent" }],
      [profiledRunId, profiledContext, { coverage: "attribution-only", invoker: "present" }],
    ] as const) {
      const afterGateway = parseJson(
        await gateway.runCli(["audit", "--run", gatewayRunId, "--explain", "--json"]),
        `post-restart Gateway run ${gatewayRunId}`,
      ) as AuditRunInspectResult;
      assertGatewayIdentityProjection(afterGateway, expectedIdentity);
      if (normalizedContextJson(afterGateway) !== expectedContext) {
        throw new Error(`Gateway execution changed across restart: ${gatewayRunId}`);
      }
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
            profiled: { runId: profiledRunId, contextSha256: sha256(profiledContext) },
            profileless: {
              runId: profilelessRunId,
              contextSha256: sha256(profilelessContext),
            },
          },
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
    const repeatedDetails = `repeated run=${repeatedRunId} executions=${repeatedRows.map((row) => row.execution_id).join(",")}; exact selection passed`;
    return `local run=${runId}; profiled Gateway run=${profiledRunId}; profileless Gateway run=${profilelessRunId}; ${repeatedDetails}; Gateway pid=${gateway.pid ?? "unknown"}; text+JSON and persisted bytes passed before/after replacement; normalized context sha256=${sha256(beforeContext)}`;
  } finally {
    await gateway?.stop().catch(() => undefined);
    await mock.stop();
    await fakeTailscale?.cleanup();
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
