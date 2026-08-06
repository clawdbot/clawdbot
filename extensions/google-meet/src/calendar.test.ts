// Google Meet tests cover Calendar API request behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractGoogleMeetUriFromCalendarEvent, listGoogleMeetCalendarEvents } from "./calendar.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Google Calendar requests", () => {
  it("aborts a stalled events.list request after 30 seconds", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("expected Calendar request abort signal"));
          return;
        }
        const rejectAbort = () =>
          reject(
            signal.reason instanceof Error
              ? signal.reason
              : new Error("Calendar request was aborted"),
          );
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = listGoogleMeetCalendarEvents({ accessToken: "test-token" });
    const rejection = expect(request).rejects.toMatchObject({
      name: "TimeoutError",
      message: "request timed out",
    });
    await vi.advanceTimersByTimeAsync(0);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    await rejection;
  });
});

describe("Google Meet calendar URL extraction", () => {
  it("normalizes Calendar HTTP links before applying the runtime Meet URL contract", () => {
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "http://meet.google.com/abc-defg-hij",
      }),
    ).toBe("https://meet.google.com/abc-defg-hij");
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "https://example.com/abc-defg-hij",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "https://meet.google.com/not-a-code",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "https://meet.google.com/lookup/classroom-alias",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "https://user@meet.google.com/abc-defg-hij",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "https://meet.google.com:444/abc-defg-hij",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        hangoutLink: "https://meet.google.com/abc-defg-hij?authuser=0",
      }),
    ).toBe("https://meet.google.com/abc-defg-hij?authuser=0");
  });

  it("ignores malformed conference entrypoints before selecting and upgrading a valid one", () => {
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        conferenceData: {
          entryPoints: [
            {
              entryPointType: "video",
              uri: "https://example.com/abc-defg-hij",
            },
            {
              entryPointType: "video",
              uri: "http://meet.google.com/abc-defg-hij",
            },
          ],
        },
      }),
    ).toBe("https://meet.google.com/abc-defg-hij");
  });

  it("applies the Meet URL contract to calendar text fallbacks", () => {
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        location:
          "Old https://meet.google.com/not-a-code, join https://meet.google.com/abc-defg-hij",
      }),
    ).toBe("https://meet.google.com/abc-defg-hij");
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        location: "Join https://meet.google.com/not-a-code",
      }),
    ).toBeUndefined();
    expect(
      extractGoogleMeetUriFromCalendarEvent({
        description: "Join https://meet.google.com/abc-defg-hij",
      }),
    ).toBe("https://meet.google.com/abc-defg-hij");
  });
});
