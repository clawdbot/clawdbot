import { isLiveTestEnabled } from "openclaw/plugin-sdk/test-env";
import { describe, expect, it } from "vitest";
import { buildGoogleMeetExportManifest, googleMeetExportFileNames } from "./src/cli.js";
import {
  fetchGoogleMeetArtifacts,
  fetchGoogleMeetAttendance,
  fetchLatestGoogleMeetConferenceRecord,
} from "./src/meet.js";
import { resolveGoogleMeetAccessToken } from "./src/oauth.js";

const LIVE_MEETING = process.env.OPENCLAW_GOOGLE_MEET_LIVE_MEETING?.trim() ?? "";
const CLIENT_ID =
  process.env.OPENCLAW_GOOGLE_MEET_CLIENT_ID?.trim() ??
  process.env.GOOGLE_MEET_CLIENT_ID?.trim() ??
  "";
const CLIENT_SECRET =
  process.env.OPENCLAW_GOOGLE_MEET_CLIENT_SECRET?.trim() ??
  process.env.GOOGLE_MEET_CLIENT_SECRET?.trim();
const REFRESH_TOKEN =
  process.env.OPENCLAW_GOOGLE_MEET_REFRESH_TOKEN?.trim() ??
  process.env.GOOGLE_MEET_REFRESH_TOKEN?.trim() ??
  "";
const ACCESS_TOKEN =
  process.env.OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN?.trim() ??
  process.env.GOOGLE_MEET_ACCESS_TOKEN?.trim();
const EXPIRES_AT = Number(
  process.env.OPENCLAW_GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT ??
    process.env.GOOGLE_MEET_ACCESS_TOKEN_EXPIRES_AT,
);

const LIVE =
  isLiveTestEnabled() &&
  LIVE_MEETING.length > 0 &&
  ((CLIENT_ID.length > 0 && REFRESH_TOKEN.length > 0) || Boolean(ACCESS_TOKEN));
const describeLive = LIVE ? describe : describe.skip;

describeLive("google-meet live", () => {
  it("resolves latest conference record and artifacts for a real meeting", async () => {
    const token = await resolveGoogleMeetAccessToken({
      clientId: CLIENT_ID,
      clientSecret: CLIENT_SECRET,
      refreshToken: REFRESH_TOKEN,
      accessToken: ACCESS_TOKEN,
      expiresAt: Number.isFinite(EXPIRES_AT) ? EXPIRES_AT : undefined,
    });

    const latest = await fetchLatestGoogleMeetConferenceRecord({
      accessToken: token.accessToken,
      meeting: LIVE_MEETING,
    });
    expect(latest.space.name).toMatch(/^spaces\//);

    const artifacts = await fetchGoogleMeetArtifacts({
      accessToken: token.accessToken,
      meeting: LIVE_MEETING,
      pageSize: 5,
    });
    expect(artifacts.conferenceRecords.length).toBeLessThanOrEqual(1);
    expect(Array.isArray(artifacts.artifacts)).toBe(true);

    const attendance = await fetchGoogleMeetAttendance({
      accessToken: token.accessToken,
      meeting: LIVE_MEETING,
      pageSize: 5,
    });
    expect(attendance.conferenceRecords.length).toBe(artifacts.conferenceRecords.length);

    const manifest = buildGoogleMeetExportManifest({
      artifacts,
      attendance,
      files: googleMeetExportFileNames(),
      request: {
        meeting: LIVE_MEETING,
        pageSize: 5,
        includeTranscriptEntries: true,
        includeDocumentBodies: false,
        allConferenceRecords: false,
        mergeDuplicateParticipants: true,
      },
      tokenSource: token.refreshed ? "refresh-token" : "cached-access-token",
    });
    expect(manifest.files).toContain("manifest.json");
    expect(manifest.counts.conferenceRecords).toBe(artifacts.conferenceRecords.length);
  }, 120_000);
});
