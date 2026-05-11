import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { createContext, Script } from "node:vm";
import { validateJsonSchemaValue, type JsonSchemaObject } from "openclaw/plugin-sdk/config-schema";
import type { RealtimeTranscriptionProviderPlugin } from "openclaw/plugin-sdk/realtime-transcription";
import type { RealtimeVoiceProviderPlugin } from "openclaw/plugin-sdk/realtime-voice";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import plugin, { __testing as googleMeetPluginTesting } from "./index.js";
import {
  extractGoogleMeetUriFromCalendarEvent,
  findGoogleMeetCalendarEvent,
  listGoogleMeetCalendarEvents,
} from "./src/calendar.js";
import { resolveGoogleMeetConfig, resolveGoogleMeetConfigWithEnv } from "./src/config.js";
import {
  buildGoogleMeetPreflightReport,
  createGoogleMeetSpace,
  fetchGoogleMeetArtifacts,
  fetchGoogleMeetAttendance,
  fetchLatestGoogleMeetConferenceRecord,
  fetchGoogleMeetSpace,
  normalizeGoogleMeetSpaceName,
} from "./src/meet.js";
import { handleGoogleMeetNodeHostCommand } from "./src/node-host.js";
import { startNodeRealtimeAudioBridge } from "./src/realtime-node.js";
import {
  convertGoogleMeetTtsAudioForBridge,
  extendGoogleMeetOutputEchoSuppression,
  isGoogleMeetLikelyAssistantEchoTranscript,
  GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS,
  resolveGoogleMeetRealtimeProvider,
  resolveGoogleMeetRealtimeTranscriptionProvider,
  startCommandAgentAudioBridge,
  startCommandRealtimeAudioBridge,
} from "./src/realtime.js";
import { GoogleMeetRuntime, normalizeMeetUrl } from "./src/runtime.js";
import {
  invokeGoogleMeetGatewayMethodForTest,
  noopLogger,
  setupGoogleMeetPlugin,
} from "./src/test-support/plugin-harness.js";
import { __testing as chromeTransportTesting } from "./src/transports/chrome.js";
import {
  buildMeetDtmfSequence,
  normalizeDialInNumber,
  prefixDtmfWait,
} from "./src/transports/twilio.js";
import type { GoogleMeetSession } from "./src/transports/types.js";

type GoogleMeetManifestConfigSchema = JsonSchemaObject & {
  properties?: Record<string, JsonSchemaObject & { properties?: Record<string, unknown> }>;
};

const voiceCallMocks = vi.hoisted(() => ({
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
  joinMeetViaVoiceCallGateway: voiceCallMocks.joinMeetViaVoiceCallGateway,
  endMeetVoiceCallGatewayCall: voiceCallMocks.endMeetVoiceCallGatewayCall,
  getMeetVoiceCallGatewayCall: voiceCallMocks.getMeetVoiceCallGatewayCall,
  isVoiceCallMissingError: voiceCallMocks.isVoiceCallMissingError,
  speakMeetViaVoiceCallGateway: voiceCallMocks.speakMeetViaVoiceCallGateway,
}));

function setup(
  config?: Parameters<typeof setupGoogleMeetPlugin>[1],
  options?: Parameters<typeof setupGoogleMeetPlugin>[2],
) {
  const harness = setupGoogleMeetPlugin(plugin, config, options);
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

function requireRecord(value: unknown, label: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Expected ${label} to be an object`);
  }
  return value;
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
  browserActResult: Record<string, unknown> | (() => Record<string, unknown>) = {
    inCall: true,
    micMuted: false,
    title: "Meet call",
    url: "https://meet.google.com/abc-defg-hij",
  },
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
          url: request.body?.url ?? "https://meet.google.com/abc-defg-hij",
        };
      }
      if (request.path === "/tabs/focus") {
        return { ok: true };
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
  chromeTransportTesting.setDepsForTest({ callGatewayFromCli });
  return callGatewayFromCli;
}

function stubMeetArtifactsApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = requestUrl(input);
    if (url.pathname === "/v2/spaces/abc-defg-hij") {
      return jsonResponse({
        name: "spaces/abc-defg-hij",
        meetingCode: "abc-defg-hij",
        meetingUri: "https://meet.google.com/abc-defg-hij",
      });
    }
    if (url.pathname === "/calendar/v3/calendars/primary/events") {
      return jsonResponse({
        items: [
          {
            id: "event-1",
            summary: "Project sync",
            hangoutLink: "https://meet.google.com/abc-defg-hij",
            start: { dateTime: "2026-04-25T10:00:00Z" },
            end: { dateTime: "2026-04-25T10:30:00Z" },
          },
        ],
      });
    }
    if (url.pathname === "/v2/conferenceRecords") {
      return jsonResponse({
        conferenceRecords: [
          {
            name: "conferenceRecords/rec-1",
            space: "spaces/abc-defg-hij",
            startTime: "2026-04-25T10:00:00Z",
            endTime: "2026-04-25T10:30:00Z",
          },
        ],
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1") {
      return jsonResponse({
        name: "conferenceRecords/rec-1",
        space: "spaces/abc-defg-hij",
        startTime: "2026-04-25T10:00:00Z",
        endTime: "2026-04-25T10:30:00Z",
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1/participants") {
      return jsonResponse({
        participants: [
          {
            name: "conferenceRecords/rec-1/participants/p1",
            earliestStartTime: "2026-04-25T10:00:00Z",
            latestEndTime: "2026-04-25T10:30:00Z",
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
            startTime: "2026-04-25T10:00:00Z",
            endTime: "2026-04-25T10:30:00Z",
          },
        ],
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1/recordings") {
      return jsonResponse({
        recordings: [
          {
            name: "conferenceRecords/rec-1/recordings/r1",
            driveDestination: { file: "drive/file-1" },
          },
        ],
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1/transcripts") {
      return jsonResponse({
        transcripts: [
          {
            name: "conferenceRecords/rec-1/transcripts/t1",
            docsDestination: { document: "docs/doc-1" },
          },
        ],
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1/transcripts/t1/entries") {
      return jsonResponse({
        transcriptEntries: [
          {
            name: "conferenceRecords/rec-1/transcripts/t1/entries/e1",
            participant: "conferenceRecords/rec-1/participants/p1",
            text: "Hello from the transcript.",
            languageCode: "en-US",
            startTime: "2026-04-25T10:01:00Z",
            endTime: "2026-04-25T10:01:05Z",
          },
        ],
      });
    }
    if (url.pathname === "/v2/conferenceRecords/rec-1/smartNotes") {
      return jsonResponse({
        smartNotes: [
          {
            name: "conferenceRecords/rec-1/smartNotes/sn1",
            docsDestination: { document: "docs/doc-2" },
          },
        ],
      });
    }
    if (url.pathname === "/drive/v3/files/doc-1/export") {
      return new Response("Transcript document body.", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    if (url.pathname === "/drive/v3/files/doc-2/export") {
      return new Response("Smart note document body.", {
        status: 200,
        headers: { "Content-Type": "text/plain" },
      });
    }
    return new Response(`unexpected ${url.pathname}`, { status: 404 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

type TestBridgeProcess = {
  stdin?: { write(chunk: unknown): unknown } | null;
  stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
  stderr: PassThrough;
  killed: boolean;
  kill: ReturnType<typeof vi.fn>;
  on: EventEmitter["on"];
  emit: EventEmitter["emit"];
};

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
    chromeTransportTesting.setDepsForTest(null);
    googleMeetPluginTesting.setCallGatewayFromCliForTests();
    googleMeetPluginTesting.setPlatformForTests();
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

  it("uses voiceProvider for bidi and transcriptionProvider for agent mode resolution", () => {
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
        createBridge: () => {
          throw new Error("unused");
        },
      },
    ];
    const transcriptionProviders: RealtimeTranscriptionProviderPlugin[] = [
      {
        id: "openai",
        label: "OpenAI",
        autoSelectOrder: 1,
        isConfigured: () => true,
        createSession: () => {
          throw new Error("unused");
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

    const voiceProvider = resolveGoogleMeetRealtimeProvider({
      config,
      fullConfig: {} as never,
      providers: voiceProviders,
    });
    expect(voiceProvider.provider.id).toBe("google");
    expect(voiceProvider.providerConfig).toEqual({
      model: "gemini-2.5-flash-native-audio-preview-12-2025",
    });
    const transcriptionProvider = resolveGoogleMeetRealtimeTranscriptionProvider({
      config,
      fullConfig: {} as never,
      providers: transcriptionProviders,
    });
    expect(transcriptionProvider.provider.id).toBe("openai");
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
    const config = resolveGoogleMeetConfigWithEnv(
      {},
      {
        OPENCLAW_GOOGLE_MEET_CLIENT_ID: "client-id",
        GOOGLE_MEET_CLIENT_SECRET: "client-secret",
        OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN: "refresh-token",
        GOOGLE_MEET_ACCESS_TOKEN: "access-token",
        OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT: "123456",
        GOOGLE_MEET_DEFAULT_MEETING: "https://meet.google.com/abc-defg-hij",
        OPENCLAW_GOOGLE_MEET_PREVIEW_ACK: "true",
      },
    );
    expect(config.defaults).toEqual({ meeting: "https://meet.google.com/abc-defg-hij" });
    expect(config.preview).toEqual({ enrollmentAcknowledged: true });
    expect(config.oauth).toEqual({
      clientId: "client-id",
      clientSecret: "client-secret",
      refreshToken: "refresh-token",
      accessToken: "access-token",
      expiresAt: 123456,
    });
  });

  it("requires explicit Meet URLs", () => {
    expect(normalizeMeetUrl("https://meet.google.com/abc-defg-hij")).toBe(
      "https://meet.google.com/abc-defg-hij",
    );
    expect(() => normalizeMeetUrl("https://example.com/abc-defg-hij")).toThrow("meet.google.com");
  });

  it("advertises only the googlemeet CLI descriptor", () => {
    const { cliRegistrations } = setup();

    expect(cliRegistrations).toContainEqual({
      commands: ["googlemeet"],
      descriptors: [
        {
          name: "googlemeet",
          description: "Join and manage Google Meet calls",
          hasSubcommands: true,
        },
      ],
    });
  });

  it("registers the node-host command used by chrome-node transport", () => {
    const { nodeHostCommands } = setup();

    const command = nodeHostCommands.find(
      (entry): entry is Record<string, unknown> =>
        isRecord(entry) && entry.command === "googlemeet.chrome",
    );
    if (!command) {
      throw new Error("expected googlemeet.chrome node host command");
    }
    expect(command.cap).toBe("google-meet");
    expect(typeof command.handle).toBe("function");
  });

  it("keeps the agent tool visible on non-macOS hosts but blocks local Chrome talk-back joins", async () => {
    const { cliRegistrations, methods, tools } = setup(undefined, { registerPlatform: "linux" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ isError?: boolean; content: unknown }>;
    };

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
    const tool = tools[0] as { description?: string; parameters: unknown };

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

  it("normalizes Meet URLs, codes, and space names for the Meet API", () => {
    expect(normalizeGoogleMeetSpaceName("spaces/abc-defg-hij")).toBe("spaces/abc-defg-hij");
    expect(normalizeGoogleMeetSpaceName("abc-defg-hij")).toBe("spaces/abc-defg-hij");
    expect(normalizeGoogleMeetSpaceName("https://meet.google.com/abc-defg-hij")).toBe(
      "spaces/abc-defg-hij",
    );
    expect(() => normalizeGoogleMeetSpaceName("https://example.com/abc-defg-hij")).toThrow(
      "meet.google.com",
    );
  });

  it("finds Google Meet links from Calendar events", async () => {
    const fetchMock = stubMeetArtifactsApi();

    expect(
      extractGoogleMeetUriFromCalendarEvent({
        conferenceData: {
          entryPoints: [
            {
              entryPointType: "video",
              uri: "https://meet.google.com/abc-defg-hij",
            },
          ],
        },
      }),
    ).toBe("https://meet.google.com/abc-defg-hij");
    const event = await findGoogleMeetCalendarEvent({
      accessToken: "token",
      now: new Date("2026-04-25T09:50:00Z"),
      timeMin: "2026-04-25T00:00:00Z",
      timeMax: "2026-04-26T00:00:00Z",
    });
    expect(event.calendarId).toBe("primary");
    expect(event.meetingUri).toBe("https://meet.google.com/abc-defg-hij");
    expect(event.event.summary).toBe("Project sync");

    const calendarEvents = await listGoogleMeetCalendarEvents({
      accessToken: "token",
      now: new Date("2026-04-25T09:50:00Z"),
      timeMin: "2026-04-25T00:00:00Z",
      timeMax: "2026-04-26T00:00:00Z",
    });
    expect(calendarEvents.calendarId).toBe("primary");
    expect(calendarEvents.events).toHaveLength(1);
    expect(calendarEvents.events[0]?.meetingUri).toBe("https://meet.google.com/abc-defg-hij");
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
          meetingUri: "https://meet.google.com/abc-defg-hij",
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
    expect(space.meetingUri).toBe("https://meet.google.com/abc-defg-hij");
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
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { session: unknown } }>;
    };
    const result = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
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
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<unknown>;
    };

    await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
      requesterSessionKey: "agent:main:wrong",
    });

    const gatewayJoinParams = requireRecord(gatewayParams[0], "gateway join params");
    expect(gatewayJoinParams.url).toBe("https://meet.google.com/abc-defg-hij");
    expect(gatewayJoinParams.requesterSessionKey).toBe("agent:main:discord:channel:general");
  });

  it("explains that Twilio joins need dial-in details", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { error?: string } }>;
    };

    const result = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details.error).toContain("Twilio transport requires a Meet dial-in phone number");
    expect(result.details.error).toContain("Google Meet URLs do not include dial-in details");
  });

  it("hangs up delegated Twilio calls on leave", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { session: { id: string } } }>;
    };
    const joined = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    await tool.execute("id", { action: "leave", sessionId: joined.details.session.id });

    const [endParams] = voiceCallMocks.endMeetVoiceCallGatewayCall.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(requireRecord(endParams.config, "voice-call end config").defaultTransport).toBe(
      "twilio",
    );
    expect(endParams.callId).toBe("call-1");
    expect(voiceCallMocks.endMeetVoiceCallGatewayCall).toHaveBeenCalledWith({
      config: endParams.config,
      callId: "call-1",
    });
  });

  it("does not reuse Twilio Meet sessions whose delegated call is no longer active", async () => {
    voiceCallMocks.getMeetVoiceCallGatewayCall.mockResolvedValueOnce({ found: false });
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { session: { id: string; state: string; notes: string[] } } }>;
    };
    const first = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
      dialInNumber: "+15551234567",
      pin: "123456",
    });
    const second = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    expect(first.details.session.state).toBe("ended");
    expect(first.details.session.notes).toContain("Voice Call is no longer active.");
    expect(second.details.session.id).not.toBe(first.details.session.id);
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledTimes(2);
  });

  it("delegates Twilio session speech through voice-call", async () => {
    const { tools } = setup({ defaultTransport: "twilio" });
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { session: { id: string } } }>;
    };
    const joined = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
      dialInNumber: "+15551234567",
      pin: "123456",
    });

    const spoken = await tool.execute("id", {
      action: "speak",
      sessionId: joined.details.session.id,
      message: "Say exactly: hello after joining.",
    });

    expect(requireRecord(spoken.details, "spoken details").spoken).toBe(true);
    const [speakParams] = voiceCallMocks.speakMeetViaVoiceCallGateway.mock.calls[0] as unknown as [
      Record<string, unknown>,
    ];
    expect(requireRecord(speakParams.config, "voice-call speak config").defaultTransport).toBe(
      "twilio",
    );
    expect(speakParams.callId).toBe("call-1");
    expect(speakParams.message).toBe("Say exactly: hello after joining.");
    expect(voiceCallMocks.speakMeetViaVoiceCallGateway).toHaveBeenCalledWith({
      config: speakParams.config,
      callId: "call-1",
      message: "Say exactly: hello after joining.",
    });
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
      const tool = tools[0] as {
        execute: (id: string, params: unknown) => Promise<{ details: { ok?: boolean } }>;
      };

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
      const tool = tools[0] as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
      };

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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { attendance?: Array<{ displayName?: string }> } }>;
    };

    const result = await tool.execute("id", {
      action: "attendance",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      conferenceRecord: "rec-1",
      pageSize: 3,
    });

    expect(result.details.attendance).toHaveLength(1);
    expect(result.details.attendance?.[0]?.displayName).toBe("Alice");
  });

  it("writes export bundles through the tool", async () => {
    stubMeetArtifactsApi();
    const tempDir = mkdtempSync(path.join(tmpdir(), "openclaw-google-meet-tool-export-"));
    const { tools } = setup();
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { files?: string[]; zipFile?: string } }>;
    };

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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { dryRun?: boolean; manifest?: { files?: string[] } } }>;
    };

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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { conferenceRecord?: { name?: string } } }>;
    };

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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { calendarEvent?: { meetingUri?: string } } }>;
    };

    const result = await tool.execute("id", {
      action: "latest",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      today: true,
    });

    expect(result.details.calendarEvent?.meetingUri).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("reports calendar event previews through the tool", async () => {
    stubMeetArtifactsApi();
    const { tools } = setup();
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { events?: Array<{ selected?: boolean; meetingUri?: string }> } }>;
    };

    const result = await tool.execute("id", {
      action: "calendar_events",
      accessToken: "token",
      expiresAt: Date.now() + 120_000,
      today: true,
    });

    expect(result.details.events).toHaveLength(1);
    expect(result.details.events?.[0]?.selected).toBe(true);
    expect(result.details.events?.[0]?.meetingUri).toBe("https://meet.google.com/abc-defg-hij");
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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
    };

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
      const tool = tools[0] as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
      };

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
      const tool = tools[0] as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
      };

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
      const tool = tools[0] as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
      };

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
      const tool = tools[0] as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{ details: { ok?: boolean; checks?: Array<{ id?: string; ok?: boolean }> } }>;
      };

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
        result.details.checks?.filter((check) => check.id === "chrome-local-audio-device"),
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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
    };

    const result = await tool.execute("id", { action: "setup_status" });

    expect(result.details.ok).toBe(true);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-plugin").ok).toBe(true);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-credentials").ok).toBe(true);
    expect(requireSetupCheck(result.details.checks, "twilio-voice-call-webhook").ok).toBe(true);
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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
    };

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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
    };

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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
    };

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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
    };

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
      const tool = tools[0] as {
        execute: (
          id: string,
          params: unknown,
        ) => Promise<{ details: { ok?: boolean; checks?: unknown[] } }>;
      };

      const result = await tool.execute("id", { action: "setup_status" });

      expect(result.details.ok).toBe(false);
      expect(requireSetupCheck(result.details.checks, "twilio-voice-call-webhook").ok).toBe(false);
    },
  );

  it("opens local Chrome Meet in observe-only mode without BlackHole checks", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { methods, runCommandWithTimeout } = setup({
        defaultMode: "transcribe",
      });
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
        url: "https://meet.google.com/abc-defg-hij",
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
      expect(runCommandWithTimeout).not.toHaveBeenCalled();
      const openCall = callGatewayFromCli.mock.calls.find(
        ([, , request]) => requireRecord(request, "browser request").path === "/tabs/open",
      );
      if (!openCall) {
        throw new Error("Expected browser /tabs/open request");
      }
      expect(openCall[0]).toBe("browser.request");
      expect(openCall[2]).toEqual({
        method: "POST",
        path: "/tabs/open",
        timeoutMs: 30000,
        body: { url: "https://meet.google.com/abc-defg-hij" },
      });
      expect(openCall[3]).toEqual({ progress: false });
      expect(
        callGatewayFromCli.mock.calls.some(
          ([, , request]) => (request as { path?: string }).path === "/permissions/grant",
        ),
      ).toBe(false);
      const payload = requireRecord(respond.mock.calls[0]?.[1], "join response payload");
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
        ([, , request]) => (request as { path?: string }).path === "/act",
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
      const callGatewayFromCli = mockLocalMeetBrowserRequest({
        inCall: true,
        micMuted: false,
        title: "Meet call",
        url: "https://meet.google.com/abc-defg-hij",
      });
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
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
      const grantCall = callGatewayFromCli.mock.calls.find(
        ([, , request]) => requireRecord(request, "browser request").path === "/permissions/grant",
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
      expect(grantCall[3]).toEqual({ progress: false });
    } finally {
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
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
              url: request.body?.url ?? "https://meet.google.com/abc-defg-hij",
            };
          }
          if (request.path === "/tabs/focus" || request.path === "/permissions/grant") {
            return { ok: true };
          }
          if (request.path === "/act") {
            return {
              result: JSON.stringify({
                inCall: true,
                micMuted: false,
                title: "Meet call",
                url: "https://meet.google.com/abc-defg-hij",
              }),
            };
          }
          throw new Error(`unexpected browser request path ${request.path}`);
        },
      );
      chromeTransportTesting.setDepsForTest({ callGatewayFromCli });
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
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
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
              url: request.body?.url ?? "https://meet.google.com/abc-defg-hij",
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
                url: "https://meet.google.com/abc-defg-hij",
              }),
            };
          }
          throw new Error(`unexpected browser request path ${request.path}`);
        },
      );
      chromeTransportTesting.setDepsForTest({ callGatewayFromCli });
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
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
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
                    url: "https://meet.google.com/abc-defg-hij",
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
            url: request.body?.url ?? "https://meet.google.com/abc-defg-hij",
          };
        }
        if (request.path === "/tabs/focus") {
          return { ok: true };
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
                    url: "https://meet.google.com/abc-defg-hij",
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
                    url: "https://meet.google.com/abc-defg-hij",
                  },
            ),
          };
        }
        throw new Error(`unexpected browser request path ${request.path}`);
      },
    );
    chromeTransportTesting.setDepsForTest({ callGatewayFromCli });
    const { methods } = setup({
      defaultMode: "transcribe",
      defaultTransport: "chrome",
    });

    const join = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.join", {
      url: "https://meet.google.com/abc-defg-hij",
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
      ([, , request]) => requireRecord(request, "browser request").path === "/tabs/focus",
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
    expect(focusCall[3]).toEqual({ progress: false });
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
                            url: "https://meet.google.com/abc-defg-hij",
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
                    url: raw.body?.url ?? "https://meet.google.com/abc-defg-hij",
                  },
                },
              };
            }
            if (raw.path === "/tabs/focus" || raw.path === "/permissions/grant") {
              return { payload: { result: { ok: true } } };
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
                      url: "https://meet.google.com/abc-defg-hij",
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
      url: "https://meet.google.com/abc-defg-hij",
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
      document,
      location: {
        href: "https://meet.google.com/abc-defg-hij",
        hostname: "meet.google.com",
      },
      MutationObserver: class {
        observe = vi.fn();
      },
      window: windowState,
    });
    const inspect = new Script(
      `(${chromeTransportTesting.meetStatusScriptForTest({
        allowMicrophone: false,
        autoJoin: false,
        captureCaptions: true,
        guestName: "OpenClaw Agent",
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
      JSON,
      document,
      location: {
        href: "https://meet.google.com/abc-defg-hij",
        hostname: "meet.google.com",
      },
      window: {},
    });
    const inspect = new Script(
      `(${chromeTransportTesting.meetStatusScriptForTest({
        allowMicrophone: true,
        autoJoin: false,
        captureCaptions: false,
        guestName: "OpenClaw Agent",
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
      JSON,
      document,
      location: {
        href: "https://meet.google.com/abc-defg-hij",
        hostname: "meet.google.com",
      },
      window: {},
    });
    const inspect = new Script(
      `(${chromeTransportTesting.meetStatusScriptForTest({
        allowMicrophone: true,
        autoJoin: false,
        captureCaptions: false,
        guestName: "OpenClaw Agent",
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
      mockLocalMeetBrowserRequest({
        inCall: true,
        micMuted: true,
        title: "Meet call",
        url: "https://meet.google.com/abc-defg-hij",
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
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });

      const payload = requireRecord(respond.mock.calls[0]?.[1], "join response payload");
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

  it("keeps waiting while the Meet microphone is muted during intro readiness", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      let inspectCount = 0;
      mockLocalMeetBrowserRequest(() => {
        inspectCount += 1;
        return {
          inCall: true,
          micMuted: true,
          title: "Meet call",
          url: "https://meet.google.com/abc-defg-hij",
        };
      });
      const { methods } = setup({
        chrome: {
          audioBridgeCommand: ["bridge", "start"],
          waitForInCallMs: 1000,
        },
      });
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();
      vi.useFakeTimers();

      const run = handler?.({
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });
      await vi.advanceTimersByTimeAsync(2_000);
      await run;

      const payload = requireRecord(respond.mock.calls[0]?.[1], "join response payload");
      expect(payload.spoken).toBe(false);
      const session = requireRecord(payload.session, "join session");
      const chrome = requireRecord(session.chrome, "join chrome session");
      const health = requireRecord(chrome.health, "join chrome health");
      expect(health.micMuted).toBe(true);
      expect(health.speechReady).toBe(false);
      expect(health.speechBlockedReason).toBe("meet-microphone-muted");
      expect(inspectCount).toBeGreaterThanOrEqual(2);
    } finally {
      vi.useRealTimers();
      Object.defineProperty(process, "platform", { value: originalPlatform });
    }
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
      params: { url: "https://meet.google.com/abc-defg-hij" },
      respond,
    });

    expect(respond.mock.calls[0]?.[0]).toBe(true);
    expect(nodesList.mock.calls[0]).toStrictEqual([]);
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
      url: "https://meet.google.com/abc-defg-hij",
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
      body: { url: "https://meet.google.com/abc-defg-hij" },
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
    expect(startParams.url).toBe("https://meet.google.com/abc-defg-hij");
    expect(startParams.mode).toBe("transcribe");
    expect(startParams.launch).toBe(false);
    expect(startParams.joinTimeoutMs).toBe(30000);
    const payload = requireRecord(respond.mock.calls[0]?.[1], "join response payload");
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
      params: { url: "https://meet.google.com/abc-defg-hij" },
      respond: first,
    });
    await handler?.({
      params: { url: "https://meet.google.com/abc-defg-hij" },
      respond: second,
    });

    expect(
      nodesInvoke.mock.calls.filter(([call]) => call.command === "googlemeet.chrome"),
    ).toHaveLength(2);
    const payload = requireRecord(second.mock.calls[0]?.[1], "second join response payload");
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
      params: { url: "https://meet.google.com/abc-defg-hij" },
      respond: second,
    });

    expect(
      nodesInvoke.mock.calls.filter(([call]) => call.command === "googlemeet.chrome"),
    ).toHaveLength(2);
    const payload = requireRecord(second.mock.calls[0]?.[1], "second join response payload");
    const session = requireRecord(payload.session, "second join session");
    expect(session.notes).toContain("Reused existing active Meet session.");
  });

  it("reuses existing Meet browser tabs across URL query differences", async () => {
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
          if (proxy.path === "/act") {
            return {
              payload: {
                result: {
                  result: JSON.stringify({
                    inCall: true,
                    title: "Meet",
                    url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
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
      params: { url: "https://meet.google.com/abc-defg-hij" },
      respond,
    });

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
        return requireRecord(call.params, "node invoke params").path === "/tabs/open";
      }),
    ).toBe(false);
  });

  it("recovers and inspects an existing Meet tab without opening a new one", async () => {
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
                    url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
                  }),
                },
              },
            };
          }
          throw new Error(`unexpected browser proxy path ${proxy.path}`);
        },
      },
    );
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { found?: boolean; targetId?: string; browser?: unknown } }>;
    };

    const result = await tool.execute("id", {
      action: "recover_current_tab",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details.found).toBe(true);
    expect(result.details.targetId).toBe("existing-meet-tab");
    const browser = requireRecord(result.details.browser, "recovered browser state");
    expect(browser.manualActionRequired).toBe(true);
    expect(browser.manualActionReason).toBe("meet-admission-required");
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
        return requireRecord(call.params, "node invoke params").path === "/tabs/open";
      }),
    ).toBe(false);
  });

  it("recovers and inspects an existing local Chrome Meet tab", async () => {
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
        if (request.path === "/act") {
          return {
            result: JSON.stringify({
              inCall: false,
              manualActionRequired: true,
              manualActionReason: "meet-admission-required",
              manualActionMessage: "Admit the OpenClaw browser participant in Google Meet.",
              title: "Meet",
              url: "https://meet.google.com/abc-defg-hij?authuser=me@example.com",
            }),
          };
        }
        throw new Error(`unexpected browser request path ${request.path}`);
      },
    );
    chromeTransportTesting.setDepsForTest({ callGatewayFromCli });
    const { tools, nodesInvoke } = setup({ defaultTransport: "chrome" });
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{
        details: { transport?: string; found?: boolean; targetId?: string; browser?: unknown };
      }>;
    };

    const result = await tool.execute("id", {
      action: "recover_current_tab",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details.transport).toBe("chrome");
    expect(result.details.found).toBe(true);
    expect(result.details.targetId).toBe("local-meet-tab");
    const browser = requireRecord(result.details.browser, "recovered browser state");
    expect(browser.manualActionRequired).toBe(true);
    expect(browser.manualActionReason).toBe("meet-admission-required");
    const focusCall = callGatewayFromCli.mock.calls.find(
      ([, , request]) => requireRecord(request, "browser request").path === "/tabs/focus",
    );
    if (!focusCall) {
      throw new Error("Expected browser /tabs/focus request");
    }
    expect(focusCall[0]).toBe("browser.request");
    expect(requireRecord(focusCall[2], "focus request").method).toBe("POST");
    expect(requireRecord(focusCall[2], "focus request").path).toBe("/tabs/focus");
    expect(focusCall[3]).toEqual({ progress: false });
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
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { createdSession?: boolean } }>;
    };

    const result = await tool.execute("id", {
      action: "test_speech",
      url: "https://meet.google.com/abc-defg-hij",
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
        url: "https://meet.google.com/abc-defg-hij",
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
                      url: "https://meet.google.com/abc-defg-hij",
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
              url: request.body?.url ?? "https://meet.google.com/abc-defg-hij",
            };
          }
          if (request.path === "/tabs/focus" || request.path === "/permissions/grant") {
            return { ok: true };
          }
          if (request.path === "/act") {
            return { result: JSON.stringify(browserState) };
          }
          throw new Error(`unexpected browser request path ${request.path}`);
        },
      );
      chromeTransportTesting.setDepsForTest({ callGatewayFromCli });
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
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond: joinRespond,
      });
      const joinPayload = requireRecord(joinRespond.mock.calls[0]?.[1], "join response payload");
      const joinSession = requireRecord(joinPayload.session, "join session");
      const joinChrome = requireRecord(joinSession.chrome, "join chrome session");
      expect(requireRecord(joinChrome.health, "join chrome health").inCall).toBe(false);
      browserState = {
        inCall: true,
        micMuted: false,
        title: "Meet",
        url: "https://meet.google.com/abc-defg-hij",
      };
      await status?.({ params: {}, respond: statusRespond });

      const statusPayload = requireRecord(
        statusRespond.mock.calls[0]?.[1],
        "status response payload",
      );
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
          url: "https://meet.google.com/abc-defg-hij",
        },
        nodesInvokeResult: {
          payload: {
            launched: true,
          },
        },
      },
    );
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{ details: { listenVerified?: boolean; transcriptLines?: number } }>;
    };

    const result = await tool.execute("id", {
      action: "test_listen",
      url: "https://meet.google.com/abc-defg-hij",
      timeoutMs: 100,
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

  it("does not start a second realtime response for test speech", async () => {
    const runtime = new GoogleMeetRuntime({
      config: resolveGoogleMeetConfig({}),
      fullConfig: {} as never,
      runtime: {} as never,
      logger: noopLogger,
    });
    const session: GoogleMeetSession = {
      id: "meet_1",
      url: "https://meet.google.com/abc-defg-hij",
      transport: "chrome",
      mode: "agent",
      state: "active",
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
      participantIdentity: "signed-in Google Chrome profile",
      realtime: {
        enabled: true,
        strategy: "agent",
        transcriptionProvider: "openai",
        toolPolicy: "safe-read-only",
      },
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: { audioOutputActive: true, lastOutputBytes: 10 },
      },
      notes: [],
    };
    vi.spyOn(runtime, "list").mockReturnValue([session]);
    const join = vi.spyOn(runtime, "join").mockResolvedValue({ session, spoken: true });
    const speak = vi.spyOn(runtime, "speak");

    const result = await runtime.testSpeech({
      url: "https://meet.google.com/abc-defg-hij",
      message: "Say exactly: hello.",
    });

    expect(join).toHaveBeenCalledTimes(1);
    const joinArgs = requireRecord(join.mock.calls[0]?.[0], "test speech join args");
    expect(joinArgs.message).toBe("Say exactly: hello.");
    expect(joinArgs.mode).toBe("agent");
    expect(speak).not.toHaveBeenCalled();
    expect(result.spoken).toBe(true);
    expect(result.speechOutputVerified).toBe(false);
    expect(result.speechOutputTimedOut).toBe(false);
  });

  it("uses the requested bidirectional realtime mode for test speech", async () => {
    const runtime = new GoogleMeetRuntime({
      config: resolveGoogleMeetConfig({ defaultMode: "agent" }),
      fullConfig: {} as never,
      runtime: {} as never,
      logger: noopLogger,
    });
    const session: GoogleMeetSession = {
      id: "meet_1",
      url: "https://meet.google.com/abc-defg-hij",
      transport: "chrome",
      mode: "bidi",
      state: "active",
      createdAt: "2026-04-27T00:00:00.000Z",
      updatedAt: "2026-04-27T00:00:00.000Z",
      participantIdentity: "signed-in Google Chrome profile",
      realtime: {
        enabled: true,
        strategy: "bidi",
        provider: "openai",
        toolPolicy: "safe-read-only",
      },
      chrome: {
        audioBackend: "blackhole-2ch",
        launched: true,
        health: { audioOutputActive: true, lastOutputBytes: 10 },
      },
      notes: [],
    };
    vi.spyOn(runtime, "list").mockReturnValue([]);
    const join = vi.spyOn(runtime, "join").mockResolvedValue({ session, spoken: true });

    await runtime.testSpeech({
      url: "https://meet.google.com/abc-defg-hij",
      mode: "bidi",
      message: "Say exactly: hello.",
    });

    expect(join).toHaveBeenCalledTimes(1);
    const joinArgs = requireRecord(join.mock.calls[0]?.[0], "test speech join args");
    expect(joinArgs.message).toBe("Say exactly: hello.");
    expect(joinArgs.mode).toBe("bidi");
  });

  it("rejects observe-only mode for test speech", async () => {
    const runtime = new GoogleMeetRuntime({
      config: resolveGoogleMeetConfig({}),
      fullConfig: {} as never,
      runtime: {} as never,
      logger: noopLogger,
    });

    await expect(
      runtime.testSpeech({
        url: "https://meet.google.com/abc-defg-hij",
        mode: "transcribe",
      }),
    ).rejects.toThrow("test_speech requires mode: agent or bidi");
  });

  it("rejects realtime and Twilio modes for test listen", async () => {
    const runtime = new GoogleMeetRuntime({
      config: resolveGoogleMeetConfig({}),
      fullConfig: {} as never,
      runtime: {} as never,
      logger: noopLogger,
    });

    await expect(
      runtime.testListen({
        url: "https://meet.google.com/abc-defg-hij",
        mode: "agent",
      }),
    ).rejects.toThrow("test_listen requires mode: transcribe");

    await expect(
      runtime.testListen({
        url: "https://meet.google.com/abc-defg-hij",
        transport: "twilio",
      }),
    ).rejects.toThrow("test_listen supports chrome or chrome-node");
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
    const tool = tools[0] as {
      execute: (
        id: string,
        params: unknown,
      ) => Promise<{
        details: {
          manualActionRequired?: boolean;
          manualActionReason?: string;
          speechReady?: boolean;
          speechBlockedReason?: string;
          spoken?: boolean;
          session?: { chrome?: { health?: { manualActionRequired?: boolean } } };
        };
      }>;
    };

    const result = await tool.execute("id", {
      action: "test_speech",
      url: "https://meet.google.com/abc-defg-hij",
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

  it("refreshes browser health before blocking an explicit speech retry", async () => {
    let openedTab = false;
    let browserReady = false;
    const { methods, nodesInvoke } = setup(
      {
        defaultTransport: "chrome-node",
        defaultMode: "agent",
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
                            url: "https://meet.google.com/abc-defg-hij",
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
                    url: raw.body?.url ?? "https://meet.google.com/abc-defg-hij",
                  },
                },
              };
            }
            if (raw.path === "/tabs/focus" || raw.path === "/permissions/grant") {
              return { payload: { result: { ok: true } } };
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
                            url: "https://meet.google.com/abc-defg-hij",
                          }
                        : {
                            inCall: false,
                            manualActionRequired: true,
                            manualActionReason: "google-login-required",
                            manualActionMessage:
                              "Sign in to Google in the OpenClaw browser profile, then retry the Meet join.",
                            title: "Sign in - Google Accounts",
                            url: "https://accounts.google.com/signin",
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
      url: "https://meet.google.com/abc-defg-hij",
      message: "Say exactly: hello.",
    })) as {
      session: { id: string; chrome?: { health?: { speechBlockedReason?: string } } };
      spoken: boolean;
    };
    expect(join.spoken).toBe(false);
    expect(join.session.chrome?.health?.speechBlockedReason).toBe("google-login-required");

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
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { error?: string } }>;
    };

    const result = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
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
    const tool = tools[0] as {
      execute: (id: string, params: unknown) => Promise<{ details: { error?: string } }>;
    };

    const result = await tool.execute("id", {
      action: "join",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details.error).toContain("Multiple Google Meet-capable nodes connected");
    expect(result.details.error).toContain("chromeNode.node");
  });

  it("runs configured Chrome audio bridge commands before launch", async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, "platform", { value: "darwin" });
    try {
      const { methods, runCommandWithTimeout } = setup({
        defaultMode: "bidi",
        chrome: {
          waitForInCallMs: 1,
          audioBridgeHealthCommand: ["bridge", "status"],
          audioBridgeCommand: ["bridge", "start"],
        },
      });
      const callGatewayFromCli = mockLocalMeetBrowserRequest();
      const handler = methods.get("googlemeet.join") as
        | ((ctx: {
            params: Record<string, unknown>;
            respond: ReturnType<typeof vi.fn>;
          }) => Promise<void>)
        | undefined;
      const respond = vi.fn();

      await handler?.({
        params: { url: "https://meet.google.com/abc-defg-hij" },
        respond,
      });

      expect(respond.mock.calls[0]?.[0]).toBe(true);
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
      expect(request.body).toStrictEqual({ url: "https://meet.google.com/abc-defg-hij" });
      expect(extra).toStrictEqual({ progress: false });
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
    const makeProcess = (stdio: {
      stdin?: { write(chunk: unknown): unknown } | null;
      stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
    }): TestBridgeProcess => {
      const proc = new EventEmitter() as unknown as TestBridgeProcess;
      proc.stdin = stdio.stdin;
      proc.stdout = stdio.stdout;
      proc.stderr = new PassThrough();
      proc.killed = false;
      proc.kill = vi.fn(() => {
        proc.killed = true;
        return true;
      });
      return proc;
    };
    const outputStdin = new Writable({
      write(chunk, _encoding, done) {
        outputStdinWrites.push(Buffer.from(chunk));
        done();
      },
    });
    const inputProcess = makeProcess({ stdout: inputStdout, stdin: null });
    const outputProcess = makeProcess({ stdin: outputStdin, stdout: null });
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
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          loadSessionStore: vi.fn(() => sessionStore),
          saveSessionStore: vi.fn(async () => {}),
          updateSessionStore: vi.fn(async (_storePath, mutator) => mutator(sessionStore as never)),
          resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
        },
        runEmbeddedPiAgent: vi.fn(async () => ({
          payloads: [{ text: "Use the Portugal launch data." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startCommandAgentAudioBridge({
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
    await vi.advanceTimersByTimeAsync(GOOGLE_MEET_AGENT_TRANSCRIPT_DEBOUNCE_MS);

    expect(sendAudio).toHaveBeenCalledTimes(1);
    const audioChunk = sendAudio.mock.calls[0]?.[0];
    expect(Buffer.isBuffer(audioChunk)).toBe(true);
    expect(audioChunk.byteLength).toBeGreaterThan(0);
    expect(runtime.agent.runEmbeddedPiAgent).toHaveBeenCalled();
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

  it("preserves telephony TTS output formats when routing Google Meet agent audio", () => {
    const ulaw = Buffer.from([0xff, 0x7f, 0x00]);
    const pcmBridgeConfig = resolveGoogleMeetConfig({ chrome: { audioFormat: "pcm16-24khz" } });
    const ulawBridgeConfig = resolveGoogleMeetConfig({ chrome: { audioFormat: "g711-ulaw-8khz" } });

    expect(
      convertGoogleMeetTtsAudioForBridge(ulaw, 8_000, ulawBridgeConfig, "raw-8khz-8bit-mono-mulaw"),
    ).toEqual(ulaw);
    const pcmForMeet = convertGoogleMeetTtsAudioForBridge(
      ulaw,
      8_000,
      pcmBridgeConfig,
      "ulaw_8000",
    );
    expect(pcmForMeet.byteLength).toBe(18);
    expect(pcmForMeet).not.toEqual(ulaw);
    expect(() =>
      convertGoogleMeetTtsAudioForBridge(Buffer.from([1, 2, 3]), 8_000, pcmBridgeConfig, "mp3"),
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
    const makeProcess = (stdio: {
      stdin?: { write(chunk: unknown): unknown } | null;
      stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
    }): TestBridgeProcess => {
      const proc = new EventEmitter() as unknown as TestBridgeProcess;
      proc.stdin = stdio.stdin;
      proc.stdout = stdio.stdout;
      proc.stderr = new PassThrough();
      proc.killed = false;
      proc.kill = vi.fn(() => {
        proc.killed = true;
        return true;
      });
      return proc;
    };
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
    const inputProcess = makeProcess({ stdout: inputStdout, stdin: null });
    const outputProcess = makeProcess({ stdin: outputStdin, stdout: null });
    const replacementOutputProcess = makeProcess({ stdin: replacementOutputStdin, stdout: null });
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
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          loadSessionStore: vi.fn(() => sessionStore),
          saveSessionStore: vi.fn(async () => {}),
          updateSessionStore: vi.fn(async (_storePath, mutator) => mutator(sessionStore as never)),
          resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
        },
        runEmbeddedPiAgent: vi.fn(async (_request: unknown) => ({
          payloads: [{ text: "Use the Portugal launch data." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startCommandRealtimeAudioBridge({
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
    const firstToolResultCall = bridge.submitToolResult.mock.calls[0];
    expect(firstToolResultCall?.[0]).toBe("tool-call-1");
    expect(firstToolResultCall?.[2]).toStrictEqual({ willContinue: true });
    const progressPayload = requireRecord(firstToolResultCall?.[1], "tool progress payload");
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
    expect(runtime.agent.runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    const agentRequest = requireRecord(
      runtime.agent.runEmbeddedPiAgent.mock.calls[0]?.[0],
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

  it("defaults Chrome command-pair realtime to agent-driven talk-back", async () => {
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
    const makeProcess = (stdio: {
      stdin?: { write(chunk: unknown): unknown } | null;
      stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
    }): TestBridgeProcess => {
      const proc = new EventEmitter() as unknown as TestBridgeProcess;
      proc.stdin = stdio.stdin;
      proc.stdout = stdio.stdout;
      proc.stderr = new PassThrough();
      proc.killed = false;
      proc.kill = vi.fn(() => {
        proc.killed = true;
        return true;
      });
      return proc;
    };
    const outputProcess = makeProcess({
      stdin: new Writable({
        write(_chunk, _encoding, done) {
          done();
        },
      }),
      stdout: null,
    });
    const inputProcess = makeProcess({ stdout: inputStdout, stdin: null });
    const spawnMock = vi.fn().mockReturnValueOnce(outputProcess).mockReturnValueOnce(inputProcess);
    const sessionStore: Record<string, unknown> = {};
    const runtime = {
      agent: {
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        ensureAgentWorkspace: vi.fn(async () => {}),
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          loadSessionStore: vi.fn(() => sessionStore),
          saveSessionStore: vi.fn(async () => {}),
          updateSessionStore: vi.fn(async (_storePath, mutator) => mutator(sessionStore as never)),
          resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
        },
        runEmbeddedPiAgent: vi.fn(async (_request: unknown) => ({
          payloads: [{ text: "The launch is still on track." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startCommandRealtimeAudioBridge({
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
    callbacks?.onTranscript?.("user", "Are we still on track?", true);
    callbacks?.onTranscript?.("user", "Please include launch blockers.", true);

    await vi.waitFor(() => {
      expect(runtime.agent.runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
    });
    const consultArgs = requireRecord(
      (runtime.agent.runEmbeddedPiAgent.mock.calls as unknown[][])[0]?.[0],
      "default talk-back agent request",
    );
    expect(consultArgs.agentId).toBe("jay");
    expect(consultArgs.spawnedBy).toBe("agent:jay:main");
    expect(consultArgs.sessionKey).toBe("agent:jay:subagent:google-meet:meet-1");
    expect(consultArgs.sandboxSessionKey).toBe("agent:jay:subagent:google-meet:meet-1");
    expect(JSON.stringify(consultArgs)).toContain(
      "Are we still on track?\\nPlease include launch blockers.",
    );
    expect(sendUserMessage).toHaveBeenCalledTimes(1);
    const sentUserMessage = sendUserMessage.mock.calls[0]?.[0];
    expect(typeof sentUserMessage).toBe("string");
    expect(sentUserMessage).toContain(JSON.stringify("The launch is still on track."));
    expect(sessionStore).toHaveProperty("agent:jay:subagent:google-meet:meet-1");

    await handle.stop();
  });

  it("tracks queued playback time when suppressing realtime input echo", () => {
    const first = extendGoogleMeetOutputEchoSuppression({
      audio: Buffer.alloc(48_000),
      audioFormat: "pcm16-24khz",
      nowMs: 1_000,
      lastOutputPlayableUntilMs: 0,
      suppressInputUntilMs: 0,
    });
    const second = extendGoogleMeetOutputEchoSuppression({
      audio: Buffer.alloc(48_000),
      audioFormat: "pcm16-24khz",
      nowMs: 1_100,
      lastOutputPlayableUntilMs: first.lastOutputPlayableUntilMs,
      suppressInputUntilMs: first.suppressInputUntilMs,
    });

    expect(first.durationMs).toBe(1_000);
    expect(first.lastOutputPlayableUntilMs).toBe(2_000);
    expect(first.suppressInputUntilMs).toBe(5_000);
    expect(second.durationMs).toBe(1_000);
    expect(second.lastOutputPlayableUntilMs).toBe(3_000);
    expect(second.suppressInputUntilMs).toBe(6_000);
  });

  it("detects assistant transcript echoes before agent consult", () => {
    const nowMs = Date.parse("2026-05-04T01:00:00.000Z");
    const transcript = [
      {
        at: new Date(nowMs - 1_000).toISOString(),
        role: "assistant" as const,
        text: "Hi Molty, glad to have you here. Let me know if there's anything specific you'd like to cover or if you need any support during the meeting.",
      },
    ];

    expect(
      isGoogleMeetLikelyAssistantEchoTranscript({
        transcript,
        text: "Let me know if there's anything specific you'd like to cover or if you need any support during the",
        nowMs,
      }),
    ).toBe(true);
    expect(
      isGoogleMeetLikelyAssistantEchoTranscript({
        transcript,
        text: "Tell me a story.",
        nowMs,
      }),
    ).toBe(false);
    expect(
      isGoogleMeetLikelyAssistantEchoTranscript({
        transcript,
        text: "yes yes yes yes",
        nowMs,
      }),
    ).toBe(false);
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
    const makeProcess = (stdio: {
      stdin?: { write(chunk: unknown): unknown } | null;
      stdout?: { on(event: "data", listener: (chunk: unknown) => void): unknown } | null;
    }): TestBridgeProcess => {
      const proc = new EventEmitter() as unknown as TestBridgeProcess;
      proc.stdin = stdio.stdin;
      proc.stdout = stdio.stdout;
      proc.stderr = new PassThrough();
      proc.killed = false;
      proc.kill = vi.fn(() => {
        proc.killed = true;
        return true;
      });
      return proc;
    };
    const outputProcess = makeProcess({ stdin: outputStdin, stdout: null });
    const inputProcess = makeProcess({ stdout: inputStdout, stdin: null });
    const bargeInProcess = makeProcess({ stdout: bargeInStdout, stdin: null });
    const replacementOutputProcess = makeProcess({ stdin: replacementOutputStdin, stdout: null });
    const spawnMock = vi
      .fn()
      .mockReturnValueOnce(outputProcess)
      .mockReturnValueOnce(inputProcess)
      .mockReturnValueOnce(bargeInProcess)
      .mockReturnValueOnce(replacementOutputProcess);

    const handle = await startCommandRealtimeAudioBridge({
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
    const fullConfig = { models: { providers: {} } } as never;
    const sessionStore: Record<string, unknown> = {};
    const runtime = {
      nodes: {
        invoke: vi.fn(async ({ params }: { params?: { action?: string; base64?: string } }) => {
          if (params?.action === "pullAudio") {
            pullCount += 1;
            if (pullCount === 1) {
              return { bridgeId: "bridge-1", base64: Buffer.from([9, 8, 7]).toString("base64") };
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { bridgeId: "bridge-1" };
          }
          return { ok: true };
        }),
      },
      agent: {
        resolveAgentDir: vi.fn(() => "/tmp/agent"),
        resolveAgentWorkspaceDir: vi.fn(() => "/tmp/workspace"),
        ensureAgentWorkspace: vi.fn(async () => {}),
        session: {
          resolveStorePath: vi.fn(() => "/tmp/sessions.json"),
          loadSessionStore: vi.fn(() => sessionStore),
          saveSessionStore: vi.fn(async () => {}),
          updateSessionStore: vi.fn(async (_storePath, mutator) => mutator(sessionStore as never)),
          resolveSessionFilePath: vi.fn(() => "/tmp/session.json"),
        },
        runEmbeddedPiAgent: vi.fn(async () => ({
          payloads: [{ text: "Use the launch update." }],
          meta: {},
        })),
        resolveAgentTimeoutMs: vi.fn(() => 1000),
      },
    };

    const handle = await startNodeRealtimeAudioBridge({
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
    const firstToolResultCall = bridge.submitToolResult.mock.calls[0];
    expect(firstToolResultCall?.[0]).toBe("tool-call-1");
    expect(firstToolResultCall?.[2]).toStrictEqual({ willContinue: true });
    const progressPayload = requireRecord(firstToolResultCall?.[1], "node tool progress payload");
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
            await new Promise((resolve) => setTimeout(resolve, 10));
            return { bridgeId: "bridge-1" };
          }
          return { ok: true };
        }),
      },
    };

    const handle = await startNodeRealtimeAudioBridge({
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

    await vi.waitFor(() => {
      expect(sendAudio).toHaveBeenCalledWith(Buffer.from([5, 4, 3]));
    });
    expect(bridge.close).not.toHaveBeenCalled();
    const health = handle.getHealth();
    expect(health.audioInputActive).toBe(true);
    expect(health.lastInputBytes).toBe(3);
    expect(health.consecutiveInputErrors).toBe(0);

    await handle.stop();
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
      const handle = await startNodeRealtimeAudioBridge({
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
      await handleGoogleMeetNodeHostCommand(
        JSON.stringify({ action: "list", url: "https://meet.google.com/abc-defg-hij" }),
      ),
    );
    expect(listed).toEqual({ bridges: [] });

    await expect(
      handleGoogleMeetNodeHostCommand(JSON.stringify({ action: "stopByUrl" })),
    ).rejects.toThrow("url required");
  });
});
