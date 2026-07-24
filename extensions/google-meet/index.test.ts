// Google Meet tests cover index plugin behavior.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createContext, Script } from "node:vm";
import {
  validateJsonSchemaValue,
  type JsonSchemaObject,
} from "openclaw/plugin-sdk/json-schema-runtime";
import {
  convertMeetingTtsAudioForBridge,
  createLocalMeetingRealtimeAudioTransport,
  createMeetingRealtimeEngineBindings,
  createNodeMeetingRealtimeAudioTransport,
  startMeetingAgentRealtimeEngine,
  startMeetingRealtimeEngine,
  type MeetingRealtimeAudioTransport,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { testing as googleMeetPluginTesting } from "./index.js";
import { findGoogleMeetCalendarEvent, listGoogleMeetCalendarEvents } from "./src/calendar.js";
import { resolveGoogleMeetConfig, type GoogleMeetConfig } from "./src/config.js";
import { normalizeMeetUrl } from "./src/meet-url.js";
import {
  buildGoogleMeetPreflightReport,
  createGoogleMeetSpace,
  fetchGoogleMeetArtifacts,
  fetchGoogleMeetAttendance,
  fetchLatestGoogleMeetConferenceRecord,
  fetchGoogleMeetSpace,
} from "./src/meet.js";
import { handleGoogleMeetNodeHostCommand } from "./src/node-host.js";
import {
  meetAudioBridge,
  meetBrowserState,
  meetRuntime,
  meetSession,
  MEET_URL,
  MEET_URL_EN,
  stubMeetArtifactsApi,
  testBridgeProcess,
} from "./src/test-support/fixtures.test-helpers.js";
import {
  getMeetTool,
  invokeGoogleMeetGatewayMethodForTest,
  noopLogger,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import * as chromeTransport from "./src/transports/chrome.js";
import { GOOGLE_MEET_PLATFORM_ADAPTER } from "./src/transports/google-meet-platform-adapter.js";
import {
  buildMeetDtmfSequence,
  normalizeDialInNumber,
  prefixDtmfWait,
} from "./src/transports/twilio.js";

type GoogleMeetManifestConfigSchema = JsonSchemaObject & {
  properties?: Record<string, JsonSchemaObject & { properties?: Record<string, unknown> }>;
};

const TEST_TALKBACK_DEBOUNCE_MS = 900;
const testTempDirs = new Set<string>();

function createIsolatedTestDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  testTempDirs.add(dir);
  return dir;
}

type MeetRealtimeAudioSpawn = NonNullable<
  Parameters<typeof createLocalMeetingRealtimeAudioTransport>[0]["spawn"]
>;

function createTestMeetRealtimeAudioTransport() {
  let inputHandler: ((audio: Buffer) => void) | undefined;
  const writeOutput = vi.fn(async () => {});
  const transport: MeetingRealtimeAudioTransport = {
    onFatal: vi.fn(),
    startInput: vi.fn((handler) => {
      inputHandler = handler;
    }),
    stop: vi.fn(async () => {}),
    writeOutput,
    clearOutput: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
  };
  return {
    transport,
    writeOutput,
    deliverInput: (audio: Buffer) => {
      if (!inputHandler) {
        throw new Error("Expected Google Meet realtime input to be started");
      }
      inputHandler(audio);
    },
  };
}

function createGoogleMeetTestEngineBindings(params: {
  config: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["config"];
  fullConfig: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["fullConfig"];
  runtime: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["runtime"];
  logger: Parameters<typeof createMeetingRealtimeEngineBindings>[0]["logger"];
}) {
  return createMeetingRealtimeEngineBindings({
    platform: GOOGLE_MEET_PLATFORM_ADAPTER,
    ...params,
  });
}

type TestLocalAgentEngineParams = Omit<
  Parameters<typeof startMeetingAgentRealtimeEngine>[0],
  "config" | "consultAgent" | "platform" | "transport"
> & {
  config: GoogleMeetConfig;
  inputCommand: string[];
  outputCommand: string[];
  spawn?: MeetRealtimeAudioSpawn;
};

async function startTestLocalAgentAudioBridge(params: TestLocalAgentEngineParams) {
  const { inputCommand, outputCommand, spawn, ...engineParams } = params;
  const transport = createLocalMeetingRealtimeAudioTransport({
    inputCommand,
    outputCommand,
    bargeInInputCommand: params.config.chrome.bargeInInputCommand,
    bargeInRmsThreshold: params.config.chrome.bargeInRmsThreshold,
    bargeInPeakThreshold: params.config.chrome.bargeInPeakThreshold,
    bargeInCooldownMs: params.config.chrome.bargeInCooldownMs,
    logger: params.logger,
    logScope: "[google-meet]",
    spawn,
  });
  return await startMeetingAgentRealtimeEngine({
    ...engineParams,
    ...createGoogleMeetTestEngineBindings(engineParams),
    transport,
  });
}

type TestLocalRealtimeEngineParams = Omit<
  Parameters<typeof startMeetingRealtimeEngine>[0],
  "config" | "consultAgent" | "handleToolCall" | "platform" | "tools" | "transport"
> & {
  config: GoogleMeetConfig;
  inputCommand: string[];
  outputCommand: string[];
  spawn?: MeetRealtimeAudioSpawn;
};

async function startTestLocalRealtimeAudioBridge(params: TestLocalRealtimeEngineParams) {
  const { inputCommand, outputCommand, spawn, ...engineParams } = params;
  const transport = createLocalMeetingRealtimeAudioTransport({
    inputCommand,
    outputCommand,
    bargeInInputCommand: params.config.chrome.bargeInInputCommand,
    bargeInRmsThreshold: params.config.chrome.bargeInRmsThreshold,
    bargeInPeakThreshold: params.config.chrome.bargeInPeakThreshold,
    bargeInCooldownMs: params.config.chrome.bargeInCooldownMs,
    logger: params.logger,
    logScope: "[google-meet]",
    spawn,
  });
  return await startMeetingRealtimeEngine({
    ...engineParams,
    ...createGoogleMeetTestEngineBindings(engineParams),
    transport,
  });
}

type TestNodeRealtimeEngineParams = Omit<
  Parameters<typeof startMeetingRealtimeEngine>[0],
  "config" | "consultAgent" | "handleToolCall" | "platform" | "tools" | "transport"
> & {
  config: GoogleMeetConfig;
  nodeId: string;
  bridgeId: string;
};

async function startTestNodeRealtimeAudioBridge(params: TestNodeRealtimeEngineParams) {
  const { nodeId, bridgeId, ...engineParams } = params;
  const transport = createNodeMeetingRealtimeAudioTransport({
    runtime: params.runtime,
    nodeId,
    bridgeId,
    logger: params.logger,
    commandName: "googlemeet.chrome",
    logScope: "[google-meet]",
    logPrefix: "node",
  });
  return {
    type: "node-command-pair" as const,
    nodeId,
    bridgeId,
    ...(await startMeetingRealtimeEngine({
      ...engineParams,
      ...createGoogleMeetTestEngineBindings(engineParams),
      logPrefix: "node",
      talkSessionId: `google-meet:${params.meetingSessionId}:${bridgeId}:node-realtime`,
      talkContext: { nodeId, bridgeId },
      transport,
    })),
  };
}

const voiceCallMocks = vi.hoisted(() => ({
  createVoiceCallGateway: vi.fn(
    ({ runtime }: { runtime: { gateway: unknown } }) => runtime.gateway,
  ),
  joinMeetViaVoiceCallGateway: vi.fn(async () => ({
    callId: "call-1",
    dtmfSent: true,
    introSent: true,
  })),
  endMeetVoiceCallGatewayCall: vi.fn(async () => {}),
  getMeetVoiceCallGatewayCall: vi.fn(
    async (): Promise<{ found: boolean; call?: { callId: string } }> => ({
      found: true,
      call: { callId: "call-1" },
    }),
  ),
  isVoiceCallMissingError: vi.fn((error: unknown) => String(error).includes("Call not found")),
  speakMeetViaVoiceCallGateway: vi.fn(async () => {}),
}));

const fetchGuardMocks = vi.hoisted(() => ({
  fetchWithSsrFGuard: vi.fn(
    async (params: {
      url: string;
      init?: RequestInit;
    }): Promise<{
      response: Response;
      release: () => Promise<void>;
    }> => ({
      response: await fetch(params.url, params.init),
      release: vi.fn(async () => {}),
    }),
  ),
}));

vi.mock("openclaw/plugin-sdk/ssrf-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/ssrf-runtime")>();
  return {
    ...actual,
    fetchWithSsrFGuard: fetchGuardMocks.fetchWithSsrFGuard,
  };
});

vi.mock("./src/voice-call-gateway.js", () => ({
  createVoiceCallGateway: voiceCallMocks.createVoiceCallGateway,
  joinMeetViaVoiceCallGateway: voiceCallMocks.joinMeetViaVoiceCallGateway,
  endMeetVoiceCallGatewayCall: voiceCallMocks.endMeetVoiceCallGatewayCall,
  getMeetVoiceCallGatewayCall: voiceCallMocks.getMeetVoiceCallGatewayCall,
  isVoiceCallMissingError: voiceCallMocks.isVoiceCallMissingError,
  speakMeetViaVoiceCallGateway: voiceCallMocks.speakMeetViaVoiceCallGateway,
}));

let localBrowserGatewayRequestHandler: NonNullable<
  Parameters<typeof setupGoogleMeetPlugin>[2]
>["gatewayRequestHandler"];

function setup(
  config?: Parameters<typeof setupGoogleMeetPlugin>[1],
  options?: Parameters<typeof setupGoogleMeetPlugin>[2],
) {
  const harness = setupGoogleMeetPlugin(plugin, config, {
    ...options,
    ...(localBrowserGatewayRequestHandler
      ? {
          gatewayAvailable: true,
          gatewayRequestHandler: localBrowserGatewayRequestHandler,
        }
      : {}),
  });
  googleMeetPluginTesting.setCallGatewayFromCliForTests(
    async (method, _opts, params) =>
      (await invokeGoogleMeetGatewayMethodForTest(harness.methods, method, params)) as Record<
        string,
        unknown
      >,
  );
  googleMeetPluginTesting.setPlatformForTests(() => options?.registerPlatform ?? "darwin");
  return harness;
}

const GOOGLE_MEET_ENV_KEYS = [
  "OPENCLAW_GOOGLE_MEET_CLIENT_ID",
  "GOOGLE_MEET_CLIENT_ID",
  "OPENCLAW_GOOGLE_MEET_CLIENT_SECRET",
  "GOOGLE_MEET_CLIENT_SECRET",
  "OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN",
  "GOOGLE_MEET_REFRESH_TOKEN",
  "OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN",
  "GOOGLE_MEET_ACCESS_TOKEN",
  "OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT",
  "GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT",
  "OPENCLAW_GOOGLE_MEET_DEFAULT_MEETING",
  "GOOGLE_MEET_DEFAULT_MEETING",
  "OPENCLAW_GOOGLE_MEET_PREVIEW_ACK",
  "GOOGLE_MEET_PREVIEW_ACK",
] as const;

function resolveGoogleMeetConfigFromTestEnv(env: Record<string, string>) {
  for (const key of GOOGLE_MEET_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  return resolveGoogleMeetConfig({});
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function requireGoogleMeetManifestConfigSchema(manifest: {
  configSchema?: GoogleMeetManifestConfigSchema;
}): GoogleMeetManifestConfigSchema {
  if (!manifest.configSchema) {
    throw new Error("Google Meet manifest did not include a config schema");
  }
  return manifest.configSchema;
}

function requireConfigProperty(
  properties: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const value = properties?.[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Expected Google Meet config schema property ${key}`);
  }
  return value as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type MockSessionEntry = {
  sessionId?: string;
  updatedAt?: number;
  [key: string]: unknown;
};

function createMockSessionRuntime(sessionStore: Record<string, unknown>) {
  const sessionRoot = createIsolatedTestDir("openclaw-google-meet-session-");
  return {
    resolveStorePath: vi.fn(() => path.join(sessionRoot, "sessions.json")),
    loadSessionStore: vi.fn(() => sessionStore),
    saveSessionStore: vi.fn(async () => {}),
    updateSessionStore: vi.fn(async (_storePath, mutator: (store: never) => unknown) =>
      mutator(sessionStore as never),
    ),
    getSessionEntry: vi.fn(
      ({ sessionKey }: { sessionKey: string }) => sessionStore[sessionKey] as MockSessionEntry,
    ),
    patchSessionEntry: vi.fn(
      async ({
        sessionKey,
        fallbackEntry,
        update,
      }: {
        sessionKey: string;
        fallbackEntry: MockSessionEntry;
        update: (entry: MockSessionEntry) => Promise<MockSessionEntry> | MockSessionEntry;
      }) => {
        const current = (sessionStore[sessionKey] as MockSessionEntry | undefined) ?? fallbackEntry;
        const patch = await update(current);
        const next = { ...current, ...patch };
        sessionStore[sessionKey] = next;
        return next;
      },
    ),
    resolveSessionFilePath: vi.fn(() => path.join(sessionRoot, "session.json")),
  };
}

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
}

function mockCall(mock: { mock: { calls: unknown[][] } }, callIndex = 0): unknown[] {
  const call = mock.mock.calls.at(callIndex);
  if (!call) {
    throw new Error(`Expected mock call at index ${callIndex}`);
  }
  return call;
}

function mockCallArg(mock: { mock: { calls: unknown[][] } }, argIndex: number, callIndex = 0) {
  return mockCall(mock, callIndex)[argIndex];
}

function expectRespondedOk(respond: { mock: { calls: unknown[][] } }): void {
  expect(mockCallArg(respond, 0)).toBe(true);
}

function requireRespondPayload(
  respond: { mock: { calls: unknown[][] } },
  label: string,
): Record<string, unknown> {
  return requireRecord(mockCallArg(respond, 1), label);
}

function requireSetupCheck(checks: unknown[] | undefined, id: string): Record<string, unknown> {
  const check = checks
    ?.map((item) => requireRecord(item, "setup check"))
    .find((item) => item.id === id);
  if (!check) {
    throw new Error(`Expected setup check ${id}`);
  }
  return check;
}

type TwilioSetupCredentials = {
  accountSid: string;
  authToken: string;
  fromNumber: string;
};

async function getTwilioVoiceCallCredentialsCheck(params: {
  env: TwilioSetupCredentials;
  configured?: Partial<TwilioSetupCredentials>;
}): Promise<Record<string, unknown>> {
  vi.stubEnv("TWILIO_ACCOUNT_SID", params.env.accountSid);
  vi.stubEnv("TWILIO_AUTH_TOKEN", params.env.authToken);
  vi.stubEnv("TWILIO_FROM_NUMBER", params.env.fromNumber);
  const { tools } = setup(
    {
      defaultTransport: "chrome-node",
      chromeNode: { node: "parallels-macos" },
    },
    {
      fullConfig: {
        plugins: {
          allow: ["google-meet", "voice-call"],
          entries: {
            "voice-call": {
              enabled: true,
              config: {
                provider: "twilio",
                publicUrl: "https://voice.example.com/voice/webhook",
                fromNumber: params.configured?.fromNumber,
                twilio: {
                  accountSid: params.configured?.accountSid,
                  authToken: params.configured?.authToken,
                },
              },
            },
          },
        },
      },
    },
  );
  const tool = getMeetTool({ tools });

  const result = await tool.execute("id", { action: "setup_status" });
  return requireSetupCheck(result.details.checks, "twilio-voice-call-credentials");
}

function requireFetchGuardCall(auditContext: string): Record<string, unknown> {
  const call = (
    fetchGuardMocks.fetchWithSsrFGuard.mock.calls as Array<[Record<string, unknown>]>
  ).find(([params]) => params.auditContext === auditContext);
  if (!call) {
    throw new Error(`Expected fetchWithSsrFGuard call for ${auditContext}`);
  }
  return call[0];
}

function requestUrl(input: RequestInfo | URL): URL {
  if (typeof input === "string") {
    return new URL(input);
  }
  if (input instanceof URL) {
    return input;
  }
  return new URL(input.url);
}

function mockLocalMeetBrowserRequest(
  browserActResult: Record<string, unknown> | (() => Record<string, unknown>) = meetBrowserState(),
) {
  const callGatewayFromCli = vi.fn(
    async (
      _method: string,
      _opts: unknown,
      params?: unknown,
      _extra?: unknown,
    ): Promise<Record<string, unknown>> => {
      const request = params as {
        path?: string;
        body?: { fn?: string; targetId?: string; url?: string };
      };
      if (request.path === "/tabs") {
        return { tabs: [] };
      }
      if (request.path === "/tabs/open") {
        return {
          targetId: "local-meet-tab",
          title: "Meet",
          url: request.body?.url ?? MEET_URL,
        };
      }
      if (request.path === "/tabs/focus") {
        return { ok: true };
      }
      if (request.path === "/navigate") {
        return {
          targetId: request.body?.targetId ?? "local-meet-tab",
          url: request.body?.url ?? MEET_URL,
        };
      }
      if (request.path === "/permissions/grant") {
        return {
          ok: true,
          origin: "https://meet.google.com",
          grantedPermissions: ["audioCapture", "videoCapture", "speakerSelection"],
          unsupportedPermissions: [],
        };
      }
      if (request.path === "/act") {
        return {
          result: JSON.stringify(
            typeof browserActResult === "function" ? browserActResult() : browserActResult,
          ),
        };
      }
      throw new Error(`unexpected browser request path ${request.path}`);
    },
  );
  localBrowserGatewayRequestHandler = async (method, params, requestOptions) =>
    await callGatewayFromCli(method, {}, params, requestOptions);
  return callGatewayFromCli;
}

function createCapturedBrowserRuntime(
  request: (params: Record<string, unknown>) => Promise<unknown>,
) {
  return {
    gateway: {
      isAvailable: async () => true,
      request: async (_method: string, params: Record<string, unknown>) => await request(params),
    },
    system: {
      runCommandWithTimeout: async () => ({ code: 0, stdout: "BlackHole 2ch", stderr: "" }),
    },
  } as never;
}

async function captureMeetStatusScript(params: {
  autoJoin: boolean;
  captionSessionId?: string;
  mode: "agent" | "transcribe";
}) {
  let script: string | undefined;
  const baseConfig = resolveGoogleMeetConfig({});
  const config = {
    ...baseConfig,
    chrome: {
      ...baseConfig.chrome,
      autoJoin: params.autoJoin,
      reuseExistingTab: false,
      waitForInCallMs: 0,
    },
  };
  const runtime = createCapturedBrowserRuntime(async (request) => {
    if (request.path === "/tabs" || request.path === "/tabs/open") {
      const tab = {
        targetId: "local-meet-tab",
        title: "Meet",
        url: MEET_URL_EN,
      };
      return request.path === "/tabs" ? { tabs: [tab] } : tab;
    }
    if (request.path === "/tabs/focus" || request.path === "/permissions/grant") {
      return { ok: true };
    }
    if (request.path === "/act") {
      script = requireRecord(request.body, "Meet status request body").fn as string;
      return {
        result: JSON.stringify({
          manualActionRequired: true,
          manualActionReason: "meet-admission-required",
        }),
      };
    }
    throw new Error(`unexpected browser request path ${String(request.path)}`);
  });
  if (params.mode === "agent") {
    await chromeTransport.recoverCurrentMeetTab({
      runtime,
      config,
      mode: "agent",
      readOnly: false,
      url: MEET_URL,
    });
  } else {
    await chromeTransport.launchChromeMeet({
      runtime,
      config,
      fullConfig: {},
      meetingSessionId: params.captionSessionId ?? "session-1",
      mode: params.mode,
      url: MEET_URL,
      logger: noopLogger,
    });
  }
  if (!script) {
    throw new Error("Google Meet status script was not sent through browser control");
  }
  return script;
}

async function captureMeetTranscriptScript(sessionId: string, finalize: boolean) {
  let script: string | undefined;
  const config = resolveGoogleMeetConfig({});
  await chromeTransport.readChromeMeetTranscript({
    runtime: createCapturedBrowserRuntime(async (request) => {
      script = requireRecord(request.body, "Meet transcript request body").fn as string;
      return {
        result: JSON.stringify({
          droppedLines: 0,
          lines: [],
          sessionMatched: true,
          urlMatched: true,
        }),
      };
    }),
    config,
    finalize,
    meetingUrl: MEET_URL,
    meetingSessionId: sessionId,
    tab: { targetId: "local-meet-tab", openedByPlugin: true },
  });
  if (!script) {
    throw new Error("Google Meet transcript script was not sent through browser control");
  }
  return script;
}

async function captureMeetLeaveScript() {
  let script: string | undefined;
  const config = resolveGoogleMeetConfig({});
  await chromeTransport.leaveChromeMeet({
    runtime: createCapturedBrowserRuntime(async (request) => {
      if (request.path === "/tabs") {
        return {
          tabs: [
            {
              targetId: "local-meet-tab",
              title: "Meet",
              url: MEET_URL_EN,
            },
          ],
        };
      }
      if (request.path === "/act") {
        script = requireRecord(request.body, "Meet leave request body").fn as string;
        return { result: JSON.stringify({ departed: true, urlMatched: true }) };
      }
      throw new Error(`unexpected browser request path ${String(request.path)}`);
    }),
    config,
    meetingSessionId: "session-1",
    meetingUrl: MEET_URL,
    tab: { targetId: "local-meet-tab", openedByPlugin: false },
  });
  if (!script) {
    throw new Error("Google Meet leave script was not sent through browser control");
  }
  return script;
}

describe("google-meet plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    voiceCallMocks.joinMeetViaVoiceCallGateway.mockResolvedValue({
      callId: "call-1",
      dtmfSent: true,
      introSent: true,
    });
    voiceCallMocks.endMeetVoiceCallGatewayCall.mockResolvedValue(undefined);
    voiceCallMocks.getMeetVoiceCallGatewayCall.mockResolvedValue({
      found: true,
      call: { callId: "call-1" },
    });
    voiceCallMocks.isVoiceCallMissingError.mockImplementation((error: unknown) =>
      String(error).includes("Call not found"),
    );
    voiceCallMocks.speakMeetViaVoiceCallGateway.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    localBrowserGatewayRequestHandler = undefined;
    googleMeetPluginTesting.setCallGatewayFromCliForTests();
    googleMeetPluginTesting.setPlatformForTests();
    for (const dir of testTempDirs) {
      rmSync(dir, { force: true, recursive: true });
    }
    testTempDirs.clear();
  });

  afterAll(() => {
    vi.doUnmock("openclaw/plugin-sdk/ssrf-runtime");
    vi.doUnmock("./src/voice-call-gateway.js");
    vi.resetModules();
  });

  it("defaults to chrome agent mode with safe read-only tools", () => {
    const config = resolveGoogleMeetConfig({});

    expect(config.enabled).toBe(true);
    expect(config.defaults).toEqual({});
    expect(config.preview).toEqual({ enrollmentAcknowledged: false });
    expect(config.defaultTransport).toBe("chrome");
    expect(config.defaultMode).toBe("agent");
    expect(config.chrome).toEqual({
      audioBackend: "blackhole-2ch",
      launch: true,
      guestName: "OpenClaw Agent",
      reuseExistingTab: true,
      autoJoin: true,
      joinTimeoutMs: 30000,
      waitForInCallMs: 20000,
      audioFormat: "pcm16-24khz",
      audioBufferBytes: 4096,
      audioInputCommand: [
        "sox",
        "-q",
        "--buffer",
        "4096",
        "-t",
        "coreaudio",
        "BlackHole 2ch",
        "-t",
        "raw",
        "-r",
        "24000",
        "-c",
        "1",
        "-e",
        "signed-integer",
        "-b",
        "16",
        "-L",
        "-",
      ],
      audioOutputCommand: [
        "sox",
        "-q",
        "--buffer",
        "4096",
        "-t",
        "raw",
        "-r",
        "24000",
        "-c",
        "1",
        "-e",
        "signed-integer",
        "-b",
        "16",
        "-L",
        "-",
        "-t",
        "coreaudio",
        "BlackHole 2ch",
      ],
      bargeInRmsThreshold: 650,
      bargeInPeakThreshold: 2500,
      bargeInCooldownMs: 900,
    });
    expect(config.chromeNode).toEqual({});
    expect(config.twilio).toEqual({});
    expect(config.voiceCall).toEqual({
      enabled: true,
      requestTimeoutMs: 30000,
      dtmfDelayMs: 12000,
      postDtmfSpeechDelayMs: 5000,
    });
    expect(config.realtime.strategy).toBe("agent");
    expect(config.realtime.provider).toBe("openai");
    expect(config.realtime.transcriptionProvider).toBe("openai");
    expect(config.realtime.introMessage).toBe("Say exactly: I'm here and listening.");
    expect(config.realtime.toolPolicy).toBe("safe-read-only");
    expect(config.realtime.providers).toEqual({});
    expect(config.realtime.instructions).toContain("openclaw_agent_consult");
    expect(config.oauth).toEqual({});
    expect(config.auth).toEqual({ provider: "google-oauth" });

    expect(resolveGoogleMeetConfig({ defaultMode: "realtime" }).defaultMode).toBe("agent");
  });

  it("resolves separate realtime providers for agent transcription and bidi voice", () => {
    const realtime = resolveGoogleMeetConfig({
      realtime: {
        provider: "openai",
        transcriptionProvider: "openai",
        voiceProvider: "google",
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
      },
    });
    expect(realtime.realtime.provider).toBe("openai");
    expect(realtime.realtime.transcriptionProvider).toBe("openai");
    expect(realtime.realtime.voiceProvider).toBe("google");
    expect(realtime.realtime.model).toBe("gemini-2.5-flash-native-audio-preview-12-2025");
  });

  it("keeps realtime.provider as the transcription compatibility fallback", () => {
    const custom = resolveGoogleMeetConfig({
      realtime: {
        provider: "custom-stt",
      },
    });
    expect(custom.realtime.provider).toBe("custom-stt");
    expect(custom.realtime.transcriptionProvider).toBe("custom-stt");

    const google = resolveGoogleMeetConfig({
      realtime: {
        provider: "google",
      },
    });
    expect(google.realtime.provider).toBe("google");
    expect(google.realtime.transcriptionProvider).toBe("openai");
  });

  it("uses voiceProvider for bidi and transcriptionProvider for agent mode resolution", async () => {
    let voiceRequest: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const voiceBridge = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      sendUserMessage: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const voiceProviders: RealtimeVoiceProviderPlugin[] = [
      {
        id: "openai",
        label: "OpenAI",
        autoSelectOrder: 1,
        isConfigured: () => true,
        createBridge: () => {
          throw new Error("unused");
        },
      },
      {
        id: "google",
        label: "Google",
        autoSelectOrder: 2,
        resolveConfig: ({ rawConfig }) => rawConfig,
        isConfigured: () => true,
        createBridge: (request) => {
          voiceRequest = request;
          return voiceBridge;
        },
      },
    ];
    let transcriptionRequest:
      | Parameters<RealtimeTranscriptionProviderPlugin["createSession"]>[0]
      | undefined;
    const transcriptionSession = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const transcriptionProviders: RealtimeTranscriptionProviderPlugin[] = [
      {
        id: "openai",
        label: "OpenAI",
        autoSelectOrder: 1,
        isConfigured: () => true,
        createSession: (request) => {
          transcriptionRequest = request;
          return transcriptionSession;
        },
      },
    ];
    const config = resolveGoogleMeetConfig({
      realtime: {
        provider: "openai",
        transcriptionProvider: "openai",
        voiceProvider: "google",
        model: "gemini-2.5-flash-native-audio-preview-12-2025",
      },
    });

    const voiceTransport = createTestMeetRealtimeAudioTransport();
    const voiceHandle = await startMeetingRealtimeEngine({
      config,
      fullConfig: {} as never,
      runtime: {} as never,
      ...createGoogleMeetTestEngineBindings({
        config,
        fullConfig: {} as never,
        runtime: {} as never,
        logger: noopLogger,
      }),
      meetingSessionId: "provider-resolution-voice",
      logger: noopLogger,
      providers: voiceProviders,
      transport: voiceTransport.transport,
    });
    expect(voiceHandle.providerId).toBe("google");
    expect(voiceRequest?.providerConfig).toEqual({
      model: "gemini-2.5-flash-native-audio-preview-12-2025",
    });
    await voiceHandle.stop();

    const transcriptionTransport = createTestMeetRealtimeAudioTransport();
    const transcriptionHandle = await startMeetingAgentRealtimeEngine({
      config,
      fullConfig: {} as never,
      runtime: {} as never,
      ...createGoogleMeetTestEngineBindings({
        config,
        fullConfig: {} as never,
        runtime: {} as never,
        logger: noopLogger,
      }),
      meetingSessionId: "provider-resolution-transcription",
      logger: noopLogger,
      providers: transcriptionProviders,
      transport: transcriptionTransport.transport,
    });
    expect(transcriptionHandle.providerId).toBe("openai");
    expect(transcriptionRequest).toBeDefined();
    await transcriptionHandle.stop();
  });

  it("declares advanced config metadata in the plugin entry and manifest", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as {
      uiHints?: Record<string, unknown>;
      configSchema?: GoogleMeetManifestConfigSchema;
    };
    const configSchema = requireGoogleMeetManifestConfigSchema(manifest);
    const entry = plugin as unknown as {
      configSchema: {
        uiHints?: Record<string, unknown>;
      };
    };

    for (const key of [
      "chrome.audioBufferBytes",
      "chrome.bargeInInputCommand",
      "chrome.bargeInRmsThreshold",
      "chrome.bargeInPeakThreshold",
      "chrome.bargeInCooldownMs",
      "voiceCall.dtmfDelayMs",
      "voiceCall.postDtmfSpeechDelayMs",
    ]) {
      expect(entry.configSchema.uiHints?.[key]).toHaveProperty("advanced", true);
      expect(manifest.uiHints?.[key]).toHaveProperty("advanced", true);
    }
    const chromeProperties = configSchema.properties?.chrome?.properties;
    expect(requireConfigProperty(chromeProperties, "audioBufferBytes")).toEqual({
      type: "number",
      default: 4096,
    });
    expect(requireConfigProperty(chromeProperties, "bargeInInputCommand")).toEqual({
      type: "array",
      items: { type: "string" },
    });
    expect(requireConfigProperty(chromeProperties, "bargeInRmsThreshold")).toEqual({
      type: "number",
      default: 650,
    });
    expect(requireConfigProperty(chromeProperties, "bargeInPeakThreshold")).toEqual({
      type: "number",
      default: 2500,
    });
    expect(requireConfigProperty(chromeProperties, "bargeInCooldownMs")).toEqual({
      type: "number",
      default: 900,
    });
    const defaultConfig = resolveGoogleMeetConfig({});
    expect(defaultConfig.voiceCall.dtmfDelayMs).toBe(12000);
    expect(
      requireConfigProperty(configSchema.properties?.voiceCall?.properties, "dtmfDelayMs"),
    ).toEqual({
      type: "number",
      default: defaultConfig.voiceCall.dtmfDelayMs,
    });
    expect(
      requireConfigProperty(
        configSchema.properties?.voiceCall?.properties,
        "postDtmfSpeechDelayMs",
      ),
    ).toEqual({
      type: "number",
      default: 5000,
    });
    const result = validateJsonSchemaValue({
      schema: configSchema,
      cacheKey: "google-meet.manifest.voice-call-post-dtmf-speech-delay",
      value: {
        voiceCall: {
          postDtmfSpeechDelayMs: 750,
        },
      },
    });
    expect(result.ok).toBe(true);
  });

  it("resolves the realtime consult agent id", () => {
    expect(
      resolveGoogleMeetConfig({
        realtime: {
          agentId: " jay ",
        },
      }).realtime.agentId,
    ).toBe("jay");
  });

  it("preserves an empty realtime intro message for silent joins", () => {
    expect(
      resolveGoogleMeetConfig({
        realtime: {
          introMessage: "",
        },
      }).realtime.introMessage,
    ).toBe("");
  });

  it("keeps legacy command-pair audio format when custom commands omit a format", () => {
    const config = resolveGoogleMeetConfig({
      chrome: {
        audioInputCommand: ["capture-legacy"],
        audioOutputCommand: ["play-legacy"],
      },
    });
    expect(config.chrome.audioFormat).toBe("g711-ulaw-8khz");
    expect(config.chrome.audioInputCommand).toEqual(["capture-legacy"]);
    expect(config.chrome.audioOutputCommand).toEqual(["play-legacy"]);
  });

  it("lets generated Chrome audio commands use a configured SoX buffer", () => {
    const config = resolveGoogleMeetConfig({ chrome: { audioBufferBytes: 2048 } });

    expect(config.chrome.audioBufferBytes).toBe(2048);
    expect(config.chrome.audioInputCommand).toEqual([
      "sox",
      "-q",
      "--buffer",
      "2048",
      "-t",
      "coreaudio",
      "BlackHole 2ch",
      "-t",
      "raw",
      "-r",
      "24000",
      "-c",
      "1",
      "-e",
      "signed-integer",
      "-b",
      "16",
      "-L",
      "-",
    ]);
    expect(config.chrome.audioOutputCommand?.slice(0, 4)).toEqual([
      "sox",
      "-q",
      "--buffer",
      "2048",
    ]);
  });

  it("clamps configured Chrome audio buffers above SoX's minimum", () => {
    const config = resolveGoogleMeetConfig({ chrome: { audioBufferBytes: 1 } });

    expect(config.chrome.audioBufferBytes).toBe(17);
    expect(config.chrome.audioInputCommand?.slice(0, 4)).toEqual(["sox", "-q", "--buffer", "17"]);
    expect(config.chrome.audioOutputCommand?.slice(0, 4)).toEqual(["sox", "-q", "--buffer", "17"]);
  });

  it("uses env fallbacks for OAuth, preview, and default meeting values", () => {
    const config = resolveGoogleMeetConfigFromTestEnv({
      OPENCLAW_GOOGLE_MEET_CLIENT_ID: "client-id",
      GOOGLE_MEET_CLIENT_SECRET: "client-secret",
      OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN: "refresh-token",
      GOOGLE_MEET_ACCESS_TOKEN: "access-token",
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT: "123456",
      GOOGLE_MEET_DEFAULT_MEETING: MEET_URL,
      OPENCLAW_GOOGLE_MEET_PREVIEW_ACK: "true",
    });
    expect(config.defaults).toEqual({ meeting: MEET_URL });
    expect(config.preview).toEqual({ enrollmentAcknowledged: true });
    expect(config.oauth).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      expiresAt: 123456,
    });
  });

  it.each(["0x10", "1e3"])("ignores non-decimal env numeric fallbacks: %s", (expiresAt) => {
    const config = resolveGoogleMeetConfigFromTestEnv({
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN: "access-token",
      OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT: expiresAt,
    });

    expect(config.oauth).toEqual({ accessToken: "access-token" });
  });

  it("requires explicit Meet URLs", () => {
    expect(normalizeMeetUrl(MEET_URL)).toBe(MEET_URL);
    expect(() => normalizeMeetUrl("https://example.com/abc-defg-hij")).toThrow("meet.google.com");
    expect(() => normalizeMeetUrl("https://user@meet.google.com/abc-defg-hij")).toThrow(
      "meet.google.com",
    );
    expect(() => normalizeMeetUrl("https://meet.google.com:444/abc-defg-hij")).toThrow(
      "meet.google.com",
    );
  });

  it("advertises only the googlemeet CLI descriptor", () => {
    const { cliRegistrations } = setup();

    expect(cliRegistrations).toEqual([
      {
        commands: ["googlemeet"],
        descriptors: [
          {
            name: "googlemeet",
            description: "Join and manage Google Meet calls",
            hasSubcommands: true,
          },
        ],
      },
    ]);
  });

  it("registers the node-host command used by chrome-node transport", () => {
    const { nodeHostCommands, nodeInvokePolicies } = setup();

    const command = nodeHostCommands.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.command === "googlemeet.chrome",
    );
    if (!command) {
      throw new Error("expected googlemeet.chrome node host command");
    }
    expect(command.cap).toBe("google-meet");
    expect(command.dangerous).toBe(true);
    expect(typeof command.handle).toBe("function");
    expect(nodeInvokePolicies).toHaveLength(1);
    expect(nodeInvokePolicies[0]).toMatchObject({
      commands: ["googlemeet.chrome"],
      dangerous: true,
    });
  });

  it("keeps the agent tool visible on non-macOS hosts but blocks local Chrome talk-back joins", async () => {
    const { cliRegistrations, methods, tools } = setup(undefined, { registerPlatform: "linux" });
    const tool = getMeetTool({ tools });

    expect(tools).toHaveLength(1);
    expect(cliRegistrations).toHaveLength(1);
    expect(methods.has("googlemeet.setup")).toBe(true);
    expect(
      googleMeetPluginTesting.isGoogleMeetAgentToolActionUnsupportedOnHost({
        config: resolveGoogleMeetConfig({}),
        raw: { action: "join" },
        platform: "linux",
      }),
    ).toBe(true);

    const blocked = await tool.execute("id", { action: "join" });
    expect(JSON.stringify(blocked)).toContain("local Chrome talk-back audio is macOS-only");

    expect(
      googleMeetPluginTesting.isGoogleMeetAgentToolActionUnsupportedOnHost({
        config: resolveGoogleMeetConfig({}),
        raw: { action: "join", mode: "transcribe" },
        platform: "linux",
      }),
    ).toBe(false);
    expect(
      googleMeetPluginTesting.isGoogleMeetAgentToolActionUnsupportedOnHost({
        config: resolveGoogleMeetConfig({}),
        raw: { action: "join", transport: "chrome-node" },
        platform: "linux",
      }),
    ).toBe(false);
  });

  it("returns structured gateway errors for missing session ids", async () => {
    const { methods } = setup();
    for (const method of ["googlemeet.leave", "googlemeet.speak"]) {
      const handler = methods.get(method) as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({ params: {}, respond });

      expect(respond).toHaveBeenCalledWith(
        false,
        { error: "sessionId required" },
        {
          code: "INVALID_REQUEST",
          message: "sessionId required",
          details: { error: "sessionId required" },
        },
      );
    }
  });

  it("uses a provider-safe flat tool parameter schema", () => {
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    expect(tool.description).toContain("recover_current_tab");
    expect(JSON.stringify(tool.parameters)).not.toContain("anyOf");
    const parameters = requireRecord(tool.parameters, "Google Meet tool parameters");
    expect(parameters.type).toBe("object");
    const properties = requireRecord(
      parameters.properties,
      "Google Meet tool parameter properties",
    );
    const action = requireRecord(properties.action, "Google Meet action parameter");
    expect(action.type).toBe("string");
    expect(action.enum).toEqual([
      "join",
      "create",
      "status",
      "transcript",
      "setup_status",
      "resolve_space",
      "preflight",
      "latest",
      "calendar_events",
      "artifacts",
      "attendance",
      "export",
      "recover_current_tab",
      "leave",
      "end_active_conference",
      "speak",
      "test_speech",
      "test_listen",
    ]);
    expect(action.description).toContain("recover_current_tab");
    expect(properties.transport).toEqual({
      type: "string",
      enum: ["chrome", "chrome-node", "twilio"],
      description: "Join transport",
    });
    expect(properties.mode).toEqual({
      type: "string",
      enum: ["agent", "bidi", "transcribe"],
      description:
        "Join mode. agent uses realtime transcription, the configured OpenClaw agent, and regular TTS. bidi uses the realtime voice model directly. transcribe joins observe-only.",
    });
  });

  it("normalizes Meet URLs, codes, and space names for the Meet API", async () => {
    stubMeetArtifactsApi();
    await expect(
      fetchGoogleMeetSpace({ accessToken: "token", meeting: "spaces/abc-defg-hij" }),
    ).resolves.toMatchObject({ name: "spaces/abc-defg-hij" });
    await expect(
      fetchGoogleMeetSpace({ accessToken: "token", meeting: "abc-defg-hij" }),
    ).resolves.toMatchObject({ name: "spaces/abc-defg-hij" });
    await expect(
      fetchGoogleMeetSpace({
        accessToken: "token",
        meeting: MEET_URL,
      }),
    ).resolves.toMatchObject({ name: "spaces/abc-defg-hij" });
    await expect(
      fetchGoogleMeetSpace({
        accessToken: "token",
        meeting: "https://example.com/abc-defg-hij",
      }),
    ).rejects.toThrow("meet.google.com");
  });

  it("finds Google Meet links from Calendar events", async () => {
    const fetchMock = stubMeetArtifactsApi();

    const event = await findGoogleMeetCalendarEvent({
      accessToken: "token",
      now: new Date("2026-04-25T09:50:00Z"),
      timeMin: "2026-04-25T00:00:00Z",
      timeMax: "2026-04-26T00:00:00Z",
    });
    expect(event.calendarId).toBe("primary");
    expect(event.meetingUri).toBe(MEET_URL);
    expect(event.event.summary).toBe("Project sync");

    const calendarEvents = await listGoogleMeetCalendarEvents({
      accessToken: "token",
      now: new Date("2026-04-25T09:50:00Z"),
      timeMin: "2026-04-25T00:00:00Z",
      timeMax: "2026-04-26T00:00:00Z",
    });
    expect(calendarEvents.calendarId).toBe("primary");
    expect(calendarEvents.events).toHaveLength(1);
    expect(calendarEvents.events[0]?.meetingUri).toBe(MEET_URL);
    expect(calendarEvents.events[0]?.selected).toBe(true);
    expect(calendarEvents.events[0]?.event.summary).toBe("Project sync");
    const calendarCall = fetchMock.mock.calls.find(([input]) => {
      const url = requestUrl(input);
      return url.pathname === "/calendar/v3/calendars/primary/events";
    });
    if (!calendarCall) {
      throw new Error("Expected Calendar events.list fetch call");
    }
    const url = requestUrl(calendarCall[0]);
    expect(url.searchParams.get("singleEvents")).toBe("true");
    expect(url.searchParams.get("orderBy")).toBe("startTime");
    const guardCall = requireFetchGuardCall("google-meet.calendar.events.list");
    expect(guardCall.policy).toEqual({ allowedHostnames: ["www.googleapis.com"] });
  });

  it("adds a reauth hint for missing Calendar scopes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("insufficientPermissions", { status: 403 })),
    );

    await expect(
      findGoogleMeetCalendarEvent({
        accessToken: "token",
        timeMin: "2026-04-25T00:00:00Z",
        timeMax: "2026-04-26T00:00:00Z",
      }),
    ).rejects.toThrow("calendar.events.readonly");
    await expect(
      findGoogleMeetCalendarEvent({
        accessToken: "token",
        timeMin: "2026-04-25T00:00:00Z",
        timeMax: "2026-04-26T00:00:00Z",
      }),
    ).rejects.toThrow("googlemeet auth login");
  });

  it("fetches Meet spaces without percent-encoding the spaces path separator", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          name: "spaces/abc-defg-hij",
          meetingCode: "abc-defg-hij",
          meetingUri: MEET_URL,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const space = await fetchGoogleMeetSpace({
      accessToken: "token",
      meeting: "spaces/abc-defg-hij",
    });
    expect(space.name).toBe("spaces/abc-defg-hij");
    expect(space.meetingCode).toBe("abc-defg-hij");
    expect(space.meetingUri).toBe(MEET_URL);
    const guardCall = requireFetchGuardCall("google-meet.spaces.get");
    expect(guardCall.url).toBe("https://meet.googleapis.com/v2/spaces/abc-defg-hij");
    expect(requireRecord(guardCall.init, "spaces.get init").headers).toEqual({
      Authorization: "Bearer token",
      Accept: "application/json",
    });
    expect(guardCall.policy).toEqual({ allowedHostnames: ["meet.googleapis.com"] });
    expect(fetchMock).toHaveBeenCalledWith("https://meet.googleapis.com/v2/spaces/abc-defg-hij", {
      headers: {
        Authorization: "Bearer token",
        Accept: "application/json",
      },
    });
  });

  it("creates Meet spaces and returns the meeting URL", async () => {
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          name: "spaces/new-space",
          meetingCode: "new-abcd-xyz",
          meetingUri: "https://meet.google.com/new-abcd-xyz",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await createGoogleMeetSpace({ accessToken: "token" });
    expect(result.meetingUri).toBe("https://meet.google.com/new-abcd-xyz");
    expect(result.space.name).toBe("spaces/new-space");
    expect(result.space.meetingCode).toBe("new-abcd-xyz");
    expect(result.space.meetingUri).toBe("https://meet.google.com/new-abcd-xyz");
    const guardCall = requireFetchGuardCall("google-meet.spaces.create");
    expect(guardCall.url).toBe("https://meet.googleapis.com/v2/spaces");
    expect(guardCall.init).toEqual({
      method: "POST",
      headers: {
        Authorization: "Bearer token",
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: "{}",
    });
    expect(guardCall.policy).toEqual({ allowedHostnames: ["meet.googleapis.com"] });
  });

  it("lists Meet artifact metadata for the latest conference record by default", async () => {
    const fetchMock = stubMeetArtifactsApi();

    const result = await fetchGoogleMeetArtifacts({
      accessToken: "token",
      meeting: "abc-defg-hij",
      pageSize: 2,
    });
    expect(result.input).toBe("abc-defg-hij");
    expect(result.space?.name).toBe("spaces/abc-defg-hij");
    expect(result.conferenceRecords.map((record) => record.name)).toEqual([
      "conferenceRecords/rec-1",
    ]);
    expect(result.artifacts).toHaveLength(1);
    const artifact = result.artifacts[0];
    expect(artifact?.conferenceRecord.name).toBe("conferenceRecords/rec-1");
    expect(artifact?.participants.map((participant) => participant.name)).toEqual([
      "conferenceRecords/rec-1/participants/p1",
    ]);
    expect(artifact?.recordings.map((recording) => recording.name)).toEqual([
      "conferenceRecords/rec-1/recordings/r1",
    ]);
    expect(artifact?.transcripts.map((transcript) => transcript.name)).toEqual([
      "conferenceRecords/rec-1/transcripts/t1",
    ]);
    expect(artifact?.transcriptEntries).toHaveLength(1);
    expect(artifact?.transcriptEntries[0]?.transcript).toBe(
      "conferenceRecords/rec-1/transcripts/t1",
    );
    expect(artifact?.transcriptEntries[0]?.entries).toEqual([
      {
        name: "conferenceRecords/rec-1/transcripts/t1/entries/e1",
        participant: "conferenceRecords/rec-1/participants/p1",
        text: "Hello from the transcript.",
        languageCode: "en-US",
        startTime: "2026-04-25T10:01:00Z",
        endTime: "2026-04-25T10:01:05Z",
      },
    ]);
    expect(artifact?.smartNotes.map((smartNote) => smartNote.name)).toEqual([
      "conferenceRecords/rec-1/smartNotes/sn1",
    ]);

    const listCall = fetchMock.mock.calls.find(([input]) => {
      const url = requestUrl(input);
      return url.pathname === "/v2/conferenceRecords";
    });
    if (!listCall) {
      throw new Error("Expected conferenceRecords.list fetch call");
    }
    const listUrl = requestUrl(listCall[0]);
    expect(listUrl.searchParams.get("filter")).toBe('space.name = "spaces/abc-defg-hij"');
    expect(listUrl.searchParams.get("pageSize")).toBe("1");
    expect(requireFetchGuardCall("google-meet.conferenceRecords.smartNotes.list").url).toBe(
      "https://meet.googleapis.com/v2/conferenceRecords/rec-1/smartNotes?pageSize=2",
    );
    expect(
      requireFetchGuardCall("google-meet.conferenceRecords.transcripts.entries.list").url,
    ).toBe(
      "https://meet.googleapis.com/v2/conferenceRecords/rec-1/transcripts/t1/entries?pageSize=2",
    );
  });

  it("keeps all conference records available when requested", async () => {
    const fetchMock = stubMeetArtifactsApi();

    await fetchGoogleMeetArtifacts({
      accessToken: "token",
      meeting: "abc-defg-hij",
      pageSize: 2,
      allConferenceRecords: true,
    });

    const listCall = fetchMock.mock.calls.find(([input]) => {
      const url = requestUrl(input);
      return url.pathname === "/v2/conferenceRecords";
    });
    if (!listCall) {
      throw new Error("Expected conferenceRecords.list fetch call");
    }
    const listUrl = requestUrl(listCall[0]);
    expect(listUrl.searchParams.get("pageSize")).toBe("2");
    expect(listUrl.searchParams.get("filter")).toBe('space.name = "spaces/abc-defg-hij"');
  });

  it("exports linked Google Docs bodies when requested", async () => {
    const fetchMock = stubMeetArtifactsApi();

    const result = await fetchGoogleMeetArtifacts({
      accessToken: "token",
      conferenceRecord: "rec-1",
      includeDocumentBodies: true,
    });
    expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]?.transcripts.map((transcript) => transcript.documentText)).toEqual([
      "Transcript document body.",
    ]);
    expect(result.artifacts[0]?.smartNotes.map((smartNote) => smartNote.documentText)).toEqual([
      "Smart note document body.",
    ]);
    const driveCalls = fetchMock.mock.calls
      .map(([input]) => requestUrl(input))
      .filter((url) => url.pathname.startsWith("/drive/v3/files/"));
    expect(driveCalls.map((url) => url.pathname)).toEqual([
      "/drive/v3/files/doc-1/export",
      "/drive/v3/files/doc-2/export",
    ]);
    expect(driveCalls.map((url) => url.searchParams.get("mimeType"))).toEqual([
      "text/plain",
      "text/plain",
    ]);
  });

  it("fetches only the latest Meet conference record for a meeting", async () => {
    const fetchMock = stubMeetArtifactsApi();

    const result = await fetchLatestGoogleMeetConferenceRecord({
      accessToken: "token",
      meeting: "abc-defg-hij",
    });
    expect(result.input).toBe("abc-defg-hij");
    expect(result.space.name).toBe("spaces/abc-defg-hij");
    expect(result.conferenceRecord?.name).toBe("conferenceRecords/rec-1");

    const listCall = fetchMock.mock.calls.find(([input]) => {
      const url = requestUrl(input);
      return url.pathname === "/v2/conferenceRecords";
    });
    if (!listCall) {
      throw new Error("Expected conferenceRecords.list fetch call");
    }
    const listUrl = requestUrl(listCall[0]);
    expect(listUrl.searchParams.get("pageSize")).toBe("1");
    expect(listUrl.searchParams.get("filter")).toBe('space.name = "spaces/abc-defg-hij"');
  });

  it("lists Meet attendance rows with participant sessions", async () => {
    const fetchMock = stubMeetArtifactsApi();

    const result = await fetchGoogleMeetAttendance({
      accessToken: "token",
      conferenceRecord: "rec-1",
      pageSize: 3,
    });
    expect(result.input).toBe("rec-1");
    expect(result.conferenceRecords.map((record) => record.name)).toEqual([
      "conferenceRecords/rec-1",
    ]);
    expect(result.attendance).toHaveLength(1);
    expect(result.attendance[0]?.conferenceRecord).toBe("conferenceRecords/rec-1");
    expect(result.attendance[0]?.participant).toBe("conferenceRecords/rec-1/participants/p1");
    expect(result.attendance[0]?.displayName).toBe("Alice");
    expect(result.attendance[0]?.user).toBe("users/alice");
    expect(result.attendance[0]?.sessions.map((session) => session.name)).toEqual([
      "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
    ]);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://meet.googleapis.com/v2/conferenceRecords/rec-1",
      {
        headers: {
          Authorization: "Bearer token",
          Accept: "application/json",
        },
      },
    );
  });

  it("merges duplicate attendance participants and annotates timing", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input);
      if (url.pathname === "/v2/conferenceRecords/rec-1") {
        return jsonResponse({
          name: "conferenceRecords/rec-1",
          startTime: "2026-04-25T10:00:00Z",
          endTime: "2026-04-25T11:00:00Z",
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants") {
        return jsonResponse({
          participants: [
            {
              name: "conferenceRecords/rec-1/participants/p1",
              signedinUser: { user: "users/alice", displayName: "Alice" },
            },
            {
              name: "conferenceRecords/rec-1/participants/p2",
              signedinUser: { user: "users/alice", displayName: "Alice" },
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants/p1/participantSessions") {
        return jsonResponse({
          participantSessions: [
            {
              name: "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
              startTime: "2026-04-25T10:10:00Z",
              endTime: "2026-04-25T10:30:00Z",
            },
          ],
        });
      }
      if (url.pathname === "/v2/conferenceRecords/rec-1/participants/p2/participantSessions") {
        return jsonResponse({
          participantSessions: [
            {
              name: "conferenceRecords/rec-1/participants/p2/participantSessions/s1",
              startTime: "2026-04-25T10:40:00Z",
              endTime: "2026-04-25T10:50:00Z",
            },
          ],
        });
      }
      return new Response(`unexpected ${url.pathname}`, { status: 404 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchGoogleMeetAttendance({
      accessToken: "token",
      conferenceRecord: "rec-1",
    });
    expect(result.attendance).toHaveLength(1);
    const row = result.attendance[0];
    expect(row?.displayName).toBe("Alice");
    expect(row?.participants).toEqual([
      "conferenceRecords/rec-1/participants/p1",
      "conferenceRecords/rec-1/participants/p2",
    ]);
    expect(row?.firstJoinTime).toBe("2026-04-25T10:10:00.000Z");
    expect(row?.lastLeaveTime).toBe("2026-04-25T10:50:00.000Z");
    expect(row?.durationMs).toBe(1_800_000);
    expect(row?.late).toBe(true);
    expect(row?.earlyLeave).toBe(true);
    expect(row?.sessions.map((session) => session.name)).toEqual([
      "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
      "conferenceRecords/rec-1/participants/p2/participantSessions/s1",
    ]);
  });

  it("surfaces Developer Preview acknowledgment blockers in preflight reports", () => {
    const report = buildGoogleMeetPreflightReport({
      input: "abc-defg-hij",
      space: { name: "spaces/abc-defg-hij" },
      previewAcknowledged: false,
      tokenSource: "cached-access-token",
    });
    expect(report.resolvedSpaceName).toBe("spaces/abc-defg-hij");
    expect(report.previewAcknowledged).toBe(false);
    expect(report.blockers).toHaveLength(1);
    expect(report.blockers[0]).toContain("Developer Preview Program");
  });

  it("builds Twilio dial plans from a PIN", () => {
    expect(normalizeDialInNumber("+1 (555) 123-4567")).toBe("+15551234567");
    expect(buildMeetDtmfSequence({ pin: "123 456" })).toBe("123456#");
    expect(buildMeetDtmfSequence({ dtmfSequence: "ww123#" })).toBe("ww123#");
    expect(prefixDtmfWait("123456#", 12000)).toBe("wwwwwwwwwwwwwwwwwwwwwwww123456#");
  });

  it("joins a Twilio session through the tool without page parsing", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = getMeetTool({ tools });
    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    const session = requireRecord(result.details.session, "Twilio session");
    expect(session.transport).toBe("twilio");
    expect(session.mode).toBe("agent");
    expect(session.twilio).toEqual({
      dialInNumber: "+15551234567",
      pinProvided: true,
      dtmfSequence: "wwwwwwwwwwwwwwwwwwwwwwww123456#",
      voiceCallId: "call-1",
      dtmfSent: true,
      introSent: true,
    });
    const [voiceCallParams] = voiceCallMocks.joinMeetViaVoiceCallGateway.mock
      .calls[0] as unknown as [Record<string, unknown>];
    expect(requireRecord(voiceCallParams.config, "voice-call config").defaultTransport).toBe(
      "twilio",
    );
    expect(voiceCallParams.dialInNumber).toBe("+15551234567");
    expect(voiceCallParams.dtmfSequence).toBe("wwwwwwwwwwwwwwwwwwwwwwww123456#");
    expect(typeof requireRecord(voiceCallParams.logger, "voice-call logger").info).toBe("function");
    expect(voiceCallParams.message).toBe("Say exactly: I'm here and listening.");
    expect(String(voiceCallParams.sessionKey)).toMatch(/^voice:google-meet:meet_/);
  });

  it("passes the caller session key through tool joins for agent context forking", async () => {
    const { tools } = setup(
      {},
      { toolContext: { sessionKey: "agent:main:discord:channel:general" } },
    );
    const gatewayParams: unknown[] = [];
    googleMeetPluginTesting.setCallGatewayFromCliForTests(async (_method, _opts, params) => {
      gatewayParams.push(params);
      return { ok: true };
    });
    const tool = getMeetTool({ tools });

    await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      requesterSessionKey: "agent:main:wrong",
    });

    const gatewayJoinParams = requireRecord(gatewayParams[0], "gateway join params");
    expect(gatewayJoinParams.url).toBe(MEET_URL);
    expect(gatewayJoinParams.requesterSessionKey).toBe("agent:main:discord:channel:general");
  });

  it("requests admin scope only for the bundled tool Gateway fallback", async () => {
    const { tools } = setup(
      {},
      { toolContext: { sessionKey: "agent:main:discord:channel:general" } },
    );
    const callGatewayFromCli = vi.fn(async () => ({ ok: true }));
    googleMeetPluginTesting.setCallGatewayFromCliForTests(callGatewayFromCli);
    const tool = getMeetTool({ tools });

    await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      mode: "transcribe",
    });

    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "googlemeet.join",
      expect.any(Object),
      expect.objectContaining({
        requesterSessionKey: "agent:main:discord:channel:general",
      }),
      { progress: false, scopes: ["operator.admin"] },
    );
  });

  it("keeps Twilio calls on the agent that invoked the tool", async () => {
    const { tools, gatewayRequest } = setup(
      { defaultTransport: "twilio" },
      {
        gatewayAvailable: true,
        toolContext: { agentId: "Support", sessionKey: "agent:support:main" },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
    });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "googlemeet.join",
      expect.objectContaining({
        agentId: "support",
        requesterSessionKey: "agent:support:main",
      }),
      { timeoutMs: 60_000, scopes: ["operator.admin"] },
    );
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        sessionKey: `agent:support:google-meet:${result.details.session.id}`,
      }),
    );
  });

  it("derives trusted agent ownership from the invoking session key", async () => {
    const { tools, gatewayRequest } = setup(
      { defaultTransport: "twilio" },
      {
        gatewayAvailable: true,
        toolContext: { sessionKey: "agent:support:pr103522-live" },
      },
    );
    const tool = getMeetTool({ tools });

    await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
      agentId: "spoofed",
    });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "googlemeet.join",
      expect.objectContaining({
        agentId: "support",
        requesterSessionKey: "agent:support:pr103522-live",
      }),
      { timeoutMs: 60_000, scopes: ["operator.admin"] },
    );
  });

  it("keeps Twilio calls on the configured realtime agent when no tool override exists", async () => {
    const { tools } = setup({
      defaultTransport: "twilio",
      realtime: { agentId: "support" },
    });
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
    });

    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "support",
        sessionKey: `agent:support:google-meet:${result.details.session.id}`,
      }),
    );
  });

  it("keeps test-listen probes on the agent that invoked the tool", async () => {
    const { tools, gatewayRequest } = setup(
      { defaultTransport: "chrome-node" },
      {
        gatewayAvailable: true,
        toolContext: { agentId: "Support", sessionKey: "agent:support:main" },
        browserActResult: {
          inCall: true,
          captioning: true,
          transcriptLines: 1,
          lastCaptionText: "hello from the meeting",
          title: "Meet call",
          url: MEET_URL,
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "test_listen",
      url: MEET_URL,
      timeoutMs: "100",
    });

    expect(gatewayRequest).toHaveBeenCalledWith(
      "googlemeet.testListen",
      expect.objectContaining({
        agentId: "support",
        requesterSessionKey: "agent:support:main",
      }),
      { timeoutMs: 60_000, scopes: ["operator.admin"] },
    );
    expect(result.details.session.agentId).toBe("support");
    expect(result.details.listenVerified).toBe(true);
  });

  it("fails closed for standalone non-default agent routing", async () => {
    const { tools } = setup(
      {},
      { toolContext: { agentId: "support", sessionKey: "agent:support:main" } },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
    });

    expect(result.details.error).toContain("requires a Gateway-hosted agent run");
  });

  it("preserves structured recovery details from the running Gateway", async () => {
    const { tools } = setup(
      {},
      { toolContext: { agentId: "main", sessionKey: "agent:main:main" } },
    );
    googleMeetPluginTesting.setCallGatewayFromCliForTests(async () => {
      throw Object.assign(new Error("browser login required"), {
        details: {
          manualActionRequired: true,
          reason: "not-authenticated",
          browser: { profile: "openclaw" },
        },
      });
    });
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
    });

    expect(result.details).toEqual({
      manualActionRequired: true,
      reason: "not-authenticated",
      browser: { profile: "openclaw" },
    });
  });

  it("does not accept agent routing from an external gateway caller", async () => {
    const { methods } = setup({ defaultTransport: "twilio" });

    await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
      url: MEET_URL,
      dialInNumber: "+15551234567",
      agentId: "spoofed",
    });

    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: undefined,
        sessionKey: expect.stringMatching(/^voice:google-meet:meet_/),
      }),
    );
  });

  it("explains that Twilio joins need dial-in details", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
    });

    expect(result.details.error).toContain("Twilio transport requires a Meet dial-in phone number");
    expect(result.details.error).toContain("Google Meet URLs do not include dial-in details");
  });

  it("hangs up delegated Twilio calls on leave", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = getMeetTool({ tools });
    const joined = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    await tool.execute("id", { action: "leave", sessionId: joined.details.session.id });

    const [endParams] = mockCall(voiceCallMocks.endMeetVoiceCallGatewayCall) as [
      Record<string, unknown>,
    ];
    expect(endParams.gateway).toBeDefined();
    expect(endParams.callId).toBe("call-1");
    expect(voiceCallMocks.endMeetVoiceCallGatewayCall).toHaveBeenCalledWith({
      gateway: endParams.gateway,
      callId: "call-1",
    });
  });

  it("does not reuse Twilio Meet sessions whose delegated call is no longer active", async () => {
    voiceCallMocks.getMeetVoiceCallGatewayCall.mockResolvedValueOnce({ found: false });
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = getMeetTool({ tools });
    const first = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
      pin: "123456",
    });
    const second = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    expect(first.details.session.state).toBe("ended");
    expect(first.details.session.notes).toContain("Voice Call is no longer active.");
    expect(second.details.session.id).not.toBe(first.details.session.id);
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledTimes(2);
  });

  it("serializes concurrent identical Twilio joins", async () => {
    let finishDial:
      | ((result: { callId: string; dtmfSent: boolean; introSent: boolean }) => void)
      | undefined;
    const dialing = new Promise<{ callId: string; dtmfSent: boolean; introSent: boolean }>(
      (resolve) => {
        finishDial = resolve;
      },
    );
    voiceCallMocks.joinMeetViaVoiceCallGateway.mockReturnValueOnce(dialing);
    const runtime = meetRuntime({ defaultTransport: "twilio" }, noopLogger);
    const request = {
      url: MEET_URL,
      dialInNumber: "+15551234567",
      pin: "123456",
    };

    const firstJoin = runtime.join(request);
    await vi.waitFor(() => {
      expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce();
    });
    const secondJoin = runtime.join(request);
    await Promise.resolve();
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce();

    finishDial?.({ callId: "call-1", dtmfSent: true, introSent: true });
    const [first, second] = await Promise.all([firstJoin, secondJoin]);

    expect(second.session.id).toBe(first.session.id);
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledOnce();
  });

  it("delegates Twilio session speech through voice-call", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = getMeetTool({ tools });
    const joined = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    const spoken = await tool.execute("id", {
      action: "speak",
      sessionId: joined.details.session.id,
      message: "Say exactly: hello after joining.",
    });

    expect(requireRecord(spoken.details, "spoken details").spoken).toBe(true);
    const [speakParams] = voiceCallMocks.speakMeetViaVoiceCallGateway.mock.calls.at(
      0,
    ) as unknown as [Record<string, unknown>];
    expect(speakParams.gateway).toBeDefined();
    expect(speakParams.callId).toBe("call-1");
    expect(speakParams.message).toBe("Say exactly: hello after joining.");
    expect(voiceCallMocks.speakMeetViaVoiceCallGateway).toHaveBeenCalledWith({
      gateway: speakParams.gateway,
      callId: "call-1",
      message: "Say exactly: hello after joining.",
    });
  });

  it("rejects ended-session speech before invoking voice-call", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = getMeetTool({ tools });
    const joined = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
      dialInNumber: "+15551234567",
    });
    const sessionId = requireRecord(joined.details.session, "joined Twilio session").id;
    await tool.execute("id", { action: "leave", sessionId });
    voiceCallMocks.speakMeetViaVoiceCallGateway.mockClear();

    const spoken = await tool.execute("id", {
      action: "speak",
      sessionId,
      message: "Do not send this.",
    });

    expect(spoken.details.found).toBe(true);
    expect(spoken.details.spoken).toBe(false);
    expect(voiceCallMocks.speakMeetViaVoiceCallGateway).not.toHaveBeenCalled();
  });

  it("reports setup status through the tool", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { tools } = setup({
        chrome: {
          audioInputCommand: ["openclaw-audio-bridge", "capture"],
          audioOutputCommand: ["openclaw-audio-bridge", "play"],
        },
      });
      const tool = getMeetTool({ tools });

      const result = await tool.execute("id", { action: "setup_status" });

      expect(result.details.ok).toBe(true);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("rejects agent-mode external audio bridges in setup status", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { tools } = setup(
        {
          defaultMode: "agent",
          defaultTransport: "chrome",
          chrome: {
            audioBridgeCommand: ["bridge", "start"],
            audioInputCommand: ["capture-meet"],
            audioOutputCommand: ["play-meet"],
          },
        },
        {
          runCommandWithTimeoutHandler: async (argv) => {
            if (argv[0] === "/usr/sbin/system_profiler") {
              return { code: 0, stdout: "BlackHole 2ch", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      );
      const tool = getMeetTool({ tools });

      const result = await tool.execute("id", { action: "setup_status" });

      expect(result.details.ok).toBe(false);
      const audioBridgeCheck = result.details.checks
        ?.map((check) => requireRecord(check, "setup check"))
        .find((check) => check.id === "audio-bridge");
      if (!audioBridgeCheck) {
        throw new Error("Expected audio-bridge setup check");
      }
      expect(audioBridgeCheck.ok).toBe(false);
      expect(String(audioBridgeCheck.message)).toContain("chrome.audioBridgeCommand is bidi-only");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("reports attendance through the tool", async () => {
    stubMeetArtifactsApi();
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "attendance",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      conferenceRecord: "rec-1",
      pageSize: "3",
    });

    expect(result.details.attendance).toHaveLength(1);
    expect(result.details.attendance?.[0]?.displayName).toBe("Alice");
  });

  it("rejects fractional attendance page sizes", async () => {
    stubMeetArtifactsApi();
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "attendance",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      conferenceRecord: "rec-1",
      pageSize: "3.5",
    });

    expect(result.details.error).toBe("pageSize must be a positive integer");
  });

  it("writes export bundles through the tool", async () => {
    stubMeetArtifactsApi();
    const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-tool-export-"));
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    try {
      const result = await tool.execute("id", {
        action: "export",
        accessToken: "token",
        expiresAt: Date.now() + 120_000,
        conferenceRecord: "rec-1",
        includeDocumentBodies: true,
        outputDir: tempDir,
        zip: true,
      });

      expect(result.details.files).toContain(path.join(tempDir, "manifest.json"));
      expect(result.details.zipFile).toBe(`${tempDir}.zip`);
      const manifest = requireRecord(
        JSON.parse(readFileSync(path.join(tempDir, "manifest.json"), "utf8")),
        "export manifest",
      );
      expect(manifest.request).toEqual({
        conferenceRecord: "rec-1",
        includeDocumentBodies: true,
        includeTranscriptEntries: true,
        allConferenceRecords: false,
        mergeDuplicateParticipants: true,
      });
      expect(manifest.counts).toEqual({
        conferenceRecords: 1,
        artifacts: 1,
        recordings: 1,
        transcripts: 1,
        transcriptEntries: 1,
        smartNotes: 1,
        attendanceRows: 1,
        warnings: 0,
      });
      expect(manifest.files).toEqual([
        "summary.md",
        "attendance.csv",
        "transcript.md",
        "artifacts.json",
        "attendance.json",
        "manifest.json",
      ]);
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
      rmSync(`${tempDir}.zip`, { force: true });
    }
  });

  it("dry-runs export bundles through the tool", async () => {
    stubMeetArtifactsApi();
    const parentDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-tool-dry-run-"));
    const outputDir = path.join(parentDir, "bundle");
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    try {
      const result = await tool.execute("id", {
        action: "export",
        accessToken: "token",
        expiresAt: Date.now() + 120_000,
        conferenceRecord: "rec-1",
        outputDir,
        dryRun: true,
      });

      expect(result.details.dryRun).toBe(true);
      expect(result.details.manifest?.files).toEqual([
        "summary.md",
        "attendance.csv",
        "transcript.md",
        "artifacts.json",
        "attendance.json",
        "manifest.json",
      ]);
      expect(existsSync(outputDir)).toBe(false);
    } finally {
      rmSync(parentDir, { recursive: true, force: true });
    }
  });

  it("reports the latest conference record through the tool", async () => {
    stubMeetArtifactsApi();
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "latest",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      meeting: "abc-defg-hij",
    });

    expect(result.details.conferenceRecord?.name).toBe("conferenceRecords/rec-1");
  });

  it("reports the latest conference record from today's calendar through the tool", async () => {
    stubMeetArtifactsApi();
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "latest",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      today: true,
    });

    expect(result.details.calendarEvent?.meetingUri).toBe(MEET_URL);
  });

  it("reports calendar event previews through the tool", async () => {
    stubMeetArtifactsApi();
    const { tools } = setup();
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "calendar_events",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      today: true,
    });

    expect(result.details.events).toHaveLength(1);
    expect(result.details.events?.[0]?.selected).toBe(true);
    expect(result.details.events?.[0]?.meetingUri).toBe(MEET_URL);
  });

  it("fails setup status when the configured Chrome node is not connected", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesListResult: {
          nodes: [
            {
              nodeId: "node-1",
              displayName: "parallels-macos",
              connected: false,
              caps: [],
              commands: [],
              remoteIp: "192.168.0.25",
            },
          ],
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", { action: "setup_status" });

    expect(result.details.ok).toBe(false);
    const check = requireSetupCheck(result.details.checks, "chrome-node-connected");
    expect(check.ok).toBe(false);
    expect(check.message).toContain("parallels-macos");
    expect(check.message).toContain("offline");
    expect(check.message).toContain("missing googlemeet.chrome");
    expect(check.message).toContain("missing browser.proxy/browser capability");
  });

  it("reports missing local Chrome audio prerequisites in setup status", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { tools } = setup(
        { defaultTransport: "chrome" },
        {
          runCommandWithTimeoutHandler: async (argv) => {
            if (argv[0] === "/usr/sbin/system_profiler") {
              return { code: 0, stdout: "Built-in Output", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      );
      const tool = getMeetTool({ tools });

      const result = await tool.execute("id", { action: "setup_status", transport: "chrome" });

      expect(result.details.ok).toBe(false);
      const check = requireSetupCheck(result.details.checks, "chrome-local-audio-device");
      expect(check.ok).toBe(false);
      expect(check.message).toContain("BlackHole 2ch audio device not found");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("reports missing local Chrome audio commands in setup status", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { tools } = setup(
        { defaultTransport: "chrome" },
        {
          runCommandWithTimeoutHandler: async (argv) => {
            if (argv[0] === "/usr/sbin/system_profiler") {
              return { code: 0, stdout: "BlackHole 2ch", stderr: "" };
            }
            if (argv[0] === "/bin/sh" && argv.at(-1) === "sox") {
              return { code: 1, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      );
      const tool = getMeetTool({ tools });

      const result = await tool.execute("id", { action: "setup_status", transport: "chrome" });

      expect(result.details.ok).toBe(false);
      const check = requireSetupCheck(result.details.checks, "chrome-local-audio-commands");
      expect(check.ok).toBe(false);
      expect(check.message).toBe("Chrome audio command missing: sox");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("checks a configured local barge-in command in setup status", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { tools } = setup(
        {
          defaultTransport: "chrome",
          chrome: {
            bargeInInputCommand: ["missing-barge-capture"],
          },
        },
        {
          runCommandWithTimeoutHandler: async (argv) => {
            if (argv[0] === "/usr/sbin/system_profiler") {
              return { code: 0, stdout: "BlackHole 2ch", stderr: "" };
            }
            if (argv[0] === "/bin/sh" && argv.at(-1) === "missing-barge-capture") {
              return { code: 1, stdout: "", stderr: "" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        },
      );
      const tool = getMeetTool({ tools });

      const result = await tool.execute("id", { action: "setup_status", transport: "chrome" });

      expect(result.details.ok).toBe(false);
      const check = requireSetupCheck(result.details.checks, "chrome-local-audio-commands");
      expect(check.ok).toBe(false);
      expect(check.message).toBe("Chrome audio command missing: missing-barge-capture");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("skips local Chrome audio prerequisites for observe-only setup status", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { tools, runCommandWithTimeout } = setup(
        { defaultMode: "transcribe", defaultTransport: "chrome" },
        {
          runCommandWithTimeoutHandler: async () => ({
            code: 1,
            stdout: "Built-in Output",
            stderr: "",
          }),
        },
      );
      const tool = getMeetTool({ tools });

      const result = await tool.execute("id", {
        action: "setup_status",
        transport: "chrome",
        mode: "transcribe",
      });

      expect(result.details.ok).toBe(true);
      const check = requireSetupCheck(result.details.checks, "audio-bridge");
      expect(check.ok).toBe(true);
      expect(check.message).toBe(
        "Chrome observe-only mode does not require a realtime audio bridge",
      );
      expect(
        result.details.checks?.filter(
          (checkLocal) => checkLocal.id === "chrome-local-audio-device",
        ),
      ).toStrictEqual([]);
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("reports Twilio delegation readiness when voice-call is enabled", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secret");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001234");
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        chromeNode: { node: "parallels-macos" },
      },
      {
        fullConfig: {
          plugins: {
            allow: ["google-meet", "voice-call"],
            entries: {
              "voice-call": {
                enabled: true,
                config: {
                  provider: "twilio",
                  publicUrl: "https://voice.example.com/voice/webhook",
                },
              },
            },
          },
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", { action: "setup_status" });

    expect(result.details.ok).toBe(true);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-plugin").ok).toBe(true);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-credentials").ok).toBe(true);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-webhook").ok).toBe(true);
  });

  it.each([
    {
      label: "environment account SID",
      env: { accountSid: "   ", authToken: "test-auth-token", fromNumber: "+15550001234" },
    },
    {
      label: "environment auth token",
      env: { accountSid: "AC123", authToken: "   ", fromNumber: "+15550001234" },
    },
    {
      label: "environment from number",
      env: { accountSid: "AC123", authToken: "test-auth-token", fromNumber: "   " },
    },
    {
      label: "configured account SID",
      env: { accountSid: "", authToken: "", fromNumber: "" },
      configured: { accountSid: "   ", authToken: "test-auth-token", fromNumber: "+15550001234" },
    },
    {
      label: "configured auth token",
      env: { accountSid: "", authToken: "", fromNumber: "" },
      configured: { accountSid: "AC123", authToken: "   ", fromNumber: "+15550001234" },
    },
    {
      label: "configured from number",
      env: { accountSid: "", authToken: "", fromNumber: "" },
      configured: { accountSid: "AC123", authToken: "test-auth-token", fromNumber: "   " },
    },
  ])("reports a blank $label as missing", async ({ env, configured }) => {
    const check = await getTwilioVoiceCallCredentialsCheck({ env, configured });

    expect(check.ok).toBe(false);
  });

  it.each([
    {
      label: "environment",
      env: {
        accountSid: "  AC123  ",
        authToken: "  test-auth-token  ",
        fromNumber: "  +15550001234  ",
      },
    },
    {
      label: "configuration",
      env: { accountSid: "", authToken: "", fromNumber: "" },
      configured: {
        accountSid: "  AC123  ",
        authToken: "  test-auth-token  ",
        fromNumber: "  +15550001234  ",
      },
    },
  ])("accepts padded Twilio credentials from $label", async ({ env, configured }) => {
    const check = await getTwilioVoiceCallCredentialsCheck({ env, configured });

    expect(check.ok).toBe(true);
  });

  it("reports missing voice-call wiring for explicit Twilio transport", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "");
    vi.stubEnv("TWILIO_FROM_NUMBER", "");
    const { tools } = setup(
      { defaultTransport: "chrome" },
      {
        fullConfig: {
          plugins: {
            allow: ["google-meet"],
            entries: {
              "voice-call": { enabled: false },
            },
          },
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", { action: "setup_status", transport: "twilio" });

    expect(result.details.ok).toBe(false);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-plugin").ok).toBe(false);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-credentials").ok).toBe(
      false,
    );
  });

  it("reports missing voice-call plugin entry for explicit Twilio transport", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secret");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001234");
    const { tools } = setup(
      { defaultTransport: "chrome" },
      {
        fullConfig: {
          plugins: {
            allow: ["google-meet", "voice-call"],
            entries: {},
          },
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", { action: "setup_status", transport: "twilio" });

    expect(result.details.ok).toBe(false);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-plugin").ok).toBe(false);
  });

  it("reports missing Twilio dial plan for explicit Twilio setup", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secret");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001234");
    const { tools } = setup(
      { defaultTransport: "chrome" },
      {
        fullConfig: {
          plugins: {
            allow: ["google-meet", "voice-call"],
            entries: {
              "voice-call": {
                enabled: true,
                config: {
                  provider: "twilio",
                  publicUrl: "https://voice.example.com/voice/webhook",
                },
              },
            },
          },
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", { action: "setup_status", transport: "twilio" });

    expect(result.details.ok).toBe(false);
    const check = requireSetupCheck(result.details.checks, "twilio-dial-plan");
    expect(check.ok).toBe(false);
    expect(check.message).toContain("dial-in phone number");
  });

  it("accepts request-provided Twilio dial-in details during setup", async () => {
    vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
    vi.stubEnv("TWILIO_AUTH_TOKEN", "secret");
    vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001234");
    const { tools } = setup(
      { defaultTransport: "chrome" },
      {
        fullConfig: {
          plugins: {
            allow: ["google-meet", "voice-call"],
            entries: {
              "voice-call": {
                enabled: true,
                config: {
                  provider: "twilio",
                  publicUrl: "https://voice.example.com/voice/webhook",
                },
              },
            },
          },
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "setup_status",
      transport: "twilio",
      dialInNumber: "+15551234567",
    });

    expect(result.details.ok).toBe(true);
    const check = requireSetupCheck(result.details.checks, "twilio-dial-plan");
    expect(check.ok).toBe(true);
    expect(check.message).toContain("request includes");
  });

  it.each([
    "http://127.0.0.1:3334/voice/webhook",
    "http://[::1]:3334/voice/webhook",
    "http://[fd00::1]/voice/webhook",
  ])(
    "reports local voice-call publicUrl %s as unusable for Twilio transport",
    async (publicUrl) => {
      vi.stubEnv("TWILIO_ACCOUNT_SID", "AC123");
      vi.stubEnv("TWILIO_AUTH_TOKEN", "secret");
      vi.stubEnv("TWILIO_FROM_NUMBER", "+15550001234");
      const { tools } = setup(
        { defaultTransport: "twilio" },
        {
          fullConfig: {
            plugins: {
              allow: ["google-meet", "voice-call"],
              entries: {
                "voice-call": {
                  enabled: true,
                  config: {
                    provider: "twilio",
                    publicUrl,
                  },
                },
              },
            },
          },
        },
      );
      const tool = getMeetTool({ tools });

      const result = await tool.execute("id", { action: "setup_status" });

      expect(result.details.ok).toBe(false);
      expect(requireSetupCheck(result.details.checks, "twilio-voice-call-webhook").ok).toBe(false);
    },
  );

  it("opens local Chrome Meet in observe-only mode without BlackHole checks", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const callGatewayFromCli = mockLocalMeetBrowserRequest({
        inCall: true,
        micMuted: true,
        captioning: true,
        captionsEnabledAttempted: true,
        transcriptLines: 1,
        lastCaptionAt: "2026-04-27T10:00:00.000Z",
        lastCaptionSpeaker: "Alice",
        lastCaptionText: "Can everyone hear the agent?",
        recentTranscript: [
          {
            at: "2026-04-27T10:00:00.000Z",
            speaker: "Alice",
            text: "Can everyone hear the agent?",
          },
        ],
        title: "Meet call",
        url: MEET_URL,
      });
      const { methods, runCommandWithTimeout } = setup({
        defaultMode: "transcribe",
        chrome: {
          browserProfile: "meet-devtools",
        },
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: MEET_URL },
        respond,
      });

      expectRespondedOk(respond);
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
      const openCall = callGatewayFromCli.mock.calls.find(
        (call) => requireRecord(call[2], "browser request").path === "/tabs/open",
      );
      if (!openCall) {
        throw new Error("Expected browser /tabs/open request");
      }
      expect(openCall[0]).toBe("browser.request");
      expect(openCall[2]).toEqual({
        method: "POST",
        path: "/tabs/open",
        timeoutMs: 30000,
        body: { url: MEET_URL_EN },
      });
      expect(openCall[3]).toEqual({ timeoutMs: 35_000, scopes: ["operator.admin"] });
      expect(
        callGatewayFromCli.mock.calls.some(
          (call) => (call[2] as { path?: string }).path === "/permissions/grant",
        ),
      ).toBe(false);
      const payload = requireRespondPayload(respond, "join response payload");
      const session = requireRecord(payload.session, "join session");
      const chrome = requireRecord(session.chrome, "join chrome session");
      const health = requireRecord(chrome.health, "join chrome health");
      expect(health.captioning).toBe(true);
      expect(health.captionsEnabledAttempted).toBe(true);
      expect(health.transcriptLines).toBe(1);
      expect(health.lastCaptionSpeaker).toBe("Alice");
      expect(health.lastCaptionText).toBe("Can everyone hear the agent?");
      const recentTranscript = health.recentTranscript as unknown[];
      expect(recentTranscript).toHaveLength(1);
      const transcriptLine = requireRecord(recentTranscript[0], "recent transcript line");
      expect(transcriptLine.speaker).toBe("Alice");
      expect(transcriptLine.text).toBe("Can everyone hear the agent?");
      const actCall = callGatewayFromCli.mock.calls.find(
        (call) => (call[2] as { path?: string }).path === "/act",
      );
      expect(String((actCall?.[2] as { body?: { fn?: string } } | undefined)?.body?.fn)).toContain(
        "const allowMicrophone = false",
      );
      expect(String((actCall?.[2] as { body?: { fn?: string } } | undefined)?.body?.fn)).toContain(
        "const captureCaptions = true",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("grants local Chrome Meet media permissions against the opened tab", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const callGatewayFromCli = mockLocalMeetBrowserRequest(meetBrowserState());
      const { methods } = setup({
        defaultMode: "bidi",
        defaultTransport: "chrome",
        chrome: {
          audioBridgeCommand: ["bridge", "start"],
        },
        realtime: { introMessage: "" },
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: MEET_URL },
        respond,
      });

      expectRespondedOk(respond);
      const grantCall = callGatewayFromCli.mock.calls.find(
        (call) => requireRecord(call[2], "browser request").path === "/permissions/grant",
      );
      if (!grantCall) {
        throw new Error("Expected browser /permissions/grant request");
      }
      expect(grantCall[0]).toBe("browser.request");
      const request = requireRecord(grantCall[2], "permissions request");
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/permissions/grant");
      const body = requireRecord(request.body, "permissions request body");
      expect(body.origin).toBe("https://meet.google.com");
      expect(body.permissions).toEqual(["audioCapture", "videoCapture"]);
      expect(body.targetId).toBe("local-meet-tab");
      expect(grantCall[3]).toEqual({ timeoutMs: 10_000, scopes: ["operator.admin"] });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  function mockLocalMeetBrowserRequestWithTabState(options?: {
    reused?: boolean;
    tabClosesAfterJoin?: boolean;
    tabUrlAfterJoin?: string;
    leaveClicked?: boolean;
    leaveConfirmationRequired?: boolean;
    nonFinalTranscriptGate?: Promise<void>;
    onNonFinalTranscriptRead?: () => void;
    skipNonFinalTranscriptGateReads?: number;
    transcript?: {
      droppedLines?: number;
      epoch?: string;
      lines: Array<{ at?: string; speaker?: string; text: string }>;
    };
    finalTranscript?: {
      droppedLines?: number;
      epoch?: string;
      lines: Array<{ at?: string; speaker?: string; text: string }>;
    };
    transcriptSequence?: Array<{
      droppedLines?: number;
      epoch?: string;
      lines: Array<{ at?: string; speaker?: string; text: string }>;
    }>;
  }) {
    let joined = false;
    let leaveStep = 0;
    let transcriptReadIndex = 0;
    let openedTabUrl = options?.reused ? MEET_URL_EN : undefined;
    const callGatewayFromCli = vi.fn(
      async (
        _method: string,
        _opts: unknown,
        params?: unknown,
        _extra?: unknown,
      ): Promise<Record<string, unknown>> => {
        const request = params as {
          method?: string;
          path?: string;
          body?: { fn?: string; targetId?: string; url?: string };
        };
        if (request.path === "/tabs") {
          const tabExists = openedTabUrl && !(options?.tabClosesAfterJoin && joined);
          const currentTabUrl = joined ? (options?.tabUrlAfterJoin ?? openedTabUrl) : openedTabUrl;
          return {
            tabs: tabExists
              ? [{ targetId: "local-meet-tab", title: "Meet", url: currentTabUrl }]
              : [],
          };
        }
        if (request.path === "/tabs/open") {
          openedTabUrl = request.body?.url;
          return { targetId: "local-meet-tab", title: "Meet", url: openedTabUrl };
        }
        if (request.path === "/tabs/focus") {
          return { ok: true };
        }
        if (request.path === "/navigate") {
          openedTabUrl = request.body?.url ?? openedTabUrl;
          return { targetId: request.body?.targetId, url: openedTabUrl };
        }
        if (request.path === "/permissions/grant") {
          return { ok: true };
        }
        if (request.method === "DELETE" && request.path === "/tabs/local-meet-tab") {
          if (options?.reused) {
            throw new Error("leave must not close a reused user-owned tab");
          }
          openedTabUrl = undefined;
          return { ok: true };
        }
        if (request.path === "/act") {
          if (String(request.body?.fn).includes("state = window.__openclawMeetCaptions")) {
            const finalizing = String(request.body?.fn).includes("if (true &&");
            if (
              !finalizing &&
              transcriptReadIndex >= (options?.skipNonFinalTranscriptGateReads ?? 0)
            ) {
              options?.onNonFinalTranscriptRead?.();
              await options?.nonFinalTranscriptGate;
            }
            const transcript = finalizing
              ? (options?.finalTranscript ?? options?.transcript)
              : options?.transcript;
            const sequencedTranscript =
              options?.transcriptSequence?.[
                Math.min(transcriptReadIndex, options.transcriptSequence.length - 1)
              ];
            transcriptReadIndex += 1;
            const responseTranscript = sequencedTranscript ?? transcript;
            return {
              result: JSON.stringify({
                urlMatched: options?.tabUrlAfterJoin?.includes("/abc-defg-hij") !== false,
                droppedLines: responseTranscript?.droppedLines ?? 0,
                epoch: responseTranscript?.epoch,
                lines: responseTranscript?.lines ?? [],
              }),
            };
          }
          if (String(request.body?.fn).includes("leaveAction")) {
            const currentUrl = options?.tabUrlAfterJoin ?? openedTabUrl;
            const urlMatched = currentUrl?.includes("/abc-defg-hij") === true;
            if (!urlMatched) {
              return { result: JSON.stringify({ departed: true, urlMatched: false }) };
            }
            if (options?.leaveClicked === false) {
              return { result: JSON.stringify({ departed: false, urlMatched: true }) };
            }
            leaveStep += 1;
            if (leaveStep === 1) {
              return {
                result: JSON.stringify({
                  departed: false,
                  leaveAction: "leave",
                  urlMatched: true,
                }),
              };
            }
            if (options?.leaveConfirmationRequired && leaveStep === 2) {
              return {
                result: JSON.stringify({
                  departed: false,
                  leaveAction: "confirm",
                  urlMatched: true,
                }),
              };
            }
            return {
              result: JSON.stringify({ departed: true, urlMatched: true }),
            };
          }
          joined = true;
          return { result: JSON.stringify(meetBrowserState({ micMuted: true })) };
        }
        throw new Error(`unexpected browser request path ${request.path}`);
      },
    );
    localBrowserGatewayRequestHandler = async (method, params, requestOptions) =>
      await callGatewayFromCli(method, {}, params, requestOptions);
    return callGatewayFromCli;
  }

  it("reads and snapshots the bounded transcript from the exact tracked tab", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const callGatewayFromCli = mockLocalMeetBrowserRequestWithTabState({
        transcript: {
          droppedLines: 2,
          lines: [
            { at: "2026-07-12T06:00:00.000Z", speaker: "Alice", text: "third line" },
            { at: "2026-07-12T06:00:01.000Z", speaker: "Bob", text: "fourth line" },
          ],
        },
      });
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as { session: { id: string } };

      const beforeRead = callGatewayFromCli.mock.calls.length;
      const transcript = (await invokeGoogleMeetGatewayMethodForTest(
        methods,
        "googlemeet.transcript",
        { sessionId: joined.session.id, sinceIndex: 3 },
      )) as {
        droppedLines: number;
        startIndex: number;
        nextIndex: number;
        lines: Array<{ text: string }>;
      };
      expect(transcript).toMatchObject({ droppedLines: 2, startIndex: 3, nextIndex: 4 });
      expect(transcript.lines.map((line) => line.text)).toEqual(["fourth line"]);
      const readCalls = callGatewayFromCli.mock.calls.slice(beforeRead);
      expect(readCalls).toHaveLength(1);
      expect(requireRecord(readCalls[0]?.[2], "transcript request")).toMatchObject({
        method: "POST",
        path: "/act",
        body: { targetId: "local-meet-tab" },
      });

      await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      });
      const afterLeave = (await invokeGoogleMeetGatewayMethodForTest(
        methods,
        "googlemeet.transcript",
        { sessionId: joined.session.id },
      )) as { lines: Array<{ text: string }> };
      expect(afterLeave.lines.map((line) => line.text)).toEqual(["third line", "fourth line"]);

      await expect(
        invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
          sessionId: joined.session.id,
          sinceIndex: 1.5,
        }),
      ).rejects.toThrow("sinceIndex must be a non-negative safe integer");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("refuses to read a tracked tab after it navigates away from the meeting", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      mockLocalMeetBrowserRequestWithTabState({
        tabUrlAfterJoin: "https://meet.google.com/lookup/unrelated",
        transcript: { lines: [{ text: "must not leak" }] },
      });
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as { session: { id: string } };

      await expect(
        invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
          sessionId: joined.session.id,
        }),
      ).rejects.toThrow("tracked Meet tab no longer shows this session's meeting URL");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("keeps the cursor monotonic when the Meet page transcript epoch resets", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      mockLocalMeetBrowserRequestWithTabState({
        transcriptSequence: [
          { epoch: "page-1", lines: [] },
          { epoch: "page-1", lines: [{ text: "before reload" }] },
          { epoch: "page-2", lines: [{ text: "after reload" }] },
          { epoch: "page-2", lines: [{ text: "after reload" }] },
        ],
      });
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as { session: { id: string } };

      const first = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
        sessionId: joined.session.id,
      })) as { nextIndex: number; lines: Array<{ text: string }> };
      const second = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
        sessionId: joined.session.id,
        sinceIndex: first.nextIndex,
      })) as { nextIndex: number; lines: Array<{ text: string }> };
      expect(first).toMatchObject({ nextIndex: 1, lines: [{ text: "before reload" }] });
      expect(second).toMatchObject({ nextIndex: 2, lines: [{ text: "after reload" }] });

      await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      });
      const ended = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
        sessionId: joined.session.id,
      })) as { lines: Array<{ text: string }> };
      expect(ended.lines.map((line) => line.text)).toEqual(["before reload", "after reload"]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does not let a late active read replace the finalized leave snapshot", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    let releaseRead: (() => void) | undefined;
    let markReadStarted: (() => void) | undefined;
    const readGate = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const readStarted = new Promise<void>((resolve) => {
      markReadStarted = resolve;
    });
    let activeReads = 0;
    try {
      const callGatewayFromCli = mockLocalMeetBrowserRequestWithTabState({
        transcript: { lines: [{ text: "partial" }] },
        finalTranscript: { lines: [{ text: "partial" }, { text: "complete caption" }] },
        nonFinalTranscriptGate: readGate,
        skipNonFinalTranscriptGateReads: 1,
        onNonFinalTranscriptRead: () => {
          activeReads += 1;
          markReadStarted?.();
        },
      });
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as { session: { id: string } };

      const lateRead = invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
        sessionId: joined.session.id,
      });
      await readStarted;
      const secondRead = invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
        sessionId: joined.session.id,
      });
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(activeReads).toBe(1);
      const leaving = invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      });
      const repeatedLeave = invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      });
      releaseRead?.();
      await Promise.allSettled([lateRead, secondRead, leaving, repeatedLeave]);
      const finalCaptures = callGatewayFromCli.mock.calls.filter((call) => {
        const request = call[2] as { body?: { fn?: string } };
        const script = String(request.body?.fn);
        return (
          script.includes("state = window.__openclawMeetCaptions") && script.includes("if (true &&")
        );
      });
      expect(finalCaptures).toHaveLength(1);
      const result = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
        sessionId: joined.session.id,
      })) as { lines: Array<{ text: string }> };
      expect(result.lines.map((line) => line.text)).toEqual(["partial", "complete caption"]);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("retains only the four most recently ended transcripts", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      mockLocalMeetBrowserRequestWithTabState({
        transcript: { lines: [{ text: "retained line" }] },
      });
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const sessionIds: string[] = [];
      for (let index = 0; index < 5; index += 1) {
        const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
          url: MEET_URL,
        })) as { session: { id: string } };
        sessionIds.push(joined.session.id);
        await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
          sessionId: joined.session.id,
        });
      }

      const oldest = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
        sessionId: sessionIds[0],
      })) as { evicted?: boolean; lines: unknown[] };
      const next = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.transcript", {
        sessionId: sessionIds[1],
      })) as { evicted?: boolean; lines: unknown[] };
      expect(oldest).toMatchObject({ evicted: true, lines: [] });
      expect(next.evicted).toBeUndefined();
      expect(next.lines).toHaveLength(1);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("leaves the Meet call in the browser when a chrome session leaves", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const callGatewayFromCli = mockLocalMeetBrowserRequestWithTabState();
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as { session: { id: string; chrome?: { browserTab?: unknown } } };
      expect(joined.session.chrome?.browserTab).toEqual({
        targetId: "local-meet-tab",
        openedByPlugin: true,
      });

      const left = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      })) as { found: boolean; browserLeft?: boolean; session: { state: string; notes: string[] } };

      expect(left.found).toBe(true);
      expect(left.session.state).toBe("ended");
      expect(left.browserLeft).toBe(true);
      expect(left.session.notes).toContain(
        "Clicked Meet's Leave call button and closed the Meet tab.",
      );
      const leaveActCall = callGatewayFromCli.mock.calls.find((call) =>
        String((call[2] as { body?: { fn?: string } }).body?.fn).includes("leaveAction"),
      );
      expect(
        requireRecord(requireRecord(leaveActCall?.[2], "leave act request").body, "leave act body")
          .targetId,
      ).toBe("local-meet-tab");
      const closeCall = callGatewayFromCli.mock.calls.find(
        (call) => (call[2] as { method?: string }).method === "DELETE",
      );
      expect((closeCall?.[2] as { path?: string } | undefined)?.path).toBe("/tabs/local-meet-tab");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("still ends the chrome session when its Meet tab is already closed on leave", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const callGatewayFromCli = mockLocalMeetBrowserRequestWithTabState({
        tabClosesAfterJoin: true,
      });
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as { session: { id: string } };

      const left = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      })) as { found: boolean; browserLeft?: boolean; session: { state: string; notes: string[] } };

      expect(left.found).toBe(true);
      expect(left.session.state).toBe("ended");
      expect(left.browserLeft).toBe(true);
      expect(left.session.notes).toContain("Meet tab is already closed.");
      expect(
        callGatewayFromCli.mock.calls.some(
          (call) => (call[2] as { method?: string }).method === "DELETE",
        ),
      ).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("confirms host leave and keeps the reused Meet tab open", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const callGatewayFromCli = mockLocalMeetBrowserRequestWithTabState({
        reused: true,
        leaveConfirmationRequired: true,
      });
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as { session: { id: string; chrome?: Record<string, unknown> } };
      expect(joined.session.chrome?.browserTab).toEqual({
        targetId: "local-meet-tab",
        openedByPlugin: false,
      });

      const left = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      })) as { found: boolean; browserLeft?: boolean; session: { state: string; notes: string[] } };

      expect(left.found).toBe(true);
      expect(left.session.state).toBe("ended");
      expect(left.browserLeft).toBe(true);
      expect(left.session.notes).toContain(
        "Clicked Meet's Leave call button; kept the reused browser tab open.",
      );
      const leaveActCall = callGatewayFromCli.mock.calls.find((call) =>
        String((call[2] as { body?: { fn?: string } }).body?.fn).includes("leaveAction"),
      );
      expect(
        requireRecord(requireRecord(leaveActCall?.[2], "leave act request").body, "leave act body")
          .targetId,
      ).toBe("local-meet-tab");
      const leaveSteps = callGatewayFromCli.mock.calls.filter((call) =>
        String((call[2] as { body?: { fn?: string } }).body?.fn).includes("leaveAction"),
      );
      expect(leaveSteps).toHaveLength(3);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("reports browserLeft false when the reused tab's Leave call click fails", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      mockLocalMeetBrowserRequestWithTabState({
        reused: true,
        leaveClicked: false,
      });
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as { session: { id: string } };

      const left = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      })) as { found: boolean; browserLeft?: boolean; session: { state: string; notes: string[] } };

      expect(left.found).toBe(true);
      expect(left.session.state).toBe("ended");
      expect(left.browserLeft).toBe(false);
      expect(left.session.notes).toContain(
        "Could not find Meet's Leave call button in the reused browser tab; leave it manually.",
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does not touch a reused tab after it moves to another meeting", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const callGatewayFromCli = mockLocalMeetBrowserRequestWithTabState({
        reused: true,
        tabUrlAfterJoin: "https://meet.google.com/xyz-abcd-efg?hl=en",
      });
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as { session: { id: string } };

      const left = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      })) as { browserLeft?: boolean; session: { notes: string[] } };

      expect(left.browserLeft).toBe(true);
      expect(left.session.notes).toContain(
        "Meet tab moved away from this session; left its current page untouched.",
      );
      expect(
        callGatewayFromCli.mock.calls.some((call) =>
          String((call[2] as { body?: { fn?: string } }).body?.fn).includes("leaveAction"),
        ),
      ).toBe(true);
      expect(
        callGatewayFromCli.mock.calls.some(
          (call) => (call[2] as { method?: string }).method === "DELETE",
        ),
      ).toBe(false);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does not leave the browser twice when an ended session is retried", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const callGatewayFromCli = mockLocalMeetBrowserRequestWithTabState({ reused: true });
      const { methods } = setup({ defaultMode: "transcribe", defaultTransport: "chrome" });
      const joined = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
        url: MEET_URL,
      })) as { session: { id: string } };

      const first = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      })) as { browserLeft?: boolean };
      const second = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.leave", {
        sessionId: joined.session.id,
      })) as { browserLeft?: boolean };

      expect(first.browserLeft).toBe(true);
      expect(second.browserLeft).toBe(true);
      const leaveCalls = callGatewayFromCli.mock.calls.filter((call) =>
        String((call[2] as { body?: { fn?: string } }).body?.fn).includes("leaveAction"),
      );
      expect(leaveCalls).toHaveLength(2);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("meet leave script clicks the enabled Leave call button", async () => {
    const makeButton = (label: string, disabled = false, iconText?: string) => ({
      disabled,
      innerText: "",
      textContent: "",
      click: vi.fn(),
      getAttribute: vi.fn((name: string) => (name === "aria-label" ? label : null)),
      querySelector: vi.fn((selector: string) =>
        selector === "i" && iconText !== undefined ? { textContent: iconText } : null,
      ),
    });
    const leaveButton = makeButton("Leave call");
    const document = {
      querySelectorAll: vi.fn((selector: string) =>
        selector === "button" ? [makeButton("Turn on captions"), leaveButton] : [],
      ),
    };
    const context = createContext({
      JSON,
      String,
      URL,
      location: { href: MEET_URL_EN },
      document,
    });
    const leaveScript = await captureMeetLeaveScript();
    const run = new Script(`(${leaveScript})()`).runInContext(context) as string;

    expect(leaveButton.click).toHaveBeenCalledTimes(1);
    expect(JSON.parse(run)).toEqual({
      departed: false,
      leaveAction: "leave",
      urlMatched: true,
    });

    document.querySelectorAll.mockImplementation((selector: string) =>
      selector === "button" ? [makeButton("Leave call", true)] : [],
    );
    const runDisabled = new Script(`(${leaveScript})()`).runInContext(context) as string;
    expect(JSON.parse(runDisabled)).toEqual({ departed: false, urlMatched: true });

    // Localized UI: no English label anywhere, but the Material Symbols
    // "call_end" icon ligature identifies the leave control in any language.
    const localizedLeave = makeButton("Anruf verlassen", false, "call_end");
    document.querySelectorAll.mockImplementation((selector: string) =>
      selector === "button"
        ? [makeButton("Untertitel aktivieren", false, "closed_caption_off"), localizedLeave]
        : [],
    );
    const runLocalized = new Script(`(${leaveScript})()`).runInContext(context) as string;
    expect(localizedLeave.click).toHaveBeenCalledTimes(1);
    expect(JSON.parse(runLocalized)).toEqual({
      departed: false,
      leaveAction: "leave",
      urlMatched: true,
    });

    const confirmLeave = makeButton("Leave meeting");
    document.querySelectorAll.mockImplementation((selector: string) =>
      selector === "button" ? [makeButton("End meeting for all"), confirmLeave] : [],
    );
    const runConfirmation = new Script(`(${leaveScript})()`).runInContext(context) as string;
    expect(confirmLeave.click).toHaveBeenCalledTimes(1);
    expect(JSON.parse(runConfirmation)).toEqual({
      departed: false,
      leaveAction: "confirm",
      urlMatched: true,
    });

    document.querySelectorAll.mockImplementation((selector: string) =>
      selector === "button" ? [makeButton("Rejoin")] : [],
    );
    const runDeparted = new Script(`(${leaveScript})()`).runInContext(context) as string;
    expect(JSON.parse(runDeparted)).toEqual({ departed: true, urlMatched: true });

    leaveButton.click.mockClear();
    context.location.href = "https://meet.google.com/xyz-abcd-efg?hl=en";
    document.querySelectorAll.mockImplementation((selector: string) =>
      selector === "button" ? [leaveButton] : [],
    );
    const runMoved = new Script(`(${leaveScript})()`).runInContext(context) as string;
    expect(leaveButton.click).not.toHaveBeenCalled();
    expect(JSON.parse(runMoved)).toEqual({ departed: true, urlMatched: false });
  });

  it("starts the local realtime audio bridge after Meet is inspected", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const events: string[] = [];
    try {
      const callGatewayFromCli = vi.fn(
        async (
          _method: string,
          _opts: unknown,
          params?: unknown,
          _extra?: unknown,
        ): Promise<Record<string, unknown>> => {
          const request = params as {
            path?: string;
            body?: { fn?: string; targetId?: string; url?: string };
          };
          events.push(`browser:${request.path}`);
          if (request.path === "/tabs") {
            return { tabs: [] };
          }
          if (request.path === "/tabs/open") {
            return {
              targetId: "local-meet-tab",
              title: "Meet",
              url: request.body?.url ?? MEET_URL,
            };
          }
          if (request.path === "/tabs/focus" || request.path === "/permissions/grant") {
            return { ok: true };
          }
          if (request.path === "/act") {
            return { result: JSON.stringify(meetBrowserState()) };
          }
          throw new Error(`unexpected browser request path ${request.path}`);
        },
      );
      localBrowserGatewayRequestHandler = async (method, params, requestOptions) =>
        await callGatewayFromCli(method, {}, params, requestOptions);
      const { methods } = setup(
        {
          defaultMode: "bidi",
          defaultTransport: "chrome",
          chrome: {
            audioBridgeCommand: ["bridge", "start"],
          },
          realtime: { introMessage: "" },
        },
        {
          runCommandWithTimeoutHandler: async (argv) => {
            events.push(`command:${argv.join(" ")}`);
            return argv[0] === "/usr/sbin/system_profiler"
              ? { code: 0, stdout: "BlackHole 2ch", stderr: "" }
              : { code: 0, stdout: "", stderr: "" };
          },
        },
      );
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: MEET_URL },
        respond,
      });

      expectRespondedOk(respond);
      expect(events.indexOf("browser:/act")).toBeGreaterThan(-1);
      expect(events.indexOf("command:bridge start")).toBeGreaterThan(
        events.indexOf("browser:/act"),
      );
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("does not start the local realtime audio bridge while Meet admission is pending", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    const events: string[] = [];
    try {
      const callGatewayFromCli = vi.fn(
        async (
          _method: string,
          _opts: unknown,
          params?: unknown,
          _extra?: unknown,
        ): Promise<Record<string, unknown>> => {
          const request = params as { path?: string; body?: { targetId?: string; url?: string } };
          events.push(`browser:${request.path}`);
          if (request.path === "/tabs") {
            return { tabs: [] };
          }
          if (request.path === "/tabs/open") {
            return {
              targetId: "local-meet-tab",
              title: "Meet",
              url: request.body?.url ?? MEET_URL,
            };
          }
          if (request.path === "/tabs/focus" || request.path === "/permissions/grant") {
            return { ok: true };
          }
          if (request.path === "/act") {
            return {
              result: JSON.stringify({
                inCall: false,
                lobbyWaiting: true,
                manualActionRequired: true,
                manualActionReason: "meet-admission-required",
                manualActionMessage: "Admit the OpenClaw browser participant in Google Meet.",
                title: "Meet",
                url: MEET_URL,
              }),
            };
          }
          throw new Error(`unexpected browser request path ${request.path}`);
        },
      );
      localBrowserGatewayRequestHandler = async (method, params, requestOptions) =>
        await callGatewayFromCli(method, {}, params, requestOptions);
      const { methods } = setup(
        {
          defaultMode: "bidi",
          defaultTransport: "chrome",
          chrome: {
            audioBridgeCommand: ["bridge", "start"],
            waitForInCallMs: 1,
          },
          realtime: { introMessage: "" },
        },
        {
          runCommandWithTimeoutHandler: async (argv) => {
            events.push(`command:${argv.join(" ")}`);
            return argv[0] === "/usr/sbin/system_profiler"
              ? { code: 0, stdout: "BlackHole 2ch", stderr: "" }
              : { code: 0, stdout: "", stderr: "" };
          },
        },
      );
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: MEET_URL },
        respond,
      });

      expectRespondedOk(respond);
      expect(events).toContain("browser:/act");
      expect(events).not.toContain("command:bridge start");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("refreshes observe-only caption health when status is requested", async () => {
    let openedTab = false;
    let actCount = 0;
    const callGatewayFromCli = vi.fn(
      async (
        _method: string,
        _opts: unknown,
        params?: unknown,
        _extra?: unknown,
      ): Promise<Record<string, unknown>> => {
        const request = params as {
          path?: string;
          body?: { targetId?: string; url?: string };
        };
        if (request.path === "/tabs") {
          return openedTab
            ? {
                tabs: [
                  {
                    targetId: "local-meet-tab",
                    title: "Meet",
                    url: MEET_URL_EN,
                  },
                ],
              }
            : { tabs: [] };
        }
        if (request.path === "/tabs/open") {
          openedTab = true;
          return {
            targetId: "local-meet-tab",
            title: "Meet",
            url: request.body?.url ?? MEET_URL_EN,
          };
        }
        if (request.path === "/tabs/focus") {
          return { ok: true };
        }
        if (request.path === "/navigate") {
          return {
            targetId: request.body?.targetId ?? "local-meet-tab",
            url: request.body?.url ?? MEET_URL_EN,
          };
        }
        if (request.path === "/act") {
          actCount += 1;
          return {
            result: JSON.stringify(
              actCount === 1
                ? {
                    inCall: true,
                    captioning: false,
                    captionsEnabledAttempted: true,
                    transcriptLines: 0,
                    title: "Meet call",
                    url: MEET_URL,
                  }
                : {
                    inCall: true,
                    captioning: true,
                    captionsEnabledAttempted: true,
                    transcriptLines: 1,
                    lastCaptionAt: "2026-04-27T10:00:00.000Z",
                    lastCaptionSpeaker: "Alice",
                    lastCaptionText: "Please capture this.",
                    recentTranscript: [
                      {
                        at: "2026-04-27T10:00:00.000Z",
                        speaker: "Alice",
                        text: "Please capture this.",
                      },
                    ],
                    title: "Meet call",
                    url: MEET_URL,
                  },
            ),
          };
        }
        throw new Error(`unexpected browser request path ${request.path}`);
      },
    );
    localBrowserGatewayRequestHandler = async (method, params, requestOptions) =>
      await callGatewayFromCli(method, {}, params, requestOptions);
    const { methods } = setup({
      defaultMode: "transcribe",
      defaultTransport: "chrome",
    });

    const join = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
      url: MEET_URL,
    })) as { session: { id: string; chrome?: { health?: { transcriptLines?: number } } } };
    expect(join.session.chrome?.health?.transcriptLines).toBe(0);

    const status = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.status", {
      sessionId: join.session.id,
    })) as {
      session?: {
        chrome?: {
          health?: {
            captioning?: boolean;
            transcriptLines?: number;
            lastCaptionText?: string;
          };
        };
      };
    };

    expect(status.session?.chrome?.health?.captioning).toBe(true);
    expect(status.session?.chrome?.health?.transcriptLines).toBe(1);
    expect(status.session?.chrome?.health?.lastCaptionText).toBe("Please capture this.");
    const focusCall = callGatewayFromCli.mock.calls.find(
      (call) => requireRecord(call[2], "browser request").path === "/tabs/focus",
    );
    if (!focusCall) {
      throw new Error("Expected browser /tabs/focus request");
    }
    expect(focusCall[0]).toBe("browser.request");
    expect(focusCall[2]).toEqual({
      method: "POST",
      path: "/tabs/focus",
      timeoutMs: 5000,
      body: { targetId: "local-meet-tab" },
    });
    expect(focusCall[3]).toEqual({ timeoutMs: 10_000, scopes: ["operator.admin"] });
  });

  it("refreshes blocked realtime browser health read-only when status is requested", async () => {
    let openedTab = false;
    const { methods, nodesInvoke } = setup(
      {
        defaultMode: "agent",
        defaultTransport: "chrome-node",
      },
      {
        nodesInvokeHandler: async ({ command, params }) => {
          const raw = params as { path?: string; body?: { url?: string; targetId?: string } };
          if (command === "browser.proxy") {
            if (raw.path === "/tabs") {
              return {
                payload: {
                  result: {
                    running: true,
                    tabs: openedTab
                      ? [
                          {
                            targetId: "tab-1",
                            title: "Meet",
                            url: MEET_URL_EN,
                          },
                        ]
                      : [],
                  },
                },
              };
            }
            if (raw.path === "/tabs/open") {
              openedTab = true;
              return {
                payload: {
                  result: {
                    targetId: "tab-1",
                    title: "Meet",
                    url: raw.body?.url ?? MEET_URL_EN,
                  },
                },
              };
            }
            if (raw.path === "/tabs/focus" || raw.path === "/permissions/grant") {
              return { payload: { result: { ok: true } } };
            }
            if (raw.path === "/navigate") {
              return {
                payload: {
                  result: {
                    targetId: raw.body?.targetId ?? "tab-1",
                    url: raw.body?.url ?? MEET_URL_EN,
                  },
                },
              };
            }
            if (raw.path === "/act") {
              return {
                payload: {
                  result: {
                    ok: true,
                    targetId: raw.body?.targetId ?? "tab-1",
                    result: JSON.stringify({
                      inCall: false,
                      manualActionRequired: true,
                      manualActionReason: "meet-audio-choice-required",
                      manualActionMessage: "Choose the Meet microphone path manually.",
                      title: "Meet",
                      url: MEET_URL,
                    }),
                  },
                },
              };
            }
          }
          if (command === "googlemeet.chrome") {
            return { payload: { launched: openedTab } };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    );

    const join = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
      url: MEET_URL,
    })) as { session: { id: string } };
    openedTab = true;
    nodesInvoke.mockClear();

    const status = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.status", {
      sessionId: join.session.id,
    })) as { session?: { chrome?: { health?: { manualActionRequired?: boolean } } } };

    expect(status.session?.chrome?.health?.manualActionRequired).toBe(true);
    const actCall = nodesInvoke.mock.calls.find(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "browser.proxy" && params.path === "/act";
    });
    if (!actCall) {
      throw new Error("Expected browser.proxy /act node invoke");
    }
    const actParams = requireRecord(
      requireRecord(actCall[0], "act node invoke").params,
      "act params",
    );
    expect(requireRecord(actParams.body, "act body").targetId).toBe("tab-1");
    expect(
      nodesInvoke.mock.calls.some(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        const params = requireRecord(call.params, "node invoke params");
        return call.command === "browser.proxy" && params.path === "/permissions/grant";
      }),
    ).toBe(false);
  });

  it("retries caption enable until the captions button is available", async () => {
    const makeButton = (label: string) => ({
      disabled: false,
      innerText: "",
      textContent: "",
      click: vi.fn(),
      getAttribute: vi.fn((name: string) => (name === "aria-label" ? label : null)),
    });
    const leaveButton = makeButton("Leave call");
    const captionButton = makeButton("Turn on captions");
    const page = {
      buttons: [leaveButton],
    };
    const windowState: Record<string, unknown> = {};
    const document = {
      body: { innerText: "", textContent: "" },
      title: "Meet",
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === "button") {
          return page.buttons;
        }
        if (selector === "input") {
          return [];
        }
        return [];
      }),
    };
    const context = createContext({
      Date,
      JSON,
      String,
      crypto: { randomUUID: () => "caption-epoch" },
      document,
      location: {
        href: MEET_URL,
        hostname: "meet.google.com",
      },
      MutationObserver: class {
        observe = vi.fn();
      },
      window: windowState,
    });
    const inspect = new Script(
      `(${await captureMeetStatusScript({
        autoJoin: false,
        captionSessionId: "session-1",
        mode: "transcribe",
      })})`,
    ).runInContext(context) as () => string | Promise<string>;

    const first = JSON.parse(await inspect()) as { captionsEnabledAttempted?: boolean };
    const captionsStateKey = "__openclawMeetCaptions";
    const stateAfterFirst = windowState[captionsStateKey] as {
      enabledAttempted?: boolean;
    };
    expect(first.captionsEnabledAttempted).toBe(false);
    expect(stateAfterFirst.enabledAttempted).toBe(false);
    expect(captionButton.click).not.toHaveBeenCalled();

    page.buttons = [leaveButton, captionButton];
    const second = JSON.parse(await inspect()) as { captionsEnabledAttempted?: boolean };
    const stateAfterSecond = windowState[captionsStateKey] as {
      enabledAttempted?: boolean;
    };
    expect(second.captionsEnabledAttempted).toBe(true);
    expect(stateAfterSecond.enabledAttempted).toBe(true);
    expect(captionButton.click).toHaveBeenCalledTimes(1);
  });

  it("coalesces progressive captions and ignores end phrases while still in call", async () => {
    const leaveButton = {
      disabled: false,
      innerText: "",
      textContent: "",
      click: vi.fn(),
      getAttribute: vi.fn((name: string) => (name === "aria-label" ? "Leave call" : null)),
    };
    const page = { caption: "Alice\nmeeting ended", visible: true };
    const makeRegion = () => ({
      get innerText() {
        return page.caption;
      },
      get textContent() {
        return page.caption;
      },
    });
    let region = makeRegion();
    const windowState: Record<string, unknown> = {};
    const disconnectObserver = vi.fn();
    const clearCaptionTimer = vi.fn();
    let settleCaption: (() => void) | undefined;
    const randomUUID = vi
      .fn()
      .mockReturnValueOnce("epoch-1")
      .mockReturnValueOnce("epoch-2")
      .mockReturnValueOnce("epoch-3");
    const document = {
      body: { innerText: "meeting ended", textContent: "meeting ended" },
      title: "Meet",
      querySelector: vi.fn((selector: string) =>
        selector.includes("aria-live") && page.visible ? region : null,
      ),
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === "button") {
          return [leaveButton];
        }
        if (selector === "input") {
          return [];
        }
        if (selector.includes("aria-live")) {
          return page.visible ? [region] : [];
        }
        return [];
      }),
    };
    const context = createContext({
      Date,
      JSON,
      clearTimeout: clearCaptionTimer,
      setTimeout: (callback: () => void) => {
        settleCaption = callback;
        return 1;
      },
      String,
      URL,
      crypto: { randomUUID },
      document,
      location: { href: MEET_URL, hostname: "meet.google.com" },
      MutationObserver: class {
        observe = vi.fn();
        disconnect = disconnectObserver;
      },
      window: windowState,
    });
    const inspect = new Script(
      `(${await captureMeetStatusScript({
        autoJoin: false,
        captionSessionId: "session-1",
        mode: "transcribe",
      })})`,
    ).runInContext(context) as () => string | Promise<string>;

    const first = JSON.parse(await inspect()) as { leaveReason?: string };
    expect(first.leaveReason).toBeUndefined();
    page.caption = "Alice\nmeeting ended after the recap";
    await inspect();
    const state = windowState["__openclawMeetCaptions"] as {
      epoch: string;
      lines: Array<{ text: string }>;
      visible: Array<{ text: string }>;
    };
    expect(state.lines).toEqual([]);
    expect(state.visible.map((line) => line.text)).toEqual(["meeting ended after the recap"]);
    region = makeRegion();
    await inspect();
    expect(state.visible).toHaveLength(1);

    page.visible = false;
    await inspect();
    page.visible = true;
    await inspect();
    expect(clearCaptionTimer).toHaveBeenCalledWith(1);
    expect(state.lines).toEqual([]);

    page.visible = false;
    await inspect();
    settleCaption?.();
    page.visible = true;
    await inspect();
    expect(state.lines.map((line) => line.text)).toEqual(["meeting ended after the recap"]);
    expect(state.visible.map((line) => line.text)).toEqual(["meeting ended after the recap"]);
    const readTranscript = async (sessionId: string, finalize: boolean) =>
      new Script(`(${await captureMeetTranscriptScript(sessionId, finalize)})`).runInContext(
        context,
      ) as () => string;
    const beforeFinalize = JSON.parse((await readTranscript("session-1", false))()) as {
      lines: unknown[];
    };
    expect(beforeFinalize.lines).toHaveLength(1);
    const afterFinalize = JSON.parse((await readTranscript("session-1", true))()) as {
      lines: unknown[];
    };
    expect(afterFinalize.lines).toHaveLength(2);

    delete windowState["__openclawMeetCaptions"];
    await inspect();
    const reloadedState = windowState["__openclawMeetCaptions"] as { epoch: string };
    expect(reloadedState.epoch).not.toBe(state.epoch);

    const inspectNextSession = new Script(
      `(${await captureMeetStatusScript({
        autoJoin: false,
        captionSessionId: "session-2",
        mode: "transcribe",
      })})`,
    ).runInContext(context) as () => string | Promise<string>;
    await inspectNextSession();
    const nextState = windowState["__openclawMeetCaptions"] as {
      droppedLines: number;
      epoch: string;
      sessionId?: string;
      lines: Array<{ text: string }>;
      visible: Array<{ text: string }>;
    };
    expect(nextState.sessionId).toBe("session-2");
    expect(nextState.epoch).not.toBe(state.epoch);
    expect(nextState.lines).toEqual([]);
    expect(nextState.visible.map((line) => line.text)).toEqual(["meeting ended after the recap"]);
    expect(disconnectObserver).toHaveBeenCalledTimes(1);
    expect(JSON.parse((await readTranscript("session-1", false))())).toMatchObject({
      sessionMatched: false,
    });

    nextState.lines = Array.from({ length: 2_000 }, (_, index) => ({ text: `line-${index}` }));
    nextState.visible = [];
    page.caption = "Alice\nline-2000";
    await inspectNextSession();
    (await readTranscript("session-2", true))();
    expect(nextState.lines).toHaveLength(2_000);
    expect(nextState.lines[0]?.text).toBe("line-1");
    expect(nextState.lines.at(-1)?.text).toBe("line-2000");
    expect(nextState.droppedLines).toBe(1);
  });

  it("reports in-call Meet audio permission problems from button labels", async () => {
    const makeButton = (label: string) => ({
      disabled: false,
      innerText: "",
      textContent: "",
      click: vi.fn(),
      getAttribute: vi.fn((name: string) => (name === "aria-label" ? label : null)),
    });
    const document = {
      body: { innerText: "", textContent: "" },
      title: "Meet",
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === "button") {
          return [
            makeButton("Leave call"),
            makeButton("Microphone problem. Show more info"),
            makeButton("Microphone: Permission needed"),
            makeButton("Speaker: Permission needed"),
          ];
        }
        if (selector === "input") {
          return [];
        }
        return [];
      }),
    };
    const context = createContext({
      crypto: { randomUUID: () => "audio-permission-epoch" },
      JSON,
      document,
      location: {
        href: MEET_URL,
        hostname: "meet.google.com",
      },
      MutationObserver: class {
        observe = vi.fn();
      },
      window: {},
    });
    const inspect = new Script(
      `(${await captureMeetStatusScript({
        autoJoin: false,
        mode: "agent",
      })})`,
    ).runInContext(context) as () => string | Promise<string>;

    const result = JSON.parse(await inspect()) as {
      inCall?: boolean;
      manualActionRequired?: boolean;
      manualActionReason?: string;
      manualActionMessage?: string;
    };

    expect(result.inCall).toBe(true);
    expect(result.manualActionRequired).toBe(true);
    expect(result.manualActionReason).toBe("meet-permission-required");
    expect(result.manualActionMessage).toContain("Allow microphone/camera/speaker permissions");
  });

  it("does not auto-join when Meet is already active elsewhere", async () => {
    const joinElsewhere = {
      disabled: false,
      innerText: "Join here too",
      textContent: "Join here too",
      click: vi.fn(),
      getAttribute: vi.fn(() => null),
    };
    const document = {
      body: { innerText: "", textContent: "" },
      title: "Meet",
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === "button") {
          return [joinElsewhere];
        }
        return [];
      }),
    };
    const context = createContext({
      JSON,
      document,
      location: {
        href: MEET_URL_EN,
        hostname: "meet.google.com",
      },
      window: {},
    });
    const inspect = new Script(
      `(${await captureMeetStatusScript({
        autoJoin: true,
        mode: "transcribe",
      })})`,
    ).runInContext(context) as () => string | Promise<string>;

    const result = JSON.parse(await inspect()) as {
      clickedJoin?: boolean;
      manualActionReason?: string;
    };

    expect(result.clickedJoin).toBe(false);
    expect(result.manualActionReason).toBe("meet-session-conflict");
    expect(joinElsewhere.click).not.toHaveBeenCalled();
  });

  it("uses the local Meet microphone control instead of remote participant mute buttons", async () => {
    const makeButton = (label: string, disabled = false) => ({
      disabled,
      innerText: "",
      textContent: "",
      click: vi.fn(),
      getAttribute: vi.fn((name: string) => (name === "aria-label" ? label : null)),
    });
    const remoteMute = makeButton("You can't remotely mute Peter Steinberger's microphone", true);
    const localMic = makeButton("Turn on microphone");
    const document = {
      body: { innerText: "", textContent: "" },
      title: "Meet",
      querySelector: vi.fn(() => null),
      querySelectorAll: vi.fn((selector: string) => {
        if (selector === "button") {
          return [makeButton("Leave call"), remoteMute, localMic];
        }
        if (selector === "input") {
          return [];
        }
        return [];
      }),
    };
    const context = createContext({
      crypto: { randomUUID: () => "microphone-control-epoch" },
      JSON,
      document,
      location: {
        href: MEET_URL,
        hostname: "meet.google.com",
      },
      MutationObserver: class {
        observe = vi.fn();
      },
      window: {},
    });
    const inspect = new Script(
      `(${await captureMeetStatusScript({
        autoJoin: false,
        mode: "agent",
      })})`,
    ).runInContext(context) as () => string | Promise<string>;

    const result = JSON.parse(await inspect()) as { micMuted?: boolean; notes?: string[] };

    expect(result.micMuted).toBe(true);
    expect(localMic.click).toHaveBeenCalledTimes(1);
    expect(remoteMute.click).not.toHaveBeenCalled();
    expect(result.notes).toContain("Attempted to turn on the Meet microphone for talk-back mode.");
  });

  it("blocks realtime speech while the Meet microphone remains muted", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      mockLocalMeetBrowserRequest(meetBrowserState({ micMuted: true }));
      const { methods } = setup({
        realtime: { introMessage: "" },
        chrome: {
          audioBridgeCommand: ["bridge", "start"],
          waitForInCallMs: 1,
        },
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: MEET_URL },
        respond,
      });

      const payload = requireRespondPayload(respond, "join response payload");
      expect(payload.spoken).toBe(false);
      const session = requireRecord(payload.session, "join session");
      const chrome = requireRecord(session.chrome, "join chrome session");
      const health = requireRecord(chrome.health, "join chrome health");
      expect(health.micMuted).toBe(true);
      expect(health.speechReady).toBe(false);
      expect(health.speechBlockedReason).toBe("meet-microphone-muted");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("blocks realtime speech while the Meet microphone state is unknown", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      mockLocalMeetBrowserRequest({
        inCall: true,
        title: "Meet call",
        url: MEET_URL,
      });
      const { methods } = setup({
        realtime: { introMessage: "" },
        chrome: {
          audioBridgeCommand: ["bridge", "start"],
          waitForInCallMs: 1,
        },
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: MEET_URL },
        respond,
      });

      const payload = requireRespondPayload(respond, "join response payload");
      expect(payload.spoken).toBe(false);
      const session = requireRecord(payload.session, "join session");
      const chrome = requireRecord(session.chrome, "join chrome session");
      const health = requireRecord(chrome.health, "join chrome health");
      expect(health.micMuted).toBeUndefined();
      expect(health.speechReady).toBe(false);
      expect(health.speechBlockedReason).toBe("browser-unverified");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("keeps waiting while the Meet microphone is muted during intro readiness", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      let inspectCount = 0;
      mockLocalMeetBrowserRequest(() => {
        inspectCount += 1;
        return meetBrowserState({ micMuted: true });
      });
      const { methods } = setup({
        chrome: {
          audioBridgeCommand: ["bridge", "start"],
          waitForInCallMs: 10,
        },
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: MEET_URL },
        respond,
      });

      const payload = requireRespondPayload(respond, "join response payload");
      expect(payload.spoken).toBe(false);
      const session = requireRecord(payload.session, "join session");
      const chrome = requireRecord(session.chrome, "join chrome session");
      const health = requireRecord(chrome.health, "join chrome health");
      expect(health.micMuted).toBe(true);
      expect(health.speechReady).toBe(false);
      expect(health.speechBlockedReason).toBe("meet-microphone-muted");
      expect(inspectCount).toBeGreaterThanOrEqual(2);
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it.each([
    {
      state: "muted",
      browser: meetBrowserState({ micMuted: true }),
      reason: "meet-microphone-muted",
    },
    {
      state: "unknown",
      browser: {
        inCall: true,
        title: "Meet call",
        url: MEET_URL,
      },
      reason: "browser-unverified",
    },
  ])(
    "keeps the paired-node audio bridge stopped while the microphone is $state",
    async ({ browser, reason }) => {
      const { methods, nodesInvoke } = setup(
        {
          defaultTransport: "chrome-node",
          defaultMode: "agent",
          realtime: { introMessage: "" },
          chrome: { waitForInCallMs: 1 },
        },
        {
          browserActResult: browser,
          nodesInvokeResult: {
            payload: { launched: true, audioBridge: { type: "external-command" } },
          },
        },
      );
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: MEET_URL },
        respond,
      });

      const startCalls = nodesInvoke.mock.calls.filter(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        const params = requireRecord(call.params, "node invoke params");
        return call.command === "googlemeet.chrome" && params.action === "start";
      });
      expect(startCalls).toHaveLength(0);
      const payload = requireRespondPayload(respond, "join response payload");
      const session = requireRecord(payload.session, "join session");
      const chrome = requireRecord(session.chrome, "join chrome session");
      const health = requireRecord(chrome.health, "join chrome health");
      expect(health.speechReady).toBe(false);
      expect(health.speechBlockedReason).toBe(reason);
    },
  );

  it("starts the paired-node audio bridge after an explicit unmuted observation", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "agent",
        realtime: { introMessage: "" },
      },
      {
        browserActResult: meetBrowserState(),
        nodesInvokeResult: {
          payload: { launched: true, audioBridge: { type: "external-command" } },
        },
      },
    );
    const handler = methods.get("googlemeet.join") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({
      params: { url: MEET_URL },
      respond,
    });

    const startCalls = nodesInvoke.mock.calls.filter(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "googlemeet.chrome" && params.action === "start";
    });
    expect(startCalls).toHaveLength(1);
    const payload = requireRespondPayload(respond, "join response payload");
    const session = requireRecord(payload.session, "join session");
    const chrome = requireRecord(session.chrome, "join chrome session");
    expect(requireRecord(chrome.audioBridge, "join audio bridge").type).toBe("external-command");
    const health = requireRecord(chrome.health, "join chrome health");
    expect(health.speechReady).toBe(true);
  });

  it("preserves the paired-node bridge for an externally managed Meet session", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "agent",
        realtime: { introMessage: "" },
        chrome: { launch: false },
      },
      {
        nodesInvokeResult: {
          payload: { launched: true, audioBridge: { type: "external-command" } },
        },
      },
    );
    const handler = methods.get("googlemeet.join") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({
      params: { url: MEET_URL },
      respond,
    });

    const startCalls = nodesInvoke.mock.calls.filter(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "googlemeet.chrome" && params.action === "start";
    });
    expect(startCalls).toHaveLength(1);
    expect(
      nodesInvoke.mock.calls.some(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        return call.command === "browser.proxy";
      }),
    ).toBe(false);
    const payload = requireRespondPayload(respond, "join response payload");
    const session = requireRecord(payload.session, "join session");
    const chrome = requireRecord(session.chrome, "join chrome session");
    expect(requireRecord(chrome.audioBridge, "join audio bridge").type).toBe("external-command");
  });

  it("joins Chrome on a paired node without local Chrome or BlackHole", async () => {
    const { methods, nodesList, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
        chromeNode: { node: "parallels-macos" },
      },
      {
        nodesInvokeResult: { payload: { launched: true } },
      },
    );
    const handler = methods.get("googlemeet.join") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({
      params: { url: MEET_URL },
      respond,
    });

    expectRespondedOk(respond);
    expect(mockCall(nodesList)).toStrictEqual([]);
    const stopCall = nodesInvoke.mock.calls.find(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "googlemeet.chrome" && params.action === "stopByUrl";
    });
    if (!stopCall) {
      throw new Error("Expected googlemeet.chrome stopByUrl node invoke");
    }
    expect(requireRecord(stopCall[0], "stop node invoke").nodeId).toBe("node-1");
    expect(requireRecord(stopCall[0], "stop node invoke").command).toBe("googlemeet.chrome");
    expect(
      requireRecord(requireRecord(stopCall[0], "stop node invoke").params, "stop params"),
    ).toEqual({
      action: "stopByUrl",
      url: MEET_URL,
      mode: "transcribe",
    });
    const openCall = nodesInvoke.mock.calls.find(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "browser.proxy" && params.path === "/tabs/open";
    });
    if (!openCall) {
      throw new Error("Expected browser.proxy /tabs/open node invoke");
    }
    expect(requireRecord(openCall[0], "open node invoke").nodeId).toBe("node-1");
    expect(requireRecord(openCall[0], "open node invoke").command).toBe("browser.proxy");
    expect(
      requireRecord(requireRecord(openCall[0], "open node invoke").params, "open params"),
    ).toEqual({
      method: "POST",
      path: "/tabs/open",
      timeoutMs: 30000,
      body: { url: MEET_URL_EN },
    });
    const startCall = nodesInvoke.mock.calls.find(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "googlemeet.chrome" && params.action === "start";
    });
    if (!startCall) {
      throw new Error("Expected googlemeet.chrome start node invoke");
    }
    expect(requireRecord(startCall[0], "start node invoke").nodeId).toBe("node-1");
    expect(requireRecord(startCall[0], "start node invoke").command).toBe("googlemeet.chrome");
    const startParams = requireRecord(
      requireRecord(startCall[0], "start node invoke").params,
      "start params",
    );
    expect(startParams.action).toBe("start");
    expect(startParams.url).toBe(MEET_URL);
    expect(startParams.mode).toBe("transcribe");
    expect(startParams.launch).toBe(false);
    expect(startParams.joinTimeoutMs).toBe(30000);
    const payload = requireRespondPayload(respond, "join response payload");
    const session = requireRecord(payload.session, "join session");
    expect(session.transport).toBe("chrome-node");
    const chrome = requireRecord(session.chrome, "join chrome session");
    expect(chrome.nodeId).toBe("node-1");
    expect(chrome.launched).toBe(true);
  });

  it("reuses an active Meet session for the same URL and transport", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesInvokeResult: {
          payload: {
            launched: true,
            browser: { inCall: true, micMuted: false },
          },
        },
      },
    );
    const handler = methods.get("googlemeet.join") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const first = vi.fn();
    const second = vi.fn();

    await handler?.({
      params: { url: MEET_URL },
      respond: first,
    });
    await handler?.({
      params: { url: MEET_URL },
      respond: second,
    });

    expect(
      nodesInvoke.mock.calls.filter(([call]) => call.command === "googlemeet.chrome"),
    ).toHaveLength(2);
    const payload = requireRespondPayload(second, "second join response payload");
    const session = requireRecord(payload.session, "second join session");
    const chrome = requireRecord(session.chrome, "second join chrome session");
    const health = requireRecord(chrome.health, "second join chrome health");
    expect(health.inCall).toBe(true);
    expect(health.micMuted).toBe(false);
    expect(session.notes).toContain("Reused existing active Meet session.");
  });

  it("reuses active Meet sessions across URL query differences", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesInvokeResult: {
          payload: {
            launched: true,
            browser: { inCall: true, micMuted: false },
          },
        },
      },
    );
    const handler = methods.get("googlemeet.join") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const first = vi.fn();
    const second = vi.fn();

    await handler?.({
      params: { url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com" },
      respond: first,
    });
    await handler?.({
      params: { url: MEET_URL },
      respond: second,
    });

    expect(
      nodesInvoke.mock.calls.filter(([call]) => call.command === "googlemeet.chrome"),
    ).toHaveLength(2);
    const payload = requireRespondPayload(second, "second join response payload");
    const session = requireRecord(payload.session, "second join session");
    expect(session.notes).toContain("Reused existing active Meet session.");
  });

  it("opens an English replacement without touching an ambiguous matching tab", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesInvokeHandler: async (params) => {
          if (params.command !== "browser.proxy") {
            return { payload: { launched: true } };
          }
          const proxy = params.params as {
            path?: string;
            body?: { targetId?: string; url?: string };
          };
          if (proxy.path === "/tabs") {
            return {
              payload: {
                result: {
                  running: true,
                  tabs: [
                    {
                      targetId: "wrong-account-english-tab",
                      title: "Meet",
                      url: "https://meet.google.com/abc-defg-hij?authuser=other%40example.com&hl=en",
                    },
                    {
                      targetId: "existing-meet-tab",
                      title: "Meet",
                      url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
                    },
                  ],
                },
              },
            };
          }
          if (proxy.path === "/tabs/open") {
            return {
              payload: {
                result: {
                  targetId: "english-meet-tab",
                  url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
                },
              },
            };
          }
          if (proxy.path === "/permissions/grant") {
            return { payload: { result: { ok: true } } };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  result: JSON.stringify({
                    inCall: true,
                    title: "Meet",
                    url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
                  }),
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const handler = methods.get("googlemeet.join") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({
      params: { url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com" },
      respond,
    });

    const openCall = nodesInvoke.mock.calls.find(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return params.path === "/tabs/open";
    });
    if (!openCall) {
      throw new Error("Expected browser.proxy /tabs/open node invoke");
    }
    expect(
      requireRecord(requireRecord(openCall[0], "open node invoke").params, "open params"),
    ).toEqual({
      method: "POST",
      path: "/tabs/open",
      timeoutMs: 30000,
      body: {
        url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
      },
    });
    expect(
      nodesInvoke.mock.calls.some(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        const params = requireRecord(call.params, "node invoke params");
        return params.path === "/tabs/focus" || params.path === "/navigate";
      }),
    ).toBe(false);
    const actCalls = nodesInvoke.mock.calls.filter(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return params.path === "/act";
    });
    expect(actCalls.length).toBeGreaterThanOrEqual(1);
    const englishTabActCall = actCalls.find(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return requireRecord(params.body, "act body").targetId === "english-meet-tab";
    });
    if (!englishTabActCall) {
      throw new Error("Expected browser.proxy /act on the English replacement tab");
    }
    expect(
      requireRecord(requireRecord(englishTabActCall[0], "act node invoke").params, "act params"),
    ).toEqual({
      method: "POST",
      path: "/act",
      timeoutMs: 10000,
      body: {
        kind: "evaluate",
        targetId: "english-meet-tab",
        fn: expect.any(String),
      },
    });
  });

  it("does not navigate a reused join tab that is already using English UI", async () => {
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesInvokeHandler: async (params) => {
          if (params.command !== "browser.proxy") {
            return { payload: { launched: true } };
          }
          const proxy = params.params as {
            path?: string;
            body?: { targetId?: string; url?: string };
          };
          if (proxy.path === "/tabs") {
            return {
              payload: {
                result: {
                  running: true,
                  tabs: [
                    {
                      targetId: "english-meet-tab",
                      title: "Meet",
                      url: MEET_URL_EN,
                    },
                  ],
                },
              },
            };
          }
          if (proxy.path === "/tabs/focus") {
            return { payload: { result: { ok: true } } };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  result: JSON.stringify({
                    inCall: true,
                    title: "Meet",
                    url: MEET_URL_EN,
                  }),
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const handler = methods.get("googlemeet.join") as
      | ((ctx: {
          params: Record<string, unknown>;
          respond: ReturnType<typeof vi.fn>;
        }) => Promise<void>)
      | undefined;
    const respond = vi.fn();

    await handler?.({
      params: { url: MEET_URL },
      respond,
    });

    expect(
      nodesInvoke.mock.calls.some(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        return requireRecord(call.params, "node invoke params").path === "/navigate";
      }),
    ).toBe(false);
    expect(
      nodesInvoke.mock.calls.some(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        return requireRecord(call.params, "node invoke params").path === "/tabs/open";
      }),
    ).toBe(false);
  });

  it("reports an ambiguous recovered Meet tab without reloading it", async () => {
    const { tools, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
      },
      {
        nodesInvokeHandler: async (params) => {
          if (params.command !== "browser.proxy") {
            throw new Error(`unexpected command ${params.command}`);
          }
          const proxy = params.params as { path?: string; body?: { targetId?: string } };
          if (proxy.path === "/tabs") {
            return {
              payload: {
                result: {
                  tabs: [
                    {
                      targetId: "existing-meet-tab",
                      title: "Meet",
                      url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
                    },
                  ],
                },
              },
            };
          }
          if (proxy.path === "/tabs/focus") {
            return { payload: { result: { ok: true } } };
          }
          if (proxy.path === "/navigate") {
            return {
              payload: {
                result: {
                  targetId: proxy.body?.targetId ?? "existing-meet-tab",
                  url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
                },
              },
            };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  result: JSON.stringify({
                    inCall: false,
                    manualActionRequired: true,
                    manualActionReason: "meet-admission-required",
                    manualActionMessage: "Admit the OpenClaw browser participant in Google Meet.",
                    title: "Meet",
                    url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
                  }),
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "recover_current_tab",
      url: MEET_URL,
    });

    expect(result.details.found).toBe(true);
    expect(result.details.targetId).toBe("existing-meet-tab");
    const browser = requireRecord(result.details.browser, "recovered browser state");
    expect(browser.manualActionRequired).toBe(true);
    expect(browser.manualActionReason).toBe("meet-locale-required");
    expect(browser.manualActionMessage).toContain("not pinned to English");
    const focusCall = nodesInvoke.mock.calls.find(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return params.path === "/tabs/focus";
    });
    if (!focusCall) {
      throw new Error("Expected browser.proxy /tabs/focus node invoke");
    }
    expect(
      requireRecord(requireRecord(focusCall[0], "focus node invoke").params, "focus params"),
    ).toEqual({
      method: "POST",
      path: "/tabs/focus",
      timeoutMs: 5000,
      body: { targetId: "existing-meet-tab" },
    });
    expect(
      nodesInvoke.mock.calls.some(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        const requestPath = requireRecord(call.params, "node invoke params").path;
        return (
          requestPath === "/tabs/open" || requestPath === "/navigate" || requestPath === "/act"
        );
      }),
    ).toBe(false);
  });

  it("prefers an English replacement when recovering matching Meet tabs", async () => {
    const { tools, nodesInvoke } = setup(
      { defaultTransport: "chrome-node" },
      {
        nodesInvokeHandler: async (params) => {
          if (params.command !== "browser.proxy") {
            throw new Error(`unexpected command ${params.command}`);
          }
          const proxy = params.params as { path?: string; body?: { targetId?: string } };
          if (proxy.path === "/tabs") {
            return {
              payload: {
                result: {
                  tabs: [
                    {
                      targetId: "wrong-account-english-tab",
                      title: "Meet",
                      url: "https://meet.google.com/abc-defg-hij?authuser=other%40example.com&hl=en",
                    },
                    {
                      targetId: "ambiguous-meet-tab",
                      title: "Meet",
                      url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com",
                    },
                    {
                      targetId: "english-meet-tab",
                      title: "Meet",
                      url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
                    },
                  ],
                },
              },
            };
          }
          if (proxy.path === "/tabs/focus") {
            return { payload: { result: { ok: true } } };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  result: JSON.stringify({
                    inCall: true,
                    title: "Meet",
                    url: MEET_URL_EN,
                  }),
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "recover_current_tab",
      url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com",
      readOnly: true,
    });

    expect(result.details.targetId).toBe("english-meet-tab");
    expect(requireRecord(result.details.browser, "recovered browser state").inCall).toBe(true);
    expect(
      nodesInvoke.mock.calls.some(([rawCall]) => {
        const call = requireRecord(rawCall, "node invoke");
        const params = requireRecord(call.params, "node invoke params");
        return (
          params.path === "/tabs/focus" &&
          requireRecord(params.body, "focus body").targetId === "english-meet-tab"
        );
      }),
    ).toBe(true);
  });

  it("preserves the Google sign-in diagnostic when no meeting tab is recoverable", async () => {
    const { tools } = setup(
      { defaultTransport: "chrome-node" },
      {
        nodesInvokeHandler: async (params) => {
          if (params.command !== "browser.proxy") {
            throw new Error(`unexpected command ${params.command}`);
          }
          const proxy = params.params as { path?: string };
          if (proxy.path === "/tabs") {
            return {
              payload: {
                result: {
                  tabs: [
                    {
                      targetId: "google-sign-in-tab",
                      title: "Sign in - Google Accounts - Meet",
                      url: "https://accounts.google.com/signin",
                    },
                  ],
                },
              },
            };
          }
          if (proxy.path === "/tabs/focus") {
            return { payload: { result: { ok: true } } };
          }
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  result: JSON.stringify({
                    inCall: false,
                    manualActionRequired: true,
                    manualActionReason: "google-login-required",
                    manualActionMessage: "Sign in to Google, then retry.",
                    url: "https://accounts.google.com/signin",
                  }),
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", { action: "recover_current_tab" });
    const browser = requireRecord(result.details.browser, "recovered browser state");
    expect(result.details.targetId).toBe("google-sign-in-tab");
    expect(browser.manualActionReason).toBe("google-login-required");
  });

  it("reports an ambiguous local Chrome Meet tab without reloading it", async () => {
    const callGatewayFromCli = vi.fn(
      async (
        _method: string,
        _opts: unknown,
        params?: unknown,
        _extra?: unknown,
      ): Promise<Record<string, unknown>> => {
        const request = params as { path?: string; body?: { targetId?: string } };
        if (request.path === "/tabs") {
          return {
            tabs: [
              {
                targetId: "local-meet-tab",
                title: "Meet",
                url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
              },
            ],
          };
        }
        if (request.path === "/tabs/focus") {
          return { ok: true };
        }
        if (request.path === "/navigate") {
          return {
            targetId: request.body?.targetId ?? "local-meet-tab",
            url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
          };
        }
        if (request.path === "/act") {
          return {
            result: JSON.stringify({
              inCall: false,
              manualActionRequired: true,
              manualActionReason: "meet-admission-required",
              manualActionMessage: "Admit the OpenClaw browser participant in Google Meet.",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?authuser=me%40example.com&hl=en",
            }),
          };
        }
        throw new Error(`unexpected browser request path ${request.path}`);
      },
    );
    localBrowserGatewayRequestHandler = async (method, params, requestOptions) =>
      await callGatewayFromCli(method, {}, params, requestOptions);
    const { tools, nodesInvoke } = setup({
      defaultTransport: "chrome",
      chrome: {
        browserProfile: "meet-devtools",
      },
    });
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "recover_current_tab",
      url: MEET_URL,
    });

    expect(result.details.transport).toBe("chrome");
    expect(result.details.found).toBe(true);
    expect(result.details.targetId).toBe("local-meet-tab");
    const browser = requireRecord(result.details.browser, "recovered browser state");
    expect(browser.manualActionRequired).toBe(true);
    expect(browser.manualActionReason).toBe("meet-locale-required");
    expect(browser.manualActionMessage).toContain("not pinned to English");
    const focusCall = callGatewayFromCli.mock.calls.find(
      (call) => requireRecord(call[2], "browser request").path === "/tabs/focus",
    );
    if (!focusCall) {
      throw new Error("Expected browser /tabs/focus request");
    }
    expect(focusCall[0]).toBe("browser.request");
    expect(requireRecord(focusCall[2], "focus request").method).toBe("POST");
    expect(requireRecord(focusCall[2], "focus request").path).toBe("/tabs/focus");
    expect(requireRecord(focusCall[2], "focus request").query).toBeUndefined();
    expect(focusCall[3]).toEqual({ timeoutMs: 10_000, scopes: ["operator.admin"] });
    expect(
      callGatewayFromCli.mock.calls.some((call) => {
        const requestPath = requireRecord(call[2], "browser request").path;
        return requestPath === "/navigate" || requestPath === "/act";
      }),
    ).toBe(false);
    expect(nodesInvoke).not.toHaveBeenCalled();
  });

  it("exposes a test-speech action that joins the requested meeting", async () => {
    const { tools, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
      },
      {
        nodesInvokeResult: {
          payload: {
            launched: true,
            browser: { inCall: true },
          },
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "test_speech",
      url: MEET_URL,
      message: "Say exactly: hello.",
    });

    const startCall = nodesInvoke.mock.calls.find(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "googlemeet.chrome" && params.action === "start";
    });
    if (!startCall) {
      throw new Error("Expected googlemeet.chrome start node invoke");
    }
    expect(result.details.createdSession).toBe(true);
  });

  it("refreshes realtime browser state in status after a delayed Meet join", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      let browserState: Record<string, unknown> = {
        inCall: false,
        title: "Meet",
        url: MEET_URL,
      };
      let opened = false;
      const callGatewayFromCli = vi.fn(
        async (
          _method: string,
          _opts: unknown,
          params?: unknown,
          _extra?: unknown,
        ): Promise<Record<string, unknown>> => {
          const request = params as {
            path?: string;
            body?: { targetId?: string; url?: string };
          };
          if (request.path === "/tabs") {
            return {
              tabs: opened
                ? [
                    {
                      targetId: "local-meet-tab",
                      title: "Meet",
                      url: MEET_URL_EN,
                    },
                  ]
                : [],
            };
          }
          if (request.path === "/tabs/open") {
            opened = true;
            return {
              targetId: "local-meet-tab",
              title: "Meet",
              url: request.body?.url ?? MEET_URL_EN,
            };
          }
          if (request.path === "/tabs/focus" || request.path === "/permissions/grant") {
            return { ok: true };
          }
          if (request.path === "/navigate") {
            return {
              targetId: request.body?.targetId ?? "local-meet-tab",
              url: request.body?.url ?? MEET_URL_EN,
            };
          }
          if (request.path === "/act") {
            return { result: JSON.stringify(browserState) };
          }
          throw new Error(`unexpected browser request path ${request.path}`);
        },
      );
      localBrowserGatewayRequestHandler = async (method, params, requestOptions) =>
        await callGatewayFromCli(method, {}, params, requestOptions);
      const { methods } = setup({
        chrome: {
          audioBridgeCommand: ["bridge", "start"],
          waitForInCallMs: 1,
        },
        realtime: { introMessage: "" },
      });
      const join = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const status = methods.get("googlemeet.status") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const joinRespond = vi.fn();
      const statusRespond = vi.fn();

      await join?.({
        params: { url: MEET_URL },
        respond: joinRespond,
      });
      const joinPayload = requireRespondPayload(joinRespond, "join response payload");
      const joinSession = requireRecord(joinPayload.session, "join session");
      const joinChrome = requireRecord(joinSession.chrome, "join chrome session");
      expect(requireRecord(joinChrome.health, "join chrome health").inCall).toBe(false);
      browserState = {
        inCall: true,
        micMuted: false,
        title: "Meet",
        url: MEET_URL,
      };
      await status?.({ params: {}, respond: statusRespond });

      const statusPayload = requireRespondPayload(statusRespond, "status response payload");
      const sessions = statusPayload.sessions as unknown[];
      expect(sessions).toHaveLength(1);
      const statusSession = requireRecord(sessions[0], "status session");
      const statusChrome = requireRecord(statusSession.chrome, "status chrome session");
      const statusHealth = requireRecord(statusChrome.health, "status chrome health");
      expect(statusHealth.inCall).toBe(true);
      expect(statusHealth.speechReady).toBe(false);
      expect(statusHealth.speechBlockedReason).toBe("audio-bridge-unavailable");
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("exposes a test-listen action that proves transcript movement", async () => {
    const { tools, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
      },
      {
        browserActResult: {
          inCall: true,
          captioning: true,
          transcriptLines: 1,
          lastCaptionText: "hello from the meeting",
          title: "Meet call",
          url: MEET_URL,
        },
        nodesInvokeResult: {
          payload: {
            launched: true,
          },
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "test_listen",
      url: MEET_URL,
      timeoutMs: "100",
    });

    const startCall = nodesInvoke.mock.calls.find(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "googlemeet.chrome" && params.action === "start";
    });
    if (!startCall) {
      throw new Error("Expected googlemeet.chrome start node invoke");
    }
    const startParams = requireRecord(
      requireRecord(startCall[0], "start node invoke").params,
      "start params",
    );
    expect(startParams.mode).toBe("transcribe");
    expect(result.details.listenVerified).toBe(true);
    expect(result.details.transcriptLines).toBe(1);
  });

  it("rejects fractional test-listen gateway timeouts", async () => {
    const { methods } = setup({ defaultTransport: "chrome-node" });

    await expect(
      invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.testListen", {
        url: MEET_URL,
        timeoutMs: "100.5",
      }),
    ).rejects.toThrow("timeoutMs must be a positive integer");
  });

  it("does not start a second realtime response for test speech", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const session = meetSession({
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: { audioOutputActive: true, lastOutputBytes: 10 },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([session]);
    const join = vi.spyOn(runtime, "join").mockResolvedValue({ session, spoken: true });
    const speak = vi.spyOn(runtime, "speak");

    const result = await runtime.testSpeech({
      url: MEET_URL,
      message: "Say exactly: hello.",
    });

    expect(join).toHaveBeenCalledTimes(1);
    const joinArgs = requireRecord(mockCallArg(join, 0), "test speech join args");
    expect(joinArgs.message).toBe("Say exactly: hello.");
    expect(joinArgs.mode).toBe("agent");
    expect(speak).not.toHaveBeenCalled();
    expect(result.spoken).toBe(true);
    expect(result.speechOutputVerified).toBe(false);
    expect(result.speechOutputTimedOut).toBe(false);
  });

  it("uses the requested bidirectional realtime mode for test speech", async () => {
    const runtime = meetRuntime({ defaultMode: "agent" }, noopLogger);
    const session = meetSession({
      mode: "bidi",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: { audioOutputActive: true, lastOutputBytes: 10 },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([]);
    const join = vi.spyOn(runtime, "join").mockResolvedValue({ session, spoken: true });

    await runtime.testSpeech({
      url: MEET_URL,
      mode: "bidi",
      message: "Say exactly: hello.",
    });

    expect(join).toHaveBeenCalledTimes(1);
    const joinArgs = requireRecord(mockCallArg(join, 0), "test speech join args");
    expect(joinArgs.message).toBe("Say exactly: hello.");
    expect(joinArgs.mode).toBe("bidi");
  });

  it("resets test speech output and loopback baselines when another agent owns the old session", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const oldSession = meetSession({
      id: "meet_old",
      agentId: "support",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: {
          audioOutputActive: true,
          lastOutputBytes: 100,
          outputLoopbackSignalBytes: 200,
          outputGeneration: 10,
          verifiedOutputGeneration: 10,
        },
      },
    });
    const newSession = meetSession({
      id: "meet_new",
      agentId: "main",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: {
          audioOutputActive: true,
          lastOutputBytes: 1,
          outputLoopbackSignalBytes: 2,
          outputGeneration: 1,
          verifiedOutputGeneration: 1,
        },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([oldSession]);
    vi.spyOn(runtime, "join").mockResolvedValue({ session: newSession, spoken: true });

    const result = await runtime.testSpeech({
      url: MEET_URL,
      agentId: "main",
      message: "Say exactly: hello.",
    });

    expect(result.speechOutputVerified).toBe(true);
    expect(result.speechOutputTimedOut).toBe(false);
  });

  it("keeps the pre-join output and loopback baselines when reusing the same session", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const session = meetSession({
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: {
          audioOutputActive: true,
          lastOutputBytes: 10,
          outputLoopbackSignalBytes: 20,
          outputGeneration: 1,
          verifiedOutputGeneration: 1,
        },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([session]);
    vi.spyOn(runtime, "join").mockImplementation(async () => {
      session.chrome!.health!.lastOutputBytes = 11;
      session.chrome!.health!.outputLoopbackSignalBytes = 21;
      session.chrome!.health!.outputGeneration = 2;
      session.chrome!.health!.verifiedOutputGeneration = 2;
      return { session, spoken: true };
    });

    const result = await runtime.testSpeech({
      url: MEET_URL,
      message: "Say exactly: hello.",
    });

    expect(result.speechOutputVerified).toBe(true);
    expect(result.speechOutputTimedOut).toBe(false);
  });

  it("does not verify speech from fresh output bytes without fresh loopback signal", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const session = meetSession({
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: {
          audioOutputActive: true,
          lastOutputBytes: 10,
          outputLoopbackSignalBytes: 20,
          outputGeneration: 1,
          verifiedOutputGeneration: 1,
        },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([session]);
    vi.spyOn(runtime, "join").mockImplementation(async () => {
      session.chrome!.health!.lastOutputBytes = 11;
      session.chrome!.health!.outputGeneration = 2;
      return { session, spoken: true };
    });

    const result = await runtime.testSpeech({
      url: MEET_URL,
      message: "Say exactly: hello.",
    });

    expect(result.speechOutputVerified).toBe(false);
    expect(result.speechOutputTimedOut).toBe(false);
  });

  it("rejects observe-only mode for test speech", async () => {
    const runtime = meetRuntime({}, noopLogger);

    await expect(
      runtime.testSpeech({
        url: MEET_URL,
        mode: "transcribe",
      }),
    ).rejects.toThrow("test_speech requires mode: agent or bidi");
  });

  it("rejects realtime and Twilio modes for test listen", async () => {
    const runtime = meetRuntime({}, noopLogger);

    await expect(
      runtime.testListen({
        url: MEET_URL,
        mode: "agent",
      }),
    ).rejects.toThrow("test_listen requires mode: transcribe");

    await expect(
      runtime.testListen({
        url: MEET_URL,
        transport: "twilio",
      }),
    ).rejects.toThrow("test_listen supports chrome or chrome-node");
  });

  it("resets test listen transcript baselines when another agent owns the old session", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const oldSession = meetSession({
      id: "meet_old",
      mode: "transcribe",
      agentId: "support",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: { transcriptLines: 10, lastCaptionText: "old caption" },
      },
    });
    const newSession = meetSession({
      id: "meet_new",
      mode: "transcribe",
      agentId: "main",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: { transcriptLines: 1, lastCaptionText: "fresh caption" },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([oldSession]);
    vi.spyOn(runtime, "join").mockResolvedValue({ session: newSession, spoken: false });

    const result = await runtime.testListen({
      url: MEET_URL,
      agentId: "main",
    });

    expect(result.listenVerified).toBe(true);
    expect(result.listenTimedOut).toBe(false);
  });

  it("keeps the pre-join test listen baseline when reusing the same session", async () => {
    const runtime = meetRuntime({}, noopLogger);
    const session = meetSession({
      mode: "transcribe",
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: { transcriptLines: 1, lastCaptionText: "old caption" },
      },
    });
    vi.spyOn(runtime, "list").mockReturnValue([session]);
    vi.spyOn(runtime, "join").mockImplementation(async () => {
      session.chrome!.health = { transcriptLines: 2, lastCaptionText: "fresh caption" };
      return { session, spoken: false };
    });

    const result = await runtime.testListen({
      url: MEET_URL,
    });

    expect(result.listenVerified).toBe(true);
    expect(result.listenTimedOut).toBe(false);
  });

  it("preserves plugin ownership from browser create through join and leave", async () => {
    const createMeet = vi
      .spyOn(GOOGLE_MEET_PLATFORM_ADAPTER.create!, "browser")
      .mockResolvedValueOnce({
        source: "browser",
        nodeId: "meet-node",
        targetId: "created-meet-tab-a",
        openedByPlugin: true,
        meetingUri: "https://meet.google.com/drf-ihtb-pad",
      })
      .mockResolvedValueOnce({
        source: "browser",
        nodeId: "meet-node",
        targetId: "created-meet-tab-b",
        openedByPlugin: true,
        meetingUri: "https://meet.google.com/qwe-rtyu-iop",
      });
    const launchChromeMeetOnNode = vi
      .spyOn(chromeTransport, "launchChromeMeetOnNode")
      .mockResolvedValueOnce({
        nodeId: "meet-node",
        launched: true,
        tab: { targetId: "created-meet-tab-a", openedByPlugin: false },
        browser: { inCall: true, micMuted: true },
      })
      .mockResolvedValueOnce({
        nodeId: "meet-node",
        launched: true,
        tab: { targetId: "created-meet-tab-b", openedByPlugin: false },
        browser: { inCall: true, micMuted: true },
      });
    const leaveChromeMeetOnNode = vi
      .spyOn(chromeTransport, "leaveChromeMeetOnNode")
      .mockResolvedValue({ left: true, note: "left created tab" });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome-node",
          defaultMode: "transcribe",
        },
        noopLogger,
      );

      const createdA = await runtime.createViaBrowser();
      const createdB = await runtime.createViaBrowser();
      const joinedA = await runtime.join({
        url: createdA.meetingUri,
        transport: "chrome-node",
      });
      const joinedB = await runtime.join({
        url: createdB.meetingUri,
        transport: "chrome-node",
      });

      expect(joinedA.session.chrome?.browserTab).toEqual({
        targetId: "created-meet-tab-a",
        openedByPlugin: true,
      });
      expect(joinedB.session.chrome?.browserTab).toEqual({
        targetId: "created-meet-tab-b",
        openedByPlugin: true,
      });
      await runtime.leave(joinedA.session.id);
      await runtime.leave(joinedB.session.id);
      expect(leaveChromeMeetOnNode).toHaveBeenNthCalledWith(1, {
        runtime: expect.any(Object),
        nodeId: "meet-node",
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: "https://meet.google.com/drf-ihtb-pad",
        tab: { targetId: "created-meet-tab-a", openedByPlugin: true },
      });
      expect(leaveChromeMeetOnNode).toHaveBeenNthCalledWith(2, {
        runtime: expect.any(Object),
        nodeId: "meet-node",
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: "https://meet.google.com/qwe-rtyu-iop",
        tab: { targetId: "created-meet-tab-b", openedByPlugin: true },
      });
    } finally {
      leaveChromeMeetOnNode.mockRestore();
      launchChromeMeetOnNode.mockRestore();
      createMeet.mockRestore();
    }
  });

  it("stops the old Chrome bridge before reassigning a Meet tab to another agent", async () => {
    const stop = vi.fn(async () => {});
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "shared-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: false },
        audioBridge: meetAudioBridge(stop),
      })
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "shared-meet-tab", openedByPlugin: false },
        browser: { inCall: true, micMuted: false },
      });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "agent",
          realtime: { introMessage: "" },
        },
        noopLogger,
      );

      const first = await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });
      const second = await runtime.join({
        url: MEET_URL,
        agentId: "main",
      });

      expect(first.session.agentId).toBe("support");
      expect(second.session.agentId).toBe("main");
      expect(first.session.state).toBe("ended");
      expect(second.session.chrome?.browserTab).toEqual({
        targetId: "shared-meet-tab",
        openedByPlugin: true,
      });
      expect(first.session.notes).toContain(
        "Ended before the same Meet tab was reassigned to another agent.",
      );
      expect(second.session.id).not.toBe(first.session.id);
      expect(stop).toHaveBeenCalledTimes(1);
      expect(launchChromeMeet).toHaveBeenCalledTimes(2);
    } finally {
      launchChromeMeet.mockRestore();
    }
  });

  it("stops the old Chrome bridge when the same agent changes talk-back mode", async () => {
    const stop = vi.fn(async () => {});
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "shared-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: false },
        audioBridge: meetAudioBridge(stop),
      })
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "shared-meet-tab", openedByPlugin: false },
        browser: { inCall: true, micMuted: false },
      });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "agent",
          realtime: { introMessage: "" },
        },
        noopLogger,
      );
      const first = await runtime.join({
        url: MEET_URL,
        agentId: "main",
        mode: "agent",
      });

      const second = await runtime.join({
        url: MEET_URL,
        agentId: "main",
        mode: "bidi",
      });

      expect(first.session.state).toBe("ended");
      expect(second.session.mode).toBe("bidi");
      expect(second.session.chrome?.browserTab).toEqual({
        targetId: "shared-meet-tab",
        openedByPlugin: true,
      });
      expect(stop).toHaveBeenCalledOnce();
    } finally {
      launchChromeMeet.mockRestore();
    }
  });

  it("reassigns an externally managed browser participant without requiring a tracked tab", async () => {
    const stop = vi.fn(async () => {});
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: false,
        audioBridge: meetAudioBridge(stop),
      })
      .mockResolvedValueOnce({ launched: false });
    const leaveChromeMeet = vi.spyOn(chromeTransport, "leaveChromeMeet");
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "agent",
          chrome: { launch: false },
          realtime: { introMessage: "" },
        },
        noopLogger,
      );
      const first = await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });

      const second = await runtime.join({
        url: MEET_URL,
        agentId: "main",
      });

      expect(first.session.state).toBe("ended");
      expect(second.session.state).toBe("active");
      expect(stop).toHaveBeenCalledOnce();
      expect(leaveChromeMeet).not.toHaveBeenCalled();
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("reassigns an ordinary shared tab to the only compatible active session", async () => {
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "shared-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: true },
      })
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "shared-meet-tab", openedByPlugin: false },
        browser: { inCall: true, micMuted: true },
      });
    const leaveChromeMeet = vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
      left: true,
      note: "left browser",
    });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "transcribe",
        },
        noopLogger,
      );

      const first = await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });
      const second = await runtime.join({
        url: MEET_URL,
        agentId: "main",
      });

      expect(second.session.chrome?.browserTab).toEqual({
        targetId: "shared-meet-tab",
        openedByPlugin: true,
      });
      expect(first.session.state).toBe("ended");
      await Promise.all([runtime.leave(first.session.id), runtime.leave(second.session.id)]);
      expect(leaveChromeMeet).toHaveBeenCalledOnce();
      expect(leaveChromeMeet).toHaveBeenCalledWith({
        runtime: expect.any(Object),
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: MEET_URL,
        tab: { targetId: "shared-meet-tab", openedByPlugin: true },
      });
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("leaves the old tab before reassignment when tab reuse is disabled", async () => {
    const stop = vi.fn(async () => {});
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "old-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: false },
        audioBridge: meetAudioBridge(stop),
      })
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "new-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: false },
      });
    const leaveChromeMeet = vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
      left: true,
      note: "left old browser tab",
    });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "agent",
          chrome: { reuseExistingTab: false },
          realtime: { introMessage: "" },
        },
        noopLogger,
      );
      await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });

      const second = await runtime.join({
        url: MEET_URL,
        agentId: "main",
      });

      expect(stop).toHaveBeenCalledOnce();
      expect(leaveChromeMeet).toHaveBeenCalledOnce();
      expect(leaveChromeMeet).toHaveBeenCalledWith({
        runtime: expect.any(Object),
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: MEET_URL,
        tab: { targetId: "old-meet-tab", openedByPlugin: true },
      });
      expect(second.session.chrome?.browserTab?.targetId).toBe("new-meet-tab");
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("releases a retained tab when replacement launch fails", async () => {
    const stop = vi.fn(async () => {});
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "retained-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: false },
        audioBridge: meetAudioBridge(stop),
      })
      .mockRejectedValueOnce(new Error("replacement launch failed"));
    const leaveChromeMeet = vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
      left: true,
      note: "released retained tab",
    });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "agent",
          realtime: { introMessage: "" },
        },
        noopLogger,
      );
      const first = await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });

      await expect(
        runtime.join({
          url: MEET_URL,
          agentId: "main",
        }),
      ).rejects.toThrow("replacement launch failed");

      expect(first.session.state).toBe("ended");
      expect(first.session.browserLeft).toBe(true);
      expect(leaveChromeMeet).toHaveBeenCalledWith({
        runtime: expect.any(Object),
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: MEET_URL,
        tab: { targetId: "retained-meet-tab", openedByPlugin: true },
      });
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("stops the replacement bridge and retries the retained tab after cleanup fails", async () => {
    const oldStop = vi.fn(async () => {});
    const replacementStop = vi.fn(async () => {});
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "retained-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: false },
        audioBridge: meetAudioBridge(oldStop),
      })
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "replacement-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: false },
        audioBridge: meetAudioBridge(replacementStop),
      });
    const leaveChromeMeet = vi
      .spyOn(chromeTransport, "leaveChromeMeet")
      .mockResolvedValueOnce({ left: false, note: "old tab cleanup failed" })
      .mockResolvedValueOnce({ left: true, note: "replacement tab released" })
      .mockResolvedValueOnce({ left: true, note: "old tab cleanup retried" });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "agent",
          realtime: { introMessage: "" },
        },
        noopLogger,
      );
      await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });

      await expect(
        runtime.join({
          url: MEET_URL,
          agentId: "main",
        }),
      ).rejects.toThrow("Could not leave the previous Meet browser tab before reassignment.");

      expect(oldStop).toHaveBeenCalledOnce();
      expect(replacementStop).toHaveBeenCalledOnce();
      expect(leaveChromeMeet).toHaveBeenCalledTimes(3);
      expect(leaveChromeMeet).toHaveBeenNthCalledWith(2, {
        runtime: expect.any(Object),
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: MEET_URL,
        tab: { targetId: "replacement-meet-tab", openedByPlugin: true },
      });
      expect(leaveChromeMeet).toHaveBeenLastCalledWith({
        runtime: expect.any(Object),
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: MEET_URL,
        tab: { targetId: "retained-meet-tab", openedByPlugin: true },
      });
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("shares one in-flight browser leave and blocks a same-meeting join until it settles", async () => {
    let resolveBrowserLeave: ((result: { left: boolean; note: string }) => void) | undefined;
    const browserLeave = new Promise<{ left: boolean; note: string }>((resolve) => {
      resolveBrowserLeave = resolve;
    });
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "leaving-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: true },
      })
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "replacement-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: true },
      });
    const leaveChromeMeet = vi
      .spyOn(chromeTransport, "leaveChromeMeet")
      .mockReturnValue(browserLeave);
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "transcribe",
        },
        noopLogger,
      );
      const joined = await runtime.join({ url: MEET_URL });

      const firstLeave = runtime.leave(joined.session.id);
      const secondLeave = runtime.leave(joined.session.id);
      const replacementJoin = runtime.join({
        url: MEET_URL,
        agentId: "support",
      });
      await vi.waitFor(() => {
        expect(leaveChromeMeet).toHaveBeenCalledOnce();
      });
      expect(launchChromeMeet).toHaveBeenCalledOnce();
      resolveBrowserLeave?.({ left: false, note: "browser leave failed" });

      const [firstResult, secondResult, replacement] = await Promise.all([
        firstLeave,
        secondLeave,
        replacementJoin,
      ]);
      expect(firstResult.browserLeft).toBe(false);
      expect(secondResult.browserLeft).toBe(false);
      expect(replacement.session.chrome?.browserTab?.targetId).toBe("replacement-meet-tab");
      expect(launchChromeMeet).toHaveBeenCalledTimes(2);
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("does not let a leave tear down a tab while another session adopts it", async () => {
    let resolveReplacementLaunch:
      | ((result: {
          launched: true;
          tab: { targetId: string; openedByPlugin: boolean };
          browser: { inCall: true; micMuted: true };
        }) => void)
      | undefined;
    const replacementLaunch = new Promise<{
      launched: true;
      tab: { targetId: string; openedByPlugin: boolean };
      browser: { inCall: true; micMuted: true };
    }>((resolve) => {
      resolveReplacementLaunch = resolve;
    });
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        tab: { targetId: "shared-meet-tab", openedByPlugin: true },
        browser: { inCall: true, micMuted: true },
      })
      .mockReturnValueOnce(replacementLaunch);
    const leaveChromeMeet = vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
      left: true,
      note: "left browser",
    });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "transcribe",
        },
        noopLogger,
      );
      const first = await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });

      const replacement = runtime.join({
        url: MEET_URL,
        agentId: "main",
      });
      await vi.waitFor(() => {
        expect(launchChromeMeet).toHaveBeenCalledTimes(2);
      });
      const oldLeave = runtime.leave(first.session.id);
      await Promise.resolve();
      expect(leaveChromeMeet).not.toHaveBeenCalled();

      resolveReplacementLaunch?.({
        launched: true,
        tab: { targetId: "shared-meet-tab", openedByPlugin: false },
        browser: { inCall: true, micMuted: true },
      });
      const adopted = await replacement;
      await oldLeave;

      expect(adopted.session.chrome?.browserTab).toEqual({
        targetId: "shared-meet-tab",
        openedByPlugin: true,
      });
      expect(leaveChromeMeet).not.toHaveBeenCalled();

      await runtime.leave(adopted.session.id);
      expect(leaveChromeMeet).toHaveBeenCalledOnce();
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("still leaves the browser when the Chrome bridge stop fails", async () => {
    const stop = vi.fn(async () => {
      throw new Error("bridge stop failed");
    });
    const launchChromeMeet = vi.spyOn(chromeTransport, "launchChromeMeet").mockResolvedValue({
      launched: true,
      tab: { targetId: "meet-tab", openedByPlugin: true },
      browser: { inCall: true, micMuted: false },
      audioBridge: meetAudioBridge(stop),
    });
    const leaveChromeMeet = vi.spyOn(chromeTransport, "leaveChromeMeet").mockResolvedValue({
      left: true,
      note: "left browser",
    });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "agent",
          realtime: { introMessage: "" },
        },
        noopLogger,
      );
      const joined = await runtime.join({ url: MEET_URL });

      await expect(runtime.leave(joined.session.id)).rejects.toThrow("bridge stop failed");

      expect(leaveChromeMeet).toHaveBeenCalledWith({
        runtime: expect.any(Object),
        config: expect.any(Object),
        meetingSessionId: expect.any(String),
        meetingUrl: MEET_URL,
        tab: { targetId: "meet-tab", openedByPlugin: true },
      });
      expect(joined.session.state).toBe("ended");
    } finally {
      leaveChromeMeet.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("reuses the stored session agent when a later Chrome bridge starts", async () => {
    const launchChromeMeet = vi
      .spyOn(chromeTransport, "launchChromeMeet")
      .mockResolvedValueOnce({
        launched: true,
        browser: { inCall: false, micMuted: false },
      })
      .mockResolvedValueOnce({
        launched: false,
        audioBridge: { type: "external-command" },
      });
    const recoverCurrentMeetTab = vi
      .spyOn(chromeTransport, "recoverCurrentMeetTab")
      .mockResolvedValue({
        transport: "chrome",
        found: true,
        message: "Existing Meet tab is in-call.",
        browser: { inCall: true, micMuted: false },
      });
    try {
      const runtime = meetRuntime(
        {
          defaultTransport: "chrome",
          defaultMode: "agent",
          realtime: { introMessage: "" },
        },
        noopLogger,
      );

      const joined = await runtime.join({
        url: MEET_URL,
        agentId: "support",
      });
      await runtime.speak(joined.session.id, "Say exactly: hello.");

      const delayedBridgeParams = requireRecord(
        mockCallArg(launchChromeMeet, 0, 1),
        "delayed bridge launch params",
      );
      const delayedBridgeConfig = requireRecord(
        delayedBridgeParams.config,
        "delayed bridge config",
      );
      const delayedRealtime = requireRecord(
        delayedBridgeConfig.realtime,
        "delayed bridge realtime config",
      );
      expect(joined.session.agentId).toBe("support");
      expect(delayedRealtime.agentId).toBe("support");
    } finally {
      recoverCurrentMeetTab.mockRestore();
      launchChromeMeet.mockRestore();
    }
  });

  it("reports manual action when the browser profile needs Google login", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
      },
      {
        browserActResult: {
          inCall: false,
          manualActionRequired: true,
          manualActionReason: "google-login-required",
          manualActionMessage:
            "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.",
          title: "Sign in - Google Accounts",
          url: "https://accounts.google.com/signin",
        },
        nodesInvokeResult: {
          payload: {
            launched: true,
          },
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "test_speech",
      url: MEET_URL,
      message: "Say exactly: hello.",
    });

    expect(result.details.manualActionRequired).toBe(true);
    expect(result.details.manualActionReason).toBe("google-login-required");
    expect(result.details.spoken).toBe(false);
    expect(result.details.speechReady).toBe(false);
    expect(result.details.speechBlockedReason).toBe("google-login-required");
    const session = requireRecord(result.details.session, "manual action session");
    const chrome = requireRecord(session.chrome, "manual action session chrome");
    const health = requireRecord(chrome.health, "manual action chrome health");
    expect(health.manualActionRequired).toBe(true);
    expect(health.manualActionReason).toBe("google-login-required");
    expect(health.speechReady).toBe(false);
    expect(health.speechBlockedReason).toBe("google-login-required");
  });

  it("recovers paired-node talkback without reopening the tracked tab", async () => {
    let openedTab = false;
    let browserReady = false;
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "agent",
        chrome: { reuseExistingTab: false },
      },
      {
        nodesInvokeHandler: async ({ command, params }) => {
          const raw = params as { path?: string; body?: { url?: string; targetId?: string } };
          if (command === "browser.proxy") {
            if (raw.path === "/tabs") {
              return {
                payload: {
                  result: {
                    running: true,
                    tabs: openedTab
                      ? [
                          {
                            targetId: "tab-1",
                            title: "Meet",
                            url: MEET_URL_EN,
                          },
                        ]
                      : [],
                  },
                },
              };
            }
            if (raw.path === "/tabs/open") {
              openedTab = true;
              return {
                payload: {
                  result: {
                    targetId: "tab-1",
                    title: "Meet",
                    url: raw.body?.url ?? MEET_URL_EN,
                  },
                },
              };
            }
            if (raw.path === "/tabs/focus" || raw.path === "/permissions/grant") {
              return { payload: { result: { ok: true } } };
            }
            if (raw.path === "/navigate") {
              return {
                payload: {
                  result: {
                    targetId: raw.body?.targetId ?? "tab-1",
                    url: raw.body?.url ?? MEET_URL_EN,
                  },
                },
              };
            }
            if (raw.path === "/act") {
              return {
                payload: {
                  result: {
                    ok: true,
                    targetId: raw.body?.targetId ?? "tab-1",
                    result: JSON.stringify(
                      browserReady
                        ? {
                            inCall: true,
                            micMuted: false,
                            manualActionRequired: false,
                            title: "Meet call",
                            url: MEET_URL,
                          }
                        : {
                            inCall: true,
                            title: "Meet call",
                            url: MEET_URL,
                          },
                    ),
                  },
                },
              };
            }
          }
          if (command === "googlemeet.chrome") {
            return { payload: { launched: true } };
          }
          throw new Error(`unexpected invoke ${command}`);
        },
      },
    );

    const join = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
      url: MEET_URL,
      message: "Say exactly: hello.",
    })) as {
      session: { id: string; chrome?: { health?: { speechBlockedReason?: string } } };
      spoken: boolean;
    };
    expect(join.spoken).toBe(false);
    expect(join.session.chrome?.health?.speechBlockedReason).toBe("browser-unverified");

    browserReady = true;
    const retry = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.speak", {
      sessionId: join.session.id,
      message: "Say exactly: hello again.",
    })) as {
      found: boolean;
      spoken: boolean;
      session?: {
        chrome?: {
          health?: {
            inCall?: boolean;
            manualActionRequired?: boolean;
            speechBlockedReason?: string;
          };
        };
      };
    };

    expect(retry.found).toBe(true);
    expect(retry.spoken).toBe(false);
    const retrySession = requireRecord(retry.session, "retry session");
    const retryChrome = requireRecord(retrySession.chrome, "retry session chrome");
    const retryHealth = requireRecord(retryChrome.health, "retry chrome health");
    expect(retryHealth.inCall).toBe(true);
    expect(retryHealth.manualActionRequired).toBe(false);
    expect(retryHealth.speechBlockedReason).toBe("audio-bridge-unavailable");
    const nodeStartCalls = nodesInvoke.mock.calls.filter(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "googlemeet.chrome" && params.action === "start";
    });
    expect(nodeStartCalls).toHaveLength(1);
    const focusCalls = nodesInvoke.mock.calls
      .map(([call]) => call)
      .filter(
        (call): call is { command: string; params: Record<string, unknown> } =>
          call.command === "browser.proxy" &&
          isRecord(call.params) &&
          call.params.path === "/tabs/focus",
      );
    expect(focusCalls.length).toBeGreaterThan(0);
    expect(focusCalls.at(-1)?.params.body).toStrictEqual({ targetId: "tab-1" });
    const openCalls = nodesInvoke.mock.calls.filter(([rawCall]) => {
      const call = requireRecord(rawCall, "node invoke");
      const params = requireRecord(call.params, "node invoke params");
      return call.command === "browser.proxy" && params.path === "/tabs/open";
    });
    expect(openCalls).toHaveLength(1);
  });

  it("explains when chrome-node has no capable paired node", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesListResult: { nodes: [] },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
    });

    expect(result.details.error).toContain("No connected Google Meet-capable node");
    expect(result.details.error).toContain("openclaw node run");
  });

  it("requires chromeNode.node when multiple capable nodes are connected", async () => {
    const { tools } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "transcribe",
      },
      {
        nodesListResult: {
          nodes: [
            {
              nodeId: "node-1",
              displayName: "parallels-macos",
              connected: true,
              caps: ["browser"],
              commands: ["browser.proxy", "googlemeet.chrome"],
            },
            {
              nodeId: "node-2",
              displayName: "mac-studio-vm",
              connected: true,
              caps: ["browser"],
              commands: ["browser.proxy", "googlemeet.chrome"],
            },
          ],
        },
      },
    );
    const tool = getMeetTool({ tools });

    const result = await tool.execute("id", {
      action: "join",
      url: MEET_URL,
    });

    expect(result.details.error).toContain("Multiple Google Meet-capable nodes connected");
    expect(result.details.error).toContain("chromeNode.node");
  });

  it("runs configured Chrome audio bridge commands before launch", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const callGatewayFromCli = mockLocalMeetBrowserRequest();
      const { methods, runCommandWithTimeout } = setup({
        defaultMode: "bidi",
        chrome: {
          waitForInCallMs: 1,
          audioBridgeHealthCommand: ["bridge", "status"],
          audioBridgeCommand: ["bridge", "start"],
        },
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: MEET_URL },
        respond,
      });

      expectRespondedOk(respond);
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(2, ["bridge", "status"], {
        timeoutMs: 30000,
      });
      expect(runCommandWithTimeout).toHaveBeenNthCalledWith(3, ["bridge", "start"], {
        timeoutMs: 30000,
      });
      const openRequests = callGatewayFromCli.mock.calls.filter((call) => {
        const params = call[2];
        return call[0] === "browser.request" && isRecord(params) && params.path === "/tabs/open";
      });
      expect(openRequests).toHaveLength(1);
      const [method, opts, params, extra] = openRequests[0] ?? [];
      expect(method).toBe("browser.request");
      expect(isRecord(opts)).toBe(true);
      const request = requireRecord(params, "local browser open request");
      expect(request.method).toBe("POST");
      expect(request.path).toBe("/tabs/open");
      expect(request.body).toStrictEqual({ url: MEET_URL_EN });
      expect(extra).toStrictEqual({ timeoutMs: 35_000, scopes: ["operator.admin"] });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
  });

  it("uses realtime transcription plus regular TTS in Chrome agent mode", async () => {
    vi.useFakeTimers();
    let callbacks: Parameters<RealtimeTranscriptionProviderPlugin["createSession"]>[0] | undefined;
    const sendAudio = vi.fn();
    const sttSession = {
      connect: vi.fn(async () => {}),
      sendAudio,
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "gpt-4o-transcribe",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createSession: (req) => {
        callbacks = req;
        return sttSession;
      },
    };
    const inputStdout = new PassThrough();
    const outputStdinWrites: Buffer[] = [];
    const outputStdin = new Writable({
      write(chunk, _encoding, done) {
        outputStdinWrites.push(Buffer.from(chunk));
        done();
      },
    });
    const inputProcess = testBridgeProcess({ stdout: inputStdout, stdin: null });
    const outputProcess = testBridgeProcess({ stdin: outputStdin, stdout: null });
    const spawnMock = vi.fn().mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    const sessionStore: Record<string, unknown> = {};
    const runtime = {
      tts: {
        textToSpeechTelephony: vi.fn(async () => ({
          success: true,
          audioBuffer: Buffer.from([1, 0, 2, 0]),
          sampleRate: 24_000,
          provider: "elevenlabs",
          providerModel: "eleven_multilingual_v2",
          providerVoice: "pMsXgVXv3BLzUgSXRplE",
          outputFormat: "pcm16",
        })),
      },
      agent: {
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        ensureAgentWorkspace: vi.fn(async () => {}),
        session: createMockSessionRuntime(sessionStore),
        runEmbeddedAgent: vi.fn(async () => ({
          payloads: [{ text: "Use the Portugal launch data." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startTestLocalAgentAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { provider: "openai", agentId: "jay", introMessage: "" },
      }),
      fullConfig: {} as never,
      runtime: runtime as never,
      meetingSessionId: "meet-1",
      inputCommand: ["capture-meet"],
      outputCommand: ["play-meet"],
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });

    expect(noopLogger.info).toHaveBeenCalledWith(
      "[google-meet] agent audio bridge starting: transcriptionProvider=openai transcriptionModel=gpt-4o-transcribe tts=telephony audioFormat=pcm16-24khz",
    );
    inputStdout.write(Buffer.from([1, 0, 2, 0, 3, 0, 4, 0]));
    callbacks?.onTranscript?.("Please summarize the launch.");
    await vi.advanceTimersByTimeAsync(TEST_TALKBACK_DEBOUNCE_MS);

    expect(sendAudio).toHaveBeenCalledTimes(1);
    const audioChunk = mockCallArg(sendAudio, 0) as Buffer;
    expect(Buffer.isBuffer(audioChunk)).toBe(true);
    expect(audioChunk.byteLength).toBeGreaterThan(0);
    expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalled();
    expect(runtime.tts.textToSpeechTelephony).toHaveBeenCalledWith({
      text: "Use the Portugal launch data.",
      cfg: {},
    });
    expect(noopLogger.info).toHaveBeenCalledWith(
      "[google-meet] agent TTS: provider=elevenlabs model=eleven_multilingual_v2 voice=pMsXgVXv3BLzUgSXRplE outputFormat=pcm16 sampleRate=24000",
    );
    expect(Buffer.concat(outputStdinWrites)).toEqual(Buffer.from([1, 0, 2, 0]));
    const health = handle.getHealth();
    expect(health.providerConnected).toBe(true);
    expect(health.audioInputActive).toBe(true);
    expect(health.audioOutputActive).toBe(true);
    expect(health.realtimeTranscriptLines).toBe(2);
    expect(health.lastRealtimeTranscriptRole).toBe("assistant");
    const talkEventTypes = health.recentTalkEvents?.map((event) => event.type) ?? [];
    expect(talkEventTypes).toEqual([
      "session.started",
      "session.ready",
      "turn.started",
      "input.audio.delta",
      "input.audio.committed",
      "transcript.done",
      "output.text.done",
      "output.audio.started",
      "output.audio.delta",
      "output.audio.done",
      "turn.ended",
    ]);
    expect(talkEventTypes.indexOf("output.text.done")).toBeLessThan(
      talkEventTypes.indexOf("output.audio.started"),
    );
    await handle.stop();
  });

  it("closes output and turn lifecycle when agent audio delivery fails", async () => {
    vi.useFakeTimers();
    let callbacks: Parameters<RealtimeTranscriptionProviderPlugin["createSession"]>[0] | undefined;
    const sttSession = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "gpt-4o-transcribe",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createSession: (req) => {
        callbacks = req;
        return sttSession;
      },
    };
    const { transport, writeOutput } = createTestMeetRealtimeAudioTransport();
    writeOutput.mockRejectedValueOnce(new Error("audio sink failed"));
    const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const handle = await startMeetingAgentRealtimeEngine({
      config: resolveGoogleMeetConfig({
        realtime: { provider: "openai", agentId: "jay", introMessage: "" },
      }),
      fullConfig: {} as never,
      runtime: {
        tts: {
          textToSpeechTelephony: vi.fn(async () => ({
            success: true,
            audioBuffer: Buffer.from([1, 0, 2, 0]),
            sampleRate: 24_000,
            provider: "test",
            outputFormat: "pcm16",
          })),
        },
      } as never,
      platform: {
        displayName: "Google Meet",
        logScope: "[google-meet]",
        sessionIdPrefix: "google-meet",
      },
      meetingSessionId: "meet-output-failure",
      transport,
      logger,
      providers: [provider],
      consultAgent: async () => ({ text: "Answer from the agent." }),
    });

    callbacks?.onTranscript?.("Question from the meeting.");
    await vi.advanceTimersByTimeAsync(TEST_TALKBACK_DEBOUNCE_MS);
    await vi.waitFor(() => {
      expect(logger.warn).toHaveBeenCalledWith("[google-meet] agent TTS failed: audio sink failed");
    });

    expect(handle.getHealth().recentTalkEvents?.map((event) => event.type)).toEqual([
      "session.started",
      "session.ready",
      "turn.started",
      "input.audio.committed",
      "transcript.done",
      "output.text.done",
      "output.audio.started",
      "output.audio.delta",
      "output.audio.done",
      "turn.ended",
    ]);
    await handle.stop();
  });

  it("aborts agent engine startup when the transport already failed", async () => {
    const createSession = vi.fn();
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "gpt-4o-transcribe",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createSession,
    };
    const stop = vi.fn(async () => {});
    const config = resolveGoogleMeetConfig({
      realtime: { provider: "openai", agentId: "jay", introMessage: "" },
    });
    await expect(
      startMeetingAgentRealtimeEngine({
        config,
        fullConfig: {} as never,
        runtime: {} as never,
        ...createGoogleMeetTestEngineBindings({
          config,
          fullConfig: {} as never,
          runtime: {} as never,
          logger: noopLogger,
        }),
        meetingSessionId: "meet-fatal",
        logger: noopLogger,
        providers: [provider],
        transport: {
          // Pre-registration fatal replays synchronously; startup must abort before createSession.
          onFatal: (handler) => handler(),
          startInput: vi.fn(),
          stop,
          writeOutput: vi.fn(async () => {}),
          clearOutput: vi.fn(async () => {}),
          dispose: vi.fn(async () => {}),
        },
      }),
    ).rejects.toThrow("transport failed before transcription provider setup");
    expect(createSession).not.toHaveBeenCalled();
    expect(stop).toHaveBeenCalled();
  });

  it("stops the Chrome agent audio bridge when child stdio streams error", async () => {
    const sttSession = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeTranscriptionProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "gpt-4o-transcribe",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createSession: () => sttSession,
    };
    const inputStdout = new PassThrough();
    const inputStderr = new PassThrough();
    const outputStderr = new PassThrough();
    const outputStdin = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const outputProcess = testBridgeProcess({
      stdin: outputStdin,
      stdout: null,
      stderr: outputStderr,
    });
    const inputProcess = testBridgeProcess({
      stdin: null,
      stdout: inputStdout,
      stderr: inputStderr,
    });
    const spawnMock = vi.fn().mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);

    const handle = await startTestLocalAgentAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { provider: "openai", agentId: "jay", introMessage: "" },
      }),
      fullConfig: {} as never,
      runtime: {} as never,
      meetingSessionId: "meet-1",
      inputCommand: ["capture-meet"],
      outputCommand: ["play-meet"],
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });

    expect(() => inputStdout.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(noopLogger.warn).toHaveBeenCalledWith(
      "[google-meet] audio input command stdout failed: EPIPE",
    );
    expect(handle.getHealth().bridgeClosed).toBe(true);
    expect(sttSession.close).toHaveBeenCalled();
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");

    expect(() => inputStderr.emit("error", new Error("stderr EPIPE"))).not.toThrow();
    expect(() => outputStderr.emit("error", new Error("output EPIPE"))).not.toThrow();
    expect(noopLogger.warn).toHaveBeenCalledWith(
      "[google-meet] audio input command stderr failed: stderr EPIPE",
    );
    expect(noopLogger.warn).toHaveBeenCalledWith(
      "[google-meet] audio output command stderr failed: output EPIPE",
    );
  });

  it("preserves telephony TTS output formats when routing Google Meet agent audio", () => {
    const ulaw = Buffer.from([0xff, 0x7f, 0x00]);
    const pcmBridgeConfig = resolveGoogleMeetConfig({ chrome: { audioFormat: "pcm16-24khz" } });
    const ulawBridgeConfig = resolveGoogleMeetConfig({ chrome: { audioFormat: "g711-ulaw-8khz" } });

    expect(
      convertMeetingTtsAudioForBridge(
        ulaw,
        8_000,
        ulawBridgeConfig.chrome.audioFormat,
        "raw-8khz-8bit-mono-mulaw",
        "Google Meet",
      ),
    ).toEqual(ulaw);
    const pcmForMeet = convertMeetingTtsAudioForBridge(
      ulaw,
      8_000,
      pcmBridgeConfig.chrome.audioFormat,
      "ulaw_8000",
      "Google Meet",
    );
    expect(pcmForMeet.byteLength).toBe(18);
    expect(pcmForMeet).not.toEqual(ulaw);
    expect(() =>
      convertMeetingTtsAudioForBridge(
        Buffer.from([1, 2, 3]),
        8_000,
        pcmBridgeConfig.chrome.audioFormat,
        "mp3",
        "Google Meet",
      ),
    ).toThrow("Unsupported telephony TTS output format");
  });

  it("pipes Chrome command-pair audio through the realtime provider", async () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const sendAudio = vi.fn();
    const bridge = {
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => {}),
      sendAudio,
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      defaultModel: "gpt-realtime-2",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createBridge: (req) => {
        callbacks = req;
        return bridge;
      },
    };
    const inputStdout = new PassThrough();
    const outputStdinWrites: Buffer[] = [];
    const replacementOutputStdinWrites: Buffer[] = [];
    const outputStdin = new Writable({
      write(chunk, _encoding, done) {
        outputStdinWrites.push(Buffer.from(chunk));
        done();
      },
    });
    const replacementOutputStdin = new Writable({
      write(chunk, _encoding, done) {
        replacementOutputStdinWrites.push(Buffer.from(chunk));
        done();
      },
    });
    const inputProcess = testBridgeProcess({ stdout: inputStdout, stdin: null });
    const outputProcess = testBridgeProcess({ stdin: outputStdin, stdout: null });
    const replacementOutputProcess = testBridgeProcess({
      stdin: replacementOutputStdin,
      stdout: null,
    });
    const spawnMock = vi
      .fn()
      .mockReturnValueOnce(outputProcess)
      .mockReturnValueOnce(inputProcess)
      .mockReturnValueOnce(replacementOutputProcess);
    const fullConfig = { models: { providers: {} } } as never;
    const sessionStore: Record<string, unknown> = {};
    const runtime = {
      agent: {
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        ensureAgentWorkspace: vi.fn(async () => {}),
        session: createMockSessionRuntime(sessionStore),
        runEmbeddedAgent: vi.fn(async (_request: unknown) => ({
          payloads: [{ text: "Use the Portugal launch data." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startTestLocalRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { strategy: "bidi", provider: "openai", model: "gpt-realtime", agentId: "jay" },
      }),
      fullConfig,
      runtime: runtime as never,
      meetingSessionId: "meet-1",
      inputCommand: ["capture-meet"],
      outputCommand: ["play-meet"],
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });

    expect(noopLogger.info).toHaveBeenCalledWith(
      "[google-meet] realtime voice bridge starting: strategy=bidi provider=openai model=gpt-realtime audioFormat=pcm16-24khz",
    );
    expect(callbacks?.cfg).toBe(fullConfig);
    inputStdout.write(Buffer.from([1, 2, 3]));
    callbacks?.onAudio(Buffer.from([4, 5]));
    callbacks?.onMark?.("mark-1");
    callbacks?.onClearAudio();
    callbacks?.onAudio(Buffer.from([6, 7]));
    callbacks?.onReady?.();
    callbacks?.onTranscript?.("assistant", "How can I help you?", true);
    callbacks?.onTranscript?.("user", "Please summarize the launch.", true);
    callbacks?.onEvent?.({ direction: "client", type: "response.create" });
    callbacks?.onEvent?.({
      direction: "server",
      type: "response.done",
      detail: "status=completed",
    });
    callbacks?.onToolCall?.({
      itemId: "item-1",
      callId: "tool-call-1",
      name: "openclaw_agent_consult",
      args: { question: "What should I say about launch timing?" },
    });
    expect(bridge.submitToolResult).toHaveBeenCalled();
    const firstToolResultCall = mockCall(bridge.submitToolResult);
    expect(firstToolResultCall[0]).toBe("tool-call-1");
    expect(firstToolResultCall[2]).toStrictEqual({ willContinue: true });
    const progressPayload = requireRecord(firstToolResultCall[1], "tool progress payload");
    expect(progressPayload.status).toBe("working");
    expect(progressPayload.tool).toBe("openclaw_agent_consult");

    expect(spawnMock).toHaveBeenNthCalledWith(1, "play-meet", [], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    expect(spawnMock).toHaveBeenNthCalledWith(2, "capture-meet", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(sendAudio).toHaveBeenCalledWith(Buffer.from([1, 2, 3]));
    expect(outputStdinWrites).toEqual([Buffer.from([4, 5])]);
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGKILL");
    expect(replacementOutputStdinWrites).toEqual([Buffer.from([6, 7])]);
    outputProcess.emit("error", new Error("stale output process failed after clear"));
    outputStdin.emit("error", new Error("stale output pipe closed after clear"));
    outputProcess.stderr.emit("error", new Error("stale output stderr closed after clear"));
    expect(bridge.close).not.toHaveBeenCalled();
    expect(bridge.acknowledgeMark).toHaveBeenCalled();
    expect(bridge.triggerGreeting).not.toHaveBeenCalled();
    handle.speak("Say exactly: hello from the meeting.");
    expect(bridge.triggerGreeting).toHaveBeenLastCalledWith("Say exactly: hello from the meeting.");
    const health = handle.getHealth();
    expect(health.providerConnected).toBe(true);
    expect(health.realtimeReady).toBe(true);
    expect(health.audioInputActive).toBe(true);
    expect(health.audioOutputActive).toBe(true);
    expect(health.lastInputBytes).toBe(3);
    expect(health.lastOutputBytes).toBe(4);
    expect(health.realtimeTranscriptLines).toBe(2);
    expect(health.lastRealtimeTranscriptRole).toBe("user");
    expect(health.lastRealtimeTranscriptText).toBe("Please summarize the launch.");
    expect(health.lastRealtimeEventType).toBe("server:response.done");
    expect(health.lastRealtimeEventDetail).toBe("status=completed");
    expect(health.clearCount).toBe(1);
    expect(health.recentRealtimeTranscript).toHaveLength(2);
    expect(health.recentRealtimeTranscript?.[0]?.role).toBe("assistant");
    expect(health.recentRealtimeTranscript?.[0]?.text).toBe("How can I help you?");
    expect(health.recentRealtimeTranscript?.[1]?.role).toBe("user");
    expect(health.recentRealtimeTranscript?.[1]?.text).toBe("Please summarize the launch.");
    expect(health.recentRealtimeEvents).toHaveLength(2);
    expect(health.recentRealtimeEvents?.[0]?.direction).toBe("client");
    expect(health.recentRealtimeEvents?.[0]?.type).toBe("response.create");
    expect(health.recentRealtimeEvents?.[1]?.direction).toBe("server");
    expect(health.recentRealtimeEvents?.[1]?.type).toBe("response.done");
    expect(health.recentRealtimeEvents?.[1]?.detail).toBe("status=completed");
    if (!callbacks) {
      throw new Error("Expected realtime bridge callbacks");
    }
    expect(callbacks.audioFormat).toStrictEqual({
      encoding: "pcm16",
      sampleRateHz: 24000,
      channels: 1,
    });
    expect(callbacks.autoRespondToAudio).toBe(true);
    expect(callbacks.tools?.map((tool) => tool.name)).toContain("openclaw_agent_consult");
    await vi.waitFor(() => {
      expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
        "tool-call-1",
        {
          text: "Use the Portugal launch data.",
        },
        undefined,
      );
    });
    const talkEventTypes = handle.getHealth().recentTalkEvents?.map((event) => event.type) ?? [];
    for (const type of [
      "session.started",
      "session.ready",
      "input.audio.delta",
      "output.audio.delta",
      "output.audio.done",
      "transcript.done",
      "output.text.done",
      "tool.call",
      "tool.progress",
      "tool.result",
      "turn.ended",
    ]) {
      expect(talkEventTypes).toContain(type);
    }
    expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalledTimes(1);
    const agentRequest = requireRecord(
      mockCallArg(runtime.agent.runEmbeddedAgent, 0),
      "embedded agent request",
    );
    expect(agentRequest.messageProvider).toBe("google-meet");
    expect(agentRequest.agentId).toBe("jay");
    expect(agentRequest.spawnedBy).toBe("agent:jay:main");
    expect(agentRequest.sessionKey).toBe("agent:jay:subagent:google-meet:meet-1");
    expect(agentRequest.sandboxSessionKey).toBe("agent:jay:subagent:google-meet:meet-1");
    expect(agentRequest.thinkLevel).toBe("high");
    expect(agentRequest.toolsAllow).toStrictEqual([
      "read",
      "web_search",
      "web_fetch",
      "x_search",
      "memory_search",
      "memory_get",
    ]);
    expect(sessionStore).toHaveProperty("agent:jay:subagent:google-meet:meet-1");

    await handle.stop();
    expect(bridge.close).toHaveBeenCalled();
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(replacementOutputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("stops the Chrome realtime audio bridge when child stdout errors", async () => {
    const bridge = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const inputStdout = new PassThrough();
    const outputProcess = testBridgeProcess({
      stdin: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      stdout: null,
    });
    const inputProcess = testBridgeProcess({ stdin: null, stdout: inputStdout });
    const spawnMock = vi.fn().mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);

    const handle = await startTestLocalRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { strategy: "bidi", provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: { models: { providers: {} } } as never,
      runtime: {} as never,
      meetingSessionId: "meet-1",
      inputCommand: ["capture-meet"],
      outputCommand: ["play-meet"],
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });

    expect(() => inputStdout.emit("error", new Error("EPIPE"))).not.toThrow();
    expect(noopLogger.warn).toHaveBeenCalledWith(
      "[google-meet] audio input command stdout failed: EPIPE",
    );
    expect(handle.getHealth().bridgeClosed).toBe(true);
    await vi.waitFor(() => {
      expect(bridge.close).toHaveBeenCalled();
    });
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("defaults Chrome command-pair realtime to agent-driven talk-back", async () => {
    vi.useFakeTimers();
    try {
      let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
      const sendUserMessage = vi.fn();
      const bridge = {
        connect: vi.fn(async () => {}),
        sendAudio: vi.fn(),
        sendUserMessage,
        setMediaTimestamp: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        triggerGreeting: vi.fn(),
        isConnected: vi.fn(() => true),
      };
      const provider: RealtimeVoiceProviderPlugin = {
        id: "openai",
        label: "OpenAI",
        defaultModel: "gpt-realtime-2",
        autoSelectOrder: 1,
        resolveConfig: ({ rawConfig }) => rawConfig,
        isConfigured: () => true,
        createBridge: (req) => {
          callbacks = req;
          return bridge;
        },
      };
      const inputStdout = new PassThrough();
      const outputProcess = testBridgeProcess({
        stdin: new Writable({
          write(_chunk, _encoding, done) {
            done();
          },
        }),
        stdout: null,
      });
      const inputProcess = testBridgeProcess({ stdout: inputStdout, stdin: null });
      const spawnMock = vi
        .fn()
        .mockReturnValueOnce(outputProcess)
        .mockReturnValueOnce(inputProcess);
      const sessionStore: Record<string, unknown> = {};
      const runtime = {
        agent: {
          resolveAgentDir: vi.fn(() => "/tmp/agent"),
          resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
          ensureAgentWorkspace: vi.fn(async () => {}),
          session: createMockSessionRuntime(sessionStore),
          runEmbeddedAgent: vi.fn(async (_request: unknown) => ({
            payloads: [{ text: "The launch is still on track." }],
            meta: {},
          })),
          resolveAgentTimeoutMs: vi.fn(() => 1000),
        },
      };

      const handle = await startTestLocalRealtimeAudioBridge({
        config: resolveGoogleMeetConfig({ realtime: { provider: "openai", agentId: "jay" } }),
        fullConfig: {} as never,
        runtime: runtime as never,
        meetingSessionId: "meet-1",
        inputCommand: ["capture-meet"],
        outputCommand: ["play-meet"],
        logger: noopLogger,
        providers: [provider],
        spawn: spawnMock,
      });

      if (!callbacks) {
        throw new Error("Expected realtime bridge callbacks");
      }
      expect(callbacks.autoRespondToAudio).toBe(false);
      expect(callbacks.tools).toStrictEqual([]);
      callbacks.onTranscript?.(
        "assistant",
        "Hi Molty, glad to have you here. Let me know if there's anything specific you'd like to cover or if you need any support during the meeting.",
        true,
      );
      callbacks.onTranscript?.(
        "user",
        "Let me know if there's anything specific you'd like to cover or if you need any support during the",
        true,
      );
      await vi.advanceTimersByTimeAsync(TEST_TALKBACK_DEBOUNCE_MS);
      expect(runtime.agent.runEmbeddedAgent).not.toHaveBeenCalled();

      callbacks.onTranscript?.("user", "yes yes yes yes", true);
      callbacks?.onTranscript?.("user", "Are we still on track?", true);
      callbacks?.onTranscript?.("user", "Please include launch blockers.", true);

      await vi.advanceTimersByTimeAsync(TEST_TALKBACK_DEBOUNCE_MS);
      await vi.waitFor(() => {
        expect(runtime.agent.runEmbeddedAgent).toHaveBeenCalledTimes(1);
      });
      const consultArgs = requireRecord(
        (runtime.agent.runEmbeddedAgent.mock.calls as unknown[][])[0]?.[0],
        "default talk-back agent request",
      );
      expect(consultArgs.agentId).toBe("jay");
      expect(consultArgs.spawnedBy).toBe("agent:jay:main");
      expect(consultArgs.sessionKey).toBe("agent:jay:subagent:google-meet:meet-1");
      expect(consultArgs.sandboxSessionKey).toBe("agent:jay:subagent:google-meet:meet-1");
      expect(JSON.stringify(consultArgs)).toContain("yes yes yes yes");
      expect(JSON.stringify(consultArgs)).toContain(
        "Are we still on track?\\nPlease include launch blockers.",
      );
      expect(sendUserMessage).toHaveBeenCalledTimes(1);
      const sentUserMessage = mockCallArg(sendUserMessage, 0) as string;
      expect(typeof sentUserMessage).toBe("string");
      expect(sentUserMessage).toContain(JSON.stringify("The launch is still on track."));
      expect(sessionStore).toHaveProperty("agent:jay:subagent:google-meet:meet-1");

      await handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("extends realtime input suppression across queued playback", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000);
      let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
      const bridge = {
        connect: vi.fn(async () => {}),
        sendAudio: vi.fn(),
        sendUserMessage: vi.fn(),
        setMediaTimestamp: vi.fn(),
        submitToolResult: vi.fn(),
        acknowledgeMark: vi.fn(),
        close: vi.fn(),
        triggerGreeting: vi.fn(),
        isConnected: vi.fn(() => true),
      };
      const provider: RealtimeVoiceProviderPlugin = {
        id: "openai",
        label: "OpenAI",
        autoSelectOrder: 1,
        resolveConfig: ({ rawConfig }) => rawConfig,
        isConfigured: () => true,
        createBridge: (request) => {
          callbacks = request;
          return bridge;
        },
      };
      const audioTransport = createTestMeetRealtimeAudioTransport();
      const config = resolveGoogleMeetConfig({
        realtime: { strategy: "bidi", provider: "openai", model: "gpt-realtime" },
      });
      const handle = await startMeetingRealtimeEngine({
        config,
        fullConfig: {} as never,
        runtime: {} as never,
        ...createGoogleMeetTestEngineBindings({
          config,
          fullConfig: {} as never,
          runtime: {} as never,
          logger: noopLogger,
        }),
        meetingSessionId: "queued-playback",
        logger: noopLogger,
        providers: [provider],
        transport: audioTransport.transport,
      });
      if (!callbacks) {
        throw new Error("Expected realtime bridge callbacks");
      }

      callbacks.onAudio(Buffer.alloc(48_000));
      vi.setSystemTime(1_100);
      callbacks.onAudio(Buffer.alloc(48_000));
      vi.setSystemTime(5_500);
      audioTransport.deliverInput(Buffer.from([1, 2, 3, 4]));
      expect(bridge.sendAudio).not.toHaveBeenCalled();

      vi.setSystemTime(6_001);
      audioTransport.deliverInput(Buffer.from([5, 6, 7]));
      expect(bridge.sendAudio).toHaveBeenCalledWith(Buffer.from([5, 6, 7]));
      expect(handle.getHealth()).toMatchObject({
        lastInputBytes: 3,
        lastOutputBytes: 96_000,
        suppressedInputBytes: 4,
      });
      await handle.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses a local barge-in input command to clear active Chrome playback", async () => {
    let callbacks:
      | {
          onAudio: (audio: Buffer) => void;
        }
      | undefined;
    const sendAudio = vi.fn();
    const bridge = {
      connect: vi.fn(async () => {}),
      sendAudio,
      setMediaTimestamp: vi.fn(),
      handleBargeIn: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createBridge: (req) => {
        callbacks = req;
        return bridge;
      },
    };
    const inputStdout = new PassThrough();
    const bargeInStdout = new PassThrough();
    const outputStdin = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const replacementOutputStdin = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const outputProcess = testBridgeProcess({ stdin: outputStdin, stdout: null });
    const inputProcess = testBridgeProcess({ stdout: inputStdout, stdin: null });
    const bargeInProcess = testBridgeProcess({ stdout: bargeInStdout, stdin: null });
    const replacementOutputProcess = testBridgeProcess({
      stdin: replacementOutputStdin,
      stdout: null,
    });
    const spawnMock = vi
      .fn()
      .mockReturnValueOnce(outputProcess)
      .mockReturnValueOnce(inputProcess)
      .mockReturnValueOnce(bargeInProcess)
      .mockReturnValueOnce(replacementOutputProcess);

    const handle = await startTestLocalRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        chrome: {
          bargeInInputCommand: ["capture-human"],
          bargeInRmsThreshold: 10,
          bargeInPeakThreshold: 10,
          bargeInCooldownMs: 1,
        },
        realtime: { provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig: {} as never,
      runtime: {} as never,
      meetingSessionId: "meet-1",
      inputCommand: ["capture-meet"],
      outputCommand: ["play-meet"],
      logger: noopLogger,
      providers: [provider],
      spawn: spawnMock,
    });

    callbacks?.onAudio(Buffer.alloc(48_000));
    inputStdout.write(Buffer.from([1, 2, 3, 4]));
    bargeInStdout.write(Buffer.from([0xff, 0x7f, 0xff, 0x7f]));

    expect(spawnMock).toHaveBeenNthCalledWith(3, "capture-human", [], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    expect(bridge.handleBargeIn).toHaveBeenCalled();
    expect(outputProcess.kill).toHaveBeenCalledWith("SIGKILL");
    expect(sendAudio).not.toHaveBeenCalledWith(Buffer.from([1, 2, 3, 4]));
    const health = handle.getHealth();
    expect(health.clearCount).toBe(1);
    expect(health.suppressedInputBytes).toBe(4);

    await handle.stop();
    expect(inputProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(bargeInProcess.kill).toHaveBeenCalledWith("SIGTERM");
    expect(replacementOutputProcess.kill).toHaveBeenCalledWith("SIGTERM");
  });

  it("pipes paired-node command-pair audio through the realtime provider", async () => {
    let callbacks: Parameters<RealtimeVoiceProviderPlugin["createBridge"]>[0] | undefined;
    const sendAudio = vi.fn();
    const bridge = {
      supportsToolResultContinuation: true,
      connect: vi.fn(async () => {}),
      sendAudio,
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createBridge: (req) => {
        callbacks = req;
        return bridge;
      },
    };
    let pullCount = 0;
    let idlePullStarted = false;
    let releaseIdlePull: (() => void) | undefined;
    const fullConfig = { models: { providers: {} } } as never;
    const sessionStore: Record<string, unknown> = {};
    const testRoot = createIsolatedTestDir("openclaw-google-meet-node-agent-");
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params?: { action?: string; base64?: string } }) => {
          if (params?.action === "pullAudio") {
            pullCount += 1;
            if (pullCount === 1) {
              return { bridgeId: "bridge-1", base64: Buffer.from([9, 8, 7]).toString("base64") };
            }
            idlePullStarted = true;
            await new Promise<void>((resolve) => {
              releaseIdlePull = resolve;
            });
            return { bridgeId: "bridge-1" };
          }
          releaseIdlePull?.();
          releaseIdlePull = undefined;
          return { ok: true };
        }),
      },
      agent: {
        resolveAgentDir: vi.fn(() => path.join(testRoot, "agent")),
        resolveAgentWorkspaceDir: vi.fn(() => path.join(testRoot, "workspace")),
        ensureAgentWorkspace: vi.fn(async () => {}),
        session: createMockSessionRuntime(sessionStore),
        runEmbeddedAgent: vi.fn(async () => ({
          payloads: [{ text: "Use the launch update." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startTestNodeRealtimeAudioBridge({
      config: resolveGoogleMeetConfig({
        realtime: { strategy: "bidi", provider: "openai", model: "gpt-realtime" },
      }),
      fullConfig,
      runtime: runtime as never,
      meetingSessionId: "meet-1",
      nodeId: "node-1",
      bridgeId: "bridge-1",
      logger: noopLogger,
      providers: [provider],
    });

    expect(noopLogger.info).toHaveBeenCalledWith(
      "[google-meet] realtime voice bridge starting: strategy=bidi provider=openai model=gpt-realtime audioFormat=pcm16-24khz",
    );
    expect(callbacks?.cfg).toBe(fullConfig);
    callbacks?.onAudio(Buffer.from([1, 2, 3]));
    callbacks?.onClearAudio();
    callbacks?.onReady?.();
    callbacks?.onTranscript?.("assistant", "How can I help from the node?", true);
    callbacks?.onEvent?.({
      direction: "server",
      type: "response.done",
      detail: "status=completed",
    });
    callbacks?.onToolCall?.({
      itemId: "item-1",
      callId: "tool-call-1",
      name: "openclaw_agent_consult",
      args: { question: "What should I say?" },
    });
    expect(bridge.submitToolResult).toHaveBeenCalled();
    const firstToolResultCall = mockCall(bridge.submitToolResult);
    expect(firstToolResultCall[0]).toBe("tool-call-1");
    expect(firstToolResultCall[2]).toStrictEqual({ willContinue: true });
    const progressPayload = requireRecord(firstToolResultCall[1], "node tool progress payload");
    expect(progressPayload.status).toBe("working");
    expect(progressPayload.tool).toBe("openclaw_agent_consult");

    await vi.waitFor(() => {
      expect(sendAudio).toHaveBeenCalledWith(Buffer.from([9, 8, 7]));
    });
    await vi.waitFor(() => {
      const pushCall = runtime.nodes.invoke.mock.calls
        .map(([call]) => call)
        .find((call) => isRecord(call.params) && call.params.action === "pushAudio");
      const push = requireRecord(pushCall, "node push audio call");
      const params = requireRecord(push.params, "node push audio params");
      expect(push.nodeId).toBe("node-1");
      expect(push.command).toBe("googlemeet.chrome");
      expect(params.bridgeId).toBe("bridge-1");
      expect(params.base64).toBe(Buffer.from([1, 2, 3]).toString("base64"));
    });
    await vi.waitFor(() => {
      const clearCall = runtime.nodes.invoke.mock.calls
        .map(([call]) => call)
        .find((call) => isRecord(call.params) && call.params.action === "clearAudio");
      const clear = requireRecord(clearCall, "node clear audio call");
      expect(clear.nodeId).toBe("node-1");
      expect(clear.command).toBe("googlemeet.chrome");
      expect(clear.params).toStrictEqual({ action: "clearAudio", bridgeId: "bridge-1" });
      expect(clear.timeoutMs).toBe(5_000);
    });
    await vi.waitFor(() => {
      expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
        "tool-call-1",
        {
          text: "Use the launch update.",
        },
        undefined,
      );
    });
    expect(bridge.triggerGreeting).not.toHaveBeenCalled();
    handle.speak("Say exactly: hello from the node.");
    expect(bridge.triggerGreeting).toHaveBeenLastCalledWith("Say exactly: hello from the node.");
    if (!callbacks) {
      throw new Error("Expected node realtime callbacks");
    }
    expect(callbacks.audioFormat).toStrictEqual({
      encoding: "pcm16",
      sampleRateHz: 24000,
      channels: 1,
    });
    expect(callbacks.autoRespondToAudio).toBe(true);
    expect(callbacks.tools?.map((tool) => tool.name)).toContain("openclaw_agent_consult");
    expect(handle.type).toBe("node-command-pair");
    expect(handle.providerId).toBe("openai");
    expect(handle.nodeId).toBe("node-1");
    expect(handle.bridgeId).toBe("bridge-1");
    const nodeHealth = handle.getHealth();
    expect(nodeHealth.providerConnected).toBe(true);
    expect(nodeHealth.realtimeReady).toBe(true);
    expect(nodeHealth.audioInputActive).toBe(true);
    expect(nodeHealth.audioOutputActive).toBe(true);
    expect(nodeHealth.lastInputBytes).toBe(3);
    expect(nodeHealth.lastOutputBytes).toBe(3);
    expect(nodeHealth.realtimeTranscriptLines).toBe(1);
    expect(nodeHealth.lastRealtimeTranscriptRole).toBe("assistant");
    expect(nodeHealth.lastRealtimeTranscriptText).toBe("How can I help from the node?");
    expect(nodeHealth.lastRealtimeEventType).toBe("server:response.done");
    expect(nodeHealth.lastRealtimeEventDetail).toBe("status=completed");
    expect(nodeHealth.clearCount).toBe(1);
    const talkEvents = nodeHealth.recentTalkEvents ?? [];
    const talkEventTypes = talkEvents.map((event) => event.type);
    for (const type of [
      "session.started",
      "session.ready",
      "input.audio.delta",
      "output.audio.delta",
      "output.audio.done",
      "output.text.done",
      "tool.call",
      "tool.progress",
      "tool.result",
      "turn.ended",
    ]) {
      expect(talkEventTypes).toContain(type);
    }
    expect(talkEvents[0]?.sessionId).toBe("google-meet:meet-1:bridge-1:node-realtime");

    await vi.waitFor(() => {
      expect(idlePullStarted).toBe(true);
    });
    await handle.stop();

    expect(bridge.close).toHaveBeenCalled();
    const stopCall = runtime.nodes.invoke.mock.calls
      .map(([call]) => call)
      .find((call) => isRecord(call.params) && call.params.action === "stop");
    const stop = requireRecord(stopCall, "node stop call");
    expect(stop.nodeId).toBe("node-1");
    expect(stop.command).toBe("googlemeet.chrome");
    expect(stop.params).toStrictEqual({ action: "stop", bridgeId: "bridge-1" });
    expect(stop.timeoutMs).toBe(5_000);
  });

  it("keeps paired-node realtime audio alive after transient input pull failures", async () => {
    vi.useFakeTimers();
    const sendAudio = vi.fn();
    const bridge = {
      connect: vi.fn(async () => {}),
      sendAudio,
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    let pullCount = 0;
    let idlePullStarted = false;
    let releaseIdlePull: (() => void) | undefined;
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params?: { action?: string } }) => {
          if (params?.action === "pullAudio") {
            pullCount += 1;
            if (pullCount === 1) {
              throw new Error("transient node timeout");
            }
            if (pullCount === 2) {
              return { bridgeId: "bridge-1", base64: Buffer.from([5, 4, 3]).toString("base64") };
            }
            idlePullStarted = true;
            await new Promise<void>((resolve) => {
              releaseIdlePull = resolve;
            });
            return { bridgeId: "bridge-1" };
          }
          releaseIdlePull?.();
          releaseIdlePull = undefined;
          return { ok: true };
        }),
      },
    };
    let handle: Awaited<ReturnType<typeof startTestNodeRealtimeAudioBridge>> | undefined;

    try {
      handle = await startTestNodeRealtimeAudioBridge({
        config: resolveGoogleMeetConfig({
          realtime: { provider: "openai", model: "gpt-realtime" },
        }),
        fullConfig: {} as never,
        runtime: runtime as never,
        meetingSessionId: "meet-1",
        nodeId: "node-1",
        bridgeId: "bridge-1",
        logger: noopLogger,
        providers: [provider],
      });

      await vi.advanceTimersByTimeAsync(250);
      await vi.waitFor(() => {
        expect(sendAudio).toHaveBeenCalledWith(Buffer.from([5, 4, 3]));
      });
      expect(bridge.close).not.toHaveBeenCalled();
      const health = handle.getHealth();
      expect(health.audioInputActive).toBe(true);
      expect(health.lastInputBytes).toBe(3);
      expect(health.consecutiveInputErrors).toBe(0);

      await vi.waitFor(() => {
        expect(idlePullStarted).toBe(true);
      });
      await handle.stop();
    } finally {
      await handle?.stop();
      vi.useRealTimers();
    }
  });

  it("stops paired-node realtime audio after repeated input pull failures", async () => {
    vi.useFakeTimers();
    const bridge = {
      connect: vi.fn(async () => {}),
      sendAudio: vi.fn(),
      setMediaTimestamp: vi.fn(),
      submitToolResult: vi.fn(),
      acknowledgeMark: vi.fn(),
      close: vi.fn(),
      triggerGreeting: vi.fn(),
      isConnected: vi.fn(() => true),
    };
    const provider: RealtimeVoiceProviderPlugin = {
      id: "openai",
      label: "OpenAI",
      autoSelectOrder: 1,
      resolveConfig: ({ rawConfig }) => rawConfig,
      isConfigured: () => true,
      createBridge: () => bridge,
    };
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params?: { action?: string } }) => {
          if (params?.action === "pullAudio") {
            throw new Error("node invoke timeout");
          }
          return { ok: true };
        }),
      },
    };

    try {
      const handle = await startTestNodeRealtimeAudioBridge({
        config: resolveGoogleMeetConfig({
          realtime: { provider: "openai", model: "gpt-realtime" },
        }),
        fullConfig: {} as never,
        runtime: runtime as never,
        meetingSessionId: "meet-1",
        nodeId: "node-1",
        bridgeId: "bridge-1",
        logger: noopLogger,
        providers: [provider],
      });

      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(
        () => {
          expect(bridge.close).toHaveBeenCalled();
        },
        { timeout: 3_000 },
      );
      const health = handle.getHealth();
      expect(health.bridgeClosed).toBe(true);
      expect(health.consecutiveInputErrors).toBe(5);
      expect(health.lastInputError).toBe("node invoke timeout");
      const stopCall = runtime.nodes.invoke.mock.calls
        .map(([call]) => call)
        .find((call) => isRecord(call.params) && call.params.action === "stop");
      const stop = requireRecord(stopCall, "failed pull stop call");
      expect(stop.nodeId).toBe("node-1");
      expect(stop.command).toBe("googlemeet.chrome");
      expect(stop.params).toStrictEqual({ action: "stop", bridgeId: "bridge-1" });
      expect(stop.timeoutMs).toBe(5_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes node-host list and stop-by-url bridge actions", async () => {
    const listed = JSON.parse(
      await handleGoogleMeetNodeHostCommand(JSON.stringify({ action: "list", url: MEET_URL })),
    );
    expect(listed).toEqual({ bridges: [] });

    await expect(
      handleGoogleMeetNodeHostCommand(JSON.stringify({ action: "stopByUrl" })),
    ).rejects.toThrow("url required");
  });
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
