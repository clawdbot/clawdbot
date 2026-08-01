import { uniqueStrings } from "openclaw/plugin-sdk/string-coerce-runtime";
import { exportGoogleDriveDocumentText, extractGoogleDriveDocumentId } from "./drive.js";
import {
  createGoogleMeetSpace,
  endGoogleMeetActiveConference,
  fetchGoogleMeetSpace,
  fetchLatestGoogleMeetConferenceRecord,
  getErrorMessage,
  listGoogleMeetParticipants,
  listGoogleMeetParticipantSessions,
  listGoogleMeetRecordings,
  listGoogleMeetSmartNotes,
  listGoogleMeetTranscriptEntries,
  listGoogleMeetTranscripts,
  resolveConferenceRecordQuery,
  type GoogleMeetAccessType,
  type GoogleMeetArtifactsResult,
  type GoogleMeetAttendanceResult,
  type GoogleMeetAttendanceRow,
  type GoogleMeetConferenceRecord,
  type GoogleMeetEntryPointAccess,
  type GoogleMeetLatestConferenceRecordResult,
  type GoogleMeetParticipant,
  type GoogleMeetParticipantSession,
  type GoogleMeetPreflightReport,
  type GoogleMeetSmartNotesListResult,
  type GoogleMeetSpace,
  type GoogleMeetSpaceConfig,
} from "./meet-api.js";

export {
  createGoogleMeetSpace,
  endGoogleMeetActiveConference,
  fetchGoogleMeetSpace,
  fetchLatestGoogleMeetConferenceRecord,
  type GoogleMeetAccessType,
  type GoogleMeetArtifactsResult,
  type GoogleMeetAttendanceResult,
  type GoogleMeetEntryPointAccess,
  type GoogleMeetLatestConferenceRecordResult,
  type GoogleMeetSpaceConfig,
};

function getParticipantDisplayName(participant: GoogleMeetParticipant): string | undefined {
  return (
    participant.signedinUser?.displayName ??
    participant.anonymousUser?.displayName ??
    participant.phoneUser?.displayName
  );
}

function getParticipantUser(participant: GoogleMeetParticipant): string | undefined {
  return participant.signedinUser?.user;
}

function getDocsDestinationDocumentId(
  destination: Record<string, unknown> | undefined,
): string | undefined {
  return (
    extractGoogleDriveDocumentId(destination?.document) ??
    extractGoogleDriveDocumentId(destination?.documentId) ??
    extractGoogleDriveDocumentId(destination?.file)
  );
}

async function attachDocumentText<T extends { docsDestination?: Record<string, unknown> }>(params: {
  accessToken: string;
  resource: T;
}): Promise<T & { documentText?: string; documentTextError?: string }> {
  const documentId = getDocsDestinationDocumentId(params.resource.docsDestination);
  if (!documentId) {
    return params.resource;
  }
  try {
    return {
      ...params.resource,
      documentText: await exportGoogleDriveDocumentText({
        accessToken: params.accessToken,
        documentId,
      }),
    };
  } catch (error) {
    return {
      ...params.resource,
      documentTextError: getErrorMessage(error),
    };
  }
}

function parseGoogleMeetTimestamp(value: string | undefined): number | undefined {
  if (!value?.trim()) {
    return undefined;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function isoFromMs(value: number | undefined): string | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toISOString()
    : undefined;
}

function minTimestamp(values: Array<string | undefined>): string | undefined {
  const parsed = values
    .map(parseGoogleMeetTimestamp)
    .filter((value): value is number => typeof value === "number");
  return parsed.length > 0 ? isoFromMs(Math.min(...parsed)) : undefined;
}

function maxTimestamp(values: Array<string | undefined>): string | undefined {
  const parsed = values
    .map(parseGoogleMeetTimestamp)
    .filter((value): value is number => typeof value === "number");
  return parsed.length > 0 ? isoFromMs(Math.max(...parsed)) : undefined;
}

function sumSessionDurationMs(
  sessions: GoogleMeetParticipantSession[],
  fallbackStart?: string,
  fallbackEnd?: string,
): number | undefined {
  const sessionTotal = sessions.reduce((total, session) => {
    const startMs = parseGoogleMeetTimestamp(session.startTime);
    const endMs = parseGoogleMeetTimestamp(session.endTime);
    return startMs !== undefined && endMs !== undefined && endMs > startMs
      ? total + (endMs - startMs)
      : total;
  }, 0);
  if (sessionTotal > 0) {
    return sessionTotal;
  }
  const startMs = parseGoogleMeetTimestamp(fallbackStart);
  const endMs = parseGoogleMeetTimestamp(fallbackEnd);
  return startMs !== undefined && endMs !== undefined && endMs > startMs
    ? endMs - startMs
    : undefined;
}

function attendanceMergeKey(row: GoogleMeetAttendanceRow): string {
  return (row.user ?? row.displayName ?? row.participant).trim().toLocaleLowerCase();
}

function sortSessions(sessions: GoogleMeetParticipantSession[]): GoogleMeetParticipantSession[] {
  return sessions.toSorted(
    (left, right) =>
      (parseGoogleMeetTimestamp(left.startTime) ?? 0) -
      (parseGoogleMeetTimestamp(right.startTime) ?? 0),
  );
}

function decorateAttendanceRow(
  row: GoogleMeetAttendanceRow,
  conferenceRecord: GoogleMeetConferenceRecord,
  params: { lateAfterMinutes?: number; earlyBeforeMinutes?: number },
): GoogleMeetAttendanceRow {
  const sessions = sortSessions(row.sessions);
  const firstJoinTime = minTimestamp([
    row.earliestStartTime,
    ...sessions.map((session) => session.startTime),
  ]);
  const lastLeaveTime = maxTimestamp([
    row.latestEndTime,
    ...sessions.map((session) => session.endTime),
  ]);
  const durationMs = sumSessionDurationMs(sessions, firstJoinTime, lastLeaveTime);
  const conferenceStartMs = parseGoogleMeetTimestamp(conferenceRecord.startTime);
  const conferenceEndMs = parseGoogleMeetTimestamp(conferenceRecord.endTime);
  const firstJoinMs = parseGoogleMeetTimestamp(firstJoinTime);
  const lastLeaveMs = parseGoogleMeetTimestamp(lastLeaveTime);
  const lateGraceMs = (params.lateAfterMinutes ?? 5) * 60_000;
  const earlyGraceMs = (params.earlyBeforeMinutes ?? 5) * 60_000;
  const lateByMs =
    conferenceStartMs !== undefined && firstJoinMs !== undefined
      ? Math.max(firstJoinMs - conferenceStartMs, 0)
      : undefined;
  const earlyLeaveByMs =
    conferenceEndMs !== undefined && lastLeaveMs !== undefined
      ? Math.max(conferenceEndMs - lastLeaveMs, 0)
      : undefined;
  const decorated: GoogleMeetAttendanceRow = {
    ...row,
    sessions,
    participants: row.participants ?? [row.participant],
  };
  decorated.earliestStartTime = firstJoinTime ?? row.earliestStartTime;
  decorated.latestEndTime = lastLeaveTime ?? row.latestEndTime;
  if (firstJoinTime) {
    decorated.firstJoinTime = firstJoinTime;
  }
  if (lastLeaveTime) {
    decorated.lastLeaveTime = lastLeaveTime;
  }
  if (durationMs !== undefined) {
    decorated.durationMs = durationMs;
  }
  if (lateByMs !== undefined) {
    decorated.late = lateByMs > lateGraceMs;
    if (decorated.late) {
      decorated.lateByMs = lateByMs;
    }
  }
  if (earlyLeaveByMs !== undefined) {
    decorated.earlyLeave = earlyLeaveByMs > earlyGraceMs;
    if (decorated.earlyLeave) {
      decorated.earlyLeaveByMs = earlyLeaveByMs;
    }
  }
  return decorated;
}

function mergeAttendanceRows(
  rows: GoogleMeetAttendanceRow[],
  conferenceRecord: GoogleMeetConferenceRecord,
  params: {
    mergeDuplicateParticipants?: boolean;
    lateAfterMinutes?: number;
    earlyBeforeMinutes?: number;
  },
): GoogleMeetAttendanceRow[] {
  if (params.mergeDuplicateParticipants === false) {
    return rows.map((row) => decorateAttendanceRow(row, conferenceRecord, params));
  }
  const grouped = new Map<string, GoogleMeetAttendanceRow>();
  for (const row of rows) {
    const key = attendanceMergeKey(row);
    const existing = grouped.get(key);
    if (!existing) {
      grouped.set(key, { ...row, participants: [row.participant] });
      continue;
    }
    existing.participants = uniqueStrings([
      ...(existing.participants ?? [existing.participant]),
      row.participant,
    ]);
    existing.sessions.push(...row.sessions);
    existing.displayName ??= row.displayName;
    existing.user ??= row.user;
    existing.earliestStartTime = minTimestamp([existing.earliestStartTime, row.earliestStartTime]);
    existing.latestEndTime = maxTimestamp([existing.latestEndTime, row.latestEndTime]);
  }
  return [...grouped.values()].map((row) => decorateAttendanceRow(row, conferenceRecord, params));
}

export async function fetchGoogleMeetArtifacts(params: {
  accessToken: string;
  meeting?: string;
  conferenceRecord?: string;
  pageSize?: number;
  includeTranscriptEntries?: boolean;
  allConferenceRecords?: boolean;
  includeDocumentBodies?: boolean;
}): Promise<GoogleMeetArtifactsResult> {
  const resolved = await resolveConferenceRecordQuery(params);
  const artifacts = await Promise.all(
    resolved.conferenceRecords.map(async (conferenceRecord) => {
      const [participants, recordings, transcripts, smartNotesResult] = await Promise.all([
        listGoogleMeetParticipants({
          accessToken: params.accessToken,
          conferenceRecord: conferenceRecord.name,
          pageSize: params.pageSize,
        }),
        listGoogleMeetRecordings({
          accessToken: params.accessToken,
          conferenceRecord: conferenceRecord.name,
          pageSize: params.pageSize,
        }),
        listGoogleMeetTranscripts({
          accessToken: params.accessToken,
          conferenceRecord: conferenceRecord.name,
          pageSize: params.pageSize,
        }),
        listGoogleMeetSmartNotes({
          accessToken: params.accessToken,
          conferenceRecord: conferenceRecord.name,
          pageSize: params.pageSize,
        })
          .then<GoogleMeetSmartNotesListResult>((smartNotes) => ({ smartNotes }))
          .catch((error: unknown) => ({
            smartNotes: [],
            smartNotesError: getErrorMessage(error),
          })),
      ]);
      const transcriptEntries =
        params.includeTranscriptEntries === false
          ? []
          : await Promise.all(
              transcripts.map(async (transcript) => {
                try {
                  return {
                    transcript: transcript.name,
                    entries: await listGoogleMeetTranscriptEntries({
                      accessToken: params.accessToken,
                      transcript: transcript.name,
                      pageSize: params.pageSize,
                    }),
                  };
                } catch (error) {
                  return {
                    transcript: transcript.name,
                    entries: [],
                    entriesError: getErrorMessage(error),
                  };
                }
              }),
            );
      const transcriptsWithText =
        params.includeDocumentBodies === true
          ? await Promise.all(
              transcripts.map((transcript) =>
                attachDocumentText({
                  accessToken: params.accessToken,
                  resource: transcript,
                }),
              ),
            )
          : transcripts;
      const smartNotesWithText =
        params.includeDocumentBodies === true
          ? await Promise.all(
              smartNotesResult.smartNotes.map((smartNote) =>
                attachDocumentText({
                  accessToken: params.accessToken,
                  resource: smartNote,
                }),
              ),
            )
          : smartNotesResult.smartNotes;
      return {
        conferenceRecord,
        participants,
        recordings,
        transcripts: transcriptsWithText,
        transcriptEntries,
        smartNotes: smartNotesWithText,
        ...(smartNotesResult.smartNotesError
          ? { smartNotesError: smartNotesResult.smartNotesError }
          : {}),
      };
    }),
  );
  return {
    input: resolved.input,
    space: resolved.space,
    conferenceRecords: resolved.conferenceRecords,
    artifacts,
  };
}

export async function fetchGoogleMeetAttendance(params: {
  accessToken: string;
  meeting?: string;
  conferenceRecord?: string;
  pageSize?: number;
  allConferenceRecords?: boolean;
  mergeDuplicateParticipants?: boolean;
  lateAfterMinutes?: number;
  earlyBeforeMinutes?: number;
}): Promise<GoogleMeetAttendanceResult> {
  const resolved = await resolveConferenceRecordQuery(params);
  const nestedRows = await Promise.all(
    resolved.conferenceRecords.map(async (conferenceRecord) => {
      const participants = await listGoogleMeetParticipants({
        accessToken: params.accessToken,
        conferenceRecord: conferenceRecord.name,
        pageSize: params.pageSize,
      });
      const rows = await Promise.all(
        participants.map(async (participant) => ({
          conferenceRecord: conferenceRecord.name,
          participant: participant.name,
          displayName: getParticipantDisplayName(participant),
          user: getParticipantUser(participant),
          earliestStartTime: participant.earliestStartTime,
          latestEndTime: participant.latestEndTime,
          sessions: await listGoogleMeetParticipantSessions({
            accessToken: params.accessToken,
            participant: participant.name,
            pageSize: params.pageSize,
          }),
        })),
      );
      return mergeAttendanceRows(rows, conferenceRecord, params);
    }),
  );
  return {
    input: resolved.input,
    space: resolved.space,
    conferenceRecords: resolved.conferenceRecords,
    attendance: nestedRows.flat(),
  };
}

export function buildGoogleMeetPreflightReport(params: {
  input: string;
  space: GoogleMeetSpace;
  previewAcknowledged: boolean;
  tokenSource: "cached-access-token" | "refresh-token";
}): GoogleMeetPreflightReport {
  const blockers: string[] = [];
  if (!params.previewAcknowledged) {
    blockers.push(
      "Set preview.enrollmentAcknowledged=true after confirming your Cloud project, OAuth principal, and meeting participants are enrolled in the Google Workspace Developer Preview Program.",
    );
  }
  return {
    input: params.input,
    resolvedSpaceName: params.space.name,
    meetingCode: params.space.meetingCode,
    meetingUri: params.space.meetingUri,
    hasActiveConference: Boolean(params.space.activeConference),
    previewAcknowledged: params.previewAcknowledged,
    tokenSource: params.tokenSource,
    blockers,
  };
}
