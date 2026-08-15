import fs from "node:fs/promises";
import { createServer, type Server as HttpServer } from "node:http";
import net from "node:net";
import path from "node:path";
// Real Control UI/Gateway proof for queued follow-up recovery after missed terminal events.
import { asNullableRecord } from "@openclaw/normalization-core/record-coerce";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../../../src/config/config.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";
import type { GatewayServer } from "../../../src/gateway/server.js";
import { buildMockOpenAiResponsesProvider } from "../../../src/gateway/test-openai-responses-model.js";
import {
  createOpenClawTestState,
  type OpenClawTestState,
} from "../../../src/test-utils/openclaw-test-state.js";
import {
  canRunPlaywrightChromium,
  controlUiE2eWaitTimeoutMs,
  resolvePlaywrightChromiumExecutablePath,
  startControlUiE2eServer,
  type ControlUiE2eServer,
} from "../test-helpers/control-ui-e2e.ts";

const chromiumExecutablePath = resolvePlaywrightChromiumExecutablePath(chromium.executablePath());
const chromiumAvailable = canRunPlaywrightChromium(chromiumExecutablePath);
const allowMissingChromium = process.env.OPENCLAW_UI_E2E_ALLOW_MISSING_CHROMIUM === "1";
const describeRealGateway = chromiumAvailable || !allowMissingChromium ? describe : describe.skip;
const artifactDir = path.resolve(
  process.cwd(),
  process.env.OPENCLAW_UI_E2E_ARTIFACT_DIR?.trim() ||
    ".artifacts/control-ui-e2e/chat-flow-real-gateway",
);
const captureUiProof = process.env.OPENCLAW_CAPTURE_UI_PROOF === "1";
const authToken = "chat-flow-real-gateway-proof";
const firstPrompt = "REAL_GATEWAY_FIRST_TURN";
const followUp = "REAL_GATEWAY_FIFO_FOLLOW_UP";

type JsonRecord = Record<string, unknown>;

type TraceEntry = {
  direction: "browser-to-gateway" | "gateway-to-browser";
  kind: "event" | "request" | "response";
  method?: string;
  event?: string;
  dropped?: boolean;
  params?: JsonRecord;
  payload?: JsonRecord;
};

type RecoveryProxy = {
  armEventLoss: () => void;
  close: () => Promise<void>;
  droppedEvents: string[];
  firstRunId: string | null;
  port: number;
  trace: TraceEntry[];
  url: string;
};

let browser: Browser;
let context: BrowserContext;
let controlUi: ControlUiE2eServer;
let gateway: GatewayServer;
let providerServer: HttpServer;
let proxy: RecoveryProxy;
let state: OpenClawTestState;

function parseFrame(data: RawData): JsonRecord | null {
  try {
    const text = Array.isArray(data)
      ? Buffer.concat(data).toString("utf8")
      : data instanceof ArrayBuffer
        ? Buffer.from(data).toString("utf8")
        : data.toString("utf8");
    return asNullableRecord(JSON.parse(text));
  } catch {
    return null;
  }
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function getFreePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("failed to allocate a loopback port");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  return address.port;
}

function openAiResponseEvents(text: string, id: string): string {
  const message = {
    type: "message",
    id,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations: [] }],
  };
  return [
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { ...message, status: "in_progress", content: [] },
    },
    { type: "response.output_item.done", output_index: 0, item: message },
    {
      type: "response.completed",
      response: {
        status: "completed",
        usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 },
      },
    },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .concat("data: [DONE]\n\n")
    .join("");
}

async function startProvider(): Promise<{ baseUrl: string; server: HttpServer }> {
  let requestCount = 0;
  const server = createServer((_request, response) => {
    requestCount += 1;
    response.writeHead(200, { "content-type": "text/event-stream" });
    const finish = () => {
      response.end(
        openAiResponseEvents(
          requestCount === 1 ? "REAL_GATEWAY_FIRST_REPLY" : "REAL_GATEWAY_SECOND_REPLY",
          `real-gateway-proof-${requestCount}`,
        ),
      );
    };
    if (requestCount === 1) {
      setTimeout(finish, 2_000);
    } else {
      finish();
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("proof provider did not bind a loopback port");
  }
  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, server };
}

function terminalSessionEvent(frame: JsonRecord, firstRunId: string): boolean {
  const event = stringValue(frame.event);
  const payload = asNullableRecord(frame.payload);
  if (!payload) {
    return false;
  }
  if (event === "chat") {
    return (
      payload.runId === firstRunId &&
      ["final", "aborted", "error"].includes(stringValue(payload.state) ?? "")
    );
  }
  if (event !== "session.message" && event !== "sessions.changed") {
    return false;
  }
  const session = asNullableRecord(payload.session);
  const hasActiveRun = payload.hasActiveRun ?? session?.hasActiveRun;
  // The isolated proof setup owns one session. Intentionally lose every idle
  // publication until the exact-run watchdog starts, matching a browser that
  // missed both the terminal chat frame and the later session-state update.
  return hasActiveRun === false;
}

async function startRecoveryProxy(gatewayUrl: string): Promise<RecoveryProxy> {
  const trace: TraceEntry[] = [];
  const droppedEvents: string[] = [];
  const requestMethods = new Map<string, string>();
  const sockets = new Set<WebSocket>();
  const websocketServer = new WebSocketServer({ noServer: true });
  let droppedSequenceCount = 0;
  let firstRunId: string | null = null;
  let eventLossArmed = false;
  let recoveryStarted = false;
  let chatSendCount = 0;
  const server = createServer((_request, response) => response.writeHead(404).end());

  server.on("upgrade", (request, socket, head) => {
    websocketServer.handleUpgrade(request, socket, head, (browserSocket) => {
      const upstream = new WebSocket(gatewayUrl, {
        origin: typeof request.headers.origin === "string" ? request.headers.origin : undefined,
      });
      sockets.add(browserSocket);
      sockets.add(upstream);
      const pending: Array<{ data: RawData; isBinary: boolean }> = [];

      browserSocket.on("message", (data, isBinary) => {
        const frame = parseFrame(data);
        if (frame?.type === "req") {
          const id = stringValue(frame.id);
          const method = stringValue(frame.method);
          if (id && method) {
            requestMethods.set(id, method);
            if (method === "chat.send") {
              chatSendCount += 1;
            }
            if (method === "agent.wait") {
              recoveryStarted = true;
            }
            if (["chat.send", "agent.wait", "chat.history"].includes(method)) {
              trace.push({
                direction: "browser-to-gateway",
                kind: "request",
                method,
                params: asNullableRecord(frame.params) ?? undefined,
              });
            }
          }
        }
        if (upstream.readyState === WebSocket.OPEN) {
          upstream.send(data, { binary: isBinary });
        } else {
          pending.push({ data, isBinary });
        }
      });

      upstream.on("open", () => {
        for (const frame of pending.splice(0)) {
          upstream.send(frame.data, { binary: frame.isBinary });
        }
      });

      upstream.on("message", (data, isBinary) => {
        const frame = parseFrame(data);
        if (frame?.type === "res") {
          const id = stringValue(frame.id);
          const method = id ? requestMethods.get(id) : undefined;
          const payload = asNullableRecord(frame.payload);
          if (method === "chat.send" && chatSendCount === 1 && payload) {
            firstRunId = stringValue(payload.runId);
          }
          if (method && ["chat.send", "agent.wait", "chat.history"].includes(method)) {
            trace.push({
              direction: "gateway-to-browser",
              kind: "response",
              method,
              payload: payload ?? undefined,
            });
          }
        }
        const event = frame?.type === "event" ? stringValue(frame.event) : null;
        const isFirstRunTerminal = Boolean(
          firstRunId && frame && terminalSessionEvent(frame, firstRunId),
        );
        const isMissedSessionUpdate =
          eventLossArmed && (event === "session.message" || event === "sessions.changed");
        if (!recoveryStarted && (isFirstRunTerminal || isMissedSessionUpdate)) {
          const droppedEvent = event ?? "unknown";
          droppedEvents.push(droppedEvent);
          trace.push({
            direction: "gateway-to-browser",
            dropped: true,
            event: droppedEvent,
            kind: "event",
          });
          if (typeof frame?.seq === "number") {
            droppedSequenceCount += 1;
          }
          return;
        }
        if (
          frame?.type === "event" &&
          ["chat", "session.message", "sessions.changed"].includes(stringValue(frame.event) ?? "")
        ) {
          trace.push({
            direction: "gateway-to-browser",
            dropped: false,
            event: stringValue(frame.event) ?? "unknown",
            kind: "event",
          });
        }
        if (browserSocket.readyState === WebSocket.OPEN) {
          if (event && droppedSequenceCount > 0 && typeof frame?.seq === "number") {
            browserSocket.send(JSON.stringify({ ...frame, seq: frame.seq - droppedSequenceCount }));
          } else {
            browserSocket.send(data, { binary: isBinary });
          }
        }
      });

      const closePeer = (peerSocket: WebSocket) => {
        sockets.delete(peerSocket);
        if (
          peerSocket.readyState === WebSocket.OPEN ||
          peerSocket.readyState === WebSocket.CONNECTING
        ) {
          peerSocket.close();
        }
      };
      browserSocket.on("close", () => closePeer(upstream));
      upstream.on("close", () => closePeer(browserSocket));
      browserSocket.on("error", () => closePeer(upstream));
      upstream.on("error", () => closePeer(browserSocket));
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("recovery proxy did not bind a loopback port");
  }
  return {
    armEventLoss: () => {
      eventLossArmed = true;
    },
    close: async () => {
      for (const socket of sockets) {
        socket.terminate();
      }
      sockets.clear();
      await new Promise<void>((resolve, reject) => {
        websocketServer.close(() => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      });
    },
    droppedEvents,
    get firstRunId() {
      return firstRunId;
    },
    port: address.port,
    trace,
    url: `ws://127.0.0.1:${address.port}`,
  };
}

function requests(method: string): TraceEntry[] {
  return proxy.trace.filter((entry) => entry.kind === "request" && entry.method === method);
}

async function screenshot(page: Page, fileName: string): Promise<void> {
  if (!captureUiProof) {
    return;
  }
  await page.screenshot({ path: path.join(artifactDir, fileName), fullPage: true });
}

describeRealGateway("Control UI queued follow-up recovery with a real Gateway", () => {
  beforeAll(async () => {
    if (!chromiumAvailable) {
      throw new Error(`Playwright Chromium is unavailable at ${chromiumExecutablePath}`);
    }
    await fs.mkdir(artifactDir, { recursive: true });
    controlUi = await startControlUiE2eServer(undefined, { source: true });
    const provider = await startProvider();
    providerServer = provider.server;
    const model = buildMockOpenAiResponsesProvider(provider.baseUrl);
    const gatewayPort = await getFreePort();
    state = await createOpenClawTestState({
      label: "chat-flow-real-gateway",
      layout: "home",
      env: {
        OPENCLAW_DISABLE_BUNDLED_PLUGINS: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
        VITEST: "1",
      },
    });
    const cfg: OpenClawConfig = {
      agents: {
        defaults: {
          model: { primary: model.modelRef },
          models: {
            [model.modelRef]: { params: { openaiWsWarmup: false, transport: "sse" } },
          },
          skipBootstrap: true,
          workspace: state.workspaceDir,
        },
      },
      gateway: {
        auth: { mode: "token", token: authToken },
        controlUi: { allowedOrigins: [new URL(controlUi.baseUrl).origin], enabled: false },
        port: gatewayPort,
      },
      models: { mode: "replace", providers: { [model.providerId]: model.config } },
      ui: { prefs: { chatFollowUpMode: "queue" } },
    };
    await state.writeConfig(cfg);
    state.applyEnv();
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    const { startGatewayServer } = await import("../../../src/gateway/server.js");
    gateway = await startGatewayServer(gatewayPort, {
      auth: { mode: "token", token: authToken },
      bind: "loopback",
      controlUiEnabled: false,
      sidecarStartup: "defer",
    });
    proxy = await startRecoveryProxy(`ws://127.0.0.1:${gatewayPort}`);
    browser = await chromium.launch({ executablePath: chromiumExecutablePath });
    context = await browser.newContext({
      locale: "en-US",
      recordVideo: captureUiProof
        ? { dir: artifactDir, size: { height: 900, width: 1280 } }
        : undefined,
      serviceWorkers: "block",
      viewport: { height: 900, width: 1280 },
    });
  }, 120_000);

  afterAll(async () => {
    const cleanup = [];
    for (const operation of [
      () => context?.close(),
      () => browser?.close(),
      () => proxy?.close(),
      () => gateway?.close({ reason: "real queued follow-up proof complete" }),
      () => controlUi?.close(),
      () =>
        providerServer
          ? new Promise<void>((resolve) => {
              providerServer.close(() => {
                resolve();
              });
            })
          : Promise.resolve(),
    ]) {
      try {
        await operation();
        cleanup.push({ status: "fulfilled" as const });
      } catch (reason) {
        cleanup.push({ reason, status: "rejected" as const });
      }
    }
    clearConfigCache();
    clearRuntimeConfigSnapshot();
    state?.restoreEnv();
    await state?.cleanup();
    expect(
      cleanup
        .filter((result) => result.status === "rejected")
        .map((result) => String(result.reason)),
    ).toEqual([]);
  }, 60_000);

  it(
    "uses agent.wait, reloads history, and drains FIFO after terminal events are missed",
    { timeout: 90_000 },
    async () => {
      const page = await context.newPage();
      page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
      await page.addInitScript(
        ({ gatewayUrl, token }) => {
          (
            window as Window & {
              ["__OPENCLAW_NATIVE_CONTROL_AUTH__"]?: { gatewayUrl: string; token: string };
            }
          )["__OPENCLAW_NATIVE_CONTROL_AUTH__"] = { gatewayUrl, token };
        },
        { gatewayUrl: proxy.url, token: authToken },
      );

      expect((await page.goto(`${controlUi.baseUrl}chat?session=main`))?.status()).toBe(200);
      await page.locator("openclaw-app-shell").waitFor({ timeout: 60_000 });
      await expect.poll(() => new URL(page.url()).pathname).toMatch(/\/chat\/main$/u);

      const composer = page.locator(".agent-chat__composer-combobox textarea");
      await composer.fill(firstPrompt);
      await page.getByRole("button", { name: "Send message" }).click();
      await expect.poll(() => requests("chat.send").length).toBe(1);
      await page.getByRole("button", { name: "Stop generating" }).waitFor();

      await composer.fill(followUp);
      await page.getByRole("button", { name: "Queue message" }).click();
      const queue = page.locator(".chat-queue");
      await queue.getByText(followUp).waitFor();
      proxy.armEventLoss();
      await screenshot(page, "01-real-gateway-queued-after-dropped-events.png");

      await expect.poll(() => proxy.firstRunId).toMatch(/^[-A-Za-z0-9_]+$/u);
      const browserRunState = await page.locator("openclaw-chat-pane").evaluate((element) => {
        const paneState = (
          element as HTMLElement & {
            state?: {
              chatRunId?: unknown;
              connected?: unknown;
            };
          }
        ).state;
        return {
          chatRunId: paneState?.chatRunId,
          connected: paneState?.connected,
        };
      });
      expect(browserRunState).toMatchObject({
        chatRunId: proxy.firstRunId,
        connected: true,
      });
      await expect.poll(() => proxy.droppedEvents.includes("chat"), { timeout: 15_000 }).toBe(true);
      expect(
        proxy.droppedEvents.some(
          (event) => event === "session.message" || event === "sessions.changed",
        ),
      ).toBe(true);
      expect(requests("chat.send")).toHaveLength(1);
      await expect
        .poll(() => requests("agent.wait").length, { timeout: 25_000 })
        .toBeGreaterThan(0);
      const waitRequest = requests("agent.wait")[0];
      expect(waitRequest?.params).toMatchObject({ runId: proxy.firstRunId, timeoutMs: 50 });

      await expect.poll(() => requests("chat.send").length).toBe(2);
      const secondSend = requests("chat.send")[1];
      expect(secondSend?.params).toMatchObject({ message: followUp });
      const waitIndex = proxy.trace.indexOf(waitRequest as TraceEntry);
      const historyIndex = proxy.trace.findIndex(
        (entry, index) =>
          index > waitIndex && entry.kind === "request" && entry.method === "chat.history",
      );
      const secondSendIndex = proxy.trace.indexOf(secondSend as TraceEntry);
      expect(historyIndex).toBeGreaterThan(waitIndex);
      expect(historyIndex).toBeLessThan(secondSendIndex);

      await queue.waitFor({ state: "detached", timeout: 15_000 });
      await page
        .getByRole("paragraph")
        .filter({ hasText: /^REAL_GATEWAY_SECOND_REPLY$/u })
        .waitFor();
      await screenshot(page, "02-real-gateway-recovered-fifo-delivered.png");

      const proof = {
        setup: {
          browser: "Chromium via Playwright",
          controlUi: "source-served production Control UI",
          gateway: "real in-process Gateway over loopback WebSocket",
          provider: "loopback OpenAI Responses SSE transport",
          sessionStore: "isolated real OpenClaw state",
        },
        missedEvents: [...new Set(proxy.droppedEvents)].toSorted(),
        recovery: {
          exactRunAgentWait: waitRequest?.params?.runId === proxy.firstRunId,
          agentWaitTimeoutMs: waitRequest?.params?.timeoutMs,
          historyReloadAfterWait: waitIndex < historyIndex,
          fifoSendAfterHistory: historyIndex < secondSendIndex,
          queuedMessage: followUp,
          queueCleared: (await queue.count()) === 0,
          secondAssistantVisible: true,
        },
        trace: proxy.trace.map((entry) => ({
          direction: entry.direction,
          dropped: entry.dropped,
          event: entry.event,
          kind: entry.kind,
          method: entry.method,
          params:
            entry.direction === "browser-to-gateway" && entry.method === "agent.wait"
              ? {
                  runId: entry.params?.runId === proxy.firstRunId ? "<first-run-id>" : "<other>",
                  timeoutMs: entry.params?.timeoutMs,
                }
              : entry.direction === "browser-to-gateway" && entry.method === "chat.send"
                ? { message: entry.params?.message }
                : entry.direction === "browser-to-gateway" && entry.method === "chat.history"
                  ? { limit: entry.params?.limit, sessionKey: entry.params?.sessionKey }
                  : undefined,
          payload:
            entry.direction === "gateway-to-browser" && entry.method === "agent.wait"
              ? { status: entry.payload?.status }
              : entry.direction === "gateway-to-browser" && entry.method === "chat.send"
                ? { runId: "<redacted>", status: entry.payload?.status }
                : undefined,
        })),
      };
      await fs.writeFile(
        path.join(artifactDir, "real-gateway-recovery-proof.json"),
        `${JSON.stringify(proof, null, 2)}\n`,
      );
      expect(proof.recovery).toMatchObject({
        exactRunAgentWait: true,
        fifoSendAfterHistory: true,
        historyReloadAfterWait: true,
        queueCleared: true,
        secondAssistantVisible: true,
      });
    },
  );
});
