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
    expect(resolveGoogleMeetConfig({})).toMatchObject({
      enabled: true,
      defaults: {},
      preview: { enrollmentAcknowledged: false },
      defaultTransport: "chrome",
      defaultMode: "agent",
      chrome: {
        audioBackend: "blackhole-2ch",
        launch: true,
        guestName: "OpenClaw Agent",
        reuseExistingTab: true,
        autoJoin: true,
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
      },
      voiceCall: {
        enabled: true,
        requestTimeoutMs: 30000,
        dtmfDelayMs: 12000,
        postDtmfSpeechDelayMs: 5000,
      },
      realtime: {
        strategy: "agent",
        provider: "openai",
        transcriptionProvider: "openai",
        introMessage: "Say exactly: I'm here and listening.",
        toolPolicy: "safe-read-only",
      },
      oauth: {},
      auth: { provider: "google-oauth" },
    });
    expect(resolveGoogleMeetConfig({ defaultMode: "realtime" }).defaultMode).toBe("agent");
    expect(resolveGoogleMeetConfig({}).realtime.instructions).toContain("openclaw_agent_consult");
  });

  it("resolves separate realtime providers for agent transcription and bidi voice", () => {
    expect(
      resolveGoogleMeetConfig({
        realtime: {
          provider: "openai",
          transcriptionProvider: "openai",
          voiceProvider: "google",
          model: "gemini-2.5-flash-native-audio-preview-12-2025",
        },
      }).realtime,
    ).toMatchObject({
      provider: "openai",
      transcriptionProvider: "openai",
      voiceProvider: "google",
      model: "gemini-2.5-flash-native-audio-preview-12-2025",
    });
  });

  it("keeps realtime.provider as the transcription compatibility fallback", () => {
    expect(
      resolveGoogleMeetConfig({
        realtime: {
          provider: "custom-stt",
        },
      }).realtime,
    ).toMatchObject({
      provider: "custom-stt",
      transcriptionProvider: "custom-stt",
    });
    expect(
      resolveGoogleMeetConfig({
        realtime: {
          provider: "google",
        },
      }).realtime,
    ).toMatchObject({
      provider: "google",
      transcriptionProvider: "openai",
    });
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

    expect(
      resolveGoogleMeetRealtimeProvider({
        config,
        fullConfig: {} as never,
        providers: voiceProviders,
      }),
    ).toMatchObject({
      provider: { id: "google" },
      providerConfig: { model: "gemini-2.5-flash-native-audio-preview-12-2025" },
    });
    expect(
      resolveGoogleMeetRealtimeTranscriptionProvider({
        config,
        fullConfig: {} as never,
        providers: transcriptionProviders,
      }),
    ).toMatchObject({
      provider: { id: "openai" },
    });
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

    expect(entry.configSchema.uiHints).toMatchObject({
      "chrome.audioBufferBytes": expect.objectContaining({ advanced: true }),
      "chrome.bargeInInputCommand": expect.objectContaining({ advanced: true }),
      "chrome.bargeInRmsThreshold": expect.objectContaining({ advanced: true }),
      "chrome.bargeInPeakThreshold": expect.objectContaining({ advanced: true }),
      "chrome.bargeInCooldownMs": expect.objectContaining({ advanced: true }),
      "voiceCall.postDtmfSpeechDelayMs": expect.objectContaining({ advanced: true }),
    });
    expect(manifest.uiHints).toMatchObject({
      "chrome.audioBufferBytes": expect.objectContaining({ advanced: true }),
      "chrome.bargeInInputCommand": expect.objectContaining({ advanced: true }),
      "chrome.bargeInRmsThreshold": expect.objectContaining({ advanced: true }),
      "chrome.bargeInPeakThreshold": expect.objectContaining({ advanced: true }),
      "chrome.bargeInCooldownMs": expect.objectContaining({ advanced: true }),
      "voiceCall.postDtmfSpeechDelayMs": expect.objectContaining({ advanced: true }),
    });
    expect(configSchema.properties?.chrome?.properties).toMatchObject({
      audioBufferBytes: expect.objectContaining({ type: "number", default: 4096 }),
      bargeInInputCommand: expect.objectContaining({
        type: "array",
        items: { type: "string" },
      }),
      bargeInRmsThreshold: expect.objectContaining({ type: "number", default: 650 }),
      bargeInPeakThreshold: expect.objectContaining({ type: "number", default: 2500 }),
      bargeInCooldownMs: expect.objectContaining({ type: "number", default: 900 }),
    });
    expect(configSchema.properties?.voiceCall?.properties).toMatchObject({
      postDtmfSpeechDelayMs: expect.objectContaining({ type: "number", default: 5000 }),
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
    expect(
      resolveGoogleMeetConfig({
        chrome: {
          audioInputCommand: ["capture-legacy"],
          audioOutputCommand: ["play-legacy"],
        },
      }).chrome,
    ).toMatchObject({
      audioFormat: "g711-ulaw-8khz",
      audioInputCommand: ["capture-legacy"],
      audioOutputCommand: ["play-legacy"],
    });
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
    expect(
      resolveGoogleMeetConfigWithEnv(
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
      ),
    ).toMatchObject({
      defaults: { meeting: "https://meet.google.com/abc-defg-hij" },
      preview: { enrollmentAcknowledged: true },
      oauth: {
        clientId: "client-id",
        clientSecret: "client-secret",
        refreshToken: "refresh-token",
        accessToken: "access-token",
        expiresAt: 123456,
      },
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

    expect(nodeHostCommands).toContainEqual(
      expect.objectContaining({
        command: "googlemeet.chrome",
        cap: "google-meet",
        handle: expect.any(Function),
      }),
    );
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
    expect(tool.parameters).toMatchObject({
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: [
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
          ],
          description: expect.stringContaining("recover_current_tab"),
        },
        transport: { type: "string", enum: ["chrome", "chrome-node", "twilio"] },
        mode: { type: "string", enum: ["agent", "bidi", "transcribe"] },
      },
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
    await expect(
      findGoogleMeetCalendarEvent({
        accessToken: "token",
        now: new Date("2026-04-25T09:50:00Z"),
        timeMin: "2026-04-25T00:00:00Z",
        timeMax: "2026-04-26T00:00:00Z",
      }),
    ).resolves.toMatchObject({
      calendarId: "primary",
      meetingUri: "https://meet.google.com/abc-defg-hij",
      event: { summary: "Project sync" },
    });
    await expect(
      listGoogleMeetCalendarEvents({
        accessToken: "token",
        now: new Date("2026-04-25T09:50:00Z"),
        timeMin: "2026-04-25T00:00:00Z",
        timeMax: "2026-04-26T00:00:00Z",
      }),
    ).resolves.toMatchObject({
      events: [
        {
          meetingUri: "https://meet.google.com/abc-defg-hij",
          selected: true,
        },
      ],
    });
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
    expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        policy: { allowedHostnames: ["www.googleapis.com"] },
        auditContext: "google-meet.calendar.events.list",
      }),
    );
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

    await expect(
      fetchGoogleMeetSpace({
        accessToken: "token",
        meeting: "spaces/abc-defg-hij",
      }),
    ).resolves.toMatchObject({ name: "spaces/abc-defg-hij" });
    expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://meet.googleapis.com/v2/spaces/abc-defg-hij",
        init: expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer token" }),
        }),
        policy: { allowedHostnames: ["meet.googleapis.com"] },
        auditContext: "google-meet.spaces.get",
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "https://meet.googleapis.com/v2/spaces/abc-defg-hij",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
    );
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

    await expect(createGoogleMeetSpace({ accessToken: "token" })).resolves.toMatchObject({
      meetingUri: "https://meet.google.com/new-abcd-xyz",
      space: { name: "spaces/new-space" },
    });
    expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://meet.googleapis.com/v2/spaces",
        init: expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({ Authorization: "Bearer token" }),
          body: "{}",
        }),
        policy: { allowedHostnames: ["meet.googleapis.com"] },
        auditContext: "google-meet.spaces.create",
      }),
    );
  });

  it("lists Meet artifact metadata for the latest conference record by default", async () => {
    const fetchMock = stubMeetArtifactsApi();

    await expect(
      fetchGoogleMeetArtifacts({
        accessToken: "token",
        meeting: "abc-defg-hij",
        pageSize: 2,
      }),
    ).resolves.toMatchObject({
      input: "abc-defg-hij",
      space: { name: "spaces/abc-defg-hij" },
      conferenceRecords: [{ name: "conferenceRecords/rec-1" }],
      artifacts: [
        {
          conferenceRecord: { name: "conferenceRecords/rec-1" },
          participants: [{ name: "conferenceRecords/rec-1/participants/p1" }],
          recordings: [{ name: "conferenceRecords/rec-1/recordings/r1" }],
          transcripts: [{ name: "conferenceRecords/rec-1/transcripts/t1" }],
          transcriptEntries: [
            {
              transcript: "conferenceRecords/rec-1/transcripts/t1",
              entries: [
                {
                  name: "conferenceRecords/rec-1/transcripts/t1/entries/e1",
                  text: "Hello from the transcript.",
                },
              ],
            },
          ],
          smartNotes: [{ name: "conferenceRecords/rec-1/smartNotes/sn1" }],
        },
      ],
    });

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
    expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://meet.googleapis.com/v2/conferenceRecords/rec-1/smartNotes?pageSize=2",
        auditContext: "google-meet.conferenceRecords.smartNotes.list",
      }),
    );
    expect(fetchGuardMocks.fetchWithSsrFGuard).toHaveBeenCalledWith(
      expect.objectContaining({
        url: "https://meet.googleapis.com/v2/conferenceRecords/rec-1/transcripts/t1/entries?pageSize=2",
        auditContext: "google-meet.conferenceRecords.transcripts.entries.list",
      }),
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

    await expect(
      fetchGoogleMeetArtifacts({
        accessToken: "token",
        conferenceRecord: "rec-1",
        includeDocumentBodies: true,
      }),
    ).resolves.toMatchObject({
      artifacts: [
        {
          transcripts: [{ documentText: "Transcript document body." }],
          smartNotes: [{ documentText: "Smart note document body." }],
        },
      ],
    });
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

    await expect(
      fetchLatestGoogleMeetConferenceRecord({
        accessToken: "token",
        meeting: "abc-defg-hij",
      }),
    ).resolves.toMatchObject({
      input: "abc-defg-hij",
      space: { name: "spaces/abc-defg-hij" },
      conferenceRecord: { name: "conferenceRecords/rec-1" },
    });

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

    await expect(
      fetchGoogleMeetAttendance({
        accessToken: "token",
        conferenceRecord: "rec-1",
        pageSize: 3,
      }),
    ).resolves.toMatchObject({
      input: "rec-1",
      conferenceRecords: [{ name: "conferenceRecords/rec-1" }],
      attendance: [
        {
          conferenceRecord: "conferenceRecords/rec-1",
          participant: "conferenceRecords/rec-1/participants/p1",
          displayName: "Alice",
          user: "users/alice",
          sessions: [
            {
              name: "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
            },
          ],
        },
      ],
    });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://meet.googleapis.com/v2/conferenceRecords/rec-1",
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer token" }),
      }),
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

    await expect(
      fetchGoogleMeetAttendance({
        accessToken: "token",
        conferenceRecord: "rec-1",
      }),
    ).resolves.toMatchObject({
      attendance: [
        {
          displayName: "Alice",
          participants: [
            "conferenceRecords/rec-1/participants/p1",
            "conferenceRecords/rec-1/participants/p2",
          ],
          firstJoinTime: "2026-04-25T10:10:00.000Z",
          lastLeaveTime: "2026-04-25T10:50:00.000Z",
          durationMs: 1_800_000,
          late: true,
          earlyLeave: true,
          sessions: [
            { name: expect.stringContaining("/p1/") },
            { name: expect.stringContaining("/p2/") },
          ],
        },
      ],
    });
  });

  it("surfaces Developer Preview acknowledgment blockers in preflight reports", () => {
    expect(
      buildGoogleMeetPreflightReport({
        input: "abc-defg-hij",
        space: { name: "spaces/abc-defg-hij" },
        previewAcknowledged: false,
        tokenSource: "cached-access-token",
      }),
    ).toMatchObject({
      resolvedSpaceName: "spaces/abc-defg-hij",
      previewAcknowledged: false,
      blockers: [expect.stringContaining("Developer Preview Program")],
    });
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

    expect(result.details.session).toMatchObject({
      transport: "twilio",
      mode: "agent",
      twilio: {
        dialInNumber: "+15551234567",
        pinProvided: true,
        dtmfSequence: "wwwwwwwwwwwwwwwwwwwwwwww123456#",
        voiceCallId: "call-1",
        dtmfSent: true,
        introSent: true,
      },
    });
    expect(voiceCallMocks.joinMeetViaVoiceCallGateway).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ defaultTransport: "twilio" }),
        dialInNumber: "+15551234567",
        dtmfSequence: "wwwwwwwwwwwwwwwwwwwwwwww123456#",
        logger: expect.objectContaining({ info: expect.any(Function) }),
        message: "Say exactly: I'm here and listening.",
        sessionKey: expect.stringMatching(/^voice:google-meet:meet_/),
      }),
    );
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

    expect(gatewayParams[0]).toMatchObject({
      url: "https://meet.google.com/abc-defg-hij",
      requesterSessionKey: "agent:main:discord:channel:general",
    });
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

    expect(voiceCallMocks.endMeetVoiceCallGatewayCall).toHaveBeenCalledWith({
      config: expect.objectContaining({ defaultTransport: "twilio" }),
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

    expect(spoken.details).toMatchObject({ spoken: true });
    expect(voiceCallMocks.speakMeetViaVoiceCallGateway).toHaveBeenCalledWith({
      config: expect.objectContaining({ defaultTransport: "twilio" }),
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
      expect(result.details.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "audio-bridge",
            ok: false,
            message: expect.stringContaining("chrome.audioBridgeCommand is bidi-only"),
          }),
        ]),
      );
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

    expect(result.details.attendance).toEqual([expect.objectContaining({ displayName: "Alice" })]);
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

      expect(result.details.files).toEqual(
        expect.arrayContaining([path.join(tempDir, "manifest.json")]),
      );
      expect(result.details.zipFile).toBe(`${tempDir}.zip`);
      const manifest = JSON.parse(readFileSync(path.join(tempDir, "manifest.json"), "utf8"));
      expect(manifest).toMatchObject({
        request: {
          conferenceRecord: "rec-1",
          includeDocumentBodies: true,
        },
        counts: {
          attendanceRows: 1,
          warnings: 0,
        },
        files: expect.arrayContaining(["summary.md", "manifest.json"]),
      });
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

      expect(result.details).toMatchObject({
        dryRun: true,
        manifest: {
          files: expect.arrayContaining(["summary.md", "manifest.json"]),
        },
      });
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

    expect(result.details.conferenceRecord).toMatchObject({ name: "conferenceRecords/rec-1" });
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

    expect(result.details.calendarEvent).toMatchObject({
      meetingUri: "https://meet.google.com/abc-defg-hij",
    });
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

    expect(result.details.events).toEqual([
      expect.objectContaining({
        selected: true,
        meetingUri: "https://meet.google.com/abc-defg-hij",
      }),
    ]);
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
    expect(result.details.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "chrome-node-connected",
          ok: false,
          message: expect.stringContaining("parallels-macos"),
        }),
      ]),
    );
    const check = result.details.checks?.find(
      (item) => (item as { id?: unknown }).id === "chrome-node-connected",
    ) as { message?: string } | undefined;
    expect(check?.message).toContain("offline");
    expect(check?.message).toContain("missing googlemeet.chrome");
    expect(check?.message).toContain("missing browser.proxy/browser capability");
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
      expect(result.details.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "chrome-local-audio-device",
            ok: false,
            message: expect.stringContaining("BlackHole 2ch audio device not found"),
          }),
        ]),
      );
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
      expect(result.details.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "chrome-local-audio-commands",
            ok: false,
            message: "Chrome audio command missing: sox",
          }),
        ]),
      );
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
      expect(result.details.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "chrome-local-audio-commands",
            ok: false,
            message: "Chrome audio command missing: missing-barge-capture",
          }),
        ]),
      );
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
      expect(result.details.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "audio-bridge",
            ok: true,
            message: "Chrome observe-only mode does not require a realtime audio bridge",
          }),
        ]),
      );
      expect(
        result.details.checks?.filter((check) => check.id === "chrome-local-audio-device"),
      ).toEqual([]);
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
    expect(result.details.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "twilio-voice-call-plugin",
          ok: true,
        }),
        expect.objectContaining({
          id: "twilio-voice-call-credentials",
          ok: true,
        }),
        expect.objectContaining({
          id: "twilio-voice-call-webhook",
          ok: true,
        }),
      ]),
    );
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
    expect(result.details.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "twilio-voice-call-plugin",
          ok: false,
        }),
        expect.objectContaining({
          id: "twilio-voice-call-credentials",
          ok: false,
        }),
      ]),
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
    expect(result.details.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "twilio-voice-call-plugin",
          ok: false,
        }),
      ]),
    );
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
    expect(result.details.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "twilio-dial-plan",
          ok: false,
          message: expect.stringContaining("dial-in phone number"),
        }),
      ]),
    );
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
    expect(result.details.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "twilio-dial-plan",
          ok: true,
          message: expect.stringContaining("request includes"),
        }),
      ]),
    );
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
      expect(result.details.checks).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            id: "twilio-voice-call-webhook",
            ok: false,
          }),
        ]),
      );
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
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "browser.request",
        expect.any(Object),
        expect.objectContaining({
          method: "POST",
          path: "/tabs/open",
          body: { url: "https://meet.google.com/abc-defg-hij" },
        }),
        { progress: false },
      );
      expect(
        callGatewayFromCli.mock.calls.some(
          ([, , request]) => (request as { path?: string }).path === "/permissions/grant",
        ),
      ).toBe(false);
      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        session: {
          chrome: {
            health: {
              captioning: true,
              captionsEnabledAttempted: true,
              transcriptLines: 1,
              lastCaptionSpeaker: "Alice",
              lastCaptionText: "Can everyone hear the agent?",
              recentTranscript: [
                {
                  speaker: "Alice",
                  text: "Can everyone hear the agent?",
                },
              ],
            },
          },
        },
      });
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
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "browser.request",
        expect.any(Object),
        expect.objectContaining({
          method: "POST",
          path: "/permissions/grant",
          body: expect.objectContaining({
            origin: "https://meet.google.com",
            permissions: ["audioCapture", "videoCapture"],
            targetId: "local-meet-tab",
          }),
        }),
        { progress: false },
      );
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

    expect(status.session?.chrome?.health).toMatchObject({
      captioning: true,
      transcriptLines: 1,
      lastCaptionText: "Please capture this.",
    });
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "browser.request",
      expect.any(Object),
      expect.objectContaining({
        method: "POST",
        path: "/tabs/focus",
        body: { targetId: "local-meet-tab" },
      }),
      { progress: false },
    );
  });

  it("does not mutate realtime browser prompts when status is requested", async () => {
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
              return { payload: { result: { running: true, tabs: [] } } };
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
    nodesInvoke.mockClear();

    const status = (await invokeGoogleMeetGatewayMethodForTest(methods, "googlemeet.status", {
      sessionId: join.session.id,
    })) as { session?: { chrome?: { health?: { manualActionRequired?: boolean } } } };

    expect(status.session?.chrome?.health?.manualActionRequired).toBe(true);
    expect(nodesInvoke).not.toHaveBeenCalledWith(
      expect.objectContaining({ command: "browser.proxy" }),
    );
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

      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        spoken: false,
        session: {
          chrome: {
            health: {
              micMuted: true,
              speechReady: false,
              speechBlockedReason: "meet-microphone-muted",
            },
          },
        },
      });
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

      expect(respond.mock.calls[0]?.[1]).toMatchObject({
        spoken: false,
        session: {
          chrome: {
            health: {
              micMuted: true,
              speechReady: false,
              speechBlockedReason: "meet-microphone-muted",
            },
          },
        },
      });
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
    expect(nodesList.mock.calls[0]).toEqual([]);
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        command: "googlemeet.chrome",
        params: expect.objectContaining({
          action: "stopByUrl",
          url: "https://meet.google.com/abc-defg-hij",
          mode: "transcribe",
        }),
      }),
    );
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        command: "browser.proxy",
        params: expect.objectContaining({
          path: "/tabs/open",
          body: { url: "https://meet.google.com/abc-defg-hij" },
        }),
      }),
    );
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        command: "googlemeet.chrome",
        params: expect.objectContaining({
          action: "start",
          url: "https://meet.google.com/abc-defg-hij",
          mode: "transcribe",
          launch: false,
        }),
      }),
    );
    expect(respond.mock.calls[0]?.[1]).toMatchObject({
      session: {
        transport: "chrome-node",
        chrome: {
          nodeId: "node-1",
          launched: true,
        },
      },
    });
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
    expect(second.mock.calls[0]?.[1]).toMatchObject({
      session: {
        chrome: { health: { inCall: true, micMuted: false } },
        notes: expect.arrayContaining(["Reused existing active Meet session."]),
      },
    });
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
    expect(second.mock.calls[0]?.[1]).toMatchObject({
      session: {
        notes: expect.arrayContaining(["Reused existing active Meet session."]),
      },
    });
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

    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          path: "/tabs/focus",
          body: { targetId: "existing-meet-tab" },
        }),
      }),
    );
    expect(nodesInvoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ path: "/tabs/open" }),
      }),
    );
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
      ) => Promise<{ details: { found?: boolean; browser?: unknown } }>;
    };

    const result = await tool.execute("id", {
      action: "recover_current_tab",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details).toMatchObject({
      found: true,
      targetId: "existing-meet-tab",
      browser: {
        manualActionRequired: true,
        manualActionReason: "meet-admission-required",
      },
    });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({
          path: "/tabs/focus",
          body: { targetId: "existing-meet-tab" },
        }),
      }),
    );
    expect(nodesInvoke).not.toHaveBeenCalledWith(
      expect.objectContaining({
        params: expect.objectContaining({ path: "/tabs/open" }),
      }),
    );
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
      ) => Promise<{ details: { transport?: string; found?: boolean; browser?: unknown } }>;
    };

    const result = await tool.execute("id", {
      action: "recover_current_tab",
      url: "https://meet.google.com/abc-defg-hij",
    });

    expect(result.details).toMatchObject({
      transport: "chrome",
      found: true,
      targetId: "local-meet-tab",
      browser: {
        manualActionRequired: true,
        manualActionReason: "meet-admission-required",
      },
    });
    expect(callGatewayFromCli).toHaveBeenCalledWith(
      "browser.request",
      expect.any(Object),
      expect.objectContaining({ method: "POST", path: "/tabs/focus" }),
      { progress: false },
    );
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

    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "googlemeet.chrome",
        params: expect.objectContaining({ action: "start" }),
      }),
    );
    expect(result.details).toMatchObject({ createdSession: true });
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
      expect(joinRespond.mock.calls[0]?.[1]).toMatchObject({
        session: { chrome: { health: { inCall: false } } },
      });
      browserState = {
        inCall: true,
        micMuted: false,
        title: "Meet",
        url: "https://meet.google.com/abc-defg-hij",
      };
      await status?.({ params: {}, respond: statusRespond });

      expect(statusRespond.mock.calls[0]?.[1]).toMatchObject({
        sessions: [
          {
            chrome: {
              health: {
                inCall: true,
                speechReady: false,
                speechBlockedReason: "audio-bridge-unavailable",
              },
            },
          },
        ],
      });
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

    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "googlemeet.chrome",
        params: expect.objectContaining({
          action: "start",
          mode: "transcribe",
        }),
      }),
    );
    expect(result.details).toMatchObject({ listenVerified: true, transcriptLines: 1 });
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

    expect(join).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Say exactly: hello.",
        mode: "agent",
      }),
    );
    expect(speak).not.toHaveBeenCalled();
    expect(result.spoken).toBe(true);
    expect(result.speechOutputVerified).toBe(false);
    expect(result.speechOutputTimedOut).toBe(false);
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

    expect(result.details).toMatchObject({
      manualActionRequired: true,
      manualActionReason: "google-login-required",
      spoken: false,
      speechReady: false,
      speechBlockedReason: "google-login-required",
      session: {
        chrome: {
          health: {
            manualActionRequired: true,
            manualActionReason: "google-login-required",
            speechReady: false,
            speechBlockedReason: "google-login-required",
          },
        },
      },
    });
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

    expect(retry).toMatchObject({
      found: true,
      spoken: false,
      session: {
        chrome: {
          health: {
            inCall: true,
            manualActionRequired: false,
            speechBlockedReason: "audio-bridge-unavailable",
          },
        },
      },
    });
    expect(nodesInvoke).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "browser.proxy",
        params: expect.objectContaining({
          path: "/tabs/focus",
          body: { targetId: "tab-1" },
        }),
      }),
    );
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
      expect(callGatewayFromCli).toHaveBeenCalledWith(
        "browser.request",
        expect.any(Object),
        expect.objectContaining({
          method: "POST",
          path: "/tabs/open",
          body: { url: "https://meet.google.com/abc-defg-hij" },
        }),
        { progress: false },
      );
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

    expect(sendAudio).toHaveBeenCalledWith(expect.any(Buffer));
    expect(runtime.agent.runEmbeddedPiAgent).toHaveBeenCalled();
    expect(runtime.tts.textToSpeechTelephony).toHaveBeenCalledWith({
      text: "Use the Portugal launch data.",
      cfg: {},
    });
    expect(noopLogger.info).toHaveBeenCalledWith(
      "[google-meet] agent TTS: provider=elevenlabs model=eleven_multilingual_v2 voice=pMsXgVXv3BLzUgSXRplE outputFormat=pcm16 sampleRate=24000",
    );
    expect(Buffer.concat(outputStdinWrites)).toEqual(Buffer.from([1, 0, 2, 0]));
    expect(handle.getHealth()).toMatchObject({
      providerConnected: true,
      audioInputActive: true,
      audioOutputActive: true,
      realtimeTranscriptLines: 2,
      lastRealtimeTranscriptRole: "assistant",
    });
    const talkEventTypes = handle.getHealth().recentTalkEvents?.map((event) => event.type) ?? [];
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
      "[google-meet] realtime voice bridge starting: strategy=bidi provider=openai model=gpt-realtime audioFormat=pcm16-24khz",
    );
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
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      1,
      "tool-call-1",
      expect.objectContaining({
        status: "working",
        tool: "openclaw_agent_consult",
      }),
      { willContinue: true },
    );

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
    expect(handle.getHealth()).toMatchObject({
      providerConnected: true,
      realtimeReady: true,
      audioInputActive: true,
      audioOutputActive: true,
      lastInputBytes: 3,
      lastOutputBytes: 4,
      realtimeTranscriptLines: 2,
      lastRealtimeTranscriptRole: "user",
      lastRealtimeTranscriptText: "Please summarize the launch.",
      lastRealtimeEventType: "server:response.done",
      lastRealtimeEventDetail: "status=completed",
      recentRealtimeTranscript: [
        expect.objectContaining({ role: "assistant", text: "How can I help you?" }),
        expect.objectContaining({ role: "user", text: "Please summarize the launch." }),
      ],
      recentRealtimeEvents: [
        expect.objectContaining({ direction: "client", type: "response.create" }),
        expect.objectContaining({
          direction: "server",
          type: "response.done",
          detail: "status=completed",
        }),
      ],
      clearCount: 1,
    });
    expect(callbacks).toMatchObject({
      audioFormat: {
        encoding: "pcm16",
        sampleRateHz: 24000,
        channels: 1,
      },
      autoRespondToAudio: true,
      tools: [
        expect.objectContaining({
          name: "openclaw_agent_consult",
        }),
      ],
    });
    await vi.waitFor(() => {
      expect(bridge.submitToolResult).toHaveBeenLastCalledWith(
        "tool-call-1",
        {
          text: "Use the Portugal launch data.",
        },
        undefined,
      );
    });
    expect(handle.getHealth().recentTalkEvents?.map((event) => event.type)).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(runtime.agent.runEmbeddedPiAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        messageProvider: "google-meet",
        agentId: "jay",
        spawnedBy: "agent:jay:main",
        sessionKey: "agent:jay:subagent:google-meet:meet-1",
        sandboxSessionKey: "agent:jay:subagent:google-meet:meet-1",
        thinkLevel: "high",
        toolsAllow: ["read", "web_search", "web_fetch", "x_search", "memory_search", "memory_get"],
      }),
    );
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

    expect(callbacks).toMatchObject({
      autoRespondToAudio: false,
      tools: [],
    });
    callbacks?.onTranscript?.("user", "Are we still on track?", true);
    callbacks?.onTranscript?.("user", "Please include launch blockers.", true);

    await vi.waitFor(() => {
      expect(runtime.agent.runEmbeddedPiAgent).toHaveBeenCalledTimes(1);
      expect(runtime.agent.runEmbeddedPiAgent).toHaveBeenCalledWith(
        expect.objectContaining({
          agentId: "jay",
          spawnedBy: "agent:jay:main",
          sessionKey: "agent:jay:subagent:google-meet:meet-1",
          sandboxSessionKey: "agent:jay:subagent:google-meet:meet-1",
        }),
      );
    });
    const consultArgs = (runtime.agent.runEmbeddedPiAgent.mock.calls as unknown[][])[0]?.[0];
    expect(JSON.stringify(consultArgs)).toContain(
      "Are we still on track?\\nPlease include launch blockers.",
    );
    expect(sendUserMessage).toHaveBeenCalledWith(
      expect.stringContaining(JSON.stringify("The launch is still on track.")),
    );
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

    expect(first).toMatchObject({
      durationMs: 1_000,
      lastOutputPlayableUntilMs: 2_000,
      suppressInputUntilMs: 5_000,
    });
    expect(second).toMatchObject({
      durationMs: 1_000,
      lastOutputPlayableUntilMs: 3_000,
      suppressInputUntilMs: 6_000,
    });
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
    expect(handle.getHealth()).toMatchObject({
      clearCount: 1,
      suppressedInputBytes: 4,
    });

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
      fullConfig: {} as never,
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
    expect(bridge.submitToolResult).toHaveBeenNthCalledWith(
      1,
      "tool-call-1",
      expect.objectContaining({
        status: "working",
        tool: "openclaw_agent_consult",
      }),
      { willContinue: true },
    );

    await vi.waitFor(() => {
      expect(sendAudio).toHaveBeenCalledWith(Buffer.from([9, 8, 7]));
    });
    await vi.waitFor(() => {
      expect(runtime.nodes.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "node-1",
          command: "googlemeet.chrome",
          params: expect.objectContaining({
            action: "pushAudio",
            bridgeId: "bridge-1",
            base64: Buffer.from([1, 2, 3]).toString("base64"),
          }),
        }),
      );
    });
    await vi.waitFor(() => {
      expect(runtime.nodes.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "node-1",
          command: "googlemeet.chrome",
          params: {
            action: "clearAudio",
            bridgeId: "bridge-1",
          },
          timeoutMs: 5_000,
        }),
      );
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
    expect(callbacks).toMatchObject({
      audioFormat: {
        encoding: "pcm16",
        sampleRateHz: 24000,
        channels: 1,
      },
      autoRespondToAudio: true,
      tools: [
        expect.objectContaining({
          name: "openclaw_agent_consult",
        }),
      ],
    });
    expect(handle).toMatchObject({
      type: "node-command-pair",
      providerId: "openai",
      nodeId: "node-1",
      bridgeId: "bridge-1",
    });
    expect(handle.getHealth()).toMatchObject({
      providerConnected: true,
      realtimeReady: true,
      audioInputActive: true,
      audioOutputActive: true,
      lastInputBytes: 3,
      lastOutputBytes: 3,
      realtimeTranscriptLines: 1,
      lastRealtimeTranscriptRole: "assistant",
      lastRealtimeTranscriptText: "How can I help from the node?",
      lastRealtimeEventType: "server:response.done",
      lastRealtimeEventDetail: "status=completed",
      clearCount: 1,
    });
    const talkEvents = handle.getHealth().recentTalkEvents ?? [];
    expect(talkEvents.map((event) => event.type)).toEqual(
      expect.arrayContaining([
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
      ]),
    );
    expect(talkEvents[0]).toMatchObject({
      sessionId: "google-meet:meet-1:bridge-1:node-realtime",
    });

    await handle.stop();

    expect(bridge.close).toHaveBeenCalled();
    expect(runtime.nodes.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        nodeId: "node-1",
        command: "googlemeet.chrome",
        params: { action: "stop", bridgeId: "bridge-1" },
        timeoutMs: 5_000,
      }),
    );
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
    expect(handle.getHealth()).toMatchObject({
      audioInputActive: true,
      lastInputBytes: 3,
      consecutiveInputErrors: 0,
    });

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
      expect(handle.getHealth()).toMatchObject({
        bridgeClosed: true,
        consecutiveInputErrors: 5,
        lastInputError: "node invoke timeout",
      });
      expect(runtime.nodes.invoke).toHaveBeenCalledWith(
        expect.objectContaining({
          nodeId: "node-1",
          command: "googlemeet.chrome",
          params: { action: "stop", bridgeId: "bridge-1" },
          timeoutMs: 5_000,
        }),
      );
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
