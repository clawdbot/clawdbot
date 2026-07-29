// Live proof that the terminal chat event's `messageId` is the id of the
// assistant message the run actually persisted.
//
// The unit coverage in `agent-session.message-id.test.ts` proves the id is the
// real transcript id at the session layer, and the gateway test in
// `server.agent.gateway-server-agent-b.test.ts` proves the lifecycle id is
// forwarded onto the wire. Neither joins the two ends. This test does: it runs a
// real gateway, a real external websocket client, and a real agent turn, then
// correlates the `final` event a client actually received against the transcript
// row the gateway actually wrote.
//
// Run:
//   OPENCLAW_LIVE=1 OPENCLAW_LIVE_FINAL_MESSAGE_ID=1 \
//     node node_modules/vitest/vitest.mjs run \
//     src/gateway/gateway-final-message-id.live.test.ts --no-coverage
import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import { isLiveTestEnabled } from "../agents/live-test-helpers.js";
import { loadTranscriptEvents } from "../config/sessions/session-accessor.js";
import type { OpenClawConfig } from "../config/config.js";
import { setTestEnvValue } from "../test-utils/env.js";
import { GatewayClient } from "./client.js";
import {
  connectTestGatewayClient,
  createBootstrapWorkspace,
  ensurePairedTestGatewayClientIdentity,
  getFreeGatewayPort,
} from "./gateway-cli-backend.live-helpers.js";
import { loadSessionEntry } from "./session-utils.js";

const LIVE = isLiveTestEnabled();
const FINAL_MESSAGE_ID_LIVE = process.env.OPENCLAW_LIVE_FINAL_MESSAGE_ID === "1";
const describeLive = LIVE && FINAL_MESSAGE_ID_LIVE ? describe : describe.skip;

const LIVE_TIMEOUT_MS = 420_000;
const GATEWAY_CONNECT_TIMEOUT_MS = 60_000;
const FINAL_EVENT_TIMEOUT_MS = 240_000;
const DEFAULT_MODEL = process.env.OPENCLAW_LIVE_FINAL_MESSAGE_ID_MODEL ?? "claude-cli/claude-sonnet-4-6";

type ChatEventPayload = {
  runId?: string;
  sessionKey?: string;
  state?: string;
  messageId?: string;
  seq?: number;
};

function chatPayload(frame: EventFrame): ChatEventPayload | undefined {
  const candidate = frame as unknown as { event?: string; payload?: ChatEventPayload };
  return candidate.event === "chat" ? candidate.payload : undefined;
}

function snapshotEnv(): NodeJS.ProcessEnv {
  return { ...process.env };
}

function restoreEnv(previous: NodeJS.ProcessEnv): void {
  for (const key of Object.keys(process.env)) {
    if (!(key in previous)) {
      delete process.env[key];
    }
  }
  Object.assign(process.env, previous);
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
    agents: {
      list: [{ id: "dev", default: true }],
      defaults: {
        workspace: params.workspace,
        skipBootstrap: true,
        model: { primary: params.modelKey },
        models: { [params.modelKey]: { agentRuntime: { id: "claude-cli" } } },
        sandbox: { mode: "off" },
      },
    },
  };
  await fs.writeFile(params.configPath, `${JSON.stringify(cfg, null, 2)}\n`);
}

async function waitForTerminalChatEvent(params: {
  events: EventFrame[];
  runId: string;
  timeoutMs: number;
}): Promise<ChatEventPayload> {
  const deadline = Date.now() + params.timeoutMs;
  while (Date.now() < deadline) {
    for (const frame of params.events) {
      const payload = chatPayload(frame);
      if (
        payload?.runId === params.runId &&
        (payload.state === "final" || payload.state === "aborted")
      ) {
        return payload;
      }
    }
    await new Promise((resolve) => {
      setTimeout(resolve, 250);
    });
  }
  throw new Error(`timed out waiting for a terminal chat event for run ${params.runId}`);
}

describeLive("gateway final chat event messageId (live)", () => {
  const cleanup: Array<() => Promise<void>> = [];

  afterEach(async () => {
    for (const task of cleanup.splice(0).reverse()) {
      await task().catch(() => {});
    }
  });

  it(
    "final event messageId resolves to the assistant transcript row the run wrote",
    async () => {
      const { clearRuntimeConfigSnapshot } = await import("../config/config.js");
      const { startGatewayServer } = await import("./server.js");

      const previousEnv = snapshotEnv();
      const tempDir = await fs.mkdtemp(path.join(process.cwd(), ".tmp-openclaw-final-msgid-live-"));
      cleanup.push(async () => {
        restoreEnv(previousEnv);
        clearRuntimeConfigSnapshot();
        await fs.rm(tempDir, { recursive: true, force: true });
      });

      const stateDir = path.join(tempDir, "state");
      const { workspaceDir } = await createBootstrapWorkspace(tempDir);
      const configPath = path.join(tempDir, "openclaw.json");
      const token = `test-${randomUUID()}`;
      const port = await getFreeGatewayPort();

      clearRuntimeConfigSnapshot();
      setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
      setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
      process.env.OPENCLAW_GATEWAY_TOKEN = token;
      process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
      process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
      process.env.OPENCLAW_SKIP_CHANNELS = "1";
      process.env.OPENCLAW_SKIP_CRON = "1";
      process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
      await fs.mkdir(stateDir, { recursive: true });
      await writeLiveGatewayConfig({
        configPath,
        modelKey: DEFAULT_MODEL,
        port,
        token,
        workspace: workspaceDir,
      });

      const server = await startGatewayServer(port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
      });
      cleanup.push(async () => {
        await server.close();
      });

      const gatewayEvents: EventFrame[] = [];
      const deviceIdentity = await ensurePairedTestGatewayClientIdentity({
        displayName: "final-msgid-live",
      });
      const client: GatewayClient = await connectTestGatewayClient({
        url: `ws://127.0.0.1:${port}`,
        token,
        deviceIdentity,
        timeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
        requestTimeoutMs: 60_000,
        tickWatchTimeoutMs: FINAL_EVENT_TIMEOUT_MS + 120_000,
        clientDisplayName: "final-msgid-live",
        onEvent: (event) => {
          gatewayEvents.push(event);
        },
      });
      cleanup.push(async () => {
        await client.stopAndWait({ timeoutMs: 5_000 });
      });

      const sessionKey = "agent:dev:live-final-message-id";
      const replyToken = `MSGID-LIVE-${randomBytes(3).toString("hex").toUpperCase()}`;
      const runId = `chat-${randomUUID()}`;

      const ack = (await client.request(
        "chat.send",
        {
          sessionKey,
          message: `Reply with exactly ${replyToken} and nothing else.`,
          idempotencyKey: runId,
        },
        { timeoutMs: 60_000 },
      )) as { status?: string };
      expect(["accepted", "ok", "started"]).toContain(ack?.status);

      const terminal = await waitForTerminalChatEvent({
        events: gatewayEvents,
        runId,
        timeoutMs: FINAL_EVENT_TIMEOUT_MS,
      });

      // 1. The wire carries an id at all.
      expect(terminal.state).toBe("final");
      expect(typeof terminal.messageId).toBe("string");
      expect(terminal.messageId).not.toBe("");

      // 2. That id resolves to a real assistant row in the persisted transcript.
      const { entry, storePath } = loadSessionEntry(sessionKey);
      if (!entry?.sessionId) {
        throw new Error(`live session was not persisted: ${sessionKey}`);
      }
      const transcript = await loadTranscriptEvents({
        agentId: "dev",
        sessionId: entry.sessionId,
        sessionKey,
        storePath,
      });
      const assistantRows = transcript.filter(
        (event) => (event as { message?: { role?: string } }).message?.role === "assistant",
      );
      const matched = assistantRows.find(
        (event) => (event as { id?: string }).id === terminal.messageId,
      );

      // 3. It is the row carrying this run's reply — not merely *a* valid id.
      const matchedText = JSON.stringify(
        (matched as { message?: unknown } | undefined)?.message ?? null,
      );
      expect(matched, `no assistant transcript row with id ${terminal.messageId}`).toBeDefined();
      expect(matchedText).toContain(replyToken);

      // Redacted proof block for the PR. Model output is reduced to the token we
      // asked for, so nothing beyond the correlation itself is disclosed.
      console.error(
        `[final-message-id-live] ${JSON.stringify(
          {
            finalEvent: {
              state: terminal.state,
              runId: "<redacted>",
              sessionKey,
              messageId: terminal.messageId,
            },
            transcript: {
              assistantRowCount: assistantRows.length,
              matchedRowId: (matched as { id?: string }).id,
              matchedRowContainsReplyToken: matchedText.includes(replyToken),
            },
          },
          null,
          2,
        )}`,
      );
    },
    LIVE_TIMEOUT_MS,
  );
});
