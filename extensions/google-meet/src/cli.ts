import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { format } from "node:util";
import type { Command } from "commander";
import {
  buildGoogleMeetCalendarDayWindow,
  findGoogleMeetCalendarEvent,
  listGoogleMeetCalendarEvents,
  type GoogleMeetCalendarLookupResult,
} from "./calendar.js";
import type { GoogleMeetConfig, GoogleMeetMode, GoogleMeetTransport } from "./config.js";
import {
  buildGoogleMeetPreflightReport,
  createGoogleMeetSpace,
  fetchGoogleMeetArtifacts,
  fetchGoogleMeetAttendance,
  fetchLatestGoogleMeetConferenceRecord,
  fetchGoogleMeetSpace,
  type GoogleMeetArtifactsResult,
  type GoogleMeetAttendanceResult,
  type GoogleMeetLatestConferenceRecordResult,
} from "./meet.js";
import {
  buildGoogleMeetAuthUrl,
  createGoogleMeetOAuthState,
  createGoogleMeetPkce,
  exchangeGoogleMeetAuthCode,
  resolveGoogleMeetAccessToken,
  waitForGoogleMeetAuthCode,
} from "./oauth.js";
import type { GoogleMeetRuntime } from "./runtime.js";

type JoinOptions = {
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetMode;
  message?: string;
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
};

type OAuthLoginOptions = {
  clientId?: string;
  clientSecret?: string;
  manual?: boolean;
  json?: boolean;
  timeoutSec?: string;
};

type ResolveSpaceOptions = {
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

type MeetArtifactOptions = ResolveSpaceOptions & {
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

type SetupOptions = {
  json?: boolean;
  mode?: GoogleMeetMode;
  transport?: GoogleMeetTransport;
};

type DoctorOptions = {
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

type JsonOptions = {
  json?: boolean;
};

type RecoverTabOptions = JsonOptions & {
  transport?: GoogleMeetTransport;
};

type CreateOptions = {
  accessToken?: string;
  refreshToken?: string;
  clientId?: string;
  clientSecret?: string;
  expiresAt?: string;
  join?: boolean;
  transport?: GoogleMeetTransport;
  mode?: GoogleMeetMode;
  message?: string;
  dialInNumber?: string;
  pin?: string;
  dtmfSequence?: string;
  json?: boolean;
};

function writeStdoutJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function writeStdoutLine(...values: unknown[]): void {
  process.stdout.write(`${format(...values)}\n`);
}

async function writeCliOutput(options: { output?: string }, text: string): Promise<void> {
  if (options.output?.trim()) {
    await writeFile(options.output, text.endsWith("\n") ? text : `${text}\n`, "utf8");
    writeStdoutLine("wrote: %s", options.output);
    return;
  }
  process.stdout.write(text.endsWith("\n") ? text : `${text}\n`);
}

async function promptInput(message: string): Promise<string> {
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

function parseOptionalNumber(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Expected a numeric value, received ${value}`);
  }
  return parsed;
}

function writeSetupStatus(status: Awaited<ReturnType<GoogleMeetRuntime["setupStatus"]>>): void {
  writeStdoutLine("Google Meet setup: %s", status.ok ? "OK" : "needs attention");
  for (const check of status.checks) {
    writeStdoutLine("[%s] %s: %s", check.ok ? "ok" : "fail", check.id, check.message);
  }
}

function formatBoolean(value: boolean | undefined): string {
  return typeof value === "boolean" ? (value ? "yes" : "no") : "unknown";
}

function formatOptional(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "n/a";
}

function formatDuration(value: number | undefined): string {
  if (value === undefined) {
    return "n/a";
  }
  const totalSeconds = Math.round(value / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${hours}h ${minutes.toString().padStart(2, "0")}m`
    : `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function writeDoctorStatus(status: Awaited<ReturnType<GoogleMeetRuntime["status"]>>): void {
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
    writeStdoutLine(
      "provider: %s",
      session.chrome?.audioBridge?.provider ?? session.realtime.provider ?? "n/a",
    );
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
  }
}

type OAuthDoctorCheck = {
  id: string;
  ok: boolean;
  message: string;
};

type OAuthDoctorReport = {
  ok: boolean;
  configured: boolean;
  tokenSource?: "cached-access-token" | "refresh-token";
  expiresAt?: number;
  scope?: string;
  meetingUri?: string;
  createdSpace?: string;
  checks: OAuthDoctorCheck[];
};

function sanitizeOAuthErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/(access_token["'=:\s]+)[^"',\s&]+/gi, "$1[redacted]")
    .replace(/(refresh_token["'=:\s]+)[^"',\s&]+/gi, "$1[redacted]")
    .replace(/(client_secret["'=:\s]+)[^"',\s&]+/gi, "$1[redacted]");
}

async function buildOAuthDoctorReport(
  config: GoogleMeetConfig,
  options: DoctorOptions,
): Promise<OAuthDoctorReport> {
  const clientId = options.clientId?.trim() || config.oauth.clientId;
  const clientSecret = options.clientSecret?.trim() || config.oauth.clientSecret;
  const refreshToken = options.refreshToken?.trim() || config.oauth.refreshToken;
  const accessToken = options.accessToken?.trim() || config.oauth.accessToken;
  const expiresAt = parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt;
  const checks: OAuthDoctorCheck[] = [];

  const hasRefreshConfig = Boolean(clientId && refreshToken);
  const hasAccessConfig = Boolean(accessToken);
  if (!hasRefreshConfig && !hasAccessConfig) {
    checks.push({
      id: "oauth-config",
      ok: false,
      message:
        "Missing Google Meet OAuth credentials. Configure oauth.clientId and oauth.refreshToken, or pass --client-id and --refresh-token.",
    });
    return { ok: false, configured: false, checks };
  }

  checks.push({
    id: "oauth-config",
    ok: true,
    message: hasRefreshConfig
      ? "Google Meet OAuth refresh credentials are configured"
      : "Google Meet cached access token is configured",
  });

  let token: Awaited<ReturnType<typeof resolveGoogleMeetAccessToken>>;
  try {
    token = await resolveGoogleMeetAccessToken({
      clientId,
      clientSecret,
      refreshToken,
      accessToken,
      expiresAt,
    });
    checks.push({
      id: "oauth-token",
      ok: true,
      message: token.refreshed
        ? "Refresh token minted an access token"
        : "Cached access token is still valid",
    });
  } catch (error) {
    checks.push({
      id: "oauth-token",
      ok: false,
      message: sanitizeOAuthErrorMessage(error),
    });
    return { ok: false, configured: true, checks };
  }

  const report: OAuthDoctorReport = {
    ok: true,
    configured: true,
    tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
    expiresAt: token.expiresAt,
    checks,
  };

  const meeting = options.meeting?.trim();
  if (meeting) {
    try {
      const space = await fetchGoogleMeetSpace({ accessToken: token.accessToken, meeting });
      checks.push({
        id: "meet-spaces-get",
        ok: true,
        message: `Resolved ${space.name}`,
      });
      report.meetingUri = space.meetingUri;
    } catch (error) {
      checks.push({
        id: "meet-spaces-get",
        ok: false,
        message: sanitizeOAuthErrorMessage(error),
      });
    }
  }

  if (options.createSpace) {
    try {
      const created = await createGoogleMeetSpace({ accessToken: token.accessToken });
      checks.push({
        id: "meet-spaces-create",
        ok: true,
        message: `Created ${created.space.name}`,
      });
      report.createdSpace = created.space.name;
      report.meetingUri = created.meetingUri;
    } catch (error) {
      checks.push({
        id: "meet-spaces-create",
        ok: false,
        message: sanitizeOAuthErrorMessage(error),
      });
    }
  }

  report.ok = checks.every((check) => check.ok);
  return report;
}

function writeOAuthDoctorReport(report: OAuthDoctorReport): void {
  writeStdoutLine("Google Meet OAuth: %s", report.ok ? "OK" : "needs attention");
  writeStdoutLine("configured: %s", report.configured ? "yes" : "no");
  if (report.tokenSource) {
    writeStdoutLine("token source: %s", report.tokenSource);
  }
  if (report.meetingUri) {
    writeStdoutLine("meeting uri: %s", report.meetingUri);
  }
  for (const check of report.checks) {
    writeStdoutLine("[%s] %s: %s", check.ok ? "ok" : "fail", check.id, check.message);
  }
}

function writeRecoverCurrentTabResult(
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

function resolveMeetingInput(config: GoogleMeetConfig, value?: string): string {
  const meeting = value?.trim() || config.defaults.meeting;
  if (!meeting) {
    throw new Error(
      "Meeting input is required. Pass a URL/meeting code or configure defaults.meeting.",
    );
  }
  return meeting;
}

function resolveOAuthTokenOptions(
  config: GoogleMeetConfig,
  options: ResolveSpaceOptions,
): {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
} {
  return {
    clientId: options.clientId?.trim() || config.oauth.clientId,
    clientSecret: options.clientSecret?.trim() || config.oauth.clientSecret,
    refreshToken: options.refreshToken?.trim() || config.oauth.refreshToken,
    accessToken: options.accessToken?.trim() || config.oauth.accessToken,
    expiresAt: parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt,
  };
}

function resolveTokenOptions(
  config: GoogleMeetConfig,
  options: ResolveSpaceOptions,
): {
  meeting: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
} {
  return {
    meeting: resolveMeetingInput(config, options.meeting),
    ...resolveOAuthTokenOptions(config, options),
  };
}

function hasCalendarLookupOptions(options: ResolveSpaceOptions): boolean {
  return Boolean(options.today || options.event?.trim());
}

async function resolveCalendarMeetingInput(params: {
  accessToken: string;
  options: ResolveSpaceOptions;
}): Promise<{ meeting?: string; calendarEvent?: GoogleMeetCalendarLookupResult }> {
  if (!hasCalendarLookupOptions(params.options)) {
    return {};
  }
  const window = params.options.today ? buildGoogleMeetCalendarDayWindow() : {};
  const calendarEvent = await findGoogleMeetCalendarEvent({
    accessToken: params.accessToken,
    calendarId: params.options.calendar,
    eventQuery: params.options.event,
    ...window,
  });
  return { meeting: calendarEvent.meetingUri, calendarEvent };
}

async function resolveMeetingForToken(params: {
  config: GoogleMeetConfig;
  options: ResolveSpaceOptions;
  accessToken: string;
  configuredMeeting?: string;
}): Promise<{ meeting: string; calendarEvent?: GoogleMeetCalendarLookupResult }> {
  const calendarMeeting = await resolveCalendarMeetingInput({
    accessToken: params.accessToken,
    options: params.options,
  });
  const meeting =
    calendarMeeting.meeting ?? params.configuredMeeting ?? params.config.defaults.meeting;
  if (!meeting) {
    throw new Error(
      "Meeting input is required. Pass --meeting, --today, --event, or configure defaults.meeting.",
    );
  }
  return calendarMeeting.calendarEvent
    ? { meeting, calendarEvent: calendarMeeting.calendarEvent }
    : { meeting };
}

function resolveCreateTokenOptions(
  config: GoogleMeetConfig,
  options: CreateOptions,
): {
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
} {
  return {
    clientId: options.clientId?.trim() || config.oauth.clientId,
    clientSecret: options.clientSecret?.trim() || config.oauth.clientSecret,
    refreshToken: options.refreshToken?.trim() || config.oauth.refreshToken,
    accessToken: options.accessToken?.trim() || config.oauth.accessToken,
    expiresAt: parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt,
  };
}

function resolveArtifactTokenOptions(
  config: GoogleMeetConfig,
  options: MeetArtifactOptions,
): {
  meeting?: string;
  conferenceRecord?: string;
  clientId?: string;
  clientSecret?: string;
  refreshToken?: string;
  accessToken?: string;
  expiresAt?: number;
  pageSize?: number;
  includeTranscriptEntries?: boolean;
  allConferenceRecords?: boolean;
  includeDocumentBodies?: boolean;
  mergeDuplicateParticipants?: boolean;
  lateAfterMinutes?: number;
  earlyBeforeMinutes?: number;
} {
  const meeting = options.meeting?.trim() || config.defaults.meeting;
  const conferenceRecord = options.conferenceRecord?.trim();
  if (!meeting && !conferenceRecord && !hasCalendarLookupOptions(options)) {
    throw new Error(
      "Meeting input or conference record is required. Pass --meeting, --today, --event, --conference-record, or configure defaults.meeting.",
    );
  }
  return {
    meeting,
    conferenceRecord,
    clientId: options.clientId?.trim() || config.oauth.clientId,
    clientSecret: options.clientSecret?.trim() || config.oauth.clientSecret,
    refreshToken: options.refreshToken?.trim() || config.oauth.refreshToken,
    accessToken: options.accessToken?.trim() || config.oauth.accessToken,
    expiresAt: parseOptionalNumber(options.expiresAt) ?? config.oauth.expiresAt,
    pageSize: parseOptionalNumber(options.pageSize),
    includeTranscriptEntries: options.transcriptEntries !== false,
    allConferenceRecords: Boolean(options.allConferenceRecords),
    includeDocumentBodies: Boolean(options.includeDocBodies),
    mergeDuplicateParticipants: options.mergeDuplicates !== false,
    lateAfterMinutes: parseOptionalNumber(options.lateAfterMinutes),
    earlyBeforeMinutes: parseOptionalNumber(options.earlyBeforeMinutes),
  };
}

function hasCreateOAuth(config: GoogleMeetConfig, options: CreateOptions): boolean {
  return Boolean(
    options.accessToken?.trim() ||
    options.refreshToken?.trim() ||
    config.oauth.accessToken ||
    config.oauth.refreshToken,
  );
}

function writeArtifactsSummary(result: GoogleMeetArtifactsResult): void {
  if (result.input) {
    writeStdoutLine("input: %s", result.input);
  }
  if (result.space) {
    writeStdoutLine("space: %s", result.space.name);
  }
  writeStdoutLine("conference records: %d", result.conferenceRecords.length);
  for (const entry of result.artifacts) {
    writeStdoutLine("");
    writeStdoutLine("record: %s", entry.conferenceRecord.name);
    writeStdoutLine("started: %s", formatOptional(entry.conferenceRecord.startTime));
    writeStdoutLine("ended: %s", formatOptional(entry.conferenceRecord.endTime));
    writeStdoutLine("participants: %d", entry.participants.length);
    writeStdoutLine("recordings: %d", entry.recordings.length);
    writeStdoutLine("transcripts: %d", entry.transcripts.length);
    writeStdoutLine(
      "transcript entries: %d",
      entry.transcriptEntries.reduce((count, transcript) => count + transcript.entries.length, 0),
    );
    writeStdoutLine("smart notes: %d", entry.smartNotes.length);
    if (entry.smartNotesError) {
      writeStdoutLine("smart notes warning: %s", entry.smartNotesError);
    }
    for (const recording of entry.recordings) {
      writeStdoutLine("- recording: %s", recording.name);
    }
    for (const transcript of entry.transcripts) {
      writeStdoutLine("- transcript: %s", transcript.name);
      if (transcript.documentTextError) {
        writeStdoutLine("- transcript document body warning: %s", transcript.documentTextError);
      }
    }
    for (const transcriptEntries of entry.transcriptEntries) {
      if (transcriptEntries.entriesError) {
        writeStdoutLine(
          "- transcript entries warning: %s: %s",
          transcriptEntries.transcript,
          transcriptEntries.entriesError,
        );
      }
    }
    for (const smartNote of entry.smartNotes) {
      writeStdoutLine("- smart note: %s", smartNote.name);
      if (smartNote.documentTextError) {
        writeStdoutLine("- smart note document body warning: %s", smartNote.documentTextError);
      }
    }
  }
}

function writeAttendanceSummary(result: GoogleMeetAttendanceResult): void {
  if (result.input) {
    writeStdoutLine("input: %s", result.input);
  }
  if (result.space) {
    writeStdoutLine("space: %s", result.space.name);
  }
  writeStdoutLine("conference records: %d", result.conferenceRecords.length);
  writeStdoutLine("attendance rows: %d", result.attendance.length);
  for (const row of result.attendance) {
    const identity = row.displayName || row.user || row.participant;
    writeStdoutLine("");
    writeStdoutLine("participant: %s", identity);
    writeStdoutLine("record: %s", row.conferenceRecord);
    writeStdoutLine("resource: %s", row.participant);
    writeStdoutLine("participants merged: %d", row.participants?.length ?? 1);
    writeStdoutLine("first joined: %s", formatOptional(row.firstJoinTime ?? row.earliestStartTime));
    writeStdoutLine("last left: %s", formatOptional(row.lastLeaveTime ?? row.latestEndTime));
    writeStdoutLine("duration: %s", formatDuration(row.durationMs));
    writeStdoutLine("late: %s", row.late ? formatDuration(row.lateByMs) : "no");
    writeStdoutLine("early leave: %s", row.earlyLeave ? formatDuration(row.earlyLeaveByMs) : "no");
    writeStdoutLine("sessions: %d", row.sessions.length);
    for (const session of row.sessions) {
      writeStdoutLine(
        "- %s: %s -> %s",
        session.name,
        formatOptional(session.startTime),
        formatOptional(session.endTime),
      );
    }
  }
}

function writeLatestConferenceRecordSummary(result: GoogleMeetLatestConferenceRecordResult): void {
  writeStdoutLine("input: %s", result.input);
  writeStdoutLine("space: %s", result.space.name);
  if (!result.conferenceRecord) {
    writeStdoutLine("conference record: none");
    return;
  }
  writeStdoutLine("conference record: %s", result.conferenceRecord.name);
  writeStdoutLine("started: %s", formatOptional(result.conferenceRecord.startTime));
  writeStdoutLine("ended: %s", formatOptional(result.conferenceRecord.endTime));
}

function writeCalendarEventsSummary(
  result: Awaited<ReturnType<typeof listGoogleMeetCalendarEvents>>,
): void {
  writeStdoutLine("calendar: %s", result.calendarId);
  writeStdoutLine("meet events: %d", result.events.length);
  for (const entry of result.events) {
    writeStdoutLine("");
    writeStdoutLine("%s%s", entry.selected ? "* " : "- ", entry.event.summary ?? "untitled");
    writeStdoutLine("meeting uri: %s", entry.meetingUri);
    writeStdoutLine(
      "starts: %s",
      formatOptional(entry.event.start?.dateTime ?? entry.event.start?.date),
    );
    writeStdoutLine("ends: %s", formatOptional(entry.event.end?.dateTime ?? entry.event.end?.date));
  }
}

function pushMarkdownLine(lines: string[], text = ""): void {
  lines.push(text);
}

function formatMarkdownOptional(value: unknown): string {
  return typeof value === "string" && value.trim() ? value : "n/a";
}

function formatMarkdownIdentity(row: GoogleMeetAttendanceResult["attendance"][number]): string {
  return row.displayName || row.user || row.participant;
}

function participantDisplayName(
  entry: GoogleMeetArtifactsResult["artifacts"][number],
  name: string,
): string {
  const participant = entry.participants.find((candidate) => candidate.name === name);
  if (!participant) {
    return name;
  }
  return (
    participant.signedinUser?.displayName ??
    participant.anonymousUser?.displayName ??
    participant.phoneUser?.displayName ??
    participant.signedinUser?.user ??
    name
  );
}

function renderArtifactsMarkdown(result: GoogleMeetArtifactsResult): string {
  const lines: string[] = ["# Google Meet Artifacts"];
  if (result.input) {
    pushMarkdownLine(lines, `Input: ${result.input}`);
  }
  if (result.space) {
    pushMarkdownLine(lines, `Space: ${result.space.name}`);
  }
  pushMarkdownLine(lines);
  pushMarkdownLine(lines, `Conference records: ${result.conferenceRecords.length}`);
  for (const entry of result.artifacts) {
    pushMarkdownLine(lines);
    pushMarkdownLine(lines, `## ${entry.conferenceRecord.name}`);
    pushMarkdownLine(lines, `Started: ${formatMarkdownOptional(entry.conferenceRecord.startTime)}`);
    pushMarkdownLine(lines, `Ended: ${formatMarkdownOptional(entry.conferenceRecord.endTime)}`);
    pushMarkdownLine(lines);
    pushMarkdownLine(lines, `Participants: ${entry.participants.length}`);
    pushMarkdownLine(lines, `Recordings: ${entry.recordings.length}`);
    pushMarkdownLine(lines, `Transcripts: ${entry.transcripts.length}`);
    pushMarkdownLine(
      lines,
      `Transcript entries: ${entry.transcriptEntries.reduce(
        (count, transcript) => count + transcript.entries.length,
        0,
      )}`,
    );
    pushMarkdownLine(lines, `Smart notes: ${entry.smartNotes.length}`);
    const warnings = collectGoogleMeetArtifactWarnings({
      conferenceRecords: [entry.conferenceRecord],
      artifacts: [entry],
    });
    if (warnings.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Warnings");
      for (const warning of warnings) {
        const resource = warning.resource ? `${warning.resource}: ` : "";
        pushMarkdownLine(lines, `- ${resource}${warning.message}`);
      }
    }
    if (entry.recordings.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Recordings");
      for (const recording of entry.recordings) {
        pushMarkdownLine(lines, `- ${recording.name}`);
      }
    }
    if (entry.transcripts.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Transcripts");
      for (const transcript of entry.transcripts) {
        pushMarkdownLine(lines, `- ${transcript.name}`);
        if (transcript.documentTextError) {
          pushMarkdownLine(lines, `  - Document body warning: ${transcript.documentTextError}`);
        } else if (transcript.documentText) {
          pushMarkdownLine(lines, `  - Document body: ${transcript.documentText.length} chars`);
        }
      }
    }
    for (const transcriptEntries of entry.transcriptEntries) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, `### Transcript Entries: ${transcriptEntries.transcript}`);
      if (transcriptEntries.entriesError) {
        pushMarkdownLine(lines, `Warning: ${transcriptEntries.entriesError}`);
        continue;
      }
      if (transcriptEntries.entries.length === 0) {
        pushMarkdownLine(lines, "_No transcript entries._");
        continue;
      }
      for (const transcriptEntry of transcriptEntries.entries) {
        const times =
          transcriptEntry.startTime || transcriptEntry.endTime
            ? ` (${formatMarkdownOptional(transcriptEntry.startTime)} -> ${formatMarkdownOptional(
                transcriptEntry.endTime,
              )})`
            : "";
        const speaker = transcriptEntry.participant
          ? `${participantDisplayName(entry, transcriptEntry.participant)}: `
          : "";
        pushMarkdownLine(lines, `- ${speaker}${transcriptEntry.text ?? ""}${times}`);
      }
    }
    if (entry.smartNotes.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Smart Notes");
      for (const smartNote of entry.smartNotes) {
        pushMarkdownLine(lines, `- ${smartNote.name}`);
        if (smartNote.documentTextError) {
          pushMarkdownLine(lines, `  - Document body warning: ${smartNote.documentTextError}`);
        } else if (smartNote.documentText) {
          pushMarkdownLine(lines, `  - Document body: ${smartNote.documentText.length} chars`);
        }
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

function renderAttendanceMarkdown(result: GoogleMeetAttendanceResult): string {
  const lines: string[] = ["# Google Meet Attendance"];
  if (result.input) {
    pushMarkdownLine(lines, `Input: ${result.input}`);
  }
  if (result.space) {
    pushMarkdownLine(lines, `Space: ${result.space.name}`);
  }
  pushMarkdownLine(lines);
  pushMarkdownLine(lines, `Conference records: ${result.conferenceRecords.length}`);
  pushMarkdownLine(lines, `Attendance rows: ${result.attendance.length}`);
  for (const row of result.attendance) {
    pushMarkdownLine(lines);
    pushMarkdownLine(lines, `## ${formatMarkdownIdentity(row)}`);
    pushMarkdownLine(lines, `Record: ${row.conferenceRecord}`);
    pushMarkdownLine(lines, `Resource: ${row.participant}`);
    pushMarkdownLine(lines, `Participants merged: ${row.participants?.length ?? 1}`);
    pushMarkdownLine(
      lines,
      `First joined: ${formatMarkdownOptional(row.firstJoinTime ?? row.earliestStartTime)}`,
    );
    pushMarkdownLine(
      lines,
      `Last left: ${formatMarkdownOptional(row.lastLeaveTime ?? row.latestEndTime)}`,
    );
    pushMarkdownLine(lines, `Duration: ${formatDuration(row.durationMs)}`);
    pushMarkdownLine(lines, `Late: ${row.late ? formatDuration(row.lateByMs) : "no"}`);
    pushMarkdownLine(
      lines,
      `Early leave: ${row.earlyLeave ? formatDuration(row.earlyLeaveByMs) : "no"}`,
    );
    pushMarkdownLine(lines, `Sessions: ${row.sessions.length}`);
    for (const session of row.sessions) {
      pushMarkdownLine(
        lines,
        `- ${session.name}: ${formatMarkdownOptional(session.startTime)} -> ${formatMarkdownOptional(
          session.endTime,
        )}`,
      );
    }
  }
  return `${lines.join("\n")}\n`;
}

function csvCell(value: unknown): string {
  const text =
    value === undefined || value === null
      ? ""
      : typeof value === "string" || typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function renderAttendanceCsv(result: GoogleMeetAttendanceResult): string {
  const rows: unknown[][] = [
    [
      "conferenceRecord",
      "displayName",
      "user",
      "participants",
      "firstJoined",
      "lastLeft",
      "durationMs",
      "sessions",
      "late",
      "lateByMs",
      "earlyLeave",
      "earlyLeaveByMs",
    ],
  ];
  for (const row of result.attendance) {
    rows.push([
      row.conferenceRecord,
      row.displayName ?? "",
      row.user ?? "",
      (row.participants ?? [row.participant]).join(";"),
      row.firstJoinTime ?? row.earliestStartTime ?? "",
      row.lastLeaveTime ?? row.latestEndTime ?? "",
      row.durationMs ?? "",
      row.sessions.length,
      row.late ?? "",
      row.lateByMs ?? "",
      row.earlyLeave ?? "",
      row.earlyLeaveByMs ?? "",
    ]);
  }
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function renderTranscriptMarkdown(result: GoogleMeetArtifactsResult): string {
  const lines: string[] = ["# Google Meet Transcript"];
  if (result.input) {
    pushMarkdownLine(lines, `Input: ${result.input}`);
  }
  for (const entry of result.artifacts) {
    pushMarkdownLine(lines);
    pushMarkdownLine(lines, `## ${entry.conferenceRecord.name}`);
    if (entry.transcriptEntries.length === 0) {
      pushMarkdownLine(lines, "_No transcript entries._");
      continue;
    }
    for (const transcriptEntries of entry.transcriptEntries) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, `### ${transcriptEntries.transcript}`);
      if (transcriptEntries.entriesError) {
        pushMarkdownLine(lines, `Warning: ${transcriptEntries.entriesError}`);
        continue;
      }
      for (const transcriptEntry of transcriptEntries.entries) {
        const speaker = transcriptEntry.participant
          ? participantDisplayName(entry, transcriptEntry.participant)
          : "unknown";
        const time = transcriptEntry.startTime ? ` [${transcriptEntry.startTime}]` : "";
        pushMarkdownLine(lines, `- ${speaker}${time}: ${transcriptEntry.text ?? ""}`);
      }
    }
    const docsTranscripts = entry.transcripts.filter((transcript) => transcript.documentText);
    if (docsTranscripts.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Transcript Document Bodies");
      for (const transcript of docsTranscripts) {
        pushMarkdownLine(lines);
        pushMarkdownLine(lines, `#### ${transcript.name}`);
        pushMarkdownLine(lines, transcript.documentText?.trim() || "_Empty document body._");
      }
    }
    const smartNotes = entry.smartNotes.filter((smartNote) => smartNote.documentText);
    if (smartNotes.length > 0) {
      pushMarkdownLine(lines);
      pushMarkdownLine(lines, "### Smart Note Document Bodies");
      for (const smartNote of smartNotes) {
        pushMarkdownLine(lines);
        pushMarkdownLine(lines, `#### ${smartNote.name}`);
        pushMarkdownLine(lines, smartNote.documentText?.trim() || "_Empty document body._");
      }
    }
  }
  return `${lines.join("\n")}\n`;
}

export function collectGoogleMeetArtifactWarnings(
  result: GoogleMeetArtifactsResult,
): GoogleMeetExportWarning[] {
  const warnings: GoogleMeetExportWarning[] = [];
  for (const entry of result.artifacts) {
    const conferenceRecord = entry.conferenceRecord.name;
    if (entry.smartNotesError) {
      warnings.push({
        type: "smart_notes",
        conferenceRecord,
        message: entry.smartNotesError,
      });
    }
    for (const transcriptEntries of entry.transcriptEntries) {
      if (transcriptEntries.entriesError) {
        warnings.push({
          type: "transcript_entries",
          conferenceRecord,
          resource: transcriptEntries.transcript,
          message: transcriptEntries.entriesError,
        });
      }
    }
    for (const transcript of entry.transcripts) {
      if (transcript.documentTextError) {
        warnings.push({
          type: "transcript_document_body",
          conferenceRecord,
          resource: transcript.name,
          message: transcript.documentTextError,
        });
      }
    }
    for (const smartNote of entry.smartNotes) {
      if (smartNote.documentTextError) {
        warnings.push({
          type: "smart_note_document_body",
          conferenceRecord,
          resource: smartNote.name,
          message: smartNote.documentTextError,
        });
      }
    }
  }
  return warnings;
}

export function buildGoogleMeetExportManifest(params: {
  artifacts: GoogleMeetArtifactsResult;
  attendance: GoogleMeetAttendanceResult;
  files: string[];
  request?: GoogleMeetExportRequest;
  tokenSource?: "cached-access-token" | "refresh-token";
  calendarEvent?: GoogleMeetCalendarLookupResult;
  zipFile?: string;
}): GoogleMeetExportManifest {
  const transcriptEntryCount = params.artifacts.artifacts.reduce(
    (count, entry) =>
      count +
      entry.transcriptEntries.reduce(
        (entryCount, transcript) => entryCount + transcript.entries.length,
        0,
      ),
    0,
  );
  const warnings = collectGoogleMeetArtifactWarnings(params.artifacts);
  return {
    generatedAt: new Date().toISOString(),
    ...(params.request ? { request: params.request } : {}),
    ...(params.tokenSource ? { tokenSource: params.tokenSource } : {}),
    ...(params.calendarEvent ? { calendarEvent: params.calendarEvent } : {}),
    inputs: {
      ...(params.artifacts.input ? { artifacts: params.artifacts.input } : {}),
      ...(params.attendance.input ? { attendance: params.attendance.input } : {}),
    },
    counts: {
      conferenceRecords: params.artifacts.conferenceRecords.length,
      artifacts: params.artifacts.artifacts.length,
      attendanceRows: params.attendance.attendance.length,
      recordings: params.artifacts.artifacts.reduce(
        (count, entry) => count + entry.recordings.length,
        0,
      ),
      transcripts: params.artifacts.artifacts.reduce(
        (count, entry) => count + entry.transcripts.length,
        0,
      ),
      transcriptEntries: transcriptEntryCount,
      smartNotes: params.artifacts.artifacts.reduce(
        (count, entry) => count + entry.smartNotes.length,
        0,
      ),
      warnings: warnings.length,
    },
    conferenceRecords: params.artifacts.conferenceRecords.map((record) => record.name),
    files: params.files,
    ...(params.zipFile ? { zipFile: params.zipFile } : {}),
    warnings,
  };
}

export function googleMeetExportFileNames(): string[] {
  return [
    "summary.md",
    "attendance.csv",
    "transcript.md",
    "artifacts.json",
    "attendance.json",
    "manifest.json",
  ];
}

function defaultExportDirectory(): string {
  return `google-meet-export-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

const CRC32_TABLE = new Uint32Array(
  Array.from({ length: 256 }, (_, index) => {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    return value >>> 0;
  }),
);

function crc32(buffer: Buffer): number {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function dosDateTime(date = new Date()): { date: number; time: number } {
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    date: ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function buildZipArchive(files: Array<{ name: string; content: string }>): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;
  const stamp = dosDateTime();
  for (const file of files) {
    const name = Buffer.from(file.name, "utf8");
    const content = Buffer.from(file.content, "utf8");
    const checksum = crc32(content);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(content.length, 18);
    local.writeUInt32LE(content.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, content);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(checksum, 16);
    central.writeUInt32LE(content.length, 20);
    central.writeUInt32LE(content.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);
    offset += local.length + name.length + content.length;
  }
  const centralDirectory = Buffer.concat(centralParts);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, centralDirectory, end]);
}

export async function writeMeetExportBundle(params: {
  outputDir?: string;
  artifacts: GoogleMeetArtifactsResult;
  attendance: GoogleMeetAttendanceResult;
  zip?: boolean;
  request?: GoogleMeetExportRequest;
  tokenSource?: "cached-access-token" | "refresh-token";
  calendarEvent?: GoogleMeetCalendarLookupResult;
}): Promise<{ outputDir: string; files: string[]; zipFile?: string }> {
  const outputDir = params.outputDir?.trim() || defaultExportDirectory();
  await mkdir(outputDir, { recursive: true });
  const zipFile = params.zip ? `${outputDir.replace(/\/$/, "")}.zip` : undefined;
  const fileNames = googleMeetExportFileNames();
  const files = [
    {
      name: "summary.md",
      content: `${renderArtifactsMarkdown(params.artifacts)}\n${renderAttendanceMarkdown(params.attendance)}`,
    },
    { name: "attendance.csv", content: renderAttendanceCsv(params.attendance) },
    { name: "transcript.md", content: renderTranscriptMarkdown(params.artifacts) },
    { name: "artifacts.json", content: `${JSON.stringify(params.artifacts, null, 2)}\n` },
    { name: "attendance.json", content: `${JSON.stringify(params.attendance, null, 2)}\n` },
    {
      name: "manifest.json",
      content: `${JSON.stringify(
        buildGoogleMeetExportManifest({
          artifacts: params.artifacts,
          attendance: params.attendance,
          files: fileNames,
          ...(params.request ? { request: params.request } : {}),
          ...(params.tokenSource ? { tokenSource: params.tokenSource } : {}),
          ...(params.calendarEvent ? { calendarEvent: params.calendarEvent } : {}),
          ...(zipFile ? { zipFile } : {}),
        }),
        null,
        2,
      )}\n`,
    },
  ];
  for (const file of files) {
    await writeFile(path.join(outputDir, file.name), file.content, "utf8");
  }
  const result: { outputDir: string; files: string[]; zipFile?: string } = {
    outputDir,
    files: files.map((file) => path.join(outputDir, file.name)),
  };
  if (zipFile) {
    await writeFile(zipFile, buildZipArchive(files));
    result.zipFile = zipFile;
  }
  return result;
}

export function registerGoogleMeetCli(params: {
  program: Command;
  config: GoogleMeetConfig;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
}) {
  const root = params.program
    .command("googlemeet")
    .description("Google Meet participant utilities")
    .addHelpText("after", () => `\nDocs: https://docs.openclaw.ai/plugins/google-meet\n`);

  const auth = root.command("auth").description("Google Meet OAuth helpers");

  auth
    .command("login")
    .description("Run a PKCE OAuth flow and print refresh-token JSON to store in plugin config")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--manual", "Use copy/paste callback flow instead of localhost callback")
    .option("--json", "Print the token payload as JSON", false)
    .option("--timeout-sec <n>", "Local callback timeout in seconds", "300")
    .action(async (options: OAuthLoginOptions) => {
      const clientId = options.clientId?.trim() || params.config.oauth.clientId;
      const clientSecret = options.clientSecret?.trim() || params.config.oauth.clientSecret;
      if (!clientId) {
        throw new Error(
          "Missing Google Meet OAuth client id. Configure oauth.clientId or pass --client-id.",
        );
      }
      const { verifier, challenge } = createGoogleMeetPkce();
      const state = createGoogleMeetOAuthState();
      const authUrl = buildGoogleMeetAuthUrl({
        clientId,
        challenge,
        state,
      });
      const code = await waitForGoogleMeetAuthCode({
        state,
        manual: Boolean(options.manual),
        timeoutMs: (parseOptionalNumber(options.timeoutSec) ?? 300) * 1000,
        authUrl,
        promptInput,
        writeLine: (message) => writeStdoutLine("%s", message),
      });
      const tokens = await exchangeGoogleMeetAuthCode({
        clientId,
        clientSecret,
        code,
        verifier,
      });
      if (!tokens.refreshToken) {
        throw new Error(
          "Google OAuth did not return a refresh token. Re-run the flow with consent and offline access.",
        );
      }
      const payload = {
        oauth: {
          clientId,
          ...(clientSecret ? { clientSecret } : {}),
          refreshToken: tokens.refreshToken,
          accessToken: tokens.accessToken,
          expiresAt: tokens.expiresAt,
        },
        scope: tokens.scope,
        tokenType: tokens.tokenType,
      };
      if (!options.json) {
        writeStdoutLine("Paste this into plugins.entries.google-meet.config:");
      }
      writeStdoutJson(payload);
    });

  root
    .command("create")
    .description("Create a new Google Meet space and print its meeting URL")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--no-join", "Only create the meeting URL; do not join it")
    .option("--transport <transport>", "Join transport: chrome, chrome-node, or twilio")
    .option(
      "--mode <mode>",
      "Join mode: realtime for live talk-back, transcribe for observe/control",
    )
    .option("--message <text>", "Realtime speech to trigger after join")
    .option("--dial-in-number <phone>", "Meet dial-in number for Twilio transport")
    .option("--pin <pin>", "Meet phone PIN; # is appended if omitted")
    .option("--dtmf-sequence <sequence>", "Explicit Twilio DTMF sequence")
    .option("--json", "Print JSON output", false)
    .action(async (options: CreateOptions) => {
      if (!hasCreateOAuth(params.config, options)) {
        const rt = await params.ensureRuntime();
        const result = await rt.createViaBrowser();
        const join =
          options.join !== false
            ? await rt.join({
                url: result.meetingUri,
                transport: options.transport,
                mode: options.mode,
                message: options.message,
                dialInNumber: options.dialInNumber,
                pin: options.pin,
                dtmfSequence: options.dtmfSequence,
              })
            : undefined;
        const payload = {
          source: result.source,
          meetingUri: result.meetingUri,
          joined: Boolean(join),
          ...(join ? { join } : {}),
          browser: {
            nodeId: result.nodeId,
            targetId: result.targetId,
            browserUrl: result.browserUrl,
            browserTitle: result.browserTitle,
          },
        };
        if (options.json) {
          writeStdoutJson(payload);
          return;
        }
        writeStdoutLine("meeting uri: %s", result.meetingUri);
        writeStdoutLine("source: browser");
        writeStdoutLine("node: %s", result.nodeId);
        if (join) {
          writeStdoutLine("joined: %s", join.session.id);
        } else {
          writeStdoutLine("joined: no (run `openclaw googlemeet join %s`)", result.meetingUri);
        }
        return;
      }
      const token = await resolveGoogleMeetAccessToken(
        resolveCreateTokenOptions(params.config, options),
      );
      const result = await createGoogleMeetSpace({ accessToken: token.accessToken });
      const join =
        options.join !== false
          ? await (
              await params.ensureRuntime()
            ).join({
              url: result.meetingUri,
              transport: options.transport,
              mode: options.mode,
              message: options.message,
              dialInNumber: options.dialInNumber,
              pin: options.pin,
              dtmfSequence: options.dtmfSequence,
            })
          : undefined;
      if (options.json) {
        writeStdoutJson({
          ...result,
          tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
          joined: Boolean(join),
          ...(join ? { join } : {}),
        });
        return;
      }
      writeStdoutLine("meeting uri: %s", result.meetingUri);
      writeStdoutLine("space: %s", result.space.name);
      if (result.space.meetingCode) {
        writeStdoutLine("meeting code: %s", result.space.meetingCode);
      }
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
      if (join) {
        writeStdoutLine("joined: %s", join.session.id);
      } else {
        writeStdoutLine("joined: no (run `openclaw googlemeet join %s`)", result.meetingUri);
      }
    });

  root
    .command("join")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome, chrome-node, or twilio")
    .option(
      "--mode <mode>",
      "Mode: realtime for live talk-back, transcribe to join without the realtime voice bridge",
    )
    .option("--message <text>", "Realtime speech to trigger after join")
    .option("--dial-in-number <phone>", "Meet dial-in number for Twilio transport")
    .option("--pin <pin>", "Meet phone PIN; # is appended if omitted")
    .option("--dtmf-sequence <sequence>", "Explicit Twilio DTMF sequence")
    .action(async (url: string | undefined, options: JoinOptions) => {
      const rt = await params.ensureRuntime();
      const result = await rt.join({
        url: resolveMeetingInput(params.config, url),
        transport: options.transport,
        mode: options.mode,
        message: options.message,
        dialInNumber: options.dialInNumber,
        pin: options.pin,
        dtmfSequence: options.dtmfSequence,
      });
      writeStdoutJson(result.session);
    });

  root
    .command("test-speech")
    .argument("[url]", "Explicit https://meet.google.com/... URL")
    .option("--transport <transport>", "Transport: chrome, chrome-node, or twilio")
    .option(
      "--mode <mode>",
      "Mode: realtime for live talk-back, transcribe to join without the realtime voice bridge",
    )
    .option(
      "--message <text>",
      "Realtime speech to trigger",
      "Say exactly: Google Meet speech test complete.",
    )
    .action(async (url: string | undefined, options: JoinOptions) => {
      const rt = await params.ensureRuntime();
      writeStdoutJson(
        await rt.testSpeech({
          url: resolveMeetingInput(params.config, url),
          transport: options.transport,
          mode: options.mode,
          message: options.message,
        }),
      );
    });

  root
    .command("resolve-space")
    .description("Resolve a Meet URL, meeting code, or spaces/{id} to its canonical space")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const resolved = resolveTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const space = await fetchGoogleMeetSpace({
        accessToken: token.accessToken,
        meeting: resolved.meeting,
      });
      if (options.json) {
        writeStdoutJson(space);
        return;
      }
      writeStdoutLine("input: %s", resolved.meeting);
      writeStdoutLine("space: %s", space.name);
      if (space.meetingCode) {
        writeStdoutLine("meeting code: %s", space.meetingCode);
      }
      if (space.meetingUri) {
        writeStdoutLine("meeting uri: %s", space.meetingUri);
      }
      writeStdoutLine("active conference: %s", space.activeConference ? "yes" : "no");
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("preflight")
    .description("Validate OAuth + meeting resolution prerequisites for Meet media work")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const resolved = resolveTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const space = await fetchGoogleMeetSpace({
        accessToken: token.accessToken,
        meeting: resolved.meeting,
      });
      const report = buildGoogleMeetPreflightReport({
        input: resolved.meeting,
        space,
        previewAcknowledged: params.config.preview.enrollmentAcknowledged,
        tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
      });
      if (options.json) {
        writeStdoutJson(report);
        return;
      }
      writeStdoutLine("input: %s", report.input);
      writeStdoutLine("resolved space: %s", report.resolvedSpaceName);
      if (report.meetingCode) {
        writeStdoutLine("meeting code: %s", report.meetingCode);
      }
      if (report.meetingUri) {
        writeStdoutLine("meeting uri: %s", report.meetingUri);
      }
      writeStdoutLine("active conference: %s", report.hasActiveConference ? "yes" : "no");
      writeStdoutLine("preview acknowledged: %s", report.previewAcknowledged ? "yes" : "no");
      writeStdoutLine("token source: %s", report.tokenSource);
      if (report.blockers.length === 0) {
        writeStdoutLine("blockers: none");
        return;
      }
      writeStdoutLine("blockers:");
      for (const blocker of report.blockers) {
        writeStdoutLine("- %s", blocker);
      }
    });

  root
    .command("latest")
    .description("Find the latest Meet conference record for a meeting")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--today", "Find a Meet link on today's calendar")
    .option("--event <query>", "Find a matching calendar event with a Meet link")
    .option("--calendar <id>", "Calendar id for --today or --event", "primary")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const token = await resolveGoogleMeetAccessToken(
        resolveOAuthTokenOptions(params.config, options),
      );
      const resolved = await resolveMeetingForToken({
        config: params.config,
        options,
        accessToken: token.accessToken,
        configuredMeeting: options.meeting?.trim(),
      });
      const result = await fetchLatestGoogleMeetConferenceRecord({
        accessToken: token.accessToken,
        meeting: resolved.meeting,
      });
      if (options.json) {
        writeStdoutJson({
          ...result,
          ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
          tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
        });
        return;
      }
      if (resolved.calendarEvent) {
        writeStdoutLine("calendar event: %s", resolved.calendarEvent.event.summary ?? "untitled");
        writeStdoutLine("calendar meet: %s", resolved.calendarEvent.meetingUri);
      }
      writeLatestConferenceRecordSummary(result);
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("calendar-events")
    .description("Preview Calendar events with Google Meet links")
    .option("--today", "Find Meet links on today's calendar")
    .option("--event <query>", "Find matching calendar events with Meet links")
    .option("--calendar <id>", "Calendar id for lookup", "primary")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (options: ResolveSpaceOptions) => {
      const token = await resolveGoogleMeetAccessToken(
        resolveOAuthTokenOptions(params.config, options),
      );
      const window = options.today ? buildGoogleMeetCalendarDayWindow() : {};
      const result = await listGoogleMeetCalendarEvents({
        accessToken: token.accessToken,
        calendarId: options.calendar,
        eventQuery: options.event,
        ...window,
      });
      const payload = {
        ...result,
        tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
      };
      if (options.json) {
        writeStdoutJson(payload);
        return;
      }
      writeCalendarEventsSummary(result);
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("artifacts")
    .description("List Meet conference records and available participant/artifact metadata")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--conference-record <name>", "Conference record name or id")
    .option("--today", "Find a Meet link on today's calendar")
    .option("--event <query>", "Find a matching calendar event with a Meet link")
    .option("--calendar <id>", "Calendar id for --today or --event", "primary")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--page-size <n>", "Max resources per Meet API page")
    .option("--all-conference-records", "Fetch every conference record for --meeting")
    .option("--no-transcript-entries", "Skip structured transcript entry lookup")
    .option("--include-doc-bodies", "Export linked transcript and smart-note Google Docs text")
    .option("--format <format>", "Output format: summary or markdown", "summary")
    .option("--output <path>", "Write output to a file instead of stdout")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = resolveArtifactTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const meeting = resolved.conferenceRecord
        ? resolved.meeting
        : (
            await resolveMeetingForToken({
              config: params.config,
              options,
              accessToken: token.accessToken,
              configuredMeeting: resolved.meeting,
            })
          ).meeting;
      const result = await fetchGoogleMeetArtifacts({
        accessToken: token.accessToken,
        meeting,
        conferenceRecord: resolved.conferenceRecord,
        pageSize: resolved.pageSize,
        includeTranscriptEntries: resolved.includeTranscriptEntries,
        allConferenceRecords: resolved.allConferenceRecords,
        includeDocumentBodies: resolved.includeDocumentBodies,
      });
      if (options.json) {
        await writeCliOutput(
          options,
          JSON.stringify(
            {
              ...result,
              tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
            },
            null,
            2,
          ),
        );
        return;
      }
      if (options.format === "markdown") {
        await writeCliOutput(options, renderArtifactsMarkdown(result));
        return;
      }
      if (options.format && options.format !== "summary") {
        throw new Error("Unsupported format. Expected summary or markdown.");
      }
      writeArtifactsSummary(result);
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("attendance")
    .description("List Meet participants and participant sessions")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--conference-record <name>", "Conference record name or id")
    .option("--today", "Find a Meet link on today's calendar")
    .option("--event <query>", "Find a matching calendar event with a Meet link")
    .option("--calendar <id>", "Calendar id for --today or --event", "primary")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--page-size <n>", "Max resources per Meet API page")
    .option("--all-conference-records", "Fetch every conference record for --meeting")
    .option("--no-merge-duplicates", "Keep duplicate participant resources as separate rows")
    .option("--late-after-minutes <n>", "Mark participants late after this many minutes", "5")
    .option("--early-before-minutes <n>", "Mark early leavers before this many minutes", "5")
    .option("--format <format>", "Output format: summary, markdown, or csv", "summary")
    .option("--output <path>", "Write output to a file instead of stdout")
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = resolveArtifactTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const meeting = resolved.conferenceRecord
        ? resolved.meeting
        : (
            await resolveMeetingForToken({
              config: params.config,
              options,
              accessToken: token.accessToken,
              configuredMeeting: resolved.meeting,
            })
          ).meeting;
      const result = await fetchGoogleMeetAttendance({
        accessToken: token.accessToken,
        meeting,
        conferenceRecord: resolved.conferenceRecord,
        pageSize: resolved.pageSize,
        allConferenceRecords: resolved.allConferenceRecords,
        mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
        lateAfterMinutes: resolved.lateAfterMinutes,
        earlyBeforeMinutes: resolved.earlyBeforeMinutes,
      });
      if (options.json) {
        await writeCliOutput(
          options,
          JSON.stringify(
            {
              ...result,
              tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
            },
            null,
            2,
          ),
        );
        return;
      }
      if (options.format === "markdown") {
        await writeCliOutput(options, renderAttendanceMarkdown(result));
        return;
      }
      if (options.format === "csv") {
        await writeCliOutput(options, renderAttendanceCsv(result));
        return;
      }
      if (options.format && options.format !== "summary") {
        throw new Error("Unsupported format. Expected summary, markdown, or csv.");
      }
      writeAttendanceSummary(result);
      writeStdoutLine(
        "token source: %s",
        token.refreshed ? "refresh-token" : "cached-access-token",
      );
    });

  root
    .command("export")
    .description("Write Meet artifacts, attendance, transcript, and raw JSON into a folder")
    .option("--meeting <value>", "Meet URL, meeting code, or spaces/{id}")
    .option("--conference-record <name>", "Conference record name or id")
    .option("--today", "Find a Meet link on today's calendar")
    .option("--event <query>", "Find a matching calendar event with a Meet link")
    .option("--calendar <id>", "Calendar id for --today or --event", "primary")
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--page-size <n>", "Max resources per Meet API page")
    .option("--all-conference-records", "Fetch every conference record for --meeting")
    .option("--no-transcript-entries", "Skip structured transcript entry lookup")
    .option("--include-doc-bodies", "Export linked transcript and smart-note Google Docs text")
    .option("--no-merge-duplicates", "Keep duplicate participant resources as separate rows")
    .option("--late-after-minutes <n>", "Mark participants late after this many minutes", "5")
    .option("--early-before-minutes <n>", "Mark early leavers before this many minutes", "5")
    .option("--output <dir>", "Output directory")
    .option("--zip", "Also write a portable .zip archive")
    .option("--dry-run", "Fetch export data and print the manifest without writing files", false)
    .option("--json", "Print JSON output", false)
    .action(async (options: MeetArtifactOptions) => {
      const resolved = resolveArtifactTokenOptions(params.config, options);
      const token = await resolveGoogleMeetAccessToken(resolved);
      const meetingResult: { meeting?: string; calendarEvent?: GoogleMeetCalendarLookupResult } =
        resolved.conferenceRecord
          ? { meeting: resolved.meeting }
          : await resolveMeetingForToken({
              config: params.config,
              options,
              accessToken: token.accessToken,
              configuredMeeting: resolved.meeting,
            });
      const artifacts = await fetchGoogleMeetArtifacts({
        accessToken: token.accessToken,
        meeting: meetingResult.meeting,
        conferenceRecord: resolved.conferenceRecord,
        pageSize: resolved.pageSize,
        includeTranscriptEntries: resolved.includeTranscriptEntries,
        allConferenceRecords: resolved.allConferenceRecords,
        includeDocumentBodies: resolved.includeDocumentBodies,
      });
      const attendance = await fetchGoogleMeetAttendance({
        accessToken: token.accessToken,
        meeting: meetingResult.meeting,
        conferenceRecord: resolved.conferenceRecord,
        pageSize: resolved.pageSize,
        allConferenceRecords: resolved.allConferenceRecords,
        mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
        lateAfterMinutes: resolved.lateAfterMinutes,
        earlyBeforeMinutes: resolved.earlyBeforeMinutes,
      });
      const resolvedMeeting = meetingResult.meeting ?? resolved.meeting;
      const request: GoogleMeetExportRequest = {
        ...(resolvedMeeting ? { meeting: resolvedMeeting } : {}),
        ...(resolved.conferenceRecord ? { conferenceRecord: resolved.conferenceRecord } : {}),
        ...(meetingResult.calendarEvent?.event.id
          ? { calendarEventId: meetingResult.calendarEvent.event.id }
          : {}),
        ...(meetingResult.calendarEvent?.event.summary
          ? { calendarEventSummary: meetingResult.calendarEvent.event.summary }
          : {}),
        ...(options.calendar ? { calendarId: options.calendar } : {}),
        ...(resolved.pageSize !== undefined ? { pageSize: resolved.pageSize } : {}),
        includeTranscriptEntries: resolved.includeTranscriptEntries,
        includeDocumentBodies: resolved.includeDocumentBodies,
        allConferenceRecords: resolved.allConferenceRecords,
        mergeDuplicateParticipants: resolved.mergeDuplicateParticipants,
        ...(resolved.lateAfterMinutes !== undefined
          ? { lateAfterMinutes: resolved.lateAfterMinutes }
          : {}),
        ...(resolved.earlyBeforeMinutes !== undefined
          ? { earlyBeforeMinutes: resolved.earlyBeforeMinutes }
          : {}),
      };
      if (options.dryRun) {
        writeStdoutJson({
          dryRun: true,
          manifest: buildGoogleMeetExportManifest({
            artifacts,
            attendance,
            files: googleMeetExportFileNames(),
            request,
            tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
            ...(meetingResult.calendarEvent ? { calendarEvent: meetingResult.calendarEvent } : {}),
          }),
          ...(meetingResult.calendarEvent ? { calendarEvent: meetingResult.calendarEvent } : {}),
          tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
        });
        return;
      }
      const bundle = await writeMeetExportBundle({
        outputDir: options.output,
        artifacts,
        attendance,
        zip: Boolean(options.zip),
        request,
        tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
        ...(meetingResult.calendarEvent ? { calendarEvent: meetingResult.calendarEvent } : {}),
      });
      const payload = {
        ...bundle,
        ...(meetingResult.calendarEvent ? { calendarEvent: meetingResult.calendarEvent } : {}),
        tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
      };
      if (options.json) {
        writeStdoutJson(payload);
        return;
      }
      writeStdoutLine("export: %s", bundle.outputDir);
      for (const file of bundle.files) {
        writeStdoutLine("- %s", file);
      }
      if (bundle.zipFile) {
        writeStdoutLine("zip: %s", bundle.zipFile);
      }
    });

  root
    .command("status")
    .argument("[session-id]", "Meet session ID")
    .option("--json", "Print JSON output", false)
    .action(async (sessionId?: string) => {
      const rt = await params.ensureRuntime();
      writeStdoutJson(await rt.status(sessionId));
    });

  root
    .command("doctor")
    .description("Show human-readable Meet session/browser/realtime health")
    .argument("[session-id]", "Meet session ID")
    .option("--oauth", "Verify Google Meet OAuth token refresh without printing secrets", false)
    .option("--meeting <value>", "Also verify spaces.get for a Meet URL, code, or spaces/{id}")
    .option("--create-space", "Also verify spaces.create by creating a throwaway Meet space", false)
    .option("--access-token <token>", "Access token override")
    .option("--refresh-token <token>", "Refresh token override")
    .option("--client-id <id>", "OAuth client id override")
    .option("--client-secret <secret>", "OAuth client secret override")
    .option("--expires-at <ms>", "Cached access token expiry as unix epoch milliseconds")
    .option("--json", "Print JSON output", false)
    .action(async (sessionId: string | undefined, options: DoctorOptions) => {
      if (options.oauth) {
        const report = await buildOAuthDoctorReport(params.config, options);
        if (options.json) {
          writeStdoutJson(report);
          return;
        }
        writeOAuthDoctorReport(report);
        return;
      }
      const rt = await params.ensureRuntime();
      const status = await rt.status(sessionId);
      if (options.json) {
        writeStdoutJson(status);
        return;
      }
      writeDoctorStatus(status);
    });

  root
    .command("recover-tab")
    .description("Focus and inspect an existing Google Meet tab")
    .argument("[url]", "Optional Meet URL to match")
    .option("--transport <transport>", "Transport to inspect: chrome or chrome-node")
    .option("--json", "Print JSON output", false)
    .action(async (url: string | undefined, options: RecoverTabOptions) => {
      const rt = await params.ensureRuntime();
      const result = await rt.recoverCurrentTab({ url, transport: options.transport });
      if (options.json) {
        writeStdoutJson(result);
        return;
      }
      writeRecoverCurrentTabResult(result);
    });

  root
    .command("setup")
    .description("Show Google Meet transport setup status")
    .option("--transport <transport>", "Transport to check: chrome, chrome-node, or twilio")
    .option("--mode <mode>", "Mode to check: realtime or transcribe")
    .option("--json", "Print JSON output", false)
    .action(async (options: SetupOptions) => {
      const rt = await params.ensureRuntime();
      const status = await rt.setupStatus({ transport: options.transport, mode: options.mode });
      if (options.json) {
        writeStdoutJson(status);
        return;
      }
      writeSetupStatus(status);
    });

  root
    .command("leave")
    .argument("<session-id>", "Meet session ID")
    .action(async (sessionId: string) => {
      const rt = await params.ensureRuntime();
      const result = await rt.leave(sessionId);
      if (!result.found) {
        throw new Error("session not found");
      }
      writeStdoutLine("left %s", sessionId);
    });

  root
    .command("speak")
    .argument("<session-id>", "Meet session ID")
    .argument("[message]", "Realtime instructions to speak now")
    .action(async (sessionId: string, message?: string) => {
      const rt = await params.ensureRuntime();
      const result = await rt.speak(sessionId, message);
      if (!result.found) {
        throw new Error("session not found");
      }
      if (!result.spoken) {
        throw new Error(
          result.session?.chrome?.health?.speechBlockedMessage ??
            "session has no active realtime audio bridge",
        );
      }
      writeStdoutLine("speaking on %s", sessionId);
    });
}
