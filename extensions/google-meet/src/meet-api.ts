import { readProviderJsonResponse } from "openclaw/plugin-sdk/provider-http";
// Google Meet plugin module implements meet behavior.
import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { googleApiError } from "./google-api-errors.js";

const GOOGLE_MEET_API_ORIGIN = "https://meet.googleapis.com";
const GOOGLE_MEET_API_BASE_URL = `${GOOGLE_MEET_API_ORIGIN}/v2`;
const GOOGLE_MEET_URL_HOST = "meet.google.com";
const GOOGLE_MEET_API_HOST = "meet.googleapis.com";
const GOOGLE_MEET_REQUEST_TIMEOUT_MS = 30_000;
const GOOGLE_MEET_MEDIA_SCOPE =
  "https://www.googleapis.com/auth/meetings.conference.media.readonly";
const GOOGLE_MEET_SPACE_SCOPE = "https://www.googleapis.com/auth/meetings.space.readonly";
const GOOGLE_MEET_SPACE_CREATED_SCOPE = "https://www.googleapis.com/auth/meetings.space.created";
const GOOGLE_MEET_SPACE_SETTINGS_SCOPE = "https://www.googleapis.com/auth/meetings.space.settings";

export type GoogleMeetAccessType = "OPEN" | "TRUSTED" | "RESTRICTED";
export type GoogleMeetEntryPointAccess = "ALL" | "CREATOR_APP_ONLY";

export type GoogleMeetSpaceConfig = {
  accessType?: GoogleMeetAccessType;
  entryPointAccess?: GoogleMeetEntryPointAccess;
};

export type GoogleMeetSpace = {
  name: string;
  meetingCode?: string;
  meetingUri?: string;
  activeConference?: Record<string, unknown>;
  config?: GoogleMeetSpaceConfig & Record<string, unknown>;
};

export type GoogleMeetPreflightReport = {
  input: string;
  resolvedSpaceName: string;
  meetingCode?: string;
  meetingUri?: string;
  hasActiveConference: boolean;
  previewAcknowledged: boolean;
  tokenSource: "cached-access-token" | "refresh-token";
  blockers: string[];
};

type GoogleMeetCreateSpaceResult = {
  space: GoogleMeetSpace;
  meetingUri: string;
};

type GoogleMeetEndActiveConferenceResult = {
  space: string;
  ended: true;
};

export type GoogleMeetConferenceRecord = {
  name: string;
  space?: string;
  startTime?: string;
  endTime?: string;
  expireTime?: string;
};

export type GoogleMeetParticipant = {
  name: string;
  earliestStartTime?: string;
  latestEndTime?: string;
  signedinUser?: {
    user?: string;
    displayName?: string;
  };
  anonymousUser?: {
    displayName?: string;
  };
  phoneUser?: {
    displayName?: string;
  };
};

export type GoogleMeetParticipantSession = {
  name: string;
  startTime?: string;
  endTime?: string;
};

type GoogleMeetRecording = {
  name: string;
  startTime?: string;
  endTime?: string;
  driveDestination?: Record<string, unknown>;
};

type GoogleMeetTranscript = {
  name: string;
  startTime?: string;
  endTime?: string;
  docsDestination?: Record<string, unknown>;
  documentText?: string;
  documentTextError?: string;
};

type GoogleMeetTranscriptEntry = {
  name: string;
  participant?: string;
  text?: string;
  languageCode?: string;
  startTime?: string;
  endTime?: string;
};

type GoogleMeetTranscriptEntries = {
  transcript: string;
  entries: GoogleMeetTranscriptEntry[];
  entriesError?: string;
};

type GoogleMeetSmartNote = {
  name: string;
  startTime?: string;
  endTime?: string;
  docsDestination?: Record<string, unknown>;
  documentText?: string;
  documentTextError?: string;
};

type GoogleMeetArtifactsEntry = {
  conferenceRecord: GoogleMeetConferenceRecord;
  participants: GoogleMeetParticipant[];
  recordings: GoogleMeetRecording[];
  transcripts: GoogleMeetTranscript[];
  transcriptEntries: GoogleMeetTranscriptEntries[];
  smartNotes: GoogleMeetSmartNote[];
  smartNotesError?: string;
};

export type GoogleMeetArtifactsResult = {
  input?: string;
  space?: GoogleMeetSpace;
  conferenceRecords: GoogleMeetConferenceRecord[];
  artifacts: GoogleMeetArtifactsEntry[];
};

export type GoogleMeetLatestConferenceRecordResult = {
  input: string;
  space: GoogleMeetSpace;
  conferenceRecord?: GoogleMeetConferenceRecord;
};

export type GoogleMeetAttendanceRow = {
  conferenceRecord: string;
  participant: string;
  participants?: string[];
  displayName?: string;
  user?: string;
  earliestStartTime?: string;
  latestEndTime?: string;
  firstJoinTime?: string;
  lastLeaveTime?: string;
  durationMs?: number;
  late?: boolean;
  lateByMs?: number;
  earlyLeave?: boolean;
  earlyLeaveByMs?: number;
  sessions: GoogleMeetParticipantSession[];
};

export type GoogleMeetAttendanceResult = {
  input?: string;
  space?: GoogleMeetSpace;
  conferenceRecords: GoogleMeetConferenceRecord[];
  attendance: GoogleMeetAttendanceRow[];
};

export type GoogleMeetSmartNotesListResult = {
  smartNotes: GoogleMeetSmartNote[];
  smartNotesError?: string;
};

function normalizeGoogleMeetSpaceName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Meeting input is required");
  }
  if (trimmed.startsWith("spaces/")) {
    const suffix = trimmed.slice("spaces/".length).trim();
    if (!suffix) {
      throw new Error("spaces/ input must include a meeting code or space id");
    }
    return `spaces/${suffix}`;
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const url = new URL(trimmed);
    if (url.hostname !== GOOGLE_MEET_URL_HOST) {
      throw new Error(`Expected a ${GOOGLE_MEET_URL_HOST} URL, received ${url.hostname}`);
    }
    const firstSegment = url.pathname
      .split("/")
      .map((segment) => segment.trim())
      .find(Boolean);
    if (!firstSegment) {
      throw new Error("Google Meet URL did not include a meeting code");
    }
    return `spaces/${firstSegment}`;
  }
  return `spaces/${trimmed}`;
}

function encodeSpaceNameForPath(name: string): string {
  return name.split("/").map(encodeURIComponent).join("/");
}

function encodeResourceNameForPath(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new Error("Google Meet resource name is required");
  }
  return trimmed.split("/").map(encodeURIComponent).join("/");
}

function normalizeConferenceRecordName(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error("Conference record is required");
  }
  return trimmed.startsWith("conferenceRecords/") ? trimmed : `conferenceRecords/${trimmed}`;
}

function appendQuery(
  url: string,
  query?: Record<string, string | number | boolean | undefined>,
): string {
  if (!query) {
    return url;
  }
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

function assertResourceArray<T extends { name?: string }>(
  value: unknown,
  key: string,
  context: string,
): T[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error(`Google Meet ${context} response had non-array ${key}`);
  }
  const resources = value as T[];
  for (const resource of resources) {
    if (!resource.name?.trim()) {
      throw new Error(`Google Meet ${context} response included a resource without name`);
    }
  }
  return resources;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function requestGoogleMeetApi(params: {
  accessToken: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  method?: "GET" | "POST";
  body?: string;
  auditContext: string;
}) {
  return await fetchWithSsrFGuard({
    url: appendQuery(`${GOOGLE_MEET_API_BASE_URL}/${params.path}`, params.query),
    init: {
      method: params.method,
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: "application/json",
        ...(params.body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: params.body,
    },
    policy: { allowedHostnames: [GOOGLE_MEET_API_HOST] },
    auditContext: params.auditContext,
    timeoutMs: GOOGLE_MEET_REQUEST_TIMEOUT_MS,
  });
}

async function fetchGoogleMeetJson<T>(params: {
  accessToken: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  auditContext: string;
  errorPrefix: string;
}): Promise<T> {
  const { response, release } = await requestGoogleMeetApi({
    accessToken: params.accessToken,
    path: params.path,
    query: params.query,
    auditContext: params.auditContext,
  });
  try {
    if (!response.ok) {
      throw await googleApiError({
        response,
        prefix: params.errorPrefix,
        scopes: [GOOGLE_MEET_MEDIA_SCOPE],
      });
    }
    return await readProviderJsonResponse<T>(response, params.errorPrefix);
  } finally {
    await release();
  }
}

async function listGoogleMeetCollection<T extends { name?: string }>(params: {
  accessToken: string;
  path: string;
  collectionKey: string;
  query?: Record<string, string | number | boolean | undefined>;
  maxItems?: number;
  auditContext: string;
  errorPrefix: string;
}): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  do {
    const payload = await fetchGoogleMeetJson<Record<string, unknown>>({
      accessToken: params.accessToken,
      path: params.path,
      query: { ...params.query, pageToken },
      auditContext: params.auditContext,
      errorPrefix: params.errorPrefix,
    });
    const pageItems = assertResourceArray<T>(
      payload[params.collectionKey],
      params.collectionKey,
      params.errorPrefix,
    );
    const remaining =
      typeof params.maxItems === "number" ? Math.max(params.maxItems - items.length, 0) : undefined;
    items.push(...(remaining === undefined ? pageItems : pageItems.slice(0, remaining)));
    if (typeof params.maxItems === "number" && items.length >= params.maxItems) {
      break;
    }
    pageToken = typeof payload.nextPageToken === "string" ? payload.nextPageToken : undefined;
  } while (pageToken);
  return items;
}

export async function fetchGoogleMeetSpace(params: {
  accessToken: string;
  meeting: string;
}): Promise<GoogleMeetSpace> {
  const name = normalizeGoogleMeetSpaceName(params.meeting);
  const { response, release } = await requestGoogleMeetApi({
    accessToken: params.accessToken,
    path: encodeSpaceNameForPath(name),
    auditContext: "google-meet.spaces.get",
  });
  try {
    if (!response.ok) {
      throw await googleApiError({
        response,
        prefix: "Google Meet spaces.get",
        scopes: [GOOGLE_MEET_SPACE_SCOPE],
      });
    }
    const payload = await readProviderJsonResponse<GoogleMeetSpace>(
      response,
      "Google Meet spaces.get",
    );
    if (!payload.name?.trim()) {
      throw new Error("Google Meet spaces.get response was missing name");
    }
    return payload;
  } finally {
    await release();
  }
}

export async function createGoogleMeetSpace(params: {
  accessToken: string;
  config?: GoogleMeetSpaceConfig;
}): Promise<GoogleMeetCreateSpaceResult> {
  const body =
    params.config && Object.keys(params.config).length > 0
      ? JSON.stringify({ config: params.config })
      : "{}";
  const { response, release } = await requestGoogleMeetApi({
    accessToken: params.accessToken,
    path: "spaces",
    method: "POST",
    body,
    auditContext: "google-meet.spaces.create",
  });
  try {
    if (!response.ok) {
      throw await googleApiError({
        response,
        prefix: "Google Meet spaces.create",
        scopes:
          params.config && Object.keys(params.config).length > 0
            ? [GOOGLE_MEET_SPACE_CREATED_SCOPE, GOOGLE_MEET_SPACE_SETTINGS_SCOPE]
            : [GOOGLE_MEET_SPACE_CREATED_SCOPE],
      });
    }
    const payload = await readProviderJsonResponse<GoogleMeetSpace>(
      response,
      "Google Meet spaces.create",
    );
    if (!payload.name?.trim()) {
      throw new Error("Google Meet spaces.create response was missing name");
    }
    const meetingUri = payload.meetingUri?.trim();
    if (!meetingUri) {
      throw new Error("Google Meet spaces.create response was missing meetingUri");
    }
    return { space: payload, meetingUri };
  } finally {
    await release();
  }
}

export async function endGoogleMeetActiveConference(params: {
  accessToken: string;
  meeting: string;
}): Promise<GoogleMeetEndActiveConferenceResult> {
  const resolved = await fetchGoogleMeetSpace({
    accessToken: params.accessToken,
    meeting: params.meeting,
  });
  const space = resolved.name;
  const { response, release } = await requestGoogleMeetApi({
    accessToken: params.accessToken,
    path: `${encodeSpaceNameForPath(space)}:endActiveConference`,
    method: "POST",
    body: "{}",
    auditContext: "google-meet.spaces.endActiveConference",
  });
  try {
    if (!response.ok) {
      throw await googleApiError({
        response,
        prefix: "Google Meet spaces.endActiveConference",
        scopes: [GOOGLE_MEET_SPACE_CREATED_SCOPE],
      });
    }
    return { space, ended: true };
  } finally {
    await release();
  }
}

async function fetchGoogleMeetConferenceRecord(params: {
  accessToken: string;
  conferenceRecord: string;
}): Promise<GoogleMeetConferenceRecord> {
  const name = normalizeConferenceRecordName(params.conferenceRecord);
  const payload = await fetchGoogleMeetJson<GoogleMeetConferenceRecord>({
    accessToken: params.accessToken,
    path: encodeResourceNameForPath(name),
    auditContext: "google-meet.conferenceRecords.get",
    errorPrefix: "Google Meet conferenceRecords.get",
  });
  if (!payload.name?.trim()) {
    throw new Error("Google Meet conferenceRecords.get response was missing name");
  }
  return payload;
}

async function listGoogleMeetConferenceRecords(params: {
  accessToken: string;
  meeting?: string;
  pageSize?: number;
  maxItems?: number;
}): Promise<GoogleMeetConferenceRecord[]> {
  const filter = params.meeting
    ? `space.name = "${normalizeGoogleMeetSpaceName(params.meeting)}"`
    : undefined;
  return listGoogleMeetCollection<GoogleMeetConferenceRecord>({
    accessToken: params.accessToken,
    path: "conferenceRecords",
    collectionKey: "conferenceRecords",
    query: {
      pageSize: params.pageSize,
      filter,
    },
    maxItems: params.maxItems,
    auditContext: "google-meet.conferenceRecords.list",
    errorPrefix: "Google Meet conferenceRecords.list",
  });
}

export async function fetchLatestGoogleMeetConferenceRecord(params: {
  accessToken: string;
  meeting: string;
}): Promise<GoogleMeetLatestConferenceRecordResult> {
  const space = await fetchGoogleMeetSpace({
    accessToken: params.accessToken,
    meeting: params.meeting,
  });
  const [conferenceRecord] = await listGoogleMeetConferenceRecords({
    accessToken: params.accessToken,
    meeting: space.name,
    pageSize: 1,
    maxItems: 1,
  });
  return {
    input: params.meeting,
    space,
    ...(conferenceRecord ? { conferenceRecord } : {}),
  };
}

export async function listGoogleMeetParticipants(params: {
  accessToken: string;
  conferenceRecord: string;
  pageSize?: number;
}): Promise<GoogleMeetParticipant[]> {
  const parent = normalizeConferenceRecordName(params.conferenceRecord);
  return listGoogleMeetCollection<GoogleMeetParticipant>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(parent)}/participants`,
    collectionKey: "participants",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.participants.list",
    errorPrefix: "Google Meet conferenceRecords.participants.list",
  });
}

export async function listGoogleMeetParticipantSessions(params: {
  accessToken: string;
  participant: string;
  pageSize?: number;
}): Promise<GoogleMeetParticipantSession[]> {
  return listGoogleMeetCollection<GoogleMeetParticipantSession>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(params.participant)}/participantSessions`,
    collectionKey: "participantSessions",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.participants.participantSessions.list",
    errorPrefix: "Google Meet conferenceRecords.participants.participantSessions.list",
  });
}

export async function listGoogleMeetRecordings(params: {
  accessToken: string;
  conferenceRecord: string;
  pageSize?: number;
}): Promise<GoogleMeetRecording[]> {
  const parent = normalizeConferenceRecordName(params.conferenceRecord);
  return listGoogleMeetCollection<GoogleMeetRecording>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(parent)}/recordings`,
    collectionKey: "recordings",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.recordings.list",
    errorPrefix: "Google Meet conferenceRecords.recordings.list",
  });
}

export async function listGoogleMeetTranscripts(params: {
  accessToken: string;
  conferenceRecord: string;
  pageSize?: number;
}): Promise<GoogleMeetTranscript[]> {
  const parent = normalizeConferenceRecordName(params.conferenceRecord);
  return listGoogleMeetCollection<GoogleMeetTranscript>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(parent)}/transcripts`,
    collectionKey: "transcripts",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.transcripts.list",
    errorPrefix: "Google Meet conferenceRecords.transcripts.list",
  });
}

export async function listGoogleMeetTranscriptEntries(params: {
  accessToken: string;
  transcript: string;
  pageSize?: number;
}): Promise<GoogleMeetTranscriptEntry[]> {
  return listGoogleMeetCollection<GoogleMeetTranscriptEntry>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(params.transcript)}/entries`,
    collectionKey: "transcriptEntries",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.transcripts.entries.list",
    errorPrefix: "Google Meet conferenceRecords.transcripts.entries.list",
  });
}

export async function listGoogleMeetSmartNotes(params: {
  accessToken: string;
  conferenceRecord: string;
  pageSize?: number;
}): Promise<GoogleMeetSmartNote[]> {
  const parent = normalizeConferenceRecordName(params.conferenceRecord);
  return listGoogleMeetCollection<GoogleMeetSmartNote>({
    accessToken: params.accessToken,
    path: `${encodeResourceNameForPath(parent)}/smartNotes`,
    collectionKey: "smartNotes",
    query: { pageSize: params.pageSize },
    auditContext: "google-meet.conferenceRecords.smartNotes.list",
    errorPrefix: "Google Meet conferenceRecords.smartNotes.list",
  });
}

export async function resolveConferenceRecordQuery(params: {
  accessToken: string;
  meeting?: string;
  conferenceRecord?: string;
  pageSize?: number;
  allConferenceRecords?: boolean;
}): Promise<{
  input?: string;
  space?: GoogleMeetSpace;
  conferenceRecords: GoogleMeetConferenceRecord[];
}> {
  if (params.conferenceRecord?.trim()) {
    const conferenceRecord = await fetchGoogleMeetConferenceRecord({
      accessToken: params.accessToken,
      conferenceRecord: params.conferenceRecord,
    });
    return {
      input: params.conferenceRecord.trim(),
      conferenceRecords: [conferenceRecord],
    };
  }
  if (!params.meeting?.trim()) {
    throw new Error("Meeting input or conference record is required");
  }
  const space = await fetchGoogleMeetSpace({
    accessToken: params.accessToken,
    meeting: params.meeting,
  });
  const conferenceRecords = await listGoogleMeetConferenceRecords({
    accessToken: params.accessToken,
    meeting: space.name,
    pageSize: params.allConferenceRecords ? params.pageSize : 1,
    maxItems: params.allConferenceRecords ? undefined : 1,
  });
  return {
    input: params.meeting,
    space,
    conferenceRecords,
  };
}
