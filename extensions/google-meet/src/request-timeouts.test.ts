// Google Meet tests cover request deadlines across Google API surfaces.
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportGoogleDriveDocumentText } from "./drive.js";
import { fetchGoogleMeetSpace } from "./meet.js";
import { refreshGoogleMeetAccessToken } from "./oauth.js";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const requests = [
  {
    name: "Meet v2",
    run: () => fetchGoogleMeetSpace({ accessToken: "test-token", meeting: "abc-defg-hij" }),
  },
  {
    name: "Drive export",
    run: () =>
      exportGoogleDriveDocumentText({ accessToken: "test-token", documentId: "document-id" }),
  },
  {
    name: "OAuth token",
    run: () =>
      refreshGoogleMeetAccessToken({
        clientId: "client-id",
        refreshToken: "refresh-token",
      }),
  },
] as const;

describe("Google API request timeouts", () => {
  it.each(requests)("aborts a stalled $name request after 30 seconds", async ({ run }) => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (!signal) {
          reject(new Error("expected Google API request abort signal"));
          return;
        }
        const rejectAbort = () =>
          reject(signal.reason instanceof Error ? signal.reason : new Error("request aborted"));
        if (signal.aborted) {
          rejectAbort();
          return;
        }
        signal.addEventListener("abort", rejectAbort, { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const request = run();
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
