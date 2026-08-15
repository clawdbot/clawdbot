import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { teamsMeetingTranscriptScript } from "./teams-meetings-page-scripts.js";
import {
  CONSUMER_URL,
  URL,
  control,
  runStatusScript,
} from "./teams-meetings-platform-adapter.test-helpers.js";

describe("Microsoft Teams meeting caption ownership", () => {
  it("rotates live captions when the verified tab adopts a new session", async () => {
    let disconnects = 0;
    const old = {
      droppedLines: 0,
      lines: [],
      observer: { disconnect: () => (disconnects += 1) },
      observerInstalled: true,
      sessionId: "old-session",
      visible: [{ text: "Old live caption" }],
    };
    const { window } = await runStatusScript({
      allowMicrophone: false,
      captureCaptions: true,
      leave: control({ label: "Leave" }),
      priorCaptions: old,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "old-session",
      },
    });
    const current = window["__openclawTeamsCaptions"] as Record<string, unknown>;

    expect(disconnects).toBe(1);
    expect(old).toMatchObject({ finalized: true, lines: [{ text: "Old live caption" }] });
    expect(current).not.toBe(old);
    expect(current.sessionId).toBe("session-1");
    expect(window["__openclawTeamsCaptionArchive"]).toMatchObject({
      "old-session": old,
    });
    delete window["__openclawTeamsCaptions"];

    const readOldTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "old-session", false)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        location: new globalThis.URL(URL),
        window,
      },
    ) as () => string;
    expect(JSON.parse(readOldTranscript())).toMatchObject({
      sessionMatched: true,
      lines: [{ text: "Old live caption" }],
    });
  });

  it("archives a prior meeting caption buffer without rewriting its identity", async () => {
    const old = {
      droppedLines: 0,
      identity: "teams-work:19:meeting_test@thread.v2",
      lines: [],
      observerInstalled: true,
      sessionId: "session-a",
      visible: [{ text: "Meeting A caption" }],
    };
    const { window } = await runStatusScript({
      allowMicrophone: false,
      captureCaptions: true,
      currentUrl: CONSUMER_URL,
      leave: control({ label: "Leave" }),
      meetingSessionId: "session-b",
      meetingUrl: CONSUMER_URL,
      priorCaptions: old,
      priorMeeting: {
        identity: "teams-work:19:meeting_test@thread.v2",
        sessionId: "session-a",
      },
    });

    expect(old).toMatchObject({
      finalized: true,
      identity: "teams-work:19:meeting_test@thread.v2",
      lines: [{ text: "Meeting A caption" }],
    });
    delete window["__openclawTeamsCaptions"];
    const readOldTranscript = runInNewContext(
      `(${teamsMeetingTranscriptScript(URL, "session-a", false)})`,
      {
        URL: globalThis.URL,
        clearTimeout,
        location: new globalThis.URL(CONSUMER_URL),
        window,
      },
    ) as () => string;
    expect(JSON.parse(readOldTranscript())).toMatchObject({
      sessionMatched: true,
      urlMatched: true,
      lines: [{ text: "Meeting A caption" }],
    });
  });
});
