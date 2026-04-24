import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

const GOOGLE_MEET_API_BASE_URL = "https://meet.googleapis.com/v2";
const GOOGLE_MEET_URL_HOST = "meet.google.com";
const GOOGLE_MEET_API_HOST = "meet.googleapis.com";

export type GoogleMeetSpace = {
  name: string;
  meetingCode?: string;
  meetingUri?: string;
  activeConference?: Record<string, unknown>;
  config?: Record<string, unknown>;
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

export function normalizeGoogleMeetSpaceName(input: string): string {
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

export async function fetchGoogleMeetSpace(params: {
  accessToken: string;
  meeting: string;
}): Promise<GoogleMeetSpace> {
  const name = normalizeGoogleMeetSpaceName(params.meeting);
  const { response, release } = await fetchWithSsrFGuard({
    url: `${GOOGLE_MEET_API_BASE_URL}/${encodeSpaceNameForPath(name)}`,
    init: {
      headers: {
        Authorization: `Bearer ${params.accessToken}`,
        Accept: "application/json",
      },
    },
    policy: { allowedHostnames: [GOOGLE_MEET_API_HOST] },
    auditContext: "google-meet.spaces.get",
  });
  try {
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Google Meet spaces.get failed (${response.status}): ${detail}`);
    }
    const payload = (await response.json()) as GoogleMeetSpace;
    if (!payload.name?.trim()) {
      throw new Error("Google Meet spaces.get response was missing name");
    }
    return payload;
  } finally {
    await release();
  }
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
