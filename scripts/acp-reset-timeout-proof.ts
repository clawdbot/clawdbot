#!/usr/bin/env node

import { execFileSync, spawn, type ChildProcessByStdio } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ChatEvent, EventFrame } from "../packages/gateway-protocol/src/index.js";
import type { GatewayClient } from "../src/gateway/client.js";
import { connectTestGatewayClient } from "../src/gateway/gateway-cli-backend.live-helpers.js";
import { createOpenClawTestState } from "../src/test-utils/openclaw-test-state.js";
import { getFreePortBlockWithPermissionFallback } from "../src/test-utils/ports.js";
import { sleep } from "../src/utils/sleep.js";

const RESET_CLEANUP_DEADLINE_MS = 15_000;
const RESET_REQUEST_TIMEOUT_MS = 75_000;
const EVENT_WAIT_TIMEOUT_MS = 30_000;
const CONTROL_SESSION_KEY = "main";
const PROOF_CHANNEL = "telegram";
const PROOF_ACCOUNT_ID = "default";
const PROOF_CONVERSATION_ID = "1000000001";
const PROOF_TELEGRAM_TOKEN = "123456:proof-only-not-a-real-token";
const PROOF_ACP_AGENT = "main";

type AdapterEvent = {
  at: string;
  event: string;
  instanceId: string;
  pid: number;
  sessionId?: string;
  text?: string;
  reply?: string;
  stopReason?: string;
  [key: string]: unknown;
};

type RuntimeIdentity = {
  instanceId: string;
  sessionId: string;
};

type ScenarioName = "close-timeout" | "cancel-timeout" | "late-turn" | "runtime-option-timeout";
type ResetCommand = "/new" | "/reset";
type GatewayProcess = ChildProcessByStdio<null, Readable, Readable>;
type ChatFinalEvent = Extract<ChatEvent, { state: "final" }>;

type ScenarioResult = {
  scenario: ScenarioName;
  resetCommand: ResetCommand;
  gatewayPid: number;
  gatewayPidAfterReset: number;
  gatewayPidAfterLateCompletion: number;
  oldIdentity: RuntimeIdentity;
  freshIdentity: RuntimeIdentity;
  followupIdentity: RuntimeIdentity;
  cleanupStartedAt: string;
  cleanupDeadlineAt: string;
  resetCompletedAt: string;
  resetElapsedMs: number;
  resetResponse: string;
  lateCompletionAt: string;
  lateRuntimeOptionCompletedAt?: string;
  gatewayStayedAlive: boolean;
  assertions: string[];
  keyEvents: AdapterEvent[];
};

export function parseAdapterEvents(raw: string): AdapterEvent[] {
  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line) as AdapterEvent;
        return parsed && typeof parsed === "object" ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

export function identityFromTurn(event: AdapterEvent): RuntimeIdentity {
  if (!event.sessionId) {
    throw new Error(`turn event is missing sessionId: ${JSON.stringify(event)}`);
  }
  return { instanceId: event.instanceId, sessionId: event.sessionId };
}

export function sameAcpSession(left: RuntimeIdentity, right: RuntimeIdentity): boolean {
  return left.sessionId === right.sessionId;
}

export function extractSpawnedAcpSessionKey(messages: unknown[]): string {
  for (const message of messages) {
    if (
      !message ||
      typeof message !== "object" ||
      (message as { role?: unknown }).role !== "assistant"
    ) {
      continue;
    }
    const match = messageText(message).match(/Spawned ACP session (\S+) \(/);
    if (match?.[1]) {
      return match[1];
    }
  }
  return "";
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(message);
  }
}

async function readEvents(controlDir: string): Promise<AdapterEvent[]> {
  const raw = await fs.readFile(path.join(controlDir, "adapter.jsonl"), "utf8").catch(() => "");
  return parseAdapterEvents(raw);
}

async function waitForEvent(params: {
  controlDir: string;
  afterIndex?: number;
  description: string;
  predicate: (event: AdapterEvent) => boolean;
  timeoutMs?: number;
}): Promise<{ event: AdapterEvent; index: number; events: AdapterEvent[] }> {
  const startedAt = Date.now();
  const afterIndex = params.afterIndex ?? -1;
  while (Date.now() - startedAt < (params.timeoutMs ?? EVENT_WAIT_TIMEOUT_MS)) {
    const events = await readEvents(params.controlDir);
    const relativeIndex = events.slice(afterIndex + 1).findIndex(params.predicate);
    if (relativeIndex >= 0) {
      const index = afterIndex + 1 + relativeIndex;
      return { event: events[index]!, index, events };
    }
    await sleep(50);
  }
  const events = await readEvents(params.controlDir);
  throw new Error(
    `timed out waiting for ${params.description}; recent events=${JSON.stringify(events.slice(-12))}`,
  );
}

async function writeMarker(controlDir: string, name: string): Promise<void> {
  await fs.writeFile(path.join(controlDir, name), `${new Date().toISOString()}\n`, "utf8");
}

async function releaseAllMarkers(controlDir: string): Promise<void> {
  await Promise.all(
    ["release-cancel", "release-close", "release-set-mode", "release-turn"].map((name) =>
      writeMarker(controlDir, name),
    ),
  );
}

async function logDriverEvent(
  scenarioDir: string,
  event: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  await fs.appendFile(
    path.join(scenarioDir, "driver.jsonl"),
    `${JSON.stringify({ at: new Date().toISOString(), event, ...fields })}\n`,
    "utf8",
  );
}

function readAcpMetadataRow(
  stateDir: string,
  sessionKey: string,
): Record<string, unknown> | undefined {
  const databasePath = path.join(stateDir, "state", "openclaw.sqlite");
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return database
        .prepare("SELECT * FROM acp_sessions WHERE session_key = ?")
        .get(sessionKey) as Record<string, unknown> | undefined;
    } finally {
      database.close();
    }
  } catch {
    return undefined;
  }
}

function readAgentSessionRows(stateDir: string, sessionKey: string): Record<string, unknown> {
  const databasePath = path.join(
    stateDir,
    "agents",
    PROOF_ACP_AGENT,
    "agent",
    "openclaw-agent.sqlite",
  );
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      return {
        node: database.prepare("SELECT * FROM session_nodes WHERE session_key = ?").get(sessionKey),
        windows: database
          .prepare("SELECT * FROM session_windows WHERE session_key = ? ORDER BY updated_at DESC")
          .all(sessionKey),
      };
    } finally {
      database.close();
    }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

export function readAcpSessionIdFromRow(row: Record<string, unknown> | undefined): string {
  const raw = row?.identity_json;
  if (typeof raw !== "string") {
    return "";
  }
  try {
    const identity = JSON.parse(raw) as { acpxSessionId?: unknown };
    return typeof identity.acpxSessionId === "string" ? identity.acpxSessionId : "";
  } catch {
    return "";
  }
}

async function sendChat(
  client: GatewayClient,
  text: string,
  options: { sessionKey?: string; withOrigin?: boolean } = {},
): Promise<string> {
  const startedAt = Date.now();
  while (true) {
    try {
      const withOrigin = options.withOrigin !== false;
      const started = await client.request<{ runId?: string; status?: string }>("chat.send", {
        sessionKey: options.sessionKey ?? CONTROL_SESSION_KEY,
        message: text,
        idempotencyKey: `proof-${text}-${randomUUID()}`,
        ...(withOrigin
          ? {
              originatingChannel: PROOF_CHANNEL,
              originatingTo: PROOF_CONVERSATION_ID,
              originatingAccountId: PROOF_ACCOUNT_ID,
            }
          : {}),
      });
      assert(started.status === "started" && typeof started.runId === "string", "chat.send failed");
      return started.runId;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        !message.includes("chat.send unavailable during gateway startup") ||
        Date.now() - startedAt >= 30_000
      ) {
        throw error;
      }
      await sleep(250);
    }
  }
}

async function waitForRun(client: GatewayClient, runId: string, timeoutMs = 45_000): Promise<void> {
  const result = await client.request<{ error?: unknown; status?: string }>(
    "agent.wait",
    { runId, timeoutMs },
    { timeoutMs: timeoutMs + 5_000 },
  );
  assert(result.status === "ok", `agent.wait failed for ${runId}: ${JSON.stringify(result)}`);
}

function messageText(message: unknown): string {
  if (!message || typeof message !== "object") {
    return "";
  }
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((block) => {
      if (!block || typeof block !== "object") {
        return [];
      }
      const text = (block as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("");
}

function isChatFinalEvent(payload: unknown, runId: string): payload is ChatFinalEvent {
  if (!payload || typeof payload !== "object") {
    return false;
  }
  const candidate = payload as { state?: unknown; runId?: unknown };
  return candidate.state === "final" && candidate.runId === runId;
}

async function sendResetCommand(params: {
  client: GatewayClient;
  gatewayEvents: EventFrame[];
  scenarioDir: string;
  acpSessionKey: string;
  command: ResetCommand;
}): Promise<string> {
  const runId = await sendChat(params.client, params.command);
  await logDriverEvent(params.scenarioDir, "reset_command_requested", {
    command: params.command,
    sourceSessionKey: CONTROL_SESSION_KEY,
    acpSessionKey: params.acpSessionKey,
    runId,
  });
  await waitForRun(params.client, runId, RESET_REQUEST_TIMEOUT_MS - 5_000);
  const finalEvent = params.gatewayEvents
    .toReversed()
    .find(
      (event): event is EventFrame & { payload: ChatFinalEvent } =>
        event.event === "chat" && isChatFinalEvent(event.payload, runId),
    );
  const histories = await Promise.all(
    [CONTROL_SESSION_KEY, params.acpSessionKey].map(async (sessionKey) => {
      const history = await params.client.request<{ messages?: unknown[] }>("chat.history", {
        sessionKey,
        limit: 20,
      });
      return history.messages ?? [];
    }),
  );
  const historyResponse = histories
    .flat()
    .toReversed()
    .filter(
      (message) =>
        message &&
        typeof message === "object" &&
        (message as { role?: unknown }).role === "assistant",
    )
    .map(messageText)
    .find((text) => text.includes("ACP session reset in place") || text.includes("Session reset"));
  const eventResponse = messageText(finalEvent?.payload?.message);
  const resetResponse =
    [eventResponse, historyResponse].find(
      (text) => text?.includes("ACP session reset in place") || text?.includes("Session reset"),
    ) ?? "";
  await logDriverEvent(params.scenarioDir, "reset_command_observed", {
    command: params.command,
    runId,
    eventResponse,
    historyResponse,
  });
  assert(resetResponse, `${params.command} did not return its reset acknowledgement`);
  await logDriverEvent(params.scenarioDir, "reset_command_completed", {
    command: params.command,
    sourceSessionKey: CONTROL_SESSION_KEY,
    acpSessionKey: params.acpSessionKey,
    runId,
    response: resetResponse,
  });
  return resetResponse;
}

function requireGatewayPid(pid: number | undefined): number {
  assert(typeof pid === "number", "Gateway child process has no PID");
  process.kill(pid, 0);
  return pid;
}

async function waitForGatewayPort(params: {
  child: GatewayProcess;
  port: number;
  timeoutMs: number;
}): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < params.timeoutMs) {
    if (params.child.exitCode !== null || params.child.signalCode !== null) {
      throw new Error(
        `Gateway exited before listening: code=${String(params.child.exitCode)} signal=${String(params.child.signalCode)}`,
      );
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.connect({ host: "127.0.0.1", port: params.port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {
      await sleep(50);
    }
  }
  throw new Error(`timed out waiting for Gateway port ${params.port}`);
}

function signalGatewayProcess(child: GatewayProcess, signal: NodeJS.Signals): void {
  if (process.platform !== "win32" && typeof child.pid === "number") {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch {
      // Fall back to the direct child when the process group already exited.
    }
  }
  child.kill(signal);
}

async function stopGatewayProcess(child: GatewayProcess | undefined): Promise<void> {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  signalGatewayProcess(child, "SIGTERM");
  const exited = await Promise.race([
    new Promise<boolean>((resolve) => {
      child.once("exit", () => {
        resolve(true);
      });
    }),
    sleep(3_000).then(() => false),
  ]);
  if (!exited && child.exitCode === null && child.signalCode === null) {
    signalGatewayProcess(child, "SIGKILL");
    await Promise.race([
      new Promise<void>((resolve) => {
        child.once("exit", () => {
          resolve();
        });
      }),
      sleep(3_000),
    ]);
  }
}

async function sendAndObserveTurn(params: {
  client: GatewayClient;
  controlDir: string;
  scenarioDir: string;
  stateDir: string;
  acpSessionKey: string;
  text: string;
  afterIndex?: number;
  directToAcpSession?: boolean;
}): Promise<{ event: AdapterEvent; index: number }> {
  const runId = await sendChat(
    params.client,
    params.text,
    params.directToAcpSession ? { sessionKey: params.acpSessionKey } : {},
  );
  await logDriverEvent(params.scenarioDir, "turn_requested", {
    sourceSessionKey: CONTROL_SESSION_KEY,
    acpSessionKey: params.acpSessionKey,
    text: params.text,
    runId,
  });
  await waitForRun(params.client, runId);
  await logDriverEvent(params.scenarioDir, "turn_run_completed", {
    acpSessionKey: params.acpSessionKey,
    text: params.text,
    runId,
    acpRow: readAcpMetadataRow(params.stateDir, params.acpSessionKey),
    agentRows: readAgentSessionRows(params.stateDir, params.acpSessionKey),
  });
  return await waitForEvent({
    controlDir: params.controlDir,
    afterIndex: params.afterIndex,
    description: `completed turn ${params.text}`,
    predicate: (event) =>
      event.event === "turn_end" && event.text === params.text && event.stopReason === "end_turn",
  });
}

async function spawnAndBindAcpSession(params: {
  client: GatewayClient;
  controlDir: string;
  repoRoot: string;
  scenarioDir: string;
}): Promise<string> {
  const command = `/acp spawn ${PROOF_ACP_AGENT} --bind here --cwd ${params.repoRoot}`;
  const runId = await sendChat(params.client, command);
  await logDriverEvent(params.scenarioDir, "acp_spawn_requested", {
    sourceSessionKey: CONTROL_SESSION_KEY,
    runId,
  });
  await waitForRun(params.client, runId, 60_000);
  const history = await params.client.request<{ messages?: unknown[] }>("chat.history", {
    sessionKey: CONTROL_SESSION_KEY,
    limit: 20,
  });
  const messages = history.messages ?? [];
  const acpSessionKey = extractSpawnedAcpSessionKey(messages);
  assert(
    acpSessionKey,
    `the ACP spawn command did not return a session key: ${messages.map(messageText).join(" | ")}`,
  );
  await waitForEvent({
    controlDir: params.controlDir,
    description: "spawned ACP adapter session creation",
    predicate: (event) => event.event === "session_create",
  });
  await logDriverEvent(params.scenarioDir, "acp_spawn_bound", {
    sourceSessionKey: CONTROL_SESSION_KEY,
    acpSessionKey,
    runId,
  });
  return acpSessionKey;
}

async function snapshotDirectory(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (dir: string): Promise<void> => {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolute);
      } else if (entry.isFile()) {
        const relative = path.relative(root, absolute);
        const stat = await fs.stat(absolute);
        snapshot[relative] =
          stat.size <= 256 * 1024
            ? await fs.readFile(absolute, "utf8").catch(() => `<binary:${stat.size}>`)
            : `<omitted:${stat.size}>`;
      }
    }
  };
  await visit(root);
  return snapshot;
}

function redactGatewayLogs(raw: string, replacements: Array<[string, string]>): string {
  let result = raw;
  for (const [value, replacement] of replacements) {
    if (value) {
      result = result.split(value).join(replacement);
    }
  }
  return result;
}

async function runScenario(params: {
  repoRoot: string;
  runtimeRoot: string;
  outputRoot: string;
  scenario: ScenarioName;
}): Promise<ScenarioResult> {
  const scenarioDir = path.join(params.outputRoot, params.scenario);
  const controlDir = path.join(scenarioDir, "control");
  const acpxStateDir = path.join(scenarioDir, "acpx-state");
  const rawGatewayLog = path.join(scenarioDir, "gateway.raw.log");
  await fs.mkdir(controlDir, { recursive: true });
  await fs.mkdir(acpxStateDir, { recursive: true });

  const adapterPath = path.join(params.repoRoot, "test/fixtures/acp-reset-timeout-adapter.ts");
  const tsxImport = path.join(params.repoRoot, "node_modules/tsx/dist/loader.mjs");
  const port = await getFreePortBlockWithPermissionFallback({
    offsets: [0, 1, 2, 4],
    fallbackBase: 43_000,
  });
  const gatewayToken = `acp-reset-proof-${randomUUID()}`;
  const state = await createOpenClawTestState({
    label: `acp-reset-${params.scenario}`,
    layout: "home",
    applyEnv: false,
  });
  await state.writeConfig({
    gateway: {
      port,
      bind: "loopback",
      auth: { mode: "token", token: gatewayToken },
      controlUi: { enabled: false },
    },
    logging: {
      level: "debug",
      consoleLevel: "warn",
      consoleStyle: "json",
      file: rawGatewayLog,
    },
    channels: {
      telegram: {
        enabled: true,
        botToken: PROOF_TELEGRAM_TOKEN,
        threadBindings: { enabled: true, spawnSessions: true },
      },
    },
    acp: {
      enabled: true,
      backend: "acpx",
      defaultAgent: PROOF_ACP_AGENT,
      allowedAgents: [PROOF_ACP_AGENT],
      dispatch: { enabled: true },
    },
    plugins: {
      enabled: true,
      allow: ["acpx", "telegram"],
      entries: {
        acpx: {
          enabled: true,
          config: {
            cwd: params.repoRoot,
            stateDir: acpxStateDir,
            permissionMode: "deny-all",
            nonInteractivePermissions: "deny",
            agents: {
              [PROOF_ACP_AGENT]: {
                command: process.execPath,
                args: ["--import", tsxImport, adapterPath, "--control-dir", controlDir],
              },
            },
          },
        },
        telegram: { enabled: true },
      },
    },
  });
  const gatewayEnv: NodeJS.ProcessEnv = {
    ...state.env,
    OPENCLAW_GATEWAY_TOKEN: "",
    OPENCLAW_GATEWAY_PASSWORD: "",
    OPENCLAW_SKIP_CHANNELS: "1",
    OPENCLAW_SKIP_PROVIDERS: "1",
    OPENCLAW_SKIP_GMAIL_WATCHER: "1",
    OPENCLAW_SKIP_CRON: "1",
    OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
    OPENCLAW_SKIP_CANVAS_HOST: "1",
    OPENCLAW_TEST_MINIMAL_GATEWAY: "0",
    OPENCLAW_ACPX_RUNTIME_STARTUP_PROBE: "0",
    OPENCLAW_SKIP_ACPX_RUNTIME_PROBE: "1",
    OPENCLAW_BUNDLED_PLUGINS_DIR: path.join(params.runtimeRoot, "dist", "extensions"),
  };
  const gatewayStdout: string[] = [];
  const gatewayStderr: string[] = [];
  let gatewayProcess: GatewayProcess | undefined;
  let client: GatewayClient | undefined;
  const gatewayEvents: EventFrame[] = [];
  try {
    gatewayProcess = spawn(
      process.execPath,
      [
        path.join(params.runtimeRoot, "dist", "index.js"),
        "gateway",
        "--port",
        String(port),
        "--bind",
        "loopback",
        "--allow-unconfigured",
      ],
      {
        cwd: params.runtimeRoot,
        env: gatewayEnv,
        stdio: ["ignore", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );
    gatewayProcess.stdout.setEncoding("utf8");
    gatewayProcess.stderr.setEncoding("utf8");
    gatewayProcess.stdout.on("data", (chunk) => gatewayStdout.push(String(chunk)));
    gatewayProcess.stderr.on("data", (chunk) => gatewayStderr.push(String(chunk)));
    await waitForGatewayPort({ child: gatewayProcess, port, timeoutMs: 60_000 });
    const gatewayPid = requireGatewayPid(gatewayProcess.pid);
    await logDriverEvent(scenarioDir, "gateway_started", {
      gatewayPid,
      port,
      entrypoint: [path.join(params.runtimeRoot, "dist", "index.js")],
    });
    client = await connectTestGatewayClient({
      url: `ws://127.0.0.1:${port}`,
      token: gatewayToken,
      clientDisplayName: null,
      timeoutMs: 60_000,
      requestTimeoutMs: RESET_REQUEST_TIMEOUT_MS,
      onEvent: (event) => gatewayEvents.push(event),
    });

    const acpSessionKey = await spawnAndBindAcpSession({
      client,
      controlDir,
      repoRoot: params.repoRoot,
      scenarioDir,
    });
    await logDriverEvent(scenarioDir, "runtime_state_after_spawn", {
      sessionKey: acpSessionKey,
      acpRow: readAcpMetadataRow(state.stateDir, acpSessionKey),
      agentRows: readAgentSessionRows(state.stateDir, acpSessionKey),
    });

    const baseline = await sendAndObserveTurn({
      client,
      controlDir,
      scenarioDir,
      stateDir: state.stateDir,
      acpSessionKey,
      text: `baseline-${params.scenario}`,
    });
    const oldIdentity = identityFromTurn(baseline.event);
    const rowAfterBaseline = readAcpMetadataRow(state.stateDir, acpSessionKey);
    assert(
      readAcpSessionIdFromRow(rowAfterBaseline) === oldIdentity.sessionId,
      `baseline metadata does not own the observed ACP session: ${JSON.stringify(rowAfterBaseline)}`,
    );
    await logDriverEvent(scenarioDir, "acp_session_after_baseline", {
      sessionKey: acpSessionKey,
      row: rowAfterBaseline,
      identity: oldIdentity,
    });

    if (params.scenario === "cancel-timeout") {
      await writeMarker(controlDir, "hang-cancel");
    } else if (params.scenario === "runtime-option-timeout") {
      await writeMarker(controlDir, "hang-close");
      await writeMarker(controlDir, "hang-set-mode");
    } else {
      await writeMarker(controlDir, "hang-close");
    }
    if (params.scenario === "late-turn") {
      await writeMarker(controlDir, "cancel-no-abort");
    }

    let heldTurnRunId: string | undefined;
    let runtimeOptionRunId: string | undefined;
    let eventCursor = baseline.index;
    if (params.scenario === "runtime-option-timeout") {
      runtimeOptionRunId = await sendChat(client, "/acp set-mode plan");
      const setModeStarted = await waitForEvent({
        controlDir,
        afterIndex: eventCursor,
        description: "old runtime-option operation start",
        predicate: (event) =>
          event.event === "set_mode_start" && event.sessionId === oldIdentity.sessionId,
      });
      eventCursor = setModeStarted.index;
      await logDriverEvent(scenarioDir, "held_runtime_option_started", {
        runId: runtimeOptionRunId,
        identity: oldIdentity,
      });
    } else if (params.scenario !== "close-timeout") {
      heldTurnRunId = await sendChat(client, "hold-turn");
      const heldTurn = await waitForEvent({
        controlDir,
        afterIndex: eventCursor,
        description: "held old turn start",
        predicate: (event) =>
          event.event === "turn_start" &&
          event.text === "hold-turn" &&
          event.sessionId === oldIdentity.sessionId,
      });
      eventCursor = heldTurn.index;
      await logDriverEvent(scenarioDir, "held_turn_started", {
        runId: heldTurnRunId,
        identity: identityFromTurn(heldTurn.event),
      });
    }

    const cleanupStartedMs = Date.now();
    const cleanupStartedAt = new Date(cleanupStartedMs).toISOString();
    const cleanupDeadlineAt = new Date(cleanupStartedMs + RESET_CLEANUP_DEADLINE_MS).toISOString();
    const resetCommand = resolveResetCommand(params.scenario);
    const resetResponse = await sendResetCommand({
      client,
      gatewayEvents,
      scenarioDir,
      acpSessionKey,
      command: resetCommand,
    });
    const resetCompletedMs = Date.now();
    const resetElapsedMs = resetCompletedMs - cleanupStartedMs;
    assert(
      resetElapsedMs >= RESET_CLEANUP_DEADLINE_MS - 100,
      `reset completed before the production cleanup deadline: ${resetElapsedMs}ms`,
    );
    const gatewayPidAfterReset = requireGatewayPid(gatewayProcess.pid);
    assert(gatewayPidAfterReset === gatewayPid, "Gateway PID changed during reset");
    await logDriverEvent(scenarioDir, "runtime_state_after_reset", {
      sessionKey: acpSessionKey,
      row: readAcpMetadataRow(state.stateDir, acpSessionKey),
      gatewayPid: gatewayPidAfterReset,
    });

    const fresh = await sendAndObserveTurn({
      client,
      controlDir,
      scenarioDir,
      stateDir: state.stateDir,
      acpSessionKey,
      text: `fresh-${params.scenario}`,
      afterIndex: eventCursor,
      directToAcpSession: true,
    });
    eventCursor = fresh.index;
    const freshIdentity = identityFromTurn(fresh.event);
    assert(
      freshIdentity.sessionId !== oldIdentity.sessionId,
      "reset reused the old ACP session ID",
    );
    const rowAfterFresh = readAcpMetadataRow(state.stateDir, acpSessionKey);
    assert(
      readAcpSessionIdFromRow(rowAfterFresh) === freshIdentity.sessionId,
      `fresh metadata does not own the new ACP session: ${JSON.stringify(rowAfterFresh)}`,
    );
    await logDriverEvent(scenarioDir, "runtime_state_after_fresh_turn", {
      sessionKey: acpSessionKey,
      row: rowAfterFresh,
      identity: freshIdentity,
    });

    let lateCompletion: { event: AdapterEvent; index: number };
    let lateRuntimeOptionCompletedAt: string | undefined;
    if (params.scenario === "close-timeout") {
      await writeMarker(controlDir, "release-close");
      lateCompletion = await waitForEvent({
        controlDir,
        afterIndex: eventCursor,
        description: "late close completion",
        predicate: (event) =>
          event.event === "close_end" && event.sessionId === oldIdentity.sessionId,
      });
    } else if (params.scenario === "cancel-timeout") {
      await writeMarker(controlDir, "release-cancel");
      lateCompletion = await waitForEvent({
        controlDir,
        afterIndex: eventCursor,
        description: "late cancel completion",
        predicate: (event) =>
          event.event === "cancel_end" && event.sessionId === oldIdentity.sessionId,
      });
      await waitForEvent({
        controlDir,
        afterIndex: eventCursor,
        description: "cancelled old turn completion",
        predicate: (event) =>
          event.event === "turn_end" &&
          event.sessionId === oldIdentity.sessionId &&
          event.stopReason === "cancelled",
      });
    } else if (params.scenario === "runtime-option-timeout") {
      await writeMarker(controlDir, "release-set-mode");
      await writeMarker(controlDir, "release-close");
      const lateRuntimeOption = await waitForEvent({
        controlDir,
        afterIndex: eventCursor,
        description: "late runtime-option completion",
        predicate: (event) =>
          event.event === "set_mode_end" && event.sessionId === oldIdentity.sessionId,
      });
      assert(
        lateRuntimeOption.index > fresh.index,
        "runtime-option completion was not observed after the fresh turn",
      );
      lateRuntimeOptionCompletedAt = lateRuntimeOption.event.at;
      lateCompletion = await waitForEvent({
        controlDir,
        afterIndex: eventCursor,
        description: "late close completion after runtime-option operation",
        predicate: (event) =>
          event.event === "close_end" && event.sessionId === oldIdentity.sessionId,
      });
      if (runtimeOptionRunId) {
        await client
          .request(
            "agent.wait",
            { runId: runtimeOptionRunId, timeoutMs: 5_000 },
            { timeoutMs: 10_000 },
          )
          .catch(() => undefined);
      }
      await logDriverEvent(scenarioDir, "late_runtime_option_completed", {
        runId: runtimeOptionRunId,
        identity: oldIdentity,
        completionAt: lateRuntimeOption.event.at,
      });
    } else {
      await writeMarker(controlDir, "release-turn");
      lateCompletion = await waitForEvent({
        controlDir,
        afterIndex: eventCursor,
        description: "late old turn completion",
        predicate: (event) =>
          event.event === "turn_end" &&
          event.sessionId === oldIdentity.sessionId &&
          event.text === "hold-turn" &&
          event.stopReason === "end_turn",
      });
      await writeMarker(controlDir, "release-close");
      await waitForEvent({
        controlDir,
        afterIndex: lateCompletion.index,
        description: "old close completion after late turn",
        predicate: (event) =>
          event.event === "close_end" && event.sessionId === oldIdentity.sessionId,
      });
    }
    eventCursor = lateCompletion.index;

    if (heldTurnRunId) {
      await client
        .request("agent.wait", { runId: heldTurnRunId, timeoutMs: 5_000 }, { timeoutMs: 10_000 })
        .catch(() => undefined);
    }

    await sleep(500);
    const gatewayPidAfterLateCompletion = requireGatewayPid(gatewayProcess.pid);
    assert(
      gatewayPidAfterLateCompletion === gatewayPid,
      "Gateway PID changed after late operation completion",
    );
    const rowAfterLateCompletion = readAcpMetadataRow(state.stateDir, acpSessionKey);
    assert(
      readAcpSessionIdFromRow(rowAfterLateCompletion) === freshIdentity.sessionId,
      `late completion replaced fresh ACP metadata: ${JSON.stringify(rowAfterLateCompletion)}`,
    );

    const followup = await sendAndObserveTurn({
      client,
      controlDir,
      scenarioDir,
      stateDir: state.stateDir,
      acpSessionKey,
      text: `followup-${params.scenario}`,
      afterIndex: eventCursor,
      directToAcpSession: true,
    });
    const followupIdentity = identityFromTurn(followup.event);
    assert(
      sameAcpSession(freshIdentity, followupIdentity),
      `late completion replaced the fresh ACP session: fresh=${JSON.stringify(freshIdentity)} followup=${JSON.stringify(followupIdentity)}`,
    );
    const rowAfterFollowup = readAcpMetadataRow(state.stateDir, acpSessionKey);
    assert(
      readAcpSessionIdFromRow(rowAfterFollowup) === freshIdentity.sessionId,
      `follow-up metadata no longer owns the fresh ACP session: ${JSON.stringify(rowAfterFollowup)}`,
    );
    await logDriverEvent(scenarioDir, "runtime_state_after_late_completion", {
      sessionKey: acpSessionKey,
      rowAfterLateCompletion,
      rowAfterFollowup,
      followupIdentity,
      gatewayPid: gatewayPidAfterLateCompletion,
    });

    const events = await readEvents(controlDir);
    const keyEvents = events.filter((event) =>
      [
        "process_start",
        "session_create",
        "session_load",
        "turn_start",
        "turn_end",
        "set_mode_start",
        "set_mode_end",
        "cancel_start",
        "cancel_end",
        "close_start",
        "close_end",
        "process_exit",
      ].includes(event.event),
    );
    const result: ScenarioResult = {
      scenario: params.scenario,
      resetCommand,
      gatewayPid,
      gatewayPidAfterReset,
      gatewayPidAfterLateCompletion,
      oldIdentity,
      freshIdentity,
      followupIdentity,
      cleanupStartedAt,
      cleanupDeadlineAt,
      resetCompletedAt: new Date(resetCompletedMs).toISOString(),
      resetElapsedMs,
      resetResponse,
      lateCompletionAt: lateCompletion.event.at,
      ...(lateRuntimeOptionCompletedAt ? { lateRuntimeOptionCompletedAt } : {}),
      gatewayStayedAlive: true,
      assertions: [
        `reset exceeded the ${RESET_CLEANUP_DEADLINE_MS}ms production cleanup deadline`,
        `bound ${resetCommand} completed the ACP reset path`,
        "Gateway child PID remained unchanged",
        "the first post-reset turn used a fresh ACP session ID",
        "the late old operation completed after the fresh turn",
        "persistent ACP metadata remained owned by the fresh session",
        "the follow-up turn remained on the fresh ACP session",
        ...(params.scenario === "runtime-option-timeout"
          ? [
              "the old runtime-option operation started before reset and completed after the fresh turn",
              "the superseded runtime-option operation did not replace fresh metadata or ownership",
            ]
          : []),
      ],
      keyEvents,
    };

    await fs.writeFile(
      path.join(scenarioDir, "result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(
      path.join(scenarioDir, "acpx-state-snapshot.json"),
      `${JSON.stringify(await snapshotDirectory(acpxStateDir), null, 2)}\n`,
      "utf8",
    );
    return result;
  } finally {
    await releaseAllMarkers(controlDir).catch(() => {});
    await client?.stopAndWait({ timeoutMs: 2_000 }).catch(() => {});
    const replacements: Array<[string, string]> = [
      [gatewayToken, "<gateway-token>"],
      [PROOF_TELEGRAM_TOKEN, "<proof-telegram-token>"],
      [params.repoRoot, "<repo-root>"],
      [params.runtimeRoot, "<built-runtime>"],
      [state.home, "<isolated-home>"],
      [state.stateDir, "<isolated-state>"],
      [params.outputRoot, "<proof-output>"],
    ];
    await stopGatewayProcess(gatewayProcess).catch(() => {});
    const rawLogs = await fs.readFile(rawGatewayLog, "utf8").catch(() => "");
    await fs.writeFile(
      path.join(scenarioDir, "gateway.log"),
      redactGatewayLogs(rawLogs, replacements),
      "utf8",
    );
    await fs.writeFile(
      path.join(scenarioDir, "gateway-process.log"),
      redactGatewayLogs(
        `--- stdout ---\n${gatewayStdout.join("")}\n--- stderr ---\n${gatewayStderr.join("")}\n`,
        replacements,
      ),
      "utf8",
    );
    await fs.rm(rawGatewayLog, { force: true });
    await state.cleanup();
  }
}

async function createBuiltGatewayRuntime(repoRoot: string): Promise<string> {
  const runtimeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-acp-reset-proof-runtime-"));
  await fs.copyFile(path.join(repoRoot, "package.json"), path.join(runtimeRoot, "package.json"));
  await fs.cp(path.join(repoRoot, "dist"), path.join(runtimeRoot, "dist"), { recursive: true });
  await fs.mkdir(path.join(runtimeRoot, "src", "agents"), { recursive: true });
  await fs.cp(
    path.join(repoRoot, "src", "agents", "templates"),
    path.join(runtimeRoot, "src", "agents", "templates"),
    { recursive: true },
  );
  await fs.mkdir(path.join(runtimeRoot, "docs", "reference"), { recursive: true });
  await fs.cp(
    path.join(repoRoot, "docs", "reference", "templates"),
    path.join(runtimeRoot, "docs", "reference", "templates"),
    { recursive: true },
  );
  await fs.symlink(
    path.join(repoRoot, "node_modules"),
    path.join(runtimeRoot, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  return runtimeRoot;
}

function resolveOutputRoot(repoRoot: string): string {
  const outputIndex = process.argv.indexOf("--output-dir");
  const configured = outputIndex >= 0 ? process.argv[outputIndex + 1]?.trim() : "";
  if (configured) {
    return path.resolve(configured);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(repoRoot, "tmp", `acp-reset-timeout-proof-${stamp}`);
}

export function resolveResetCommand(scenario: ScenarioName): ResetCommand {
  return scenario === "late-turn" ? "/new" : "/reset";
}

function resolveScenarios(): ScenarioName[] {
  const scenarioIndex = process.argv.indexOf("--scenario");
  const configured = scenarioIndex >= 0 ? process.argv[scenarioIndex + 1]?.trim() : "";
  if (!configured) {
    return ["close-timeout", "cancel-timeout", "late-turn", "runtime-option-timeout"];
  }
  if (
    configured === "close-timeout" ||
    configured === "cancel-timeout" ||
    configured === "late-turn" ||
    configured === "runtime-option-timeout"
  ) {
    return [configured];
  }
  throw new Error(`unknown proof scenario: ${configured}`);
}

async function main(): Promise<void> {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const outputRoot = resolveOutputRoot(repoRoot);
  await fs.mkdir(outputRoot, { recursive: true });
  const revision = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  const startedAt = new Date().toISOString();
  const results: ScenarioResult[] = [];
  const runtimeRoot = await createBuiltGatewayRuntime(repoRoot);
  try {
    for (const scenario of resolveScenarios()) {
      process.stdout.write(`[proof] starting ${scenario}\n`);
      const result = await runScenario({ repoRoot, runtimeRoot, outputRoot, scenario });
      results.push(result);
      process.stdout.write(
        `[proof] ${scenario} passed reset=${result.resetElapsedMs}ms old=${result.oldIdentity.sessionId} fresh=${result.freshIdentity.sessionId}\n`,
      );
    }
  } finally {
    await fs.rm(runtimeRoot, { recursive: true, force: true });
  }
  const summary = {
    claim:
      "After ACP reset cleanup exceeds its production deadline, OpenClaw discards old runtime ownership, creates a fresh ACP session without restarting Gateway, and rejects late old cancel/close/turn/runtime-option completion from replacing the fresh runtime.",
    revision,
    startedAt,
    completedAt: new Date().toISOString(),
    environment: {
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      node: process.version,
      sqlite: process.versions.sqlite,
      acpAdapter: "test/fixtures/acp-reset-timeout-adapter.ts",
      gateway: "isolated child process spawned from a temporary copy of the built dist runtime",
      acpRegistration: "bundled acpx plugin service with a configured proof agent command",
      binding:
        "dynamic /acp spawn main --bind here binding for a synthetic Telegram DM with channel network startup disabled",
      isolatedState: true,
      productionCleanupDeadlineMs: RESET_CLEANUP_DEADLINE_MS,
    },
    commands: [
      "node --import tsx scripts/acp-reset-timeout-proof.ts --output-dir <proof-output>",
      "Gateway: node <built-runtime>/dist/index.js gateway --port <ephemeral> --bind loopback --allow-unconfigured",
      "Adapter: node --import tsx test/fixtures/acp-reset-timeout-adapter.ts --control-dir <proof-output>/<scenario>/control",
    ],
    results,
    limitations: [
      "The backend is a deterministic ACP protocol adapter, not a commercial third-party model backend.",
      "Reset removes the dynamic conversation binding, so post-reset proof turns target the same ACP session key directly through Gateway chat.send.",
      "The bound /new command path is exercised by the late-turn scenario; the bound /reset path is exercised by the close, cancel, and runtime-option timeout scenarios.",
      "The proof covers one old runtime and one fresh runtime per timeout mode; it does not exhaustively fuzz arbitrary reset concurrency.",
      "Process and ACP session identity are observed at the adapter boundary; actor epochs remain an internal implementation detail covered by focused tests and the reset-overlap runtime-option scenario.",
    ],
  };
  await fs.writeFile(
    path.join(outputRoot, "summary.json"),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  process.stdout.write(`[proof] all scenarios passed; artifacts=${outputRoot}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error: unknown) => {
    process.stderr.write(
      `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
