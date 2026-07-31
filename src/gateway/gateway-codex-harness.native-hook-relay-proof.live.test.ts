// Live proof lane for `resolveCodexAppServerNativeHookRelay`: drives a real
// Codex app-server through the in-process gateway and captures the exact
// `thread/start` (attempt) and `thread/fork` (side question) config the
// app-server receives for one configuration mode per run.
//
// The `approval-*` modes additionally capture a real
// `item/commandExecution/requestApproval` round-trip, proving an active approval
// policy still enforces while `nativeHookRelay.enabled: false` is configured.
//
// Opt-in:
//   OPENCLAW_LIVE_TEST=1 OPENCLAW_LIVE_CODEX_RELAY_PROOF=1 \
//   RELAY_PROOF_MODE=<baseline|disabled-never|disabled-active
//                     |approval-baseline|approval-disabled> \
//   RELAY_PROOF_DIR=<abs dir> RELAY_PROOF_CODEX_COMMAND=<abs tee shim> \
//   [RELAY_PROOF_APPROVAL_COMMAND=<shell command template with {token}>] \
//   pnpm exec vitest run --config test/vitest/vitest.live.config.ts \
//     src/gateway/gateway-codex-harness.native-hook-relay-proof.live.test.ts
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { setTestEnvValue } from "../test-utils/env.js";
import type { GatewayClient } from "./client.js";
import {
  connectTestGatewayClient,
  ensurePairedTestGatewayClientIdentity,
} from "./gateway-cli-backend.live-helpers.js";
import { restoreLiveEnv, snapshotLiveEnv, type LiveEnvSnapshot } from "./live-env-test-helpers.js";

const LIVE = isLiveTestEnabled();
const RELAY_PROOF = isTruthyEnvValue(process.env.OPENCLAW_LIVE_CODEX_RELAY_PROOF);
const describeLive = LIVE && RELAY_PROOF ? describe : describe.skip;

const MODEL_KEY = process.env.RELAY_PROOF_MODEL ?? "openai/gpt-5.5";
const THINKING = "low" as const;
const REQUEST_TIMEOUT_MS = 180_000;
const AGENT_TIMEOUT_SECONDS = Math.max(1, Math.ceil(REQUEST_TIMEOUT_MS / 1000) - 10);
const GATEWAY_CONNECT_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 540_000;

type RelayProofMode =
  | "baseline"
  | "disabled-never"
  | "disabled-active"
  | "approval-baseline"
  | "approval-disabled";

const RELAY_PROOF_MODES: readonly RelayProofMode[] = [
  "baseline",
  "disabled-never",
  "disabled-active",
  "approval-baseline",
  "approval-disabled",
];

/** Modes that prove the approval round-trip instead of the echo + `/btw` pair. */
const RELAY_PROOF_APPROVAL_MODES = new Set<RelayProofMode>([
  "approval-baseline",
  "approval-disabled",
]);

const CODEX_APPROVAL_REQUEST_METHOD = "item/commandExecution/requestApproval";
// A bare `echo` can be auto-trusted by Codex's safe-command classifier, which
// would never raise an approval. A shell wrapper is opaque to that classifier.
// Override without editing this spec when a live run shows no approval request.
const DEFAULT_RELAY_PROOF_APPROVAL_COMMAND = "sh -c 'echo {token}'";
const APPROVAL_CAPTURE_TIMEOUT_MS = 60_000;
const APPROVAL_CAPTURE_POLL_MS = 250;
// The tee appends synchronously, so the frame is normally already on disk.
const CAPTURE_FRAME_TIMEOUT_MS = 15_000;

function resolveRelayProofMode(): RelayProofMode {
  const raw = process.env.RELAY_PROOF_MODE?.trim();
  if (!raw || !RELAY_PROOF_MODES.includes(raw as RelayProofMode)) {
    throw new Error(`RELAY_PROOF_MODE must be one of ${RELAY_PROOF_MODES.join(", ")}; got ${raw}`);
  }
  return raw as RelayProofMode;
}

function isRelayProofApprovalMode(mode: RelayProofMode): boolean {
  return RELAY_PROOF_APPROVAL_MODES.has(mode);
}

function resolveApprovalCommand(echoToken: string): string {
  const template =
    process.env.RELAY_PROOF_APPROVAL_COMMAND?.trim() || DEFAULT_RELAY_PROOF_APPROVAL_COMMAND;
  return template.replaceAll("{token}", echoToken);
}

/**
 * The five configurations under proof. `mode` fixes the effective approval policy
 * so approvals are genuinely active on the wire, independent of the configured
 * value the parse-layer guard reads: `guardian` resolves to a prompting policy,
 * while the documented full kill-switch case pins `approvalPolicy: "never"`
 * explicitly — the only spelling that unlocks it. The `approval-*` pair pins
 * `untrusted` so a non-trusted command deterministically raises
 * `item/commandExecution/requestApproval` rather than relying on the model to
 * escalate on its own.
 */
const RELAY_PROOF_APP_SERVER_CONFIGS = {
  baseline: { mode: "guardian" },
  "disabled-never": { mode: "yolo", approvalPolicy: "never", nativeHookRelay: { enabled: false } },
  "disabled-active": { mode: "guardian", nativeHookRelay: { enabled: false } },
  "approval-baseline": { mode: "guardian", approvalPolicy: "untrusted" },
  "approval-disabled": {
    mode: "guardian",
    approvalPolicy: "untrusted",
    nativeHookRelay: { enabled: false },
  },
} as const satisfies Record<RelayProofMode, Record<string, unknown>>;

function buildModeAppServerConfig(mode: RelayProofMode): Record<string, unknown> {
  return RELAY_PROOF_APP_SERVER_CONFIGS[mode];
}

async function getFreeGatewayPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (port <= 0) {
    throw new Error("failed to allocate gateway port");
  }
  return port;
}

async function createLiveWorkspace(tempDir: string): Promise<string> {
  const workspace = path.join(tempDir, "workspace");
  await fs.mkdir(workspace, { recursive: true });
  await fs.writeFile(
    path.join(workspace, "AGENTS.md"),
    [
      "# AGENTS.md",
      "",
      "Follow exact reply instructions from the user.",
      "Do not add commentary when asked for an exact response.",
    ].join("\n"),
  );
  return workspace;
}

async function removeLiveTempDir(dir: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
      await delay(100);
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
}

async function writeProofGatewayConfig(params: {
  codexCommand: string;
  configPath: string;
  mode: RelayProofMode;
  port: number;
  token: string;
  workspace: string;
}): Promise<Record<string, unknown>> {
  const appServer = {
    command: params.codexCommand,
    ...buildModeAppServerConfig(params.mode),
  };
  const cfg: OpenClawConfig = {
    gateway: {
      mode: "local",
      port: params.port,
      auth: { mode: "token", token: params.token },
    },
    plugins: {
      allow: ["codex"],
      entries: {
        codex: {
          enabled: true,
          config: { appServer },
        },
      },
    },
    agents: {
      defaults: {
        workspace: params.workspace,
        skipBootstrap: true,
        timeoutSeconds: AGENT_TIMEOUT_SECONDS,
        maxConcurrent: 4,
        thinkingDefault: THINKING,
        model: { primary: MODEL_KEY },
        models: { [MODEL_KEY]: { agentRuntime: { id: "codex" } } },
        sandbox: { mode: "off" },
      },
      entries: {
        dev: {
          default: true,
          workspace: params.workspace,
          thinkingDefault: THINKING,
          model: { primary: MODEL_KEY },
          models: { [MODEL_KEY]: { agentRuntime: { id: "codex" } } },
        },
      },
    },
  } as OpenClawConfig;
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
  return appServer;
}

type CapturedAgentEvent = {
  stream: string;
  data?: Record<string, unknown>;
  sessionKey?: string;
};

async function requestAgentTextWithEvents(params: {
  client: GatewayClient;
  message: string;
  sessionKey: string;
}): Promise<{ text: string; events: CapturedAgentEvent[] }> {
  const { extractPayloadText } = await import("./test-helpers.agent-results.js");
  const { onAgentEvent } = await import("../infra/agent-events.js");
  const events: CapturedAgentEvent[] = [];
  const unsubscribe = onAgentEvent((event) => {
    if (!event.stream.startsWith("codex_app_server.")) {
      return;
    }
    events.push({ stream: event.stream, sessionKey: event.sessionKey, data: event.data });
  });
  try {
    const payload = await params.client.request(
      "agent",
      {
        sessionKey: params.sessionKey,
        idempotencyKey: `idem-${randomUUID()}-relay-proof`,
        message: params.message,
        deliver: false,
        thinking: THINKING,
        timeout: AGENT_TIMEOUT_SECONDS,
      },
      { expectFinal: true, timeoutMs: REQUEST_TIMEOUT_MS },
    );
    if (payload?.status !== "ok") {
      throw new Error(`agent status=${String(payload?.status)} payload=${JSON.stringify(payload)}`);
    }
    return { text: extractPayloadText(payload.result), events };
  } finally {
    unsubscribe();
  }
}

function extractChatFinalText(event: EventFrame, runId: string): string | undefined {
  if (event.event !== "chat") {
    return undefined;
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.runId !== runId || record.state !== "final") {
    return undefined;
  }
  const message = record.message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const messageRecord = message as Record<string, unknown>;
  if (typeof messageRecord.text === "string" && messageRecord.text.trim()) {
    return messageRecord.text;
  }
  const content = Array.isArray(messageRecord.content) ? messageRecord.content : [];
  return content
    .map((entry) =>
      entry && typeof entry === "object" ? (entry as Record<string, unknown>).text : undefined,
    )
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0)
    .join("\n")
    .trim();
}

async function waitForChatFinalText(params: {
  events: EventFrame[];
  runId: string;
  timeoutMs: number;
}): Promise<string> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    const text = params.events
      .map((event) => extractChatFinalText(event, params.runId))
      .find(Boolean);
    if (text) {
      return text;
    }
    await delay(50);
  }
  throw new Error(`timed out waiting for chat final for ${params.runId}`);
}

async function requestChatCommandText(params: {
  client: GatewayClient;
  command: string;
  events: EventFrame[];
  sessionKey: string;
}): Promise<string> {
  const runId = `idem-${randomUUID()}-relay-proof-cmd`;
  const started = await params.client.request(
    "chat.send",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: runId,
      message: params.command,
    },
    { timeoutMs: REQUEST_TIMEOUT_MS },
  );
  if (started?.status !== "started") {
    throw new Error(`command ${params.command} did not start: ${JSON.stringify(started)}`);
  }
  return await waitForChatFinalText({
    events: params.events,
    runId,
    timeoutMs: REQUEST_TIMEOUT_MS,
  });
}

/**
 * Reads a `chat.side_result` frame for this run. `/btw` answers land here as
 * `kind: "btw"`, and a failed side question sets `isError` with the reason in
 * `text` — knowing that instantly is what keeps a broken run from burning the
 * whole timeout.
 */
function readSideResult(
  event: EventFrame,
  runId: string,
): { isError: boolean; text: string } | undefined {
  if (event.event !== "chat.side_result") {
    return undefined;
  }
  const payload = event.payload;
  if (!payload || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as Record<string, unknown>;
  if (record.kind !== "btw" || record.runId !== runId) {
    return undefined;
  }
  return {
    isError: record.isError === true,
    text: typeof record.text === "string" ? record.text : "",
  };
}

/**
 * Side-question replies do not always surface as a `chat` final frame for the
 * originating runId, so accept the `chat.side_result` frame, any gateway frame
 * carrying the echo token, or the app-server's own `item/completed`
 * agentMessage from the stdio capture. An errored `chat.side_result` fails the
 * run immediately with the gateway's own reason.
 */
async function waitForSideQuestionEcho(params: {
  client: GatewayClient;
  command: string;
  events: EventFrame[];
  proofDir: string;
  sessionKey: string;
  token: string;
  timeoutMs: number;
}): Promise<{ source: string; text: string }> {
  const runId = `idem-${randomUUID()}-relay-proof-side`;
  const started = await params.client.request(
    "chat.send",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: runId,
      message: params.command,
    },
    { timeoutMs: params.timeoutMs },
  );
  if (started?.status !== "started") {
    throw new Error(`side question did not start: ${JSON.stringify(started)}`);
  }
  const capturePath = path.join(params.proofDir, "rpc-out.jsonl");
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    // Fail fast: the gateway already knows the side question is dead, so do not
    // sit out the remaining timeout waiting for an echo that cannot arrive.
    const sideResult = params.events
      .map((event) => readSideResult(event, runId))
      .find((result) => result !== undefined);
    if (sideResult?.isError) {
      await fs.writeFile(
        path.join(params.proofDir, "side-question-error.json"),
        `${JSON.stringify({ runId, token: params.token, text: sideResult.text }, null, 2)}\n`,
      );
      throw new Error(`side question failed: ${sideResult.text.trim() || "(no reason reported)"}`);
    }
    if (sideResult && sideResult.text.includes(params.token)) {
      return { source: "gateway-side-result", text: sideResult.text };
    }
    const final = params.events
      .map((event) => extractChatFinalText(event, runId))
      .find((text) => typeof text === "string" && text.includes(params.token));
    if (final) {
      return { source: "gateway-chat-final", text: final };
    }
    const frame = params.events.find((event) => {
      const serialized = JSON.stringify(event);
      return serialized.includes(params.token) && !serialized.includes("/btw");
    });
    if (frame) {
      return { source: "gateway-event", text: JSON.stringify(frame) };
    }
    const captured = await readCapturedAgentMessage(capturePath, params.token);
    if (captured) {
      return { source: "app-server-capture", text: captured };
    }
    await delay(250);
  }
  await fs.writeFile(
    path.join(params.proofDir, "side-question-events-debug.json"),
    `${JSON.stringify(params.events.slice(-60), null, 2)}\n`,
  );
  throw new Error(`timed out waiting for side-question echo ${params.token}`);
}

/**
 * Drives one approval round-trip: a single agent turn running a command Codex
 * cannot classify as trusted, then the `item/commandExecution/requestApproval`
 * request the app-server raised and the decision the gateway answered with.
 * A denial is still proof of enforcement, so only the round-trip is asserted.
 */
async function runApprovalProofTurn(params: {
  client: GatewayClient;
  mode: RelayProofMode;
  proofDir: string;
  receipt: Record<string, unknown>;
  sessionKey: string;
  upperMode: string;
}): Promise<void> {
  const nonce = randomBytes(3).toString("hex").toUpperCase();
  const echoToken = `APPROVAL-${params.upperMode}-${nonce}`;
  const command = resolveApprovalCommand(echoToken);
  const approval: Record<string, unknown> = {
    method: CODEX_APPROVAL_REQUEST_METHOD,
    command,
    echoToken,
  };
  // Attach by reference before anything can throw: later mutations land in the
  // receipt even when the round-trip assertions below fail.
  params.receipt.approval = approval;
  try {
    const turn = await requestAgentTextWithEvents({
      client: params.client,
      sessionKey: params.sessionKey,
      message: `Use your shell tool to run this exact command: ${command}\nThen reply with exactly the command's stdout and nothing else.`,
    });
    approval.text = turn.text.trim().slice(0, 400);
    approval.echoTokenSeen = turn.text.includes(echoToken);
    Object.assign(approval, readLifecycleIdentity(turn.events));
  } catch (error) {
    // A denied or unanswered approval can fail the turn itself; the captured
    // round-trip below is the actual proof, so keep it rather than bailing out.
    approval.turnError = error instanceof Error ? error.message : String(error);
  }
  const roundTrip = await readCapturedApprovalRoundTrip({
    proofDir: params.proofDir,
    timeoutMs: APPROVAL_CAPTURE_TIMEOUT_MS,
  });
  await assertCapturedCodexHookOverlay({
    proofDir: params.proofDir,
    method: "thread/start",
    label: `${params.mode} attempt`,
    expected: RELAY_PROOF_EXPECTED_OVERLAYS[params.mode].attempt,
    timeoutMs: CAPTURE_FRAME_TIMEOUT_MS,
  });
  approval.requestId = roundTrip.request?.id ?? null;
  approval.requestParams = roundTrip.request?.params ?? null;
  approval.response = roundTrip.response ?? null;
  approval.decision = roundTrip.response ? readApprovalDecision(roundTrip.response) : undefined;
  expect(
    roundTrip.request,
    `no ${CODEX_APPROVAL_REQUEST_METHOD} request captured for command: ${command}`,
  ).toBeTruthy();
  expect(
    roundTrip.response,
    `no gateway response captured for ${CODEX_APPROVAL_REQUEST_METHOD} id ${String(roundTrip.request?.id)}`,
  ).toBeTruthy();
}

/**
 * Pairs the app-server's approval request (`rpc-out.jsonl`) with the gateway's
 * response by JSON-RPC id (`rpc-in.jsonl`). Polls because the tee appends after
 * the turn already settled. Returns whatever it has at the deadline so a partial
 * round-trip is still recorded in the receipt.
 */
async function readCapturedApprovalRoundTrip(params: {
  proofDir: string;
  timeoutMs: number;
}): Promise<{ request?: Record<string, unknown>; response?: Record<string, unknown> }> {
  const requestPath = path.join(params.proofDir, "rpc-out.jsonl");
  const responsePath = path.join(params.proofDir, "rpc-in.jsonl");
  const deadline = Date.now() + params.timeoutMs;
  let request: Record<string, unknown> | undefined;
  for (;;) {
    request ??= (await readCapturedJsonRpcRecords(requestPath)).find(
      (record) => record.method === CODEX_APPROVAL_REQUEST_METHOD,
    );
    const requestId = request?.id;
    if (requestId !== undefined) {
      const response = (await readCapturedJsonRpcRecords(responsePath)).find(
        (record) => record.method === undefined && record.id === requestId,
      );
      if (response) {
        return { request, response };
      }
    }
    if (Date.now() >= deadline) {
      return request ? { request } : {};
    }
    await delay(APPROVAL_CAPTURE_POLL_MS);
  }
}

/**
 * The overlay each mode must produce on the wire. Kept in lockstep with
 * `expectAttempt` in `proof/extract-evidence.mjs` (the evidence pack's verdict
 * table) — that file lives outside the repo, so the table is duplicated here on
 * purpose; change both together.
 *
 * Two asymmetries are baked in:
 *  - `thread/start` is built with `clearOmittedEvents` off, so an event the
 *    resolver did not select emits **no key at all** ("absent"). `thread/fork`
 *    is built with it on, so every key is present and omitted ones are `[]`.
 *  - "selected" is not "installed": `shouldRelayEvent` writes `[]` for a
 *    selected event with no OpenClaw-side work. The proof gateway registers no
 *    before-tool policy and no after_tool_call/before_agent_finalize hooks, so
 *    `post_tool_use`/`before_agent_finalize` are selected-but-empty and
 *    `pre_tool_use` installs via the loop detector.
 */
type CodexHookOverlayState = "installed" | "empty" | "absent";
type CodexHookOverlay = {
  featuresHooks: boolean;
  hooks: Record<(typeof RELAY_PROOF_HOOK_KEYS)[number], CodexHookOverlayState>;
};

const RELAY_PROOF_HOOK_KEYS = [
  "hooks.PreToolUse",
  "hooks.PostToolUse",
  "hooks.PermissionRequest",
  "hooks.Stop",
] as const;

const RELAY_PROOF_EXPECTED_OVERLAYS: Record<
  RelayProofMode,
  { attempt: CodexHookOverlay; fork?: CodexHookOverlay }
> = {
  baseline: {
    attempt: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "absent",
        "hooks.Stop": "empty",
      },
    },
    fork: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "empty",
        "hooks.Stop": "empty",
      },
    },
  },
  "disabled-never": {
    attempt: {
      featuresHooks: false,
      hooks: {
        "hooks.PreToolUse": "empty",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "empty",
        "hooks.Stop": "empty",
      },
    },
    fork: {
      featuresHooks: false,
      hooks: {
        "hooks.PreToolUse": "empty",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "empty",
        "hooks.Stop": "empty",
      },
    },
  },
  "disabled-active": {
    attempt: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "absent",
        "hooks.PermissionRequest": "absent",
        "hooks.Stop": "absent",
      },
    },
    fork: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "empty",
        "hooks.Stop": "empty",
      },
    },
  },
  // Approval modes run no `/btw`, so they have no `thread/fork` frame.
  "approval-baseline": {
    attempt: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "empty",
        "hooks.PermissionRequest": "absent",
        "hooks.Stop": "empty",
      },
    },
  },
  "approval-disabled": {
    attempt: {
      featuresHooks: true,
      hooks: {
        "hooks.PreToolUse": "installed",
        "hooks.PostToolUse": "absent",
        "hooks.PermissionRequest": "absent",
        "hooks.Stop": "absent",
      },
    },
  },
};

function classifyCodexHookOverlayEntry(
  config: Record<string, unknown>,
  key: string,
): { state: CodexHookOverlayState | "other"; raw: unknown } {
  if (!(key in config)) {
    return { state: "absent", raw: undefined };
  }
  const raw = config[key];
  if (!Array.isArray(raw)) {
    return { state: "other", raw };
  }
  return { state: raw.length === 0 ? "empty" : "installed", raw };
}

/**
 * Reads the `params.config` the app-server actually received for `method` and
 * asserts the whole overlay. Polls because the tee appends after the turn has
 * already settled; a missing frame fails loudly rather than passing vacuously.
 */
async function assertCapturedCodexHookOverlay(params: {
  proofDir: string;
  method: "thread/start" | "thread/fork";
  label: string;
  expected: CodexHookOverlay;
  timeoutMs: number;
}): Promise<void> {
  const capturePath = path.join(params.proofDir, "rpc-in.jsonl");
  const deadline = Date.now() + params.timeoutMs;
  let frame: Record<string, unknown> | undefined;
  for (;;) {
    frame = (await readCapturedJsonRpcRecords(capturePath)).find(
      (record) => record.method === params.method,
    );
    if (frame || Date.now() >= deadline) {
      break;
    }
    await delay(APPROVAL_CAPTURE_POLL_MS);
  }
  expect(
    frame,
    `${params.label}: no ${params.method} frame captured in ${capturePath}`,
  ).toBeTruthy();
  const rawConfig = (frame?.params as { config?: unknown } | undefined)?.config;
  expect(
    rawConfig && typeof rawConfig === "object",
    `${params.label}: ${params.method} carried no params.config`,
  ).toBe(true);
  const config = rawConfig as Record<string, unknown>;
  expect(
    config["features.hooks"],
    `${params.label}: features.hooks on ${params.method} (captured ${JSON.stringify(
      config["features.hooks"],
    )})`,
  ).toBe(params.expected.featuresHooks);
  for (const key of RELAY_PROOF_HOOK_KEYS) {
    const { state, raw } = classifyCodexHookOverlayEntry(config, key);
    expect(
      state,
      `${params.label}: ${key} on ${params.method} (captured ${JSON.stringify(raw)})`,
    ).toBe(params.expected.hooks[key]);
  }
}

async function readCapturedJsonRpcRecords(capturePath: string): Promise<Record<string, unknown>[]> {
  let text: string;
  try {
    text = await fs.readFile(capturePath, "utf8");
  } catch {
    return [];
  }
  const records: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        records.push(parsed as Record<string, unknown>);
      }
    } catch {
      /* partial line */
    }
  }
  return records;
}

function readApprovalDecision(response: Record<string, unknown>): string | undefined {
  const result = response.result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const decision = (result as Record<string, unknown>).decision;
    if (typeof decision === "string") {
      return decision;
    }
  }
  return response.error ? "error" : undefined;
}

async function readCapturedAgentMessage(
  capturePath: string,
  token: string,
): Promise<string | undefined> {
  let text: string;
  try {
    text = await fs.readFile(capturePath, "utf8");
  } catch {
    return undefined;
  }
  for (const line of text.split("\n")) {
    if (!line.includes(token) || !line.includes("agentMessage")) {
      continue;
    }
    try {
      const parsed = JSON.parse(line) as {
        method?: string;
        params?: { item?: { text?: unknown; type?: unknown } };
      };
      const item = parsed.params?.item;
      if (
        parsed.method === "item/completed" &&
        item?.type === "agentMessage" &&
        typeof item.text === "string" &&
        item.text.includes(token)
      ) {
        return item.text;
      }
    } catch {
      /* partial line */
    }
  }
  return undefined;
}

function readLifecycleIdentity(events: CapturedAgentEvent[]): {
  action?: string;
  clientId?: string;
  model?: string;
  threadId?: string;
} {
  const turnStarting = events.find(
    (event) =>
      event.stream === "codex_app_server.lifecycle" && event.data?.phase === "turn_starting",
  );
  const threadReady = events.find(
    (event) =>
      event.stream === "codex_app_server.lifecycle" && event.data?.phase === "thread_ready",
  );
  return {
    action: threadReady?.data?.action as string | undefined,
    clientId: threadReady?.data?.clientId as string | undefined,
    model: turnStarting?.data?.model as string | undefined,
    threadId: threadReady?.data?.threadId as string | undefined,
  };
}

describeLive("gateway live (Codex native hook relay config proof)", () => {
  it(
    "sends the resolved native hook relay overlay to a real Codex app-server",
    async () => {
      const mode = resolveRelayProofMode();
      const proofDir = process.env.RELAY_PROOF_DIR?.trim();
      const codexCommand = process.env.RELAY_PROOF_CODEX_COMMAND?.trim();
      if (!proofDir) {
        throw new Error("RELAY_PROOF_DIR is required");
      }
      if (!codexCommand) {
        throw new Error("RELAY_PROOF_CODEX_COMMAND is required");
      }
      await fs.mkdir(proofDir, { recursive: true });

      const { clearRuntimeConfigSnapshot } = await import("../config/config.js");
      const { startGatewayServer } = await import("./server.js");

      const previousEnv: LiveEnvSnapshot = snapshotLiveEnv(["OPENCLAW_ALLOW_SLOW_REPLY_TESTS"]);
      const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-relay-proof-"));
      const stateDir = path.join(tempDir, "state");
      const workspace = await createLiveWorkspace(tempDir);
      const configPath = path.join(tempDir, "openclaw.json");
      const token = `test-${randomUUID()}`;
      const port = await getFreeGatewayPort();

      clearRuntimeConfigSnapshot();
      process.env.OPENCLAW_AGENT_RUNTIME = "codex";
      // Codex-auth (ChatGPT) lane: never let stray OpenAI overrides hijack it.
      delete process.env.OPENAI_BASE_URL;
      delete process.env.OPENAI_API_KEY;
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_ALLOW_SLOW_REPLY_TESTS", "1");
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);

      await fs.mkdir(stateDir, { recursive: true });
      const appServerConfig = await writeProofGatewayConfig({
        codexCommand,
        configPath,
        mode,
        port,
        token,
        workspace,
      });
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity({
        displayName: "vitest-codex-relay-proof",
      });
      let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
      let client: Awaited<ReturnType<typeof connectTestGatewayClient>> | undefined;
      const gatewayEvents: EventFrame[] = [];
      const receipt: Record<string, unknown> = {
        mode,
        modelKey: MODEL_KEY,
        pluginAppServerConfig: appServerConfig,
        startedAt: new Date().toISOString(),
      };

      try {
        server = await startGatewayServer(port, {
          bind: "loopback",
          auth: { mode: "token", token },
          controlUiEnabled: false,
        });
        client = await connectTestGatewayClient({
          url: `ws://127.0.0.1:${port}`,
          token,
          deviceIdentity,
          timeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
          requestTimeoutMs: REQUEST_TIMEOUT_MS,
          clientDisplayName: "vitest-codex-relay-proof",
          onEvent: (event) => {
            gatewayEvents.push(event);
          },
        });
        const activeClient = client;
        const sessionKey = `agent:dev:relay-proof-${mode}`;

        const modelCommandText = await requestChatCommandText({
          client: activeClient,
          events: gatewayEvents,
          sessionKey,
          command: `/model ${MODEL_KEY} --runtime codex`,
        });
        receipt.modelCommandText = modelCommandText;
        expect(modelCommandText).toContain("Runtime set to codex");

        const upperMode = mode.toUpperCase();
        if (isRelayProofApprovalMode(mode)) {
          // Approval modes run a single turn: the round-trip is the evidence, and
          // the approval bridge is shared by the attempt and side-question paths.
          await runApprovalProofTurn({
            client: activeClient,
            mode,
            proofDir,
            receipt,
            sessionKey,
            upperMode,
          });
        } else {
          const attemptNonce = randomBytes(3).toString("hex").toUpperCase();
          const attemptToken = `RELAY-PROOF-${upperMode}-${attemptNonce}`;
          const attempt = await requestAgentTextWithEvents({
            client: activeClient,
            sessionKey,
            message: `Reply with exactly ${attemptToken} and nothing else.`,
          });
          expect(attempt.text).toContain(attemptToken);
          const attemptIdentity = readLifecycleIdentity(attempt.events);
          receipt.attempt = {
            echoToken: attemptToken,
            text: attempt.text.trim(),
            ...attemptIdentity,
          };
          expect(attemptIdentity.threadId).toBeTruthy();
          await assertCapturedCodexHookOverlay({
            proofDir,
            method: "thread/start",
            label: `${mode} attempt`,
            expected: RELAY_PROOF_EXPECTED_OVERLAYS[mode].attempt,
            timeoutMs: CAPTURE_FRAME_TIMEOUT_MS,
          });

          const sideNonce = randomBytes(3).toString("hex").toUpperCase();
          const sideToken = `RELAY-SIDE-${upperMode}-${sideNonce}`;
          const side = await waitForSideQuestionEcho({
            client: activeClient,
            command: `/btw Reply with exactly ${sideToken} and nothing else.`,
            events: gatewayEvents,
            proofDir,
            sessionKey,
            token: sideToken,
            timeoutMs: REQUEST_TIMEOUT_MS,
          });
          expect(side.text).toContain(sideToken);
          receipt.sideQuestion = {
            echoToken: sideToken,
            source: side.source,
            text: side.text.trim().slice(0, 400),
          };
          const forkOverlay = RELAY_PROOF_EXPECTED_OVERLAYS[mode].fork;
          expect(forkOverlay, `${mode}: missing fork overlay expectation`).toBeTruthy();
          if (forkOverlay) {
            await assertCapturedCodexHookOverlay({
              proofDir,
              method: "thread/fork",
              label: `${mode} side question`,
              expected: forkOverlay,
              timeoutMs: CAPTURE_FRAME_TIMEOUT_MS,
            });
          }
        }
        receipt.finishedAt = new Date().toISOString();
      } finally {
        try {
          await fs.writeFile(
            path.join(proofDir, "receipt.json"),
            `${JSON.stringify(receipt, null, 2)}\n`,
          );
        } catch {
          /* receipt is best-effort */
        }
        try {
          clearRuntimeConfigSnapshot();
          try {
            await client?.stopAndWait();
          } finally {
            await server?.close();
          }
          const { resetTaskFlowRegistryForTests, resetTaskRegistryForTests } =
            await import("../tasks/task-runtime.test-helpers.js");
          resetTaskRegistryForTests({ persist: false });
          resetTaskFlowRegistryForTests({ persist: false });
        } finally {
          restoreLiveEnv(previousEnv);
          await removeLiveTempDir(tempDir);
        }
      }
    },
    TEST_TIMEOUT_MS,
  );
});
