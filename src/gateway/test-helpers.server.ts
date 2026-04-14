import fs from "node:fs/promises";
import { type AddressInfo, createServer } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, expect, vi } from "vitest";
import { WebSocket } from "ws";
import "./test-helpers.mocks.js";
import { parseConfigJson5, resetConfigRuntimeState } from "../config/config.js";
import {
  clearSessionStoreCacheForTest,
  resolveMainSessionKeyFromConfig,
  type SessionEntry,
} from "../config/sessions.js";
import { resetAgentRunContextForTest } from "../infra/agent-events.js";
import {
  loadOrCreateDeviceIdentity,
  publicKeyRawBase64UrlFromPem,
  signDevicePayload,
} from "../infra/device-identity.js";
import { drainSystemEvents, peekSystemEvents } from "../infra/system-events.js";
import { rawDataToString } from "../infra/ws.js";
import { resetLogger, setLoggerOverride } from "../logging.js";
import { clearGatewaySubagentRuntime } from "../plugins/runtime/index.js";
import {
  DEFAULT_AGENT_ID,
  normalizeMainKey,
  parseAgentSessionKey,
  toAgentStoreSessionKey,
} from "../routing/session-key.js";
import { normalizeLowercaseStringOrEmpty } from "../shared/string-coerce.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { captureEnv } from "../test-utils/env.js";
import { getDeterministicFreePortBlock } from "../test-utils/ports.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { buildDeviceAuthPayloadV3 } from "./device-auth.js";
import { PROTOCOL_VERSION } from "./protocol/index.js";
import type { GatewayServerOptions } from "./server.js";
import { resetTestPluginRegistry } from "./test-helpers.plugin-registry.js";
import {
  agentCommand,
  cronIsolatedRun,
  embeddedRunMock,
  getReplyFromConfig,
  piSdkMock,
  sendWhatsAppMock,
  sessionStoreSaveDelayMs,
  setTestConfigRoot,
  testIsNixMode,
  testTailscaleWhois,
  testState,
  testTailnetIPv4,
} from "./test-helpers.runtime-state.js";

// Import lazily after test env/home setup so config/session paths resolve to test dirs.
// Keep one cached module per worker for speed.
let serverModulePromise: Promise<typeof import("./server.js")> | undefined;

async function getServerModule() {
  serverModulePromise ??= import("./server.js");
  return await serverModulePromise;
}

const GATEWAY_TEST_ENV_KEYS = [
  "HOME",
  "USERPROFILE",
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_BUNDLED_PLUGINS_DIR",
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
] as const;

let gatewayEnvSnapshot: ReturnType<typeof captureEnv> | undefined;
let tempHome: string | undefined;
let tempConfigRoot: string | undefined;
let tempControlUiRoot: string | undefined;
let suiteConfigRootSeq = 0;
let lastSyncedSessionStorePath: string | undefined;
let lastSyncedSessionConfigJson: string | undefined;
let activeSuiteGatewayServerCount = 0;
let activeSuiteHookScopeCount = 0;

function resolveGatewayTestMainSessionKeys(): string[] {
  const resolved = resolveMainSessionKeyFromConfig();
  const keys = new Set<string>();
  if (resolved) {
    keys.add(resolved);
  }
  if (resolved !== "global") {
    const parsed = parseAgentSessionKey(resolved);
    const agentId = parsed?.agentId ?? DEFAULT_AGENT_ID;
    keys.add(`agent:${agentId}:main`);
    const configuredMainKey = normalizeMainKey(
      (testState.sessionConfig as { mainKey?: unknown } | undefined)?.mainKey as string | undefined,
    );
    keys.add(`agent:${agentId}:${configuredMainKey}`);
  }
  return [...keys];
}

function serializeGatewayTestSessionConfig(): string | undefined {
  if (!testState.sessionConfig) {
    return undefined;
  }
  return JSON.stringify(testState.sessionConfig);
}

function hasUnsyncedGatewayTestSessionConfig(): boolean {
  return (
    testState.sessionStorePath !== lastSyncedSessionStorePath ||
    serializeGatewayTestSessionConfig() !== lastSyncedSessionConfigJson
  );
}

async function persistTestSessionConfig(): Promise<void> {
  const configPaths = new Set<string>();
  if (process.env.OPENCLAW_CONFIG_PATH) {
    configPaths.add(process.env.OPENCLAW_CONFIG_PATH);
  }
  if (process.env.OPENCLAW_STATE_DIR) {
    configPaths.add(path.join(process.env.OPENCLAW_STATE_DIR, "openclaw.json"));
  }
  const parsedConfigs = new Map<string, Record<string, unknown>>();
  let preservedTemplateStore: string | undefined;
  for (const configPath of configPaths) {
    let config: Record<string, unknown> = {};
    try {
      const raw = await fs.readFile(configPath, "utf-8");
      const parsed = parseConfigJson5(raw);
      if (
        parsed.ok &&
        parsed.parsed &&
        typeof parsed.parsed === "object" &&
        !Array.isArray(parsed.parsed)
      ) {
        config = parsed.parsed as Record<string, unknown>;
      }
    } catch {
      config = {};
    }
    parsedConfigs.set(configPath, config);
    const session =
      config.session && typeof config.session === "object" && !Array.isArray(config.session)
        ? (config.session as Record<string, unknown>)
        : undefined;
    const existingStore = typeof session?.store === "string" ? session.store.trim() : "";
    if (!preservedTemplateStore && existingStore.includes("{agentId}")) {
      preservedTemplateStore = existingStore;
    }
  }
  const nextStoreValue =
    typeof testState.sessionStorePath === "string"
      ? preservedTemplateStore || testState.sessionStorePath
      : preservedTemplateStore;
  for (const configPath of configPaths) {
    const config = { ...parsedConfigs.get(configPath) };
    const session =
      config.session && typeof config.session === "object" && !Array.isArray(config.session)
        ? { ...(config.session as Record<string, unknown>) }
        : {};
    delete session.mainKey;
    delete session.store;
    if (typeof nextStoreValue === "string" && nextStoreValue.trim().length > 0) {
      session.store = nextStoreValue;
    }
    if (testState.sessionConfig) {
      Object.assign(session, testState.sessionConfig);
    }
    if (Object.keys(session).length > 0) {
      config.session = session;
    } else {
      delete config.session;
    }
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf-8");
  }
  resetConfigRuntimeState();
  lastSyncedSessionStorePath = testState.sessionStorePath;
  lastSyncedSessionConfigJson = serializeGatewayTestSessionConfig();
}

export async function writeSessionStore(params: {
  entries: Record<string, Partial<SessionEntry>>;
  storePath?: string;
  agentId?: string;
  mainKey?: string;
}): Promise<void> {
  const storePath = params.storePath ?? testState.sessionStorePath;
  if (!storePath) {
    throw new Error("writeSessionStore requires testState.sessionStorePath");
  }
  const agentId = params.agentId ?? DEFAULT_AGENT_ID;
  const store: Record<string, Partial<SessionEntry>> = {};
  for (const [requestKey, entry] of Object.entries(params.entries)) {
    const rawKey = requestKey.trim();
    const storeKey =
      rawKey === "global" || rawKey === "unknown"
        ? rawKey
        : toAgentStoreSessionKey({
            agentId,
            requestKey,
            mainKey: params.mainKey,
          });
    store[storeKey] = entry;
  }
  // Gateway suites often reuse the same store path across tests while writing the
  // file directly; clear the in-process cache so handlers reload the seeded state.
  clearSessionStoreCacheForTest();
  await persistTestSessionConfig();
  await fs.mkdir(path.dirname(storePath), { recursive: true });
  await fs.writeFile(storePath, JSON.stringify(store, null, 2), "utf-8");
  clearSessionStoreCacheForTest();
}

async function setupGatewayTestHome() {
  gatewayEnvSnapshot = captureEnv([...GATEWAY_TEST_ENV_KEYS]);
  tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-gateway-home-"));
  process.env.HOME = tempHome;
  process.env.USERPROFILE = tempHome;
  process.env.OPENCLAW_STATE_DIR = path.join(tempHome, ".openclaw");
  delete process.env.OPENCLAW_CONFIG_PATH;
}

function applyGatewaySkipEnv() {
  process.env.OPENCLAW_SKIP_BROWSER_CONTROL_SERVER = "1";
  process.env.OPENCLAW_SKIP_GMAIL_WATCHER = "1";
  process.env.OPENCLAW_SKIP_CANVAS_HOST = "1";
  process.env.OPENCLAW_SKIP_CHANNELS = "1";
  process.env.OPENCLAW_SKIP_PROVIDERS = "1";
  process.env.OPENCLAW_SKIP_CRON = "1";
  process.env.OPENCLAW_TEST_MINIMAL_GATEWAY = "1";
  process.env.OPENCLAW_BUNDLED_PLUGINS_DIR = tempHome
    ? path.join(tempHome, "openclaw-test-no-bundled-extensions")
    : "openclaw-test-no-bundled-extensions";
}

async function resetGatewayTestState(options: { uniqueConfigRoot: boolean }) {
  // Some tests intentionally use fake timers; ensure they don't leak into gateway suites.
  vi.useRealTimers();
  setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  if (!tempHome) {
    throw new Error("resetGatewayTestState called before temp home was initialized");
  }
  applyGatewaySkipEnv();
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  const stateDir = process.env.OPENCLAW_STATE_DIR;
  if (stateDir) {
    await fs.rm(stateDir, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
    await fs.mkdir(stateDir, { recursive: true });
  }
  if (options.uniqueConfigRoot) {
    const suiteRoot = path.join(tempHome, ".openclaw-test-suite");
    await fs.mkdir(suiteRoot, { recursive: true });
    tempConfigRoot = path.join(suiteRoot, `case-${suiteConfigRootSeq++}`);
    await fs.rm(tempConfigRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
    await fs.mkdir(tempConfigRoot, { recursive: true });
  } else {
    tempConfigRoot = path.join(tempHome, ".openclaw-test");
    await fs.rm(tempConfigRoot, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
    await fs.mkdir(tempConfigRoot, { recursive: true });
  }
  setTestConfigRoot(tempConfigRoot);
  tempControlUiRoot = path.join(tempHome, ".openclaw-test-control-ui");
  await fs.rm(tempControlUiRoot, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 25,
  });
  await fs.mkdir(tempControlUiRoot, { recursive: true });
  await fs.writeFile(
    path.join(tempControlUiRoot, "index.html"),
    "<!doctype html><title>openclaw-test-control-ui</title>\n",
    "utf-8",
  );
  setTestConfigRoot(tempConfigRoot);
  resetConfigRuntimeState();
  resetTestPluginRegistry();
  clearGatewaySubagentRuntime();
  sessionStoreSaveDelayMs.value = 0;
  testTailnetIPv4.value = undefined;
  testTailscaleWhois.value = null;
  testState.gatewayBind = undefined;
  testState.gatewayAuth = { mode: "token", token: "test-gateway-token-1234567890" };
  testState.gatewayControlUi = undefined;
  testState.hooksConfig = undefined;
  testState.canvasHostPort = undefined;
  testState.legacyIssues = [];
  testState.legacyParsed = {};
  testState.migrationConfig = null;
  testState.migrationChanges = [];
  testState.cronEnabled = false;
  testState.cronStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.sessionStorePath = undefined;
  testState.agentConfig = undefined;
  testState.agentsConfig = undefined;
  testState.bindingsConfig = undefined;
  testState.channelsConfig = undefined;
  testState.allowFrom = undefined;
  lastSyncedSessionStorePath = testState.sessionStorePath;
  lastSyncedSessionConfigJson = serializeGatewayTestSessionConfig();
  testIsNixMode.value = false;
  cronIsolatedRun.mockReset();
  cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "ok" });
  agentCommand.mockReset();
  agentCommand.mockResolvedValue(undefined);
  getReplyFromConfig.mockReset();
  getReplyFromConfig.mockResolvedValue(undefined);
  sendWhatsAppMock.mockReset();
  sendWhatsAppMock.mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" });
  embeddedRunMock.activeIds.clear();
  embeddedRunMock.abortCalls = [];
  embeddedRunMock.waitCalls = [];
  embeddedRunMock.waitResults.clear();
  embeddedRunMock.compactEmbeddedPiSession.mockReset();
  embeddedRunMock.compactEmbeddedPiSession.mockResolvedValue({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });
  for (const sessionKey of resolveGatewayTestMainSessionKeys()) {
    drainSystemEvents(sessionKey);
  }
  resetAgentRunContextForTest();
  const mod = await getServerModule();
  await mod.__resetModelCatalogCacheForTest();
  piSdkMock.enabled = false;
  piSdkMock.discoverCalls = 0;
  piSdkMock.models = [];
}

async function cleanupGatewayTestHome(options: { restoreEnv: boolean }) {
  vi.useRealTimers();
  clearGatewaySubagentRuntime();
  resetLogger();
  if (options.restoreEnv) {
    gatewayEnvSnapshot?.restore();
    gatewayEnvSnapshot = undefined;
  }
  if (options.restoreEnv && tempHome) {
    await fs.rm(tempHome, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
    tempHome = undefined;
  }
  tempConfigRoot = undefined;
  tempControlUiRoot = undefined;
  if (options.restoreEnv) {
    suiteConfigRootSeq = 0;
  }
}

async function resetGatewayTestRuntimeOnly() {
  vi.useRealTimers();
  setLoggerOverride({ level: "silent", consoleLevel: "silent" });
  applyGatewaySkipEnv();
  delete process.env.OPENCLAW_GATEWAY_TOKEN;
  resetConfigRuntimeState();
  resetTestPluginRegistry();
  clearGatewaySubagentRuntime();
  sessionStoreSaveDelayMs.value = 0;
  testTailnetIPv4.value = undefined;
  testTailscaleWhois.value = null;
  testState.gatewayBind = undefined;
  testState.gatewayAuth = { mode: "token", token: "test-gateway-token-1234567890" };
  testState.gatewayControlUi = undefined;
  testState.hooksConfig = undefined;
  testState.canvasHostPort = undefined;
  testState.legacyIssues = [];
  testState.legacyParsed = {};
  testState.migrationConfig = null;
  testState.migrationChanges = [];
  testState.cronEnabled = false;
  testState.cronStorePath = undefined;
  testState.sessionConfig = undefined;
  testState.sessionStorePath = undefined;
  testState.agentConfig = undefined;
  testState.agentsConfig = undefined;
  testState.bindingsConfig = undefined;
  testState.channelsConfig = undefined;
  testState.allowFrom = undefined;
  lastSyncedSessionStorePath = testState.sessionStorePath;
  lastSyncedSessionConfigJson = serializeGatewayTestSessionConfig();
  testIsNixMode.value = false;
  cronIsolatedRun.mockReset();
  cronIsolatedRun.mockResolvedValue({ status: "ok", summary: "ok" });
  agentCommand.mockReset();
  agentCommand.mockResolvedValue(undefined);
  getReplyFromConfig.mockReset();
  getReplyFromConfig.mockResolvedValue(undefined);
  sendWhatsAppMock.mockReset();
  sendWhatsAppMock.mockResolvedValue({ messageId: "msg-1", toJid: "jid-1" });
  embeddedRunMock.activeIds.clear();
  embeddedRunMock.abortCalls = [];
  embeddedRunMock.waitCalls = [];
  embeddedRunMock.waitResults.clear();
  embeddedRunMock.compactEmbeddedPiSession.mockReset();
  embeddedRunMock.compactEmbeddedPiSession.mockResolvedValue({
    ok: true,
    compacted: true,
    result: {
      summary: "summary",
      firstKeptEntryId: "entry-1",
      tokensBefore: 120,
      tokensAfter: 80,
    },
  });
  clearSessionStoreCacheForTest();
  await persistTestSessionConfig();
  for (const sessionKey of resolveGatewayTestMainSessionKeys()) {
    drainSystemEvents(sessionKey);
  }
  resetAgentRunContextForTest();
}

export function installGatewayTestHooks(options?: { scope?: "test" | "suite" }) {
  const scope = options?.scope ?? "test";
  if (scope === "suite") {
    beforeAll(async () => {
      if (activeSuiteHookScopeCount === 0) {
        await setupGatewayTestHome();
        await resetGatewayTestState({ uniqueConfigRoot: false });
      }
      activeSuiteHookScopeCount += 1;
    });
    beforeEach(async () => {
      if (activeSuiteGatewayServerCount > 0) {
        await resetGatewayTestRuntimeOnly();
        return;
      }
      await resetGatewayTestState({ uniqueConfigRoot: false });
    }, 60_000);
    afterEach(async () => {
      if (activeSuiteGatewayServerCount > 0) {
        vi.useRealTimers();
        return;
      }
      await cleanupGatewayTestHome({ restoreEnv: false });
    });
    afterAll(async () => {
      activeSuiteHookScopeCount = Math.max(0, activeSuiteHookScopeCount - 1);
      if (activeSuiteHookScopeCount === 0) {
        await cleanupGatewayTestHome({ restoreEnv: true });
      }
    }, 300_000);
    return;
  }

  beforeEach(async () => {
    await setupGatewayTestHome();
    await resetGatewayTestState({ uniqueConfigRoot: false });
  }, 60_000);

  afterEach(async () => {
    await cleanupGatewayTestHome({ restoreEnv: true });
  });
}

export async function getFreePort(): Promise<number> {
  return await getDeterministicFreePortBlock({ offsets: [0, 1, 2, 3, 4] });
}

export async function occupyPort(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
}> {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({ server, port });
    });
  });
}

type GatewayTestMessage = {
  type?: string;
  id?: string;
  ok?: boolean;
  event?: string;
  payload?: Record<string, unknown> | null;
  seq?: number;
  stateVersion?: Record<string, unknown>;
  [key: string]: unknown;
};

const CONNECT_CHALLENGE_NONCE_KEY = "__openclawTestConnectChallengeNonce";
const CONNECT_CHALLENGE_TRACKED_KEY = "__openclawTestConnectChallengeTracked";
type TrackedWs = WebSocket & Record<string, unknown>;

export function getTrackedConnectChallengeNonce(ws: WebSocket): string | undefined {
  const tracked = (ws as TrackedWs)[CONNECT_CHALLENGE_NONCE_KEY];
  return typeof tracked === "string" && tracked.trim().length > 0 ? tracked.trim() : undefined;
}

export function trackConnectChallengeNonce(ws: WebSocket): void {
  const trackedWs = ws as TrackedWs;
  if (trackedWs[CONNECT_CHALLENGE_TRACKED_KEY] === true) {
    return;
  }
  trackedWs[CONNECT_CHALLENGE_TRACKED_KEY] = true;
  ws.on("message", (data) => {
    try {
      const obj = JSON.parse(rawDataToString(data)) as GatewayTestMessage;
      if (obj.type !== "event" || obj.event !== "connect.challenge") {
        return;
      }
      const nonce = (obj.payload as { nonce?: unknown } | undefined)?.nonce;
      if (typeof nonce === "string" && nonce.trim().length > 0) {
        trackedWs[CONNECT_CHALLENGE_NONCE_KEY] = nonce.trim();
      }
    } catch {
      // ignore parse errors in nonce tracker
    }
  });
}

export function onceMessage<T extends GatewayTestMessage = GatewayTestMessage>(
  ws: WebSocket,
  filter: (obj: T) => boolean,
  // Full-suite runs can saturate the event loop (581+ files). Keep this high
  // enough to avoid flaky RPC timeouts, but still fail fast when a response
  // never arrives.
  timeoutMs = 10_000,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    const closeHandler = (code: number, reason: Buffer) => {
      clearTimeout(timer);
      ws.off("message", handler);
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    const handler = (data: WebSocket.RawData) => {
      const obj = JSON.parse(rawDataToString(data)) as T;
      if (filter(obj)) {
        clearTimeout(timer);
        ws.off("message", handler);
        ws.off("close", closeHandler);
        resolve(obj);
      }
    };
    ws.on("message", handler);
    ws.once("close", closeHandler);
  });
}

export async function startGatewayServer(port: number, opts?: GatewayServerOptions) {
  const mod = await getServerModule();
  const resolvedOpts =
    opts?.controlUiEnabled === undefined ? { ...opts, controlUiEnabled: false } : opts;
  if (
    resolvedOpts?.controlUiEnabled === true &&
    process.env.OPENCLAW_TEST_MINIMAL_GATEWAY === "1" &&
    tempControlUiRoot &&
    typeof (testState.gatewayControlUi as { root?: unknown } | undefined)?.root !== "string"
  ) {
    testState.gatewayControlUi = {
      ...testState.gatewayControlUi,
      root: tempControlUiRoot,
    };
  }
  const server = await mod.startGatewayServer(port, resolvedOpts);
  activeSuiteGatewayServerCount += 1;
  const originalClose = server.close.bind(server);
  let closed = false;
  server.close = (async (...args: Parameters<typeof originalClose>) => {
    try {
      return await originalClose(...args);
    } finally {
      if (!closed) {
        closed = true;
        activeSuiteGatewayServerCount = Math.max(0, activeSuiteGatewayServerCount - 1);
      }
    }
  }) as typeof server.close;
  return server;
}

export async function startGatewayServerWithRetries(params: {
  port: number;
  opts?: GatewayServerOptions;
}): Promise<{ port: number; server: Awaited<ReturnType<typeof startGatewayServer>> }> {
  let port = params.port;
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return {
        port,
        server: await startGatewayServer(port, params.opts),
      };
    } catch (err) {
      const code = (err as { cause?: { code?: string } }).cause?.code;
      if (code !== "EADDRINUSE") {
        throw err;
      }
      port = await getFreePort();
    }
  }
  throw new Error("failed to start gateway server after retries");
}

async function waitForWebSocketOpen(ws: WebSocket, timeoutMs = 10_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      ws.off("error", onError);
      ws.off("close", onClose);
    };
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = (err: unknown) => {
      cleanup();
      reject(err instanceof Error ? err : new Error(String(err)));
    };
    const onClose = (code: number, reason: Buffer) => {
      cleanup();
      reject(new Error(`closed ${code}: ${reason.toString()}`));
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
    ws.once("close", onClose);
  });
}

async function openTrackedWebSocket(params: {
  port: number;
  headers?: Record<string, string>;
}): Promise<WebSocket> {
  const ws = new WebSocket(
    `ws://127.0.0.1:${params.port}`,
    params.headers ? { headers: params.headers } : undefined,
  );
  trackConnectChallengeNonce(ws);
  await waitForWebSocketOpen(ws);
  return ws;
}

export async function withGatewayServer<T>(
  fn: (ctx: { port: number; server: Awaited<ReturnType<typeof startGatewayServer>> }) => Promise<T>,
  opts?: { port?: number; serverOptions?: GatewayServerOptions },
): Promise<T> {
  const started = await startGatewayServerWithRetries({
    port: opts?.port ?? (await getFreePort()),
    opts: opts?.serverOptions,
  });
  try {
    return await fn({ port: started.port, server: started.server });
  } finally {
    await started.server.close();
  }
}

export async function createGatewaySuiteHarness(opts?: {
  port?: number;
  serverOptions?: GatewayServerOptions;
}): Promise<{
  port: number;
  server: Awaited<ReturnType<typeof startGatewayServer>>;
  openWs: (headers?: Record<string, string>) => Promise<WebSocket>;
  close: () => Promise<void>;
}> {
  const started = await startGatewayServerWithRetries({
    port: opts?.port ?? (await getFreePort()),
    opts: opts?.serverOptions,
  });
  return {
    port: started.port,
    server: started.server,
    openWs: async (headers?: Record<string, string>) => {
      return await openTrackedWebSocket({
        port: started.port,
        headers,
      });
    },
    close: async () => {
      await started.server.close();
    },
  };
}

export async function startServerWithClient(
  token?: string,
  opts?: GatewayServerOptions & { wsHeaders?: Record<string, string> },
) {
  const { wsHeaders, ...gatewayOpts } = opts ?? {};
  let port = await getFreePort();
  const envSnapshot = captureEnv(["OPENCLAW_GATEWAY_TOKEN"]);
  const prev = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (typeof token === "string") {
    testState.gatewayAuth = { mode: "token", token };
  }
  const fallbackToken =
    token ??
    (typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
      ? (testState.gatewayAuth as { token?: string }).token
      : undefined);
  if (fallbackToken === undefined) {
    delete process.env.OPENCLAW_GATEWAY_TOKEN;
  } else {
    process.env.OPENCLAW_GATEWAY_TOKEN = fallbackToken;
  }

  const resolvedGatewayOpts: GatewayServerOptions =
    fallbackToken && !gatewayOpts.auth
      ? {
          ...gatewayOpts,
          auth: { mode: "token", token: fallbackToken },
        }
      : gatewayOpts;

  const started = await startGatewayServerWithRetries({ port, opts: resolvedGatewayOpts });
  port = started.port;
  const server = started.server;

  const ws = await openTrackedWebSocket({ port, headers: wsHeaders });
  return { server, ws, port, prevToken: prev, envSnapshot };
}

export async function startConnectedServerWithClient(
  token?: string,
  opts?: GatewayServerOptions & { wsHeaders?: Record<string, string> },
) {
  const started = await startServerWithClient(token, opts);
  await connectOk(started.ws);
  return started;
}

type ConnectResponse = {
  type: "res";
  id: string;
  ok: boolean;
  payload?: Record<string, unknown>;
  error?: { message?: string; code?: string; details?: unknown };
};

function resolveDefaultTestDeviceIdentityPath(params: {
  clientId: string;
  clientMode: string;
  platform: string;
  deviceFamily?: string;
  role: string;
}) {
  const safe = normalizeLowercaseStringOrEmpty(
    `${params.clientId}-${params.clientMode}-${params.platform}-${params.deviceFamily ?? "none"}-${params.role}`.replace(
      /[^a-zA-Z0-9._-]+/g,
      "_",
    ),
  );
  const suiteRoot = process.env.OPENCLAW_STATE_DIR ?? process.env.HOME ?? os.tmpdir();
  return path.join(suiteRoot, "test-device-identities", `${safe}.json`);
}

export async function readConnectChallengeNonce(
  ws: WebSocket,
  timeoutMs = 2_000,
): Promise<string | undefined> {
  const cached = getTrackedConnectChallengeNonce(ws);
  if (cached) {
    return cached;
  }
  trackConnectChallengeNonce(ws);
  try {
    const evt = await onceMessage(
      ws,
      (o) => o.type === "event" && o.event === "connect.challenge",
      timeoutMs,
    );
    const nonce = (evt.payload as { nonce?: unknown } | undefined)?.nonce;
    if (typeof nonce === "string" && nonce.trim().length > 0) {
      (ws as TrackedWs)[CONNECT_CHALLENGE_NONCE_KEY] = nonce.trim();
      return nonce.trim();
    }
    return undefined;
  } catch {
    return undefined;
  }
}

function resolveAuthTokenForSignature(opts?: {
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
}) {
  return opts?.token ?? opts?.bootstrapToken ?? opts?.deviceToken;
}

export function testOnlyResolveAuthTokenForSignature(opts?: {
  token?: string;
  bootstrapToken?: string;
  deviceToken?: string;
}) {
  return resolveAuthTokenForSignature(opts);
}

export async function connectReq(
  ws: WebSocket,
  opts?: {
    token?: string;
    bootstrapToken?: string;
    deviceToken?: string;
    password?: string;
    skipDefaultAuth?: boolean;
    minProtocol?: number;
    maxProtocol?: number;
    client?: {
      id: string;
      displayName?: string;
      version: string;
      platform: string;
      mode: string;
      deviceFamily?: string;
      modelIdentifier?: string;
      instanceId?: string;
    };
    role?: string;
    scopes?: string[];
    caps?: string[];
    commands?: string[];
    permissions?: Record<string, boolean>;
    device?: {
      id: string;
      publicKey: string;
      signature: string;
      signedAt: number;
      nonce?: string;
    } | null;
    deviceIdentityPath?: string;
    skipConnectChallengeNonce?: boolean;
    timeoutMs?: number;
  },
): Promise<ConnectResponse> {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  const client = opts?.client ?? {
    id: GATEWAY_CLIENT_NAMES.TEST,
    version: "1.0.0",
    platform: "test",
    mode: GATEWAY_CLIENT_MODES.TEST,
  };
  const role = opts?.role ?? "operator";
  const defaultToken =
    opts?.skipDefaultAuth === true
      ? undefined
      : typeof (testState.gatewayAuth as { token?: unknown } | undefined)?.token === "string"
        ? ((testState.gatewayAuth as { token?: string }).token ?? undefined)
        : process.env.OPENCLAW_GATEWAY_TOKEN;
  const defaultPassword =
    opts?.skipDefaultAuth === true
      ? undefined
      : typeof (testState.gatewayAuth as { password?: unknown } | undefined)?.password === "string"
        ? ((testState.gatewayAuth as { password?: string }).password ?? undefined)
        : process.env.OPENCLAW_GATEWAY_PASSWORD;
  const token = opts?.token ?? defaultToken;
  const bootstrapToken = normalizeOptionalString(opts?.bootstrapToken);
  const deviceToken = normalizeOptionalString(opts?.deviceToken);
  const password = opts?.password ?? defaultPassword;
  const authTokenForSignature = resolveAuthTokenForSignature({
    token,
    bootstrapToken,
    deviceToken,
  });
  const requestedScopes = Array.isArray(opts?.scopes)
    ? opts.scopes
    : role === "operator"
      ? ["operator.admin"]
      : [];
  if (opts?.skipConnectChallengeNonce && opts?.device === undefined) {
    throw new Error("skipConnectChallengeNonce requires an explicit device override");
  }
  const connectChallengeNonce =
    opts?.device !== undefined ? undefined : await readConnectChallengeNonce(ws);
  const device = (() => {
    if (opts?.device === null) {
      return undefined;
    }
    if (opts?.device) {
      return opts.device;
    }
    if (!connectChallengeNonce) {
      throw new Error("missing connect.challenge nonce");
    }
    const identityPath =
      opts?.deviceIdentityPath ??
      resolveDefaultTestDeviceIdentityPath({
        clientId: client.id,
        clientMode: client.mode,
        platform: client.platform,
        deviceFamily: client.deviceFamily,
        role,
      });
    const identity = loadOrCreateDeviceIdentity(identityPath);
    const signedAtMs = Date.now();
    const payload = buildDeviceAuthPayloadV3({
      deviceId: identity.deviceId,
      clientId: client.id,
      clientMode: client.mode,
      role,
      scopes: requestedScopes,
      signedAtMs,
      token: authTokenForSignature ?? null,
      nonce: connectChallengeNonce,
      platform: client.platform,
      deviceFamily: client.deviceFamily,
    });
    return {
      id: identity.deviceId,
      publicKey: publicKeyRawBase64UrlFromPem(identity.publicKeyPem),
      signature: signDevicePayload(identity.privateKeyPem, payload),
      signedAt: signedAtMs,
      nonce: connectChallengeNonce,
    };
  })();
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method: "connect",
      params: {
        minProtocol: opts?.minProtocol ?? PROTOCOL_VERSION,
        maxProtocol: opts?.maxProtocol ?? PROTOCOL_VERSION,
        client,
        caps: opts?.caps ?? [],
        commands: opts?.commands ?? [],
        permissions: opts?.permissions ?? undefined,
        role,
        scopes: requestedScopes,
        auth:
          token || bootstrapToken || password || deviceToken
            ? {
                token,
                bootstrapToken,
                deviceToken,
                password,
              }
            : undefined,
        device,
      },
    }),
  );
  const isResponseForId = (o: unknown): boolean => {
    if (!o || typeof o !== "object" || Array.isArray(o)) {
      return false;
    }
    const rec = o as Record<string, unknown>;
    return rec.type === "res" && rec.id === id;
  };
  return await onceMessage<ConnectResponse>(ws, isResponseForId, opts?.timeoutMs);
}

export async function connectOk(ws: WebSocket, opts?: Parameters<typeof connectReq>[1]) {
  const res = await connectReq(ws, opts);
  expect(res.ok, JSON.stringify(res)).toBe(true);
  expect((res.payload as { type?: unknown } | undefined)?.type).toBe("hello-ok");
  return res.payload as { type: "hello-ok" };
}

export async function connectWebchatClient(params: {
  port: number;
  origin?: string;
  client?: NonNullable<Parameters<typeof connectReq>[1]>["client"];
}): Promise<WebSocket> {
  const origin = params.origin ?? `http://127.0.0.1:${params.port}`;
  const ws = new WebSocket(`ws://127.0.0.1:${params.port}`, {
    headers: { origin },
  });
  trackConnectChallengeNonce(ws);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timeout waiting for ws open")), 10_000);
    const onOpen = () => {
      clearTimeout(timer);
      ws.off("error", onError);
      resolve();
    };
    const onError = (err: Error) => {
      clearTimeout(timer);
      ws.off("open", onOpen);
      reject(err);
    };
    ws.once("open", onOpen);
    ws.once("error", onError);
  });
  await connectOk(ws, {
    client:
      params.client ??
      ({
        id: GATEWAY_CLIENT_NAMES.WEBCHAT,
        version: "1.0.0",
        platform: "test",
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      } as NonNullable<Parameters<typeof connectReq>[1]>["client"]),
  });
  return ws;
}

export async function rpcReq<T extends Record<string, unknown>>(
  ws: WebSocket,
  method: string,
  params?: unknown,
  timeoutMs?: number,
) {
  if (hasUnsyncedGatewayTestSessionConfig()) {
    await persistTestSessionConfig();
  }
  // Gateway suites often mutate testState-backed config/session inputs between
  // RPCs while reusing one server instance; flush caches so the next request
  // observes the updated test fixture state.
  resetConfigRuntimeState();
  clearSessionStoreCacheForTest();
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  ws.send(JSON.stringify({ type: "req", id, method, params }));
  return await onceMessage<{
    type: "res";
    id: string;
    ok: boolean;
    payload?: T | null | undefined;
    error?: { message?: string; code?: string };
  }>(
    ws,
    (o) => {
      if (!o || typeof o !== "object" || Array.isArray(o)) {
        return false;
      }
      const rec = o as Record<string, unknown>;
      return rec.type === "res" && rec.id === id;
    },
    timeoutMs,
  );
}

export async function waitForSystemEvent(timeoutMs = 2000) {
  const sessionKeys = resolveGatewayTestMainSessionKeys();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const sessionKey of sessionKeys) {
      const events = peekSystemEvents(sessionKey);
      if (events.length > 0) {
        return events;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timeout waiting for system event");
}
