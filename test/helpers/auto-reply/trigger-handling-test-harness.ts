import { rmSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, vi } from "vitest";
import { clearRuntimeAuthProfileStoreSnapshots } from "../../../src/agents/auth-profiles.js";
import type { EmbeddedPiQueueMessageOutcome } from "../../../src/agents/pi-embedded-runner/runs.js";
import { withFastReplyConfig } from "../../../src/auto-reply/reply/get-reply-fast-path.js";
import type { OpenClawConfig } from "../../../src/config/types.openclaw.js";

// Avoid exporting vitest mock types (TS2742 under pnpm + d.ts emit).
type AnyMock = any;
type AnyMocks = Record<string, any>;

function getSharedMocks<T>(key: string, create: () => T): T {
  const symbol = Symbol.for(key);
  const store = globalThis as Record<symbol, T | undefined>;
  if (!store[symbol]) {
    store[symbol] = create();
  }
  return store[symbol];
}

const piEmbeddedMocks = getSharedMocks("openclaw.trigger-handling.pi-embedded-mocks", () => ({
  abortEmbeddedPiRun: vi.fn().mockReturnValue(false),
  compactEmbeddedPiSession: vi.fn(),
  runEmbeddedPiAgent: vi.fn(),
  queueEmbeddedPiMessageWithOutcome: vi.fn(
    (sessionId: string, _text?: string, _options?: unknown): EmbeddedPiQueueMessageOutcome => ({
      queued: false,
      sessionId,
      reason: "not_streaming",
      gatewayHealth: "live",
    }),
  ),
  resolveActiveEmbeddedRunSessionId: vi.fn().mockReturnValue(undefined),
  isEmbeddedPiRunActive: vi.fn().mockReturnValue(false),
  isEmbeddedPiRunStreaming: vi.fn().mockReturnValue(false),
}));

export function getAbortEmbeddedPiRunMock(): AnyMock {
  return piEmbeddedMocks.abortEmbeddedPiRun;
}

export function getCompactEmbeddedPiSessionMock(): AnyMock {
  return piEmbeddedMocks.compactEmbeddedPiSession;
}

export function getRunEmbeddedPiAgentMock(): AnyMock {
  return piEmbeddedMocks.runEmbeddedPiAgent;
}

const installPiEmbeddedMock = () =>
  vi.doMock("../../../src/agents/pi-embedded.js", () => ({
    abortEmbeddedPiRun: (...args: unknown[]) => piEmbeddedMocks.abortEmbeddedPiRun(...args),
    compactEmbeddedPiSession: (...args: unknown[]) =>
      piEmbeddedMocks.compactEmbeddedPiSession(...args),
    runEmbeddedPiAgent: (...args: unknown[]) => piEmbeddedMocks.runEmbeddedPiAgent(...args),
    queueEmbeddedPiMessageWithOutcome: (sessionId: string, text: string, options?: unknown) =>
      piEmbeddedMocks.queueEmbeddedPiMessageWithOutcome(sessionId, text, options),
    resolveEmbeddedSessionLane: (key: string) => `session:${key.trim() || "main"}`,
    resolveActiveEmbeddedRunSessionId: (...args: unknown[]) =>
      piEmbeddedMocks.resolveActiveEmbeddedRunSessionId(...args),
    isEmbeddedPiRunActive: (...args: unknown[]) => piEmbeddedMocks.isEmbeddedPiRunActive(...args),
    isEmbeddedPiRunStreaming: (...args: unknown[]) =>
      piEmbeddedMocks.isEmbeddedPiRunStreaming(...args),
  }));

installPiEmbeddedMock();

vi.doMock("../../../src/agents/pi-embedded-runner/runs.js", () => ({
  abortEmbeddedPiRun: (...args: unknown[]) => piEmbeddedMocks.abortEmbeddedPiRun(...args),
  formatEmbeddedPiQueueFailureSummary: (outcome: { reason?: string; sessionId?: string }) =>
    outcome.reason && outcome.sessionId
      ? `queue_message_failed reason=${outcome.reason} sessionId=${outcome.sessionId} gatewayHealth=live`
      : undefined,
  queueEmbeddedPiMessageWithOutcome: (sessionId: string, text: string, options?: unknown) =>
    piEmbeddedMocks.queueEmbeddedPiMessageWithOutcome(sessionId, text, options),
}));

const providerUsageMocks = vi.hoisted(() => ({
  loadProviderUsageSummary: vi.fn().mockResolvedValue({
    updatedAt: 0,
    providers: [],
  }),
  formatUsageSummaryLine: vi.fn().mockReturnValue("📊 Usage: Claude 80% left"),
  formatUsageWindowSummary: vi.fn().mockReturnValue("Claude 80% left"),
  resolveUsageProviderId: vi.fn((provider: string) => provider.split("/")[0]),
}));

export function getProviderUsageMocks(): AnyMocks {
  return providerUsageMocks;
}

vi.mock("../../../src/infra/provider-usage.js", () => providerUsageMocks);

const modelCatalogMocks = getSharedMocks("openclaw.trigger-handling.model-catalog-mocks", () => ({
  loadModelCatalog: vi.fn().mockResolvedValue([
    {
      provider: "anthropic",
      id: "claude-opus-4-6",
      name: "Claude Opus 4.5",
      contextWindow: 200000,
    },
    {
      provider: "openrouter",
      id: "anthropic/claude-opus-4-6",
      name: "Claude Opus 4.5 (OpenRouter)",
      contextWindow: 200000,
    },
    { provider: "openai", id: "gpt-5.4-mini", name: "GPT-5.4 mini" },
    { provider: "openai", id: "gpt-5.5", name: "GPT-5.5" },
    { provider: "openai-codex", id: "gpt-5.5", name: "GPT-5.5 (Codex)" },
    { provider: "minimax", id: "MiniMax-M2.7", name: "MiniMax M2.7" },
  ]),
  resetModelCatalogCacheForTest: vi.fn(),
}));

const installModelCatalogMock = () =>
  vi.doMock("../../../src/agents/model-catalog.js", () => modelCatalogMocks);

installModelCatalogMock();

vi.doMock("../../../src/agents/model-catalog.runtime.js", () => ({
  loadModelCatalog: (...args: unknown[]) => modelCatalogMocks.loadModelCatalog(...args),
}));

vi.doMock("../../../src/plugins/provider-runtime.runtime.js", () => ({
  augmentModelCatalogWithProviderPlugins: async (params: { catalog?: unknown[] }) =>
    params.catalog ?? [],
  buildProviderAuthDoctorHintWithPlugin: () => undefined,
  buildProviderMissingAuthMessageWithPlugin: () => undefined,
  formatProviderAuthProfileApiKeyWithPlugin: (params: { apiKey?: string }) => params.apiKey,
  prepareProviderRuntimeAuth: async () => undefined,
  refreshProviderOAuthCredentialWithPlugin: async () => undefined,
}));

const modelFallbackMocks = getSharedMocks("openclaw.trigger-handling.model-fallback-mocks", () => ({
  runWithModelFallback: vi.fn(
    async (params: {
      provider: string;
      model: string;
      run: (provider: string, model: string, runOptions?: unknown) => Promise<unknown>;
    }) => ({
      result: await params.run(params.provider, params.model),
      provider: params.provider,
      model: params.model,
      attempts: [],
    }),
  ),
}));

const installModelFallbackMock = () =>
  vi.doMock("../../../src/agents/model-fallback.js", () => modelFallbackMocks);

installModelFallbackMock();

vi.doMock("../../../src/infra/git-commit.js", () => ({
  resolveCommitHash: vi.fn(() => "abcdef0"),
}));

const webSessionMocks = getSharedMocks("openclaw.trigger-handling.web-session-mocks", () => ({
  webAuthExists: vi.fn().mockResolvedValue(true),
  getWebAuthAgeMs: vi.fn().mockReturnValue(120_000),
  readWebSelfId: vi.fn().mockReturnValue({ e164: "+1999" }),
}));

const installWebSessionMock = () =>
  vi.doMock("../../../src/plugins/runtime/runtime-web-channel-plugin.js", () => ({
    webAuthExists: (...args: unknown[]) => webSessionMocks.webAuthExists(...args),
    getWebAuthAgeMs: (...args: unknown[]) => webSessionMocks.getWebAuthAgeMs(...args),
    readWebSelfId: (...args: unknown[]) => webSessionMocks.readWebSelfId(...args),
  }));

installWebSessionMock();

export const MAIN_SESSION_KEY = "agent:main:main";

type TempHomeEnvSnapshot = {
  home: string | undefined;
  userProfile: string | undefined;
  homeDrive: string | undefined;
  homePath: string | undefined;
  openclawHome: string | undefined;
  stateDir: string | undefined;
};

let suiteTempHomeRoot = "";
let suiteTempHomeId = 0;

function snapshotTempHomeEnv(): TempHomeEnvSnapshot {
  return {
    home: process.env.HOME,
    userProfile: process.env.USERPROFILE,
    homeDrive: process.env.HOMEDRIVE,
    homePath: process.env.HOMEPATH,
    openclawHome: process.env.OPENCLAW_HOME,
    stateDir: process.env.OPENCLAW_STATE_DIR,
  };
}

function restoreTempHomeEnv(snapshot: TempHomeEnvSnapshot): void {
  const restoreKey = (key: string, value: string | undefined) => {
    if (value === undefined) {
      delete process.env[key];
      return;
    }
    process.env[key] = value;
  };

  restoreKey("HOME", snapshot.home);
  restoreKey("USERPROFILE", snapshot.userProfile);
  restoreKey("HOMEDRIVE", snapshot.homeDrive);
  restoreKey("HOMEPATH", snapshot.homePath);
  restoreKey("OPENCLAW_HOME", snapshot.openclawHome);
  restoreKey("OPENCLAW_STATE_DIR", snapshot.stateDir);
}

function setTempHomeEnv(home: string): void {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  delete process.env.OPENCLAW_HOME;
  process.env.OPENCLAW_STATE_DIR = join(home, ".openclaw");

  if (process.platform !== "win32") {
    return;
  }
  const match = home.match(/^([A-Za-z]:)(.*)$/);
  if (!match) {
    return;
  }
  process.env.HOMEDRIVE = match[1];
  process.env.HOMEPATH = match[2] || "\\";
}

beforeAll(async () => {
  suiteTempHomeRoot = await fs.mkdtemp(join(os.tmpdir(), "openclaw-triggers-suite-"));
});

afterAll(async () => {
  if (!suiteTempHomeRoot) {
    return;
  }
  try {
    rmSync(suiteTempHomeRoot, { recursive: true, force: true });
  } catch {
    // Best-effort temp cleanup only.
  }
  suiteTempHomeRoot = "";
  suiteTempHomeId = 0;
});

export async function withTempHome<T>(fn: (home: string) => Promise<T>): Promise<T> {
  const home = join(suiteTempHomeRoot, `case-${++suiteTempHomeId}`);
  const snapshot = snapshotTempHomeEnv();
  await fs.mkdir(join(home, ".openclaw", "agents", "main", "sessions"), { recursive: true });
  setTempHomeEnv(home);

  try {
    // Hard reset shared mocks so non-isolated runs don't inherit prior behavior.
    piEmbeddedMocks.runEmbeddedPiAgent.mockReset();
    piEmbeddedMocks.abortEmbeddedPiRun.mockReset().mockReturnValue(false);
    piEmbeddedMocks.compactEmbeddedPiSession.mockReset();
    piEmbeddedMocks.queueEmbeddedPiMessageWithOutcome
      .mockReset()
      .mockImplementation((sessionId: string) => ({
        queued: false,
        sessionId,
        reason: "not_streaming",
        gatewayHealth: "live",
      }));
    piEmbeddedMocks.isEmbeddedPiRunActive.mockReset().mockReturnValue(false);
    piEmbeddedMocks.isEmbeddedPiRunStreaming.mockReset().mockReturnValue(false);
    modelFallbackMocks.runWithModelFallback.mockClear();
    return await fn(home);
  } finally {
    restoreTempHomeEnv(snapshot);
  }
}

export function makeCfg(home: string): OpenClawConfig {
  return withFastReplyConfig({
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-opus-4-6" },
        workspace: join(home, "openclaw"),
        // Test harness: avoid 1s coalescer idle sleeps that dominate trigger suites.
        blockStreamingCoalesce: { idleMs: 1 },
        // Trigger tests assert routing/authorization behavior, not delivery pacing.
        humanDelay: { mode: "off" },
      },
    },
    channels: {
      whatsapp: {
        allowFrom: ["*"],
      },
    },
    messages: {
      queue: {
        debounceMs: 0,
      },
    },
    session: { store: join(home, "sessions.json") },
  } as OpenClawConfig);
}

export async function loadGetReplyFromConfig() {
  return (await import("../../../src/auto-reply/reply.js")).getReplyFromConfig;
}

export function installTriggerHandlingReplyHarness(
  setGetReplyFromConfig: (
    getReplyFromConfig: typeof import("../../../src/auto-reply/reply.js").getReplyFromConfig,
  ) => void,
): void {
  beforeAll(async () => {
    setGetReplyFromConfig(await loadGetReplyFromConfig());
  });
  installTriggerHandlingE2eTestHooks();
}

export function requireSessionStorePath(cfg: { session?: { store?: string } }): string {
  const storePath = cfg.session?.store;
  if (!storePath) {
    throw new Error("expected session store path");
  }
  return storePath;
}

export async function expectInlineCommandHandledAndStripped(params: {
  home: string;
  getReplyFromConfig: typeof import("../../../src/auto-reply/reply.js").getReplyFromConfig;
  body: string;
  stripToken: string;
  blockReplyContains: string;
  requestOverrides?: Record<string, unknown>;
}) {
  const runEmbeddedPiAgentMock = mockRunEmbeddedPiAgentOk();
  runEmbeddedPiAgentMock.mockClear();
  const { blockReplies, handlers } = createBlockReplyCollector();
  const res = await params.getReplyFromConfig(
    {
      Body: params.body,
      From: "+1002",
      To: "+2000",
      CommandAuthorized: true,
      ...params.requestOverrides,
    },
    handlers,
    makeCfg(params.home),
  );

  const text = Array.isArray(res) ? res[0]?.text : res?.text;
  expect(blockReplies.length).toBe(1);
  expect(blockReplies[0]?.text).toContain(params.blockReplyContains);
  expect(runEmbeddedPiAgentMock).toHaveBeenCalled();
  const prompt = runEmbeddedPiAgentMock.mock.calls.at(-1)?.[0]?.prompt ?? "";
  expect(prompt).not.toContain(params.stripToken);
  expect(text).toBe("ok");
}

export async function expectBareNewOrResetAcknowledged(params: {
  home: string;
  body: "/new" | "/reset";
  getReplyFromConfig: typeof import("../../../src/auto-reply/reply.js").getReplyFromConfig;
}) {
  const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
  runEmbeddedPiAgentMock.mockClear();
  runEmbeddedPiAgentMock.mockResolvedValue({
    payloads: [{ text: "hello" }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });

  const res = await params.getReplyFromConfig(
    {
      Body: params.body,
      From: "+1003",
      To: "+2000",
      CommandAuthorized: true,
    },
    {},
    makeCfg(params.home),
  );
  const text = Array.isArray(res) ? res[0]?.text : res?.text;
  expect(text).toBe(params.body === "/reset" ? "✅ Session reset." : "✅ New session started.");
  expect(runEmbeddedPiAgentMock).not.toHaveBeenCalled();
}

export function installTriggerHandlingE2eTestHooks() {
  afterEach(() => {
    clearRuntimeAuthProfileStoreSnapshots();
    vi.clearAllMocks();
  });
}

export function mockRunEmbeddedPiAgentOk(text = "ok"): AnyMock {
  const runEmbeddedPiAgentMock = getRunEmbeddedPiAgentMock();
  runEmbeddedPiAgentMock.mockResolvedValue({
    payloads: [{ text }],
    meta: {
      durationMs: 1,
      agentMeta: { sessionId: "s", provider: "p", model: "m" },
    },
  });
  return runEmbeddedPiAgentMock;
}

export function createBlockReplyCollector() {
  const blockReplies: Array<{ text?: string }> = [];
  return {
    blockReplies,
    handlers: {
      onBlockReply: async (payload: { text?: string }) => {
        blockReplies.push(payload);
      },
    },
  };
}
