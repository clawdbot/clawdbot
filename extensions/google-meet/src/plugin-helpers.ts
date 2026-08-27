import { readPositiveIntegerParam } from "openclaw/plugin-sdk/channel-actions";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/plugin-entry";
import { normalizeOptionalString } from "openclaw/plugin-sdk/string-coerce-runtime";
import {
  buildGoogleMeetCalendarDayWindow,
  findGoogleMeetCalendarEvent,
  type GoogleMeetCalendarLookupResult,
} from "./calendar.js";
import type { GoogleMeetConfig } from "./config.js";
import {
  fetchGoogleMeetArtifacts,
  fetchGoogleMeetAttendance,
  fetchGoogleMeetSpace,
} from "./meet.js";
import { loadGoogleMeetCliModule, resolveMeetingInput } from "./plugin-registration.js";
import type { GoogleMeetRuntime } from "./runtime.js";

const loadGoogleMeetCreateModule = createLazyRuntimeModule(() => import("./create.js"));

export async function createMeetFromParams(params: {
  config: GoogleMeetConfig;
  runtime: OpenClawPluginApi["runtime"];
  raw: Record<string, unknown>;
}) {
  const create = await loadGoogleMeetCreateModule();
  return create.createMeetFromParams(params);
}

export async function createAndJoinMeetFromParams(params: {
  config: GoogleMeetConfig;
  runtime: OpenClawPluginApi["runtime"];
  raw: Record<string, unknown>;
  ensureRuntime: () => Promise<GoogleMeetRuntime>;
}) {
  const create = await loadGoogleMeetCreateModule();
  return create.createAndJoinMeetFromParams(params);
}

export async function resolveGoogleMeetTokenFromParams(
  config: GoogleMeetConfig,
  raw: Record<string, unknown>,
) {
  const { resolveGoogleMeetAccessToken } = await import("./oauth.js");
  return resolveGoogleMeetAccessToken({
    clientId: normalizeOptionalString(raw.clientId) ?? config.oauth.clientId,
    clientSecret: normalizeOptionalString(raw.clientSecret) ?? config.oauth.clientSecret,
    refreshToken: normalizeOptionalString(raw.refreshToken) ?? config.oauth.refreshToken,
    accessToken: normalizeOptionalString(raw.accessToken) ?? config.oauth.accessToken,
    expiresAt: typeof raw.expiresAt === "number" ? raw.expiresAt : config.oauth.expiresAt,
  });
}

function wantsCalendarLookup(raw: Record<string, unknown>): boolean {
  return raw.today === true || Boolean(normalizeOptionalString(raw.event));
}

export async function resolveMeetingFromParams(params: {
  config: GoogleMeetConfig;
  raw: Record<string, unknown>;
  accessToken: string;
}): Promise<{ meeting: string; calendarEvent?: GoogleMeetCalendarLookupResult }> {
  if (wantsCalendarLookup(params.raw)) {
    const window = params.raw.today === true ? buildGoogleMeetCalendarDayWindow() : {};
    const calendarEvent = await findGoogleMeetCalendarEvent({
      accessToken: params.accessToken,
      calendarId: normalizeOptionalString(params.raw.calendarId),
      eventQuery: normalizeOptionalString(params.raw.event),
      ...window,
    });
    return { meeting: calendarEvent.meetingUri, calendarEvent };
  }
  return { meeting: resolveMeetingInput(params.config, params.raw.meeting) };
}

export async function resolveSpaceFromParams(
  config: GoogleMeetConfig,
  raw: Record<string, unknown>,
) {
  const token = await resolveGoogleMeetTokenFromParams(config, raw);
  const { meeting, calendarEvent } = await resolveMeetingFromParams({
    config,
    raw,
    accessToken: token.accessToken,
  });
  const space = await fetchGoogleMeetSpace({
    accessToken: token.accessToken,
    meeting,
  });
  return { meeting, token, space, calendarEvent };
}

export async function resolveArtifactQueryFromParams(
  config: GoogleMeetConfig,
  raw: Record<string, unknown>,
) {
  const meeting = normalizeOptionalString(raw.meeting) ?? config.defaults.meeting;
  const conferenceRecord = normalizeOptionalString(raw.conferenceRecord);
  const token = await resolveGoogleMeetTokenFromParams(config, raw);
  const resolvedMeeting: { meeting?: string; calendarEvent?: GoogleMeetCalendarLookupResult } =
    conferenceRecord
      ? { meeting }
      : wantsCalendarLookup(raw)
        ? await resolveMeetingFromParams({ config, raw, accessToken: token.accessToken })
        : { meeting };
  if (!resolvedMeeting.meeting && !conferenceRecord) {
    throw new Error("Meeting input, calendar lookup, or conferenceRecord required");
  }
  return {
    token,
    meeting: resolvedMeeting.meeting,
    calendarEvent: resolvedMeeting.calendarEvent,
    conferenceRecord,
    pageSize: readPositiveIntegerParam(raw, "pageSize"),
    includeTranscriptEntries: raw.includeTranscriptEntries !== false,
    includeDocumentBodies: raw.includeDocumentBodies === true,
    allConferenceRecords: raw.includeAllConferenceRecords === true,
    mergeDuplicateParticipants: raw.mergeDuplicateParticipants !== false,
    lateAfterMinutes: readPositiveIntegerParam(raw, "lateAfterMinutes"),
    earlyBeforeMinutes: readPositiveIntegerParam(raw, "earlyBeforeMinutes"),
  };
}

type ResolvedGoogleMeetArtifactQuery = Awaited<ReturnType<typeof resolveArtifactQueryFromParams>>;

export function fetchResolvedGoogleMeetArtifacts(query: ResolvedGoogleMeetArtifactQuery) {
  return fetchGoogleMeetArtifacts({
    accessToken: query.token.accessToken,
    meeting: query.meeting,
    conferenceRecord: query.conferenceRecord,
    pageSize: query.pageSize,
    includeTranscriptEntries: query.includeTranscriptEntries,
    includeDocumentBodies: query.includeDocumentBodies,
    allConferenceRecords: query.allConferenceRecords,
  });
}

export function fetchResolvedGoogleMeetAttendance(query: ResolvedGoogleMeetArtifactQuery) {
  return fetchGoogleMeetAttendance({
    accessToken: query.token.accessToken,
    meeting: query.meeting,
    conferenceRecord: query.conferenceRecord,
    pageSize: query.pageSize,
    allConferenceRecords: query.allConferenceRecords,
    mergeDuplicateParticipants: query.mergeDuplicateParticipants,
    lateAfterMinutes: query.lateAfterMinutes,
    earlyBeforeMinutes: query.earlyBeforeMinutes,
  });
}

export async function exportGoogleMeetBundleFromParams(
  config: GoogleMeetConfig,
  raw: Record<string, unknown>,
) {
  const resolved = await resolveArtifactQueryFromParams(config, raw);
  const [artifacts, attendance] = await Promise.all([
    fetchResolvedGoogleMeetArtifacts(resolved),
    fetchResolvedGoogleMeetAttendance(resolved),
  ]);
  const { buildGoogleMeetExportManifest, googleMeetExportFileNames, writeMeetExportBundle } =
    await loadGoogleMeetCliModule();
  const calendarId = normalizeOptionalString(raw.calendarId);
  const request = {
    ...(resolved.meeting ? { meeting: resolved.meeting } : {}),
    ...(resolved.conferenceRecord ? { conferenceRecord: resolved.conferenceRecord } : {}),
    ...(resolved.calendarEvent?.event.id
      ? { calendarEventId: resolved.calendarEvent.event.id }
      : {}),
    ...(resolved.calendarEvent?.event.summary
      ? { calendarEventSummary: resolved.calendarEvent.event.summary }
      : {}),
    ...(calendarId ? { calendarId } : {}),
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
  const tokenSource = resolved.token.refreshed ? "refresh-token" : "cached-access-token";
  if (raw.dryRun === true) {
    return {
      dryRun: true,
      manifest: buildGoogleMeetExportManifest({
        artifacts,
        attendance,
        files: googleMeetExportFileNames(),
        request,
        tokenSource,
        ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
      }),
      ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
      tokenSource,
    };
  }
  const outputDir = normalizeOptionalString(raw.outputDir) ?? normalizeOptionalString(raw.output);
  const bundle = await writeMeetExportBundle({
    ...(outputDir ? { outputDir } : {}),
    artifacts,
    attendance,
    zip: raw.zip === true,
    request,
    tokenSource,
    ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
  });
  return {
    ...bundle,
    ...(resolved.calendarEvent ? { calendarEvent: resolved.calendarEvent } : {}),
    tokenSource,
  };
}

export { buildGoogleMeetCalendarDayWindow, listGoogleMeetCalendarEvents } from "./calendar.js";
export {
  buildGoogleMeetPreflightReport,
  endGoogleMeetActiveConference,
  fetchLatestGoogleMeetConferenceRecord,
} from "./meet.js";
