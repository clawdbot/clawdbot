// Google Meet tests cover Calendar API request behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import { listGoogleMeetCalendarEvents } from "./calendar.js";

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
