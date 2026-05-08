import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";
import { googleApiError } from "./google-api-errors.js";

const GOOGLE_CALENDAR_API_BASE_URL = "https://www.googleapis.com/calendar/v3";
const GOOGLE_CALENDAR_API_HOST = "www.googleapis.com";
const GOOGLE_MEET_URL_HOST = "meet.google.com";
const GOOGLE_CALENDAR_EVENTS_SCOPE = "https://www.googleapis.com/auth/calendar.events.readonly";

type GoogleCalendarEventDate = {
  date?: string;
  dateTime?: string;
  timeZone?: string;
};

type GoogleCalendarConferenceEntryPoint = {
  entryPointType?: string;
  uri?: string;
  label?: string;
};

type GoogleMeetCalendarEvent = {
  id?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  hangoutLink?: string;
  start?: GoogleCalendarEventDate;
  end?: GoogleCalendarEventDate;
  conferenceData?: {
    conferenceId?: string;
    conferenceSolution?: {
      key?: { type?: string };
      name?: string;
    };
    entryPoints?: GoogleCalendarConferenceEntryPoint[];
  };
};

export type GoogleMeetCalendarLookupResult = {
  calendarId: string;
  event: GoogleMeetCalendarEvent;
  meetingUri: string;
};

type GoogleMeetCalendarEventsResult = {
  calendarId: string;
  events: Array<{
    event: GoogleMeetCalendarEvent;
    meetingUri: string;
    selected: boolean;
  }>;
};

function appendQuery(url: string, query: Record<string, string | number | boolean | undefined>) {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) {
      parsed.searchParams.set(key, String(value));
    }
  }
  return parsed.toString();
}

function isGoogleMeetUri(value: string | undefined): value is string {
  if (!value?.trim()) {
    return false;
  }
  try {
    return new URL(value).hostname === GOOGLE_MEET_URL_HOST;
  } catch {
    return false;
  }
}

function extractGoogleMeetUriFromText(value: string | undefined): string | undefined {
  const match = value?.match(/https:\/\/meet\.google\.com\/[a-z0-9-]+/i);
  return match?.[0];
}

export function extractGoogleMeetUriFromCalendarEvent(
  event: GoogleMeetCalendarEvent,
): string | undefined {
  if (isGoogleMeetUri(event.hangoutLink)) {
    return event.hangoutLink;
  }
  const entryPoints = event.conferenceData?.entryPoints ?? [];
  const videoEntry = entryPoints.find(
    (entry) => entry.entryPointType === "video" && isGoogleMeetUri(entry.uri),
  );
  if (videoEntry?.uri) {
    return videoEntry.uri;
  }
  const meetEntry = entryPoints.find((entry) => isGoogleMeetUri(entry.uri));
  if (meetEntry?.uri) {
    return meetEntry.uri;
  }
  return (
    extractGoogleMeetUriFromText(event.location) ?? extractGoogleMeetUriFromText(event.description)
  );
}

export function buildGoogleMeetCalendarDayWindow(now = new Date()): {
  timeMin: string;
  timeMax: string;
} {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(start.getDate() + 1);
  return { timeMin: start.toISOString(), timeMax: end.toISOString() };
}

function parseCalendarEventTime(value: GoogleCalendarEventDate | undefined): number | undefined {
  const raw = value?.dateTime ?? value?.date;
  if (!raw) {
    return undefined;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function rankCalendarEvent(event: GoogleMeetCalendarEvent, nowMs: number): number {
  const startMs = parseCalendarEventTime(event.start) ?? Number.POSITIVE_INFINITY;
  const endMs = parseCalendarEventTime(event.end) ?? startMs;
  if (startMs <= nowMs && endMs >= nowMs) {
    return 0;
  }
  if (startMs > nowMs) {
    return startMs - nowMs;
  }
  return nowMs - startMs + 30 * 24 * 60 * 60 * 1000;
}

function chooseBestMeetCalendarEvent(
  events: GoogleMeetCalendarEvent[],
  now: Date,
): GoogleMeetCalendarLookupResult["event"] | undefined {
  const nowMs = now.getTime();
  let selected: GoogleMeetCalendarEvent | undefined;
  let selectedRank = Number.POSITIVE_INFINITY;
  for (const event of events) {
    if (event.status === "cancelled" || !extractGoogleMeetUriFromCalendarEvent(event)) {
      continue;
    }
    const rank = rankCalendarEvent(event, nowMs);
    if (!selected || rank < selectedRank) {
      selected = event;
      selectedRank = rank;
    }
  }
  return selected;
}

async function fetchGoogleCalendarEvents(params: {
  accessToken: string;
  calendarId?: string;
  eventQuery?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  now?: Date;
}): Promise<{ calendarId: string; events: GoogleMeetCalendarEvent[]; now: Date }> {
  const calendarId = params.calendarId?.trim() || "primary";
  const now = params.now ?? new Date();
  const defaultTimeMax = new Date(now);
  defaultTimeMax.setDate(defaultTimeMax.getDate() + 7);
  const { response, release } = await fetchWithSsrFGuard({
    url: appendQuery(
      `${GOOGLE_CALENDAR_API_BASE_URL}/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        maxResults: params.maxResults ?? 50,
        orderBy: "startTime",
        q: params.eventQuery?.trim() || undefined,
        showDeleted: false,
        singleEvents: true,
        timeMin: params.timeMin ?? now.toISOString(),
        timeMax: params.timeMax ?? defaultTimeMax.toISOString(),
      },
    ),
    init: {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: "application/json",
      },
    },
    policy: { allowedHostnames: [GOOGLE_CALENDAR_API_HOST] },
    auditContext: "google-meet.calendar.events.list",
  });
  try {
    if (!response.ok) {
      const detail = await response.text();
      throw await googleApiError({
        response,
        detail,
        prefix: "Google Calendar events.list",
        scopes: [GOOGLE_CALENDAR_EVENTS_SCOPE],
      });
    }
    const payload = (await response.json()) as { items?: unknown };
    if (payload.items !== undefined && !Array.isArray(payload.items)) {
      throw new Error("Google Calendar events.list response had non-array items");
    }
    return { calendarId, events: (payload.items ?? []) as GoogleMeetCalendarEvent[], now };
  } finally {
    await release();
  }
}

export async function listGoogleMeetCalendarEvents(params: {
  accessToken: string;
  calendarId?: string;
  eventQuery?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  now?: Date;
}): Promise<GoogleMeetCalendarEventsResult> {
  const { calendarId, events, now } = await fetchGoogleCalendarEvents(params);
  const best = chooseBestMeetCalendarEvent(events, now);
  return {
    calendarId,
    events: events
      .map((event) => {
        const meetingUri = extractGoogleMeetUriFromCalendarEvent(event);
        return meetingUri ? { event, meetingUri, selected: event === best } : undefined;
      })
      .filter((event): event is GoogleMeetCalendarEventsResult["events"][number] => Boolean(event)),
  };
}

export async function findGoogleMeetCalendarEvent(params: {
  accessToken: string;
  calendarId?: string;
  eventQuery?: string;
  timeMin?: string;
  timeMax?: string;
  maxResults?: number;
  now?: Date;
}): Promise<GoogleMeetCalendarLookupResult> {
  const result = await listGoogleMeetCalendarEvents(params);
  const selected = result.events.find((event) => event.selected) ?? result.events[0];
  if (!selected) {
    throw new Error("No Google Calendar event with a Google Meet link matched the query");
  }
  return {
    calendarId: result.calendarId,
    event: selected.event,
    meetingUri: selected.meetingUri,
  };
}
