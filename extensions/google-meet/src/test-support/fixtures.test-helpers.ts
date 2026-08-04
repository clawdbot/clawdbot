import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { MeetingRealtimeAudioEngineHealth } from "openclaw/plugin-sdk/meeting-runtime";
import { vi } from "vitest";
import { resolveGoogleMeetConfig } from "../config.js";
import { GoogleMeetRuntime } from "../runtime.js";
import type { GoogleMeetSession } from "../transports/types.js";

export const MEET_URL = "https://meet.google.com/abc-defg-hij";
export const MEET_URL_EN = `${MEET_URL}?hl=en`;

const conferenceRecord = {
  name: "conferenceRecords/rec-1",
  space: "spaces/abc-defg-hij",
  startTime: "2026-04-25T10:00:00Z",
  endTime: "2026-04-25T10:30:00Z",
};

const meetApiFixtures: Record<string, unknown> = {
  "/v2/spaces/abc-defg-hij": {
    name: "spaces/abc-defg-hij",
    meetingCode: "abc-defg-hij",
    meetingUri: MEET_URL,
  },
  "/calendar/v3/calendars/primary/events": {
    items: [
      {
        id: "event-1",
        summary: "Project sync",
        hangoutLink: MEET_URL,
        start: { dateTime: "2026-04-25T10:00:00Z" },
        end: { dateTime: "2026-04-25T10:30:00Z" },
      },
    ],
  },
  "/v2/conferenceRecords": { conferenceRecords: [conferenceRecord] },
  "/v2/conferenceRecords/rec-1": conferenceRecord,
  "/v2/conferenceRecords/rec-1/participants": {
    participants: [
      {
        name: "conferenceRecords/rec-1/participants/p1",
        earliestStartTime: "2026-04-25T10:00:00Z",
        latestEndTime: "2026-04-25T10:30:00Z",
        signedinUser: { user: "users/alice", displayName: "Alice" },
      },
    ],
  },
  "/v2/conferenceRecords/rec-1/participants/p1/participantSessions": {
    participantSessions: [
      {
        name: "conferenceRecords/rec-1/participants/p1/participantSessions/s1",
        startTime: "2026-04-25T10:00:00Z",
        endTime: "2026-04-25T10:30:00Z",
      },
    ],
  },
  "/v2/conferenceRecords/rec-1/recordings": {
    recordings: [
      {
        name: "conferenceRecords/rec-1/recordings/r1",
        driveDestination: { file: "drive/file-1" },
      },
    ],
  },
  "/v2/conferenceRecords/rec-1/transcripts": {
    transcripts: [
      {
        name: "conferenceRecords/rec-1/transcripts/t1",
        docsDestination: { document: "docs/doc-1" },
      },
    ],
  },
  "/v2/conferenceRecords/rec-1/transcripts/t1/entries": {
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
  },
  "/v2/conferenceRecords/rec-1/smartNotes": {
    smartNotes: [
      {
        name: "conferenceRecords/rec-1/smartNotes/sn1",
        docsDestination: { document: "docs/doc-2" },
      },
    ],
  },
};

export function stubMeetArtifactsApi() {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const path = new URL(typeof input === "string" || input instanceof URL ? input : input.url)
      .pathname;
    const fixture = meetApiFixtures[path];
    if (fixture) {
      return new Response(JSON.stringify(fixture), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const document = {
      "/drive/v3/files/doc-1/export": "Transcript document body.",
      "/drive/v3/files/doc-2/export": "Smart note document body.",
    }[path];
    return new Response(document ?? `unexpected ${path}`, {
      status: document ? 200 : 404,
      ...(document ? { headers: { "Content-Type": "text/plain" } } : {}),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

export function meetBrowserState(overrides: Record<string, unknown> = {}) {
  return {
    inCall: true,
    micMuted: false,
    title: "Meet call",
    url: MEET_URL,
    ...overrides,
  };
}

type SessionOverrides = Omit<Partial<GoogleMeetSession>, "chrome" | "realtime"> & {
  chrome?: Partial<NonNullable<GoogleMeetSession["chrome"]>>;
  realtime?: Partial<NonNullable<GoogleMeetSession["realtime"]>>;
};

export function meetSession(overrides: SessionOverrides = {}): GoogleMeetSession {
  const { chrome, realtime, ...session } = overrides;
  const mode = session.mode ?? "agent";
  return {
    id: "meet_1",
    url: MEET_URL,
    transport: "chrome",
    mode,
    agentId: "main",
    state: "active",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    participantIdentity: "signed-in Google Chrome profile",
    realtime: {
      enabled: mode !== "transcribe",
      strategy: mode === "bidi" ? "bidi" : "agent",
      ...(mode === "bidi" ? { provider: "openai" } : {}),
      ...(mode === "agent" ? { transcriptionProvider: "openai" } : {}),
      toolPolicy: "safe-read-only",
      ...realtime,
    },
    chrome: {
      audioBackend: "blackhole-2ch",
      launched: true,
      ...chrome,
    },
    notes: [],
    ...session,
  };
}

function emptyRealtimeAudioHealth(): MeetingRealtimeAudioEngineHealth {
  return {
    providerConnected: false,
    realtimeReady: false,
    audioInputActive: false,
    audioOutputActive: false,
    lastInputBytes: 0,
    lastOutputBytes: 0,
    suppressedInputBytes: 0,
    realtimeTranscriptLines: 0,
    recentRealtimeTranscript: [],
    recentTalkEvents: [],
    bridgeClosed: false,
  };
}

export function meetAudioBridge(stop = vi.fn(async () => {})) {
  return {
    type: "command-pair" as const,
    providerId: "openai",
    inputCommand: ["capture-meet"],
    outputCommand: ["play-meet"],
    speak: vi.fn(),
    getHealth: vi.fn(emptyRealtimeAudioHealth),
    stop,
  };
}

export function meetRuntime(
  config: Parameters<typeof resolveGoogleMeetConfig>[0],
  logger: ConstructorParameters<typeof GoogleMeetRuntime>[0]["logger"],
) {
  return new GoogleMeetRuntime({
    config: resolveGoogleMeetConfig(config),
    fullConfig: {} as never,
    runtime: {} as never,
    logger,
  });
}

type TestBridgeProcess = {
  stdin?: { write(chunk: unknown): unknown } | null;
  stdout?: PassThrough | null;
  stderr: PassThrough;
  killed: boolean;
  exitCode: number | null;
  signalCode: NodeJS.Signals | null;
  kill: ReturnType<typeof vi.fn>;
  on: EventEmitter["on"];
  emit: EventEmitter["emit"];
};

export function testBridgeProcess(stdio: {
  stdin?: { write(chunk: unknown): unknown } | null;
  stdout?: PassThrough | null;
  stderr?: PassThrough;
}): TestBridgeProcess {
  const proc = new EventEmitter() as unknown as TestBridgeProcess;
  proc.stdin = stdio.stdin;
  proc.stdout = stdio.stdout;
  proc.stderr = stdio.stderr ?? new PassThrough();
  proc.killed = false;
  proc.exitCode = null;
  proc.signalCode = null;
  proc.kill = vi.fn((signal?: NodeJS.Signals) => {
    proc.killed = true;
    proc.signalCode = signal ?? "SIGTERM";
    return true;
  });
  return proc;
}
