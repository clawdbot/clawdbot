import { writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { format } from "node:util";
import { formatErrorMessage } from "openclaw/plugin-sdk/error-runtime";
import { callGatewayFromCli } from "openclaw/plugin-sdk/gateway-runtime";
import {
  clampTimerTimeoutMs,
  parseStrictPositiveInteger,
} from "openclaw/plugin-sdk/number-runtime";
import prettyMilliseconds from "pretty-ms";
import type { GoogleMeetCalendarLookupResult } from "./calendar.js";
import {
  resolveGoogleMeetGatewayOperationTimeoutMs,
  type GoogleMeetModeInput,
  type GoogleMeetTransport,
} from "./config.js";
import type { GoogleMeetRuntime } from "./runtime.js";

export type JoinOptions = {
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetModeInput;
  message?: string;
  timeoutMs?: string;
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
};

export type OAuthLoginOptions = {
  clientId?: string;
  clientSecret?: string;
  manual?: boolean;
  json?: boolean;
  timeoutSec?: string;
};

export const testing = {
  parsePositiveNumber,
  resolveGoogleMeetGatewayOperationTimeoutMs,
  resolveGoogleMeetGatewayTimeoutMs,
  resolveGoogleMeetOAuthCallbackTimeoutMs,
};

export type ResolveSpaceOptions = {
  meeting?: string;
  today?: boolean;
  event?: string;
  calendar?: string;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
  json?: boolean;
};

export type MeetArtifactOptions = ResolveSpaceOptions & {
  conferenceRecord?: string;
  pageSize?: string;
  transcriptEntries?: boolean;
  allConferenceRecords?: boolean;
  includeDocBodies?: boolean;
  mergeDuplicates?: boolean;
  lateAfterMinutes?: string;
  earlyBeforeMinutes?: string;
  zip?: boolean;
  dryRun?: boolean;
  format?: "summary" | "markdown" | "csv";
  output?: string;
};

export type GoogleMeetExportRequest = {
  meeting?: string;
  conferenceRecord?: string;
  calendarEventId?: string;
  calendarEventSummary?: string;
  calendarId?: string;
  pageSize?: number;
  includeTranscriptEntries?: boolean;
  includeDocumentBodies?: boolean;
  allConferenceRecords?: boolean;
  mergeDuplicateParticipants?: boolean;
  lateAfterMinutes?: number;
  earlyBeforeMinutes?: number;
};

export type GoogleMeetExportWarning = {
  type:
    | "smart_notes"
    | "transcript_entries"
    | "transcript_document_body"
    | "smart_note_document_body";
  conferenceRecord: string;
  resource?: string;
  message: string;
};

export type GoogleMeetExportManifest = {
  generatedAt: string;
  request?: GoogleMeetExportRequest;
  tokenSource?: "cached-access-token" | "refresh-token";
  calendarEvent?: GoogleMeetCalendarLookupResult;
  inputs: {
    artifacts?: string;
    attendance?: string;
  };
  counts: {
    conferenceRecords: number;
    artifacts: number;
    attendanceRows: number;
    recordings: number;
    transcripts: number;
    transcriptEntries: number;
    smartNotes: number;
    warnings: number;
  };
  conferenceRecords: string[];
  files: string[];
  zipFile?: string;
  warnings: GoogleMeetExportWarning[];
};

export type SetupOptions = {
  json?: boolean;
  mode?: GoogleMeetModeInput;
  transport?: GoogleMeetTransport;
};

type GoogleMeetGatewayMethod =
  | "googlemeet.create"
  | "googlemeet.join"
  | "googlemeet.leave"
  | "googlemeet.speak"
  | "googlemeet.status"
  | "googlemeet.transcript"
  | "googlemeet.testListen"
  | "googlemeet.testSpeech";

type GoogleMeetGatewayCallResult = { ok: true; payload: unknown } | { ok: false; error: unknown };

const GOOGLE_MEET_GATEWAY_DEFAULT_TIMEOUT_MS = 5000;
const PLAIN_DECIMAL_NUMBER_RE = /^\d+(?:\.\d+)?$/;

export type DoctorOptions = {
  json?: boolean;
  oauth?: boolean;
  meeting?: string;
  createSpace?: boolean;
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
};

export type JsonOptions = {
  json?: boolean;
};

export type RecoverTabOptions = JsonOptions & {
  transport?: GoogleMeetTransport;
};

export type CreateOptions = {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
  accessType?: string;
  entryPointAccess?: string;
  join?: boolean;
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetModeInput;
  message?: string;
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
  json?: boolean;
};

export function writeStdoutJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function isGatewayUnavailableForLocalFallback(
  err: unknown,
  method: GoogleMeetGatewayMethod,
): boolean {
  const message = formatErrorMessage(err);
  return (
    message.includes("ECONNREFUSED") ||
    message.includes("ECONNRESET") ||
    message.includes("EHOSTUNREACH") ||
    message.includes("ENOTFOUND") ||
    message.includes("gateway not connected") ||
    message.includes(`unknown method: ${method}`)
  );
}

export function writeStdoutLine(...values: unknown[]): void {
  process.stdout.write(`${format(...values)}\n`);
}

export async function writeCliOutput(options: { output?: string }, text: string): Promise<void> {
  if (options.output?.trim()) {
    await writeFile(options.output, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    writeStdoutLine("wrote: %s", options.output);
    return;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

export async function promptInput(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

export function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const trimmed = value.trim();
  const parsed = PLAIN_DECIMAL_NUMBER_RE.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric value, received ${value}`);
  }
  return parsed;
}

export function writeSetupStatus(
  status: Awaited<ReturnType<GoogleMeetRuntime["setupStatus"]>>,
): void {
  writeStdoutLine("Google Meet setup: %s", status.ok ? "OK" : "needs attention");
  for (const check of status.checks) {
    writeStdoutLine("[%s] %s: %s", check.ok ? "ok" : "fail", check.id, check.message);
  }
}

function formatBoolean(value: boolean | undefined): string {
  return typeof value === "boolean" ? (value ? "yes" : "no") : "unknown";
}

export function formatOptional(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "n/a";
}

export function parsePositiveNumber(value: string | undefined, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  const parsed = PLAIN_DECIMAL_NUMBER_RE.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`);
  }
  return parsed;
}

function resolveGoogleMeetGatewayTimeoutMs(timeoutMs: unknown): number {
  return typeof timeoutMs === "number" && Number.isFinite(timeoutMs)
    ? (clampTimerTimeoutMs(Math.ceil(timeoutMs)) ?? 1)
    : GOOGLE_MEET_GATEWAY_DEFAULT_TIMEOUT_MS;
}

export function resolveGoogleMeetOAuthCallbackTimeoutMs(timeoutSec: string | undefined): number {
  return (
    clampTimerTimeoutMs((parsePositiveNumber(timeoutSec, "timeout-sec") ?? 300) * 1000) ?? 300_000
  );
}

export function parsePositiveIntegerOption(
  value: string | undefined,
  label: string,
): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  const parsed = parseStrictPositiveInteger(value);
  if (parsed === undefined) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

export async function callGoogleMeetGateway(params: {
  callGateway: typeof callGatewayFromCli;
  method: GoogleMeetGatewayMethod;
  payload?: Record<string, unknown>;
  timeoutMs?: number;
}): Promise<GoogleMeetGatewayCallResult> {
  try {
    const timeoutMs = resolveGoogleMeetGatewayTimeoutMs(params.timeoutMs);
    return {
      ok: true,
      payload: await params.callGateway(
        params.method,
        { json: true, timeout: String(timeoutMs) },
        params.payload,
        { progress: false },
      ),
    };
  } catch (err) {
    if (isGatewayUnavailableForLocalFallback(err, params.method)) {
      return { ok: false, error: err };
    }
    throw err;
  }
}

export function formatDuration(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }
  return prettyMilliseconds(Math.max(0, Math.round(value / 1000) * 1000), {
    unitCount: 2,
  });
}

export function writeDoctorStatus(status: Awaited<ReturnType<GoogleMeetRuntime["status"]>>): void {
  if (!status.found) {
    writeStdoutLine("Google Meet session: not found");
    return;
  }
  const sessions = status.session ? [status.session] : (status.sessions ?? []);
  if (sessions.length === 0) {
    writeStdoutLine("Google Meet sessions: none");
    return;
  }
  writeStdoutLine("Google Meet sessions: %d", sessions.length);
  for (const session of sessions) {
    const health = session.chrome?.health;
    writeStdoutLine("");
    writeStdoutLine("session: %s", session.id);
    writeStdoutLine("url: %s", session.url);
    writeStdoutLine("state: %s", session.state);
    writeStdoutLine("transport: %s", session.transport);
    writeStdoutLine("mode: %s", session.mode);
    if (session.twilio) {
      writeStdoutLine("twilio dial-in: %s", session.twilio.dialInNumber);
      writeStdoutLine("voice call id: %s", formatOptional(session.twilio.voiceCallId));
      writeStdoutLine("dtmf sent: %s", formatBoolean(session.twilio.dtmfSent));
      writeStdoutLine("intro sent: %s", formatBoolean(session.twilio.introSent));
    }
    if (!session.chrome) {
      continue;
    }
    writeStdoutLine("node: %s", session.chrome?.nodeId ?? "local/none");
    writeStdoutLine("audio bridge: %s", session.chrome?.audioBridge?.type ?? "none");
    const bridgeProvider =
      session.chrome?.audioBridge?.provider ??
      session.realtime.transcriptionProvider ??
      session.realtime.provider ??
      "n/a";
    writeStdoutLine(
      session.mode === "agent" ? "transcription provider: %s" : "provider: %s",
      bridgeProvider,
    );
    if (session.realtime.enabled) {
      writeStdoutLine("talk-back mode: %s", session.realtime.strategy ?? session.mode);
    }
    writeStdoutLine("in call: %s", formatBoolean(health?.inCall));
    writeStdoutLine("lobby waiting: %s", formatBoolean(health?.lobbyWaiting));
    writeStdoutLine("captioning: %s", formatBoolean(health?.captioning));
    writeStdoutLine("transcript lines: %s", health?.transcriptLines ?? 0);
    writeStdoutLine("last caption: %s", formatOptional(health?.lastCaptionAt));
    writeStdoutLine("manual action: %s", formatBoolean(health?.manualActionRequired));
    if (health?.manualActionRequired) {
      writeStdoutLine("manual reason: %s", formatOptional(health.manualActionReason));
      writeStdoutLine("manual message: %s", formatOptional(health.manualActionMessage));
    }
    writeStdoutLine("speech ready: %s", formatBoolean(health?.speechReady));
    if (health?.speechReady === false) {
      writeStdoutLine("speech blocked reason: %s", formatOptional(health.speechBlockedReason));
      writeStdoutLine("speech blocked message: %s", formatOptional(health.speechBlockedMessage));
    }
    writeStdoutLine("provider connected: %s", formatBoolean(health?.providerConnected));
    writeStdoutLine("realtime ready: %s", formatBoolean(health?.realtimeReady));
    writeStdoutLine("audio input active: %s", formatBoolean(health?.audioInputActive));
    writeStdoutLine("audio output active: %s", formatBoolean(health?.audioOutputActive));
    writeStdoutLine("meet output routed: %s", formatBoolean(health?.audioOutputRouted));
    if (health?.audioOutputDeviceLabel || health?.audioOutputRouteError) {
      writeStdoutLine("meet output device: %s", formatOptional(health.audioOutputDeviceLabel));
      writeStdoutLine("meet output route error: %s", formatOptional(health.audioOutputRouteError));
    }
    writeStdoutLine(
      "last input: %s (%s bytes)",
      formatOptional(health?.lastInputAt),
      health?.lastInputBytes ?? 0,
    );
    writeStdoutLine(
      "last output: %s (%s bytes)",
      formatOptional(health?.lastOutputAt),
      health?.lastOutputBytes ?? 0,
    );
    writeStdoutLine("bridge closed: %s", formatBoolean(health?.bridgeClosed));
    writeStdoutLine("browser url: %s", formatOptional(health?.browserUrl));
    if (health?.lastCaptionText) {
      const speaker = health.lastCaptionSpeaker ? `${health.lastCaptionSpeaker}: ` : "";
      writeStdoutLine("last caption text: %s%s", speaker, health.lastCaptionText);
    }
    writeStdoutLine("realtime transcript lines: %s", health?.realtimeTranscriptLines ?? 0);
    if (health?.lastRealtimeTranscriptText) {
      const role = health.lastRealtimeTranscriptRole
        ? `${health.lastRealtimeTranscriptRole}: `
        : "";
      writeStdoutLine("last realtime transcript: %s%s", role, health.lastRealtimeTranscriptText);
    }
    if (health?.lastRealtimeEventType) {
      const detail = health.lastRealtimeEventDetail ? ` ${health.lastRealtimeEventDetail}` : "";
      writeStdoutLine("last realtime event: %s%s", health.lastRealtimeEventType, detail);
    }
  }
}

export function writeRecoverCurrentTabResult(
  result: Awaited<ReturnType<GoogleMeetRuntime["recoverCurrentTab"]>>,
): void {
  writeStdoutLine("Google Meet current tab: %s", result.found ? "found" : "not found");
  writeStdoutLine("transport: %s", result.transport);
  writeStdoutLine("node: %s", result.nodeId ?? "local/none");
  if (result.targetId) {
    writeStdoutLine("target: %s", result.targetId);
  }
  if (result.tab?.url) {
    writeStdoutLine("tab url: %s", result.tab.url);
  }
  writeStdoutLine("message: %s", result.message);
  if (result.browser) {
    writeDoctorStatus({
      found: true,
      session: {
        id: "current-tab",
        url: result.browser.browserUrl ?? result.tab?.url ?? "unknown",
        transport: result.transport,
        mode: "transcribe",
        agentId: "main",
        state: "active",
        createdAt: "",
        updatedAt: "",
        participantIdentity:
          result.transport === "chrome-node"
            ? "signed-in Google Chrome profile on a paired node"
            : "signed-in Google Chrome profile",
        realtime: { enabled: false, toolPolicy: "safe-read-only" },
        chrome: {
          audioBackend: "blackhole-2ch",
          launched: true,
          nodeId: result.nodeId,
          health: result.browser,
        },
        notes: [],
      },
    });
  }
}

export function writeLeaveResult(sessionId: string, result: { browserLeft?: boolean }): void {
  if (result.browserLeft === false) {
    writeStdoutLine(
      "left %s, but the browser participant may still be in the call; check session notes",
      sessionId,
    );
    return;
  }
  writeStdoutLine("left %s", sessionId);
}
