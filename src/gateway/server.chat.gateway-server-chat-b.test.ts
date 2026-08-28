// Gateway chat integration tests cover dashboard chat requests, transcript
// history limits, model overrides, inbound dispatch, and streaming event fanout.
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { upsertAcpSessionMeta } from "../acp/runtime/session-meta.js";
import type { EmbeddedAgentQueueHandle } from "../agents/embedded-agent-runner/run-state.js";
import {
  clearActiveEmbeddedRun,
  setActiveEmbeddedRun,
} from "../agents/embedded-agent-runner/runs.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.types.js";
import { createSessionsHistoryTool } from "../agents/tools/sessions-history-tool.js";
import type { GetReplyOptions } from "../auto-reply/get-reply-options.types.js";
import { HEARTBEAT_PROMPT } from "../auto-reply/heartbeat.js";
import type { InternalGetReplyOptions } from "../auto-reply/reply/get-reply.types.js";
import { clearConfigCache, getRuntimeConfig } from "../config/config.js";
import { resolveSessionRoutingContract } from "../config/sessions/main-session.js";
import {
  appendTranscriptEvent,
  appendTranscriptMessage,
  loadSessionEntry,
  loadExactSessionEntry,
  loadTranscriptEventsSync,
  patchSessionEntryCore,
  replaceTranscriptEvents,
  replaceSessionEntry,
  withTranscriptWriteLock,
} from "../config/sessions/session-accessor.js";
import {
  waitForSessionTranscriptIndexReconcile,
  waitForSessionTranscriptProjection,
} from "../config/sessions/session-transcript-reconcile.js";
import type { AgentModelConfig } from "../config/types.agents-shared.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { rotateAgentEventLifecycleGeneration } from "../infra/agent-events.js";
import { onDiagnosticEvent, type DiagnosticPayloadLargeEvent } from "../infra/diagnostic-events.js";
import { ExecApprovalsMigrationRequiredError } from "../infra/exec-approvals-migration-gate.js";
import { getMediaDir } from "../media/store.js";
import { installTemporaryCurrentPluginMetadataSnapshot } from "../plugins/current-plugin-metadata-snapshot.js";
import { resolveInstalledPluginIndexPolicyHash } from "../plugins/installed-plugin-index-policy.js";
import { rebasePluginMetadataSnapshotManifestRegistry } from "../plugins/plugin-metadata-snapshot.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import {
  isSessionWorkAdmissionActive,
  runExclusiveSessionLifecycleMutation,
} from "../sessions/session-lifecycle-admission.js";
import { buildPersistedUserTurnMessage } from "../sessions/user-turn-transcript.js";
import { recordAgentProvenance } from "../state/agent-provenance.js";
import { openOpenClawAgentDatabase } from "../state/openclaw-agent-db.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import * as chatDisplayProjection from "./chat-display-projection.js";
import { assertPluginMetadataSnapshotConsistency } from "./plugin-metadata.test-helpers.js";
import {
  createDirectChatContext,
  createTextTranscriptEvent,
} from "./server-chat.agent-events.test-helpers.js";
import { getMaxChatHistoryMessagesBytes } from "./server-constants.js";
import { createGatewayChatMetadataRuntime } from "./server-methods/chat-metadata-runtime.js";
import type {
  GatewayRequestContext,
  GatewayRequestHandlerOptions,
  RespondFn,
} from "./server-methods/shared-types.js";
import { pendingChatSendDedupeKey } from "./server-shared.js";
import type { GatewaySessionsDefaults } from "./session-utils.types.js";
import {
  connectOk,
  createGatewaySuiteHarness,
  dispatchInboundMessageMock,
  gatewayReplyMock,
  installGatewayTestHooks,
  mockGetReplyFromConfigOnce,
  onceMessage,
  rpcReq,
  testState,
  writeSessionStore,
} from "./test-helpers.js";

const restartRecoveryMocks = vi.hoisted(() => ({
  retryRestartAbortedMainSessionRecovery: vi.fn<
    typeof import("../agents/main-session-recovery/main-session-restart-recovery.js").retryRestartAbortedMainSessionRecovery
  >(async () => ({
    started: 0,
    settled: 0,
    failed: 1,
    skipped: 0,
  })),
}));
const preparedThinkingPolicy = vi.hoisted(() => ({ fallback: "off" as "base" | "off" }));

vi.mock(
  "../agents/main-session-recovery/main-session-restart-recovery.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("../agents/main-session-recovery/main-session-restart-recovery.js")
      >();
    return {
      ...actual,
      retryRestartAbortedMainSessionRecovery:
        restartRecoveryMocks.retryRestartAbortedMainSessionRecovery,
    };
  },
);

vi.mock("../plugins/provider-thinking.js", () => ({
  resolveEffectiveThinkingProfile: (params: { context?: { reasoning?: boolean } }) => {
    const offOnly =
      params.context?.reasoning === false ||
      (params.context?.reasoning === undefined && preparedThinkingPolicy.fallback === "off");
    return offOnly
      ? {
          levels: [{ id: "off", label: "off" }],
          defaultLevel: "off",
          preserveWhenCatalogReasoningFalse: true,
        }
      : undefined;
  },
}));

installGatewayTestHooks({ scope: "suite" });
const FAST_WAIT_OPTS = { timeout: 2_000, interval: 1 } as const;
function waitForFast<T>(
  callback: () => T | Promise<T>,
  options: { timeout?: number; interval?: number } = {},
) {
  return vi.waitFor(callback, { interval: 1, ...options });
}

function createChatVisionModelCatalogSnapshot(): Awaited<
  ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>
> {
  return {
    agentId: "main",
    agentDir: "/tmp/chat-attachment-vision-agent",
    catalogComplete: false,
    workspaceDir: "/tmp/chat-attachment-vision-workspace",
    config: {},
    entries: [
      {
        id: "vision-model",
        name: "Vision Model",
        provider: "test-provider",
        input: ["text", "image"],
      },
    ],
    routeVariants: [],
  };
}

type GatewayHarness = Awaited<ReturnType<typeof createGatewaySuiteHarness>>;
type GatewaySocket = Awaited<ReturnType<GatewayHarness["openWs"]>>;
let harness: GatewayHarness;

function createGatewayPluginMetadataSnapshot(config: OpenClawConfig): PluginMetadataSnapshot {
  const policyHash = resolveInstalledPluginIndexPolicyHash(config);
  const emptySnapshot: PluginMetadataSnapshot = {
    policyHash,
    index: {
      version: 1,
      hostContractVersion: "test",
      compatRegistryVersion: "test",
      migrationVersion: 1,
      policyHash,
      generatedAtMs: 0,
      installRecords: {},
      // Matches the real isolated bundled snapshot: no installed-index rows,
      // with the selected bundled manifests supplied below.
      plugins: [],
      diagnostics: [],
    },
    registryDiagnostics: [],
    manifestRegistry: { plugins: [], diagnostics: [] },
    plugins: [],
    diagnostics: [],
    byPluginId: new Map(),
    normalizePluginId: (pluginId) => pluginId,
    owners: {
      channels: new Map(),
      channelConfigs: new Map(),
      providers: new Map(),
      modelCatalogProviders: new Map(),
      cliBackends: new Map(),
      setupProviders: new Map(),
      commandAliases: new Map(),
      contracts: new Map(),
    },
    metrics: {
      registrySnapshotMs: 0,
      manifestRegistryMs: 0,
      ownerMapsMs: 0,
      totalMs: 0,
      indexPluginCount: 0,
      manifestPluginCount: 0,
    },
  };
  return rebasePluginMetadataSnapshotManifestRegistry(emptySnapshot, {
    plugins: [
      {
        id: "openai",
        channels: [],
        providers: ["openai"],
        cliBackends: [],
        syntheticAuthRefs: [],
        providerAuthChoices: [
          { provider: "openai", method: "oauth", choiceId: "openai" },
          {
            provider: "openai",
            method: "device-code",
            choiceId: "openai-device-code",
          },
          { provider: "openai", method: "api-key", choiceId: "openai-api-key" },
        ],
        modelSupport: { modelPrefixes: ["gpt-", "o1", "o3", "o4"] },
        skills: [],
        hooks: [],
        origin: "bundled",
        rootDir: "/test/openai",
        source: "/test/openai/index.ts",
        manifestPath: "/test/openai/openclaw.plugin.json",
      },
    ],
    diagnostics: [],
  });
}
const autoCleanupTempDirs = useAutoCleanupTempDirTracker(afterEach);

beforeAll(async () => {
  harness = await createGatewaySuiteHarness();
});

afterAll(async () => {
  await harness.close();
});

const sendReq = (
  ws: { send: (payload: string) => void },
  id: string,
  method: string,
  params: unknown,
) => {
  ws.send(
    JSON.stringify({
      type: "req",
      id,
      method,
      params,
    }),
  );
};

async function withGatewayChatHarness(
  run: (ctx: { ws: GatewaySocket; createSessionDir: () => Promise<string> }) => Promise<void>,
  options?: { headers?: Record<string, string> },
) {
  const ws = await harness.openWs(options?.headers);
  const createSessionDir = async () => openDirectChatSession().sessionDir;

  try {
    await run({ ws, createSessionDir });
  } finally {
    if (process.env.OPENCLAW_CONFIG_PATH) {
      await fs.rm(process.env.OPENCLAW_CONFIG_PATH, { force: true });
    }
    clearConfigCache();
    testState.sessionStorePath = undefined;
    ws.close();
  }
}

function testSessionFilePath(sessionDir: string, sessionId: string): string {
  return path.join(sessionDir, `${sessionId}.jsonl`);
}

async function writeMainSessionStore(sessionId = "sess-main") {
  await writeStoredMainSession({
    sessionId,
    updatedAt: futureFixtureUpdatedAt(),
  });
}

function futureFixtureUpdatedAt(): number {
  return Date.now() + 60_000;
}

function readOpenClawSeq(message: unknown): number | undefined {
  if (!message || typeof message !== "object" || Array.isArray(message)) {
    return undefined;
  }
  const metadata = (message as Record<string, unknown>)["__openclaw"];
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return undefined;
  }
  const seq = (metadata as Record<string, unknown>).seq;
  return typeof seq === "number" ? seq : undefined;
}

async function writeGatewayConfig(config: Record<string, unknown>) {
  const configPath = process.env.OPENCLAW_CONFIG_PATH;
  if (!configPath) {
    throw new Error("OPENCLAW_CONFIG_PATH missing in gateway test environment");
  }
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, JSON.stringify(config, null, 2), "utf-8");
  clearConfigCache();
}

async function writeMainSessionTranscript(
  events: unknown[],
  sessionId = "sess-main",
  opts?: {
    agentId?: string;
    sessionKey?: string;
  },
) {
  const storePath = testState.sessionStorePath;
  if (!storePath) {
    throw new Error("session store path was not initialized");
  }
  // These fixtures always seed a complete fresh transcript. Replace it in one
  // transaction so large history cases do not pay one SQLite commit per event.
  const transcriptEvents = events
    .filter((event) => typeof event !== "string" || event.trim())
    .map((event) => (typeof event === "string" ? JSON.parse(event) : event)) as Parameters<
    typeof replaceTranscriptEvents
  >[1];
  await replaceTranscriptEvents(
    {
      agentId: opts?.agentId ?? "main",
      sessionId,
      sessionKey: opts?.sessionKey ?? "agent:main:main",
      storePath,
    },
    transcriptEvents,
  );
  // Oversized fixture transcripts take the deferred rebuild path; history
  // reads need the projection converged before the case under test runs.
  await waitForSessionTranscriptProjection({
    agentId: opts?.agentId ?? "main",
    sessionId,
    storePath,
  });
}

async function withDirectChatSession(
  run: (sessionDir: string, storePath: string) => Promise<void>,
) {
  const { sessionDir, storePath } = openDirectChatSession();
  try {
    await run(sessionDir, storePath);
  } finally {
    resetDirectChatSession();
  }
}

type StoredSessionEntry = Parameters<typeof writeSessionStore>[0]["entries"][string];

function openDirectChatSession() {
  const sessionDir = autoCleanupTempDirs.make("openclaw-gw-");
  const storePath = path.join(sessionDir, "sessions.json");
  testState.sessionStorePath = storePath;
  return { sessionDir, storePath };
}

function resetDirectChatSession() {
  dispatchInboundMessageMock.mockReset();
  testState.sessionStorePath = undefined;
  clearConfigCache();
}

async function writeStoredMainSession(entry: StoredSessionEntry = {}) {
  await writeSessionStore({
    entries: {
      main: {
        sessionId: "sess-main",
        updatedAt: Date.now(),
        ...entry,
      },
    },
  });
}

type DirectChatMethod = "chat.abort" | "chat.history" | "chat.send" | "chat.startup";

async function callDirectChatHandler(
  method: DirectChatMethod,
  options: GatewayRequestHandlerOptions,
) {
  const { chatHandlers } = await import("./server-methods/chat.js");
  await expectDefined(chatHandlers[method], `${method} test invariant`)(options);
}

type DirectChatCallOptions = Omit<
  GatewayRequestHandlerOptions,
  "client" | "isWebchatConnect" | "req"
> & {
  id: string;
  client?: GatewayRequestHandlerOptions["client"];
  isWebchatConnect?: GatewayRequestHandlerOptions["isWebchatConnect"];
  req?: GatewayRequestHandlerOptions["req"];
};

async function callDirectChat(method: DirectChatMethod, options: DirectChatCallOptions) {
  const { client, id, isWebchatConnect, req, ...handlerOptions } = options;
  await callDirectChatHandler(method, {
    ...handlerOptions,
    req: req ?? { type: "req", id, method, params: options.params },
    client: client ?? null,
    isWebchatConnect: isWebchatConnect ?? (() => false),
  });
}

function createControlUiClient(
  scopes = ["operator.write", "operator.admin"],
  properties: Record<string, unknown> = {},
) {
  return {
    ...properties,
    connect: {
      client: {
        id: GATEWAY_CLIENT_NAMES.CONTROL_UI,
        mode: GATEWAY_CLIENT_MODES.WEBCHAT,
      },
      scopes,
    },
  } as never;
}

type ChatSendParamOverrides = {
  idempotencyKey: string;
  [key: string]: unknown;
};

function makeMainSessionParams(overrides: Record<string, unknown> = {}) {
  return { sessionKey: "main", ...overrides };
}

function makeMainMessageParams(messageId: string) {
  return { sessionKey: "main", messageId };
}

function makeChatSendParams(overrides: ChatSendParamOverrides) {
  return makeMainSessionParams({ message: "hello", ...overrides });
}

function makeMainSessionScope(storePath: string | undefined) {
  return {
    agentId: "main",
    sessionId: "sess-main",
    sessionKey: "agent:main:main",
    storePath,
  };
}

function makeGatewayWebchatClient(id: string = GATEWAY_CLIENT_NAMES.CONTROL_UI) {
  return {
    client: {
      id,
      version: "1.0.0",
      platform: "web",
      mode: GATEWAY_CLIENT_MODES.WEBCHAT,
    },
  };
}

function makeTuiClient() {
  return {
    connId: "conn-tui",
    connect: {
      client: { id: GATEWAY_CLIENT_NAMES.TUI, mode: GATEWAY_CLIENT_MODES.UI },
      scopes: ["operator.write", "operator.admin"],
    },
  } as never;
}

function makeTranscriptTextEvent(
  text: string,
  overrides: {
    role?: "assistant" | "toolResult" | "user";
    message?: Record<string, unknown>;
    [key: string]: unknown;
  } = {},
) {
  const { role = "assistant", message = {}, ...event } = overrides;
  return {
    ...event,
    message: { role, content: [{ type: "text", text }], ...message },
  };
}

function makeClaudeCliSessionEntry(
  sessionDir: string,
  sessionId: string,
  cliSessionId: string,
): StoredSessionEntry {
  return {
    sessionId,
    sessionFile: testSessionFilePath(sessionDir, sessionId),
    updatedAt: futureFixtureUpdatedAt(),
    modelProvider: "claude-cli",
    model: "claude-sonnet-4-6",
    cliSessionBindings: { "claude-cli": { sessionId: cliSessionId } },
  };
}

function makeDoneSessionEntry(overrides: StoredSessionEntry = {}): StoredSessionEntry {
  return { status: "done", ...overrides };
}

type CapturedChatResult = { ok: boolean; payload?: unknown };
type CapturedChatResponse = CapturedChatResult & { error?: unknown };

function captureChatResult(results: CapturedChatResult[]): RespondFn {
  return (ok, payload) => {
    results.push({ ok, payload });
  };
}

function captureChatResponse(responses: CapturedChatResponse[]): RespondFn {
  return (ok, payload, error) => {
    responses.push({ ok, payload, error });
  };
}

async function sendControlUiChat(params: {
  authenticatedUserId?: string;
  authenticatedUserProfile?: {
    profileId: string;
    displayName: string | null;
    hasAvatar: boolean;
  };
  context: GatewayRequestContext;
  expectedSessionRoutingContract?: string;
  idempotencyKey: string;
  message: string;
  respond: RespondFn;
  onAdmissionOwned?: () => Promise<boolean>;
}): Promise<void> {
  const requestParams = makeChatSendParams({
    message: params.message,
    idempotencyKey: params.idempotencyKey,
    ...(params.expectedSessionRoutingContract
      ? { expectedSessionRoutingContract: params.expectedSessionRoutingContract }
      : {}),
  });
  const options: GatewayRequestHandlerOptions = {
    req: {
      type: "req",
      id: params.idempotencyKey,
      method: "chat.send",
      params: requestParams,
    },
    params: requestParams,
    client: createControlUiClient(undefined, {
      ...(params.authenticatedUserId ? { authenticatedUserId: params.authenticatedUserId } : {}),
      ...(params.authenticatedUserProfile
        ? { authenticatedUserProfile: params.authenticatedUserProfile }
        : {}),
    }),
    isWebchatConnect: () => true,
    respond: params.respond,
    context: params.context,
  };
  if (params.onAdmissionOwned) {
    const { handleChatSend } = await import("./server-methods/chat-send-handler.js");
    await handleChatSend(options, params.onAdmissionOwned);
    return;
  }
  await callDirectChatHandler("chat.send", options);
}

test("chat.send replays a cached result after the session is archived", async () => {
  openDirectChatSession();
  try {
    dispatchInboundMessageMock.mockClear();
    await writeStoredMainSession({
      archivedAt: Date.now(),
    });
    const context = createDirectChatContext();
    const runId = "idem-archived-cached-result";
    const cachedPayload = { runId, status: "ok", summary: "already completed" };
    context.dedupe.set(`chat:${runId}`, {
      ts: Date.now(),
      ok: true,
      payload: cachedPayload,
    });
    const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown; meta?: unknown }> =
      [];
    await callDirectChat("chat.send", {
      id: "cached",
      req: { type: "req", id: "cached", method: "chat.send" },
      params: makeChatSendParams({
        message: "retry completed send",
        idempotencyKey: runId,
      }),
      respond: ((ok, payload, error, meta) => {
        responses.push({ ok, payload, error, meta });
      }) as RespondFn,
      context,
    });

    expect(responses).toEqual([
      {
        ok: true,
        payload: cachedPayload,
        error: undefined,
        meta: { cached: true },
      },
    ]);
    expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
  } finally {
    resetDirectChatSession();
  }
});

async function readTimelineEvents(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(filePath, "utf-8");
  return raw
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function fetchHistoryMessages(
  ws: GatewaySocket,
  params?: {
    limit?: number;
    maxChars?: number;
  },
): Promise<unknown[]> {
  const historyRes = await rpcReq<{ messages?: unknown[] }>(
    ws,
    "chat.history",
    makeMainSessionParams({
      limit: params?.limit ?? 1000,
      ...(typeof params?.maxChars === "number" ? { maxChars: params.maxChars } : {}),
    }),
  );
  expect(historyRes.ok).toBe(true);
  return historyRes.payload?.messages ?? [];
}

async function fetchChatMessage(
  ws: GatewaySocket,
  params: {
    sessionKey: string;
    agentId?: string;
    messageId: string;
    maxChars?: number;
  },
): Promise<{
  ok?: boolean;
  message?: unknown;
  unavailableReason?: "not_found" | "oversized" | "not_visible";
}> {
  const res = await rpcReq<{
    ok?: boolean;
    message?: unknown;
    unavailableReason?: "not_found" | "oversized" | "not_visible";
  }>(ws, "chat.message.get", {
    sessionKey: params.sessionKey,
    ...(params.agentId ? { agentId: params.agentId } : {}),
    messageId: params.messageId,
    ...(typeof params.maxChars === "number" ? { maxChars: params.maxChars } : {}),
  });
  if (!res.ok) {
    throw new Error(`chat.message.get rpc failed: ${JSON.stringify(res.error ?? null)}`);
  }
  return res.payload ?? {};
}

type ConfiguredImageModelCase = {
  id: string;
  imageModel: AgentModelConfig;
};

const configuredImageModelCases: ConfiguredImageModelCase[] = [
  {
    id: "with-image-fallback",
    imageModel: { primary: "openai/gpt-4o", fallbacks: ["openai/gpt-4o-mini"] },
  },
  {
    id: "without-image-fallback",
    imageModel: { primary: "openai/gpt-4o" },
  },
];

async function prepareMainHistoryHarness(params: {
  ws: GatewaySocket;
  createSessionDir: () => Promise<string>;
  sessionId?: string;
}) {
  await connectOk(params.ws);
  const sessionDir = await params.createSessionDir();
  await writeMainSessionStore(params.sessionId);
  return sessionDir;
}

async function prepareUnconfiguredAcpHarnessSession(options?: { withMetadata?: boolean }) {
  openDirectChatSession();
  const sessionKey = `agent:codex:acp:${randomUUID()}`;
  const config: OpenClawConfig = {
    agents: { entries: { main: { default: true } } },
    acp: { enabled: true, backend: "acpx", allowedAgents: ["codex"] },
  };
  testState.agentsConfig = config.agents;
  await writeGatewayConfig(config);
  if (options?.withMetadata === false) {
    await writeSessionStore({
      agentId: "codex",
      entries: {
        [sessionKey]: {
          sessionId: "sess-acp-codex",
          updatedAt: Date.now(),
        },
      },
    });
  } else {
    await upsertAcpSessionMeta({
      sessionKey,
      agentId: "codex",
      cfg: getRuntimeConfig(),
      now: () => 1,
      mutate: () => ({
        backend: "acpx",
        agent: "codex",
        runtimeSessionName: sessionKey,
        mode: "persistent",
        state: "idle",
        lastActivityAt: Date.now(),
      }),
    });
  }
  return sessionKey;
}

describe("gateway server chat", () => {
  test.each(["chat.history", "chat.startup"] as const)(
    "%s reads a persisted ACP harness session without configuring its harness as an ordinary agent",
    async (method) => {
      try {
        const sessionKey = await prepareUnconfiguredAcpHarnessSession();
        const responses: CapturedChatResponse[] = [];
        await callDirectChat(method, {
          id: `acp-harness-${method}`,
          params: { sessionKey },
          respond: captureChatResponse(responses),
          context: createDirectChatContext({ getRuntimeConfig }),
        });

        expect(responses).toHaveLength(1);
        expect(responses[0]?.ok, JSON.stringify(responses[0]?.error ?? null)).toBe(true);
      } finally {
        testState.agentsConfig = undefined;
        resetDirectChatSession();
      }
    },
  );

  test("chat.send accepts a persisted ACP harness without configuring it as an ordinary agent", async () => {
    try {
      const sessionKey = await prepareUnconfiguredAcpHarnessSession();
      const responses: CapturedChatResponse[] = [];
      const context = createDirectChatContext({ getRuntimeConfig });
      await callDirectChat("chat.send", {
        id: "acp-harness-send",
        params: {
          sessionKey,
          message: "continue the bound ACP session",
          idempotencyKey: "acp-harness-send",
        },
        respond: captureChatResponse(responses),
        context,
      });

      expect(responses).toHaveLength(1);
      expect(responses[0]?.ok, JSON.stringify(responses[0]?.error ?? null)).toBe(true);
      expect(responses[0]?.payload).toMatchObject({ status: "started" });
      await waitForFast(
        () => expect(context.removeChatRun).toHaveBeenCalledTimes(1),
        FAST_WAIT_OPTS,
      );
    } finally {
      testState.agentsConfig = undefined;
      resetDirectChatSession();
    }
  });

  test("chat.send rejects an unconfigured ACP-shaped session without authoritative ACP metadata", async () => {
    try {
      const sessionKey = await prepareUnconfiguredAcpHarnessSession({ withMetadata: false });
      const responses: CapturedChatResponse[] = [];
      await callDirectChat("chat.send", {
        id: "acp-harness-forged",
        params: {
          sessionKey,
          message: "reject an unconfirmed ACP session",
          idempotencyKey: "acp-harness-forged",
        },
        respond: captureChatResponse(responses),
        context: createDirectChatContext({ getRuntimeConfig }),
      });

      expect(responses).toHaveLength(1);
      expect(responses[0]).toMatchObject({
        ok: false,
        error: { message: 'Agent "codex" no longer exists in configuration' },
      });
    } finally {
      testState.agentsConfig = undefined;
      resetDirectChatSession();
    }
  });

  test.each(["chat.history", "chat.startup"] as const)(
    "%s projects the session's durable worker placement",
    async (method) => {
      openDirectChatSession();
      try {
        await writeMainSessionStore();
        const placement = {
          sessionId: "sess-main",
          agentId: "main",
          sessionKey: "agent:main:main",
          executionMode: "worker-turn",
          state: "active",
          environmentId: "env-placement",
          generation: 7,
          activeOwnerEpoch: 12,
          workspaceBaseManifestRef: "manifest-base",
          remoteWorkspaceDir: "/workspace/main",
          workerBundleHash: "ab".repeat(32),
          recoveryError: null,
          terminalReason: null,
          terminalAtMs: null,
          turnClaim: null,
          createdAtMs: 100,
          updatedAtMs: 300,
          stateChangedAtMs: 200,
        };
        const context = createDirectChatContext({
          workerSessionPlacementService: {
            getMany: () => new Map([[placement.sessionId, placement]]),
            getPlacementMoves: () => new Map(),
          },
        } as unknown as Partial<GatewayRequestContext>);
        const responses: Array<{ ok: boolean; payload?: unknown }> = [];
        await callDirectChat(method, {
          id: method,
          params: makeMainSessionParams(),
          respond: captureChatResult(responses),
          context,
        });

        expect(responses[0]?.ok).toBe(true);
        // Clients merge this row into the same store sessions.list fills, so a
        // missing placement here silently erases a live worker placement.
        expect(
          (responses[0]?.payload as { sessionInfo?: { placement?: { state?: string } } })
            ?.sessionInfo?.placement,
        ).toMatchObject({ state: "active", environmentId: "env-placement" });
      } finally {
        testState.sessionStorePath = undefined;
        clearConfigCache();
      }
    },
  );

  test.each(["chat.history", "chat.startup"] as const)(
    "%s replays the active plan snapshot in inFlightRun",
    async (method) => {
      openDirectChatSession();
      try {
        await writeMainSessionStore();
        const context = createDirectChatContext();
        const controller = new AbortController();
        context.chatAbortControllers.set("run-active", {
          controller,
          sessionId: "sess-main",
          sessionKey: "main",
          startedAtMs: 1_000,
          expiresAtMs: 10_000,
          projectSessionActive: true,
        });
        const activeRun = context.chatRunState.getOrCreate("run-active");
        activeRun.buffer = "partial reply";
        activeRun.planSnapshot = {
          explanation: "Replay on reconnect",
          steps: [{ step: "Reconnect clients", status: "in_progress" }],
        };
        const responses: Array<{ ok: boolean; payload?: unknown }> = [];
        await callDirectChat(method, {
          id: method,
          params: makeMainSessionParams(),
          respond: captureChatResult(responses),
          context,
        });

        expect(responses).toHaveLength(1);
        expect(responses[0]?.ok).toBe(true);
        expect(
          (responses[0]?.payload as { inFlightRun?: unknown } | undefined)?.inFlightRun,
        ).toEqual({
          runId: "run-active",
          text: "partial reply",
          startedAt: 1_000,
          plan: {
            explanation: "Replay on reconnect",
            steps: [{ step: "Reconnect clients", status: "in_progress" }],
          },
        });
      } finally {
        testState.sessionStorePath = undefined;
        clearConfigCache();
      }
    },
  );

  test.each(["chat.history", "chat.startup"] as const)(
    "%s projects embedded identity through the existing run snapshot",
    async (method) => {
      const {
        createAgentEventHandler,
        createSessionEventSubscriberRegistry,
        createSessionMessageSubscriberRegistry,
      } = await import("./server-chat.js");
      openDirectChatSession();
      await writeMainSessionStore();
      const context = createDirectChatContext();
      const handler = createAgentEventHandler({
        broadcast: context.broadcast,
        broadcastToConnIds: context.broadcastToConnIds,
        nodeSendToSession: context.nodeSendToSession,
        agentRunSeq: context.agentRunSeq,
        chatRunState: context.chatRunState,
        resolveSessionKeyForRun: () => "main",
        clearAgentRunContext: vi.fn(),
        toolEventRecipients: context.chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
      });
      const handle: EmbeddedAgentQueueHandle = {
        runId: "run-embedded",
        startedAtMs: 1_700_000_000_000,
        abort: () => undefined,
        isAborted: () => false,
        isCompacting: () => false,
        isStreaming: () => true,
        queueMessage: async () => undefined,
      };
      setActiveEmbeddedRun("sess-main", handle, "main");
      try {
        handler({
          runId: "run-embedded",
          seq: 1,
          stream: "item",
          ts: 1_001,
          data: { kind: "preamble", itemId: "preamble-1", progressText: "Checking files" },
        });
        handler({
          runId: "run-embedded",
          seq: 2,
          stream: "tool",
          ts: 1_002,
          data: {
            phase: "start",
            name: "exec",
            toolCallId: "tool-1",
            args: { command: "SECRET_COMMAND" },
          },
        });
        handler({
          runId: "run-embedded",
          seq: 3,
          stream: "tool",
          ts: 1_003,
          data: {
            phase: "input_delta",
            name: "exec",
            toolCallId: "tool-1",
            diff: "SECRET_DIFF",
          },
        });
        handler({
          runId: "run-embedded",
          seq: 4,
          stream: "tool",
          ts: 1_004,
          data: {
            phase: "update",
            name: "exec",
            toolCallId: "tool-1",
            partialResult: "SECRET_PARTIAL",
          },
        });
        handler({
          runId: "run-embedded",
          seq: 5,
          stream: "tool",
          ts: 1_005,
          data: {
            phase: "review",
            name: "exec",
            toolCallId: "tool-1",
            review: { id: "review-1", text: "SECRET_REVIEW" },
          },
        });
        handler({
          runId: "run-embedded",
          seq: 6,
          stream: "tool",
          ts: 1_006,
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "tool-1",
            result: "SECRET_RESULT",
          },
        });
        handler({
          runId: "run-embedded",
          seq: 7,
          stream: "plan",
          ts: 1_007,
          data: {
            phase: "update",
            steps: [{ step: "Inspect", status: "in_progress" }],
          },
        });

        const responses: Array<{ ok: boolean; payload?: unknown }> = [];
        await callDirectChat(method, {
          id: method,
          params: makeMainSessionParams(),
          respond: captureChatResult(responses),
          context,
        });

        expect(responses[0]?.ok).toBe(true);
        const inFlightRun = (responses[0]?.payload as { inFlightRun?: unknown } | undefined)
          ?.inFlightRun;
        expect(inFlightRun).toEqual({
          runId: "run-embedded",
          text: "",
          startedAt: 1_700_000_000_000,
          sessionAbortable: true,
          events: [
            {
              runId: "run-embedded",
              seq: 1,
              stream: "item",
              ts: 1_001,
              sessionKey: "main",
              data: {
                kind: "preamble",
                itemId: "preamble-1",
                progressText: "Checking files",
              },
            },
            {
              runId: "run-embedded",
              seq: 2,
              stream: "tool",
              ts: 1_002,
              sessionKey: "main",
              data: { phase: "start", name: "exec", toolCallId: "tool-1" },
            },
            {
              runId: "run-embedded",
              seq: 3,
              stream: "tool",
              ts: 1_003,
              sessionKey: "main",
              data: { phase: "input_delta", name: "exec", toolCallId: "tool-1" },
            },
            {
              runId: "run-embedded",
              seq: 4,
              stream: "tool",
              ts: 1_004,
              sessionKey: "main",
              data: { phase: "update", name: "exec", toolCallId: "tool-1" },
            },
            {
              runId: "run-embedded",
              seq: 6,
              stream: "tool",
              ts: 1_006,
              sessionKey: "main",
              data: { phase: "result", name: "exec", toolCallId: "tool-1" },
            },
          ],
          plan: { steps: [{ step: "Inspect", status: "in_progress" }] },
        });
        expect(JSON.stringify(inFlightRun)).not.toContain("SECRET");
      } finally {
        clearActiveEmbeddedRun("sess-main", handle, "main");
        testState.sessionStorePath = undefined;
        clearConfigCache();
      }
    },
  );

  test.each(["chat.history", "chat.startup"] as const)(
    "%s adopts the in-flight run for a non-default agent alias key",
    async (method) => {
      const { sessionDir } = openDirectChatSession();
      try {
        // Per-agent stores: bare keys then carry no persisted fixed-store
        // owner, so an explicit non-default agentId is a valid pairing.
        testState.sessionConfig = {
          store: path.join(sessionDir, "sessions-{agentId}.json"),
        };
        await writeGatewayConfig({
          agents: { entries: { main: { default: true }, writer: {} } },
        });
        await writeSessionStore({
          agentId: "writer",
          storePath: path.join(sessionDir, "sessions-writer.json"),
          entries: { "agent:writer:notes": { sessionId: "sess-writer", updatedAt: Date.now() } },
        });
        const writerConfig = {
          agents: { entries: { main: { default: true }, writer: {} } },
          session: { store: path.join(sessionDir, "sessions-{agentId}.json") },
        };
        const context = createDirectChatContext({
          getRuntimeConfig: () => writerConfig,
        });
        const controller = new AbortController();
        // chat.send registers the agent-scoped canonical key; the handler's
        // in-flight adoption must resolve the same scoped key for the bare
        // alias request or the streaming run renders idle on switch-back.
        context.chatAbortControllers.set("run-writer", {
          controller,
          sessionId: "sess-writer",
          sessionKey: "agent:writer:notes",
          agentId: "writer",
          startedAtMs: 1_000,
          expiresAtMs: Date.now() + 60_000,
          projectSessionActive: true,
        });
        context.chatRunState.getOrCreate("run-writer").buffer = "writer partial";
        const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
        await callDirectChat(method, {
          id: method,
          params: { sessionKey: "notes", agentId: "writer" },
          respond: captureChatResponse(responses),
          context,
        });

        expect(responses).toHaveLength(1);
        expect(responses[0]?.ok, JSON.stringify(responses[0]?.error ?? null)).toBe(true);
        expect(
          (responses[0]?.payload as { inFlightRun?: unknown } | undefined)?.inFlightRun,
        ).toMatchObject({ runId: "run-writer", text: "writer partial" });
      } finally {
        testState.sessionConfig = undefined;
        testState.sessionStorePath = undefined;
        clearConfigCache();
      }
    },
  );

  test.each(["chat.history", "chat.startup"] as const)(
    "%s retains completed tool owner events in bounded inFlightRun replay",
    async (method) => {
      const {
        createAgentEventHandler,
        createSessionEventSubscriberRegistry,
        createSessionMessageSubscriberRegistry,
      } = await import("./server-chat.js");
      openDirectChatSession();
      const context = createDirectChatContext();
      const handler = createAgentEventHandler({
        broadcast: context.broadcast,
        broadcastToConnIds: context.broadcastToConnIds,
        nodeSendToSession: context.nodeSendToSession,
        agentRunSeq: context.agentRunSeq,
        chatRunState: context.chatRunState,
        resolveSessionKeyForRun: () => "main",
        clearAgentRunContext: vi.fn(),
        toolEventRecipients: context.chatRunState.toolEventRecipients,
        sessionEventSubscribers: createSessionEventSubscriberRegistry(),
        sessionMessageSubscribers: createSessionMessageSubscriberRegistry(),
      });
      try {
        await writeMainSessionStore();
        const controller = new AbortController();
        context.chatAbortControllers.set("run-active", {
          controller,
          sessionId: "sess-main",
          sessionKey: "main",
          startedAtMs: 1_000,
          expiresAtMs: 10_000,
          projectSessionActive: true,
        });
        context.chatRunState.registry.add("provider-run", {
          sessionKey: "main",
          clientRunId: "run-active",
        });

        handler({
          runId: "provider-run",
          seq: 1,
          stream: "item",
          ts: 1_001,
          data: { kind: "preamble", itemId: "preamble-1", progressText: "Checking files" },
        });
        handler({
          runId: "provider-run",
          seq: 2,
          stream: "tool",
          ts: 1_002,
          data: { phase: "start", name: "read", toolCallId: "tool-active", args: { path: "a" } },
        });
        handler({
          runId: "provider-run",
          seq: 3,
          stream: "tool",
          ts: 1_003,
          data: {
            phase: "update",
            name: "read",
            toolCallId: "tool-active",
            partialResult: "halfway",
          },
        });
        handler({
          runId: "provider-run",
          seq: 4,
          stream: "tool",
          ts: 1_004,
          data: { phase: "start", name: "exec", toolCallId: "tool-finished", args: {} },
        });
        handler({
          runId: "provider-run",
          seq: 5,
          stream: "tool",
          ts: 1_005,
          data: {
            phase: "result",
            name: "exec",
            toolCallId: "tool-finished",
            result: "x".repeat(256_000),
          },
        });
        // A delayed result older than the latest accepted progress event must
        // not remove the active tool from the reconnect projection.
        handler({
          runId: "provider-run",
          seq: 3,
          stream: "tool",
          ts: 1_006,
          data: { phase: "result", name: "read", toolCallId: "tool-active", result: "stale" },
        });
        handler({
          runId: "provider-run",
          seq: 6,
          stream: "item",
          ts: 1_006,
          data: {
            kind: "preamble",
            itemId: "preamble-2",
            progressText: "Autoreview is running",
          },
        });

        const responses: Array<{ ok: boolean; payload?: unknown }> = [];
        await callDirectChat(method, {
          id: method,
          params: makeMainSessionParams(),
          respond: captureChatResult(responses),
          context,
        });

        expect(responses).toHaveLength(1);
        expect(responses[0]?.ok).toBe(true);
        expect(
          (responses[0]?.payload as { inFlightRun?: unknown } | undefined)?.inFlightRun,
        ).toEqual({
          runId: "run-active",
          text: "",
          startedAt: 1_000,
          events: [
            {
              runId: "run-active",
              seq: 1,
              stream: "item",
              ts: 1_001,
              sessionKey: "main",
              data: {
                kind: "preamble",
                itemId: "preamble-1",
                progressText: "Checking files",
              },
            },
            {
              runId: "run-active",
              seq: 2,
              stream: "tool",
              ts: 1_002,
              sessionKey: "main",
              data: {
                phase: "start",
                name: "read",
                toolCallId: "tool-active",
                args: { path: "a" },
              },
            },
            {
              runId: "run-active",
              seq: 3,
              stream: "tool",
              ts: 1_003,
              sessionKey: "main",
              data: {
                phase: "update",
                name: "read",
                toolCallId: "tool-active",
                partialResult: "halfway",
              },
            },
            {
              runId: "run-active",
              seq: 4,
              stream: "tool",
              ts: 1_004,
              sessionKey: "main",
              data: {
                phase: "start",
                name: "exec",
                toolCallId: "tool-finished",
                args: {},
              },
            },
            {
              runId: "run-active",
              seq: 5,
              stream: "tool",
              ts: 1_005,
              sessionKey: "main",
              data: {
                phase: "result",
                name: "exec",
                toolCallId: "tool-finished",
              },
            },
            {
              runId: "run-active",
              seq: 6,
              stream: "item",
              ts: 1_006,
              sessionKey: "main",
              data: {
                kind: "preamble",
                itemId: "preamble-2",
                progressText: "Autoreview is running",
              },
            },
          ],
        });
      } finally {
        handler.dispose();
        testState.sessionStorePath = undefined;
        clearConfigCache();
      }
    },
  );

  test("chat.history exposes selected and synthetic session metadata for startup hydration", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      const updatedAt = Date.now();
      await writeStoredMainSession({
        updatedAt,
        providerOverride: "openai",
        modelOverride: "gpt-5",
        modelProvider: "openai",
        model: "gpt-5",
        agentHarnessId: "openclaw",
        contextTokens: 128_000,
        contextTokensSource: "runtime",
      });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "persisted metadata", { timestamp: updatedAt }),
      ]);

      const persisted = await rpcReq<{
        defaults?: { modelProvider?: string | null; model?: string | null };
        sessionInfo?: {
          key?: string;
          sessionId?: string;
          updatedAt?: number | null;
          modelProvider?: string | null;
          model?: string | null;
          contextTokens?: number | null;
        };
      }>(ws, "chat.history", makeMainSessionParams());

      expect(persisted.ok).toBe(true);
      expect(persisted.payload?.defaults?.modelProvider).toBeTruthy();
      expect(persisted.payload?.defaults?.model).toBeTruthy();
      expect(persisted.payload?.sessionInfo).toMatchObject({
        key: "agent:main:main",
        sessionId: "sess-main",
        updatedAt,
        modelProvider: "openai",
        model: "gpt-5",
        contextTokens: 128_000,
      });

      await writeSessionStore({ entries: {} });
      const synthetic = await rpcReq<{
        defaults?: { modelProvider?: string | null; model?: string | null };
        sessionInfo?: {
          key?: string;
          sessionId?: string;
          updatedAt?: number | null;
          modelProvider?: string | null;
          model?: string | null;
          contextTokens?: number | null;
        };
      }>(ws, "chat.history", makeMainSessionParams());

      expect(synthetic.ok).toBe(true);
      expect(synthetic.payload?.defaults?.modelProvider).toBeTruthy();
      expect(synthetic.payload?.defaults?.model).toBeTruthy();
      expect(synthetic.payload?.sessionInfo?.key).toBe("agent:main:main");
      expect(synthetic.payload?.sessionInfo?.sessionId).toBeUndefined();
      expect(synthetic.payload?.sessionInfo?.updatedAt).toBeNull();
      expect(synthetic.payload?.sessionInfo?.modelProvider).toBeTruthy();
      expect(synthetic.payload?.sessionInfo?.model).toBeTruthy();
      expect(synthetic.payload?.sessionInfo?.contextTokens).toEqual(expect.any(Number));
    });
  });

  test("chat.startup returns warm metadata while agents.list owns roster provenance", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-main",
            },
            models: {
              "openai/gpt-main": {},
            },
          },
          entries: { main: { default: true }, research: {} },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [{ id: "gpt-main", name: "GPT Main" }],
            },
          },
        },
      });
      recordAgentProvenance(
        "research",
        { createdVia: "agent", creatorAgentId: "main" },
        { nowMs: 42 },
      );
      await connectOk(ws);
      await createSessionDir();
      const updatedAt = Date.now();
      await writeStoredMainSession({
        updatedAt,
        modelProvider: "openai",
        model: "gpt-5",
      });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "startup hydrate", { timestamp: updatedAt }),
      ]);
      const preparedMetadata = await rpcReq(ws, "chat.metadata", { agentId: "main" });
      expect(preparedMetadata.ok).toBe(true);

      const startup = await rpcReq<{
        metadata?: {
          commands?: Array<{ name?: string; textAliases?: string[] }>;
          models?: Array<{ id?: string; provider?: string }>;
        };
        messages?: unknown[];
        sessionInfo?: { key?: string; sessionId?: string };
      }>(ws, "chat.startup", makeMainSessionParams());
      const agents = await rpcReq<{
        agents?: Array<{
          id?: string;
          createdVia?: string;
          creatorAgentId?: string | null;
          createdAt?: number;
        }>;
        defaultId?: string | null;
        mainKey?: string | null;
      }>(ws, "agents.list", {});

      expect(startup.ok).toBe(true);
      expect(startup.payload).not.toHaveProperty("agentsList");
      expect(agents.ok).toBe(true);
      expect(agents.payload?.defaultId).toBe("main");
      expect(agents.payload?.mainKey).toBe("main");
      expect(agents.payload?.agents?.map((agent) => agent.id)).toContain("main");
      expect(agents.payload?.agents?.find((agent) => agent.id === "research")).toMatchObject({
        createdVia: "agent",
        creatorAgentId: "main",
        createdAt: 42,
      });
      expect(startup.payload?.sessionInfo).toMatchObject({
        key: "agent:main:main",
        sessionId: "sess-main",
      });
      expect(startup.payload?.metadata?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "gpt-main",
            provider: "openai",
          }),
        ]),
      );
      expect(startup.payload?.metadata?.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "model",
            textAliases: expect.arrayContaining(["/model"]),
          }),
        ]),
      );
      expect(startup.payload?.messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: "user",
            content: [{ type: "text", text: "startup hydrate" }],
          }),
        ]),
      );
    });
  });

  test("chat.startup omits model metadata from a fallback owner", async () => {
    const config = {
      agents: {
        defaults: {},
        list: [{ id: "main", default: true }, { id: "work" }],
      },
    } as OpenClawConfig;
    const context = createDirectChatContext({
      getRuntimeConfig: () => config,
      loadGatewayModelCatalogSnapshot: vi.fn(async () => ({
        agentId: "main",
        agentDir: "/tmp/chat-main-agent",
        catalogComplete: false,
        workspaceDir: "/tmp/chat-main-workspace",
        config,
        entries: [{ id: "main-only", name: "Main only", provider: "test" }],
        routeVariants: [],
      })),
    });
    testState.agentsConfig = config.agents;
    openDirectChatSession();
    try {
      await writeSessionStore({
        agentId: "work",
        entries: { "agent:work:main": { sessionId: "sess-work", updatedAt: Date.now() } },
      });
      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      await callDirectChat("chat.startup", {
        id: "startup-fallback-owner",
        params: { sessionKey: "agent:work:main" },
        respond: captureChatResponse(responses),
        context,
      });

      expect(responses[0]?.ok, JSON.stringify(responses[0])).toBe(true);
      expect(
        (responses[0]?.payload as { metadata?: { models?: unknown[] } })?.metadata?.models,
      ).toBe(undefined);
      expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
    } finally {
      testState.agentsConfig = undefined;
      testState.sessionStorePath = undefined;
    }
  });

  test("chat.startup does not start optional model catalog discovery", async () => {
    openDirectChatSession();
    try {
      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "slow-catalog-model",
      });
      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext({
        loadGatewayModelCatalogSnapshot: vi.fn(),
        getRuntimeConfig: () => ({}),
      });
      await callDirectChat("chat.startup", {
        id: "startup-slow-catalog",
        params: makeMainSessionParams(),
        respond: captureChatResponse(responses),
        context,
      });

      expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      expect(responses).toHaveLength(1);
      expect(responses[0]?.ok).toBe(true);
      const payload = responses[0]?.payload as
        | {
            metadata?: unknown;
            sessionInfo?: { sessionId?: string };
          }
        | undefined;
      expect(payload?.sessionInfo?.sessionId).toBe("sess-main");
      expect(payload?.metadata).toBeUndefined();
    } finally {
      testState.sessionStorePath = undefined;
    }
  });

  test.each([
    { method: "chat.startup", profile: false, delta: false, thinkingLevel: undefined },
    { method: "chat.history", profile: false, delta: false, thinkingLevel: undefined },
    { method: "chat.history", profile: true, delta: false, thinkingLevel: undefined },
    { method: "chat.history", profile: true, delta: true, thinkingLevel: undefined },
    { method: "chat.history", profile: true, delta: false, thinkingLevel: "off" },
    { method: "chat.history", profile: true, delta: true, thinkingLevel: "off" },
  ] as const)(
    "$method returns transcript while metadata replacement is pending (profile=$profile delta=$delta thinking=$thinkingLevel)",
    async ({ method, profile, delta, thinkingLevel }) => {
      const { storePath } = openDirectChatSession();
      testState.agentConfig = { thinkingDefault: "medium" };
      try {
        await writeStoredMainSession({
          thinkingLevel,
          ...(profile
            ? {
                authProfileOverride: "test:session",
                authProfileOverrideSource: "user",
              }
            : {}),
        });
        await writeMainSessionTranscript([
          createTextTranscriptEvent("user", "paint without metadata"),
        ]);
        const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
        const context = createDirectChatContext({ getRuntimeConfig: () => ({}) });
        let cursor: string | undefined;
        if (delta) {
          const initial: CapturedChatResponse[] = [];
          await callDirectChat("chat.history", {
            id: "history-before-metadata-replacement",
            params: makeMainSessionParams(),
            respond: captureChatResponse(initial),
            context,
          });
          expect(initial[0]?.ok).toBe(true);
          const initialPayload = expectDefined(initial[0]?.payload, "initial history page") as {
            deltaCursor?: string;
          };
          cursor = initialPayload.deltaCursor;
          expect(cursor).toEqual(expect.any(String));
        }
        const metadataRuntime = createGatewayChatMetadataRuntime({
          getConfig: () => ({}),
          getContext: () => context,
          log: context.logGateway,
        });
        context.readChatStartupProjection = metadataRuntime.readStartup;
        metadataRuntime.invalidate();

        const startup = callDirectChat(method, {
          id: "startup-neutral-pending-metadata",
          params: makeMainSessionParams(delta ? { cursor } : {}),
          respond: captureChatResponse(responses),
          context,
        });

        try {
          await vi.waitFor(() => expect(responses).toHaveLength(1), FAST_WAIT_OPTS);
          if (delta) {
            expect(responses[0]).toMatchObject({
              ok: true,
              payload: { kind: "delta", messages: [] },
            });
          } else {
            expect(responses[0]).toMatchObject({
              ok: true,
              payload: {
                messages: [
                  expect.objectContaining({
                    role: "user",
                    content: [{ type: "text", text: "paint without metadata" }],
                  }),
                ],
              },
            });
          }
          expect(responses[0]?.payload).not.toHaveProperty("metadata");
          const payload = responses[0]?.payload as {
            sessionInfo: {
              thinkingLevel?: string | null;
              thinkingDefault?: string;
            };
          };
          expect(payload.sessionInfo.thinkingDefault).toBe("medium");
          expect(payload.sessionInfo.thinkingLevel ?? null).toBe(thinkingLevel ?? null);
          const stored = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
          expect(stored?.thinkingLevel).toBe(thinkingLevel);
          expect(stored?.authProfileOverride).toBe(profile ? "test:session" : undefined);
        } finally {
          metadataRuntime.fail(new Error("test metadata replacement stopped"));
          await startup;
        }
      } finally {
        testState.agentConfig = undefined;
        testState.sessionStorePath = undefined;
        clearConfigCache();
      }
    },
  );

  test.each<{
    name: string;
    preparedReasoning?: boolean;
    rawCatalog: "slow" | "empty" | "nonreasoning" | "prepared";
    configured?: { agent?: "off" | "low"; model?: "off" | "medium"; global?: "off" | "high" };
    thinkingLevel?: "off" | "xhigh";
    preparedEmpty?: boolean;
    preparedUnknown?: boolean;
    expectedDefault?: string;
  }>([
    {
      name: "inherits prepared Medium while raw discovery is slow",
      preparedReasoning: true,
      rawCatalog: "slow",
      expectedDefault: "medium",
    },
    {
      name: "inherits prepared Medium when the raw catalog is empty",
      preparedReasoning: true,
      rawCatalog: "empty",
      expectedDefault: "medium",
    },
    {
      name: "inherits prepared Medium over a non-reasoning raw route",
      preparedReasoning: true,
      rawCatalog: "nonreasoning",
      expectedDefault: "medium",
    },
    { name: "leaves unavailable prepared metadata unknown", rawCatalog: "slow" },
    {
      name: "keeps identity-only prepared metadata unknown and explicit XHigh intact",
      rawCatalog: "empty",
      preparedUnknown: true,
      thinkingLevel: "xhigh",
    },
    {
      name: "respects a prepared non-reasoning model",
      preparedReasoning: false,
      rawCatalog: "prepared",
      expectedDefault: "off",
    },
    {
      name: "respects configured Off without prepared metadata",
      rawCatalog: "slow",
      configured: { global: "off" },
      expectedDefault: "off",
    },
    {
      name: "keeps an empty prepared catalog unknown",
      rawCatalog: "nonreasoning",
      preparedEmpty: true,
    },
    {
      name: "respects per-model Off over the global default without metadata",
      rawCatalog: "slow",
      configured: { model: "off", global: "high" },
      expectedDefault: "off",
    },
    {
      name: "respects per-agent Off over model and global defaults without metadata",
      rawCatalog: "slow",
      configured: { agent: "off", model: "medium", global: "high" },
      expectedDefault: "off",
    },
    {
      name: "respects per-model Medium over global Off without metadata",
      rawCatalog: "slow",
      configured: { model: "medium", global: "off" },
      expectedDefault: "medium",
    },
    {
      name: "respects per-agent Low over model and global defaults without metadata",
      rawCatalog: "slow",
      configured: { agent: "low", model: "medium", global: "high" },
      expectedDefault: "low",
    },
    {
      name: "keeps explicit Off when the inherited default is unknown",
      rawCatalog: "slow",
      thinkingLevel: "off",
    },
    {
      name: "keeps explicit Off separate from inherited Medium",
      preparedReasoning: true,
      rawCatalog: "prepared",
      thinkingLevel: "off",
      expectedDefault: "medium",
    },
  ])("chat.history reasoning-default projection $name", async (fixture) => {
    const { storePath } = openDirectChatSession();
    preparedThinkingPolicy.fallback = "base";
    try {
      testState.agentConfig = {
        model: { primary: "test-provider/slow-catalog-model" },
        thinkingDefault: fixture.configured?.global,
        models: {
          "test-provider/slow-catalog-model": { params: { thinking: fixture.configured?.model } },
        },
      };
      testState.agentsConfig = {
        defaults: testState.agentConfig,
        entries: { main: { thinkingDefault: fixture.configured?.agent } },
      };
      const config = { agents: testState.agentsConfig };

      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "slow-catalog-model",
        ...(fixture.thinkingLevel ? { thinkingLevel: fixture.thinkingLevel } : {}),
      });
      await appendTranscriptMessage(makeMainSessionScope(storePath), {
        eventId: "reasoning-projection-message",
        parentId: null,
        message: {
          role: "user",
          content: [{ type: "text", text: "reasoning projection" }],
        },
      });
      const preparedModel = {
        provider: "test-provider",
        id: "slow-catalog-model",
        name: "Reasoning Model",
        reasoning: fixture.preparedReasoning,
        compat: fixture.preparedUnknown
          ? undefined
          : { supportedReasoningEfforts: ["low", "medium", "high", "xhigh"] },
      };
      const preparedCatalog = [preparedModel];
      const rawSnapshot = {
        agentId: "main",
        agentDir: "/tmp/chat-history-agent",
        catalogComplete: false,
        workspaceDir: "/tmp/chat-history-workspace",
        config,
        entries:
          fixture.rawCatalog === "empty"
            ? []
            : fixture.rawCatalog === "nonreasoning"
              ? [{ ...preparedModel, reasoning: false }]
              : preparedCatalog,
        routeVariants: [],
      };
      const slowCatalog =
        createDeferred<
          Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>>
        >();
      const context = createDirectChatContext({
        loadGatewayModelCatalogSnapshot: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
          .mockReturnValue(
            fixture.rawCatalog === "slow" ? slowCatalog.promise : Promise.resolve(rawSnapshot),
          ),
        getRuntimeConfig: () => config,
        readChatStartupProjection: async () =>
          fixture.preparedEmpty
            ? {
                metadata: { swarmEnabled: false },
                sessionModelCatalog: [],
                defaultModelCatalog: [],
              }
            : fixture.preparedReasoning === undefined && !fixture.preparedUnknown
              ? undefined
              : {
                  metadata: { models: preparedCatalog, swarmEnabled: false },
                  sessionModelCatalog: preparedCatalog,
                  defaultModelCatalog: preparedCatalog,
                },
      });
      try {
        let cursor: string | undefined;
        for (const mode of ["startup", "page", "delta"] as const) {
          if (mode === "delta") {
            await appendTranscriptMessage(makeMainSessionScope(storePath), {
              eventId: "reasoning-projection-reply",
              parentId: "reasoning-projection-message",
              message: {
                role: "assistant",
                content: [{ type: "text", text: "reasoning reply" }],
              },
            });
          }
          const responses: CapturedChatResponse[] = [];
          await callDirectChat(mode === "startup" ? "chat.startup" : "chat.history", {
            id: `history-reasoning-${mode}`,
            params: makeMainSessionParams(mode === "delta" ? { cursor } : {}),
            respond: captureChatResponse(responses),
            context,
          });

          expect(responses).toHaveLength(1);
          expect(responses[0]?.ok, JSON.stringify(responses[0]?.error)).toBe(true);
          const payload = responses[0]?.payload as {
            kind?: string;
            deltaCursor?: string;
            messages: Array<{ session?: Record<string, unknown> }>;
            thinkingLevel?: string;
            defaults?: GatewaySessionsDefaults;
            sessionInfo: {
              sessionId?: string;
              modelProvider?: string;
              model?: string;
              agentRuntime?: unknown;
              activeLeafEntryId?: string | null;
              thinkingLevel?: string | null;
              thinkingDefault?: string;
              thinkingLevels?: Array<{ id: string; label: string }>;
              thinkingOptions?: string[];
            };
          };
          expect(payload.sessionInfo, mode).toMatchObject({
            sessionId: "sess-main",
            modelProvider: "test-provider",
            model: "slow-catalog-model",
          });
          if (mode !== "startup") {
            expect(payload).not.toHaveProperty("metadata");
          }
          if (mode === "delta") {
            expect(payload.kind).toBe("delta");
            expect(payload.messages).toHaveLength(1);
            expect(payload.messages[0]?.session).toMatchObject({
              sessionId: payload.sessionInfo.sessionId,
              modelProvider: payload.sessionInfo.modelProvider,
              model: payload.sessionInfo.model,
              agentRuntime: payload.sessionInfo.agentRuntime,
              thinkingLevel: fixture.thinkingLevel ?? null,
            });
            for (const field of ["thinkingDefault", "thinkingLevels", "thinkingOptions"]) {
              expect(payload.messages[0]?.session).not.toHaveProperty(field);
            }
            expect(payload.sessionInfo.activeLeafEntryId).toBe("reasoning-projection-reply");
            expect(payload.deltaCursor).toEqual(expect.any(String));
            expect(payload.deltaCursor).not.toBe(cursor);
          } else {
            expect(payload.messages).toEqual([
              expect.objectContaining({
                content: [{ type: "text", text: "reasoning projection" }],
              }),
            ]);
            expect(payload.deltaCursor).toEqual(expect.any(String));
            cursor = payload.deltaCursor;
            expect
              .soft(payload.thinkingLevel, `${mode} effective thinking`)
              .toBe(fixture.thinkingLevel ?? fixture.expectedDefault);
          }
          expect(payload.sessionInfo.thinkingLevel ?? null, `${mode} override`).toBe(
            fixture.thinkingLevel ?? null,
          );
          const projections =
            mode === "delta"
              ? [payload.sessionInfo]
              : [payload.sessionInfo, expectDefined(payload.defaults, "page defaults")];
          for (const projection of projections) {
            expect
              .soft(projection.thinkingDefault, `${mode} default`)
              .toBe(fixture.expectedDefault);
            if (fixture.preparedReasoning === true) {
              expect
                .soft(
                  projection.thinkingLevels?.map((level) => level.id),
                  `${mode} supported levels`,
                )
                .toEqual(expect.arrayContaining(["medium", "xhigh"]));
            } else if (fixture.preparedReasoning === false) {
              expect(
                projection.thinkingLevels?.map((level) => level.id),
                mode,
              ).toEqual(["off"]);
            } else {
              expect.soft(projection.thinkingLevels, `${mode} unknown levels`).toBeUndefined();
              expect.soft(projection.thinkingOptions, `${mode} unknown options`).toBeUndefined();
            }
          }
          expect(
            loadSessionEntry({ sessionKey: "agent:main:main", storePath })?.thinkingLevel,
          ).toBe(fixture.thinkingLevel);
        }
        expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
      } finally {
        slowCatalog.resolve(rawSnapshot);
      }
    } finally {
      preparedThinkingPolicy.fallback = "off";
      testState.agentConfig = undefined;
      testState.agentsConfig = undefined;
      testState.sessionStorePath = undefined;
      clearConfigCache();
    }
  });

  test("chat.startup and chat.history preserve reasoning-default projection per agent and session auth", async () => {
    await withOpenClawTestState(
      {
        layout: "state-only",
        prefix: "openclaw-gw-startup-routes-",
        agentEnv: "main",
        env: {
          CHATGPT_OAUTH_TOKEN: undefined,
          CODEX_API_KEY: undefined,
          CODEX_HOME: "/__openclaw_gateway_startup_routes__/codex",
          OPENCLAW_BUNDLED_PLUGINS_DIR: path.resolve("extensions"),
          OPENCLAW_DISABLE_BUNDLED_PLUGINS: undefined,
          OPENAI_API_KEY: undefined,
          OPENAI_BASE_URL: undefined,
          OPENAI_OAUTH_TOKEN: undefined,
        },
      },
      async (state) => {
        let releasePluginMetadata: () => boolean = () => false;
        const previousAgentConfig = testState.agentConfig;
        const previousAgentsConfig = testState.agentsConfig;
        openDirectChatSession();
        try {
          const config = {
            agents: {
              ownership: "explicit" as const,
              defaults: {
                model: { primary: "openai/gpt-5.5" },
                models: { "openai/gpt-5.5": {} },
                heartbeat: { agentId: "main" },
                sessionStore: { agentId: "main" },
                systemAgent: { agentId: "main" },
              },
              entries: { main: {}, work: {} },
            },
            auth: {
              order: { openai: ["openai:api", "openai:chatgpt", "openai:expired"] },
            },
            talk: { agentId: "main" },
          };
          await state.writeConfig(config);
          clearConfigCache();
          const pluginMetadataSnapshot = createGatewayPluginMetadataSnapshot(config);
          assertPluginMetadataSnapshotConsistency(pluginMetadataSnapshot);
          releasePluginMetadata = installTemporaryCurrentPluginMetadataSnapshot(
            pluginMetadataSnapshot,
            {
              config,
              compatibleConfigs: [config],
              env: process.env,
            },
          ).release;
          const persistedConfig = getRuntimeConfig();
          expect(persistedConfig.auth?.order?.openai).toEqual([
            "openai:api",
            "openai:chatgpt",
            "openai:expired",
          ]);
          testState.agentsConfig = persistedConfig.agents;
          testState.agentConfig = persistedConfig.agents?.defaults;
          await writeSessionStore({
            entries: {
              "agent:work:main": {
                sessionId: "sess-work",
                modelProvider: "openai",
                model: "gpt-5.5",
                authProfileOverride: "openai:chatgpt",
                authProfileOverrideSource: "user",
                updatedAt: Date.now(),
              },
              "agent:work:auto": {
                sessionId: "sess-work-auto",
                modelProvider: "openai",
                model: "gpt-5.5",
                authProfileOverride: "openai:expired",
                authProfileOverrideSource: "auto",
                updatedAt: Date.now(),
              },
              "agent:work:auto-preferred": {
                sessionId: "sess-work-auto-preferred",
                modelProvider: "openai",
                model: "gpt-5.5",
                authProfileOverride: "openai:chatgpt",
                authProfileOverrideSource: "auto",
                updatedAt: Date.now(),
              },
              "agent:work:legacy-auto": {
                sessionId: "sess-work-legacy-auto",
                modelProvider: "openai",
                model: "gpt-5.5",
                authProfileOverride: "openai:expired",
                authProfileOverrideCompactionCount: 0,
                updatedAt: Date.now(),
              },
            },
          });
          const { loadGatewaySessionEntryReadOnly } = await import("./session-utils.js");
          const loaded = loadGatewaySessionEntryReadOnly("agent:work:main");
          expect(loaded.cfg.agents?.defaults?.model).toEqual(config.agents.defaults.model);
          expect(loaded.cfg.agents?.entries).toEqual(config.agents.entries);
          expect(loaded.canonicalKey).toBe("agent:work:main");
          expect(loaded.entry).toMatchObject({
            sessionId: "sess-work",
            modelProvider: "openai",
            model: "gpt-5.5",
            authProfileOverride: "openai:chatgpt",
          });
          await state.writeAuthProfiles({
            version: 1,
            profiles: {
              "openai:chatgpt": {
                type: "oauth",
                provider: "openai",
                access: "chatgpt-access",
                refresh: "chatgpt-refresh",
                expires: Date.now() + 30 * 60_000,
              },
            },
          });
          await state.writeAuthProfiles(
            {
              version: 1,
              profiles: {
                "openai:api": {
                  type: "api_key",
                  provider: "openai",
                  key: "platform-api-key",
                },
                "openai:chatgpt": {
                  type: "oauth",
                  provider: "openai",
                  access: "work-chatgpt-access",
                  refresh: "work-chatgpt-refresh",
                  expires: Date.now() + 30 * 60_000,
                },
                "openai:expired": {
                  type: "oauth",
                  provider: "openai",
                  access: "expired-work-chatgpt-access",
                  expires: Date.now() - 60_000,
                },
              },
            },
            "work",
          );
          const platformRoute = {
            id: "gpt-5.5",
            name: "GPT-5.5",
            provider: "openai",
            api: "openai-responses" as const,
            baseUrl: "https://api.openai.com/v1",
            contextWindow: 1_000_000,
            reasoning: true,
            compat: { supportedReasoningEfforts: ["none", "low", "medium", "high", "xhigh"] },
          };
          const subscriptionRoute = {
            ...platformRoute,
            api: "openai-chatgpt-responses" as const,
            baseUrl: "https://chatgpt.com/backend-api/codex",
            contextWindow: 400_000,
            reasoning: false,
            compat: { supportedReasoningEfforts: ["low"] },
            params: { apiKey: "private-route-token" },
          };
          const catalogSnapshot = {
            entries: [subscriptionRoute],
            routeVariants: [subscriptionRoute, platformRoute],
          };
          const { loadAuthProfileStoreForRuntime } = await import("../agents/auth-profiles.js");
          const { resolveAgentDir } = await import("../agents/agent-scope.js");
          const preparedAuthStoreByAgentId = new Map([
            [
              "main",
              loadAuthProfileStoreForRuntime(resolveAgentDir(persistedConfig, "main"), {
                readOnly: true,
              }),
            ],
            [
              "work",
              loadAuthProfileStoreForRuntime(resolveAgentDir(persistedConfig, "work"), {
                inheritedAuthDir: resolveAgentDir(persistedConfig, "main"),
                readOnly: true,
              }),
            ],
          ]);
          const requirePreparedAuthStore = (agentId: string) => {
            const authStore = preparedAuthStoreByAgentId.get(agentId);
            if (!authStore) {
              throw new Error(`expected prepared auth store for agent "${agentId}"`);
            }
            return authStore;
          };
          const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
          const { buildModelsListResult, createGatewayAgentModelCatalogProjector } =
            await import("./server-methods/models-list-result.js");
          const projectionByKey = new Map<
            string,
            Promise<{
              modelCatalog: ModelCatalogEntry[];
              metadata: { models: unknown[]; swarmEnabled: boolean };
            }>
          >();
          const projectAgent = (
            context: GatewayRequestContext,
            agentId: string,
            sessionEntry?: Parameters<GatewayRequestContext["readChatMetadata"]>[0]["sessionEntry"],
          ) => {
            const profileId = sessionEntry?.authProfileOverride?.trim();
            const profileSource = sessionEntry?.authProfileOverrideSource;
            const legacyUserProfile =
              profileSource === undefined &&
              sessionEntry?.authProfileOverrideCompactionCount === undefined;
            const key = [
              agentId,
              profileId ?? "",
              profileId && (profileSource === "user" || legacyUserProfile) ? profileId : "",
            ].join("\0");
            const existing = projectionByKey.get(key);
            if (existing) {
              return existing;
            }
            const projector = createGatewayAgentModelCatalogProjector({
              cfg: persistedConfig,
              agentId,
              snapshot: catalogSnapshot,
              metadataSnapshot: pluginMetadataSnapshot,
              preparedAuthStore: requirePreparedAuthStore(agentId),
              ...(profileId ? { preferredProfileId: profileId } : {}),
              ...(profileId && (profileSource === "user" || legacyUserProfile)
                ? { lockedProfileId: profileId }
                : {}),
            });
            const projection = Promise.all([
              projector.projectCatalog(),
              buildModelsListResult({
                context,
                agentId,
                params: { view: "configured" },
                preloadedCatalog: {
                  agentId,
                  config: persistedConfig,
                  snapshot: catalogSnapshot,
                },
                preloadedOnly: true,
                catalogProjector: projector,
              }),
            ]).then(([modelCatalog, metadata]) => ({
              modelCatalog,
              metadata: { ...metadata, swarmEnabled: false },
            }));
            projectionByKey.set(key, projection);
            return projection;
          };
          const context = createDirectChatContext({
            loadGatewayModelCatalogSnapshot: vi
              .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
              .mockResolvedValue({
                agentId: "work",
                agentDir: "/tmp/chat-work-agent",
                catalogComplete: false,
                workspaceDir: "/tmp/chat-work-workspace",
                config: persistedConfig,
                ...catalogSnapshot,
              }),
            getRuntimeConfig: () => persistedConfig,
            readChatStartupProjection: vi.fn(async ({ agentId, sessionEntry }) => {
              const [neutralProjection, sessionProjection] = await Promise.all([
                projectAgent(context, agentId),
                projectAgent(context, agentId, sessionEntry),
              ]);
              preparedThinkingPolicy.fallback = sessionProjection.modelCatalog.some(
                (entry) => entry.reasoning === true,
              )
                ? "base"
                : "off";
              return {
                metadata: sessionProjection.metadata,
                sessionModelCatalog: sessionProjection.modelCatalog,
                defaultModelCatalog: neutralProjection.modelCatalog,
              };
            }),
          });
          const expiredPreferenceEvaluation = await createGatewayAgentModelCatalogProjector({
            cfg: persistedConfig,
            agentId: "work",
            snapshot: catalogSnapshot,
            metadataSnapshot: pluginMetadataSnapshot,
            preparedAuthStore: requirePreparedAuthStore("work"),
            preferredProfileId: "openai:expired",
          }).evaluateEntry(subscriptionRoute, catalogSnapshot.routeVariants);
          expect(expiredPreferenceEvaluation).toMatchObject({
            availability: true,
            selectedProfileId: "openai:api",
            selectedRoute: { authRequirement: "api-key" },
          });
          // Main only has subscription auth; work's neutral default selects API auth.
          // Keep the Off-only default control separate from work's locked session profile.
          await callDirectChat("chat.startup", {
            id: "startup-main-neutral-route",
            params: { sessionKey: "agent:main:main" },
            respond: captureChatResponse(responses),
            context,
          });
          expect(responses).toHaveLength(1);
          expect(responses[0]?.ok, JSON.stringify(responses[0]?.error)).toBe(true);
          const mainPayload = responses[0]?.payload as {
            defaults?: GatewaySessionsDefaults;
            sessionInfo?: { thinkingLevels?: Array<{ id: string }> };
          };
          expect(mainPayload.defaults).toMatchObject({ modelProvider: "openai", model: "gpt-5.5" });
          expect(mainPayload.defaults?.thinkingLevels?.map((level) => level.id)).toEqual(["off"]);
          expect(mainPayload.sessionInfo?.thinkingLevels?.map((level) => level.id)).toEqual([
            "off",
          ]);
          responses.length = 0;
          await callDirectChat("chat.startup", {
            id: "startup-dual-route-catalog",
            params: { sessionKey: "agent:work:main" },
            respond: captureChatResponse(responses),
            context,
          });

          expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
          expect(responses).toHaveLength(1);
          expect(responses[0]?.ok).toBe(true);
          const payload = responses[0]?.payload as
            | {
                metadata?: { models?: unknown[] };
                sessionInfo?: { thinkingLevels?: Array<{ id?: string }> };
                defaults?: { thinkingLevels?: Array<{ id?: string }> };
              }
            | undefined;
          expect(payload?.metadata?.models).toEqual([
            expect.objectContaining({
              id: "gpt-5.5",
              name: "GPT-5.5",
              provider: "openai",
              agentRuntime: {
                id: "codex",
                cloudPlacementSupported: false,
                devicePlacementSupported: false,
                source: "implicit",
              },
              contextWindow: 400_000,
              reasoning: false,
              available: true,
            }),
          ]);
          expect(payload?.sessionInfo?.thinkingLevels?.map((level) => level.id)).toEqual(["off"]);
          expect(payload?.defaults?.thinkingLevels?.map((level) => level.id)).toEqual([
            "off",
            "minimal",
            "low",
            "medium",
            "high",
            "xhigh",
          ]);
          const serialized = JSON.stringify(responses[0]?.payload);
          expect(serialized).not.toContain("private-route-token");
          expect(serialized).not.toContain("platform-api-key");
          expect(serialized).not.toContain("chatgpt-access");
          expect(serialized).not.toContain("supportedReasoningEfforts");
          expect(serialized).not.toContain(platformRoute.baseUrl);
          expect(serialized).not.toContain(subscriptionRoute.baseUrl);

          for (const [index, [sessionKey, sessionId, expectedRoute]] of [
            ["agent:work:auto-preferred", "sess-work-auto-preferred", "subscription"],
            ["agent:work:auto", "sess-work-auto", "platform"],
            ["agent:work:legacy-auto", "sess-work-legacy-auto", "platform"],
          ].entries()) {
            await writeMainSessionTranscript(
              [
                createTextTranscriptEvent("user", "route reasoning", {
                  id: "route-message",
                  parentId: null,
                }),
              ],
              sessionId,
              { agentId: "work", sessionKey },
            );
            responses.length = 0;
            await callDirectChat("chat.startup", {
              id: `startup-preferred-route-${index}`,
              params: { sessionKey },
              respond: ((ok, responsePayload, error) => {
                responses.push({ ok, payload: responsePayload, error });
              }) as RespondFn,
              context,
            });

            expect(responses).toHaveLength(1);
            expect(responses[0]?.ok).toBe(true);
            const preferredPayload = responses[0]?.payload as
              | {
                  metadata?: { models?: Array<{ contextWindow?: number }> };
                  defaults?: GatewaySessionsDefaults;
                  sessionInfo?: {
                    agentRuntime?: unknown;
                    thinkingLevel?: string;
                    thinkingDefault?: string;
                    thinkingLevels?: Array<{ id?: string }>;
                    thinkingOptions?: string[];
                  };
                }
              | undefined;
            expect(preferredPayload?.metadata?.models?.[0]?.contextWindow, sessionKey).toBe(
              expectedRoute === "subscription" ? 400_000 : 1_000_000,
            );
            const thinkingLevels = preferredPayload?.sessionInfo?.thinkingLevels?.map(
              (level) => level.id,
            );
            if (expectedRoute === "subscription") {
              expect(thinkingLevels, sessionKey).toEqual(["off"]);
            } else {
              expect(thinkingLevels, sessionKey).toContain("high");
            }
            expect(preferredPayload?.sessionInfo?.thinkingLevel ?? null).toBeNull();
            let cursor: string | undefined;
            for (const mode of ["page", "delta"] as const) {
              responses.length = 0;
              await callDirectChat("chat.history", {
                id: `history-preferred-route-${index}-${mode}`,
                params: { sessionKey, ...(mode === "delta" ? { cursor } : {}) },
                respond: captureChatResponse(responses),
                context,
              });
              expect(responses).toHaveLength(1);
              expect(responses[0]?.ok, JSON.stringify(responses[0]?.error)).toBe(true);
              const history = responses[0]?.payload as {
                kind?: string;
                deltaCursor?: string;
                thinkingLevel?: string;
                defaults?: GatewaySessionsDefaults;
                sessionInfo?: NonNullable<typeof preferredPayload>["sessionInfo"];
              };
              const label = `${sessionKey} ${mode}`;
              if (mode === "delta") {
                expect(history.kind, label).toBe("delta");
              } else {
                expect(history.deltaCursor, label).toEqual(expect.any(String));
                cursor = history.deltaCursor;
                expect(history.defaults, `${label} neutral defaults`).toEqual(
                  preferredPayload?.defaults,
                );
                expect
                  .soft(history.thinkingLevel, `${label} effective thinking`)
                  .toBe(preferredPayload?.sessionInfo?.thinkingDefault);
              }
              expect(history.sessionInfo?.thinkingLevel ?? null, `${label} override`).toBeNull();
              expect(history.sessionInfo?.agentRuntime, `${label} runtime`).toEqual(
                preferredPayload?.sessionInfo?.agentRuntime,
              );
              expect
                .soft(history.sessionInfo?.thinkingDefault, `${label} default`)
                .toBe(preferredPayload?.sessionInfo?.thinkingDefault);
              expect
                .soft(history.sessionInfo?.thinkingLevels, `${label} supported levels`)
                .toEqual(preferredPayload?.sessionInfo?.thinkingLevels);
              expect
                .soft(history.sessionInfo?.thinkingOptions, `${label} supported options`)
                .toEqual(preferredPayload?.sessionInfo?.thinkingOptions);
            }
          }
        } finally {
          preparedThinkingPolicy.fallback = "off";
          testState.agentConfig = previousAgentConfig;
          testState.agentsConfig = previousAgentsConfig;
          testState.sessionStorePath = undefined;
          releasePluginMetadata();
          clearConfigCache();
        }
      },
    );
  });

  test("chat.startup serves prepared metadata when configured visibility needs full discovery", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      await writeGatewayConfig({
        agents: {
          defaults: {
            model: { primary: "openai/gpt-main" },
            models: {
              "openai/*": {},
            },
          },
          entries: { main: { default: true } },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [{ id: "gpt-main", name: "GPT Main" }],
            },
          },
        },
      });
      await connectOk(ws);
      const preparedMetadata = await rpcReq(ws, "chat.metadata", { agentId: "main" });
      expect(preparedMetadata.ok).toBe(true);

      const startup = await rpcReq<{
        metadata?: { models?: Array<{ id?: string; provider?: string }> };
      }>(ws, "chat.startup", makeMainSessionParams());

      expect(startup.ok).toBe(true);
      expect(startup.payload?.metadata?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "gpt-main",
            provider: "openai",
          }),
        ]),
      );
    });
  });

  test.each(["chat.startup", "chat.history"] as const)(
    "%s scopes metadata to agent session keys without explicit agentId",
    async (method) => {
      openDirectChatSession();
      try {
        await writeSessionStore({
          entries: {
            "agent:work:main": {
              sessionId: "sess-work",
              updatedAt: Date.now(),
            },
          },
        });
        const config = {
          agents: {
            defaults: {
              model: {
                primary: "openai/gpt-main",
              },
              models: {
                "openai/gpt-main": {},
              },
            },
            entries: {
              main: { default: true },
              work: {
                model: {
                  primary: "minimax/MiniMax-M2.7-highspeed",
                },
                models: {
                  "minimax/MiniMax-M2.7-highspeed": {},
                },
              },
            },
          },
          models: {
            providers: {
              openai: {
                baseUrl: "https://openai.example.com/v1",
                models: [{ id: "gpt-main", name: "GPT Main" }],
              },
              minimax: {
                baseUrl: "https://minimax.example.com/v1",
                models: [{ id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" }],
              },
            },
          },
        } as unknown as OpenClawConfig;
        await writeGatewayConfig(config);
        const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
        const metadata = {
          models: [
            {
              id: "MiniMax-M2.7-highspeed",
              name: "MiniMax M2.7 Highspeed",
              provider: "minimax",
            },
          ],
          swarmEnabled: false,
        };
        const readChatStartupProjection = vi.fn(async () => ({
          metadata,
          sessionModelCatalog: metadata.models,
          defaultModelCatalog: metadata.models,
        }));
        const context = createDirectChatContext({
          loadGatewayModelCatalogSnapshot: vi
            .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
            .mockImplementation(async () => {
              await Promise.resolve();
              await Promise.resolve();
              const entries = [
                {
                  id: "gpt-main",
                  name: "GPT Main",
                  provider: "openai",
                },
                {
                  id: "MiniMax-M2.7-highspeed",
                  name: "MiniMax M2.7 Highspeed",
                  provider: "minimax",
                },
              ];
              return {
                agentId: "work",
                agentDir: "/tmp/chat-work-agent",
                catalogComplete: false,
                workspaceDir: "/tmp/chat-work-workspace",
                config,
                entries,
                routeVariants: entries,
              };
            }),
          getRuntimeConfig: () => config,
          readChatStartupProjection,
        });
        await callDirectChat(method, {
          id: "startup-agent-scoped-metadata",
          params: { sessionKey: "agent:work:main" },
          respond: captureChatResponse(responses),
          context,
        });

        expect(context.loadGatewayModelCatalogSnapshot).not.toHaveBeenCalled();
        expect(readChatStartupProjection).toHaveBeenCalledWith(
          expect.objectContaining({
            agentId: "work",
            sessionEntry: expect.objectContaining({ sessionId: "sess-work" }),
          }),
        );
        expect(context.readChatMetadata).not.toHaveBeenCalled();
        expect(responses).toHaveLength(1);
        expect(responses[0]?.ok).toBe(true);
        const payload = responses[0]?.payload as
          | {
              metadata?: {
                models?: Array<{ id?: string; provider?: string }>;
              };
              sessionInfo?: { key?: string; sessionId?: string };
              defaults?: { modelProvider?: string; model?: string };
            }
          | undefined;
        expect(payload?.sessionInfo).toMatchObject({
          key: "agent:work:main",
          sessionId: "sess-work",
        });
        expect(payload?.defaults).toMatchObject({
          model: "MiniMax-M2.7-highspeed",
          modelProvider: "minimax",
        });
        if (method === "chat.startup") {
          expect(payload?.metadata?.models).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                id: "MiniMax-M2.7-highspeed",
                provider: "minimax",
              }),
            ]),
          );
        } else {
          expect(payload).not.toHaveProperty("metadata");
        }
      } finally {
        testState.sessionStorePath = undefined;
      }
    },
  );

  test("chat.metadata coalesces configured models and text commands", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      await writeGatewayConfig({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-main",
              fallbacks: ["openai/gpt-fallback"],
            },
            models: {
              "openai/gpt-main": {},
            },
          },
          entries: {
            main: { default: true },
            work: {
              model: {
                primary: "minimax/MiniMax-M2.7-highspeed",
              },
              tools: { swarm: { enabled: true } },
            },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [
                { id: "gpt-main", name: "GPT Main" },
                { id: "gpt-fallback", name: "GPT Fallback" },
              ],
            },
            minimax: {
              baseUrl: "https://minimax.example.com/v1",
              models: [{ id: "MiniMax-M2.7-highspeed", name: "MiniMax M2.7 Highspeed" }],
            },
          },
        },
      });
      await connectOk(ws);

      const metadata = await rpcReq<{
        commands?: Array<{ name?: string; textAliases?: string[] }>;
        models?: Array<{ id?: string; provider?: string }>;
        swarmEnabled?: boolean;
      }>(ws, "chat.metadata", { agentId: "work" });

      expect(metadata.ok).toBe(true);
      expect(metadata.payload?.swarmEnabled).toBe(true);
      expect(metadata.payload?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "MiniMax-M2.7-highspeed",
            provider: "minimax",
          }),
        ]),
      );
      expect(metadata.payload?.commands).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "model",
            textAliases: expect.arrayContaining(["/model"]),
          }),
        ]),
      );
    });
  });

  test("chat.metadata preserves configured models when text commands require exec approvals migration", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      await writeGatewayConfig({
        agents: {
          defaults: {
            model: {
              primary: "openai/gpt-5.6-luna",
            },
            models: {
              "openai/gpt-5.6-luna": {},
              "openai/gpt-5.6-terra": {},
            },
          },
          entries: {
            main: { default: true },
          },
        },
        models: {
          providers: {
            openai: {
              baseUrl: "https://openai.example.com/v1",
              models: [
                { id: "gpt-5.6-luna", name: "GPT-5.6 Luna" },
                { id: "gpt-5.6-terra", name: "GPT-5.6 Terra" },
              ],
            },
          },
        },
      });
      await connectOk(ws);

      const legacyExecApprovalsPath = path.join(
        autoCleanupTempDirs.make("openclaw-chat-metadata-exec-approvals-"),
        "exec-approvals.json",
      );
      const commandsListResult = await import("./server-methods/commands-list-result.js");
      vi.spyOn(commandsListResult, "buildCommandsListResult").mockImplementationOnce(() => {
        throw new ExecApprovalsMigrationRequiredError(legacyExecApprovalsPath);
      });

      const metadata = await rpcReq<{
        commands?: Array<{ name?: string }>;
        models?: Array<{ id?: string; provider?: string }>;
      }>(ws, "chat.metadata", { agentId: "main" });

      expect(metadata.ok).toBe(true);
      expect(metadata.payload?.commands).toBeUndefined();
      expect(metadata.payload?.models).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: "gpt-5.6-luna", provider: "openai" }),
          expect.objectContaining({ id: "gpt-5.6-terra", provider: "openai" }),
        ]),
      );
    });
  });

  test("chat.metadata remains unavailable when configured models fail", async () => {
    await withGatewayChatHarness(async ({ ws }) => {
      await connectOk(ws);
      const modelsListResult = await import("./server-methods/models-list-result.js");
      vi.spyOn(modelsListResult, "buildModelsListResult").mockRejectedValue(
        new Error("configured model catalog unavailable"),
      );

      const metadata = await rpcReq(ws, "chat.metadata", { agentId: "main" });

      expect(metadata.ok).toBe(false);
      expect(metadata.error).toMatchObject({
        code: "UNAVAILABLE",
        message: expect.stringContaining("configured model catalog unavailable"),
      });
    });
  });

  test("chat.send returns in_flight when duplicate attachment send wins parsing race", async () => {
    openDirectChatSession();
    const dispatchRelease = createDeferred();
    try {
      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "vision-model",
      });

      const firstCatalogSnapshot =
        createDeferred<
          Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>>
        >();
      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext({
        loadGatewayModelCatalogSnapshot: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
          .mockImplementationOnce(() => firstCatalogSnapshot.promise)
          .mockResolvedValue(createChatVisionModelCatalogSnapshot()),
        getRuntimeConfig: () => ({}),
      });
      dispatchInboundMessageMock.mockImplementation(async () => dispatchRelease.promise);

      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      const params = makeChatSendParams({
        message: "see image",
        idempotencyKey: "idem-attachment-race",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: pngB64,
          },
        ],
      });
      const callSend = (id: string) =>
        callDirectChat("chat.send", {
          id,
          params,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });

      const first = Promise.resolve(callSend("first"));
      await waitForFast(() => {
        expect(context.loadGatewayModelCatalogSnapshot).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);

      await callSend("duplicate");
      expect(responses).toEqual([
        {
          id: "duplicate",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "in_flight" },
          error: undefined,
        },
      ]);

      firstCatalogSnapshot.resolve(createChatVisionModelCatalogSnapshot());
      await first;

      expect(responses).toEqual([
        {
          id: "duplicate",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "in_flight" },
          error: undefined,
        },
        {
          id: "first",
          ok: true,
          payload: { runId: "idem-attachment-race", status: "started" },
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(context.addChatRun).toHaveBeenCalledTimes(1);
      dispatchRelease.resolve();
      await waitForFast(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    } finally {
      dispatchRelease.resolve();
      resetDirectChatSession();
    }
  });

  test("chat.send discards prepared inbound media when a hook blocks the turn", async () => {
    openDirectChatSession();
    try {
      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "vision-model",
      });
      const context = createDirectChatContext({ getRuntimeConfig: () => ({}) });
      const inboundDir = path.join(getMediaDir(), "inbound");
      const inboundBaseline = new Set(await fs.readdir(inboundDir).catch(() => []));
      // A before_agent_run block persists only the redacted reason — no media
      // markers — so dispatch must discard the prepared refs on settle.
      dispatchInboundMessageMock.mockImplementationOnce(async (params: unknown) => {
        const recorder = (
          params as {
            replyOptions?: { userTurnTranscriptRecorder?: { markBlocked: () => void } };
          }
        ).replyOptions?.userTurnTranscriptRecorder;
        recorder?.markBlocked();
      });
      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      await callDirectChat("chat.send", {
        id: "blocked-turn-media",
        params: makeChatSendParams({
          message: "blocked turn with media",
          idempotencyKey: "idem-blocked-turn-media",
          attachments: [
            {
              type: "file",
              mimeType: "text/plain",
              fileName: "notes.txt",
              content: Buffer.from("offloaded inbound media").toString("base64"),
            },
          ],
        }),
        client: {
          connId: "conn-owner",
          connect: { device: { id: "dev-owner" }, scopes: ["operator.write"] },
        } as never,
        respond: ((ok, payload, error) => {
          responses.push({ ok, payload, error });
        }) as RespondFn,
        context,
      });
      expect(responses[0]?.ok).toBe(true);
      await waitForFast(async () => {
        const remaining = await fs.readdir(inboundDir).catch(() => []);
        expect(remaining.filter((name) => !inboundBaseline.has(name))).toEqual([]);
      }, FAST_WAIT_OPTS);
    } finally {
      resetDirectChatSession();
    }
  });

  test("chat.send discards prepared inbound media when setup throws before the ACK", async () => {
    openDirectChatSession();
    try {
      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "vision-model",
      });
      const context = createDirectChatContext({
        // Throwing from addChatRun exercises handleChatSendSetupError — one of
        // the pre-persistence exits that previously leaked staged media.
        addChatRun: vi.fn(() => {
          throw new Error("setup exploded before ack");
        }),
        getRuntimeConfig: () => ({}),
      });
      const inboundDir = path.join(getMediaDir(), "inbound");
      const inboundBaseline = new Set(await fs.readdir(inboundDir).catch(() => []));
      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      await callDirectChat("chat.send", {
        id: "setup-error-media",
        params: makeChatSendParams({
          message: "setup error with media",
          idempotencyKey: "idem-setup-error-media",
          attachments: [
            {
              // Non-image attachments always offload into the inbound media
              // store during preparation; the failed send must discard them.
              type: "file",
              mimeType: "text/plain",
              fileName: "notes.txt",
              content: Buffer.from("offloaded inbound media").toString("base64"),
            },
          ],
        }),
        client: {
          connId: "conn-owner",
          connect: { device: { id: "dev-owner" }, scopes: ["operator.write"] },
        } as never,
        respond: ((ok, payload, error) => {
          responses.push({ ok, payload, error });
        }) as RespondFn,
        context,
      });
      expect(responses).toEqual([
        {
          ok: false,
          payload: expect.objectContaining({ status: "error" }),
          error: expect.anything(),
        },
      ]);
      // Prepared inbound media has no transcript reference on this exit; the
      // admission cleanup owner must discard it or the file is orphaned
      // forever (the inbound sweep is off unless attachments.ttlHours is set).
      await waitForFast(async () => {
        const remaining = await fs.readdir(inboundDir).catch(() => []);
        expect(remaining.filter((name) => !inboundBaseline.has(name))).toEqual([]);
      }, FAST_WAIT_OPTS);
    } finally {
      resetDirectChatSession();
    }
  });

  test("chat.abort cancels chat.send during attachment preparation before ACK", async () => {
    openDirectChatSession();
    const firstCatalogSnapshot =
      createDeferred<
        Awaited<ReturnType<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>>
      >();
    try {
      await writeStoredMainSession({
        modelProvider: "test-provider",
        model: "vision-model",
      });

      const sendResponses: Array<{
        id: string;
        ok: boolean;
        payload?: unknown;
        error?: unknown;
      }> = [];
      const abortResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext({
        loadGatewayModelCatalogSnapshot: vi
          .fn<GatewayRequestContext["loadGatewayModelCatalogSnapshot"]>()
          .mockImplementationOnce(() => firstCatalogSnapshot.promise),
        getRuntimeConfig: () => ({}),
      });

      const inboundDir = path.join(getMediaDir(), "inbound");
      const inboundBaseline = new Set(await fs.readdir(inboundDir).catch(() => []));
      const pngB64 =
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
      const params = makeChatSendParams({
        message: "abort this image",
        idempotencyKey: "idem-attachment-abort",
        attachments: [
          {
            type: "image",
            mimeType: "image/png",
            fileName: "dot.png",
            content: pngB64,
          },
          {
            // Non-image attachments always offload into the inbound media
            // store during preparation; the aborted send must discard them.
            type: "file",
            mimeType: "text/plain",
            fileName: "notes.txt",
            content: Buffer.from("offloaded inbound media").toString("base64"),
          },
        ],
      });
      const client = {
        connId: "conn-owner",
        connect: {
          device: { id: "dev-owner" },
          scopes: ["operator.write"],
        },
      } as never;
      const first = Promise.resolve(
        callDirectChat("chat.send", {
          id: "first",
          params,
          client,
          respond: ((ok, payload, error) => {
            sendResponses.push({ id: "first", ok, payload, error });
          }) as RespondFn,
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.loadGatewayModelCatalogSnapshot).toHaveBeenCalledTimes(1);
        expect(context.chatAbortControllers.has("idem-attachment-abort")).toBe(true);
      }, FAST_WAIT_OPTS);

      await callDirectChat("chat.abort", {
        id: "abort",
        params: makeMainSessionParams({ runId: "idem-attachment-abort" }),
        client,
        respond: captureChatResponse(abortResponses),
        context,
      });

      expect(abortResponses).toEqual([
        {
          ok: true,
          payload: { ok: true, aborted: true, runIds: ["idem-attachment-abort"] },
          error: undefined,
        },
      ]);
      expect(context.chatAbortControllers.has("idem-attachment-abort")).toBe(false);

      await callDirectChat("chat.send", {
        id: "retry",
        params,
        client,
        respond: ((ok, payload, error) => {
          sendResponses.push({ id: "retry", ok, payload, error });
        }) as RespondFn,
        context,
      });

      expect(sendResponses).toEqual([
        {
          id: "retry",
          ok: true,
          payload: {
            runId: "idem-attachment-abort",
            status: "timeout",
            summary: "aborted",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
      ]);

      firstCatalogSnapshot.resolve(createChatVisionModelCatalogSnapshot());
      await first;

      expect(sendResponses).toEqual([
        {
          id: "retry",
          ok: true,
          payload: {
            runId: "idem-attachment-abort",
            status: "timeout",
            summary: "aborted",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
        {
          id: "first",
          ok: true,
          payload: {
            runId: "idem-attachment-abort",
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(context.addChatRun).not.toHaveBeenCalled();
      expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      // Prepared inbound media has no transcript reference on this exit; the
      // handler must discard it or the file is orphaned forever (the inbound
      // sweep is disabled unless attachments.ttlHours is set).
      await waitForFast(async () => {
        const remaining = await fs.readdir(inboundDir).catch(() => []);
        expect(remaining.filter((name) => !inboundBaseline.has(name))).toEqual([]);
      }, FAST_WAIT_OPTS);
    } finally {
      firstCatalogSnapshot.resolve(createChatVisionModelCatalogSnapshot());
      resetDirectChatSession();
    }
  });

  test("chat.abort cancels chat.send while lifecycle admission waits", async () => {
    const { storePath } = openDirectChatSession();
    const releaseMutation = createDeferred();
    try {
      await writeStoredMainSession({});
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: ["sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const abortResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext();
      const runId = "idem-lifecycle-wait-abort";
      const collidingFinalKey = `chat:pending:${runId}`;
      const collidingFinalEntry = {
        ts: Date.now(),
        ok: true,
        payload: { runId: `pending:${runId}`, status: "ok" },
      };
      context.dedupe.set(collidingFinalKey, collidingFinalEntry);
      const params = makeChatSendParams({
        message: "do not dispatch",
        idempotencyKey: runId,
      });
      const client = {
        connId: "conn-owner",
        connect: {
          device: { id: "dev-owner" },
          scopes: ["operator.write"],
        },
      } as never;
      const send = Promise.resolve(
        callDirectChat("chat.send", {
          id: "send",
          params,
          client,
          respond: captureChatResponse(sendResponses),
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);
      expect(context.dedupe.get(collidingFinalKey)).toBe(collidingFinalEntry);
      expect(context.chatAbortControllers.has(runId)).toBe(false);

      const retryResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      await callDirectChat("chat.send", {
        id: "retry",
        params,
        client,
        respond: captureChatResponse(retryResponses),
        context,
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: { runId, status: "in_flight" },
          error: undefined,
        },
      ]);
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);

      await callDirectChat("chat.abort", {
        id: "abort",
        params: makeMainSessionParams({ runId }),
        client,
        respond: captureChatResponse(abortResponses),
        context,
      });
      releaseMutation.resolve();
      await mutation;
      await send;

      expect(abortResponses).toEqual([
        {
          ok: true,
          payload: { ok: true, aborted: true, runIds: [runId] },
          error: undefined,
        },
      ]);
      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: {
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
      ]);
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
      expect(context.dedupe.get(collidingFinalKey)).toBe(collidingFinalEntry);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      resetDirectChatSession();
    }
  });

  test("chat.send rejects stale lifecycle work after admission waits", async () => {
    const { storePath } = openDirectChatSession();
    const releaseMutation = createDeferred();
    try {
      await writeStoredMainSession({});
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: ["sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext();
      const runId = "idem-stale-lifecycle";
      const params = makeChatSendParams({
        message: "do not resume after restart",
        idempotencyKey: runId,
      });
      const send = Promise.resolve(
        callDirectChat("chat.send", {
          id: "send",
          params,
          respond: captureChatResponse(sendResponses),
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);

      rotateAgentEventLifecycleGeneration();
      releaseMutation.resolve();
      await mutation;
      await send;

      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: {
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "restart",
            endedAt: expect.any(Number),
          },
          error: undefined,
        },
      ]);
      expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(false);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      resetDirectChatSession();
    }
  });

  test("chat.send does not recreate a session deleted while admission waits", async () => {
    openDirectChatSession();
    const performDeletion = createDeferred();
    let mutation: Promise<void> | undefined;
    try {
      await writeStoredMainSession({});
      const [{ deleteSessionEntryLifecycle }, { loadSessionEntry: loadGatewaySessionEntry }] =
        await Promise.all([
          import("../config/sessions/session-accessor.js"),
          import("./session-utils.js"),
        ]);
      const seededSession = loadGatewaySessionEntry("main");
      const seededSessionId = seededSession.entry?.sessionId;
      expect(seededSessionId).toBe("sess-main");
      const mutationStarted = createDeferred();
      mutation = runExclusiveSessionLifecycleMutation({
        scope: seededSession.storePath,
        identities: [seededSession.canonicalKey, seededSessionId],
        run: async () => {
          mutationStarted.resolve();
          await performDeletion.promise;
          // Read the authoritative row inside the mutation. Admission startup
          // may refresh metadata before it blocks, but this test deletes that
          // same session generation rather than a stale pre-admission snapshot.
          const deletionSession = loadGatewaySessionEntry("main");
          const deletionEntry = expectDefined(
            deletionSession.entry,
            "session deletion test invariant",
          );
          expect(deletionEntry.sessionId).toBe(seededSessionId);
          const deletion = await deleteSessionEntryLifecycle({
            agentId: "main",
            archiveTranscript: false,
            expectedEntry: deletionEntry,
            expectedSessionId: seededSessionId,
            requireWriteSuccess: true,
            storePath: deletionSession.storePath,
            target: {
              canonicalKey: deletionSession.canonicalKey,
              storeKeys: deletionSession.storeKeys,
            },
          });
          expect(deletion.deleted).toBe(true);
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{
        ok: boolean;
        payload?: unknown;
        error?: unknown;
        meta?: unknown;
      }> = [];
      const context = createDirectChatContext();
      const runId = "idem-deleted-during-admission";
      const params = makeChatSendParams({
        message: "do not recreate the deleted session",
        idempotencyKey: runId,
      });
      const send = Promise.resolve(
        callDirectChat("chat.send", {
          id: "send",
          params,
          respond: ((ok, payload, error, meta) => {
            sendResponses.push({ ok, payload, error, meta });
          }) as RespondFn,
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);

      performDeletion.resolve();
      await mutation;
      await send;

      expect(sendResponses).toEqual([
        {
          ok: false,
          payload: undefined,
          error: expect.objectContaining({
            message: expect.stringMatching(/deleted while starting work/i),
          }),
          meta: undefined,
        },
      ]);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      performDeletion.resolve();
      await Promise.allSettled(mutation ? [mutation] : []);
      resetDirectChatSession();
    }
  });

  test("chat.send does not enter a replacement session after reset while admission waits", async () => {
    const { storePath } = openDirectChatSession();
    const releaseMutation = createDeferred();
    try {
      await writeStoredMainSession({
        sessionId: "sess-before-reset",
      });
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: ["agent:main:main", "sess-before-reset"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext();
      const runId = "idem-reset-during-admission";
      const params = makeChatSendParams({
        message: "do not enter the replacement session",
        idempotencyKey: runId,
      });
      const send = Promise.resolve(
        callDirectChat("chat.send", {
          id: "send",
          params,
          respond: captureChatResponse(sendResponses),
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(pendingChatSendDedupeKey(runId))).toBe(true);
      }, FAST_WAIT_OPTS);

      await writeStoredMainSession({
        sessionId: "sess-after-reset",
      });
      releaseMutation.resolve();
      await mutation;
      await send;

      expect(sendResponses).toHaveLength(1);
      expect(sendResponses[0]?.ok).toBe(false);
      expect(sendResponses[0]?.error).toMatchObject({
        message: expect.stringMatching(/changed while starting work/i),
      });
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseMutation.resolve();
      resetDirectChatSession();
    }
  });

  test("chat.send does not consume a replacement pending reservation", async () => {
    const { storePath } = openDirectChatSession();
    const releaseMutation = createDeferred();
    const releaseTerminalMutation = createDeferred();
    try {
      await writeStoredMainSession({});
      const mutationStarted = createDeferred();
      const mutation = runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: ["sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const sendResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext();
      const runId = "idem-replaced-reservation";
      const pendingKey = pendingChatSendDedupeKey(runId);
      const params = makeChatSendParams({
        message: "only the replacement may run",
        idempotencyKey: runId,
      });
      const send = Promise.resolve(
        callDirectChat("chat.send", {
          id: "send",
          params,
          respond: captureChatResponse(sendResponses),
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(pendingKey)).toBe(true);
      }, FAST_WAIT_OPTS);
      const original = context.dedupe.get(pendingKey);
      const originalPayload = original?.payload as Record<string, unknown>;
      const replacement = {
        ts: Date.now(),
        ok: true,
        payload: {
          ...originalPayload,
          attemptId: "replacement-attempt",
          expiresAtMs: Date.now() + 120_000,
        },
      };
      context.dedupe.set(pendingKey, replacement);

      releaseMutation.resolve();
      await mutation;
      await send;

      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: { runId, status: "in_flight" },
          error: undefined,
        },
      ]);
      expect(context.dedupe.get(pendingKey)).toBe(replacement);
      expect(context.chatAbortControllers.has(runId)).toBe(false);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();

      const terminalMutationStarted = createDeferred();
      const terminalMutation = runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: ["sess-main"],
        run: async () => {
          terminalMutationStarted.resolve();
          await releaseTerminalMutation.promise;
        },
      });
      await terminalMutationStarted.promise;
      const terminalRunId = "idem-terminal-replacement";
      const terminalPendingKey = pendingChatSendDedupeKey(terminalRunId);
      const terminalParams = makeChatSendParams({
        message: "preserve the replacement result",
        idempotencyKey: terminalRunId,
      });
      const terminalResponses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const terminalSend = Promise.resolve(
        callDirectChat("chat.send", {
          id: "terminal-send",
          params: terminalParams,
          respond: captureChatResponse(terminalResponses),
          context,
        }),
      );
      await waitForFast(() => {
        expect(context.dedupe.has(terminalPendingKey)).toBe(true);
      }, FAST_WAIT_OPTS);
      const terminalResult = {
        ts: Date.now(),
        ok: true,
        payload: { runId: terminalRunId, status: "ok", summary: "replacement completed" },
      };
      context.dedupe.delete(terminalPendingKey);
      context.dedupe.set(`chat:${terminalRunId}`, terminalResult);

      releaseTerminalMutation.resolve();
      await terminalMutation;
      await terminalSend;

      expect(terminalResponses).toEqual([
        { ok: true, payload: terminalResult.payload, error: undefined },
      ]);
      expect(context.dedupe.get(`chat:${terminalRunId}`)).toBe(terminalResult);
      expect(context.chatRunState.runs.get(terminalRunId)?.abortMarker).toBeUndefined();
    } finally {
      releaseMutation.resolve();
      releaseTerminalMutation.resolve();
      resetDirectChatSession();
    }
  });

  test.each(configuredImageModelCases)(
    "chat.send preserves text-only image uploads as MediaPaths even with configured imageModel: $id",
    async ({ id, imageModel }) => {
      openDirectChatSession();
      try {
        testState.agentConfig = {
          model: {
            primary: "anthropic/claude-opus-4-6",
            fallbacks: ["anthropic/claude-haiku-4-6"],
          },
          imageModel,
          models: {
            "anthropic/claude-opus-4-6": {},
          },
        };
        await writeStoredMainSession({
          modelProvider: "anthropic",
          model: "claude-opus-4-6",
        });

        const context = createDirectChatContext({
          getRuntimeConfig,
          loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(
            async () => [
              {
                id: "claude-opus-4-6",
                name: "Claude Opus 4.6",
                provider: "anthropic",
                input: ["text"],
              },
              {
                id: "gpt-4o",
                name: "GPT-4o",
                provider: "openai",
                input: ["text", "image"],
              },
              {
                id: "gpt-4o-mini",
                name: "GPT-4o mini",
                provider: "openai",
                input: ["text", "image"],
              },
              {
                id: "claude-haiku-4-6",
                name: "Claude Haiku 4.6",
                provider: "anthropic",
                input: ["text"],
              },
            ],
          ),
        });
        const pngB64 =
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/woAAn8B9FD5fHAAAAAASUVORK5CYII=";
        let captured: { ctx?: Record<string, unknown>; replyOptions?: GetReplyOptions } | undefined;
        dispatchInboundMessageMock.mockImplementationOnce(async (...args: unknown[]) => {
          const [params] = args as [
            {
              ctx: Record<string, unknown>;
              replyOptions?: GetReplyOptions;
            },
          ];
          captured = {
            ctx: params.ctx,
            replyOptions: params.replyOptions,
          };
        });

        const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
        await callDirectChat("chat.send", {
          id: `configured-image-model-${id}`,
          params: makeChatSendParams({
            message: "see image",
            idempotencyKey: `idem-configured-image-model-${id}`,
            attachments: [
              {
                type: "image",
                mimeType: "image/png",
                fileName: "dot.png",
                content: pngB64,
              },
            ],
          }),
          respond: captureChatResponse(responses),
          context,
        });

        expect(responses[0]?.ok).toBe(true);
        await waitForFast(() => expect(captured).toBeDefined(), FAST_WAIT_OPTS);
        expect(captured?.replyOptions?.images).toBeUndefined();
        expect(captured?.ctx?.media).toEqual([
          expect.objectContaining({
            path: expect.any(String),
            contentType: "image/png",
            workspaceDir: expect.any(String),
          }),
        ]);
        await waitForFast(() => expect(context.removeChatRun).toHaveBeenCalledTimes(1));
      } finally {
        dispatchInboundMessageMock.mockReset();
        testState.agentConfig = undefined;
        testState.sessionStorePath = undefined;
        clearConfigCache();
      }
    },
  );

  test("chat.send durably admits a restart-safe Control UI turn before ACK", async () => {
    const { storePath } = openDirectChatSession();
    const dispatchRelease = createDeferred();
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      await patchSessionEntryCore({ sessionKey: "agent:main:main", storePath }, () => ({
        lastRunId: "previous-run",
      }));
      const context = createDirectChatContext();
      dispatchInboundMessageMock.mockImplementationOnce(async () => dispatchRelease.promise);
      let snapshotAtAck:
        | {
            entry: ReturnType<typeof loadSessionEntry>;
            events: ReturnType<typeof loadTranscriptEventsSync>;
          }
        | undefined;

      await sendControlUiChat({
        context,
        idempotencyKey: "idem-restart-safe-admission",
        message: "persist me before ACK",
        respond: ((ok, payload) => {
          if (!ok || (payload as { status?: unknown } | undefined)?.status !== "started") {
            return;
          }
          const scope = makeMainSessionScope(storePath);
          snapshotAtAck = {
            entry: loadSessionEntry(scope),
            events: loadTranscriptEventsSync(scope),
          };
        }) as RespondFn,
      });

      expect(snapshotAtAck?.entry).toMatchObject({
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: "idem-restart-safe-admission",
        restartRecoveryDeliverySourceRunId: "idem-restart-safe-admission",
        sessionId: "sess-main",
        status: "running",
      });
      expect(snapshotAtAck?.entry?.lastRunId).toBeUndefined();
      expect(snapshotAtAck?.entry?.restartRecoveryDeliveryContext).toBeUndefined();
      expect(snapshotAtAck?.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: "persist me before ACK",
              idempotencyKey: "idem-restart-safe-admission:user",
            }),
          }),
        ]),
      );
      const dispatchOptions = (
        dispatchInboundMessageMock.mock.calls[0]?.[0] as { replyOptions?: GetReplyOptions }
      )?.replyOptions;
      expect(dispatchOptions?.suppressNextUserMessagePersistence).toBe(true);
      dispatchRelease.resolve(undefined);
      await waitForFast(
        () => expect(context.removeChatRun).toHaveBeenCalledTimes(1),
        FAST_WAIT_OPTS,
      );
    } finally {
      dispatchRelease.resolve(undefined);
      resetDirectChatSession();
    }
  });

  test("chat.send persists optional connection identity per turn", async () => {
    openDirectChatSession();
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext();
      const send = async (params: {
        authenticatedUserId?: string;
        authenticatedUserProfile?: {
          profileId: string;
          displayName: string | null;
          hasAvatar: boolean;
        };
        idempotencyKey: string;
        message: string;
      }) => {
        const removeCount = (context.removeChatRun as ReturnType<typeof vi.fn>).mock.calls.length;
        await sendControlUiChat({
          context,
          ...params,
          respond: vi.fn() as RespondFn,
        });
        await waitForFast(
          () => expect(context.removeChatRun).toHaveBeenCalledTimes(removeCount + 1),
          FAST_WAIT_OPTS,
        );
      };

      await send({
        authenticatedUserId: "alice@example.com",
        authenticatedUserProfile: {
          profileId: "0d9f4c35-d221-49da-9a3f-b8c73921066b",
          displayName: "Alice",
          hasAvatar: false,
        },
        idempotencyKey: "idem-attributed-alice",
        message: "prompt from alice",
      });
      await send({
        authenticatedUserId: "bob@example.com",
        authenticatedUserProfile: {
          profileId: "77ad3957-b2c8-428a-83d3-fc09e696492e",
          displayName: "Bob",
          hasAvatar: true,
        },
        idempotencyKey: "idem-attributed-bob",
        message: "prompt from bob",
      });
      await send({
        idempotencyKey: "idem-unattributed",
        message: "prompt without identity",
      });

      const transcriptEvents = loadTranscriptEventsSync(
        makeMainSessionScope(testState.sessionStorePath),
      );
      expect(transcriptEvents).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: "prompt from alice",
              __openclaw: expect.objectContaining({
                senderId: "0d9f4c35-d221-49da-9a3f-b8c73921066b",
                senderName: "Alice",
              }),
            }),
          }),
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: "prompt from bob",
              __openclaw: expect.objectContaining({
                senderId: "77ad3957-b2c8-428a-83d3-fc09e696492e",
                senderName: "Bob",
              }),
            }),
          }),
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              role: "user",
              content: "prompt without identity",
              __openclaw: expect.not.objectContaining({ senderId: expect.anything() }),
            }),
          }),
        ]),
      );
    } finally {
      resetDirectChatSession();
    }
  });

  test("chat.send preserves a terminal source claim before admitting the next turn", async () => {
    const { storePath } = openDirectChatSession();
    const dispatchRelease = createDeferred();
    const priorRunId = "idem-prior-terminal-claim";
    const nextRunId = "idem-after-terminal-claim";
    try {
      await writeStoredMainSession(
        makeDoneSessionEntry({
          abortedLastRun: false,
          restartRecoveryDeliveryRunId: priorRunId,
          restartRecoveryDeliverySourceRunId: priorRunId,
          restartRecoveryTerminalRunIds: ["idem-older-terminal-claim"],
        }),
      );
      const context = createDirectChatContext();
      dispatchInboundMessageMock.mockImplementationOnce(async () => dispatchRelease.promise);
      let snapshotAtAck: ReturnType<typeof loadSessionEntry>;
      const freshAdmission = vi.fn(async () => {
        expect(context.chatAbortControllers.get(nextRunId)?.controlUiVisible).not.toBe(false);
        return true;
      });

      await sendControlUiChat({
        context,
        idempotencyKey: nextRunId,
        message: "admit after terminal claim",
        onAdmissionOwned: freshAdmission,
        respond: ((ok, payload) => {
          if (ok && (payload as { status?: unknown } | undefined)?.status === "started") {
            snapshotAtAck = loadSessionEntry({
              sessionKey: "agent:main:main",
              storePath,
            });
          }
        }) as RespondFn,
      });

      expect(freshAdmission).toHaveBeenCalledTimes(1);
      expect(context.chatAbortControllers.get(nextRunId)?.controlUiVisible).toBeUndefined();
      expect(snapshotAtAck).toMatchObject({
        restartRecoveryDeliveryRunId: nextRunId,
        restartRecoveryDeliverySourceRunId: nextRunId,
        restartRecoveryTerminalRunIds: ["idem-older-terminal-claim", priorRunId],
        status: "running",
      });

      const retryResponses: Array<{ ok: boolean; payload?: unknown; meta?: unknown }> = [];
      const replayAdmission = vi.fn(async () => true);
      await sendControlUiChat({
        context,
        idempotencyKey: priorRunId,
        message: "must not execute again",
        onAdmissionOwned: replayAdmission,
        respond: ((ok, payload, _error, meta) =>
          retryResponses.push({ ok, payload, meta })) as RespondFn,
      });
      expect(replayAdmission).not.toHaveBeenCalled();
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: { runId: priorRunId, status: "ok" },
          meta: { cached: true, runId: priorRunId },
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      dispatchRelease.resolve(undefined);
      await waitForFast(
        () => expect(context.removeChatRun).toHaveBeenCalledTimes(1),
        FAST_WAIT_OPTS,
      );
    } finally {
      dispatchRelease.resolve(undefined);
      resetDirectChatSession();
    }
  });

  test("chat.send runs an admission-owned callback for only one concurrent retry", async () => {
    openDirectChatSession();
    const dispatchRelease = createDeferred();
    const runId = "idem-concurrent-admission-owner";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext();
      dispatchInboundMessageMock.mockImplementationOnce(async () => dispatchRelease.promise);
      const firstAdmission = vi.fn(async () => true);
      const secondAdmission = vi.fn(async () => true);
      const responses: Array<{ ok: boolean; payload?: unknown; meta?: unknown }> = [];
      const send = (onAdmissionOwned: () => Promise<boolean>) =>
        sendControlUiChat({
          context,
          idempotencyKey: runId,
          message: "admit exactly once",
          onAdmissionOwned,
          respond: ((ok, payload, _error, meta) =>
            responses.push({ ok, payload, meta })) as RespondFn,
        });

      await Promise.all([send(firstAdmission), send(secondAdmission)]);

      expect(firstAdmission.mock.calls.length + secondAdmission.mock.calls.length).toBe(1);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(responses).toHaveLength(2);
      expect(responses.every((response) => response.ok)).toBe(true);
      expect(
        responses.filter(
          (response) =>
            (response.payload as { status?: unknown } | undefined)?.status === "started",
        ),
      ).toHaveLength(1);

      dispatchRelease.resolve(undefined);
      await waitForFast(
        () => expect(context.removeChatRun).toHaveBeenCalledTimes(1),
        FAST_WAIT_OPTS,
      );
    } finally {
      dispatchRelease.resolve(undefined);
      resetDirectChatSession();
    }
  });

  test("chat.abort still sees a replacement while its admission callback is running", async () => {
    openDirectChatSession();
    const callbackEntered = createDeferred();
    const releaseCallback = createDeferred();
    const runId = "idem-visible-during-admission-callback";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext({ chatQueuedTurns: new Map() });
      const sendResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      const sendPromise = sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "remain publicly abortable",
        onAdmissionOwned: async () => {
          callbackEntered.resolve(undefined);
          await releaseCallback.promise;
          return true;
        },
        respond: captureChatResult(sendResponses),
      });
      await callbackEntered.promise;
      expect(context.chatAbortControllers.get(runId)?.controlUiVisible).not.toBe(false);

      const abortResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      await callDirectChat("chat.abort", {
        id: "abort-visible-replacement",
        params: makeMainSessionParams(),
        client: createControlUiClient(),
        isWebchatConnect: () => true,
        respond: captureChatResult(abortResponses),
        context,
      });

      expect(abortResponses).toEqual([
        {
          ok: true,
          payload: { ok: true, aborted: true, runIds: [runId] },
        },
      ]);
      releaseCallback.resolve(undefined);
      await sendPromise;

      expect(sendResponses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason: "rpc",
          }),
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      releaseCallback.resolve(undefined);
      resetDirectChatSession();
    }
  });

  test.each([
    { caseName: "tombstones an explicit abort", retryable: false, stopReason: "rpc" },
    { caseName: "retains a restart interruption", retryable: true, stopReason: "restart" },
  ])("chat.send $caseName during SQLite admission", async ({ retryable, stopReason }) => {
    const { storePath } = openDirectChatSession();
    const runId = `idem-restart-safe-abort-${stopReason}`;
    const lockEntered = createDeferred();
    const releaseLock = createDeferred();
    let lockPromise: Promise<void> | undefined;
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const scope = makeMainSessionScope(storePath);
      lockPromise = withTranscriptWriteLock(scope, async () => {
        lockEntered.resolve(undefined);
        await releaseLock.promise;
      });
      await lockEntered.promise;
      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];
      const sendPromise = sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "persist, then stop",
        respond: captureChatResult(responses),
      });
      await waitForFast(
        () => expect(context.chatAbortControllers.get(runId)).toBeDefined(),
        FAST_WAIT_OPTS,
      );
      const activeRun = context.chatAbortControllers.get(runId);
      if (!activeRun) {
        throw new Error("expected admitted chat run");
      }
      activeRun.abortStopReason = stopReason;
      activeRun.controller.abort();
      releaseLock.resolve(undefined);
      await Promise.all([sendPromise, lockPromise]);

      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({
            runId,
            status: "timeout",
            summary: "aborted",
            stopReason,
          }),
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      const stored = loadSessionEntry(scope);
      expect(stored).toMatchObject({
        abortedLastRun: !retryable,
        lastRunId: runId,
        sessionId: "sess-main",
        status: "killed",
      });
      expect(stored?.restartRecoveryDeliveryContext).toBeUndefined();
      if (retryable) {
        expect(stored?.restartRecoveryBeforeAgentReplyState).toBeUndefined();
        expect(stored?.restartRecoveryDeliveryRequestFingerprint).toEqual(
          expect.stringMatching(/^hmac-sha256:v1:/u),
        );
        expect(stored?.restartRecoveryDeliveryRunId).toBe(runId);
        expect(stored?.restartRecoveryDeliverySourceRunId).toBe(runId);
        expect(stored?.restartRecoverySourceIngress).toBe("control-ui");
        expect(stored?.restartRecoveryTerminalRunIds).toBeUndefined();
      } else {
        expect(stored?.restartRecoveryDeliveryRequestFingerprint).toBeUndefined();
        expect(stored?.restartRecoveryDeliveryRunId).toBeUndefined();
        expect(stored?.restartRecoveryDeliverySourceRunId).toBeUndefined();
        expect(stored?.restartRecoverySourceIngress).toBeUndefined();
        expect(stored?.restartRecoveryTerminalRunIds).toEqual([runId]);
      }
      expect(loadTranscriptEventsSync(scope)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "message",
            message: expect.objectContaining({
              content: "persist, then stop",
              idempotencyKey: `${runId}:user`,
              role: "user",
            }),
          }),
        ]),
      );

      const retryContext = createDirectChatContext();
      const retryResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      if (retryable) {
        dispatchInboundMessageMock.mockResolvedValueOnce(undefined);
      }
      await sendControlUiChat({
        context: retryContext,
        idempotencyKey: runId,
        message: "persist, then stop",
        respond: captureChatResult(retryResponses),
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: retryable
            ? expect.objectContaining({ runId, status: "started" })
            : { runId, status: "ok" },
        },
      ]);
      if (retryable) {
        await waitForFast(
          () => expect(retryContext.removeChatRun).toHaveBeenCalledTimes(1),
          FAST_WAIT_OPTS,
        );
        expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
        expect(
          (
            dispatchInboundMessageMock.mock.calls[0]?.[0] as
              | { replyOptions?: GetReplyOptions }
              | undefined
          )?.replyOptions?.suppressNextUserMessagePersistence,
        ).toBe(true);
      } else {
        expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      }
      expect(
        loadTranscriptEventsSync(scope).filter((event) => {
          if (
            typeof event !== "object" ||
            event === null ||
            !("type" in event) ||
            event.type !== "message" ||
            !("message" in event)
          ) {
            return false;
          }
          const message = event.message;
          return (
            typeof message === "object" &&
            message !== null &&
            "idempotencyKey" in message &&
            message.idempotencyKey === `${runId}:user`
          );
        }),
      ).toHaveLength(1);
    } finally {
      releaseLock.resolve(undefined);
      await lockPromise?.catch(() => undefined);
      resetDirectChatSession();
    }
  });

  test("chat.send keeps a durable Control UI retry pending when recovery remains abandoned", async () => {
    const { storePath } = openDirectChatSession();
    const idempotencyKey = "idem-restart-safe-duplicate";
    try {
      await writeSessionStore({ entries: {} });
      await replaceSessionEntry(
        { sessionKey: "main", storePath },
        {
          sessionId: "sess-main",
          status: "running",
          abortedLastRun: true,
          restartRecoveryDeliveryRunId: "recovery-run",
          restartRecoveryDeliverySourceRunId: idempotencyKey,
          updatedAt: Date.now(),
        },
      );
      await appendTranscriptMessage(
        {
          agentId: "main",
          sessionId: "sess-main",
          sessionKey: "main",
          storePath,
        },
        {
          message: {
            role: "user",
            content: "already admitted",
            idempotencyKey: `${idempotencyKey}:user`,
          },
        },
      );
      const context = createDirectChatContext();
      const responses: Array<{ error?: unknown; ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        idempotencyKey,
        message: "already admitted",
        respond: captureChatResponse(responses),
      });

      expect(responses).toEqual([
        {
          error: expect.objectContaining({ code: "UNAVAILABLE", retryable: true }),
          ok: false,
          payload: undefined,
        },
      ]);
      expect(restartRecoveryMocks.retryRestartAbortedMainSessionRecovery).toHaveBeenCalledWith({
        canonicalSessionKey: "agent:main:main",
        cfg: expect.any(Object),
        expectedRecoveryRunId: "recovery-run",
        expectedRecoverySourceRunId: idempotencyKey,
        expectedSessionId: "sess-main",
        sessionKey: "agent:main:main",
        storePath,
        gatewayRuntime: expect.any(Object),
      });
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(
        loadExactSessionEntry({ sessionKey: "agent:main:main", storePath })?.entry,
      ).toMatchObject({
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: idempotencyKey,
        sessionId: "sess-main",
        status: "running",
      });
    } finally {
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockClear();
      resetDirectChatSession();
    }
  });

  test("chat.send retires a durable retry after recovery re-dispatch succeeds", async () => {
    const { storePath } = openDirectChatSession();
    const idempotencyKey = "idem-restart-safe-recovered-retry";
    try {
      await writeStoredMainSession({
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: idempotencyKey,
      });
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockImplementationOnce(
        async ({ sessionKey, storePath: recoveryStorePath }) => {
          await patchSessionEntryCore({ sessionKey, storePath: recoveryStorePath }, () => ({
            abortedLastRun: false,
            updatedAt: Date.now(),
          }));
          return { started: 1, settled: 0, failed: 0, skipped: 0 };
        },
      );
      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        idempotencyKey,
        message: "already admitted",
        respond: captureChatResult(responses),
      });

      expect(responses).toEqual([
        {
          ok: true,
          payload: { runId: idempotencyKey, status: "ok" },
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        abortedLastRun: false,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: idempotencyKey,
        status: "running",
      });
    } finally {
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockClear();
      resetDirectChatSession();
    }
  });

  test("chat.send suppresses a durable retry settled while lifecycle admission waits", async () => {
    const { storePath } = openDirectChatSession();
    const idempotencyKey = "idem-recovery-settled-during-admission";
    const releaseMutation = createDeferred();
    let mutation: Promise<void> | undefined;
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const mutationStarted = createDeferred();
      mutation = runExclusiveSessionLifecycleMutation({
        scope: storePath,
        identities: ["agent:main:main", "sess-main"],
        run: async () => {
          mutationStarted.resolve();
          await releaseMutation.promise;
        },
      });
      await mutationStarted.promise;

      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown; meta?: unknown }> = [];
      const send = sendControlUiChat({
        context,
        idempotencyKey,
        message: "already recovered",
        respond: ((ok, payload, _error, meta) =>
          responses.push({ ok, payload, meta })) as RespondFn,
      });
      await waitForFast(
        () => expect(context.dedupe.has(pendingChatSendDedupeKey(idempotencyKey))).toBe(true),
        FAST_WAIT_OPTS,
      );
      await patchSessionEntryCore({ sessionKey: "agent:main:main", storePath }, () => ({
        restartRecoveryTerminalRunIds: [idempotencyKey],
        updatedAt: Date.now(),
      }));
      releaseMutation.resolve();
      await Promise.all([send, mutation]);

      expect(responses).toEqual([
        {
          ok: true,
          payload: { runId: idempotencyKey, status: "ok" },
          meta: { cached: true, runId: idempotencyKey },
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      expect(context.chatAbortControllers.has(idempotencyKey)).toBe(false);
    } finally {
      releaseMutation.resolve();
      await Promise.allSettled(mutation ? [mutation] : []);
      resetDirectChatSession();
    }
  });

  test("chat.send does not re-dispatch an archived durable recovery claim", async () => {
    openDirectChatSession();
    const idempotencyKey = "idem-restart-safe-archived-retry";
    try {
      await writeStoredMainSession({
        archivedAt: Date.now(),
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: idempotencyKey,
      });
      const context = createDirectChatContext();
      const responses: Array<{ error?: unknown; ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        idempotencyKey,
        message: "must stay archived",
        respond: captureChatResponse(responses),
      });

      expect(responses).toEqual([
        {
          error: expect.objectContaining({ code: "INVALID_REQUEST", retryable: false }),
          ok: false,
          payload: undefined,
        },
      ]);
      expect(restartRecoveryMocks.retryRestartAbortedMainSessionRecovery).not.toHaveBeenCalled();
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockClear();
      resetDirectChatSession();
    }
  });

  test("chat.send stops automatic retry when durable recovery ownership changes", async () => {
    openDirectChatSession();
    const idempotencyKey = "idem-restart-safe-replaced-retry";
    try {
      await writeStoredMainSession({
        status: "running",
        abortedLastRun: true,
        restartRecoveryDeliveryRunId: "recovery-run",
        restartRecoveryDeliverySourceRunId: idempotencyKey,
      });
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockImplementationOnce(
        async ({ sessionKey, storePath: recoveryStorePath }) => {
          await patchSessionEntryCore({ sessionKey, storePath: recoveryStorePath }, () => ({
            sessionId: "replacement-session",
            restartRecoveryDeliveryRunId: "replacement-recovery",
            restartRecoveryDeliverySourceRunId: "replacement-source",
            updatedAt: Date.now(),
          }));
          return { started: 0, settled: 0, failed: 0, skipped: 0 };
        },
      );
      const context = createDirectChatContext();
      const responses: Array<{ error?: unknown; ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        idempotencyKey,
        message: "must not dispatch replacement ownership",
        respond: captureChatResponse(responses),
      });

      expect(responses).toEqual([
        {
          error: expect.objectContaining({ code: "UNAVAILABLE", retryable: false }),
          ok: false,
          payload: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      restartRecoveryMocks.retryRestartAbortedMainSessionRecovery.mockClear();
      resetDirectChatSession();
    }
  });

  test.each([
    { caseName: "settled recovery", status: "done" as const, abortedLastRun: false },
    { caseName: "unresumable recovery", status: "failed" as const, abortedLastRun: true },
  ])("chat.send suppresses a Control UI retry after $caseName", async (terminal) => {
    openDirectChatSession();
    const idempotencyKey = `idem-${terminal.status}-recovery`;
    try {
      await writeStoredMainSession({
        status: terminal.status,
        abortedLastRun: terminal.abortedLastRun,
        restartRecoveryTerminalRunIds: [idempotencyKey],
      });
      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        idempotencyKey,
        message: "already handled",
        respond: captureChatResult(responses),
      });

      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId: idempotencyKey, status: "ok" }),
        },
      ]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
    } finally {
      resetDirectChatSession();
    }
  });

  test("chat.send releases an unadopted durable claim after dispatch rejection", async () => {
    const { storePath } = openDirectChatSession();
    const runId = "idem-restart-safe-dispatch-error";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];
      dispatchInboundMessageMock.mockRejectedValueOnce(new Error("dispatch rejected"));

      await sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "retry me after dispatch failure",
        respond: captureChatResult(responses),
      });
      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId, status: "started" }),
        },
      ]);
      await waitForFast(
        () => expect(context.removeChatRun).toHaveBeenCalledTimes(1),
        FAST_WAIT_OPTS,
      );
      const failed = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(failed).toMatchObject({ abortedLastRun: false, status: "failed" });
      expect(failed?.restartRecoveryDeliveryRequestFingerprint).toEqual(
        expect.stringMatching(/^hmac-sha256:v1:/u),
      );
      expect(failed?.restartRecoveryDeliveryRunId).toBe(runId);
      expect(failed?.restartRecoveryDeliverySourceRunId).toBe(runId);

      const collisionContext = createDirectChatContext();
      const collisionResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      await sendControlUiChat({
        context: collisionContext,
        idempotencyKey: runId,
        message: "changed text under the same run id",
        respond: captureChatResult(collisionResponses),
      });
      expect(collisionResponses).toEqual([
        {
          ok: false,
          payload: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(loadSessionEntry({ sessionKey: "agent:main:main", storePath })).toMatchObject({
        abortedLastRun: false,
        status: "failed",
      });

      const retryContext = createDirectChatContext();
      const retryResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      dispatchInboundMessageMock.mockResolvedValueOnce(undefined);
      await sendControlUiChat({
        context: retryContext,
        idempotencyKey: runId,
        message: "retry me after dispatch failure",
        respond: captureChatResult(retryResponses),
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId, status: "started" }),
        },
      ]);
      await waitForFast(
        () => expect(retryContext.removeChatRun).toHaveBeenCalledTimes(1),
        FAST_WAIT_OPTS,
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(
        (
          dispatchInboundMessageMock.mock.calls[1]?.[0] as
            | { replyOptions?: GetReplyOptions }
            | undefined
        )?.replyOptions?.suppressNextUserMessagePersistence,
      ).toBe(true);
    } finally {
      resetDirectChatSession();
    }
  });

  test("chat.send releases a durable claim after synchronous post-admission failure", async () => {
    const { storePath } = openDirectChatSession();
    const runId = "idem-restart-safe-setup-error";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext();
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];
      let responseCount = 0;

      await sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "retry me after setup failure",
        respond: ((ok, payload) => {
          responseCount += 1;
          if (responseCount === 1) {
            throw new Error("response transport failed");
          }
          responses.push({ ok, payload });
        }) as RespondFn,
      });

      expect(responses).toEqual([{ ok: false, payload: expect.objectContaining({ runId }) }]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      const failed = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(failed).toMatchObject({ abortedLastRun: false, status: "failed" });
      expect(failed?.restartRecoveryDeliveryRequestFingerprint).toEqual(
        expect.stringMatching(/^hmac-sha256:v1:/u),
      );
      expect(failed?.restartRecoveryDeliveryRunId).toBe(runId);
      expect(failed?.restartRecoveryDeliverySourceRunId).toBe(runId);
    } finally {
      resetDirectChatSession();
    }
  });

  test("chat.send leaves a post-admission routing rejection retryable", async () => {
    const { storePath } = openDirectChatSession();
    const runId = "idem-restart-safe-routing-change";
    try {
      await writeStoredMainSession(makeDoneSessionEntry());
      const context = createDirectChatContext();
      const initialRuntimeConfig = getRuntimeConfig();
      const changedRuntimeConfig = {
        ...initialRuntimeConfig,
        session: {
          ...initialRuntimeConfig.session,
          scope: initialRuntimeConfig.session?.scope === "global" ? "per-sender" : "global",
        },
      } as const;
      context.getRuntimeConfig = vi
        .fn()
        .mockReturnValueOnce(initialRuntimeConfig)
        .mockReturnValueOnce(initialRuntimeConfig)
        .mockReturnValue(changedRuntimeConfig);
      const responses: Array<{ ok: boolean; payload?: unknown }> = [];

      await sendControlUiChat({
        context,
        expectedSessionRoutingContract: resolveSessionRoutingContract(initialRuntimeConfig),
        idempotencyKey: runId,
        message: "retry me after routing changes",
        respond: captureChatResult(responses),
      });
      expect(responses).toEqual([{ ok: false, payload: undefined }]);
      expect(dispatchInboundMessageMock).not.toHaveBeenCalled();
      const failed = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
      expect(failed).toMatchObject({ abortedLastRun: false, status: "failed" });
      expect(failed?.restartRecoveryDeliveryRequestFingerprint).toEqual(
        expect.stringMatching(/^hmac-sha256:v1:/u),
      );
      expect(failed?.restartRecoveryDeliveryRunId).toBe(runId);
      expect(failed?.restartRecoveryDeliverySourceRunId).toBe(runId);

      const retryContext = createDirectChatContext();
      const retryResponses: Array<{ ok: boolean; payload?: unknown }> = [];
      dispatchInboundMessageMock.mockResolvedValueOnce(undefined);
      await sendControlUiChat({
        context: retryContext,
        idempotencyKey: runId,
        message: "retry me after routing changes",
        respond: captureChatResult(retryResponses),
      });
      expect(retryResponses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({ runId, status: "started" }),
        },
      ]);
      await waitForFast(
        () => expect(retryContext.removeChatRun).toHaveBeenCalledTimes(1),
        FAST_WAIT_OPTS,
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      expect(
        (
          dispatchInboundMessageMock.mock.calls[0]?.[0] as
            | { replyOptions?: GetReplyOptions }
            | undefined
        )?.replyOptions?.suppressNextUserMessagePersistence,
      ).toBe(true);
    } finally {
      resetDirectChatSession();
    }
  });

  test.each([
    {
      caseName: "pending final delivery",
      runId: "idem-pending-final-delivery",
      entry: {
        pendingFinalDelivery: {
          kind: "replayable" as const,
          text: "older reply",
          createdAt: Date.now(),
          context: {
            channel: "whatsapp",
            to: "+15551234567",
          },
        },
      },
    },
    {
      caseName: "an aborted-run hint",
      runId: "idem-aborted-run-hint",
      entry: { abortedLastRun: true },
    },
  ])("chat.send leaves $caseName outside restart-safe admission", async ({ entry, runId }) => {
    const { storePath } = openDirectChatSession();
    try {
      await writeStoredMainSession(
        makeDoneSessionEntry({
          ...entry,
          updatedAt: Date.now(),
        }),
      );
      const context = createDirectChatContext();
      dispatchInboundMessageMock.mockResolvedValueOnce(undefined);
      const ackSnapshot: { entry: ReturnType<typeof loadSessionEntry> } = { entry: undefined };

      await sendControlUiChat({
        context,
        idempotencyKey: runId,
        message: "new Control UI turn",
        respond: ((ok, payload) => {
          if (ok && (payload as { status?: unknown } | undefined)?.status === "started") {
            ackSnapshot.entry = loadSessionEntry({ sessionKey: "agent:main:main", storePath });
          }
        }) as RespondFn,
      });

      expect(ackSnapshot.entry).toMatchObject({
        ...entry,
        status: "done",
      });
      expect(ackSnapshot.entry?.restartRecoveryDeliveryRunId).toBeUndefined();
      await waitForFast(
        () => expect(context.removeChatRun).toHaveBeenCalledTimes(1),
        FAST_WAIT_OPTS,
      );
    } finally {
      resetDirectChatSession();
    }
  });

  test("chat.send keeps matching WebChat text sends distinct by idempotency key", async () => {
    openDirectChatSession();
    const dispatchRelease = createDeferred();
    try {
      await writeStoredMainSession({});

      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext({
        getRuntimeConfig,
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
      });
      dispatchInboundMessageMock.mockImplementation(async () => dispatchRelease.promise);

      const callSend = (
        id: string,
        idempotencyKey: string,
        systemProvenanceReceipt?: string,
        thinking = "low",
      ) => {
        const params = makeChatSendParams({
          idempotencyKey,
          message: "?",
          thinking,
          ...(systemProvenanceReceipt ? { systemProvenanceReceipt } : {}),
        });
        return callDirectChat("chat.send", {
          id,
          params,
          client: createControlUiClient(),
          isWebchatConnect: () => true,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });
      };

      const first = Promise.resolve(callSend("first", "idem-active-a"));
      await waitForFast(
        () => {
          expect(responses).toEqual([
            {
              id: "first",
              ok: true,
              payload: expect.objectContaining({
                runId: "idem-active-a",
                status: "started",
                serverTiming: {
                  receivedToAckMs: expect.any(Number),
                  loadSessionMs: expect.any(Number),
                },
              }),
              error: undefined,
            },
          ]);
        },
        { timeout: 2_000, interval: 5 },
      );

      const duplicate = Promise.resolve(callSend("duplicate", "idem-active-b"));

      await waitForFast(() => {
        expect(responses).toEqual([
          {
            id: "first",
            ok: true,
            payload: expect.objectContaining({
              runId: "idem-active-a",
              status: "started",
              serverTiming: {
                receivedToAckMs: expect.any(Number),
                loadSessionMs: expect.any(Number),
              },
            }),
            error: undefined,
          },
          {
            id: "duplicate",
            ok: true,
            payload: expect.objectContaining({
              runId: "idem-active-b",
              status: "started",
              serverTiming: {
                receivedToAckMs: expect.any(Number),
                loadSessionMs: expect.any(Number),
              },
            }),
            error: undefined,
          },
        ]);
      }, FAST_WAIT_OPTS);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      expect(context.addChatRun).toHaveBeenCalledTimes(2);

      const withSystemContext = Promise.resolve(
        callSend("system-context", "idem-active-c", "proposal=support-file-sampler-b"),
      );

      await waitForFast(
        () => {
          expect(responses).toEqual([
            {
              id: "first",
              ok: true,
              payload: expect.objectContaining({
                runId: "idem-active-a",
                status: "started",
                serverTiming: {
                  receivedToAckMs: expect.any(Number),
                  loadSessionMs: expect.any(Number),
                },
              }),
              error: undefined,
            },
            {
              id: "duplicate",
              ok: true,
              payload: expect.objectContaining({
                runId: "idem-active-b",
                status: "started",
                serverTiming: {
                  receivedToAckMs: expect.any(Number),
                  loadSessionMs: expect.any(Number),
                },
              }),
              error: undefined,
            },
            {
              id: "system-context",
              ok: true,
              payload: expect.objectContaining({
                runId: "idem-active-c",
                status: "started",
                serverTiming: {
                  receivedToAckMs: expect.any(Number),
                  loadSessionMs: expect.any(Number),
                },
              }),
              error: undefined,
            },
          ]);
        },
        { timeout: 2_000, interval: 5 },
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(3);
      expect(context.addChatRun).toHaveBeenCalledTimes(3);

      const withDifferentThinking = Promise.resolve(
        callSend("different-thinking", "idem-active-d", undefined, "high"),
      );
      await waitForFast(
        () => {
          expect(responses.at(-1)).toEqual({
            id: "different-thinking",
            ok: true,
            payload: expect.objectContaining({
              runId: "idem-active-d",
              status: "started",
              serverTiming: {
                receivedToAckMs: expect.any(Number),
                loadSessionMs: expect.any(Number),
              },
            }),
            error: undefined,
          });
        },
        { timeout: 2_000, interval: 5 },
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(4);
      expect(context.addChatRun).toHaveBeenCalledTimes(4);

      dispatchRelease.resolve();
      await Promise.all([first, duplicate, withSystemContext, withDifferentThinking]);
      await waitForFast(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(4);
      }, FAST_WAIT_OPTS);
    } finally {
      dispatchRelease.resolve();
      resetDirectChatSession();
    }
  });

  test("chat.send can suppress command interpretation for slash-prefixed system turns", async () => {
    await withDirectChatSession(async () => {
      await writeStoredMainSession({});

      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext({
        getRuntimeConfig,
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
      });
      dispatchInboundMessageMock.mockResolvedValue({});

      await callDirectChat("chat.send", {
        id: "suppressed-command",
        params: makeChatSendParams({
          message: "/reset examples",
          suppressCommandInterpretation: true,
          idempotencyKey: "idem-suppressed-command",
        }),
        client: createControlUiClient(),
        isWebchatConnect: () => true,
        respond: ((ok, payload, error) => {
          responses.push({ id: "suppressed-command", ok, payload, error });
        }) as RespondFn,
        context,
      });

      expect(responses).toEqual([
        {
          id: "suppressed-command",
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-suppressed-command",
            status: "started",
          }),
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);
      const dispatchContext = (
        dispatchInboundMessageMock.mock.calls[0]?.[0] as { ctx?: Record<string, unknown> }
      )?.ctx;
      expect(dispatchContext).toMatchObject({
        Body: "/reset examples",
        BodyForAgent: "/reset examples",
        BodyForCommands: "/reset examples",
        CommandBody: "/reset examples",
        CommandAuthorized: false,
        CommandInterpretationSuppressed: true,
        CommandTurn: {
          kind: "normal",
          source: "message",
          authorized: false,
          body: "/reset examples",
        },
        RawBody: "/reset examples",
      });
      expect(dispatchContext).not.toHaveProperty("CommandSource");
      await waitForFast(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);
    });
  });

  test("chat.send starts the next WebChat turn after the prior internal run finishes", async () => {
    await withDirectChatSession(async () => {
      await writeStoredMainSession({});

      const responses: Array<{ id: string; ok: boolean; payload?: unknown; error?: unknown }> = [];
      const context = createDirectChatContext({
        getRuntimeConfig,
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
      });
      dispatchInboundMessageMock.mockResolvedValue(undefined);

      const callSend = (id: string, message: string, idempotencyKey: string) =>
        callDirectChat("chat.send", {
          id,
          params: makeChatSendParams({ idempotencyKey, message }),
          client: createControlUiClient(["operator.write"]),
          isWebchatConnect: () => true,
          respond: ((ok, payload, error) => {
            responses.push({ id, ok, payload, error });
          }) as RespondFn,
          context,
        });

      await callSend("first", "first message", "idem-sequential-a");
      await waitForFast(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(1);
      }, FAST_WAIT_OPTS);

      await callSend("second", "second message", "idem-sequential-b");
      await waitForFast(() => {
        expect(context.removeChatRun).toHaveBeenCalledTimes(2);
      }, FAST_WAIT_OPTS);

      expect(responses).toEqual([
        {
          id: "first",
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-sequential-a",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          }),
          error: undefined,
        },
        {
          id: "second",
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-sequential-b",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          }),
          error: undefined,
        },
      ]);
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(2);
      const dispatchOptions = dispatchInboundMessageMock.mock.calls.map(([params]) => {
        return (params as { replyOptions?: GetReplyOptions }).replyOptions;
      });
      expect(dispatchOptions[0]?.runId).toBe("idem-sequential-a");
      expect(dispatchOptions[1]?.runId).toBe("idem-sequential-b");
      expect(dispatchOptions[0]?.promptCacheKey).toEqual(
        expect.stringMatching(/^openclaw-webchat-[a-f0-9]{32}$/u),
      );
      expect(dispatchOptions[1]?.promptCacheKey).toBe(dispatchOptions[0]?.promptCacheKey);
      expect(dispatchOptions[0]?.promptCacheKey).not.toContain("main");
      expect(dispatchOptions[0]?.promptCacheKey).not.toContain("sess-main");
      expect(context.addChatRun).toHaveBeenCalledTimes(2);
    });
  });

  test("chat.send terminalizes returned validation errors as safe aborts", async () => {
    await withDirectChatSession(async () => {
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const runId = "idem-validation-loop";
      const validationSummary = "edit tool validation failed: invalid arguments";
      const broadcast = vi.fn<GatewayRequestContext["broadcast"]>();
      const context = createDirectChatContext({
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        broadcast,
        getRuntimeConfig: () => ({}),
      });
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const dispatch = args as {
          dispatcher?: {
            sendFinalReply: (payload: { text: string; isError: true }) => boolean;
            markComplete: () => void;
            waitForIdle: () => Promise<void>;
          };
          replyOptions?: GetReplyOptions;
        };
        dispatch.replyOptions?.onAgentRunStart?.(runId);
        const active = context.chatAbortControllers.get(runId);
        expect(active).toBeDefined();
        if (active) {
          active.toolErrorSummary = validationSummary;
        }
        const dispatcher = expectDefined(
          dispatch.dispatcher,
          "chat.send projected reply dispatcher",
        );
        dispatcher.sendFinalReply({ text: "LLM request failed.", isError: true });
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        return {};
      });

      const { chatHandlers } = await import("./server-methods/chat.js");
      await expectDefined(
        chatHandlers["chat.send"],
        'chatHandlers["chat.send"] test invariant',
      )({
        req: {
          type: "req",
          id: "validation-loop",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "trigger malformed edit calls",
            idempotencyKey: runId,
          },
        },
        params: {
          sessionKey: "main",
          message: "trigger malformed edit calls",
          idempotencyKey: runId,
        },
        client: {
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.TUI,
              mode: GATEWAY_CLIENT_MODES.UI,
            },
            scopes: ["operator.write", "operator.admin"],
          },
        } as never,
        isWebchatConnect: () => true,
        respond: vi.fn() as RespondFn,
        context,
      });

      await waitForFast(
        () => {
          expect(broadcast).toHaveBeenCalledWith(
            "chat",
            expect.objectContaining({
              runId,
              sessionKey: "agent:main:main",
              state: "aborted",
              errorMessage: validationSummary,
            }),
            { sessionKeys: ["agent:main:main"] },
          );
        },
        { timeout: 10_000, interval: 1 },
      );
      expect(broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId, state: "error" }),
        expect.anything(),
      );
      expect(JSON.stringify(broadcast.mock.calls)).not.toContain("LLM request failed");
      expect(context.dedupe.get(`chat:${runId}`)).toMatchObject({
        ok: false,
        payload: {
          runId,
          status: "error",
          summary: validationSummary,
        },
        error: {
          message: validationSummary,
        },
      });
    });
  });

  test("chat.send does not rebroadcast lifecycle-owned returned errors", async () => {
    await withDirectChatSession(async () => {
      await writeSessionStore({
        entries: {
          main: {
            sessionId: "sess-main",
            updatedAt: Date.now(),
          },
        },
      });

      const runId = "idem-lifecycle-owned-error";
      const errorMessage = "LLM request failed.";
      const sessionKey = "agent:main:main";
      const broadcast = vi.fn<GatewayRequestContext["broadcast"]>();
      const context = createDirectChatContext({
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        broadcast,
        getRuntimeConfig: () => ({}),
      });
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const dispatch = args as {
          dispatcher?: {
            sendFinalReply: (payload: { text: string; isError: true }) => boolean;
            markComplete: () => void;
            waitForIdle: () => Promise<void>;
          };
          replyOptions?: GetReplyOptions;
        };
        dispatch.replyOptions?.onAgentRunStart?.(runId);
        const active = context.chatAbortControllers.get(runId);
        expect(active).toBeDefined();
        if (active) {
          active.chatTerminalBroadcasted = true;
        }
        broadcast(
          "chat",
          {
            runId,
            sessionKey,
            seq: 4,
            state: "error",
            errorMessage,
          },
          { sessionKeys: [sessionKey] },
        );
        const dispatcher = expectDefined(
          dispatch.dispatcher,
          "chat.send projected reply dispatcher",
        );
        dispatcher.sendFinalReply({ text: errorMessage, isError: true });
        dispatcher.markComplete();
        await dispatcher.waitForIdle();
        return {};
      });

      const { chatHandlers } = await import("./server-methods/chat.js");
      await expectDefined(
        chatHandlers["chat.send"],
        'chatHandlers["chat.send"] test invariant',
      )({
        req: {
          type: "req",
          id: "lifecycle-owned-error",
          method: "chat.send",
          params: {
            sessionKey: "main",
            message: "trigger provider failure",
            idempotencyKey: runId,
          },
        },
        params: {
          sessionKey: "main",
          message: "trigger provider failure",
          idempotencyKey: runId,
        },
        client: {
          connect: {
            client: {
              id: GATEWAY_CLIENT_NAMES.TUI,
              mode: GATEWAY_CLIENT_MODES.UI,
            },
            scopes: ["operator.write", "operator.admin"],
          },
        } as never,
        isWebchatConnect: () => true,
        respond: vi.fn() as RespondFn,
        context,
      });

      await waitForFast(() => {
        expect(context.dedupe.get(`chat:${runId}`)).toMatchObject({
          ok: false,
          payload: {
            runId,
            status: "error",
            summary: errorMessage,
          },
        });
      });
      expect(
        broadcast.mock.calls.filter(
          ([event, payload]) =>
            event === "chat" &&
            (payload as { runId?: string; state?: string }).runId === runId &&
            (payload as { state?: string }).state === "error",
        ),
      ).toHaveLength(1);
    });
  });

  test("chat.send terminalizes the client run when a followup is queued", async () => {
    await withDirectChatSession(async (_sessionDir, storePath) => {
      await writeStoredMainSession({});

      const broadcast = vi.fn((_event: string, _payload: unknown) => undefined);
      const context = createDirectChatContext({
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        chatQueuedTurns: new Map(),
        broadcast,
        getRuntimeConfig: () => ({}),
      });
      let turnAdoptionLifecycle: GetReplyOptions["turnAdoptionLifecycle"];
      let onQueueDisposition: InternalGetReplyOptions["onFollowupQueueDisposition"];
      let onQueuedFollowupReplyBatch: InternalGetReplyOptions["onQueuedFollowupReplyBatch"];
      const dispatchRelease = createDeferred();
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const replyOptions = (args as { replyOptions?: InternalGetReplyOptions }).replyOptions;
        turnAdoptionLifecycle = replyOptions?.turnAdoptionLifecycle;
        onQueueDisposition = replyOptions?.onFollowupQueueDisposition;
        onQueuedFollowupReplyBatch = replyOptions?.onQueuedFollowupReplyBatch;
        turnAdoptionLifecycle?.onDeferred?.();
        await dispatchRelease.promise;
        return {};
      });

      await callDirectChat("chat.send", {
        id: "queued-followup",
        params: makeChatSendParams({
          message: "queued prompt",
          idempotencyKey: "idem-queued-followup",
        }),
        client: makeTuiClient(),
        isWebchatConnect: () => true,
        respond: vi.fn() as RespondFn,
        context,
      });

      await waitForFast(() => expect(turnAdoptionLifecycle).toBeDefined(), FAST_WAIT_OPTS);
      expect(turnAdoptionLifecycle?.ownerKey).toBe("connection:conn-tui");
      expect(broadcast).not.toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({ runId: "idem-queued-followup", state: "final" }),
        expect.anything(),
      );
      dispatchRelease.resolve();
      await waitForFast(() => {
        expect(broadcast).toHaveBeenCalledWith(
          "chat",
          expect.objectContaining({
            runId: "idem-queued-followup",
            sessionKey: "agent:main:main",
            state: "final",
          }),
          { sessionKeys: ["agent:main:main"] },
        );
      }, FAST_WAIT_OPTS);
      const finalEvents = broadcast.mock.calls.filter(
        ([event, payload]) =>
          event === "chat" &&
          (payload as { runId?: string; state?: string }).runId === "idem-queued-followup" &&
          (payload as { state?: string }).state === "final",
      );
      expect(finalEvents).toHaveLength(1);
      expect(onQueuedFollowupReplyBatch).toBeTypeOf("function");
      await onQueuedFollowupReplyBatch?.({
        kind: "queued-followup",
        runId: "queued-followup-agent-run",
        originatingChannel: "webchat",
        payloads: [{ text: "queued follow-up answer" }],
      });
      expect(broadcast).toHaveBeenCalledWith(
        "chat",
        expect.objectContaining({
          runId: "queued-followup-agent-run",
          state: "final",
          message: expect.objectContaining({
            content: [{ type: "text", text: "queued follow-up answer" }],
          }),
        }),
        { sessionKeys: ["agent:main:main"] },
      );
      expect(context.chatQueuedTurns.has("idem-queued-followup")).toBe(true);
      expect(isSessionWorkAdmissionActive(storePath, ["agent:main:main", "sess-main"])).toBe(true);
      const { createAgentTurnService } = await import("./agent-turn/agent-turn-service.js");
      await expect(
        createAgentTurnService({ context, isWebchatConnect: () => true }).waitForTurn({
          runId: "idem-queued-followup",
          timeoutMs: 10,
        }),
      ).resolves.toMatchObject({
        runId: "idem-queued-followup",
        status: "pending",
        timeoutPhase: "queue",
        providerStarted: false,
      });

      onQueueDisposition?.("queue-cap-old");
      expect(context.logGateway.info).toHaveBeenCalledWith(
        "chat queue turn intentionally skipped",
        {
          runId: "idem-queued-followup",
          sessionKey: "agent:main:main",
          outcome: "skipped",
          reason: "queue-cap-old",
        },
      );

      context.dedupe.delete("chat:idem-queued-followup");
      const replayRespond = vi.fn() as RespondFn;
      await callDirectChat("chat.send", {
        id: "queued-followup-replay",
        params: makeChatSendParams({
          message: "queued prompt",
          idempotencyKey: "idem-queued-followup",
        }),
        client: makeTuiClient(),
        isWebchatConnect: () => true,
        respond: replayRespond,
        context,
      });
      expect(replayRespond).toHaveBeenCalledWith(
        true,
        { runId: "idem-queued-followup", status: "in_flight" },
        undefined,
        { cached: true, runId: "idem-queued-followup" },
      );
      expect(dispatchInboundMessageMock).toHaveBeenCalledTimes(1);

      const queuedEntry = context.chatQueuedTurns.get("idem-queued-followup");
      expect(queuedEntry).toBeDefined();
      queuedEntry?.controller.abort();
      expect(context.chatQueuedTurns.has("idem-queued-followup")).toBe(false);

      turnAdoptionLifecycle?.onSettled?.();
      expect(context.chatQueuedTurns.has("idem-queued-followup")).toBe(false);
      expect(isSessionWorkAdmissionActive(storePath, ["agent:main:main", "sess-main"])).toBe(false);
      await waitForFast(
        () => expect(context.removeChatRun).toHaveBeenCalledTimes(1),
        FAST_WAIT_OPTS,
      );

      let failedDispatchLifecycle: GetReplyOptions["turnAdoptionLifecycle"];
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        failedDispatchLifecycle = (args as { replyOptions?: GetReplyOptions }).replyOptions
          ?.turnAdoptionLifecycle;
        failedDispatchLifecycle?.onDeferred?.();
        throw new Error("post-enqueue bookkeeping failed");
      });
      await callDirectChat("chat.send", {
        id: "queued-followup-post-error",
        params: makeChatSendParams({
          message: "accepted before dispatch error",
          idempotencyKey: "idem-queued-followup-post-error",
        }),
        client: makeTuiClient(),
        isWebchatConnect: () => true,
        respond: vi.fn() as RespondFn,
        context,
      });

      await waitForFast(
        () => expect(context.removeChatRun).toHaveBeenCalledTimes(2),
        FAST_WAIT_OPTS,
      );
      const acceptedErrorEvents = broadcast.mock.calls.filter(
        ([event, payload]) =>
          event === "chat" &&
          (payload as { runId?: string }).runId === "idem-queued-followup-post-error",
      );
      expect(acceptedErrorEvents).toHaveLength(1);
      expect(acceptedErrorEvents[0]?.[1]).toMatchObject({ state: "final" });
      expect(context.dedupe.get("chat:idem-queued-followup-post-error")).toMatchObject({
        ok: true,
        payload: { status: "ok" },
      });
      expect(context.chatQueuedTurns.has("idem-queued-followup-post-error")).toBe(true);
      failedDispatchLifecycle?.onSettled?.();
      expect(context.chatQueuedTurns.has("idem-queued-followup-post-error")).toBe(false);
    });
  });

  test("chat.send emits operator-only post-ACK server timing milestones", async () => {
    await withDirectChatSession(async () => {
      await writeStoredMainSession({});

      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const broadcastToConnIds = vi.fn();
      const context = createDirectChatContext({
        getRuntimeConfig,
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        broadcastToConnIds,
      });
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const replyOptions = (args as { replyOptions?: GetReplyOptions }).replyOptions;
        replyOptions?.onModelSelected?.({
          provider: "openai",
          model: "gpt-5.5",
          thinkLevel: undefined,
        });
        replyOptions?.onAgentRunStart?.("agent-run-1");
        return {};
      });

      await callDirectChat("chat.send", {
        id: "operator-timing",
        params: makeChatSendParams({
          message: "measure",
          idempotencyKey: "idem-server-timing",
        }),
        client: createControlUiClient(["operator.write"], { connId: "conn-control-ui" }),
        isWebchatConnect: () => true,
        respond: captureChatResponse(responses),
        context,
      });

      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-server-timing",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          }),
          error: undefined,
        },
      ]);
      await waitForFast(
        () => {
          const phases = broadcastToConnIds.mock.calls
            .filter(([event]) => event === "chat.send_timing")
            .map(([, payload]) => (payload as { phase?: unknown }).phase);
          expect(phases).toEqual(
            expect.arrayContaining([
              "dispatch-started",
              "model-selected",
              "agent-run-started",
              "dispatch-completed",
              "post-dispatch-completed",
            ]),
          );
        },
        { timeout: 2_000, interval: 5 },
      );
      for (const [event, payload, connIds, opts] of broadcastToConnIds.mock.calls) {
        expect(event).toBe("chat.send_timing");
        expect(connIds).toEqual(new Set(["conn-control-ui"]));
        expect(opts).toEqual({ dropIfSlow: true });
        expect(payload).toMatchObject({
          runId: "idem-server-timing",
          sessionKey: "agent:main:main",
          ackToPhaseMs: expect.any(Number),
          receivedToPhaseMs: expect.any(Number),
        });
      }
      const timingPayloads = broadcastToConnIds.mock.calls.map(([, payload]) => payload);
      expect(timingPayloads).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            phase: "model-selected",
            provider: "openai",
            model: "gpt-5.5",
          }),
          expect.objectContaining({
            phase: "agent-run-started",
            agentRunId: "agent-run-1",
            dispatchStartedToPhaseMs: expect.any(Number),
          }),
        ]),
      );
    });
  });

  test("chat.send emits first-assistant timing for direct final replies", async () => {
    await withDirectChatSession(async () => {
      await writeStoredMainSession({});

      const responses: Array<{ ok: boolean; payload?: unknown; error?: unknown }> = [];
      const broadcast = vi.fn();
      const broadcastToConnIds = vi.fn();
      const context = createDirectChatContext({
        getRuntimeConfig,
        loadGatewayModelCatalog: vi.fn<GatewayRequestContext["loadGatewayModelCatalog"]>(),
        broadcast,
        broadcastToConnIds,
      });
      dispatchInboundMessageMock.mockImplementationOnce(async (args: unknown) => {
        const dispatcher = (
          args as {
            dispatcher?: {
              sendFinalReply: (payload: { text: string }) => boolean;
              markComplete: () => void;
              waitForIdle: () => Promise<void>;
            };
          }
        ).dispatcher;
        dispatcher?.sendFinalReply({ text: "direct reply" });
        dispatcher?.markComplete();
        await dispatcher?.waitForIdle();
        return {};
      });

      await callDirectChat("chat.send", {
        id: "operator-direct-timing",
        params: makeChatSendParams({
          message: "measure direct",
          idempotencyKey: "idem-direct-server-timing",
        }),
        client: createControlUiClient(["operator.write"], { connId: "conn-control-ui" }),
        isWebchatConnect: () => true,
        respond: captureChatResponse(responses),
        context,
      });

      expect(responses).toEqual([
        {
          ok: true,
          payload: expect.objectContaining({
            runId: "idem-direct-server-timing",
            status: "started",
          }),
          error: undefined,
        },
      ]);
      await waitForFast(
        () => {
          expect(broadcastToConnIds).toHaveBeenCalledWith(
            "chat.send_timing",
            expect.objectContaining({
              phase: "first-assistant-event",
              runId: "idem-direct-server-timing",
              sessionKey: "agent:main:main",
              ackToPhaseMs: expect.any(Number),
              dispatchStartedToPhaseMs: expect.any(Number),
              receivedToPhaseMs: expect.any(Number),
            }),
            new Set(["conn-control-ui"]),
            { dropIfSlow: true },
          );
          expect(broadcast).toHaveBeenCalledWith(
            "chat",
            expect.objectContaining({
              runId: "idem-direct-server-timing",
              state: "final",
              message: expect.objectContaining({
                content: expect.arrayContaining([
                  expect.objectContaining({
                    text: "direct reply",
                  }),
                ]),
              }),
            }),
            { sessionKeys: ["agent:main:main"] },
          );
        },
        { timeout: 2_000, interval: 5 },
      );

      const firstAssistantTimingCallIndex = broadcastToConnIds.mock.calls.findIndex(
        ([event, payload]) =>
          event === "chat.send_timing" &&
          (payload as { phase?: unknown }).phase === "first-assistant-event",
      );
      expect(firstAssistantTimingCallIndex).toBeGreaterThanOrEqual(0);
      expect(
        broadcastToConnIds.mock.invocationCallOrder[firstAssistantTimingCallIndex],
      ).toBeLessThan(
        expectDefined(
          broadcast.mock.invocationCallOrder[0],
          "broadcast.mock.invocationCallOrder[0] test invariant",
        ),
      );
    });
  });

  test("chat.history backfills claude-cli sessions from Claude project files", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionId = "sess-claude-cli-backfill";
      const homeEnvSnapshot = captureEnv(["HOME"]);
      const homeDir = path.join(sessionDir, "home");
      const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07530";
      const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
      await fs.mkdir(claudeProjectsDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeProjectsDir, `${cliSessionId}.jsonl`),
        [
          JSON.stringify({
            type: "queue-operation",
            operation: "enqueue",
            timestamp: "2026-03-26T16:29:54.722Z",
            sessionId: cliSessionId,
            content: "[Thu 2026-03-26 16:29 GMT] hi",
          }),
          JSON.stringify({
            type: "user",
            uuid: "user-1",
            timestamp: "2026-03-26T16:29:54.800Z",
            message: {
              role: "user",
              content:
                'Sender: ⟦openclaw:ctx⟧\n```json\n{"label":"openclaw-control-ui"}\n```\n\n[Thu 2026-03-26 16:29 GMT] hi',
            },
          }),
          JSON.stringify({
            type: "user",
            uuid: "skill-meta-1",
            isMeta: true,
            sourceToolUseID: "toolu_skill",
            timestamp: "2026-03-26T16:29:55.000Z",
            message: {
              role: "user",
              content: [
                { type: "text", text: "Base directory for this skill: /tmp/skills/autoreview" },
              ],
            },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "assistant-1",
            timestamp: "2026-03-26T16:29:55.500Z",
            message: {
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "hello from Claude" }],
            },
          }),
          ...Array.from({ length: 105 }, (_, index) =>
            JSON.stringify({
              type: index % 2 === 0 ? "user" : "assistant",
              uuid: `older-${index}`,
              timestamp: new Date(Date.parse("2026-03-26T16:30:00.000Z") + index).toISOString(),
              message: {
                role: index % 2 === 0 ? "user" : "assistant",
                content: [{ type: "text", text: `imported message ${index + 1}` }],
              },
            }),
          ),
        ].join("\n"),
        "utf-8",
      );
      setTestEnvValue("HOME", homeDir);
      try {
        await writeStoredMainSession(
          makeClaudeCliSessionEntry(sessionDir, sessionId, cliSessionId),
        );
        const history = await rpcReq<{
          messages?: Array<{ __openclaw?: { id?: string } }>;
          hasMore?: boolean;
          nextOffset?: number;
          totalMessages?: number;
          completeSnapshot?: boolean;
        }>(ws, "chat.history", makeMainSessionParams({ limit: 100 }));
        expect(history.ok).toBe(true);
        const messages = history.payload?.messages ?? [];
        expect(messages).toHaveLength(107);
        const userMessage = expectDefined(messages[0], "oldest imported user message") as {
          role?: string;
          content?: string;
          provenance?: unknown;
        };
        expect(userMessage.role).toBe("user");
        expect(userMessage.content).toBe("hi");
        // The operator-authored turn carries no injected provenance.
        expect(userMessage.provenance).toBeUndefined();
        expect(JSON.stringify(messages)).not.toContain("Base directory for this skill");
        const assistantMessage = expectDefined(
          messages[1],
          "oldest imported assistant message",
        ) as { role?: string; provider?: string };
        expect(assistantMessage.role).toBe("assistant");
        expect(assistantMessage.provider).toBe("claude-cli");
        expect(JSON.stringify(messages)).toContain("imported message 105");
        expect(history.payload?.hasMore).toBe(false);
        expect(history.payload?.nextOffset).toBeUndefined();
        expect(history.payload?.totalMessages).toBe(107);
        expect(history.payload?.completeSnapshot).toBe(true);
        expect(new Set(messages.map((message) => message["__openclaw"]?.id)).size).toBe(107);
      } finally {
        homeEnvSnapshot.restore();
      }
    });
  });

  test("chat.history deduplicates a structured local Claude delivery with managed audio", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionId = "sess-claude-cli-delivery-dedupe";
      const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07531";
      const deliveryTimestamp = Date.parse("2026-03-26T16:29:55.500Z");
      const homeEnvSnapshot = captureEnv(["HOME"]);
      const homeDir = path.join(sessionDir, "home");
      const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
      const managedAudioUrl = "/api/chat/media/outgoing/main/claude-delivery/full";
      await fs.mkdir(claudeProjectsDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeProjectsDir, `${cliSessionId}.jsonl`),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-delivery-ready",
          timestamp: new Date(deliveryTimestamp).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "CLAUDE DELIVERY READY" }],
          },
        }),
        "utf-8",
      );
      setTestEnvValue("HOME", homeDir);
      try {
        await writeStoredMainSession(
          makeClaudeCliSessionEntry(sessionDir, sessionId, cliSessionId),
        );
        await writeMainSessionTranscript(
          [
            createTextTranscriptEvent("assistant", "CLAUDE DELIVERY READY", {
              timestamp: deliveryTimestamp,
              message: {
                content: [
                  {
                    type: "text",
                    text: "CLAUDE DELIVERY READY",
                  },
                  { type: "audio", url: managedAudioUrl, openUrl: managedAudioUrl },
                ],
                openclawDelivery: { replyToId: "delivery-run-1" },
              },
            }),
          ],
          sessionId,
        );

        const history = await rpcReq<{
          messages?: Array<{ role?: unknown; content?: unknown }>;
        }>(ws, "chat.history", makeMainSessionParams({ limit: 100 }));
        expect(history.ok).toBe(true);
        const assistantMessages = (history.payload?.messages ?? []).filter(
          (message) => message.role === "assistant",
        );
        expect(assistantMessages).toHaveLength(1);
        const survivingContent = expectDefined(
          assistantMessages[0]?.content,
          "surviving assistant content",
        );
        expect(Array.isArray(survivingContent)).toBe(true);
        const contentBlocks = survivingContent as Array<{ type?: unknown; text?: unknown }>;
        expect(
          contentBlocks.filter(
            (block) => block.type === "text" && block.text === "CLAUDE DELIVERY READY",
          ),
        ).toHaveLength(1);
        expect(contentBlocks.filter((block) => block.type === "audio")).toHaveLength(1);
        expect(JSON.stringify(assistantMessages)).not.toContain("[[reply_to:");
      } finally {
        homeEnvSnapshot.restore();
      }
    });
  });

  test("chat startup and history share a non-blocking large Claude snapshot", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const secondWs = await harness.openWs();
      const homeEnvSnapshot = captureEnv(["HOME"]);
      try {
        await connectOk(secondWs);
        const sessionDir = await createSessionDir();
        const sessionId = "sess-claude-cli-large-snapshot";
        const cliSessionId = "7b8b202c-f6bb-4046-9475-d2f15fd07533";
        const homeDir = path.join(sessionDir, "home");
        const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
        const secret = "sk-abcdef1234567890-large-snapshot";
        const oversizedIgnoredLine = JSON.stringify({
          type: "queue-operation",
          operation: "enqueue",
          sessionId: cliSessionId,
          content: "q".repeat(34 * 1024 * 1024),
        });
        const jsonl = `${oversizedIgnoredLine}\n${[
          JSON.stringify({
            type: "user",
            uuid: "large-snapshot-user",
            timestamp: "2026-03-26T16:29:54.800Z",
            message: { role: "user", content: "large snapshot question" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "large-snapshot-assistant",
            timestamp: "2026-03-26T16:29:55.500Z",
            message: {
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: `large snapshot answer ${secret}` }],
            },
          }),
        ].join("\n")}`;
        expect(Buffer.byteLength(jsonl, "utf8")).toBeGreaterThan(32 * 1024 * 1024);
        expect(Buffer.byteLength(jsonl, "utf8")).toBeLessThan(36 * 1024 * 1024);
        await fs.mkdir(claudeProjectsDir, { recursive: true });
        await fs.writeFile(path.join(claudeProjectsDir, `${cliSessionId}.jsonl`), jsonl, "utf8");
        setTestEnvValue("HOME", homeDir);
        await writeStoredMainSession(
          makeClaudeCliSessionEntry(sessionDir, sessionId, cliSessionId),
        );
        await writeMainSessionTranscript(
          [
            createTextTranscriptEvent("user", "local sqlite row", {
              timestamp: Date.parse("2026-03-26T16:29:53.000Z"),
            }),
          ],
          sessionId,
        );

        let heartbeatTicks = 0;
        const heartbeat = setInterval(() => {
          heartbeatTicks += 1;
        }, 5);
        const [startup, history] = await Promise.all([
          rpcReq<{
            messages?: Array<{ __openclaw?: Record<string, unknown> }>;
            completeSnapshot?: boolean;
            hasMore?: boolean;
            nextOffset?: number;
            totalMessages?: number;
          }>(ws, "chat.startup", makeMainSessionParams()),
          rpcReq<{
            messages?: Array<{ __openclaw?: Record<string, unknown> }>;
            completeSnapshot?: boolean;
            hasMore?: boolean;
            nextOffset?: number;
            totalMessages?: number;
          }>(secondWs, "chat.history", makeMainSessionParams()),
        ]).finally(() => clearInterval(heartbeat));

        expect(startup.ok).toBe(true);
        expect(history.ok).toBe(true);
        expect(heartbeatTicks).toBeGreaterThan(5);
        expect(startup.payload?.messages).toEqual(history.payload?.messages);
        const messages = startup.payload?.messages ?? [];
        expect(messages).toHaveLength(3);
        expect(JSON.stringify(messages)).not.toContain(secret);
        for (const externalId of ["large-snapshot-user", "large-snapshot-assistant"]) {
          expect(messages).toContainEqual(
            expect.objectContaining({
              __openclaw: expect.objectContaining({
                cliSessionId,
                externalId,
                importedFrom: "claude-cli",
              }),
            }),
          );
        }
        for (const response of [startup, history]) {
          expect(response.payload?.completeSnapshot).toBe(true);
          expect(response.payload?.hasMore).toBe(false);
          expect(response.payload?.nextOffset).toBeUndefined();
          expect(response.payload?.totalMessages).toBe(3);
        }
      } finally {
        secondWs.close();
        homeEnvSnapshot.restore();
      }
    });
  });

  test("chat.history makes the full local prefix reachable in a claude-cli merge", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionId = "sess-claude-cli-local-prefix";
      const cliSessionId = "5b8b202c-f6bb-4046-9475-d2f15fd07532";
      const homeEnvSnapshot = captureEnv(["HOME"]);
      const homeDir = path.join(sessionDir, "home");
      const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
      await fs.mkdir(claudeProjectsDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeProjectsDir, `${cliSessionId}.jsonl`),
        [
          JSON.stringify({
            type: "user",
            uuid: "import-prefix-user",
            timestamp: "2026-03-26T16:29:54.800Z",
            message: { role: "user", content: "import prefix user" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "import-prefix-assistant",
            timestamp: "2026-03-26T16:29:55.500Z",
            message: { role: "assistant", content: "import prefix assistant" },
          }),
        ].join("\n"),
        "utf-8",
      );
      setTestEnvValue("HOME", homeDir);
      try {
        await writeStoredMainSession(
          makeClaudeCliSessionEntry(sessionDir, sessionId, cliSessionId),
        );
        await writeMainSessionTranscript(
          Array.from({ length: 70 }, (_, index) =>
            createTextTranscriptEvent(
              index % 2 === 0 ? "user" : "assistant",
              `local-only message ${index + 1}`,
              { timestamp: Date.parse("2026-03-27T00:00:00.000Z") + index },
            ),
          ),
          sessionId,
        );

        const history = await rpcReq<{
          messages?: Array<{ __openclaw?: { id?: string; seq?: number } }>;
          hasMore?: boolean;
          nextOffset?: number;
          totalMessages?: number;
          completeSnapshot?: boolean;
        }>(ws, "chat.history", makeMainSessionParams({ limit: 2 }));
        expect(history.ok).toBe(true);
        expect(history.payload?.totalMessages).toBe(72);
        expect(history.payload?.hasMore).toBe(false);
        expect(history.payload?.nextOffset).toBeUndefined();
        expect(history.payload?.completeSnapshot).toBe(true);
        const deliveredIdentities = new Set(
          (history.payload?.messages ?? []).map((message) => {
            const metadata = expectDefined(message["__openclaw"], "history metadata");
            return metadata.seq !== undefined
              ? `seq:${metadata.seq}`
              : `id:${expectDefined(metadata.id, "history id")}`;
          }),
        );
        expect(deliveredIdentities.size).toBe(72);
        expect(deliveredIdentities).toContain("id:import-prefix-user");
        expect(deliveredIdentities).toContain("id:import-prefix-assistant");
        for (let index = 1; index <= 70; index += 1) {
          expect(deliveredIdentities).toContain(`seq:${index}`);
        }
      } finally {
        homeEnvSnapshot.restore();
      }
    });
  });

  test("chat.history keeps offset paging when a claude-cli binding has no import", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionId = "sess-claude-cli-missing-import";
      const homeEnvSnapshot = captureEnv(["HOME"]);
      setTestEnvValue("HOME", path.join(sessionDir, "empty-home"));
      try {
        await writeStoredMainSession(
          makeClaudeCliSessionEntry(sessionDir, sessionId, "missing-cli-session"),
        );
        await writeMainSessionTranscript(
          Array.from({ length: 5 }, (_, index) =>
            createTextTranscriptEvent(
              index % 2 === 0 ? "user" : "assistant",
              `local message ${index + 1}`,
              { timestamp: Date.now() + index },
            ),
          ),
          sessionId,
        );

        const firstPage = await rpcReq<{
          messages?: Array<{ __openclaw?: { seq?: number } }>;
          hasMore?: boolean;
          nextOffset?: number;
          totalMessages?: number;
        }>(ws, "chat.history", makeMainSessionParams({ limit: 2 }));
        expect(firstPage.ok).toBe(true);
        expect(firstPage.payload?.messages?.map(readOpenClawSeq)).toEqual([4, 5]);
        expect(firstPage.payload?.hasMore).toBe(true);
        expect(firstPage.payload?.nextOffset).toBe(2);
        expect(firstPage.payload?.totalMessages).toBe(5);

        const secondPage = await rpcReq<{
          messages?: Array<{ __openclaw?: { seq?: number } }>;
          hasMore?: boolean;
          nextOffset?: number;
        }>(
          ws,
          "chat.history",
          makeMainSessionParams({
            limit: 2,
            offset: firstPage.payload?.nextOffset,
          }),
        );
        expect(secondPage.ok).toBe(true);
        expect(secondPage.payload?.messages?.map(readOpenClawSeq)).toEqual([2, 3]);
        expect(secondPage.payload?.hasMore).toBe(true);
        expect(secondPage.payload?.nextOffset).toBe(4);
      } finally {
        homeEnvSnapshot.restore();
      }
    });
  });

  test("chat.history terminates when the full local read dedupes every claude-cli import", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      const sessionDir = await createSessionDir();
      const sessionId = "sess-claude-cli-dedupe-loop";
      const homeEnvSnapshot = captureEnv(["HOME"]);
      const homeDir = path.join(sessionDir, "home");
      const cliSessionId = "0f5b202c-f6bb-4046-9475-d2f15fd07531";
      const claudeProjectsDir = path.join(homeDir, ".claude", "projects", "workspace");
      const dupBaseMs = Date.parse("2026-03-26T16:29:54.800Z");
      await fs.mkdir(claudeProjectsDir, { recursive: true });
      await fs.writeFile(
        path.join(claudeProjectsDir, `${cliSessionId}.jsonl`),
        [
          JSON.stringify({
            type: "user",
            uuid: "dup-user-1",
            timestamp: new Date(dupBaseMs).toISOString(),
            message: { role: "user", content: "dup user question" },
          }),
          JSON.stringify({
            type: "assistant",
            uuid: "dup-assistant-1",
            timestamp: new Date(dupBaseMs + 1000).toISOString(),
            message: {
              role: "assistant",
              model: "claude-sonnet-4-6",
              content: [{ type: "text", text: "dup assistant reply" }],
            },
          }),
        ].join("\n"),
        "utf-8",
      );
      setTestEnvValue("HOME", homeDir);
      try {
        await writeStoredMainSession(
          makeClaudeCliSessionEntry(sessionDir, sessionId, cliSessionId),
        );
        // The two import copies are the oldest local records; 45 newer
        // local-only records push them past the limit-1 tail window (40 raw
        // messages), so the tail merge incorporates the import while the full
        // read dedupes everything. This layout used to recurse forever.
        await writeMainSessionTranscript(
          [
            createTextTranscriptEvent("user", "dup user question", { timestamp: dupBaseMs }),
            createTextTranscriptEvent("assistant", "dup assistant reply", {
              timestamp: dupBaseMs + 1000,
            }),
            ...Array.from({ length: 45 }, (_, index) =>
              createTextTranscriptEvent(
                index % 2 === 0 ? "user" : "assistant",
                `local-only message ${index + 1}`,
                { timestamp: dupBaseMs + 60_000 + index },
              ),
            ),
          ],
          sessionId,
        );

        const history = await rpcReq<{
          messages?: unknown[];
          hasMore?: boolean;
          nextOffset?: number;
          totalMessages?: number;
        }>(ws, "chat.history", makeMainSessionParams({ limit: 1 }));
        expect(history.ok).toBe(true);
        expect(history.payload?.totalMessages).toBe(47);
        expect(history.payload?.hasMore).toBe(true);
        expect(history.payload?.nextOffset).toBeGreaterThan(0);
        expect(JSON.stringify(history.payload?.messages?.at(-1))).toContain(
          "local-only message 45",
        );
      } finally {
        homeEnvSnapshot.restore();
      }
    });
  });

  test("chat.history overreads one local message to drop stale announce pairs at the limit boundary", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      const sessionStartedAt = Date.parse("2026-05-23T04:02:30.000Z");
      await writeStoredMainSession({
        sessionStartedAt,
      });
      await writeMainSessionTranscript([
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:31.000Z",
          message: {
            role: "user",
            content: [
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
              "stale announce payload",
            ].join("\n"),
            provenance: {
              kind: "inter_session",
              sourceSessionKey: "agent:main:subagent:child",
              sourceTool: "subagent_announce",
            },
          },
        }),
        makeTranscriptTextEvent("stale announce reply", {
          timestamp: "2026-05-16T16:00:33.000Z",
        }),
        makeTranscriptTextEvent("fresh turn", {
          role: "user",
          timestamp: "2026-05-23T04:03:10.000Z",
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 2 });
      expect(messages).toHaveLength(1);
      expect(JSON.stringify(messages)).not.toContain("stale announce reply");
      expect(JSON.stringify(messages)).toContain("fresh turn");
    });
  });

  test("chat.history does not surface an older stale assistant when overreading for pair context", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      const sessionStartedAt = Date.parse("2026-05-23T04:02:30.000Z");
      await writeStoredMainSession({
        sessionStartedAt,
      });
      const announce = {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:child",
        sourceTool: "subagent_announce",
      };
      await writeMainSessionTranscript([
        JSON.stringify({ type: "session", version: 1, id: "sess-main" }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:29.000Z",
          message: {
            role: "user",
            content:
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
            provenance: announce,
          },
        }),
        makeTranscriptTextEvent("older stale announce reply", {
          timestamp: "2026-05-16T16:00:30.000Z",
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:31.000Z",
          message: {
            role: "user",
            content:
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
            provenance: announce,
          },
        }),
        makeTranscriptTextEvent("newer stale announce reply", {
          timestamp: "2026-05-16T16:00:33.000Z",
        }),
        makeTranscriptTextEvent("fresh turn", {
          role: "user",
          timestamp: "2026-05-23T04:03:10.000Z",
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 3 });
      const serialized = JSON.stringify(messages);
      expect(serialized).not.toContain("older stale announce reply");
      expect(serialized).not.toContain("newer stale announce reply");
      expect(serialized).toContain("fresh turn");
    });
  });

  test("chat.history offset pages backfill after filtering stale announce replies", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      const sessionStartedAt = Date.parse("2026-05-23T04:02:30.000Z");
      const announce = {
        kind: "inter_session",
        sourceSessionKey: "agent:main:subagent:child",
        sourceTool: "subagent_announce",
      };
      await writeStoredMainSession({
        sessionStartedAt,
      });
      await writeMainSessionTranscript([
        makeTranscriptTextEvent("older visible turn", {
          role: "user",
          timestamp: "2026-05-23T04:03:10.000Z",
        }),
        JSON.stringify({
          timestamp: "2026-05-16T16:00:31.000Z",
          message: {
            role: "user",
            content:
              "[Inter-session message] sourceSession=agent:main:subagent:child sourceChannel=internal sourceTool=subagent_announce",
            provenance: announce,
          },
        }),
        makeTranscriptTextEvent("stale announce reply", {
          timestamp: "2026-05-16T16:00:33.000Z",
        }),
        makeTranscriptTextEvent("latest visible reply", {
          timestamp: "2026-05-23T04:03:20.000Z",
        }),
      ]);

      const page = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        nextOffset?: number;
        hasMore?: boolean;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 1,
          offset: 1,
          maxChars: 100,
        }),
      );
      expect(page.ok).toBe(true);
      expect(JSON.stringify(page.payload?.messages)).toContain("older visible turn");
      expect(JSON.stringify(page.payload)).not.toContain("stale announce reply");
      expect(page.payload?.nextOffset).toBeUndefined();
      expect(page.payload?.hasMore).toBe(false);
    });
  });

  test("chat.history offset pages preserve a hidden heartbeat boundary from overread context", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      await writeStoredMainSession({});
      await writeMainSessionTranscript([
        makeTranscriptTextEvent(HEARTBEAT_PROMPT, { role: "user" }),
        makeTranscriptTextEvent("heartbeat run output"),
        makeTranscriptTextEvent("newest output"),
      ]);

      const page = await rpcReq<{
        messages?: Array<{
          content?: Array<{ text?: string }>;
          __openclaw?: { turnBoundary?: boolean };
        }>;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 1,
          offset: 1,
        }),
      );

      expect(page.ok).toBe(true);
      expect(page.payload?.messages).toHaveLength(1);
      expect(page.payload?.messages?.[0]?.content?.[0]?.text).toBe("heartbeat run output");
      expect(page.payload?.messages?.[0]?.["__openclaw"]?.turnBoundary).toBe(true);
    });
  });

  test("chat.send does not force-disable block streaming", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = gatewayReplyMock;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();
      testState.agentConfig = { blockStreamingDefault: "on" };
      try {
        let capturedOpts: GetReplyOptions | undefined;
        mockGetReplyFromConfigOnce(async (_ctx, opts) => {
          capturedOpts = opts;
          return undefined;
        });

        const sendRes = await rpcReq(
          ws,
          "chat.send",
          makeChatSendParams({
            idempotencyKey: "idem-block-streaming",
          }),
        );
        expect(sendRes.ok).toBe(true);

        await waitForFast(() => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        }, FAST_WAIT_OPTS);

        expect(capturedOpts?.disableBlockStreaming).toBeUndefined();
      } finally {
        testState.agentConfig = undefined;
      }
    });
  });

  test("chat.send diagnostics timeline carries run correlation attributes", async () => {
    const timelineDir = autoCleanupTempDirs.make("openclaw-chat-timeline-");
    const timelinePath = path.join(timelineDir, "timeline.jsonl");
    const previousDiagnostics = process.env.OPENCLAW_DIAGNOSTICS;
    const previousTimelinePath = process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
    process.env.OPENCLAW_DIAGNOSTICS = "timeline";
    process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = timelinePath;
    try {
      await withGatewayChatHarness(
        async ({ ws, createSessionDir }) => {
          const spy = gatewayReplyMock;
          await connectOk(ws, makeGatewayWebchatClient());

          await createSessionDir();
          await writeMainSessionStore();
          mockGetReplyFromConfigOnce(async () => undefined);

          const sendRes = await rpcReq(
            ws,
            "chat.send",
            makeChatSendParams({
              idempotencyKey: "idem-timeline",
            }),
          );
          expect(sendRes.ok).toBe(true);
          expect(sendRes.payload).toMatchObject({
            runId: "idem-timeline",
            status: "started",
            serverTiming: {
              receivedToAckMs: expect.any(Number),
              loadSessionMs: expect.any(Number),
            },
          });

          await waitForFast(() => {
            expect(spy.mock.calls.length).toBeGreaterThan(0);
          }, FAST_WAIT_OPTS);
          await waitForFast(async () => {
            const events = await readTimelineEvents(timelinePath);
            const ackReady = events.find(
              (event) =>
                event.type === "mark" &&
                event.name === "gateway.chat_send.ack_ready" &&
                (event.attributes as Record<string, unknown> | undefined)?.runId ===
                  "idem-timeline",
            );
            expect(ackReady?.attributes).toMatchObject({
              runId: "idem-timeline",
              ackStatus: "started",
              serverReceivedToAckMs: expect.any(Number),
              serverLoadSessionMs: expect.any(Number),
            });
            expect(
              events.some(
                (event) =>
                  event.type === "span.end" &&
                  event.name === "gateway.chat_send.dispatch_inbound" &&
                  (event.attributes as Record<string, unknown> | undefined)?.runId ===
                    "idem-timeline",
              ),
            ).toBe(true);
          }, FAST_WAIT_OPTS);
        },
        {
          headers: { origin: `http://127.0.0.1:${harness.port}` },
        },
      );
    } finally {
      if (previousDiagnostics === undefined) {
        delete process.env.OPENCLAW_DIAGNOSTICS;
      } else {
        process.env.OPENCLAW_DIAGNOSTICS = previousDiagnostics;
      }
      if (previousTimelinePath === undefined) {
        delete process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH;
      } else {
        process.env.OPENCLAW_DIAGNOSTICS_TIMELINE_PATH = previousTimelinePath;
      }
    }
  });

  test("chat.send omits ACK server timing for public WebChat clients", async () => {
    await withGatewayChatHarness(
      async ({ ws, createSessionDir }) => {
        await connectOk(ws, makeGatewayWebchatClient(GATEWAY_CLIENT_NAMES.WEBCHAT_UI));

        await createSessionDir();
        await writeMainSessionStore();
        mockGetReplyFromConfigOnce(async () => undefined);

        const sendRes = await rpcReq(
          ws,
          "chat.send",
          makeChatSendParams({
            idempotencyKey: "idem-public-webchat",
          }),
        );

        expect(sendRes.ok).toBe(true);
        expect(sendRes.payload).toMatchObject({
          runId: "idem-public-webchat",
          status: "started",
        });
        expect(
          (sendRes.payload as { serverTiming?: unknown } | undefined)?.serverTiming,
        ).toBeUndefined();
      },
      {
        headers: { origin: `http://127.0.0.1:${harness.port}` },
      },
    );
  });

  test("chat.send rejects Control UI reconnect resume marker from public WebChat clients", async () => {
    await withGatewayChatHarness(
      async ({ ws }) => {
        await connectOk(ws, makeGatewayWebchatClient(GATEWAY_CLIENT_NAMES.WEBCHAT_UI));

        const sendRes = await rpcReq(
          ws,
          "chat.send",
          makeChatSendParams({
            sessionId: "sess-main",
            __controlUiReconnectResume: true,
            message: "hello after reconnect",
            idempotencyKey: "idem-public-webchat-resume",
          }),
        );
        expect(sendRes.ok).toBe(false);
      },
      {
        headers: { origin: `http://127.0.0.1:${harness.port}` },
      },
    );
  });

  test("chat.send forwards Control UI reconnect resume internally", async () => {
    await withGatewayChatHarness(
      async ({ ws, createSessionDir }) => {
        const spy = gatewayReplyMock;
        await connectOk(ws, makeGatewayWebchatClient());

        await createSessionDir();
        await writeMainSessionStore();
        let capturedOpts: InternalGetReplyOptions | undefined;
        mockGetReplyFromConfigOnce(async (_ctx, opts) => {
          capturedOpts = opts;
          return undefined;
        });

        const sendRes = await rpcReq(
          ws,
          "chat.send",
          makeChatSendParams({
            sessionId: "sess-main",
            __controlUiReconnectResume: true,
            message: "hello after reconnect",
            idempotencyKey: "idem-requested-session-id",
          }),
        );
        expect(sendRes.ok).toBe(true);

        await waitForFast(() => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        }, FAST_WAIT_OPTS);

        expect(capturedOpts?.requestedSessionId).toBe("sess-main");
        expect(capturedOpts?.resumeRequestedSession).toBe(true);
      },
      {
        headers: { origin: `http://127.0.0.1:${harness.port}` },
      },
    );
  });

  test("chat.send forwards one-turn queue mode overrides internally", async () => {
    await withGatewayChatHarness(
      async ({ ws, createSessionDir }) => {
        const spy = gatewayReplyMock;
        await connectOk(ws, makeGatewayWebchatClient());

        await createSessionDir();
        await writeMainSessionStore();
        let capturedOpts: InternalGetReplyOptions | undefined;
        mockGetReplyFromConfigOnce(async (_ctx, opts) => {
          capturedOpts = opts;
          return undefined;
        });

        const sendRes = await rpcReq(
          ws,
          "chat.send",
          makeChatSendParams({
            message: "follow up this turn",
            queueMode: "followup",
            idempotencyKey: "idem-queue-mode-override",
          }),
        );
        expect(sendRes.ok).toBe(true);

        await waitForFast(() => {
          expect(spy.mock.calls.length).toBeGreaterThan(0);
        }, FAST_WAIT_OPTS);

        expect(capturedOpts).toMatchObject({ queueModeOverride: "followup" });
      },
      {
        headers: { origin: `http://127.0.0.1:${harness.port}` },
      },
    );
  });

  test("chat.history hard-caps single oversized nested payloads", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const historyMaxBytes = getMaxChatHistoryMessagesBytes();
      const hugeNestedText = "n".repeat(300_000);
      await writeMainSessionTranscript([
        JSON.stringify({
          id: "msg-huge",
          message: {
            role: "assistant",
            timestamp: Date.now(),
            content: [
              {
                type: "tool_result",
                toolUseId: "tool-1",
                output: { nested: { payload: hugeNestedText } },
              },
            ],
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      const serialized = JSON.stringify(messages);
      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(historyMaxBytes);
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(messages[0]).toMatchObject({
        __openclaw: { id: "msg-huge", truncated: true, reason: "oversized" },
      });
      expect(serialized.includes(hugeNestedText.slice(0, 256))).toBe(false);
    });
  });

  test("projects persisted media facts through Gateway history and sessions_history", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const invalidClaims = [
        "media://inbound/nested/file.png",
        "media://inbound/nested%2Ffile.png",
        "media://inbound/nested%5Cfile.png",
        "media://inbound/file%00.png",
        "media://inbound/",
        "media://inbound/.",
        "media://inbound/..",
        ["media://user", "password@inbound/claim.png"].join(":"),
        "media://inbound/claim.png?signature=private-secret",
        "media://inbound/claim.png#private-fragment",
      ];
      const persisted = buildPersistedUserTurnMessage({
        text: "inspect mixed attachments",
        timestamp: Date.now(),
        media: [
          {
            kind: "video",
            url: "media://inbound/video-claim",
            contentType: "video/mp4",
            fileName: "managed-video.mp4",
            durationMs: 5678,
          },
          {
            kind: "image",
            url: "media://inbound/image-claim",
            contentType: "image/png",
            fileName: "managed-image.png",
            width: 640,
            height: 480,
          },
          {
            kind: "image",
            path: "/private/media/local-image.png",
            workspaceDir: "/private/workspace",
            contentType: "image/png",
            fileName: "local-image.png",
            sizeBytes: 42,
            width: 640,
            height: 480,
            messageId: "local-source-id",
          },
          {
            kind: "audio",
            url: "https://media-user@media.example/audio.wav?signature=private-signature#audio-fragment",
            contentType: "audio/wav",
            fileName: "remote-audio.wav",
            durationMs: 1234,
          },
          {
            kind: "document",
            url: "not a media reference",
            contentType: "application/pdf",
            fileName: "metadata-only.pdf",
          },
          ...invalidClaims.map((claim, index) => ({
            kind: "image" as const,
            path: claim,
            contentType: "image/png",
            fileName: `invalid-claim-${index}.png`,
          })),
        ],
        mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 1 }] },
      }) as unknown as Record<string, unknown>;
      const metadata = persisted["__openclaw"] as Record<string, unknown>;
      const facts = metadata.media as Array<Record<string, unknown>>;
      Object.assign(expectDefined(facts[2], "local media fact"), {
        data: "private-inline-data",
        blob: "private-inline-blob",
        filePath: "/private/media/alternate-image.png",
        source: "telegram-attachment-1",
      });
      metadata.upstreamUserText = "private upstream prompt";
      metadata.keepMe = { durable: true };
      await writeMainSessionTranscript([{ id: "persisted-media", message: persisted }]);

      const historyMessages = await fetchHistoryMessages(ws);
      const tool = createSessionsHistoryTool({
        config: {},
        callGateway: async <T = Record<string, unknown>>(request: {
          method: string;
          params?: unknown;
        }) => {
          const response = await rpcReq<T & Record<string, unknown>>(
            ws,
            request.method,
            request.params,
          );
          expect(response.ok).toBe(true);
          return expectDefined(response.payload, `${request.method} payload`);
        },
      });
      const toolResult = await tool.execute("persisted-media", { sessionKey: "main" });
      const sessionsHistory = (toolResult.details as { messages: unknown[] }).messages;

      for (const [boundary, messages] of [
        ["chat.history", historyMessages],
        ["sessions_history", sessionsHistory],
      ] as const) {
        expect(messages, boundary).toHaveLength(1);
        expect(messages[0], boundary).toMatchObject({
          role: "user",
          content: "inspect mixed attachments",
          __openclaw: {
            keepMe: { durable: true },
            mediaImageLayout: { slots: [{ kind: "offloaded", factIndex: 1 }] },
            media: [
              {
                kind: "video",
                url: "media://inbound/video-claim",
                contentType: "video/mp4",
                fileName: "managed-video.mp4",
                durationMs: 5678,
              },
              {
                kind: "image",
                url: "media://inbound/image-claim",
                contentType: "image/png",
                fileName: "managed-image.png",
                width: 640,
                height: 480,
              },
              {
                kind: "image",
                contentType: "image/png",
                fileName: "local-image.png",
                sizeBytes: 42,
                width: 640,
                height: 480,
                messageId: "local-source-id",
                source: "telegram-attachment-1",
              },
              {
                kind: "audio",
                url: "https://media.example/audio.wav",
                contentType: "audio/wav",
                fileName: "remote-audio.wav",
                durationMs: 1234,
              },
              {
                kind: "document",
                contentType: "application/pdf",
                fileName: "metadata-only.pdf",
              },
              ...invalidClaims.map((_, index) => ({
                kind: "image",
                contentType: "image/png",
                fileName: `invalid-claim-${index}.png`,
              })),
            ],
          },
        });
        const projectedMedia = (
          (messages[0] as { __openclaw?: { media?: Array<Record<string, unknown>> } })["__openclaw"]
            ?.media ?? []
        ).map((fact) => fact.path ?? fact.url ?? null);
        expect(projectedMedia, boundary).toEqual([
          "media://inbound/video-claim",
          "media://inbound/image-claim",
          null,
          "https://media.example/audio.wav",
          ...Array.from({ length: invalidClaims.length + 1 }, () => null),
        ]);
        const serialized = JSON.stringify(messages);
        for (const privateValue of [
          "/private/media",
          "/private/workspace",
          "private-inline-data",
          "private-inline-blob",
          "media-user",
          "private-signature",
          "audio-fragment",
          "private upstream prompt",
          "not a media reference",
        ]) {
          expect(serialized, `${boundary}: ${privateValue}`).not.toContain(privateValue);
        }
      }
    });
  });

  test("chat.history keeps recent messages within the production byte budget", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const historyMaxBytes = getMaxChatHistoryMessagesBytes();
      const baseText = "s".repeat(100_000);
      const lines: unknown[] = Array.from({ length: 70 }, (_, index) =>
        createTextTranscriptEvent("user", `small-${index}:${baseText}`, {
          timestamp: Date.now() + index,
        }),
      );
      lines.push(
        JSON.stringify({
          message: {
            role: "assistant",
            timestamp: Date.now() + 1_000,
            content: [
              {
                type: "tool_result",
                toolUseId: "tool-1",
                output: { nested: { payload: "z".repeat(300_000) } },
              },
            ],
          },
        }),
      );

      await writeMainSessionTranscript(lines);
      const messages = await fetchHistoryMessages(ws, { maxChars: 100_000 });
      const serialized = JSON.stringify(messages);

      expect(Buffer.byteLength(serialized, "utf8")).toBeLessThanOrEqual(historyMaxBytes);
      expect(serialized).toContain("small-69:");
      expect(serialized).toContain("[chat.history omitted: message too large]");
      expect(serialized).not.toContain("small-0:");
    });
  });

  test("chat.history serves older history past an oversized newest record", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const historyMaxBytes = getMaxChatHistoryMessagesBytes();
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "reachable older message", { timestamp: Date.now() }),
        makeTranscriptTextEvent("NO_REPLY", {
          message: {
            padding: "x".repeat(historyMaxBytes * 2 + 1024),
            timestamp: Date.now() + 1,
          },
        }),
      ]);

      const firstPage = await rpcReq<{
        messages?: unknown[];
        nextOffset?: number;
        hasMore?: boolean;
      }>(ws, "chat.history", makeMainSessionParams({ limit: 1 }));
      expect(firstPage.ok).toBe(true);
      expect(JSON.stringify(firstPage.payload?.messages)).toContain("reachable older message");
      expect(firstPage.payload?.hasMore).toBe(false);
      expect(firstPage.payload?.nextOffset).toBeUndefined();
    });
  });

  test("chat.history preserves usage and cost metadata for assistant messages", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();

      await writeMainSessionTranscript([
        makeTranscriptTextEvent("hello", {
          message: {
            timestamp: Date.now(),
            usage: {
              input: 12,
              output: 5,
              totalTokens: 17,
              cost: { input: 0.002, output: 0.01, cacheRead: 0.0003, cacheWrite: 0, total: 0.0123 },
            },
            cost: { input: 0.002, output: 0.01, cacheRead: 0.0003, cacheWrite: 0, total: 0.0123 },
            details: { debug: true },
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(messages).toHaveLength(1);
      const message = messages[0] as {
        role?: string;
        usage?: {
          input?: number;
          output?: number;
          totalTokens?: number;
          cost?: Record<string, number>;
        };
        cost?: Record<string, number>;
      };
      expect(message.role).toBe("assistant");
      expect(message.usage?.input).toBe(12);
      expect(message.usage?.output).toBe(5);
      expect(message.usage?.totalTokens).toBe(17);
      expect(message.usage?.cost).toEqual({
        input: 0.002,
        output: 0.01,
        cacheRead: 0.0003,
        cacheWrite: 0,
        total: 0.0123,
      });
      expect(message.cost).toEqual({
        input: 0.002,
        output: 0.01,
        cacheRead: 0.0003,
        cacheWrite: 0,
        total: 0.0123,
      });
      expect(message.cost?.total).toBe(0.0123);
      expect(messages[0]).not.toHaveProperty("details");
    });
  });

  test("chat.history preserves canonical parallel tool calls and bounded result diffs", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const fullDiff = `-12 old line\n+12 ${"new line ".repeat(20)}`;
      await writeMainSessionTranscript([
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              {
                type: "toolCall",
                id: "call-edit",
                name: "edit",
                arguments: { path: "src/a.ts", oldText: "old line", newText: "new line" },
              },
              {
                type: "toolCall",
                id: "call-read",
                name: "read",
                arguments: { path: "src/b.ts" },
              },
            ],
            timestamp: 1,
          },
        }),
        makeTranscriptTextEvent("Updated src/a.ts", {
          role: "toolResult",
          message: {
            toolCallId: "call-edit",
            toolName: "edit",
            details: { diff: fullDiff, internal: "not for display" },
            timestamp: 2,
          },
        }),
        makeTranscriptTextEvent("contents of b", {
          role: "toolResult",
          message: {
            toolCallId: "call-read",
            toolName: "read",
            timestamp: 3,
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws, { maxChars: 48 });
      expect(messages).toHaveLength(3);
      const callMessage = messages[0] as {
        content?: Array<{ id?: string; name?: string }>;
      };
      expect(callMessage.content?.map((block) => [block.id, block.name])).toEqual([
        ["call-edit", "edit"],
        ["call-read", "read"],
      ]);
      const editResult = messages[1] as {
        toolCallId?: string;
        details?: Record<string, unknown>;
      };
      expect(editResult.toolCallId).toBe("call-edit");
      expect(editResult.details).toEqual({ diff: expect.any(String) });
      const projectedDiff = editResult.details?.diff;
      expect(typeof projectedDiff).toBe("string");
      expect(projectedDiff).toContain("-12 old line");
      expect(projectedDiff).toContain("...(truncated)...");
      expect((projectedDiff as string).length).toBeLessThanOrEqual(
        48 + "\n...(truncated)...".length,
      );
    });
  });

  test("chat.history retains a completed command's Guardian review details", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const toolCallId = "exec-guardian-approved";
      const review = {
        id: "review-guardian-approved",
        label: "Guardian",
        status: "approved",
        riskLevel: "low",
        userAuthorization: "high",
        rationale: "The command is local and read-only.",
      };
      await writeMainSessionTranscript([
        {
          message: {
            role: "assistant",
            content: [{ type: "toolCall", id: toolCallId, name: "exec", arguments: {} }],
          },
        },
        makeTranscriptTextEvent("Command completed.", {
          role: "toolResult",
          message: {
            toolCallId,
            toolName: "exec",
            details: {
              approvalReviews: [review],
              approvalReviewOutcome: "approved",
              internal: "not for display",
            },
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      expect(messages).toHaveLength(2);
      expect(messages[1]).toMatchObject({
        role: "toolResult",
        toolCallId,
        details: {
          approvalReviews: [review],
          approvalReviewOutcome: "approved",
        },
      });
      expect(messages[1]).not.toHaveProperty("details.internal");
    });
  });

  test("chat.history preserves quoted inline directives verbatim", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();

      const quoted = "Use `[[reply_to_current]]` and `[[tts]]` literally.";
      const lines = [
        makeTranscriptTextEvent(quoted, {
          message: { openclawDelivery: { replyToCurrent: true }, timestamp: Date.now() },
        }),
      ];
      await writeMainSessionTranscript(lines);
      const messages = await fetchHistoryMessages(ws);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({
        content: [{ text: quoted }],
        openclawDelivery: { replyToCurrent: true },
      });
    });
  });

  test("chat.history preserves assistant trace from mixed tool-use transcript messages", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "fix it", { timestamp: 1 }),
        JSON.stringify({
          message: {
            role: "assistant",
            content: [
              { type: "thinking", thinking: "private reasoning" },
              {
                type: "text",
                text: "I will clean that up now.",
                textSignature: JSON.stringify({
                  v: 1,
                  id: "msg-progress",
                  phase: "commentary",
                }),
              },
              {
                type: "toolCall",
                id: "call-read",
                name: "read",
                arguments: { path: "AGENTS.md" },
              },
            ],
            timestamp: 2,
          },
        }),
        makeTranscriptTextEvent("file contents", {
          role: "toolResult",
          message: {
            toolCallId: "call-read",
            toolName: "read",
            timestamp: 3,
          },
        }),
      ]);

      const messages = await fetchHistoryMessages(ws);
      const assistantMessage = messages[2] as {
        role?: string;
        content?: Array<{ type?: string; text?: string }>;
        timestamp?: number;
      };
      expect(assistantMessage.role).toBe("assistant");
      expect(messages[1]).toMatchObject({
        role: "assistant",
        content: [{ type: "text", text: "I will clean that up now." }],
        openclawStreamFallback: {
          replacementText: "I will clean that up now.",
          source: "segment",
          itemId: "msg-progress",
        },
      });
      expect(assistantMessage.content).toEqual([
        { type: "thinking", thinking: "private reasoning" },
        {
          type: "toolCall",
          id: "call-read",
          name: "read",
          arguments: { path: "AGENTS.md" },
        },
      ]);
      expect(assistantMessage.timestamp).toBe(2);
    });
  });

  test("chat.history applies RPC maxChars", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("assistant", "abcdefghij", { timestamp: Date.now() }),
      ]);

      const messages = await fetchHistoryMessages(ws, { maxChars: 7 });
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain("abcdefg\\n...(truncated)...");
    });
  });

  test("chat.history rejects invalid RPC maxChars values", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });

      const zeroRes = await rpcReq(
        ws,
        "chat.history",
        makeMainSessionParams({
          maxChars: 0,
        }),
      );
      expect(zeroRes.ok).toBe(false);
      expect((zeroRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /invalid chat\.history params/i,
      );

      const tooLargeRes = await rpcReq(
        ws,
        "chat.history",
        makeMainSessionParams({
          maxChars: 500_001,
        }),
      );
      expect(tooLargeRes.ok).toBe(false);
      expect((tooLargeRes.error as { message?: string } | undefined)?.message ?? "").toMatch(
        /invalid chat\.history params/i,
      );
    });
  });

  test("chat.message.get returns the full projected message for a truncated history row", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("assistant", "abcdefghij", { id: "msg-full-assistant" }),
      ]);

      const historyMessages = await fetchHistoryMessages(ws, { maxChars: 5 });
      expect(JSON.stringify(historyMessages)).toContain("abcde\\n...(truncated)...");
      // The capped row is structurally marked so a client can detect the bounded
      // preview without sniffing the sentinel, then fetch the durable content.
      expect(
        (historyMessages[0] as Record<string, unknown> | undefined)?.["__openclaw"],
      ).toMatchObject({ truncated: true, reason: "display-cap" });

      const full = await fetchChatMessage(ws, makeMainMessageParams("msg-full-assistant"));
      expect(full.ok).toBe(true);
      expect(full.unavailableReason).toBeUndefined();
      expect(JSON.stringify(full.message)).toContain("abcdefghij");
      expect(JSON.stringify(full.message)).not.toContain("...(truncated)...");
      const fullMeta = (full.message as Record<string, unknown> | undefined)?.["__openclaw"];
      expect((fullMeta as { truncated?: unknown } | undefined)?.truncated).toBeUndefined();
    });
  });

  test("chat.message.get returns archive-backed rows surfaced by history", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionId = "sess-archive-backed";
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir, sessionId });
      await fs.writeFile(
        `${testSessionFilePath(sessionDir, sessionId)}.reset.2026-02-16T22-26-34.000Z`,
        [
          JSON.stringify({ type: "session", version: 1, id: sessionId }),
          JSON.stringify(
            createTextTranscriptEvent("assistant", "archive abcdefghij", {
              id: "msg-archive-full-assistant",
            }),
          ),
        ].join("\n"),
        "utf-8",
      );

      const historyMessages = await fetchHistoryMessages(ws, { maxChars: 12 });
      expect(JSON.stringify(historyMessages)).toContain("archive abcd\\n...(truncated)...");

      const full = await fetchChatMessage(ws, makeMainMessageParams("msg-archive-full-assistant"));
      expect(full.ok).toBe(true);
      expect(full.unavailableReason).toBeUndefined();
      expect(JSON.stringify(full.message)).toContain("archive abcdefghij");
      expect(JSON.stringify(full.message)).not.toContain("...(truncated)...");
    });
  });

  test("chat.message.get accepts the selected agent for global sessions", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await writeGatewayConfig({
        session: { scope: "global" },
        agents: {
          ownership: "explicit",
          defaults: { sessionStore: { agentId: "work" } },
          entries: { main: {}, work: {} },
        },
      });
      await connectOk(ws);
      await createSessionDir();
      await writeSessionStore({
        agentId: "work",
        entries: {
          global: { sessionId: "sess-global", updatedAt: Date.now() },
        },
      });
      await writeMainSessionTranscript(
        [
          createTextTranscriptEvent("assistant", "global agent content", {
            id: "msg-global-agent",
          }),
        ],
        "sess-global",
        { agentId: "work", sessionKey: "global" },
      );

      const full = await fetchChatMessage(ws, {
        sessionKey: "global",
        agentId: "work",
        messageId: "msg-global-agent",
      });
      expect(full.ok).toBe(true);
      expect(JSON.stringify(full.message)).toContain("global agent content");
    });
  });

  test("chat.message.get reports oversized archive transcript entries as unavailable", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionId = "sess-oversized-archive";
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir, sessionId });
      const oversizedLine = JSON.stringify(
        createTextTranscriptEvent("assistant", "x".repeat(300 * 1024), {
          id: "msg-oversized",
        }),
      );
      await fs.writeFile(
        `${testSessionFilePath(sessionDir, sessionId)}.reset.2026-02-16T22-26-34.000Z`,
        [JSON.stringify({ type: "session", version: 1, id: sessionId }), oversizedLine].join("\n"),
        "utf-8",
      );

      const full = await fetchChatMessage(ws, makeMainMessageParams("msg-oversized"));
      expect(full.ok).toBe(false);
      expect(full.unavailableReason).toBe("oversized");
      expect(full.message).toBeUndefined();
    });
  });

  test("chat.message.get returns active SQLite oversized transcript entries", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const oversizedText = "x".repeat(300 * 1024);
      await writeMainSessionTranscript([
        createTextTranscriptEvent("assistant", oversizedText, { id: "msg-oversized-sqlite" }),
      ]);

      const full = await fetchChatMessage(ws, makeMainMessageParams("msg-oversized-sqlite"));
      expect(full.ok).toBe(true);
      expect(JSON.stringify(full.message)).toContain(oversizedText.slice(0, 256));
    });
  });

  test("chat.message.get does not return inactive branch entries", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "question", { id: "msg-root", parentId: null }),
        createTextTranscriptEvent("assistant", "stale branch", {
          id: "msg-stale",
          parentId: "msg-root",
        }),
        createTextTranscriptEvent("assistant", "active branch", {
          id: "msg-active",
          parentId: "msg-root",
        }),
        createTextTranscriptEvent("assistant", "side delivery", {
          id: "msg-side-delivery",
          parentId: "msg-active",
        }),
        JSON.stringify({
          type: "leaf",
          id: "active-leaf",
          parentId: "msg-side-delivery",
          targetId: "msg-active",
        }),
      ]);
      await waitForSessionTranscriptIndexReconcile({
        agentId: "main",
        path: path.join(sessionDir, "openclaw-agent.sqlite"),
      });

      const stale = await fetchChatMessage(ws, makeMainMessageParams("msg-stale"));
      expect(stale.ok).toBe(false);
      expect(stale.unavailableReason).toBe("not_found");

      const sideDelivery = await fetchChatMessage(ws, makeMainMessageParams("msg-side-delivery"));
      expect(sideDelivery.ok).toBe(false);
      expect(sideDelivery.unavailableReason).toBe("not_found");

      const active = await fetchChatMessage(ws, makeMainMessageParams("msg-active"));
      expect(active.ok).toBe(true);
      expect(JSON.stringify(active.message)).toContain("active branch");
      expect(JSON.stringify(await fetchHistoryMessages(ws))).not.toContain("side delivery");
    });
  });

  test("chat.message.get does not return pre-session announce pairs hidden by history", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await connectOk(ws);
      await createSessionDir();
      const sessionStartedAt = Date.now();
      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now(), sessionStartedAt },
        },
      });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "announce", {
          id: "msg-announce",
          timestamp: sessionStartedAt - 2_000,
          message: { provenance: { kind: "inter_session", sourceTool: "subagent_announce" } },
        }),
        createTextTranscriptEvent("assistant", "hidden pre-session reply", {
          id: "msg-hidden-assistant",
          timestamp: sessionStartedAt - 1_000,
        }),
        createTextTranscriptEvent("assistant", "visible reply", {
          id: "msg-visible-assistant",
          timestamp: sessionStartedAt + 1_000,
        }),
      ]);

      const hidden = await fetchChatMessage(ws, makeMainMessageParams("msg-hidden-assistant"));
      expect(hidden.ok).toBe(false);
      expect(hidden.unavailableReason).toBe("not_found");

      const announce = await fetchChatMessage(ws, makeMainMessageParams("msg-announce"));
      expect(announce.ok).toBe(false);
      expect(announce.unavailableReason).toBe("not_found");

      const visible = await fetchChatMessage(ws, makeMainMessageParams("msg-visible-assistant"));
      expect(visible.ok).toBe(true);
      expect(JSON.stringify(visible.message)).toContain("visible reply");
    });
  });

  test("chat.history still drops assistant NO_REPLY entries before truncation", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("assistant", "NO_REPLY", { timestamp: Date.now() }),
      ]);

      const messages = await fetchHistoryMessages(ws, { maxChars: 3 });
      expect(messages).toStrictEqual([]);
    });
  });

  test("chat.history backfills visible messages when raw tail is mostly silent", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const silentTail = Array.from({ length: 24 }, (_, index) =>
        createTextTranscriptEvent("assistant", "NO_REPLY", { timestamp: Date.now() + index + 2 }),
      );
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "visible question", { timestamp: Date.now() }),
        createTextTranscriptEvent("assistant", "visible answer", { timestamp: Date.now() + 1 }),
        ...silentTail,
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 2, maxChars: 100 });
      expect(JSON.stringify(messages)).toContain("visible question");
      expect(JSON.stringify(messages)).toContain("visible answer");
      expect(JSON.stringify(messages)).not.toContain("NO_REPLY");
    });
  });

  // A silent tail longer than the bounded raw window used to project to an empty
  // first page while the branch still held visible turns, and snapshot clients
  // erase their rendered conversation when that page comes back empty.
  test.each([
    { name: "tail request", params: { limit: 2, maxChars: 100 } },
    { name: "explicit first page", params: { limit: 2, maxChars: 100, offset: 0 } },
  ])(
    "chat.history recovers visible history when the raw tail window is entirely silent ($name)",
    async ({ params }) => {
      await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
        await prepareMainHistoryHarness({ ws, createSessionDir });
        // limit 2 reads at most 2 * 20 + 20 raw records, so 80 silent records
        // push every visible turn out of the tail window.
        const silentTail = Array.from({ length: 80 }, (_, index) =>
          createTextTranscriptEvent("assistant", "NO_REPLY", {
            timestamp: Date.now() + index + 2,
          }),
        );
        await writeMainSessionTranscript([
          createTextTranscriptEvent("user", "visible question", { timestamp: Date.now() }),
          createTextTranscriptEvent("assistant", "visible answer", { timestamp: Date.now() + 1 }),
          ...silentTail,
        ]);

        const page = await rpcReq<{ messages?: unknown[]; hasMore?: boolean }>(
          ws,
          "chat.history",
          makeMainSessionParams(params),
        );
        expect(page.ok).toBe(true);
        expect(JSON.stringify(page.payload?.messages)).toContain("visible question");
        expect(JSON.stringify(page.payload?.messages)).toContain("visible answer");
        expect(JSON.stringify(page.payload?.messages)).not.toContain("NO_REPLY");
        expect(page.payload?.hasMore).toBe(false);
      });
    },
  );

  test("chat.history overreads context while scanning past a silent tail", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const sessionStartedAt = Date.now();
      await writeSessionStore({
        entries: {
          main: { sessionId: "sess-main", updatedAt: Date.now(), sessionStartedAt },
        },
      });
      // limit 2 reads a 60-record tail, and the scan then walks 100-record
      // chunks, so record 239 of 400 is the first chunk's context boundary.
      const silent = (index: number, count: number) =>
        Array.from({ length: count }, (_, offset) =>
          createTextTranscriptEvent("assistant", "NO_REPLY", {
            timestamp: sessionStartedAt + index + offset,
          }),
        );
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "oldest visible question", {
          timestamp: sessionStartedAt + 1,
        }),
        ...silent(2, 238),
        createTextTranscriptEvent("user", "stale announce", {
          timestamp: sessionStartedAt - 2_000,
          message: { provenance: { kind: "inter_session", sourceTool: "subagent_announce" } },
        }),
        createTextTranscriptEvent("assistant", "stale announce reply", {
          timestamp: sessionStartedAt - 1_000,
        }),
        ...silent(300, 159),
      ]);

      const messages = await fetchHistoryMessages(ws, { limit: 2, maxChars: 100 });
      const serialized = JSON.stringify(messages);
      expect(serialized).toContain("oldest visible question");
      expect(serialized).not.toContain("stale announce reply");
    });
  });

  test("chat.history returns retryable unavailable while a dirty projection rebuilds", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        JSON.stringify({ message: { role: "user", content: "ready after rebuild" } }),
      ]);
      const databaseOptions = {
        agentId: "main",
        path: path.join(sessionDir, "openclaw-agent.sqlite"),
      };
      const database = openOpenClawAgentDatabase(databaseOptions);
      database.db
        .prepare("UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?")
        .run("sess-main");

      const rebuilding = await rpcReq(ws, "chat.history", makeMainSessionParams({ limit: 1 }));
      expect(rebuilding.ok).toBe(false);
      expect(rebuilding.error).toMatchObject({ code: "UNAVAILABLE", retryable: true });

      await waitForSessionTranscriptIndexReconcile(databaseOptions);
      const ready = await rpcReq<{ messages?: unknown[] }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 1,
        }),
      );
      expect(ready.ok).toBe(true);
      expect(JSON.stringify(ready.payload?.messages)).toContain("ready after rebuild");
    });
  });

  test("chat.history offset pagination advances from the projected first-page boundary", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "oldest question", { timestamp: Date.now() }),
        createTextTranscriptEvent("assistant", "oldest answer", { timestamp: Date.now() + 1 }),
        createTextTranscriptEvent("user", "visible boundary", { timestamp: Date.now() + 2 }),
        createTextTranscriptEvent("assistant", "NO_REPLY", { timestamp: Date.now() + 3 }),
        createTextTranscriptEvent("assistant", "visible latest", { timestamp: Date.now() + 4 }),
      ]);

      const firstPage = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        nextOffset?: number;
        hasMore?: boolean;
        totalMessages?: number;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 2,
          offset: 0,
          maxChars: 100,
        }),
      );
      expect(firstPage.ok).toBe(true);
      expect(firstPage.payload?.messages?.map(readOpenClawSeq)).toEqual([3, 5]);
      expect(firstPage.payload?.nextOffset).toBe(3);
      expect(firstPage.payload?.hasMore).toBe(true);
      expect(firstPage.payload?.totalMessages).toBe(5);

      const secondPage = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        hasMore?: boolean;
        nextOffset?: number;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 2,
          offset: firstPage.payload?.nextOffset,
          maxChars: 100,
        }),
      );
      expect(secondPage.ok).toBe(true);
      expect(secondPage.payload?.messages?.map(readOpenClawSeq)).toEqual([1, 2]);
      expect(JSON.stringify(secondPage.payload?.messages)).not.toContain("visible boundary");
      expect(secondPage.payload?.hasMore).toBe(false);
      expect(secondPage.payload?.nextOffset).toBeUndefined();
    });
  });

  test("chat.history backfills older offset pages across a dense silent gap", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const startedAt = Date.now();
      await writeMainSessionTranscript([
        createTextTranscriptEvent("user", "older visible question", { timestamp: startedAt }),
        createTextTranscriptEvent("assistant", "older visible answer", {
          timestamp: startedAt + 1,
        }),
        ...Array.from({ length: 80 }, (_, index) =>
          createTextTranscriptEvent("assistant", "NO_REPLY", {
            timestamp: startedAt + index + 2,
          }),
        ),
        createTextTranscriptEvent("assistant", "latest visible answer", {
          timestamp: startedAt + 82,
        }),
      ]);

      type HistoryPage = {
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        nextOffset?: number;
        hasMore?: boolean;
      };
      const firstPage = await rpcReq<HistoryPage>(
        ws,
        "chat.history",
        makeMainSessionParams({ limit: 1, offset: 0, maxChars: 100 }),
      );
      expect(firstPage.ok).toBe(true);
      expect(JSON.stringify(firstPage.payload?.messages)).toContain("latest visible answer");
      expect(firstPage.payload?.nextOffset).toBe(1);

      const olderPage = await rpcReq<HistoryPage>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 2,
          offset: firstPage.payload?.nextOffset,
          maxChars: 100,
        }),
      );
      expect(olderPage.ok).toBe(true);
      expect(olderPage.payload?.messages?.map(readOpenClawSeq)).toEqual([1, 2]);
      expect(JSON.stringify(olderPage.payload?.messages)).not.toContain("NO_REPLY");
      expect(olderPage.payload?.hasMore).toBe(false);
      expect(olderPage.payload?.nextOffset).toBeUndefined();
    });
  });

  test("chat.history fills sparse pages without repeatedly projecting scanned transcript rows", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const startedAt = Date.now();
      const events = Array.from({ length: 1_500 }, (_, index) =>
        createTextTranscriptEvent(
          index % 50 === 0 ? "user" : "assistant",
          index % 50 === 0 ? `visible ${index / 50}` : "NO_REPLY",
          { timestamp: startedAt + index },
        ),
      );
      await writeMainSessionTranscript(events);

      let projectedRows = 0;
      const project = chatDisplayProjection.projectChatDisplayMessagesWithState;
      const projectionSpy = vi
        .spyOn(chatDisplayProjection, "projectChatDisplayMessagesWithState")
        .mockImplementation((messages, options) => {
          projectedRows += messages.length;
          return project(messages, options);
        });

      try {
        const page = await rpcReq<{
          messages?: Array<{ __openclaw?: { seq?: number } }>;
          nextOffset?: number;
          hasMore?: boolean;
        }>(ws, "chat.history", makeMainSessionParams({ limit: 25, offset: 0 }));
        expect(page.ok).toBe(true);
        expect(page.payload?.messages?.map(readOpenClawSeq)).toEqual(
          Array.from({ length: 25 }, (_, index) => (index + 5) * 50 + 1),
        );
        expect(page.payload).toMatchObject({ hasMore: true, nextOffset: 1_250 });
        expect(projectedRows).toBeGreaterThan(0);
        expect(projectedRows).toBeLessThanOrEqual(events.length * 2);
      } finally {
        projectionSpy.mockRestore();
      }
    });
  });

  test.each([
    {
      boundary: {
        type: "reset",
        id: "reset-boundary",
        reason: "reset",
        firstKeptEntryId: "kept-one",
      },
      expectedFirstSeqs: [3, 4, 12, 20],
      expectedOlderSeqs: [1, 2],
      marker: "Reset",
      totalMessages: 27,
    },
    {
      boundary: {
        type: "compaction",
        id: "compaction-boundary",
        summary: "summary",
        firstKeptEntryId: "old",
      },
      expectedFirstSeqs: [4, 5, 13, 21],
      expectedOlderSeqs: [1, 2, 3],
      marker: "Compaction",
      totalMessages: 28,
    },
  ])(
    "chat.history incrementally fills pages across $boundary.type boundaries",
    async ({ boundary, expectedFirstSeqs, expectedOlderSeqs, marker, totalMessages }) => {
      await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
        await prepareMainHistoryHarness({ ws, createSessionDir });
        const timestamp = Date.now();
        const events: Array<Record<string, unknown>> = [
          {
            type: "message",
            ...createTextTranscriptEvent("user", "discarded old", {
              id: "old",
              parentId: null,
              timestamp,
            }),
          },
          {
            type: "message",
            ...createTextTranscriptEvent("user", "kept one", {
              id: "kept-one",
              parentId: "old",
              timestamp: timestamp + 1,
            }),
          },
          {
            type: "message",
            ...createTextTranscriptEvent("assistant", "kept two", {
              id: "kept-two",
              parentId: "kept-one",
              timestamp: timestamp + 2,
            }),
          },
          {
            ...boundary,
            parentId: "kept-two",
            timestamp: new Date(timestamp + 3).toISOString(),
          },
        ];
        let parentId = boundary.id;
        let eventIndex = 4;
        for (const label of ["visible one", "visible two", "visible three"]) {
          const visibleId = `visible-${eventIndex}`;
          events.push({
            type: "message",
            ...createTextTranscriptEvent("user", label, {
              id: visibleId,
              parentId,
              timestamp: timestamp + eventIndex,
            }),
          });
          parentId = visibleId;
          eventIndex += 1;
          for (let hidden = 0; hidden < 7; hidden += 1) {
            const hiddenId = `hidden-${eventIndex}`;
            events.push({
              type: "message",
              ...createTextTranscriptEvent("assistant", "NO_REPLY", {
                id: hiddenId,
                parentId,
                timestamp: timestamp + eventIndex,
              }),
            });
            parentId = hiddenId;
            eventIndex += 1;
          }
        }
        await writeMainSessionTranscript(events);

        type HistoryPage = {
          messages?: Array<{ __openclaw?: { seq?: number } }>;
          nextOffset?: number;
          hasMore?: boolean;
          totalMessages?: number;
        };
        const first = await rpcReq<HistoryPage>(
          ws,
          "chat.history",
          makeMainSessionParams({ limit: 4, offset: 0 }),
        );
        expect(first.ok).toBe(true);
        expect(
          first.payload?.messages?.map(readOpenClawSeq),
          JSON.stringify(first.payload),
        ).toEqual(expectedFirstSeqs);
        expect(JSON.stringify(first.payload?.messages)).toContain(marker);
        expect(JSON.stringify(first.payload?.messages)).toContain("visible three");
        expect(first.payload).toMatchObject({
          hasMore: true,
          nextOffset: 25,
          totalMessages,
        });

        const older = await rpcReq<HistoryPage>(
          ws,
          "chat.history",
          makeMainSessionParams({ limit: 4, offset: first.payload?.nextOffset }),
        );
        expect(older.ok).toBe(true);
        expect(older.payload?.messages?.map(readOpenClawSeq)).toEqual(expectedOlderSeqs);
        expect(older.payload?.hasMore).toBe(false);
        expect(older.payload?.nextOffset).toBeUndefined();
      });
    },
  );

  test("chat.history first-page metadata pages backward without overlaps or gaps", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript(
        Array.from({ length: 7 }, (_, index) =>
          createTextTranscriptEvent(
            index % 2 === 0 ? "user" : "assistant",
            `message ${index + 1}`,
            { timestamp: Date.now() + index },
          ),
        ),
      );

      type HistoryPage = {
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        nextOffset?: number;
        hasMore?: boolean;
        totalMessages?: number;
      };
      const pages: HistoryPage[] = [];
      let offset: number | undefined;
      do {
        const page = await rpcReq<HistoryPage>(
          ws,
          "chat.history",
          makeMainSessionParams({
            limit: 2,
            ...(offset !== undefined ? { offset } : {}),
          }),
        );
        expect(page.ok).toBe(true);
        pages.push(page.payload ?? {});
        offset = page.payload?.nextOffset;
      } while (pages.at(-1)?.hasMore);

      expect(pages.map((page) => page.messages?.map(readOpenClawSeq))).toEqual([
        [6, 7],
        [4, 5],
        [2, 3],
        [1],
      ]);
      expect(pages.map((page) => page.nextOffset)).toEqual([2, 4, 6, undefined]);
      expect(pages.map((page) => page.hasMore)).toEqual([true, true, true, false]);
      expect(pages.map((page) => page.totalMessages)).toEqual([7, 7, 7, 7]);
      expect(
        pages
          .flatMap((page) => page.messages ?? [])
          .map(readOpenClawSeq)
          .toSorted((a, b) => (a ?? 0) - (b ?? 0)),
      ).toEqual([1, 2, 3, 4, 5, 6, 7]);
    });
  });

  test("chat.history pagination ignores non-message event sequence gaps", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("session store path was not initialized");
      }
      const scope = makeMainSessionScope(storePath);
      let parentId: string | null = null;
      for (let index = 1; index <= 5; index += 1) {
        const messageId = `message-${index}`;
        await appendTranscriptMessage(scope, {
          eventId: messageId,
          parentId,
          message: {
            role: index % 2 === 0 ? "assistant" : "user",
            content: [{ type: "text", text: `message ${index}` }],
            timestamp: Date.now() + index,
          },
        });
        parentId = messageId;
        if (index < 5) {
          const controlId = `control-${index}`;
          await appendTranscriptEvent(scope, { type: "custom", id: controlId, parentId });
          parentId = controlId;
        }
      }

      type HistoryPage = {
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        nextOffset?: number;
        hasMore?: boolean;
        totalMessages?: number;
      };
      const pages: HistoryPage[] = [];
      let offset: number | undefined;
      do {
        const page = await rpcReq<HistoryPage>(
          ws,
          "chat.history",
          makeMainSessionParams({
            limit: 2,
            ...(offset !== undefined ? { offset } : {}),
          }),
        );
        expect(page.ok).toBe(true);
        pages.push(page.payload ?? {});
        offset = page.payload?.nextOffset;
      } while (pages.at(-1)?.hasMore);

      expect(pages.map((page) => page.messages?.map(readOpenClawSeq))).toEqual([
        [4, 5],
        [2, 3],
        [1],
      ]);
      expect(pages.map((page) => page.nextOffset)).toEqual([2, 4, undefined]);
      expect(pages.map((page) => page.hasMore)).toEqual([true, true, false]);
      expect(pages.map((page) => page.totalMessages)).toEqual([5, 5, 5]);
    });
  });

  test("chat.history centers a bounded page around a message id", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const sessionDir = await prepareMainHistoryHarness({ ws, createSessionDir });
      await writeMainSessionTranscript([
        JSON.stringify({ type: "model_change", provider: "mock", modelId: "mock" }),
        JSON.stringify({ type: "thinking_level_change", thinkingLevel: "off" }),
      ]);
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("session store path was not initialized");
      }
      for (let index = 0; index < 7; index += 1) {
        await appendTranscriptMessage(makeMainSessionScope(storePath), {
          eventId: `message-${index + 1}`,
          message: {
            role: index % 2 === 0 ? "user" : "assistant",
            content: [{ type: "text", text: `message ${index + 1} ${"x".repeat(700)}` }],
            timestamp: Date.now() + index,
          },
        });
      }
      await waitForSessionTranscriptIndexReconcile({
        agentId: "main",
        path: path.join(sessionDir, "openclaw-agent.sqlite"),
      });

      const history = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        hasMore?: boolean;
        nextOffset?: number;
        offset?: number;
        totalMessages?: number;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 3,
          messageId: "message-3",
          sessionId: "sess-main",
          maxChars: 100,
        }),
      );

      expect(history.ok).toBe(true);
      expect(history.payload?.messages?.map(readOpenClawSeq)).toEqual([2, 3, 4]);
      expect(history.payload?.offset).toBeUndefined();
      expect(history.payload?.nextOffset).toBeUndefined();
      expect(history.payload?.hasMore).toBeUndefined();
      expect(history.payload?.totalMessages).toBeUndefined();
    });
  });

  test("chat.history reopens a search anchor from a prior session id", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const currentSessionStartedAt = Date.now();
      await writeStoredMainSession({
        updatedAt: futureFixtureUpdatedAt(),
        sessionStartedAt: currentSessionStartedAt,
      });
      const storePath = testState.sessionStorePath;
      if (!storePath) {
        throw new Error("session store path was not initialized");
      }
      const archivedScope = {
        agentId: "main",
        sessionId: "sess-before-reset",
        sessionKey: "agent:main:main",
        storePath,
      };
      await appendTranscriptMessage(archivedScope, {
        eventId: "archived-1",
        parentId: null,
        message: {
          role: "user",
          provenance: { kind: "inter_session", sourceTool: "subagent_announce" },
          content: "before anchor",
          timestamp: currentSessionStartedAt - 2_000,
        },
      });
      await appendTranscriptMessage(archivedScope, {
        eventId: "archived-2",
        parentId: "archived-1",
        message: {
          role: "assistant",
          content: "matching anchor",
          timestamp: currentSessionStartedAt - 1_000,
        },
      });
      await appendTranscriptMessage(archivedScope, {
        eventId: "archived-3",
        parentId: "archived-2",
        message: { role: "user", content: "after anchor" },
      });

      const history = await rpcReq<{
        messages?: Array<{ content?: string }>;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: 3,
          messageId: "archived-2",
          sessionId: "sess-before-reset",
        }),
      );

      expect(history.ok).toBe(true);
      expect(history.payload?.messages?.map((message) => message.content)).toEqual([
        "matching anchor",
        "after anchor",
      ]);
    });
  });

  test("chat.history rejects offset and message id together", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });

      const history = await rpcReq(
        ws,
        "chat.history",
        makeMainSessionParams({
          offset: 0,
          messageId: "message-1",
        }),
      );

      expect(history.ok).toBe(false);
      expect((history.error as { message?: string } | undefined)?.message).toContain(
        "offset and messageId cannot be used together",
      );
    });
  });

  test("chat.history rejects an anchored session id from another session key", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });

      const history = await rpcReq(
        ws,
        "chat.history",
        makeMainSessionParams({
          messageId: "message-1",
          sessionId: "unknown-session",
        }),
      );

      expect(history.ok).toBe(false);
      expect((history.error as { message?: string } | undefined)?.message).toContain(
        "sessionId does not belong to sessionKey",
      );
    });
  });

  test("chat.history offset pagination advances from the final budgeted page", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const messageCount = 70;
      await writeMainSessionTranscript(
        Array.from({ length: messageCount }, (_, index) =>
          createTextTranscriptEvent(
            index % 2 === 0 ? "user" : "assistant",
            `message ${index + 1} ${"x".repeat(100_000)}`,
            { timestamp: Date.now() + index },
          ),
        ),
      );

      const firstPage = await rpcReq<{
        messages?: Array<{ __openclaw?: { seq?: number } }>;
        nextOffset?: number;
        hasMore?: boolean;
        totalMessages?: number;
      }>(
        ws,
        "chat.history",
        makeMainSessionParams({
          limit: messageCount,
          offset: 0,
          maxChars: 100_000,
        }),
      );
      expect(firstPage.ok).toBe(true);
      const sequences = firstPage.payload?.messages?.map(readOpenClawSeq) ?? [];
      expect(sequences.length).toBeGreaterThan(0);
      expect(sequences.length).toBeLessThan(messageCount);
      const oldestSeq = expectDefined(sequences[0], "oldest returned sequence");
      expect(firstPage.payload?.nextOffset).toBe(messageCount - oldestSeq + 1);
      expect(firstPage.payload?.hasMore).toBe(true);
      expect(firstPage.payload?.totalMessages).toBe(messageCount);
    });
  });

  test("chat.history advances past a replay boundary that cannot fit all projected siblings", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      await prepareMainHistoryHarness({ ws, createSessionDir });
      const projectedSiblingCount = 70;
      const captured: DiagnosticPayloadLargeEvent[] = [];
      const unsubscribe = onDiagnosticEvent((event) => {
        if (event.type === "payload.large" && event.surface === "gateway.chat.history") {
          captured.push(event);
        }
      });
      try {
        await writeMainSessionTranscript([
          createTextTranscriptEvent("user", "reachable older message", { timestamp: Date.now() }),
          JSON.stringify({
            message: {
              role: "assistant",
              content: Array.from({ length: projectedSiblingCount }, (_, index) => ({
                type: "toolcall",
                name: "message",
                arguments: {
                  action: "send",
                  message: `projected sibling ${index + 1} ${"x".repeat(100_000)}`,
                },
              })),
              timestamp: Date.now() + 1,
            },
          }),
          JSON.stringify({
            message: {
              role: "assistant",
              toolName: "message",
              result: { ok: true },
              content: [{ type: "text", text: "NO_REPLY" }],
              timestamp: Date.now() + 2,
            },
          }),
        ]);

        type HistoryPage = {
          messages?: Array<{ __openclaw?: { seq?: number } }>;
          nextOffset?: number;
          hasMore?: boolean;
        };
        const firstPage = await rpcReq<HistoryPage>(
          ws,
          "chat.history",
          makeMainSessionParams({
            limit: projectedSiblingCount + 1,
            offset: 0,
            maxChars: 100_000,
          }),
        );
        expect(firstPage.ok).toBe(true);
        const firstPageSequences = firstPage.payload?.messages?.map(readOpenClawSeq) ?? [];
        expect(firstPageSequences.length).toBeGreaterThan(0);
        expect(firstPageSequences.every((seq) => seq === 3)).toBe(true);
        expect(firstPage.payload?.hasMore).toBe(true);
        expect(firstPage.payload?.nextOffset).toBeGreaterThan(0);
        expect(
          captured.some((event) => event.action === "truncated" && (event.count ?? 0) > 0),
        ).toBe(true);

        let offset = expectDefined(firstPage.payload?.nextOffset, "second page offset");
        const olderMessages: unknown[] = [];
        for (let pageIndex = 0; pageIndex < 3; pageIndex += 1) {
          const page = await rpcReq<HistoryPage>(
            ws,
            "chat.history",
            makeMainSessionParams({
              limit: 2,
              offset,
            }),
          );
          expect(page.ok).toBe(true);
          olderMessages.push(...(page.payload?.messages ?? []));
          const nextOffset = page.payload?.nextOffset;
          if (nextOffset === undefined) {
            expect(page.payload?.hasMore).toBe(false);
            break;
          }
          expect(nextOffset).toBeGreaterThan(offset);
          offset = nextOffset;
        }
        expect(JSON.stringify(olderMessages)).toContain("reachable older message");
      } finally {
        unsubscribe();
      }
    });
  });

  test("smoke: supports abort and idempotent completion", async () => {
    await withGatewayChatHarness(async ({ ws, createSessionDir }) => {
      const spy = gatewayReplyMock;
      let aborted = false;
      await connectOk(ws);

      await createSessionDir();
      await writeMainSessionStore();

      mockGetReplyFromConfigOnce(async (_ctx, opts) => {
        opts?.onAgentRunStart?.(opts.runId ?? "idem-abort-1");
        const signal = opts?.abortSignal;
        await new Promise<void>((resolve) => {
          if (!signal || signal.aborted) {
            aborted = Boolean(signal?.aborted);
            resolve();
            return;
          }
          signal.addEventListener(
            "abort",
            () => {
              aborted = true;
              resolve();
            },
            { once: true },
          );
        });
        return undefined;
      });

      const sendResP = onceMessage(ws, (o) => o.type === "res" && o.id === "send-abort-1", 2_000);
      sendReq(
        ws,
        "send-abort-1",
        "chat.send",
        makeChatSendParams({
          idempotencyKey: "idem-abort-1",
          timeoutMs: 30_000,
        }),
      );

      const sendRes = await sendResP;
      expect(sendRes.ok).toBe(true);
      await waitForFast(() => {
        expect(spy.mock.calls.length).toBeGreaterThan(0);
      }, FAST_WAIT_OPTS);

      const inFlight = await rpcReq<{ status?: string }>(
        ws,
        "chat.send",
        makeChatSendParams({
          idempotencyKey: "idem-abort-1",
        }),
      );
      expect(inFlight.ok).toBe(true);
      expect(["started", "in_flight", "ok"]).toContain(inFlight.payload?.status ?? "");

      const abortRes = await rpcReq<{ aborted?: boolean }>(
        ws,
        "chat.abort",
        makeMainSessionParams({
          runId: "idem-abort-1",
        }),
      );
      expect(abortRes.ok).toBe(true);
      expect(abortRes.payload?.aborted).toBe(true);
      await waitForFast(() => {
        expect(aborted).toBe(true);
      }, FAST_WAIT_OPTS);

      spy.mockClear();
      spy.mockResolvedValueOnce(undefined);

      const completeRes = await rpcReq<{ status?: string }>(
        ws,
        "chat.send",
        makeChatSendParams({
          idempotencyKey: "idem-complete-1",
        }),
      );
      expect(completeRes.ok).toBe(true);

      await waitForFast(async () => {
        const again = await rpcReq<{ status?: string }>(
          ws,
          "chat.send",
          makeChatSendParams({
            idempotencyKey: "idem-complete-1",
          }),
        );
        expect(again.ok).toBe(true);
        expect(again.payload?.status).toBe("ok");
      }, FAST_WAIT_OPTS);
    });
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
