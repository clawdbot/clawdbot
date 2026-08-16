import crypto from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
// Feishu gateway harness proves the #54409 fix at the real gateway boundary:
// webhook-mode feishu channel + mock OpenAI-responses provider + ephemeral
// gateway. A second same-chat message must reach core's queue policy while the
// first run is still active (lane released at turn adoption) and be handled per
// the configured queue mode instead of starting a second independent run after
// the first completes.
//
// This is the changed-path real-behavior proof: the queue decision
// (`resolveActiveRunQueueAction`) only ever sees `isActive=true` when the
// feishu plugin releases its per-chat sequential queue lane before the turn
// finishes. Pre-fix, the second message is not even dispatched until run 1
// completes, so no `message.queued` event can appear during the hold.
//
// All three queue modes are covered here. Steer parks the candidate and emits
// `message.queued` with source "followup-queue-steer"; collect/followup never
// park — their changed-path signal is the dispatch lifecycle's
// `message.queued` with source "dispatch", which fires the moment the lane is
// released (before admission). Mode-specific semantics (steer merge vs
// collect batch vs FIFO follow-up) are owned and tested by core's queue
// suite; the feishu boundary only controls when the lane frees.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../packages/gateway-protocol/src/client-info.js";
import type { OpenClawConfig } from "../src/config/types.openclaw.js";
import { GatewayClient, type GatewayClientOptions } from "../src/gateway/client.js";
import { buildMockOpenAiResponsesProvider } from "../src/gateway/test-openai-responses-model.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../src/utils/message-channel.js";
import {
  createOpenClawTestInstance,
  type OpenClawTestInstance,
} from "./helpers/openclaw-test-instance.js";
import { createDeferred } from "./helpers/promise.js";

const TEST_TIMEOUT_MS = 300_000;
const WAIT_OPTS = { timeout: 45_000, interval: 20 } as const;
const GATEWAY_TOKEN = "feishu-adoption-harness-token";
const FEISHU_ACCOUNT_ID = "harness";
const FEISHU_WEBHOOK_PATH = "/feishu/events";
const FEISHU_VERIFY_TOKEN = "harness_verify_token";
const FEISHU_ENCRYPT_KEY = "harness_encrypt_key";
const FEISHU_CHAT_ID = "oc_harness_chat";
const FEISHU_SENDER_OPEN_ID = "ou_harness_sender";

type ModelRequest = { body: Record<string, unknown> };
type MockModelServer = {
  baseUrl: string;
  requests: ModelRequest[];
  releaseFirst: () => void;
  stop: () => Promise<void>;
};
type StabilitySnapshot = {
  lastSeq?: number;
  events?: Array<Record<string, unknown>>;
};
type GatewayFixture = {
  instance: OpenClawTestInstance;
  diagnosticsClient: GatewayClient;
  modelServer: MockModelServer;
  webhookUrl: string;
  webhookPort: number;
};

const instances: OpenClawTestInstance[] = [];
const diagnosticsClients: GatewayClient[] = [];
const cleanupDirs: string[] = [];
const modelServers: MockModelServer[] = [];

async function collectCleanupFailures(
  tasks: Array<Promise<unknown>>,
  failures: unknown[],
): Promise<void> {
  const results = await Promise.allSettled(tasks);
  failures.push(
    ...results.flatMap((result) => (result.status === "rejected" ? [result.reason] : [])),
  );
}

afterEach(async () => {
  const failures: unknown[] = [];
  await collectCleanupFailures(
    diagnosticsClients.splice(0).map((client) => client.stopAndWait()),
    failures,
  );
  await collectCleanupFailures(
    instances.splice(0).map((instance) => instance.cleanup()),
    failures,
  );
  await collectCleanupFailures(
    modelServers.splice(0).map((server) => server.stop()),
    failures,
  );
  await collectCleanupFailures(
    cleanupDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    failures,
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Feishu adoption gateway harness cleanup failed");
  }
});

async function readJsonRequest(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
}

function writeSse(res: ServerResponse, events: Record<string, unknown>[]): void {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.end(
    `${events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")}data: [DONE]\n\n`,
  );
}

function writeTextResponse(res: ServerResponse, requestIndex: number): void {
  const id = `msg_feishu_harness_${requestIndex}`;
  const text = `TURN_${requestIndex}_COMPLETE`;
  const message = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  writeSse(res, [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    {
      type: "response.output_text.delta",
      item_id: id,
      output_index: 0,
      content_index: 0,
      delta: text,
    },
    {
      type: "response.output_text.done",
      item_id: id,
      output_index: 0,
      content_index: 0,
      text,
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        id: `resp_feishu_harness_${requestIndex}`,
        status: "completed",
        output: [message],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      },
    },
  ]);
}

async function startMockModelServer(): Promise<MockModelServer> {
  const requests: ModelRequest[] = [];
  const firstResponse = createDeferred();
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      if (req.method === "GET" && url.pathname === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "feishu-harness", object: "model" }] }));
        return;
      }
      if (req.method !== "POST" || url.pathname !== "/v1/responses") {
        res.writeHead(404).end();
        return;
      }
      requests.push({ body: await readJsonRequest(req) });
      const requestIndex = requests.length;
      if (requestIndex === 1) {
        await firstResponse.promise;
        if (res.destroyed) {
          return;
        }
      }
      writeTextResponse(res, requestIndex);
    })().catch((error: unknown) => {
      if (!res.destroyed) {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: String(error) } }));
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("mock model server did not bind");
  }
  let stopped = false;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    releaseFirst: () => {
      firstResponse.resolve();
    },
    stop: async () => {
      if (stopped) {
        return;
      }
      stopped = true;
      firstResponse.resolve();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
    },
  };
}

// Feishu webhook request signing: sha256(timestamp + nonce + encryptKey +
// body), carried in the x-lark-request-* headers. Same contract the plugin's
// real webhook transport verifies (monitor.transport.ts).
function signFeishuPayload(rawBody: string): Record<string, string> {
  const timestamp = "1711111111";
  const nonce = "nonce-harness";
  const signature = crypto
    .createHash("sha256")
    .update(timestamp + nonce + FEISHU_ENCRYPT_KEY + rawBody)
    .digest("hex");
  return {
    "content-type": "application/json",
    "x-lark-request-timestamp": timestamp,
    "x-lark-request-nonce": nonce,
    "x-lark-signature": signature,
  };
}

function buildFeishuMessageEvent(params: {
  eventId: string;
  messageId: string;
  text: string;
}): Record<string, unknown> {
  return {
    schema: "2.0",
    header: { event_type: "im.message.receive_v1", event_id: params.eventId },
    event: {
      sender: {
        sender_id: { open_id: FEISHU_SENDER_OPEN_ID, user_id: "user_harness" },
        sender_type: "user",
        tenant_key: "tenant_harness",
      },
      message: {
        message_id: params.messageId,
        chat_id: FEISHU_CHAT_ID,
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({ text: params.text }),
        create_time: "1711111111000",
      },
    },
  };
}

async function postFeishuMessage(
  webhookUrl: string,
  params: { eventId: string; messageId: string; text: string },
): Promise<Response> {
  const rawBody = JSON.stringify(buildFeishuMessageEvent(params));
  return await fetch(webhookUrl, {
    method: "POST",
    headers: signFeishuPayload(rawBody),
    body: rawBody,
  });
}

// Drive comment notices (drive.notice.comment_add_v1) ride the same signed
// webhook transport and durable drain as messages; the handler receives the
// inner event object (parseFeishuDriveCommentNoticeEventPayload). notice_meta
// identifies the document lane (comment-doc:<file_type>:<file_token>), which
// the durable ingress, the plugin's sequential queue, and the core session
// key all share.
function buildFeishuCommentEvent(params: {
  eventId: string;
  commentId: string;
}): Record<string, unknown> {
  return {
    schema: "2.0",
    header: { event_type: "drive.notice.comment_add_v1", event_id: params.eventId },
    event: {
      type: "drive.notice.comment_add_v1",
      event_id: params.eventId,
      comment_id: params.commentId,
      is_mentioned: true,
      notice_meta: {
        file_token: "docx_harness_token",
        file_type: "docx",
        from_user_id: { open_id: FEISHU_SENDER_OPEN_ID },
        to_user_id: { open_id: "ou_harness_bot" },
        notice_type: "add_comment",
      },
      timestamp: "1711111111000",
    },
  };
}

async function postFeishuComment(
  webhookUrl: string,
  params: { eventId: string; commentId: string },
): Promise<Response> {
  const rawBody = JSON.stringify(buildFeishuCommentEvent(params));
  return await fetch(webhookUrl, {
    method: "POST",
    headers: signFeishuPayload(rawBody),
    body: rawBody,
  });
}

async function waitForWebhookListening(
  fixture: GatewayFixture,
  port: number,
  timeoutMs: number,
): Promise<void> {
  const net = await import("node:net");
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port });
        socket.setTimeout(500);
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("timeout", () => {
          socket.destroy();
          reject(new Error(`connect timeout to 127.0.0.1:${port}`));
        });
        socket.once("error", reject);
      });
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolvePoll) => {
        setTimeout(resolvePoll, 250);
      });
    }
  }
  throw new Error(
    `feishu webhook never listened on 127.0.0.1:${port}: ${String(lastError)}\n` +
      redactedFixtureLogs(fixture.instance),
  );
}

type QueueMode = "steer" | "collect" | "followup";

function createConfig(params: {
  fixtureDir: string;
  modelServer: MockModelServer;
  feishuWebhookPort: number;
  queueMode: QueueMode;
  feishuApiDomain?: string;
}): OpenClawConfig {
  const provider = buildMockOpenAiResponsesProvider(
    `${params.modelServer.baseUrl}/v1`,
    "feishu-harness",
  );
  return {
    plugins: { slots: { memory: "none" } },
    agents: {
      defaults: {
        workspace: path.join(params.fixtureDir, "workspace"),
        model: { primary: provider.modelRef },
        models: {
          [provider.modelRef]: {
            agentRuntime: { id: "openclaw" },
            params: { transport: "sse", openaiWsWarmup: false },
          },
        },
        skills: [],
        skipBootstrap: true,
      },
      entries: {
        main: { default: true, model: { primary: provider.modelRef }, skills: [] },
      },
    },
    tools: { profile: "minimal" },
    models: {
      mode: "replace",
      providers: {
        [provider.providerId]: {
          ...provider.config,
          models: provider.config.models.map((model) =>
            Object.assign({}, model, { input: Array.from(model.input) }),
          ),
          request: { allowPrivateNetwork: true },
        },
      },
    },
    messages: { queue: { mode: params.queueMode, debounceMsByChannel: { feishu: 0 } } },
    channels: {
      feishu: {
        enabled: true,
        dmPolicy: "open",
        allowFrom: ["*"],
        resolveSenderNames: false,
        typingIndicator: false,
        connectionMode: "webhook",
        webhookHost: "127.0.0.1",
        webhookPort: params.feishuWebhookPort,
        accounts: {
          [FEISHU_ACCOUNT_ID]: {
            enabled: true,
            appId: "cli_harness",
            appSecret: "harness_secret", // pragma: allowlist secret
            connectionMode: "webhook",
            webhookPath: FEISHU_WEBHOOK_PATH,
            verificationToken: FEISHU_VERIFY_TOKEN,
            encryptKey: FEISHU_ENCRYPT_KEY,
            ...(params.feishuApiDomain ? { domain: params.feishuApiDomain } : {}),
          },
        },
      },
    },
  };
}

async function getFreePort(): Promise<number> {
  const net = await import("node:net");
  return await new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("failed to bind ephemeral port"));
        return;
      }
      server.close(() => resolve(address.port));
    });
  });
}

async function connectDiagnosticsClient(instance: OpenClawTestInstance): Promise<GatewayClient> {
  let resolveHello!: () => void;
  let rejectHello!: (error: Error) => void;
  const hello = new Promise<void>((resolve, reject) => {
    resolveHello = resolve;
    rejectHello = reject;
  });
  const gatewayUrl = new URL(instance.url);
  gatewayUrl.protocol = gatewayUrl.protocol === "wss:" ? "https:" : "http:";
  const options: GatewayClientOptions = {
    url: instance.url,
    origin: gatewayUrl.origin,
    token: GATEWAY_TOKEN,
    clientName: GATEWAY_CLIENT_NAMES.TUI,
    clientDisplayName: "feishu-adoption-harness-diagnostics",
    mode: GATEWAY_CLIENT_MODES.UI,
    role: "operator",
    scopes: ["operator.admin", "operator.read", "operator.write"],
    caps: [GATEWAY_CLIENT_CAPS.TASK_SUGGESTIONS],
    platform: process.platform,
    requestTimeoutMs: 30_000,
    onHelloOk: resolveHello,
    onConnectError: rejectHello,
    onClose: (code, reason) => rejectHello(new Error(`Gateway closed ${code}: ${reason}`)),
  };
  const client = new GatewayClient(options);
  diagnosticsClients.push(client);
  client.start();
  await hello;
  return client;
}

async function createGatewayFixture(
  name: string,
  queueMode: QueueMode,
  feishuApiDomain?: string,
): Promise<GatewayFixture> {
  const fixtureDir = await mkdtemp(path.join(tmpdir(), `openclaw-${name}-`));
  cleanupDirs.push(fixtureDir);
  const modelServer = await startMockModelServer();
  modelServers.push(modelServer);
  const feishuWebhookPort = await getFreePort();
  const instance = await createOpenClawTestInstance({
    name,
    gatewayToken: GATEWAY_TOKEN,
    config: createConfig({
      fixtureDir,
      modelServer,
      feishuWebhookPort,
      queueMode,
      feishuApiDomain,
    }),
    env: {
      OPENCLAW_LOG_LEVEL: "debug",
      OPENCLAW_SKIP_CHANNELS: undefined,
      OPENCLAW_SKIP_PROVIDERS: undefined,
      OPENCLAW_TEST_MINIMAL_GATEWAY: undefined,
      // The feishu bot-info probe hits open.feishu.cn with harness credentials
      // and fails; bound its timeout so startup is not gated on the network.
      OPENCLAW_FEISHU_STARTUP_PROBE_TIMEOUT_MS: "3000",
    },
  });
  instances.push(instance);
  await instance.startGateway();
  const diagnosticsClient = await connectDiagnosticsClient(instance);
  return {
    instance,
    diagnosticsClient,
    modelServer,
    webhookUrl: `http://127.0.0.1:${feishuWebhookPort}${FEISHU_WEBHOOK_PATH}`,
    webhookPort: feishuWebhookPort,
  };
}

async function stabilityEvents(
  fixture: GatewayFixture,
  type: string,
  sinceSeq?: number,
): Promise<Array<Record<string, unknown>>> {
  const snapshot = await fixture.diagnosticsClient.request<StabilitySnapshot>(
    "diagnostics.stability",
    {
      type,
      ...(sinceSeq !== undefined ? { sinceSeq } : {}),
      limit: 20,
    },
  );
  return snapshot.events ?? [];
}

function contentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") {
        return [];
      }
      const text = (part as { text?: unknown }).text;
      return typeof text === "string" ? [text] : [];
    })
    .join("\n");
}

function userInputs(request: ModelRequest | undefined): string[] {
  const input = request?.body.input;
  if (typeof input === "string") {
    return [input];
  }
  if (!Array.isArray(input)) {
    return [];
  }
  return input.flatMap((item) =>
    item && typeof item === "object" && (item as { role?: unknown }).role === "user"
      ? [contentText((item as { content?: unknown }).content)]
      : [],
  );
}

function redactedFixtureLogs(instance: OpenClawTestInstance): string {
  return instance
    .logs()
    .replaceAll(GATEWAY_TOKEN, "[REDACTED]")
    .replace(/Bearer\s+\S+/giu, "Bearer [REDACTED]")
    .replace(/(["']?apiKey["']?\s*[:=]\s*)["'][^"']+["']/giu, "$1[REDACTED]")
    .replace(/harness_secret/giu, "[REDACTED]")
    .slice(-16_000);
}

describe("Feishu adoption gate at the gateway boundary (#54409)", () => {
  it.each(["steer", "collect", "followup"] as QueueMode[])(
    "releases the lane at adoption so a same-chat message reaches the %s queue policy while run 1 is active",
    async (queueMode) => {
      const fixture = await createGatewayFixture(`feishu-adoption-gate-${queueMode}`, queueMode);

      // The feishu channel webhook server binds during channel startup, after
      // the gateway reports ready; wait for the listener before injecting.
      await waitForWebhookListening(fixture, fixture.webhookPort, 30_000);

      // Message 1 arrives via the real webhook transport; the durable ack
      // proves signed admission completed end-to-end.
      const ackOne = await postFeishuMessage(fixture.webhookUrl, {
        eventId: "evt_harness_1",
        messageId: "om_harness_1",
        text: "MESSAGE_ONE",
      });
      expect(ackOne.status).toBe(200);
      expect(ackOne.headers.get("x-openclaw-delivery-accepted")).toBe("durable");

      // Run 1 reaches the mock provider and is held there (turn active).
      try {
        await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(1), WAIT_OPTS);
      } catch (error) {
        throw new Error(
          `first feishu message did not reach the mock provider\n` +
            redactedFixtureLogs(fixture.instance),
          { cause: error },
        );
      }

      // CHANGED-PATH PROOF: the second message reaches core's queue policy
      // while run 1 is still active. Baseline the stability seq BEFORE the
      // POST — the lane is already free (adoption), so message 2's dispatch
      // can complete during the POST itself and its events must not be
      // excluded by the sinceSeq filter. Steer parks the candidate and emits
      // message.queued with source "followup-queue-steer"; collect/followup
      // never park, but the dispatch lifecycle emits message.queued with
      // source "dispatch" the moment the lane is released (before admission).
      // Pre-fix, the message is not dispatched until run 1 completes and
      // neither event can exist during the hold.
      const baseline = await fixture.diagnosticsClient.request<{ lastSeq?: number }>(
        "diagnostics.stability",
        { type: "message.queued", limit: 1 },
      );
      const baselineSeq = baseline.lastSeq ?? 0;

      // Message 2 arrives while run 1 is still held.
      const ackTwo = await postFeishuMessage(fixture.webhookUrl, {
        eventId: "evt_harness_2",
        messageId: "om_harness_2",
        text: "MESSAGE_TWO",
      });
      expect(ackTwo.status).toBe(200);
      expect(ackTwo.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
      const queuedSource = queueMode === "steer" ? "followup-queue-steer" : "dispatch";
      try {
        await vi.waitFor(async () => {
          const queuedEvents = (
            await stabilityEvents(fixture, "message.queued", baselineSeq)
          ).filter((event) => event.type === "message.queued" && event.source === queuedSource);
          expect(queuedEvents).not.toHaveLength(0);
          expect(fixture.modelServer.requests).toHaveLength(1);
        }, WAIT_OPTS);
      } catch (error) {
        throw new Error(
          `second message was not queued while run 1 stayed active\n` +
            redactedFixtureLogs(fixture.instance),
          { cause: error },
        );
      }

      // Release run 1: the queued message is handled by the mode's policy
      // without starting a concurrent run — the follow-up model request must
      // carry MESSAGE_TWO.
      fixture.modelServer.releaseFirst();
      try {
        await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(2), WAIT_OPTS);
      } catch (error) {
        throw new Error(
          `no follow-up model request reached the mock provider\n` +
            redactedFixtureLogs(fixture.instance),
          { cause: error },
        );
      }
      // The follow-up request must carry MESSAGE_TWO; which user item holds it
      // varies by mode (steer merges into the active run, collect/followup
      // start a queued run), so scan every user item rather than a fixed slot.
      const handled = userInputs(fixture.modelServer.requests[1]).join("\n");
      expect(handled).toContain("MESSAGE_TWO");

      // The run finishes and the session returns to idle with an empty queue;
      // message 2 never starts its own concurrent run (no third model request).
      await vi.waitFor(async () => {
        const idleEvents = await stabilityEvents(fixture, "session.state");
        expect(
          idleEvents.some(
            (event) =>
              event.type === "session.state" && event.outcome === "idle" && event.queueDepth === 0,
          ),
        ).toBe(true);
      }, WAIT_OPTS);
      expect(fixture.modelServer.requests).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );
});

describe("Feishu comment adoption gate at the gateway boundary (#54409)", () => {
  it.each(["steer", "collect", "followup"] as QueueMode[])(
    "releases the same-document comment lane at adoption so a second notice reaches the %s queue policy while run 1 is active",
    async (queueMode) => {
      // Drive comment context resolution calls the Feishu Open API for
      // document meta and comment thread text. Point the account domain at a
      // dead local port so those calls fail instantly (requestFeishuOpenApi
      // degrades to an empty context and never throws) instead of waiting on
      // real network timeouts; the changed path under test is the document
      // queue lane, not the drive context fetch.
      const fixture = await createGatewayFixture(
        `feishu-comment-gate-${queueMode}`,
        queueMode,
        `https://127.0.0.1:${await getFreePort()}`,
      );

      // The feishu channel webhook server binds during channel startup, after
      // the gateway reports ready; wait for the listener before injecting.
      await waitForWebhookListening(fixture, fixture.webhookPort, 30_000);

      // Comment 1 arrives via the real webhook transport; the durable ack
      // proves signed admission completed end-to-end.
      const ackOne = await postFeishuComment(fixture.webhookUrl, {
        eventId: "evt_comment_1",
        commentId: "comment_harness_1",
      });
      expect(ackOne.status).toBe(200);
      expect(ackOne.headers.get("x-openclaw-delivery-accepted")).toBe("durable");

      // Run 1 reaches the mock provider and is held there (turn active).
      try {
        await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(1), WAIT_OPTS);
      } catch (error) {
        throw new Error(
          `first feishu comment notice did not reach the mock provider\n` +
            redactedFixtureLogs(fixture.instance),
          { cause: error },
        );
      }

      // CHANGED-PATH PROOF: the second same-document notice reaches core's
      // queue policy while run 1 is still active. Baseline the stability seq
      // BEFORE the POST, exactly as in the message harness — the document
      // lane is already free (adoption), so comment 2's dispatch can complete
      // during the POST itself. Pre-fix, the notice is not even dispatched
      // until run 1 completes and no `message.queued` event can exist during
      // the hold.
      const baseline = await fixture.diagnosticsClient.request<{ lastSeq?: number }>(
        "diagnostics.stability",
        { type: "message.queued", limit: 1 },
      );
      const baselineSeq = baseline.lastSeq ?? 0;

      // Comment 2 on the same document arrives while run 1 is still held.
      const ackTwo = await postFeishuComment(fixture.webhookUrl, {
        eventId: "evt_comment_2",
        commentId: "comment_harness_2",
      });
      expect(ackTwo.status).toBe(200);
      expect(ackTwo.headers.get("x-openclaw-delivery-accepted")).toBe("durable");
      const queuedSource = queueMode === "steer" ? "followup-queue-steer" : "dispatch";
      try {
        await vi.waitFor(async () => {
          const queuedEvents = (
            await stabilityEvents(fixture, "message.queued", baselineSeq)
          ).filter((event) => event.type === "message.queued" && event.source === queuedSource);
          expect(queuedEvents).not.toHaveLength(0);
          expect(fixture.modelServer.requests).toHaveLength(1);
        }, WAIT_OPTS);
      } catch (error) {
        throw new Error(
          `second comment notice was not queued while run 1 stayed active\n` +
            redactedFixtureLogs(fixture.instance),
          { cause: error },
        );
      }

      // Release run 1: the queued comment is handled by the mode's policy
      // without starting a concurrent run — the follow-up model request must
      // carry comment 2's event identity (the drive context fetch is degraded
      // in this harness, so the prompt itself only carries the boilerplate
      // surface; the event identity is the durable discriminator).
      fixture.modelServer.releaseFirst();
      try {
        await vi.waitFor(() => expect(fixture.modelServer.requests).toHaveLength(2), WAIT_OPTS);
      } catch (error) {
        throw new Error(
          `no follow-up model request reached the mock provider\n` +
            redactedFixtureLogs(fixture.instance),
          { cause: error },
        );
      }
      const handled = userInputs(fixture.modelServer.requests[1]).join("\n");
      expect(handled).toContain("evt_comment_2");

      // The run finishes and the session returns to idle with an empty queue;
      // comment 2 never starts its own concurrent run (no third model request).
      await vi.waitFor(async () => {
        const idleEvents = await stabilityEvents(fixture, "session.state");
        expect(
          idleEvents.some(
            (event) =>
              event.type === "session.state" && event.outcome === "idle" && event.queueDepth === 0,
          ),
        ).toBe(true);
      }, WAIT_OPTS);
      expect(fixture.modelServer.requests).toHaveLength(2);
    },
    TEST_TIMEOUT_MS,
  );
});
