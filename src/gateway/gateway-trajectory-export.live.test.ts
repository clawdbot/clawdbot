// Gateway trajectory export live tests verify Codex harness runs emit trajectory artifacts under live settings.
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import type { OpenClawConfig } from "../config/config.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { loadSqliteTrajectoryRuntimeEvents } from "../trajectory/runtime-store.sqlite.js";
import { GatewayClient } from "./client.js";
import {
  connectTestGatewayClient,
  createBootstrapWorkspace,
  ensurePairedTestGatewayClientIdentity,
  getFreeGatewayPort,
} from "./gateway-cli-backend.live-helpers.js";
import { restoreLiveEnv, snapshotLiveEnv, type LiveEnvSnapshot } from "./live-env-test-helpers.js";
import { loadSessionEntry } from "./session-utils.js";
import { extractPayloadText } from "./test-helpers.agent-results.js";

const LIVE = isLiveTestEnabled();
const CODEX_HARNESS_LIVE = process.env.OPENCLAW_LIVE_CODEX_HARNESS === "1";
const CODEX_HARNESS_DEBUG = process.env.OPENCLAW_LIVE_CODEX_HARNESS_DEBUG === "1";
const CODEX_HARNESS_AUTH_MODE =
  process.env.OPENCLAW_LIVE_CODEX_HARNESS_AUTH === "api-key" ? "api-key" : "codex-auth";
const describeLive = LIVE && CODEX_HARNESS_LIVE ? describe : describe.skip;
const LIVE_TIMEOUT_MS = 420_000;
const GATEWAY_CONNECT_TIMEOUT_MS = 60_000;
const AGENT_REQUEST_TIMEOUT_MS = 180_000;
// Keep this below LIVE_TIMEOUT_MS so timeout diagnostics win over Vitest's generic cap.
const TRAJECTORY_EXPORT_INSTRUCTION_TIMEOUT_MS = 120_000;
const DEFAULT_CODEX_MODEL = "openai/gpt-5.6-luna";

type TrajectoryExportApprovalEntry = {
  id?: string;
  command?: string;
  commandArgv?: string[];
  commandText?: string;
  commandPreview?: string;
  request?: {
    command?: string;
    commandArgv?: string[];
    commandText?: string;
    commandPreview?: string;
  };
};

type TrajectoryExportApprovalSummary = {
  id?: string;
  hasTrajectoryExportCommand: boolean;
};

type TrajectoryExportSignal = {
  approvalId?: string;
  instructionText: string;
};

function logLiveStep(step: string, details?: Record<string, unknown>): void {
  if (!CODEX_HARNESS_DEBUG) {
    return;
  }
  const suffix = details && Object.keys(details).length > 0 ? ` ${JSON.stringify(details)}` : "";
  console.error(`[gateway-trajectory-live] ${step}${suffix}`);
}

function snapshotEnv(): LiveEnvSnapshot {
  return snapshotLiveEnv(["OPENCLAW_TRAJECTORY", "OPENCLAW_TRAJECTORY_DIR"]);
}

function restoreEnv(snapshot: LiveEnvSnapshot): void {
  restoreLiveEnv(snapshot);
}

async function removeLiveTempDir(dir: string): Promise<void> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error;
      const code = (error as { code?: unknown } | null)?.code;
      if (code !== "EBUSY" && code !== "ENOTEMPTY" && code !== "EPERM" && code !== "EACCES") {
        throw error;
      }
      await new Promise((resolve) => {
        setTimeout(resolve, 100);
      });
    }
  }
  await fs.rm(dir, { recursive: true, force: true });
  void lastError;
}

async function writeLiveGatewayConfig(params: {
  configPath: string;
  modelKey: string;
  port: number;
  token: string;
  workspace: string;
}): Promise<void> {
  const cfg: OpenClawConfig = {
    gateway: {
      mode: "local",
      port: params.port,
      auth: { mode: "token", token: params.token },
    },
    commands: { ownerAllowFrom: ["*"] },
    plugins: { allow: ["codex"] },
    agents: {
      list: [{ id: "dev", default: true, tools: { exec: { host: "node" } } }],
      defaults: {
        workspace: params.workspace,
        skipBootstrap: true,
        model: { primary: params.modelKey },
        models: { [params.modelKey]: { agentRuntime: { id: "codex" } } },
        sandbox: { mode: "off" },
      },
    },
  };
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

async function connectGatewayClient(params: {
  onEvent?: (event: EventFrame) => void;
  url: string;
  token: string;
}): Promise<GatewayClient> {
  const deviceIdentity = await ensurePairedTestGatewayClientIdentity({
    displayName: "trajectory-live",
  });
  const client = await connectTestGatewayClient({
    url: params.url,
    token: params.token,
    deviceIdentity,
    timeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
    requestTimeoutMs: 60_000,
    tickWatchTimeoutMs: AGENT_REQUEST_TIMEOUT_MS + 120_000,
    clientDisplayName: "trajectory-live",
    onEvent: params.onEvent,
  });
  return client;
}

async function requestAgentExactReply(params: {
  client: GatewayClient;
  expectedToken: string;
  message: string;
  sessionKey: string;
}): Promise<string> {
  const payload = (await params.client.request(
    "agent",
    {
      sessionKey: params.sessionKey,
      idempotencyKey: `idem-${randomUUID()}`,
      message: params.message,
      deliver: false,
      thinking: "low",
    },
    { expectFinal: true, timeoutMs: AGENT_REQUEST_TIMEOUT_MS },
  )) as {
    status?: string;
    result?: unknown;
  };
  if (payload?.status !== "ok") {
    throw new Error(`agent request failed: ${JSON.stringify(payload)}`);
  }
  const text = extractPayloadText(payload.result);
  expect(text).toContain(params.expectedToken);
  return text;
}

async function listDirectoryNames(dirPath: string): Promise<string[]> {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}

async function waitForPath(filePath: string, timeoutMs = 60_000): Promise<void> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      await fs.stat(filePath);
      return;
    } catch {
      await new Promise((resolve) => {
        setTimeout(resolve, 500);
      });
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

function formatTextPreview(texts: string[], maxChars = 800): string {
  const combined = texts.join("\n\n").trim();
  if (!combined) {
    return "<none>";
  }
  return combined.length > maxChars ? `${combined.slice(0, maxChars)}...` : combined;
}

function findTrajectoryExportInstructionText(
  texts: string[],
  expectedTexts: string[],
): string | undefined {
  const combined = texts.filter((text) => text.trim().length > 0).join("\n\n");
  return expectedTexts.every((expectedText) => combined.includes(expectedText))
    ? combined
    : undefined;
}

function extractAssistantTexts(messages: unknown[]): string[] {
  const texts: string[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== "object") {
      continue;
    }
    if ((entry as { role?: unknown }).role !== "assistant") {
      continue;
    }
    const text = extractVisibleMessageText(entry);
    if (typeof text === "string" && text.trim().length > 0) {
      texts.push(text);
    }
  }
  return texts;
}

function getTrajectoryExportApprovalCommands(entry: TrajectoryExportApprovalEntry): string[] {
  return [
    entry.request?.command,
    entry.request?.commandArgv?.join(" "),
    entry.request?.commandText,
    entry.request?.commandPreview,
    entry.command,
    entry.commandArgv?.join(" "),
    entry.commandText,
    entry.commandPreview,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function hasTrajectoryExportArgv(argv: string[] | undefined): boolean {
  if (!argv) {
    return false;
  }
  return argv.some((arg, index) => arg === "sessions" && argv[index + 1] === "export-trajectory");
}

function isTrajectoryExportApproval(entry: TrajectoryExportApprovalEntry): boolean {
  if (
    hasTrajectoryExportArgv(entry.request?.commandArgv) ||
    hasTrajectoryExportArgv(entry.commandArgv)
  ) {
    return true;
  }
  return getTrajectoryExportApprovalCommands(entry).some((command) => {
    const normalized = command.replaceAll(/['"]/gu, "");
    return normalized.includes("sessions export-trajectory");
  });
}

function summarizeTrajectoryExportApproval(
  entry: TrajectoryExportApprovalEntry,
): TrajectoryExportApprovalSummary {
  const summary: TrajectoryExportApprovalSummary = {
    hasTrajectoryExportCommand: isTrajectoryExportApproval(entry),
  };
  if (entry.id) {
    summary.id = entry.id;
  }
  return summary;
}

async function waitForTrajectoryExportSignal(params: {
  client: GatewayClient;
  events: EventFrame[];
  eventStartIndex: number;
  expectedTexts: string[];
  initialTexts?: string[];
  runId: string;
  sessionKey: string;
  timeoutMs: number;
}): Promise<TrajectoryExportSignal> {
  const deadline = Date.now() + params.timeoutMs;
  let finalTexts: string[] | undefined;
  let assistantTexts: string[] | undefined;
  let approvalId: string | undefined;
  let nextHistoryPollAt = 0;
  while (Date.now() < deadline) {
    const newEvents = params.events.slice(params.eventStartIndex);
    finalTexts = newEvents
      .map((event) => extractChatFinalText(event, params.runId))
      .filter((text): text is string => typeof text === "string" && text.trim().length > 0);
    const matchedText = findTrajectoryExportInstructionText(
      [...(params.initialTexts ?? []), ...finalTexts, ...(assistantTexts ?? [])],
      params.expectedTexts,
    );
    if (matchedText) {
      return { ...(approvalId ? { approvalId } : {}), instructionText: matchedText };
    }
    if (Date.now() >= nextHistoryPollAt) {
      try {
        const history = (await params.client.request(
          "chat.history",
          {
            sessionKey: params.sessionKey,
            limit: 24,
          },
          { timeoutMs: 10_000 },
        )) as { messages?: unknown[] };
        assistantTexts = extractAssistantTexts(history.messages ?? []);
        const matchedHistoryText = findTrajectoryExportInstructionText(
          [...(params.initialTexts ?? []), ...finalTexts, ...assistantTexts],
          params.expectedTexts,
        );
        if (matchedHistoryText) {
          return { ...(approvalId ? { approvalId } : {}), instructionText: matchedHistoryText };
        }
      } catch {
        assistantTexts = [];
      }
      try {
        const approvals = (await params.client.request(
          "exec.approval.list",
          {},
          { timeoutMs: 10_000 },
        )) as TrajectoryExportApprovalEntry[];
        const approval = approvals.find(isTrajectoryExportApproval);
        if (approval && !approvalId) {
          approvalId = await approveTrajectoryExport(params.client, approval);
        }
      } catch {}
      nextHistoryPollAt = Date.now() + 2_000;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  let approvalSummaries: TrajectoryExportApprovalSummary[];
  try {
    const approvals = (await params.client.request(
      "exec.approval.list",
      {},
      { timeoutMs: 10_000 },
    )) as TrajectoryExportApprovalEntry[];
    approvalSummaries = approvals.map(summarizeTrajectoryExportApproval);
  } catch {
    approvalSummaries = [];
  }
  throw new Error(
    `timed out waiting for trajectory export instruction text for ${params.runId}; ` +
      `events=${params.events.length}; approved=${approvalId ?? "<none>"}; finalTexts=${formatTextPreview(finalTexts ?? [])}; assistantTexts=${formatTextPreview(assistantTexts ?? [])}; approvals=${JSON.stringify(approvalSummaries)}`,
  );
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
  return extractChatFinalRecordText(record);
}

function extractChatFinalRecordText(record: Record<string, unknown>): string | undefined {
  const message = record.message;
  if (!message || typeof message !== "object") {
    return undefined;
  }
  return extractVisibleMessageText(message);
}

function extractVisibleMessageText(message: unknown): string | undefined {
  if (!message || typeof message !== "object") {
    return undefined;
  }
  const record = message as { text?: unknown; content?: unknown };
  if (typeof record.text === "string" && record.text.trim()) {
    return record.text;
  }
  if (typeof record.content === "string" && record.content.trim()) {
    return record.content;
  }
  if (!Array.isArray(record.content)) {
    return undefined;
  }
  const text = record.content
    .map((block) => {
      if (!block || typeof block !== "object") {
        return "";
      }
      const entry = block as { type?: unknown; text?: unknown };
      return entry.type === "text" && typeof entry.text === "string" ? entry.text : "";
    })
    .filter((value) => value.trim())
    .join("\n");
  return text || undefined;
}

async function approveTrajectoryExport(
  client: GatewayClient,
  existingApproval?: TrajectoryExportApprovalEntry,
): Promise<string> {
  const startedAt = Date.now();
  let approval: TrajectoryExportApprovalEntry | undefined = existingApproval;
  let lastApprovalSummaries: TrajectoryExportApprovalSummary[] = [];
  while (!approval && Date.now() - startedAt < 60_000) {
    const approvals = (await client.request(
      "exec.approval.list",
      {},
      { timeoutMs: 10_000 },
    )) as TrajectoryExportApprovalEntry[];
    lastApprovalSummaries = approvals.map(summarizeTrajectoryExportApproval);
    approval = approvals.find(isTrajectoryExportApproval);
    if (approval) {
      break;
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 500);
    });
  }
  if (!approval?.id) {
    throw new Error(
      `expected trajectory export approval id; approvals=${JSON.stringify(lastApprovalSummaries)}`,
    );
  }
  expect(isTrajectoryExportApproval(approval)).toBe(true);
  await client.request(
    "exec.approval.resolve",
    { id: approval.id, decision: "allow-once" },
    { timeoutMs: 10_000 },
  );
  return approval.id;
}

describeLive("gateway live trajectory export", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const step of cleanup.splice(0).toReversed()) {
      await step();
    }
  });

  it(
    "exports a combined runtime and transcript trajectory bundle through the live gateway",
    async () => {
      const { clearRuntimeConfigSnapshot } = await import("../config/config.js");
      const { startGatewayServer } = await import("./server.js");

      const previousEnv = snapshotEnv();
      const tempDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-openclaw-trajectory-live-"));
      cleanup.push(async () => {
        restoreEnv(previousEnv);
        clearRuntimeConfigSnapshot();
        await removeLiveTempDir(tempDir);
      });

      const stateDir = path.join(tempDir, "state");
      const trajectoryDir = path.join(tempDir, "runtime-traces");
      const { workspaceDir } = await createBootstrapWorkspace(tempDir);
      const configPath = path.join(tempDir, "openclaw.json");
      const token = `test-${randomUUID()}`;
      const port = await getFreeGatewayPort();
      const modelKey = process.env.OPENCLAW_LIVE_CODEX_HARNESS_MODEL ?? DEFAULT_CODEX_MODEL;

      clearRuntimeConfigSnapshot();
      process.env.OPENCLAW_AGENT_RUNTIME = "codex";
      // API-key CI lanes intentionally pass OPENAI_API_KEY through to the Codex
      // app-server harness; only stored Codex-auth runs should clear OpenAI env.
      if (CODEX_HARNESS_AUTH_MODE !== "api-key") {
        delete process.env.OPENAI_BASE_URL;
        delete process.env.OPENAI_API_KEY;
      } else if (!process.env.OPENAI_BASE_URL?.trim()) {
        delete process.env.OPENAI_BASE_URL;
      }
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      process.env.OPENCLAW_TRAJECTORY = "1";
      process.env.OPENCLAW_TRAJECTORY_DIR = trajectoryDir;

      await fs.mkdir(stateDir, { recursive: true });
      await fs.mkdir(trajectoryDir, { recursive: true });
      await writeLiveGatewayConfig({ configPath, modelKey, port, token, workspace: workspaceDir });
      logLiveStep("config-written", { configPath, modelKey, port, workspaceDir });

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      logLiveStep("gateway-started", { port });
      cleanup.push(async () => {
        await server.close();
      });

      const gatewayEvents: EventFrame[] = [];
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        onEvent: (event) => {
          gatewayEvents.push(event);
        },
      });
      logLiveStep("client-connected");
      cleanup.push(async () => {
        await client.stopAndWait({ timeoutMs: 5_000 });
      });

      const sessionKey = "agent:dev:live-trajectory-export";
      const replyToken = `TRAJECTORY-LIVE-${randomBytes(3).toString("hex").toUpperCase()}`;
      logLiveStep("agent-turn:start", { sessionKey, replyToken });
      const firstReply = await requestAgentExactReply({
        client,
        sessionKey,
        expectedToken: replyToken,
        message: `Reply with exactly ${replyToken} and nothing else.`,
      });
      logLiveStep("agent-turn:done", { firstReply });
      expect(firstReply.trim()).toBe(replyToken);

      const { entry, storePath } = loadSessionEntry(sessionKey);
      if (!entry?.sessionId) {
        throw new Error(`live trajectory session was not persisted: ${sessionKey}`);
      }
      const runtimeEvents = await loadSqliteTrajectoryRuntimeEvents({
        agentId: "dev",
        sessionId: entry.sessionId,
        storePath,
      });
      logLiveStep("runtime-events", {
        count: runtimeEvents.length,
        types: runtimeEvents.map((event) => event.type),
      });
      expect(runtimeEvents.length).toBeGreaterThan(0);

      const bundleDir = path.join(workspaceDir, ".openclaw", "trajectory-exports", "bundle");
      const beforeExport = new Set(await listDirectoryNames(tempDir));
      const exportRunId = `chat-export-${randomUUID()}`;
      const exportEventStartIndex = gatewayEvents.length;
      logLiveStep("export:start", { bundleDir, exportRunId });
      const exportResponse = (await client.request(
        "chat.send",
        {
          sessionKey,
          message: "/export-trajectory bundle",
          idempotencyKey: exportRunId,
        },
        { timeoutMs: 60_000 },
      )) as { status?: string; message?: unknown };
      logLiveStep("export:ack", { status: exportResponse?.status });
      expect(
        exportResponse?.status === "accepted" ||
          exportResponse?.status === "ok" ||
          exportResponse?.status === "started",
      ).toBe(true);
      const exportSignal = await waitForTrajectoryExportSignal({
        client,
        events: gatewayEvents,
        eventStartIndex: exportEventStartIndex,
        expectedTexts: ["Trajectory exports can include", "through exec approval", "Approve once"],
        initialTexts:
          typeof exportResponse?.message === "object"
            ? [extractVisibleMessageText(exportResponse.message) ?? ""]
            : [],
        runId: exportRunId,
        sessionKey,
        timeoutMs: TRAJECTORY_EXPORT_INSTRUCTION_TIMEOUT_MS,
      });
      expect(exportSignal.instructionText).toContain("Trajectory exports can include");
      expect(exportSignal.instructionText).toContain("through exec approval");
      expect(exportSignal.instructionText).toContain("Approve once");
      const approvalId = exportSignal.approvalId ?? (await approveTrajectoryExport(client));
      logLiveStep("export:approved", { approvalId });
      await waitForPath(path.join(bundleDir, "events.jsonl"), 60_000);
      logLiveStep("export:done", { approvalId, finalText: exportSignal.instructionText });
      const bundleNames = await listDirectoryNames(bundleDir);
      for (const expectedName of [
        "artifacts.json",
        "events.jsonl",
        "manifest.json",
        "prompts.json",
        "session-branch.json",
        "tools.json",
      ]) {
        expect(bundleNames).toContain(expectedName);
      }
      expect(beforeExport.has("bundle")).toBe(false);

      const manifest = JSON.parse(
        await fs.readFile(path.join(bundleDir, "manifest.json"), "utf8"),
      ) as {
        eventCount?: number;
        runtimeEventCount?: number;
        transcriptEventCount?: number;
        supplementalFiles?: string[];
      };
      for (const supplementalFile of manifest.supplementalFiles ?? []) {
        expect(bundleNames).toContain(supplementalFile);
      }
      expect(manifest.eventCount).toBeGreaterThan(0);
      expect(manifest.runtimeEventCount).toBeGreaterThan(0);
      expect(manifest.transcriptEventCount).toBeGreaterThan(0);

      const exportedEvents = (await fs.readFile(path.join(bundleDir, "events.jsonl"), "utf8"))
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { type?: string });
      const eventTypes = new Set(exportedEvents.map((event) => event.type));
      expect(eventTypes.has("context.compiled")).toBe(true);
      expect(eventTypes.has("prompt.submitted")).toBe(true);
      expect(eventTypes.has("model.completed")).toBe(true);
      expect(eventTypes.has("session.ended")).toBe(true);
      expect(eventTypes.has("user.message")).toBe(true);
      expect(eventTypes.has("assistant.message")).toBe(true);
    },
    LIVE_TIMEOUT_MS,
  );
});
